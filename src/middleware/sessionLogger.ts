/**
 * Hook qui enregistre chaque action du dashboard dans `DashboardSession`.
 * Permet :
 *   - de tracer qui configure quoi (audit trail)
 *   - de détecter la collusion : 3 "comptes propriétaires" différents qui
 *     se connectent depuis la même IP en quelques heures = signal fort
 *
 * On reste léger : 1 ligne par session par jour par guild (pas par requête)
 * pour éviter le bloat de la table.
 */

import type { FastifyRequest } from 'fastify';
import { prisma } from '../lib/prisma.js';

const seen = new Map<string, number>(); // mémoire courte : userId+guildId → ts dernière insertion

/** Anti-bloat : 1 enregistrement / 5 min par couple (user, guild) */
const DEDUP_MS = 5 * 60_000;

export async function logDashboardSession(
  request: FastifyRequest,
  guildId: string | null = null,
) {
  const user = request.user;
  if (!user) return;

  const key = `${user.id}:${guildId ?? '_'}`;
  const now = Date.now();
  const last = seen.get(key);
  if (last && now - last < DEDUP_MS) return;
  seen.set(key, now);

  // Best-effort : on ne plante pas la requête si l'écriture échoue
  try {
    await prisma.dashboardSession.create({
      data: {
        userId: user.id,
        guildId: guildId ?? undefined,
        ip: extractIp(request),
        userAgent: request.headers['user-agent']?.slice(0, 255) ?? null,
      },
    });
  } catch {
    /* ignore */
  }
}

function extractIp(request: FastifyRequest): string | null {
  const fwd = request.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  return request.ip ?? null;
}
