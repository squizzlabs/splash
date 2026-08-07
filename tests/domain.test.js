import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { UniverseGraph } from '../js/route-planner.js';
import {
  advanceRouteProgress,
  autopilotStopsFor,
  buildRoute,
  duplicateRoute,
  gateSegmentWaypoints,
  itineraryFor,
  mergeCalculatedLegs,
  parseConnectionLines,
  parseList,
  parseRouteImport,
  nextRouteNavigationAction,
  overrideGameWaypoints,
  remainingRouteWormholes,
  routeDestinationState,
  routeRequestBody,
  routeNavigationStages,
  routeStopSystemIndexes,
  serializeRoutes,
  stopsForCharacter,
  systemSecurityColor
} from '../js/domain.js';

test('system security colors match the zKillboard security palette', () => {
  assert.equal(systemSecurityColor(1), '#2c74e0');
  assert.equal(systemSecurityColor(0.5), '#f3fd82');
  assert.equal(systemSecurityColor(0.4), '#DC6D07');
  assert.equal(systemSecurityColor(0.01), '#722020');
  assert.equal(systemSecurityColor(0), '#8d3264');
  assert.equal(systemSecurityColor(-0.4), '#8d3264');
});

test('specified stops are located in route order even when systems repeat', () => {
  const routeSystems = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 2 }, { id: 4 }];
  const stops = [{ id: 2 }, { systemId: 2 }, { id: 4 }];
  assert.deepEqual(routeStopSystemIndexes(routeSystems, stops), [1, 3, 4]);
});

test('route progress advances without jumping ahead on repeated systems', () => {
  const systems = [{ id: 1 }, { id: 2 }, { id: 1 }, { id: 3 }];
  const start = advanceRouteProgress(systems, 1);
  const unchanged = advanceRouteProgress(systems, 1, start);
  const second = advanceRouteProgress(systems, 2, unchanged);
  const repeated = advanceRouteProgress(systems, 1, second);

  assert.equal(start.systemIndex, 0);
  assert.equal(unchanged.systemIndex, 0);
  assert.equal(second.systemIndex, 1);
  assert.equal(repeated.systemIndex, 2);
});

test('route progress never moves backward when a pilot leaves the path', () => {
  const systems = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const previous = { systemIndex: 1, lastSystemId: 2 };
  const offRoute = advanceRouteProgress(systems, 99, previous);
  const returned = advanceRouteProgress(systems, 3, offRoute);

  assert.equal(offRoute.systemIndex, 1);
  assert.equal(offRoute.onRoute, false);
  assert.equal(returned.systemIndex, 2);
});

const systems = {
  a: { id: 1, name: 'Alpha' },
  b: { id: 2, name: 'Beta' },
  c: { id: 3, name: 'Gamma' },
  d: { id: 4, name: 'Delta' }
};

test('list and connection inputs are normalized', () => {
  assert.deepEqual(parseList('Jita, Amarr\nJita'), ['Jita', 'Amarr']);
  assert.deepEqual(parseConnectionLines('Jita > Perimeter\nAmarr -> Ashab'), [
    { from: 'Jita', to: 'Perimeter' },
    { from: 'Amarr', to: 'Ashab' }
  ]);
  assert.throws(() => parseConnectionLines('Jita'), /From > To/);
});

test('route request matches the current ESI/SDE routing options', () => {
  const body = routeRequestBody({
    preference: 'Safer',
    securityPenalty: 140,
    avoidSystems: [systems.b, systems.b],
    connections: [{ from: systems.a, to: systems.d }]
  });
  assert.deepEqual(body, {
    preference: 'Safer',
    security_penalty: 100,
    avoid_systems: [2],
    connections: [{ from: 1, to: 4 }]
  });
});

test('routing defaults to safest when no preference is supplied', () => {
  assert.equal(routeRequestBody({}).preference, 'Safer');
  const route = buildRoute({ origin: systems.a, stops: [systems.c] });
  assert.equal(route.preference, 'Safer');
  assert.equal(route.overrideGameRouting, false);
  assert.equal(buildRoute({ origin: systems.a, stops: [systems.c], overrideGameRouting: true }).overrideGameRouting, true);
});

test('multi-leg paths merge without repeated boundaries', () => {
  assert.deepEqual(mergeCalculatedLegs([[1, 2, 3], [3, 4], [4, 5]]), [1, 2, 3, 4, 5]);
});

