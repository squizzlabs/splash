import assert from 'node:assert/strict';
import test from 'node:test';

import { TabCoordinator } from '../js/tab-coordinator.js';

class FakeBroadcastChannel {
  static channels = new Map();

  constructor(name) {
    this.name = name;
    this.listener = null;
    if (!FakeBroadcastChannel.channels.has(name)) FakeBroadcastChannel.channels.set(name, new Set());
    FakeBroadcastChannel.channels.get(name).add(this);
  }

  addEventListener(type, listener) {
    if (type === 'message') this.listener = listener;
  }

  postMessage(data) {
    FakeBroadcastChannel.channels.get(this.name)?.forEach((channel) => {
      if (channel === this || !channel.listener) return;
      queueMicrotask(() => channel.listener({ data }));
    });
  }

  close() {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

class FakeLockManager {
  constructor() {
    this.queues = new Map();
    this.active = new Set();
  }

  request(name, options, callback) {
    return new Promise((resolve, reject) => {
      const entry = { callback, resolve, reject, granted: false };
      if (!this.queues.has(name)) this.queues.set(name, []);
      this.queues.get(name).push(entry);
      options.signal?.addEventListener('abort', () => {
        if (entry.granted) return;
        const queue = this.queues.get(name);
        const index = queue?.indexOf(entry) ?? -1;
        if (index >= 0) queue.splice(index, 1);
        const error = new Error('Lock request aborted.');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
      this.pump(name);
    });
  }

  pump(name) {
    if (this.active.has(name)) return;
    const entry = this.queues.get(name)?.shift();
    if (!entry) return;
    entry.granted = true;
    this.active.add(name);
    Promise.resolve()
      .then(() => entry.callback({ name }))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.active.delete(name);
        this.pump(name);
      });
  }
}

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for cross-tab state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('one tab owns ESI work while followers use RPC and take over after it closes', async () => {
  const locks = new FakeLockManager();
  const options = {
    navigatorObject: { locks },
    storage: null,
    channelFactory: (name) => new FakeBroadcastChannel(name)
  };
  const first = new TabCoordinator(options);
  const second = new TabCoordinator(options);
  first.setRequestHandler((method, args) => ({ executor: 'first', method, args }));
  second.setRequestHandler((method, args) => ({ executor: 'second', method, args }));

  try {
    first.start();
    second.start();
    await waitUntil(() => Number(first.isLeader) + Number(second.isLeader) === 1);

    const leader = first.isLeader ? first : second;
    const follower = first.isLeader ? second : first;
    const expectedExecutor = first.isLeader ? 'first' : 'second';
    const response = await follower.request('esi:characterLocation', [42]);

    assert.deepEqual(response, {
      executor: expectedExecutor,
      method: 'esi:characterLocation',
      args: [42]
    });
    assert.equal(Number(first.isLeader) + Number(second.isLeader), 1);

    leader.stop();
    await waitUntil(() => follower.isLeader);
    assert.equal(await follower.request('esi:characterOnline', [42]).then((result) => result.executor), expectedExecutor === 'first' ? 'second' : 'first');
  } finally {
    first.stop();
    second.stop();
    FakeBroadcastChannel.channels.clear();
  }
});
