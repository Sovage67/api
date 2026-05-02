/**
 * Helpers pour appeler l'API REST de Discord.
 */
const DISCORD_API = 'https://discord.com/api/v10';

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  email?: string;
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
}

export async function exchangeCode(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}> {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID!,
    client_secret: process.env.DISCORD_CLIENT_SECRET!,
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.DISCORD_REDIRECT_URI!,
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!res.ok) {
    throw new Error(`Échange OAuth échoué : ${res.status}`);
  }
  return res.json();
}

export async function getCurrentUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Impossible de récupérer l\'utilisateur');
  return res.json();
}

export async function getCurrentUserGuilds(accessToken: string): Promise<DiscordGuild[]> {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Impossible de récupérer les serveurs');
  return res.json();
}

/**
 * Vérifier si l'utilisateur a la permission ADMINISTRATOR (0x8) sur la guilde.
 */
export function hasAdminPermission(permissions: string): boolean {
  return (BigInt(permissions) & 0x8n) === 0x8n;
}

// ── Helpers bot token (pour récupérer salons/rôles) ──────────────────────────

export interface DiscordChannel {
  id: string;
  name: string;
  type: number; // 0=text, 2=voice, 4=category, 5=news, 13=stage, 15=forum
  position: number;
  parent_id: string | null;
}

export interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
  managed: boolean;
}

export interface DiscordGuildDetail {
  id: string;
  name: string;
  icon: string | null;
  approximate_member_count?: number;
  approximate_presence_count?: number;
  premium_subscription_count?: number;
  premium_tier: number;
  member_count?: number;
}

function botHeaders() {
  // Le token Discord du bot est partagé entre le bot et l'API.
  // On accepte DISCORD_TOKEN (préféré) ou BOT_TOKEN (alias historique).
  const token = process.env.DISCORD_TOKEN ?? process.env.BOT_TOKEN;
  return { Authorization: `Bot ${token}` };
}

export async function getBotGuildChannels(guildId: string): Promise<DiscordChannel[]> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, { headers: botHeaders() });
  if (!res.ok) throw new Error(`Discord channels error: ${res.status}`);
  return res.json();
}

export async function getBotGuildRoles(guildId: string): Promise<DiscordRole[]> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, { headers: botHeaders() });
  if (!res.ok) throw new Error(`Discord roles error: ${res.status}`);
  return res.json();
}

export async function getBotGuildDetail(guildId: string): Promise<DiscordGuildDetail> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}?with_counts=true`, { headers: botHeaders() });
  if (!res.ok) throw new Error(`Discord guild error: ${res.status}`);
  return res.json();
}
