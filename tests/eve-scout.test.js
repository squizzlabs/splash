import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionsForWormholeHubs,
  EveScoutClient,
  normalizeWormholeHubs,
  parseEveScoutSignatures,
  wormholeStepsForPath
} from '../js/eve-scout.js';
import { UniverseGraph } from '../js/route-planner.js';

const systems = new Map([
  [31000005, { id: 31000005, name: 'Thera' }],
  [30002086, { id: 30002086, name: 'Turnur' }],
  [30000142, { id: 30000142, name: 'Jita' }],
  [30002187, { id: 30002187, name: 'Amarr' }]
]);
const resolveSystem = (id) => systems.get(Number(id)) || null;
const now = Date.parse('2026-08-06T12:00:00.000Z');

function signature(overrides = {}) {
  return {
    id: 1,
    completed: true,
    signature_type: 'wormhole',
    out_system_id: 31000005,
    out_system_name: 'Thera',
    in_system_id: 30000142,
    in_system_name: 'Jita',
    out_signature: 'ABC-123',
    in_signature: 'XYZ-987',
    wh_type: 'E587',
    max_ship_size: 'xlarge',
    expires_at: '2026-08-06T18:00:00.000Z',
    ...overrides
  };
}

test('EVE-Scout signatures become active bidirectional hub links', () => {
  const links = parseEveScoutSignatures([
    signature(),
    signature({ id: 2, out_system_id: 30002086, out_system_name: 'Turnur', in_system_id: 30002187 }),
    signature({ id: 3, completed: false }),
    signature({ id: 4, expires_at: '2026-08-06T11:59:59.000Z' })
  ], resolveSystem, now);

  assert.deepEqual(links.map((link) => link.hub), ['thera', 'turnur']);
  assert.deepEqual(connectionsForWormholeHubs(links, ['thera'], now).map((connection) => (
    [connection.from.id, connection.to.id]
  )), [[31000005, 30000142], [30000142, 31000005]]);
});

test('wormhole hub selection is normalized and ordered', () => {
  assert.deepEqual(normalizeWormholeHubs(['TURNUR', 'invalid', 'thera', 'thera']), ['thera', 'turnur']);
});

test('active Thera links are usable as A* shortcuts', () => {
  const graph = new UniverseGraph({
    schemaVersion: 1,
    maxGateDistance: 1,
    systems: [
      [30000142, 'Jita', 0.9, 1, 0, 0, 0, []],
      [31000005, 'Thera', -1, 2, 100, 0, 0, []],
      [30002187, 'Amarr', 1, 1, 200, 0, 0, []]
    ]
  });
  const links = parseEveScoutSignatures([
    signature(),
    signature({ id: 2, in_system_id: 30002187, in_system_name: 'Amarr' })
  ], (id) => graph.get(id), now);

  const path = graph.astar(30000142, 30002187, {
    preference: 'Shorter',
    connections: connectionsForWormholeHubs(links, ['thera'], now)
  });
  assert.deepEqual(path, [30000142, 31000005, 30002187]);
  assert.deepEqual(wormholeStepsForPath(links, path.map((id) => graph.get(id))).map((step) => ({
    from: step.from.name,
    to: step.to.name,
    signatureId: step.signatureId,
    destinationSignatureId: step.destinationSignatureId
  })), [
    { from: 'Jita', to: 'Thera', signatureId: 'XYZ-987', destinationSignatureId: 'ABC-123' },
    { from: 'Thera', to: 'Amarr', signatureId: 'ABC-123', destinationSignatureId: 'XYZ-987' }
  ]);
});

test('EVE-Scout client reads the public freshness header', async () => {
  const browserStyleFetch = function () {
    assert.equal(this, globalThis);
    return Promise.resolve(new Response(JSON.stringify([signature()]), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Last-Signaleer-Hub-Interaction': '2026-08-06T11:55:00.000Z'
      }
    }));
  };
  const client = new EveScoutClient(browserStyleFetch);
  const result = await client.connections(resolveSystem, now);
  assert.equal(result.links.length, 1);
  assert.equal(result.lastInteractionAt, '2026-08-06T11:55:00.000Z');
});
