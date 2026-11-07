import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DECK_COUNT_BY_PLAYERS,
  HAND_SIZE_BY_PLAYERS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  addAI,
  addPlayer,
  analyzeCombo,
  buildSnapshot,
  canStart,
  cardId,
  cardLabel,
  continueRound,
  createRoom,
  findDroppedSeatByName,
  findPlayableCombo,
  findReconnectSeat,
  jokerId,
  occupiedSeats,
  passTurn,
  playCards,
  prepareJoin,
  resetToLobby,
  sortHand,
  startGame,
  startHint,
  takeOverSeat,
  updateConnection
} from '../js/game.js';

function seeded(seed = 42) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function makeTable(playerCount = 3) {
  const room = createRoom({ hostName: '阿福' });
  for (let seat = 1; seat < playerCount; seat += 1) {
    const result = addPlayer(room, {
      name: `牌友${seat}`,
      token: `token-${seat}`,
      peerId: `peer-${seat}`
    });
    assert.equal(result.ok, true);
  }
  return room;
}

function seatTable(room, hands, leader = 0) {
  const seats = occupiedSeats(room);
  const start = seats.indexOf(leader);
  room.phase = 'playing';
  room.round = 1;
  room.leader = leader;
  room.turnOrder = [...seats.slice(start), ...seats.slice(0, start)];
  room.turnIndex = 0;
  room.turn = leader;
  room.actions = {};
  room.hands = {};
  for (const seat of seats) room.hands[seat] = sortHand(hands[seat] || []);
  room.revealed = [];
  room.winner = null;
  room.winnerCandidates = [];
  room.nextLeader = null;
}

function comboOf(cards) {
  const result = analyzeCombo(cards);
  assert.equal(result.valid, true, result.reason);
  return result.combo;
}

test('每种人数的牌副数、手牌数和明牌数正确', () => {
  for (let count = MIN_PLAYERS; count <= MAX_PLAYERS; count += 1) {
    const room = makeTable(count);
    assert.equal(canStart(room).ok, true);
    const result = startGame(room, seeded(10 + count));
    assert.equal(result.ok, true, result.message);
    assert.equal(room.deckInfo.deckCount, DECK_COUNT_BY_PLAYERS[count]);
    assert.equal(room.deckInfo.handSize, HAND_SIZE_BY_PLAYERS[count]);
    assert.equal(room.revealed.length, count === 5 ? 3 : 0);
    assert.equal(room.phase, 'playing');
    assert.equal(room.round, 1);
    assert.equal(room.turn, room.leader);

    const seats = occupiedSeats(room);
    let total = room.revealed.length;
    for (const seat of seats) {
      assert.equal(room.hands[seat].length, HAND_SIZE_BY_PLAYERS[count]);
      total += room.hands[seat].length;
    }
    assert.equal(total, DECK_COUNT_BY_PLAYERS[count] * 54);

    const allIds = [...room.revealed];
    for (const seat of seats) allIds.push(...room.hands[seat]);
    assert.equal(new Set(allIds).size, allIds.length, '牌的编号应当唯一');
  }
});

test('三人以下不能开局，六人以上不能入座', () => {
  const one = createRoom({ hostName: '阿福' });
  assert.equal(one.phase, 'lobby');
  assert.equal(canStart(one).ok, false);
  assert.match(startHint(one), /还差 2 位/);

  addPlayer(one, { name: '二', token: 't2' });
  assert.equal(canStart(one).ok, false);
  assert.match(startHint(one), /还差 1 位/);

  addPlayer(one, { name: '三', token: 't3' });
  assert.equal(canStart(one).ok, true);

  const six = makeTable(6);
  assert.equal(occupiedSeats(six).length, 6);
  assert.equal(six.seats.length, MAX_PLAYERS);
  const full = addPlayer(six, { name: '七', token: 't7' });
  assert.equal(full.ok, false);
  assert.equal(full.error, 'ROOM_FULL');
});

