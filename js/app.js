import {
  CHAT_PHRASES,
  DECK_COUNT_BY_PLAYERS,
  MAX_PLAYERS,
  addAI,
  addPlayer,
  analyzeCombo,
  buildSnapshot,
  cleanName,
  continueRound,
  createRoom,
  findPlayableCombo,
  parseCard,
  passTurn,
  playCards,
  prepareJoin,
  randomToken,
  removeSeat,
  resetScores,
  resetToLobby,
  sameComboShape,
  sortHand,
  startGame,
  takeOverSeat,
  updateConnection
} from './game.js';
import { chooseAIAction } from './ai.js';
import {
  PeerGuest,
  PeerHost,
  PROTOCOL_VERSION,
  friendlyPeerError,
  makeRoomCode
} from './net.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const POSITION_MAP = {
  1: ['top'],
  2: ['left', 'right'],
  3: ['left', 'top', 'right'],
  4: ['left-low', 'left-high', 'right-high', 'right-low'],
  5: ['left-low', 'left-high', 'top', 'right-high', 'right-low']
};

const STORAGE = {
  name: 'darksy-name',
  settings: 'darksy-settings',
  token: (code) => `darksy-token-${code}`
};

const DEFAULT_SETTINGS = {
  font: 'large',
  sound: true,
  voice: true
};

const app = {
  mode: null, // host | guest
  room: null,
  snapshot: null,
  seat: null,
  code: null,
  name: '',
  token: null,
  selected: new Set(),
  claims: new Map(),
  pendingCards: null,
  modalType: null,
  modalCloseable: true,
  reviewOpenRound: 0,
  resultKey: null,
  lastTurnKey: '',
  lastClaimKey: '',
  chatBubbles: new Map(),
  peerHost: null,
  peerGuest: null,
  hostStatus: 'idle',
  guestStatus: 'idle',
  joinToken: null,
  joinRequests: [],
  activeJoinRequest: null,
  actionPending: false,
  handSheetOpen: false,
  aiTimer: null,
  aiTurnKey: ''
};

let settings = { ...DEFAULT_SETTINGS };
let audioContext = null;
let toastSeq = 0;

/* --------------------------------------------------------------------------
   基础工具
   -------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCode(code) {
  const text = String(code || '');
  return text.length === 6 ? `${text.slice(0, 3)} ${text.slice(3)}` : text;
}

function getName() {
  const input = $('#input-name');
  const name = cleanName(input?.value || app.name || '牌友', '牌友');
  if (input) input.value = name;
  app.name = name;
  try {
    localStorage.setItem(STORAGE.name, name);
  } catch {
    /* ignore */
  }
  return name;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE.settings);
    if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  applySettings();
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE.settings, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

function applySettings() {
  document.documentElement.dataset.font = settings.font;
  const soundBtn = $('#btn-sound');
  if (soundBtn) {
    soundBtn.setAttribute('aria-pressed', String(settings.sound));
    $('#sound-icon').textContent = settings.sound ? '🔔' : '🔕';
    $('#sound-label').textContent = settings.sound ? '声音开' : '声音关';
  }
}

function setConnection(state, text) {
  const pill = $('#connection-pill');
  const label = $('#connection-text');
  if (!pill || !label) return;
  if (!state) {
    pill.classList.add('hidden');
    return;
  }
  pill.classList.remove('hidden', 'is-reconnecting', 'is-offline');
  if (state === 'reconnecting') pill.classList.add('is-reconnecting');
  if (state === 'offline') pill.classList.add('is-offline');
  label.textContent = text;
}

function updateConnectionPill() {
  if (!app.mode) {
    setConnection(null);
    return;
  }
  if (app.mode === 'host') {
    if (app.hostStatus === 'reconnecting') {
      setConnection('reconnecting', '牵线重连中');
      return;
    }
    if (app.hostStatus === 'offline') {
      setConnection('offline', '网络已断开');
      return;
    }
    const count = app.room ? app.room.seats.filter((player) => player?.connected).length : 0;
    if (count <= 1) setConnection('online', '等待牌友');
    else setConnection('online', `在线 · ${count} 人`);
    return;
  }
  if (app.guestStatus === 'offline') setConnection('offline', '连接已断开');
  else if (app.guestStatus === 'reconnecting') setConnection('reconnecting', '正在重连');
  else setConnection('online', '已连接房主');
}

function clearToasts() {
  const stack = $('#toast-stack');
  if (stack) stack.innerHTML = '';
}

function toast(message, { warm = false, claim = false, duration = 3200 } = {}) {
  const stack = $('#toast-stack');
  if (!stack || !message) return;
  const id = ++toastSeq;
  const el = document.createElement('div');
  el.className = `toast${warm ? ' is-warm' : ''}${claim ? ' is-claim' : ''}`;
  el.dataset.toastId = String(id);
  el.textContent = message;
  stack.appendChild(el);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-5px)';
    el.style.transition = 'opacity 180ms ease, transform 180ms ease';
    setTimeout(() => el.remove(), 200);
  }, duration);
}

function primeAudio() {
  if (audioContext) return;
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    audioContext = null;
  }
}

function tone(kind = 'tap') {
  if (!settings.sound) return;
  primeAudio();
  if (!audioContext) return;
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  const now = audioContext.currentTime;
  const configs = {
    tap: { freq: 520, end: 480, dur: 0.05, gain: 0.035, type: 'sine' },
    card: { freq: 390, end: 520, dur: 0.09, gain: 0.045, type: 'triangle' },
    draw: { freq: 300, end: 360, dur: 0.08, gain: 0.035, type: 'sine' },
    pass: { freq: 330, end: 280, dur: 0.12, gain: 0.03, type: 'sine' },
    win: { freq: 523, end: 784, dur: 0.42, gain: 0.06, type: 'triangle' },
    error: { freq: 210, end: 170, dur: 0.16, gain: 0.04, type: 'sawtooth' }
  };
  const cfg = configs[kind] || configs.tap;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.type = cfg.type;
  osc.frequency.setValueAtTime(cfg.freq, now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(80, cfg.end), now + cfg.dur);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(cfg.gain, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + cfg.dur);
  osc.connect(gain);
  gain.connect(audioContext.destination);
  osc.start(now);
  osc.stop(now + cfg.dur + 0.02);
}

function speak(text) {
  if (!settings.voice || !('speechSynthesis' in window) || !text) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 0.9;
    utterance.pitch = 1;
    utterance.volume = 0.9;
    window.speechSynthesis.speak(utterance);
  } catch {
    /* ignore */
  }
}

function announceClaims(snapshot, previous) {
  if (!snapshot || snapshot.phase !== 'playing') return;
  const claimed = Object.values(snapshot.actions || {})
    .filter((action) => action?.claims?.length)
    .sort((a, b) => a.order - b.order);
  const latest = claimed[claimed.length - 1];
  if (!latest) return;
  const key = `${snapshot.round}:${latest.seat}:${latest.claims
    .map((claim) => `${claim.target}${claim.dir}`)
    .join('|')}`;
  if (app.lastClaimKey === key) return;
  app.lastClaimKey = key;
  if (!previous) return;
  const player = snapshot.players?.[latest.seat];
  if (!player) return;
  toast(`${player.name} 公开报：${claimsText(latest.claims)}`, {
    claim: true,
    duration: 4600
  });
}

function announceSnapshot(snapshot) {
  if (!snapshot) return;
  if (snapshot.phase === 'playing' && snapshot.self?.isTurn) {
    const key = `${snapshot.round}:${snapshot.turn}`;
    if (app.lastTurnKey !== key) {
      app.lastTurnKey = key;
      let text = '轮到你扣牌。';
      if (snapshot.target?.label) text += `这一轮要跟${snapshot.target.label}。`;
      else text += '你是先手，可以出任意牌型。';
      speak(text);
    }
  } else if (snapshot.phase === 'review') {
    app.lastTurnKey = '';
  } else if (snapshot.phase === 'gameOver') {
    const key = `over:${snapshot.round}:${snapshot.winner?.seat}`;
    if (app.lastTurnKey !== key) {
      app.lastTurnKey = key;
      if (snapshot.winner?.isSelf) speak('恭喜，您先出完，成为上游。');
      else speak(`${snapshot.winner?.name || '牌友'}先出完，成为上游。`);
    }
  }
}

/* --------------------------------------------------------------------------
   弹层
   -------------------------------------------------------------------------- */

const MODAL_TYPE_CLASS = {
  result: 'modal-result',
  review: 'review-modal',
  claim: 'claim-modal',
  hand: 'hand-sheet-modal'
};

function openModal(html, { type = 'generic', closeable = true } = {}) {
  const root = $('#modal-root');
  if (!root) return;
  app.modalType = type;
  app.modalCloseable = closeable;
  const typeClass = MODAL_TYPE_CLASS[type] || '';
  root.innerHTML = `
    <div class="modal-backdrop" data-action="modal-backdrop">
      <div class="modal ${typeClass}" role="dialog" aria-modal="true">
        ${closeable ? '<button class="modal-close" type="button" data-action="close-modal" aria-label="关闭">×</button>' : ''}
        ${html}
      </div>
    </div>
  `;
}

function closeModal({ force = false } = {}) {
  if (!app.modalType) return;
  if (!force && !app.modalCloseable) return;
  app.modalType = null;
  app.modalCloseable = true;
  app.handSheetOpen = false;
  const root = $('#modal-root');
  if (root) root.innerHTML = '';
}

function showLoading(title, detail = '请稍等一下，马上就好。') {
  openModal(
    `<div class="loading-box">
      <div class="spinner" aria-hidden="true"></div>
      <p><strong>${escapeHtml(title)}</strong>${escapeHtml(detail)}</p>
    </div>`,
    { type: 'loading', closeable: false }
  );
}

function showError(title, message, retry = null) {
  openModal(
    `<p class="modal-eyebrow">出了点小问题</p>
     <h2>${escapeHtml(title)}</h2>
     <p class="modal-lead">${escapeHtml(message)}</p>
     <div class="modal-actions">
       ${retry ? '<button class="btn btn-primary" type="button" data-action="retry">再试一次</button>' : ''}
       <button class="btn btn-cream" type="button" data-action="go-home">回到首页</button>
     </div>`,
    { type: 'error', closeable: true }
  );
  app.retryAction = retry || null;
}

function openConfirm({ title, body, confirmText = '确定', onConfirm }) {
  openModal(
    `<p class="modal-eyebrow">确认一下</p>
     <h2>${escapeHtml(title)}</h2>
     <p class="modal-lead">${escapeHtml(body)}</p>
     <div class="modal-actions">
       <button class="btn btn-cream" type="button" data-action="close-modal">再想想</button>
       <button class="btn btn-primary" type="button" data-action="confirm-modal">${escapeHtml(confirmText)}</button>
     </div>`,
    { type: 'confirm', closeable: true }
  );
  app.confirmAction = onConfirm || null;
}

