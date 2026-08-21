import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addMapSystem,
  assignConnectionSignature,
  connectedMapSystemIds,
  connectionLifeExpiresAt,
  computeChainLayout,
  emptyMapState,
  fitChainViewport,
  mapRoutingConnections,
  mapWormholeStepsForPath,
  nextMapExpirationAt,
  normalizeMapState,
  observeCharacterMovements,
  parseScannerSignatures,
  preferredMapRoot,
  pruneExpiredConnections,
  pruneExpiredMapItems,
  pruneExpiredSignatures,
  removeMapConnection,
  removeMapSystem,
  updateConnectionCondition,
  updateMapSignature,
  upsertSignatures,
  wormholeSignatureCandidates
} from '../js/map-domain.js';
import { UniverseGraph } from '../js/route-planner.js';

const systems = new Map([
  [1, { id: 1, name: 'Alpha', adjacent: [2] }],
  [2, { id: 2, name: 'Beta', adjacent: [1] }],
  [3, { id: 3, name: 'J123456', adjacent: [] }],
  [4, { id: 4, name: 'J654321', adjacent: [] }]
]);
const graph = { get: (id) => systems.get(Number(id)) || null };
const now = () => '2026-08-20T12:00:00.000Z';

test('map connection style defaults to pipe and preserves the curve option', () => {
  assert.equal(emptyMapState().connectionStyle, 'pipe');
  assert.equal(normalizeMapState({ connectionStyle: 'curve' }, graph).connectionStyle, 'curve');
  assert.equal(normalizeMapState({ connectionStyle: 'unknown' }, graph).connectionStyle, 'pipe');
});

test('manual systems connect to the selected chain node without duplicate edges', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  assert.deepEqual(map.nodes.map((node) => node.id), [1, 3]);
  assert.equal(map.connections.length, 1);
  assert.equal(map.connections[0].id, '1:3');
  assert.equal(map.rootId, 1);
  assert.equal(map.selectedSystemId, 3);
});

test('manually selecting an auto-tracked root pins it against gate-follow replacement', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), { source: 'tracked' }, now).map;
  map = addMapSystem(map, systems.get(1), {}, now).map;
  map = { ...map, lastLocations: { 99: 1 } };
  map = observeCharacterMovements(map, [{ id: 99, presence: { online: true }, location: { id: 2 } }], graph, now).map;
  assert.deepEqual(map.nodes.map((node) => node.id), [1]);
  assert.equal(map.nodes[0].source, 'manual');
});

test('live tracking follows gate travel until a non-gate jump creates a chain connection', () => {
  const online = (id, locationId) => ({ id, presence: { online: true }, location: { id: locationId } });
  let map = observeCharacterMovements(emptyMapState(), [online(99, 1)], graph, now).map;
  assert.deepEqual(map.nodes.map((node) => node.id), [1]);

  map = observeCharacterMovements(map, [online(99, 2)], graph, now).map;
  assert.deepEqual(map.nodes.map((node) => node.id), [2]);
  assert.equal(map.connections.length, 0);

  const result = observeCharacterMovements(map, [online(99, 3)], graph, now);
  assert.deepEqual(result.map.nodes.map((node) => node.id), [2, 3]);
  assert.equal(result.map.connections.length, 1);
  assert.equal(result.changes[0].type, 'connection');
  assert.deepEqual(result.changes[1], {
    type: 'wormhole-jump',
    from: 2,
    to: 3,
    connectionId: '2:3',
    characterId: 99
  });
});

test('returning through an existing wormhole still emits a jump for the unmapped side', () => {
  const online = (locationId) => ({ id: 99, presence: { online: true }, location: { id: locationId } });
  let map = observeCharacterMovements(emptyMapState(), [online(1)], graph, now).map;
  map = observeCharacterMovements(map, [online(3)], graph, now).map;
  const result = observeCharacterMovements(map, [online(1)], graph, now);
  assert.equal(result.map.connections.length, 1);
  assert.deepEqual(result.changes, [{
    type: 'wormhole-jump',
    from: 3,
    to: 1,
    connectionId: '1:3',
    characterId: 99
  }]);
});

