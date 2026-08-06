import { APP_CONFIG } from './config.js';

const OAUTH_PREFIX = 'just-the-trip:oauth:';

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodePart(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function parsePart(value) {
  return JSON.parse(new TextDecoder().decode(decodePart(value)));
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function normalizeIssuer(value) {
  return String(value || '').trim().toLocaleLowerCase().replace(/\/+$/, '');
}

function isLocalHostname(hostname) {
  return ['localhost', '127.0.0.1'].includes(hostname);
}

export function userAgentForHostname(hostname) {
  const callbackUrl = isLocalHostname(hostname) ? APP_CONFIG.localCallbackUrl : APP_CONFIG.productionCallbackUrl;
  return `${APP_CONFIG.appName} / ${new URL(callbackUrl).origin} / ${APP_CONFIG.userAgentAttribution}`;
}

export function isValidEveIssuer(issuer, metadataIssuer = '') {
  const normalized = normalizeIssuer(issuer);
  return new Set([
    normalizeIssuer(metadataIssuer),
    normalizeIssuer('https://login.eveonline.com/'),
    normalizeIssuer('login.eveonline.com')
  ].filter(Boolean)).has(normalized);
}

export class ESIError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.name = 'ESIError';
    this.status = status;
    this.payload = payload;
  }
}

export class ESIClient {
  constructor(store) {
    this.store = store;
    this.metadataPromise = null;
  }

  async metadata() {
    if (!this.metadataPromise) {
      this.metadataPromise = fetch(APP_CONFIG.ssoMetadataUrl).then(async (response) => {
        if (!response.ok) throw new Error('EVE SSO metadata is unavailable.');
        return response.json();
      });
    }
    return this.metadataPromise;
  }

  async clientId() {
    return isLocalHostname(window.location.hostname)
      ? APP_CONFIG.localClientId
      : APP_CONFIG.productionClientId;
  }

  get callbackUrl() {
    if (isLocalHostname(window.location.hostname)) return APP_CONFIG.localCallbackUrl;
    if (window.location.hostname === APP_CONFIG.productionHost) return APP_CONFIG.productionCallbackUrl;
    return `${window.location.origin}/callback`;
  }

  get userAgent() {
    return userAgentForHostname(window.location.hostname);
  }

  async isConfigured() {
    return Boolean(await this.clientId());
  }

  async beginAuthorization() {
    const clientId = await this.clientId();
    if (!clientId) throw new Error('EVE SSO is not configured for this deployment.');

    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
    sessionStorage.setItem(`${OAUTH_PREFIX}verifier`, verifier);
    sessionStorage.setItem(`${OAUTH_PREFIX}state`, state);
    sessionStorage.setItem(`${OAUTH_PREFIX}clientId`, clientId);

    const metadata = await this.metadata();
    const params = new URLSearchParams({
      response_type: 'code',
      redirect_uri: this.callbackUrl,
      client_id: clientId,
      scope: APP_CONFIG.scopes.join(' '),
      code_challenge: base64Url(new Uint8Array(digest)),
      code_challenge_method: 'S256',
      state
    });
    window.location.assign(`${metadata.authorization_endpoint}?${params}`);
  }

  async validateAccessToken(token, clientId) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('EVE SSO returned an invalid access token.');
    const header = parsePart(parts[0]);
    const claims = parsePart(parts[1]);
    if (header.alg !== 'RS256' || !header.kid) throw new Error('EVE SSO returned an unsupported token signature.');

    const metadata = await this.metadata();
    const jwksResponse = await fetch(metadata.jwks_uri);
    if (!jwksResponse.ok) throw new Error('EVE SSO signing keys are unavailable.');
    const jwks = await jwksResponse.json();
    const jwk = jwks.keys?.find((candidate) => candidate.kid === header.kid);
    if (!jwk) throw new Error('EVE SSO token signing key was not found.');
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      decodePart(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) throw new Error('EVE SSO token signature validation failed.');