function openRules() {
  openModal(
    `<p class="modal-eyebrow">暗上游 · 规则</p>
     <h2>扣牌、报型、猜大小</h2>
     <p class="modal-lead">
       三人起局，先出完手牌的人获胜。每轮每人只有一次机会，扣下的牌只报牌型，不报点数。
     </p>
     <ol class="rules-list">
       <li><b>1</b><span><strong>人数与牌：</strong>3人1副，每人18张；4人2副，每人27张；5人2副，每人21张，余下3张开局亮明；6人3副，每人27张。</span></li>
       <li><b>2</b><span><strong>牌型：</strong>单张、对子、三张、三带二、顺子、三连对、钢板，以及四张及以上同点数牌。跟牌必须同牌型、同张数，不能跨牌型压制。</span></li>
       <li><b>3</b><span><strong>一轮：</strong>先手扣任意牌型；后面的人可以跟同牌型，也可以随时选择“过”。跟牌时要分别猜自己比前面每位出过牌的人大还是小。</span></li>
       <li><b>4</b><span><strong>揭晓：</strong>所有人轮完后一起亮牌。先手默认通过；猜错的人只收回自己这一手牌；前面某人已判错时，后面与他的比较默认通过。</span></li>
       <li><b>5</b><span><strong>下一轮：</strong>本轮实际出牌最大、且还没出完的人先出，不论他有没有猜对；点数相同，先出者先。最大的人已经出完时，顺延给仍在血战的人。</span></li>
       <li><b>6</b><span><strong>血战到底：</strong>有人出完后牌局不结束，剩余玩家继续打，直到只剩最后一位。最先出完的是上游，最后留下的是下游；同一轮多人出完，按点数排先后，点数相同先出者在前。</span></li>
       <li><b>7</b><span><strong>公开报大小：</strong>每个人报完大小，所有牌友立刻就能看到报的内容；“过”随时可以选，但先手必须出第一手牌。猜错只收回自己的牌。</span></li>
     </ol>
     <div class="rules-note">
       <strong>牌型大小：</strong>大王 &gt; 小王 &gt; 2 &gt; A &gt; K &gt; Q &gt; J &gt; 10 … &gt; 3。
       顺子为五张连续单牌，A 可作头尾，2 可参与；三连对、钢板同理。王不参与连续牌型，但多副牌时同种王可组对子、三张或多张。
     </div>
     <div class="rules-grid">
       <div><b>单张</b> 1 张</div>
       <div><b>对子</b> 2 张同点</div>
       <div><b>三张</b> 3 张同点</div>
       <div><b>三带二</b> 三张 + 一对</div>
       <div><b>顺子</b> 5 张连续单牌</div>
       <div><b>三连对</b> 3 对连续</div>
       <div><b>钢板</b> 2 组连续三张</div>
       <div><b>多张</b> 4 张及以上同点</div>
     </div>
     <div class="modal-actions">
       <button class="btn btn-primary" type="button" data-action="close-modal">看明白了</button>
     </div>`,
    { type: 'rules', closeable: true }
  );
}

function openSettings() {
  const fontOptions = [
    ['normal', '标准'],
    ['large', '大'],
    ['xlarge', '特大']
  ]
    .map(
      ([value, label]) =>
        `<button class="font-option${settings.font === value ? ' active' : ''}" type="button" data-font-option="${value}">${label}</button>`
    )
    .join('');

  openModal(
    `<p class="modal-eyebrow">牌桌设置</p>
     <h2>看得清，用着顺手</h2>
     <div class="settings-group">
       <div class="settings-label"><span>文字大小</span><span class="settings-hint">字和按钮一起变大</span></div>
       <div class="font-options">${fontOptions}</div>
     </div>
     <div class="settings-group">
       <div class="toggle-row">
         <div class="toggle-copy"><strong>提示音</strong><span>扣牌、过牌和获胜时轻轻响一下</span></div>
         <button class="switch" type="button" data-toggle="sound" aria-checked="${settings.sound}" aria-label="提示音"></button>
       </div>
       <div class="toggle-row">
         <div class="toggle-copy"><strong>语音提醒</strong><span>只在轮到您和牌局结束时说话</span></div>
         <button class="switch" type="button" data-toggle="voice" aria-checked="${settings.voice}" aria-label="语音提醒"></button>
       </div>
     </div>
     <div class="modal-actions">
       <button class="btn btn-cream" type="button" data-action="open-rules">完整规则</button>
       <button class="btn btn-primary" type="button" data-action="close-modal">好了</button>
     </div>`,
    { type: 'settings', closeable: true }
  );
}

function openChatPicker() {
  openModal(
    `<p class="modal-eyebrow">和牌友说一句</p>
     <h2>打个招呼</h2>
     <p class="modal-lead">点一句就行，不用打字。</p>
     <div class="chat-grid">
       ${CHAT_PHRASES.map(
         (text) =>
           `<button class="chat-choice" type="button" data-chat-phrase="${escapeHtml(text)}">${escapeHtml(text)}</button>`
       ).join('')}
     </div>`,
    { type: 'chat', closeable: true }
  );
}

/* --------------------------------------------------------------------------
   页面切换
   -------------------------------------------------------------------------- */

function showScreen(name) {
  for (const screen of ['home', 'lobby', 'game']) {
    $(`#screen-${screen}`)?.classList.toggle('hidden', screen !== name);
  }
  document.body.dataset.screen = name;
}

function goHome() {
  clearAITimer();
  cancelJoinRequests();
  closePeers();
  app.mode = null;
  app.room = null;
  app.snapshot = null;
  app.seat = null;
  app.code = null;
  app.token = null;
  app.selected.clear();
  app.claims.clear();
  app.pendingCards = null;
  app.actionPending = false;
  app.handSheetOpen = false;
  app.lastTurnKey = '';
  app.reviewOpenRound = 0;
  app.resultKey = null;
  closeModal({ force: true });
  setConnection(null);
  clearConfetti();
  showScreen('home');
  updateHome();
}

function updateHome() {
  const url = new URLSearchParams(window.location.search);
  const room = (url.get('room') || '').replace(/\D/g, '').slice(0, 6);
  if (room.length === 6 && !app.mode) {
    $('#join-form')?.classList.remove('hidden');
    const input = $('#input-room');
    if (input && !input.value) input.value = room;
  }
}

function closePeers() {
  try {
    app.peerHost?.close();
  } catch {
    /* ignore */
  }
  try {
    app.peerGuest?.close();
  } catch {
    /* ignore */
  }
  app.peerHost = null;
  app.peerGuest = null;
  app.hostStatus = 'idle';
  app.guestStatus = 'idle';
}

/* --------------------------------------------------------------------------
   渲染：首页 / 大厅
   -------------------------------------------------------------------------- */

function playerAt(seat) {
  return app.snapshot?.players?.[seat] || null;
}

function selfSeat() {
  return app.snapshot?.self?.seat ?? app.seat ?? 0;
}

function selfPlayer() {
  return playerAt(selfSeat());
}

function renderLobby() {
  const snapshot = app.snapshot;
  if (!snapshot) return;
  showScreen('lobby');
  const players = snapshot.players || [];
  const count = players.filter(Boolean).length;
  $('#room-code').textContent = formatCode(snapshot.code || app.code);
  $('#lobby-seat-count').textContent = `${count} / ${MAX_PLAYERS} 位`;
  $('#lobby-title').textContent = count >= 3 ? '牌桌热起来啦' : '牌桌开好啦';
  $('#lobby-sub').textContent =
    count >= 3
      ? '人齐就可以开局。人少时也能先聊两句。'
      : '把房间号念给亲友，至少三位牌友才能开局。';

  const seatHtml = [];
  for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
    const player = players[seat];
    if (!player) {
      seatHtml.push(
        `<div class="lobby-seat is-empty">
          <div class="ls-avatar" aria-hidden="true">＋</div>
          <div class="ls-empty-copy"><strong>空位</strong>等亲友入座</div>
        </div>`
      );
      continue;
    }
    const isYou = seat === selfSeat();
    const canRemove =
      snapshot.isHost && seat !== 0 && (player.isAI || !player.connected);
    seatHtml.push(
      `<div class="lobby-seat${isYou ? ' is-you' : ''}${player.connected ? '' : ' is-offline'}">
        ${canRemove ? `<button class="ls-remove" type="button" data-action="remove-seat" data-seat="${seat}" aria-label="移走 ${escapeHtml(player.name)}">×</button>` : ''}
        <div class="ls-avatar" aria-hidden="true">${escapeHtml(player.avatar)}</div>
        <div class="ls-name">${escapeHtml(player.name)}</div>
        <div class="ls-tags">
          ${player.isHost ? '<span class="tag gold">房主</span>' : ''}
          ${player.isAI ? '<span class="tag blue">电脑</span>' : ''}
          ${isYou ? '<span class="tag green">您</span>' : ''}
          ${player.connected ? '' : '<span class="tag red">掉线</span>'}
        </div>
      </div>`
    );
  }
  $('#lobby-seats').innerHTML = seatHtml.join('');

  const isHost = snapshot.isHost;
  $('#lobby-host-tools').classList.toggle('hidden', !isHost);
  $('#lobby-guest-wait').classList.toggle('hidden', isHost);
  if (isHost) {
    const start = $('#btn-start');
    start.disabled = !snapshot.canStart;
    $('#lobby-start-hint').textContent = snapshot.startHint;
    const addAi = $('#btn-add-ai');
    if (addAi) addAi.disabled = count >= MAX_PLAYERS;
  }

  $('#lobby-connection').innerHTML = `<span class="connection-dot"></span><span>${
    isHost
      ? `房主牌桌 · 在线 ${count} 人`
      : '已连上房主，等大家入座'
  }</span>`;
  renderLobbyScores();
}

function renderLobbyScores() {
  const container = $('#lobby-scores');
  const snapshot = app.snapshot;
  if (!container || !snapshot) return;
  if (!snapshot.gamesPlayed) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  const rows = (snapshot.players || [])
    .map((player, seat) => (player ? { ...player, seat } : null))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.seat - b.seat);
  container.classList.remove('hidden');
  container.innerHTML = `
    <div class="lobby-scores-head">
      <strong>累计积分</strong>
      <span>已打 ${snapshot.gamesPlayed} 局</span>
      ${
        snapshot.isHost
          ? '<button class="lobby-scores-reset" type="button" data-action="reset-scores">清零</button>'
          : ''
      }
    </div>
    <div class="lobby-scores-list">
      ${rows
        .map(
          (player, index) => `<div class="lobby-score-row">
            <span class="lobby-score-rank">${index + 1}</span>
            <span class="lobby-score-avatar" aria-hidden="true">${escapeHtml(player.avatar)}</span>
            <span class="lobby-score-name">${escapeHtml(player.name)}${
              player.isAI ? '<i>电脑</i>' : ''
            }</span>
            <span class="lobby-score-value">${player.score} 分</span>
          </div>`
        )
        .join('')}
    </div>`;
}

/* --------------------------------------------------------------------------
   渲染：牌桌
   -------------------------------------------------------------------------- */

