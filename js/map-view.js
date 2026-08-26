import {
  addMapSystem,
  assignConnectionSignature,
  connectedMapSystemIds,
  connectionLifeExpiresAt,
  connectionId,
  computeChainLayout,
  emptyMapState,
  fitChainViewport,
  nextMapExpirationAt,
  normalizeMapState,
  observeCharacterMovements,
  parseScannerSignatures,
  preferredMapRoot,
  pruneExpiredConnections,
  pruneExpiredSignatures,
  removeMapConnection,
  removeMapSignature,
  removeMapSystem,
  resetOfflineCharacterTracking,
  updateConnectionCondition,
  updateMapSignature,
  upsertSignatures,
  wormholeSignatureCandidates
} from './map-domain.js?v=20260826-2';

const MAP_STATE_KEY = 'mapper-state';
const MAP_VIEWPORT_KEY = 'mapper-viewport';
const MAP_VIEWPORT_SESSION_KEY = 'splash:mapper-viewport';
const NODE_WIDTH = 176;
const NODE_HEIGHT = 72;
const MAP_LAYOUT_SPACING = Object.freeze({
  expanded: Object.freeze({ columnGap: 220, levelGap: 126 }),
  compact: Object.freeze({ columnGap: 184, levelGap: 88, packing: 'contour' })
});
const SIGNATURE_ID_PATTERN = /^[A-Z0-9]{3}(?:-[A-Z0-9]{3})?$/;
const SIGNATURE_GROUPS = ['Cosmic Signature', 'Wormhole', 'Relic Site', 'Data Site', 'Gas Site', 'Combat Site', 'Unknown'];
const CONNECTION_LIFE_OPTIONS = [
  ['stable', 'Stable'],
  ['under-4h', '&lt;4 hours'],
  ['under-1h', '&lt;1 hour'],
  ['expired', 'Expired']
];

function svgEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ageLabel(value) {
  if (!value) return 'new';
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours) return `${hours}h`;
  return `${Math.max(1, Math.floor(elapsed / 60_000))}m`;
}

function systemBand(system) {
  if (system.id >= 31_000_000 && system.id <= 31_999_999) return '#8d5ad8';
  if (system.security >= 0.5) return '#58bfe7';
  if (system.security > 0) return '#e39a48';
  return '#bf5267';
}

function systemClass(system) {
  if (system.id >= 31_000_000 && system.id <= 31_999_999) return 'J-space';
  if (system.security >= 0.5) return 'High security';
  if (system.security > 0) return 'Low security';
  return 'Null security';
}

