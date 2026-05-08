/**
 * Couche freemium côté API (jumelle de bot/src/lib/freemium.ts).
 *
 * Règle : 1 utilisateur Discord = 1 serveur gratuit.
 * - Quota free  : 1 serveur par installerUserId
 * - Quota premium : 3 serveurs par installerUserId
 *
 * Les serveurs au-delà du quota passent en `licenseFrozen = true` et leurs
 * modules avancés sont désactivés, mais ils restent en BDD (pour permettre
 * l'upgrade Premium ou la libération d'un slot ailleurs).
 */

import { prisma } from './prisma.js';

export const FREE_QUOTA = 1;
export const PREMIUM_QUOTA = 3;

export interface InstallerUsage {
  free: number;       // serveurs gratuits actifs
  premium: number;    // serveurs premium actifs
  frozen: number;     // serveurs gelés (au-delà du quota)
  freeRemaining: number;
  premiumRemaining: number;
}

export async function getInstallerUsage(installerUserId: string): Promise<InstallerUsage> {
  const [free, premium, frozen] = await Promise.all([
    prisma.guild.count({ where: { installerUserId, premium: false, licenseFrozen: false } }),
    prisma.guild.count({ where: { installerUserId, premium: true,  licenseFrozen: false } }),
    prisma.guild.count({ where: { installerUserId, licenseFrozen: true } }),
  ]);
  return {
    free,
    premium,
    frozen,
    freeRemaining: Math.max(0, FREE_QUOTA - free),
    premiumRemaining: Math.max(0, PREMIUM_QUOTA - premium),
  };
}

/**
 * Évalue si on peut activer (dégeler) ce serveur pour cet installateur.
 * Renvoie l'info détaillée pour l'API.
 */
export async function canActivateGuild(installerUserId: string, guildId: string) {
  const usage = await getInstallerUsage(installerUserId);
  // On vérifie que ce guildId n'est pas déjà comptabilisé comme actif
  const current = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { premium: true, licenseFrozen: true },
  });
  const alreadyActive = current && !current.licenseFrozen;
  if (alreadyActive) return { ok: true, usage };
  // Sinon on regarde les slots restants
  const isPremiumGuild = current?.premium === true;
  const remaining = isPremiumGuild ? usage.premiumRemaining : usage.freeRemaining;
  return { ok: remaining > 0, usage, isPremiumGuild };
}

/**
 * Annote une liste de guilds avec leur état freemium pour le dashboard.
 */
export async function annotateGuildsWithLicense<T extends { id: string }>(
  guilds: T[],
): Promise<(T & { licenseFrozen: boolean; isInstaller: boolean; isLicenseHolder: boolean })[]> {
  if (guilds.length === 0) return [];
  const ids = guilds.map((g) => g.id);
  const records = await prisma.guild.findMany({
    where: { id: { in: ids } },
    select: { id: true, licenseFrozen: true, installerUserId: true, licenseHolderId: true },
  });
  const map = new Map(records.map((r) => [r.id, r]));
  return guilds.map((g) => {
    const r = map.get(g.id);
    return {
      ...g,
      licenseFrozen: r?.licenseFrozen ?? false,
      isInstaller: false, // sera surchargé en aval avec l'userId courant
      isLicenseHolder: false,
    };
  });
}

/**
 * Marque l'utilisateur connecté comme "license holder" du serveur si pas
 * encore défini, et calcule un signal de risque léger en passant.
 */
export async function claimLicenseHolder(guildId: string, userId: string): Promise<void> {
  await prisma.guild.update({
    where: { id: guildId },
    data: {
      licenseHolderId: userId,
    },
  }).catch(() => { /* guild peut ne pas être en BDD si bot pas encore arrivé */ });
}

/**
 * Compte combien de serveurs distincts cet utilisateur a configuré
 * récemment (= signal anti-collusion : qui édite vraiment).
 */
export async function getUserConfigFootprint(userId: string, lookbackDays = 30) {
  const since = new Date(Date.now() - lookbackDays * 86400_000);
  const sessions = await prisma.dashboardSession.findMany({
    where: { userId, createdAt: { gte: since }, guildId: { not: null } },
    select: { guildId: true, ip: true, createdAt: true },
  });
  const distinctGuilds = new Set(sessions.map((s) => s.guildId).filter(Boolean));
  const distinctIps = new Set(sessions.map((s) => s.ip).filter(Boolean));
  return {
    distinctGuilds: distinctGuilds.size,
    distinctIps: distinctIps.size,
    sessions: sessions.length,
  };
}