test('dynamic routes support multiple character calculations', () => {
  const route = buildRoute({
    name: 'Form-up',
    originMode: 'character',
    stops: [systems.c],
    assignedCharacterIds: [9001, 9002],
    calculations: [
      { key: '9001', characterId: 9001, origin: systems.a, systems: [systems.a, systems.b, systems.c] },
      { key: '9002', characterId: 9002, origin: systems.d, systems: [systems.d, systems.c] }
    ]
  });
  assert.equal(route.origin, null);
  assert.deepEqual(route.calculations.map((item) => item.jumpCount), [2, 1]);
});

test('route exports retain wormhole hubs and import assignments only for characters on this device', () => {
  const route = buildRoute({
    origin: systems.a,
    stops: [systems.c],
    wormholeHubs: ['thera', 'turnur'],
    overrideGameRouting: true,
    assignedCharacterIds: [9001, 9002]
  });
  assert.equal('destination' in route, false);
  assert.equal('waypoints' in route, false);
  const payload = serializeRoutes([route]);
  const [imported] = parseRouteImport(payload, [], [9002]);
  assert.deepEqual(imported.assignedCharacterIds, [9002]);
  assert.deepEqual(imported.wormholeHubs, ['thera', 'turnur']);
  assert.equal(imported.overrideGameRouting, true);
});

test('duplicated routes start unassigned', () => {
  const route = buildRoute({
    origin: systems.a,
    stops: [systems.c],
    wormholeHubs: ['TURNUR', 'thera', 'invalid'],
    assignedCharacterIds: [9001],
    calculations: [{ key: '9001', characterId: 9001, origin: systems.a, systems: [systems.a, systems.c] }]
  });
  const copy = duplicateRoute(route);
  assert.deepEqual(copy.assignedCharacterIds, []);
  assert.deepEqual(copy.stopAssignments, []);
  assert.deepEqual(copy.calculations, []);
  assert.deepEqual(copy.wormholeHubs, ['thera', 'turnur']);
});

test('coverage routes give every assigned pilot the complete route', () => {
  const route = buildRoute({
    mode: 'coverage',
    coverageArea: { type: 'constellation', id: 20, name: 'Test Pocket' },
    origin: systems.a,
    stops: [systems.a, systems.b, systems.c],
    assignedCharacterIds: [9001, 9002],
    stopAssignments: [{ stopId: systems.b.id, characterIds: [9002] }],
    calculations: [
      {
        key: '9001',
        characterId: 9001,
        origin: systems.a,
        systems: [systems.a, systems.b, systems.c],
        stops: [systems.a, systems.b, systems.c]
      },
      {
        key: '9002',
        characterId: 9002,
        origin: systems.a,
        systems: [systems.a, systems.b, systems.c],
        stops: [systems.b, systems.c]
      }
    ]
  });
  assert.equal('destination' in route, false);
  assert.deepEqual(route.stopAssignments, []);
  assert.deepEqual(stopsForCharacter(route, 9001).map((system) => system.id), [1, 2, 3]);
  assert.deepEqual(stopsForCharacter(route, 9002).map((system) => system.id), [1, 2, 3]);
  assert.deepEqual(autopilotStopsFor(route, 9001).map((system) => system.id), [2, 3]);
  assert.deepEqual(autopilotStopsFor(route, 9002).map((system) => system.id), [2, 3]);
});

test('coverage routes can omit their origin', () => {
  const route = buildRoute({
    mode: 'coverage',
    originMode: 'auto',
    coverageArea: { type: 'region', id: 10, name: 'Test Region' },
    stops: [systems.a, systems.b]
  });
  assert.equal(route.originMode, 'auto');
  assert.equal(route.origin, null);
  assert.equal(route.name, 'Test Region coverage');
});

test('station stops route through their solar system and retain their ESI destination ID', () => {
  const station = {
    id: 60000001,
    name: 'Alpha I - Test Station',
    kind: 'station',
    systemId: systems.a.id,
    systemName: systems.a.name
  };
  const route = buildRoute({ origin: systems.d, stops: [systems.b, station] });
  assert.deepEqual(itineraryFor(route).map((system) => system.id), [4, 2, 1]);
  assert.deepEqual(autopilotStopsFor(route).map((stop) => stop.id), [2, 60000001]);
  assert.equal(route.stops.at(-1).kind, 'station');
});

