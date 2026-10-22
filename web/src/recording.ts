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
const MIN_MOTION_METERS = 20;
const AUTO_FINISH_IDLE_MS = 15 * 60_000;

export type MotionState = {
  driveId: string;
  anchor: DrivePoint;
  lastFix: DrivePoint;
  lastMovementAt: number;
};

function meaningfulMovement(from: DrivePoint, to: DrivePoint): number {
  const distance = distanceMeters(from.position, to.position);
  return distance >= Math.max(MIN_MOTION_METERS, (from.accuracy ?? 10) + (to.accuracy ?? 10)) ? distance : 0;
}

export function movingTimeMs(points: DrivePoint[]): number {
  let time = 0;
  let anchor: DrivePoint | null = null;
  for (const point of points) {
    if (!anchor || point.segmentStart || point.timestamp - anchor.timestamp > MAX_SEGMENT_GAP_MS) {
      anchor = point;
      continue;
    }
    const distance = meaningfulMovement(anchor, point);
    if (distance) {
      // A stop followed by one movement fix cannot turn the whole pause into drive time.
      time += Math.min(point.timestamp - anchor.timestamp, distance * 1000);
      anchor = point;
    }
  }
  return time;
}

export function startMotionState(driveId: string, fix: DrivePoint): MotionState {
  return { driveId, anchor: fix, lastFix: fix, lastMovementAt: fix.timestamp };
}

export function advanceMotionState(state: MotionState, fix: DrivePoint): MotionState {
  if (fix.timestamp <= state.lastFix.timestamp) return state;
  if (meaningfulMovement(state.anchor, fix)) {
    return { ...state, anchor: fix, lastFix: fix, lastMovementAt: fix.timestamp };
  }
  return { ...state, lastFix: fix };
}

export function stationaryDurationMs(drive: ActiveDrive, state: MotionState | null, now: number): number | null {
  if (!state || state.driveId !== drive.id || drive.distance < 50
    || now < state.lastFix.timestamp || now - state.lastFix.timestamp > 20_000
    || state.anchor.accuracy == null || state.anchor.accuracy > 20
    || state.lastFix.accuracy == null || state.lastFix.accuracy > 20
    || distanceMeters(state.anchor.position, state.lastFix.position) > MIN_MOTION_METERS) return null;
  return Math.max(0, now - state.lastMovementAt);
}

export function canAutoFinishDrive(drive: ActiveDrive, state: MotionState | null, now: number): boolean {
  return (stationaryDurationMs(drive, state, now) ?? 0) >= AUTO_FINISH_IDLE_MS;
}

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