test('牌型大小：大王 > 小王 > 2 > A > K', () => {
  const ranks = [
    ['大王', jokerId(0, true)],
    ['小王', jokerId(0, false)],
    ['2', cardId(0, 'S', 2)],
    ['A', cardId(0, 'H', 1)],
    ['K', cardId(0, 'C', 13)]
  ];
  const combos = ranks.map(([, id]) => comboOf([id]));
  for (let i = 1; i < combos.length; i += 1) {
    assert.ok(combos[i - 1].key > combos[i].key);
  }
});

test('基础牌型识别', () => {
  assert.equal(comboOf([cardId(0, 'S', 7)]).type, 'single');
  assert.equal(comboOf([cardId(0, 'S', 7), cardId(0, 'H', 7)]).type, 'pair');
  assert.equal(
    comboOf([cardId(0, 'S', 7), cardId(0, 'H', 7), cardId(0, 'C', 7)]).type,
    'triple'
  );
  assert.equal(
    comboOf([
      cardId(0, 'S', 7),
      cardId(0, 'H', 7),
      cardId(0, 'C', 7),
      cardId(0, 'D', 4),
      cardId(0, 'S', 4)
    ]).type,
    'fullhouse'
  );
  assert.equal(
    comboOf([
      cardId(0, 'S', 9),
      cardId(0, 'H', 9),
      cardId(0, 'C', 9),
      cardId(0, 'D', 9)
    ]).type,
    'multi'
  );
  assert.equal(
    comboOf([
      cardId(0, 'S', 9),
      cardId(0, 'H', 9),
      cardId(0, 'C', 9),
      cardId(0, 'D', 9),
      cardId(1, 'S', 9)
    ]).label,
    '5张'
  );
});

test('顺子：A 可作头尾，2 可参与，王不参与', () => {
  const straight = (ranks) =>
    analyzeCombo(ranks.map((rank, i) => cardId(0, ['S', 'H', 'C', 'D', 'S'][i], rank)));

  assert.equal(straight([1, 2, 3, 4, 5]).valid, true);
  assert.equal(straight([1, 2, 3, 4, 5]).combo.key, 5);
  assert.equal(straight([2, 3, 4, 5, 6]).valid, true);
  assert.equal(straight([10, 11, 12, 13, 1]).valid, true);
  assert.equal(straight([10, 11, 12, 13, 1]).combo.key, 14);
  assert.equal(straight([11, 12, 13, 1, 2]).valid, false);
  assert.equal(straight([3, 4, 5, 6, 8]).valid, false);

  const withJoker = analyzeCombo([
    cardId(0, 'S', 10),
    cardId(0, 'H', 11),
    cardId(0, 'C', 12),
    cardId(0, 'D', 13),
    jokerId(0, true)
  ]);
  assert.equal(withJoker.valid, false);
});

test('三连对和钢板连续牌型', () => {
  const pairseq = (ranks) =>
    analyzeCombo(
      ranks.flatMap((rank, i) => [
        cardId(0, ['S', 'H', 'C', 'D'][i % 4], rank),
        cardId(1, ['S', 'H', 'C', 'D'][i % 4], rank)
      ])
    );
  const steel = (ranks) =>
    analyzeCombo(
      ranks.flatMap((rank, i) => ['S', 'H', 'C'].map((suit) => cardId(i, suit, rank)))
    );

  assert.equal(pairseq([3, 4, 5]).valid, true);
  assert.equal(pairseq([1, 2, 3]).valid, true);
  assert.equal(pairseq([12, 13, 1]).valid, true);
  assert.equal(pairseq([11, 12, 13, 1]).valid, false);
  assert.equal(pairseq([3, 4, 6]).valid, false);

  assert.equal(steel([3, 4]).valid, true);
  assert.equal(steel([1, 2]).valid, true);
  assert.equal(steel([13, 1]).valid, true);
  assert.equal(steel([3, 5]).valid, false);

  const sixSame = analyzeCombo([
    cardId(0, 'S', 8),
    cardId(0, 'H', 8),
    cardId(0, 'C', 8),
    cardId(1, 'S', 8),
    cardId(1, 'H', 8),
    cardId(1, 'C', 8)
  ]);
  assert.equal(sixSame.valid, true);
  assert.equal(sixSame.combo.type, 'multi');
});

