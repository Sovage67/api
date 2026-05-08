import type { FastifyRequest, FastifyReply } from 'fastify';
import { redis } from '../lib/redis.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: {
      id: string;
      username: string;
      sessionId: string;
      accessToken: string;
    };
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify({ onlyCookie: true });

    const { sessionId } = request.user as { sessionId?: string };
    if (!sessionId) {
      reply.status(401).send({ error: 'Unauthorized', message: 'Session invalide' });
      return;
    }

    const accessToken = await redis.get('session:token:' + sessionId);
    if (!accessToken) {
      reply.clearCookie('session', { path: '/' });
      reply.status(401).send({ error: 'Unauthorized', message: 'Session expiree, reconnectez-vous' });
      return;
    }

    (request.user as { accessToken: string }).accessToken = accessToken;
  } catch {
    reply.status(401).send({ error: 'Unauthorized', message: 'Connexion requise' });
  }
}
