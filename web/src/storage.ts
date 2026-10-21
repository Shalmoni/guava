import { STORAGE_KEY, type DrivePoint, type Trip } from './model';
import type { ActiveDrive } from './recording';

export type DriveLocalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type LocalStorage = DriveLocalStorage;

export class LocalDriveStorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'LocalDriveStorageError';
  }
}

export function driveStorageKey(scope: string, kind: 'trips' | 'draft'): string {
  if (typeof scope !== 'string' || !scope.trim()) throw new LocalDriveStorageError('A drive account is required.');
  return `guava.web.v2.${scope === 'local' ? 'local' : `account.${encodeURIComponent(scope)}`}.${kind}`;
}
const key = driveStorageKey;

function perform<T>(action: 'load' | 'save' | 'remove', operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof LocalDriveStorageError) throw cause;
    throw new LocalDriveStorageError(
      action === 'load'
        ? 'Could not read drives saved in this browser. Existing data has been preserved.'
        : 'Could not save the drive on this device. Browser storage may be full or unavailable. Keep this page open and export your drives.',
      cause,
    );
  }
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function storedPoint(value: unknown): value is DrivePoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as DrivePoint;
  return Array.isArray(point.position) && point.position.length === 2
    && point.position.every(Number.isFinite)
    && Math.abs(point.position[0]) <= 180 && Math.abs(point.position[1]) <= 90
    && nonnegative(point.timestamp)
    && (point.altitude === null || typeof point.altitude === 'number' && Number.isFinite(point.altitude))
    && (point.accuracy === undefined || nonnegative(point.accuracy))
    && (point.segmentStart === undefined || typeof point.segmentStart === 'boolean');
}

function pointsValid(points: unknown): points is DrivePoint[] {
  return Array.isArray(points) && points.length > 0 && points.every(storedPoint)
    && points.every((point, index) => index === 0 || point.timestamp > points[index - 1].timestamp);
}

export function isOwnedTrip(value: unknown, scope: string): value is Trip {
  if (!value || typeof value !== 'object') return false;
  const trip = value as Trip;
  return trip.ownerId === scope && typeof trip.id === 'string' && Boolean(trip.id)
    && nonnegative(trip.startedAt) && nonnegative(trip.endedAt) && trip.endedAt >= trip.startedAt
    && pointsValid(trip.points) && trip.points[0].timestamp >= trip.startedAt
    && trip.points.at(-1)!.timestamp <= trip.endedAt
    && nonnegative(trip.distanceMeters) && nonnegative(trip.heightMeters)
    && nonnegative(trip.newRoadUnits) && nonnegative(trip.xp)
    && (trip.communityStatus === undefined || ['pending', 'uploaded', 'failed'].includes(trip.communityStatus))
    && (trip.communityError === undefined || typeof trip.communityError === 'string')
    && (trip.retryAfter === undefined || nonnegative(trip.retryAfter))
    && (trip.uploadAttempts === undefined || nonnegative(trip.uploadAttempts));
}

export function isOwnedDraft(value: unknown, scope: string): value is ActiveDrive {
  if (!value || typeof value !== 'object') return false;
  const draft = value as ActiveDrive;
  return draft.ownerId === scope && typeof draft.id === 'string' && Boolean(draft.id)
    && nonnegative(draft.startedAt) && pointsValid(draft.points)
    && draft.points[0].timestamp >= draft.startedAt
    && nonnegative(draft.distance) && nonnegative(draft.height)
    && (draft.altitudeAnchor === null || typeof draft.altitudeAnchor === 'number' && Number.isFinite(draft.altitudeAnchor))
    && typeof draft.share === 'boolean';
}

export function loadTrips(scope: string, storage?: LocalStorage): Trip[] {
  return perform('load', () => {
    const raw = (storage || localStorage).getItem(key(scope, 'trips'));
    if (raw === null) return [];
    const trips: unknown = JSON.parse(raw);
    if (!Array.isArray(trips) || !trips.every(trip => isOwnedTrip(trip, scope))) {
      throw new LocalDriveStorageError('Saved drives could not be read safely for this account. Existing data has been preserved.');
    }
    return trips;
  });
}

export function saveTrips(scope: string, trips: Trip[], storage?: LocalStorage): void {
  perform('save', () => {
    if (!trips.every(trip => isOwnedTrip(trip, scope))) {
      throw new LocalDriveStorageError('These drives do not belong to the active account or contain invalid data. Nothing was saved.');
    }
    // A UI which could not load corrupt data must not replace it with the empty
    // fallback it rendered. Require an explicit storage recovery first.
    loadTrips(scope, storage);
    // Do not silently evict older drives or queued uploads to fit a fixed count.
    (storage || localStorage).setItem(key(scope, 'trips'), JSON.stringify(trips));
  });
}

export function loadDraft(scope: string, storage?: LocalStorage): ActiveDrive | null {
  return perform('load', () => {
    const raw = (storage || localStorage).getItem(key(scope, 'draft'));
    if (raw === null) return null;
    const draft: unknown = JSON.parse(raw);
    if (!isOwnedDraft(draft, scope)) {
      throw new LocalDriveStorageError('The unfinished drive could not be read safely for this account. Existing data has been preserved.');
    }
    return draft;
  });
}

export function saveDraft(scope: string, draft: ActiveDrive | null, storage?: LocalStorage): void {
  perform(draft === null ? 'remove' : 'save', () => {
    const target = storage || localStorage;
    if (draft === null) { target.removeItem(key(scope, 'draft')); return; }
    if (!isOwnedDraft(draft, scope)) {
      throw new LocalDriveStorageError('This unfinished drive does not belong to the active account or contains invalid data. Nothing was saved.');
    }
    loadDraft(scope, target);
    target.setItem(key(scope, 'draft'), JSON.stringify(draft));
  });
}

// The pre-account key has no reliable owner. Keep its raw bytes available for an
// explicit export; never assign its queued uploads to the next signed-in user.
export function exportLegacyTrips(storage?: LocalStorage): string | null {
  return perform('load', () => (storage || localStorage).getItem(STORAGE_KEY));
}

export function hasLegacyTrips(storage?: LocalStorage): boolean {
  const raw = exportLegacyTrips(storage);
  return raw !== null && raw.trim() !== '' && raw.trim() !== '[]';
}

// Export the original strings, including malformed JSON, so recovery never
// depends on successfully parsing the data which caused the error.
export function exportAccountData(scope: string, storage?: LocalStorage): string {
  return perform('load', () => {
    const target = storage || localStorage;
    return JSON.stringify({
      format: 'guava-local-recovery',
      version: 1,
      ownerId: scope,
      exportedAt: new Date().toISOString(),
      raw: {
        trips: target.getItem(key(scope, 'trips')),
        draft: target.getItem(key(scope, 'draft')),
      },
    }, null, 2);
  });
}
