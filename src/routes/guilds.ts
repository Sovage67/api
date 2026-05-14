import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireGuildAdmin } from '../middleware/guildPermissions.js';
import { freemiumPatchGate } from '../middleware/freemiumGate.js';
import { logDashboardSession } from '../middleware/sessionLogger.js';
import { prisma } from '../lib/prisma.js';
import { publishEvent } from '../lib/redis.js';
import { claimLicenseHolder, getInstallerUsage, FREE_QUOTA, PREMIUM_QUOTA } from '../lib/freemium.js';
import { getBotGuildChannels, getBotGuildRoles, getBotGuildDetail } from '../lib/discord.js';

// ID Discord valide : 17 à 20 chiffres uniquement
const discordId = z.string().regex(/^\d{17,20}$/, 'ID Discord invalide').nullable().optional();

const updateGuildSchema = z.object({
  prefix: z.string().min(1).max(5).optional(),
  language: z.enum(['fr', 'en', 'es']).optional(),
  welcomeChannel: discordId,
  welcomeMessage: z.string().max(2000).nullable().optional(),
  leaveChannel: discordId,
  leaveMessage: z.string().max(2000).nullable().optional(),
  logsChannel: discordId,
  autoRole: discordId,
  modules: z.object({
    economy: z.boolean().optional(),
    levels: z.boolean().optional(),
    moderation: z.boolean().optional(),
    tickets: z.boolean().optional(),
    polls: z.boolean().optional(),
    reactionRoles: z.boolean().optional(),
    music: z.boolean().optional(),
    translation: z.boolean().optional(),
    stats: z.boolean().optional(),
    databaseId: z.boolean().optional(),
    antiInsulte: z.boolean().optional(),
    antiraid: z.boolean().optional(),
    surveillance: z.boolean().optional(),
    invitations: z.boolean().optional(),
    messagesRecurrents: z.boolean().optional(),
    livesTwitch: z.boolean().optional(),
    commandesCustom: z.boolean().optional(),
  }).passthrough().optional(),
  ticketCategory: discordId,
  ticketSupportRole: discordId,
  ticketOpenMessage: z.string().max(2000).nullable().optional(),
  ticketVoice: z.boolean().optional(),
  ticketVoiceCategory: discordId,
  botNickname: z.string().max(32).nullable().optional(),
  botDescription: z.string().max(190).nullable().optional(),
  translationTarget: z.enum(['fr', 'en', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'ko', 'zh']).optional(),
  statsChannel: discordId,
  memberLogsChannel: discordId,
  databaseIdAdminRole: discordId,
});

export async function guildRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireGuildAdmin }, async (request, reply) => {
    const guild = await prisma.guild.findUnique({ where: { id: request.params.id } });
    if (!guild) return reply.status(404).send({ error: 'Not Found', message: 'Le bot nest pas sur ce serveur.' });
    if (request.user && !guild.licenseHolderId) await claimLicenseHolder(guild.id, request.user.id);
    await logDashboardSession(request, guild.id);
    const usage = guild.installerUserId ? await getInstallerUsage(guild.installerUserId) : null;
    return {
      ...guild,
      license: {
        frozen: guild.licenseFrozen,
        isInstaller: request.user?.id === guild.installerUserId,
        isLicenseHolder: request.user?.id === guild.licenseHolderId,
        quotas: { free: FREE_QUOTA, premium: PREMIUM_QUOTA },
        usage,
      },
    };
  });

  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateGuildSchema> }>(
    '/:id',
    { preHandler: [requireGuildAdmin, freemiumPatchGate] },
    async (request, reply) => {
      const parsed = updateGuildSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      // @ts-ignore
      const updated = await prisma.guild.update({ where: { id: request.params.id }, data: parsed.data });
      await publishEvent('guild:update', { guildId: updated.id, changes: parsed.data });
      await logDashboardSession(request, updated.id);
      return updated;
    },
  );

  app.get<{ Params: { id: string } }>('/:id/channels', { preHandler: requireGuildAdmin }, async (request, reply) => {
    try {
      const channels = await getBotGuildChannels(request.params.id);
      return channels.filter((c) => [0, 2, 4, 5, 15].includes(c.type)).sort((a, b) => a.position - b.position);
    } catch {
      return reply.status(502).send({ error: 'Impossible de recuperer les salons.' });
    }
  });

  app.get<{ Params: { id: string } }>('/:id/roles', { preHandler: requireGuildAdmin }, async (request, reply) => {
    try {
      const roles = await getBotGuildRoles(request.params.id);
      return roles.filter((r) => r.name !== '@everyone' && !r.managed).sort((a, b) => b.position - a.position);
    } catch {
      return reply.status(502).send({ error: 'Impossible de recuperer les roles.' });
    }
  });

  app.get<{ Params: { id: string } }>('/:id/stats', { preHandler: requireGuildAdmin }, async (request, reply) => {
    try {
      const [guildDetail, memberCount, warnCount, recentJoins, recentLeaves] = await Promise.all([
        getBotGuildDetail(request.params.id),
        prisma.member.count({ where: { guildId: request.params.id } }),
        prisma.warn.count({ where: { guildId: request.params.id } }),
        prisma.memberLog.count({ where: { guildId: request.params.id, type: 'join', createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } }),
        prisma.memberLog.count({ where: { guildId: request.params.id, type: 'leave', createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } }),
      ]);
      return {
        name: guildDetail.name,
        icon: guildDetail.icon,
        memberCount: guildDetail.approximate_member_count ?? memberCount,
        onlineCount: guildDetail.approximate_presence_count ?? 0,
        boostCount: guildDetail.premium_subscription_count ?? 0,
        boostTier: guildDetail.premium_tier ?? 0,
        totalWarns: warnCount,
        joinsThisWeek: recentJoins,
        leavesThisWeek: recentLeaves,
        dbMembers: memberCount,
      };
    } catch {
      return reply.status(502).send({ error: 'Impossible de recuperer les stats.' });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { page?: string; type?: string } }>(
    '/:id/logs',
    { preHandler: requireGuildAdmin },
    async (request) => {
      const page = Math.max(1, parseInt(request.query.page ?? '1', 10));
      const type = request.query.type;
      const take = 50;
      const skip = (page - 1) * take;
      const where = { guildId: request.params.id, ...(type ? { type } : {}) };
      const [logs, total] = await Promise.all([
        prisma.memberLog.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
        prisma.memberLog.count({ where }),
      ]);
      return { logs, total, page, pages: Math.ceil(total / take) };
    },
  );

  app.get<{ Params: { id: string } }>('/:id/warns', { preHandler: requireGuildAdmin }, async (request) => {
    return prisma.warn.findMany({ where: { guildId: request.params.id }, orderBy: { createdAt: 'desc' }, take: 100 });
  });
}
