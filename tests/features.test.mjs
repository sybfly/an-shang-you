import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addAI,
  addPlayer,
  analyzeCombo,
  buildSnapshot,
  canStart,
  cardId,
  continueRound,
  createRoom,
  makeDeck,
  jokerId,
  parseCard,
  passTurn,
  playCards,
  resetScores,
  resetToLobby,
  sortHand,
  startGame,
  validateDeal
} from '../js/game.js';
import {
  chooseAIAction,
  chooseClaimDirection,
  estimateHigherChance,
  remainingRankCounts
} from '../js/ai.js';

function seeded(seed = 42) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function makeTable() {
  const room = createRoom({ hostName: '房主' });
  addPlayer(room, { name: '牌友一', token: 't1', peerId: 'p1' });
  addPlayer(room, { name: '牌友二', token: 't2', peerId: 'p2' });
  return room;
}

function makeAIRoom() {
  const room = createRoom({ hostName: '房主' });
  assert.equal(addAI(room).ok, true);
  assert.equal(addAI(room).ok, true);
  return room;
}

function seatTable(room, hands, leader = 0) {
  const seats = Object.keys(hands).map(Number).sort((a, b) => a - b);
  const start = seats.indexOf(leader);
  room.phase = 'playing';
  room.round = 1;
  room.leader = leader;
  room.turnOrder = [...seats.slice(start), ...seats.slice(0, start)];
  room.turnIndex = 0;
  room.turn = leader;
  room.actions = {};
  room.hands = {};
  room.finished = [];
  room.ranking = [];
  room.winner = null;
  room.winnerCandidates = [];
  room.nextLeader = null;
  for (const seat of seats) room.hands[seat] = sortHand(hands[seat] || []);
}

function finishThreePlayerGame(room, rng) {
  startGame(room, rng);
  seatTable(room, {
    0: [cardId(0, 'S', 7)],
    1: [cardId(0, 'H', 9)],
    2: [cardId(0, 'C', 5), cardId(0, 'C', 6)]
  });
  playCards(room, 0, [cardId(0, 'S', 7)]);
  playCards(room, 1, [cardId(0, 'H', 9)], [{ target: 0, dir: 'higher' }]);
  passTurn(room, 2);
}

function comboOfOne(id) {
  const result = analyzeCombo([id]);
  assert.equal(result.valid, true, result.reason);
  return result.combo;
}

test('开局配牌：3～6 人的副数、手牌数、明牌数都合规', () => {
  for (let count = 3; count <= 6; count += 1) {
    const room = createRoom({ hostName: '房主' });
    for (let seat = 1; seat < count; seat += 1) {
      addPlayer(room, { name: `牌友${seat}`, token: `t${seat}`, peerId: `p${seat}` });
    }
    const started = startGame(room, seeded(30 + count));
    assert.equal(started.ok, true, started.message);
    const check = validateDeal(room);
    assert.equal(check.ok, true, check.message);
    assert.equal(room.deckInfo.deckCount, count === 3 ? 1 : count === 6 ? 3 : 2);
    assert.equal(room.revealed.length, count === 5 ? 3 : 0);
  }

  const room = createRoom({ hostName: '房主' });
  addPlayer(room, { name: '牌友一', token: 't1', peerId: 'p1' });
  addPlayer(room, { name: '牌友二', token: 't2', peerId: 'p2' });
  startGame(room, seeded(41));
  room.hands[0].push(room.hands[0][0]);
  assert.equal(validateDeal(room).ok, false, '重复牌应当被判为配牌异常');
});

test('电脑记牌：公开出牌后，没见过的牌会减少', () => {
  const room = makeTable();
  finishThreePlayerGame(room, seeded(51));
  assert.equal(room.phase, 'gameOver');
  for (const id of [cardId(0, 'S', 7), cardId(0, 'H', 9)]) {
    assert.ok(room.publicCards.includes(id), `${id} 应该进入公开牌池`);
  }
  const counts = remainingRankCounts(room, 0);
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(total, 52, '54 张牌减去 2 张公开牌，还剩 52 张没见过');
});

test('电脑推理：牌型越高越敢猜大，公开高牌后会更有把握', () => {
  const room = makeAIRoom();
  room.deckInfo = { deckCount: 1, handSize: 18, revealedCount: 0, totalCards: 54 };
  room.publicCards = [];
  room.revealed = [];

  room.hands[1] = [jokerId(0, true)];
  const high = comboOfOne(jokerId(0, true));
  const highChance = estimateHigherChance(room, 1, high);

  room.hands[1] = [cardId(0, 'S', 3)];
  const low = comboOfOne(cardId(0, 'S', 3));
  const lowChance = estimateHigherChance(room, 1, low);

  room.hands[1] = [cardId(0, 'S', 10)];
  const mid = comboOfOne(cardId(0, 'S', 10));
  const midChance = estimateHigherChance(room, 1, mid);

  assert.ok(highChance > 0.9, `大的牌应该敢猜大，实际 ${highChance}`);
  assert.ok(lowChance < 0.1, `小的牌应该不敢猜大，实际 ${lowChance}`);
  assert.ok(midChance > lowChance && midChance < highChance);

  room.publicCards = makeDeck(1).filter((id) => parseCard(id).rankValue > 10);
  const afterSeenHigh = estimateHigherChance(room, 1, mid);
  assert.ok(afterSeenHigh > midChance, '高牌都露过面后，中等牌更有把握猜大');

  assert.equal(chooseClaimDirection(room, 1, high, () => 0.1), 'higher');
  assert.equal(chooseClaimDirection(room, 1, low, () => 0.9), 'lower');
});

