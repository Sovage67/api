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
import { ownerRoutes } from './routes/owner.js';

const SESSION_SECRET = process.env.SESSION_SECRET ?? '';
if (!SESSION_SECRET || SESSION_SECRET === 'change-me-please' || SESSION_SECRET.length < 32) {
  console.error('FATAL: SESSION_SECRET manquant ou trop court (32+ caracteres requis)');
  process.exit(1);
}

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
  trustProxy: true,
});

async function bootstrap() {
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginEmbedderPolicy: false });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN?.split(',') ?? 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie);

  await app.register(jwt, {
    secret: SESSION_SECRET,
    cookie: { cookieName: 'session', signed: false },
  });

  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    redis,
    // FIX: Rate limit par userId si authentifie, sinon par IP.
    // Empeche le contournement via proxies / IPs multiples.
    keyGenerator: (req) => {
      try {
        const cookies = req.cookies as Record<string, string | undefined>;
        const session = cookies?.session ?? '';
        if (session) {
          const parts = session.split('.');
          if (parts.length === 3) {
            const raw = Buffer.from(parts[1], 'base64').toString('utf8');
            const payload = JSON.parse(raw) as { id?: string };
            if (payload.id) return 'user:' + payload.id;
          }
        }
      } catch (_e) { /* cookie absent ou malforme */ }
      return req.ip;
    },
    errorResponseBuilder: () => ({
      error: 'TooManyRequests',
      message: 'Trop de requetes, reessayez dans une minute.',
    }),
  });

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    if (req.url?.startsWith('/api/stripe/')) {
      done(null, body);
      return;
    }
    try {
      done(null, JSON.parse(body.toString()));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // FIX: /health limite a 30 req/min (rateLimit: false supprime)
  app.get('/health', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  app.get('/api/status', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (_req, reply) => {
    const results: Record<string, { ok: boolean; latencyMs?: number }> = {};
    results.api = { ok: true };

    try {
      const t0 = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      results.database = { ok: true, latencyMs: Date.now() - t0 };
    } catch { results.database = { ok: false }; }

    try {
      const t0 = Date.now();
      await redis.ping();
      results.redis = { ok: true, latencyMs: Date.now() - t0 };
    } catch { results.redis = { ok: false }; }

    // FIX: AbortController 3s pour eviter les hangs infinis si Discord est lent
    try {
      const t0 = Date.now();
      const botToken = process.env.DISCORD_TOKEN ?? process.env.BOT_TOKEN;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3000);
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: 'Bot ' + botToken },
        signal: ac.signal,
      });
      clearTimeout(timer);
      results.bot = { ok: res.ok, latencyMs: Date.now() - t0 };
    } catch { results.bot = { ok: false }; }

    const allOk = Object.values(results).every((r) => r.ok);
    return reply.status(allOk ? 200 : 207).send({
      status: allOk ? 'operational' : 'degraded',
      timestamp: new Date().toISOString(),
      services: results,
    });
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(userRoutes, { prefix: '/api/user' });
  await app.register(guildRoutes, { prefix: '/api/guilds' });
  await app.register(stripeRoutes, { prefix: '/api/stripe' });
  await app.register(ownerRoutes, { prefix: '/api/owner' });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: error.name,
      message: statusCode === 500 ? 'Erreur interne du serveur' : error.message,
    });
  });

  const shutdown = async () => {
    app.log.info('Arret en cours...');
    await app.close();
    await prisma.$disconnect();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info('API demarree sur le port ' + port);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