function cardHtml(id, { interactive = false, extraClass = '' } = {}) {
  const card = parseCard(id);
  if (!card) return '';
  const selected = app.selected.has(id);
  const classes = ['pcard'];
  if (card.color === 'red') classes.push('red');
  if (card.joker) classes.push('is-joker');
  if (selected) classes.push('is-selected');
  if (extraClass) classes.push(extraClass);
  const corner = card.joker
    ? `<span class="pcard-corner"><b>${card.big ? '大' : '小'}</b><i>王</i></span>`
    : `<span class="pcard-corner"><b>${escapeHtml(card.short)}</b><i>${card.symbol}</i></span>`;
  const center = card.joker ? (card.big ? '大王' : '小王') : card.symbol;
  const note = card.joker ? '' : `<span class="pcard-note">${escapeHtml(card.label)}</span>`;
  const tag = selected ? '<span class="pcard-tag">已选</span>' : '';
  const content = `
    ${corner}
    <span class="pcard-center">${center}</span>
    ${card.joker ? '' : `<span class="pcard-corner bottom"><b>${escapeHtml(card.short)}</b><i>${card.symbol}</i></span>`}
    ${note}
    ${tag}`;
  if (!interactive) {
    return `<div class="${classes.join(' ')}" aria-label="${escapeHtml(card.label)}">${content}</div>`;
  }
  return `<button class="${classes.join(' ')}" type="button" data-card-id="${escapeHtml(
    id
  )}" aria-pressed="${selected}" aria-label="${escapeHtml(card.label)}${selected ? '，已选' : ''}">${content}</button>`;
}

function miniCardHtml(id) {
  const card = parseCard(id);
  if (!card) return '';
  if (card.joker) {
    return `<span class="mini-pcard is-joker ${card.color === 'red' ? 'red' : ''}" title="${escapeHtml(card.label)}">${card.big ? '大王' : '小王'}</span>`;
  }
  return `<span class="mini-pcard ${card.color === 'red' ? 'red' : ''}" title="${escapeHtml(card.label)}"><b>${escapeHtml(card.short)}</b><span>${card.symbol}</span></span>`;
}

function actionFor(seat) {
  return app.snapshot?.actions?.[seat] || null;
}

function seatStatusText(player, snapshot) {
  if (!player) return '';
  if (player.finished) {
    return player.place === 1 ? '上游 · 已出完' : `第 ${player.place} 名 · 已出完`;
  }
  if (!player.connected) return '掉线';
  if (snapshot.phase === 'playing' && player.isTurn) return '正在扣牌';
  if (player.status === 'played') return `已扣 ${player.pendingCount} 张`;
  if (player.status === 'passed') return '已过';
  if (player.status === 'success') return '出牌成功';
  if (player.status === 'failed') return '猜错收回';
  if (snapshot.phase === 'review') return '等下一轮';
  return '等一等';
}

function seatStatusClass(player, snapshot) {
  if (!player) return '';
  if (player.finished) return 'is-finished';
  if (!player.connected) return '';
  if (snapshot.phase === 'playing' && player.isTurn) return 'is-turn';
  if (player.status === 'played') return 'is-played';
  if (player.status === 'passed') return 'is-passed';
  if (player.status === 'failed') return 'is-failed';
  if (player.status === 'success') return 'is-success';
  return '';
}

function claimsText(claims) {
  return (claims || [])
    .map((claim) => `比${claim.targetName}${claim.dir === 'higher' ? '大' : '小'}`)
    .join('、');
}

function seatClaimsHtml(action) {
  const claims = action?.claims || [];
  if (!claims.length) return '';
  const chips = claims.map(
    (claim) =>
      `<span class="mini-claim ${claim.dir}">${claim.dir === 'higher' ? '↑' : '↓'}${escapeHtml(
        (claim.targetName || '?').slice(0, 2)
      )}</span>`
  );
  // 一行放两个，第三位开始换到下一行；人多的时候也看得全。
  if (chips.length > 2) {
    chips.splice(2, 0, '<span class="seat-report-break" aria-hidden="true"></span>');
  }
  return `<span class="seat-report" title="${escapeHtml(claimsText(claims))}"><span class="seat-report-label">报</span>${chips.join(
    ''
  )}</span>`;
}

function opponentOrder() {
  const snapshot = app.snapshot;
  if (!snapshot) return [];
  const self = selfSeat();
  return (snapshot.players || [])
    .map((player, seat) => ({ player, seat }))
    .filter(({ player, seat }) => player && seat !== self)
    .sort((a, b) => ((a.seat - self + MAX_PLAYERS) % MAX_PLAYERS) - ((b.seat - self + MAX_PLAYERS) % MAX_PLAYERS));
}

function bubbleFor(seat) {
  const bubble = app.chatBubbles.get(seat);
  if (!bubble) return '';
  return `<span class="seat-bubble">${escapeHtml(bubble.text)}</span>`;
}

function seatHtml(player, seat, snapshot) {
  const isTurn = snapshot.phase === 'playing' && snapshot.turn === seat;
  const statusClass = seatStatusClass(player, snapshot);
  const action = actionFor(seat);
  return `<div class="seat${isTurn ? ' is-turn' : ''}${player.isLeader ? ' is-leader' : ''}${
    player.connected ? '' : ' is-offline'
  }${player.finished ? ' is-finished' : ''}" data-seat="${seat}">
    ${player.isLeader ? '<span class="crown">先手</span>' : ''}
    ${
      player.finished
        ? `<span class="place-badge${player.place === 1 ? ' first' : ''}">${
            player.place === 1 ? '上游' : `第${player.place}名`
          }</span>`
        : ''
    }
    <div class="seat-avatar-wrap">
      <span class="seat-avatar" aria-hidden="true">${escapeHtml(player.avatar)}</span>
      <span class="seat-turn-ring" aria-hidden="true"></span>
    </div>
    <div class="seat-copy">
      <span class="seat-name">${escapeHtml(player.name)}</span>
      <span class="seat-sub"><b>${player.cardCount}</b> 张牌${
        snapshot.gamesPlayed ? `<i class="seat-score">${player.score} 分</i>` : ''
      }</span>
      <span class="seat-status ${statusClass}">${escapeHtml(seatStatusText(player, snapshot))}</span>
      ${seatClaimsHtml(action)}
    </div>
    ${player.status === 'played' ? `<span class="seat-pending">暗牌 ${player.pendingCount}</span>` : ''}
    ${isTurn ? `<span class="turn-flag">${seat === selfSeat() ? '轮到您' : '轮到TA'}</span>` : ''}
    ${bubbleFor(seat)}
  </div>`;
}

function renderOpponents() {
  const snapshot = app.snapshot;
  const container = $('#opponents');
  if (!snapshot || !container) return;
  const opponents = opponentOrder();
  const positions = POSITION_MAP[opponents.length] || [];
  container.innerHTML = opponents
    .map(({ player, seat }, index) => {
      const pos = positions[index] || 'top';
      return `<div class="opp-seat pos-${pos}">${seatHtml(player, seat, snapshot)}</div>`;
    })
    .join('');
}

function currentTurnPlayer() {
  const snapshot = app.snapshot;
  if (!snapshot || snapshot.phase !== 'playing' || snapshot.turn == null) return null;
  return playerAt(snapshot.turn);
}

function renderCenter() {
  const snapshot = app.snapshot;
  if (!snapshot) return;
  const self = selfSeat();
  const turnPlayer = currentTurnPlayer();
  const myTurn = snapshot.phase === 'playing' && snapshot.turn === self;

  $('#table-room-label').textContent = snapshot.code ? `房间 ${formatCode(snapshot.code)}` : '亲友牌桌';
  $('#table-round-label').textContent = `第 ${snapshot.round || 1} 轮`;
  $('#round-chip').textContent = `第 ${snapshot.round || 1} 轮`;

  const count = snapshot.players.filter(Boolean).length;
  const decks = DECK_COUNT_BY_PLAYERS[count] || 1;
  const finishedCount = snapshot.finished?.length || 0;
  $('#deck-chip').textContent =
    `${count} 人 · ${decks} 副牌` +
    (snapshot.revealed?.length ? ` · ${snapshot.revealed.length} 张明牌` : '') +
    (finishedCount ? ` · ${snapshot.activeCount} 人血战` : '');

  if (snapshot.target) {
    $('#target-type').textContent = snapshot.target.label;
    const leader = playerAt(snapshot.leader);
    $('#target-sub').textContent = leader
      ? `${leader.name} 先手 · 跟同牌型，也可以过`
      : '跟同牌型，也可以过';
  } else {
    $('#target-type').textContent = '等先手扣牌';
    $('#target-sub').textContent = '先手可以出任意牌型，只报牌型';
  }

  const callout = $('#turn-callout');
  callout.classList.toggle('is-mine', myTurn);
  if (snapshot.phase === 'review') {
    $('#turn-title').textContent = '本轮结束';
    $('#turn-detail').textContent = '看牌、判定';
  } else if (snapshot.phase === 'gameOver') {
    $('#turn-title').textContent = '牌局结束';
    $('#turn-detail').textContent = snapshot.winner ? `${snapshot.winner.name} 上游` : '';
  } else if (snapshot.self?.finished) {
    const nextActive = turnPlayer;
    $('#turn-title').textContent = nextActive ? `${nextActive.name} 正在扣牌` : '血战继续';
    $('#turn-detail').textContent = snapshot.target
      ? `您已出完 · 跟「${snapshot.target.label}」`
      : '您已出完，等其他人';
  } else if (myTurn) {
    $('#turn-title').textContent = '轮到您扣牌';
    $('#turn-detail').textContent = snapshot.target
      ? `跟「${snapshot.target.label}」`
      : '先出任意牌型';
  } else if (turnPlayer) {
    if (turnPlayer.isAI) {
      $('#turn-title').textContent = `${turnPlayer.name} 正在配牌…`;
      $('#turn-detail').textContent = snapshot.target
        ? `跟「${snapshot.target.label}」`
        : '电脑先出牌';
    } else if (!turnPlayer.connected) {
      $('#turn-title').textContent = `等 ${turnPlayer.name} 连回来`;
      $('#turn-detail').textContent = '房主可以代为处理';
    } else {
      $('#turn-title').textContent = `${turnPlayer.name} 正在扣牌`;
      $('#turn-detail').textContent = snapshot.target
        ? `跟「${snapshot.target.label}」`
        : '先手出牌型';
    }
  } else {
    $('#turn-title').textContent = '准备开始';
    $('#turn-detail').textContent = '';
  }

  const track = $('#round-track');
  const order = snapshot.turnOrder?.length
    ? snapshot.turnOrder
    : snapshot.players.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  track.innerHTML = order
    .map((seat) => {
      const player = playerAt(seat);
      if (!player) return '';
      const action = actionFor(seat);
      const classes = ['track-player'];
      if (snapshot.phase === 'playing' && snapshot.turn === seat) classes.push('is-current');
      if (action) {
        if (action.passed) classes.push('is-passed');
        else if (action.status === 'failed') classes.push('is-failed');
        else if (action.status === 'success') classes.push('is-success');
        else classes.push('is-played');
      }
      if (snapshot.winner?.seat === seat) classes.push('is-winner');
      return `<span class="${classes.join(' ')}"><b>${escapeHtml(player.avatar)}</b>${escapeHtml(
        player.name
      )}</span>`;
    })
    .join('');

  const revealed = $('#revealed-strip');
  if (snapshot.revealed?.length) {
    revealed.classList.remove('hidden');
    $('#revealed-list').innerHTML = snapshot.revealed.map(miniCardHtml).join('');
  } else {
    revealed.classList.add('hidden');
  }
}

