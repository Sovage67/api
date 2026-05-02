import 'dotenv/config';
import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { authRoutes } from './routes/auth.js';
import { guildRoutes } from './routes/guilds.js';
import { userRoutes } from './routes/user.js';
import { stripeRoutes } from './routes/stripe.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
});

async function bootstrap() {
  // Sécurité
  await app.register(helmet);
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN?.split(',') ?? 'http://localhost:3000',
    credentials: true,
  });
  await app.register(cookie);
  await app.register(jwt, {
    secret: process.env.SESSION_SECRET ?? 'change-me-please',
    cookie: { cookieName: 'session', signed: false },
  });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    redis,
  });

  // Health check
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  // Status public (bot, API, DB, Redis)
  app.get('/api/status', async (_req, reply) => {
    const results: Record<string, { ok: boolean; latencyMs?: number }> = {};

    // API elle-même
    results.api = { ok: true };

    // Base de données
    try {
      const t0 = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      results.database = { ok: true, latencyMs: Date.now() - t0 };
    } catch {
      results.database = { ok: false };
    }

    // Redis
    try {
      const t0 = Date.now();
      await redis.ping();
      results.redis = { ok: true, latencyMs: Date.now() - t0 };
    } catch {
      results.redis = { ok: false };
    }

    // Bot (via Discord API — vérifie si le bot répond)
    try {
      const t0 = Date.now();
      const botToken = process.env.DISCORD_TOKEN ?? process.env.BOT_TOKEN;
      const res = await fetch(`https://discord.com/api/v10/users/@me`, {
        headers: { Authorization: `Bot ${botToken}` },
      });
      results.bot = { ok: res.ok, latencyMs: Date.now() - t0 };
    } catch {
      results.bot = { ok: false };
    }

    const allOk = Object.values(results).every((r) => r.ok);
    return reply.status(allOk ? 200 : 207).send({
      status: allOk ? 'operational' : 'degraded',
      timestamp: new Date().toISOString(),
      services: results,
    });
  });

  // Routes
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(userRoutes, { prefix: '/api/user' });
  await app.register(guildRoutes, { prefix: '/api/guilds' });
  await app.register(stripeRoutes, { prefix: '/api/stripe' });

  // Gestion d'erreur globale
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: error.name,
      message: statusCode === 500 ? 'Erreur interne du serveur' : error.message,
    });
  });

  // Arrêt propre
  const shutdown = async () => {
    app.log.info('Arrêt en cours...');
    await app.close();
    await prisma.$disconnect();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`API démarrée sur le port ${port}`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
