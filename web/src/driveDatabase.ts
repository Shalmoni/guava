import type { Trip } from './model';
import type { ActiveDrive } from './recording';
import {
  driveStorageKey, isOwnedDraft, isOwnedTrip, LocalDriveStorageError,
  type DriveLocalStorage,
} from './storage';

type AccountRecord = { version: 1; scope: string; trips: Trip[]; draft: ActiveDrive | null };
type TripArchive = { version: 2; scope: string; trips: Trip[] };
type DraftRecord = { version: 1; scope: string; draft: ActiveDrive | null };
type LegacySnapshot = { storage: DriveLocalStorage | null; trips: string | null; draft: string | null };
type DatabaseOptions = {
  indexedDB?: IDBFactory;
  localStorage?: DriveLocalStorage | null;
  databaseName?: string;
};

function checkedRecord(value: unknown, scope: string): AccountRecord {
  const record = value as Partial<AccountRecord> | null;
  if (!record || record.version !== 1 || record.scope !== scope
    || !Array.isArray(record.trips) || !record.trips.every(trip => isOwnedTrip(trip, scope))
    || (record.draft !== null && !isOwnedDraft(record.draft, scope))) {
    throw new LocalDriveStorageError('Saved drives could not be read safely for this account. Existing data has been preserved; export recovery data before proceeding.');
  }
  return record as AccountRecord;
}

function checkedArchive(value: unknown, scope: string): TripArchive {
  const archive = value as Partial<TripArchive> | null;
  if (!archive || archive.version !== 2 || archive.scope !== scope
    || !Array.isArray(archive.trips) || !archive.trips.every(trip => isOwnedTrip(trip, scope))) {
    throw new LocalDriveStorageError('Saved drives could not be read safely for this account. Existing data has been preserved; export recovery data before proceeding.');
  }
  return archive as TripArchive;
}

function checkedDraft(value: unknown, scope: string): DraftRecord {
  const record = value as Partial<DraftRecord> | null;
  if (!record || record.version !== 1 || record.scope !== scope
    || (record.draft !== null && !isOwnedDraft(record.draft, scope))) {
    throw new LocalDriveStorageError('The unfinished drive could not be read safely for this account. Existing data has been preserved; export recovery data before proceeding.');
  }
  return record as DraftRecord;
}

function storageFailure(cause: unknown): LocalDriveStorageError {
  return cause instanceof LocalDriveStorageError ? cause : new LocalDriveStorageError(
    'Could not access drive storage on this device. Keep this page open and export your drives; existing saved data has been preserved.',
    cause,
  );
}

