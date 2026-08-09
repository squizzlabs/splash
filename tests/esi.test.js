import test from 'node:test';
import assert from 'node:assert/strict';
import { ESIClient, isValidEveIssuer, userAgentForHostname } from '../js/esi.js';

test('ESI user agent identifies the active deployment', () => {
  assert.equal(userAgentForHostname('localhost'), 'Splash / http://localhost:59832 / Squizz Caphinator');
  assert.equal(userAgentForHostname('127.0.0.1'), 'Splash / http://localhost:59832 / Squizz Caphinator');
  assert.equal(userAgentForHostname('splash.zzeve.com'), 'Splash / https://splash.zzeve.com / Squizz Caphinator');
});

test('EVE issuer validation accepts canonical trailing-slash variants', () => {
  assert.equal(isValidEveIssuer('https://login.eveonline.com', 'https://login.eveonline.com/'), true);
  assert.equal(isValidEveIssuer('https://login.eveonline.com/', 'https://login.eveonline.com'), true);
  assert.equal(isValidEveIssuer('login.eveonline.com', 'https://login.eveonline.com'), true);
});

test('EVE issuer validation rejects other hosts and paths', () => {
  assert.equal(isValidEveIssuer('https://example.com/', 'https://login.eveonline.com'), false);
  assert.equal(isValidEveIssuer('https://login.eveonline.com/other', 'https://login.eveonline.com'), false);
});

test('character location retains station and structure identifiers', async () => {
  const cached = [];
  const client = new ESIClient({
    get: async () => null,
    put: async (_store, value) => cached.push(value)
  });
  client.request = async (path) => {
    if (path.includes('/location')) {
      return { data: { solar_system_id: 30000142, structure_id: 1_000_000_000_001 } };
    }
    return { data: { name: 'Home Keepstar', solar_system_id: 30000142, type_id: 35834, owner_id: 98_000_001 } };
  };
  const location = await client.characterLocation(42);
  assert.equal(location.systemId, 30000142);
  assert.equal(location.stationId, null);
  assert.equal(location.structureId, 1_000_000_000_001);
  assert.equal(location.structure.name, 'Home Keepstar');
  assert.equal(cached[0].structureId, 1_000_000_000_001);
});

test('character ship retains its name separately from its hull type', async () => {
  const client = new ESIClient({
    get: async () => null,
    put: async () => undefined
  });
  client.request = async () => ({
    data: {
      ship_item_id: 123456,
      ship_name: 'Unscheduled Detonation',
      ship_type_id: 32880
    }
  });
  client.typeName = async () => 'Venture';

  const ship = await client.characterShip(42);

  assert.equal(ship.name, 'Unscheduled Detonation');
  assert.equal(ship.typeName, 'Venture');
});

test('character online checks bypass the browser response cache', async () => {
  const client = new ESIClient({
    get: async () => null,
    put: async () => undefined
  });
  let requestOptions;
  client.request = async (_path, options) => {
    requestOptions = options;
    return { data: { online: true, logins: 3 } };
  };

  const presence = await client.characterOnline(42);

  assert.equal(requestOptions.cache, 'no-store');
  assert.equal(presence.online, true);
});

test('setting the current location as a waypoint clears existing waypoints', async () => {
  const client = new ESIClient({
    get: async () => null,
    put: async () => undefined
  });
  let requestPath;
  let requestOptions;
  client.request = async (path, options) => {
    requestPath = path;
    requestOptions = options;
    return { data: null };
  };

  await client.setWaypoint(42, 60003760, true);

  const query = new URL(requestPath, 'https://esi.evetech.net').searchParams;
  assert.equal(query.get('destination_id'), '60003760');
  assert.equal(query.get('clear_other_waypoints'), 'true');
  assert.equal(requestOptions.method, 'POST');
  assert.equal(requestOptions.characterId, 42);
});

test('setting an exact route clears once and appends every waypoint in order', async () => {
  const client = new ESIClient({
    get: async () => null,
    put: async () => undefined
  });
  const requests = [];
  client.request = async (path, options) => {
    requests.push({ path, options });
    return { data: null };
  };

  await client.setWaypoints(42, [30000142, 30000144, 60003760], true);

  const queries = requests.map(({ path }) => new URL(path, 'https://esi.evetech.net').searchParams);
  assert.deepEqual(queries.map((query) => query.get('destination_id')), ['30000142', '30000144', '60003760']);
  assert.deepEqual(queries.map((query) => query.get('clear_other_waypoints')), ['true', 'false', 'false']);
  assert.ok(requests.every(({ options }) => options.method === 'POST' && options.characterId === 42));
});
