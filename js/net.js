/**
 * 点对点联机（WebRTC DataChannel）。
 *
 * 这里没有游戏服务器：房主的浏览器就是牌桌本身，其他牌友直接连到房主。
 * PeerJS 的公共云服务只负责第一次“互相找到”（交换 SDP），随后所有牌局消息
 * 都走浏览器之间的加密 DataChannel。若网络需要中继，PeerJS 提供的 TURN
 * 只转发加密数据，不解析牌局。
 */

export const PROTOCOL_VERSION = 2;
export const ROOM_PREFIX = 'leling-darksy-v1-';

export const PEER_ERRORS = {
  'peer-unavailable': '没有找到这个房间，请核对房间号',
  'unavailable-id': '房间号刚好被占用了，请换一个',
  'browser-incompatible': '这个浏览器不支持点对点连接，请换新版 Chrome、Edge 或 Safari',
  network: '网络好像断开了，请检查网络后再试',
  'server-error': '牵线服务正忙，请稍后再试',
  'socket-error': '网络连接不稳定，请稍后再试',
  'socket-closed': '网络连接已关闭，请刷新页面',
  'ssl-unavailable': '页面需要使用 HTTPS 才能联机',
  'invalid-id': '房间号格式不对',
  'invalid-key': '连接密钥无效',
  'not-open-yet': '连接还没准备好，请稍等'
};

export function friendlyPeerError(error) {
  if (!error) return '网络连接失败，请稍后再试';
  if (typeof error === 'string') return PEER_ERRORS[error] || error;
  return (
    PEER_ERRORS[error.type] ||
    PEER_ERRORS[error.code] ||
    error.message ||
    '网络连接失败，请稍后再试'
  );
}

export function makeRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function hostPeerId(code) {
  return `${ROOM_PREFIX}${code}`;
}

/**
 * 优先国内可用的 STUN，同时保留 PeerJS 公共 TURN。
 * 如自建 PeerServer，可在页面加载前设置 window.__LELING_PEER_OPTIONS__。
 */
export const DEFAULT_PEER_OPTIONS = {
  debug: 0,
  config: {
    sdpSemantics: 'unified-plan',
    iceServers: [
      { urls: 'stun:stun.qq.com:3478' },
      { urls: 'stun:stun.miwifi.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: [
          'turn:eu-0.turn.peerjs.com:3478',
          'turn:us-0.turn.peerjs.com:3478'
        ],
        username: 'peerjs',
        credential: 'peerjsp'
      }
    ]
  }
};

function peerOptions(extra = {}) {
  const injected = globalThis.__LELING_PEER_OPTIONS__;
  return {
    ...DEFAULT_PEER_OPTIONS,
    ...(injected || {}),
    ...extra
  };
}

function getPeerCtor() {
  if (typeof globalThis.Peer !== 'function') {
    throw new Error('PeerJS 没有加载成功，请刷新页面');
  }
  return globalThis.Peer;
}

export class PeerHost {
  constructor({ code, onJoin, onMessage, onLeave, onJoined, onStatus, onError }) {
    this.code = code;
    this.onJoin = onJoin;
    this.onMessage = onMessage;
    this.onLeave = onLeave;
    this.onJoined = onJoined;
    this.onStatus = onStatus;
    this.onError = onError;
    this.peer = null;
    this.connections = new Map(); // peerId -> { conn, seat }
    this.seatConnections = new Map(); // seat -> conn
    this.closed = false;
    this.reconnectTimer = null;
  }

