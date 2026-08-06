export function isCharacterOnline(character) {
  return character?.presence?.online === true && !character?.onlineError;
}

export async function syncCharacterOnline(character, services, now = () => new Date().toISOString()) {
  const status = await services.getOnline(character.id);
  const presence = {
    online: Boolean(status.online),
    lastLogin: status.lastLogin || null,
    lastLogout: status.lastLogout || null,
    logins: Number(status.logins || 0),
    checkedAt: now()
  };

  return {
    ...character,
    presence,
    onlineError: null,
    ...(presence.online ? {} : { locationError: null, shipError: null })
  };
}

export async function syncOnlineCharacterData(character, services, now = () => new Date().toISOString()) {
  if (!isCharacterOnline(character)) return character;

  const [locationResult, shipResult] = await Promise.allSettled([
    services.getLocation(character.id),
    services.getShip ? services.getShip(character.id) : Promise.resolve(null)
  ]);
  let updated = {
    ...character,
    onlineError: null
  };

  if (locationResult.status === 'fulfilled') {
    const rawLocation = locationResult.value;
    const systemId = Number(rawLocation.systemId);
    const system = services.resolveSystem(systemId);
    const systemName = system?.name || `System ${systemId}`;
    const stationId = rawLocation.stationId == null ? null : Number(rawLocation.stationId);
    const structureId = rawLocation.structureId == null ? null : Number(rawLocation.structureId);
    const station = stationId ? services.resolveStop?.(stationId) : null;
    const exact = structureId
      ? {
          id: structureId,
          name: rawLocation.structure?.name || `Structure ${structureId}`,
          kind: 'structure',
          systemId,
          systemName
        }
      : stationId
        ? {
            id: stationId,
            name: station?.name || `Station ${stationId}`,
            kind: 'station',
            systemId,
            systemName
          }
        : {
            id: systemId,
            name: systemName,
            kind: 'system',
            systemId,
            systemName
          };
    updated = {
      ...updated,
      locationError: null,
      location: {
        id: systemId,
        name: systemName,
        stop: exact,
        structureError: rawLocation.structureError || null,
        updatedAt: now()
      }
    };
  } else {
    updated.locationError = locationResult.reason?.message || 'Location is unavailable.';
  }

  if (shipResult.status === 'fulfilled' && shipResult.value) {
    updated = {
      ...updated,
      shipError: null,
      ship: {
        ...shipResult.value,
        updatedAt: now()
      }
    };
  } else if (shipResult.status === 'rejected') {
    updated.shipError = shipResult.reason?.message || 'Ship is unavailable.';
  }

  return updated;
}

export async function syncCharacterPresence(character, services, now = () => new Date().toISOString()) {
  const updated = await syncCharacterOnline(character, services, now);
  return syncOnlineCharacterData(updated, services, now);
}
