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
        prisma.memberLog.count({ where: { guildId: request.params.id, type: 'join', createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } }),
        prisma.memberLog.count({ where: { guildId: request.params.id, type: 'leave', createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } }),
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

  app.get<{ Params: { id: string }; Querystring: { range?: string } }>(
    '/:id/stats/history',
    { preHandler: requireGuildAdmin },
    async (request, reply) => {
      const range = request.query.range ?? 'week';
      const now = new Date();
      let startDate: Date;
      switch (range) {
        case 'day':   startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); break;
        case 'month': startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
        case 'year':  startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); break;
        default:      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      }

      const guildId = request.params.id;

      try {
        const heatmapStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const [memberLogs, messageData, heatmapRaw, reactionData] = await Promise.all([
          prisma.memberLog.findMany({
            where: { guildId, createdAt: { gte: startDate } },
            select: { type: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          }),
          // @ts-ignore — MessageActivity ajouté via migration Prisma
          prisma.messageActivity.findMany({
            where: { guildId, bucket: { gte: startDate } },
            select: { bucket: true, count: true },
            orderBy: { bucket: 'asc' },
          }),
          // @ts-ignore
          prisma.messageActivity.findMany({
            where: { guildId, bucket: { gte: heatmapStart } },
            select: { bucket: true, count: true },
          }),
          // @ts-ignore — ReactionActivity ajouté via migration Prisma
          prisma.reactionActivity.findMany({
            where: { guildId, bucket: { gte: startDate } },
            select: { bucket: true, count: true },
            orderBy: { bucket: 'asc' },
          }),
        ]);

        // Grouper les logs membres par jour
        const memberByDay = new Map<string, { joins: number; leaves: number }>();
        for (const log of memberLogs) {
          const day = log.createdAt.toISOString().slice(0, 10);
          if (!memberByDay.has(day)) memberByDay.set(day, { joins: 0, leaves: 0 });
          const entry = memberByDay.get(day)!;
          if (log.type === 'join') entry.joins++;
          else entry.leaves++;
        }
        const members = Array.from(memberByDay.entries())
          .map(([date, d]) => ({ date, joins: d.joins, leaves: d.leaves, net: d.joins - d.leaves }))
          .sort((a, b) => a.date.localeCompare(b.date));

        // Buckets horaires bruts (agrégation côté dashboard)
        const messages = (messageData as { bucket: Date; count: number }[]).map(m => ({
          date: m.bucket.toISOString(),
          count: m.count,
        }));

        // Heatmap 7j × 24h : grouper par (jour semaine Mon=0, heure)
        const heatmapMap = new Map<string, number>();
        for (const h of heatmapRaw as { bucket: Date; count: number }[]) {
          const dayOfWeek = (h.bucket.getUTCDay() + 6) % 7; // 0=Lun … 6=Dim
          const hour = h.bucket.getUTCHours();
          const key = `${dayOfWeek}-${hour}`;
          heatmapMap.set(key, (heatmapMap.get(key) ?? 0) + h.count);
        }
        const heatmap = Array.from(heatmapMap.entries()).map(([key, count]) => {
          const [day, hour] = key.split('-').map(Number);
          return { day, hour, count };
        });

        // Réactions : buckets horaires bruts (agrégation côté dashboard)
        const reactions = (reactionData as { bucket: Date; count: number }[]).map(r => ({
          date: r.bucket.toISOString(),
          count: r.count,
        }));

        return { range, members, messages, heatmap, reactions };
      } catch {
        return reply.status(502).send({ error: 'Impossible de récupérer l\'historique.' });
      }
    },
  );

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

  // ── Anti-Insulte ────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/antiinsulte', { preHandler: requireGuildAdmin }, async (request, reply) => {
    try {
      // @ts-ignore
      let cfg = await prisma.antiInsulteConfig.findUnique({ where: { guildId: request.params.id } });
      if (!cfg) {
        // @ts-ignore
        cfg = await prisma.antiInsulteConfig.create({
          data: { guildId: request.params.id, words: [], exemptRoles: [], exemptChannels: [] },
        });
      }
      return cfg;
    } catch {
      return reply.status(500).send({ error: 'Erreur lors de la récupération de la config.' });
    }
  });

  const antiInsulteSchema = z.object({
    enabled:         z.boolean().optional(),
    words:                z.array(z.string().max(50)).max(200).optional(),
    removedDefaultWords:  z.array(z.string().max(50)).max(200).optional(),
    action:          z.enum(['delete', 'warn', 'timeout', 'kick']).optional(),
    timeoutDuration: z.number().int().min(10).max(2419200).optional(), // 10s → 28 jours
    kickAfterWarns:  z.number().int().min(1).max(5).optional(),
    warnMaxCount:    z.number().int().min(1).max(5).optional(),
    warnMessages:    z.array(z.string().max(500)).max(5).optional(),
    warnDm:          z.boolean().optional(),
    exemptRoles:     z.array(z.string().regex(/^\d{17,20}$/)).max(50).optional(),
    exemptChannels:  z.array(z.string().regex(/^\d{17,20}$/)).max(50).optional(),
    logChannelId:    z.string().regex(/^\d{17,20}$/).nullable().optional(),
    modPingRoleId:   z.string().regex(/^\d{17,20}$/).nullable().optional(),
  });

  app.get<{ Params: { id: string } }>(
    '/:id/antiinsulte/logs/export',
    { preHandler: requireGuildAdmin },
    async (request, reply) => {
      try {
        // @ts-ignore
        const logs = await prisma.antiInsulteLog.findMany({
          where: { guildId: request.params.id },
          orderBy: { createdAt: 'desc' },
          take: 10000,
        });
        return logs;
      } catch {
        return reply.status(500).send({ error: 'Erreur lors de l\'export.' });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { page?: string } }>(
    '/:id/antiinsulte/logs',
    { preHandler: requireGuildAdmin },
    async (request, reply) => {
      const page = Math.max(1, parseInt(request.query.page ?? '1', 10));
      const take = 50;
      const skip = (page - 1) * take;
      try {
        // @ts-ignore
        const [logs, total] = await Promise.all([
          // @ts-ignore
          prisma.antiInsulteLog.findMany({
            where: { guildId: request.params.id },
            orderBy: { createdAt: 'desc' },
            take, skip,
          }),
          // @ts-ignore
          prisma.antiInsulteLog.count({ where: { guildId: request.params.id } }),
        ]);
        // Top offenders
        // @ts-ignore
        const raw = await prisma.antiInsulteLog.groupBy({
          by: ['userId', 'username'],
          where: { guildId: request.params.id },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
          take: 50,
        });
        const topOffenders = raw.map((r: { userId: string; username: string; _count: { id: number } }) => ({
          userId: r.userId,
          username: r.username,
          count: r._count.id,
        }));
        return { logs, total, page, pages: Math.ceil(total / take), topOffenders };
      } catch {
        return reply.status(500).send({ error: 'Erreur lors de la récupération des logs.' });
      }
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/:id/antiinsulte/logs/user/:userId',
    { preHandler: requireGuildAdmin },
    async (request, reply) => {
      try {
        // @ts-ignore
        const { count } = await prisma.antiInsulteLog.deleteMany({
          where: { guildId: request.params.id, userId: request.params.userId },
        });
        return { deleted: count };
      } catch {
        return reply.status(500).send({ error: 'Erreur lors de la suppression.' });
      }
    },
  );

  // ── Anti-Raid ───────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/antiraid', { preHandler: requireGuildAdmin }, async (request, reply) => {
    try {
      // @ts-ignore
      let cfg = await prisma.antiRaidConfig.findUnique({ where: { guildId: request.params.id } });
      if (!cfg) {
        // @ts-ignore
        cfg = await prisma.antiRaidConfig.create({ data: { guildId: request.params.id } });
      }
      return cfg;
    } catch {
      return reply.status(500).send({ error: 'Erreur lors de la récupération de la config anti-raid.' });
    }
  });

  const antiRaidSchema = z.object({
    enabled:        z.boolean().optional(),
    joinEnabled:    z.boolean().optional(),
    joinThreshold:  z.number().int().min(2).max(100).optional(),
    joinWindow:     z.number().int().min(1).max(60).optional(),
    suspectEnabled: z.boolean().optional(),
    minAccountAge:  z.number().int().min(0).max(365).optional(),
    botApiEnabled:  z.boolean().optional(),
    linkEnabled:    z.boolean().optional(),
    linkThreshold:  z.number().int().min(1).max(20).optional(),
    linkWindow:     z.number().int().min(1).max(60).optional(),
    banPurgeDays:   z.number().int().min(0).max(7).optional(),
    logChannelId:   z.string().regex(/^\d{17,20}$/).nullable().optional(),
    modPingRoleId:  z.string().regex(/^\d{17,20}$/).nullable().optional(),
  });

  app.patch<{ Params: { id: string }; Body: z.infer<typeof antiRaidSchema> }>(
    '/:id/antiraid',
    { preHandler: requireGuildAdmin },
    async (request, reply) => {
      const parsed = antiRaidSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      try {
        // @ts-ignore
        const cfg = await prisma.antiRaidConfig.upsert({
          where: { guildId: request.params.id },
          create: { guildId: request.params.id, ...parsed.data },
          update: parsed.data,
        });
        await publishEvent('antiraid:update', { guildId: request.params.id });
        return cfg;
      } catch {
        return reply.status(500).send({ error: 'Erreur lors de la mise à jour de la config anti-raid.' });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { page?: string } }>(
    '/:id/antiraid/logs',
    { preHandler: requireGuildAdmin },
    async (request, reply) => {
      const page = Math.max(1, parseInt(request.query.page ?? '1', 10));
      const take = 50;
      const skip = (page - 1) * take;
      try {
        // @ts-ignore
        const [logs, total] = await Promise.all([
          // @ts-ignore
          prisma.antiRaidLog.findMany({
            where: { guildId: request.params.id },
            orderBy: { createdAt: 'desc' },
            take, skip,
          }),
          // @ts-ignore
          prisma.antiRaidLog.count({ where: { guildId: request.params.id } }),
        ]);
        return { logs, total, page, pages: Math.ceil(total / take) };
      } catch {
        return reply.status(500).send({ error: 'Erreur lors de la récupération des logs anti-raid.' });
      }
    },
  );

  // ── Traduction auto ──────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/traduction', { preHandler: requireGuildAdmin }, async (request, reply) => {
    try {
      // @ts-ignore
      let cfg = await prisma.traductionConfig.findUnique({ where: { guildId: request.params.id } });
      if (!cfg) {
        // @ts-ignore
        cfg = await prisma.traductionConfig.create({
          data: { guildId: request.params.id, channels: [] },
        });
      }
      return cfg;
    } catch {
      return reply.status(500).send({ error: 'Erreur lors de la récupération de la config traduction.' });
    }
  });

  const traductionSchema = z.object({
    enabled:      z.boolean().optional(),
    targetLang:   z.enum(['fr','en','es','de','it','pt','nl','pl','ru','ja','ko','zh','ar','tr','sv','da','nb','fi','uk','id']).optional(),
    mode:         z.enum(['reply', 'embed']).optional(),
    channelMode:  z.enum(['all', 'whitelist', 'blacklist']).optional(),
    channels:     z.array(z.string().regex(/^\d{17,20}$/)).max(100).optional(),
    skipSameLang: z.boolean().optional(),
  });

  app.patch<{ Params: { id: string }; Body: z.infer<typeof traductionSchema> }>(
    '/:id/traduction',
    { preHandler: requireGuildAdmin },
    async (request, reply) => {
      const parsed = traductionSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      try {
        // @ts-ignore
        const cfg = await prisma.traductionConfig.upsert({
          where: { guildId: request.params.id },
          create: { guildId: request.params.id, channels: [], ...parsed.data },
          update: parsed.data,
        });
        await publishEvent('traduction:update', { guildId: request.params.id });
        return cfg;
      } catch {
        return reply.status(500).send({ error: 'Erreur lors de la mise à jour de la config traduction.' });
      }
    },
  );

  // ── Arrivées & Départs ──────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/arrivees', { preHandler: requireGuildAdmin }, async (request, reply) => {
    try {
      // @ts-ignore
      let cfg = await prisma.arriveesDepartsConfig.findUnique({ where: { guildId: request.params.id } });
      if (!cfg) {
        // @ts-ignore
        cfg = await prisma.arriveesDepartsConfig.create({ data: { guildId: request.params.id } });
      }
      return cfg;
    } catch {
      return reply.status(500).send({ error: 'Erreur lors de la récupération de la config arrivées.' });
    }
  });

  const arriveeSchema = z.object({
    autoRoleEnabled: z.boolean().optional(),
    autoRoleId:      z.string().regex(/^\d{17,20}$/).nullable().optional(),
    welcomeEnabled:  z.boolean().optional(),
    welcomeChannel:  z.string().regex(/^\d{17,20}$/).nullable().optional(),
    welcomeMessage:  z.string().max(500).optional(),
    welcomeFormat:   z.enum(['text', 'embed']).optional(),
    welcomeMention:  z.boolean().optional(),
    welcomeImageUrl: z.string().url().max(500).nullable().optional(),
    goodbyeEnabled:  z.boolean().optional(),
    goodbyeChannel:  z.string().regex(/^\d{17,20}$/).nullable().optional(),
    goodbyeMessage:  z.string().max(500).optional(),
    goodbyeFormat:   z.enum(['text', 'embed']).optional(),
    goodbyeImageUrl: z.string().url().max(500).nullable().optional(),
  });

  app.patch<{ Params: { id: string }; Body: z.infer<typeof arriveeSchema> }>(
    '/:id/arrivees',
    { preHandler: requireGuildAdmin },
    async (request, reply) => {
      const parsed = arriveeSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      try {
        // @ts-ignore
        const cfg = await prisma.arriveesDepartsConfig.upsert({
          where: { guildId: request.params.id },
          create: { guildId: request.params.id, ...parsed.data },
          update: parsed.data,
        });
        await publishEvent('arrivees:update', { guildId: request.params.id });
        return cfg;
      } catch {
        return reply.status(500).send({ error: 'Erreur lors de la mise à jour de la config arrivées.' });
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: z.infer<typeof antiInsulteSchema> }>(
    '/:id/antiinsulte',
    { preHandler: requireGuildAdmin },
    async (request, reply) => {
      const parsed = antiInsulteSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      try {
        // @ts-ignore
        const cfg = await prisma.antiInsulteConfig.upsert({
          where: { guildId: request.params.id },
          create: { guildId: request.params.id, words: [], exemptRoles: [], exemptChannels: [], ...parsed.data },
          update: parsed.data,
        });
        // Invalider le cache bot via Redis pub/sub
        await publishEvent('antiinsulte:update', { guildId: request.params.id });
        return cfg;
      } catch {
        return reply.status(500).send({ error: 'Erreur lors de la mise à jour.' });
      }
    },
  );
}
