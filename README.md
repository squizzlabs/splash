# Just The Trip

Just The Trip is a static, browser-only EVE Online route planner. It keeps routes, settings, character tokens, and last-known locations in the browser's IndexedDB—there is no application server or shared database.

## Features

- Authorize multiple EVE characters with SSO Authorization Code + PKCE.
- Check each character's online state through ESI and only request live services for online pilots.
- Read each online character's current solar system and active ship through ESI.
- Create routes from a fixed system or each assigned character's live location.
- Set an immediate, per-pilot “Take me to…” route with destination autocomplete and the full routing options, without creating a saved/exported route or requiring a separate assignment step.
- Start new routes from the selected online character's live location by default.
- Add solar systems or NPC stations as ordered stops, or insert a selected pilot's exact live station/structure location; the final stop is the route endpoint.
- Calculate shortest, safer, and less-secure routes in-browser with A*.
- Generate complete region or constellation coverage routes from the bundled SDE, with a fixed, live, or automatically optimized starting system.
- Optionally include completed, unexpired public Thera and Turnur wormhole connections in A* route calculations.
- Create and edit routes without assigning characters, then staff each route from its flight-board action.
- Assign one saved route to multiple characters; every selected pilot receives the complete route.
- Stage one reachable ESI waypoint at a time for every assigned character and advance it from live location updates.
- Create, inspect, update, duplicate, archive, and delete routes.
- Avoid systems and add custom one-way connections such as jump bridges.
- Import and export portable route JSON without exposing character tokens.
- Follow dark, light, or system appearance settings.

## EVE SSO setup

Create an application in the [EVE Developers portal](https://developers.eveonline.com/applications) using the Authorization Code flow with PKCE. Enable these scopes:

- `publicData`
- `esi-location.read_location.v1`
- `esi-location.read_online.v1`
- `esi-location.read_ship_type.v1`
- `esi-universe.read_structures.v1`
- `esi-ui.write_waypoint.v1`

Characters authorized before the required location, online, ship, or structure scopes were added must be reconnected once. The app marks unavailable protected services instead of treating incomplete authorization as valid live data.

Client IDs and callback URLs are deployment configuration and are never exposed as user settings. A client secret is neither requested nor stored.

The registered callbacks are:

- Local: `http://localhost:59832/callback`
- Production: `https://jtt.zzeve.com/callback`

The hostname-specific public client IDs are configured only in `js/config.js`.

## Run locally

```bash
python3 serve.py
```

Then open <http://localhost:59832>. Static hosting such as GitHub Pages or Netlify works without a build step.

## Universe graph updates

The app ships `data/universe.json`, a compact graph generated from CCP's solar-system, stargate, region, constellation, and NPC-station JSONL files. It contains routing topology, area membership, and searchable station stops.

`.github/workflows/update-sde.yml` checks CCP's `latest.jsonl` every day after downtime. When the build number changes, it downloads the current SDE, runs `scripts/build-sde.mjs`, runs the tests, and commits the updated graph. This adapts the release-check/download pattern used by zKillboard's `cron/sde/update_sde_jsonl.sh` for a static GitHub-hosted app.

To check for and install an SDE update locally:

```bash
npm run update-sde
```

The updater exits without downloading the archive when the installed build is current. To download and rebuild the current release anyway:

```bash
npm run update-sde -- --force
```

The replacement graph is built in a temporary directory and must pass a real A* route smoke test before it replaces `data/universe.json`.

To rebuild directly from JSONL files you already have:

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

## Live wormhole shortcuts

Each route can independently include Thera, Turnur, or both as shortcuts. The choice can be made while editing the route or immediately before assigning it to pilots. Just The Trip reads completed, unexpired public connections from the [EVE-Scout API](https://api.eve-scout.com/ui/) and caches the result in memory for five minutes. The most recently assigned choice is saved on the route and persists with route exports; live signatures do not.

EVE autopilot cannot perform a wormhole traversal. Just The Trip therefore stages route delivery: it sends only the next gate-reachable waypoint, waits for location polling to confirm the pilot reached it, and then adds the next one. At a wormhole system, Route Progress shows the exact signature to warp to and tracks the pilot through the destination system without submitting Thera or another wormhole-only system to ESI. Wormhole instructions, signatures, and expiration times are retained with the calculated pilot route. The planner currently does not filter connections by the active ship's mass limit.

## Privacy and backups

Route exports do not include access tokens, refresh tokens, or character records. Removing a character deletes its tokens and assignments from this browser. **Erase all local data** deletes the entire IndexedDB database.

## License

[Zero-Clause BSD](LICENSE).