test('station destinations remain in docking state until the pilot is docked there', () => {
  const station = {
    id: 60000001,
    name: 'Delta I - Test Station',
    kind: 'station',
    systemId: systems.d.id,
    systemName: systems.d.name
  };
  const route = buildRoute({
    origin: systems.a,
    stops: [station],
    assignedCharacterIds: [9001],
    calculations: [{
      key: '9001',
      characterId: 9001,
      origin: systems.a,
      systems: [systems.a, systems.b, systems.c, systems.d]
    }]
  });
  const progress = { systemIndex: 3, onRoute: true };
  const inSystem = {
    id: 9001,
    location: { id: systems.d.id, stop: { ...systems.d, kind: 'system', systemId: systems.d.id, systemName: systems.d.name } }
  };
  const docked = {
    ...inSystem,
    location: { id: systems.d.id, stop: station }
  };

  assert.deepEqual(
    routeDestinationState(route, inSystem, progress),
    { complete: false, docking: true, requiresDocking: true, finalStop: station, finalSystemIndex: 3 }
  );
  assert.deepEqual(
    routeDestinationState(route, docked, progress),
    { complete: true, docking: false, requiresDocking: true, finalStop: station, finalSystemIndex: 3 }
  );
  assert.equal(routeDestinationState(route, docked, { systemIndex: 0 }).complete, false);
});

test('game routing override submits every calculated system and retains station stops in order', () => {
  const station = {
    id: 60000001,
    name: 'Delta I - Test Station',
    kind: 'station',
    systemId: systems.d.id,
    systemName: systems.d.name
  };
  const route = buildRoute({
    origin: systems.a,
    stops: [systems.b, station],
    overrideGameRouting: true,
    assignedCharacterIds: [9001],
    calculations: [{
      key: '9001',
      characterId: 9001,
      origin: systems.a,
      systems: [systems.a, systems.b, systems.c, systems.d]
    }]
  });

  const waypoints = overrideGameWaypoints(route, 9001, { systemIndex: 0 });
  assert.deepEqual(waypoints.map((waypoint) => waypoint.id), [2, 3, 4, 60000001]);
  assert.deepEqual(waypoints.map((waypoint) => waypoint.systemIndex), [1, 2, 3, 3]);
});

test('wormhole navigation stages approach the hole, show its signature, and never waypoint Thera', () => {
  const thera = { id: 31000005, name: 'Thera' };
  const route = buildRoute({
    origin: systems.a,
    stops: [systems.c],
    wormholeHubs: ['thera'],
    assignedCharacterIds: [9001],
    calculations: [{
      key: '9001',
      characterId: 9001,
      origin: systems.a,
      systems: [systems.a, systems.b, thera, systems.c],
      wormholeSteps: [
        {
          id: '10',
          hub: 'thera',
          from: systems.b,
          to: thera,
          fromIndex: 1,
          toIndex: 2,
          signatureId: 'INB-123',
          destinationSignatureId: 'THR-456',
          expiresAt: '2026-08-07T00:00:00.000Z',
          maxShipSize: 'large',
          wormholeType: 'K162'
        },
        {
          id: '11',
          hub: 'thera',
          from: thera,
          to: systems.c,
          fromIndex: 2,
          toIndex: 3,
          signatureId: 'OUT-789',
          destinationSignatureId: 'EXT-012',
          expiresAt: '2026-08-07T00:00:00.000Z',
          maxShipSize: 'large',
          wormholeType: 'E587'
        }
      ]
    }]
  });
  const character = { id: 9001, location: { id: systems.a.id, stop: { id: systems.a.id, kind: 'system' } } };
  const stages = routeNavigationStages(route, character.id);
  assert.deepEqual(stages.map((stage) => [stage.kind, stage.systemIndex]), [
    ['wormhole', 1],
    ['wormhole', 2],
    ['waypoint', 3]
  ]);
  assert.deepEqual(remainingRouteWormholes(route, character.id, { systemIndex: 0 }).map((step) => step.signatureId), ['INB-123', 'OUT-789']);
  assert.deepEqual(remainingRouteWormholes(route, character.id, { systemIndex: 2 }).map((step) => step.signatureId), ['OUT-789']);
  assert.deepEqual(remainingRouteWormholes(route, character.id, { systemIndex: 3 }), []);
  assert.deepEqual(overrideGameWaypoints(route, character.id, { systemIndex: 0 }).map((waypoint) => waypoint.id), [systems.b.id]);
  assert.deepEqual(overrideGameWaypoints(route, character.id, { systemIndex: 1 }), []);
  assert.deepEqual(overrideGameWaypoints(route, character.id, { systemIndex: 2 }), []);
  assert.deepEqual(gateSegmentWaypoints(route, character, { systemIndex: 0, onRoute: true }).map((waypoint) => waypoint.id), [systems.b.id]);

  const approach = nextRouteNavigationAction(route, character, { systemIndex: 0, onRoute: true });
  assert.equal(approach.kind, 'waypoint');
  assert.equal(approach.destination.id, systems.b.id);
  assert.equal(approach.wormhole.signatureId, 'INB-123');

  character.location.id = systems.b.id;
  const firstHole = nextRouteNavigationAction(route, character, { systemIndex: 1, onRoute: true });
  assert.equal(firstHole.kind, 'wormhole');
  assert.equal(firstHole.wormhole.signatureId, 'INB-123');
  assert.deepEqual(gateSegmentWaypoints(route, character, { systemIndex: 1, onRoute: true }), []);

  character.location.id = thera.id;
  const theraHole = nextRouteNavigationAction(route, character, { systemIndex: 2, onRoute: true });
  assert.equal(theraHole.kind, 'wormhole');
  assert.equal(theraHole.wormhole.signatureId, 'OUT-789');
  assert.deepEqual(gateSegmentWaypoints(route, character, { systemIndex: 2, onRoute: true }), []);

  const [imported] = parseRouteImport(serializeRoutes([route]), [], [9001]);
  assert.deepEqual(imported.calculations[0].wormholeSteps.map((step) => step.signatureId), ['INB-123', 'OUT-789']);
});

