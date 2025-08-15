import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server as IOServer } from 'socket.io';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { applyRoutes } from './routes.js';
import { startLeaderboardLoop } from './leaderboard.js';

async function main() {
  const app = Fastify({ logger: true });

  // CORS（Fastify v4）
  await app.register(cors, { origin: true });

  const PORT = Number(process.env.PORT || 8080);

  // ENVが未設定でも落ちないように「任意」にする
  const redisUrl = process.env.REDIS_URL;
  const dbUrl = process.env.DATABASE_URL;
  const redis = redisUrl ? new Redis(redisUrl) : null;
  const db = dbUrl ? new Pool({ connectionString: dbUrl }) : null;

  // Socket.IO は Fastify の server にぶら下げる
  const io = new IOServer(app.server, { cors: { origin: true } });

  io.of('/overlay').on('connection', (socket) => {
    socket.emit('hello', { ts: Date.now() });
  });

  // REST/WS ルート
  applyRoutes(app, { redis, db, io });

  // リーダーボード更新（Redisがなければスキップ）
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
