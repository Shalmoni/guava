import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBDatabase as FakeDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createDriveDatabase } from './driveDatabase';
import { STORAGE_KEY, type Trip } from './model';
import type { ActiveDrive } from './recording';
import { driveStorageKey, LocalDriveStorageError, saveDraft, saveTrips } from './storage';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function trip(ownerId = 'alice'): Trip {
  return {
    ownerId, id: 'trip-a', startedAt: 1000, endedAt: 11_000,
    points: [
      { position: [35.043, 32.461], timestamp: 1000, altitude: 100, accuracy: 5 },
      { position: [35.044, 32.461], timestamp: 11_000, altitude: 106, accuracy: 5 },
    ],
    distanceMeters: 94, heightMeters: 6, newRoadUnits: 4, xp: 18,
    communityStatus: 'failed', communityError: 'Offline', retryAfter: 12_000, uploadAttempts: 2,
  };
}

function draft(ownerId = 'alice'): ActiveDrive {
  const saved = trip(ownerId);
  return {
    ownerId, id: saved.id, startedAt: saved.startedAt, points: saved.points,
    distance: saved.distanceMeters, height: saved.heightMeters, altitudeAnchor: 106, share: true,
  };
}

function setup() {
  const factory = new IDBFactory();
  const storage = new MemoryStorage();
  const options = { indexedDB: factory, localStorage: storage, databaseName: 'guava-test' };
  return { factory, storage, options, database: createDriveDatabase(options) };
}

