import Fastify from 'fastify';
import cors from '@fastify/cors';       // ← 追加
import { Server } from 'socket.io';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { applyRoutes } from './routes.js';
import { startLeaderboardLoop } from './leaderboard.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });  // ← 追加（Fastify v4）

const PORT = Number(process.env.PORT || 8080);
const redis = new Redis(process.env.REDIS_URL!);
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// WebSocket: overlay channel
io.of('/overlay').on('connection', (socket) => {
  socket.emit('hello', { ts: Date.now() });
});

// REST routes
applyRoutes(app, { redis, db, io });

// ranking loop
startLeaderboardLoop(redis, io)
  .catch(err => app.log.error(err));

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on ${PORT}`);
});
