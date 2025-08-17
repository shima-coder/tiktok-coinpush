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

/** ===== 互換のポイント系（必要なら活用） ===== */
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

/** ===== 全体カウント・ボーナス（原子化 Lua） ===== */
const GLOBAL_COUNT_KEY = 'glob:act_count';
const DEFAULT_THRESHOLD = Number(process.env.GLOBAL_BONUS_THRESHOLD ?? 10); // 10回ごと
const DEFAULT_BONUS_SCORE = Number(process.env.GLOBAL_BONUS_SCORE ?? 100);  // +100

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

/** ===== リモート設定（Redis） ===== */
type LiveConfig = {
  threshold: number;    // ボーナスしきい値
  bonusScore: number;   // ボーナス加点
  paceMs: number;       // 連続回転の間隔（ms）…フロント側へ通知
  fxLevel: number;      // 演出強度（0.3〜1.5）…フロント側へ通知
};
const CONFIG_KEY = 'overlay:config';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const defaultConfig: LiveConfig = {
  threshold: DEFAULT_THRESHOLD,
  bonusScore: DEFAULT_BONUS_SCORE,
  paceMs: 180,
  fxLevel: 1.0,
};

async function getConfig(redis: Redis | null): Promise<LiveConfig> {
  if (!redis) return { ...defaultConfig };
  const raw = await redis.get(CONFIG_KEY);
  if (!raw) return { ...defaultConfig };
  try {
    const parsed = JSON.parse(raw);
    return {
      threshold: Number(parsed.threshold ?? defaultConfig.threshold),
      bonusScore: Number(parsed.bonusScore ?? defaultConfig.bonusScore),
      paceMs: Number(parsed.paceMs ?? defaultConfig.paceMs),
      fxLevel: Number(parsed.fxLevel ?? defaultConfig.fxLevel),
    };
  } catch {
    return { ...defaultConfig };
  }
}
async function setConfig(redis: Redis, patch: Partial<LiveConfig>): Promise<LiveConfig> {
  const cur = await getConfig(redis);
  const next: LiveConfig = {
    threshold: Math.max(1, Math.floor(Number(patch.threshold ?? cur.threshold))),
    bonusScore: Math.max(0, Math.floor(Number(patch.bonusScore ?? cur.bonusScore))),
    paceMs: Math.max(80, Math.min(800, Math.floor(Number(patch.paceMs ?? cur.paceMs)))),
    fxLevel: Math.max(0.3, Math.min(1.5, Number(patch.fxLevel ?? cur.fxLevel))),
  };
  await redis.set(CONFIG_KEY, JSON.stringify(next));
  return next;
}
function requireAdmin(req: any) {
  const t = req.headers['x-admin-token'] || req.query?.token;
  return ADMIN_TOKEN && String(t) === ADMIN_TOKEN;
}

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

  // 進捗の取得（リロード直後など）
  app.get('/bonus/state', async () => {
    if (!redis) return { threshold: defaultConfig.threshold, remain: 0, after: 0 };
    const conf = await getConfig(redis);
    const after = Number(await (redis as any).get(GLOBAL_COUNT_KEY) || 0);
    let remain = conf.threshold - (after % conf.threshold);
    if (remain === conf.threshold) remain = 0;
    return { threshold: conf.threshold, remain, after };
  });

  // ===== 静的ファイル（assets）配信 =====
  app.get('/assets/*', async (req, reply) => {
    try {
      const wildcard = (req.params as any)['*'] as string;
      const abs = path.resolve(process.cwd(), 'dist/assets', wildcard || '');
      const data = await readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      const mime: Record<string,string> = {
        '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
        '.webp':'image/webp', '.svg':'image/svg+xml', '.json':'application/json'
      };
      reply.type(mime[ext] ?? 'application/octet-stream').send(data);
    } catch {
      reply.code(404).send({ ok:false, error:'asset_not_found' });
    }
  });

  // ===== ギフト由来の演出 =====
  app.post('/ingest/gift', async (req, reply) => {
    try {
      const body: any = (req as any).body || {};
      const userId = String(body.userId || 'anon');
      const amountYen = Number(body.amountYen || 100);

      const coins = Math.floor(amountYen * (Number(process.env.COINS_PER_100YEN || 100) / 100));
      const medals = Math.floor(coins * (Number(process.env.MEDALS_PER_100_COINS || 5) / 100));

      const seed = randomUUID();
      const jpPool = redis ? Number((await (redis as any).get('jp_pool')) || 0) : 0;
      const phys = simulate(seed, medals, jpPool);
      const spinRes = spin();
      const finalScore = Math.max(0, Math.floor(phys.score * (spinRes.multiplier || 1)));

      if (redis) {
        await (redis as any).incrby('jp_pool', Math.floor(amountYen * Number(process.env.JP_POOL_PCT || 0.02)));
        await addScore(redis as any, userId, finalScore);
      } else {
        app.log.warn('REDIS_URL 未設定のためスコアは保存されません');
      }

      const payload = {
        userId,
        dropped: phys.dropped, fallen: phys.fallen, bonus: phys.bonus,
        jpDelta: phys.jpDelta, score: finalScore, spin: spinRes,
        source: 'gift' as const,
      };

      io.of('/overlay').emit('play:event', payload);
      return reply.send({ ok: true, coins, medals, result: payload });
    } catch (e: any) {
      app.log.error(e);
      return reply.code(500).send({ ok: false, error: String(e?.message || e) });
    }
  });

  // ===== ライブ行動で回す + 全体カウント（Lua原子） =====
  app.post('/ingest/action', async (req, reply) => {
    try {
      const body: any = (req as any).body || {};
      const action = String(body.action || 'comment'); // 'comment' | 'like' | 'follow' | 'gift'
      const userId = String(body.userId || 'anon');
      const amountYen = Number(body.amountYen || 0);

      // メダル換算
      let medals = 1;
      if (action === 'gift')      medals = Math.max(1, Math.floor(amountYen * ACTION_MEDALS.giftPerYen));
      else if (action === 'like') medals = ACTION_MEDALS.like;
      else if (action === 'follow') medals = ACTION_MEDALS.follow;
      else                        medals = ACTION_MEDALS.comment;

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

      const eventPayload = {
        userId, action,
        dropped: phys.dropped, fallen: phys.fallen, bonus: phys.bonus,
        jpDelta: phys.jpDelta, score: finalScore, spin: spinRes,
        source: 'action' as const,
      };
      io.of('/overlay').emit('play:event', eventPayload);

      // 原子 INCR + 進捗/発火
      let after = 0, remain = 0, triggered = 0;
      if (redis) {
        const conf = await getConfig(redis);
        const res: any = await (redis as any).eval(LUA_BONUS_INCR, 1, GLOBAL_COUNT_KEY, String(conf.threshold));
        after = Number(res?.[0] ?? 0);
        remain = Number(res?.[1] ?? 0);
        triggered = Number(res?.[2] ?? 0);

        // 進捗イベント
        io.of('/overlay').emit('bonus:progress', { threshold: conf.threshold, after, remain });

        if (triggered === 1) {
          await addScore(redis as any, userId, conf.bonusScore);
          io.of('/overlay').emit('play:bonus', {
            kind: 'global', userId, action,
            threshold: conf.threshold, bonusScore: conf.bonusScore, remain: 0
          });
        }
      } else {
        app.log.warn('REDIS_URL 未設定のため、全体カウントは無効です');
      }

      return reply.send({ ok: true, result: eventPayload, after, remain, bonusTriggered: triggered === 1 });
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
        dropped: phys.dropped, fallen: phys.fallen, bonus: phys.bonus,
        jpDelta: phys.jpDelta, score: finalScore, spin: spinRes,
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

  // ===== Admin: 設定の取得・更新・ボーナス強制 =====
  app.get('/admin/config', async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(403).send({ ok:false, error:'forbidden' });
    const conf = await getConfig(redis!);
    return reply.send({ ok:true, config: conf });
  });

  app.post('/admin/config', async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(403).send({ ok:false, error:'forbidden' });
    try {
      const body: Partial<LiveConfig> = (req as any).body || {};
      const next = await setConfig(redis!, body);
      // クライアントへ即時通知
      ctx.io.of('/overlay').emit('config:update', next);

      // 進捗も再計算して通知（メーターずれ防止）
      const after = Number(await (redis as any).get(GLOBAL_COUNT_KEY) || 0);
      let remain = next.threshold - (after % next.threshold);
      if (remain === next.threshold) remain = 0;
      ctx.io.of('/overlay').emit('bonus:progress', { threshold: next.threshold, after, remain });

      return reply.send({ ok:true, config: next });
    } catch (e:any) {
      app.log.error(e);
      return reply.code(500).send({ ok:false, error: String(e?.message || e) });
    }
  });

  app.post('/admin/bonus/trigger', async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(403).send({ ok:false, error:'forbidden' });
    try {
      const conf = await getConfig(redis!);
      const body:any = (req as any).body || {};
      const actor = String(body.userId || 'admin');
      if (redis) await addScore(redis as any, actor, conf.bonusScore);
      ctx.io.of('/overlay').emit('play:bonus', {
        kind:'admin', userId: actor, action:'admin',
        threshold: conf.threshold, bonusScore: conf.bonusScore, remain: 0
      });
      return reply.send({ ok:true });
    } catch (e:any) {
      app.log.error(e);
      return reply.code(500).send({ ok:false, error: String(e?.message || e) });
    }
  });

  // ===== overlay.html 静的配信 =====
  app.get('/overlay.html', async (_req, reply) => {
    try {
      const p = path.resolve(process.cwd(), 'dist/overlay.html');
      const html = await readFile(p, 'utf-8');
      reply.type('text/html').send(html);
    } catch (e) {
      ctx.io.sockets.emit('log', { level:'error', msg:'overlay.html not found' });
      reply.code(404).send({ error: 'overlay.html not found' });
    }
  });
}
