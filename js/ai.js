/**
 * 电脑牌友的简单策略。
 *
 * 设计目标是“能跟就跟、不会算牌”的轻松陪练：
 *   - 先手：出手里最小的单牌。
 *   - 跟牌：找得到同牌型就出，找不到就过。
 *   - 猜大小：只看自己手里的牌，不偷看别人的暗牌，随机猜大或小。
 *
 * 这里只读取 AI 自己的手牌和已经公开的牌型，不读取其他座位的牌面点数。
 */

import { findPlayableCombo } from './game.js';

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
    dir: rng() < 0.5 ? 'higher' : 'lower'
  }));

  return { kind: 'play', cards: playable.cards, claims };
}

/**
 * 给房主界面用：AI 还剩多少张牌、是否轮到它。
 * 目前只需要一个稳定的展示文案，保留成函数便于以后加难度。
 */
export function aiThinkingText(room, seat) {
  const player = room?.seats?.[seat];
  if (!player?.isAI) return '';
  const count = room.hands?.[seat]?.length || 0;
  if (room.turn === seat && room.phase === 'playing') return '正在想…';
  return `${count} 张牌`;
}