test('offline characters do not add to the chain or create a tracking cursor', () => {
  const map = observeCharacterMovements(emptyMapState(), [{ id: 99, presence: { online: false }, location: { id: 3 } }], graph, now).map;
  assert.equal(map.nodes.length, 0);
  assert.deepEqual(map.lastLocations, {});
});

test('an offline observation breaks movement tracking before the pilot reconnects elsewhere', () => {
  const online = (locationId) => ({ id: 99, presence: { online: true }, location: { id: locationId } });
  const offline = (locationId) => ({ id: 99, presence: { online: false }, location: { id: locationId } });
  let map = observeCharacterMovements(emptyMapState(), [online(1)], graph, now).map;

  map = observeCharacterMovements(map, [offline(1)], graph, now).map;
  assert.deepEqual(map.lastLocations, {});

  const result = observeCharacterMovements(map, [online(3)], graph, now);
  assert.deepEqual(result.map.nodes.map((node) => node.id), [1, 3]);
  assert.equal(result.map.connections.length, 0);
  assert.deepEqual(result.map.lastLocations, { 99: 3 });
  assert.deepEqual(result.changes, [{ type: 'system', systemId: 3, characterId: 99 }]);
});

test('removing a system also removes attached connections and signatures', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  map = upsertSignatures(map, 3, [{ id: 'ABC-123', group: 'Wormhole' }], now);
  map = assignConnectionSignature(map, '1:3', 1, 'OUT-456', now);
  map = removeMapSystem(map, 3, now);
  assert.deepEqual(map.nodes.map((node) => node.id), [1]);
  assert.equal(map.connections.length, 0);
  assert.equal(map.signatures[3], undefined);
  assert.deepEqual(map.signatures[1], []);
});

test('removing a connection removes its assigned signatures from both systems', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  map = upsertSignatures(map, 1, [{ id: 'KEP-001', group: 'Data Site' }], now);
  map = assignConnectionSignature(map, '1:3', 1, 'AAA-111', now);
  map = assignConnectionSignature(map, '1:3', 3, 'BBB-222', now);
  map = removeMapConnection(map, '1:3', now);
  assert.equal(map.connections.length, 0);
  assert.deepEqual(map.signatures[1].map((signature) => signature.id), ['KEP-001']);
  assert.deepEqual(map.signatures[3], []);
});

test('connection cleanup preserves a signature still referenced by another connection', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  map = addMapSystem(map, systems.get(4), { connectFrom: 1 }, now).map;
  map = assignConnectionSignature(map, '1:3', 1, 'AAA-111', now);
  map = assignConnectionSignature(map, '1:4', 1, 'AAA-111', now);
  map = removeMapConnection(map, '1:3', now);
  assert.equal(map.connections.length, 1);
  assert.equal(map.signatures[1][0].id, 'AAA-111');
});

test('scanner paste accepts EVE tab-separated rows and ignores unrelated text', () => {
  const parsed = parseScannerSignatures([
    'ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t2.4 AU',
    'not a scanner row',
    'DEF-456\tCosmic Signature\tRelic Site\tRuined Sansha Temple Site\t100.0%'
  ].join('\n'), now);
  assert.deepEqual(parsed.map((signature) => [signature.id, signature.group, signature.type]), [
    ['ABC-123', 'Wormhole', 'Unstable Wormhole'],
    ['DEF-456', 'Relic Site', 'Ruined Sansha Temple Site']
  ]);
});

