import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireGuildAdmin } from '../middleware/guildPermissions.js';
import { prisma } from '../lib/prisma.js';
import { publishEvent } from '../lib/redis.js';

const updateGuildSchema = z.object({
  prefix: z.string().min(1).max(5).optional(),
  language: z.enum(['fr', 'en', 'es']).optional(),
  welcomeChannel: z.string().nullable().optional(),
  welcomeMessage: z.string().max(2000).nullable().optional(),
  leaveChannel: z.string().nullable().optional(),
  leaveMessage: z.string().max(2000).nullable().optional(),
  logsChannel: z.string().nullable().optional(),
  autoRole: z.string().nullable().optional(),
  modules: z
    .object({
      economy: z.boolean().optional(),
      levels: z.boolean().optional(),
      moderation: z.boolean().optional(),
    })
    .optional(),
});

export async function guildRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // GET /api/guilds/:id → récupère la config
  app.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireGuildAdmin },
    async (request, reply) => {
      const guild = await prisma.guild.findUnique({ where: { id: request.params.id } });
      if (!guild) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Le bot n\'est pas sur ce serveur.' });
      }
      return guild;
    },
  );

  // PATCH /api/guilds/:id → modifie la config
  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateGuildSchema> }>(
    '/:id',
    { preHandler: requireGuildAdmin },
    async (request, reply) => {
      const parsed = updateGuildSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      }

      const updated = await prisma.guild.update({
        where: { id: request.params.id },
        data: parsed.data,
      });

      // Notifier le bot via Redis
      await publishEvent('guild:update', {
        guildId: updated.id,
        changes: parsed.data,
      });

      return updated;
    },
  );

  // GET /api/guilds/:id/warns → liste des warns
  app.get<{ Params: { id: string } }>(
    '/:id/warns',
    { preHandler: requireGuildAdmin },
    async (request) => {
      const warns = await prisma.warn.findMany({
        where: { guildId: request.params.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return warns;
    },
  );
}
