/**
 * 《暗上游》规则引擎
 *
 * 已确认的落地口径：
 *   - 3～6 人；3人1副、4人2副、5人2副（每人21张，余3张明牌）、6人3副。
 *   - 每人每轮出一次牌，出牌时只报牌型，不报点数。
 *   - 后手必须跟同牌型；可以随时选择“过”。
 *   - 后手要分别猜自己与前面每位已出牌玩家的大小，不能猜“相同”。
 *   - 判定时，猜错者只收回自己的牌；前面某人已判错时，后面与他相关的比较默认通过。
 *   - 下一轮由本轮实际出牌最大者先出，不论其是否猜对；点数相同则先出者先。
 *   - 先出完者获胜；同一轮多人出完，比较本轮所出牌点数，点数相同先出者胜。
 */

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 6;
export const SUIT_ORDER = ['S', 'H', 'C', 'D'];
export const AVATARS = ['🐼', '🐯', '🐰', '🐸', '🦊', '🐻'];
export const AI_NAMES = ['小虎', '小兔', '小狐', '小熊', '小鹿'];

export const DECK_COUNT_BY_PLAYERS = { 3: 1, 4: 2, 5: 2, 6: 3 };
export const HAND_SIZE_BY_PLAYERS = { 3: 18, 4: 27, 5: 21, 6: 27 };
export const REVEALED_BY_PLAYERS = { 3: 0, 4: 0, 5: 3, 6: 0 };

export const CHAT_PHRASES = ['大家好', '好牌！', '慢慢来', '谢谢'];

export const RANK_LABELS = {
  1: 'A',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
  15: '2',
  16: '小王',
  17: '大王'
};

export const SUITS = {
  S: { id: 'S', symbol: '♠', name: '黑桃', color: 'black' },
  H: { id: 'H', symbol: '♥', name: '红桃', color: 'red' },
  C: { id: 'C', symbol: '♣', name: '梅花', color: 'black' },
  D: { id: 'D', symbol: '♦', name: '方块', color: 'red' }
};

export const COMBO_LABELS = {
  single: '单张',
  pair: '对子',
  triple: '三张',
  fullhouse: '三带二',
  straight: '顺子',
  pairseq: '三连对',
  steel: '钢板',
  multi: '多张'
};

/* --------------------------------------------------------------------------
   牌与牌堆
   -------------------------------------------------------------------------- */

export function cardId(deck, suit, rank) {
  return `${deck}:${suit}${rank}`;
}

export function jokerId(deck, big = true) {
  return `${deck}:${big ? 'BJ' : 'SJ'}`;
}

export function parseCard(id) {
  if (typeof id !== 'string') return null;
  const sep = id.indexOf(':');
  if (sep < 0) return null;
  const deck = Number(id.slice(0, sep));
  const body = id.slice(sep + 1);
  if (!Number.isInteger(deck) || deck < 0) return null;

  if (body === 'BJ' || body === 'SJ') {
    const big = body === 'BJ';
    return {
      id,
      deck,
      joker: true,
      big,
      suit: null,
      rank: big ? 17 : 16,
      rankValue: big ? 17 : 16,
      label: big ? '大王' : '小王',
      short: big ? '大' : '小',
      symbol: '🃏',
      color: big ? 'red' : 'black'
    };
  }

  const suit = body[0];
  const rank = Number(body.slice(1));
  if (!SUITS[suit] || !Number.isInteger(rank) || rank < 1 || rank > 13) return null;
  const rankValue = rank === 1 ? 14 : rank === 2 ? 15 : rank;
  return {
    id,
    deck,
    joker: false,
    big: false,
    suit,
    rank,
    rankValue,
    label: `${SUITS[suit].name}${rankLabel(rank)}`,
    short: rankLabel(rank),
    symbol: SUITS[suit].symbol,
    color: SUITS[suit].color
  };
}

export function rankLabel(rank) {
  if (rank === 1) return 'A';
  if (rank === 11) return 'J';
  if (rank === 12) return 'Q';
  if (rank === 13) return 'K';
  if (rank === 14) return 'A';
  if (rank === 15) return '2';
  if (rank === 16) return '小王';
  if (rank === 17) return '大王';
  return String(rank);
}

export function makeDeck(deckCount = 1) {
  const deck = [];
  for (let d = 0; d < deckCount; d += 1) {
    for (const suit of SUIT_ORDER) {
      for (let rank = 1; rank <= 13; rank += 1) {
        deck.push(cardId(d, suit, rank));
      }
    }
    deck.push(jokerId(d, false));
    deck.push(jokerId(d, true));
  }
  return deck;
}

export function shuffle(items, rng = Math.random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function sortHand(hand) {
  return [...hand].sort((a, b) => {
    const ca = parseCard(a);
    const cb = parseCard(b);
    if (!ca || !cb) return 0;
    if (ca.rankValue !== cb.rankValue) return cb.rankValue - ca.rankValue;
    const sa = ca.suit ? SUIT_ORDER.indexOf(ca.suit) : 9;
    const sb = cb.suit ? SUIT_ORDER.indexOf(cb.suit) : 9;
    if (sa !== sb) return sa - sb;
    if (ca.deck !== cb.deck) return ca.deck - cb.deck;
    return a.localeCompare(b);
  });
}

export function groupHandByRank(hand) {
  const groups = [];
  let current = null;
  for (const id of sortHand(hand)) {
    const card = parseCard(id);
    if (!current || current.rankValue !== card.rankValue) {
      current = { rankValue: card.rankValue, cards: [] };
      groups.push(current);
    }
    current.cards.push(id);
  }
  return groups;
}

export function cardLabel(id, full = false) {
  const card = parseCard(id);
  if (!card) return '';
  if (card.joker) return card.label;
  return full ? card.label : `${card.symbol}${card.short}`;
}

export function isRedCard(id) {
  return parseCard(id)?.color === 'red';
}

/* --------------------------------------------------------------------------
   牌型识别
   -------------------------------------------------------------------------- */

function consecutiveSorted(values) {
  if (!values.length) return false;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] !== values[i - 1] + 1) return false;
  }
  return true;
}