test('scanner paste reads mapped results and discards strength and distance columns', () => {
  const parsed = parseScannerSignatures([
    'XVB-704\tCosmic Signature\tData Site\tUnsecured Perimeter Transponder Farm \t100.0%\t20.39 AU',
    'CFA-844\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t20.64 AU',
    'AZN-690\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t3.93 AU',
    'THV-835\tCosmic Signature\tGas Site\tToken Perimeter Reservoir\t100.0%\t32.37 AU',
    'DLW-225\tCosmic Signature\tRelic Site\tRuined Angel Monument Site\t100.0%\t1,863 km',
    'OPU-480\tCosmic Signature\t\t\t0.0%\t16.34 AU'
  ].join('\n'), now);

  assert.deepEqual(parsed.map(({ id, group, type, name }) => ({ id, group, type, name })), [
    { id: 'XVB-704', group: 'Data Site', type: 'Unsecured Perimeter Transponder Farm', name: 'Unsecured Perimeter Transponder Farm' },
    { id: 'CFA-844', group: 'Wormhole', type: 'Unstable Wormhole', name: 'Unstable Wormhole' },
    { id: 'AZN-690', group: 'Wormhole', type: 'Unstable Wormhole', name: 'Unstable Wormhole' },
    { id: 'THV-835', group: 'Gas Site', type: 'Token Perimeter Reservoir', name: 'Token Perimeter Reservoir' },
    { id: 'DLW-225', group: 'Relic Site', type: 'Ruined Angel Monument Site', name: 'Ruined Angel Monument Site' },
    { id: 'OPU-480', group: 'Cosmic Signature', type: '', name: '' }
  ]);
  assert.equal(JSON.stringify(parsed).includes('20.39 AU'), false);
  assert.equal(JSON.stringify(parsed).includes('1,863 km'), false);
  assert.equal(JSON.stringify(parsed).includes('100.0%'), false);
});

test('previous unresolved imports migrate from Unknown to Cosmic Signature', () => {
  const map = normalizeMapState({
    nodes: [{ id: 1 }],
    signatures: { 1: [{ id: 'OPU-480', group: 'Unknown', type: '', name: '' }] }
  }, graph);
  assert.equal(map.signatures[1][0].group, 'Cosmic Signature');
});

test('non-wormhole signatures expire three days after they were last seen', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = upsertSignatures(map, 1, [
    { id: 'DAT-001', group: 'Data Site', updatedAt: '2026-08-17T12:00:00.000Z' },
    { id: 'REL-002', group: 'Relic Site', updatedAt: '2026-08-17T12:00:00.001Z' },
    { id: 'WHL-003', group: 'Wormhole', updatedAt: '2026-08-01T00:00:00.000Z' }
  ], now);
  assert.equal(nextMapExpirationAt(map), Date.parse(now()));
  map = pruneExpiredSignatures(map, now);
  assert.deepEqual(map.signatures[1].map((signature) => signature.id), ['REL-002', 'WHL-003']);
});

test('seeing a non-wormhole signature again refreshes its three-day lifetime', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = upsertSignatures(map, 1, [{ id: 'DAT-001', group: 'Data Site', updatedAt: '2026-08-17T11:00:00.000Z' }], now);
  map = upsertSignatures(map, 1, [{ id: 'DAT-001', group: 'Data Site', updatedAt: now() }], now);
  map = pruneExpiredSignatures(map, now);
  assert.equal(map.signatures[1][0].updatedAt, now());
});

test('legacy signatures without an age start their three-day timer on migration', () => {
  const map = pruneExpiredSignatures({
    ...emptyMapState(),
    signatures: { 1: [{ id: 'GAS-001', group: 'Gas Site', type: '', name: '', updatedAt: null }] }
  }, now);
  assert.equal(map.signatures[1][0].updatedAt, now());
});

test('assigned signatures are exempt from the three-day site cleanup', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  map = upsertSignatures(map, 1, [{ id: 'OLD-123', group: 'Cosmic Signature', updatedAt: '2026-08-01T00:00:00.000Z' }], now);
  map = assignConnectionSignature(map, '1:3', 1, 'OLD-123', () => '2026-08-01T00:00:00.000Z');
  map = pruneExpiredMapItems(map, now);
  assert.equal(map.signatures[1][0].id, 'OLD-123');
});