  start() {
    const PeerCtor = getPeerCtor();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          this.peer?.destroy();
        } catch {
          /* ignore */
        }
        reject(new Error('连接牵线服务超时，请检查网络'));
      }, 16000);

      let peer;
      try {
        peer = new PeerCtor(hostPeerId(this.code), peerOptions());
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }
      this.peer = peer;

      peer.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.onStatus?.('online');
        resolve({ peerId: peer.id, code: this.code });
      });

      peer.on('connection', (conn) => this.#handleConnection(conn));

      peer.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const wrapped = new Error(friendlyPeerError(error));
          wrapped.type = error?.type;
          wrapped.code = error?.type;
          reject(wrapped);
          return;
        }
        if (error?.type === 'network' || error?.type === 'socket-error') {
          this.onStatus?.('reconnecting');
          this.#scheduleReconnect();
        }
        this.onError?.(error);
      });

      peer.on('disconnected', () => {
        if (this.closed) return;
        this.onStatus?.('reconnecting');
        this.#scheduleReconnect();
      });

      peer.on('close', () => {
        if (this.closed) return;
        this.onStatus?.('offline');
      });
    });
  }

  #scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || !this.peer || this.peer.destroyed) return;
      try {
        if (this.peer.disconnected) this.peer.reconnect();
      } catch {
        /* ignore */
      }
    }, 2200);
  }

  #handleConnection(conn) {
    let joined = false;
    let seat = null;
    let peerId = conn.peer;

    const rejectJoin = (code, message) => {
      try {
        conn.send({ type: 'error', code, message, protocol: PROTOCOL_VERSION });
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          conn.close();
        } catch {
          /* ignore */
        }
      }, 350);
    };

    // onJoin 允许返回 Promise：房主需要人工审批时，会一直等着房主点头。
    let joining = false;

    conn.on('data', async (data) => {
      if (!data || typeof data !== 'object') return;
      if (!joined) {
        if (joining) return;
        if (data.type !== 'join') {
          rejectJoin('BAD_JOIN', '连接还没准备好，请重新进入房间');
          return;
        }
        if (data.protocol != null && data.protocol !== PROTOCOL_VERSION) {
          rejectJoin('VERSION', '页面版本不一致，请刷新后再试');
          return;
        }
        joining = true;
        let result;
        try {
          result = await this.onJoin?.({
            peerId,
            token: typeof data.token === 'string' ? data.token.slice(0, 80) : '',
            name: data.name,
            conn
          });
        } catch (error) {
          console.error('join handler failed', error);
          result = { ok: false, message: '入座时出了点小问题，请重试' };
        }
        joining = false;
        if (conn.open === false) return;
        if (!result?.ok) {
          rejectJoin(result?.code || 'JOIN_REJECTED', result?.message || '暂时不能入座');
          return;
        }

        joined = true;
        seat = result.seat;
        const previous = this.seatConnections.get(seat);
        if (previous && previous !== conn) {
          try {
            previous.close();
          } catch {
            /* ignore */
          }
        }
        this.connections.set(peerId, { conn, seat });
        this.seatConnections.set(seat, conn);

        try {
          conn.send({
            type: 'welcome',
            seat,
            token: result.token,
            code: this.code,
            protocol: PROTOCOL_VERSION
          });
        } catch {
          rejectJoin('SEND_FAILED', '连接没有建立好，请重试');
          return;
        }
        this.onJoined?.(seat, result);
        this.onStatus?.('online');
        return;
      }

      this.onMessage?.(seat, data);
    });

    conn.on('close', () => {
      if (!joined) return;
      const current = this.seatConnections.get(seat);
      if (current !== conn) return; // 已被新连接替换
      this.seatConnections.delete(seat);
      this.connections.delete(peerId);
      this.onLeave?.(seat, peerId);
      this.onStatus?.(this.seatConnections.size ? 'online' : 'waiting');
    });

    conn.on('error', (error) => {
      console.warn('data connection error', error);
    });
  }

  send(seat, message) {
    const conn = this.seatConnections.get(seat);
    if (!conn) return false;
    if (conn.open) {
      try {
        conn.send(message);
        return true;
      } catch (error) {
        console.warn('send failed', error);
        return false;
      }
    }
    // 刚建立的数据通道偶尔还没来得及把 open 置为 true；
    // 等它打开后补发一次，避免丢掉第一份牌桌状态。
    const timer = setTimeout(() => {
      if (!conn.open) return;
      try {
        conn.send(message);
      } catch {
        /* ignore */
      }
    }, 180);
    conn.on('open', () => {
      clearTimeout(timer);
      if (!conn.open) return;
      try {
        conn.send(message);
      } catch {
        /* ignore */
      }
    });
    return true;
  }

  broadcast(buildForSeat) {
    for (const [seat, conn] of this.seatConnections.entries()) {
      if (!conn?.open) continue;
      try {
        const message = buildForSeat(seat);
        if (message) conn.send(message);
      } catch (error) {
        console.warn('broadcast failed', error);
      }
    }
  }

  get connectedCount() {
    return this.seatConnections.size;
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    for (const conn of this.seatConnections.values()) {
      try {
        conn.send({ type: 'host-left', message: '房主已经离开牌桌' });
        conn.close();
      } catch {
        /* ignore */
      }
    }
    this.seatConnections.clear();
    this.connections.clear();
    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
  }
}

