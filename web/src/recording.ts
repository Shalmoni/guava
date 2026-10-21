import { distanceMeters, type DrivePoint } from './model';

export type ActiveDrive = {
  ownerId: string;
  id: string;
  startedAt: number;
  points: DrivePoint[];
  distance: number;
  height: number;
  altitudeAnchor: number | null;
  share: boolean;
  destination?: string;
};

const MAX_FIX_AGE_MS = 15_000;
const MAX_FUTURE_FIX_MS = 5_000;
const MAX_SEGMENT_GAP_MS = 30_000;
const MAX_SEGMENT_DISTANCE_METERS = 300;

export function isUsableDriveFix(sample: DrivePoint, now = Date.now()): boolean {
  return Array.isArray(sample.position) && sample.position.length === 2
    && sample.position.every(Number.isFinite)
    && Math.abs(sample.position[0]) <= 180 && Math.abs(sample.position[1]) <= 90
    && Number.isFinite(sample.timestamp) && sample.timestamp >= 0
    && sample.timestamp >= now - MAX_FIX_AGE_MS
    && sample.timestamp <= now + MAX_FUTURE_FIX_MS
    && sample.accuracy != null && Number.isFinite(sample.accuracy)
    && sample.accuracy >= 0 && sample.accuracy <= 50
    && (sample.altitude === null || Number.isFinite(sample.altitude))
    && (sample.segmentStart === undefined || typeof sample.segmentStart === 'boolean');
}

// Return the original drive for ignored fixes so callers only persist accepted
// changes. After a GPS gap, retain a fresh anchor and count subsequent movement;
// never invent the path or altitude change while recording was interrupted.
export function appendDriveFix(drive: ActiveDrive, sample: DrivePoint, now = Date.now()): ActiveDrive {
  if (!isUsableDriveFix(sample, now) || sample.timestamp < drive.startedAt) return drive;
  const previous = drive.points.at(-1);
  if (previous && sample.timestamp <= previous.timestamp) return drive;
  const elapsed = previous ? sample.timestamp - previous.timestamp : 0;
  const movement = previous ? distanceMeters(previous.position, sample.position) : 0;
  if (previous && !sample.segmentStart && movement > Math.max(150, elapsed / 1000 * 58)) return drive;
  const startsSegment = !previous || sample.segmentStart === true
    || elapsed > MAX_SEGMENT_GAP_MS || movement > MAX_SEGMENT_DISTANCE_METERS;
  if (!startsSegment && movement < 2) return drive;

  const accepted: DrivePoint = {
    ...sample,
    position: [sample.position[0], sample.position[1]],
    ...(startsSegment ? { segmentStart: true } : {}),
  };
  let height = drive.height;
  let altitudeAnchor = startsSegment ? sample.altitude : drive.altitudeAnchor;
  if (!startsSegment && sample.altitude != null) {
    if (altitudeAnchor == null) altitudeAnchor = sample.altitude;
    else if (Math.abs(sample.altitude - altitudeAnchor) >= 3) {
      height += Math.min(50, Math.abs(sample.altitude - altitudeAnchor));
      altitudeAnchor = sample.altitude;
    }
  }
  return {
    ...drive,
    points: [...drive.points, accepted],
    distance: drive.distance + (startsSegment ? 0 : movement),
    height,
    altitudeAnchor,
  };
}