test('editing a signature updates its details and its connection-side reference', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  map = upsertSignatures(map, 1, [{ id: 'ABC-123', group: 'Cosmic Signature' }], now);
  map = assignConnectionSignature(map, '1:3', 1, 'ABC-123', now);
  map = updateMapSignature(map, 1, 'ABC-123', {
    id: 'XYZ-987',
    group: 'Wormhole',
    type: 'Unstable Wormhole',
    name: 'Unstable Wormhole'
  }, now);
  assert.deepEqual(map.signatures[1][0], {
    id: 'XYZ-987',
    group: 'Wormhole',
    type: 'Unstable Wormhole',
    name: 'Unstable Wormhole',
    updatedAt: now()
  });
  assert.equal(map.connections[0].fromSignature, 'XYZ-987');
});

test('wormhole prompt candidates exclude sites and signatures used by other connections', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  map = addMapSystem(map, systems.get(4), { connectFrom: 1 }, now).map;
  map = upsertSignatures(map, 1, [
    { id: 'AAA-111', group: 'Wormhole', type: 'Unstable Wormhole' },
    { id: 'BBB-222', group: 'Wormhole', type: 'Unstable Wormhole' },
    { id: 'DDD-444', group: 'Cosmic Signature', type: '' },
    { id: 'CCC-333', group: 'Data Site', type: 'Unsecured Site' }
  ], now);
  map = assignConnectionSignature(map, '1:3', 1, 'AAA-111', now);
  assert.deepEqual(wormholeSignatureCandidates(map, 1, '1:4').map((signature) => signature.id), ['BBB-222', 'DDD-444']);
});

test('assigning a jump signature labels the correct connection side and records manual IDs', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  map = assignConnectionSignature(map, '1:3', 3, 'xyz-987', now);
  assert.equal(map.connections[0].fromSignature, '');
  assert.equal(map.connections[0].toSignature, 'XYZ-987');
  assert.deepEqual(map.signatures[3][0], {
    id: 'XYZ-987',
    group: 'Wormhole',
    type: '',
    name: '',
    updatedAt: now()
  });
});

test('assigning an existing unresolved signature promotes it to a wormhole', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  map = upsertSignatures(map, 1, [{ id: 'OPU-480', group: 'Cosmic Signature' }], now);
  map = assignConnectionSignature(map, '1:3', 1, 'OPU-480', now);
  assert.equal(map.signatures[1][0].group, 'Wormhole');
  assert.equal(map.connections[0].fromSignature, 'OPU-480');
});

test('a three-letter custom signature can be assigned to a connection', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  map = assignConnectionSignature(map, '1:3', 1, 'opu', now);
  assert.equal(map.connections[0].fromSignature, 'OPU');
  assert.equal(map.signatures[1][0].id, 'OPU');
  assert.equal(map.signatures[1][0].group, 'Wormhole');
});

test('wormhole lifetime changes set and preserve the correct deletion deadlines', () => {
  const base = { life: 'stable', mass: 'stable', size: 'medium', expiresAt: null };
  const underFour = updateConnectionCondition(base, { life: 'under-4h' }, now);
  assert.equal(underFour.expiresAt, '2026-08-20T16:00:00.000Z');
  const massOnly = updateConnectionCondition(underFour, { mass: 'critical' }, () => '2026-08-20T13:00:00.000Z');
  assert.equal(massOnly.expiresAt, underFour.expiresAt);
  const underOne = updateConnectionCondition(massOnly, { life: 'under-1h' }, () => '2026-08-20T13:00:00.000Z');
  assert.equal(underOne.expiresAt, '2026-08-20T14:00:00.000Z');
  const expired = updateConnectionCondition(underOne, { life: 'expired' }, now);
  assert.equal(expired.expiresAt, '2026-08-20T12:30:00.000Z');
  assert.equal(connectionLifeExpiresAt('stable', now), null);
  assert.equal(updateConnectionCondition(expired, { life: 'stable' }, now).expiresAt, null);
});

