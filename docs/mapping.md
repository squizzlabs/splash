# Wormhole mapping

Splash includes a browser-local wormhole chain mapper alongside its route planner. The first version combines Tripwire's dense chain workspace with the automatic location tracking prototyped in ProbeDaddy, while keeping Splash dependency-free and browser-only.

## Current behavior

- Pan, zoom, fit, and select systems on the SVG chain map. Zoom is remembered in this browser; reopening the map restores that scale while re-centering the live root one `em` from the top.
- Deep-link directly to the mapper with `#map`; selecting a system updates the URL to `#map-<system-id>`, which restores that mapped system after a reload. Major app views use `#route`, `#characters`, and `#settings` and participate in browser Back/Forward navigation.
- Show online pilots on the system they currently occupy.
- Switch the active pilot from the clickable header portraits. The selection is remembered, the active portrait is highlighted, and the mapper renders only that pilot's connected chain with their current system at the top; other connected pilots and disconnected chains continue tracking in the background.
- When auto-map is enabled, follow ordinary stargate travel without growing the map and create a wormhole connection after a non-stargate system change.
- After a detected wormhole jump, prompt for the signature used in the origin system. The picker lists that system's scanned wormholes, excludes signatures already assigned to other exits, accepts a manually entered signature ID, and queues simultaneous pilot jumps. A return trip can label the other side of the same connection.
- Record optional system aliases.
- Record connection signature, wormhole type, life, remaining mass, and ship-size class.
- Add individual cosmic signatures or import tab-separated rows copied from EVE's probe scanner with Ctrl+V, the Paste scan button, or the manual paste field. Strength and distance columns are ignored.
- Persist the map in the same IndexedDB `kv` store used by the rest of Splash.

The renderer uses native SVG rather than a graph library. Layout is a live-rooted tree: the focused pilot's current system stays at the top, each jump moves one row downward, and every parent's descendants occupy one contiguous horizontal subtree. Like Tripwire's organization-chart layout, sibling connections share one vertical trunk and horizontal branch rail before dropping into each child. Connection life, mass, and size are encoded on the line so degraded links can be read without opening the inspector.

## Auto-mapping safeguards

ESI provides a character's current solar system but does not identify how the character moved. Splash compares consecutive locations against the bundled stargate adjacency graph:

- A known stargate move advances the tracking cursor and does not create a wormhole edge.
- A system change with no stargate adjacency creates a connection and asks which origin-side wormhole signature was used. The mapper never guesses between multiple signatures with the same generic name.
- Both system observations must occur while the pilot is online. Seeing a pilot offline clears their movement cursor, so reconnecting in another system does not create a connection across the offline gap.

Jump bridges, cynos, filaments, and other non-gate travel can therefore look like a wormhole to a browser-only observer. Automatically created connections are intentionally unclassified until a mapper supplies signature and type details.

## Storage and sharing

The map is currently personal to the browser. A Tripwire-style corporation map needs a shared service with access control, a durable topology store, and real-time conflict-safe updates. That is a separate architecture phase; adding it to the static deployment would otherwise imply collaboration that the app cannot actually provide.

The local model is structured so nodes, connections, signatures, map roots, and tracking cursors can later be synchronized without replacing the SVG UI or movement detection.

## Design references

- [Tripwire](https://tripwiremap.app/) for the chain-first workspace, compact system cards, signatures, re-rooting, and map-level status cues.
- [Tripwire source](https://github.com/eve-sec/tripwire) for its open implementation and data concepts.
- [EVEeye chain mapping documentation](https://eveeye.readthedocs.io/en/latest/map/chain-mapping/) for current conventions around automatic movement mapping and encoding connection life, mass, and size.
- [wormhole.systems documentation](https://wormhole.systems/documentation) for modern collaborative maps, live presence, signature linking, and routing expectations.
- `~/probedaddy` for Splash's original custom graph prototype and live-location experiment.
