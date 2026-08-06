import test from 'node:test';
import assert from 'node:assert/strict';
import { isCharacterOnline, syncCharacterOnline, syncCharacterPresence, syncOnlineCharacterData } from '../js/presence.js';

test('offline characters never trigger a location request', async () => {
  let locationRequests = 0;
  let shipRequests = 0;
  const character = await syncCharacterPresence({ id: 42, name: 'Offline Pilot' }, {
    getOnline: async () => ({ online: false, lastLogout: '2026-08-05T20:00:00Z' }),
    getLocation: async () => { locationRequests += 1; return { systemId: 30000142 }; },
    getShip: async () => { shipRequests += 1; return { typeId: 670, typeName: 'Capsule' }; },
    resolveSystem: () => ({ id: 30000142, name: 'Jita' })
  }, () => '2026-08-05T21:00:00Z');
  assert.equal(locationRequests, 0);
  assert.equal(shipRequests, 0);
  assert.equal(character.presence.online, false);
  assert.equal(isCharacterOnline(character), false);
});

test('online characters update their location after the presence check', async () => {
  const calls = [];
  const character = await syncCharacterPresence({ id: 43, name: 'Online Pilot' }, {
    getOnline: async () => { calls.push('online'); return { online: true }; },
    getLocation: async () => { calls.push('location'); return { systemId: 30002187 }; },
    getShip: async () => { calls.push('ship'); return { itemId: 99, name: 'Golden Fleet', typeId: 11184, typeName: 'Crusader' }; },
    resolveSystem: () => ({ id: 30002187, name: 'Amarr' })
  }, () => '2026-08-05T21:00:00Z');
  assert.deepEqual(calls, ['online', 'location', 'ship']);
  assert.equal(character.location.name, 'Amarr');
  assert.equal(character.location.stop.kind, 'system');
  assert.equal(character.location.stop.id, 30002187);
  assert.equal(character.ship.typeName, 'Crusader');
  assert.equal(isCharacterOnline(character), true);
});

test('online characters preserve an exact NPC station location', async () => {
  const character = await syncCharacterPresence({ id: 44, name: 'Docked Pilot' }, {
    getOnline: async () => ({ online: true }),
    getLocation: async () => ({ systemId: 30000142, stationId: 60003760, structureId: null }),
    getShip: async () => null,
    resolveSystem: () => ({ id: 30000142, name: 'Jita' }),
    resolveStop: () => ({ id: 60003760, name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant' })
  }, () => '2026-08-05T21:00:00Z');
  assert.deepEqual(character.location.stop, {
    id: 60003760,
    name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
    kind: 'station',
    systemId: 30000142,
    systemName: 'Jita'
  });
});

test('online characters preserve an exact player structure location', async () => {
  const character = await syncCharacterPresence({ id: 45, name: 'Structure Pilot' }, {
    getOnline: async () => ({ online: true }),
    getLocation: async () => ({
      systemId: 30000142,
      stationId: null,
      structureId: 1_000_000_000_001,
      structure: { name: 'Home Keepstar' }
    }),
    getShip: async () => null,
    resolveSystem: () => ({ id: 30000142, name: 'Jita' }),
    resolveStop: () => null
  }, () => '2026-08-05T21:00:00Z');
  assert.deepEqual(character.location.stop, {
    id: 1_000_000_000_001,
    name: 'Home Keepstar',
    kind: 'structure',
    systemId: 30000142,
    systemName: 'Jita'
  });
});

test('online checks do not request location or ship data', async () => {
  const calls = [];
  const character = await syncCharacterOnline({ id: 46, name: 'Status Pilot' }, {
    getOnline: async () => { calls.push('online'); return { online: true }; },
    getLocation: async () => { calls.push('location'); },
    getShip: async () => { calls.push('ship'); }
  }, () => '2026-08-05T21:00:00Z');

  assert.deepEqual(calls, ['online']);
  assert.equal(isCharacterOnline(character), true);
});

test('location refresh uses cached online status and skips offline characters', async () => {
  const calls = [];
  const services = {
    getOnline: async () => { calls.push('online'); return { online: true }; },
    getLocation: async () => { calls.push('location'); return { systemId: 30000142 }; },
    getShip: async () => { calls.push('ship'); return { name: 'Venture', typeName: 'Venture' }; },
    resolveSystem: () => ({ id: 30000142, name: 'Jita' })
  };

  await syncOnlineCharacterData({ id: 47, presence: { online: true } }, services);
  await syncOnlineCharacterData({ id: 48, presence: { online: false } }, services);

  assert.deepEqual(calls, ['location', 'ship']);
});
