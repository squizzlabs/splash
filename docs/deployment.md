# Deployment and data maintenance

Splash is a static application. Hosting serves the repository’s HTML, CSS, JavaScript, images, and generated universe data directly. There is no server process, token service, or database to deploy.

## Hosting requirements

A deployment needs:

- HTTPS outside localhost
- A registered EVE SSO callback URL
- Static handling for `/callback`
- Access from the browser to EVE SSO, ESI, EVE image services, and the EVE-Scout API

The production hostname is `splash.zzeve.com`. [`CNAME`](../CNAME), [`_redirects`](../_redirects), and [`404.html`](../404.html) provide the repository’s static-host callback and navigation behavior.

`/callback` must serve or redirect to [`auth.html`](../auth.html) while preserving the query string. The local server performs this rewrite directly.

## Local server

Run:

```bash
python3 serve.py
```

The server binds to `localhost:59832`, disables caching, and rewrites `/callback` to `/auth.html`.

Use a different port only for static inspection:

```bash
python3 serve.py --port 8000
```

EVE SSO uses the registered `http://localhost:59832/callback` URL, so character authorization requires the default port.

## Public configuration

[`js/config.js`](../js/config.js) contains:

- Local and production EVE client IDs
- Callback URLs
- Production hostname
- Requested ESI scopes
- ESI, SSO metadata, and EVE-Scout endpoints
- Route export format identifiers
- ESI request attribution

These values are application deployment data. The Settings UI contains only pilot-facing behavior and display choices.

The application uses PKCE and public client IDs. It does not use a client secret.

## Browser storage

IndexedDB contains four stores:

- `routes` for saved route plans and calculated itineraries
- `characters` for EVE authorizations, presence, location, ship, and progress state
- `names` for resolved structure names
- `kv` for application settings

The app has no cross-device synchronization. Import and export move route plans only.

## SDE contents

[`data/universe.json`](../data/universe.json) is generated from CCP JSONL files for:

- Solar systems
- Stargates
- Regions
- Constellations
- NPC stations

[`data/wormhole-systems.json`](../data/wormhole-systems.json) separately provides J-space class, environmental effect/type, and destination-labeled static wormhole codes. Regenerate it from a `wh_effects.csv` export; the importer reads the adjacent `sig2class.csv` destination mapping automatically:

```bash
node scripts/import-wormhole-systems.mjs --input /path/to/wh_effects.csv --out data/wormhole-systems.json
```
- Moons
- NPC corporations
- Station operations

The generated graph contains only the fields required by the browser planner and autocomplete. [`data/sde-version.json`](../data/sde-version.json) records the installed build number and release date.

## Local SDE update

Requirements: `curl`, `unzip`, Node.js, `mktemp`, and `find`.

Check for and install the current SDE:

```bash
npm run update-sde
```

Download and rebuild even when the build number matches:

```bash
npm run update-sde -- --force
```

The updater:

1. Reads CCP’s current release metadata.
2. Downloads and extracts the JSONL SDE when needed.
3. Builds a compact graph in a temporary directory.
4. Validates graph integrity and a real A* route.
5. Installs the graph and version metadata.
6. Runs the complete test suite.

## Build from local JSONL files

```bash
node scripts/build-sde.mjs \
  --systems /path/to/mapSolarSystems.jsonl \
  --stargates /path/to/mapStargates.jsonl \
  --regions /path/to/mapRegions.jsonl \
  --constellations /path/to/mapConstellations.jsonl \
  --stations /path/to/npcStations.jsonl \
  --moons /path/to/mapMoons.jsonl \
  --corporations /path/to/npcCorporations.jsonl \
  --station-operations /path/to/stationOperations.jsonl \
  --latest /path/to/latest.jsonl \
  --out data/universe.json \
  --version-out data/sde-version.json
```

Validate an installed graph:

```bash
node scripts/validate-sde.mjs --graph data/universe.json
```

## Automated SDE update

[`update-sde.yml`](../.github/workflows/update-sde.yml) checks CCP’s release metadata on its schedule and can also be started manually. When the build number changes, it:

1. Downloads the current JSONL archive.
2. Builds `data/universe.json` and `data/sde-version.json`.
3. Validates the graph.
4. Runs `npm test`.
5. Commits and pushes the generated files.

The workflow requires repository `contents: write` permission for its update commit.

## Verification

Run these checks after application or routing changes:

```bash
node --check js/app.js
npm test
```

The tests cover route-domain behavior, A* graph routing, SSO and ESI helpers, EVE-Scout parsing, waypoint delivery, and character presence synchronization.