    if (!isValidEveIssuer(claims.iss, metadata.issuer)) {
      throw new Error('EVE SSO token issuer is invalid.');
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(clientId)) throw new Error('EVE SSO token was issued for a different application.');
    if (Number(claims.exp || 0) * 1000 <= Date.now()) throw new Error('EVE SSO returned an expired access token.');
    return claims;
  }

  async requestToken(fields) {
    const metadata = await this.metadata();
    const response = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields)
    });
    const payload = await parseResponse(response);
    if (!response.ok || !payload?.access_token) {
      throw new ESIError(payload?.error_description || payload?.error || 'EVE SSO token request failed.', response.status, payload);
    }
    return payload;
  }

  async handleAuthorizationCallback(search = window.location.search) {
    const params = new URLSearchParams(search);
    const expectedState = sessionStorage.getItem(`${OAUTH_PREFIX}state`);
    const verifier = sessionStorage.getItem(`${OAUTH_PREFIX}verifier`);
    const clientId = sessionStorage.getItem(`${OAUTH_PREFIX}clientId`) || await this.clientId();
    if (params.get('error')) throw new Error(params.get('error_description') || `EVE SSO declined authorization: ${params.get('error')}`);
    if (!expectedState || params.get('state') !== expectedState) throw new Error('EVE SSO state validation failed. Start the login again.');
    if (!verifier || !params.get('code') || !clientId) throw new Error('The EVE SSO callback is incomplete.');

    const token = await this.requestToken({
      grant_type: 'authorization_code',
      code: params.get('code'),
      client_id: clientId,
      code_verifier: verifier,
      redirect_uri: this.callbackUrl
    });
    const claims = await this.validateAccessToken(token.access_token, clientId);
    const characterId = Number(String(claims.sub || '').replace('CHARACTER:EVE:', ''));
    if (!Number.isSafeInteger(characterId) || characterId <= 0) throw new Error('The EVE access token did not identify a character.');
    const scopes = Array.isArray(claims.scp) ? claims.scp : String(claims.scp || '').split(/\s+/).filter(Boolean);
    const existing = await this.store.get('characters', characterId);
    const character = {
      ...existing,
      id: characterId,
      name: claims.name || existing?.name || `Character ${characterId}`,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || existing?.refreshToken,
      expiresAt: Date.now() + (Math.max(60, Number(token.expires_in || 1200)) - 30) * 1000,
      scopes,
      addedAt: existing?.addedAt || Date.now(),
      authorizedAt: Date.now()
    };
    await this.store.put('characters', character);
    ['state', 'verifier', 'clientId'].forEach((key) => sessionStorage.removeItem(`${OAUTH_PREFIX}${key}`));
    return character;
  }

  async accessToken(characterId, forceRefresh = false) {
    const character = await this.store.get('characters', Number(characterId));
    if (!character) throw new Error('That character is no longer connected.');
    if (!forceRefresh && character.accessToken && character.expiresAt > Date.now()) return character.accessToken;
    if (!character.refreshToken) throw new Error(`${character.name} must be connected again.`);
    const clientId = await this.clientId();
    const token = await this.requestToken({
      grant_type: 'refresh_token',
      refresh_token: character.refreshToken,
      client_id: clientId
    });
    const claims = await this.validateAccessToken(token.access_token, clientId);
    const updated = {
      ...character,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || character.refreshToken,
      expiresAt: Date.now() + (Math.max(60, Number(token.expires_in || 1200)) - 30) * 1000,
      scopes: Array.isArray(claims.scp) ? claims.scp : String(claims.scp || '').split(/\s+/).filter(Boolean)
    };
    await this.store.put('characters', updated);
    return updated.accessToken;
  }

  async request(path, options = {}) {
    const headers = {
      Accept: 'application/json',
      'X-Compatibility-Date': APP_CONFIG.compatibilityDate,
      'X-User-Agent': this.userAgent,
      ...(options.headers || {})
    };
    if (options.characterId) headers.Authorization = `Bearer ${await this.accessToken(options.characterId, options.forceRefresh)}`;
    let body;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const url = path.startsWith('http') ? path : `${APP_CONFIG.esiBaseUrl}${path}`;
    const response = await fetch(url, { method: options.method || 'GET', headers, body, cache: options.cache });
    if (response.status === 401 && options.characterId && !options.forceRefresh) {
      return this.request(path, { ...options, forceRefresh: true });
    }
    const payload = await parseResponse(response);
    if (!response.ok) {
      const retry = response.headers.get('Retry-After');
      const message = response.status === 429
        ? `ESI rate limit reached. Try again in ${retry || 'a few'} seconds.`
        : payload?.error || payload?.message || `ESI request failed with status ${response.status}.`;
      throw new ESIError(message, response.status, payload);
    }
    return { data: payload, headers: response.headers, status: response.status };
  }

  async characterLocation(characterId) {
    const response = await this.request(`/characters/${Number(characterId)}/location`, { characterId });
    const location = {
      systemId: Number(response.data.solar_system_id),
      stationId: response.data.station_id == null ? null : Number(response.data.station_id),
      structureId: response.data.structure_id == null ? null : Number(response.data.structure_id),
      structure: null,
      structureError: null
    };
    if (location.structureId) {
      try {
        location.structure = await this.structureInfo(characterId, location.structureId);
      } catch (error) {
        location.structureError = error.message;
      }
    }
    return location;
  }

  async structureInfo(characterId, structureId) {
    const id = Number(structureId);
    const key = `structure:${id}`;
    const cached = await this.store.get('names', key);
    if (cached?.name && cached.cachedAt > Date.now() - 3_600_000) {
      return {
        id,
        name: cached.name,
        systemId: Number(cached.systemId),
        typeId: cached.typeId == null ? null : Number(cached.typeId)
      };
    }
    const response = await this.request(`/universe/structures/${id}`, { characterId });
    const structure = {
      id,
      name: String(response.data.name || `Structure ${id}`),
      systemId: Number(response.data.solar_system_id),
      typeId: response.data.type_id == null ? null : Number(response.data.type_id)
    };
    await this.store.put('names', { ...structure, id: key, structureId: id, cachedAt: Date.now() });
    return structure;
  }

  async characterOnline(characterId) {
    const response = await this.request(`/characters/${Number(characterId)}/online`, { characterId, cache: 'no-store' });
    return {
      online: Boolean(response.data.online),
      lastLogin: response.data.last_login || null,
      lastLogout: response.data.last_logout || null,
      logins: Number(response.data.logins || 0)
    };
  }

  async typeName(typeId) {
    const key = `type:${Number(typeId)}`;
    const cached = await this.store.get('names', key);
    if (cached?.name) return cached.name;
    const response = await this.request(`/universe/types/${Number(typeId)}`);
    const name = response.data?.name || `Type ${Number(typeId)}`;
    await this.store.put('names', { id: key, name, cachedAt: Date.now() });
    return name;
  }

  async characterShip(characterId) {
    const response = await this.request(`/characters/${Number(characterId)}/ship`, { characterId });
    const typeId = Number(response.data.ship_type_id);
    let typeName;
    try {
      typeName = await this.typeName(typeId);
    } catch (_) {
      typeName = `Type ${typeId}`;
    }
    return {
      itemId: Number(response.data.ship_item_id),
      name: response.data.ship_name || typeName,
      typeId,
      typeName
    };
  }

  async setWaypoint(characterId, destinationId, clearOtherWaypoints = false) {
    const params = new URLSearchParams({
      add_to_beginning: 'false',
      clear_other_waypoints: String(Boolean(clearOtherWaypoints)),
      destination_id: String(Number(destinationId))
    });
    return this.request(`/ui/autopilot/waypoint?${params}`, { method: 'POST', characterId });
  }

  async setWaypoints(characterId, destinationIds, clearOtherWaypoints = true) {
    const ids = [...destinationIds].map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
    for (let index = 0; index < ids.length; index += 1) {
      await this.setWaypoint(characterId, ids[index], clearOtherWaypoints && index === 0);
    }
  }
}