export function wormholeSystemDisplay(system) {
  const details = system?.wormhole;
  if (!details || !Number.isSafeInteger(Number(details.class))) return null;
  const destinationOrder = ['HS', 'LS', 'NS', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C13', 'Thera', 'Sentinel', 'Barbican', 'Vidette', 'Conflux', 'Redoubt', 'Pochven'];
  const destinationRanks = new Map(destinationOrder.map((destination, index) => [destination, index]));
  const statics = (Array.isArray(details.statics) ? details.statics : []).map((staticExit) => {
    const pair = Array.isArray(staticExit);
    const object = staticExit && typeof staticExit === 'object' && !pair;
    return {
      code: String(pair ? staticExit[0] : object ? staticExit.code : staticExit || '').trim().toUpperCase(),
      destination: String(pair ? staticExit[1] : object ? staticExit.destination : '').trim()
    };
  }).filter((staticExit) => staticExit.code).sort((left, right) => {
    const leftRank = destinationRanks.get(left.destination) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = destinationRanks.get(right.destination) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.destination.localeCompare(right.destination) || left.code.localeCompare(right.code);
  });
  const staticLabels = statics.map((staticExit) => staticExit.destination
    ? `${staticExit.destination} (${staticExit.code})`
    : staticExit.code);
  const effect = String(details.effect || '').trim();
  return {
    classLabel: `C${details.class}`,
    effect,
    statics,
    staticLabels,
    heading: [String(system.name || ''), `(C${details.class})`, effect].filter(Boolean).join(' ')
  };
}

function signatureGroupOptions(selectedGroup) {
  const groups = SIGNATURE_GROUPS.includes(selectedGroup) ? SIGNATURE_GROUPS : [selectedGroup, ...SIGNATURE_GROUPS];
  return groups.map((group) => `<option value="${svgEscape(group)}" ${group === selectedGroup ? 'selected' : ''}>${svgEscape(group === 'Cosmic Signature' ? 'Signature' : group)}</option>`).join('');
}

function connectionLifeOptions(selectedLife) {
  return CONNECTION_LIFE_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === selectedLife ? 'selected' : ''}>${label}</option>`).join('');
}

function connectionCountdownText(connection, now = Date.now()) {
  if (!connection) return '';
  const expiration = Date.parse(connection.expiresAt);
  if (!Number.isFinite(expiration)) return 'Timer starts when saved';
  const remaining = Math.max(0, expiration - now);
  if (!remaining) return 'Expired · removing connection…';
  const totalSeconds = Math.ceil(remaining / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const duration = hours ? `${hours}h ${minutes}m` : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const life = connection.life === 'expired'
    ? 'Expired'
    : connection.life === 'under-1h'
      ? '<1 hour'
      : connection.life === 'under-4h'
        ? '<4 hours'
        : 'Stable';
  return `${life} · auto-deletes in ${duration}`;
}

export function normalizeMapLayoutSpacing(value) {
  const spacing = Number(value);
  return Number.isFinite(spacing) ? Math.min(100, Math.max(0, spacing)) : 100;
}

export function computeMapLayout(nodes, connections, rootId, layoutSpacing = 100, verticalSpacing = layoutSpacing) {
  const horizontalBlend = normalizeMapLayoutSpacing(layoutSpacing) / 100;
  const verticalBlend = normalizeMapLayoutSpacing(verticalSpacing) / 100;
  const compact = computeChainLayout(nodes, connections, rootId, MAP_LAYOUT_SPACING.compact);
  if (horizontalBlend === 0 && verticalBlend === 0) return compact;
  const expanded = computeChainLayout(nodes, connections, rootId, MAP_LAYOUT_SPACING.expanded);
  if (horizontalBlend === 1 && verticalBlend === 1) return expanded;
  const positions = new Map();
  expanded.forEach((expandedPosition, id) => {
    const compactPosition = compact.get(id) || expandedPosition;
    positions.set(id, {
      ...expandedPosition,
      x: compactPosition.x + (expandedPosition.x - compactPosition.x) * horizontalBlend,
      y: compactPosition.y + (expandedPosition.y - compactPosition.y) * verticalBlend
    });
  });
  return positions;
}

export function mapConnectionPath(from, to, options = {}) {
  if (!from || !to) return '';
  if (from.depth !== to.depth) {
    const parent = from.depth < to.depth ? from : to;
    const child = from.depth < to.depth ? to : from;
    const startX = Number.isFinite(options.parentPortX) ? options.parentPortX : parent.x + NODE_WIDTH / 2;
    const startY = parent.y + NODE_HEIGHT;
    const endX = Number.isFinite(options.childPortX) ? options.childPortX : child.x + NODE_WIDTH / 2;
    const endY = child.y;
    if (startX === endX) return `M ${startX} ${startY} L ${endX} ${endY}`;
    const branchY = Number.isFinite(options.branchY) ? options.branchY : startY + (endY - startY) / 2;
    return `M ${startX} ${startY} L ${startX} ${branchY} L ${endX} ${branchY} L ${endX} ${endY}`;
  }
  const leftToRight = from.x <= to.x;
  const startX = from.x + (leftToRight ? NODE_WIDTH : 0);
  const endX = to.x + (leftToRight ? 0 : NODE_WIDTH);
  const startY = from.y + NODE_HEIGHT / 2;
  const endY = to.y + NODE_HEIGHT / 2;
  return `M ${startX} ${startY} L ${endX} ${endY}`;
}

export function curvedMapConnectionPath(from, to) {
  if (!from || !to) return '';
  if (from.depth !== to.depth) {
    const parent = from.depth < to.depth ? from : to;
    const child = from.depth < to.depth ? to : from;
    const startX = parent.x + NODE_WIDTH / 2;
    const startY = parent.y + NODE_HEIGHT;
    const endX = child.x + NODE_WIDTH / 2;
    const endY = child.y;
    const bend = Math.max(28, (endY - startY) * .52);
    return `M ${startX} ${startY} C ${startX} ${startY + bend}, ${endX} ${endY - bend}, ${endX} ${endY}`;
  }
  const leftToRight = from.x <= to.x;
  const startX = from.x + (leftToRight ? NODE_WIDTH : 0);
  const endX = to.x + (leftToRight ? 0 : NODE_WIDTH);
  const startY = from.y + NODE_HEIGHT / 2;
  const endY = to.y + NODE_HEIGHT / 2;
  const bend = Math.max(46, Math.abs(endX - startX) * .48);
  const direction = leftToRight ? 1 : -1;
  return `M ${startX} ${startY} C ${startX + bend * direction} ${startY}, ${endX - bend * direction} ${endY}, ${endX} ${endY}`;
}

export function mapConnectionPaths(connections, positions) {
  const paths = new Map();
  (connections || []).forEach((connection, index) => {
    const from = positions.get(connection.from);
    const to = positions.get(connection.to);
    if (!from || !to) return;
    const key = connection.id || `${connection.from}:${connection.to}:${index}`;
    paths.set(key, mapConnectionPath(from, to));
  });
  return paths;
}

function signatureCount(map) {
  return Object.values(map?.signatures || {}).reduce((count, rows) => count + rows.length, 0);
}

function localConnectionSignature(connection, systemId) {
  return String((connection.from === Number(systemId) ? connection.fromSignature : connection.toSignature) || '').toUpperCase();
}

function recordedSignatureForConnection(signatures, connection, systemId) {
  const connectionSignature = localConnectionSignature(connection, systemId);
  if (!connectionSignature) return null;
  const exact = signatures.find((signature) => signature.id === connectionSignature);
  if (exact) return exact;
  if (!/^[A-Z0-9]{3}$/.test(connectionSignature)) return null;
  const prefixMatches = signatures.filter((signature) => signature.id.startsWith(`${connectionSignature}-`));
  return prefixMatches.length === 1 ? prefixMatches[0] : null;
}

export function mapSystemSignatureRows(map, systemId) {
  const id = Number(systemId);
  const signatures = map?.signatures?.[id] || [];
  const connections = (map?.connections || []).filter((connection) => connection.kind !== 'gate'
    && (connection.from === id || connection.to === id));
  const connectionSignatures = new Map(connections.map((connection) => [
    connection.id,
    recordedSignatureForConnection(signatures, connection, id)
  ]));
  const rows = signatures.map((signature) => ({
    signature,
    connection: connections.find((candidate) => connectionSignatures.get(candidate.id)?.id === signature.id) || null,
    synthetic: false
  }));
  connections.forEach((connection) => {
    if (connectionSignatures.get(connection.id)) return;
    rows.push({
      signature: {
        id: localConnectionSignature(connection, id) || '???-???',
        group: 'Wormhole',
        type: '',
        name: '',
        updatedAt: connection.updatedAt || connection.createdAt || null
      },
      connection,
      synthetic: true
    });
  });
  return rows;
}

export class MapperView {
  constructor({ store, graph, toast, confirmAction, portraitUrl, activeCharacterId = null, onSystemSelected = () => {} }) {
    this.store = store;
    this.graph = graph;
    this.toast = toast;
    this.confirmAction = confirmAction;
    this.portraitUrl = portraitUrl;
    this.activeCharacterId = Number(activeCharacterId) || null;
    this.onSystemSelected = onSystemSelected;
    this.map = emptyMapState();
    this.characters = [];
    this.visibleNodes = [];
    this.visibleConnections = [];
    this.positions = new Map();
    this.layoutRootId = null;
    this.viewport = { x: 80, y: 80, scale: 1 };
    this.rememberedScale = null;
    this.viewportSaveTimer = null;
    this.panning = null;
    this.hasFit = false;
    this.jumpPromptQueue = [];
    this.activeJumpPrompt = null;
    this.editingSignature = null;
    this.editingConnectionId = null;
    this.editingConnectionDraft = null;
    this.mapExpiryTimer = null;
    this.connectionCountdownTimer = null;
    this.draggingSignature = null;
  }

  async init() {
    const [savedMap, savedViewport] = await Promise.all([
      this.store.getSetting(MAP_STATE_KEY, null),
      this.store.getSetting(MAP_VIEWPORT_KEY, null)
    ]);
    this.map = normalizeMapState(savedMap, this.graph);
    await this.removeExpiredMapItems({ notify: false, render: false });
    let sessionViewport = null;
    try {
      sessionViewport = JSON.parse(sessionStorage.getItem(MAP_VIEWPORT_SESSION_KEY) || 'null');
    } catch (_) {
      sessionViewport = null;
    }
    const scale = Number(sessionViewport?.scale ?? savedViewport?.scale);
    this.rememberedScale = Number.isFinite(scale) ? Math.min(2.4, Math.max(.28, scale)) : null;
    this.bindEvents();
    this.render();
  }

  async reload() {
    const previousConnectionIds = new Set(this.map.connections.map((connection) => connection.id));
    const selectedSystemId = this.map.selectedSystemId;
    const latest = normalizeMapState(await this.store.getSetting(MAP_STATE_KEY, null), this.graph);
    this.map = latest.nodes.some((node) => node.id === selectedSystemId)
      ? { ...latest, selectedSystemId }
      : latest;
    await this.removeExpiredMapItems({ notify: false, render: false });
    this.render(this.characters);
    const newTrackedJumps = this.map.connections
      .filter((connection) => connection.kind === 'wormhole'
        && connection.source === 'tracked'
        && !connection.fromSignature
        && !previousConnectionIds.has(connection.id))
      .map((connection) => ({
        type: 'wormhole-jump',
        from: connection.from,
        to: connection.to,
        connectionId: connection.id,
        characterId: null
      }));
    if (this.activeJumpPrompt && this.connectionSignatureForJump(this.activeJumpPrompt)) this.finishJumpPrompt();
    this.queueJumpPrompts(newTrackedJumps);
  }

  render(characters = this.characters) {
    this.characters = Array.isArray(characters) ? characters : [];
    const activeCharacter = this.characters.find((character) => Number(character.id) === this.activeCharacterId) || null;
    const activeSystemId = Number(activeCharacter?.location?.id) || null;
    const mappedIds = new Set(this.map.nodes.map((node) => node.id));
    const visibleIds = this.activeCharacterId
      ? connectedMapSystemIds(this.map.nodes, this.map.connections, activeSystemId)
      : mappedIds;
    this.visibleNodes = this.map.nodes.filter((node) => visibleIds.has(node.id));
    this.visibleConnections = this.map.connections.filter((connection) => visibleIds.has(connection.from) && visibleIds.has(connection.to));
    const visibleMap = { ...this.map, nodes: this.visibleNodes, connections: this.visibleConnections };
    this.layoutRootId = visibleIds.has(activeSystemId)
      ? activeSystemId
      : preferredMapRoot(visibleMap, activeCharacter ? [activeCharacter] : this.characters);
    if (this.layoutRootId && !visibleIds.has(Number(this.map.selectedSystemId))) {
      this.map = { ...this.map, selectedSystemId: this.layoutRootId };
    }
    this.positions = computeMapLayout(
      this.visibleNodes,
      this.visibleConnections,
      this.layoutRootId,
      this.map.layoutSpacing,
      this.map.layoutVerticalSpacing
    );
    this.renderToolbar();
    this.renderGraph();
    this.renderInspector();
    this.scheduleMapExpiry();
  }

  setActiveCharacter(characterId, { fit = false, notify = true } = {}) {
    const id = Number(characterId);
    if (!this.characters.some((character) => Number(character.id) === id)) return false;
    this.activeCharacterId = id;
    const previousSelection = this.map.selectedSystemId;
    this.hasFit = false;
    this.render();
    if (notify && this.map.selectedSystemId !== previousSelection) this.onSystemSelected(this.map.selectedSystemId);
    if (fit) requestAnimationFrame(() => this.fit({ preferredScale: this.rememberedScale, persist: false }));
    return true;
  }

  renderToolbar() {
    const autoTrack = document.getElementById('map-auto-track');
    if (autoTrack) autoTrack.checked = this.map.autoTrack;
    document.querySelectorAll('[data-map-connection-style]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.mapConnectionStyle === this.map.connectionStyle));
    });
    [
      ['map-layout-spacing', this.map.layoutSpacing, 'horizontal'],
      ['map-layout-vertical-spacing', this.map.layoutVerticalSpacing, 'vertical']
    ].forEach(([elementId, spacing, axis]) => {
      const input = document.getElementById(elementId);
      if (!input) return;
      input.value = String(normalizeMapLayoutSpacing(spacing));
      const valueText = input.value === '0'
        ? `Minimum ${axis} spacing`
        : input.value === '100' ? `Maximum ${axis} spacing` : `${input.value}% ${axis} spacing`;
      input.setAttribute('aria-valuetext', valueText);
    });
  }

  renderGraph() {
    const svg = document.getElementById('chain-map');
    const empty = document.getElementById('map-empty-state');
    if (!svg || !empty) return;
    empty.hidden = this.visibleNodes.length > 0;
    if (!this.visibleNodes.length && this.activeCharacterId) {
      const character = this.characters.find((candidate) => Number(candidate.id) === this.activeCharacterId);
      const heading = empty.querySelector('h2');
      const message = empty.querySelector('p');
      if (heading) heading.textContent = character ? `${character.name}'s chain` : 'Start a chain';
      if (message) message.textContent = character?.location?.name
        ? `Waiting for ${character.location.name} to be added by live tracking.`
        : 'Waiting for this pilot’s current location.';
    }
    const pilotGroups = new Map();
    this.characters.forEach((character) => {
      if (character?.presence?.online !== true || !character.location?.id) return;
      const id = Number(character.location.id);
      if (!pilotGroups.has(id)) pilotGroups.set(id, []);
      pilotGroups.get(id).push(character);
    });
    const pipePaths = this.map.connectionStyle === 'pipe'
      ? mapConnectionPaths(this.visibleConnections, this.positions)
      : null;
    const edges = this.visibleConnections.map((connection) => {
      const from = this.positions.get(connection.from);
      const to = this.positions.get(connection.to);
      if (!from || !to) return '';
      const fromSystem = this.graph.get(connection.from);
      const toSystem = this.graph.get(connection.to);
      const interaction = connection.kind === 'gate'
        ? ''
        : `data-map-connection="${connection.id}" role="button" tabindex="0" aria-label="Edit wormhole connection between ${svgEscape(fromSystem?.name || connection.from)} and ${svgEscape(toSystem?.name || connection.to)}"`;
      const path = pipePaths?.get(connection.id) || curvedMapConnectionPath(from, to);
      return `<g class="map-connection-group is-style-${this.map.connectionStyle} is-life-${connection.life} is-mass-${connection.mass} is-size-${connection.size}" ${interaction}>
        <path class="map-connection-hit" d="${path}"></path>
        <path class="map-connection-line" d="${path}"></path>
      </g>`;
    }).join('');
    const nodes = this.visibleNodes.map((node) => {
      const position = this.positions.get(node.id);
      const system = this.graph.get(node.id);
      if (!position || !system) return '';
      const region = this.graph.regions.get(system.regionId)?.name || 'Unknown region';
      const wormhole = wormholeSystemDisplay(system);
      const pilots = pilotGroups.get(node.id) || [];
      const signatures = mapSystemSignatureRows(this.map, node.id).length;
      const selected = this.map.selectedSystemId === node.id;
      const metadata = `${systemClass(system)} · ${region}`;
      const wormholeStaticLines = wormhole
        ? (wormhole.staticLabels.length > 3
            ? [wormhole.staticLabels.slice(0, 3), wormhole.staticLabels.slice(3)]
            : [wormhole.staticLabels])
          .filter((line) => line.length)
          .map((line) => line.join(', '))
        : [];
      const fitWormholeHeading = wormhole?.heading.length > 24
        ? ` textLength="${NODE_WIDTH - 30}" lengthAdjust="spacingAndGlyphs"`
        : '';
      const accessibleName = wormhole ? `${wormhole.heading}, statics ${wormhole.staticLabels.join(', ')}` : system.name;
      const portraits = pilots.slice(0, 4).map((character, index) =>
        `<image class="map-pilot-image" href="${this.portraitUrl(character.id, 64)}" x="${NODE_WIDTH - 23 - index * 18}" y="46" width="20" height="20"><title>${svgEscape(character.name)}</title></image>`
      ).join('');
      return `<g class="map-system-node ${selected ? 'is-selected' : ''}" transform="translate(${position.x} ${position.y})" data-map-system="${node.id}" role="button" tabindex="0" aria-label="${svgEscape(accessibleName)}">
        ${wormhole ? `<title>${svgEscape(`${wormhole.heading} · Statics ${wormhole.staticLabels.join(', ')}`)}</title>` : ''}
        <rect class="map-node-shadow" x="2" y="3" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="5"></rect>
        <rect class="map-node-body" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="5"></rect>
        <rect class="map-node-band" width="5" height="${NODE_HEIGHT}" rx="3" fill="${systemBand(system)}"></rect>
        <text class="map-node-name ${wormhole && !node.alias ? 'is-wormhole' : ''}" x="15" y="23"${!node.alias ? fitWormholeHeading : ''}>${svgEscape(node.alias || wormhole?.heading || system.name)}</text>
        ${node.alias ? `<text class="map-node-alias" x="15" y="39"${fitWormholeHeading}>${svgEscape(wormhole?.heading || system.name)}</text>` : ''}
        ${wormhole ? '' : `<text class="map-node-meta" x="15" y="${node.alias ? 54 : 42}">${svgEscape(metadata)}</text>`}
        ${wormholeStaticLines.map((line, index) => `<text class="map-node-wormhole" x="15" y="${(node.alias ? 54 : 43) + index * 13}">${svgEscape(line)}</text>`).join('') || (signatures ? `<text class="map-node-signatures" x="15" y="63">${signatures} sig${signatures === 1 ? '' : 's'}</text>` : '')}
        ${portraits}
      </g>`;
    }).join('');
    svg.innerHTML = `<g id="map-viewport" transform="translate(${this.viewport.x} ${this.viewport.y}) scale(${this.viewport.scale})">${edges}${nodes}</g>`;
  }

  renderInspector() {
    const container = document.getElementById('map-inspector-content');
    if (!container) return;
    const node = this.visibleNodes.find((candidate) => candidate.id === this.map.selectedSystemId);
    const system = node ? this.graph.get(node.id) : null;
    if (!node || !system) {
      container.innerHTML = '<div class="map-inspector-empty"><span>⌖</span><h2>No system selected</h2><p>Select a system card to inspect its signatures and connections.</p></div>';
      return;
    }
    const region = this.graph.regions.get(system.regionId)?.name || 'Unknown region';
    const wormhole = wormholeSystemDisplay(system);
    const signatureEntries = mapSystemSignatureRows(this.map, node.id);
    const draggableSignatureIds = new Set(wormholeSignatureCandidates(this.map, node.id).map((signature) => signature.id));
    const signatureRows = signatureEntries.length ? signatureEntries.map(({ signature, connection, synthetic }) => {
      const otherId = connection ? connection.from === node.id ? connection.to : connection.from : null;
      const other = otherId ? this.graph.get(otherId) : null;
      const effectiveGroup = connection && signature.group === 'Cosmic Signature' ? 'Wormhole' : signature.group;
      const group = effectiveGroup === 'Cosmic Signature' ? 'Signature' : effectiveGroup;
      const detail = signature.type || signature.name || '—';
      const displayedDetail = connection ? [other?.name || otherId, connection.type].filter(Boolean).join(' · ') : detail;
      const editing = this.editingSignature?.systemId === node.id
        && this.editingSignature.id === signature.id
        && (this.editingSignature.connectionId || '') === (synthetic ? connection.id : '');
      const draggable = !synthetic && draggableSignatureIds.has(signature.id) && !editing;
      const connectionEditor = connection ? `<div class="map-signature-connection" data-map-connection-card="${connection.id}">
        <div class="map-signature-connection-heading"><span>Connection</span><button type="button" data-map-select-system="${otherId}">${svgEscape(other?.name || otherId)}</button><button class="map-inline-remove" type="button" data-map-remove-connection="${connection.id}" aria-label="Remove connection to ${svgEscape(other?.name || otherId)}">×</button></div>
        <div class="map-exit-fields map-signature-connection-fields">
          <label>Life<select name="connectionLife">${connectionLifeOptions(connection.life)}</select></label>
          <label>Mass<select name="connectionMass"><option value="stable" ${connection.mass === 'stable' ? 'selected' : ''}>Stable</option><option value="reduced" ${connection.mass === 'reduced' ? 'selected' : ''}>Reduced</option><option value="critical" ${connection.mass === 'critical' ? 'selected' : ''}>Critical</option></select></label>
          <label>Size<select name="connectionSize"><option value="frigate" ${connection.size === 'frigate' ? 'selected' : ''}>Frigate</option><option value="small" ${connection.size === 'small' ? 'selected' : ''}>Small</option><option value="medium" ${connection.size === 'medium' ? 'selected' : ''}>Medium</option><option value="large" ${connection.size === 'large' ? 'selected' : ''}>Large</option><option value="xlarge" ${connection.size === 'xlarge' ? 'selected' : ''}>XL</option></select></label>
          <label class="map-signature-connection-type">WH type<input name="connectionType" maxlength="12" autocomplete="off" value="${svgEscape(connection.type)}" placeholder="K162"></label>
        </div>
      </div>` : '';
      const editor = editing ? `<tr id="map-signature-editor-${svgEscape(signature.id)}" class="map-signature-editor-row"><td colspan="5">
        <form class="map-signature-edit-form" data-map-signature-edit-form="${synthetic ? '' : svgEscape(signature.id)}" ${connection ? `data-map-connection-id="${connection.id}"` : ''} ${synthetic ? `data-map-synthetic-connection-id="${connection.id}"` : ''} autocomplete="off">
          <label><span>Signature</span><input name="id" maxlength="7" value="${svgEscape(synthetic && signature.id === '???-???' ? '' : signature.id)}" placeholder="ABC-123" aria-label="Signature ID" required></label>
          <label><span>Group</span><select name="group" aria-label="Signature group">${signatureGroupOptions(effectiveGroup)}</select></label>
          <label class="map-signature-edit-type"><span>Type / name</span><input name="type" maxlength="72" value="${svgEscape(signature.type || signature.name)}" aria-label="Signature type or name"></label>
          ${connectionEditor}
          <div class="map-signature-edit-actions"><button class="button button-ghost" type="button" data-map-action="cancel-signature-edit">Cancel</button><button class="button button-primary" type="submit">Save</button></div>
        </form>
      </td></tr>` : '';
      const dragTitle = draggable ? ' · Drag onto a system to assign' : '';
      return `<tr class="map-signature-row ${editing ? 'is-editing' : ''}" data-map-edit-signature="${svgEscape(signature.id)}" ${synthetic ? `data-map-edit-connection-id="${connection.id}" data-map-synthetic-signature="true"` : ''} ${draggable ? `draggable="true" data-map-drag-signature="${svgEscape(signature.id)}" data-map-drag-system="${node.id}"` : ''} title="${svgEscape(`${signature.id} · ${effectiveGroup}${detail === '—' ? '' : ` · ${detail}`}${connection ? ` · ${other?.name || otherId}` : ''}${dragTitle}`)}">
        <td class="map-signature-id"><button class="map-signature-edit-trigger" type="button" aria-expanded="${editing}" aria-label="Edit signature ${svgEscape(signature.id)}">${svgEscape(signature.id)}</button></td>
        <td class="map-signature-group">${svgEscape(group)}</td>
        <td class="map-signature-type" title="${svgEscape(displayedDetail)}">${svgEscape(displayedDetail)}</td>
        <td class="map-signature-age">${svgEscape(ageLabel(signature.updatedAt))}</td>
        <td class="map-signature-remove"><button type="button" ${synthetic ? `data-map-remove-connection="${connection.id}" aria-label="Remove connection to ${svgEscape(other?.name || otherId)}"` : `data-map-remove-signature="${svgEscape(signature.id)}" aria-label="Remove ${svgEscape(signature.id)}"`}>×</button></td>
      </tr>${editor}`;
    }).join('') : '<tr><td class="map-signature-empty" colspan="5">No signatures recorded.</td></tr>';
    const systemFacts = wormhole
      ? [node.alias ? wormhole.heading : null, region, `Statics ${wormhole.staticLabels.join(', ')}`, `${ageLabel(node.createdAt)} old`].filter(Boolean)
      : [node.alias ? system.name : null, region, system.security.toFixed(1), systemClass(system), `${ageLabel(node.createdAt)} old`].filter(Boolean);
    container.innerHTML = `<header class="map-inspector-system" style="--system-band:${systemBand(system)}">
      <div class="map-inspector-title-row"><div><span class="eyebrow">Selected system</span><input class="map-system-alias-input" data-map-node-field="alias" value="${svgEscape(node.alias)}" placeholder="${svgEscape(wormhole?.heading || system.name)}" maxlength="60" aria-label="System alias"></div><button class="map-system-remove" type="button" data-map-action="remove-system" aria-label="Remove ${svgEscape(system.name)}" title="Remove system">×</button></div>
      <p class="map-system-facts">${systemFacts.map((fact) => `<span>${svgEscape(fact)}</span>`).join('')}</p>
    </header>
    <section class="map-inspector-section"><div class="map-section-heading"><h2>Signatures <span class="map-section-count">${signatureEntries.length}</span></h2><button class="button button-primary map-paste-button" type="button" data-map-action="paste-signatures"><svg class="map-paste-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5h-1A1.5 1.5 0 0 0 3 5v7.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V5a1.5 1.5 0 0 0-1.5-1.5h-1"/><rect x="5.5" y="2" width="5" height="3" rx="1"/></svg><span>Paste scan</span></button></div>
      <table class="map-signature-table"><tbody>${signatureRows}</tbody></table>
      <details class="map-signature-manual"><summary>Add one manually</summary><form id="map-signature-form" class="map-signature-form" autocomplete="off"><input id="map-signature-id" maxlength="7" placeholder="ABC" aria-label="Signature ID" autocapitalize="characters" required><select id="map-signature-group" aria-label="Signature group"><option>Wormhole</option><option>Relic Site</option><option>Data Site</option><option>Gas Site</option><option>Combat Site</option><option>Unknown</option></select><input id="map-signature-type" maxlength="72" placeholder="Type / name" aria-label="Signature type"><button class="button button-ghost" type="submit">Add</button></form></details>
      <details class="map-signature-import"><summary>Paste probe scanner results</summary><textarea id="map-signature-paste" rows="5" placeholder="Copy rows from the EVE probe scanner and paste them here"></textarea><button class="button button-ghost" type="button" data-map-action="import-signatures">Import scan</button></details>
    </section>`;
  }

  updateViewport() {
    const viewport = document.getElementById('map-viewport');
    if (viewport) viewport.setAttribute('transform', `translate(${this.viewport.x} ${this.viewport.y}) scale(${this.viewport.scale})`);
  }

  fit({ preferredScale = null, persist = true } = {}) {
    const canvas = document.getElementById('chain-map');
    if (!canvas || !this.positions.size) return;
    const rect = canvas.getBoundingClientRect();
    const topGap = Number.parseFloat(getComputedStyle(canvas).fontSize) || 16;
    this.viewport = fitChainViewport(
      this.positions,
      this.layoutRootId,
      rect,
      { width: NODE_WIDTH, height: NODE_HEIGHT },
      { topGap, preferredScale }
    );
    this.hasFit = true;
    this.updateViewport();
    if (persist) this.rememberViewportScale();
  }

  rememberViewportScale() {
    this.rememberedScale = this.viewport.scale;
    window.clearTimeout(this.viewportSaveTimer);
    this.viewportSaveTimer = window.setTimeout(() => {
      try {
        sessionStorage.setItem(MAP_VIEWPORT_SESSION_KEY, JSON.stringify({ scale: this.rememberedScale }));
      } catch (_) {
        // IndexedDB remains the persistence fallback when session storage is unavailable.
      }
      this.store.setSetting(MAP_VIEWPORT_KEY, { scale: this.rememberedScale })
        .catch((error) => this.toast(error.message, 'error'));
    }, 180);
  }

  zoom(factor, clientX = null, clientY = null) {
    const svg = document.getElementById('chain-map');
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = clientX == null ? rect.width / 2 : clientX - rect.left;
    const y = clientY == null ? rect.height / 2 : clientY - rect.top;
    const oldScale = this.viewport.scale;
    const scale = Math.min(2.4, Math.max(.28, oldScale * factor));
    const worldX = (x - this.viewport.x) / oldScale;
    const worldY = (y - this.viewport.y) / oldScale;
    this.viewport = { scale, x: x - worldX * scale, y: y - worldY * scale };
    this.updateViewport();
    this.rememberViewportScale();
  }

  activate() {
    if (!this.hasFit) requestAnimationFrame(() => this.fit({ preferredScale: this.rememberedScale, persist: false }));
  }

  async observeCharacters(characters, { trackMovements = true } = {}) {
    this.characters = characters;
    const previousSelection = this.map.selectedSystemId;
    let changes = [];
    let changed = false;
    this.map = await this.store.updateSetting(MAP_STATE_KEY, (storedMap) => {
      const latest = normalizeMapState(storedMap, this.graph);
      const current = latest.nodes.some((node) => node.id === previousSelection)
        ? { ...latest, selectedSystemId: previousSelection }
        : latest;
      const result = trackMovements
        ? observeCharacterMovements(current, characters, this.graph)
        : { map: resetOfflineCharacterTracking(current, characters), changes: [] };
      changes = result.changes;
      changed = result.map !== current;
      return changed ? result.map : storedMap || current;
    }, null);
    this.map = normalizeMapState(this.map, this.graph);
    if (this.map.nodes.some((node) => node.id === previousSelection)) {
      this.map = { ...this.map, selectedSystemId: previousSelection };
    }
    if (changed) {
      this.render();
      if (this.map.selectedSystemId !== previousSelection) this.onSystemSelected(this.map.selectedSystemId);
      if (changes.some((change) => change.type === 'connection')) this.toast('New non-gate connection added to the map.');
      this.queueJumpPrompts(changes.filter((change) => change.type === 'wormhole-jump'));
    } else {
      this.renderGraph();
    }
  }

  connectionSignatureForJump(jump) {
    const connection = this.map.connections.find((candidate) => candidate.id === jump.connectionId);
    if (!connection) return '';
    if (connection.from === jump.from) return connection.fromSignature;
    if (connection.to === jump.from) return connection.toSignature;
    return '';
  }

  queueJumpPrompts(jumps) {
    jumps.forEach((jump) => {
      if (this.connectionSignatureForJump(jump)) return;
      if (!wormholeSignatureCandidates(this.map, jump.from, jump.connectionId).length) return;
      const key = `${jump.connectionId}:${jump.from}`;
      const duplicate = this.activeJumpPrompt?.key === key || this.jumpPromptQueue.some((candidate) => candidate.key === key);
      if (!duplicate) this.jumpPromptQueue.push({ ...jump, key });
    });
    this.showNextJumpPrompt();
  }

  showNextJumpPrompt() {
    if (this.activeJumpPrompt) return;
    const dialog = document.getElementById('map-jump-dialog');
    if (!dialog || [...document.querySelectorAll('dialog[open]')].some((candidate) => candidate !== dialog)) return;
    while (this.jumpPromptQueue.length) {
      const jump = this.jumpPromptQueue.shift();
      if (this.connectionSignatureForJump(jump)) continue;
      const from = this.graph.get(jump.from);
      const to = this.graph.get(jump.to);
      const character = this.characters.find((candidate) => Number(candidate.id) === jump.characterId);
      const signatures = wormholeSignatureCandidates(this.map, jump.from, jump.connectionId);
      if (!signatures.length) continue;
      const options = document.getElementById('map-jump-signatures');
      document.getElementById('map-jump-message').textContent = `${character?.name || 'A tracked pilot'} made a non-gate jump. Select the signature used in ${from?.name || 'the origin system'} so this connection is labeled correctly.`;
      document.getElementById('map-jump-route').innerHTML = `<span><small>From</small><strong>${svgEscape(from?.name || jump.from)}</strong></span><b aria-hidden="true">→</b><span><small>To</small><strong>${svgEscape(to?.name || jump.to)}</strong></span>`;
      options.innerHTML = signatures.map((signature, index) => {
        const detail = signature.type || signature.name || 'Wormhole';
        return `<label class="map-jump-option"><input type="radio" name="map-jump-signature" value="${svgEscape(signature.id)}" ${signatures.length === 1 && index === 0 ? 'checked' : ''}><span><strong>${svgEscape(signature.id)}</strong><small title="${svgEscape(detail)}">${svgEscape(detail)}</small></span></label>`;
      }).join('');
      const manual = document.getElementById('map-jump-signature-manual');
      manual.value = '';
      this.activeJumpPrompt = jump;
      dialog.showModal();
      if (!signatures.length) requestAnimationFrame(() => manual.focus());
      return;
    }
  }

  resolveSignatureReference(systemId, value) {
    const signatureId = String(value || '').trim().toUpperCase();
    if (signatureId.length !== 3) return signatureId;
    const matches = (this.map.signatures[Number(systemId)] || []).filter((signature) => signature.id.startsWith(`${signatureId}-`));
    return matches.length === 1 ? matches[0].id : signatureId;
  }

  finishJumpPrompt() {
    const dialog = document.getElementById('map-jump-dialog');
    if (dialog?.open) dialog.close();
    this.activeJumpPrompt = null;
    queueMicrotask(() => this.showNextJumpPrompt());
  }

  async submitJumpPrompt() {
    if (!this.activeJumpPrompt) return;
    const manual = document.getElementById('map-jump-signature-manual')?.value.trim().toUpperCase() || '';
    const selected = document.querySelector('input[name="map-jump-signature"]:checked')?.value || '';
    const signatureId = this.resolveSignatureReference(this.activeJumpPrompt.from, manual || selected);
    if (!SIGNATURE_ID_PATTERN.test(signatureId)) {
      this.toast('Choose a signature or enter three letters, such as ABC.', 'error');
      return;
    }
    const jump = this.activeJumpPrompt;
    await this.mutate((map) => assignConnectionSignature(map, jump.connectionId, jump.from, signatureId));
    this.toast(`${signatureId} mapped to the ${this.graph.get(jump.from)?.name || 'origin'} connection.`);
    this.finishJumpPrompt();
  }

  async importSignatureText(text) {
    if (!this.map.selectedSystemId) {
      this.toast('Select a system before importing scanner results.', 'error');
      return false;
    }
    const signatures = parseScannerSignatures(text);
    if (!signatures.length) {
      this.toast('No EVE scanner signature rows were recognized.', 'error');
      return false;
    }
    await this.mutate((map) => upsertSignatures(map, map.selectedSystemId, signatures));
    this.toast(`Imported ${signatures.length} signature${signatures.length === 1 ? '' : 's'}.`);
    return true;
  }

  showPasteFallback() {
    const details = document.querySelector('.map-signature-import');
    if (details) details.open = true;
    const textarea = document.getElementById('map-signature-paste');
    textarea?.focus();
    this.toast('Clipboard access was blocked. Press Ctrl+V in the paste field.', 'error');
  }

  async pasteSignaturesFromClipboard() {
    if (!navigator.clipboard?.readText) return this.showPasteFallback();
    try {
      const text = await navigator.clipboard.readText();
      await this.importSignatureText(text);
    } catch (_) {
      this.showPasteFallback();
    }
  }

  scheduleMapExpiry() {
    if (typeof window === 'undefined') return;
    window.clearTimeout(this.mapExpiryTimer);
    const expiration = nextMapExpirationAt(this.map);
    if (!Number.isFinite(expiration)) {
      this.mapExpiryTimer = null;
      return;
    }
    const delay = Math.min(2_147_000_000, Math.max(50, expiration - Date.now() + 25));
    this.mapExpiryTimer = window.setTimeout(() => {
      this.removeExpiredMapItems().catch((error) => this.toast(error.message, 'error'));
    }, delay);
  }

  async removeExpiredMapItems({ notify = true, render = true } = {}) {
    const selectedSystemId = this.map.selectedSystemId;
    let removedConnections = 0;
    let removedSignatures = 0;
    const storedMap = await this.store.updateSetting(MAP_STATE_KEY, (value) => {
      const current = normalizeMapState(value, this.graph);
      const withoutExpiredConnections = pruneExpiredConnections(current);
      const next = pruneExpiredSignatures(withoutExpiredConnections);
      removedConnections = current.connections.length - next.connections.length;
      removedSignatures = signatureCount(withoutExpiredConnections) - signatureCount(next);
      const needsLifetimeMigration = (value?.connections || []).some((connection) => {
        const normalized = current.connections.find((candidate) => candidate.id === connectionId(connection.from, connection.to));
        return normalized && (connection.life !== normalized.life || connection.expiresAt !== normalized.expiresAt);
      });
      return next !== current || needsLifetimeMigration ? next : value || current;
    }, null);
    const latest = normalizeMapState(storedMap, this.graph);
    this.map = latest.nodes.some((node) => node.id === selectedSystemId)
      ? { ...latest, selectedSystemId }
      : latest;
    if (this.editingConnectionId && !this.map.connections.some((connection) => connection.id === this.editingConnectionId)) {
      document.getElementById('map-connection-dialog')?.close();
      this.editingConnectionId = null;
    }
    if (render) this.render();
    if (notify && (removedConnections || removedSignatures)) {
      const removals = [
        removedConnections ? removedConnections === 1 ? 'Wormhole connection' : `${removedConnections} wormhole connections` : '',
        removedSignatures ? removedSignatures === 1 ? 'Signature' : `${removedSignatures} signatures` : ''
      ].filter(Boolean).join(' and ');
      this.toast(`${removals} expired and ${removedConnections + removedSignatures === 1 ? 'was' : 'were'} removed.`);
    }
    return removedConnections + removedSignatures;
  }

  async mutate(mutator, { fit = false } = {}) {
    const previousSelection = this.map.selectedSystemId;
    this.map = await this.store.updateSetting(MAP_STATE_KEY, (storedMap) => {
      const latest = normalizeMapState(storedMap, this.graph);
      const current = latest.nodes.some((node) => node.id === previousSelection)
        ? { ...latest, selectedSystemId: previousSelection }
        : latest;
      return normalizeMapState(mutator(current), this.graph);
    }, null);
    this.render();
    if (this.map.selectedSystemId !== previousSelection) this.onSystemSelected(this.map.selectedSystemId);
    if (fit) requestAnimationFrame(() => this.fit({ preferredScale: this.rememberedScale }));
  }

  selectSystem(systemId, { notify = true } = {}) {
    const id = Number(systemId);
    if (!this.map.nodes.some((node) => node.id === id)) return false;
    const changed = this.map.selectedSystemId !== id;
    if (changed) this.editingSignature = null;
    this.map = { ...this.map, selectedSystemId: id };
    this.render();
    if (notify && changed) this.onSystemSelected(id);
    return true;
  }

  editSignature(signatureId, connectionId = '') {
    const id = String(signatureId || '').toUpperCase();
    const mappedConnectionId = String(connectionId || '');
    const sameSignature = this.editingSignature?.systemId === this.map.selectedSystemId
      && this.editingSignature.id === id
      && (this.editingSignature.connectionId || '') === mappedConnectionId;
    this.editingSignature = sameSignature ? null : { systemId: this.map.selectedSystemId, id, connectionId: mappedConnectionId };
    this.renderInspector();
    if (!sameSignature) requestAnimationFrame(() => document.querySelector('[data-map-signature-edit-form] input[name="id"]')?.select());
  }

  async saveSignatureEdit(editForm) {
    const originalId = editForm.dataset.mapSignatureEditForm;
    const syntheticConnectionId = editForm.dataset.mapSyntheticConnectionId || '';
    const id = editForm.elements.namedItem('id').value.trim().toUpperCase();
    const group = editForm.elements.namedItem('group').value;
    const type = editForm.elements.namedItem('type').value.trim();
    const connectionId = editForm.dataset.mapConnectionId || '';
    if (!SIGNATURE_ID_PATTERN.test(id)) {
      this.toast('Use three letters or a full signature ID, such as ABC or ABC-123.', 'error');
      return false;
    }
    const duplicate = !syntheticConnectionId && (this.map.signatures[this.map.selectedSystemId] || [])
      .some((signature) => signature.id === id && signature.id !== originalId);
    if (duplicate) {
      this.toast(`${id} already exists in this system.`, 'error');
      return false;
    }
    this.editingSignature = null;
    await this.mutate((map) => {
      const updatedAt = new Date().toISOString();
      const assigned = syntheticConnectionId
        ? assignConnectionSignature(map, syntheticConnectionId, map.selectedSystemId, id, () => updatedAt)
        : map;
      const next = updateMapSignature(assigned, map.selectedSystemId, syntheticConnectionId ? id : originalId, { id, group, type, name: type }, () => updatedAt);
      if (!connectionId) return next;
      const life = editForm.elements.namedItem('connectionLife').value;
      const mass = editForm.elements.namedItem('connectionMass').value;
      const size = editForm.elements.namedItem('connectionSize').value;
      const connectionType = editForm.elements.namedItem('connectionType').value.trim().toUpperCase();
      return {
        ...next,
        connections: next.connections.map((connection) => {
          if (connection.id !== connectionId) return connection;
          const signatureField = connection.from === map.selectedSystemId ? 'fromSignature' : 'toSignature';
          return updateConnectionCondition(connection, { [signatureField]: id, life, mass, size, type: connectionType }, updatedAt);
        }),
        updatedAt
      };
    });
    this.toast(`${id} updated.`);
    return true;
  }

  openConnectionEditor(connectionId) {
    const connection = this.map.connections.find((candidate) => candidate.id === String(connectionId));
    const dialog = document.getElementById('map-connection-dialog');
    if (!connection || connection.kind === 'gate' || !dialog) return false;
    const from = this.graph.get(connection.from);
    const to = this.graph.get(connection.to);
    this.editingConnectionId = connection.id;
    this.editingConnectionDraft = { life: connection.life, expiresAt: connection.expiresAt };
    document.getElementById('map-connection-title').textContent = 'Edit wormhole';
    document.getElementById('map-connection-systems').textContent = `${from?.name || connection.from} ↔ ${to?.name || connection.to}`;
    document.getElementById('map-connection-life').value = connection.life;
    document.getElementById('map-connection-mass').value = connection.mass;
    document.getElementById('map-connection-size').value = connection.size;
    dialog.showModal();
    this.startConnectionCountdown();
    requestAnimationFrame(() => document.getElementById('map-connection-life')?.focus());
    return true;
  }

  updateConnectionCountdown() {
    const output = document.getElementById('map-connection-expiry');
    if (!output) return;
    output.textContent = connectionCountdownText(this.editingConnectionDraft);
  }

  startConnectionCountdown() {
    if (typeof window === 'undefined') return;
    window.clearInterval(this.connectionCountdownTimer);
    this.updateConnectionCountdown();
    this.connectionCountdownTimer = window.setInterval(() => this.updateConnectionCountdown(), 1_000);
  }

  stopConnectionCountdown() {
    if (typeof window !== 'undefined') window.clearInterval(this.connectionCountdownTimer);
    this.connectionCountdownTimer = null;
    this.editingConnectionDraft = null;
  }

  async saveConnectionEditor() {
    const connectionId = this.editingConnectionId;
    if (!connectionId) return false;
    const life = document.getElementById('map-connection-life').value;
    const mass = document.getElementById('map-connection-mass').value;
    const size = document.getElementById('map-connection-size').value;
    if (!['stable', 'under-4h', 'under-1h', 'expired'].includes(life)
      || !['stable', 'reduced', 'critical'].includes(mass)
      || !['frigate', 'small', 'medium', 'large', 'xlarge'].includes(size)) {
      this.toast('Choose a valid wormhole condition.', 'error');
      return false;
    }
    const updatedAt = new Date().toISOString();
    await this.mutate((map) => ({
      ...map,
      connections: map.connections.map((connection) => connection.id === connectionId
        ? updateConnectionCondition(connection, { life, mass, size }, updatedAt)
        : connection),
      updatedAt
    }));
    document.getElementById('map-connection-dialog')?.close();
    this.editingConnectionId = null;
    this.toast('Wormhole condition updated.');
    return true;
  }

  async deleteConnectionEditor() {
    const connectionId = this.editingConnectionId;
    if (!connectionId) return false;
    await this.mutate((map) => removeMapConnection(map, connectionId), { fit: true });
    document.getElementById('map-connection-dialog')?.close();
    this.editingConnectionId = null;
    this.toast('Wormhole connection deleted.');
    return true;
  }

  clearSignatureDropTarget() {
    document.querySelectorAll('.map-system-node.is-signature-drop-target').forEach((node) => node.classList.remove('is-signature-drop-target'));
  }

  async assignSignatureToSystem(sourceSystemId, signatureId, targetSystemId) {
    const sourceId = Number(sourceSystemId);
    const targetId = Number(targetSystemId);
    const id = String(signatureId || '').toUpperCase();
    if (!Number.isSafeInteger(sourceId) || !Number.isSafeInteger(targetId) || sourceId === targetId || !SIGNATURE_ID_PATTERN.test(id)) return false;
    let assigned = false;
    let created = false;
    let gateConflict = false;
    await this.mutate((map) => {
      if (!map.nodes.some((node) => node.id === sourceId) || !map.nodes.some((node) => node.id === targetId)) return map;
      if (!wormholeSignatureCandidates(map, sourceId).some((signature) => signature.id === id)) return map;
      const mappedConnectionId = connectionId(sourceId, targetId);
      let connection = map.connections.find((candidate) => candidate.id === mappedConnectionId);
      if (connection?.kind === 'gate') {
        gateConflict = true;
        return map;
      }
      let next = map;
      if (!connection) {
        const target = this.graph.get(targetId);
        if (!target) return map;
        const result = addMapSystem(map, target, { connectFrom: sourceId, kind: 'wormhole', source: 'tracked' });
        if (!result.connected) return map;
        created = true;
        next = {
          ...result.map,
          selectedSystemId: map.selectedSystemId,
          connections: result.map.connections.map((candidate) => candidate.id === mappedConnectionId
            ? { ...candidate, source: 'manual' }
            : candidate)
        };
        connection = next.connections.find((candidate) => candidate.id === mappedConnectionId);
      }
      const result = assignConnectionSignature(next, connection.id, sourceId, id);
      assigned = result !== next;
      return result;
    });
    if (!assigned) {
      this.toast(gateConflict ? 'Those systems are connected by a stargate, not a wormhole.' : `${id} is no longer available to assign.`, 'error');
      return false;
    }
    if (created) requestAnimationFrame(() => this.fit({ preferredScale: this.rememberedScale }));
    this.toast(`${id} assigned to ${this.graph.get(targetId)?.name || targetId}.`);
    return true;
  }

  bindEvents() {
    document.getElementById('map-fit')?.addEventListener('click', () => this.fit());
    document.getElementById('map-zoom-in')?.addEventListener('click', () => this.zoom(1.18));
    document.getElementById('map-zoom-out')?.addEventListener('click', () => this.zoom(1 / 1.18));
    document.getElementById('map-auto-track')?.addEventListener('change', (event) => this.mutate((map) => ({ ...map, autoTrack: event.target.checked })));
    document.querySelectorAll('[data-map-connection-style]').forEach((button) => {
      button.addEventListener('click', () => {
        const connectionStyle = button.dataset.mapConnectionStyle === 'curve' ? 'curve' : 'pipe';
        this.mutate((map) => ({ ...map, connectionStyle })).catch((error) => this.toast(error.message, 'error'));
      });
    });
    [
      ['map-layout-spacing', 'layoutSpacing'],
      ['map-layout-vertical-spacing', 'layoutVerticalSpacing']
    ].forEach(([elementId, field]) => {
      const input = document.getElementById(elementId);
      input?.addEventListener('input', (event) => {
        const value = normalizeMapLayoutSpacing(event.target.value);
        const preferredScale = this.viewport.scale;
        this.map = { ...this.map, [field]: value };
        this.render();
        this.fit({ preferredScale, persist: false });
      });
      input?.addEventListener('change', (event) => {
        const value = normalizeMapLayoutSpacing(event.target.value);
        this.mutate((map) => ({ ...map, [field]: value }), { fit: true })
          .catch((error) => this.toast(error.message, 'error'));
      });
    });
    document.getElementById('map-jump-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitJumpPrompt().catch((error) => this.toast(error.message, 'error'));
    });
    document.getElementById('map-jump-skip')?.addEventListener('click', () => this.finishJumpPrompt());
    document.getElementById('map-jump-dialog')?.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.finishJumpPrompt();
    });
    document.getElementById('map-connection-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.saveConnectionEditor().catch((error) => this.toast(error.message, 'error'));
    });
    document.getElementById('map-connection-delete')?.addEventListener('click', () => {
      this.deleteConnectionEditor().catch((error) => this.toast(error.message, 'error'));
    });
    document.getElementById('map-connection-dialog')?.addEventListener('close', () => {
      this.editingConnectionId = null;
      this.stopConnectionCountdown();
    });
    document.getElementById('map-connection-life')?.addEventListener('change', (event) => {
      const life = event.target.value;
      this.editingConnectionDraft = { life, expiresAt: connectionLifeExpiresAt(life) };
      this.updateConnectionCountdown();
    });
    document.getElementById('map-jump-signatures')?.addEventListener('change', () => {
      const manual = document.getElementById('map-jump-signature-manual');
      if (manual) manual.value = '';
    });
    document.getElementById('map-jump-signature-manual')?.addEventListener('input', (event) => {
      event.target.value = event.target.value.toUpperCase();
      if (event.target.value.trim()) document.querySelectorAll('input[name="map-jump-signature"]').forEach((input) => { input.checked = false; });
    });
    document.addEventListener('close', (event) => {
      if (event.target.id !== 'map-jump-dialog') this.showNextJumpPrompt();
    }, true);
    const svg = document.getElementById('chain-map');
    svg?.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX, event.clientY);
    }, { passive: false });
    svg?.addEventListener('pointerdown', (event) => {
      if (event.target.closest('[data-map-system], [data-map-connection]')) return;
      this.panning = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: this.viewport.x, originY: this.viewport.y };
      svg.setPointerCapture(event.pointerId);
      svg.classList.add('is-panning');
    });
    svg?.addEventListener('pointermove', (event) => {
      if (!this.panning || this.panning.id !== event.pointerId) return;
      this.viewport.x = this.panning.originX + event.clientX - this.panning.x;
      this.viewport.y = this.panning.originY + event.clientY - this.panning.y;
      this.updateViewport();
    });
    const stopPan = (event) => {
      if (!this.panning || this.panning.id !== event.pointerId) return;
      this.panning = null;
      svg.classList.remove('is-panning');
    };
    svg?.addEventListener('pointerup', stopPan);
    svg?.addEventListener('pointercancel', stopPan);
    svg?.addEventListener('dragover', (event) => {
      const node = event.target.closest('[data-map-system]');
      if (!node || !this.draggingSignature || Number(node.dataset.mapSystem) === this.draggingSignature.systemId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'link';
      this.clearSignatureDropTarget();
      node.classList.add('is-signature-drop-target');
    });
    svg?.addEventListener('dragleave', (event) => {
      const node = event.target.closest('[data-map-system]');
      if (node && !node.contains(event.relatedTarget)) node.classList.remove('is-signature-drop-target');
    });
    svg?.addEventListener('drop', (event) => {
      const node = event.target.closest('[data-map-system]');
      const dragging = this.draggingSignature;
      this.clearSignatureDropTarget();
      this.draggingSignature = null;
      if (!node || !dragging) return;
      event.preventDefault();
      this.assignSignatureToSystem(dragging.systemId, dragging.signatureId, node.dataset.mapSystem)
        .catch((error) => this.toast(error.message, 'error'));
    });
    svg?.addEventListener('click', (event) => {
      const connection = event.target.closest('[data-map-connection]');
      if (connection) return this.openConnectionEditor(connection.dataset.mapConnection);
      const node = event.target.closest('[data-map-system]');
      if (!node) return;
      this.selectSystem(node.dataset.mapSystem);
    });
    svg?.addEventListener('keydown', (event) => {
      const connection = event.target.closest('[data-map-connection]');
      if (connection && ['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        return this.openConnectionEditor(connection.dataset.mapConnection);
      }
      const node = event.target.closest('[data-map-system]');
      if (!node || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      this.selectSystem(node.dataset.mapSystem);
    });
    document.getElementById('map-inspector-content')?.addEventListener('dragstart', (event) => {
      const row = event.target.closest('[data-map-drag-signature]');
      if (!row) return;
      this.draggingSignature = {
        systemId: Number(row.dataset.mapDragSystem),
        signatureId: row.dataset.mapDragSignature
      };
      row.classList.add('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'link';
        event.dataTransfer.setData('text/plain', row.dataset.mapDragSignature);
      }
    });
    document.getElementById('map-inspector-content')?.addEventListener('dragend', (event) => {
      event.target.closest('[data-map-drag-signature]')?.classList.remove('is-dragging');
      this.draggingSignature = null;
      this.clearSignatureDropTarget();
    });
    document.getElementById('map-inspector-content')?.addEventListener('click', async (event) => {
      const select = event.target.closest('[data-map-select-system]');
      if (select) return this.selectSystem(select.dataset.mapSelectSystem);
      const removeConnection = event.target.closest('[data-map-remove-connection]');
      if (removeConnection) return this.mutate((map) => removeMapConnection(map, removeConnection.dataset.mapRemoveConnection), { fit: true });
      const removeSignature = event.target.closest('[data-map-remove-signature]');
      if (removeSignature) {
        this.editingSignature = null;
        return this.mutate(
          (map) => removeMapSignature(map, map.selectedSystemId, removeSignature.dataset.mapRemoveSignature),
          { fit: true }
        );
      }
      const action = event.target.closest('[data-map-action]')?.dataset.mapAction;
      if (action === 'remove-system') {
        const selected = this.graph.get(this.map.selectedSystemId);
        if (await this.confirmAction('Remove mapped system?', `${selected?.name || 'This system'} and all of its mapped connections will be removed.`, 'Remove system')) {
          return this.mutate((map) => removeMapSystem(map, map.selectedSystemId), { fit: true });
        }
      }
      if (action === 'paste-signatures') return this.pasteSignaturesFromClipboard();
      if (action === 'cancel-signature-edit') {
        this.editingSignature = null;
        return this.renderInspector();
      }
      if (action === 'import-signatures') {
        const textarea = document.getElementById('map-signature-paste');
        return this.importSignatureText(textarea?.value);
      }
      const editSignature = event.target.closest('[data-map-edit-signature]');
      if (editSignature) return this.editSignature(editSignature.dataset.mapEditSignature, editSignature.dataset.mapEditConnectionId);
    });
    document.getElementById('map-inspector-content')?.addEventListener('submit', async (event) => {
      const editForm = event.target.closest('[data-map-signature-edit-form]');
      if (!editForm && event.target.id !== 'map-signature-form') return;
      event.preventDefault();
      if (editForm) return this.saveSignatureEdit(editForm);
      const signature = {
        id: document.getElementById('map-signature-id').value.trim().toUpperCase(),
        group: document.getElementById('map-signature-group').value,
        type: document.getElementById('map-signature-type').value,
        name: document.getElementById('map-signature-type').value,
        updatedAt: new Date().toISOString()
      };
      if (!SIGNATURE_ID_PATTERN.test(signature.id)) return this.toast('Use three letters or a full signature ID, such as ABC or ABC-123.', 'error');
      await this.mutate((map) => upsertSignatures(map, map.selectedSystemId, [signature]));
    });
    document.getElementById('map-inspector-content')?.addEventListener('change', (event) => {
      const nodeField = event.target.dataset.mapNodeField;
      if (nodeField) {
        const value = event.target.value.trim();
        return this.mutate((map) => ({ ...map, nodes: map.nodes.map((node) => node.id === map.selectedSystemId ? { ...node, [nodeField]: value, updatedAt: new Date().toISOString() } : node) }));
      }
    });
    document.addEventListener('paste', (event) => {
      const mapView = document.getElementById('view-map');
      if (!mapView || mapView.hidden) return;
      const text = event.clipboardData?.getData('text/plain') || '';
      if (!parseScannerSignatures(text).length) return;
      event.preventDefault();
      this.importSignatureText(text).catch((error) => this.toast(error.message, 'error'));
    });
  }
}
