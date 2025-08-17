import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { addScore, getTopN } from './leaderboard.js';
import { simulate } from './physics.js';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import { spin } from './slot.js';

// 依存注入用のコンテキスト
type Ctx = { redis: Redis | null; db: Pool | null; io: Server };

// ===== ポイント制：設定値（環境変数で上書き可） =====
const POINTS_INITIAL = Number(process.env.POINTS_INITIAL ?? 2000);
const POINTS_COST_PER_SPIN = Number(process.env.POINTS_COST_PER_SPIN ?? 100);
const POINTS_PER_YEN = Number(process.env.POINTS_PER_YEN ?? 1);
// ポイントスピン時にJPプールにも加算するなら適当に（0で無効）
const POINT_SPIN_JP_ADD = Number(process.env.POINT_SPIN_JP_ADD ?? 10);

// Redisキー
const ptsKey = (userId: string) => `pts:${userId}`;

// Luaスクリプト：不足チェックしつつ原子的に減算（初期化も内包）
const LUA_CONSUME_POINTS = `
local key = KEYS[1]
local cost = tonumber(ARGV[1])
local init = tonumber(ARGV[2])
if redis.call('EXISTS', key) == 0 then
  redis.call('SET', key, init)
end
local bal = tonumber(redis.call('GET', key))
if bal < cost then
  return {0, bal}
end
local newbal = redis.call('DECRBY', key, cost)
return {1, newbal}
`;

// ユーティリティ
async function getOrInitPoints(redis: Redis, userId: string): Promise<number> {
  const key = ptsKey(userId);
  const v = await redis.get(key);
  if (v === null) {
    await redis.set(key, String(POINTS_INITIAL));
    return POINTS_INITIAL;
    }
  return Number(v) || 0;
}

async function addPoints(redis: Redis, userId: string, amount: number): Promise<number> {
  const key = ptsKey(userId);
  const exists = await redis.exists(key);
  if (!exists) await redis.set(key, String(POINTS_INITIAL));
  const after = await redis.incrby(key, Math.floor(amount));
  return after;
}

