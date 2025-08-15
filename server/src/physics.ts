import seedrandom from 'seedrandom';

export type PhysicsResult = { dropped: number; fallen: number; bonus: number; jpDelta: number; score: number };

export function simulate(seed: string, medals: number, jpPool: number) : PhysicsResult {
  const rng = seedrandom(seed);
  const fallRate = 0.35 + rng() * 0.25; // 35-60%が落ちる
  const fallen = Math.floor(medals * fallRate);
  const bonus = rng() < 0.08 ? 1 : 0; // 8%でボーナス
  const jpHit = rng() < 0.01; // 1%でJP演出（スコアのみ）
  const jpDelta = jpHit ? Math.floor(jpPool * (0.05 + rng()*0.05)) : 0; // 5-10%演出
  const scorePerDrop = Number(process.env.SCORE_PER_DROP || 10);
  const bonusScore = Number(process.env.BONUS_HOLE_SCORE || 100);
  const score = fallen*scorePerDrop + bonus*bonusScore + jpDelta;
  return { dropped: medals, fallen, bonus, jpDelta, score };
}