test('the next regular waypoint is exposed only after the previous one is reached', () => {
  const route = buildRoute({
    origin: systems.a,
    stops: [systems.b, systems.c],
    assignedCharacterIds: [9001],
    calculations: [{ key: '9001', characterId: 9001, origin: systems.a, systems: [systems.a, systems.b, systems.c] }]
  });
  const character = { id: 9001, location: { id: systems.a.id, stop: { id: systems.a.id, kind: 'system' } } };
  assert.equal(nextRouteNavigationAction(route, character, { systemIndex: 0, onRoute: true }).destination.id, systems.b.id);
  character.location = { id: systems.b.id, stop: { id: systems.b.id, kind: 'system' } };
  assert.equal(nextRouteNavigationAction(route, character, { systemIndex: 1, onRoute: true }).destination.id, systems.c.id);
});

test('ordinary route delivery queues every remaining stop in the gate segment', () => {
  const route = buildRoute({
    origin: systems.a,
    stops: [systems.b, systems.c, systems.d],
    assignedCharacterIds: [9001],
    calculations: [{
      key: '9001',
      characterId: 9001,
      origin: systems.a,
      systems: [systems.a, systems.b, systems.c, systems.d]
    }]
  });
  const character = { id: 9001, location: { id: systems.a.id, stop: { id: systems.a.id, kind: 'system' } } };

  assert.deepEqual(
    gateSegmentWaypoints(route, character, { systemIndex: 0, onRoute: true }).map((waypoint) => waypoint.id),
    [systems.b.id, systems.c.id, systems.d.id]
  );
});

test('structure stops route through their solar system and retain their ESI destination ID', () => {
  const structure = {
    id: 1_000_000_000_001,
    name: 'Home Keepstar',
    kind: 'structure',
    systemId: systems.a.id,
    systemName: systems.a.name
  };
  const route = buildRoute({ origin: systems.d, stops: [structure] });
  assert.deepEqual(itineraryFor(route).map((system) => system.id), [4, 1]);
  assert.deepEqual(autopilotStopsFor(route).map((stop) => stop.id), [1_000_000_000_001]);
  assert.equal(route.stops[0].kind, 'structure');
});

