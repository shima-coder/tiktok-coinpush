import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server as IOServer } from 'socket.io';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { applyRoutes } from './routes.js';
import { startLeaderboardLoop } from './leaderboard.js';

async function main() {
  const app = Fastify({ logger: true });

  // CORS
  await app.register(cors, { origin: true });

  const PORT = Number(process.env.PORT || 8080);

  // ENV未設定でも落ちないよう任意扱いに
  const redisUrl = process.env.REDIS_URL;
  const dbUrl = process.env.DATABASE_URL;
  const redis = redisUrl ? new Redis(redisUrl) : null;
  const db = dbUrl ? new Pool({ connectionString: dbUrl }) : null;

  // Socket.IO を Fastify のサーバに接続
  const io = new IOServer(app.server, { cors: { origin: true } });

  io.of('/overlay').on('connection', (socket) => {
    socket.emit('hello', { ts: Date.now() });
  });

  // ルート登録
  applyRoutes(app, { redis, db, io });

  // ランキング更新ループ（Redisがある時だけ）
  if (redis) {
    startLeaderboardLoop(redis as any, io).catch((err) => app.log.error(err));
  } else {
    app.log.warn('REDIS_URL 未設定のため leaderboard ループは無効です');
  }

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`listening on ${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
