import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addAI,
  addPlayer,
  buildSnapshot,
  canStart,
  cardId,
  continueRound,
  createRoom,
  passTurn,
  playCards,
  resetScores,
  resetToLobby,
  sortHand,
  startGame
} from '../js/game.js';
import { chooseAIAction } from '../js/ai.js';

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