test('legacy end-of-life connections migrate to the under-four-hour timer', () => {
  const map = normalizeMapState({
    nodes: [{ id: 1 }, { id: 3 }],
    connections: [{ from: 1, to: 3, life: 'eol', updatedAt: now() }]
  }, graph);
  assert.equal(map.connections[0].life, 'under-4h');
  assert.equal(map.connections[0].expiresAt, '2026-08-20T16:00:00.000Z');
});

test('expired deadlines remove the connection and its assigned signature', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  map = assignConnectionSignature(map, '1:3', 1, 'AAA', now);
  map.connections[0] = {
    ...map.connections[0],
    life: 'expired',
    expiresAt: '2026-08-20T12:30:00.000Z'
  };
  assert.deepEqual(mapRoutingConnections(map, graph, now), []);
  const pruned = pruneExpiredConnections(map, () => '2026-08-20T12:30:00.000Z');
  assert.equal(pruned.connections.length, 0);
  assert.deepEqual(pruned.nodes.map((node) => node.id), [1, 3]);
  assert.deepEqual(pruned.signatures[1], []);
});

test('mapped wormholes become direction-specific routing edges and instructions', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  map = assignConnectionSignature(map, '1:3', 1, 'AAA', now);
  map.connections[0] = { ...map.connections[0], type: 'K162', life: 'under-1h', expiresAt: '2026-08-20T13:00:00.000Z', mass: 'reduced', size: 'medium' };

  const forwardOnly = mapRoutingConnections(map, graph, now);
  assert.deepEqual(forwardOnly.map(({ from, to }) => [from.id, to.id]), [[1, 3]]);
  const routingGraph = new UniverseGraph({
    schemaVersion: 1,
    maxGateDistance: 1,
    systems: [
      [1, 'Alpha', -1, 1, 0, 0, 0, []],
      [3, 'J123456', -1, 1, 100, 0, 0, []]
    ]
  });
  assert.deepEqual(routingGraph.astar(1, 3, { preference: 'Shorter', connections: mapRoutingConnections(map, routingGraph, now) }), [1, 3]);
  assert.throws(() => routingGraph.astar(3, 1, { preference: 'Shorter', connections: mapRoutingConnections(map, routingGraph, now) }), /No known route/);
  assert.deepEqual(mapWormholeStepsForPath(map, graph, [systems.get(1), systems.get(3)], now)[0], {
    id: 'map:1:3',
    key: 'wormhole:map:1:3:0:1',
    source: 'map',
    hub: '',
    from: { id: 1, name: 'Alpha' },
    to: { id: 3, name: 'J123456' },
    fromIndex: 0,
    toIndex: 1,
    signatureId: 'AAA',
    destinationSignatureId: '',
    expiresAt: '2026-08-20T13:00:00.000Z',
    maxShipSize: 'medium',
    wormholeType: 'K162',
    life: 'under-1h',
    mass: 'reduced'
  });
  assert.deepEqual(mapWormholeStepsForPath(map, graph, [systems.get(3), systems.get(1)], now), []);

  map = assignConnectionSignature(map, '1:3', 3, 'BBB-222', now);
  assert.deepEqual(mapRoutingConnections(map, graph, now).map(({ from, to }) => [from.id, to.id]), [[1, 3], [3, 1]]);
});

test('chain layout puts the root on top and adjacent branches below', () => {
  const nodes = [{ id: 1 }, { id: 3 }, { id: 4 }];
  const connections = [{ from: 1, to: 3 }, { from: 1, to: 4 }];
  const positions = computeChainLayout(nodes, connections, 1);
  assert.equal(positions.get(1).y, 0);
  assert.equal(positions.get(3).y, 126);
  assert.equal(positions.get(4).y, 126);
  assert.notEqual(positions.get(3).x, positions.get(4).x);
});

