import type { FastifyInstance } from 'fastify';
import { exchangeCode, getCurrentUser } from '../lib/discord.js';
import { prisma } from '../lib/prisma.js';

export async function authRoutes(app: FastifyInstance) {
  // GET /api/auth/login → redirige vers Discord
  app.get('/login', async (_request, reply) => {
    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID!,
      redirect_uri: process.env.DISCORD_REDIRECT_URI!,
      response_type: 'code',
      scope: 'identify guilds',
      prompt: 'none',
    });
    return reply.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
  });

  // GET /api/auth/callback → échange le code contre un token et crée la session
  app.get<{ Querystring: { code?: string; error?: string } }>(
    '/callback',
    async (request, reply) => {
      if (request.query.error) {
        return reply.redirect('/?error=oauth_denied');
      }
      const code = request.query.code;
      if (!code) {
        return reply.status(400).send({ error: 'Code manquant' });
      }

      try {
        const tokens = await exchangeCode(code);
        const discordUser = await getCurrentUser(tokens.access_token);

        // Upsert user en BDD
        await prisma.user.upsert({
          where: { id: discordUser.id },
          create: { id: discordUser.id, username: discordUser.username },
          update: { username: discordUser.username },
        });

        // Créer un JWT signé contenant l'access token Discord
        const token = await reply.jwtSign(
          {
            id: discordUser.id,
            username: discordUser.username,
            accessToken: tokens.access_token,
          },
          { expiresIn: `${tokens.expires_in}s` },
        );

        const isProd = process.env.NODE_ENV === 'production';
        reply.setCookie('session', token, {
          path: '/',
          httpOnly: true,
          secure: isProd,
          sameSite: 'lax',
          domain: process.env.COOKIE_DOMAIN,
          maxAge: tokens.expires_in,
        });

        return reply.redirect(process.env.CORS_ORIGIN ?? 'http://localhost:3000');
      } catch (err) {
        request.log.error({ err }, 'Erreur OAuth callback');
        return reply.redirect('/?error=oauth_failed');
      }
    },
  );

  // POST /api/auth/logout → supprime le cookie
  app.post('/logout', async (_request, reply) => {
    reply.clearCookie('session', { path: '/' });
    return { success: true };
  });
}