test('无效牌型会被拒绝', () => {
  const invalid = [
    [cardId(0, 'S', 7), cardId(0, 'H', 8)],
    [cardId(0, 'S', 7), cardId(0, 'H', 7), cardId(0, 'C', 8), cardId(0, 'D', 8)],
    [
      cardId(0, 'S', 7),
      cardId(0, 'H', 7),
      cardId(0, 'C', 7),
      cardId(0, 'D', 7),
      cardId(0, 'S', 8)
    ],
    [
      cardId(0, 'S', 3),
      cardId(0, 'H', 3),
      cardId(0, 'C', 4),
      cardId(0, 'D', 4),
      cardId(0, 'S', 6),
      cardId(0, 'H', 6)
    ]
  ];
  for (const cards of invalid) {
    assert.equal(analyzeCombo(cards).valid, false, cards.join(','));
  }
});

test('找牌能覆盖所有跟牌牌型', () => {
  const hand = [
    cardId(0, 'S', 3),
    cardId(0, 'H', 3),
    cardId(0, 'C', 3),
    cardId(1, 'S', 3),
    cardId(0, 'D', 4),
    cardId(0, 'S', 4),
    cardId(0, 'H', 4),
    cardId(0, 'C', 5),
    cardId(0, 'D', 5),
    cardId(0, 'S', 6),
    cardId(0, 'H', 6),
    cardId(0, 'C', 7),
    cardId(0, 'D', 7)
  ];
  const cases = [
    { type: 'single', size: 1 },
    { type: 'pair', size: 2 },
    { type: 'triple', size: 3 },
    { type: 'fullhouse', size: 5 },
    { type: 'straight', size: 5 },
    { type: 'pairseq', size: 6 },
    { type: 'steel', size: 6 },
    { type: 'multi', size: 4 }
  ];
  for (const target of cases) {
    const found = findPlayableCombo(hand, target);
    assert.ok(found, `没有找到 ${target.type}`);
    const analysis = analyzeCombo(found.cards);
    assert.equal(analysis.valid, true);
    assert.equal(analysis.combo.type, target.type);
    assert.equal(analysis.combo.size, target.size);
  }
});

test('先手必须出牌，后手可以随时过', () => {
  const room = makeTable(3);
  seatTable(room, {
    0: [cardId(0, 'S', 7), cardId(0, 'S', 8)],
    1: [cardId(0, 'H', 9), cardId(0, 'H', 10)],
    2: [cardId(0, 'C', 5), cardId(0, 'C', 6)]
  });

  assert.equal(passTurn(room, 0).error, 'LEADER_MUST_PLAY');
  assert.equal(playCards(room, 0, [cardId(0, 'S', 7)]).ok, true);
  assert.equal(room.turn, 1);
  const passed = passTurn(room, 1);
  assert.equal(passed.ok, true);
  assert.equal(room.actions[1].passed, true);
  assert.equal(room.turn, 2);
});

test('猜错只收回自己的牌，其他人正常出牌', () => {
  const room = makeTable(3);
  seatTable(room, {
    0: [cardId(0, 'S', 7), cardId(0, 'S', 8)],
    1: [cardId(0, 'H', 9), cardId(0, 'H', 10)],
    2: [cardId(0, 'C', 5), cardId(0, 'C', 6)]
  });

  playCards(room, 0, [cardId(0, 'S', 7)]);
  playCards(room, 1, [cardId(0, 'H', 9)], [{ target: 0, dir: 'lower' }]);
  passTurn(room, 2);

  assert.equal(room.phase, 'review');
  assert.equal(room.actions[0].status, 'success');
  assert.equal(room.actions[1].status, 'failed');
  assert.equal(room.actions[2].status, 'passed');
  assert.ok(room.hands[1].includes(cardId(0, 'H', 9)));
  assert.equal(room.hands[0].includes(cardId(0, 'S', 7)), false);
  assert.equal(room.nextLeader, 1, '本轮最大是 9，即使猜错也由他先出');
});