export function applyRoutes(app: FastifyInstance, ctx: Ctx) {
  const { redis, io } = ctx;

  // ========== 既存：ヘルス ==========
  app.get('/health', async () => ({ ok: true }));

  // ========== 既存：ランキング状態 ==========
  app.get('/overlay/state', async () => {
    if (!redis) return { top10: [] };
    const top10 = await getTopN(redis as any, 10);
    return { top10 };
  });

  // ========== 既存：ギフト由来の演出（そのまま） ==========
  app.post('/ingest/gift', async (req, reply) => {
    try {
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
      const phys = simulate(seed, medals, jpPool); // { dropped, fallen, bonus, jpDelta, score }

      const spinRes = spin(); // { tier, multiplier, symbols, bonusGame, comboExtend }
      const finalScore = Math.max(0, Math.floor(phys.score * (spinRes.multiplier || 1)));

      if (redis) {
        await (redis as any).incrby(
          'jp_pool',
          Math.floor(amountYen * Number(process.env.JP_POOL_PCT || 0.02))
        );
        await addScore(redis as any, userId, finalScore);
      } else {
        app.log.warn('REDIS_URL 未設定のためスコアは保存されません');
      }

      const payload = {
        userId,
        dropped: phys.dropped,
        fallen: phys.fallen,
        bonus: phys.bonus,
        jpDelta: phys.jpDelta,
        score: finalScore,
        spin: spinRes,
        source: 'gift' as const,
      };

      io.of('/overlay').emit('play:event', payload);
      return reply.send({ ok: true, coins, medals, result: payload });
    } catch (e: any) {
      app.log.error(e);
      return reply.code(500).send({ ok: false, error: String(e?.message || e) });
    }
  });

  // ========== 追加：ポイント残高取得（初回は自動で2000付与） ==========
  app.get('/points/balance', async (req, reply) => {
    try {
      if (!redis) return reply.code(500).send({ ok: false, error: 'points_unavailable' });
      const userId = String((req as any).query?.userId || 'anon');
      const points = await getOrInitPoints(redis, userId);
      return reply.send({ ok: true, userId, points });
    } catch (e: any) {
      app.log.error(e);
      return reply.code(500).send({ ok: false, error: String(e?.message || e) });
    }
  });

  // ========== 追加：ポイントでスピン（100pt消費） ==========
  app.post('/ingest/spin-points', async (req, reply) => {
    try {
      if (!redis) return reply.code(500).send({ ok: false, error: 'points_unavailable' });
      const body: any = (req as any).body || {};
      const userId = String(body.userId || 'anon');
      const key = ptsKey(userId);

      // 原子的に消費（不足なら失敗）
      const res: any = await (redis as any).eval(LUA_CONSUME_POINTS, 1, key, String(POINTS_COST_PER_SPIN), String(POINTS_INITIAL));
      const okFlag = Number(res?.[0] ?? 0);
      const after = Number(res?.[1] ?? 0);
      if (!okFlag) {
        return reply.code(400).send({ ok: false, error: 'insufficient_points', userId, points: after });
      }
      const before = after + POINTS_COST_PER_SPIN;

      // ギフトと同等の演出・スコア算出（medalsは100ptに相当する仮値で十分）
      const medals = 5; // テスト用の固定値（演出の強さはspin()で増幅）
      const seed = randomUUID();
      const jpPool = Number((await (redis as any).get('jp_pool')) || 0);
      const phys = simulate(seed, medals, jpPool);

      const spinRes = spin();
      const finalScore = Math.max(0, Math.floor(phys.score * (spinRes.multiplier || 1)));

      // 任意：ポイントスピンでもJPを少し進める（視覚的に楽しい）
      if (POINT_SPIN_JP_ADD > 0) {
        await (redis as any).incrby('jp_pool', POINT_SPIN_JP_ADD);
      }

      // ランキング加算
      await addScore(redis as any, userId, finalScore);

      const payload = {
        userId,
        dropped: phys.dropped,
        fallen: phys.fallen,
        bonus: phys.bonus,
        jpDelta: phys.jpDelta,
        score: finalScore,
        spin: spinRes,
        source: 'points' as const,
      };

      io.of('/overlay').emit('play:event', payload);
      return reply.send({ ok: true, userId, before, after, cost: POINTS_COST_PER_SPIN, result: payload });
    } catch (e: any) {
      app.log.error(e);
      return reply.code(500).send({ ok: false, error: String(e?.message || e) });
    }
  });

  // ========== 追加：ポイント購入（テスト用） ==========
  app.post('/points/purchase', async (req, reply) => {
    try {
      if (!redis) return reply.code(500).send({ ok: false, error: 'points_unavailable' });
      const body: any = (req as any).body || {};
      const userId = String(body.userId || 'anon');
      const amountYen = Number(body.amountYen);
      if (!Number.isFinite(amountYen) || amountYen <= 0) {
        return reply.code(400).send({ ok: false, error: 'invalid_amount' });
      }
      const add = Math.floor(amountYen * POINTS_PER_YEN);
      const after = await addPoints(redis, userId, add);
      return reply.send({ ok: true, userId, added: add, points: after });
    } catch (e: any) {
      app.log.error(e);
      return reply.code(500).send({ ok: false, error: String(e?.message || e) });
    }
  });

  // ========== 追加：ポイント残高リセット（開発/検証用） ==========
  app.post('/points/reset', async (req, reply) => {
    try {
      if (!redis) return reply.code(500).send({ ok: false, error: 'points_unavailable' });
      if (process.env.ALLOW_POINTS_RESET !== 'true') {
        return reply.code(403).send({ ok: false, error: 'reset_disabled' });
      }
      const body: any = (req as any).body || {};
      const userId = String(body.userId || 'anon');
      const to = Number(body.to ?? POINTS_INITIAL);
      if (!Number.isFinite(to) || to < 0) return reply.code(400).send({ ok: false, error: 'invalid_to' });

      await (redis as any).set(ptsKey(userId), String(Math.floor(to)));
      const points = Number(await (redis as any).get(ptsKey(userId))) || 0;
      return reply.send({ ok: true, userId, points });
    } catch (e: any) {
      app.log.error(e);
      return reply.code(500).send({ ok: false, error: String(e?.message || e) });
    }
  });

  // ========== 既存：overlay.html ==========
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