/**
 * 在 A 可作 1 或 14 的规则下寻找连续段。
 * 返回这一段的最大自然点数（用于比较大小）。
 */
function sequenceHigh(parsed, length) {
  if (parsed.some((c) => c.joker)) return null;

  const lowValues = parsed.map((c) => (c.rank === 1 ? 1 : c.rank));
  const lowUnique = [...new Set(lowValues)].sort((a, b) => a - b);
  if (lowUnique.length === length && consecutiveSorted(lowUnique)) {
    return lowUnique[lowUnique.length - 1];
  }

  if (parsed.some((c) => c.rank === 1)) {
    const highValues = parsed.map((c) => (c.rank === 1 ? 14 : c.rank));
    const highUnique = [...new Set(highValues)].sort((a, b) => a - b);
    if (highUnique.length === length && consecutiveSorted(highUnique)) {
      return highUnique[highUnique.length - 1];
    }
  }
  return null;
}

function countsOf(parsed) {
  const map = new Map();
  for (const card of parsed) {
    map.set(card.rankValue, (map.get(card.rankValue) || 0) + 1);
  }
  return map;
}

export function comboLabel(type, size) {
  if (type === 'multi') return `${size}张`;
  return COMBO_LABELS[type] || '牌型';
}

/**
 * 识别一组牌。返回 { valid, combo } 或 { valid:false, reason }。
 * combo: { type, size, key, label }
 */
export function analyzeCombo(cards) {
  if (!Array.isArray(cards) || cards.length === 0) {
    return { valid: false, reason: '先选几张牌吧' };
  }
  if (new Set(cards).size !== cards.length) {
    return { valid: false, reason: '同一张牌不能选两次' };
  }
  const parsed = cards.map(parseCard);
  if (parsed.some((c) => !c)) {
    return { valid: false, reason: '牌面没有认出来，请重选' };
  }

  const n = cards.length;
  const counts = countsOf(parsed);
  const uniqueRanks = counts.size;
  const sameRank = uniqueRanks === 1;
  const rankValues = [...counts.keys()];

  const make = (type, key, label = comboLabel(type, n)) => ({
    valid: true,
    combo: { type, size: n, key, label }
  });

  if (n === 1) return make('single', parsed[0].rankValue, '单张');
  if (n === 2 && sameRank) return make('pair', parsed[0].rankValue, '对子');
  if (n === 3 && sameRank) return make('triple', parsed[0].rankValue, '三张');

  if (n >= 4 && sameRank) {
    return make('multi', parsed[0].rankValue, comboLabel('multi', n));
  }

  if (n === 5) {
    if (uniqueRanks === 2) {
      const sizes = [...counts.values()].sort((a, b) => a - b);
      if (sizes[0] === 2 && sizes[1] === 3) {
        const tripleRank = rankValues.find((rank) => counts.get(rank) === 3);
        return make('fullhouse', tripleRank, '三带二');
      }
    }

    if (uniqueRanks === 5) {
      const high = sequenceHigh(parsed, 5);
      if (high != null) return make('straight', high, '顺子');
    }
    return { valid: false, reason: '五张牌不是顺子或三带二' };
  }

  if (n === 6) {
    if (uniqueRanks === 3 && [...counts.values()].every((count) => count === 2)) {
      const high = sequenceHigh(parsed, 3);
      if (high != null) return make('pairseq', high, '三连对');
    }

    if (uniqueRanks === 2 && [...counts.values()].every((count) => count === 3)) {
      const high = sequenceHigh(parsed, 2);
      if (high != null) return make('steel', high, '钢板');
    }
    return { valid: false, reason: '六张牌不是三连对或钢板' };
  }

  return { valid: false, reason: '这组牌还不是有效牌型' };
}

export function comboShape(combo) {
  if (!combo) return null;
  return { type: combo.type, size: combo.size };
}

export function sameComboShape(a, b) {
  if (!a || !b) return false;
  return a.type === b.type && a.size === b.size;
}

/**
 * 从手牌里找一组能跟上 target 的牌。target 为空时找一张最小的单牌。
 * 仅用于“帮我找牌”，不是 AI。
 */
