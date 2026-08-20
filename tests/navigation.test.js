import assert from 'node:assert/strict';
import test from 'node:test';

import { parseViewHash, viewHash } from '../js/navigation.js';

test('view hashes use stable singular route and map URLs', () => {
  assert.equal(viewHash('routes'), '#route');
  assert.equal(viewHash('map'), '#map');
  assert.equal(viewHash('map', 31000005), '#map-31000005');
  assert.equal(viewHash('characters'), '#characters');
  assert.equal(viewHash('settings'), '#settings');
});

test('hash parsing restores a map system and accepts view aliases', () => {
  assert.deepEqual(parseViewHash('#map-31000005'), { view: 'map', systemId: 31000005 });
  assert.deepEqual(parseViewHash('#map'), { view: 'map', systemId: null });
  assert.deepEqual(parseViewHash('#routes'), { view: 'routes', systemId: null });
  assert.deepEqual(parseViewHash('#character'), { view: 'characters', systemId: null });
  assert.deepEqual(parseViewHash('#not-a-view'), { view: 'routes', systemId: null });
});
