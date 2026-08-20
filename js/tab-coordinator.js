const DEFAULT_CHANNEL = 'splash:tabs:v1';
const DEFAULT_LOCK = 'splash:esi-leader:v1';
const LEADER_TTL_MS = 5_000;

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorPayload(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    status: Number(error?.status || 0),
    payload: error?.payload ?? null
  };
}

export class TabCoordinator {
  constructor({
    channelName = DEFAULT_CHANNEL,
    lockName = DEFAULT_LOCK,
    navigatorObject = globalThis.navigator,
    storage = globalThis.localStorage,
    channelFactory = typeof globalThis.BroadcastChannel === 'function'
      ? (name) => new globalThis.BroadcastChannel(name)
      : null
  } = {}) {
    this.id = makeId();
    this.channelName = channelName;
    this.lockName = lockName;
    this.navigator = navigatorObject;
    this.storage = storage;
    this.channelFactory = channelFactory;
    this.channel = null;
    this.running = false;
    this.isLeader = false;
    this.leaderId = null;
    this.leaderSeenAt = 0;
    this.handler = null;
    this.leadershipListeners = new Set();
    this.pending = new Map();
    this.heartbeatTimer = null;
    this.leaseTimer = null;
    this.releaseLock = null;
    this.lockAbort = null;
  }

  setRequestHandler(handler) {
    this.handler = handler;
  }

  onLeadershipChange(listener) {
    if (typeof listener !== 'function') return () => {};
    this.leadershipListeners.add(listener);
    return () => this.leadershipListeners.delete(listener);
  }

  setLeader(value) {
    const next = Boolean(value);
    if (this.isLeader === next) return;
    this.isLeader = next;
    if (next) {
      this.leaderId = this.id;
      this.leaderSeenAt = Date.now();
      this.announceLeader();
    }
    this.leadershipListeners.forEach((listener) => listener(next));
  }

  post(message) {
    this.channel?.postMessage({ ...message, sourceId: this.id });
  }

  announceLeader() {
    if (!this.isLeader) return;
    this.leaderSeenAt = Date.now();
    this.post({ type: 'leader', leaderId: this.id, sentAt: this.leaderSeenAt });
  }

  start() {
    if (this.running) return;
    this.running = true;
    if (this.channelFactory) {
      this.channel = this.channelFactory(this.channelName);
      this.channel.addEventListener('message', (event) => this.handleMessage(event.data));
    }
    this.heartbeatTimer = globalThis.setInterval(() => {
      if (this.isLeader) this.announceLeader();
      else if (this.leaderSeenAt < Date.now() - LEADER_TTL_MS) this.post({ type: 'leader-query' });
    }, 1_500);
    this.post({ type: 'leader-query' });
    if (this.navigator?.locks?.request) this.startWebLockElection();
    else this.startLeaseElection();
  }

  startWebLockElection() {
    this.lockAbort = new AbortController();
    this.navigator.locks.request(this.lockName, {
      mode: 'exclusive',
      signal: this.lockAbort.signal
    }, async () => {
      if (!this.running) return;
      this.setLeader(true);
      await new Promise((resolve) => { this.releaseLock = resolve; });
      this.releaseLock = null;
      this.setLeader(false);
    }).catch((error) => {
      if (error?.name !== 'AbortError') console.warn('Cross-tab ESI leader election failed:', error);
    });
  }

  leaseRecord() {
    try {
      return JSON.parse(this.storage?.getItem(this.lockName) || 'null');
    } catch (_) {
      return null;
    }
  }

  startLeaseElection() {
    const updateLease = () => {
      if (!this.running || !this.storage) return;
      const now = Date.now();
      const current = this.leaseRecord();
      if (!current || current.expiresAt <= now || current.ownerId === this.id) {
        const candidate = { ownerId: this.id, expiresAt: now + LEADER_TTL_MS };
        this.storage.setItem(this.lockName, JSON.stringify(candidate));
        const confirmed = this.leaseRecord();
        this.setLeader(confirmed?.ownerId === this.id);
        return;
      }
      this.leaderId = current.ownerId;
      this.leaderSeenAt = now;
      this.setLeader(false);
    };
    updateLease();
    this.leaseTimer = globalThis.setInterval(updateLease, 1_500);
  }

  async handleMessage(message) {
    if (!message || message.sourceId === this.id) return;
    if (message.type === 'leader-query') {
      this.announceLeader();
      return;
    }
    if (message.type === 'leader') {
      this.leaderId = message.leaderId;
      this.leaderSeenAt = Date.now();
      return;
    }
    if (message.type === 'leader-releasing' && message.leaderId === this.leaderId) {
      this.leaderId = null;
      this.leaderSeenAt = 0;
      this.post({ type: 'leader-query' });
      return;
    }
    if (message.type === 'rpc-request') {
      if (!this.isLeader || !this.handler) return;
      try {
        const result = await this.handler(message.method, message.args || []);
        this.post({ type: 'rpc-response', targetId: message.sourceId, requestId: message.requestId, result });
      } catch (error) {
        this.post({ type: 'rpc-response', targetId: message.sourceId, requestId: message.requestId, error: errorPayload(error) });
      }
      return;
    }
    if (message.type !== 'rpc-response' || message.targetId !== this.id) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    globalThis.clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(message.error.message);
      error.name = message.error.name;
      error.status = message.error.status;
      error.payload = message.error.payload;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  async waitForLeader(timeoutMs = 3_000) {
    if (this.isLeader || (this.leaderId && this.leaderSeenAt > Date.now() - LEADER_TTL_MS)) return;
    this.post({ type: 'leader-query' });
    await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = globalThis.setInterval(() => {
        if (this.isLeader || (this.leaderId && this.leaderSeenAt > Date.now() - LEADER_TTL_MS)) {
          globalThis.clearInterval(timer);
          resolve();
        } else if (Date.now() - startedAt >= timeoutMs) {
          globalThis.clearInterval(timer);
          reject(new Error('No active Splash tab is available to execute ESI requests.'));
        }
      }, 50);
    });
  }

  async request(method, args = [], { timeoutMs = 90_000 } = {}) {
    if (!this.running) throw new Error('Cross-tab ESI coordination has not started.');
    if (this.isLeader) {
      if (!this.handler) throw new Error('The ESI leader is not ready.');
      return this.handler(method, args);
    }
    await this.waitForLeader();
    if (this.isLeader) return this.handler(method, args);
    const requestId = makeId();
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('The ESI leader tab did not respond.'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.post({ type: 'rpc-request', requestId, method, args });
    });
  }

  stop() {
    if (!this.running) return;
    if (this.isLeader) this.post({ type: 'leader-releasing', leaderId: this.id });
    this.running = false;
    this.releaseLock?.();
    this.lockAbort?.abort();
    globalThis.clearInterval(this.heartbeatTimer);
    globalThis.clearInterval(this.leaseTimer);
    if (this.isLeader && this.storage && !this.navigator?.locks?.request) {
      const lease = this.leaseRecord();
      if (lease?.ownerId === this.id) this.storage.removeItem(this.lockName);
    }
    this.setLeader(false);
    this.channel?.close();
    this.channel = null;
    this.pending.forEach(({ reject, timer }) => {
      globalThis.clearTimeout(timer);
      reject(new Error('This Splash tab closed before the ESI request completed.'));
    });
    this.pending.clear();
  }
}
