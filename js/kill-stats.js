const ZKILL_API = 'https://zkillboard.com/api/kills/solarSystemID';
const ESI_CHARACTER_API = 'https://esi.evetech.net/latest/characters';

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Kill data unavailable (${response.status}).`);
  return response.json();
}

export async function loadSystemKillStats(systemId, characterId) {
  const identity = await getJson(`${ESI_CHARACTER_API}/${Number(characterId)}/`);
  const corporationId = Number(identity.corporation_id) || null;
  const allianceId = Number(identity.alliance_id) || null;
  const scoped = (scope, id) => id
    ? getJson(`${ZKILL_API}/${Number(systemId)}/${scope}/${id}/`)
    : Promise.resolve([]);
  const [characterKills, corporationKills, allianceKills] = await Promise.all([
    scoped('characterID', characterId),
    scoped('corporationID', corporationId),
    scoped('allianceID', allianceId)
  ]);
  return {
    me: Array.isArray(characterKills) ? characterKills.length : 0,
    corp: Array.isArray(corporationKills) ? corporationKills.length : 0,
    alliance: Array.isArray(allianceKills) ? allianceKills.length : 0,
    sampled: Array.isArray(characterKills) ? characterKills.length : 0,
    links: {
      me: `https://zkillboard.com/character/${Number(characterId)}/solarSystemID/${Number(systemId)}/`,
      corp: corporationId ? `https://zkillboard.com/corporation/${corporationId}/solarSystemID/${Number(systemId)}/` : '',
      alliance: allianceId ? `https://zkillboard.com/alliance/${allianceId}/solarSystemID/${Number(systemId)}/` : ''
    }
  };
}