test('前面的人猜错后，后面与他的比较默认通过', () => {
  const room = makeTable(3);
  seatTable(room, {
    0: [cardId(0, 'S', 7), cardId(0, 'S', 8)],
    1: [cardId(0, 'H', 9), cardId(0, 'H', 10)],
    2: [cardId(0, 'C', 10), cardId(0, 'C', 6)]
  });

  playCards(room, 0, [cardId(0, 'S', 7)]);
  playCards(room, 1, [cardId(0, 'H', 9)], [{ target: 0, dir: 'lower' }]);
  const third = playCards(room, 2, [cardId(0, 'C', 10)], [
    { target: 0, dir: 'higher' },
    { target: 1, dir: 'lower' }
  ]);
  assert.equal(third.ok, true);

  assert.equal(room.phase, 'review');
  assert.equal(room.actions[1].status, 'failed');
  assert.equal(room.actions[2].status, 'success');
  const auto = room.actions[2].claimResults.find((result) => result.target === 1);
  assert.equal(auto.auto, true);
  assert.equal(auto.ok, true);
  assert.equal(auto.actual, null);
});

test('同一轮多人出完，按本轮点数决出上游', () => {
  const room = makeTable(3);
  seatTable(room, {
    0: [cardId(0, 'S', 7)],
    1: [cardId(0, 'H', 9)],
    2: [cardId(0, 'C', 5)]
  });

  playCards(room, 0, [cardId(0, 'S', 7)]);
  playCards(room, 1, [cardId(0, 'H', 9)], [{ target: 0, dir: 'higher' }]);
  playCards(room, 2, [cardId(0, 'C', 5)], [
    { target: 0, dir: 'lower' },
    { target: 1, dir: 'lower' }
  ]);

  assert.equal(room.phase, 'gameOver');
  assert.equal(room.winner, 1);
  assert.equal(room.winnerCandidates.length, 3);
  assert.equal(room.winnerCandidates[0].seat, 1);
  assert.equal(room.ranking[2].last, true, '全员出完时最后一名也算下游');
});

test('血战到底：一人出完后牌局继续，先手跳过已出完的人', () => {
  const room = makeTable(3);
  seatTable(room, {
    0: [cardId(0, 'S', 7)],
    1: [cardId(0, 'H', 9), cardId(0, 'H', 8)],
    2: [cardId(0, 'C', 5), cardId(0, 'C', 6)]
  });
  playCards(room, 0, [cardId(0, 'S', 7)]);
  playCards(room, 1, [cardId(0, 'H', 9)], [{ target: 0, dir: 'higher' }]);
  passTurn(room, 2);

  assert.equal(room.phase, 'review');
  assert.equal(room.winner, null);
  assert.equal(room.finished.length, 1);
  assert.equal(room.finished[0].seat, 0);
  assert.equal(room.finished[0].place, 1);
  assert.equal(room.nextLeader, 1);

  const result = continueRound(room);
  assert.equal(result.ok, true);
  assert.deepEqual(room.turnOrder, [1, 2]);
  assert.equal(room.turn, 1);
  assert.equal(room.round, 2);
});

test('血战到底：只剩一人时结束，并排出上下游', () => {
  const room = makeTable(3);
  seatTable(room, {
    0: [cardId(0, 'S', 7)],
    1: [cardId(0, 'H', 9)],
    2: [cardId(0, 'C', 5), cardId(0, 'C', 6)]
  });
  playCards(room, 0, [cardId(0, 'S', 7)]);
  playCards(room, 1, [cardId(0, 'H', 9)], [{ target: 0, dir: 'higher' }]);
  passTurn(room, 2);

  assert.equal(room.phase, 'gameOver');
  assert.equal(room.winner, 1, '9 比 7 大，先出完的上游是 1 号');
  assert.deepEqual(
    room.ranking.map((entry) => entry.seat),
    [1, 0, 2]
  );
  assert.equal(room.ranking[2].last, true);
  const snapshot = buildSnapshot(room, 2);
  assert.equal(snapshot.winner.seat, 1);
  assert.equal(snapshot.ranking.length, 3);
  assert.equal(snapshot.finished[0].seat, 1);
  assert.equal(snapshot.players[0].finished, true);
  assert.equal(snapshot.players[2].finished, false);
});