async function rawConnection(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open('guava-test', 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function replaceRawRecord(factory: IDBFactory, value: unknown, storeName = 'accounts'): Promise<void> {
  const connection = await rawConnection(factory);
  await new Promise<void>((resolve, reject) => {
    const transaction = connection.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  connection.close();
}

async function seedOldDatabase(factory: IDBFactory, value: unknown): Promise<void> {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('guava-test', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('accounts', { keyPath: 'scope' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = connection.transaction('accounts', 'readwrite');
    transaction.objectStore('accounts').put(value);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  connection.close();
}

test('trips and active drafts survive closing and reopening the database', async () => {
  const { database, options } = setup();
  await database.saveTrips('alice', [trip()]);
  await database.saveDraft('alice', draft());
  await database.close();
  const reopened = createDriveDatabase(options);
  assert.deepEqual(await reopened.loadTrips('alice'), [trip()]);
  assert.deepEqual(await reopened.loadDraft('alice'), draft());
  await reopened.close();
});

test('simultaneous field updates preserve both trips and draft through serialized transactions', async () => {
  const { database } = setup();
  await Promise.all([
    database.saveTrips('alice', [trip()]),
    database.saveDraft('alice', draft()),
  ]);
  assert.deepEqual(await database.loadTrips('alice'), [trip()]);
  assert.deepEqual(await database.loadDraft('alice'), draft());
  await database.saveDraft('alice', null);
  assert.deepEqual(await database.loadTrips('alice'), [trip()]);
  assert.equal(await database.loadDraft('alice'), null);
  await database.close();
});

test('save promises resolve after transaction completion, not request success', async () => {
  const { database } = setup();
  await database.loadTrips('alice');
  let committed = false;
  const original = FakeDatabase.prototype.transaction;
  FakeDatabase.prototype.transaction = function (...args) {
    const transaction = original.apply(this, args);
    transaction.addEventListener('complete', () => { committed = true; });
    return transaction;
  };
  try {
    await database.saveTrips('alice', [trip()]);
    assert.equal(committed, true);
  } finally {
    FakeDatabase.prototype.transaction = original;
    await database.close();
  }
});

test('account and anonymous scopes cannot read or replace each other', async () => {
  const { database } = setup();
  await database.saveTrips('alice', [trip()]);
  await database.saveDraft('local', draft('local'));
  assert.deepEqual(await database.loadTrips('bob'), []);
  assert.equal(await database.loadDraft('alice'), null);
  assert.equal((await database.loadDraft('local'))?.ownerId, 'local');
  await assert.rejects(database.saveTrips('bob', [trip()]), /do not belong/);
  await assert.rejects(database.saveDraft('bob', draft()), /does not belong/);
  assert.deepEqual(await database.loadTrips('alice'), [trip()]);
  await database.close();
});

test('same-account scoped v2 data migrates only after a durable transaction, and v1 stays unassigned', async () => {
  const { database, storage } = setup();
  saveTrips('alice', [trip()], storage);
  saveDraft('alice', draft(), storage);
  saveTrips('bob', [trip('bob')], storage);
  const legacy = JSON.stringify([{ ...trip(), ownerId: undefined, communityStatus: 'pending' }]);
  storage.setItem(STORAGE_KEY, legacy);
  assert.deepEqual(await database.loadTrips('alice'), [trip()]);
  assert.deepEqual(await database.loadDraft('alice'), draft());
  assert.equal(storage.getItem(driveStorageKey('alice', 'trips')), null);
  assert.equal(storage.getItem(driveStorageKey('alice', 'draft')), null);
  assert.ok(storage.getItem(driveStorageKey('bob', 'trips')));
  assert.equal(storage.getItem(STORAGE_KEY), legacy);
  assert.deepEqual(await database.loadTrips('carol'), []);
  await database.close();
});

test('failed migration keeps localStorage originals and does not silently fall back to writing them', async () => {
  const { database, storage } = setup();
  saveTrips('alice', [trip()], storage);
  const before = storage.getItem(driveStorageKey('alice', 'trips'));
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
  try {
    await assert.rejects(database.loadTrips('alice'), LocalDriveStorageError);
    assert.equal(storage.getItem(driveStorageKey('alice', 'trips')), before);
  } finally { IDBObjectStore.prototype.put = original; }
  assert.deepEqual(await database.loadTrips('alice'), [trip()]);
  await database.close();
});

test('quota or transaction abort leaves the previous durable draft and trip archive unchanged', async () => {
  const { database, storage } = setup();
  await database.saveTrips('alice', [trip()]);
  await database.saveDraft('alice', draft());
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
  try {
    await assert.rejects(database.saveDraft('alice', { ...draft(), distance: 200 }), /preserved/);
    await assert.rejects(database.saveTrips('alice', [{ ...trip(), id: 'new-trip' }]), /preserved/);
  } finally { IDBObjectStore.prototype.put = original; }
  assert.deepEqual(await database.loadTrips('alice'), [trip()]);
  assert.deepEqual(await database.loadDraft('alice'), draft());
  assert.equal(storage.values.size, 0);
  await database.close();
});

test('corrupt database records cannot be overwritten and can be exported without validation', async () => {
  const { database, factory } = setup();
  await database.loadTrips('alice');
  const corrupt = { version: 2, scope: 'alice', trips: 'broken trips' };
  await replaceRawRecord(factory, corrupt);
  await assert.rejects(database.loadTrips('alice'), /preserved/);
  await assert.rejects(database.saveTrips('alice', []), /preserved/);
  const exported = JSON.parse(await database.exportAccountData('alice'));
  assert.deepEqual(exported.raw.indexedDB.account, corrupt);
  // Independent drafts remain writable without replacing the corrupt archive.
  await database.saveDraft('alice', draft());
  assert.deepEqual(JSON.parse(await database.exportAccountData('alice')).raw.indexedDB.account, corrupt);
  await database.close();
});

test('corrupt or wrong-owner scoped legacy storage is preserved and exportable, never assigned', async () => {
  const { database, storage } = setup();
  storage.setItem(driveStorageKey('alice', 'trips'), '{broken');
  await assert.rejects(database.loadTrips('alice'), /preserved/);
  const exported = JSON.parse(await database.exportAccountData('alice'));
  assert.equal(exported.raw.localStorage.trips, '{broken');
  assert.deepEqual(exported.raw.indexedDB, { account: null, draft: null });
  storage.setItem(driveStorageKey('alice', 'trips'), JSON.stringify([trip('bob')]));
  await assert.rejects(database.loadTrips('alice'), /preserved/);
  assert.equal(storage.getItem(driveStorageKey('alice', 'trips')), JSON.stringify([trip('bob')]));
  await database.close();
});

test('migration cleanup never deletes a newer localStorage copy', async () => {
  const { database, storage } = setup();
  saveTrips('alice', [trip()], storage);
  const tripsKey = driveStorageKey('alice', 'trips');
  const updated = JSON.stringify([{ ...trip(), id: 'newer-in-old-tab' }]);
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const request = original.apply(this, args);
    storage.setItem(tripsKey, updated);
    return request;
  };
  try { assert.deepEqual(await database.loadTrips('alice'), [trip()]); }
  finally { IDBObjectStore.prototype.put = original; }
  assert.equal(storage.getItem(tripsKey), updated);
  await database.close();
});

test('queued writes snapshot input immediately, so later caller mutations cannot alter the durable result', async () => {
  const { database } = setup();
  const values = [trip()];
  const saving = database.saveTrips('alice', values);
  values[0].xp = 9999;
  values[0].points[0].position[0] = 0;
  await saving;
  assert.deepEqual(await database.loadTrips('alice'), [trip()]);
  await database.close();
});

test('a GPS draft write never reads or rewrites saved trip history after account initialization', async () => {
  const { database } = setup();
  await database.saveTrips('alice', Array.from({ length: 150 }, (_, index) => ({ ...trip(), id: `trip-${index}` })));
  const reads: string[] = [], writes: string[] = [];
  const originalGet = IDBObjectStore.prototype.get;
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.get = function (...args) {
    reads.push(this.name);
    return originalGet.apply(this, args);
  };
  IDBObjectStore.prototype.put = function (...args) {
    writes.push(this.name);
    return originalPut.apply(this, args);
  };
  try { await database.saveDraft('alice', draft()); }
  finally {
    IDBObjectStore.prototype.get = originalGet;
    IDBObjectStore.prototype.put = originalPut;
  }
  assert.deepEqual(reads, ['drafts']);
  assert.deepEqual(writes, ['drafts']);
  assert.equal((await database.loadTrips('alice')).length, 150);
  await database.close();
});

test('existing v1 IndexedDB records split atomically into archive and draft stores on first access', async () => {
  const { database, factory } = setup();
  await seedOldDatabase(factory, { version: 1, scope: 'alice', trips: [trip()], draft: draft() });
  assert.deepEqual(await database.loadTrips('alice'), [trip()]);
  assert.deepEqual(await database.loadDraft('alice'), draft());
  const exported = JSON.parse(await database.exportAccountData('alice'));
  assert.deepEqual(exported.raw.indexedDB.account, { version: 2, scope: 'alice', trips: [trip()] });
  assert.deepEqual(exported.raw.indexedDB.draft, { version: 1, scope: 'alice', draft: draft() });
  await database.close();
});

test('an aborted v1 split retains the full original account including its draft', async () => {
  const { database, factory } = setup();
  const originalRecord = { version: 1, scope: 'alice', trips: [trip()], draft: draft() };
  await seedOldDatabase(factory, originalRecord);
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'drafts') throw new DOMException('Quota exceeded', 'QuotaExceededError');
    return originalPut.apply(this, args);
  };
  try { await assert.rejects(database.loadTrips('alice'), /preserved/); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  const exported = JSON.parse(await database.exportAccountData('alice'));
  assert.deepEqual(exported.raw.indexedDB.account, originalRecord);
  assert.equal(exported.raw.indexedDB.draft, null);
  assert.deepEqual(await database.loadDraft('alice'), draft());
  await database.close();
});

test('corrupt v1 originals remain exportable and are never overwritten by migration', async () => {
  const { database, factory } = setup();
  const corrupt = { version: 1, scope: 'alice', trips: [trip()], draft: { broken: true } };
  await seedOldDatabase(factory, corrupt);
  await assert.rejects(database.loadDraft('alice'), /preserved/);
  await assert.rejects(database.saveDraft('alice', draft()), /preserved/);
  const exported = JSON.parse(await database.exportAccountData('alice'));
  assert.deepEqual(exported.raw.indexedDB.account, corrupt);
  assert.equal(exported.raw.indexedDB.draft, null);
  await database.close();
});

test('corrupt separate draft records are preserved and can be exported alongside a valid archive', async () => {
  const { database, factory } = setup();
  await database.saveTrips('alice', [trip()]);
  const corrupt = { version: 1, scope: 'alice', draft: 'broken' };
  await replaceRawRecord(factory, corrupt, 'drafts');
  await assert.rejects(database.loadDraft('alice'), /preserved/);
  await assert.rejects(database.saveDraft('alice', draft()), /preserved/);
  const exported = JSON.parse(await database.exportAccountData('alice'));
  assert.deepEqual(exported.raw.indexedDB.draft, corrupt);
  assert.deepEqual(await database.loadTrips('alice'), [trip()]);
  await database.close();
});
