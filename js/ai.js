/**
 * 电脑牌友策略：记牌、简单推理、按手数配牌。
 *
 * 信息边界：
 *   - 只看自己的手牌；
 *   - 只看已经公开的牌：开局明牌、每轮结束后亮出的出牌；
 *   - 不读取其他座位当前扣着的暗牌，也不读取本轮还没揭晓的牌。
 *
 * 配牌思路：
 *   - 每出一手，就少一次出牌机会，所以优先让剩下的手牌“手数”更少；
 *   - 同手数时，优先把更多牌打出去；
 *   - 跟牌时枚举所有同牌型的组合，不只会拿最小的一组；
 *   - 猜大小时按没见过的牌估算概率，并结合目标之前成功打出的牌修正判断。
 */

import { analyzeCombo, makeDeck, parseCard, sameComboShape } from './game.js';

/* 新配牌策略会更多打出高牌，原来的“猜大”概率整体偏高；用 500 局结果压回来。 */
const CLAIM_CALIBRATION = [
  [0, 0.02],
  [0.2, 0.05],
  [0.4, 0.16],
  [0.5, 0.26],
  [0.6, 0.33],
  [0.7, 0.43],
  [0.8, 0.6],
  [0.9, 0.82],
  [1, 0.95]
];

function calibrateClaimChance(value) {
  const p = Math.max(0, Math.min(1, value));
  for (let i = 1; i < CLAIM_CALIBRATION.length; i += 1) {
    const [x1, y1] = CLAIM_CALIBRATION[i - 1];
    const [x2, y2] = CLAIM_CALIBRATION[i];
    if (p <= x2) {
      const t = (p - x1) / (x2 - x1 || 1);
      return y1 + (y2 - y1) * t;
    }
  }
  return CLAIM_CALIBRATION[CLAIM_CALIBRATION.length - 1][1];
}

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
 * 还没被 AI 见过的牌，按点数统计。每一轮公开出牌后这张表都会变少。
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

function sequenceRankValues(start, length) {
  const values = [];
  for (let value = start; value < start + length; value += 1) {
    values.push(value === 1 ? 14 : value === 2 ? 15 : value === 14 ? 14 : value);
  }
  return values;
}

function sequenceCards(groups, start, length, need) {
  const cards = [];
  for (const rankValue of sequenceRankValues(start, length)) {
    const group = groups.get(rankValue);
    if (!group || group.length < need) return null;
    cards.push(...group.slice(0, need));
  }
  return cards;
}

/**
 * 粗略估算一手牌最少还要出几次。贪心先拆顺子、三连对、钢板、三带二，
 * 再拆四张以上、三张、对子、单张。不是精确最优解，但足够当配牌评分。
 */
export function estimateHandTurns(cards) {
  const counts = new Map();
  for (const id of cards) {
    const card = parseCard(id);
    if (!card) continue;
    counts.set(card.rankValue, (counts.get(card.rankValue) || 0) + 1);
  }

  const total = () => [...counts.values()].reduce((sum, value) => sum + value, 0);
  const take = (rankValue, amount) => {
    const left = (counts.get(rankValue) || 0) - amount;
    if (left > 0) counts.set(rankValue, left);
    else counts.delete(rankValue);
  };

  const takeSequence = (length, need) => {
    for (let start = 1; start + length - 1 <= 14; start += 1) {
      const values = sequenceRankValues(start, length);
      if (values.every((rankValue) => (counts.get(rankValue) || 0) >= need)) {
        for (const rankValue of values) take(rankValue, need);
        return true;
      }
    }
    return false;
  };

  const takeFullHouse = () => {
    for (const [tripleRank, tripleCount] of counts) {
      if (tripleCount < 3) continue;
      for (const [pairRank, pairCount] of counts) {
        if (pairRank === tripleRank || pairCount < 2) continue;
        take(tripleRank, 3);
        take(pairRank, 2);
        return true;
      }
    }
    return false;
  };

  let turns = 0;
  while (total() > 0) {
    turns += 1;
    if (takeSequence(5, 1)) continue; // 顺子
    if (takeSequence(3, 2)) continue; // 三连对
    if (takeSequence(2, 3)) continue; // 钢板
    if (takeFullHouse()) continue;

    let multiRank = null;
    let multiCount = 0;
    for (const [rankValue, count] of counts) {
      if (count >= 4 && count > multiCount) {
        multiRank = rankValue;
        multiCount = count;
      }
    }
    if (multiRank != null) {
      take(multiRank, multiCount);
      continue;
    }

    let tripleRank = null;
    for (const [rankValue, count] of counts) {
      if (count >= 3) {
        tripleRank = rankValue;
        break;
      }
    }
    if (tripleRank != null) {
      take(tripleRank, 3);
      continue;
    }

    let pairRank = null;
    for (const [rankValue, count] of counts) {
      if (count >= 2) {
        pairRank = rankValue;
        break;
      }
    }
    if (pairRank != null) {
      take(pairRank, 2);
      continue;
    }

    const singleRank = counts.keys().next().value;
    take(singleRank, 1);
  }
  return turns;
}