export function findPlayableCombo(hand, target = null) {
  const cards = sortHand(hand);
  if (!cards.length) return null;
  const byRank = new Map();
  for (const id of cards) {
    const card = parseCard(id);
    if (!byRank.has(card.rankValue)) byRank.set(card.rankValue, []);
    byRank.get(card.rankValue).push(id);
  }

  const pickGroup = (size) => {
    const ranks = [...byRank.keys()].sort((a, b) => a - b);
    for (const rank of ranks) {
      const group = byRank.get(rank);
      if (group.length >= size) {
        const picked = group.slice(0, size);
        const analysis = analyzeCombo(picked);
        if (analysis.valid) return picked;
      }
    }
    return null;
  };

  if (!target) {
    const card = cards[cards.length - 1];
    return { cards: [card], combo: analyzeCombo([card]).combo, found: true };
  }

  if (target.type === 'single') {
    const card = cards[cards.length - 1];
    const analysis = analyzeCombo([card]);
    return analysis.valid && sameComboShape(analysis.combo, target)
      ? { cards: [card], combo: analysis.combo, found: true }
      : null;
  }

  if (target.type === 'pair') {
    const picked = pickGroup(2);
    return picked ? { cards: picked, combo: analyzeCombo(picked).combo, found: true } : null;
  }

  if (target.type === 'triple') {
    const picked = pickGroup(3);
    return picked ? { cards: picked, combo: analyzeCombo(picked).combo, found: true } : null;
  }

  if (target.type === 'multi') {
    const picked = pickGroup(target.size);
    return picked ? { cards: picked, combo: analyzeCombo(picked).combo, found: true } : null;
  }

  if (target.type === 'fullhouse') {
    const ranks = [...byRank.keys()].sort((a, b) => a - b);
    for (const tripleRank of ranks) {
      if (byRank.get(tripleRank).length < 3) continue;
      for (const pairRank of ranks) {
        if (pairRank === tripleRank) continue;
        if (byRank.get(pairRank).length < 2) continue;
        const picked = [
          ...byRank.get(tripleRank).slice(0, 3),
          ...byRank.get(pairRank).slice(0, 2)
        ];
        const analysis = analyzeCombo(picked);
        if (analysis.valid && sameComboShape(analysis.combo, target)) {
          return { cards: picked, combo: analysis.combo, found: true };
        }
      }
    }
    return null;
  }

  if (target.type === 'straight') {
    for (let start = 1; start <= 10; start += 1) {
      const seq = [start, start + 1, start + 2, start + 3, start + 4];
      const picked = [];
      let ok = true;
      for (const value of seq) {
        const rank = value === 1 || value === 14 ? 1 : value;
        const group = [...byRank.entries()]
          .filter(([rankValue]) => (rankValue === 14 ? rank === 1 : rankValue === rank))
          .flatMap(([, ids]) => ids);
        if (!group.length) {
          ok = false;
          break;
        }
        picked.push(group[0]);
      }
      if (!ok) continue;
      const analysis = analyzeCombo(picked);
      if (analysis.valid && sameComboShape(analysis.combo, target)) {
        return { cards: picked, combo: analysis.combo, found: true };
      }
    }
    return null;
  }

  if (target.type === 'pairseq') {
    for (let start = 1; start <= 12; start += 1) {
      const seq = [start, start + 1, start + 2];
      const picked = [];
      let ok = true;
      for (const value of seq) {
        const rank = value === 1 || value === 14 ? 1 : value;
        const group = [...byRank.entries()]
          .filter(([rankValue]) => (rankValue === 14 ? rank === 1 : rankValue === rank))
          .flatMap(([, ids]) => ids);
        if (group.length < 2) {
          ok = false;
          break;
        }
        picked.push(group[0], group[1]);
      }
      if (!ok) continue;
      const analysis = analyzeCombo(picked);
      if (analysis.valid && sameComboShape(analysis.combo, target)) {
        return { cards: picked, combo: analysis.combo, found: true };
      }
    }
    return null;
  }

  if (target.type === 'steel') {
    for (let start = 1; start <= 13; start += 1) {
      const seq = [start, start + 1];
      const picked = [];
      let ok = true;
      for (const value of seq) {
        const rank = value === 1 || value === 14 ? 1 : value;
        const group = [...byRank.entries()]
          .filter(([rankValue]) => (rankValue === 14 ? rank === 1 : rankValue === rank))
          .flatMap(([, ids]) => ids);
        if (group.length < 3) {
          ok = false;
          break;
        }
        picked.push(group[0], group[1], group[2]);
      }
      if (!ok) continue;
      const analysis = analyzeCombo(picked);
      if (analysis.valid && sameComboShape(analysis.combo, target)) {
        return { cards: picked, combo: analysis.combo, found: true };
      }
    }
    return null;
  }

  return null;
}

/* --------------------------------------------------------------------------
   房间
   -------------------------------------------------------------------------- */

export function cleanName(raw, fallback = '牌友') {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8);
  return name || fallback;
}

export function randomToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function makeSeat(name, options = {}) {
  const {
    avatar = '🐼',
    connected = true,
    isHost = false,
    isAI = false,
    token = null,
    peerId = null
  } = options;
  return {
    name: cleanName(name),
    avatar,
    isAI,
    isHost,
    connected,
    token,
    peerId,
    auto: false,
    joinedAt: Date.now()
  };
}

export function createRoom({
  code = 'LOCAL',
  mode = 'online',
  hostName = '牌友',
  hostAvatar = '🐼',
  token = null
} = {}) {
  const room = {
    code,
    mode,
    phase: 'lobby',
    round: 0,
    seats: Array(MAX_PLAYERS).fill(null),
    hands: {},
    revealed: [],
    actions: {},
    turnOrder: [],
    turnIndex: 0,
    turn: null,
    leader: null,
    nextLeader: null,
    winner: null,
    winnerCandidates: [],
    finished: [],
    ranking: [],
    scores: { 0: 0 },
    gamesPlayed: 0,
    gameNo: 0,
    scoredGame: -1,
    lastGameScores: {},
    publicCards: [],
    publicPlays: [],
    seq: 1,
    deckInfo: null,
    lastEvent: null,
    createdAt: Date.now()
  };
  room.seats[0] = makeSeat(hostName, {
    avatar: hostAvatar,
    isHost: true,
    token,
    connected: true
  });
  return room;
}

export function occupiedSeats(room) {
  return room.seats.map((player, index) => (player ? index : -1)).filter((i) => i >= 0);
}

