const DB_NAME = 'splash';
const LEGACY_DB_NAME = ['just', 'the', 'trip'].join('-');
const DB_VERSION = 2;
const STORE_NAMES = Object.freeze(['routes', 'characters', 'names', 'kv']);
const MIGRATION_KEY = 'splash-storage-migration';

function resultOf(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', resolve, { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error), { once: true });
  });
}

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener('success', resolve, { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
    request.addEventListener('blocked', () => reject(new Error('Close other Splash tabs before erasing local data.')), { once: true });
  });
}

function openSplashDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener('upgradeneeded', (event) => {
      const database = request.result;
      if (event.oldVersion > 0 && event.oldVersion < 2 && database.objectStoreNames.contains('routes')) {
        database.deleteObjectStore('routes');
      }
      if (!database.objectStoreNames.contains('routes')) {
        const store = database.createObjectStore('routes', { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!database.objectStoreNames.contains('characters')) {
        database.createObjectStore('characters', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('names')) {
        database.createObjectStore('names', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('kv')) {
        database.createObjectStore('kv', { keyPath: 'key' });
      }
    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
    request.addEventListener('blocked', () => reject(new Error('Close other Splash tabs before upgrading local data.')), { once: true });
  });
}

async function legacyDatabaseExists() {
  if (typeof indexedDB.databases !== 'function') return true;
  try {
    return (await indexedDB.databases()).some((database) => database.name === LEGACY_DB_NAME);
  } catch (_) {
    return true;
  }
}

async function openLegacyDatabase() {
  if (!await legacyDatabaseExists()) return null;
  return new Promise((resolve, reject) => {
    let created = false;
    const request = indexedDB.open(LEGACY_DB_NAME);
    request.addEventListener('upgradeneeded', (event) => {
      created = event.oldVersion === 0;
    }, { once: true });
    request.addEventListener('success', () => {
      const database = request.result;
      if (!created) return resolve(database);
      database.close();
      indexedDB.deleteDatabase(LEGACY_DB_NAME);
      return resolve(null);
    }, { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
}

async function migrateLegacyData(database) {
  const marker = await resultOf(database.transaction('kv', 'readonly').objectStore('kv').get(MIGRATION_KEY));
  if (marker) return;

  const legacy = await openLegacyDatabase();
  const valuesByStore = new Map();
  if (legacy) {
    for (const storeName of STORE_NAMES) {
      if (!legacy.objectStoreNames.contains(storeName)) continue;
      valuesByStore.set(storeName, await resultOf(legacy.transaction(storeName, 'readonly').objectStore(storeName).getAll()));
    }
    legacy.close();
  }

  const transaction = database.transaction(STORE_NAMES, 'readwrite');
  valuesByStore.forEach((values, storeName) => {
    const store = transaction.objectStore(storeName);
    values.forEach((value) => store.put(value));
  });
  transaction.objectStore('kv').put({ key: MIGRATION_KEY, value: true });
  await done(transaction);
}

export class TripStore {
  constructor() {
    this.databasePromise = null;
  }

  open() {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = openSplashDatabase().then(async (database) => {
      await migrateLegacyData(database);
      return database;
    });
    return this.databasePromise;
  }

  async get(storeName, key) {
    const database = await this.open();
    return resultOf(database.transaction(storeName, 'readonly').objectStore(storeName).get(key));
  }

  async getAll(storeName) {
    const database = await this.open();
    return resultOf(database.transaction(storeName, 'readonly').objectStore(storeName).getAll());
  }

  async put(storeName, value) {
    const database = await this.open();
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(value);
    await done(transaction);
    return value;
  }

  async putMany(storeName, values) {
    if (!values.length) return;
    const database = await this.open();
    const transaction = database.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    values.forEach((value) => store.put(value));
    await done(transaction);
  }

  async delete(storeName, key) {
    const database = await this.open();
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(key);
    await done(transaction);
  }

  async clear(storeName) {
    const database = await this.open();
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).clear();
    await done(transaction);
  }

  async getSetting(key, fallback = null) {
    const record = await this.get('kv', key);
    return record ? record.value : fallback;
  }

  async setSetting(key, value) {
    return this.put('kv', { key, value });
  }

  async destroy() {
    if (this.databasePromise) {
      const database = await this.databasePromise;
      database.close();
    }
    this.databasePromise = null;
    await deleteDatabase(DB_NAME);
    if (await legacyDatabaseExists()) await deleteDatabase(LEGACY_DB_NAME);
  }
}
