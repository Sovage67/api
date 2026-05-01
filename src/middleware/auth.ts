import type { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
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
    const decoded = await request.jwtVerify<{
      id: string;
      username: string;
      accessToken: string;
    }>({ onlyCookie: true });
    request.user = decoded;
  } catch {
    reply.status(401).send({ error: 'Unauthorized', message: 'Connexion requise' });
  }
}
