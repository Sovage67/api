import type { FastifyRequest, FastifyReply } from 'fastify';

// Augmenter @fastify/jwt pour que request.user soit bien typé partout
declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: {
      id: string;
      username: string;
      accessToken: string;
    };
  }
}

/**
 * Middleware qui vérifie le JWT en cookie et attache l'utilisateur à la requête.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify({ onlyCookie: true });
  } catch {
    reply.status(401).send({ error: 'Unauthorized', message: 'Connexion requise' });
  }
}
