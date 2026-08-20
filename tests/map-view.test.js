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