// Exported factory permits isolated transaction tests without browser globals.
// The normal application uses the module-level instance below.
export function createDriveDatabase(options: DatabaseOptions = {}) {
  let connection: Promise<IDBDatabase> | null = null;
  const initialized = new Map<string, Promise<void>>();
  const databaseName = options.databaseName || 'guava-drives-v1';

  function open(): Promise<IDBDatabase> {
    if (connection) return connection;
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = options.indexedDB || globalThis.indexedDB;
      if (!factory) {
        reject(new LocalDriveStorageError('This browser cannot open drive storage. Keep this page open and export any unsaved drive.'));
        return;
      }
      const request = factory.open(databaseName, 2);
      let settled = false;
      const fail = (cause: unknown) => {
        settled = true;
        connection = null;
        reject(storageFailure(cause));
      };
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('accounts')) {
          request.result.createObjectStore('accounts', { keyPath: 'scope' });
        }
        if (!request.result.objectStoreNames.contains('drafts')) {
          request.result.createObjectStore('drafts', { keyPath: 'scope' });
        }
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new LocalDriveStorageError('Close other Guava tabs so drive storage can finish opening.'));
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        settled = true;
        db.onversionchange = () => { db.close(); connection = null; initialized.clear(); };
        resolve(db);
      };
    }).catch(cause => { connection = null; throw storageFailure(cause); });
    return connection;
  }

  function legacySnapshot(scope: string): LegacySnapshot {
    // Only scoped v2 keys can migrate. The global v1 key is deliberately absent.
    const storage = options.localStorage === null ? null : options.localStorage || globalThis.localStorage || null;
    return {
      storage,
      trips: storage?.getItem(driveStorageKey(scope, 'trips')) ?? null,
      draft: storage?.getItem(driveStorageKey(scope, 'draft')) ?? null,
    };
  }

  function migratedRecord(scope: string, snapshot: LegacySnapshot): AccountRecord {
    return checkedRecord({
      version: 1,
      scope,
      trips: snapshot.trips === null ? [] : JSON.parse(snapshot.trips),
      draft: snapshot.draft === null ? null : JSON.parse(snapshot.draft),
    }, scope);
  }

  function removeMigratedCopy(scope: string, snapshot: LegacySnapshot): void {
    if (!snapshot.storage) return;
    // Cleanup runs only after transaction completion. Do not remove a legacy
    // copy another tab changed after we read it; leaving a duplicate is safe.
    try {
      for (const kind of ['trips', 'draft'] as const) {
        const key = driveStorageKey(scope, kind);
        if (snapshot[kind] !== null && snapshot.storage.getItem(key) === snapshot[kind]) {
          snapshot.storage.removeItem(key);
        }
      }
    } catch { /* The IndexedDB copy is durable; retain any inaccessible backup. */ }
  }

  function initialize(scope: string): Promise<void> {
    const existing = initialized.get(scope);
    if (existing) return existing;
    const pending = initializeAccount(scope).catch(cause => {
      initialized.delete(scope);
      throw cause;
    });
    initialized.set(scope, pending);
    return pending;
  }

  async function initializeAccount(scope: string): Promise<void> {
    try {
      driveStorageKey(scope, 'trips'); // Validate identity before opening storage.
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(['accounts', 'drafts'], 'readwrite');
        const store = transaction.objectStore('accounts');
        let failure: unknown;
        let migration: LegacySnapshot | null = null;
        transaction.oncomplete = () => {
          if (migration) removeMigratedCopy(scope, migration);
          resolve();
        };
        transaction.onabort = () => reject(storageFailure(failure || transaction.error));
        transaction.onerror = () => { failure ||= transaction.error; };
        const request = store.get(scope);
        request.onsuccess = () => {
          try {
            if (request.result?.version === 2) {
              checkedArchive(request.result, scope);
              return;
            }
            let record: AccountRecord;
            if (request.result === undefined) {
              migration = legacySnapshot(scope);
              record = migratedRecord(scope, migration);
            } else record = checkedRecord(request.result, scope);
            // Convert a valid v1 account atomically. Invalid originals are never
            // overwritten; export can read them without running this migration.
            store.put({ version: 2, scope, trips: record.trips } satisfies TripArchive);
            transaction.objectStore('drafts').put({
              version: 1, scope, draft: record.draft,
            } satisfies DraftRecord);
          } catch (cause) {
            failure = cause;
            transaction.abort();
          }
        };
      });
    } catch (cause) { throw storageFailure(cause); }
  }

  async function fieldTransaction<TRecord, TResult>(
    scope: string,
    storeName: 'accounts' | 'drafts',
    validate: (value: unknown, scope: string) => TRecord,
    operation: (record: TRecord) => { record?: TRecord; result: TResult },
  ): Promise<TResult> {
    try {
      await initialize(scope);
      const db = await open();
      return await new Promise<TResult>((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        let result: TResult;
        let failure: unknown;
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(storageFailure(failure || transaction.error));
        transaction.onerror = () => { failure ||= transaction.error; };
        const request = store.get(scope);
        request.onsuccess = () => {
          try {
            const update = operation(validate(request.result, scope));
            result = update.result;
            if (update.record) store.put(validate(update.record, scope));
          } catch (cause) {
            failure = cause;
            transaction.abort();
          }
        };
      });
    } catch (cause) { throw storageFailure(cause); }
  }

  async function loadTrips(scope: string): Promise<Trip[]> {
    return fieldTransaction(scope, 'accounts', checkedArchive, record => ({ result: record.trips }));
  }

  async function saveTrips(scope: string, trips: Trip[]): Promise<void> {
    if (!trips.every(trip => isOwnedTrip(trip, scope))) {
      throw new LocalDriveStorageError('These drives do not belong to the active account or contain invalid data. Nothing was saved.');
    }
    // Snapshot the caller's value immediately; later state mutation cannot
    // change what this queued transaction commits.
    const snapshot = structuredClone(trips);
    await fieldTransaction(scope, 'accounts', checkedArchive, record => ({ record: { ...record, trips: snapshot }, result: undefined }));
  }

  async function loadDraft(scope: string): Promise<ActiveDrive | null> {
    return fieldTransaction(scope, 'drafts', checkedDraft, record => ({ result: record.draft }));
  }

  async function saveDraft(scope: string, draft: ActiveDrive | null): Promise<void> {
    if (draft !== null && !isOwnedDraft(draft, scope)) {
      throw new LocalDriveStorageError('This unfinished drive does not belong to the active account or contains invalid data. Nothing was saved.');
    }
    const snapshot = structuredClone(draft);
    // No trip history is read, cloned, validated, or rewritten for a GPS fix.
    await fieldTransaction(scope, 'drafts', checkedDraft, record => ({ record: { ...record, draft: snapshot }, result: undefined }));
  }

  async function exportAccountData(scope: string): Promise<string> {
    try {
      driveStorageKey(scope, 'trips');
      const db = await open();
      const rawRecords: unknown = await new Promise((resolve, reject) => {
        const transaction = db.transaction(['accounts', 'drafts'], 'readonly');
        const account = transaction.objectStore('accounts').get(scope);
        const draft = transaction.objectStore('drafts').get(scope);
        transaction.oncomplete = () => resolve({ account: account.result ?? null, draft: draft.result ?? null });
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => { /* abort supplies the final error */ };
      });
      const legacy = legacySnapshot(scope);
      return JSON.stringify({
        format: 'guava-local-recovery', version: 3, ownerId: scope,
        exportedAt: new Date().toISOString(),
        raw: { indexedDB: rawRecords, localStorage: { trips: legacy.trips, draft: legacy.draft } },
      }, null, 2);
    } catch (cause) { throw storageFailure(cause); }
  }

  async function close(): Promise<void> {
    const current = connection;
    connection = null;
    initialized.clear();
    if (current) (await current).close();
  }

  return { loadTrips, saveTrips, loadDraft, saveDraft, exportAccountData, close };
}

const database = createDriveDatabase();
export const { loadTrips, saveTrips, loadDraft, saveDraft, exportAccountData } = database;
