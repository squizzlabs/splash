# Splash

> We do the navigating. You do the exploding.

Splash is a static, browser-only route planner for EVE Online. It calculates routes locally from a bundled EVE universe graph, connects multiple characters through EVE SSO, sends routes through ESI, and tracks each online pilot’s progress from live location data.

Routes, settings, character authorizations, and last-known locations are stored in the browser’s IndexedDB. The app has no application server or shared database.

## What it does

- Connects multiple EVE characters with Authorization Code + PKCE.
- Checks character online status every 15 seconds.
- Polls locations and ships for online characters every 8 seconds.
- Calculates Shortest, Safest, and Less secure routes locally with A*.
- Creates saved routes without requiring pilot assignments.
- Sends one saved route to any number of online pilots; each pilot receives the complete route.
- Sets direct, unsaved routes for one or more online pilots.
- Supports ordered solar-system, NPC-station, and known structure stops.
- Tracks station and structure destinations through docking completion.
- Can automatically remove completed pilots from local tracking without changing their EVE autopilot route.
- Generates region and constellation coverage routes.
- Supports draggable ordered stops, autocomplete, system avoidance, and custom one-way connections.
- Uses Jita as the initial default system to avoid; the default list is editable in Settings.
- Uses active public Thera and Turnur connections from EVE-Scout when selected.
- Stages route delivery around wormhole traversals and displays the signature to use.
- Can submit every calculated gate system to override EVE’s own route choice.
- Imports and exports route plans without including character tokens.

See [Routing and route delivery](docs/routing.md) for the complete routing model.

## Run locally

Requirements:

- Python 3 for the local static server
- Node.js 22 or newer for tests and SDE tooling

Start the app:

```bash
python3 serve.py
```

Open <http://localhost:59832>.

Run the test suite:

```bash
npm test
```

## EVE application configuration

The EVE application uses the Authorization Code flow with PKCE and these scopes:

- `esi-location.read_location.v1`
- `esi-location.read_online.v1`
- `esi-location.read_ship_type.v1`
- `esi-structures.read_character.v1`
- `esi-ui.write_waypoint.v1`

Registered callback URLs:

- Local: `http://localhost:59832/callback`
- Production: `https://splash.zzeve.com/callback`

Public client IDs, callback URLs, ESI endpoints, and attribution are deployment configuration in [`js/config.js`](js/config.js). They are not user settings. The app does not use or store a client secret.

Every ESI request identifies the app with:

```text
Splash / <deployment URL> / Squizz Caphinator
```

The local deployment uses `http://localhost:59832`; the production deployment uses `https://splash.zzeve.com`.

## Universe data

The app ships [`data/universe.json`](data/universe.json), a compact browser graph built from CCP’s JSONL SDE. It contains:

- Solar systems and stargate adjacency
- Coordinates and security status
- Regions and constellations
- NPC station stops used by autocomplete

Update the installed SDE locally:

```bash
npm run update-sde
```

Force a fresh download and rebuild:

```bash
npm run update-sde -- --force
```

The updater builds into a temporary directory, validates the graph, runs the tests, and replaces the installed data only after validation succeeds. The GitHub Action performs the same update automatically when CCP publishes a new build.

See [Deployment and data maintenance](docs/deployment.md) for hosting, callback routing, SDE build commands, storage, and operational details.

## Project layout

```text
index.html                  Main application
auth.html                   EVE SSO callback UI
og-image.png                Open Graph and large-card social preview
css/app.css                 Application styles
js/app.js                   UI and workflow orchestration
js/domain.js                Route and progress domain logic
js/route-planner.js         Universe graph and A* routing
js/esi.js                   EVE SSO and ESI client
js/eve-scout.js             Thera and Turnur connection client
js/presence.js              Online, location, and ship synchronization
js/db.js                    IndexedDB storage
scripts/                    SDE build, validation, and update tools
tests/                      Node test suite
```

## Privacy

Character tokens remain in this browser and are sent only to EVE SSO and ESI as required. Route exports exclude tokens and character records. Removing a character deletes its authorization and assignments from the browser. **Erase all local data** removes the app’s IndexedDB database.

## License

[Zero-Clause BSD](LICENSE).
