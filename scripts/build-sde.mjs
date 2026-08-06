#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

function argumentsFor(argv) {
  const parsed = {};
  for (let index = 2; index < argv.length; index += 2) parsed[argv[index].replace(/^--/, '')] = argv[index + 1];
  return parsed;
}

async function readJsonLines(filePath, visitor) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    await visitor(JSON.parse(line));
  }
}

const args = argumentsFor(process.argv);
for (const required of ['systems', 'stargates', 'regions', 'constellations', 'stations', 'moons', 'corporations', 'station-operations', 'out']) {
  if (!args[required]) throw new Error(`Missing --${required}`);
}

const regions = new Map();
await readJsonLines(args.regions, (row) => {
  const id = Number(row._key ?? row.key);
  if (Number.isSafeInteger(id)) regions.set(id, String(row.name?.en || row.name || `Region ${id}`));
});

const constellations = new Map();
await readJsonLines(args.constellations, (row) => {
  const id = Number(row._key ?? row.key);
  if (!Number.isSafeInteger(id)) return;
  constellations.set(id, {
    id,
    name: String(row.name?.en || row.name || `Constellation ${id}`),
    regionId: Number(row.regionID || 0)
  });
});

const systems = new Map();
await readJsonLines(args.systems, (row) => {
  const id = Number(row._key ?? row.key);
  if (!Number.isSafeInteger(id)) return;
  systems.set(id, {
    id,
    name: String(row.name?.en || row.name || `System ${id}`),
    security: Number(row.securityStatus || 0),
    regionId: Number(row.regionID || 0),
    constellationId: Number(row.constellationID || 0),
    x: Number(row.position?.x || 0),
    y: Number(row.position?.y || 0),
    z: Number(row.position?.z || 0),
    adjacent: new Set()
  });
});

const moonIds = new Set();
await readJsonLines(args.moons, (row) => {
  const id = Number(row._key ?? row.key);
  if (Number.isSafeInteger(id)) moonIds.add(id);
});

const corporationNames = new Map();
await readJsonLines(args.corporations, (row) => {
  const id = Number(row._key ?? row.key);
  if (Number.isSafeInteger(id)) corporationNames.set(id, String(row.name?.en || row.name || `Corporation ${id}`));
});

const operationNames = new Map();
await readJsonLines(args['station-operations'], (row) => {
  const id = Number(row._key ?? row.key);
  if (Number.isSafeInteger(id)) operationNames.set(id, String(row.operationName?.en || row.operationName || `Station ${id}`));
});

function romanNumeral(value) {
  let number = Math.max(1, Math.round(Number(value) || 1));
  const numerals = [['M', 1000], ['CM', 900], ['D', 500], ['CD', 400], ['C', 100], ['XC', 90], ['L', 50], ['XL', 40], ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]];
  let output = '';
  for (const [symbol, amount] of numerals) {
    while (number >= amount) {
      output += symbol;
      number -= amount;
    }
  }
  return output;
}

const stations = [];
await readJsonLines(args.stations, (row) => {
  const id = Number(row._key ?? row.key);
  const systemId = Number(row.solarSystemID);
  const system = systems.get(systemId);
  if (!Number.isSafeInteger(id) || !system) return;
  const location = moonIds.has(Number(row.orbitID))
    ? `${system.name} ${romanNumeral(row.celestialIndex)} - Moon ${Number(row.orbitIndex)}`
    : `${system.name} ${romanNumeral(row.celestialIndex)}`;
  const owner = corporationNames.get(Number(row.ownerID)) || `Corporation ${Number(row.ownerID)}`;
  const operation = row.useOperationName ? ` ${operationNames.get(Number(row.operationID)) || 'Station'}` : '';
  stations.push([id, `${location} - ${owner}${operation}`, systemId]);
});

await readJsonLines(args.stargates, (row) => {
  const from = Number(row.solarSystemID);
  const to = Number(row.destination?.solarSystemID);
  if (systems.has(from) && systems.has(to)) systems.get(from).adjacent.add(to);
});

let maxGateDistance = 0;
for (const system of systems.values()) {
  for (const neighborId of system.adjacent) {
    const neighbor = systems.get(neighborId);
    const distance = Math.hypot(system.x - neighbor.x, system.y - neighbor.y, system.z - neighbor.z);
    maxGateDistance = Math.max(maxGateDistance, distance);
  }
}

let latest = {};
if (args.latest && fs.existsSync(args.latest)) latest = JSON.parse(fs.readFileSync(args.latest, 'utf8'));
const payload = {
  schemaVersion: 1,
  sdeVersion: Number(latest.buildNumber || 0),
  sdeReleaseDate: latest.releaseDate || null,
  generatedAt: new Date().toISOString(),
  maxGateDistance,
  regions: [...regions].sort((left, right) => left[0] - right[0]),
  constellations: [...constellations.values()]
    .sort((left, right) => left.id - right.id)
    .map((constellation) => [constellation.id, constellation.name, constellation.regionId]),
  stations: stations.sort((left, right) => left[0] - right[0]),
  systems: [...systems.values()]
    .sort((a, b) => a.id - b.id)
    .map((system) => [
      system.id,
      system.name,
      Number(system.security.toFixed(6)),
      system.regionId,
      system.x,
      system.y,
      system.z,
      [...system.adjacent].sort((a, b) => a - b),
      system.constellationId
    ])
};

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(payload));
if (args['version-out']) {
  fs.writeFileSync(args['version-out'], `${JSON.stringify({
    _key: 'sde',
    buildNumber: payload.sdeVersion,
    releaseDate: payload.sdeReleaseDate
  }, null, 2)}\n`);
}
console.log(`Wrote ${payload.systems.length} systems and ${payload.stations.length} NPC stations to ${args.out}`);
