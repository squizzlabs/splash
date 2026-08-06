import { APP_CONFIG } from './config.js';
import { TripStore } from './db.js';
import { ESIClient } from './esi.js';
import {
  advanceRouteProgress,
  autopilotStopsFor,
  buildRoute,
  duplicateRoute,
  itineraryFor,
  parseRouteImport,
  preferenceLabel,
  routeStopSystemIndexes,
  serializeRoutes,
  systemSecurityColor
} from './domain.js';
import { UniverseGraph } from './route-planner.js';
import { isCharacterOnline, syncCharacterOnline, syncCharacterPresence, syncOnlineCharacterData } from './presence.js';

const redirectToLocalhost = window.location.hostname === '127.0.0.1';
const ONLINE_REFRESH_MS = 15_000;
const LOCATION_REFRESH_MS = 8_000;
if (redirectToLocalhost) {
  window.location.replace(`http://localhost:59832${window.location.pathname}${window.location.search}${window.location.hash}`);
}

const store = new TripStore();
const esi = new ESIClient(store);
const state = {
  graph: null,
  systemSearch: [],
  routes: [],
  characters: [],
  settings: { theme: 'system', density: 'comfortable' },
  editingRouteId: null,
  editorStops: [],
  editorAvoidSystems: [],
  editorConnections: [],
  editorCoverageArea: null,
  assigningRouteId: null,
  assignmentCharacterIds: new Set(),
  settingRoutes: false,
  clearRouteCharacterIds: new Set(),
  clearingRoutes: false,
  detailRouteId: null,
  locationTimer: null,
  onlineTimer: null,
  presenceSyncing: false,
  onlineSyncPending: false,
  locationSyncPending: false,
  sloganTimer: null
};

const autocomplete = {
  input: null,
  matches: [],
  activeIndex: -1
};

const waypointDrag = {
  pointerId: null,
  sourceIndex: -1,
  row: null,
  handle: null
};

const $ = (id) => document.getElementById(id);

