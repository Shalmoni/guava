import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceMotionState, appendDriveFix, canAutoFinishDrive, isUsableDriveFix, movingTimeMs, startMotionState, type ActiveDrive } from './recording';
import { distanceMeters, drivePointSegments, finishTrip, roadUnit, tripUnits, type DrivePoint } from './model';

const startTime = 1_700_000_000_000;
function fix(longitude: number, seconds: number, altitude: number | null = 100): DrivePoint {
  return { position: [longitude, 32.461], timestamp: startTime + seconds * 1000, altitude, accuracy: 5 };
}
function drive(): ActiveDrive {
  return {
    ownerId: 'alice', id: 'drive-a', startedAt: startTime, points: [fix(35.043, 0)],
    distance: 0, height: 0, altitudeAnchor: 100, share: true,
  };
}
function append(current: ActiveDrive, sample: DrivePoint): ActiveDrive {
  return appendDriveFix(current, sample, sample.timestamp);
}

test('recording recovers after a >300 m gap without crediting or drawing the missing stretch', () => {
  const first = append(drive(), fix(35.044, 30));
  const afterGap = append(first, fix(35.049, 60));
  const resumed = append(afterGap, fix(35.050, 90));
  assert.equal(afterGap.points.length, 3);
  assert.equal(afterGap.points.at(-1)?.segmentStart, true);
  assert.equal(afterGap.distance, first.distance);
  assert.ok(Math.abs(resumed.distance - first.distance * 2) < 0.01);
  assert.deepEqual(drivePointSegments(resumed.points).map(segment => segment.length), [2, 2]);
  assert.equal(tripUnits(resumed.points).has(roadUnit([35.047, 32.461])), false);
});

test('moving time excludes a long parked interval and GPS jitter', () => {
  const at = (metres: number, seconds: number) => fix(35.043 + metres / 94_100, seconds);
  const points = [at(0, 0), at(30, 10), at(33, 20), at(27, 30), at(31, 40), at(29, 50), at(32, 600), at(62, 610)];
  assert.equal(movingTimeMs(points), 20_000);
  assert.equal(movingTimeMs([at(0, 0), at(30, 10), { ...at(500, 610), segmentStart: true }, at(530, 620)]), 20_000);
});

test('a parked drive auto-finishes only after 15 minutes of fresh, accurate GPS', () => {
  const at = (metres: number, seconds: number) => fix(35.043 + metres / 94_100, seconds);
  const active = { ...drive(), distance: 60 };
  const moved = advanceMotionState(startMotionState(active.id, at(0, 0)), at(30, 10));
  const parked = advanceMotionState(moved, at(32, 910));
  assert.equal(canAutoFinishDrive(active, parked, startTime + 910_000), true);
  assert.equal(canAutoFinishDrive(active, moved, startTime + 910_000), false);
  assert.equal(canAutoFinishDrive({ ...active, distance: 40 }, parked, startTime + 910_000), false);
  assert.equal(canAutoFinishDrive(active, advanceMotionState(moved, { ...at(32, 910), accuracy: 30 }), startTime + 910_000), false);
  assert.equal(canAutoFinishDrive(active, advanceMotionState(parked, at(62, 911)), startTime + 911_000), false);
});

test('a long GPS pause starts a new segment even if its endpoints are close', () => {
  const sample = fix(35.0431, 31);
  const updated = append(drive(), sample);
  assert.equal(updated.distance, 0);
  assert.equal(updated.points.at(-1)?.segmentStart, true);
  const continuing = append(updated, fix(35.0432, 32));
  assert.ok(continuing.distance > 9 && continuing.distance < 10);
});

test('an explicit resume starts a segment without counting movement or altitude while absent', () => {
  const resumed = append(drive(), { ...fix(35.1, 10, 500), segmentStart: true });
  assert.equal(resumed.distance, 0);
  assert.equal(resumed.height, 0);
  assert.equal(resumed.altitudeAnchor, 500);
  assert.equal(resumed.points.at(-1)?.segmentStart, true);
  const next = append(resumed, fix(35.1001, 11, 506));
  assert.equal(next.height, 6);
  assert.ok(next.distance > 9);
});

test('altitude differences across a detected gap do not count as traveled height', () => {
  const first = append(drive(), fix(35.044, 20, 110));
  const afterGap = append(first, fix(35.049, 40, 300));
  const resumed = append(afterGap, fix(35.050, 60, 306));
  assert.equal(first.height, 10);
  assert.equal(afterGap.height, 10);
  assert.equal(afterGap.altitudeAnchor, 300);
  assert.equal(resumed.height, 16);
});

test('invalid, stale, out-of-order and implausible fixes never change the accepted anchor', () => {
  const original = drive();
  const valid = fix(35.0431, 1);
  const invalid: DrivePoint[] = [
    { ...valid, accuracy: 51 }, { ...valid, accuracy: -1 }, { ...valid, accuracy: undefined },
    { ...valid, position: [NaN, 32] }, { ...valid, position: [35, 91] },
    { ...valid, altitude: NaN }, { ...valid, timestamp: NaN },
    { ...valid, timestamp: startTime }, { ...valid, timestamp: startTime - 1 },
    fix(35.2, 1),
  ];
  for (const sample of invalid) {
    assert.equal(appendDriveFix(original, sample, valid.timestamp), original);
  }
  assert.equal(appendDriveFix(original, valid, valid.timestamp + 15_001), original);
  assert.equal(appendDriveFix(original, valid, valid.timestamp - 5_001), original);
  assert.ok(isUsableDriveFix(valid, valid.timestamp));
});

test('a rejected GPS jump does not prevent later valid samples from recording', () => {
  const original = drive();
  assert.equal(append(original, fix(35.2, 1)), original);
  const accepted = append(original, fix(35.0431, 2));
  assert.equal(accepted.points.length, 2);
  assert.ok(accepted.distance > 9);
});

test('accepted coordinates do not share mutable arrays with the incoming GPS sample', () => {
  const sample = fix(35.0431, 1);
  const accepted = append(drive(), sample);
  sample.position[0] = 0;
  assert.equal(accepted.points.at(-1)?.position[0], 35.0431);
});

test('segmented local exploration equals the union of observed stretches only', () => {
  const first = [fix(35.043, 0), fix(35.044, 10)];
  const second = [{ ...fix(35.1, 100), segmentStart: true }, fix(35.101, 110)];
  const expected = new Set([...tripUnits(first), ...tripUnits(second)]);
  assert.deepEqual(tripUnits([...first, ...second]), expected);
});

test('a recovered trip keeps ownership and ends at the last recorded time', () => {
  const points = [fix(35.043, 0), fix(35.044, 10)];
  const trip = finishTrip(points, startTime, distanceMeters(points[0].position, points[1].position),
    0, [], 'Home', 'drive-a', 'alice', points[1].timestamp);
  assert.ok(trip);
  assert.equal(trip.ownerId, 'alice');
  assert.equal(trip.endedAt, startTime + 10_000);
});
