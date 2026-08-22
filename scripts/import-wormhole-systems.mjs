#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function argumentsFor(argv) {
  const parsed = {};
  for (let index = 2; index < argv.length; index += 2) parsed[argv[index].replace(/^--/, '')] = argv[index + 1];
  return parsed;
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error('The wormhole CSV contains an unterminated quoted field.');
  values.push(value);
  return values;
}

const args = argumentsFor(process.argv);
if (!args.input || !args.out) {
  throw new Error('Usage: node scripts/import-wormhole-systems.mjs --input /path/to/wh_effects.csv --out data/wormhole-systems.json [--destinations /path/to/sig2class.csv]');
}

const destinationPath = args.destinations || path.join(path.dirname(args.input), 'sig2class.csv');
const destinationOrder = ['HS', 'LS', 'NS', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C13', 'Thera', 'Sentinel', 'Barbican', 'Vidette', 'Conflux', 'Redoubt', 'Pochven'];
const destinationRanks = new Map(destinationOrder.map((destination, index) => [destination, index]));
const staticDestinations = new Map();
fs.readFileSync(destinationPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).forEach((line) => {
  const [destinationValue, codesValue] = parseCsvLine(line);
  const destination = String(destinationValue || '').trim();
  String(codesValue || '').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean).forEach((code) => {
    if (!destination || staticDestinations.has(code)) throw new Error(`Invalid or duplicate destination mapping for ${code}.`);
    staticDestinations.set(code, destination);
  });
});

const lines = fs.readFileSync(args.input, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
const headers = parseCsvLine(lines.shift() || '');
const requiredHeaders = ['solarSystemName', 'SolarSystemID', 'wormholeClass', 'wormholeEffect', 'statics'];
requiredHeaders.forEach((header) => {
  if (!headers.includes(header)) throw new Error(`The wormhole CSV is missing ${header}.`);
});
const headerIndex = new Map(headers.map((header, index) => [header, index]));
const seen = new Set();
const systems = [];
lines.forEach((line) => {
  const columns = parseCsvLine(line);
  const name = String(columns[headerIndex.get('solarSystemName')] || '').trim();
  if (!/^J\d{6}$/.test(name)) return;
  const id = Number(columns[headerIndex.get('SolarSystemID')]);
  const wormholeClass = Number(columns[headerIndex.get('wormholeClass')]);
  const effect = String(columns[headerIndex.get('wormholeEffect')] || '').trim();
  const staticCodes = String(columns[headerIndex.get('statics')] || '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const statics = staticCodes.map((code) => {
    const destination = staticDestinations.get(code);
    if (!destination) throw new Error(`No destination mapping exists for static ${code} in ${name}.`);
    return [code, destination];
  }).sort((left, right) => {
    const leftRank = destinationRanks.get(left[1]) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = destinationRanks.get(right[1]) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left[1].localeCompare(right[1]) || left[0].localeCompare(right[0]);
  });
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(wormholeClass) || wormholeClass < 1 || !statics.length || seen.has(id)) {
    throw new Error(`Invalid or duplicate wormhole system row for ${name || id}.`);
  }
  seen.add(id);
  systems.push([id, wormholeClass, effect, statics]);
});
systems.sort((left, right) => left[0] - right[0]);
if (!systems.length) throw new Error('The wormhole CSV did not contain any J-code systems.');

const payload = {
  schemaVersion: 1,
  source: path.basename(args.input),
  staticDestinationSource: path.basename(destinationPath),
  fields: ['solarSystemId', 'wormholeClass', 'effect', 'statics'],
  systems
};
fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, `${JSON.stringify(payload)}\n`);
console.log(`Wrote ${systems.length} J-code systems to ${args.out}.`);