export function addPlayer(room, { name, token, peerId, isAI = false }) {
  if (room.phase !== 'lobby') {
    return { ok: false, error: 'NOT_LOBBY', message: '牌局已经开始了' };
  }
  let seat = -1;
  for (let i = 1; i < MAX_PLAYERS; i += 1) {
    if (!room.seats[i]) {
      seat = i;
      break;
    }
  }
  if (seat < 0) {
    return { ok: false, error: 'ROOM_FULL', message: '牌桌已经坐满六位了' };
  }
  room.seats[seat] = makeSeat(name, {
    avatar: AVATARS[seat] || '🐼',
    isAI,
    token: isAI ? null : token || randomToken(),
    peerId: isAI ? null : peerId || null,
    connected: true
  });
  if (room.scores[seat] == null) room.scores[seat] = 0;
  room.seq += 1;
  return { ok: true, seat, player: room.seats[seat] };
}

export function addAI(room) {
  if (room.phase !== 'lobby') {
    return { ok: false, error: 'NOT_LOBBY', message: '牌局已经开始了' };
  }
  const seat = room.seats.findIndex((player, index) => index > 0 && !player);
  if (seat < 0) {
    return { ok: false, error: 'ROOM_FULL', message: '牌桌已经坐满六位了' };
  }
  const result = addPlayer(room, {
    name: `电脑${AI_NAMES[seat - 1] || '小友'}`,
    isAI: true
  });
  if (result.ok) result.player.avatar = '🤖';
  return result;
}

export function removeSeat(room, seat) {
  if (room.phase !== 'lobby') {
    return { ok: false, error: 'NOT_LOBBY', message: '牌局进行中，不能移走座位' };
  }
  if (seat === 0 || !room.seats[seat]) {
    return { ok: false, error: 'INVALID_SEAT', message: '这个座位不能移走' };
  }
  const player = room.seats[seat];
  room.seats[seat] = null;
  delete room.scores[seat];
  delete room.lastGameScores[seat];
  room.seq += 1;
  return { ok: true, player };
}

export function updateConnection(room, seat, connected) {
  const player = room.seats[seat];
  if (!player) return { ok: false, error: 'NO_PLAYER' };
  player.connected = Boolean(connected);
  player.auto = room.phase !== 'lobby' ? !connected : false;
  room.seq += 1;
  return { ok: true, player };
}

export function findReconnectSeat(room, token) {
  if (!token) return -1;
  return room.seats.findIndex((p) => p && !p.isAI && p.token && p.token === token);
}

export function canStart(room) {
  const seats = occupiedSeats(room);
  if (seats.length < MIN_PLAYERS) {
    return {
      ok: false,
      message: `再等 ${MIN_PLAYERS - seats.length} 位牌友，至少三人才能开局`
    };
  }
  if (seats.length > MAX_PLAYERS) {
    return { ok: false, message: '牌桌最多六位牌友' };
  }
  const offline = seats.find((seat) => !room.seats[seat].connected);
  if (offline != null) {
    return { ok: false, message: `${room.seats[offline].name} 正在重连，稍等一下` };
  }
  return { ok: true, message: '人到齐了，可以开局' };
}

export function startHint(room) {
  const seats = occupiedSeats(room);
  if (seats.length < MIN_PLAYERS) {
    return `还差 ${MIN_PLAYERS - seats.length} 位牌友`;
  }
  const offline = seats.find((seat) => !room.seats[seat].connected);
  if (offline != null) return `等 ${room.seats[offline].name} 连回来`;
  return '可以开局啦';
}

/* --------------------------------------------------------------------------
   开局 / 轮次
   -------------------------------------------------------------------------- */

/**
 * 检查一局发牌是否合规：
 * 人数对应的副数、每人手牌数、明牌数、总牌数都对，且没有重复牌。
 * 发牌异常时返回 ok:false，调用方不应开始牌局。
 */
export function validateDeal(room) {
  const seats = occupiedSeats(room);
  const count = seats.length;
  const deckCount = DECK_COUNT_BY_PLAYERS[count];
  const perHand = HAND_SIZE_BY_PLAYERS[count];
  const revealedCount = REVEALED_BY_PLAYERS[count];
  if (!deckCount || !perHand) {
    return { ok: false, message: '人数不对，无法配牌' };
  }
  const info = room.deckInfo;
  if (
    !info ||
    info.deckCount !== deckCount ||
    info.handSize !== perHand ||
    info.revealedCount !== revealedCount ||
    info.totalCards !== deckCount * 54
  ) {
    return { ok: false, message: '牌副数和人数不匹配' };
  }

  const seen = new Set();
  const addCard = (id) => {
    const card = parseCard(id);
    if (!card) return `有一张牌认不出来：${id}`;
    if (card.deck >= deckCount) return `牌号超出副数：${id}`;
    if (seen.has(id)) return `同一张牌出现了两次：${id}`;
    seen.add(id);
    return null;
  };

  for (const seat of seats) {
    const hand = room.hands[seat];
    if (!Array.isArray(hand) || hand.length !== perHand) {
      return { ok: false, message: `座位 ${seat} 的手牌数量不对` };
    }
    for (const id of hand) {
      const error = addCard(id);
      if (error) return { ok: false, message: error };
    }
  }

  if (!Array.isArray(room.revealed) || room.revealed.length !== revealedCount) {
    return { ok: false, message: '明牌数量不对' };
  }
  for (const id of room.revealed) {
    const error = addCard(id);
    if (error) return { ok: false, message: error };
  }

  if (seen.size !== deckCount * 54) {
    return { ok: false, message: '牌没有发完，或者多出了牌' };
  }
  return { ok: true, message: '配牌正常', totalCards: seen.size };
}

