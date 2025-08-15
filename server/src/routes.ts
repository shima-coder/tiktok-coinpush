import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { addScore, getTopN } from './leaderboard.js';
import { simulate } from './physics.js';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';

// スロット実装（server/src/slot.ts を別途追加している前提）
// もし未作成なら、前回メッセージの slot.ts を作成してください。
import { spin } from './slot.js';

type Ctx = { redis: Redis | null; db: Pool | null; io: Server };

export function applyRoutes(app: FastifyInstance, ctx: Ctx) {
  const { redis, io } = ctx;

  // ヘルスチェック
  app.get('/health', async () => ({ ok: true }));

  // ランキング（Top10）
  app.get('/overlay/state', async () => {
    if (!redis) return { top10: [] };
    const top10 = await getTopN(redis as any, 10);
    return { top10 };
  });

  // ギフト受信（スタブ）→ スロット実行 → 物理スコアに倍率を適用 → 送信
  app.post('/ingest/gift', async (req, reply) => {
    try {
      const body: any = (req as any).body || {};
      const userId = String(body.userId || 'anon');
      const amountYen = Number(body.amountYen || 100);

      // 金額→コイン→メダル（ベース）
      const coins = Math.floor(
        amountYen * (Number(process.env.COINS_PER_100YEN || 100) / 100)
      );
      const medals = Math.floor(
        coins * (Number(process.env.MEDALS_PER_100_COINS || 5) / 100)
      );

      // 物理スコア算出（既存ロジック）
      const seed = randomUUID();
      const jpPool = redis ? Number((await (redis as any).get('jp_pool')) || 0) : 0;
      const phys = simulate(seed, medals, jpPool); // { dropped, fallen, bonus, jpDelta, score }

      // スロットを回す（新ロジック）
      const spinRes = spin(); // { tier, multiplier, symbols, bonusGame, comboExtend }

      // 倍率を適用した最終スコア
      const finalScore = Math.max(0, Math.floor(phys.score * (spinRes.multiplier || 1)));

      // JPプール加算 & ランキング保存
      if (redis) {
        await (redis as any).incrby(
          'jp_pool',
          Math.floor(amountYen * Number(process.env.JP_POOL_PCT || 0.02))
        );
        await addScore(redis as any, userId, finalScore);
      } else {
        app.log.warn('REDIS_URL 未設定のためスコアは保存されません');
      }

      // 互換: 旧フィールド + 新フィールド(spin) を payload に含める
      const payload = {
        userId,
        dropped: phys.dropped,
        fallen: phys.fallen,
        bonus: phys.bonus,
        jpDelta: phys.jpDelta,
        score: finalScore,
        spin: spinRes,
      };

      // オーバーレイへ通知
      io.of('/overlay').emit('play:event', payload);

      return reply.send({ ok: true, coins, medals, result: payload });
    } catch (e: any) {
      app.log.error(e);
      return reply.code(500).send({ ok: false, error: String(e?.message || e) });
    }
  });

  // overlay.html を返すルート（ビルド後の dist を返却）
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
