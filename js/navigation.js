const VIEW_ALIASES = new Map([
  ['route', 'routes'],
  ['routes', 'routes'],
  ['map', 'map'],
  ['character', 'characters'],
  ['characters', 'characters'],
  ['setting', 'settings'],
  ['settings', 'settings']
]);

export function parseViewHash(hash) {
  let value = String(hash || '').replace(/^#/, '');
  try {
    value = decodeURIComponent(value);
  } catch (_) {
    return { view: 'routes', systemId: null };
  }
  const mapMatch = value.match(/^map(?:-(\d+))?$/i);
  if (mapMatch) {
    const systemId = mapMatch[1] ? Number(mapMatch[1]) : null;
    return { view: 'map', systemId: Number.isSafeInteger(systemId) ? systemId : null };
  }
  return { view: VIEW_ALIASES.get(value.toLowerCase()) || 'routes', systemId: null };
}

export function viewHash(view, selectedSystemId = null) {
  if (view === 'map') {
    const systemId = Number(selectedSystemId);
    return Number.isSafeInteger(systemId) && systemId > 0 ? `#map-${systemId}` : '#map';
  }
  if (view === 'characters') return '#characters';
  if (view === 'settings') return '#settings';
  return '#route';
}
