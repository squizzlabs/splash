import { normalizeWormholeHubs } from './eve-scout.js';

export const ROUTE_STATUSES = Object.freeze(['draft', 'ready', 'archived']);
export const ROUTE_PREFERENCES = Object.freeze(['Shorter', 'Safer', 'LessSecure']);
const ROUTE_EXPORT_KIND = 'splash-routes';
const LEGACY_ROUTE_EXPORT_KIND = ['just', 'the', 'trip', 'routes'].join('-');
const SECURITY_COLORS = Object.freeze({
  '1.0': '#2c74e0',
  '0.9': '#3a9aeb',
  '0.8': '#4ecef8',
  '0.7': '#60d9a3',
  '0.6': '#71e554',
  '0.5': '#f3fd82',
  '0.4': '#DC6D07',
  '0.3': '#ce440f',
  '0.2': '#bc1117',
  '0.1': '#722020'
});

export function systemSecurityColor(security) {
  const value = Number(security);
  if (!Number.isFinite(value)) return '#8d3264';
  let rounded = Math.round((value + Number.EPSILON) * 10) / 10;
  if (rounded === 0 && value > 0) rounded = 0.1;
  return SECURITY_COLORS[rounded.toFixed(1)] || '#8d3264';
}

function fallbackId() {
  return `route-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeId() {
  return globalThis.crypto?.randomUUID?.() || fallbackId();
}

const HTML_TEXT_ENTITIES = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"'
});

export function decodeHtmlEntities(value) {
  let decoded = String(value ?? '');
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (match, decimal, hexadecimal, named) => {
      if (named) return HTML_TEXT_ENTITIES[named.toLowerCase()] ?? match;
      const codePoint = Number.parseInt(decimal || hexadecimal, decimal ? 10 : 16);
      if (!Number.isSafeInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return match;
      }
      return String.fromCodePoint(codePoint);
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

export function normalizeRouteText(route) {
  return {
    ...route,
    name: decodeHtmlEntities(route?.name),
    notes: decodeHtmlEntities(route?.notes)
  };
}

export function parseList(value) {
  return [...new Set(
    String(value || '')
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  )];
}

export function parseConnectionLines(value) {
  return String(value || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parts = line.split(/\s*(?:->|>|→)\s*/).map((part) => part.trim()).filter(Boolean);
      if (parts.length !== 2) {
        throw new Error(`Connection ${index + 1} must look like “From > To”.`);
      }
      return { from: parts[0], to: parts[1] };
    });
}

export function normalizeSystem(system, label = 'system') {
  const id = Number(system?.id ?? system?.system_id);
  const name = String(system?.name || '').trim();
  if (!Number.isSafeInteger(id) || id <= 0 || !name) {
    throw new Error(`The ${label} is not a valid EVE solar system.`);
  }
  return { id, name };
}

export function normalizeStop(stop, label = 'stop') {
  const id = Number(stop?.id);
  const name = String(stop?.name || '').trim();
  const kind = stop?.kind === 'station' || stop?.kind === 'structure' ? stop.kind : 'system';
  const systemId = Number(stop?.systemId ?? (kind === 'system' ? id : 0));
  const systemName = String(stop?.systemName || (kind === 'system' ? name : '')).trim();
  if (!Number.isSafeInteger(id) || id <= 0 || !name || !Number.isSafeInteger(systemId) || systemId <= 0 || !systemName) {
    throw new Error(`The ${label} is not a valid EVE solar system, station, or structure.`);
  }
  return { id, name, kind, systemId, systemName };
}

export function navigationSystem(stop) {
  const normalized = normalizeStop(stop);
  return { id: normalized.systemId, name: normalized.systemName };
}

export function uniqueSystems(systems) {
  const seen = new Set();
  return systems.filter((system) => {
    const id = Number(system.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export const uniqueStops = uniqueSystems;

export function routeStopSystemIndexes(systems, stops) {
  const systemIds = (systems || []).map((system) => Number(system?.id ?? system));
  const indexes = [];
  let searchFrom = 0;
  for (const stop of stops || []) {
    const stopSystemId = Number(stop?.systemId ?? stop?.id ?? stop);
    const index = systemIds.findIndex((systemId, candidateIndex) => candidateIndex >= searchFrom && systemId === stopSystemId);
    if (index < 0) continue;
    indexes.push(index);
    searchFrom = index + 1;
  }
  return indexes;
}

export function advanceRouteProgress(systems, currentSystemId, previous = null) {
  const ids = (systems || []).map((system) => Number(system?.id ?? system));
  const current = Number(currentSystemId);
  if (!ids.length || !Number.isSafeInteger(current) || current <= 0) {
    return { systemIndex: -1, lastSystemId: null, onRoute: false };
  }

  const previousIndex = Number(previous?.systemIndex);
  const hasPrevious = Number.isInteger(previousIndex) && previousIndex >= 0 && previousIndex < ids.length;
  if (hasPrevious && Number(previous.lastSystemId) === current) {
    return { systemIndex: previousIndex, lastSystemId: current, onRoute: ids[previousIndex] === current };
  }

  const searchFrom = hasPrevious ? previousIndex + 1 : 0;
  const nextIndex = ids.findIndex((id, index) => index >= searchFrom && id === current);
  if (nextIndex >= 0) {
    return { systemIndex: nextIndex, lastSystemId: current, onRoute: true };
  }
  if (hasPrevious && ids[previousIndex] === current) {
    return { systemIndex: previousIndex, lastSystemId: current, onRoute: true };
  }
  return { systemIndex: hasPrevious ? previousIndex : -1, lastSystemId: current, onRoute: false };
}

export function stopsForCharacter(route) {
  return [...(route.stops || [])];
}

export function itineraryFor(route, originOverride = null, characterId = null) {
  return [originOverride || route.origin, ...stopsForCharacter(route, characterId).map(navigationSystem)].filter(Boolean);
}

export function autopilotStopsFor(route, characterId = null) {
  if (route.mode === 'coverage') {
    const calculation = (route.calculations || []).find((item) => (
      characterId == null ? item.characterId == null : Number(item.characterId) === Number(characterId)
    ));
    if (Array.isArray(calculation?.stops)) {
      return uniqueSystems(calculation.stops)
        .filter((system) => Number(system.id) !== Number(calculation.origin?.id));
    }
    return uniqueSystems(stopsForCharacter(route, characterId));
  }
  return uniqueStops(stopsForCharacter(route, characterId));
}

function routeCalculationFor(route, characterId = null) {
  const calculations = route?.calculations || [];
  if (characterId != null) {
    const assigned = calculations.find((item) => Number(item.characterId) === Number(characterId));
    if (assigned) return assigned;
  }
  return calculations.find((item) => item.characterId == null) || calculations[0] || null;
}

export function routeNavigationStages(route, characterId = null) {
  const calculation = routeCalculationFor(route, characterId);
  if (!calculation) return [];
  const specifiedStops = route.mode === 'coverage' ? calculation.stops || route.stops || [] : route.stops || [];
  const stopIndexes = routeStopSystemIndexes(calculation.systems, specifiedStops);
  const waypointStages = specifiedStops.flatMap((stop, index) => {
    const systemIndex = stopIndexes[index];
    if (!Number.isInteger(systemIndex)) return [];
    return [{
      key: `waypoint:${index}:${Number(stop.id)}`,
      kind: 'waypoint',
      systemIndex,
      destination: stop
    }];
  });
  const wormholeStages = (calculation.wormholeSteps || []).map((wormhole, index) => ({
    key: wormhole.key || `wormhole:${wormhole.id}:${wormhole.fromIndex}:${wormhole.toIndex}:${index}`,
    kind: 'wormhole',
    systemIndex: Number(wormhole.fromIndex),
    completesAtIndex: Number(wormhole.toIndex),
    wormhole
  }));
  return [...waypointStages, ...wormholeStages].sort((left, right) => {
    const bySystem = left.systemIndex - right.systemIndex;
    if (bySystem) return bySystem;
    if (left.kind !== right.kind) return left.kind === 'waypoint' ? -1 : 1;
    return left.key.localeCompare(right.key);
  });
}

export function gateSegmentWaypoints(route, character, progress = null) {
  const action = nextRouteNavigationAction(route, character, progress);
  if (!action || action.kind !== 'waypoint') return [];
  if (action.wormhole) {
    return [{ ...action.destination, systemIndex: action.systemIndex }];
  }

  const stages = routeNavigationStages(route, character?.id);
  const startIndex = stages.findIndex((stage) => stage.key === action.key);
  if (startIndex < 0) return [{ ...action.destination, systemIndex: action.systemIndex }];

  const waypoints = [];
  for (let stageIndex = startIndex; stageIndex < stages.length; stageIndex += 1) {
    const stage = stages[stageIndex];
    if (stage.kind === 'wormhole') {
      waypoints.push({ ...stage.wormhole.from, kind: 'system', systemIndex: stage.systemIndex });
      break;
    }
    waypoints.push({ ...stage.destination, systemIndex: stage.systemIndex });
  }
  return waypoints;
}

export function overrideGameWaypoints(route, characterId = null, progress = null) {
  const calculation = routeCalculationFor(route, characterId);
  if (!calculation?.systems?.length) return [];
  const currentIndex = Number.isInteger(progress?.systemIndex) ? progress.systemIndex : -1;
  const startIndex = Math.max(0, currentIndex + 1);
  const nextWormhole = [...(calculation.wormholeSteps || [])]
    .filter((step) => Number(step.toIndex) > currentIndex && Number(step.fromIndex) >= currentIndex)
    .sort((left, right) => Number(left.fromIndex) - Number(right.fromIndex))[0] || null;
  const endIndex = nextWormhole ? Number(nextWormhole.fromIndex) : calculation.systems.length - 1;
  if (startIndex > endIndex) return [];

  const specifiedStops = route.mode === 'coverage' ? calculation.stops || route.stops || [] : route.stops || [];
  const stopsByIndex = new Map();
  routeStopSystemIndexes(calculation.systems, specifiedStops).forEach((systemIndex, stopIndex) => {
    if (!Number.isInteger(systemIndex) || systemIndex < 0) return;
    if (!stopsByIndex.has(systemIndex)) stopsByIndex.set(systemIndex, []);
    stopsByIndex.get(systemIndex).push(specifiedStops[stopIndex]);
  });

  const waypoints = [];
  for (let systemIndex = startIndex; systemIndex <= endIndex; systemIndex += 1) {
    const system = calculation.systems[systemIndex];
    waypoints.push({ ...system, kind: 'system', systemIndex });
    (stopsByIndex.get(systemIndex) || []).forEach((stop) => {
      if (stop.kind === 'station' || stop.kind === 'structure') waypoints.push({ ...stop, systemIndex });
    });
  }
  return waypoints;
}

export function remainingRouteWormholes(route, characterId = null, progress = null) {
  const calculation = routeCalculationFor(route, characterId);
  if (!calculation) return [];
  const currentIndex = Number.isInteger(progress?.systemIndex) ? progress.systemIndex : -1;
  return [...(calculation.wormholeSteps || [])]
    .filter((wormhole) => Number(wormhole.toIndex) > currentIndex)
    .sort((left, right) => Number(left.fromIndex) - Number(right.fromIndex));
}

function waypointReached(stage, character, currentIndex) {
  if (currentIndex > stage.systemIndex) return true;
  if (currentIndex < stage.systemIndex) return false;
  const destination = stage.destination;
  if (destination.kind === 'station' || destination.kind === 'structure') {
    return Number(character?.location?.stop?.id) === Number(destination.id);
  }
  return Number(character?.location?.id) === Number(destination.systemId ?? destination.id);
}

export function nextRouteNavigationAction(route, character, progress) {
  const currentIndex = Number.isInteger(progress?.systemIndex) ? progress.systemIndex : -1;
  const currentSystemId = Number(character?.location?.id);
  for (const stage of routeNavigationStages(route, character?.id)) {
    if (stage.kind === 'waypoint') {
      if (waypointReached(stage, character, currentIndex)) continue;
      return stage;
    }
    if (currentIndex >= stage.completesAtIndex) continue;
    if (currentIndex === stage.systemIndex && currentSystemId === Number(stage.wormhole.from.id)) return stage;
    return {
      key: `approach:${stage.key}`,
      kind: 'waypoint',
      systemIndex: stage.systemIndex,
      destination: stage.wormhole.from,
      wormhole: stage.wormhole
    };
  }
  return null;
}

export function routeDestinationState(route, character, progress = null) {
  const calculation = routeCalculationFor(route, character?.id);
  const specifiedStops = route?.mode === 'coverage'
    ? calculation?.stops || route?.stops || []
    : route?.stops || [];
  const finalStop = specifiedStops.at(-1) || null;
  const finalSystemIndex = (calculation?.systems?.length || 0) - 1;
  const finalSystemId = Number(finalStop?.systemId ?? finalStop?.id);
  const requiresDocking = finalStop?.kind === 'station' || finalStop?.kind === 'structure';
  const atFinalSystem = finalSystemIndex >= 0
    && Number(progress?.systemIndex) === finalSystemIndex
    && Number(character?.location?.id) === finalSystemId
    && Number(calculation.systems[finalSystemIndex]?.id) === finalSystemId;
  const docked = requiresDocking
    && atFinalSystem
    && Number(character?.location?.stop?.id) === Number(finalStop.id);

  return {
    complete: atFinalSystem && (!requiresDocking || docked),
    docking: atFinalSystem && requiresDocking && !docked,
    requiresDocking,
    finalStop,
    finalSystemIndex
  };
}

export function routeRequestBody(route) {
  const preference = ROUTE_PREFERENCES.includes(route.preference) ? route.preference : 'Safer';
  const penalty = Math.min(100, Math.max(0, Math.round(Number(route.securityPenalty ?? 50))));
  return {
    preference,
    security_penalty: penalty,
    avoid_systems: uniqueSystems(route.avoidSystems || []).map((system) => Number(system.id)),
    connections: (route.connections || []).map((connection) => ({
      from: Number(connection.from.id),
      to: Number(connection.to.id)
    }))
  };
}

export function mergeCalculatedLegs(legs) {
  const merged = [];
  legs.forEach((leg) => {
    (leg || []).forEach((systemId, index) => {
      const id = Number(systemId);
      if (!Number.isSafeInteger(id) || id <= 0) return;
      if (index === 0 && merged.at(-1) === id) return;
      merged.push(id);
    });
  });
  return merged;
}

export function buildRoute(input, previous = null) {
  const mode = input.mode === 'coverage' ? 'coverage' : 'standard';
  const originMode = input.originMode === 'character'
    ? 'character'
    : mode === 'coverage' && input.originMode === 'auto'
      ? 'auto'
      : 'fixed';
  const origin = originMode === 'fixed' ? normalizeSystem(input.origin, 'origin') : null;

  const now = new Date().toISOString();
  const status = ROUTE_STATUSES.includes(input.status) ? input.status : 'draft';
  const preference = ROUTE_PREFERENCES.includes(input.preference) ? input.preference : 'Safer';
  const assignedCharacterIds = [...new Set((input.assignedCharacterIds || [])
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  const stops = uniqueStops((input.stops || []).map((item) => normalizeStop(item, mode === 'coverage' ? 'coverage system' : 'stop')))
    .filter((item) => item.id !== origin?.id || mode === 'coverage');
  if (!stops.length) throw new Error(mode === 'coverage' ? 'Load a coverage area first.' : 'Add at least one stop.');
  if (mode === 'coverage' && stops.some((stop) => stop.kind !== 'system')) {
    throw new Error('Coverage routes may only contain solar systems.');
  }
  const coverageArea = mode === 'coverage' ? {
    type: input.coverageArea?.type === 'constellation' ? 'constellation' : 'region',
    id: Number(input.coverageArea?.id),
    name: String(input.coverageArea?.name || '').trim()
  } : null;
  if (mode === 'coverage' && (!Number.isSafeInteger(coverageArea.id) || coverageArea.id <= 0 || !coverageArea.name)) {
    throw new Error('Choose a valid region or constellation for the coverage route.');
  }
  const calculations = (input.calculations || []).map((calculation) => {
    const systems = (calculation.systems || []).map((system) => normalizeSystem(system, 'calculated route system'));
    const stops = (calculation.stops || []).map((stop) => normalizeStop(stop, 'calculated coverage stop'));
    const wormholeSteps = (calculation.wormholeSteps || []).map((step, index) => {
      const fromIndex = Number(step.fromIndex);
      const toIndex = Number(step.toIndex);
      const from = normalizeSystem(step.from, `wormhole step ${index + 1} origin`);
      const to = normalizeSystem(step.to, `wormhole step ${index + 1} destination`);
      const signatureId = String(step.signatureId || '').trim().toUpperCase();
      const destinationSignatureId = String(step.destinationSignatureId || '').trim().toUpperCase();
      if (!Number.isInteger(fromIndex) || toIndex !== fromIndex + 1 || systems[fromIndex]?.id !== from.id || systems[toIndex]?.id !== to.id) {
        throw new Error(`Wormhole step ${index + 1} does not match the calculated route.`);
      }
      if (!signatureId || !destinationSignatureId || !Number.isFinite(Date.parse(step.expiresAt))) {
        throw new Error(`Wormhole step ${index + 1} is missing its signatures or expiration.`);
      }
      return {
        id: String(step.id || `${from.id}:${to.id}`),
        key: String(step.key || `wormhole:${step.id || `${from.id}:${to.id}`}:${fromIndex}:${toIndex}`),
        hub: normalizeWormholeHubs([step.hub])[0] || '',
        from,
        to,
        fromIndex,
        toIndex,
        signatureId,
        destinationSignatureId,
        expiresAt: new Date(step.expiresAt).toISOString(),
        maxShipSize: String(step.maxShipSize || 'unknown'),
        wormholeType: String(step.wormholeType || 'Unknown')
      };
    });
    const characterId = calculation.characterId == null ? null : Number(calculation.characterId);
    return {
      key: String(calculation.key || characterId || 'fixed'),
      characterId: Number.isSafeInteger(characterId) && characterId > 0 ? characterId : null,
      origin: normalizeSystem(calculation.origin, 'calculated route origin'),
      systems,
      stops,
      wormholeSteps,
      jumpCount: Math.max(0, systems.length - 1),
      calculatedAt: calculation.calculatedAt || now
    };
  });

  return {
    id: previous?.id || input.id || makeId(),
    schemaVersion: 2,
    name: decodeHtmlEntities(input.name).trim() || (mode === 'coverage'
      ? `${coverageArea.name} coverage`
      : `${origin?.name || 'Live origins'} to ${stops.at(-1).name}`),
    notes: decodeHtmlEntities(input.notes).trim(),
    mode,
    coverageArea,
    status,
    preference,
    overrideGameRouting: input.overrideGameRouting === true,
    securityPenalty: Math.min(100, Math.max(0, Math.round(Number(input.securityPenalty ?? 50)))),
    originMode,
    origin,
    stops,
    avoidSystems: uniqueSystems((input.avoidSystems || []).map((item) => normalizeSystem(item, 'avoid system')))
      .filter((item) => item.id !== origin?.id),
    connections: (input.connections || []).map((connection) => ({
      from: normalizeSystem(connection.from, 'connection origin'),
      to: normalizeSystem(connection.to, 'connection destination')
    })),
    wormholeHubs: normalizeWormholeHubs(input.wormholeHubs),
    assignedCharacterIds,
    stopAssignments: [],
    calculations,
    lastCalculatedAt: input.lastCalculatedAt || (calculations.length ? now : null),
    lastSentAt: input.lastSentAt || previous?.lastSentAt || null,
    createdAt: previous?.createdAt || input.createdAt || now,
    updatedAt: now
  };
}

export function duplicateRoute(route) {
  const copy = structuredClone(route);
  delete copy.id;
  copy.name = `${route.name} copy`;
  copy.status = 'draft';
  copy.assignedCharacterIds = [];
  copy.stopAssignments = [];
  copy.calculations = (copy.calculations || []).filter((calculation) => calculation.characterId == null);
  copy.lastSentAt = null;
  copy.createdAt = new Date().toISOString();
  return buildRoute(copy);
}

export function serializeRoutes(routes, config = {}) {
  return {
    kind: config.kind || ROUTE_EXPORT_KIND,
    version: config.version || 2,
    exportedAt: new Date().toISOString(),
    routes: routes.map((route) => structuredClone(route))
  };
}

export function parseRouteImport(payload, existingRoutes = [], availableCharacterIds = []) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!parsed || ![ROUTE_EXPORT_KIND, LEGACY_ROUTE_EXPORT_KIND].includes(parsed.kind) || parsed.version !== 2 || !Array.isArray(parsed.routes)) {
    throw new Error('This is not a supported Splash route file.');
  }
  if (parsed.routes.length > 500) throw new Error('A route file may contain at most 500 routes.');

  const usedIds = new Set(existingRoutes.map((route) => route.id));
  const characterIds = new Set(availableCharacterIds.map(Number));
  return parsed.routes.map((route, index) => {
    try {
      const imported = buildRoute({
        ...route,
        id: usedIds.has(route.id) ? makeId() : route.id,
        assignedCharacterIds: (route.assignedCharacterIds || []).filter((id) => characterIds.has(Number(id)))
      });
      usedIds.add(imported.id);
      return imported;
    } catch (error) {
      throw new Error(`Route ${index + 1} could not be imported: ${error.message}`);
    }
  });
}

export function preferenceLabel(preference) {
  return ({ Shorter: 'Shortest', Safer: 'Safest', LessSecure: 'Less secure' })[preference] || 'Safest';
}