function renderSelf() {
  const snapshot = app.snapshot;
  const self = selfPlayer();
  if (!snapshot || !self) return;
  $('#self-avatar').textContent = self.avatar;
  $('#self-name').textContent = self.name;
  $('#self-count').textContent = self.finished
    ? `已出完 · ${self.place === 1 ? '上游' : `第${self.place}名`}`
    : `${self.cardCount} 张牌`;
  const selfScore = $('#self-score');
  if (selfScore) {
    selfScore.textContent = `${self.score} 分`;
    selfScore.classList.toggle('hidden', !snapshot.gamesPlayed);
  }
  const myTurn = snapshot.phase === 'playing' && snapshot.turn === self.seat;
  $('#self-turn-tag').classList.toggle('hidden', !myTurn || self.finished);
  $('#self-leader-tag').classList.toggle(
    'hidden',
    !(snapshot.phase === 'playing' && snapshot.leader === self.seat) || self.finished
  );
  const placeTag = $('#self-place-tag');
  placeTag.classList.toggle('hidden', !self.finished);
  if (self.finished) {
    placeTag.textContent = self.place === 1 ? '上游' : `第${self.place}名`;
  }
  $('#btn-hand-sheet').classList.toggle('hidden', self.finished);
}

function renderHand() {
  const snapshot = app.snapshot;
  const self = snapshot?.self;
  const container = $('#hand');
  if (!container || !self) return;
  const scroll = $('.hand-scroll');
  const left = scroll?.scrollLeft || 0;

  if (self.finished) {
    container.innerHTML = `<div class="hand-empty"><span>您已出完</span><small>${
      self.place === 1 ? '上游' : `第 ${self.place} 名`
    } · 血战继续，等其他人出完</small></div>`;
    return;
  }

  const hand = self.hand || [];
  container.innerHTML = hand.map((id) => cardHtml(id, { interactive: true })).join('');
  container.classList.toggle('many-cards', hand.length > 20);

  const cards = [...container.querySelectorAll('.pcard')];
  const cardW = cards[0]?.offsetWidth || 60;
  const available = Math.max(0, (scroll?.clientWidth || 360) - 18);
  const step =
    cards.length > 1
      ? Math.max(10, Math.min(cardW + 8, (available - cardW) / (cards.length - 1)))
      : cardW;
  container.style.setProperty('--hand-step', `${step.toFixed(2)}px`);
  if (scroll) scroll.scrollLeft = left;
}

function selectionState() {
  const cards = [...app.selected];
  if (!cards.length) {
    return { cards, valid: false, analysis: null, matchesTarget: false, message: '' };
  }
  const analysis = analyzeCombo(cards);
  if (!analysis.valid) {
    return {
      cards,
      valid: false,
      analysis: null,
      matchesTarget: false,
      message: analysis.reason
    };
  }
  const target = app.snapshot?.target || null;
  if (target && !sameComboShape(analysis.combo, target)) {
    return {
      cards,
      valid: false,
      analysis: analysis.combo,
      matchesTarget: false,
      message: `这一轮要跟「${target.label}」`
    };
  }
  return {
    cards,
    valid: true,
    analysis: analysis.combo,
    matchesTarget: true,
    message: ''
  };
}

function renderActionDock() {
  const snapshot = app.snapshot;
  const dock = $('#action-dock');
  if (!snapshot || !dock) return;
  const self = selfSeat();
  const myTurn = snapshot.phase === 'playing' && snapshot.turn === self;
  dock.classList.toggle('is-my-turn', myTurn);

  if (snapshot.phase === 'gameOver') {
    dock.classList.add('hidden');
    return;
  }

  if (snapshot.phase === 'review') {
    dock.classList.remove('hidden');
    $('#action-title').textContent = '本轮牌面已经揭晓';
    $('#action-sub').textContent = snapshot.isHost ? '看清判定后，继续下一轮' : '等房主继续下一轮';
    $('#action-buttons').innerHTML = snapshot.isHost
      ? '<button class="btn btn-primary btn-play" type="button" data-action="continue-round">继续下一轮</button>'
      : '<button class="btn btn-quiet" type="button" data-action="show-review">查看本轮</button>';
    return;
  }

  if (snapshot.self?.finished && snapshot.phase === 'playing') {
    dock.classList.remove('hidden');
    $('#action-title').textContent = `您已出完 · ${
      snapshot.self.place === 1 ? '上游' : `第${snapshot.self.place}名`
    }`;
    $('#action-sub').textContent = '血战继续，等其他人出完';
    $('#action-buttons').innerHTML = '';
    return;
  }

  if (!myTurn) {
    const turnPlayer = currentTurnPlayer();
    if (snapshot.isHost && turnPlayer && !turnPlayer.connected) {
      dock.classList.remove('hidden');
      $('#action-title').textContent = `${turnPlayer.name} 掉线了`;
      if (snapshot.turn === snapshot.leader) {
        $('#action-sub').textContent = '先手不能过，房主可代出一张最小的单牌';
        $('#action-buttons').innerHTML =
          '<button class="btn btn-primary btn-play" type="button" data-action="host-lead">代出最小单牌</button>';
      } else {
        $('#action-sub').textContent = '房主可以代他过这一轮';
        $('#action-buttons').innerHTML =
          '<button class="btn btn-primary btn-play" type="button" data-action="host-pass">代他过牌</button>';
      }
      return;
    }
    dock.classList.add('hidden');
    return;
  }

  dock.classList.remove('hidden');
  const selection = selectionState();
  const isLeader = snapshot.leader === self;
  if (app.actionPending) {
    $('#action-title').textContent = '已扣牌';
    $('#action-sub').textContent = '等大家行动完，一起揭晓';
    $('#action-buttons').innerHTML = '';
    return;
  }
  if (!selection.cards.length) {
    $('#action-title').textContent = isLeader ? '轮到您先出牌' : '轮到您扣牌';
    $('#action-sub').textContent = snapshot.target
      ? `要跟「${snapshot.target.label}」，选好牌再猜大小`
      : '先出任意牌型，选好牌再扣下';
  } else if (selection.valid) {
    $('#action-title').textContent = `已选 ${selection.cards.length} 张`;
    $('#action-sub').textContent = `${selection.analysis.label}${
      snapshot.target ? ` · 跟「${snapshot.target.label}」` : ' · 先手牌型'
    }`;
  } else {
    $('#action-title').textContent = `已选 ${selection.cards.length} 张`;
    $('#action-sub').textContent = selection.message;
  }

  const submitDisabled = !selection.valid ? ' disabled' : '';
  $('#action-buttons').innerHTML = `
    <button class="btn btn-quiet" type="button" data-action="hint">帮我找牌</button>
    ${
      isLeader
        ? ''
        : '<button class="btn btn-quiet pass-btn" type="button" data-action="pass">过</button>'
    }
    <button class="btn btn-primary btn-play" type="button" data-action="submit-play"${submitDisabled}>扣牌</button>
  `;
}

function renderGame() {
  const snapshot = app.snapshot;
  if (!snapshot) return;
  showScreen('game');
  renderCenter();
  renderOpponents();
  renderSelf();
  renderHand();
  renderActionDock();
  $('#btn-chat').classList.toggle('hidden', app.mode !== 'host' && app.mode !== 'guest');
}

/* --------------------------------------------------------------------------
   渲染入口
   -------------------------------------------------------------------------- */

function render() {
  if (!app.snapshot) {
    if (app.mode) return;
    showScreen('home');
    updateHome();
    setConnection(null);
    return;
  }
  updateConnectionPill();
  if (app.snapshot.phase === 'lobby') {
    renderLobby();
    return;
  }
  renderGame();
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  if (
    app.snapshot &&
    snapshot.code === app.snapshot.code &&
    Number(snapshot.seq) < Number(app.snapshot.seq)
  ) {
    return;
  }
  if (app.modalType === 'loading') closeModal({ force: true });
  const prev = app.snapshot;
  app.snapshot = snapshot;
  if (snapshot.self?.seat != null) app.seat = snapshot.self.seat;
  app.actionPending = false;

  if (prev?.phase !== 'playing' && snapshot.phase === 'playing') {
    app.reviewOpenRound = 0;
    app.resultKey = null;
    app.lastClaimKey = '';
    app.lastTurnKey = '';
  }

  const self = selfSeat();
  const myTurn = snapshot.phase === 'playing' && snapshot.turn === self;
  const hand = new Set(snapshot.self?.hand || []);
  const handChanged =
    prev?.round !== snapshot.round ||
    prev?.phase !== snapshot.phase ||
    prev?.self?.hand?.length !== snapshot.self?.hand?.length;
  if (
    !myTurn ||
    snapshot.phase !== 'playing' ||
    [...app.selected].some((id) => !hand.has(id))
  ) {
    if (!app.actionPending) {
      app.selected.clear();
      app.claims.clear();
    }
  }
  if (handChanged && app.modalType === 'claim') closeModal({ force: true });
  if (!myTurn && app.modalType === 'claim') closeModal({ force: true });

  announceClaims(snapshot, prev);
  render();

  if (snapshot.phase === 'review' && app.reviewOpenRound !== snapshot.round) {
    app.reviewOpenRound = snapshot.round;
    if (!app.modalType || app.modalType === 'loading') openReview();
  } else if (snapshot.phase === 'gameOver') {
    const key = `${snapshot.round}:${snapshot.winner?.seat}:${snapshot.winner?.combo?.key}`;
    if (app.resultKey !== key) {
      app.resultKey = key;
      closeModal({ force: true });
      openResult();
    }
  } else if (snapshot.phase === 'playing') {
    if (app.modalType === 'review' || app.modalType === 'result') closeModal({ force: true });
  } else if (snapshot.phase === 'lobby') {
    if (app.modalType === 'review' || app.modalType === 'result' || app.modalType === 'claim') {
      closeModal({ force: true });
    }
  }

  announceSnapshot(snapshot);
}

/* --------------------------------------------------------------------------
   联机：房主
   -------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
   入座审批：昵称和掉线的人重名时，先问房主
   -------------------------------------------------------------------------- */

const JOIN_APPROVAL_TIMEOUT = 60000;

