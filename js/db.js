const DB_NAME = 'just-the-trip';
const DB_VERSION = 2;

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

export class TripStore {
  constructor() {
    this.databasePromise = null;
  }

  open() {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
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
      request.addEventListener('blocked', () => reject(new Error('Close other Just The Trip tabs before upgrading local data.')), { once: true });
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
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.addEventListener('success', resolve, { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
      request.addEventListener('blocked', () => reject(new Error('Close other Just The Trip tabs before erasing local data.')), { once: true });
    });
  }
}
