import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { logDashboardSession } from '../middleware/sessionLogger.js';
import { getCurrentUserGuilds, hasAdminPermission } from '../lib/discord.js';
import { prisma } from '../lib/prisma.js';
import { getInstallerUsage, FREE_QUOTA, PREMIUM_QUOTA } from '../lib/freemium.js';

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // GET /api/user/me → utilisateur + serveurs admin (avec état freemium)
  app.get('/me', async (request) => {
    const user = request.user!;
    const userGuilds = await getCurrentUserGuilds(user.accessToken);

    // Filtrer les serveurs où l'utilisateur est admin
    const adminGuilds = userGuilds.filter((g) => hasAdminPermission(g.permissions));

    // Croiser avec ceux où le bot est présent (BDD) + récupérer l'état licence
    const adminIds = adminGuilds.map((g) => g.id);
    const dbGuilds = await prisma.guild.findMany({
      where: { id: { in: adminIds } },
      select: {
        id: true,
        licenseFrozen: true,
        installerUserId: true,
        licenseHolderId: true,
        premium: true,
      },
    });
    const dbMap = new Map(dbGuilds.map((g) => [g.id, g]));

    // Stats freemium pour l'utilisateur (combien de serveurs il a installé)
    const myUsage = await getInstallerUsage(user.id);

    // Log de la session
    await logDashboardSession(request, null);

    return {
      user: { id: user.id, username: user.username },
      license: {
        quotas: { free: FREE_QUOTA, premium: PREMIUM_QUOTA },
        usage: myUsage,
      },
      guilds: adminGuilds.map((g) => {
        const db = dbMap.get(g.id);
        return {
          id: g.id,
          name: g.name,
          icon: g.icon,
          botPresent: !!db,
          licenseFrozen: db?.licenseFrozen ?? false,
          isInstaller: db?.installerUserId === user.id,
          isLicenseHolder: db?.licenseHolderId === user.id,
          premium: db?.premium ?? false,
        };
      }),
    };
  });
}