function updateSlogan() {
  const letter = $('slogan-letter');
  if (!letter) return;
  letter.textContent = Math.floor(Date.now() / 60_000) % 2 === 0 ? 'd' : 'r';
  window.clearTimeout(state.sloganTimer);
  state.sloganTimer = window.setTimeout(updateSlogan, 60_025 - (Date.now() % 60_000));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function portraitUrl(characterId, size = 64) {
  return `https://images.evetech.net/characters/${Number(characterId)}/portrait?size=${size}`;
}

function formatRelative(value) {
  if (!value) return 'never';
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

function calculationJumps(route) {
  const calculations = route.calculations || [];
  const references = calculations.filter((calculation) => calculation.characterId == null);
  return (references.length ? references : calculations).map((calculation) => Number(calculation.jumpCount || 0));
}

function ensureReferenceCalculation(calculations) {
  const normalized = [...(calculations || [])];
  if (!normalized.length || normalized.some((calculation) => calculation.characterId == null)) return normalized;
  return [{ ...structuredClone(normalized[0]), key: 'reference', characterId: null }, ...normalized];
}

function fallbackRouteJumpCount(route) {
  if (!state.graph) return 0;
  let origin = route.origin || null;
  if (!origin && route.originMode === 'character') {
    const character = [...state.characters]
      .filter((item) => item.location?.id && !item.locationError)
      .sort((left, right) => (
        Number(isCharacterOnline(right)) - Number(isCharacterOnline(left))
        || String(right.location.updatedAt || '').localeCompare(String(left.location.updatedAt || ''))
      ))[0];
    if (character) origin = state.graph.resolve(character.location.id);
  }

  try {
    if (route.mode !== 'coverage' && itineraryFor(route, origin).length < 2) return 0;
    const calculation = calculateSeedItinerary(route, origin, null);
    return Math.max(0, (calculation?.systems?.length || 1) - 1);
  } catch (error) {
    console.warn(`Could not calculate a display jump count for ${route.name}:`, error);
    return 0;
  }
}

function routeJumpValues(route) {
  const values = calculationJumps(route);
  return values.length ? values : [fallbackRouteJumpCount(route)];
}

function jumpLabel(route) {
  const values = routeJumpValues(route);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? String(min) : `${min}–${max}`;
}

function selectedCharacters(route) {
  const ids = new Set((route.assignedCharacterIds || []).map(Number));
  return state.characters.filter((character) => ids.has(character.id));
}

let toastTimer;
function toast(message, type = 'success') {
  const element = $('toast');
  clearTimeout(toastTimer);
  element.textContent = message;
  element.classList.toggle('is-error', type === 'error');
  element.classList.add('is-visible');
  toastTimer = setTimeout(() => element.classList.remove('is-visible'), 4200);
}

function setBusy(button, busy, busyText = 'Working…') {
  if (!button) return;
  if (busy) {
    button.dataset.previousText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.previousText || button.textContent;
    button.disabled = false;
    delete button.dataset.previousText;
  }
}

function waitForPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function applyAppearance() {
  if (state.settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.dataset.density = state.settings.density;
}

function showView(name) {
  document.querySelectorAll('.app-view').forEach((view) => {
    const active = view.dataset.view === name;
    view.hidden = !active;
    view.classList.toggle('is-active', active);
  });
  document.querySelectorAll('[data-view-target]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.viewTarget === name);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderHeader() {
  $('nav-character-count').textContent = state.characters.length;
  $('header-characters').innerHTML = state.characters.map((character) =>
    `<img class="${isCharacterOnline(character) ? '' : 'is-offline'}" src="${portraitUrl(character.id, 64)}" alt="${escapeHtml(character.name)}" title="${escapeHtml(character.name)} · ${isCharacterOnline(character) ? 'online' : 'offline'}">`
  ).join('');
}

function routeOriginLabel(route) {
  if (route.originMode === 'character') {
    const calculations = route.calculations || [];
    if (calculations.length === 1) return calculations[0].origin.name;
    return calculations.length ? `${calculations.length} live origins` : 'Live pilot locations';
  }
  if (route.originMode === 'auto') {
    const calculations = route.calculations || [];
    return calculations.length === 1 ? `${calculations[0].origin.name} · optimized` : 'Optimized starting systems';
  }
  return route.origin?.name || 'Unknown origin';
}

function assignedRouteForCharacter(characterId) {
  return state.routes
    .filter((route) => (route.assignedCharacterIds || []).map(Number).includes(Number(characterId)))
    .sort((left, right) => {
      const leftTime = Date.parse(left.lastSentAt || left.updatedAt || 0) || 0;
      const rightTime = Date.parse(right.lastSentAt || right.updatedAt || 0) || 0;
      return rightTime - leftTime;
    })[0] || null;
}

function assignedCalculation(route, characterId) {
  return (route?.calculations || []).find((calculation) => Number(calculation.characterId) === Number(characterId)) || null;
}

function assignedPilotProgress(character) {
  const route = assignedRouteForCharacter(character.id);
  if (!route) return null;
  const calculation = assignedCalculation(route, character.id);
  const systems = calculation?.systems || [];
  const specifiedStops = route.mode === 'coverage' ? calculation?.stops || route.stops : route.stops;
  const stopIndexes = new Set(routeStopSystemIndexes(systems, specifiedStops));
  const annotateSystem = (routeSystem, systemIndex) => ({ ...routeSystem, isStop: stopIndexes.has(systemIndex) });
  const progressKey = `${route.id}:${route.lastSentAt || ''}:${calculation?.calculatedAt || ''}`;
  const previous = character.routeProgress?.key === progressKey ? character.routeProgress : null;
  const progress = advanceRouteProgress(systems, character.location?.id, previous);
  let jumpsRemaining = null;
  let remainingSystems = [];

  if (systems.length && progress.onRoute && progress.systemIndex >= 0) {
    remainingSystems = systems.slice(progress.systemIndex + 1)
      .map((routeSystem, offset) => annotateSystem(routeSystem, progress.systemIndex + 1 + offset));
    jumpsRemaining = remainingSystems.length;
  } else if (systems.length && character.location?.id) {
    const targetIndex = previous?.systemIndex >= 0
      ? Math.min(previous.systemIndex + 1, systems.length - 1)
      : 0;
    try {
      const rejoin = state.graph.astar(character.location.id, systems[targetIndex].id, route);
      remainingSystems = [
        ...rejoin.slice(1).map((systemId, index, path) => {
          const system = state.graph.get(systemId);
          return system ? { ...system, isStop: index === path.length - 1 && stopIndexes.has(targetIndex) } : null;
        }).filter(Boolean),
        ...systems.slice(targetIndex + 1).map((routeSystem, offset) => annotateSystem(routeSystem, targetIndex + 1 + offset))
      ];
      jumpsRemaining = remainingSystems.length;
    } catch (_) {
      jumpsRemaining = null;
    }
  }

  return {
    route,
    calculation,
    jumpsRemaining,
    remainingSystems,
    progress: {
      key: progressKey,
      routeId: route.id,
      calculationKey: calculation?.key || null,
      systemIndex: progress.systemIndex,
      lastSystemId: progress.lastSystemId,
      onRoute: progress.onRoute,
      updatedAt: new Date().toISOString()
    }
  };
}

function renderAssignedPilots() {
  const allAssignments = state.characters
    .map((character) => ({ character, assignment: assignedPilotProgress(character) }))
    .filter(({ assignment }) => assignment)
    .sort((left, right) => left.character.name.localeCompare(right.character.name));
  const showOffline = $('show-offline-pilots').checked;
  const assignments = allAssignments.filter(({ character }) => showOffline || isCharacterOnline(character));

  if (!assignments.length) {
    const message = allAssignments.length
      ? 'No online pilots have an assigned route.'
      : 'No pilots have a known assigned route.';
    $('assigned-pilots-list').innerHTML = `<div class="pilot-progress-empty">${escapeHtml(message)}</div>`;
    return;
  }

  $('assigned-pilots-list').innerHTML = assignments.map(({ character, assignment }) => {
    const online = isCharacterOnline(character);
    const location = character.location?.stop?.name || character.location?.name || 'Location unavailable';
    const jumps = assignment.jumpsRemaining == null ? '—' : assignment.jumpsRemaining;
    const jumpLabel = assignment.jumpsRemaining === 0 ? 'complete' : 'jumps left';
    const jumpSquares = assignment.remainingSystems.map((routeSystem) => {
      const system = state.graph.get(routeSystem.id);
      const security = Number(system?.security);
      const securityLabel = Number.isFinite(security) ? security.toFixed(1) : 'unknown security';
      const title = `${system?.name || routeSystem.name || `System ${routeSystem.id}`} · ${securityLabel}${routeSystem.isStop ? ' · route stop' : ''}`;
      const markerClass = routeSystem.isStop ? 'is-stop' : 'is-transit';
      const color = systemSecurityColor(security);
      return `<span class="jump-marker ${markerClass}" style="--jump-color:${color}" title="${escapeHtml(title)}" aria-hidden="true"></span>`;
    }).join('');
    return `<article class="pilot-progress-row ${online ? '' : 'is-offline'}">
      <img src="${portraitUrl(character.id, 64)}" alt="">
      <div class="pilot-progress-identity"><strong>${escapeHtml(character.name)}</strong><span>${escapeHtml(assignment.route.name)}</span></div>
      <div class="pilot-progress-location"><span>${online ? 'Current location' : 'Last known location'}</span><strong>${escapeHtml(location)}</strong></div>
      <div class="pilot-progress-jumps"><strong>${jumps}</strong><span>${jumpLabel}</span></div>
      ${jumpSquares ? `<div class="pilot-jump-track" aria-label="${assignment.jumpsRemaining} jumps remaining">${jumpSquares}</div>` : ''}
    </article>`;
  }).join('');
}

function renderRoutes() {
  renderAssignedPilots();
  const query = $('route-search').value.trim().toLocaleLowerCase();
  const status = $('route-status-filter').value;
  const sort = $('route-sort').value;
  let routes = state.routes.filter((route) => {
    const matchesStatus = status === 'all' || route.status === status;
    const haystack = [route.name, route.notes, route.origin?.name, route.coverageArea?.name, ...(route.stops || []).map((item) => item.name)].join(' ').toLocaleLowerCase();
    return matchesStatus && (!query || haystack.includes(query));
  });
  routes = routes.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'jumps') return Math.min(...routeJumpValues(a)) - Math.min(...routeJumpValues(b));
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  if (!routes.length) {
    const filtered = state.routes.length > 0;
    $('routes-list').innerHTML = `<div class="empty-state">
      <div class="empty-orbit" aria-hidden="true"></div>
      <h3>${filtered ? 'No routes match' : 'Your flight board is clear'}</h3>
      <p>${filtered ? 'Try a different search or status filter.' : 'Add ordered stops now, then assign pilots from the flight board whenever you are ready.'}</p>
      ${filtered ? '' : '<button class="button button-primary" type="button" data-empty-new>Plan your first route</button>'}
    </div>`;
    $('routes-list').querySelector('[data-empty-new]')?.addEventListener('click', () => openRouteEditor());
    return;
  }

  $('routes-list').innerHTML = routes.map((route) => {
    const crew = selectedCharacters(route);
    const coverage = route.mode === 'coverage';
    const stops = route.stops?.length ? `${route.stops.length} ${coverage ? 'systems' : `stop${route.stops.length === 1 ? '' : 's'}`} · ` : '';
    const endpointLabel = coverage ? 'Coverage area' : 'Final stop';
    const endpointName = coverage ? route.coverageArea?.name || 'Unknown area' : route.stops?.at(-1)?.name || 'No stops';
    const jumpValue = jumpLabel(route);
    return `<article class="route-row">
      <div class="route-primary">
        <div class="route-primary-top"><span class="status-pill status-${route.status}">${escapeHtml(route.status)}</span><span class="route-updated">${formatRelative(route.updatedAt)}</span></div>
        <h3>${escapeHtml(route.name)}</h3>
        <p>${escapeHtml(stops + preferenceLabel(route.preference))}</p>
      </div>
      <div class="route-line">
        <div class="route-system"><span>${endpointLabel}</span><strong>${escapeHtml(endpointName)}</strong></div>
      </div>
      <div class="route-metrics"><div class="metric"><strong>${jumpValue}</strong><span>jumps</span></div></div>
      <div class="route-actions">
        <button class="route-edit" type="button" data-route-edit="${escapeHtml(route.id)}" aria-label="Edit ${escapeHtml(route.name)}" title="Edit route">
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4Z"></path><path d="m13.5 6.5 4 4"></path></svg>
        </button>
        <button class="route-assign" type="button" data-route-assign="${escapeHtml(route.id)}" aria-label="${crew.length ? 'Edit' : 'Assign'} pilots for ${escapeHtml(route.name)}" title="${crew.length ? 'Edit pilots' : 'Assign pilots'}">
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 12h15"></path><path d="m13 6 6 6-6 6"></path></svg>
        </button>
      </div>
    </article>`;
  }).join('');
}

function renderCharacters() {
  const cards = state.characters.map((character) => {
    const location = character.location;
    const online = isCharacterOnline(character);
    const presenceKnown = typeof character.presence?.online === 'boolean';
    const locationName = location?.stop?.name || location?.name || (character.locationError ? 'Location unavailable' : 'Not synced yet');
    const locationContext = location?.stop && location.stop.kind !== 'system' ? `${location.name} · ` : '';
    const statusLabel = character.onlineError ? 'Reconnect required' : online ? 'Online' : presenceKnown ? 'Offline' : 'Checking status';
    const shipType = character.ship?.typeName || '';
    const shipName = character.ship?.name || (character.shipError ? 'Ship unavailable' : 'Not reported');
    const shipTypeMarkup = shipType ? `<small>${escapeHtml(shipType)}</small>` : '';
    return `<article class="character-card">
      <div class="character-head">
        <img src="${portraitUrl(character.id, 128)}" alt="${escapeHtml(character.name)}">
        <div><h2>${escapeHtml(character.name)}</h2><p>Character ${character.id}</p></div>
      </div>
      <div class="character-location">
        <span class="location-pulse ${online ? '' : 'is-offline'}" aria-hidden="true"></span>
        <div><span>${online ? 'Current location' : 'Last known location'}</span><strong>${escapeHtml(locationName)}</strong><span>${online && location ? `${escapeHtml(locationContext)}Updated ${formatRelative(location.updatedAt)}` : escapeHtml(statusLabel)}</span></div>
      </div>
      <div class="character-ship"><strong>${escapeHtml(shipName)}</strong>${shipTypeMarkup}</div>
      <div class="character-actions"><span class="scope-status ${online ? '' : 'is-offline'}">● ${escapeHtml(statusLabel)}</span><span>${character.onlineError ? `<button class="text-button reconnect-button" type="button" data-reauthorize>Reconnect</button>` : ''}<button class="text-button" type="button" data-remove-character="${character.id}">Remove</button></span></div>
    </article>`;
  }).join('');
  $('characters-list').innerHTML = `${cards}<article class="character-card add-character-card"><div><button type="button" data-add-character aria-label="Add EVE character">＋</button><strong>Add another pilot</strong><span>Authorize with EVE Online SSO</span></div></article>`;
}

function renderSettings() {
  $('theme-select').value = state.settings.theme;
  $('density-select').value = state.settings.density;
  if (state.graph) {
    $('settings-sde-build').textContent = state.graph.version || 'Unknown';
    $('settings-sde-date').textContent = formatDate(state.graph.releaseDate);
    $('settings-system-count').textContent = state.graph.systems.size.toLocaleString();
  }
}

function prepareSystemAutocomplete() {
  state.systemSearch = [...state.graph.systems.values()]
    .sort((left, right) => left.name.localeCompare(right.name));
}

function autocompleteMatches(input, query) {
  const normalized = String(query || '').trim().toLocaleLowerCase();
  if (!normalized) return [];
  if (input.hasAttribute('data-area-autocomplete')) {
    return state.graph.searchAreas(normalized, $('route-coverage-type').value, 10);
  }
  if (input.hasAttribute('data-stop-autocomplete')) return state.graph.searchStops(normalized, 10);
  const prefixes = [];
  const partials = [];
  const numeric = /^\d+$/.test(normalized);
  for (const system of state.systemSearch) {
    const name = system.name.toLocaleLowerCase();
    const id = String(system.id);
    if ((numeric && id.startsWith(normalized)) || name.startsWith(normalized)) prefixes.push(system);
    else if (((!numeric && name.includes(normalized)) || (numeric && id.includes(normalized))) && partials.length < 10) partials.push(system);
    if (prefixes.length >= 10) break;
  }
  return [...prefixes, ...partials].slice(0, 10);
}

function positionSystemAutocomplete() {
  const menu = $('system-autocomplete-menu');
  if (menu.hidden || !autocomplete.input) return;
  const rect = autocomplete.input.getBoundingClientRect();
  const availableWidth = window.innerWidth - 16;
  const width = Math.min(Math.max(Math.min(rect.width, 560), 280), availableWidth);
  let left = rect.left;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  left = Math.max(8, left);
  let top = rect.bottom + 5;
  let maxHeight = Math.min(280, window.innerHeight - top - 10);
  if (maxHeight < 150) {
    maxHeight = Math.min(280, rect.top - 10);
    top = Math.max(8, rect.top - maxHeight - 5);
  }
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.width = `${Math.round(width)}px`;
  menu.style.maxHeight = `${Math.max(120, Math.round(maxHeight))}px`;
}

function setAutocompleteActive(index) {
  if (!autocomplete.matches.length) return;
  autocomplete.activeIndex = (index + autocomplete.matches.length) % autocomplete.matches.length;
  $('system-autocomplete-menu').querySelectorAll('[role="option"]').forEach((option, optionIndex) => {
    const active = optionIndex === autocomplete.activeIndex;
    option.classList.toggle('is-active', active);
    option.setAttribute('aria-selected', String(active));
    if (active) {
      autocomplete.input?.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    }
  });
}

function hideSystemAutocomplete() {
  const menu = $('system-autocomplete-menu');
  menu.hidden = true;
  autocomplete.input?.setAttribute('aria-expanded', 'false');
  autocomplete.input?.removeAttribute('aria-activedescendant');
  autocomplete.input = null;
  autocomplete.matches = [];
  autocomplete.activeIndex = -1;
}

function showSystemAutocomplete(input) {
  const matches = autocompleteMatches(input, input.value);
  if (!matches.length) {
    hideSystemAutocomplete();
    return;
  }
  autocomplete.input = input;
  autocomplete.matches = matches;
  autocomplete.activeIndex = 0;
  const menu = $('system-autocomplete-menu');
  const areaInput = input.hasAttribute('data-area-autocomplete');
  const stopInput = input.hasAttribute('data-stop-autocomplete');
  menu.innerHTML = matches.map((item, index) => `<button id="system-option-${index}" type="button" role="option" data-index="${index}" aria-selected="${index === 0 ? 'true' : 'false'}" class="${index === 0 ? 'is-active' : ''}">
    <strong>${escapeHtml(item.name)}</strong>
    <span>${areaInput
      ? `${escapeHtml(item.type)} · ${item.id}`
      : stopInput && item.kind === 'station'
        ? `station · ${escapeHtml(item.systemName)} · ${item.id}`
        : `${item.id} · security ${item.security.toFixed(1)}`}</span>
  </button>`).join('');
  menu.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', 'system-option-0');
  positionSystemAutocomplete();
}

function chooseAutocompleteMatch(index = autocomplete.activeIndex) {
  const match = autocomplete.matches[index];
  const input = autocomplete.input;
  if (!match || !input) return;
  input.value = match.name;
  hideSystemAutocomplete();
  input.focus();
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function bindSystemAutocomplete() {
  const inputs = [...document.querySelectorAll('[data-system-autocomplete], [data-stop-autocomplete], [data-area-autocomplete]')];
  inputs.forEach((input) => {
    input.setAttribute('aria-expanded', 'false');
    input.addEventListener('focus', () => showSystemAutocomplete(input));
    input.addEventListener('input', () => showSystemAutocomplete(input));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !($('system-autocomplete-menu').hidden)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        hideSystemAutocomplete();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if ($('system-autocomplete-menu').hidden) showSystemAutocomplete(input);
        else setAutocompleteActive(autocomplete.activeIndex + 1);
        return;
      }
      if (event.key === 'ArrowUp' && !($('system-autocomplete-menu').hidden)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setAutocompleteActive(autocomplete.activeIndex - 1);
        return;
      }
      if (event.key === 'Enter' && !($('system-autocomplete-menu').hidden) && autocomplete.matches.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        chooseAutocompleteMatch();
      }
    });
  });
  $('system-autocomplete-menu').addEventListener('pointerdown', (event) => event.preventDefault());
  $('system-autocomplete-menu').addEventListener('click', (event) => {
    const option = event.target.closest('[data-index]');
    if (option) chooseAutocompleteMatch(Number(option.dataset.index));
  });
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('[data-system-autocomplete], [data-stop-autocomplete], [data-area-autocomplete]') && !event.target.closest('#system-autocomplete-menu')) hideSystemAutocomplete();
  });
  $('route-editor').addEventListener('scroll', positionSystemAutocomplete, true);
  window.addEventListener('resize', positionSystemAutocomplete);
}