test('血战到底：多人同轮出完按牌点排先后，剩余玩家继续', () => {
  const room = makeTable(4);
  seatTable(room, {
    0: [cardId(0, 'S', 7)],
    1: [cardId(0, 'H', 10)],
    2: [cardId(0, 'C', 5), cardId(0, 'C', 6)],
    3: [cardId(0, 'D', 4), cardId(0, 'D', 3)]
  });
  playCards(room, 0, [cardId(0, 'S', 7)]);
  playCards(room, 1, [cardId(0, 'H', 10)], [{ target: 0, dir: 'higher' }]);
  passTurn(room, 2);
  passTurn(room, 3);

  assert.equal(room.phase, 'review');
  assert.deepEqual(
    room.finished.map((entry) => entry.seat),
    [1, 0]
  );
  assert.equal(room.finished[0].place, 1);
  assert.equal(room.finished[1].place, 2);
  assert.equal(room.nextLeader, 2, '已出完的人不能再先出');
  const result = continueRound(room);
  assert.equal(result.ok, true);
  assert.deepEqual(room.turnOrder, [2, 3]);
});

test('同点数时，先出者下一轮先出', () => {
  const room = makeTable(3);
  seatTable(room, {
    0: [cardId(0, 'S', 9), cardId(0, 'S', 8)],
    1: [cardId(0, 'H', 9), cardId(0, 'H', 10)],
    2: [cardId(0, 'C', 5), cardId(0, 'C', 6)]
  });

  playCards(room, 0, [cardId(0, 'S', 9)]);
  playCards(room, 1, [cardId(0, 'H', 9)], [{ target: 0, dir: 'higher' }]);
  passTurn(room, 2);

  assert.equal(room.actions[1].status, 'failed');
  assert.equal(room.nextLeader, 0, '点数相同，先出的 0 号先手');
});

test('同牌型才能跟，不能跨牌型压制', () => {
  const room = makeTable(3);
  seatTable(room, {
    0: [cardId(0, 'S', 7), cardId(0, 'H', 7)],
    1: [cardId(0, 'C', 9), cardId(0, 'D', 9)],
    2: [cardId(0, 'S', 10), cardId(0, 'H', 11)]
  });

  playCards(room, 0, [cardId(0, 'S', 7)]);
  const wrong = playCards(room, 1, [cardId(0, 'C', 9), cardId(0, 'D', 9)]);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, 'TYPE_MISMATCH');
  const right = playCards(room, 1, [cardId(0, 'C', 9)], [
    { target: 0, dir: 'higher' }
  ]);
  assert.equal(right.ok, true);
});

test('后手必须为前面每位出牌者提交猜测', () => {
  const room = makeTable(3);
  seatTable(room, {
    0: [cardId(0, 'S', 7)],
    1: [cardId(0, 'H', 9)],
    2: [cardId(0, 'C', 10)]
  });

  playCards(room, 0, [cardId(0, 'S', 7)]);
  const missing = playCards(room, 1, [cardId(0, 'H', 9)], []);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'BAD_CLAIMS');

  assert.equal(
    playCards(room, 1, [cardId(0, 'H', 9)], [{ target: 0, dir: 'higher' }]).ok,
    true
  );
  const thirdMissing = playCards(room, 2, [cardId(0, 'C', 10)], [
    { target: 0, dir: 'higher' }
  ]);
  assert.equal(thirdMissing.ok, false);
  assert.equal(thirdMissing.error, 'BAD_CLAIMS');
});