test('chain layout keeps each parent centered over a contiguous subtree', () => {
  const nodes = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id }));
  const connections = [
    { from: 1, to: 2 },
    { from: 1, to: 3 },
    { from: 2, to: 4 },
    { from: 3, to: 5 },
    { from: 3, to: 6 },
    { from: 3, to: 7 }
  ];
  const positions = computeChainLayout(nodes, connections, 1);
  assert.equal(positions.get(2).x, positions.get(4).x);
  assert.equal(positions.get(3).x, (positions.get(5).x + positions.get(7).x) / 2);
  assert.ok(positions.get(4).x < positions.get(5).x);
  assert.equal(positions.get(2).parentId, 1);
  assert.equal(positions.get(7).parentId, 3);
});

test('character chain focus excludes disconnected mapped components', () => {
  const visible = connectedMapSystemIds(
    [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    [{ from: 1, to: 3 }, { from: 2, to: 4 }],
    1
  );
  assert.deepEqual([...visible].sort((left, right) => left - right), [1, 3]);
});

test('map fit anchors the root one em from the top and centered', () => {
  const positions = computeChainLayout(
    [{ id: 1 }, { id: 3 }, { id: 4 }],
    [{ from: 1, to: 3 }, { from: 1, to: 4 }],
    1
  );
  const viewport = fitChainViewport(
    positions,
    1,
    { width: 1000, height: 700 },
    { width: 176, height: 72 },
    { topGap: 16 }
  );
  const root = positions.get(1);
  assert.equal(viewport.y + root.y * viewport.scale, 16);
  assert.equal(viewport.x + (root.x + 88) * viewport.scale, 500);
});

test('map fit restores a remembered zoom while retaining the root anchor', () => {
  const positions = computeChainLayout(
    [{ id: 1 }, { id: 3 }, { id: 4 }],
    [{ from: 1, to: 3 }, { from: 1, to: 4 }],
    1
  );
  const viewport = fitChainViewport(
    positions,
    1,
    { width: 1000, height: 700 },
    { width: 176, height: 72 },
    { topGap: 16, preferredScale: 0.82 }
  );
  const root = positions.get(1);
  assert.equal(viewport.scale, 0.82);
  assert.equal(viewport.y + root.y * viewport.scale, 16);
  assert.equal(viewport.x + (root.x + 88) * viewport.scale, 500);
});

test('the tracked root follows its pilot through a wormhole', () => {
  const online = (locationId) => ({ id: 99, presence: { online: true }, location: { id: locationId } });
  let map = observeCharacterMovements(emptyMapState(), [online(1)], graph, now).map;
  map = observeCharacterMovements(map, [online(3)], graph, now).map;
  assert.equal(map.rootId, 3);
  assert.equal(map.selectedSystemId, 3);
  assert.equal(map.connections.length, 1);
});

test('an occupied selected system overrides a stale saved root', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  map = { ...map, rootId: 1, selectedSystemId: 3 };
  const characters = [{ id: 99, presence: { online: true }, location: { id: 3 } }];
  assert.equal(preferredMapRoot(map, characters), 3);
  assert.equal(computeChainLayout(map.nodes, map.connections, preferredMapRoot(map, characters)).get(3).y, 0);
});

test('an occupied saved root remains stable when another pilot is elsewhere', () => {
  let map = addMapSystem(emptyMapState(), systems.get(1), {}, now).map;
  map = addMapSystem(map, systems.get(3), { connectFrom: 1 }, now).map;
  map = { ...map, rootId: 1, selectedSystemId: 4 };
  const characters = [
    { id: 99, presence: { online: true }, location: { id: 1 } },
    { id: 100, presence: { online: true }, location: { id: 3 } }
  ];
  assert.equal(preferredMapRoot(map, characters), 1);
});
