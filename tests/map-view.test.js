import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { emptyMapState } from '../js/map-domain.js';
import { computeMapLayout, curvedMapConnectionPath, mapConnectionPath, mapConnectionPaths, normalizeMapLayoutSpacing, MapperView, wormholeSystemDisplay } from '../js/map-view.js';

test('the jump prompt keeps Map connection enabled for custom signatures', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const submit = html.match(/<button id="map-jump-submit"[^>]*>/)?.[0] || '';
  assert.ok(submit);
  assert.doesNotMatch(submit, /\sdisabled(?:\s|>)/);
  assert.match(html, /data-map-connection-style="pipe"[^>]*>\|<\/button>/);
  assert.match(html, /data-map-connection-style="curve"[^>]*>∿<\/button>/);
  assert.match(html, /id="map-layout-spacing"[^>]*type="range"[^>]*min="0"[^>]*max="100"/);
  assert.match(html, /id="map-layout-vertical-spacing"[^>]*type="range"[^>]*min="0"[^>]*max="100"/);
  const toolbar = html.match(/<div class="map-bottom-toolbar">([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/)?.[1] || '';
  assert.ok(toolbar.indexOf('class="map-legend"') < toolbar.indexOf('class="map-presentation-controls"'));
  assert.ok(toolbar.indexOf('class="map-presentation-controls"') < toolbar.indexOf('class="map-zoom-controls"'));
});

test('map spacing sliders independently blend horizontal and vertical layouts', () => {
  const nodes = [1, 2, 3, 4, 5].map((id) => ({ id }));
  const connections = [
    { from: 1, to: 2 },
    { from: 1, to: 3 },
    { from: 2, to: 4 },
    { from: 4, to: 5 }
  ];
  const compact = computeMapLayout(nodes, connections, 1, 0);
  const middle = computeMapLayout(nodes, connections, 1, 50);
  const expanded = computeMapLayout(nodes, connections, 1, 100);
  const wideAndTight = computeMapLayout(nodes, connections, 1, 100, 0);
  const compactAndTall = computeMapLayout(nodes, connections, 1, 0, 100);
  nodes.forEach(({ id }) => {
    assert.equal(middle.get(id).x, (compact.get(id).x + expanded.get(id).x) / 2);
    assert.equal(middle.get(id).y, (compact.get(id).y + expanded.get(id).y) / 2);
    assert.equal(wideAndTight.get(id).x, expanded.get(id).x);
    assert.equal(wideAndTight.get(id).y, compact.get(id).y);
    assert.equal(compactAndTall.get(id).x, compact.get(id).x);
    assert.equal(compactAndTall.get(id).y, expanded.get(id).y);
  });
  assert.ok(Math.max(...[...compact.values()].map(({ x }) => x)) < Math.max(...[...expanded.values()].map(({ x }) => x)));
  [compact, middle, expanded].forEach((positions) => {
    const levels = new Map();
    positions.forEach(({ depth, x }) => {
      if (!levels.has(depth)) levels.set(depth, []);
      levels.get(depth).push(x);
    });
    levels.forEach((columns) => {
      columns.sort((left, right) => left - right);
      for (let index = 1; index < columns.length; index += 1) {
        assert.ok(columns[index] - columns[index - 1] >= 176);
      }
    });
  });
  assert.equal(normalizeMapLayoutSpacing(-1), 0);
  assert.equal(normalizeMapLayoutSpacing(101), 100);
});

test('wormhole system details format class, type, and ordered static destinations', () => {
  assert.deepEqual(wormholeSystemDisplay({
    name: 'J055520',
    wormhole: { class: 14, effect: 'Red Giant', statics: [
      { code: 'D382', destination: 'C2' },
      { code: 'N110', destination: 'HS' },
      { code: 'Z647', destination: 'C1' }
    ] }
  }), {
    classLabel: 'C14',
    effect: 'Red Giant',
    statics: [
      { code: 'N110', destination: 'HS' },
      { code: 'Z647', destination: 'C1' },
      { code: 'D382', destination: 'C2' }
    ],
    staticLabels: ['HS (N110)', 'C1 (Z647)', 'C2 (D382)'],
    heading: 'J055520 (C14) Red Giant'
  });
  assert.equal(wormholeSystemDisplay({ name: 'J123456', wormhole: { class: 1, effect: '', statics: [{ code: 'Z060', destination: 'NS' }] } }).heading, 'J123456 (C1)');
});

test('map connections use right-angle paths', () => {
  assert.equal(
    mapConnectionPath({ x: 0, y: 0, depth: 0 }, { x: 220, y: 126, depth: 1 }),
    'M 88 72 L 88 99 L 308 99 L 308 126'
  );
  assert.equal(
    mapConnectionPath({ x: 0, y: 0, depth: 0 }, { x: 0, y: 126, depth: 1 }),
    'M 88 72 L 88 126'
  );
  assert.equal(
    mapConnectionPath({ x: 0, y: 126, depth: 1 }, { x: 220, y: 126, depth: 1 }),
    'M 176 162 L 220 162'
  );
});

test('curved connections retain the original committed geometry', () => {
  assert.equal(
    curvedMapConnectionPath({ x: 0, y: 0, depth: 0 }, { x: 220, y: 126, depth: 1 }),
    'M 88 72 C 88 100.08, 308 97.92, 308 126'
  );
  assert.equal(
    curvedMapConnectionPath({ x: 0, y: 126, depth: 1 }, { x: 220, y: 126, depth: 1 }),
    'M 176 162 C 222 162, 174 162, 220 162'
  );
});

test('sibling connections share a Tripwire-style trunk and branch rail', () => {
  const positions = new Map([
    [1, { x: 440, y: 0, depth: 0 }],
    [2, { x: 0, y: 126, depth: 1 }],
    [3, { x: 220, y: 126, depth: 1 }]
  ]);
  const paths = mapConnectionPaths([
    { id: '1:2', from: 1, to: 2 },
    { id: '1:3', from: 1, to: 3 }
  ], positions);
  assert.equal(paths.get('1:2'), 'M 528 72 L 528 99 L 88 99 L 88 126');
  assert.equal(paths.get('1:3'), 'M 528 72 L 528 99 L 308 99 L 308 126');
});

test('wide sibling groups use one centered branch rail without crossings', () => {
  const positions = new Map([
    [1, { x: 605, y: 0, depth: 0 }],
    [2, { x: 110, y: 126, depth: 1 }],
    [3, { x: 660, y: 126, depth: 1 }],
    [4, { x: 1100, y: 126, depth: 1 }]
  ]);
  const paths = mapConnectionPaths([
    { id: '1:2', from: 1, to: 2 },
    { id: '1:3', from: 1, to: 3 },
    { id: '1:4', from: 1, to: 4 }
  ], positions);
  assert.equal(paths.get('1:2'), 'M 693 72 L 693 99 L 198 99 L 198 126');
  assert.equal(paths.get('1:3'), 'M 693 72 L 693 99 L 748 99 L 748 126');
  assert.equal(paths.get('1:4'), 'M 693 72 L 693 99 L 1188 99 L 1188 126');
});

test('the inspector folds connection settings into the matching signature editor', () => {
  const container = { innerHTML: '' };
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: (id) => id === 'map-inspector-content' ? container : null };
  try {
    const systems = new Map([
      [1, { id: 1, name: 'Alpha', regionId: 10, security: -1, wormhole: { class: 1, effect: 'Pulsar', statics: [{ code: 'Z647', destination: 'C1' }, { code: 'N110', destination: 'HS' }] } }],
      [2, { id: 2, name: 'Beta', regionId: 10, security: -1 }]
    ]);
    const view = new MapperView({
      store: {},
      graph: { get: (id) => systems.get(Number(id)), regions: new Map([[10, { name: 'Test Region' }]]) },
      toast: () => {},
      confirmAction: () => true,
      portraitUrl: () => ''
    });
    view.map = {
      ...emptyMapState(),
      nodes: [{ id: 1, name: 'Alpha', alias: '', createdAt: null }],
      selectedSystemId: 1,
      signatures: { 1: [{ id: 'ABC-123', group: 'Wormhole', type: 'Unstable Wormhole', name: 'Unstable Wormhole', updatedAt: null }] },
      connections: [{ id: '1:2', from: 1, to: 2, fromSignature: 'ABC-123', toSignature: '', type: 'K162', life: 'stable', mass: 'stable', size: 'medium' }]
    };
    view.visibleNodes = view.map.nodes;
    assert.equal(view.resolveSignatureReference(1, 'abc'), 'ABC-123');
    assert.equal(view.resolveSignatureReference(1, 'xyz'), 'XYZ');
    view.renderInspector();
    assert.match(container.innerHTML, />Signatures /);
    assert.doesNotMatch(container.innerHTML, />Connections /);
    assert.match(container.innerHTML, /Beta · K162/);
    assert.match(container.innerHTML, /placeholder="Alpha \(C1\) Pulsar"/);
    assert.match(container.innerHTML, /Statics HS \(N110\), C1 \(Z647\)/);
    assert.match(container.innerHTML, /data-map-edit-signature="ABC-123"/);
    assert.doesNotMatch(container.innerHTML, /data-map-signature-edit-form/);

    systems.get(1).wormhole.effect = '';
    view.renderInspector();
    assert.match(container.innerHTML, /placeholder="Alpha \(C1\)"/);
    assert.match(container.innerHTML, /Statics HS \(N110\), C1 \(Z647\)/);

    view.editingSignature = { systemId: 1, id: 'ABC-123' };
    view.renderInspector();
    assert.match(container.innerHTML, /data-map-signature-edit-form="ABC-123"/);
    assert.match(container.innerHTML, /name="group"/);
    assert.match(container.innerHTML, /name="type"/);
    assert.match(container.innerHTML, /name="connectionLife"/);
    assert.match(container.innerHTML, /name="connectionMass"/);
    assert.match(container.innerHTML, /name="connectionSize"/);
    assert.match(container.innerHTML, /name="connectionType"/);
    assert.doesNotMatch(container.innerHTML, />Near sig</);

    view.editingSignature = null;
    view.map.connections[0].fromSignature = '';
    view.renderInspector();
    assert.match(container.innerHTML, /Unassigned exits/);
    assert.match(container.innerHTML, /data-map-connection-field="nearSignature"/);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('map mutations start from the latest cross-tab state', async () => {
  const systems = new Map([
    [1, { id: 1, name: 'Alpha', regionId: 10, security: -1 }],
    [2, { id: 2, name: 'Beta', regionId: 10, security: -1 }]
  ]);
  let storedMap = {
    ...emptyMapState(),
    nodes: [
      { id: 1, name: 'Alpha', alias: '', source: 'manual', createdAt: null, updatedAt: null },
      { id: 2, name: 'Beta', alias: '', source: 'manual', createdAt: null, updatedAt: null }
    ],
    selectedSystemId: 2,
    rootId: 1
  };
  const view = new MapperView({
    store: {
      updateSetting: async (_key, updater) => {
        storedMap = updater(storedMap);
        return storedMap;
      }
    },
    graph: { get: (id) => systems.get(Number(id)), regions: new Map([[10, { name: 'Test Region' }]]) },
    toast: () => {},
    confirmAction: () => true,
    portraitUrl: () => ''
  });
  view.map = {
    ...emptyMapState(),
    nodes: [{ id: 1, name: 'Alpha', alias: '', source: 'manual', createdAt: null, updatedAt: null }],
    selectedSystemId: 1,
    rootId: 1
  };
  view.render = () => {};

  await view.mutate((map) => ({
    ...map,
    nodes: map.nodes.map((node) => node.id === map.selectedSystemId ? { ...node, alias: 'Home' } : node)
  }));

  assert.equal(storedMap.nodes.length, 2);
  assert.equal(storedMap.nodes.find((node) => node.id === 1).alias, 'Home');
  assert.equal(storedMap.nodes.find((node) => node.id === 2).name, 'Beta');
});

test('status refreshes clear offline tracking without observing stale online locations', async () => {
  const systems = new Map([
    [1, { id: 1, name: 'Alpha', adjacent: [] }],
    [3, { id: 3, name: 'Gamma', adjacent: [] }]
  ]);
  let storedMap = {
    ...emptyMapState(),
    nodes: [{ id: 1, name: 'Alpha', alias: '', source: 'tracked', createdAt: null, updatedAt: null }],
    lastLocations: { 99: 1 },
    selectedSystemId: 1,
    rootId: 1
  };
  const view = new MapperView({
    store: {
      updateSetting: async (_key, updater) => {
        storedMap = updater(storedMap);
        return storedMap;
      }
    },
    graph: { get: (id) => systems.get(Number(id)) || null, regions: new Map() },
    toast: () => {},
    confirmAction: () => true,
    portraitUrl: () => ''
  });
  view.map = storedMap;
  view.render = () => {};
  view.renderGraph = () => {};
  view.queueJumpPrompts = () => {};

  await view.observeCharacters([{ id: 99, presence: { online: false }, location: { id: 1 } }], { trackMovements: false });
  assert.deepEqual(storedMap.lastLocations, {});

  await view.observeCharacters([{ id: 99, presence: { online: true }, location: { id: 1 } }], { trackMovements: false });
  assert.deepEqual(storedMap.lastLocations, {});

  await view.observeCharacters([{ id: 99, presence: { online: true }, location: { id: 3 } }]);
  assert.deepEqual(storedMap.nodes.map((node) => node.id), [1, 3]);
  assert.equal(storedMap.connections.length, 0);
  assert.deepEqual(storedMap.lastLocations, { 99: 3 });
});

test('dropping an unassigned signature on a system creates and labels its connection', async () => {
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => callback();
  const systems = new Map([
    [1, { id: 1, name: 'Alpha', regionId: 10, security: -1 }],
    [2, { id: 2, name: 'Beta', regionId: 10, security: -1 }]
  ]);
  let storedMap = {
    ...emptyMapState(),
    nodes: [
      { id: 1, name: 'Alpha', alias: '', source: 'manual', createdAt: null, updatedAt: null },
      { id: 2, name: 'Beta', alias: '', source: 'tracked', createdAt: null, updatedAt: null }
    ],
    signatures: { 1: [{ id: 'OPU-480', group: 'Cosmic Signature', type: '', name: '', updatedAt: null }] },
    rootId: 1,
    selectedSystemId: 1
  };
  const messages = [];
  const view = new MapperView({
    store: {
      updateSetting: async (_key, updater) => {
        storedMap = updater(storedMap);
        return storedMap;
      }
    },
    graph: { get: (id) => systems.get(Number(id)), regions: new Map([[10, { name: 'Test Region' }]]) },
    toast: (message) => messages.push(message),
    confirmAction: () => true,
    portraitUrl: () => ''
  });
  view.map = storedMap;
  view.render = () => {};
  view.fit = () => {};

  try {
    assert.equal(await view.assignSignatureToSystem(1, 'OPU-480', 2), true);
    assert.equal(storedMap.connections.length, 1);
    assert.equal(storedMap.connections[0].from, 1);
    assert.equal(storedMap.connections[0].to, 2);
    assert.equal(storedMap.connections[0].fromSignature, 'OPU-480');
    assert.equal(storedMap.connections[0].source, 'manual');
    assert.equal(storedMap.signatures[1][0].group, 'Wormhole');
    assert.equal(storedMap.nodes.find((node) => node.id === 2).source, 'tracked');
    assert.equal(storedMap.selectedSystemId, 1);
    assert.deepEqual(messages, ['OPU-480 assigned to Beta.']);
  } finally {
    globalThis.requestAnimationFrame = previousAnimationFrame;
  }
});

test('tracked jumps only queue a signature prompt when the origin has a known candidate', () => {
  const view = new MapperView({
    store: {},
    graph: { get: () => null, regions: new Map() },
    toast: () => {},
    confirmAction: () => true,
    portraitUrl: () => ''
  });
  view.map = {
    ...emptyMapState(),
    connections: [{ id: '1:2', from: 1, to: 2, fromSignature: '', toSignature: '', kind: 'wormhole' }],
    signatures: {}
  };
  let showAttempts = 0;
  view.showNextJumpPrompt = () => { showAttempts += 1; };
  const jump = { connectionId: '1:2', from: 1, to: 2, characterId: 42 };

  view.queueJumpPrompts([jump]);
  assert.equal(view.jumpPromptQueue.length, 0);

  view.map.signatures[1] = [{ id: 'OPU-480', group: 'Cosmic Signature', type: '', name: '' }];
  view.queueJumpPrompts([jump]);
  assert.equal(view.jumpPromptQueue.length, 1);
  assert.equal(showAttempts, 2);
});

test('expired connection cleanup is persisted without deleting its systems', async () => {
  const systems = new Map([
    [1, { id: 1, name: 'Alpha', regionId: 10, security: -1 }],
    [2, { id: 2, name: 'Beta', regionId: 10, security: -1 }]
  ]);
  let storedMap = {
    ...emptyMapState(),
    nodes: [
      { id: 1, name: 'Alpha', alias: '', source: 'manual', createdAt: null, updatedAt: null },
      { id: 2, name: 'Beta', alias: '', source: 'manual', createdAt: null, updatedAt: null }
    ],
    connections: [{ id: '1:2', from: 1, to: 2, kind: 'wormhole', fromSignature: 'OLD-123', toSignature: '', life: 'expired', expiresAt: '2000-01-01T00:30:00.000Z', mass: 'stable', size: 'medium' }],
    signatures: { 1: [{ id: 'OLD-123', group: 'Wormhole', type: '', name: '', updatedAt: null }] },
    rootId: 1,
    selectedSystemId: 1
  };
  const messages = [];
  const view = new MapperView({
    store: {
      updateSetting: async (_key, updater) => {
        storedMap = updater(storedMap);
        return storedMap;
      }
    },
    graph: { get: (id) => systems.get(Number(id)), regions: new Map([[10, { name: 'Test Region' }]]) },
    toast: (message) => messages.push(message),
    confirmAction: () => true,
    portraitUrl: () => ''
  });
  view.map = storedMap;

  assert.equal(await view.removeExpiredMapItems({ render: false }), 1);
  assert.equal(storedMap.connections.length, 0);
  assert.deepEqual(storedMap.nodes.map((node) => node.id), [1, 2]);
  assert.deepEqual(storedMap.signatures[1], []);
  assert.deepEqual(messages, ['Wormhole connection expired and was removed.']);
});

test('old stable graph connections expire even when they have no signatures', async () => {
  const systems = new Map([
    [1, { id: 1, name: 'Alpha', regionId: 10, security: -1 }],
    [2, { id: 2, name: 'Beta', regionId: 10, security: -1 }]
  ]);
  let storedMap = {
    ...emptyMapState(),
    nodes: [
      { id: 1, name: 'Alpha', alias: '', source: 'manual', createdAt: null, updatedAt: null },
      { id: 2, name: 'Beta', alias: '', source: 'manual', createdAt: null, updatedAt: null }
    ],
    connections: [{
      id: '1:2',
      from: 1,
      to: 2,
      kind: 'wormhole',
      fromSignature: '',
      toSignature: '',
      life: 'stable',
      expiresAt: null,
      mass: 'stable',
      size: 'medium',
      createdAt: new Date(Date.now() - 47 * 60 * 60 * 1_000).toISOString(),
      updatedAt: null
    }],
    signatures: {},
    rootId: 1,
    selectedSystemId: 1
  };
  const messages = [];
  const view = new MapperView({
    store: {
      updateSetting: async (_key, updater) => {
        storedMap = updater(storedMap);
        return storedMap;
      }
    },
    graph: { get: (id) => systems.get(Number(id)), regions: new Map([[10, { name: 'Test Region' }]]) },
    toast: (message) => messages.push(message),
    confirmAction: () => true,
    portraitUrl: () => ''
  });
  view.map = storedMap;

  assert.equal(await view.removeExpiredMapItems({ render: false }), 1);
  assert.equal(storedMap.connections.length, 0);
  assert.deepEqual(storedMap.nodes.map((node) => node.id), [1, 2]);
  assert.deepEqual(messages, ['Wormhole connection expired and was removed.']);
});

test('expired wormhole signature cleanup persists removal of its connection and opposite signature', async () => {
  const systems = new Map([
    [1, { id: 1, name: 'Alpha', regionId: 10, security: -1 }],
    [2, { id: 2, name: 'Beta', regionId: 10, security: -1 }]
  ]);
  let storedMap = {
    ...emptyMapState(),
    nodes: [
      { id: 1, name: 'Alpha', alias: '', source: 'manual', createdAt: null, updatedAt: null },
      { id: 2, name: 'Beta', alias: '', source: 'manual', createdAt: null, updatedAt: null }
    ],
    connections: [{ id: '1:2', from: 1, to: 2, kind: 'wormhole', fromSignature: 'OLD-123', toSignature: 'NEW-456', life: 'stable', expiresAt: null, mass: 'stable', size: 'medium' }],
    signatures: {
      1: [{ id: 'OLD-123', group: 'Wormhole', type: '', name: '', updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000 - 1_000).toISOString() }],
      2: [{ id: 'NEW-456', group: 'Wormhole', type: '', name: '', updatedAt: new Date().toISOString() }]
    },
    rootId: 1,
    selectedSystemId: 1
  };
  const messages = [];
  const view = new MapperView({
    store: {
      updateSetting: async (_key, updater) => {
        storedMap = updater(storedMap);
        return storedMap;
      }
    },
    graph: { get: (id) => systems.get(Number(id)), regions: new Map([[10, { name: 'Test Region' }]]) },
    toast: (message) => messages.push(message),
    confirmAction: () => true,
    portraitUrl: () => ''
  });
  view.map = storedMap;

  assert.equal(await view.removeExpiredMapItems({ render: false }), 3);
  assert.equal(storedMap.connections.length, 0);
  assert.deepEqual(storedMap.signatures[1], []);
  assert.deepEqual(storedMap.signatures[2], []);
  assert.deepEqual(storedMap.nodes.map((node) => node.id), [1, 2]);
  assert.deepEqual(messages, ['Wormhole connection and 2 signatures expired and were removed.']);
});

test('the line editor updates a wormhole condition', async () => {
  const previousDocument = globalThis.document;
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  const elements = new Map([
    ['map-connection-dialog', { open: false, showModal() { this.open = true; }, close() { this.open = false; } }],
    ['map-connection-title', { textContent: '' }],
    ['map-connection-systems', { textContent: '' }],
    ['map-connection-expiry', { textContent: '' }],
    ['map-connection-life', { value: '', focus() {} }],
    ['map-connection-mass', { value: '' }],
    ['map-connection-size', { value: '' }]
  ]);
  globalThis.document = { getElementById: (id) => elements.get(id) || null };
  globalThis.requestAnimationFrame = (callback) => callback();
  const systems = new Map([
    [1, { id: 1, name: 'Alpha', regionId: 10, security: -1 }],
    [2, { id: 2, name: 'Beta', regionId: 10, security: -1 }]
  ]);
  let storedMap = {
    ...emptyMapState(),
    nodes: [
      { id: 1, name: 'Alpha', alias: '', source: 'manual', createdAt: null, updatedAt: null },
      { id: 2, name: 'Beta', alias: '', source: 'manual', createdAt: null, updatedAt: null }
    ],
    connections: [{ id: '1:2', from: 1, to: 2, kind: 'wormhole', type: '', fromSignature: 'AAA-111', toSignature: '', life: 'stable', mass: 'stable', size: 'medium', source: 'manual', createdAt: null, updatedAt: null }],
    signatures: { 1: [{ id: 'AAA-111', group: 'Wormhole', type: '', name: '', updatedAt: null }] },
    rootId: 1,
    selectedSystemId: 1
  };
  const messages = [];
  const view = new MapperView({
    store: {
      updateSetting: async (_key, updater) => {
        storedMap = updater(storedMap);
        return storedMap;
      }
    },
    graph: { get: (id) => systems.get(Number(id)), regions: new Map([[10, { name: 'Test Region' }]]) },
    toast: (message) => messages.push(message),
    confirmAction: () => true,
    portraitUrl: () => ''
  });
  view.map = storedMap;
  view.render = () => {};

  try {
    assert.equal(view.openConnectionEditor('1:2'), true);
    assert.equal(elements.get('map-connection-systems').textContent, 'Alpha ↔ Beta');
    const beforeSave = Date.now();
    elements.get('map-connection-life').value = 'expired';
    elements.get('map-connection-mass').value = 'critical';
    elements.get('map-connection-size').value = 'large';

    await view.saveConnectionEditor();

    assert.equal(storedMap.connections[0].life, 'expired');
    assert.ok(Date.parse(storedMap.connections[0].expiresAt) >= beforeSave + 30 * 60 * 1_000);
    assert.ok(Date.parse(storedMap.connections[0].expiresAt) <= Date.now() + 30 * 60 * 1_000);
    assert.equal(storedMap.connections[0].mass, 'critical');
    assert.equal(storedMap.connections[0].size, 'large');
    assert.equal(elements.get('map-connection-dialog').open, false);
    assert.deepEqual(messages, ['Wormhole condition updated.']);

    view.openConnectionEditor('1:2');
    await view.deleteConnectionEditor();
    assert.equal(storedMap.connections.length, 0);
    assert.deepEqual(storedMap.signatures[1], []);
    assert.equal(elements.get('map-connection-dialog').open, false);
    assert.deepEqual(messages, ['Wormhole condition updated.', 'Wormhole connection deleted.']);
  } finally {
    globalThis.document = previousDocument;
    globalThis.requestAnimationFrame = previousAnimationFrame;
  }
});
