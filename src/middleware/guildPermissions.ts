import type { FastifyRequest, FastifyReply } from 'fastify';
import { getCurrentUserGuilds, hasAdminPermission } from '../lib/discord.js';
import { redis } from '../lib/redis.js';

/**
 * Vérifie que l'utilisateur connecté est admin de la guilde demandée (paramètre :id).
 * Met en cache les guildes 60s pour éviter de spammer l'API Discord.
 */
export async function requireGuildAdmin(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  if (!request.user) {
    reply.status(401).send({ error: 'Unauthorized' });
    return;
  }

  const guildId = request.params.id;
  const cacheKey = `userguilds:${request.user.id}`;
  let guilds: { id: string; permissions: string }[];

  const cached = await redis.get(cacheKey);
  if (cached) {
    guilds = JSON.parse(cached);
  } else {
    try {
      const fetched = await getCurrentUserGuilds(request.user.accessToken);
      guilds = fetched.map((g) => ({ id: g.id, permissions: g.permissions }));
      await redis.set(cacheKey, JSON.stringify(guilds), 'EX', 60);
    } catch {
      reply.status(502).send({ error: 'Discord API error' });
      return;
    }
  }

  const target = guilds.find((g) => g.id === guildId);
  if (!target || !hasAdminPermission(target.permissions)) {
    reply.status(403).send({
      error: 'Forbidden',
      message: 'Vous n\'avez pas les droits administrateurs sur ce serveur.',
    });
    return;
  }
}
