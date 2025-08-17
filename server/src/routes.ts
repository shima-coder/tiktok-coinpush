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

// 依存注入用コンテキスト
type Ctx = { redis: Redis | null; db: Pool | null; io: Server };

/** ===== 互換のポイント系（使ってなくても残す） ===== */
const POINTS_INITIAL = Number(process.env.POINTS_INITIAL ?? 2000);
const POINTS_COST_PER_SPIN = Number(process.env.POINTS_COST_PER_SPIN ?? 100);
const POINTS_PER_YEN = Number(process.env.POINTS_PER_YEN ?? 1);
const POINT_SPIN_JP_ADD = Number(process.env.POINT_SPIN_JP_ADD ?? 10);
const ptsKey = (userId: string) => `pts:${userId}`;
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
async function getOrInitPoints(redis: Redis, userId: string): Promise<number> {
  const key = ptsKey(userId);
  const v = await redis.get(key);
  if (v === null) { await redis.set(key, String(POINTS_INITIAL)); return POINTS_INITIAL; }
  return Number(v) || 0;
}
async function addPoints(redis: Redis, userId: string, amount: number): Promise<number> {
  const key = ptsKey(userId);
  const exists = await redis.exists(key);
  if (!exists) await redis.set(key, String(POINTS_INITIAL));
  const after = await redis.incrby(key, Math.floor(amount));
  return after;
}

/** ===== 新：全体カウント・ボーナス（原子化） ===== */
const GLOBAL_BONUS_THRESHOLD = Number(process.env.GLOBAL_BONUS_THRESHOLD ?? 10); // 10回ごと
const GLOBAL_BONUS_SCORE     = Number(process.env.GLOBAL_BONUS_SCORE ?? 100);    // +100
const GLOBAL_COUNT_KEY       = 'glob:act_count';

// INCR → しきい値判定 → 残カウント計算 を原子化
// 戻り: { after, remain, triggered }
const LUA_BONUS_INCR = `
local key = KEYS[1]
local thr = tonumber(ARGV[1])
local after = redis.call('INCR', key)
local rem = thr - (after % thr)
if rem == thr then rem = 0 end
local trig = 0
if (after % thr) == 0 then trig = 1 end
return {after, rem, trig}
`;

// 行動→メダル換算（演出のベース強度）
const ACTION_MEDALS = {
  comment: Number(process.env.ACTION_COMMENT_MEDALS ?? 1),
  like:    Number(process.env.ACTION_LIKE_MEDALS    ?? 2),
  follow:  Number(process.env.ACTION_FOLLOW_MEDALS  ?? 5),
  giftPerYen: Number(process.env.ACTION_GIFT_MEDALS_PER_YEN ?? 0.05)
};
// ギフト以外でもJPを少し進めると楽しい
const JP_ADD_PER_ACTION = Number(process.env.JP_ADD_PER_ACTION ?? 2);