test('出牌时和揭晓后的快照不会泄露暗牌', () => {
  const room = makeTable(3);
  seatTable(room, {
    0: [cardId(0, 'S', 7), cardId(0, 'S', 8)],
    1: [cardId(0, 'H', 9), cardId(0, 'H', 10)],
    2: [cardId(0, 'C', 5), cardId(0, 'C', 6)]
  });
  playCards(room, 0, [cardId(0, 'S', 7)]);

  const viewer = 2;
  const snapshot = buildSnapshot(room, viewer);
  assert.equal(snapshot.target.type, 'single');
  assert.equal(snapshot.target.key, undefined);
  assert.equal(snapshot.actions[0].cards, null);
  assert.equal(snapshot.actions[0].combo.key, undefined);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('S7'), false, '不能泄露先手暗牌');

  playCards(room, 1, [cardId(0, 'H', 9)], [{ target: 0, dir: 'higher' }]);
  passTurn(room, 2);
  const revealed = buildSnapshot(room, viewer);
  assert.equal(revealed.phase, 'review');
  assert.equal(Array.isArray(revealed.actions[0].cards), true);
  assert.equal(revealed.actions[0].combo.key, 7);
});

test('五人局三张明牌公开，其他人数没有明牌', () => {
  for (const count of [3, 4, 5, 6]) {
    const room = makeTable(count);
    startGame(room, seeded(20 + count));
    const snapshot = buildSnapshot(room, 0);
    assert.equal(snapshot.revealed.length, count === 5 ? 3 : 0);
    if (count === 5) assert.equal(snapshot.deckInfo.revealedCount, 3);
  }
});

test('房主继续下一轮后，由本轮最大牌先出', () => {
  const room = makeTable(3);
  seatTable(room, {
    0: [cardId(0, 'S', 7), cardId(0, 'S', 8)],
    1: [cardId(0, 'H', 9), cardId(0, 'H', 10)],
    2: [cardId(0, 'C', 5), cardId(0, 'C', 6)]
  });
  playCards(room, 0, [cardId(0, 'S', 7)]);
  playCards(room, 1, [cardId(0, 'H', 9)], [{ target: 0, dir: 'higher' }]);
  passTurn(room, 2);
  assert.equal(room.phase, 'review');
  assert.equal(room.nextLeader, 1);

  const result = continueRound(room);
  assert.equal(result.ok, true);
  assert.equal(room.phase, 'playing');
  assert.equal(room.leader, 1);
  assert.equal(room.turn, 1);
  assert.equal(room.round, 2);
});

test('断线重连令牌和回到大厅', () => {
  const room = makeTable(3);
  assert.equal(findReconnectSeat(room, 'token-1'), 1);
  assert.equal(findReconnectSeat(room, 'missing'), -1);
  updateConnection(room, 1, false);
  assert.equal(room.seats[1].connected, false);
  updateConnection(room, 1, true);
  assert.equal(room.seats[1].connected, true);

  assert.equal(canStart(room).ok, true);
  startGame(room, seeded(31));
  assert.equal(resetToLobby(room).ok, true);
  assert.equal(room.phase, 'lobby');
  assert.deepEqual(room.hands, {});
  assert.equal(room.round, 0);
});

test('三个座位也按顺时针组成完整轮次', () => {
  const room = makeTable(3);
  seatTable(
    room,
    {
      0: [cardId(0, 'S', 7)],
      1: [cardId(0, 'H', 8)],
      2: [cardId(0, 'C', 9)]
    },
    2
  );
  assert.deepEqual(room.turnOrder, [2, 0, 1]);
  playCards(room, 2, [cardId(0, 'C', 9)]);
  assert.equal(room.turn, 0);
  playCards(room, 0, [cardId(0, 'S', 7)], [{ target: 2, dir: 'lower' }]);
  assert.equal(room.turn, 1);
});