export function startGame(room, rng = Math.random) {
  if (room.phase !== 'lobby' && room.phase !== 'gameOver') {
    return { ok: false, error: 'NOT_READY', message: '现在还不能重新开局' };
  }
  const seats = occupiedSeats(room);
  if (seats.length < MIN_PLAYERS || seats.length > MAX_PLAYERS) {
    return {
      ok: false,
      error: 'PLAYER_COUNT',
      message: `需要 ${MIN_PLAYERS}～${MAX_PLAYERS} 位牌友`
    };
  }
  const offline = seats.find((seat) => !room.seats[seat].connected);
  if (offline != null) {
    return {
      ok: false,
      error: 'PLAYER_OFFLINE',
      message: `${room.seats[offline].name} 还没连回来`
    };
  }

  const count = seats.length;
  const deckCount = DECK_COUNT_BY_PLAYERS[count];
  const perHand = HAND_SIZE_BY_PLAYERS[count];
  const deck = shuffle(makeDeck(deckCount), rng);
  const hands = {};
  for (const seat of seats) hands[seat] = [];

  for (let i = 0; i < perHand; i += 1) {
    for (const seat of seats) {
      hands[seat].push(deck.pop());
    }
  }
  const revealed = sortHand(deck.splice(0));
  for (const seat of seats) hands[seat] = sortHand(hands[seat]);

  room.hands = hands;
  room.revealed = revealed;
  room.deckInfo = {
    deckCount,
    handSize: perHand,
    revealedCount: revealed.length,
    totalCards: deckCount * 54
  };
  room.publicCards = [];
  room.publicPlays = [];
  const dealCheck = validateDeal(room);
  if (!dealCheck.ok) {
    return fail('BAD_DEAL', dealCheck.message);
  }
  room.actions = {};
  room.turnOrder = [];
  room.turnIndex = 0;
  room.turn = null;
  room.leader = null;
  room.nextLeader = null;
  room.winner = null;
  room.winnerCandidates = [];
  room.finished = [];
  room.ranking = [];
  room.round = 0;
  room.phase = 'lobby';
  room.gameNo += 1;
  room.lastGameScores = {};
  for (const seat of seats) {
    if (room.scores[seat] == null) room.scores[seat] = 0;
  }

  const leader = seats[Math.floor(rng() * seats.length)];
  const result = beginRound(room, leader);
  room.lastEvent = {
    kind: 'start',
    seat: leader,
    text: `新一局开始，${room.seats[leader].name} 先出`
  };
  room.seq += 1;
  return { ok: true, leader, ...result };
}

export function activeSeats(room) {
  return occupiedSeats(room).filter((seat) => (room.hands[seat]?.length || 0) > 0);
}

export function beginRound(room, leader) {
  if (!room.seats[leader]) {
    return { ok: false, error: 'BAD_LEADER', message: '先手座位不存在' };
  }
  const active = activeSeats(room);
  if (active.length < 2) {
    return { ok: false, error: 'GAME_OVER', message: '血战已经结束，没有下一轮了' };
  }
  const start = active.indexOf(leader);
  if (start < 0) {
    return { ok: false, error: 'BAD_LEADER', message: '先手已经出完，不能继续先出' };
  }
  const turnOrder = [...active.slice(start), ...active.slice(0, start)];

  room.round += 1;
  room.phase = 'playing';
  room.leader = leader;
  room.turnOrder = turnOrder;
  room.turnIndex = 0;
  room.turn = leader;
  room.actions = {};
  room.nextLeader = null;
  room.winner = null;
  room.winnerCandidates = [];
  room.lastEvent = {
    kind: 'roundStart',
    seat: leader,
    text: `第 ${room.round} 轮，${room.seats[leader].name} 先出`
  };
  room.seq += 1;
  return { ok: true, leader, round: room.round };
}

function fail(error, message) {
  return { ok: false, error, message };
}

function expectedClaimTargets(room, seat) {
  const index = room.turnOrder.indexOf(seat);
  if (index < 0) return [];
  return room.turnOrder
    .slice(0, index)
    .filter((targetSeat) => room.actions[targetSeat]?.played);
}

function normalizeClaims(room, seat, claims) {
  const expected = expectedClaimTargets(room, seat);
  if (!expected.length) {
    if (claims == null) return { ok: true, claims: [] };
    if (!Array.isArray(claims) || claims.length !== 0) {
      return fail('BAD_CLAIMS', '先手不用猜大小');
    }
    return { ok: true, claims: [] };
  }
  if (!Array.isArray(claims) || claims.length !== expected.length) {
    return fail('BAD_CLAIMS', `这一手要猜 ${expected.length} 位牌友的大小`);
  }
  const map = new Map();
  for (const claim of claims) {
    if (!claim || !Number.isInteger(claim.target)) {
      return fail('BAD_CLAIMS', '猜测没有填完整');
    }
    if (!expected.includes(claim.target)) {
      return fail('BAD_CLAIMS', '只能猜前面已经出过牌的牌友');
    }
    if (claim.dir !== 'higher' && claim.dir !== 'lower') {
      return fail('BAD_CLAIMS', '只能猜“大”或“小”');
    }
    if (map.has(claim.target)) {
      return fail('BAD_CLAIMS', '同一位牌友只能猜一次');
    }
    map.set(claim.target, claim.dir);
  }
  return {
    ok: true,
    claims: expected.map((target) => ({ target, dir: map.get(target) }))
  };
}

export function passTurn(room, seat) {
  if (room.phase !== 'playing') return fail('NOT_PLAYING', '现在还没到出牌的时候');
  if (room.turn !== seat) return fail('NOT_YOUR_TURN', '还没轮到您');
  if (seat === room.leader) return fail('LEADER_MUST_PLAY', '先手必须出牌，不能过');
  if (room.actions[seat]?.acted) return fail('ALREADY_ACTED', '您这一轮已经做过了');

  room.actions[seat] = {
    seat,
    order: room.turnIndex,
    played: false,
    passed: true,
    acted: true,
    cards: [],
    combo: null,
    claims: [],
    claimResults: null,
    status: 'passed',
    reason: null
  };
  room.seq += 1;
  advanceTurn(room);
  return { ok: true, resolved: room.phase !== 'playing' };
}

