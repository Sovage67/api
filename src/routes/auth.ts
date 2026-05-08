import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { exchangeCode, getCurrentUser } from '../lib/discord.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

async function generateOAuthState(): Promise<string> {
  const state = crypto.randomBytes(32).toString('hex');
  await redis.set('oauth:state:' + state, '1', 'EX', 600);
  return state;
}

async function verifyOAuthState(state: string): Promise<boolean> {
  const key = 'oauth:state:' + state;
  const exists = await redis.get(key);
  if (!exists) return false;
  await redis.del(key);
  return true;
}

export async function authRoutes(app: FastifyInstance) {
  const authRateLimit = { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } };

  app.get('/login', authRateLimit, async (_request, reply) => {
    const state = await generateOAuthState();
    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID!,
      redirect_uri: process.env.DISCORD_REDIRECT_URI!,
      response_type: 'code',
      scope: 'identify guilds',
      prompt: 'none',
      state,
    });
    return reply.redirect('https://discord.com/api/oauth2/authorize?' + params.toString());
  });

  app.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
    '/callback',
    authRateLimit,
    async (request, reply) => {
      if (request.query.error) return reply.redirect('/?error=oauth_denied');

      const { code, state } = request.query;
      if (!state || !(await verifyOAuthState(state))) {
        request.log.warn('OAuth callback: invalid CSRF state');
        return reply.redirect('/?error=invalid_state');
      }
      if (!code) return reply.status(400).send({ error: 'Code manquant' });

      try {
        const tokens = await exchangeCode(code);
        const discordUser = await getCurrentUser(tokens.access_token);

        await prisma.user.upsert({
          where: { id: discordUser.id },
          create: { id: discordUser.id, username: discordUser.username },
          update: { username: discordUser.username },
        });

        const sessionId = crypto.randomBytes(32).toString('hex');
        await redis.set('session:token:' + sessionId, tokens.access_token, 'EX', tokens.expires_in);

        const token = await reply.jwtSign(
          { id: discordUser.id, username: discordUser.username, sessionId },
          { expiresIn: tokens.expires_in + 's' },
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
        request.log.error({ err }, 'OAuth callback error');
        return reply.redirect('/?error=oauth_failed');
      }
    },
  );

  app.post('/logout', async (request, reply) => {
    try {
      const decoded = await request.jwtVerify<{ sessionId?: string }>({ onlyCookie: true });
      if (decoded?.sessionId) await redis.del('session:token:' + decoded.sessionId);
    } catch { /* JWT expire ou absent */ }
    reply.clearCookie('session', { path: '/' });
    return { success: true };
  });
}