test('A* finds the shortest stargate path and honors avoid systems', () => {
  const graph = new UniverseGraph({
    schemaVersion: 1,
    maxGateDistance: 2,
    stations: [[60000001, 'Alpha I - Test Station', 1]],
    systems: [
      [1, 'Alpha', 1, 10, 0, 0, 0, [2, 4]],
      [2, 'Beta', 1, 10, 1, 0, 0, [1, 3]],
      [3, 'Gamma', 1, 10, 2, 0, 0, [2, 4]],
      [4, 'Delta', 1, 10, 0, 1, 0, [1, 3]]
    ]
  });
  assert.deepEqual(graph.astar(1, 3, { preference: 'Shorter' }), [1, 2, 3]);
  assert.deepEqual(graph.astar(1, 3, { preference: 'Shorter', avoidSystems: [systems.b] }), [1, 4, 3]);
  assert.equal(graph.resolve('gamma').id, 3);
  assert.equal(graph.resolveStop('Alpha I - Test Station').systemId, 1);
  assert.equal(graph.searchStops('test station')[0].id, 60000001);
});

test('A* includes custom one-way connections', () => {
  const graph = new UniverseGraph({
    schemaVersion: 1,
    maxGateDistance: 1,
    systems: [
      [1, 'Alpha', 1, 10, 0, 0, 0, [2]],
      [2, 'Beta', 1, 10, 1, 0, 0, [1]],
      [3, 'Gamma', 1, 10, 100, 0, 0, []]
    ]
  });
  assert.deepEqual(graph.astar(1, 3, {
    preference: 'Shorter',
    connections: [{ from: systems.a, to: systems.c }]
  }), [1, 3]);
});

test('coverage visits every target using shortest available legs', () => {
  const graph = new UniverseGraph({
    schemaVersion: 1,
    maxGateDistance: 1,
    regions: [[10, 'Test Region']],
    constellations: [[20, 'Test Pocket', 10]],
    systems: [
      [1, 'Alpha', 1, 10, 0, 0, 0, [2], 20],
      [2, 'Beta', 1, 10, 1, 0, 0, [1, 3, 4], 20],
      [3, 'Gamma', 1, 10, 2, 0, 0, [2], 20],
      [4, 'Delta', 1, 10, 1, 1, 0, [2], 20]
    ]
  });
  assert.equal(graph.resolveArea('Test Region', 'region').id, 10);
  assert.equal(graph.resolveArea('test pocket', 'constellation').id, 20);
  assert.deepEqual(graph.systemsInArea('constellation', 20).map((system) => system.id).sort(), [1, 2, 3, 4]);
  const coverage = graph.calculateCoverage(systems.a, [systems.b, systems.c, systems.d]);
  assert.deepEqual(new Set(coverage.stops.map((system) => system.id)), new Set([2, 3, 4]));
  assert.equal(coverage.systems[0].id, 1);
  const optimized = graph.calculateBestCoverage([systems.a, systems.b, systems.c, systems.d]);
  assert.ok([1, 3, 4].includes(optimized.origin.id));
  assert.equal(optimized.stops.length, 4);
});

test('bundled SDE graph resolves and routes between trade hubs', () => {
  const payload = JSON.parse(fs.readFileSync(new URL('../data/universe.json', import.meta.url), 'utf8'));
  const graph = new UniverseGraph(payload);
  const jita = graph.resolve('Jita');
  const amarr = graph.resolve('Amarr');
  assert.ok(graph.systems.size > 8_000);
  assert.ok(graph.stations.size > 5_000);
  assert.equal(jita.id, 30000142);
  assert.equal(amarr.id, 30002187);
  const jitaStation = graph.resolveStop('Jita IV - Moon 4 - Caldari Navy Assembly Plant');
  assert.equal(jitaStation.id, 60003760);
  assert.equal(jitaStation.systemId, jita.id);
  [
    ['Jita', 30000142, 60003760],
    ['Amarr', 30002187, 60008494],
    ['Rens', 30002510, 60004588],
    ['Dodixie', 30002659, 60011866],
    ['Hek', 30002053, 60015140]
  ].forEach(([query, systemId, stationId]) => {
    const results = graph.searchStops(query, 10);
    assert.deepEqual(results.slice(0, 2).map((result) => result.id), [systemId, stationId]);
    assert.equal(results[1].marketHub, true);
  });
  const path = graph.astar(jita.id, amarr.id, { preference: 'Shorter' });
  assert.equal(path[0], jita.id);
  assert.equal(path.at(-1), amarr.id);
  assert.ok(path.length > 2);
});