export function playCards(room, seat, cards, claims = [], rng = Math.random) {
  if (room.phase !== 'playing') return fail('NOT_PLAYING', '现在还没到出牌的时候');
  if (room.turn !== seat) return fail('NOT_YOUR_TURN', '还没轮到您');
  if (room.actions[seat]?.acted) return fail('ALREADY_ACTED', '您这一轮已经出过牌了');
  if (!Array.isArray(cards) || cards.length === 0) {
    return fail('NO_CARDS', '先选几张要扣的牌');
  }
  if (new Set(cards).size !== cards.length) {
    return fail('DUPLICATE_CARD', '同一张牌不能选两次');
  }
  const hand = room.hands[seat];
  if (!hand) return fail('NO_HAND', '没有找到您的手牌');
  if (cards.some((id) => !hand.includes(id))) {
    return fail('CARD_NOT_IN_HAND', '这些牌不在您手里，请重新选');
  }

  const analysis = analyzeCombo(cards);
  if (!analysis.valid) return fail('BAD_COMBO', analysis.reason);
  const combo = analysis.combo;
  const isLeader = seat === room.leader;

  if (!isLeader) {
    const leaderAction = room.actions[room.leader];
    if (!leaderAction?.played) return fail('NO_TARGET', '先手还没出牌');
    if (!sameComboShape(combo, leaderAction.combo)) {
      return fail(
        'TYPE_MISMATCH',
        `这一轮要跟“${leaderAction.combo.label}”，不能出“${combo.label}”`
      );
    }
  }

  const normalized = normalizeClaims(room, seat, claims);
  if (!normalized.ok) return normalized;

  const remove = new Set(cards);
  room.hands[seat] = sortHand(hand.filter((id) => !remove.has(id)));
  room.actions[seat] = {
    seat,
    order: room.turnIndex,
    played: true,
    passed: false,
    acted: true,
    cards: sortHand(cards),
    combo,
    claims: normalized.claims,
    claimResults: null,
    status: 'pending',
    reason: null
  };
  room.seq += 1;
  advanceTurn(room);
  return {
    ok: true,
    combo,
    resolved: room.phase !== 'playing',
    cardsLeft: room.hands[seat].length
  };
}

function advanceTurn(room) {
  room.turnIndex += 1;
  if (room.turnIndex >= room.turnOrder.length) {
    room.turn = null;
    resolveRound(room);
    return;
  }
  room.turn = room.turnOrder[room.turnIndex];
}

/**
 * 一局结束时按名次记分：第一名得 (人数-1) 分，依次递减，最后一名 0 分。
 * 积分累计到下一局；同一个 gameNo 只结算一次。
 */
function applyGameScores(room) {
  if (room.scoredGame === room.gameNo) return;
  const total = room.ranking.length;
  for (const entry of room.ranking) {
    const points = Math.max(0, total - entry.place);
    entry.points = points;
    room.scores[entry.seat] = (room.scores[entry.seat] || 0) + points;
    room.lastGameScores[entry.seat] = points;
  }
  room.scoredGame = room.gameNo;
  room.gamesPlayed += 1;
}