export function applyRoutes(app: FastifyInstance, ctx: Ctx) {
  const { redis, io } = ctx;

  // ===== ヘルス =====
  app.get('/health', async () => ({ ok: true }));

  // ===== ランキング状態 =====
  app.get('/overlay/state', async () => {
    if (!redis) return { top10: [] };
    const top10 = await getTopN(redis as any, 10);
    return { top10 };
  });

  // ★ 追加：ボーナス進捗の取得（リロード直後の初期化用）
  app.get('/bonus/state', async () => {
    if (!redis) return { threshold: GLOBAL_BONUS_THRESHOLD, remain: 0, after: 0 };
    const after = Number(await (redis as any).get(GLOBAL_COUNT_KEY) || 0);
    let remain = GLOBAL_BONUS_THRESHOLD - (after % GLOBAL_BONUS_THRESHOLD);
    if (remain === GLOBAL_BONUS_THRESHOLD) remain = 0;
    return { threshold: GLOBAL_BONUS_THRESHOLD, remain, after };
  });

  // ===== 既存：ギフト由来の演出（そのまま） =====
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
      const phys = simulate(seed, medals, jpPool);

      const spinRes = spin();
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

  // ===== 新：ライブ行動で回す + 全体カウント（原子化） =====
  app.post('/ingest/action', async (req, reply) => {
    try {
      const body: any = (req as any).body || {};
      const action = String(body.action || 'comment'); // 'comment' | 'like' | 'follow' | 'gift'
      const userId = String(body.userId || 'anon');
      const amountYen = Number(body.amountYen || 0);

      // メダル換算
      let medals = 1;
      if (action === 'gift') {
        medals = Math.max(1, Math.floor(amountYen * ACTION_MEDALS.giftPerYen));
      } else if (action === 'like') {
        medals = ACTION_MEDALS.like;
      } else if (action === 'follow') {
        medals = ACTION_MEDALS.follow;
      } else {
        medals = ACTION_MEDALS.comment;
      }

      // 通常スロット
      const seed = randomUUID();
      const jpPool = redis ? Number((await (redis as any).get('jp_pool')) || 0) : 0;
      const phys = simulate(seed, medals, jpPool);
      const spinRes = spin();
      const finalScore = Math.max(0, Math.floor(phys.score * (spinRes.multiplier || 1)));

      if (redis) {
        if (action === 'gift') {
          await (redis as any).incrby('jp_pool', Math.floor(amountYen * Number(process.env.JP_POOL_PCT || 0.02)));
        } else if (JP_ADD_PER_ACTION > 0) {
          await (redis as any).incrby('jp_pool', JP_ADD_PER_ACTION);
        }
        await addScore(redis as any, userId, finalScore);
      }

      const payload = {
        userId, action,
        dropped: phys.dropped,
        fallen: phys.fallen,
        bonus: phys.bonus,
        jpDelta: phys.jpDelta,
        score: finalScore,
        spin: spinRes,
        source: 'action' as const,
      };
      io.of('/overlay').emit('play:event', payload);

      // 全体カウント原子化 INCR（remain/triggered を返す）
      let after = 0, remain = 0, triggered = 0;
      if (redis) {
        const res: any = await (redis as any).eval(LUA_BONUS_INCR, 1, GLOBAL_COUNT_KEY, String(GLOBAL_BONUS_THRESHOLD));
        after = Number(res?.[0] ?? 0);
        remain = Number(res?.[1] ?? 0);
        triggered = Number(res?.[2] ?? 0);

        // 進捗イベント（全クライアントへ）
        io.of('/overlay').emit('bonus:progress', {
          threshold: GLOBAL_BONUS_THRESHOLD,
          after, remain
        });

        if (triggered === 1) {
          // 達成者に +100
          await addScore(redis as any, userId, GLOBAL_BONUS_SCORE);
          // ボーナス演出
          io.of('/overlay').emit('play:bonus', {
            kind: 'global',
            userId,
            action,
            threshold: GLOBAL_BONUS_THRESHOLD,
            bonusScore: GLOBAL_BONUS_SCORE,
            remain: 0
          });
        }
      } else {
        app.log.warn('REDIS_URL 未設定のため、全体カウントは無効です');
      }

      return reply.send({ ok: true, result: payload, after, remain, bonusTriggered: triggered === 1 });
    } catch (e: any) {
      app.log.error(e);
      return reply.code(500).send({ ok: false, error: String(e?.message || e) });
    }
  });

  /** ===== 互換：ポイント系 ===== */
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

  app.post('/ingest/spin-points', async (req, reply) => {
    try {
      if (!redis) return reply.code(500).send({ ok: false, error: 'points_unavailable' });
      const body: any = (req as any).body || {};
      const userId = String(body.userId || 'anon');
      const key = ptsKey(userId);
      const res: any = await (redis as any).eval(LUA_CONSUME_POINTS, 1, key, String(POINTS_COST_PER_SPIN), String(POINTS_INITIAL));
      const okFlag = Number(res?.[0] ?? 0);
      const after = Number(res?.[1] ?? 0);
      if (!okFlag) return reply.code(400).send({ ok: false, error: 'insufficient_points', userId, points: after });

      const medals = 5;
      const seed = randomUUID();
      const jpPool = Number((await (redis as any).get('jp_pool')) || 0);
      const phys = simulate(seed, medals, jpPool);
      const spinRes = spin();
      const finalScore = Math.max(0, Math.floor(phys.score * (spinRes.multiplier || 1)));

      if (POINT_SPIN_JP_ADD > 0) await (redis as any).incrby('jp_pool', POINT_SPIN_JP_ADD);
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
      return reply.send({ ok: true, userId, pointsAfter: after, cost: POINTS_COST_PER_SPIN, result: payload });
    } catch (e: any) {
      app.log.error(e);
      return reply.code(500).send({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/points/purchase', async (req, reply) => {
    try {
      if (!redis) return reply.code(500).send({ ok: false, error: 'points_unavailable' });
      const body: any = (req as any).body || {};
      const userId = String(body.userId || 'anon');
      const amountYen = Number(body.amountYen);
      if (!Number.isFinite(amountYen) || amountYen <= 0) return reply.code(400).send({ ok: false, error: 'invalid_amount' });
      const add = Math.floor(amountYen * POINTS_PER_YEN);
      const after = await addPoints(redis, userId, add);
      return reply.send({ ok: true, userId, added: add, points: after });
    } catch (e: any) {
      app.log.error(e);
      return reply.code(500).send({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/points/reset', async (req, reply) => {
    try {
      if (!redis) return reply.code(500).send({ ok: false, error: 'points_unavailable' });
      if (process.env.ALLOW_POINTS_RESET !== 'true') return reply.code(403).send({ ok: false, error: 'reset_disabled' });
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

  // ===== overlay.html 静的配信 =====
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
