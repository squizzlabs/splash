import {
  assignConnectionSignature,
  connectedMapSystemIds,
  computeChainLayout,
  emptyMapState,
  fitChainViewport,
  normalizeMapState,
  observeCharacterMovements,
  parseScannerSignatures,
  preferredMapRoot,
  removeMapSystem,
  upsertSignatures,
  wormholeSignatureCandidates
} from './map-domain.js';

const MAP_STATE_KEY = 'mapper-state';
const MAP_VIEWPORT_KEY = 'mapper-viewport';
const NODE_WIDTH = 176;
const NODE_HEIGHT = 72;

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
  }

  async init() {
    const [savedMap, savedViewport] = await Promise.all([
      this.store.getSetting(MAP_STATE_KEY, null),
      this.store.getSetting(MAP_VIEWPORT_KEY, null)
    ]);
    this.map = normalizeMapState(savedMap, this.graph);
    const scale = Number(savedViewport?.scale);
    this.rememberedScale = Number.isFinite(scale) ? Math.min(2.4, Math.max(.28, scale)) : null;
    this.bindEvents();
    this.render();
  }

  async reload() {
    this.map = normalizeMapState(await this.store.getSetting(MAP_STATE_KEY, null), this.graph);
    this.render(this.characters);
  }

  async save() {
    await this.store.setSetting(MAP_STATE_KEY, this.map);
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
      this.save().catch((error) => this.toast(error.message, 'error'));
    }
    this.positions = computeChainLayout(this.visibleNodes, this.visibleConnections, this.layoutRootId);
    this.renderToolbar();
    this.renderGraph();
    this.renderInspector();
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
    const edges = this.visibleConnections.map((connection) => {
      const from = this.positions.get(connection.from);
      const to = this.positions.get(connection.to);
      if (!from || !to) return '';
      let startX;
      let startY;
      let endX;
      let endY;
      let path;
      if (from.depth !== to.depth) {
        const parent = from.depth < to.depth ? from : to;
        const child = from.depth < to.depth ? to : from;
        startX = parent.x + NODE_WIDTH / 2;
        startY = parent.y + NODE_HEIGHT;
        endX = child.x + NODE_WIDTH / 2;
        endY = child.y;
        const bend = Math.max(28, (endY - startY) * .52);
        path = `M ${startX} ${startY} C ${startX} ${startY + bend}, ${endX} ${endY - bend}, ${endX} ${endY}`;
      } else {
        const leftToRight = from.x <= to.x;
        startX = from.x + (leftToRight ? NODE_WIDTH : 0);
        endX = to.x + (leftToRight ? 0 : NODE_WIDTH);
        startY = from.y + NODE_HEIGHT / 2;
        endY = to.y + NODE_HEIGHT / 2;
        const bend = Math.max(46, Math.abs(endX - startX) * .48);
        const direction = leftToRight ? 1 : -1;
        path = `M ${startX} ${startY} C ${startX + bend * direction} ${startY}, ${endX - bend * direction} ${endY}, ${endX} ${endY}`;
      }
      return `<g class="map-connection-group ${connection.life === 'eol' ? 'is-eol' : ''} is-mass-${connection.mass} is-size-${connection.size}" data-map-connection="${connection.id}">
        <path class="map-connection-hit" d="${path}"></path>
        <path class="map-connection-line" d="${path}"></path>
      </g>`;
    }).join('');
    const nodes = this.visibleNodes.map((node) => {
      const position = this.positions.get(node.id);
      const system = this.graph.get(node.id);
      if (!position || !system) return '';
      const region = this.graph.regions.get(system.regionId)?.name || 'Unknown region';
      const pilots = pilotGroups.get(node.id) || [];
      const signatures = this.map.signatures[node.id]?.length || 0;
      const selected = this.map.selectedSystemId === node.id;
      const portraits = pilots.slice(0, 4).map((character, index) =>
        `<image class="map-pilot-image" href="${this.portraitUrl(character.id, 64)}" x="${NODE_WIDTH - 23 - index * 18}" y="46" width="20" height="20"><title>${svgEscape(character.name)}</title></image>`
      ).join('');
      return `<g class="map-system-node ${selected ? 'is-selected' : ''}" transform="translate(${position.x} ${position.y})" data-map-system="${node.id}" role="button" tabindex="0" aria-label="${svgEscape(system.name)}">
        <rect class="map-node-shadow" x="2" y="3" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="5"></rect>
        <rect class="map-node-body" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="5"></rect>
        <rect class="map-node-band" width="5" height="${NODE_HEIGHT}" rx="3" fill="${systemBand(system)}"></rect>
        <text class="map-node-name" x="15" y="23">${svgEscape(node.alias || system.name)}</text>
        ${node.alias ? `<text class="map-node-alias" x="15" y="39">${svgEscape(system.name)}</text>` : ''}
        <text class="map-node-meta" x="15" y="${node.alias ? 54 : 42}">${svgEscape(systemClass(system))} · ${svgEscape(region)}</text>
        ${signatures ? `<text class="map-node-signatures" x="15" y="63">${signatures} sig${signatures === 1 ? '' : 's'}</text>` : ''}
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
    const connections = this.map.connections.filter((connection) => connection.from === node.id || connection.to === node.id);
    const signatures = this.map.signatures[node.id] || [];
    const exits = connections.length ? connections.map((connection) => {
      const otherId = connection.from === node.id ? connection.to : connection.from;
      const other = this.graph.get(otherId);
      return `<article class="map-exit-card" data-map-connection-card="${connection.id}">
        <div class="map-exit-heading">
          <button type="button" data-map-select-system="${otherId}"><span>${svgEscape(connection.from === node.id ? connection.fromSignature || '???-???' : connection.toSignature || '???-???')}</span>${svgEscape(other?.name || otherId)}</button>
          <button class="map-inline-remove" type="button" data-map-remove-connection="${connection.id}" aria-label="Remove connection">×</button>
        </div>
        <div class="map-exit-fields">
          <label>Life<select data-map-connection-field="life"><option value="stable" ${connection.life === 'stable' ? 'selected' : ''}>Stable</option><option value="eol" ${connection.life === 'eol' ? 'selected' : ''}>End of life</option></select></label>
          <label>Mass<select data-map-connection-field="mass"><option value="stable" ${connection.mass === 'stable' ? 'selected' : ''}>Stable</option><option value="reduced" ${connection.mass === 'reduced' ? 'selected' : ''}>Reduced</option><option value="critical" ${connection.mass === 'critical' ? 'selected' : ''}>Critical</option></select></label>
          <label>Size<select data-map-connection-field="size"><option value="frigate" ${connection.size === 'frigate' ? 'selected' : ''}>Frigate</option><option value="small" ${connection.size === 'small' ? 'selected' : ''}>Small</option><option value="medium" ${connection.size === 'medium' ? 'selected' : ''}>Medium</option><option value="large" ${connection.size === 'large' ? 'selected' : ''}>Large</option><option value="xlarge" ${connection.size === 'xlarge' ? 'selected' : ''}>XL</option></select></label>
        </div>
        <div class="map-exit-fields map-exit-identifiers">
          <label>Near sig<input maxlength="7" autocomplete="off" value="${svgEscape(connection.from === node.id ? connection.fromSignature : connection.toSignature)}" data-map-connection-field="nearSignature" placeholder="ABC-123"></label>
          <label>Type<input maxlength="12" autocomplete="off" value="${svgEscape(connection.type)}" data-map-connection-field="type" placeholder="K162"></label>
        </div>
      </article>`;
    }).join('') : '<p class="map-panel-note">No mapped exits yet. A detected non-gate jump will add the next connection.</p>';
    const signatureRows = signatures.length ? signatures.map((signature) => {
      const group = signature.group === 'Cosmic Signature' ? 'Signature' : signature.group;
      const detail = signature.type || signature.name || '—';
      return `<tr title="${svgEscape(`${signature.id} · ${signature.group}${detail === '—' ? '' : ` · ${detail}`}`)}">
        <td class="map-signature-id">${svgEscape(signature.id)}</td>
        <td class="map-signature-group">${svgEscape(group)}</td>
        <td class="map-signature-type" title="${svgEscape(detail)}">${svgEscape(detail)}</td>
        <td class="map-signature-age">${svgEscape(ageLabel(signature.updatedAt))}</td>
        <td class="map-signature-remove"><button type="button" data-map-remove-signature="${svgEscape(signature.id)}" aria-label="Remove ${svgEscape(signature.id)}">×</button></td>
      </tr>`;
    }).join('') : '<tr><td class="map-signature-empty" colspan="5">No signatures recorded.</td></tr>';
    const systemFacts = [node.alias ? system.name : null, region, system.security.toFixed(1), systemClass(system), `${ageLabel(node.createdAt)} old`].filter(Boolean);
    container.innerHTML = `<header class="map-inspector-system" style="--system-band:${systemBand(system)}">
      <div class="map-inspector-title-row"><div><span class="eyebrow">Selected system</span><input class="map-system-alias-input" data-map-node-field="alias" value="${svgEscape(node.alias)}" placeholder="${svgEscape(system.name)}" maxlength="60" aria-label="System alias"></div><button class="map-system-remove" type="button" data-map-action="remove-system" aria-label="Remove ${svgEscape(system.name)}" title="Remove system">×</button></div>
      <p class="map-system-facts">${systemFacts.map((fact) => `<span>${svgEscape(fact)}</span>`).join('')}</p>
    </header>
    <section class="map-inspector-section"><div class="map-section-heading"><h2>Connections <span class="map-section-count">${connections.length}</span></h2></div>${exits}</section>
    <section class="map-inspector-section"><div class="map-section-heading"><h2>Signatures <span class="map-section-count">${signatures.length}</span></h2><button class="button button-primary map-paste-button" type="button" data-map-action="paste-signatures"><svg class="map-paste-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5h-1A1.5 1.5 0 0 0 3 5v7.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V5a1.5 1.5 0 0 0-1.5-1.5h-1"/><rect x="5.5" y="2" width="5" height="3" rx="1"/></svg><span>Paste scan</span></button></div>
      <table class="map-signature-table"><tbody>${signatureRows}</tbody></table>
      <details class="map-signature-manual"><summary>Add one manually</summary><form id="map-signature-form" class="map-signature-form" autocomplete="off"><input id="map-signature-id" maxlength="7" placeholder="ABC-123" aria-label="Signature ID" required><select id="map-signature-group" aria-label="Signature group"><option>Wormhole</option><option>Relic Site</option><option>Data Site</option><option>Gas Site</option><option>Combat Site</option><option>Unknown</option></select><input id="map-signature-type" maxlength="72" placeholder="Type / name" aria-label="Signature type"><button class="button button-ghost" type="submit">Add</button></form></details>
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

  async observeCharacters(characters) {
    this.characters = characters;
    const previousSelection = this.map.selectedSystemId;
    const result = observeCharacterMovements(this.map, characters, this.graph);
    if (result.map !== this.map) {
      this.map = result.map;
      await this.save();
      this.render();
      if (this.map.selectedSystemId !== previousSelection) this.onSystemSelected(this.map.selectedSystemId);
      if (result.changes.some((change) => change.type === 'connection')) this.toast('New non-gate connection added to the map.');
      this.queueJumpPrompts(result.changes.filter((change) => change.type === 'wormhole-jump'));
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
      const options = document.getElementById('map-jump-signatures');
      document.getElementById('map-jump-message').textContent = `${character?.name || 'A tracked pilot'} made a non-gate jump. Select the signature used in ${from?.name || 'the origin system'} so this connection is labeled correctly.`;
      document.getElementById('map-jump-route').innerHTML = `<span><small>From</small><strong>${svgEscape(from?.name || jump.from)}</strong></span><b aria-hidden="true">→</b><span><small>To</small><strong>${svgEscape(to?.name || jump.to)}</strong></span>`;
      options.innerHTML = signatures.length ? signatures.map((signature, index) => {
        const detail = signature.type || signature.name || 'Wormhole';
        return `<label class="map-jump-option"><input type="radio" name="map-jump-signature" value="${svgEscape(signature.id)}" ${signatures.length === 1 && index === 0 ? 'checked' : ''}><span><strong>${svgEscape(signature.id)}</strong><small title="${svgEscape(detail)}">${svgEscape(detail)}</small></span></label>`;
      }).join('') : '<p class="map-jump-no-signatures">No scanned wormhole signatures are available here. Enter the signature ID below, or skip and label the connection later.</p>';
      const manual = document.getElementById('map-jump-signature-manual');
      manual.value = '';
      this.activeJumpPrompt = jump;
      this.updateJumpSubmitState();
      dialog.showModal();
      if (!signatures.length) requestAnimationFrame(() => manual.focus());
      return;
    }
  }

  updateJumpSubmitState() {
    const manual = document.getElementById('map-jump-signature-manual')?.value.trim().toUpperCase() || '';
    const selected = document.querySelector('input[name="map-jump-signature"]:checked')?.value || '';
    const submit = document.getElementById('map-jump-submit');
    if (submit) submit.disabled = !/^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(manual || selected);
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
    const signatureId = manual || selected;
    if (!/^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(signatureId)) {
      this.toast('Choose a signature or enter one like ABC-123.', 'error');
      return;
    }
    const jump = this.activeJumpPrompt;
    this.map = assignConnectionSignature(this.map, jump.connectionId, jump.from, signatureId);
    await this.save();
    this.render();
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

  async mutate(mutator, { fit = false } = {}) {
    const previousSelection = this.map.selectedSystemId;
    this.map = mutator(this.map);
    await this.save();
    this.render();
    if (this.map.selectedSystemId !== previousSelection) this.onSystemSelected(this.map.selectedSystemId);
    if (fit) requestAnimationFrame(() => this.fit({ preferredScale: this.rememberedScale }));
  }

  selectSystem(systemId, { notify = true } = {}) {
    const id = Number(systemId);
    if (!this.map.nodes.some((node) => node.id === id)) return false;
    const changed = this.map.selectedSystemId !== id;
    this.map = { ...this.map, selectedSystemId: id };
    this.save().catch((error) => this.toast(error.message, 'error'));
    this.render();
    if (notify && changed) this.onSystemSelected(id);
    return true;
  }

  bindEvents() {
    document.getElementById('map-fit')?.addEventListener('click', () => this.fit());
    document.getElementById('map-zoom-in')?.addEventListener('click', () => this.zoom(1.18));
    document.getElementById('map-zoom-out')?.addEventListener('click', () => this.zoom(1 / 1.18));
    document.getElementById('map-auto-track')?.addEventListener('change', (event) => this.mutate((map) => ({ ...map, autoTrack: event.target.checked })));
    document.getElementById('map-jump-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitJumpPrompt().catch((error) => this.toast(error.message, 'error'));
    });
    document.getElementById('map-jump-skip')?.addEventListener('click', () => this.finishJumpPrompt());
    document.getElementById('map-jump-dialog')?.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.finishJumpPrompt();
    });
    document.getElementById('map-jump-signatures')?.addEventListener('change', () => {
      const manual = document.getElementById('map-jump-signature-manual');
      if (manual) manual.value = '';
      this.updateJumpSubmitState();
    });
    document.getElementById('map-jump-signature-manual')?.addEventListener('input', (event) => {
      event.target.value = event.target.value.toUpperCase();
      if (event.target.value.trim()) document.querySelectorAll('input[name="map-jump-signature"]').forEach((input) => { input.checked = false; });
      this.updateJumpSubmitState();
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
      if (event.target.closest('[data-map-system]')) return;
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
    svg?.addEventListener('click', (event) => {
      const node = event.target.closest('[data-map-system]');
      if (!node) return;
      this.selectSystem(node.dataset.mapSystem);
    });
    svg?.addEventListener('keydown', (event) => {
      const node = event.target.closest('[data-map-system]');
      if (!node || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      this.selectSystem(node.dataset.mapSystem);
    });
    document.getElementById('map-inspector-content')?.addEventListener('click', async (event) => {
      const select = event.target.closest('[data-map-select-system]');
      if (select) return this.selectSystem(select.dataset.mapSelectSystem);
      const removeConnection = event.target.closest('[data-map-remove-connection]');
      if (removeConnection) return this.mutate((map) => ({ ...map, connections: map.connections.filter((connection) => connection.id !== removeConnection.dataset.mapRemoveConnection) }), { fit: true });
      const removeSignature = event.target.closest('[data-map-remove-signature]');
      if (removeSignature) return this.mutate((map) => ({ ...map, signatures: { ...map.signatures, [map.selectedSystemId]: (map.signatures[map.selectedSystemId] || []).filter((signature) => signature.id !== removeSignature.dataset.mapRemoveSignature) } }));
      const action = event.target.closest('[data-map-action]')?.dataset.mapAction;
      if (action === 'remove-system') {
        const selected = this.graph.get(this.map.selectedSystemId);
        if (await this.confirmAction('Remove mapped system?', `${selected?.name || 'This system'} and all of its mapped connections will be removed.`, 'Remove system')) {
          return this.mutate((map) => removeMapSystem(map, map.selectedSystemId), { fit: true });
        }
      }
      if (action === 'paste-signatures') return this.pasteSignaturesFromClipboard();
      if (action === 'import-signatures') {
        const textarea = document.getElementById('map-signature-paste');
        return this.importSignatureText(textarea?.value);
      }
    });
    document.getElementById('map-inspector-content')?.addEventListener('submit', async (event) => {
      if (event.target.id !== 'map-signature-form') return;
      event.preventDefault();
      const signature = {
        id: document.getElementById('map-signature-id').value,
        group: document.getElementById('map-signature-group').value,
        type: document.getElementById('map-signature-type').value,
        name: document.getElementById('map-signature-type').value,
        updatedAt: new Date().toISOString()
      };
      const parsed = parseScannerSignatures(`${signature.id}\tCosmic Signature\t${signature.group}\t${signature.type}`);
      if (!parsed.length) return this.toast('Use a signature ID like ABC-123.', 'error');
      parsed[0] = { ...parsed[0], ...signature, id: signature.id.toUpperCase() };
      await this.mutate((map) => upsertSignatures(map, map.selectedSystemId, parsed));
    });
    document.getElementById('map-inspector-content')?.addEventListener('change', (event) => {
      const nodeField = event.target.dataset.mapNodeField;
      if (nodeField) {
        const value = event.target.value.trim();
        return this.mutate((map) => ({ ...map, nodes: map.nodes.map((node) => node.id === map.selectedSystemId ? { ...node, [nodeField]: value, updatedAt: new Date().toISOString() } : node) }));
      }
      const connectionField = event.target.dataset.mapConnectionField;
      if (!connectionField) return;
      const card = event.target.closest('[data-map-connection-card]');
      if (!card) return;
      let field = connectionField;
      if (field === 'nearSignature') {
        const connection = this.map.connections.find((candidate) => candidate.id === card.dataset.mapConnectionCard);
        field = connection.from === this.map.selectedSystemId ? 'fromSignature' : 'toSignature';
      }
      const value = event.target.value.trim();
      this.mutate((map) => ({ ...map, connections: map.connections.map((connection) => connection.id === card.dataset.mapConnectionCard ? { ...connection, [field]: ['type', 'fromSignature', 'toSignature'].includes(field) ? value.toUpperCase() : value, updatedAt: new Date().toISOString() } : connection) }));
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
