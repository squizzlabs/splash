# Routing and route delivery

Splash separates route planning from pilot assignment. A saved route is a reusable plan. Assigning it calculates and sends a complete pilot-specific itinerary from that pilot’s current location. A direct route calculates and sends the same kind of itinerary without adding a saved route to the Routes list.

## Route origins

An ordered-stop route starts from each pilot’s current location by default. It can instead use a fixed solar system.

A region or constellation coverage route can use:

- An automatically optimized start
- Each assigned pilot’s current location
- A fixed solar system

Character locations come from ESI. Only online characters are polled for live location and ship data or offered as route recipients.

## Stops and destinations

Ordered-stop routes accept multiple stops in travel order. Stops can be rearranged by dragging them.

Supported stop types:

- Solar systems
- NPC stations included in the SDE
- A connected pilot’s current structure when ESI provides it

Autocomplete searches systems and NPC stations. A market-hub station is shown immediately after its matching system and is labeled `[MARKET HUB]`.

A station or structure final stop is represented as a docking destination. Reaching its solar system leaves the route in **Docking** state. The route becomes **Complete** when ESI reports the character at that exact station or structure.

## Coverage routes

Coverage planning loads every solar system in a selected region or constellation and orders the systems using shortest available legs. The origin can be optimized automatically or supplied explicitly.

Coverage systems and avoided systems cannot overlap. Remove a coverage system from the route’s avoid list when that system must be visited.

## Route preferences

The routing preference is selected in Settings and remains adjustable in every route workflow:

- **Shortest** minimizes the number of traversed connections.
- **Safest** favors higher-security systems.
- **Less secure** favors lower-security systems.

Security strictness controls how strongly security status affects Safest and Less secure calculations. It is disabled for Shortest because Shortest does not use security weighting.

## Avoided systems and custom connections

Settings contains the default avoid list. It initially contains Jita. New saved routes and direct routes begin with a copy of this list, and each planner can add or remove systems independently.

An avoided system is not used as an intermediate gate-routing system. An explicitly selected origin or destination remains reachable.

Custom connections are manually entered, directional system-to-system edges in the route graph. Add the reverse direction separately when travel works both ways.

## Thera and Turnur

Thera and Turnur shortcuts use completed, unexpired public signatures from the EVE-Scout API. The app caches the live response in memory for five minutes.

Settings provides the default Thera and Turnur selections. The route editor, assignment dialog, and direct-route dialog can change those selections for the operation being performed.

EVE autopilot cannot traverse a wormhole and wormhole-only systems cannot be submitted as normal ESI waypoints. Splash therefore divides delivery into gate-reachable segments:

1. It submits the reachable waypoints before the wormhole.
2. Route Progress shows the system, `Warp to SIG` instruction, signature ID, destination, wormhole type, ship-size limit, and expiration.
3. Location polling detects the pilot on the far side.
4. The app submits the next gate-reachable segment.

All remaining explicit stops in a gate-only route are sent together. Staggered delivery is used only when a wormhole interrupts the path.

The planner displays EVE-Scout’s ship-size information but does not exclude a connection based on the pilot’s active ship mass.

## EVE waypoint behavior

Normal delivery sends the route’s explicit stops and lets EVE calculate gate travel between them.

**Override Game Routing** sends every calculated solar system in order so the in-game route follows Splash’s gate path. The option is off by default and is available in Settings and each route workflow.

Assigning a saved route to multiple pilots gives every selected pilot the entire route. Route systems are never divided among pilots.

Only online pilots can receive or clear routes. Clear Route submits the pilot’s current known location as the replacement ESI waypoint and removes the app’s tracked assignment after ESI accepts the request.

Removing a pilot from Route Progress only removes the app’s assignment and progress tracking. It does not change that pilot’s in-game EVE autopilot route.

**Auto-remove complete** applies that same tracking-only removal automatically when a pilot reaches the final system, or docks at the final station or structure. Offline pilots remain visible in Route Progress while they still have an assignment.

The pencil action in Route Progress edits the pilot’s assigned route. Saved assignments open the saved-route editor. Direct assignments reopen the direct-route form with the destination and routing options prefilled; the pilot must be online to send the updated direct route.

The direct-route form previews one calculated path whenever all selected pilots share the same current solar system. When their current systems differ or are not all known, it states that pilot-specific routes will be calculated separately.

## Route Progress

Online state is checked every 15 seconds. Online character location and ship data are refreshed every 8 seconds.

Route Progress compares the live character location with the calculated system path. Pilots are sorted by jumps remaining by default, with pilot name available as an alternate sort. Transit systems are squares, specified route stops are plus signs, and a final station or structure is a hollow square. Expanding a progress row shows each remaining system’s name, security status, and region.

While the page is open, each observed location update advances the tracked path and triggers the next staged waypoint when needed. After the page is reopened, the app catches up from the pilot’s current system when that system can be matched to the route. Travel completed before the pilot moved somewhere else cannot be reconstructed from ESI’s current-location response.

If the live topology, an avoided system, or a custom connection leaves two stops disconnected, the planner reports that no known route exists between them.