function renderAll() {
  renderHeader();
  renderRoutes();
  renderCharacters();
  renderSettings();
  if ($('route-assignment').open) renderRouteAssignment();
  const openDetail = currentDetailRoute();
  if ($('route-detail').open && openDetail) openRouteDetail(openDetail);
}

async function beginAuthorization() {
  try {
    await esi.beginAuthorization();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function refreshCharacterPresence(character, quiet = false) {
  try {
    const updated = await syncCharacterPresence(character, {
      getOnline: (characterId) => esi.characterOnline(characterId),
      getLocation: (characterId) => esi.characterLocation(characterId),
      getShip: (characterId) => esi.characterShip(characterId),
      resolveSystem: (systemId) => state.graph?.get(systemId),
      resolveStop: (stopId) => state.graph?.resolveStop(stopId)
    });
    const assignment = assignedPilotProgress(updated);
    const tracked = assignment ? { ...updated, routeProgress: assignment.progress } : updated;
    await store.put('characters', tracked);
    const index = state.characters.findIndex((item) => item.id === character.id);
    if (index >= 0) state.characters[index] = tracked;
    return tracked;
  } catch (error) {
    const updated = {
      ...character,
      presence: { ...(character.presence || {}), online: false, checkedAt: new Date().toISOString() },
      onlineError: error.message
    };
    await store.put('characters', updated);
    const index = state.characters.findIndex((item) => item.id === character.id);
    if (index >= 0) state.characters[index] = updated;
    if (!quiet) toast(`${character.name}: ${error.message}`, 'error');
    throw error;
  }
}

async function refreshCharacterOnline(character, quiet = false) {
  try {
    const updated = await syncCharacterOnline(character, {
      getOnline: (characterId) => esi.characterOnline(characterId)
    });
    await store.put('characters', updated);
    const index = state.characters.findIndex((item) => item.id === character.id);
    if (index >= 0) state.characters[index] = updated;
    return updated;
  } catch (error) {
    const updated = {
      ...character,
      presence: { ...(character.presence || {}), online: false, checkedAt: new Date().toISOString() },
      onlineError: error.message
    };
    await store.put('characters', updated);
    const index = state.characters.findIndex((item) => item.id === character.id);
    if (index >= 0) state.characters[index] = updated;
    if (!quiet) toast(`${character.name}: ${error.message}`, 'error');
    throw error;
  }
}

async function refreshCharacterLocation(character) {
  const updated = await syncOnlineCharacterData(character, {
    getLocation: (characterId) => esi.characterLocation(characterId),
    getShip: (characterId) => esi.characterShip(characterId),
    resolveSystem: (systemId) => state.graph?.get(systemId),
    resolveStop: (stopId) => state.graph?.resolveStop(stopId)
  });
  const assignment = assignedPilotProgress(updated);
  const tracked = assignment ? { ...updated, routeProgress: assignment.progress } : updated;
  await store.put('characters', tracked);
  const index = state.characters.findIndex((item) => item.id === character.id);
  if (index >= 0) state.characters[index] = tracked;
  return tracked;
}

function renderPilotData() {
  renderHeader();
  renderRoutes();
  renderCharacters();
  if ($('route-assignment').open) renderRouteAssignment();
  const openDetail = currentDetailRoute();
  if ($('route-detail').open && openDetail) openRouteDetail(openDetail);
}

function finishPilotSync() {
  state.presenceSyncing = false;
  if (state.onlineSyncPending) {
    state.onlineSyncPending = false;
    queueMicrotask(refreshOnlineStatuses);
  } else if (state.locationSyncPending) {
    state.locationSyncPending = false;
    queueMicrotask(refreshOnlineLocations);
  }
}

async function refreshOnlineStatuses() {
  if (!state.characters.length) return;
  if (state.presenceSyncing) {
    state.onlineSyncPending = true;
    return;
  }
  state.presenceSyncing = true;
  try {
    await Promise.allSettled(state.characters.map((character) => refreshCharacterOnline(character, true)));
    renderPilotData();
  } finally {
    finishPilotSync();
  }
}

async function refreshOnlineLocations() {
  if (state.presenceSyncing) {
    state.locationSyncPending = true;
    return;
  }
  const onlineCharacters = state.characters.filter(isCharacterOnline);
  if (!onlineCharacters.length) return;
  state.presenceSyncing = true;
  try {
    await Promise.allSettled(onlineCharacters.map((character) => refreshCharacterLocation(character)));
    await recalculateAssignedRoutes();
    renderPilotData();
  } finally {
    finishPilotSync();
  }
}

async function refreshAllLocations({ quiet = false, button = null } = {}) {
  if (!state.characters.length) {
    if (!quiet) toast('Connect an EVE character first.', 'error');
    return;
  }
  if (state.presenceSyncing) return;
  state.presenceSyncing = true;
  setBusy(button, true, 'Syncing…');
  try {
    const results = await Promise.allSettled(state.characters.map((character) => refreshCharacterPresence(character, true)));
    await recalculateAssignedRoutes();
    renderHeader();
    renderRoutes();
    renderCharacters();
    if ($('route-assignment').open) renderRouteAssignment();
    const openDetail = currentDetailRoute();
    if ($('route-detail').open && openDetail) openRouteDetail(openDetail);
    const successes = results.filter((result) => result.status === 'fulfilled').length;
    if (!quiet) toast(successes ? `Updated ${successes} pilot status${successes === 1 ? '' : 'es'}.` : 'No pilot statuses could be updated.', successes ? 'success' : 'error');
  } catch (error) {
    if (quiet) console.warn('Pilot status refresh failed:', error);
    else toast(error.message, 'error');
  } finally {
    finishPilotSync();
    setBusy(button, false);
  }
}

function currentOnlineCharacter() {
  return state.characters
    .filter(isCharacterOnline)
    .sort((left, right) => Number(right.authorizedAt || 0) - Number(left.authorizedAt || 0))[0] || null;
}

function updateOriginMode() {
  const fixed = $('route-origin-mode').value === 'fixed';
  $('route-origin-field').hidden = !fixed;
  $('route-origin').required = fixed;
}

function updateRouteMode() {
  const coverage = $('route-mode').value === 'coverage';
  const autoOption = $('route-origin-auto-option');
  autoOption.hidden = !coverage;
  autoOption.disabled = !coverage;
  if (coverage && $('route-origin-mode').value === 'fixed' && !$('route-origin').value.trim()) {
    $('route-origin-mode').value = 'auto';
  } else if (!coverage && $('route-origin-mode').value === 'auto') {
    $('route-origin-mode').value = state.characters.some(isCharacterOnline) ? 'character' : 'fixed';
  }
  updateOriginMode();
  $('route-coverage-field').hidden = !coverage;
  $('route-add-current-location').hidden = coverage;
  $('route-waypoint-add-row').hidden = coverage;
  $('route-waypoint-heading').innerHTML = coverage
    ? 'Systems to visit <small>every system in the selected area</small>'
    : 'Stops <small>in travel order; the final stop is the endpoint</small>';
  $('route-waypoint-input').placeholder = coverage ? 'Coverage systems are generated above' : 'Search for a solar system or station';
  renderEditorSystems();
}

function coverageReferenceOrigin() {
  if ($('route-origin-mode').value === 'auto') return null;
  if ($('route-origin-mode').value === 'fixed') return state.graph.resolve($('route-origin').value);
  const character = currentOnlineCharacter();
  return character ? state.graph.resolve(character.location.id) : null;
}

async function generateCoverageStops() {
  const button = $('route-coverage-generate');
  const status = $('route-coverage-status');
  setBusy(button, true, 'Optimizing…');
  try {
    const type = $('route-coverage-type').value;
    const area = state.graph.resolveArea($('route-coverage-area').value, type);
    if (!area) throw new Error(`Choose an exact ${type} name or ID from the suggestions.`);
    const targets = state.graph.systemsInArea(type, area.id);
    if (!targets.length) throw new Error(`${area.name} has no solar systems in the current SDE.`);
    status.textContent = `Ordering ${targets.length} systems by shortest available legs…`;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const origin = coverageReferenceOrigin();
    const options = {
      preference: document.querySelector('input[name="preference"]:checked')?.value || 'Shorter',
      securityPenalty: $('security-penalty').value,
      avoidSystems: state.editorAvoidSystems,
      connections: state.editorConnections
    };
    const optimized = origin
      ? state.graph.calculateCoverage(origin, targets, options)
      : state.graph.calculateBestCoverage(targets, options);
    const ordered = optimized.stops;
    state.editorCoverageArea = { type, id: area.id, name: area.name };
    state.editorStops = ordered;
    if (!$('route-name').value.trim()) $('route-name').value = `${area.name} coverage`;
    renderEditorSystems();
    status.textContent = `${targets.length} systems loaded from optimized start ${optimized.origin.name}. Pilot-specific paths will be optimized when saved.`;
    $('route-form-status').textContent = '';
  } catch (error) {
    status.textContent = error.message;
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

function updatePreference() {
  const preference = document.querySelector('input[name="preference"]:checked')?.value || 'Shorter';
  $('security-penalty-field').hidden = preference === 'Shorter';
}

function updateCurrentLocationButton() {
  const button = $('route-add-current-location');
  if (!button) return;
  const character = currentOnlineCharacter();
  button.disabled = !character;
  button.title = character
    ? `Add ${character.name}’s exact current location`
    : 'No connected character is currently online';
}

function renderEditorSystems() {
  const coverage = $('route-mode').value === 'coverage';
  $('route-waypoint-list').innerHTML = state.editorStops.length
    ? state.editorStops.map((stop, index) => `<div class="ordered-system-row ${coverage ? 'is-coverage-stop' : ''} ${!coverage && index === state.editorStops.length - 1 ? 'is-final-stop' : ''}" data-waypoint-row data-index="${index}">
        <button class="waypoint-drag-handle" type="button" data-waypoint-drag data-index="${index}" aria-label="Drag ${escapeHtml(stop.name)} to reorder" title="Drag to reorder"><span aria-hidden="true">⠿</span></button>
        <span class="system-order">${index + 1}</span>
        <span class="ordered-system-name"><strong>${escapeHtml(stop.name)}</strong><small>${stop.kind === 'station' ? `Station · ${escapeHtml(stop.systemName)}` : stop.kind === 'structure' ? `Structure · ${escapeHtml(stop.systemName)}` : !coverage && index === state.editorStops.length - 1 ? 'Final stop' : 'Solar system'}</small></span>
        <span class="system-id">${stop.id}</span>
        <span class="system-row-actions">
          <button type="button" data-waypoint-move="up" data-index="${index}" aria-label="Move ${escapeHtml(stop.name)} up" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-waypoint-move="down" data-index="${index}" aria-label="Move ${escapeHtml(stop.name)} down" ${index === state.editorStops.length - 1 ? 'disabled' : ''}>↓</button>
          ${coverage ? '' : `<button type="button" data-waypoint-remove data-index="${index}" aria-label="Remove ${escapeHtml(stop.name)}">×</button>`}
        </span>
      </div>`).join('')
    : '<p class="builder-empty">No stops yet.</p>';

  $('route-avoid-list').innerHTML = state.editorAvoidSystems.map((system, index) => `<span class="system-chip">
    ${escapeHtml(system.name)}
    <button type="button" data-avoid-remove data-index="${index}" aria-label="Remove ${escapeHtml(system.name)}">×</button>
  </span>`).join('');

  $('route-connection-list').innerHTML = state.editorConnections.map((connection, index) => `<div class="connection-row">
    <strong>${escapeHtml(connection.from.name)}</strong><span>→</span><strong>${escapeHtml(connection.to.name)}</strong>
    <button type="button" data-connection-remove data-index="${index}" aria-label="Remove connection">×</button>
  </div>`).join('');
  updateCurrentLocationButton();
}

function resetWaypointDrag() {
  waypointDrag.row?.classList.remove('is-dragging');
  $('route-waypoint-list').classList.remove('is-reordering');
  document.body.classList.remove('is-reordering-waypoint');
  waypointDrag.pointerId = null;
  waypointDrag.sourceIndex = -1;
  waypointDrag.row = null;
  waypointDrag.handle = null;
}

function beginWaypointDrag(event) {
  const handle = event.target.closest('[data-waypoint-drag]');
  if (!handle || event.button !== 0 || waypointDrag.pointerId !== null) return;
  const row = handle.closest('[data-waypoint-row]');
  if (!row) return;
  event.preventDefault();
  waypointDrag.pointerId = event.pointerId;
  waypointDrag.sourceIndex = Number(row.dataset.index);
  waypointDrag.row = row;
  waypointDrag.handle = handle;
  handle.setPointerCapture?.(event.pointerId);
  row.classList.add('is-dragging');
  $('route-waypoint-list').classList.add('is-reordering');
  document.body.classList.add('is-reordering-waypoint');
}

function moveWaypointDrag(event) {
  if (event.pointerId !== waypointDrag.pointerId || !waypointDrag.row) return;
  event.preventDefault();
  const list = $('route-waypoint-list');
  const rows = [...list.querySelectorAll('[data-waypoint-row]')]
    .filter((row) => row !== waypointDrag.row);
  const insertBefore = rows.find((row) => {
    const rect = row.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2;
  });
  if (insertBefore) list.insertBefore(waypointDrag.row, insertBefore);
  else list.append(waypointDrag.row);

  const scrollArea = list.closest('.modal-body');
  if (!scrollArea) return;
  const rect = scrollArea.getBoundingClientRect();
  if (event.clientY < rect.top + 48) scrollArea.scrollBy({ top: -14 });
  else if (event.clientY > rect.bottom - 48) scrollArea.scrollBy({ top: 14 });
}

function finishWaypointDrag(event) {
  if (event.pointerId !== waypointDrag.pointerId || !waypointDrag.row) return;
  const sourceIndex = waypointDrag.sourceIndex;
  const destinationIndex = [...$('route-waypoint-list').querySelectorAll('[data-waypoint-row]')]
    .indexOf(waypointDrag.row);
  if (waypointDrag.handle?.hasPointerCapture?.(event.pointerId)) {
    waypointDrag.handle.releasePointerCapture(event.pointerId);
  }
  resetWaypointDrag();
  if (sourceIndex >= 0 && destinationIndex >= 0 && sourceIndex !== destinationIndex) {
    const [moved] = state.editorStops.splice(sourceIndex, 1);
    state.editorStops.splice(destinationIndex, 0, moved);
  }
  renderEditorSystems();
}

function addEditorSystem(collectionName, inputId, label) {
  const input = $(inputId);
  const query = input.value.trim();
  if (!query) return false;
  const system = collectionName === 'editorStops' ? resolveStop(query, label) : resolveSystem(query, label);
  const collection = state[collectionName];
  if (collection.some((item) => item.id === system.id)) throw new Error(`${system.name} is already in this list.`);
  collection.push(system);
  input.value = '';
  renderEditorSystems();
  input.focus();
  return true;
}

async function addCurrentLocationsToRoute() {
  const button = $('route-add-current-location');
  const current = currentOnlineCharacter();
  if (!current) throw new Error('No connected character is currently online.');
  setBusy(button, true, 'Checking…');
  try {
    const character = await refreshCharacterPresence(current, true);
    if (!isCharacterOnline(character) || !character.location?.stop) {
      throw new Error(`${character.name} does not have an available live location.`);
    }
    const stop = character.location.stop;
    if (state.editorStops.some((item) => item.id === stop.id)) {
      throw new Error(`${stop.name} is already in this route.`);
    }
    state.editorStops.push({ ...stop });
    renderHeader();
    renderCharacters();
    renderEditorSystems();
    toast(`Added ${stop.name}.`);
  } finally {
    setBusy(button, false);
    updateCurrentLocationButton();
  }
}

function addEditorConnection() {
  const fromInput = $('route-connection-from');
  const toInput = $('route-connection-to');
  const fromQuery = fromInput.value.trim();
  const toQuery = toInput.value.trim();
  if (!fromQuery && !toQuery) return false;
  if (!fromQuery || !toQuery) throw new Error('Choose both systems for the one-way connection.');
  const from = resolveSystem(fromQuery, 'Connection origin');
  const to = resolveSystem(toQuery, 'Connection destination');
  if (from.id === to.id) throw new Error('A connection must join two different systems.');
  if (state.editorConnections.some((item) => item.from.id === from.id && item.to.id === to.id)) {
    throw new Error(`${from.name} → ${to.name} is already included.`);
  }
  state.editorConnections.push({ from, to });
  fromInput.value = '';
  toInput.value = '';
  renderEditorSystems();
  fromInput.focus();
  return true;
}

function flushEditorSystemInputs() {
  if ($('route-waypoint-input').value.trim()) addEditorSystem('editorStops', 'route-waypoint-input', 'Stop');
  if ($('route-avoid-input').value.trim()) addEditorSystem('editorAvoidSystems', 'route-avoid-input', 'Avoid system');
  if ($('route-connection-from').value.trim() || $('route-connection-to').value.trim()) addEditorConnection();
}

function handleEditorBuilderAction(action) {
  try {
    action();
    $('route-form-status').textContent = '';
  } catch (error) {
    $('route-form-status').textContent = error.message;
    toast(error.message, 'error');
  }
}

function openRouteEditor(route = null) {
  hideSystemAutocomplete();
  state.editingRouteId = route?.id || null;
  $('route-form').reset();
  $('route-editor-title').textContent = route ? 'Edit route' : 'New route';
  $('route-delete').hidden = !route;
  $('route-form-status').textContent = '';
  $('route-mode').value = route?.mode === 'coverage' ? 'coverage' : 'standard';
  $('route-origin-mode').value = route?.originMode || 'character';
  $('route-name').value = route?.name || '';
  $('route-origin').value = route?.origin?.name || '';
  state.editorCoverageArea = route?.coverageArea ? { ...route.coverageArea } : null;
  $('route-coverage-type').value = route?.coverageArea?.type || 'region';
  $('route-coverage-area').value = route?.coverageArea?.name || '';
  $('route-coverage-area').placeholder = `Search ${$('route-coverage-type').value}s`;
  $('route-coverage-status').textContent = route?.coverageArea
    ? `${route.stops?.length || 0} systems loaded from ${route.coverageArea.name}.`
    : 'Choose an area to generate an optimized coverage route.';
  state.editorStops = (route?.stops || []).map((stop) => ({ ...stop }));
  state.editorAvoidSystems = (route?.avoidSystems || []).map((system) => ({ ...system }));
  state.editorConnections = (route?.connections || []).map((connection) => ({ from: { ...connection.from }, to: { ...connection.to } }));
  $('route-waypoint-input').value = '';
  $('route-avoid-input').value = '';
  $('route-connection-from').value = '';
  $('route-connection-to').value = '';
  $('route-status').value = route?.status || 'ready';
  $('route-notes').value = route?.notes || '';
  $('security-penalty').value = route?.securityPenalty ?? 50;
  $('security-penalty-output').textContent = $('security-penalty').value;
  const preference = route?.preference || 'Shorter';
  document.querySelector(`input[name="preference"][value="${preference}"]`).checked = true;
  updateOriginMode();
  updateRouteMode();
  updatePreference();
  $('route-editor').showModal();
  setTimeout(() => $('route-name').focus(), 50);
}

function resolveSystem(query, label) {
  const system = state.graph.resolve(query);
  if (!system) throw new Error(`${label} “${query}” was not found in the current EVE SDE. Use an exact system name or ID.`);
  return system;
}

function resolveStop(query, label) {
  const stop = state.graph.resolveStop(query);
  if (!stop) throw new Error(`${label} “${query}” was not found in the current EVE SDE. Choose an exact solar system or NPC station name or ID.`);
  return stop;
}

function calculateSeedItinerary(seed, origin, characterId = null) {
  if (seed.mode === 'coverage') {
    const targets = seed.stops || [];
    if (!targets.length) return null;
    return origin
      ? state.graph.calculateCoverage(origin, targets, seed)
      : state.graph.calculateBestCoverage(targets, seed);
  }
  return {
    origin,
    systems: state.graph.calculateItinerary(itineraryFor(seed, origin, characterId), seed),
    stops: []
  };
}

function calculateAssignedItineraries(route, characters) {
  const calculatedAt = new Date().toISOString();
  return characters.flatMap((character) => {
    let origin = route.origin;
    if (route.originMode === 'character') {
      if (!character.location || character.locationError) return [];
      origin = resolveSystem(character.location.id, `${character.name}’s location`);
    }
    const result = calculateSeedItinerary(route, origin, character.id);
    if (!result) return [];
    return [{
      key: String(character.id),
      characterId: character.id,
      origin: result.origin,
      systems: result.systems,
      stops: result.stops,
      calculatedAt
    }];
  });
}

function routeNeedsAssignedCalculation(route, characters) {
  return characters.some((character) => {
    if (route.originMode === 'character' && (!character.location || character.locationError)) return false;
    const calculation = (route.calculations || []).find((item) => Number(item.characterId) === character.id);
    return !calculation;
  });
}

async function recalculateAssignedRoutes() {
  const changed = [];
  for (const route of state.routes) {
    const characters = selectedCharacters(route);
    if (!characters.length || !routeNeedsAssignedCalculation(route, characters)) continue;
    try {
      const calculations = calculateAssignedItineraries(route, characters);
      changed.push(buildRoute({
        ...route,
        calculations: ensureReferenceCalculation(calculations),
        lastCalculatedAt: calculations.length ? new Date().toISOString() : null
      }, route));
    } catch (error) {
      console.warn(`Could not recalculate ${route.name}:`, error);
    }
  }
  if (!changed.length) return;
  await store.putMany('routes', changed);
  const replacements = new Map(changed.map((route) => [route.id, route]));
  state.routes = state.routes.map((route) => replacements.get(route.id) || route);
}

async function saveRoute(event) {
  event.preventDefault();
  const button = $('route-save');
  const status = $('route-form-status');
  const previous = state.routes.find((route) => route.id === state.editingRouteId) || null;
  setBusy(button, true, 'Calculating…');
  status.textContent = 'Resolving systems and calculating A* paths…';
  try {
    flushEditorSystemInputs();
    const assignedCharacterIds = previous?.assignedCharacterIds || [];
    const originMode = $('route-origin-mode').value;
    const mode = $('route-mode').value;
    if (mode === 'coverage') {
      const type = $('route-coverage-type').value;
      const area = state.graph.resolveArea($('route-coverage-area').value, type);
      if (!area || !state.editorCoverageArea || area.id !== state.editorCoverageArea.id || area.type !== state.editorCoverageArea.type) {
        throw new Error('Load the selected region or constellation before saving the coverage route.');
      }
      const expected = state.graph.systemsInArea(type, area.id);
      const loaded = new Set(state.editorStops.map((stop) => stop.id));
      const missing = expected.find((system) => !loaded.has(system.id));
      if (missing || loaded.size !== expected.length) {
        throw new Error(`Coverage must include every system in ${area.name}. Load the area again to restore the complete set.`);
      }
    }

    const seed = buildRoute({
      name: $('route-name').value,
      mode,
      coverageArea: mode === 'coverage' ? state.editorCoverageArea : null,
      originMode,
      origin: originMode === 'fixed' ? resolveSystem($('route-origin').value, 'Origin') : null,
      stops: state.editorStops,
      avoidSystems: state.editorAvoidSystems,
      connections: state.editorConnections,
      assignedCharacterIds,
      stopAssignments: [],
      preference: document.querySelector('input[name="preference"]:checked').value,
      securityPenalty: $('security-penalty').value,
      status: $('route-status').value,
      notes: $('route-notes').value,
      calculations: []
    }, previous);

    const calculations = [];
    const assignedCharacters = state.characters.filter((character) => assignedCharacterIds.includes(character.id));
    if (assignedCharacters.length) {
      calculations.push(...calculateAssignedItineraries(seed, assignedCharacters));
    } else if (originMode === 'character') {
      let character = currentOnlineCharacter();
      if (character) {
        status.textContent = `Checking ${character.name}’s current location…`;
        try {
          character = await refreshCharacterPresence(character, true);
        } catch (_) {
          character = null;
        }
      }
      if (character && isCharacterOnline(character) && character.location && !character.locationError) {
        const origin = resolveSystem(character.location.id, `${character.name}’s location`);
        const result = calculateSeedItinerary(seed, origin, null);
        if (result) calculations.push({ key: 'reference', characterId: null, origin: result.origin, systems: result.systems, stops: result.stops });
      }
    } else {
      const result = calculateSeedItinerary(seed, seed.origin, null);
      if (result) calculations.push({ key: originMode === 'auto' ? 'optimized' : 'fixed', characterId: null, origin: result.origin, systems: result.systems, stops: result.stops });
    }

    const route = buildRoute({
      ...seed,
      calculations: ensureReferenceCalculation(calculations),
      lastCalculatedAt: calculations.length ? new Date().toISOString() : null
    }, previous);
    await store.put('routes', route);
    const existingIndex = state.routes.findIndex((item) => item.id === route.id);
    if (existingIndex >= 0) state.routes[existingIndex] = route;
    else state.routes.push(route);
    $('route-editor').close();
    renderAll();
    toast(previous ? 'Route updated.' : 'Route added to the flight board.');
  } catch (error) {
    console.error(error);
    status.textContent = error.message;
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

function detailCalculationMarkup(route, calculation) {
  const character = calculation.characterId ? state.characters.find((item) => item.id === calculation.characterId) : null;
  const heading = character?.name || (route.originMode === 'fixed' ? 'Fixed route' : route.originMode === 'auto' ? 'Optimized route' : calculation.origin.name);
  const coverageStops = route.mode === 'coverage' ? ` · ${calculation.stops?.length || 0} assigned systems` : '';
  const headingMarkup = `<strong>${escapeHtml(heading)}</strong><span>${calculation.jumpCount} jumps${escapeHtml(coverageStops)} from ${escapeHtml(calculation.origin.name)}</span>`;
  const pathMarkup = `<ol class="system-path">${calculation.systems.map((system) => `<li>${escapeHtml(system.name)}</li>`).join('')}</ol>`;
  if (route.mode === 'coverage') {
    return `<details class="calculation-group coverage-calculation"><summary class="calculation-heading">${headingMarkup}</summary>${pathMarkup}</details>`;
  }
  return `<section class="calculation-group"><div class="calculation-heading">${headingMarkup}</div>${pathMarkup}</section>`;
}

function openRouteDetail(route) {
  state.detailRouteId = route.id;
  $('detail-title').textContent = route.name;
  $('detail-status').textContent = `${route.status} route`;
  const crew = selectedCharacters(route);
  const onlineCrew = crew.filter(isCharacterOnline);
  const anyOnline = state.characters.some(isCharacterOnline);
  const originLabel = route.originMode === 'character'
    ? 'Live pilot origins'
    : route.originMode === 'auto'
      ? routeOriginLabel(route)
      : route.origin.name;
  const coverage = route.mode === 'coverage';
  const via = coverage
    ? `${route.stops?.length || 0} systems · optimized coverage`
    : `${route.stops?.length || 0} ordered stop${route.stops?.length === 1 ? '' : 's'}`;
  const endpointLabel = coverage ? (route.coverageArea?.type || 'Coverage') : 'Final stop';
  const endpointName = coverage ? route.coverageArea?.name || 'Unknown area' : route.stops?.at(-1)?.name || 'No stops';
  const penalty = route.preference === 'Shorter' ? '' : ` · strictness ${route.securityPenalty}`;
  $('route-detail-body').innerHTML = `
    <div class="detail-hero">
      <div class="detail-endpoint"><span>Origin</span><strong>${escapeHtml(originLabel)}</strong></div>
      <div class="detail-jumps"><strong>${jumpLabel(route)}</strong><span>calculated jumps</span></div>
      <div class="detail-endpoint"><span>${escapeHtml(endpointLabel)}</span><strong>${escapeHtml(endpointName)}</strong></div>
    </div>
    <div class="detail-meta"><span>${escapeHtml(preferenceLabel(route.preference) + penalty)}</span><span>${escapeHtml(via)}</span><span>A* · SDE ${escapeHtml(state.graph.version)}</span><span>Updated ${escapeHtml(formatRelative(route.updatedAt))}</span></div>
    ${route.notes ? `<p class="detail-notes">${escapeHtml(route.notes)}</p>` : ''}
    ${(route.calculations || []).map((calculation) => detailCalculationMarkup(route, calculation)).join('')}
    <div class="assigned-crew">${crew.length ? crew.map((character) => `<span class="crew-chip ${isCharacterOnline(character) ? '' : 'is-offline'}"><img src="${portraitUrl(character.id, 64)}" alt=""><span>${escapeHtml(character.name)}<small>${escapeHtml(isCharacterOnline(character) ? character.ship?.typeName || 'Ship unknown' : 'Offline')}</small></span></span>`).join('') : '<span class="muted">No characters assigned.</span>'}</div>`;
  $('detail-send').disabled = !onlineCrew.length && !anyOnline;
  $('detail-send').textContent = onlineCrew.length
    ? `Send to ${onlineCrew.length} online`
    : anyOnline
      ? 'Assign an online pilot'
      : crew.length
        ? 'Assigned pilots offline'
        : 'No pilots online';
  if (!$('route-detail').open) $('route-detail').showModal();
}

function currentDetailRoute() {
  return state.routes.find((route) => route.id === state.detailRouteId) || null;
}

function currentAssignmentRoute() {
  return state.routes.find((route) => route.id === state.assigningRouteId) || null;
}

function renderRouteAssignment() {
  const route = currentAssignmentRoute();
  if (!route) return;
  const onlineCharacters = state.characters.filter(isCharacterOnline);
  const onlineCharacterIds = new Set(onlineCharacters.map((character) => character.id));
  state.assignmentCharacterIds = new Set([...state.assignmentCharacterIds].filter((id) => onlineCharacterIds.has(id)));
  $('route-assignment-title').textContent = `Assign pilots · ${route.name}`;
  $('route-assignment-character-options').innerHTML = state.characters.map((character) => {
    const online = isCharacterOnline(character);
    const location = character.location?.stop?.name || character.location?.name || 'Location unavailable';
    const detail = online ? `Online · ${location}` : `Offline · ${location}`;
    const selectable = online && !state.settingRoutes;
    return `<label class="character-option ${selectable ? '' : 'is-disabled'} ${online ? '' : 'is-offline'}" ${online ? '' : 'title="Offline pilots cannot receive routes"'}>
      <input type="checkbox" value="${character.id}" ${state.assignmentCharacterIds.has(character.id) ? 'checked' : ''} ${selectable ? '' : 'disabled'}>
      <span><img src="${portraitUrl(character.id, 64)}" alt=""><strong>${escapeHtml(character.name)}</strong><small>${escapeHtml(detail)}</small></span>
    </label>`;
  }).join('');
  $('route-assignment-character-empty').textContent = state.characters.length
    ? 'No pilots are currently online. Offline pilots cannot receive routes.'
    : 'Connect an EVE character before assigning this route.';
  $('route-assignment-character-empty').hidden = onlineCharacters.length > 0;
  const selectedCharacterCount = onlineCharacters.filter((character) => state.assignmentCharacterIds.has(character.id)).length;
  $('assignment-select-all').disabled = state.settingRoutes || onlineCharacters.length === 0 || selectedCharacterCount === onlineCharacters.length;
  $('assignment-select-none').disabled = state.settingRoutes || selectedCharacterCount === 0;
  $('route-assignment-submit').disabled = state.settingRoutes || selectedCharacterCount === 0;
  const status = $('route-assignment-status');
  if (!state.settingRoutes && !status.textContent.trim()) {
    status.textContent = selectedCharacterCount
      ? `${selectedCharacterCount} online pilot${selectedCharacterCount === 1 ? '' : 's'} selected.`
      : onlineCharacters.length
        ? 'Select one or more online pilots.'
        : 'No online pilots are available.';
  }

  const coverage = route.mode === 'coverage';
  $('route-assignment-coverage').hidden = !coverage;
  if (!coverage) return;
  $('route-assignment-stops').innerHTML = route.stops.map((stop, index) => {
    return `<div class="assignment-stop-row">
      <span class="system-order">${index + 1}</span>
      <span class="ordered-system-name"><strong>${escapeHtml(stop.name)}</strong><small>Coverage system</small></span>
    </div>`;
  }).join('');
}

function openRouteAssignment(route) {
  state.assigningRouteId = route.id;
  state.assignmentCharacterIds = new Set();
  state.settingRoutes = false;
  $('route-assignment-status').textContent = '';
  $('route-assignment-status').classList.remove('is-error');
  renderRouteAssignment();
  if (!$('route-assignment').open) $('route-assignment').showModal();
}

function selectAllRoutePilots(selected) {
  const characterIds = state.characters.filter(isCharacterOnline).map((character) => character.id);
  state.assignmentCharacterIds = new Set(selected ? characterIds : []);
  $('route-assignment-status').textContent = '';
  $('route-assignment-status').classList.remove('is-error');
  renderRouteAssignment();
}

function canClearCharacterRoute(character) {
  return isCharacterOnline(character) && Boolean(character.location?.stop?.id || character.location?.id) && !character.locationError;
}

function renderClearRoutesDialog() {
  const eligibleCharacters = state.characters.filter(canClearCharacterRoute);
  const eligibleIds = new Set(eligibleCharacters.map((character) => character.id));
  state.clearRouteCharacterIds = new Set([...state.clearRouteCharacterIds].filter((id) => eligibleIds.has(id)));
  $('clear-routes-character-options').innerHTML = state.characters.map((character) => {
    const online = isCharacterOnline(character);
    const location = character.location?.stop?.name || character.location?.name || 'Location unavailable';
    const selectable = canClearCharacterRoute(character) && !state.clearingRoutes;
    const detail = online ? `Online · ${location}` : `Offline · ${location}`;
    return `<label class="character-option ${selectable ? '' : 'is-disabled'} ${online ? '' : 'is-offline'}" ${selectable ? '' : 'title="Only online pilots with a known location can have their route cleared"'}>
      <input type="checkbox" value="${character.id}" ${state.clearRouteCharacterIds.has(character.id) ? 'checked' : ''} ${selectable ? '' : 'disabled'}>
      <span><img src="${portraitUrl(character.id, 64)}" alt=""><strong>${escapeHtml(character.name)}</strong><small>${escapeHtml(detail)}</small></span>
    </label>`;
  }).join('');
  $('clear-routes-character-empty').hidden = eligibleCharacters.length > 0;
  const selectedCount = state.clearRouteCharacterIds.size;
  $('clear-routes-select-all').disabled = state.clearingRoutes || !eligibleCharacters.length || selectedCount === eligibleCharacters.length;
  $('clear-routes-select-none').disabled = state.clearingRoutes || selectedCount === 0;
  $('clear-routes-submit').disabled = state.clearingRoutes || selectedCount === 0;
  const status = $('clear-routes-status');
  if (!state.clearingRoutes && !status.textContent.trim()) {
    status.textContent = selectedCount
      ? `${selectedCount} pilot${selectedCount === 1 ? '' : 's'} selected.`
      : eligibleCharacters.length
        ? 'Select one or more online pilots.'
        : 'No online pilots with a known location are available.';
  }
}

function openClearRoutesDialog() {
  state.clearRouteCharacterIds = new Set();
  state.clearingRoutes = false;
  $('clear-routes-status').textContent = '';
  $('clear-routes-status').classList.remove('is-error');
  renderClearRoutesDialog();
  if (!$('clear-routes-dialog').open) $('clear-routes-dialog').showModal();
}

function selectAllClearRoutePilots(selected) {
  const characterIds = state.characters.filter(canClearCharacterRoute).map((character) => character.id);
  state.clearRouteCharacterIds = new Set(selected ? characterIds : []);
  $('clear-routes-status').textContent = '';
  $('clear-routes-status').classList.remove('is-error');
  renderClearRoutesDialog();
}

async function clearSelectedPilotRoutes() {
  const selected = state.characters.filter((character) => state.clearRouteCharacterIds.has(character.id));
  if (!selected.length) throw new Error('Select at least one online pilot before clearing routes.');
  const status = $('clear-routes-status');
  const successful = [];
  const failed = [];

  for (let index = 0; index < selected.length; index += 1) {
    const selectedCharacter = selected[index];
    status.textContent = `Checking ${selectedCharacter.name} · ${index + 1} of ${selected.length}…`;
    await waitForPaint();
    try {
      const character = await refreshCharacterPresence(selectedCharacter, true);
      if (!isCharacterOnline(character)) throw new Error('Pilot is offline.');
      const destinationId = Number(character.location?.stop?.id || character.location?.id);
      if (!Number.isSafeInteger(destinationId) || destinationId <= 0 || character.locationError) {
        throw new Error('Current location is unavailable.');
      }
      status.textContent = `Clearing ${character.name}’s route…`;
      await waitForPaint();
      await esi.setWaypoint(character.id, destinationId, true);
      successful.push(character);
    } catch (error) {
      failed.push({ character: selectedCharacter, error });
    }
  }

  if (successful.length) {
    const successfulIds = new Set(successful.map((character) => character.id));
    const now = new Date().toISOString();
    const changedRoutes = state.routes.filter((route) => (
      (route.assignedCharacterIds || []).some((characterId) => successfulIds.has(Number(characterId)))
    )).map((route) => ({
      ...route,
      assignedCharacterIds: route.assignedCharacterIds.filter((characterId) => !successfulIds.has(Number(characterId))),
      calculations: ensureReferenceCalculation(route.calculations)
        .filter((calculation) => !successfulIds.has(Number(calculation.characterId))),
      updatedAt: now
    }));
    await store.putMany('routes', changedRoutes);
    const routeChanges = new Map(changedRoutes.map((route) => [route.id, route]));
    state.routes = state.routes.map((route) => routeChanges.get(route.id) || route);

    const changedCharacters = state.characters.filter((character) => successfulIds.has(character.id)).map((character) => ({
      ...character,
      routeProgress: null
    }));
    await store.putMany('characters', changedCharacters);
    const characterChanges = new Map(changedCharacters.map((character) => [character.id, character]));
    state.characters = state.characters.map((character) => characterChanges.get(character.id) || character);
    renderAll();
  }

  state.clearRouteCharacterIds = new Set(failed.map(({ character }) => character.id));
  if (failed.length) {
    const details = failed.map(({ character, error }) => `${character.name}: ${error.message}`).join(' · ');
    throw new Error(`${successful.length ? `Cleared ${successful.length} of ${selected.length} routes. ` : ''}${details}`);
  }

  $('clear-routes-dialog').close();
  toast(`Cleared ${successful.length} pilot route${successful.length === 1 ? '' : 's'}.`);
}

async function saveRouteAssignments(event) {
  event.preventDefault();
  const route = currentAssignmentRoute();
  if (!route) throw new Error('The selected route is no longer available.');
  const selected = state.characters.filter((character) => state.assignmentCharacterIds.has(character.id));
  if (!selected.length) throw new Error('Select at least one online pilot before setting routes.');

  const status = $('route-assignment-status');
  const calculations = [];
  const successful = [];
  const failed = [];
  const seed = { ...route, assignedCharacterIds: selected.map((character) => character.id), stopAssignments: [], calculations: [] };

  for (let pilotIndex = 0; pilotIndex < selected.length; pilotIndex += 1) {
    const selectedCharacter = selected[pilotIndex];
    status.textContent = `Checking ${selectedCharacter.name} · ${pilotIndex + 1} of ${selected.length}…`;
    await waitForPaint();
    try {
      const character = await refreshCharacterPresence(selectedCharacter, true);
      if (!isCharacterOnline(character)) throw new Error('Pilot is offline.');

      status.textContent = `Calculating ${character.name}’s route…`;
      await waitForPaint();
      const [calculation] = calculateAssignedItineraries(seed, [character]);
      if (!calculation) throw new Error('A route could not be calculated from the pilot’s current location.');
      const waypoints = autopilotStopsFor({ ...seed, calculations: [calculation] }, character.id);
      if (!waypoints.length) throw new Error('The route has no waypoints beyond the pilot’s current location.');

      for (let waypointIndex = 0; waypointIndex < waypoints.length; waypointIndex += 1) {
        status.textContent = `Setting ${character.name} · waypoint ${waypointIndex + 1} of ${waypoints.length}…`;
        await esi.setWaypoint(character.id, waypoints[waypointIndex].id, waypointIndex === 0);
      }
      calculations.push(calculation);
      successful.push(character);
    } catch (error) {
      failed.push({ character: selectedCharacter, error });
    }
  }

  if (successful.length) {
    const now = new Date().toISOString();
    const updated = buildRoute({
      ...seed,
      assignedCharacterIds: successful.map((character) => character.id),
      calculations: ensureReferenceCalculation(calculations),
      lastCalculatedAt: now,
      lastSentAt: now
    }, route);
    await store.put('routes', updated);
    state.routes[state.routes.findIndex((item) => item.id === route.id)] = updated;
  }

  renderHeader();
  renderCharacters();
  renderRoutes();
  if (failed.length) {
    const details = failed.map(({ character, error }) => `${character.name}: ${error.message}`).join(' · ');
    throw new Error(`${successful.length ? `Set ${successful.length} of ${selected.length} routes. ` : ''}${details}`);
  }

  $('route-assignment').close();
  renderAll();
  toast(`Route set for ${successful.length} pilot${successful.length === 1 ? '' : 's'}.`);
}

async function sendRouteToAutopilot(route) {
  const assigned = selectedCharacters(route);
  if (!assigned.length) throw new Error('Assign at least one connected character first.');
  const button = $('detail-send');
  setBusy(button, true, 'Checking pilots…');
  const checked = [];
  for (const character of assigned) {
    try {
      checked.push(await refreshCharacterPresence(character, true));
    } catch (_) {
      // An unknown presence state is unavailable for autopilot services.
    }
  }
  const characters = checked.filter(isCharacterOnline);
  if (!characters.length) {
    setBusy(button, false);
    renderAll();
    button.textContent = assigned.length ? 'Assigned pilots offline' : 'Assign a pilot first';
    button.disabled = true;
    throw new Error(assigned.length ? 'No assigned characters are currently online.' : 'Assign a character to this route first.');
  }
  button.textContent = 'Sending…';
  const results = [];
  let calculations = [...(route.calculations || [])];
  for (const character of characters) {
    try {
      if (route.originMode !== 'fixed' && character.location && !character.locationError) {
        const origin = resolveSystem(character.location.id, `${character.name}’s location`);
        const result = calculateSeedItinerary(route, origin, character.id);
        if (!result) {
          results.push({ character, ok: true });
          continue;
        }
        const calculation = {
          key: String(character.id),
          characterId: character.id,
          origin: result.origin,
          systems: result.systems,
          stops: result.stops,
          jumpCount: Math.max(0, result.systems.length - 1),
          calculatedAt: new Date().toISOString()
        };
        calculations = calculations.filter((item) => item.characterId !== character.id);
        calculations.push(calculation);
      }
      const stops = autopilotStopsFor({ ...route, calculations }, character.id);
      for (let index = 0; index < stops.length; index += 1) {
        await esi.setWaypoint(character.id, stops[index].id, index === 0);
      }
      results.push({ character, ok: true });
    } catch (error) {
      results.push({ character, ok: false, error });
    }
  }
  const successful = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  if (successful.length) {
    const updated = {
      ...route,
      calculations: ensureReferenceCalculation(calculations),
      lastCalculatedAt: new Date().toISOString(),
      lastSentAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await store.put('routes', updated);
    state.routes[state.routes.findIndex((item) => item.id === route.id)] = updated;
    renderRoutes();
  }
  setBusy(button, false);
  const remainingOnline = selectedCharacters(route).filter(isCharacterOnline).length;
  button.textContent = remainingOnline ? `Send to ${remainingOnline} online` : 'Assigned pilots offline';
  button.disabled = !remainingOnline;
  if (failed.length) throw new Error(`Sent to ${successful.length}; failed for ${failed.map((result) => result.character.name).join(', ')}: ${failed[0].error.message}`);
  const skipped = assigned.length - characters.length;
  toast(`Route sent to ${successful.length} online pilot${successful.length === 1 ? '' : 's'}${skipped ? `; ${skipped} offline skipped` : ''}.`);
}

function confirmAction(title, message, confirmText = 'Confirm') {
  return new Promise((resolve) => {
    const dialog = $('confirm-dialog');
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-accept').textContent = confirmText;
    const finish = (value) => {
      dialog.close();
      resolve(value);
    };
    $('confirm-cancel').onclick = () => finish(false);
    $('confirm-accept').onclick = () => finish(true);
    dialog.addEventListener('cancel', () => resolve(false), { once: true });
    dialog.showModal();
  });
}

async function deleteRoute(route) {
  if (!await confirmAction('Delete this route?', `${route.name} will be removed from this browser.`, 'Delete route')) return;
  await store.delete('routes', route.id);
  state.routes = state.routes.filter((item) => item.id !== route.id);
  if ($('route-editor').open) $('route-editor').close();
  if ($('route-detail').open) $('route-detail').close();
  state.editingRouteId = null;
  state.detailRouteId = null;
  renderAll();
  toast('Route deleted.');
}

async function copyRoute(route) {
  const copy = duplicateRoute(route);
  await store.put('routes', copy);
  state.routes.push(copy);
  $('route-detail').close();
  renderAll();
  toast('Route duplicated as a draft.');
}

async function removeCharacter(characterId) {
  const character = state.characters.find((item) => item.id === Number(characterId));
  if (!character) return;
  if (!await confirmAction('Remove this character?', `${character.name}’s local tokens and route assignments will be removed.`, 'Remove character')) return;
  await store.delete('characters', character.id);
  state.characters = state.characters.filter((item) => item.id !== character.id);
  const changedRoutes = state.routes.filter((route) => route.assignedCharacterIds.includes(character.id)).map((route) => ({
    ...route,
    assignedCharacterIds: route.assignedCharacterIds.filter((id) => id !== character.id),
    stopAssignments: [],
    calculations: ensureReferenceCalculation(route.calculations)
      .filter((calculation) => calculation.characterId !== character.id),
    updatedAt: new Date().toISOString()
  }));
  await store.putMany('routes', changedRoutes);
  const changes = new Map(changedRoutes.map((route) => [route.id, route]));
  state.routes = state.routes.map((route) => changes.get(route.id) || route);
  renderAll();
  toast(`${character.name} removed.`);
}

function exportRoutes() {
  if (!state.routes.length) return toast('There are no routes to export.', 'error');
  const payload = serializeRoutes(state.routes, { kind: APP_CONFIG.exportKind, version: APP_CONFIG.exportVersion });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `just-the-trip-routes-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${state.routes.length} route${state.routes.length === 1 ? '' : 's'}.`);
}

async function importRoutes(file) {
  if (!file) return;
  if (file.size > 2_000_000) throw new Error('Route files must be smaller than 2 MB.');
  const imported = parseRouteImport(await file.text(), state.routes, state.characters.map((character) => character.id));
  await store.putMany('routes', imported);
  state.routes.push(...imported);
  renderAll();
  toast(`Imported ${imported.length} route${imported.length === 1 ? '' : 's'}.`);
}

async function updateSetting(key, value) {
  state.settings = { ...state.settings, [key]: value };
  applyAppearance();
  await store.setSetting(key, value);
}

async function updateRouteBoardSetting(control) {
  renderRoutes();
  await store.setSetting(control.id, control.value);
}

async function eraseAllData() {
  if (!await confirmAction('Erase all local data?', 'This permanently removes routes, character tokens, locations, and settings from this browser.', 'Erase everything')) return;
  await store.destroy();
  window.location.reload();
}

function bindEvents() {
  bindSystemAutocomplete();
  document.querySelectorAll('[data-view-target]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.viewTarget)));
  $('header-clear-routes').addEventListener('click', openClearRoutesDialog);
  $('header-new-route').addEventListener('click', () => openRouteEditor());
  $('header-add-character').addEventListener('click', beginAuthorization);
  $('characters-sync').addEventListener('click', (event) => refreshAllLocations({ button: event.currentTarget }));
  $('add-character').addEventListener('click', beginAuthorization);
  $('characters-list').addEventListener('click', (event) => {
    const add = event.target.closest('[data-add-character]');
    if (add) return beginAuthorization();
    const reauthorize = event.target.closest('[data-reauthorize]');
    if (reauthorize) return beginAuthorization();
    const remove = event.target.closest('[data-remove-character]');
    if (remove) removeCharacter(remove.dataset.removeCharacter);
  });
  ['route-search', 'route-status-filter', 'route-sort'].forEach((id) => {
    const control = $(id);
    control.addEventListener(id === 'route-search' ? 'input' : 'change', async () => {
      try {
        await updateRouteBoardSetting(control);
      } catch (error) {
        toast(`Could not remember route filters: ${error.message}`, 'error');
      }
    });
  });
  $('show-offline-pilots').addEventListener('change', async () => {
    try {
      renderAssignedPilots();
      await store.setSetting('show-offline-pilots', $('show-offline-pilots').checked);
    } catch (error) {
      toast(`Could not remember the pilot filter: ${error.message}`, 'error');
    }
  });
  $('routes-list').addEventListener('click', (event) => {
    const edit = event.target.closest('[data-route-edit]');
    if (edit) {
      const route = state.routes.find((item) => item.id === edit.dataset.routeEdit);
      if (route) openRouteEditor(route);
      return;
    }
    const assign = event.target.closest('[data-route-assign]');
    if (assign) {
      const route = state.routes.find((item) => item.id === assign.dataset.routeAssign);
      if (route) openRouteAssignment(route);
    }
  });
  $('route-mode').addEventListener('change', updateRouteMode);
  $('route-origin-mode').addEventListener('change', updateOriginMode);
  $('route-coverage-type').addEventListener('change', () => {
    hideSystemAutocomplete();
    state.editorCoverageArea = null;
    $('route-coverage-area').value = '';
    $('route-coverage-area').placeholder = `Search ${$('route-coverage-type').value}s`;
    $('route-coverage-status').textContent = 'Choose an area to generate an optimized coverage route.';
  });
  $('route-coverage-generate').addEventListener('click', generateCoverageStops);
  $('route-add-current-location').addEventListener('click', async () => {
    try {
      await addCurrentLocationsToRoute();
      $('route-form-status').textContent = '';
    } catch (error) {
      $('route-form-status').textContent = error.message;
      toast(error.message, 'error');
    }
  });
  $('route-waypoint-add').addEventListener('click', () => handleEditorBuilderAction(() => addEditorSystem('editorStops', 'route-waypoint-input', 'Stop')));
  $('route-avoid-add').addEventListener('click', () => handleEditorBuilderAction(() => addEditorSystem('editorAvoidSystems', 'route-avoid-input', 'Avoid system')));
  $('route-connection-add').addEventListener('click', () => handleEditorBuilderAction(addEditorConnection));
  [
    ['route-waypoint-input', () => addEditorSystem('editorStops', 'route-waypoint-input', 'Stop')],
    ['route-avoid-input', () => addEditorSystem('editorAvoidSystems', 'route-avoid-input', 'Avoid system')],
    ['route-connection-from', addEditorConnection],
    ['route-connection-to', addEditorConnection]
  ].forEach(([id, action]) => {
    $(id).addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      handleEditorBuilderAction(action);
    });
  });
  ['route-waypoint-input', 'route-avoid-input'].forEach((id) => {
    $(id).addEventListener('change', () => {
      const resolved = id === 'route-waypoint-input' ? state.graph.resolveStop($(id).value) : state.graph.resolve($(id).value);
      if (resolved) {
        const collection = id === 'route-waypoint-input' ? 'editorStops' : 'editorAvoidSystems';
        const label = id === 'route-waypoint-input' ? 'Stop' : 'Avoid system';
        handleEditorBuilderAction(() => addEditorSystem(collection, id, label));
      }
    });
  });
  ['route-connection-from', 'route-connection-to'].forEach((id) => {
    $(id).addEventListener('change', () => {
      if (state.graph.resolve($('route-connection-from').value) && state.graph.resolve($('route-connection-to').value)) {
        handleEditorBuilderAction(addEditorConnection);
      }
    });
  });
  $('route-waypoint-list').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-waypoint-drag')) return;
    const index = Number(button.dataset.index);
    if (button.hasAttribute('data-waypoint-remove')) state.editorStops.splice(index, 1);
    if (button.dataset.waypointMove === 'up' && index > 0) {
      [state.editorStops[index - 1], state.editorStops[index]] = [state.editorStops[index], state.editorStops[index - 1]];
    }
    if (button.dataset.waypointMove === 'down' && index < state.editorStops.length - 1) {
      [state.editorStops[index + 1], state.editorStops[index]] = [state.editorStops[index], state.editorStops[index + 1]];
    }
    renderEditorSystems();
  });
  $('route-waypoint-list').addEventListener('pointerdown', beginWaypointDrag);
  $('route-waypoint-list').addEventListener('pointermove', moveWaypointDrag);
  $('route-waypoint-list').addEventListener('pointerup', finishWaypointDrag);
  $('route-waypoint-list').addEventListener('pointercancel', finishWaypointDrag);
  $('route-avoid-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-avoid-remove]');
    if (!button) return;
    state.editorAvoidSystems.splice(Number(button.dataset.index), 1);
    renderEditorSystems();
  });
  $('route-connection-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-connection-remove]');
    if (!button) return;
    state.editorConnections.splice(Number(button.dataset.index), 1);
    renderEditorSystems();
  });
  document.querySelectorAll('input[name="preference"]').forEach((input) => input.addEventListener('change', updatePreference));
  $('security-penalty').addEventListener('input', () => { $('security-penalty-output').textContent = $('security-penalty').value; });
  $('route-form').addEventListener('submit', saveRoute);
  $('route-delete').addEventListener('click', () => {
    const route = state.routes.find((item) => item.id === state.editingRouteId);
    if (route) deleteRoute(route);
  });
  $('route-assignment-character-options').addEventListener('change', (event) => {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;
    const characterId = Number(input.value);
    const character = state.characters.find((item) => item.id === characterId);
    if (!isCharacterOnline(character)) {
      input.checked = false;
      return;
    }
    if (input.checked) {
      state.assignmentCharacterIds.add(characterId);
    } else {
      state.assignmentCharacterIds.delete(characterId);
    }
    $('route-assignment-status').textContent = '';
    $('route-assignment-status').classList.remove('is-error');
    renderRouteAssignment();
  });
  $('assignment-select-all').addEventListener('click', () => selectAllRoutePilots(true));
  $('assignment-select-none').addEventListener('click', () => selectAllRoutePilots(false));
  $('route-assignment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('route-assignment-submit');
    const status = $('route-assignment-status');
    const closeButtons = document.querySelectorAll('[data-close-dialog="route-assignment"]');
    state.settingRoutes = true;
    status.classList.remove('is-error');
    status.textContent = 'Preparing routes…';
    closeButtons.forEach((closeButton) => { closeButton.disabled = true; });
    renderRouteAssignment();
    setBusy(button, true, 'Setting routes…');
    try {
      await saveRouteAssignments(event);
    } catch (error) {
      console.error(error);
      status.textContent = error.message;
      status.classList.add('is-error');
      toast(error.message, 'error');
    } finally {
      state.settingRoutes = false;
      setBusy(button, false);
      closeButtons.forEach((closeButton) => { closeButton.disabled = false; });
      if ($('route-assignment').open) renderRouteAssignment();
    }
  });
  $('clear-routes-character-options').addEventListener('change', (event) => {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;
    const characterId = Number(input.value);
    const character = state.characters.find((item) => item.id === characterId);
    if (!canClearCharacterRoute(character)) {
      input.checked = false;
      return;
    }
    if (input.checked) state.clearRouteCharacterIds.add(characterId);
    else state.clearRouteCharacterIds.delete(characterId);
    $('clear-routes-status').textContent = '';
    $('clear-routes-status').classList.remove('is-error');
    renderClearRoutesDialog();
  });
  $('clear-routes-select-all').addEventListener('click', () => selectAllClearRoutePilots(true));
  $('clear-routes-select-none').addEventListener('click', () => selectAllClearRoutePilots(false));
  $('clear-routes-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('clear-routes-submit');
    const status = $('clear-routes-status');
    const closeButtons = document.querySelectorAll('[data-close-dialog="clear-routes-dialog"]');
    state.clearingRoutes = true;
    status.classList.remove('is-error');
    status.textContent = 'Preparing to clear routes…';
    closeButtons.forEach((closeButton) => { closeButton.disabled = true; });
    renderClearRoutesDialog();
    setBusy(button, true, 'Clearing…');
    try {
      await clearSelectedPilotRoutes();
    } catch (error) {
      console.error(error);
      status.textContent = error.message;
      status.classList.add('is-error');
      toast(error.message, 'error');
    } finally {
      state.clearingRoutes = false;
      setBusy(button, false);
      closeButtons.forEach((closeButton) => { closeButton.disabled = false; });
      if ($('clear-routes-dialog').open) renderClearRoutesDialog();
    }
  });
  document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $(button.dataset.closeDialog).close()));
  $('detail-edit').addEventListener('click', () => { const route = currentDetailRoute(); if (route) { $('route-detail').close(); openRouteEditor(route); } });
  $('detail-duplicate').addEventListener('click', () => { const route = currentDetailRoute(); if (route) copyRoute(route); });
  $('detail-delete').addEventListener('click', () => { const route = currentDetailRoute(); if (route) deleteRoute(route); });
  $('detail-send').addEventListener('click', async () => {
    const route = currentDetailRoute();
    if (!route) return;
    if (!selectedCharacters(route).some(isCharacterOnline)) {
      $('route-detail').close();
      openRouteAssignment(route);
      toast('Assign one or more online pilots to send this route.');
      return;
    }
    try {
      await sendRouteToAutopilot(route);
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('settings-export').addEventListener('click', exportRoutes);
  $('settings-import').addEventListener('click', () => { $('import-file').value = ''; $('import-file').click(); });
  $('import-file').addEventListener('change', async () => { try { await importRoutes($('import-file').files?.[0]); } catch (error) { toast(error.message, 'error'); } });
  $('theme-select').addEventListener('change', async () => {
    try { await updateSetting('theme', $('theme-select').value); } catch (error) { toast(error.message, 'error'); }
  });
  $('density-select').addEventListener('change', async () => {
    try { await updateSetting('density', $('density-select').value); } catch (error) { toast(error.message, 'error'); }
  });
  $('erase-data').addEventListener('click', eraseAllData);
  window.addEventListener('storage', async () => {
    state.routes = await store.getAll('routes');
    state.characters = await store.getAll('characters');
    renderAll();
  });
}

async function initialize() {
  updateSlogan();
  try {
    const [graph, routes, characters, theme, density, routeSearch, routeStatus, routeSort, showOfflinePilots] = await Promise.all([
      UniverseGraph.load('./data/universe.json'),
      store.getAll('routes'),
      store.getAll('characters'),
      store.getSetting('theme', 'system'),
      store.getSetting('density', 'comfortable'),
      store.getSetting('route-search', ''),
      store.getSetting('route-status-filter', 'all'),
      store.getSetting('route-sort', 'updated'),
      store.getSetting('show-offline-pilots', true)
    ]);
    state.graph = graph;
    state.routes = routes;
    state.characters = characters.sort((a, b) => a.name.localeCompare(b.name));
    state.settings = { theme, density };
    $('route-search').value = typeof routeSearch === 'string' ? routeSearch : '';
    $('route-status-filter').value = ['all', 'ready', 'draft', 'archived'].includes(routeStatus) ? routeStatus : 'all';
    $('route-sort').value = ['updated', 'name', 'jumps'].includes(routeSort) ? routeSort : 'updated';
    $('show-offline-pilots').checked = showOfflinePilots !== false;
    applyAppearance();
    prepareSystemAutocomplete();
    bindEvents();
    renderAll();
    const params = new URLSearchParams(window.location.search);
    if (params.has('authorized')) {
      toast(`${params.get('authorized')} connected.`);
      history.replaceState({}, '', window.location.pathname);
    }
    if (state.characters.length) refreshAllLocations({ quiet: true });
    state.onlineTimer = window.setInterval(refreshOnlineStatuses, ONLINE_REFRESH_MS);
    state.locationTimer = window.setInterval(refreshOnlineLocations, LOCATION_REFRESH_MS);
  } catch (error) {
    console.error(error);
    $('routes-list').innerHTML = `<div class="empty-state"><h3>Just The Trip could not start</h3><p>${escapeHtml(error.message)}</p></div>`;
    toast(error.message, 'error');
  }
}

if (!redirectToLocalhost) initialize();