function groupByRank(hand) {
  const groups = new Map();
  for (const id of hand) {
    const card = parseCard(id);
    if (!card) continue;
    if (!groups.has(card.rankValue)) groups.set(card.rankValue, []);
    groups.get(card.rankValue).push(id);
  }
  return groups;
}

function enumerateCombos(hand, target = null) {
  const groups = groupByRank(hand);
  const candidates = [];
  const seen = new Set();

  const add = (cards) => {
    if (!cards || cards.length === 0) return;
    const analysis = analyzeCombo(cards);
    if (!analysis.valid) return;
    if (target && !sameComboShape(analysis.combo, target)) return;
    const key = [...cards].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ cards, combo: analysis.combo });
  };

  const want = (type, size) => !target || (target.type === type && target.size === size);

  if (want('single', 1)) {
    for (const [, ids] of groups) add([ids[0]]);
  }

  if (want('pair', 2)) {
    for (const [, ids] of groups) if (ids.length >= 2) add(ids.slice(0, 2));
  }

  if (want('triple', 3)) {
    for (const [, ids] of groups) if (ids.length >= 3) add(ids.slice(0, 3));
  }

  if (target?.type === 'multi') {
    for (const [, ids] of groups) {
      if (ids.length >= target.size) add(ids.slice(0, target.size));
    }
  } else if (!target) {
    for (const [, ids] of groups) if (ids.length >= 4) add([...ids]);
  }

  if (want('fullhouse', 5)) {
    const tripleRanks = [...groups.entries()].filter(([, ids]) => ids.length >= 3);
    const pairRanks = [...groups.entries()].filter(([, ids]) => ids.length >= 2);
    for (const [tripleRank, tripleIds] of tripleRanks) {
      for (const [pairRank, pairIds] of pairRanks) {
        if (pairRank === tripleRank) continue;
        add([...tripleIds.slice(0, 3), ...pairIds.slice(0, 2)]);
      }
    }
  }

  if (want('straight', 5)) {
    for (let start = 1; start <= 10; start += 1) {
      add(sequenceCards(groups, start, 5, 1));
    }
  }

  if (want('pairseq', 6)) {
    for (let start = 1; start <= 12; start += 1) {
      add(sequenceCards(groups, start, 3, 2));
    }
  }

  if (want('steel', 6)) {
    for (let start = 1; start <= 13; start += 1) {
      add(sequenceCards(groups, start, 2, 3));
    }
  }

  return candidates;
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

function targetPlayedBias(room, targetSeat, combo) {
  if (targetSeat == null || !combo) return 0;
  const plays = (room.publicPlays || []).filter(
    (play) => play.seat === targetSeat && play.success
  );
  let high = 0;
  let low = 0;
  for (const play of plays) {
    for (const id of play.cards || []) {
      const card = parseCard(id);
      if (!card) continue;
      if (card.rankValue > combo.key) high += 1;
      else if (card.rankValue < combo.key) low += 1;
    }
  }
  let bias = (high - low) * 0.02;
  const left = room.hands?.[targetSeat]?.length ?? 0;
  if (left <= 3) bias *= 1.5;
  return Math.max(-0.15, Math.min(0.15, bias));
}