test('加电脑：占座、可开局、最多六人', () => {
  const room = createRoom({ hostName: '房主' });
  const first = addAI(room);
  assert.equal(first.ok, true);
  assert.equal(first.seat, 1);
  assert.equal(first.player.isAI, true);
  assert.equal(first.player.connected, true);
  assert.equal(first.player.token, null);

  const second = addAI(room);
  assert.equal(second.ok, true);
  assert.equal(second.seat, 2);
  assert.equal(canStart(room).ok, true);

  for (let i = 0; i < 3; i += 1) assert.equal(addAI(room).ok, true);
  assert.equal(addAI(room).ok, false, '第七位不能再加');
});

test('电脑先手：打出手里最小的单牌', () => {
  const room = makeAIRoom();
  seatTable(
    room,
    {
      0: [cardId(0, 'S', 6)],
      1: [cardId(0, 'H', 9), cardId(0, 'S', 5)],
      2: [cardId(0, 'C', 4)]
    },
    1
  );
  const action = chooseAIAction(room, 1, seeded(1));
  assert.equal(action.kind, 'play');
  assert.deepEqual(action.cards, [cardId(0, 'S', 5)]);
  assert.deepEqual(action.claims, []);
});

test('电脑跟牌：能跟就跟，并为每位先出者猜大小', () => {
  const room = makeAIRoom();
  seatTable(
    room,
    {
      0: [cardId(0, 'S', 9)],
      1: [cardId(0, 'H', 10)],
      2: [cardId(0, 'C', 8)]
    },
    0
  );
  playCards(room, 0, [cardId(0, 'S', 9)]);
  assert.equal(room.turn, 1);

  const action = chooseAIAction(room, 1, seeded(2));
  assert.equal(action.kind, 'play');
  assert.deepEqual(action.cards, [cardId(0, 'H', 10)]);
  assert.equal(action.claims.length, 1);
  assert.equal(action.claims[0].target, 0);
  assert.ok(['higher', 'lower'].includes(action.claims[0].dir));
});

test('电脑跟牌：没有同牌型就过', () => {
  const room = makeAIRoom();
  seatTable(
    room,
    {
      0: [cardId(0, 'S', 9), cardId(0, 'H', 9)],
      1: [cardId(0, 'H', 10)],
      2: [cardId(0, 'C', 8)]
    },
    0
  );
  playCards(room, 0, [cardId(0, 'S', 9), cardId(0, 'H', 9)]);
  const action = chooseAIAction(room, 1, seeded(3));
  assert.equal(action.kind, 'pass');
});

test('结算记分：按名次累计，跨局保留，可清零', () => {
  const room = makeTable();
  finishThreePlayerGame(room, seeded(11));

  assert.equal(room.phase, 'gameOver');
  assert.equal(room.gamesPlayed, 1);
  assert.deepEqual(
    room.ranking.map((entry) => entry.seat),
    [1, 0, 2]
  );
  assert.equal(room.scores[1], 2);
  assert.equal(room.scores[0], 1);
  assert.equal(room.scores[2], 0);

  const snapshot = buildSnapshot(room, 2);
  assert.equal(snapshot.gamesPlayed, 1);
  assert.equal(snapshot.players[1].score, 2);
  assert.equal(snapshot.self.score, 0);
  assert.equal(snapshot.ranking[0].points, 2);

  finishThreePlayerGame(room, seeded(12));
  assert.equal(room.gamesPlayed, 2);
  assert.equal(room.scores[1], 4);
  assert.equal(room.scores[0], 2);
  assert.equal(room.scores[2], 0);

  resetToLobby(room);
  const reset = resetScores(room);
  assert.equal(reset.ok, true);
  assert.equal(room.gamesPlayed, 0);
  assert.deepEqual(room.scores, { 0: 0, 1: 0, 2: 0 });
});

test('三个电脑能自己把一局打完并结算', () => {
  const room = makeAIRoom();
  room.seats[0].isAI = true;
  startGame(room, seeded(21));

  let guard = 0;
  while (room.phase !== 'gameOver' && guard < 2000) {
    guard += 1;
    if (room.phase === 'review') {
      assert.equal(continueRound(room).ok, true);
      continue;
    }
    const seat = room.turn;
    assert.notEqual(seat, null, '进行中应该有当前玩家');
    const action = chooseAIAction(room, seat, seeded(500 + guard));
    assert.ok(action, `座位 ${seat} 应该能行动`);
    const result =
      action.kind === 'play'
        ? playCards(room, seat, action.cards, action.claims)
        : passTurn(room, seat);
    assert.equal(result.ok, true, result.message);
  }

  assert.equal(room.phase, 'gameOver');
  assert.equal(room.ranking.length, 3);
  assert.equal(room.gamesPlayed, 1);
  assert.equal(room.scores[0] + room.scores[1] + room.scores[2], 3);
});
