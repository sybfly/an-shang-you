import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerGuest, PeerHost } from '../js/net.js';

/* --------------------------------------------------------------------------
   用一个最小的假 PeerJS，把「房主 + 客人」的握手跑通。
   重点验证：onJoin 返回 Promise 时会被等待，审批期间客人能收到 pending。
   -------------------------------------------------------------------------- */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let seq = 0;
const peers = new Map();

class FakeConn {
  constructor(remotePeerId) {
    this.peer = remotePeerId;
    this.remote = null;
    this.open = false;
    this.handlers = {};
  }

  on(event, cb) {
    (this.handlers[event] ||= []).push(cb);
    return this;
  }

  emit(event, ...args) {
    for (const cb of [...(this.handlers[event] || [])]) cb(...args);
  }

  send(message) {
    if (!this.open) throw new Error('connection is not open');
    const target = this.remote;
    setTimeout(() => {
      if (target?.open) target.emit('data', message);
    }, 0);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    const target = this.remote;
    this.remote = null;
    this.emit('close');
    if (target) {
      target.remote = null;
      target.open = false;
      target.emit('close');
    }
  }
}

function pair(guestPeer, hostPeer) {
  const guestConn = new FakeConn(hostPeer.id);
  const hostConn = new FakeConn(guestPeer.id);
  guestConn.remote = hostConn;
  hostConn.remote = guestConn;
  setTimeout(() => {
    guestConn.open = true;
    hostConn.open = true;
    guestConn.emit('open');
    hostConn.emit('open');
  }, 0);
  return [guestConn, hostConn];
}

class FakePeer {
  constructor(id) {
    this.id = id || `fake-guest-${++seq}`;
    this.handlers = {};
    this.destroyed = false;
    if (id) peers.set(id, this);
    setTimeout(() => this.emit('open'), 0);
  }

  on(event, cb) {
    (this.handlers[event] ||= []).push(cb);
    return this;
  }

  emit(event, ...args) {
    for (const cb of [...(this.handlers[event] || [])]) cb(...args);
  }

  connect(id) {
    const host = peers.get(id);
    if (!host) {
      setTimeout(() => this.emit('error', { type: 'peer-unavailable' }), 0);
      throw new Error('peer-unavailable');
    }
    const [guestConn, hostConn] = pair(this, host);
    setTimeout(() => host.emit('connection', hostConn), 0);
    return guestConn;
  }

  destroy() {
    this.destroyed = true;
    if (this.id) peers.delete(this.id);
  }

  get disconnected() {
    return false;
  }

  reconnect() {}
}

globalThis.Peer = FakePeer;

function makeHost(onJoin, extra = {}) {
  return new PeerHost({
    code: '123456',
    onJoin,
    onMessage: () => {},
    onLeave: () => {},
    onJoined: () => {},
    onStatus: () => {},
    onError: () => {},
    ...extra
  });
}

function makeGuest(options = {}) {
  return new PeerGuest({
    code: '123456',
    name: '牌友一',
    token: 'tok-1',
    onState: () => {},
    onChat: () => {},
    onToast: () => {},
    onClose: () => {},
    onStatus: () => {},
    onError: () => {},
    ...options
  });
}

test('异步审批：房主点头之后客人才入座', async () => {
  let joinCalledAt = 0;
  let resolvedAt = 0;
  const host = makeHost(async () => {
    joinCalledAt = Date.now();
    await delay(40);
    resolvedAt = Date.now();
    return { ok: true, seat: 1, token: 'tok-1', reconnected: false, name: '牌友一' };
  });

  await host.start();
  const guest = makeGuest();
  const welcome = await guest.join();

  assert.equal(welcome.seat, 1);
  assert.ok(joinCalledAt > 0, 'onJoin 应该被调用');
  assert.ok(resolvedAt - joinCalledAt >= 30, '欢迎包要等审批结束才发');
  assert.equal(host.connectedCount, 1);

  guest.close();
  host.close();
});

test('审批期间客人会收到 pending 提示', async () => {
  const seen = [];
  const host = makeHost(async ({ conn }) => {
    conn.send({ type: 'pending', message: '房主正在确认你的座位' });
    await delay(30);
    return { ok: true, seat: 2, token: 'tok-2', reconnected: false, name: '牌友一' };
  });

  await host.start();
  const guest = makeGuest({
    onPending: (message) => seen.push(message)
  });
  const welcome = await guest.join();

  assert.deepEqual(seen, ['房主正在确认你的座位']);
  assert.equal(welcome.seat, 2);

  guest.close();
  host.close();
});

test('房主拒绝时，客人拿到明确的错误', async () => {
  const host = makeHost(async () => ({
    ok: false,
    code: 'HOST_DENIED',
    message: '房主没有同意这次入座'
  }));

  await host.start();
  const guest = makeGuest();

  await assert.rejects(() => guest.join(), /房主没有同意这次入座/);
  assert.equal(host.connectedCount, 0);

  host.close();
});

test('房主直接抛错也不会把连接卡死', async () => {
  const host = makeHost(async () => {
    throw new Error('boom');
  });

  await host.start();
  const guest = makeGuest();

  // net.js 会把异常打出来，这里屏蔽掉，免得测试输出里混进预期内的报错。
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(() => guest.join(), /入座时出了点小问题/);
  } finally {
    console.error = originalError;
  }
  assert.equal(host.connectedCount, 0);

  host.close();
});