export class PeerGuest {
  constructor({
    code,
    name,
    token,
    onState,
    onChat,
    onToast,
    onPending,
    onClose,
    onStatus,
    onError
  }) {
    this.code = code;
    this.name = name;
    this.token = token;
    this.onState = onState;
    this.onChat = onChat;
    this.onToast = onToast;
    this.onPending = onPending;
    this.onClose = onClose;
    this.onStatus = onStatus;
    this.onError = onError;
    this.peer = null;
    this.conn = null;
    this.seat = null;
    this.closedByUs = false;
    this.joined = false;
  }

  join() {
    const PeerCtor = getPeerCtor();
    return new Promise((resolve, reject) => {
      let settled = false;
      let connectTimer = null;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        this.close();
        reject(error instanceof Error ? error : new Error(friendlyPeerError(error)));
      };
      const succeed = (welcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        this.joined = true;
        this.seat = welcome.seat;
        this.token = welcome.token || this.token;
        this.onStatus?.('online');
        resolve({ seat: welcome.seat, token: this.token, code: welcome.code });
      };

      let peer;
      try {
        peer = new PeerCtor(peerOptions());
      } catch (error) {
        fail(error);
        return;
      }
      this.peer = peer;

      // 房主可能需要人工审批，审批期间把超时放宽，避免房主还没看完就断了。
      const armTimer = (ms) => {
        clearTimeout(connectTimer);
        connectTimer = setTimeout(() => {
          fail(new Error('连接超时，请检查房间号和网络'));
        }, ms);
      };
      armTimer(18000);

      peer.on('open', () => {
        if (settled) return;
        this.onStatus?.('connecting');
        const conn = peer.connect(hostPeerId(this.code), {
          reliable: true,
          serialization: 'json'
        });
        this.conn = conn;

        conn.on('open', () => {
          try {
            conn.send({
              type: 'join',
              name: this.name,
              token: this.token,
              protocol: PROTOCOL_VERSION
            });
          } catch (error) {
            fail(error);
          }
        });

        conn.on('data', (data) => {
          if (!data || typeof data !== 'object') return;
          if (data.type === 'pending') {
            this.onPending?.(data.message || '正在等房主确认');
            armTimer(90000);
            return;
          }
          if (data.type === 'welcome') {
            succeed(data);
            // 欢迎包和第一份牌桌状态之间可能存在极短的竞态，主动要一次状态。
            setTimeout(() => {
              try {
                if (conn.open) conn.send({ type: 'sync', protocol: PROTOCOL_VERSION });
              } catch {
                /* ignore */
              }
            }, 120);
            return;
          }
          if (data.type === 'state') {
            this.onState?.(data.state);
            return;
          }
          if (data.type === 'chat') {
            this.onChat?.(data);
            return;
          }
          if (data.type === 'toast') {
            this.onToast?.(data.message);
            return;
          }
          if (data.type === 'error') {
            if (!this.joined) {
              fail(new Error(data.message || '不能进入这个房间'));
            } else {
              this.onError?.(new Error(data.message || '操作没有成功'));
            }
            return;
          }
          if (data.type === 'host-left') {
            this.closedByUs = true;
            this.onClose?.({ hostLeft: true, message: data.message || '房主已经离开牌桌' });
            this.close();
          }
        });

        conn.on('close', () => {
          if (this.closedByUs) return;
          this.onStatus?.('offline');
          if (!settled) {
            fail(new Error('连接被关闭了，请重试'));
          } else {
            this.onClose?.({ hostLeft: false, message: '和牌桌的连接断开了' });
          }
        });

        conn.on('error', (error) => {
          if (!settled) fail(error);
          else this.onError?.(error);
        });
      });

      peer.on('error', (error) => {
        const message = friendlyPeerError(error);
        if (!settled) {
          fail(new Error(message));
          return;
        }
        if (error?.type === 'network' || error?.type === 'socket-error') {
          this.onStatus?.('reconnecting');
        }
        this.onError?.(new Error(message));
      });

      peer.on('disconnected', () => {
        if (this.closedByUs) return;
        this.onStatus?.('reconnecting');
      });
    });
  }

  sendAction(action) {
    if (!this.conn?.open) return false;
    try {
      this.conn.send({ type: 'action', action, protocol: PROTOCOL_VERSION });
      return true;
    } catch {
      return false;
    }
  }

  sendChat(text) {
    if (!this.conn?.open) return false;
    try {
      this.conn.send({ type: 'chat', text, protocol: PROTOCOL_VERSION });
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.closedByUs = true;
    try {
      this.conn?.close();
    } catch {
      /* ignore */
    }
    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.conn = null;
    this.peer = null;
  }
}
