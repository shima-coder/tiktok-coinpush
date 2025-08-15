import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import { addScore, getTopN } from './leaderboard.js';
import { simulate } from './physics.js';
import { randomUUID } from 'crypto';

type Ctx = { redis: Redis | null; db: Pool | null; io: Server };

export function applyRoutes(app: FastifyInstance, ctx: Ctx) {
  const { redis, io } = ctx;

  app.get('/health', async () => ({ ok: true }));

  app.get('/overlay/state', async () => {
    if (!redis) return { top10: [] };
    const top10 = await getTopN(redis as any, 10);
    return { top10 };
  });

  // ギフト受信スタブ（本番はTikTok連携から呼ぶ）
  app.post('/ingest/gift', async (req, reply) => {
    const body: any = req.body || {};
    const userId = String(body.userId || 'anon');
    const amountYen = Number(body.amountYen || 100);

    const coins = Math.floor(
      amountYen * (Number(process.env.COINS_PER_100YEN || 100) / 100)
    );
    const medals = Math.floor(
      coins * (Number(process.env.MEDALS_PER_100_COINS || 5) / 100)
    );

    const seed = randomUUID();
    const jpPool = redis ? Number((await redis.get('jp_pool')) || 0) : 0;
    const r = simulate(seed, medals, jpPool);

    if (redis) {
      await redis.incrby(
        'jp_pool',
        Math
