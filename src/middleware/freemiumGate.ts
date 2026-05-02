/**
 * Gate freemium : appelé avant d'écrire des paramètres sensibles sur un Guild
 * (toggle d'un module premium, etc.).
 *
 * Si le serveur est gelé pour cause de quota → on accepte la sauvegarde des
 * champs cosmétiques (prefix, langue, messages welcome) mais on REFUSE toute
 * activation d'un module premium et on renvoie 402 Payment Required avec
 * les infos d'upsell.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { getInstallerUsage, FREE_QUOTA, PREMIUM_QUOTA } from '../lib/freemium.js';

const PREMIUM_MODULES = new Set([
  'tickets',
  'polls',
  'reactionRoles',
  'music',
  'translation',
  'stats',
  'databaseId',
]);

/**
 * Pré-handler à attacher AVANT la route PATCH /:id.
 * - Si le guild est frozen + le body tente d'activer un module premium → 402.
 * - Sinon laisse passer.
 */
export async function freemiumPatchGate(
  request: FastifyRequest<{ Params: { id: string }; Body: Record<string, unknown> }>,
  reply: FastifyReply,
) {
  const guildId = request.params.id;
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { licenseFrozen: true, premium: true, installerUserId: true },
  });
  if (!guild) return; // route gérera le 404 elle-même

  if (!guild.licenseFrozen) return;

  // Guild gelée → on regarde si l'utilisateur tente d'activer un module premium
  const body = (request.body ?? {}) as { modules?: Record<string, boolean> };
  const modules = body.modules ?? {};
  const tryEnableLocked = Object.entries(modules).some(
    ([key, value]) => value === true && PREMIUM_MODULES.has(key),
  );

  if (!tryEnableLocked) return; // on laisse passer les modifs cosmétiques

  // Refus : on renvoie 402 avec un petit récap utile pour le dashboard
  const usage = guild.installerUserId
    ? await getInstallerUsage(guild.installerUserId)
    : null;

  reply.status(402).send({
    error: 'LicenseFrozen',
    message:
      'Ce serveur est en mode dormant. Le quota gratuit est de 1 serveur par utilisateur.',
    quotas: { free: FREE_QUOTA, premium: PREMIUM_QUOTA },
    usage,
  });
}
