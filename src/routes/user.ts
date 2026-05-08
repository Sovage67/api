import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { logDashboardSession } from '../middleware/sessionLogger.js';
import { getCurrentUserGuilds, hasAdminPermission } from '../lib/discord.js';
import { prisma } from '../lib/prisma.js';
import { getInstallerUsage, FREE_QUOTA, PREMIUM_QUOTA } from '../lib/freemium.js';

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/me', async (request) => {
    const user = request.user!;
    const userGuilds = await getCurrentUserGuilds(user.accessToken);
    const adminGuilds = userGuilds.filter((g) => hasAdminPermission(g.permissions));
    const adminIds = adminGuilds.map((g) => g.id);

    const dbGuilds = await prisma.guild.findMany({
      where: { id: { in: adminIds } },
      select: { id: true, licenseFrozen: true, installerUserId: true, licenseHolderId: true, premium: true },
    });
    const dbMap = new Map(dbGuilds.map((g) => [g.id, g]));
    const myUsage = await getInstallerUsage(user.id);
    await logDashboardSession(request, null);

    return {
      user: { id: user.id, username: user.username },
      license: { quotas: { free: FREE_QUOTA, premium: PREMIUM_QUOTA }, usage: myUsage },
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
