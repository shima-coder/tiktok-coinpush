import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { addScore, getTopN } from './leaderboard.js';
import { simulate } from './physics.js';
import { randomUUID } from 'crypto';

export function applyRoutes(app: FastifyInstance, ctx: { redis: Redis, db: Pool, io: Server }) {
  const { redis, io } = ctx;

  app.get('/health', async () => ({ ok: true }));

  // Overlay state（簡易）
  app.get('/overlay/state', async () => {
    const top10 = await getTopN(redis, 10);
    return { top10 };
  });

  // ギフト受信スタブ（本番はTikTok連携から呼ぶ）
  app.post('/ingest/gift', async (req, reply) => {
    const body: any = req.body || {};
    const userId = String(body.userId || 'anon');
    const amountYen = Number(body.amountYen || 100);

    const coins = Math.floor(amountYen * (Number(process.env.COINS_PER_100YEN || 100) / 100));
    const medals = Math.floor(coins * (Number(process.env.MEDALS_PER_100_COINS || 5) / 100));

    const seed = randomUUID();
    const jpPool = Number(await redis.get('jp_pool') || 0);
    const r = simulate(seed, medals, jpPool);
    await redis.incrby('jp_pool', Math.floor(amountYen * Number(process.env.JP_POOL_PCT || 0.02)));

    await addScore(redis, userId, r.score);
    io.of('/overlay').emit('play:event', { userId, ...r });

    return { ok: true, coins, medals, result: r };
  });
}