/**
 * 估算“猜大”正确的概率：目标牌型比 AI 这手牌小的可能性。
 * 只看还没见过的牌，并结合目标之前成功打出的牌修正。
 */
export function estimateHigherChance(room, seat, combo, targetSeat = null) {
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
  const base = lower / total;
  return Math.max(0.02, Math.min(0.98, base + targetPlayedBias(room, targetSeat, combo)));
}

/**
 * 根据记牌结果选择猜大还是猜小。
 * 保留两成随机偏差，避免电脑变成“算牌机器”。
 */
export function chooseClaimDirection(room, seat, combo, rng = Math.random, targetSeat = null) {
  const chance = calibrateClaimChance(
    estimateHigherChance(room, seat, combo, targetSeat)
  );
  const confidence = 0.5 + (chance - 0.5) * 0.8;
  return rng() < confidence ? 'higher' : 'lower';
}

/**
 * 把前面已经出过牌的人按他们互相报的大小排成一个从低到高的顺序。
 * 例如 B 先出、A 报“比 B 大”，顺序就是 [B, A]。
 * 如果前面的报法自身绕成环（说明至少有人说错），返回 null。
 */
function orderPriorSeats(room, prior) {
  const index = new Map(prior.map((seat, position) => [seat, position]));
  const edges = new Map(prior.map((seat) => [seat, new Set()]));
  const indegree = new Map(prior.map((seat) => [seat, 0]));
  let hasEdge = false;

  for (const seat of prior) {
    const claims = room.actions?.[seat]?.claims || [];
    for (const claim of claims) {
      const target = claim.target;
      if (!index.has(target) || target === seat) continue;
      const from = claim.dir === 'higher' ? target : seat;
      const to = claim.dir === 'higher' ? seat : target;
      if (!edges.get(from).has(to)) {
        edges.get(from).add(to);
        indegree.set(to, indegree.get(to) + 1);
        hasEdge = true;
      }
    }
  }

  if (!hasEdge) return { order: [...prior], hasEdge: false };

  const queue = prior
    .filter((seat) => indegree.get(seat) === 0)
    .sort((a, b) => index.get(a) - index.get(b));
  const order = [];
  while (queue.length) {
    const seat = queue.shift();
    order.push(seat);
    for (const next of edges.get(seat)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        queue.push(next);
        queue.sort((a, b) => index.get(a) - index.get(b));
      }
    }
  }

  return order.length === prior.length ? { order, hasEdge: true } : null;
}

/**
 * 给 AI 生成一组和前面报法不矛盾的猜测。
 *
 * 前面已经形成“B < A”这样的顺序时，电脑只能落在其中一个位置：
 * 比所有人都小、夹在中间、或比所有人都大，不能既说比 B 小又说比 A 大。
 * 这里枚举所有“切点”，选概率最高的那一种。
 */
export function chooseConsistentClaimDirections(room, seat, combo, prior, rng = Math.random) {
  const noisy = new Map();
  for (const target of prior) {
    const chance = calibrateClaimChance(estimateHigherChance(room, seat, combo, target));
    const value = 0.5 + (chance - 0.5) * 0.8 + (rng() - 0.5) * 0.2;
    noisy.set(target, Math.max(0.02, Math.min(0.98, value)));
  }

  const ordered = orderPriorSeats(room, prior);
  if (!ordered || !ordered.hasEdge) {
    return prior.map((target) => ({
      target,
      dir: rng() < noisy.get(target) ? 'higher' : 'lower'
    }));
  }

  let bestCut = 0;
  let bestScore = -Infinity;
  for (let cut = 0; cut <= ordered.order.length; cut += 1) {
    let score = 0;
    for (let i = 0; i < ordered.order.length; i += 1) {
      const probability = noisy.get(ordered.order[i]);
      score += Math.log(i < cut ? probability : 1 - probability);
    }
    if (score > bestScore + 1e-9) {
      bestScore = score;
      bestCut = cut;
    }
  }

  const directions = new Map();
  ordered.order.forEach((target, i) => {
    directions.set(target, i < bestCut ? 'higher' : 'lower');
  });
  return prior.map((target) => ({ target, dir: directions.get(target) }));
}

