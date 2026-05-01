import Redis from 'ioredis';

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

export const redis = new Redis(url);

redis.on('error', (err) => console.error('[Redis] Erreur :', err));

/**
 * Publier un événement sur un canal Redis Pub/Sub.
 * Le bot Discord est abonné et appliquera le changement.
 */
export async function publishEvent(channel: string, payload: unknown): Promise<void> {
  await redis.publish(channel, JSON.stringify(payload));
}
