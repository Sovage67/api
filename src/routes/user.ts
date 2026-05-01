import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { getCurrentUserGuilds, hasAdminPermission } from '../lib/discord.js';
import { prisma } from '../lib/prisma.js';

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // GET /api/user/me → retourne l'utilisateur + ses serveurs admin où le bot est présent
  app.get('/me', async (request) => {
    const user = request.user!;
    const userGuilds = await getCurrentUserGuilds(user.accessToken);

    // Filtrer les serveurs où l'utilisateur est admin
    const adminGuilds = userGuilds.filter((g) => hasAdminPermission(g.permissions));

    // Croiser avec ceux où le bot est présent (en BDD)
    const botGuildIds = (
      await prisma.guild.findMany({
        where: { id: { in: adminGuilds.map((g) => g.id) } },
        select: { id: true },
      })
    ).map((g) => g.id);

    return {
      user: { id: user.id, username: user.username },
      guilds: adminGuilds.map((g) => ({
        id: g.id,
        name: g.name,
        icon: g.icon,
        botPresent: botGuildIds.includes(g.id),
      })),
    };
  });
}
