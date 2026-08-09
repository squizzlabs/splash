export const APP_CONFIG = Object.freeze({
  appName: 'Splash',
  version: '0.1.0',
  userAgentAttribution: 'Squizz Caphinator',
  compatibilityDate: '2026-08-05',
  esiBaseUrl: 'https://esi.evetech.net',
  eveScoutSignaturesUrl: 'https://api.eve-scout.com/v2/public/signatures',
  eveScoutCacheMs: 300_000,
  ssoMetadataUrl: 'https://login.eveonline.com/.well-known/oauth-authorization-server',
  // Public deployment configuration. These are not user-editable settings.
  localClientId: '2113ced1124d45ee82163a3298edc652',
  productionClientId: '1fc09d4a52d44a278c7e6ca172153c85',
  productionHost: 'splash.zzeve.com',
  localCallbackUrl: 'http://localhost:59832/callback',
  productionCallbackUrl: 'https://splash.zzeve.com/callback',
  scopes: [
    'esi-location.read_location.v1',
    'esi-location.read_online.v1',
    'esi-location.read_ship_type.v1',
    'esi-structures.read_character.v1',
    'esi-ui.write_waypoint.v1'
  ],
  exportKind: 'splash-routes',
  exportVersion: 2
});
