import { APP_CONFIG } from './config.js?v=20260826-2';

export const EVE_SCOUT_HUBS = Object.freeze({
  thera: Object.freeze({ id: 31000005, name: 'Thera' }),
  turnur: Object.freeze({ id: 30002086, name: 'Turnur' })
});

export function normalizeWormholeHubs(values) {
  const selected = new Set((Array.isArray(values) ? values : []).map((value) => String(value).trim().toLocaleLowerCase()));
  return Object.keys(EVE_SCOUT_HUBS).filter((hub) => selected.has(hub));
}

export function parseEveScoutSignatures(payload, resolveSystem, now = Date.now()) {
  if (!Array.isArray(payload)) throw new Error('EVE-Scout returned an invalid signature list.');
  const links = [];
  const seen = new Set();

  for (const signature of payload) {
    const hub = String(signature?.out_system_name || '').trim().toLocaleLowerCase();
    const expectedHub = EVE_SCOUT_HUBS[hub];
    const hubId = Number(signature?.out_system_id);
    const destinationId = Number(signature?.in_system_id);
    const expiresAt = Date.parse(signature?.expires_at || '');
    if (!expectedHub || hubId !== expectedHub.id) continue;
    if (signature?.completed !== true || signature?.signature_type !== 'wormhole') continue;
    if (!Number.isSafeInteger(destinationId) || destinationId <= 0 || !Number.isFinite(expiresAt) || expiresAt <= now) continue;
    const hubSystem = resolveSystem(hubId);
    const destination = resolveSystem(destinationId);
    const hubSignature = String(signature.out_signature || '').trim().toUpperCase();
    const destinationSignature = String(signature.in_signature || '').trim().toUpperCase();
    if (!hubSystem || !destination || !hubSignature || !destinationSignature) continue;
    const key = `${hubId}:${destinationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      id: String(signature.id),
      hub,
      hubSystem: { id: Number(hubSystem.id), name: String(hubSystem.name) },
      destination: { id: Number(destination.id), name: String(destination.name) },
      expiresAt: new Date(expiresAt).toISOString(),
      eol: expiresAt - now < 4 * 60 * 60 * 1000,
      maxShipSize: String(signature.max_ship_size || 'unknown'),
      wormholeType: String(signature.wh_type || 'Unknown'),
      hubSignature,
      destinationSignature
    });
  }

  return links.sort((left, right) => left.hub.localeCompare(right.hub) || left.destination.name.localeCompare(right.destination.name));
}

export function wormholeStepsForPath(links, systems) {
  const path = systems || [];
  const pairs = new Map();
  (links || []).forEach((link) => {
    pairs.set(`${link.hubSystem.id}:${link.destination.id}`, { link, outward: true });
    pairs.set(`${link.destination.id}:${link.hubSystem.id}`, { link, outward: false });
  });

  return path.slice(0, -1).flatMap((fromSystem, fromIndex) => {
    const toSystem = path[fromIndex + 1];
    const match = pairs.get(`${Number(fromSystem.id)}:${Number(toSystem.id)}`);
    if (!match) return [];
    const { link, outward } = match;
    return [{
      id: String(link.id),
      key: `wormhole:${link.id}:${fromIndex}:${fromIndex + 1}`,
      hub: link.hub,
      from: { id: Number(fromSystem.id), name: String(fromSystem.name) },
      to: { id: Number(toSystem.id), name: String(toSystem.name) },
      fromIndex,
      toIndex: fromIndex + 1,
      signatureId: outward ? link.hubSignature : link.destinationSignature,
      destinationSignatureId: outward ? link.destinationSignature : link.hubSignature,
      expiresAt: link.expiresAt,
      maxShipSize: link.maxShipSize,
      wormholeType: link.wormholeType
    }];
  });
}

export function connectionsForWormholeHubs(links, hubs, now = Date.now()) {
  const selected = new Set(normalizeWormholeHubs(hubs));
  return (links || []).flatMap((link) => {
    if (!selected.has(link.hub) || Date.parse(link.expiresAt) <= now) return [];
    return [
      { from: link.hubSystem, to: link.destination, wormhole: link },
      { from: link.destination, to: link.hubSystem, wormhole: link }
    ];
  });
}

export class EveScoutClient {
  constructor(fetchImpl = globalThis.fetch) {
    this.fetchImpl = (...args) => fetchImpl.call(globalThis, ...args);
  }

  async connections(resolveSystem, now = Date.now()) {
    const response = await this.fetchImpl(APP_CONFIG.eveScoutSignaturesUrl, {
      headers: { Accept: 'application/json' },
      cache: 'default'
    });
    if (!response.ok) throw new Error(`EVE-Scout connections are unavailable (${response.status}).`);
    const payload = await response.json();
    return {
      links: parseEveScoutSignatures(payload, resolveSystem, now),
      fetchedAt: new Date(now).toISOString(),
      lastInteractionAt: response.headers.get('X-Last-Signaleer-Hub-Interaction') || null
    };
  }
}
