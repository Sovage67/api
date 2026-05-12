import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const OWNER_ID = process.env.OWNER_DISCORD_ID ?? '';

async function requireOwner(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  if (reply.sent) return;
  if (!OWNER_ID || request.user.id !== OWNER_ID) {
    reply.status(403).send({ error: 'Forbidden', message: 'Acces refuse.' });
  }
}

export async function ownerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOwner);

  app.get('/overview', async (_req, reply) => {
    const [guilds, totalUsers, activeSubscriptions, flaggedGuilds] = await Promise.all([
      prisma.guild.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          premium: true,
          premiumUntil: true,
          createdAt: true,
          installerUserId: true,
          ownerUserId: true,
          members: { select: { userId: true } },
        },
      }),
      prisma.user.count(),
      prisma.subscription.count({ where: { status: 'active' } }),
      prisma.guildRiskScore.findMany({
        where: { flagged: true },
        select: { guildId: true, score: true, reasons: true, computedAt: true },
      }),
    ]);

    const installerIds = [
      ...new Set(guilds.map((g) => g.installerUserId).filter(Boolean) as string[]),
    ];

    const [installerUsers, lastSessions] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: installerIds } },
        select: { id: true, username: true },
      }),
      prisma.dashboardSession.findMany({
        where: { userId: { in: installerIds } },
        orderBy: { createdAt: 'desc' },
        distinct: ['userId'],
        select: { userId: true, ip: true, userAgent: true, createdAt: true },
      }),
    ]);

    const userMap = new Map(installerUsers.map((u) => [u.id, u]));
    const sessionMap = new Map(lastSessions.map((s) => [s.userId, s]));
    const flaggedMap = new Map(flaggedGuilds.map((f) => [f.guildId, f]));

    const premiumCount = guilds.filter((g) => g.premium).length;

    return reply.send({
      stats: {
        totalGuilds: guilds.length,
        premiumGuilds: premiumCount,
        totalUsers,
        activeSubscriptions,
        flaggedGuilds: flaggedGuilds.length,
      },
      guilds: guilds.map((g) => {
        const installer = g.installerUserId ? userMap.get(g.installerUserId) : null;
        const session = g.installerUserId ? sessionMap.get(g.installerUserId) : null;
        const flagged = flaggedMap.get(g.id);
        return {
          id: g.id,
          name: g.name,
          premium: g.premium,
          premiumUntil: g.premiumUntil,
          createdAt: g.createdAt,
          memberCount: g.members.length,
          installer: installer
            ? { id: installer.id, username: installer.username }
            : null,
          lastIp: session?.ip ?? null,
          lastSeen: session?.createdAt ?? null,
          flagged: !!flagged,
          riskScore: flagged?.score ?? 0,
        };
      }),
    });
  });
}
