#!/usr/bin/env node
import fs from 'node:fs';
import { UniverseGraph } from '../js/route-planner.js';

const graphIndex = process.argv.indexOf('--graph');
const graphPath = graphIndex >= 0 ? process.argv[graphIndex + 1] : null;
if (!graphPath) throw new Error('Usage: node scripts/validate-sde.mjs --graph /path/to/universe.json');

const payload = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
const graph = new UniverseGraph(payload);
if (graph.systems.size < 8_000) throw new Error(`Universe graph has only ${graph.systems.size} systems.`);
if (graph.regions.size < 100 || graph.constellations.size < 1_000) {
  throw new Error('Universe graph is missing region or constellation metadata.');
}
if (graph.stations.size < 5_000) throw new Error('Universe graph is missing NPC stations.');

const jita = graph.resolve('Jita');
const amarr = graph.resolve('Amarr');
if (jita?.id !== 30000142 || amarr?.id !== 30002187) {
  throw new Error('Universe graph is missing expected trade-hub systems.');
}

const path = graph.astar(jita.id, amarr.id, { preference: 'Shorter' });
if (path[0] !== jita.id || path.at(-1) !== amarr.id || path.length < 3) {
  throw new Error('Universe graph failed its route smoke test.');
}

const forge = graph.resolveArea('The Forge', 'region');
if (!forge || graph.systemsInArea('region', forge.id).length < 50) {
  throw new Error('Universe graph failed its region lookup smoke test.');
}
const jitaStation = graph.resolveStop('Jita IV - Moon 4 - Caldari Navy Assembly Plant');
if (jitaStation?.id !== 60003760 || jitaStation.systemId !== jita.id) {
  throw new Error('Universe graph failed its NPC station lookup smoke test.');
}

console.log(`Validated SDE ${graph.version}: ${graph.systems.size} systems; Jita to Amarr is ${path.length - 1} jumps.`);
