const MAP_VERSION = 1;
const SCANNER_SIGNATURE_ID = /^[A-Z0-9]{3}-[A-Z0-9]{3}$/i;
const SIGNATURE_REFERENCE = /^[A-Z0-9]{3}(?:-[A-Z0-9]{3})?$/i;
const WORMHOLE_LIFE_STATES = ['stable', 'under-4h', 'under-1h', 'expired'];

export const WORMHOLE_LIFE_DURATIONS = Object.freeze({
  'under-4h': 4 * 60 * 60 * 1_000,
  'under-1h': 60 * 60 * 1_000,
  expired: 30 * 60 * 1_000
});
export const SIGNATURE_EXPIRY_MS = 3 * 24 * 60 * 60 * 1_000;

function isoNow(now) {
  return typeof now === 'function' ? now() : new Date().toISOString();
}

function cleanText(value, limit = 120) {
  return String(value || '').trim().slice(0, limit);
}

function millisecondsNow(now = Date.now()) {
  const value = typeof now === 'function' ? now() : now;
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

export function normalizeConnectionLife(value) {
  if (value === 'eol') return 'under-4h';
  return WORMHOLE_LIFE_STATES.includes(value) ? value : 'stable';
}

export function connectionLifeExpiresAt(life, now = Date.now()) {
  const normalizedLife = normalizeConnectionLife(life);
  const duration = WORMHOLE_LIFE_DURATIONS[normalizedLife];
  return duration ? new Date(millisecondsNow(now) + duration).toISOString() : null;
}

export function updateConnectionCondition(connection, updates = {}, now = Date.now()) {
  const timestamp = new Date(millisecondsNow(now)).toISOString();
  const previousLife = normalizeConnectionLife(connection?.life);
  const life = updates.life == null ? previousLife : normalizeConnectionLife(updates.life);
  const mass = updates.mass ?? connection?.mass;
  const size = updates.size ?? connection?.size;
  const currentExpiration = Date.parse(connection?.expiresAt);
  const expiresAt = life === 'stable'
    ? null
    : life === previousLife && Number.isFinite(currentExpiration)
      ? new Date(currentExpiration).toISOString()
      : connectionLifeExpiresAt(life, timestamp);
  return {
    ...connection,
    ...updates,
    life,
    expiresAt,
    mass: ['reduced', 'critical'].includes(mass) ? mass : 'stable',
    size: ['frigate', 'small', 'medium', 'large', 'xlarge'].includes(size) ? size : 'medium',
    updatedAt: timestamp
  };
}

export function emptyMapState() {
  return {
    version: MAP_VERSION,
    name: 'Personal chain',
    nodes: [],
    connections: [],
    signatures: {},
    lastLocations: {},
    rootId: null,
    selectedSystemId: null,
    autoTrack: true,
    updatedAt: null
  };
}

function normalizeNode(node, graph) {
  const id = Number(node?.id ?? node?.systemId);
  const system = graph?.get(id);
  if (!Number.isSafeInteger(id) || !system) return null;
  return {
    id,
    name: system.name,
    alias: cleanText(node.alias, 60),
    source: node.source === 'tracked' ? 'tracked' : 'manual',
    createdAt: node.createdAt || null,
    updatedAt: node.updatedAt || null
  };
}

export function connectionId(from, to) {
  return [Number(from), Number(to)].sort((left, right) => left - right).join(':');
}

function normalizeConnection(connection, nodeIds) {
  const from = Number(connection?.from);
  const to = Number(connection?.to);
  if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) return null;
  const life = normalizeConnectionLife(connection.life);
  const parsedExpiration = Date.parse(connection.expiresAt);
  const parsedBaseline = Date.parse(connection.updatedAt || connection.createdAt);
  const expiresAt = life === 'stable'
    ? null
    : Number.isFinite(parsedExpiration)
      ? new Date(parsedExpiration).toISOString()
      : connectionLifeExpiresAt(life, Number.isFinite(parsedBaseline) ? parsedBaseline : Date.now());
  return {
    id: connectionId(from, to),
    from,
    to,
    kind: connection.kind === 'gate' ? 'gate' : 'wormhole',
    type: cleanText(connection.type, 12).toUpperCase(),
    fromSignature: cleanText(connection.fromSignature, 7).toUpperCase(),
    toSignature: cleanText(connection.toSignature, 7).toUpperCase(),
    life,
    expiresAt,
    mass: ['reduced', 'critical'].includes(connection.mass) ? connection.mass : 'stable',
    size: ['frigate', 'small', 'medium', 'large', 'xlarge'].includes(connection.size) ? connection.size : 'medium',
    source: connection.source === 'tracked' ? 'tracked' : 'manual',
    createdAt: connection.createdAt || null,
    updatedAt: connection.updatedAt || null
  };
}

