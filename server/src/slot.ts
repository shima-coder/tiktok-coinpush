// server/src/slot.ts
export type Tier = 'MISS' | 'NORMAL' | 'HIGH' | 'MEGA';
export type SpinResult = {
  tier: Tier;
  multiplier: number;       // スコア倍率
  symbols: string[];        // 3絵柄
  bonusGame: boolean;       // 短尺ボーナス突入フラグ
  comboExtend: boolean;     // コンボ延命（🍀など）
};

// 絵柄（必要に応じて差し替え）
const SYM = {
  LOW: ['🪙','⭐'],
  MID: ['🎁','🔥'],
  HIGH: ['💎'],
  CLOVER: '🍀',
};

function pick<T>(arr: T[]) { return arr[(Math.random()*arr.length)|0]; }

export function spin(): SpinResult {
  // 体感確率（初期値）— 環境変数で調整可
  const pMega  = Number(process.env.SLOT_P_MEGA  ?? 0.02); // 2%
  const pHigh  = Number(process.env.SLOT_P_HIGH  ?? 0.14); // 14%
  const pNorm  = Number(process.env.SLOT_P_NORM  ?? 0.39); // 39%
  const r = Math.random();

  let tier: Tier = 'MISS';
  if (r < pMega) tier = 'MEGA';
  else if (r < pMega + pHigh) tier = 'HIGH';
  else if (r < pMega + pHigh + pNorm) tier = 'NORMAL';
  else tier = 'MISS';

  // 倍率
  const mult = { MISS: 0, NORMAL: 1.2, HIGH: 2.0, MEGA: 5.0 }[tier];

  // 絵柄生成（3×1）
  let symbols: string[] = [];
  let comboExtend = false;
  let bonusGame = false;

  if (tier === 'MISS') {
    symbols = [pick(SYM.LOW), pick(SYM.MID), pick(SYM.LOW)];
    if (Math.random() < 0.08) {
      const i = (Math.random()*3)|0;
      symbols[i] = SYM.CLOVER; comboExtend = true;
    }
  } else if (tier === 'NORMAL') {
    const s = pick([...SYM.LOW, ...SYM.MID]);
    symbols = [s, s, s];
    comboExtend = true;
    bonusGame = Math.random() < 0.05;
  } else if (tier === 'HIGH') {
    const s = pick([...SYM.MID, ...SYM.HIGH]);
    symbols = [s, s, s];
    comboExtend = true;
    bonusGame = Math.random() < 0.10;
  } else { // MEGA
    const s = SYM.HIGH[0];
    symbols = [s, s, s];
    comboExtend = true;
    bonusGame = Math.random() < 0.30;
  }

  return { tier, multiplier: mult, symbols, bonusGame, comboExtend };
}
