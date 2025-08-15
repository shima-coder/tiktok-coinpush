import type { Server } from 'socket.io';
import Redis from 'ioredis';

const DAILY_KEY = () => `lb:${new Date().toISOString().slice(0,10)}`;

export async function addScore(redis: Redis, userId: string, delta: number) {
  await redis.zincrby(DAILY_KEY(), delta, userId);
}

export async function getTopN(redis: Redis, n=10) {
  const key = DAILY_KEY();
  const list = await redis.zrevrange(key, 0, n-1, 'WITHSCORES');
  const out: any[] = [];
  for (let i=0;i<list.length;i+=2) out.push({ userId: list[i], score: Number(list[i+1]) });
  return out;
}

export async function startLeaderboardLoop(redis: Redis, io: Server) {
  setInterval(async () => {
    const top10 = await getTopN(redis, 10);
    io.of('/overlay').emit('leaderboard:update', top10);
  }, 1000);
}