test('牌型比较只发生在同牌型内', () => {
  const pair = comboOf([cardId(0, 'S', 3), cardId(0, 'H', 3)]);
  const straight = comboOf([
    cardId(0, 'S', 10),
    cardId(0, 'H', 11),
    cardId(0, 'C', 12),
    cardId(0, 'D', 13),
    cardId(0, 'S', 1)
  ]);
  assert.notEqual(pair.type, straight.type);
  assert.ok(straight.key > pair.key);
  assert.notEqual(pair.type, 'multi');
  assert.equal(cardLabel(cardId(0, 'S', 1), true), '黑桃A');
  assert.equal(cardLabel(jokerId(0, true)), '大王');
});

/* --------------------------------------------------------------------------
   掉线后同名玩家入座：必须房主审批
   -------------------------------------------------------------------------- */

test('同名掉线座位：只有掉线且非电脑的座位算数', () => {
  const room = makeTable(3);
  assert.equal(findDroppedSeatByName(room, '牌友1'), -1, '在线时不算掉线');

  updateConnection(room, 1, false);
  assert.equal(findDroppedSeatByName(room, '牌友1'), 1);
  assert.equal(findDroppedSeatByName(room, ' 牌友1 '), 1, '前后空格不影响匹配');
  assert.equal(findDroppedSeatByName(room, '牌友2'), -1, '别人还在线');
  assert.equal(findDroppedSeatByName(room, ''), -1);

  addAI(room);
  const aiSeat = room.seats.findIndex((p) => p?.isAI);
  assert.ok(aiSeat > 0);
  updateConnection(room, aiSeat, false);
  assert.equal(findDroppedSeatByName(room, room.seats[aiSeat].name), -1, '电脑不算玩家');
});

test('入座判定：同名玩家想坐回掉线位置时交给房主审批', () => {
  const room = makeTable(3);
  updateConnection(room, 1, false);

  const byName = prepareJoin(room, { name: '牌友1', token: 'someone-else' });
  assert.equal(byName.action, 'approve');
  assert.equal(byName.seat, 1);
  assert.equal(byName.verified, false, '凭证对不上，需要房主分辨');

  const byToken = prepareJoin(room, { name: '牌友1', token: 'token-1' });
  assert.equal(byToken.action, 'approve', '带原凭证也要先问房主');
  assert.equal(byToken.verified, true);

  // 牌局进行中也照样可以申请，只是要先审批
  startGame(room, seeded(77));
  updateConnection(room, 1, false);
  assert.equal(prepareJoin(room, { name: '牌友1', token: 'x' }).action, 'approve');
});

test('入座判定：不带同名、且牌局已开始，仍然拒绝', () => {
  const room = makeTable(3);
  startGame(room, seeded(78));
  const decision = prepareJoin(room, { name: '新来的', token: 'fresh' });
  assert.equal(decision.action, 'reject');
  assert.equal(decision.code, 'PLAYING');
});

test('入座判定：在线座位用凭证回来直接放行，正常新玩家在大厅入座', () => {
  const room = makeTable(3);
  assert.equal(prepareJoin(room, { name: '随便填的昵称', token: 'token-2' }).action, 'reconnect');
  assert.equal(prepareJoin(room, { name: '新来的', token: 'fresh' }).action, 'join');
});

test('房主同意后接管掉线座位：本人保留凭证，他人换发新凭证', () => {
  const room = makeTable(3);
  updateConnection(room, 1, false);
  const oldToken = room.seats[1].token;

  const same = takeOverSeat(room, 1, { peerId: 'peer-1b', token: oldToken });
  assert.equal(same.ok, true);
  assert.equal(same.keptToken, true);
  assert.equal(room.seats[1].token, oldToken);
  assert.equal(room.seats[1].connected, true);
  assert.equal(room.seats[1].peerId, 'peer-1b');
  assert.equal(room.seats[1].auto, false);

  updateConnection(room, 1, false);
  const other = takeOverSeat(room, 1, { peerId: 'peer-x', token: 'not-the-token' });
  assert.equal(other.ok, true);
  assert.equal(other.keptToken, false);
  assert.notEqual(room.seats[1].token, oldToken, '换人接手要收回旧凭证');
  assert.equal(room.seats[1].connected, true);

  assert.equal(takeOverSeat(room, 5, { peerId: 'x', token: 'y' }).ok, false);
});