/**
 * 估算“目标和自己点数相同”的概率。只对单张、对子、三张、多张有效；
 * 连续牌型靠点数判断同点没有意义，返回 0。
 */
export function estimateEqualChance(room, seat, combo) {
  if (!combo) return 0;
  const counts = remainingRankCounts(room, seat);
  if (combo.type === 'fullhouse') {
    let total = 0;
    let equal = 0;
    for (const [rankValue, count] of counts) {
      if (count < 3) continue;
      total += 1;
      if (rankValue === combo.key) equal += 1;
    }
    return total ? equal / total : 0;
  }
  if (!['single', 'pair', 'triple', 'multi'].includes(combo.type)) return 0;

  const need = combo.type === 'single' ? 1 : combo.type === 'pair' ? 2 : combo.type === 'triple' ? 3 : combo.size;
  let total = 0;
  let equal = 0;
  for (const [rankValue, count] of counts) {
    if (count < need) continue;
    total += count;
    if (rankValue === combo.key) equal += count;
  }
  return total ? equal / total : 0;
}

function countIsolatedRanks(cards) {
  const counts = new Map();
  for (const id of cards) {
    const card = parseCard(id);
    if (!card) continue;
    counts.set(card.rankValue, (counts.get(card.rankValue) || 0) + 1);
  }
  let isolated = 0;
  for (const count of counts.values()) if (count === 1) isolated += 1;
  return isolated;
}

function leadBonus(combo) {
  if (!combo) return 0;
  if (['triple', 'pairseq', 'steel'].includes(combo.type)) return 220;
  if (combo.type === 'multi') return 180;
  if (combo.type === 'straight') return 140;
  if (combo.type === 'pair') return 50;
  return 0;
}

function scoreCandidate(room, seat, candidate, hand, { isLeader, target }) {
  const played = new Set(candidate.cards);
  const remaining = hand.filter((id) => !played.has(id));
  const turns = estimateHandTurns(remaining);
  const chance = target
    ? estimateHigherChance(room, seat, candidate.combo, null)
    : 0.5;
  const equalChance = target ? estimateEqualChance(room, seat, candidate.combo) : 0;

  // 手数第一；同手数时保留更整的牌、避开中段没把握的报法、避开同点。
  let score =
    turns * 1000 +
    remaining.length +
    Math.abs(chance - 0.5) * 300 +
    equalChance * 200 +
    countIsolatedRanks(remaining) * 2;
  if (isLeader) score -= leadBonus(candidate.combo);
  return score;
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

  const candidates = enumerateCombos(hand, target);
  if (!candidates.length) return isLeader ? null : { kind: 'pass' };

  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreCandidate(room, seat, candidate, hand, { isLeader, target })
    }))
    .sort((a, b) => a.score - b.score || b.combo.key - a.combo.key);
  const best = scored[0];

  if (isLeader) {
    return { kind: 'play', cards: best.cards, claims: [] };
  }

  const index = room.turnOrder.indexOf(seat);
  const prior = room.turnOrder
    .slice(0, index)
    .filter((targetSeat) => room.actions[targetSeat]?.played);
  const claims = chooseConsistentClaimDirections(room, seat, best.combo, prior, rng);

  return { kind: 'play', cards: best.cards, claims };
}

export function aiThinkingText(room, seat) {
  const player = room?.seats?.[seat];
  if (!player?.isAI) return '';
  const count = room.hands?.[seat]?.length || 0;
  if (room.turn === seat && room.phase === 'playing') return '正在配牌…';
  return `${count} 张牌`;
}
