/**
 * 电脑牌友的简单策略。
 *
 * 目标：会记牌、做一点简单推理，但仍然只是轻松陪练。
 *
 * 信息边界：
 *   - 只看自己的手牌；
 *   - 只看已经公开的牌：开局明牌、每轮结束后亮出的出牌；
 *   - 不读取其他座位当前扣着的暗牌，也不读取本轮还没揭晓的牌。
 *
 * 记牌方式：从整副牌里扣掉“自己手里的 + 已经公开的”，得到还没见过的牌，
 * 再按牌型估算“目标比自己小”的概率，用这个概率决定猜大还是猜小。
 */

import { findPlayableCombo, makeDeck, parseCard } from './game.js';

function deckRankTotals(deckCount) {
  const totals = new Map();
  for (const id of makeDeck(deckCount)) {
    const card = parseCard(id);
    totals.set(card.rankValue, (totals.get(card.rankValue) || 0) + 1);
  }
  return totals;
}

function seenCardIds(room, seat) {
  const seen = new Set(room.hands?.[seat] || []);
  for (const id of room.publicCards || []) seen.add(id);
  for (const id of room.revealed || []) seen.add(id);
  return seen;
}

/**
 * 还没被 AI 见过的牌，按点数统计。
 * 这张表会随着每一轮公开的出牌变少，就是 AI 的“记牌”。
 */
export function remainingRankCounts(room, seat) {
  const deckCount = room.deckInfo?.deckCount || 1;
  const totals = deckRankTotals(deckCount);
  for (const id of seenCardIds(room, seat)) {
    const card = parseCard(id);
    if (!card) continue;
    const left = totals.get(card.rankValue) || 0;
    totals.set(card.rankValue, Math.max(0, left - 1));
  }
  return totals;
}

function groupFits(combo, count) {
  if (combo.type === 'single' || combo.type === 'straight') return count >= 1;
  if (combo.type === 'pair' || combo.type === 'pairseq') return count >= 2;
  if (combo.type === 'triple' || combo.type === 'fullhouse' || combo.type === 'steel') {
    return count >= 3;
  }
  if (combo.type === 'multi') return count >= combo.size;
  return count >= 1;
}

/**
 * 估算“猜大”正确的概率：目标牌型比 AI 这手牌小的可能性。
 * 只看还没见过的牌，按同牌型可组成的点数分布粗略加权。
 * 不是精确概率，够 AI 做简单推理即可。
 */
export function estimateHigherChance(room, seat, combo) {
  if (!combo) return 0.5;
  const counts = remainingRankCounts(room, seat);
  let lower = 0;
  let higher = 0;
  let equal = 0;
  for (const [rankValue, count] of counts) {
    if (count <= 0 || !groupFits(combo, count)) continue;
    if (rankValue < combo.key) lower += count;
    else if (rankValue > combo.key) higher += count;
    else equal += count;
  }
  const total = lower + higher + equal;
  if (!total) return 0.5;
  return lower / total;
}

/**
 * 根据记牌结果选择猜大还是猜小。
 * 保留 20% 的随机偏差，避免电脑变成“算牌机器”，也避免被玩家摸透。
 */
export function chooseClaimDirection(room, seat, combo, rng = Math.random) {
  const chance = estimateHigherChance(room, seat, combo);
  const confidence = 0.5 + (chance - 0.5) * 0.8;
  return rng() < confidence ? 'higher' : 'lower';
}

export function chooseAIAction(room, seat, rng = Math.random) {
  if (!room || room.phase !== 'playing' || room.turn !== seat) return null;
  const player = room.seats[seat];
  if (!player?.isAI) return null;

  const hand = room.hands[seat] || [];
  if (!hand.length) return null;

  const isLeader = room.leader === seat;
  const target = isLeader ? null : room.actions[room.leader]?.combo || null;
  if (!isLeader && !target) return null;

  const playable = findPlayableCombo(hand, target);
  if (!playable) {
    return isLeader ? null : { kind: 'pass' };
  }

  if (isLeader) {
    return { kind: 'play', cards: playable.cards, claims: [] };
  }

  const index = room.turnOrder.indexOf(seat);
  const prior = room.turnOrder
    .slice(0, index)
    .filter((targetSeat) => room.actions[targetSeat]?.played);
  const claims = prior.map((targetSeat) => ({
    target: targetSeat,
    dir: chooseClaimDirection(room, seat, playable.combo, rng)
  }));

  return { kind: 'play', cards: playable.cards, claims };
}

/**
 * 给房主界面用：AI 还剩多少张牌、是否轮到它。
 */
export function aiThinkingText(room, seat) {
  const player = room?.seats?.[seat];
  if (!player?.isAI) return '';
  const count = room.hands?.[seat]?.length || 0;
  if (room.turn === seat && room.phase === 'playing') return '正在想…';
  return `${count} 张牌`;
}