function normalizeSignature(signature) {
  const id = cleanText(signature?.id, 7).toUpperCase();
  if (!SIGNATURE_REFERENCE.test(id)) return null;
  const type = cleanText(signature.type, 72);
  const name = cleanText(signature.name, 120);
  const rawGroup = cleanText(signature.group, 32);
  return {
    id,
    group: (!rawGroup || rawGroup === 'Unknown') && !type && !name ? 'Cosmic Signature' : rawGroup || 'Unknown',
    type,
    name,
    updatedAt: signature.updatedAt || null
  };
}

export function normalizeMapState(value, graph) {
  const base = emptyMapState();
  if (!value || typeof value !== 'object') return base;
  const nodes = [];
  const nodeIds = new Set();
  (Array.isArray(value.nodes) ? value.nodes : []).forEach((candidate) => {
    const node = normalizeNode(candidate, graph);
    if (!node || nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  });
  const connectionIds = new Set();
  const connections = [];
  (Array.isArray(value.connections) ? value.connections : []).forEach((candidate) => {
    const connection = normalizeConnection(candidate, nodeIds);
    if (!connection || connectionIds.has(connection.id)) return;
    connectionIds.add(connection.id);
    connections.push(connection);
  });
  const signatures = {};
  Object.entries(value.signatures || {}).forEach(([systemId, rows]) => {
    const id = Number(systemId);
    if (!nodeIds.has(id) || !Array.isArray(rows)) return;
    const seen = new Set();
    signatures[id] = rows.map(normalizeSignature).filter((signature) => {
      if (!signature || seen.has(signature.id)) return false;
      seen.add(signature.id);
      return true;
    });
  });
  const rootId = nodeIds.has(Number(value.rootId)) ? Number(value.rootId) : nodes[0]?.id || null;
  const selectedSystemId = nodeIds.has(Number(value.selectedSystemId)) ? Number(value.selectedSystemId) : rootId;
  const lastLocations = {};
  Object.entries(value.lastLocations || {}).forEach(([characterId, systemId]) => {
    if (Number.isSafeInteger(Number(characterId)) && graph?.get(Number(systemId))) lastLocations[characterId] = Number(systemId);
  });
  return {
    ...base,
    name: cleanText(value.name, 60) || base.name,
    nodes,
    connections,
    signatures,
    lastLocations,
    rootId,
    selectedSystemId,
    autoTrack: value.autoTrack !== false,
    updatedAt: value.updatedAt || null
  };
}

export function addMapSystem(map, system, options = {}, now = () => new Date().toISOString()) {
  if (!system?.id) return { map, added: false, connected: false };
  const timestamp = isoNow(now);
  const nodes = [...map.nodes];
  const connections = [...map.connections];
  let added = false;
  let promoted = false;
  const existingIndex = nodes.findIndex((node) => node.id === Number(system.id));
  if (existingIndex < 0) {
    nodes.push({
      id: Number(system.id),
      name: system.name,
      alias: '',
      source: options.source === 'tracked' ? 'tracked' : 'manual',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    added = true;
  } else if (options.source !== 'tracked' && nodes[existingIndex].source === 'tracked') {
    nodes[existingIndex] = { ...nodes[existingIndex], source: 'manual', updatedAt: timestamp };
    promoted = true;
  }
  const connectFrom = Number(options.connectFrom);
  const id = connectionId(connectFrom, system.id);
  let connected = false;
  if (connectFrom && connectFrom !== Number(system.id) && nodes.some((node) => node.id === connectFrom) && !connections.some((connection) => connection.id === id)) {
    connections.push({
      id,
      from: connectFrom,
      to: Number(system.id),
      kind: options.kind === 'gate' ? 'gate' : 'wormhole',
      type: '',
      fromSignature: '',
      toSignature: '',
      life: 'stable',
      expiresAt: null,
      mass: 'stable',
      size: 'medium',
      source: options.source === 'tracked' ? 'tracked' : 'manual',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    connected = true;
  }
  const selectedSystemId = Number(system.id);
  return {
    added,
    connected,
    map: {
      ...map,
      nodes,
      connections,
      rootId: map.rootId || selectedSystemId,
      selectedSystemId,
      updatedAt: (added || connected || promoted) ? timestamp : map.updatedAt
    }
  };
}

function signatureRowIdForReference(map, systemId, reference) {
  const id = cleanText(reference, 7).toUpperCase();
  if (!id) return '';
  const rows = map.signatures?.[Number(systemId)] || [];
  if (rows.some((signature) => signature.id === id)) return id;
  if (id.length !== 3) return '';
  const matches = rows.filter((signature) => signature.id.startsWith(`${id}-`));
  return matches.length === 1 ? matches[0].id : '';
}

function connectionSignatureRows(map) {
  const assigned = new Map();
  (map.connections || []).forEach((connection) => {
    [[connection.from, connection.fromSignature], [connection.to, connection.toSignature]].forEach(([systemId, reference]) => {
      const signatureId = signatureRowIdForReference(map, systemId, reference);
      if (!signatureId) return;
      if (!assigned.has(Number(systemId))) assigned.set(Number(systemId), new Set());
      assigned.get(Number(systemId)).add(signatureId);
    });
  });
  return assigned;
}

function removeConnections(map, shouldRemove, timestamp) {
  const removedConnections = map.connections.filter(shouldRemove);
  if (!removedConnections.length) return map;
  const connections = map.connections.filter((connection) => !shouldRemove(connection));
  const removedSignatures = new Map();
  const retainedSignatures = new Map();
  const recordSignatures = (connection, target) => {
    [[connection.from, connection.fromSignature], [connection.to, connection.toSignature]].forEach(([systemId, reference]) => {
      const signatureId = signatureRowIdForReference(map, systemId, reference);
      if (!signatureId) return;
      if (!target.has(systemId)) target.set(systemId, new Set());
      target.get(systemId).add(signatureId);
    });
  };
  removedConnections.forEach((connection) => recordSignatures(connection, removedSignatures));
  connections.forEach((connection) => recordSignatures(connection, retainedSignatures));
  const signatures = { ...map.signatures };
  removedSignatures.forEach((signatureIds, systemId) => {
    const retained = retainedSignatures.get(systemId) || new Set();
    signatures[systemId] = (signatures[systemId] || []).filter((signature) => !signatureIds.has(signature.id) || retained.has(signature.id));
  });
  return { ...map, connections, signatures, updatedAt: timestamp };
}

export function removeMapConnection(map, connectionIdValue, now = () => new Date().toISOString()) {
  const id = String(connectionIdValue || '');
  return removeConnections(map, (connection) => connection.id === id, isoNow(now));
}

export function removeMapSystem(map, systemId, now = () => new Date().toISOString()) {
  const id = Number(systemId);
  if (!map.nodes.some((node) => node.id === id)) return map;
  const timestamp = isoNow(now);
  const withoutConnections = removeConnections(map, (connection) => connection.from === id || connection.to === id, timestamp);
  const nodes = map.nodes.filter((node) => node.id !== id);
  const signatures = { ...withoutConnections.signatures };
  delete signatures[id];
  const lastLocations = { ...withoutConnections.lastLocations };
  Object.entries(lastLocations).forEach(([characterId, locationId]) => {
    if (locationId === id) delete lastLocations[characterId];
  });
  const rootId = map.rootId === id ? nodes[0]?.id || null : map.rootId;
  return {
    ...withoutConnections,
    nodes,
    signatures,
    lastLocations,
    rootId,
    selectedSystemId: map.selectedSystemId === id ? rootId : map.selectedSystemId,
    updatedAt: timestamp
  };
}

function nodeDegree(map, systemId) {
  return map.connections.reduce((count, connection) => count + Number(connection.from === systemId || connection.to === systemId), 0);
}

export function observeCharacterMovements(map, characters, graph, now = () => new Date().toISOString()) {
  if (!map.autoTrack) return { map, changes: [] };
  let next = map;
  let changed = false;
  const changes = [];
  const lastLocations = { ...map.lastLocations };
  (Array.isArray(characters) ? characters : []).forEach((character) => {
    if (character?.presence?.online !== true || !character.location?.id) return;
    const characterId = String(Number(character.id));
    const currentId = Number(character.location.id);
    const current = graph?.get(currentId);
    if (!current) return;
    const previousId = Number(lastLocations[characterId]) || null;
    if (!previousId) {
      const result = addMapSystem(next, current, { source: 'tracked' }, now);
      next = result.map;
      changed ||= result.added;
      if (result.added) changes.push({ type: 'system', systemId: currentId, characterId: Number(character.id) });
    } else if (previousId !== currentId) {
      const previous = graph.get(previousId);
      const movedFromRoot = next.rootId === previousId;
      const usedGate = previous?.adjacent?.includes(currentId) || current.adjacent?.includes(previousId);
      if (usedGate) {
        const previousNode = next.nodes.find((node) => node.id === previousId);
        if (next.nodes.length === 1 && previousNode?.source === 'tracked' && nodeDegree(next, previousId) === 0) {
          next = removeMapSystem(next, previousId, now);
          const result = addMapSystem(next, current, { source: 'tracked' }, now);
          next = result.map;
          changed = true;
          changes.push({ type: 'gate-follow', from: previousId, to: currentId, characterId: Number(character.id) });
        } else if (movedFromRoot && next.nodes.some((node) => node.id === currentId)) {
          next = { ...next, rootId: currentId, selectedSystemId: currentId };
          changed = true;
        }
      } else if (previous) {
        let result = addMapSystem(next, previous, { source: 'tracked' }, now);
        next = result.map;
        result = addMapSystem(next, current, { source: 'tracked', connectFrom: previousId }, now);
        next = result.map;
        const mappedConnectionId = connectionId(previousId, currentId);
        if (result.added || result.connected) {
          changed = true;
          changes.push({ type: 'connection', from: previousId, to: currentId, characterId: Number(character.id) });
        }
        changes.push({
          type: 'wormhole-jump',
          from: previousId,
          to: currentId,
          connectionId: mappedConnectionId,
          characterId: Number(character.id)
        });
        if (movedFromRoot) {
          next = { ...next, rootId: currentId, selectedSystemId: currentId };
          changed = true;
        }
      }
    }
    if (lastLocations[characterId] !== currentId) {
      lastLocations[characterId] = currentId;
      changed = true;
    }
  });
  if (changed) next = { ...next, lastLocations, updatedAt: isoNow(now) };
  return { map: next, changes };
}

export function parseScannerSignatures(text, now = () => new Date().toISOString()) {
  const timestamp = isoNow(now);
  const signatures = [];
  const seen = new Set();
  String(text || '').split(/\r?\n/).forEach((line) => {
    const columns = line.split('\t').map((value) => value.trim());
    const signatureIndex = columns.findIndex((value) => SCANNER_SIGNATURE_ID.test(value));
    if (signatureIndex < 0) return;
    const id = columns[signatureIndex].toUpperCase();
    if (seen.has(id)) return;
    seen.add(id);
    const scannerColumns = columns.slice(signatureIndex);
    const isScannerRow = /^cosmic signature$/i.test(scannerColumns[1] || '');
    let group;
    let detail;
    if (isScannerRow) {
      group = scannerColumns[2] || scannerColumns[1] || 'Unknown';
      detail = scannerColumns[3] || '';
    } else {
      const tail = scannerColumns.slice(1).filter(Boolean);
      group = tail.find((value) => /site|wormhole|unknown/i.test(value) && !/^cosmic signature$/i.test(value)) || 'Unknown';
      detail = tail.find((value) => value !== group && !/^\d+(?:\.\d+)?%$/.test(value) && !/^[\d,.]+\s*(?:AU|km|m)$/i.test(value)) || '';
    }
    signatures.push({ id, group, type: detail, name: detail, updatedAt: timestamp });
  });
  return signatures;
}

export function upsertSignatures(map, systemId, signatures, now = () => new Date().toISOString()) {
  const id = Number(systemId);
  if (!map.nodes.some((node) => node.id === id)) return map;
  const rows = [...(map.signatures[id] || [])];
  signatures.map(normalizeSignature).filter(Boolean).forEach((signature) => {
    const index = rows.findIndex((row) => row.id === signature.id);
    if (index >= 0) rows[index] = { ...rows[index], ...signature };
    else rows.push(signature);
  });
  rows.sort((left, right) => left.id.localeCompare(right.id));
  return { ...map, signatures: { ...map.signatures, [id]: rows }, updatedAt: isoNow(now) };
}

export function updateMapSignature(map, systemId, signatureId, updates, now = () => new Date().toISOString()) {
  const id = Number(systemId);
  const originalId = cleanText(signatureId, 7).toUpperCase();
  const rows = map.signatures[id] || [];
  const current = rows.find((signature) => signature.id === originalId);
  if (!current) return map;
  const updatedAt = isoNow(now);
  const signature = normalizeSignature({ ...current, ...updates, updatedAt });
  if (!signature || rows.some((row) => row.id === signature.id && row.id !== originalId)) return map;
  const nextRows = rows.map((row) => row.id === originalId ? signature : row)
    .sort((left, right) => left.id.localeCompare(right.id));
  const connections = map.connections.map((connection) => {
    let changed = false;
    const next = { ...connection };
    if (connection.from === id && String(connection.fromSignature || '').toUpperCase() === originalId) {
      next.fromSignature = signature.id;
      changed = true;
    }
    if (connection.to === id && String(connection.toSignature || '').toUpperCase() === originalId) {
      next.toSignature = signature.id;
      changed = true;
    }
    return changed ? { ...next, updatedAt } : connection;
  });
  return { ...map, connections, signatures: { ...map.signatures, [id]: nextRows }, updatedAt };
}

function connectionSignatureAt(connection, systemId) {
  if (connection.from === systemId) return connection.fromSignature;
  if (connection.to === systemId) return connection.toSignature;
  return '';
}

export function pruneExpiredConnections(map, now = Date.now()) {
  const timestamp = millisecondsNow(now);
  return removeConnections(map, (connection) => {
    if (connection.kind === 'gate') return false;
    const expiration = Date.parse(connection.expiresAt);
    return Number.isFinite(expiration) && expiration <= timestamp;
  }, new Date(timestamp).toISOString());
}

export function pruneExpiredSignatures(map, now = Date.now()) {
  const timestamp = millisecondsNow(now);
  const updatedAt = new Date(timestamp).toISOString();
  const assigned = connectionSignatureRows(map);
  let changed = false;
  const signatures = {};
  Object.entries(map.signatures || {}).forEach(([systemId, rows]) => {
    signatures[systemId] = rows.flatMap((signature) => {
      if (signature.group === 'Wormhole' || assigned.get(Number(systemId))?.has(signature.id)) return [signature];
      const lastSeen = Date.parse(signature.updatedAt);
      if (!Number.isFinite(lastSeen)) {
        changed = true;
        return [{ ...signature, updatedAt }];
      }
      if (lastSeen + SIGNATURE_EXPIRY_MS <= timestamp) {
        changed = true;
        return [];
      }
      return [signature];
    });
  });
  return changed ? { ...map, signatures, updatedAt } : map;
}

export function pruneExpiredMapItems(map, now = Date.now()) {
  const timestamp = millisecondsNow(now);
  return pruneExpiredSignatures(pruneExpiredConnections(map, timestamp), timestamp);
}

export function nextMapExpirationAt(map) {
  const deadlines = (map.connections || [])
    .filter((connection) => connection.kind !== 'gate')
    .map((connection) => Date.parse(connection.expiresAt))
    .filter(Number.isFinite);
  const assigned = connectionSignatureRows(map);
  Object.entries(map.signatures || {}).forEach(([systemId, rows]) => {
    rows.forEach((signature) => {
      if (signature.group === 'Wormhole' || assigned.get(Number(systemId))?.has(signature.id)) return;
      const lastSeen = Date.parse(signature.updatedAt);
      deadlines.push(Number.isFinite(lastSeen) ? lastSeen + SIGNATURE_EXPIRY_MS : 0);
    });
  });
  return deadlines.length ? Math.min(...deadlines) : null;
}

export function mapRoutingConnections(map, graph, now = Date.now()) {
  const timestamp = millisecondsNow(now);
  return (map?.connections || []).flatMap((connection) => {
    if (connection.kind === 'gate') return [];
    const expiration = Date.parse(connection.expiresAt);
    if (normalizeConnectionLife(connection.life) === 'expired' || (Number.isFinite(expiration) && expiration <= timestamp)) return [];
    const from = graph?.get(connection.from);
    const to = graph?.get(connection.to);
    if (!from || !to) return [];
    const fromSystem = { id: Number(from.id), name: String(from.name) };
    const toSystem = { id: Number(to.id), name: String(to.name) };
    return [
      ...(connection.fromSignature ? [{ from: fromSystem, to: toSystem, mappedWormhole: connection }] : []),
      ...(connection.toSignature ? [{ from: toSystem, to: fromSystem, mappedWormhole: connection }] : [])
    ];
  });
}

export function mapWormholeStepsForPath(map, graph, systems, now = Date.now()) {
  const path = systems || [];
  const pairs = new Map();
  mapRoutingConnections(map, graph, now).forEach(({ from, to, mappedWormhole }) => {
    pairs.set(`${from.id}:${to.id}`, mappedWormhole);
  });
  return path.slice(0, -1).flatMap((fromSystem, fromIndex) => {
    const toSystem = path[fromIndex + 1];
    const connection = pairs.get(`${Number(fromSystem.id)}:${Number(toSystem.id)}`);
    if (!connection) return [];
    return [{
      id: `map:${connection.id}`,
      key: `wormhole:map:${connection.id}:${fromIndex}:${fromIndex + 1}`,
      source: 'map',
      hub: '',
      from: { id: Number(fromSystem.id), name: String(fromSystem.name) },
      to: { id: Number(toSystem.id), name: String(toSystem.name) },
      fromIndex,
      toIndex: fromIndex + 1,
      signatureId: String(connectionSignatureAt(connection, fromSystem.id) || '').toUpperCase(),
      destinationSignatureId: String(connectionSignatureAt(connection, toSystem.id) || '').toUpperCase(),
      expiresAt: connection.expiresAt || null,
      maxShipSize: connection.size || 'unknown',
      wormholeType: connection.type || 'Unknown',
      life: normalizeConnectionLife(connection.life),
      mass: connection.mass || 'stable'
    }];
  });
}

export function wormholeSignatureCandidates(map, systemId, targetConnectionId = '') {
  const id = Number(systemId);
  const used = new Set();
  (map.connections || []).forEach((connection) => {
    if (connection.id === targetConnectionId) return;
    const signature = connectionSignatureAt(connection, id);
    if (signature) used.add(signature.toUpperCase());
  });
  return (map.signatures?.[id] || []).filter((signature) => {
    const description = `${signature.group} ${signature.type} ${signature.name}`;
    const unclassified = ['Cosmic Signature', 'Unknown'].includes(signature.group)
      && !signature.type
      && !signature.name;
    return (/wormhole/i.test(description) || unclassified)
      && !used.has(signature.id.toUpperCase());
  });
}

export function assignConnectionSignature(map, connectionIdValue, systemId, signatureId, now = () => new Date().toISOString()) {
  const id = Number(systemId);
  const signature = cleanText(signatureId, 7).toUpperCase();
  if (!SIGNATURE_REFERENCE.test(signature)) return map;
  const connection = map.connections.find((candidate) => candidate.id === connectionIdValue);
  if (!connection || (connection.from !== id && connection.to !== id)) return map;
  const field = connection.from === id ? 'fromSignature' : 'toSignature';
  const timestamp = isoNow(now);
  const rows = [...(map.signatures[id] || [])];
  const signatureIndex = rows.findIndex((candidate) => candidate.id === signature);
  if (signatureIndex < 0) {
    rows.push({ id: signature, group: 'Wormhole', type: '', name: '', updatedAt: timestamp });
    rows.sort((left, right) => left.id.localeCompare(right.id));
  } else if (['Cosmic Signature', 'Unknown'].includes(rows[signatureIndex].group)) {
    rows[signatureIndex] = { ...rows[signatureIndex], group: 'Wormhole', updatedAt: timestamp };
  }
  return {
    ...map,
    connections: map.connections.map((candidate) => candidate.id === connection.id
      ? { ...candidate, [field]: signature, updatedAt: timestamp }
      : candidate),
    signatures: { ...map.signatures, [id]: rows },
    updatedAt: timestamp
  };
}

export function preferredMapRoot(map, characters) {
  const mapped = new Set((map.nodes || []).map((node) => Number(node.id)));
  const occupied = [];
  (Array.isArray(characters) ? characters : []).forEach((character) => {
    const systemId = Number(character?.location?.id);
    if (character?.presence?.online !== true || !mapped.has(systemId) || occupied.includes(systemId)) return;
    occupied.push(systemId);
  });
  const selectedSystemId = Number(map.selectedSystemId);
  if (occupied.includes(selectedSystemId)) return selectedSystemId;
  const rootId = Number(map.rootId);
  if (occupied.includes(rootId)) return rootId;
  return occupied[0] || (mapped.has(rootId) ? rootId : map.nodes?.[0]?.id || null);
}

export function connectedMapSystemIds(nodes, connections, rootId) {
  const nodeIds = new Set((nodes || []).map((node) => Number(node.id)));
  const root = Number(rootId);
  if (!nodeIds.has(root)) return new Set();
  const adjacency = new Map([...nodeIds].map((id) => [id, []]));
  (connections || []).forEach((connection) => {
    if (!nodeIds.has(connection.from) || !nodeIds.has(connection.to)) return;
    adjacency.get(connection.from).push(connection.to);
    adjacency.get(connection.to).push(connection.from);
  });
  const visible = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    adjacency.get(current).forEach((neighbor) => {
      if (visible.has(neighbor)) return;
      visible.add(neighbor);
      queue.push(neighbor);
    });
  }
  return visible;
}

export function computeChainLayout(nodes, connections, rootId, options = {}) {
  const columnGap = Number(options.columnGap || 220);
  const levelGap = Number(options.levelGap || 126);
  const ids = nodes.map((node) => Number(node.id));
  const nodeSet = new Set(ids);
  const adjacency = new Map(ids.map((id) => [id, []]));
  connections.forEach((connection) => {
    if (!nodeSet.has(connection.from) || !nodeSet.has(connection.to)) return;
    adjacency.get(connection.from).push(connection.to);
    adjacency.get(connection.to).push(connection.from);
  });
  adjacency.forEach((neighbors) => neighbors.sort((left, right) => left - right));
  const starts = [];
  if (nodeSet.has(Number(rootId))) starts.push(Number(rootId));
  ids.forEach((id) => { if (!starts.includes(id)) starts.push(id); });
  const positions = new Map();
  const visited = new Set();
  let componentLeft = 0;
  starts.forEach((start) => {
    if (visited.has(start)) return;
    const queue = [{ id: start, depth: 0 }];
    const levels = new Map();
    visited.add(start);
    while (queue.length) {
      const current = queue.shift();
      if (!levels.has(current.depth)) levels.set(current.depth, []);
      levels.get(current.depth).push(current.id);
      adjacency.get(current.id).forEach((neighbor) => {
        if (visited.has(neighbor)) return;
        visited.add(neighbor);
        queue.push({ id: neighbor, depth: current.depth + 1 });
      });
    }
    const widest = Math.max(...[...levels.values()].map((level) => level.length), 1);
    levels.forEach((level, depth) => {
      const offset = ((widest - level.length) * columnGap) / 2;
      level.forEach((id, index) => positions.set(id, {
        x: componentLeft + offset + index * columnGap,
        y: depth * levelGap,
        depth
      }));
    });
    componentLeft += widest * columnGap + columnGap;
  });
  return positions;
}

export function fitChainViewport(positions, rootId, viewport, nodeSize, options = {}) {
  const values = [...positions.values()];
  if (!values.length) return null;
  const nodeWidth = Number(nodeSize?.width) || 176;
  const nodeHeight = Number(nodeSize?.height) || 72;
  const viewportWidth = Math.max(1, Number(viewport?.width) || 1);
  const viewportHeight = Math.max(1, Number(viewport?.height) || 1);
  const topGap = Math.max(0, Number(options.topGap) || 0);
  const horizontalPadding = Math.max(0, Number(options.horizontalPadding ?? 50));
  const bottomPadding = Math.max(0, Number(options.bottomPadding ?? 50));
  const root = positions.get(Number(rootId)) || values[0];
  const rootCenterX = root.x + nodeWidth / 2;
  const minX = Math.min(...values.map((position) => position.x));
  const maxX = Math.max(...values.map((position) => position.x)) + nodeWidth;
  const maxY = Math.max(...values.map((position) => position.y)) + nodeHeight;
  const horizontalSpan = Math.max(rootCenterX - minX, maxX - rootCenterX, nodeWidth / 2);
  const verticalSpan = Math.max(nodeHeight, maxY - root.y);
  const horizontalRoom = Math.max(1, viewportWidth / 2 - horizontalPadding);
  const verticalRoom = Math.max(1, viewportHeight - topGap - bottomPadding);
  const maxScale = Number(options.maxScale ?? 1.35);
  const minScale = Number(options.minScale ?? 0.28);
  const fittedScale = Math.min(maxScale, Math.max(minScale, Math.min(horizontalRoom / horizontalSpan, verticalRoom / verticalSpan)));
  const preferredScale = Number(options.preferredScale);
  const scale = options.preferredScale != null && Number.isFinite(preferredScale)
    ? Math.min(Number(options.maxRememberedScale ?? 2.4), Math.max(minScale, preferredScale))
    : fittedScale;
  return {
    scale,
    x: viewportWidth / 2 - rootCenterX * scale,
    y: topGap - root.y * scale
  };
}