export function resolveRound(room) {
  if (room.phase !== 'playing') return { ok: false, error: 'NOT_PLAYING' };
  if (room.turnIndex < room.turnOrder.length) {
    return { ok: false, error: 'ROUND_NOT_FINISHED' };
  }
  const actions = room.turnOrder.map((seat) => room.actions[seat]).filter(Boolean);
  if (!actions.length) return { ok: false, error: 'NO_ACTIONS' };

  const leaderAction = room.actions[room.leader];
  if (!leaderAction?.played) {
    return { ok: false, error: 'LEADER_NOT_PLAYED' };
  }

  for (const action of actions) {
    if (!action.played) {
      action.status = 'passed';
      continue;
    }
    if (action.seat === room.leader) {
      action.status = 'success';
      action.claimResults = [];
      continue;
    }

    const claimResults = [];
    let failed = false;
    let reason = null;

    for (const claim of action.claims) {
      const target = room.actions[claim.target];
      if (!target?.played) {
        claimResults.push({
          ...claim,
          ok: true,
          auto: true,
          actual: null
        });
        continue;
      }

      if (target.status === 'failed') {
        claimResults.push({
          ...claim,
          ok: true,
          auto: true,
          actual: null
        });
        continue;
      }

      const currentKey = action.combo.key;
      const targetKey = target.combo.key;
      const actual =
        currentKey > targetKey ? 'higher' : currentKey < targetKey ? 'lower' : 'equal';
      const ok =
        actual !== 'equal' &&
        ((claim.dir === 'higher' && actual === 'higher') ||
          (claim.dir === 'lower' && actual === 'lower'));
      claimResults.push({
        ...claim,
        ok,
        auto: false,
        actual
      });
      if (!ok && !failed) {
        failed = true;
        reason =
          actual === 'equal'
            ? `和 ${room.seats[claim.target]?.name || '牌友'} 点数相同，不能猜平`
            : `和 ${room.seats[claim.target]?.name || '牌友'} 比，猜错了大小`;
      }
    }

    action.claimResults = claimResults;
    if (failed) {
      action.status = 'failed';
      action.reason = reason;
    } else {
      action.status = 'success';
      action.reason = null;
    }
  }

  for (const action of actions) {
    if (action.played && action.status === 'failed') {
      room.hands[action.seat] = sortHand([
        ...(room.hands[action.seat] || []),
        ...action.cards
      ]);
    }
  }

  if (actions.some((action) => action.played)) {
    const publicCards = new Set(room.publicCards || []);
    for (const action of actions) {
      if (!action.played) continue;
      for (const id of action.cards) publicCards.add(id);
      room.publicPlays.push({
        seat: action.seat,
        cards: [...action.cards],
        success: action.status === 'success',
        round: room.round
      });
    }
    room.publicCards = [...publicCards];
  }

  const emptied = actions
    .filter(
      (action) =>
        action.played &&
        action.status === 'success' &&
        (room.hands[action.seat]?.length || 0) === 0
    )
    .sort((a, b) => b.combo.key - a.combo.key || a.order - b.order);

  for (const action of emptied) {
    if (room.finished.some((entry) => entry.seat === action.seat)) continue;
    room.finished.push({
      seat: action.seat,
      place: room.finished.length + 1,
      round: room.round,
      playedOrder: action.order,
      key: action.combo.key,
      combo: action.combo
    });
  }

  const active = activeSeats(room);

  if (active.length <= 1) {
    room.phase = 'gameOver';
    room.turn = null;
    room.nextLeader = null;
    room.winner = room.finished[0]?.seat ?? active[0] ?? null;
    room.ranking = room.finished.map((entry) => ({ ...entry }));
    for (const seat of active) {
      if (room.ranking.some((entry) => entry.seat === seat)) continue;
      room.ranking.push({
        seat,
        place: room.ranking.length + 1,
        round: room.round,
        playedOrder: 999,
        key: null,
        combo: null,
        last: true
      });
    }
    if (active.length === 0 && room.ranking.length > 0) {
      room.ranking[room.ranking.length - 1].last = true;
    }
    applyGameScores(room);
    room.winnerCandidates = room.ranking.map((entry) => ({ ...entry }));
    room.lastEvent = {
      kind: 'gameOver',
      seat: room.winner,
      text: `${room.seats[room.winner]?.name || '牌友'} 最先出完，血战结束`
    };
  } else {
    const activeActions = actions
      .filter((action) => action.played && active.includes(action.seat))
      .sort((a, b) => b.combo.key - a.combo.key || a.order - b.order);
    room.nextLeader = activeActions[0]?.seat ?? nextActiveSeat(room, room.leader);
    room.phase = 'review';
    room.turn = null;
    const justFinished = emptied
      .map((action) => room.seats[action.seat]?.name || '牌友')
      .join('、');
    room.lastEvent = {
      kind: 'review',
      seat: room.nextLeader,
      text: justFinished
        ? `${justFinished} 出完了，血战继续；下一轮 ${room.seats[room.nextLeader]?.name || '牌友'} 先出`
        : `本轮结束，下一轮 ${room.seats[room.nextLeader]?.name || '牌友'} 先出`
    };
  }

  room.seq += 1;
  return {
    ok: true,
    phase: room.phase,
    winner: room.winner,
    nextLeader: room.nextLeader,
    finished: room.finished.map((entry) => ({ ...entry }))
  };
}

function nextActiveSeat(room, from) {
  const active = activeSeats(room);
  if (!active.length) return from;
  for (let step = 1; step <= MAX_PLAYERS; step += 1) {
    const seat = (from + step) % MAX_PLAYERS;
    if (active.includes(seat)) return seat;
  }
  return active[0];
}

export function continueRound(room) {
  if (room.phase !== 'review') {
    return fail('NOT_REVIEW', '现在还不能开始下一轮');
  }
  const leader = room.nextLeader;
  if (leader == null || !room.seats[leader]) {
    return fail('BAD_LEADER', '下一轮先手还没有确定');
  }
  if (!activeSeats(room).includes(leader)) {
    return fail('BAD_LEADER', '下一轮先手已经出完了');
  }
  room.nextLeader = null;
  const result = beginRound(room, leader);
  return { ...result, ok: true };
}

export function resetToLobby(room) {
  room.phase = 'lobby';
  room.round = 0;
  room.hands = {};
  room.revealed = [];
  room.actions = {};
  room.turnOrder = [];
  room.turnIndex = 0;
  room.turn = null;
  room.leader = null;
  room.nextLeader = null;
  room.winner = null;
  room.winnerCandidates = [];
  room.finished = [];
  room.ranking = [];
  room.deckInfo = null;
  room.publicCards = [];
  room.publicPlays = [];
  room.lastEvent = null;
  for (const player of room.seats.filter(Boolean)) {
    player.auto = false;
  }
  room.seq += 1;
  return { ok: true };
}

export function resetScores(room) {
  if (room.phase !== 'lobby') {
    return fail('NOT_LOBBY', '回到大厅后才能清空积分');
  }
  for (const seat of occupiedSeats(room)) room.scores[seat] = 0;
  room.gamesPlayed = 0;
  room.lastGameScores = {};
  room.scoredGame = room.gameNo;
  room.seq += 1;
  return { ok: true };
}

/* --------------------------------------------------------------------------
   快照
   -------------------------------------------------------------------------- */

function publicPlayer(room, seat) {
  const player = room.seats[seat];
  if (!player) return null;
  const action = room.actions[seat];
  const finishedEntry = room.finished.find((entry) => entry.seat === seat) || null;
  const reveal = room.phase === 'review' || room.phase === 'gameOver';
  let status = 'waiting';
  if (finishedEntry) {
    status = 'finished';
  } else if (action) {
    if (reveal && action.played) status = action.status;
    else if (reveal && action.passed) status = 'passed';
    else if (action.played) status = 'played';
    else if (action.passed) status = 'passed';
  }
  return {
    seat,
    name: player.name,
    avatar: player.avatar,
    isAI: Boolean(player.isAI),
    isHost: Boolean(player.isHost),
    connected: Boolean(player.connected),
    auto: Boolean(player.auto),
    cardCount: room.hands[seat]?.length || 0,
    score: room.scores[seat] || 0,
    isTurn: room.phase === 'playing' && room.turn === seat,
    isLeader: room.phase === 'playing' && room.leader === seat,
    acted: Boolean(action?.acted),
    finished: Boolean(finishedEntry),
    place: finishedEntry?.place ?? null,
    active: !finishedEntry,
    status,
    pendingCount: action?.played ? action.cards.length : 0
  };
}