function renderJoinRequest() {
  const el = $('#join-request');
  if (!el) return;
  const entry = app.activeJoinRequest;
  if (!entry) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="jr-body">
      <span class="jr-badge">入座申请</span>
      <p class="jr-text">
        <strong>${escapeHtml(entry.name)}</strong> 想坐回原来的位置。
        刚才掉线的就是这个名字，${
          entry.verified ? '凭证也对得上，确认是本人就放行。' : '没有带上原来的凭证，请确认是不是同一个人。'
        }
      </p>
    </div>
    <div class="jr-actions">
      <button class="btn btn-small btn-soft" type="button" data-action="deny-join">不让进</button>
      <button class="btn btn-small btn-primary" type="button" data-action="allow-join">同意入座</button>
    </div>`;
}

function showNextJoinRequest() {
  if (app.activeJoinRequest) {
    renderJoinRequest();
    return;
  }
  const next = app.joinRequests.find((item) => !item.settled);
  if (!next) {
    renderJoinRequest();
    return;
  }
  app.activeJoinRequest = next;
  renderJoinRequest();
}

function settleJoinRequest(entry, approved) {
  if (!entry || entry.settled) return;
  entry.settled = true;
  clearTimeout(entry.timer);
  const index = app.joinRequests.indexOf(entry);
  if (index >= 0) app.joinRequests.splice(index, 1);
  if (app.activeJoinRequest === entry) app.activeJoinRequest = null;
  entry.resolve(Boolean(approved));
  showNextJoinRequest();
}

function requestJoinApproval({ seat, name, verified }) {
  return new Promise((resolve) => {
    const entry = { seat, name, verified, resolve, settled: false, timer: null };
    entry.timer = setTimeout(() => {
      settleJoinRequest(entry, false);
    }, JOIN_APPROVAL_TIMEOUT);
    app.joinRequests.push(entry);
    showNextJoinRequest();
  });
}

function cancelJoinRequests() {
  for (const entry of [...app.joinRequests]) settleJoinRequest(entry, false);
  app.joinRequests = [];
  app.activeJoinRequest = null;
  renderJoinRequest();
}

async function hostAcceptJoin({ peerId, token, name, conn }) {
  const room = app.room;
  if (!room) return { ok: false, message: '牌桌还没有准备好' };

  const decision = prepareJoin(room, { name, token });

  if (decision.action === 'approve') {
    // 桌上有同名的人掉线了：先扣住连接，等房主点头。
    try {
      conn?.send({
        type: 'pending',
        message: '房主正在确认你的座位，请稍等一下',
        protocol: PROTOCOL_VERSION
      });
    } catch {
      /* ignore */
    }

    const approved = await requestJoinApproval({
      seat: decision.seat,
      name: decision.name,
      verified: decision.verified
    });
    if (!approved) {
      return { ok: false, code: 'HOST_DENIED', message: '房主没有同意这次入座' };
    }
    if (conn && conn.open === false) {
      return { ok: false, code: 'CONNECTION_GONE', message: '连接已经断开，请重新进入' };
    }

    const taken = takeOverSeat(room, decision.seat, { peerId, token });
    if (!taken.ok) {
      return { ok: false, code: taken.error, message: taken.message || '这个座位已经不能用了' };
    }
    return {
      ok: true,
      seat: decision.seat,
      token: taken.token,
      reconnected: true,
      approved: true,
      name: taken.player.name
    };
  }

  if (decision.action === 'reconnect') {
    updateConnection(room, decision.seat, true);
    room.seats[decision.seat].peerId = peerId;
    return {
      ok: true,
      seat: decision.seat,
      token,
      reconnected: true,
      name: room.seats[decision.seat].name
    };
  }

  if (decision.action === 'reject') {
    return { ok: false, code: decision.code, message: decision.message };
  }

  const result = addPlayer(room, { name, token, peerId });
  if (!result.ok) return { ok: false, code: result.error, message: result.message };
  return {
    ok: true,
    seat: result.seat,
    token: result.player.token,
    reconnected: false,
    name: result.player.name
  };
}

function hostOnGuestJoined(seat, result) {
  if (!app.room) return;
  const player = app.room.seats[seat];
  if (!player) return;
  publishHost();
  if (result.approved) {
    toast(`${player.name} 坐回了原来的座位`);
    tone('tap');
  } else if (result.reconnected) {
    toast(`${player.name} 回来了`);
  } else {
    toast(`${player.name} 入座了`);
    tone('tap');
  }
}

function hostOnGuestLeft(seat) {
  if (!app.room) return;
  const player = app.room.seats[seat];
  if (!player) return;
  updateConnection(app.room, seat, false);
  publishHost();
  toast(`${player.name} 掉线了，等他连回来`);
  if (app.room.phase === 'playing') {
    // 不自动代打；由房主在操作条里决定。
  }
}

function hostHandleMessage(seat, data) {
  if (!app.room || !data || typeof data !== 'object') return;
  if (!app.room.seats[seat]?.connected) return;
  if (data.type === 'sync') {
    app.peerHost?.send(seat, {
      type: 'state',
      state: buildSnapshot(app.room, seat)
    });
    return;
  }
  if (data.type === 'action') {
    const action = data.action;
    if (!action || typeof action !== 'object') return;
    let result;
    if (action.kind === 'play') {
      result = playCards(app.room, seat, action.cards, action.claims);
    } else if (action.kind === 'pass') {
      result = passTurn(app.room, seat);
    } else {
      result = { ok: false, message: '没有明白这个操作' };
    }
    if (!result.ok) {
      app.peerHost?.send(seat, { type: 'toast', message: result.message || '操作没有成功' });
      app.peerHost?.send(seat, {
        type: 'state',
        state: buildSnapshot(app.room, seat)
      });
      return;
    }
    tone(action.kind === 'pass' ? 'pass' : 'card');
    publishHost();
    return;
  }

  if (data.type === 'chat') {
    const text = String(data.text || '').slice(0, 20);
    if (!CHAT_PHRASES.includes(text)) return;
    broadcastChat(seat, text);
  }
}

function handleHostStatus(status) {
  app.hostStatus = status;
  updateConnectionPill();
  if (status === 'reconnecting') toast('牵线服务断开，正在自动重连');
}

function handleHostError(error) {
  const message = friendlyPeerError(error);
  if (message) toast(message, { warm: true });
}

async function createOnlineRoom() {
  if (app.mode) return;
  const name = getName();
  showLoading('正在开桌', '正在连接牵线服务，通常几秒钟就好。');
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = makeRoomCode();
    const room = createRoom({ code, mode: 'online', hostName: name });
    const host = new PeerHost({
      code,
      onJoin: hostAcceptJoin,
      onMessage: hostHandleMessage,
      onLeave: hostOnGuestLeft,
      onJoined: hostOnGuestJoined,
      onStatus: handleHostStatus,
      onError: handleHostError
    });

    app.mode = 'host';
    app.room = room;
    app.code = code;
    app.seat = 0;
    app.peerHost = host;
    app.hostStatus = 'connecting';

    try {
      await host.start();
      app.hostStatus = 'online';
      closeModal({ force: true });
      publishHost();
      toast('牌桌开好了，把房间号告诉亲友');
      tone('tap');
      return;
    } catch (error) {
      lastError = error;
      try {
        host.close();
      } catch {
        /* ignore */
      }
      app.peerHost = null;
      app.room = null;
      app.mode = null;
      app.code = null;
      app.seat = null;
      app.hostStatus = 'idle';
      if (error?.type !== 'unavailable-id' && error?.code !== 'unavailable-id') break;
    }
  }

  showError(
    '没能开成牌桌',
    lastError?.message || '网络连接失败，请检查网络后再试。',
    () => createOnlineRoom()
  );
}

function publishHost() {
  if (!app.room) return;
  app.seat = 0;
  applySnapshot(buildSnapshot(app.room, 0));
  if (app.peerHost) {
    for (const [seat, player] of app.room.seats.entries()) {
      if (!player || player.isHost || player.isAI) continue;
      if (!player.connected) continue;
      app.peerHost.send(seat, {
        type: 'state',
        state: buildSnapshot(app.room, seat)
      });
    }
  }
  updateConnectionPill();
  scheduleAITurn();
}

function clearAITimer() {
  if (app.aiTimer) clearTimeout(app.aiTimer);
  app.aiTimer = null;
  app.aiTurnKey = '';
}

function scheduleAITurn() {
  if (app.mode !== 'host' || !app.room) return;
  const room = app.room;
  if (room.phase !== 'playing' || room.turn == null) return;
  const player = room.seats[room.turn];
  if (!player?.isAI) return;

  const seat = room.turn;
  const key = `${room.seq}:${seat}`;
  if (app.aiTimer && app.aiTurnKey === key) return;
  if (app.aiTimer) clearTimeout(app.aiTimer);
  app.aiTimer = null;
  app.aiTurnKey = key;

  const delay = 900 + Math.floor(Math.random() * 600);
  app.aiTimer = setTimeout(() => {
    app.aiTimer = null;
    app.aiTurnKey = '';
    runAITurn(seat);
  }, delay);
}

function runAITurn(seat) {
  const room = app.room;
  if (!room || app.mode !== 'host') return;
  if (room.phase !== 'playing' || room.turn !== seat) return;
  if (!room.seats[seat]?.isAI) return;

  const action = chooseAIAction(room, seat);
  let result = null;
  if (action?.kind === 'play') {
    result = playCards(room, seat, action.cards, action.claims);
  } else if (action?.kind === 'pass') {
    result = passTurn(room, seat);
  }
  if (!result?.ok) {
    const hand = sortHand(room.hands[seat] || []);
    if (seat === room.leader && hand.length) {
      result = playCards(room, seat, [hand[hand.length - 1]], []);
    } else {
      result = passTurn(room, seat);
    }
  }
  if (!result?.ok) {
    console.warn('电脑出牌失败', result?.message || result?.error || 'unknown');
    return;
  }
  tone(action?.kind === 'pass' ? 'pass' : 'card');
  publishHost();
}

function broadcastChat(seat, text) {
  if (!app.room) return;
  const message = { type: 'chat', seat, text };
  for (const [targetSeat, player] of app.room.seats.entries()) {
    if (!player || player.isHost || player.isAI) continue;
    if (!player.connected) continue;
    app.peerHost?.send(targetSeat, message);
  }
  showChatBubble(seat, text);
}

function handleChatMessage(seat, text) {
  showChatBubble(seat, text);
}

function showChatBubble(seat, text) {
  if (seat === selfSeat()) {
    toast(`您说：${text}`);
    return;
  }
  const id = `${seat}:${Date.now()}:${Math.random()}`;
  app.chatBubbles.set(seat, { text, id });
  renderOpponents();
  setTimeout(() => {
    if (app.chatBubbles.get(seat)?.id === id) {
      app.chatBubbles.delete(seat);
      renderOpponents();
    }
  }, 4200);
}

/* --------------------------------------------------------------------------
   联机：客人
   -------------------------------------------------------------------------- */

async function joinOnlineRoom(rawCode) {
  if (app.mode) return;
  const code = String(rawCode || '').replace(/\D/g, '').slice(0, 6);
  if (code.length !== 6) {
    $('#join-error').textContent = '请输入六位数字房间号';
    return;
  }
  const name = getName();
  const savedToken = (() => {
    try {
      return sessionStorage.getItem(STORAGE.token(code)) || '';
    } catch {
      return '';
    }
  })();
  const token = savedToken || randomToken();

  showLoading('正在入座', `正在找房间 ${formatCode(code)}，请稍等一下。`);
  const guest = new PeerGuest({
    code,
    name,
    token,
    onState: (snapshot) => {
      app.guestStatus = 'online';
      applySnapshot(snapshot);
      updateConnectionPill();
    },
    onChat: (data) => handleChatMessage(data.seat, data.text),
    onToast: (message) => toast(message),
    onPending: (message) => {
      showLoading('等房主确认', message || '房主正在确认你的座位，稍等一下。');
    },
    onClose: (info) => handleGuestClose(info),
    onStatus: (status) => {
      app.guestStatus = status;
      updateConnectionPill();
    },
    onError: (error) => toast(error.message || '网络提示', { warm: true })
  });

  app.mode = 'guest';
  app.code = code;
  app.joinToken = token;
  app.peerGuest = guest;
  app.guestStatus = 'connecting';

  try {
    const welcome = await guest.join();
    app.seat = welcome.seat;
    app.token = welcome.token;
    try {
      sessionStorage.setItem(STORAGE.token(code), welcome.token);
    } catch {
      /* ignore */
    }
    app.guestStatus = 'online';
    // 等房主推第一份 state；通常紧跟着 welcome 到达。
    setTimeout(() => {
      if (app.mode === 'guest' && !app.snapshot) {
        closeModal({ force: true });
        toast('已连上房主，正在等牌桌状态');
      }
    }, 1800);
  } catch (error) {
    try {
      guest.close();
    } catch {
      /* ignore */
    }
    app.peerGuest = null;
    app.mode = null;
    app.code = null;
    app.seat = null;
    const message = error?.message || '没能进入牌桌，请检查房间号';
    showError('没能入座', message, () => joinOnlineRoom(code));
  }
}

function handleGuestClose(info = {}) {
  if (app.mode !== 'guest') return;
  app.guestStatus = 'offline';
  updateConnectionPill();
  if (info.hostLeft) {
    closeModal({ force: true });
    showError(
      '房主离开了牌桌',
      info.message || '这局牌桌已经关闭。可以回到首页，自己开一桌等亲友。',
      null
    );
    return;
  }
  if (app.modalType === 'reconnect') return;
  openModal(
    `<div class="loading-box">
      <p><strong>和牌桌的连接断开了</strong>可能是网络抖动，也可能是房主暂时离开了。</p>
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" type="button" data-action="reconnect">重新连接</button>
      <button class="btn btn-cream" type="button" data-action="go-home">回到首页</button>
    </div>`,
    { type: 'reconnect', closeable: false }
  );
}

async function reconnectGuest() {
  if (!app.code || !app.token) {
    goHome();
    return;
  }
  const code = app.code;
  const token = app.token;
  const name = app.name;
  try {
    app.peerGuest?.close();
  } catch {
    /* ignore */
  }
  app.peerGuest = null;
  app.mode = null;
  app.snapshot = null;
  showLoading('正在重连', '还在原来的座位上，稍等一下。');

  const guest = new PeerGuest({
    code,
    name,
    token,
    onState: (snapshot) => {
      app.guestStatus = 'online';
      applySnapshot(snapshot);
      updateConnectionPill();
    },
    onChat: (data) => handleChatMessage(data.seat, data.text),
    onToast: (message) => toast(message),
    onPending: (message) => {
      showLoading('等房主确认', message || '房主正在确认你的座位，稍等一下。');
    },
    onClose: (info) => handleGuestClose(info),
    onStatus: (status) => {
      app.guestStatus = status;
      updateConnectionPill();
    },
    onError: (error) => toast(error.message || '网络提示', { warm: true })
  });

  app.mode = 'guest';
  app.code = code;
  app.token = token;
  app.peerGuest = guest;
  app.guestStatus = 'connecting';

  try {
    const welcome = await guest.join();
    app.seat = welcome.seat;
    app.token = welcome.token;
    try {
      sessionStorage.setItem(STORAGE.token(code), welcome.token);
    } catch {
      /* ignore */
    }
    closeModal({ force: true });
    toast('回到牌桌了');
  } catch (error) {
    app.mode = null;
    app.code = null;
    app.peerGuest = null;
    showError('重连没有成功', error.message || '房主可能已经离开，或网络暂时不通。', null);
  }
}

/* --------------------------------------------------------------------------
   游戏动作
   -------------------------------------------------------------------------- */

function toggleCard(id) {
  if (!app.snapshot) return;
  const snapshot = app.snapshot;
  const myTurn = snapshot.phase === 'playing' && snapshot.turn === selfSeat();
  if (!myTurn) {
    toast('还没轮到您，先看看牌');
    return;
  }
  if (app.actionPending) return;
  if (app.selected.has(id)) app.selected.delete(id);
  else app.selected.add(id);
  app.claims.clear();
  tone('tap');
  if (app.modalType === 'hand') renderHandSheet();
  renderHand();
  renderActionDock();
}

function clearSelection() {
  app.selected.clear();
  app.claims.clear();
  app.pendingCards = null;
}

function doHint() {
  const snapshot = app.snapshot;
  const self = snapshot?.self;
  if (!snapshot || !self || snapshot.phase !== 'playing' || snapshot.turn !== self.seat) return;
  const result = findPlayableCombo(self.hand, snapshot.target);
  if (!result) {
    toast(
      snapshot.target
        ? `手里没有能跟「${snapshot.target.label}」的牌，可以过`
        : '手里暂时没有能出的牌型'
    );
    tone('error');
    return;
  }
  app.selected = new Set(result.cards);
  app.claims.clear();
  tone('tap');
  if (app.modalType === 'hand') renderHandSheet();
  renderHand();
  renderActionDock();
  toast(`帮您选出：${result.combo.label}`);
}

function beginClaimFlow() {
  const snapshot = app.snapshot;
  if (!snapshot) return;
  const selection = selectionState();
  if (!selection.valid) {
    toast(selection.message || '这组牌还不能出');
    tone('error');
    return;
  }
  const self = selfSeat();
  const prior = (snapshot.turnOrder || [])
    .slice(0, snapshot.turnOrder.indexOf(self))
    .filter((seat) => snapshot.actions?.[seat]?.played);
  app.pendingCards = [...selection.cards];
  app.claims.clear();

  if (!prior.length) {
    submitPlay(selection.cards, []);
    return;
  }

  openModal(claimModalHtml(prior, selection.analysis), { type: 'claim', closeable: true });
}

function claimModalHtml(prior, combo) {
  const rows = prior
    .map((seat) => {
      const player = playerAt(seat);
      const action = snapshotAction(seat);
      return `<div class="claim-row" data-claim-row="${seat}">
        <div class="claim-person">
          <span class="claim-avatar" aria-hidden="true">${escapeHtml(player?.avatar || '🂠')}</span>
          <span class="claim-name">
            <strong>${escapeHtml(player?.name || '牌友')}</strong>
            <small>已扣 ${action?.cardCount || 0} 张 · ${escapeHtml(action?.combo?.label || '暗牌')}</small>
          </span>
        </div>
        <div class="claim-choice">
          <button type="button" data-claim-target="${seat}" data-claim-dir="lower" data-dir="lower">比TA小</button>
          <button type="button" data-claim-target="${seat}" data-claim-dir="higher" data-dir="higher">比TA大</button>
        </div>
      </div>`;
    })
    .join('');

  return `<p class="modal-eyebrow">扣牌前，最后一步</p>
    <h2>猜一猜大小</h2>
    <p class="modal-lead">您扣下的是 <strong>${combo.size} 张 · ${escapeHtml(
    combo.label
  )}</strong>。请分别猜自己比前面每位牌友大还是小。</p>
    <div class="claim-summary"><span>要猜 ${prior.length} 位牌友</span><b id="claim-progress">0 / ${prior.length}</b></div>
    <div class="claim-list">${rows}</div>
    <p class="claim-note">不能猜“相同”。点数一样，猜大或猜小都算错；猜错只收回自己的牌。</p>
    <div class="modal-actions">
      <button class="btn btn-cream" type="button" data-action="close-modal">再选选</button>
      <button class="btn btn-primary" type="button" data-action="confirm-claim" disabled>确认扣牌</button>
    </div>`;
}

function snapshotAction(seat) {
  return app.snapshot?.actions?.[seat] || null;
}

function chooseClaim(target, dir) {
  app.claims.set(target, dir);
  for (const row of $$('.claim-row')) {
    const seat = Number(row.dataset.claimRow);
    const value = app.claims.get(seat);
    row.classList.toggle('is-done', Boolean(value));
    for (const button of $$('button', row)) {
      button.classList.toggle(
        'active',
        button.dataset.claimTarget === String(seat) && button.dataset.claimDir === value
      );
    }
  }
  const total = $$('.claim-row').length;
  const progress = $('#claim-progress');
  if (progress) progress.textContent = `${app.claims.size} / ${total}`;
  const confirm = $('[data-action="confirm-claim"]');
  if (confirm) confirm.disabled = app.claims.size !== total;
  tone('tap');
}

function submitPlay(cards, claims) {
  if (!app.snapshot) return;
  const self = selfSeat();
  if (app.mode === 'host') {
    const result = playCards(app.room, 0, cards, claims);
    if (!result.ok) {
      closeModal({ force: true });
      toast(result.message || '这手牌没有出成', { warm: true });
      tone('error');
      return;
    }
    clearSelection();
    closeModal({ force: true });
    tone('card');
    publishHost();
    return;
  }
  if (app.mode === 'guest') {
    const ok = app.peerGuest?.sendAction({ kind: 'play', cards, claims });
    if (!ok) {
      toast('连接断开了，暂时不能出牌', { warm: true });
      tone('error');
      return;
    }
    clearSelection();
    app.actionPending = true;
    closeModal({ force: true });
    tone('card');
    renderHand();
    renderActionDock();
    toast('已扣牌，等大家行动完一起揭晓');
    return;
  }
  toast('牌桌还没有准备好');
}

function requestPass() {
  const snapshot = app.snapshot;
  if (!snapshot || snapshot.phase !== 'playing' || snapshot.turn !== selfSeat()) return;
  openConfirm({
    title: '这一轮要过吗？',
    body: '过牌后，牌会留在手里，这一轮不能再出。',
    confirmText: '确定过',
    onConfirm: () => submitPass()
  });
}

function submitPass() {
  if (app.mode === 'host') {
    const result = passTurn(app.room, 0);
    if (!result.ok) {
      toast(result.message || '现在不能过', { warm: true });
      tone('error');
      return;
    }
    clearSelection();
    closeModal({ force: true });
    tone('pass');
    publishHost();
    return;
  }
  if (app.mode === 'guest') {
    const ok = app.peerGuest?.sendAction({ kind: 'pass' });
    if (!ok) {
      toast('连接断开了，暂时不能操作', { warm: true });
      return;
    }
    clearSelection();
    app.actionPending = true;
    closeModal({ force: true });
    tone('pass');
    renderHand();
    renderActionDock();
    toast('已过牌');
    return;
  }
}

function hostContinueRound() {
  if (app.mode !== 'host' || !app.room) return;
  const result = continueRound(app.room);
  if (!result.ok) {
    toast(result.message || '还不能继续', { warm: true });
    return;
  }
  closeModal({ force: true });
  publishHost();
  tone('tap');
}

function hostStartGame() {
  if (app.mode !== 'host' || !app.room) return;
  const result = startGame(app.room);
  if (!result.ok) {
    toast(result.message || '还不能开局', { warm: true });
    tone('error');
    return;
  }
  clearSelection();
  closeModal({ force: true });
  publishHost();
  tone('card');
}

function hostSkipCurrent(mode = 'pass') {
  if (app.mode !== 'host' || !app.room) return;
  const room = app.room;
  if (room.phase !== 'playing' || room.turn == null) return;
  const seat = room.turn;
  const player = room.seats[seat];
  if (!player || player.connected) return;
  let result;
  if (mode === 'lead' || seat === room.leader) {
    const hand = sortHand(room.hands[seat] || []);
    if (!hand.length) return;
    const card = hand[hand.length - 1];
    result = playCards(room, seat, [card], []);
  } else {
    result = passTurn(room, seat);
  }
  if (!result.ok) {
    toast(result.message || '代处理没有成功', { warm: true });
    return;
  }
  tone('pass');
  publishHost();
}

function hostAddAI() {
  if (app.mode !== 'host' || !app.room) return;
  const result = addAI(app.room);
  if (!result.ok) {
    toast(result.message || '现在不能加电脑', { warm: true });
    return;
  }
  publishHost();
  toast(`${result.player.name} 入座了`);
  tone('tap');
}

function hostResetScores() {
  if (app.mode !== 'host' || !app.room) return;
  openConfirm({
    title: '要清空累计积分吗？',
    body: '所有座位的积分会归零，牌桌和座位都保留。',
    confirmText: '清空积分',
    onConfirm: () => {
      const result = resetScores(app.room);
      if (!result.ok) {
        toast(result.message || '现在不能清空积分', { warm: true });
        return;
      }
      publishHost();
      toast('积分已清零');
      tone('tap');
    }
  });
}

function hostRemoveSeat(seat) {
  if (app.mode !== 'host' || !app.room) return;
  const player = app.room.seats[seat];
  if (!player || (!player.isAI && player.connected)) return;
  const result = removeSeat(app.room, seat);
  if (!result.ok) {
    toast(result.message || '不能移走这个座位', { warm: true });
    return;
  }
  toast(`${player.name} 的座位已移走`);
  publishHost();
}

function hostStartRematch() {
  if (app.mode !== 'host' || !app.room) return;
  const result = startGame(app.room);
  if (!result.ok) {
    toast(result.message || '还不能再来一局', { warm: true });
    return;
  }
  clearSelection();
  closeModal({ force: true });
  publishHost();
  tone('card');
}

function hostBackToLobby() {
  if (app.mode !== 'host' || !app.room) return;
  resetToLobby(app.room);
  closeModal({ force: true });
  publishHost();
}

/* --------------------------------------------------------------------------
   本轮记录 / 揭晓 / 结算
   -------------------------------------------------------------------------- */

function claimChips(action) {
  if (!action?.claims?.length) return '';
  return `<div class="review-claims">${action.claims
    .map((claim) => {
      const result = action.claimResults?.find((item) => item.target === claim.target);
      let cls = 'claim-chip';
      let suffix = '';
      if (action.status !== 'pending' && result) {
        if (result.auto) {
          cls += ' is-auto';
          suffix = ' 默认';
        } else if (result.ok) {
          cls += ' is-ok';
          suffix = ' ✓';
        } else {
          cls += ' is-bad';
          suffix = ' ✗';
        }
      }
      return `<span class="${cls}">比${escapeHtml(claim.targetName)}${
        claim.dir === 'higher' ? '大' : '小'
      }${suffix}</span>`;
    })
    .join('')}</div>`;
}

function reviewRowHtml(seat, action, { reveal = true } = {}) {
  const player = playerAt(seat);
  if (!player) return '';
  if (!action) {
    return `<div class="review-row is-passed">
      <div class="review-person">
        <span class="review-avatar">${escapeHtml(player.avatar)}</span>
        <span class="review-copy"><strong>${escapeHtml(player.name)}</strong><small>还没行动</small></span>
      </div>
      <div class="review-cards"></div>
    </div>`;
  }
  const statusClass = action.passed
    ? 'is-passed'
    : action.status === 'failed'
      ? 'is-failed'
      : action.status === 'success'
        ? 'is-success'
        : '';
  const cards =
    reveal && action.cards?.length
      ? `<div class="review-cards">${action.cards.map(miniCardHtml).join('')}</div>`
      : '';
  let status = '';
  if (player.finished) {
    status = `<p class="review-status ok">已出完 · ${
      player.place === 1 ? '上游' : `第 ${player.place} 名`
    }，血战继续</p>`;
  } else if (action.passed) status = '<p class="review-status">这轮选择过牌</p>';
  else if (action.status === 'success') {
    status = `<p class="review-status ok">${seat === app.snapshot.leader ? '先手默认通过' : '出牌成功，牌留在桌上'}</p>`;
  } else if (action.status === 'failed') {
    status = `<p class="review-status bad">${escapeHtml(action.reason || '猜错了，收回自己的牌')}</p>`;
  } else if (action.status === 'pending') {
    status = '<p class="review-status">等本轮结束再判定</p>';
  }

  return `<div class="review-row ${statusClass}">
    <div class="review-person">
      <span class="review-avatar">${escapeHtml(player.avatar)}</span>
      <span class="review-copy">
        <strong>${escapeHtml(player.name)}${seat === app.snapshot.leader ? ' · 先手' : ''}</strong>
        <small>${action.passed ? '过' : `${action.cardCount} 张 · ${escapeHtml(action.combo?.label || '暗牌')}`}</small>
        ${claimChips(action)}
      </span>
    </div>
    <div>
      ${cards}
      ${status}
    </div>
  </div>`;
}

function openReview() {
  const snapshot = app.snapshot;
  if (!snapshot || snapshot.phase !== 'review') return;
  clearToasts();
  app.reviewOpenRound = snapshot.round;
  const order = snapshot.turnOrder || [];
  const rows = order.map((seat) => reviewRowHtml(seat, actionFor(seat), { reveal: true })).join('');
  const next = snapshot.nextLeader != null ? playerAt(snapshot.nextLeader) : null;
  openModal(
    `<p class="modal-eyebrow">第 ${snapshot.round} 轮 · 揭晓</p>
     <h2>谁猜对了？</h2>
     <p class="modal-lead">先手默认通过；猜错的人只收回自己的牌。下一轮由本轮实际出牌最大的人先出。</p>
     <div class="review-list">${rows}</div>
     ${
       next
         ? `<div class="review-next"><span aria-hidden="true">→</span> 下一轮由 <strong>${escapeHtml(
             next.name
           )}</strong> 先出</div>`
         : ''
     }
     <div class="modal-actions">
       ${
         snapshot.isHost
           ? '<button class="btn btn-primary" type="button" data-action="continue-round">继续下一轮</button>'
           : '<span class="review-wait">等房主看明白后，开始下一轮。</span>'
       }
     </div>`,
    { type: 'review', closeable: true }
  );
}

function openLiveLog() {
  const snapshot = app.snapshot;
  if (!snapshot) return;
  if (snapshot.phase === 'review') {
    openReview();
    return;
  }
  if (snapshot.phase === 'gameOver') {
    openResult();
    return;
  }
  const order = snapshot.turnOrder || [];
  const rows = order
    .map((seat) => reviewRowHtml(seat, actionFor(seat), { reveal: false }))
    .join('');
  openModal(
    `<p class="modal-eyebrow">第 ${snapshot.round} 轮</p>
     <h2>本轮记录</h2>
     <p class="modal-lead">这里是已经扣下的牌型和大家报的大小，牌面要等本轮结束才揭晓。</p>
     <div class="review-list">${rows}</div>
     <div class="modal-actions">
       <button class="btn btn-primary" type="button" data-action="close-modal">知道了</button>
     </div>`,
    { type: 'log', closeable: true }
  );
}

function openResult() {
  const snapshot = app.snapshot;
  if (!snapshot || !snapshot.winner) return;
  clearToasts();
  const winner = snapshot.winner;
  const ranking = snapshot.ranking || [];
  const title = winner.isSelf ? '您上游啦！' : `${winner.name} 上游`;
  const sub = winner.isSelf
    ? '最先出完，这一桌您最快。'
    : '最先出完，血战到只剩最后一位。';
  const rankRows = ranking
    .map((entry) => {
      const player = playerAt(entry.seat);
      const label = entry.place === 1 ? '上游' : entry.last ? '下游' : `第 ${entry.place} 名`;
      return `<div class="rank-row${entry.seat === winner.seat ? ' is-winner' : ''}${
        entry.last ? ' is-last' : ''
      }">
        <span class="rank-place">${entry.place}</span>
        <span class="rank-avatar" aria-hidden="true">${escapeHtml(player?.avatar || '🐼')}</span>
        <span class="rank-name">${escapeHtml(player?.name || '牌友')}</span>
        <span class="rank-tag">${label}</span>
        <span class="rank-points">+${entry.points ?? 0} · 总 ${player?.score ?? 0}</span>
        <span class="rank-combo">${escapeHtml(
          entry.last ? '最后留下' : entry.combo?.label || ''
        )}</span>
      </div>`;
    })
    .join('');
  openModal(
    `<div class="result-top">
       <div class="result-trophy" aria-hidden="true">🏆</div>
       <div class="result-kicker">血战结束 · ${snapshot.round} 轮</div>
       <h2>${escapeHtml(title)}</h2>
       <p class="result-sub">${escapeHtml(sub)}</p>
     </div>
     <div class="result-body">
       <div class="result-ranking">${rankRows}</div>
       ${
         snapshot.isHost
           ? `<div class="modal-actions">
                <button class="btn btn-primary" type="button" data-action="rematch">再来一局</button>
                <button class="btn btn-cream" type="button" data-action="back-lobby">回大厅</button>
              </div>`
           : '<div class="result-wait">等房主开下一局，或者回大厅继续聊。</div>'
       }
     </div>`,
    { type: 'result', closeable: true }
  );
  tone('win');
  startConfetti();
}

function openScores() {
  const snapshot = app.snapshot;
  if (!snapshot) return;
  const players = (snapshot.players || [])
    .map((player, seat) => (player ? { ...player, seat } : null))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.seat - b.seat);
  const count = players.length;
  const rows = players
    .map(
      (player, index) => `<div class="scoreboard-row${player.seat === selfSeat() ? ' is-self' : ''}">
        <span class="scoreboard-rank">${index + 1}</span>
        <span class="scoreboard-avatar" aria-hidden="true">${escapeHtml(player.avatar)}</span>
        <span class="scoreboard-name">${escapeHtml(player.name)}${
          player.isAI ? '<i>电脑</i>' : ''
        }${player.seat === selfSeat() ? '<i class="is-you">您</i>' : ''}</span>
        <span class="scoreboard-value">${player.score} 分</span>
      </div>`
    )
    .join('');
  openModal(
    `<p class="modal-eyebrow">累计积分</p>
     <h2>记分板</h2>
     <p class="modal-lead">${
       snapshot.gamesPlayed
         ? `已经打完 ${snapshot.gamesPlayed} 局。`
         : '还没有打完一局，先开一桌吧。'
     }${
       count
         ? ` 每局按名次记分：第一名 ${count - 1} 分，依次递减，最后一名 0 分。`
         : ''
     }</p>
     <div class="scoreboard-list">${rows}</div>
     <div class="modal-actions">
       <button class="btn btn-primary" type="button" data-action="close-modal">知道了</button>
     </div>`,
    { type: 'scores', closeable: true }
  );
}

/* --------------------------------------------------------------------------
   手牌册
   -------------------------------------------------------------------------- */

function handSheetSummary() {
  const selection = selectionState();
  if (!selection.cards.length) return '还没选牌';
  if (!selection.valid) return selection.message || '这组牌还不是有效牌型';
  return `已选 ${selection.cards.length} 张 · <strong>${escapeHtml(selection.analysis.label)}</strong>`;
}

function renderHandSheet() {
  const snapshot = app.snapshot;
  if (!snapshot?.self) return;
  const hand = snapshot.self.hand || [];
  const grid = hand
    .map((id) => cardHtml(id, { interactive: true, extraClass: 'sheet-card' }))
    .join('');
  const selection = selectionState();
  openModal(
    `<p class="modal-eyebrow">您的手牌 · ${hand.length} 张</p>
     <h2>点牌选中，再扣下</h2>
     <p class="modal-lead">可以一次选一张、对子、三张、顺子等。选好后去猜大小。</p>
     <div class="hand-sheet-grid" id="hand-sheet-grid">${grid}</div>
     <div class="hand-sheet-footer">
       <div class="hand-sheet-summary" id="hand-sheet-summary">${handSheetSummary()}</div>
       <button class="btn btn-cream" type="button" data-action="close-modal">收起</button>
       <button class="btn btn-primary" type="button" data-action="hand-done"${selection.valid ? '' : ' disabled'}>去扣牌</button>
     </div>`,
    { type: 'hand', closeable: true }
  );
  app.handSheetOpen = true;
}

function finishHandSheet() {
  const selection = selectionState();
  if (!selection.valid) {
    toast(selection.message || '这组牌还不能出', { warm: true });
    return;
  }
  closeModal({ force: true });
  beginClaimFlow();
}

/* --------------------------------------------------------------------------
   彩纸
   -------------------------------------------------------------------------- */

function clearConfetti() {
  const layer = $('#confetti-layer');
  if (layer) {
    layer.classList.add('hidden');
    layer.innerHTML = '';
  }
}

function startConfetti() {
  const layer = $('#confetti-layer');
  if (!layer) return;
  layer.innerHTML = '';
  layer.classList.remove('hidden');
  const colors = ['#efc45e', '#c84337', '#2b704f', '#f2d28a', '#fffaf0'];
  for (let i = 0; i < 34; i += 1) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDuration = `${2.2 + Math.random() * 2.2}s`;
    piece.style.animationDelay = `${Math.random() * 0.8}s`;
    piece.style.setProperty('--drift', `${-60 + Math.random() * 120}px`);
    piece.style.setProperty('--spin', `${360 + Math.random() * 720}deg`);
    layer.appendChild(piece);
  }
  setTimeout(clearConfetti, 6500);
}

/* --------------------------------------------------------------------------
   复制与分享
   -------------------------------------------------------------------------- */

async function copyText(text, successMessage = '复制好了') {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      ok = document.execCommand('copy');
      area.remove();
    } catch {
      ok = false;
    }
  }
  toast(ok ? successMessage : '复制没有成功，请长按房间号手动复制', { warm: !ok });
}

function inviteLink() {
  if (!app.code) return '';
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', app.code);
  return url.toString();
}

/* --------------------------------------------------------------------------
   事件
   -------------------------------------------------------------------------- */

async function handleAction(action, target) {
  switch (action) {
    case 'close-modal':
      closeModal();
      break;
    case 'modal-backdrop':
      if (target === $('.modal-backdrop')) closeModal();
      break;
    case 'go-home':
      goHome();
      break;
    case 'retry':
      {
        const retry = app.retryAction;
        app.retryAction = null;
        closeModal({ force: true });
        retry?.();
      }
      break;
    case 'confirm-modal':
      {
        const callback = app.confirmAction;
        app.confirmAction = null;
        closeModal({ force: true });
        callback?.();
      }
      break;
    case 'open-rules':
      openRules();
      break;
    case 'open-settings':
      openSettings();
      break;
    case 'show-review':
      openReview();
      break;
    case 'continue-round':
      hostContinueRound();
      break;
    case 'start-game':
      hostStartGame();
      break;
    case 'hint':
      doHint();
      break;
    case 'submit-play':
      beginClaimFlow();
      break;
    case 'confirm-claim':
      {
        const pending = app.pendingCards && [...app.pendingCards];
        const self = selfSeat();
        const prior = (app.snapshot?.turnOrder || [])
          .slice(0, app.snapshot?.turnOrder.indexOf(self))
          .filter((seat) => app.snapshot?.actions?.[seat]?.played);
        if (!pending || app.claims.size !== prior.length) return;
        const claims = prior.map((seat) => ({ target: seat, dir: app.claims.get(seat) }));
        submitPlay(pending, claims);
      }
      break;
    case 'pass':
      requestPass();
      break;
    case 'host-pass':
      hostSkipCurrent('pass');
      break;
    case 'host-lead':
      hostSkipCurrent('lead');
      break;
    case 'add-ai':
      hostAddAI();
      break;
    case 'reset-scores':
      hostResetScores();
      break;
    case 'show-scores':
      openScores();
      break;
    case 'remove-seat':
      hostRemoveSeat(Number(target.dataset.seat));
      break;
    case 'copy-code':
      copyText(formatCode(app.code), '房间号复制好了');
      break;
    case 'share-link':
      copyText(inviteLink(), '邀请链接复制好了，发给亲友就行');
      break;
    case 'reconnect':
      reconnectGuest();
      break;
    case 'rematch':
      hostStartRematch();
      break;
    case 'back-lobby':
      hostBackToLobby();
      break;
    case 'hand-done':
      finishHandSheet();
      break;
    case 'show-chat':
      openChatPicker();
      break;
    case 'request-leave':
      requestLeave();
      break;
    case 'allow-join':
      settleJoinRequest(app.activeJoinRequest, true);
      break;
    case 'deny-join':
      settleJoinRequest(app.activeJoinRequest, false);
      break;
    default:
      break;
  }
}

document.addEventListener('click', (event) => {
  const actionEl = event.target.closest('[data-action]');
  if (actionEl) {
    const action = actionEl.dataset.action;
    if (action === 'modal-backdrop') {
      // 只有点中遮罩本身才关闭；点弹层内容要继续交给下面的选牌/猜大小处理。
      if (event.target === actionEl) {
        event.preventDefault();
        handleAction(action, actionEl);
        return;
      }
    } else {
      event.preventDefault();
      handleAction(action, actionEl);
      return;
    }
  }

  const fontButton = event.target.closest('[data-font-option]');
  if (fontButton) {
    settings.font = fontButton.dataset.fontOption;
    saveSettings();
    applySettings();
    openSettings();
    return;
  }

  const toggle = event.target.closest('[data-toggle]');
  if (toggle) {
    const key = toggle.dataset.toggle;
    settings[key] = !settings[key];
    saveSettings();
    applySettings();
    openSettings();
    if (key === 'voice' && settings.voice) speak('语音提醒已打开');
    return;
  }

  const card = event.target.closest('[data-card-id]');
  if (card) {
    toggleCard(card.dataset.cardId);
    return;
  }

  const claim = event.target.closest('[data-claim-dir]');
  if (claim) {
    chooseClaim(Number(claim.dataset.claimTarget), claim.dataset.claimDir);
    return;
  }

  const chat = event.target.closest('[data-chat-phrase]');
  if (chat) {
    const text = chat.dataset.chatPhrase;
    closeModal({ force: true });
    if (app.mode === 'host') {
      broadcastChat(0, text);
    } else if (app.mode === 'guest') {
      const ok = app.peerGuest?.sendChat(text);
      if (!ok) toast('连接断开了，消息没发出去', { warm: true });
    }
    tone('tap');
  }
});

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'join-form') return;
  event.preventDefault();
  const code = $('#input-room').value.replace(/\D/g, '').slice(0, 6);
  if (code.length !== 6) {
    $('#join-error').textContent = '请输入六位数字房间号';
    return;
  }
  $('#join-error').textContent = '';
  joinOnlineRoom(code);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && app.modalType) closeModal();
});

/* --------------------------------------------------------------------------
   初始化
   -------------------------------------------------------------------------- */

function init() {
  loadSettings();
  try {
    app.name = localStorage.getItem(STORAGE.name) || '';
  } catch {
    app.name = '';
  }
  const nameInput = $('#input-name');
  if (nameInput) nameInput.value = app.name;
  nameInput?.addEventListener('change', () => getName());

  $('#btn-solo')?.remove();

  $('#btn-create')?.addEventListener('click', () => {
    primeAudio();
    createOnlineRoom();
  });

  $('#btn-show-join')?.addEventListener('click', () => {
    const form = $('#join-form');
    form?.classList.toggle('hidden');
    if (!form?.classList.contains('hidden')) {
      $('#join-error').textContent = '';
      $('#input-room')?.focus();
    }
  });

  $('#btn-home-rules')?.addEventListener('click', openRules);
  $('#btn-settings')?.addEventListener('click', openSettings);
  $('#btn-sound')?.addEventListener('click', () => {
    settings.sound = !settings.sound;
    saveSettings();
    applySettings();
    if (settings.sound) tone('tap');
  });

  $('#btn-lobby-leave')?.addEventListener('click', requestLeave);
  $('#brand-home')?.addEventListener('click', () => {
    if (app.mode) requestLeave();
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('#btn-table-menu')?.addEventListener('click', openTableMenu);
  $('#btn-game-rules')?.addEventListener('click', openRules);
  $('#btn-round-log')?.addEventListener('click', openLiveLog);
  $('#btn-hand-sheet')?.addEventListener('click', renderHandSheet);
  $('#btn-chat')?.addEventListener('click', openChatPicker);
  $('#btn-start')?.addEventListener('click', hostStartGame);

  $('#input-room')?.addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6);
    $('#join-error').textContent = '';
  });

  window.addEventListener('beforeunload', () => {
    clearAITimer();
    try {
      app.peerHost?.close();
    } catch {
      /* ignore */
    }
    try {
      app.peerGuest?.close();
    } catch {
      /* ignore */
    }
  });

  window.addEventListener('popstate', updateHome);
  let resizeTimer = 0;
  const resizeHand = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (app.snapshot?.phase !== 'lobby') renderHand();
    }, 120);
  };
  window.addEventListener('resize', resizeHand);
  window.addEventListener('orientationchange', resizeHand);
  updateHome();
  showScreen('home');
  setConnection(null);
  render();
  document.documentElement.dataset.ready = '1';
}

function requestLeave() {
  const isHost = app.mode === 'host';
  openConfirm({
    title: isHost ? '要关掉这桌吗？' : '要离开牌桌吗？',
    body: isHost
      ? '房主离开后，这桌牌局会结束，牌友会看到“房主已离开”。'
      : '离开后这一局就不能继续了，可以重新输房间号回来。',
    confirmText: isHost ? '关掉牌桌' : '离开牌桌',
    onConfirm: () => {
      goHome();
      toast(isHost ? '牌桌已关闭' : '已离开牌桌');
    }
  });
}

function openTableMenu() {
  const isHost = app.mode === 'host';
  openModal(
    `<p class="modal-eyebrow">牌桌菜单</p>
     <h2>先歇一会儿？</h2>
     <p class="modal-lead">${
       isHost
         ? '牌局会一直保留在当前浏览器里，直到您关掉这桌。'
         : '离开后可以凭房间号重新入座，但牌局不会暂停。'
     }</p>
     <div class="modal-actions">
       <button class="btn btn-cream" type="button" data-action="open-rules">完整规则</button>
       <button class="btn btn-cream" type="button" data-action="close-modal">继续打牌</button>
       <button class="btn btn-primary" type="button" data-action="request-leave">${
         isHost ? '关掉牌桌' : '离开牌桌'
       }</button>
     </div>`,
    { type: 'menu', closeable: true }
  );
}

init();

// 本地联调与自动化测试用的只读句柄；正式部署不暴露。
if (
  ['127.0.0.1', 'localhost', '::1'].includes(window.location.hostname) ||
  new URLSearchParams(window.location.search).has('debug')
) {
  globalThis.__darksy = app;
  globalThis.__darksy.publish = publishHost;
}
