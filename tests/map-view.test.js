import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { emptyMapState } from '../js/map-domain.js';
import { MapperView } from '../js/map-view.js';

test('the jump prompt keeps Map connection enabled for custom signatures', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const submit = html.match(/<button id="map-jump-submit"[^>]*>/)?.[0] || '';
  assert.ok(submit);
  assert.doesNotMatch(submit, /\sdisabled(?:\s|>)/);
});

test('the inspector folds connection settings into the matching signature editor', () => {
  const container = { innerHTML: '' };
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: (id) => id === 'map-inspector-content' ? container : null };
  try {
    const systems = new Map([
      [1, { id: 1, name: 'Alpha', regionId: 10, security: -1 }],
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
    assert.match(container.innerHTML, /data-map-edit-signature="ABC-123"/);
    assert.doesNotMatch(container.innerHTML, /data-map-signature-edit-form/);

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

test('the line editor updates a wormhole condition', async () => {
  const previousDocument = globalThis.document;
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  const elements = new Map([
    ['map-connection-dialog', { open: false, showModal() { this.open = true; }, close() { this.open = false; } }],
    ['map-connection-title', { textContent: '' }],
    ['map-connection-systems', { textContent: '' }],
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
    connections: [{ id: '1:2', from: 1, to: 2, kind: 'wormhole', type: '', fromSignature: '', toSignature: '', life: 'stable', mass: 'stable', size: 'medium', source: 'manual', createdAt: null, updatedAt: null }],
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
    elements.get('map-connection-life').value = 'eol';
    elements.get('map-connection-mass').value = 'critical';
    elements.get('map-connection-size').value = 'large';

    await view.saveConnectionEditor();

    assert.equal(storedMap.connections[0].life, 'eol');
    assert.equal(storedMap.connections[0].mass, 'critical');
    assert.equal(storedMap.connections[0].size, 'large');
    assert.equal(elements.get('map-connection-dialog').open, false);
    assert.deepEqual(messages, ['Wormhole condition updated.']);
  } finally {
    globalThis.document = previousDocument;
    globalThis.requestAnimationFrame = previousAnimationFrame;
  }
});
