import assert from 'node:assert/strict';
import test from 'node:test';
import { STORAGE_KEY, type Trip } from './model';
import type { ActiveDrive } from './recording';
import { exportAccountData, exportLegacyTrips, hasLegacyTrips, loadDraft, loadTrips, LocalDriveStorageError, saveDraft, saveTrips } from './storage';

class MemoryStorage {
  values = new Map<string, string>();
  failWrites = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    this.values.set(key, value);
  }
  removeItem(key: string) {
    if (this.failWrites) throw new Error('Storage unavailable');
    this.values.delete(key);
  }
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

test('account trips, upload queue metadata and unfinished drives round trip independently', () => {
  const storage = new MemoryStorage();
  saveTrips('alice', [trip()], storage);
  saveDraft('alice', draft(), storage);
  assert.deepEqual(loadTrips('alice', storage), [trip()]);
  assert.deepEqual(loadDraft('alice', storage), draft());
  assert.deepEqual(loadTrips('bob', storage), []);
  assert.equal(loadDraft('bob', storage), null);
});

test('anonymous local storage is distinct from each signed-in account', () => {
  const storage = new MemoryStorage();
  saveTrips('local', [trip('local')], storage);
  saveDraft('local', draft('local'), storage);
  saveTrips('alice', [trip()], storage);
  assert.equal(loadTrips('local', storage)[0].ownerId, 'local');
  assert.equal(loadTrips('alice', storage)[0].ownerId, 'alice');
  assert.equal(loadDraft('alice', storage), null);
  assert.equal(loadDraft('local', storage)?.ownerId, 'local');
});

test('unowned legacy queued drives remain exportable and never enter an account queue', () => {
  const storage = new MemoryStorage();
  const legacy = { ...trip(), ownerId: undefined, communityStatus: 'pending' };
  const raw = JSON.stringify([legacy]);
  storage.setItem(STORAGE_KEY, raw);
  assert.equal(hasLegacyTrips(storage), true);
  assert.equal(exportLegacyTrips(storage), raw);
  assert.deepEqual(loadTrips('alice', storage), []);
  assert.deepEqual(loadTrips('local', storage), []);
  assert.equal(loadDraft('alice', storage), null);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.throws(() => saveTrips('alice', [legacy as Trip], storage), LocalDriveStorageError);
});

test('cross-account writes and data copied under the wrong account key are rejected', () => {
  const storage = new MemoryStorage();
  assert.throws(() => saveTrips('bob', [trip()], storage), /do not belong/);
  assert.throws(() => saveDraft('bob', draft(), storage), /does not belong/);
  saveTrips('alice', [trip()], storage);
  const [aliceKey] = storage.values.keys();
  const bobKey = aliceKey.replace('account.alice', 'account.bob');
  storage.setItem(bobKey, storage.getItem(aliceKey)!);
  assert.throws(() => loadTrips('bob', storage), /preserved/);
  assert.deepEqual(loadTrips('alice', storage), [trip()]);
});

test('quota failure leaves the prior durable draft and trips intact and reports failure', () => {
  const storage = new MemoryStorage();
  saveDraft('alice', draft(), storage);
  saveTrips('alice', [trip()], storage);
  storage.failWrites = true;
  assert.throws(() => saveDraft('alice', { ...draft(), distance: 200 }, storage), /Keep this page open/);
  assert.throws(() => saveTrips('alice', [{ ...trip(), id: 'trip-b' }, trip()], storage), /Keep this page open/);
  assert.equal(loadDraft('alice', storage)?.distance, 94);
  assert.equal(loadTrips('alice', storage).length, 1);
  assert.throws(() => saveDraft('alice', null, storage), LocalDriveStorageError);
  assert.ok(loadDraft('alice', storage));
});

test('corrupt storage reports the problem without silently clearing or replacing it', () => {
  const storage = new MemoryStorage();
  saveDraft('alice', draft(), storage);
  const [draftKey] = storage.values.keys();
  storage.setItem(draftKey, '{broken');
  assert.throws(() => loadDraft('alice', storage), /preserved/);
  assert.throws(() => saveDraft('alice', draft(), storage), /preserved/);
  assert.equal(storage.getItem(draftKey), '{broken');
  storage.setItem(STORAGE_KEY, '{legacy also broken');
  assert.equal(exportLegacyTrips(storage), '{legacy also broken');
});

test('new saves cannot overwrite an unreadable trip archive with an empty fallback', () => {
  const storage = new MemoryStorage();
  saveTrips('alice', [trip()], storage);
  const [tripsKey] = storage.values.keys();
  storage.setItem(tripsKey, '{broken');
  assert.throws(() => loadTrips('alice', storage), /preserved/);
  assert.throws(() => saveTrips('alice', [], storage), /preserved/);
  assert.throws(() => saveTrips('alice', [trip()], storage), /preserved/);
  assert.equal(storage.getItem(tripsKey), '{broken');
  const exported = JSON.parse(exportAccountData('alice', storage));
  assert.equal(exported.raw.trips, '{broken');
  assert.equal(exported.ownerId, 'alice');
  assert.equal(exported.raw.draft, null);
});

test('raw recovery export includes only the selected account and retains exact source strings', () => {
  const storage = new MemoryStorage();
  saveTrips('alice', [trip()], storage);
  saveDraft('alice', draft(), storage);
  saveTrips('bob', [trip('bob')], storage);
  const exported = JSON.parse(exportAccountData('alice', storage));
  assert.deepEqual(JSON.parse(exported.raw.trips), [trip()]);
  assert.deepEqual(JSON.parse(exported.raw.draft), draft());
  assert.equal(exported.raw.trips.includes('bob'), false);
});

test('saving more than 100 trips does not silently discard old drives or pending uploads', () => {
  const storage = new MemoryStorage();
  const trips = Array.from({ length: 101 }, (_, index) => ({ ...trip(), id: `trip-${index}` }));
  saveTrips('alice', trips, storage);
  assert.equal(loadTrips('alice', storage).length, 101);
});

test('drafts reject invalid coordinates and nonincreasing timestamps before persisting', () => {
  const storage = new MemoryStorage();
  const invalid = draft();
  invalid.points[1] = { ...invalid.points[1], timestamp: invalid.points[0].timestamp };
  assert.throws(() => saveDraft('alice', invalid, storage), /invalid data/);
  assert.equal(loadDraft('alice', storage), null);
  invalid.points[1] = { ...invalid.points[1], timestamp: 11_000, position: [Infinity, 32] };
  assert.throws(() => saveDraft('alice', invalid, storage), /invalid data/);
});

test('clearing one account draft preserves other accounts and legacy exports', () => {
  const storage = new MemoryStorage();
  saveDraft('alice', draft(), storage);
  saveDraft('bob', draft('bob'), storage);
  storage.setItem(STORAGE_KEY, 'legacy export');
  saveDraft('alice', null, storage);
  assert.equal(loadDraft('alice', storage), null);
  assert.deepEqual(loadDraft('bob', storage), draft('bob'));
  assert.equal(exportLegacyTrips(storage), 'legacy export');
});
