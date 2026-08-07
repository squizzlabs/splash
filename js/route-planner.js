import { mergeCalculatedLegs, routeRequestBody } from './domain.js';

const MARKET_HUB_STATION_IDS = Object.freeze([
  60003760, // Jita
  60011866, // Dodixie
  60004588, // Rens
  60015140, // Hek
  60008494  // Amarr
]);
const MARKET_HUB_STATIONS = new Set(MARKET_HUB_STATION_IDS);

class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(value) {
    this.items.push(value);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= value.priority) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = value;
  }

  pop() {
    if (!this.items.length) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (!this.items.length) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.items.length) break;
      let child = left;
      if (right < this.items.length && this.items[right].priority < this.items[left].priority) child = right;
      if (this.items[child].priority >= last.priority) break;
      this.items[index] = this.items[child];
      index = child;
    }
    this.items[index] = last;
    return first;
  }
}

function edgeCost(preference, securityPenalty, targetSecurity) {
  if (preference === 'Shorter') return 1;
  const penalty = Math.exp(0.15 * securityPenalty);
  if (preference === 'Safer') {
    if (targetSecurity <= 0) return 2 * penalty;
    if (targetSecurity < 0.45) return penalty;
    return 0.9;
  }
  if (targetSecurity <= 0) return 2 * penalty;
  if (targetSecurity < 0.45) return 0.9;
  return penalty;
}

function geometricDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export class UniverseGraph {
  constructor(payload) {
    if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.systems)) {
      throw new Error('The bundled universe graph is invalid.');
    }
    this.version = payload.sdeVersion || 'unknown';
    this.releaseDate = payload.sdeReleaseDate || null;
    this.generatedAt = payload.generatedAt || null;
    this.maxGateDistance = Number(payload.maxGateDistance || 1);
    this.systems = new Map();
    this.names = new Map();
    this.regions = new Map();
    this.constellations = new Map();
    this.stations = new Map();
    this.regionNames = new Map();
    this.constellationNames = new Map();
    this.stationNames = new Map();
    (payload.regions || []).forEach(([id, name]) => {
      const region = { id: Number(id), name: String(name), type: 'region' };
      this.regions.set(region.id, region);
      this.regionNames.set(region.name.toLocaleLowerCase(), region.id);
    });
    (payload.constellations || []).forEach(([id, name, regionId]) => {
      const constellation = { id: Number(id), name: String(name), regionId: Number(regionId), type: 'constellation' };
      this.constellations.set(constellation.id, constellation);
      this.constellationNames.set(constellation.name.toLocaleLowerCase(), constellation.id);
    });
    payload.systems.forEach((row) => {
      const [id, name, security, regionId, x, y, z, adjacent, constellationId] = row;
      const system = {
        id: Number(id),
        name: String(name),
        security: Number(security),
        regionId: Number(regionId),
        constellationId: Number(constellationId || 0),
        x: Number(x),
        y: Number(y),
        z: Number(z),
        adjacent: (adjacent || []).map(Number)
      };
      this.systems.set(system.id, system);
      this.names.set(system.name.toLocaleLowerCase(), system.id);
    });
    (payload.stations || []).forEach(([id, name, systemId]) => {
      const system = this.get(systemId);
      if (!system) return;
      const station = {
        id: Number(id),
        name: String(name),
        kind: 'station',
        systemId: system.id,
        systemName: system.name,
        marketHub: MARKET_HUB_STATIONS.has(Number(id))
      };
      this.stations.set(station.id, station);
      this.stationNames.set(station.name.toLocaleLowerCase(), station.id);
    });
  }

  static async load(url = './data/universe.json') {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Universe graph could not be loaded (${response.status}).`);
    return new UniverseGraph(await response.json());
  }

  get(id) {
    return this.systems.get(Number(id)) || null;
  }

  resolve(query) {
    const value = String(query || '').trim();
    if (!value) return null;
    const numericId = /^\d+$/.test(value) ? Number(value) : null;
    const system = numericId ? this.get(numericId) : this.get(this.names.get(value.toLocaleLowerCase()));
    return system ? { id: system.id, name: system.name } : null;
  }

  resolveStop(query) {
    const value = String(query || '').trim();
    if (!value) return null;
    const numericId = /^\d+$/.test(value) ? Number(value) : null;
    const station = numericId
      ? this.stations.get(numericId)
      : this.stations.get(this.stationNames.get(value.toLocaleLowerCase()));
    if (station) return { ...station };
    const system = this.resolve(value);
    return system ? { ...system, kind: 'system', systemId: system.id, systemName: system.name } : null;
  }

  searchStops(query, limit = 10) {
    const normalized = String(query || '').trim().toLocaleLowerCase();
    if (!normalized) return [];
    const numeric = /^\d+$/.test(normalized);
    const prefixes = [];
    const partials = [];
    const consider = (item) => {
      const name = item.name.toLocaleLowerCase();
      const id = String(item.id);
      if ((numeric && id.startsWith(normalized)) || name.startsWith(normalized)) prefixes.push(item);
      else if (partials.length < limit && ((!numeric && name.includes(normalized)) || (numeric && id.includes(normalized)))) partials.push(item);
    };
    this.systems.forEach((system) => consider({
      id: system.id,
      name: system.name,
      kind: 'system',
      systemId: system.id,
      systemName: system.name,
      security: system.security
    }));
    this.stations.forEach(consider);
    const matches = [...prefixes.sort((left, right) => left.name.localeCompare(right.name)), ...partials];
    if (!numeric) {
      MARKET_HUB_STATION_IDS.forEach((stationId) => {
        const station = this.stations.get(stationId);
        if (!station || !station.name.toLocaleLowerCase().includes(normalized)) return;
        const systemIndex = matches.findIndex((item) => item.kind === 'system' && item.id === station.systemId);
        if (systemIndex < 0) return;
        const existingIndex = matches.findIndex((item) => item.id === station.id);
        if (existingIndex >= 0) matches.splice(existingIndex, 1);
        const currentSystemIndex = matches.findIndex((item) => item.kind === 'system' && item.id === station.systemId);
        matches.splice(currentSystemIndex + 1, 0, station);
      });
    }
    return matches.slice(0, limit);
  }

  resolveArea(query, type = 'region') {
    const value = String(query || '').trim();
    if (!value) return null;
    const collection = type === 'constellation' ? this.constellations : this.regions;
    const names = type === 'constellation' ? this.constellationNames : this.regionNames;
    const numericId = /^\d+$/.test(value) ? Number(value) : null;
    return collection.get(numericId || names.get(value.toLocaleLowerCase())) || null;
  }

  searchAreas(query, type = 'region', limit = 10) {
    const normalized = String(query || '').trim().toLocaleLowerCase();
    if (!normalized) return [];
    const collection = type === 'constellation' ? this.constellations : this.regions;
    const numeric = /^\d+$/.test(normalized);
    const prefixes = [];
    const partials = [];
    for (const area of collection.values()) {
      const name = area.name.toLocaleLowerCase();
      const id = String(area.id);
      if ((numeric && id.startsWith(normalized)) || name.startsWith(normalized)) prefixes.push(area);
      else if (partials.length < limit && ((!numeric && name.includes(normalized)) || (numeric && id.includes(normalized)))) partials.push(area);
    }
    return [...prefixes.sort((a, b) => a.name.localeCompare(b.name)), ...partials].slice(0, limit);
  }

  systemsInArea(type, areaId) {
    const key = type === 'constellation' ? 'constellationId' : 'regionId';
    return [...this.systems.values()]
      .filter((system) => system[key] === Number(areaId))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((system) => ({ id: system.id, name: system.name }));
  }

  shortestPathToAny(originId, destinationIds, options = {}) {
    const origin = this.get(originId);
    const destinations = new Set([...destinationIds].map(Number));
    if (!origin || !destinations.size) throw new Error('Coverage routing requires an origin and at least one destination.');
    if (destinations.has(origin.id)) return [origin.id];

    const request = routeRequestBody(options);
    const avoidedTargets = [...destinations].filter((id) => request.avoid_systems.includes(id));
    if (avoidedTargets.length) {
      const system = this.get(avoidedTargets[0]);
      throw new Error(`${system?.name || 'A coverage system'} cannot be both visited and avoided.`);
    }
    const avoid = new Set(request.avoid_systems);
    avoid.delete(origin.id);
    const extraConnections = new Map();
    request.connections.forEach(({ from, to }) => {
      if (!extraConnections.has(from)) extraConnections.set(from, []);
      extraConnections.get(from).push(to);
    });

    const open = new MinHeap();
    const cameFrom = new Map();
    const scores = new Map([[origin.id, 0]]);
    open.push({ id: origin.id, priority: 0, score: 0 });
    while (open.size) {
      const current = open.pop();
      if (current.score !== scores.get(current.id)) continue;
      if (destinations.has(current.id)) {
        const path = [current.id];
        let cursor = current.id;
        while (cameFrom.has(cursor)) {
          cursor = cameFrom.get(cursor);
          path.push(cursor);
        }
        return path.reverse();
      }
      const system = this.get(current.id);
      const neighbors = [...system.adjacent, ...(extraConnections.get(current.id) || [])];
      for (const neighborId of neighbors) {
        if (avoid.has(neighborId)) continue;
        const neighbor = this.get(neighborId);
        if (!neighbor) continue;
        const score = current.score + edgeCost(request.preference, request.security_penalty, neighbor.security);
        if (score >= (scores.get(neighbor.id) ?? Infinity)) continue;
        cameFrom.set(neighbor.id, current.id);
        scores.set(neighbor.id, score);
        open.push({ id: neighbor.id, score, priority: score });
      }
    }
    throw new Error(`No stargate path reaches the remaining coverage systems from ${origin.name}.`);
  }

  calculateCoverage(origin, targets, options = {}) {
    const originSystem = this.get(origin?.id ?? origin);
    if (!originSystem) throw new Error('The coverage origin is missing from the current SDE.');
    const targetIds = [...new Set((targets || []).map((system) => Number(system?.id ?? system)))]
      .filter((id) => this.systems.has(id));
    const remaining = new Set(targetIds);
    const stopIds = [];
    const pathIds = [originSystem.id];
    if (remaining.delete(originSystem.id)) stopIds.push(originSystem.id);
    let cursor = originSystem.id;
    while (remaining.size) {
      const leg = this.shortestPathToAny(cursor, remaining, options);
      for (const id of leg.slice(1)) {
        if (remaining.delete(id)) stopIds.push(id);
        if (pathIds.at(-1) !== id) pathIds.push(id);
      }
      cursor = leg.at(-1);
    }
    const normalize = (id) => {
      const system = this.get(id);
      return { id: system.id, name: system.name };
    };
    const request = routeRequestBody(options);
    const cost = pathIds.slice(1).reduce((total, id) => (
      total + edgeCost(request.preference, request.security_penalty, this.get(id).security)
    ), 0);
    return { origin: normalize(originSystem.id), systems: pathIds.map(normalize), stops: stopIds.map(normalize), cost };
  }

  calculateBestCoverage(targets, options = {}) {
    const targetIds = [...new Set((targets || []).map((system) => Number(system?.id ?? system)))]
      .filter((id) => this.systems.has(id));
    if (!targetIds.length) throw new Error('Choose at least one system for coverage.');
    const targetSet = new Set(targetIds);
    const candidates = targetIds.map((id) => {
      const system = this.get(id);
      const degree = system.adjacent.reduce((count, neighborId) => count + Number(targetSet.has(neighborId)), 0);
      return { system, degree };
    }).sort((left, right) => left.degree - right.degree || left.system.name.localeCompare(right.system.name));

    let best = null;
    let lastError = null;
    for (const candidate of candidates.slice(0, Math.min(16, candidates.length))) {
      try {
        const result = this.calculateCoverage(candidate.system, targetIds, options);
        if (!best || result.cost < best.cost || (result.cost === best.cost && result.systems.length < best.systems.length)) {
          best = result;
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (!best) throw lastError || new Error('No connected stargate coverage route could be calculated.');
    return best;
  }

  astar(originId, destinationId, options = {}) {
    const origin = this.get(originId);
    const destination = this.get(destinationId);
    if (!origin || !destination) throw new Error('The route contains a solar system missing from the current SDE.');
    if (origin.id === destination.id) return [origin.id];

    const request = routeRequestBody(options);
    const avoid = new Set(request.avoid_systems);
    avoid.delete(origin.id);
    avoid.delete(destination.id);
    const extraConnections = new Map();
    request.connections.forEach(({ from, to }) => {
      if (!extraConnections.has(from)) extraConnections.set(from, []);
      extraConnections.get(from).push(to);
    });

    const minimumEdgeCost = request.preference === 'Shorter' ? 1 : 0.9;
    const heuristic = (system) => {
      // A player connection can span farther than any stargate, so the SDE
      // distance bound is no longer admissible when custom edges are present.
      if (request.connections.length) return 0;
      if (!this.maxGateDistance) return 0;
      return (geometricDistance(system, destination) / this.maxGateDistance) * minimumEdgeCost;
    };

    const open = new MinHeap();
    const cameFrom = new Map();
    const scores = new Map([[origin.id, 0]]);
    open.push({ id: origin.id, priority: heuristic(origin), score: 0 });

    while (open.size) {
      const current = open.pop();
      if (current.score !== scores.get(current.id)) continue;
      if (current.id === destination.id) {
        const path = [destination.id];
        let cursor = destination.id;
        while (cameFrom.has(cursor)) {
          cursor = cameFrom.get(cursor);
          path.push(cursor);
        }
        return path.reverse();
      }

      const system = this.get(current.id);
      const neighbors = [...system.adjacent, ...(extraConnections.get(current.id) || [])];
      for (const neighborId of neighbors) {
        if (avoid.has(neighborId)) continue;
        const neighbor = this.get(neighborId);
        if (!neighbor) continue;
        const score = current.score + edgeCost(request.preference, request.security_penalty, neighbor.security);
        if (score >= (scores.get(neighbor.id) ?? Infinity)) continue;
        cameFrom.set(neighbor.id, current.id);
        scores.set(neighbor.id, score);
        open.push({ id: neighbor.id, score, priority: score + heuristic(neighbor) });
      }
    }
    throw new Error(`No known route exists between ${origin.name} and ${destination.name}.`);
  }

  calculateItinerary(systems, options = {}) {
    if (systems.length < 2) throw new Error('A route requires an origin and at least one stop.');
    const legs = [];
    for (let index = 0; index < systems.length - 1; index += 1) {
      legs.push(this.astar(systems[index].id, systems[index + 1].id, options));
    }
    return mergeCalculatedLegs(legs).map((id) => {
      const system = this.get(id);
      return { id: system.id, name: system.name };
    });
  }
}
