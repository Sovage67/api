import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { redis, publishEvent } from '../lib/redis.js';

/**
 * Webhook Stripe pour gérer les abonnements premium.
 *
 * IMPORTANT : pour que la signature soit vérifiée, le body doit être lu en raw.
 * Avec Fastify, ajouter dans server.ts :
 *
 *   app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
 *     done(null, body);
 *   });
 *
 * Et installer le SDK : npm install stripe
 */
export async function stripeRoutes(app: FastifyInstance) {
  app.post<{ Body: Buffer }>('/webhook', async (request, reply) => {
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
      return reply.status(503).send({ error: 'Stripe non configuré' });
    }

    const signature = request.headers['stripe-signature'];
    if (!signature || typeof signature !== 'string') {
      return reply.status(400).send({ error: 'Signature manquante' });
    }

    // Import dynamique pour ne pas charger Stripe si non utilisé
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    let event: import('stripe').Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      app.log.error({ err }, 'Signature Stripe invalide');
      return reply.status(400).send({ error: 'Signature invalide' });
    }

    // Anti-rejeu : ignorer les events déjà traités (idempotence)
    const key = `stripe:event:${event.id}`;
    const claimed = await redis.set(key, '1', 'EX', 86400, 'NX'); // TTL 24h, anti-rejeu
    if (!claimed) {
      app.log.warn({ eventId: event.id }, 'Stripe event already processed — skipping');
      return { received: true };
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        const guildId = session.metadata?.guildId;
        if (!userId || !guildId) break;

        await prisma.subscription.create({
          data: {
            userId,
            stripeId: session.subscription as string,
            status: 'active',
            guildIds: [guildId],
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        });

        await prisma.guild.update({
          where: { id: guildId },
          data: {
            premium: true,
            premiumUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        });

        await publishEvent('guild:update', { guildId, changes: { premium: true } });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const dbSub = await prisma.subscription.findUnique({ where: { stripeId: sub.id } });
        if (dbSub) {
          await prisma.subscription.update({
            where: { stripeId: sub.id },
            data: { status: 'canceled' },
          });
          for (const gid of dbSub.guildIds) {
            await prisma.guild.update({ where: { id: gid }, data: { premium: false } });
            await publishEvent('guild:update', { guildId: gid, changes: { premium: false } });
          }
        }
        break;
      }
    }

    return { received: true };
  });
}
