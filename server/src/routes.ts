import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { addScore, getTopN } from './leaderboard.js';
import { simulate } from './physics.js';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';

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
    const body: any = (req as any).body || {};
    const userId = String(body.userId || 'anon');
    const amountYen = Number(body.amountYen || 100);

    const coins = Math.floor(
      amountYen * (Number(process.env.COINS_PER_100YEN || 100) / 100)
    );
    const medals = Math.floor(
      coins * (Number(process.env.MEDALS_PER_100_COINS || 5) / 100)
    );

    const seed = randomUUID();
    const jpPool = redis ? Number((await (redis as any).get('jp_pool')) || 0) : 0;
    const r = simulate(seed, medals, jpPool);

    if (redis) {
      await (redis as any).incrby(
        'jp_pool',
        Math.floor(amountYen * Number(process.env.JP_POOL_PCT || 0.02))
      );
      await addScore(redis as any, userId, r.score);
    } else {
      app.log.warn('REDIS_URL 未設定のためスコアは保存されません');
    }

    io.of('/overlay').emit('play:event', { userId, ...r });

    return { ok: true, coins, medals, result: r };
  });

  // ← ここから追加：overlay.html を返すルート
  app.get('/overlay.html', async (_req, reply) => {
    try {
      const p = path.resolve(process.cwd(), 'dist/overlay.html');
      const html = await readFile(p, 'utf-8');
      reply.type('text/html').send(html);
    } catch (e) {
      app.log.error(e);
      reply.code(404).send({ error: 'overlay.html not found' });
    }
  });
}