function comboPublic(combo, reveal = false) {
  if (!combo) return null;
  const base = {
    type: combo.type,
    size: combo.size,
    label: combo.label
  };
  return reveal ? { ...base, key: combo.key } : base;
}

function publicAction(room, action, viewerSeat, reveal) {
  if (!action) return null;
  const cardsVisible = reveal || viewerSeat === action.seat;
  return {
    seat: action.seat,
    order: action.order,
    played: action.played,
    passed: action.passed,
    acted: action.acted,
    combo: comboPublic(action.combo, reveal),
    claims: action.claims.map((claim) => ({
      target: claim.target,
      dir: claim.dir,
      targetName: room.seats[claim.target]?.name || '牌友'
    })),
    claimResults: reveal
      ? (action.claimResults || []).map((result) => ({
          target: result.target,
          dir: result.dir,
          ok: result.ok,
          auto: result.auto,
          actual: result.actual,
          targetName: room.seats[result.target]?.name || '牌友'
        }))
      : null,
    status: reveal ? action.status : action.played ? 'pending' : 'passed',
    reason: reveal ? action.reason : null,
    cards: cardsVisible ? action.cards : null,
    cardCount: action.cards.length
  };
}

export function buildSnapshot(room, viewerSeat) {
  const viewer =
    Number.isInteger(viewerSeat) && viewerSeat >= 0 && viewerSeat < MAX_PLAYERS
      ? viewerSeat
      : null;
  const reveal = room.phase === 'review' || room.phase === 'gameOver';
  const leaderAction = room.leader != null ? room.actions[room.leader] : null;
  const target = leaderAction?.played ? comboPublic(leaderAction.combo, reveal) : null;
  const actionMap = {};
  for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
    const action = room.actions[seat];
    if (action) actionMap[seat] = publicAction(room, action, viewer, reveal);
  }

  const startResult = canStart(room);
  const winnerEntry = room.finished[0] || null;
  const activeCount = occupiedSeats(room).filter(
    (seat) => (room.hands[seat]?.length || 0) > 0
  ).length;
  return {
    seq: room.seq,
    code: room.code,
    mode: room.mode,
    phase: room.phase,
    round: room.round,
    hostSeat: 0,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    isHost: viewer === 0,
    canStart: room.phase === 'lobby' ? startResult.ok : false,
    startHint: room.phase === 'lobby' ? startResult.message : '',
    deckInfo: room.deckInfo,
    gamesPlayed: room.gamesPlayed,
    players: room.seats.map((_, seat) => publicPlayer(room, seat)),
    self: viewer == null
      ? null
      : {
          seat: viewer,
          hand: room.hands[viewer] ? sortHand(room.hands[viewer]) : [],
          isTurn: room.phase === 'playing' && room.turn === viewer,
          isLeader: room.phase === 'playing' && room.leader === viewer,
          finished: Boolean(room.finished.find((entry) => entry.seat === viewer)),
          place:
            room.finished.find((entry) => entry.seat === viewer)?.place ?? null,
          score: room.scores[viewer] || 0,
          pending: room.actions[viewer] ? actionMap[viewer] || null : null
        },
    leader: room.leader,
    turn: room.turn,
    turnOrder: [...room.turnOrder],
    turnIndex: room.turnIndex,
    target,
    actions: actionMap,
    revealed: [...room.revealed],
    winner:
      room.winner == null
        ? null
        : {
            seat: room.winner,
            name: room.seats[room.winner]?.name || '牌友',
            avatar: room.seats[room.winner]?.avatar || '🐼',
            isSelf: room.winner === viewer,
            place: winnerEntry?.place ?? 1,
            combo: winnerEntry?.combo
              ? comboPublic(winnerEntry.combo, true)
              : null
          },
    finished: room.finished.map((entry) => ({
      seat: entry.seat,
      name: room.seats[entry.seat]?.name || '牌友',
      avatar: room.seats[entry.seat]?.avatar || '🐼',
      place: entry.place,
      round: entry.round,
      key: entry.key,
      combo: comboPublic(entry.combo, true)
    })),
    ranking: room.ranking.map((entry) => ({
      seat: entry.seat,
      name: room.seats[entry.seat]?.name || '牌友',
      avatar: room.seats[entry.seat]?.avatar || '🐼',
      place: entry.place,
      round: entry.round,
      key: entry.key,
      last: Boolean(entry.last),
      points: entry.points ?? 0,
      combo: entry.combo ? comboPublic(entry.combo, true) : null
    })),
    activeCount,
    winnerCandidates: reveal
      ? (room.winnerCandidates || []).map((candidate) => ({
          seat: candidate.seat,
          place: candidate.place,
          name: room.seats[candidate.seat]?.name || '牌友',
          avatar: room.seats[candidate.seat]?.avatar || '🐼',
          key: candidate.key,
          order: candidate.playedOrder,
          last: Boolean(candidate.last),
          combo: candidate.combo ? comboPublic(candidate.combo, true) : null
        }))
      : [],
    nextLeader: room.nextLeader,
    lastEvent: room.lastEvent
  };
}
