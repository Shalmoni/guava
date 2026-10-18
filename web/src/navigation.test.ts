import assert from 'node:assert/strict';
import test from 'node:test';
import { snapToRoute, traversedRoute } from './navigation';
import type { Point } from './model';

const eastRoad: Point[] = [[35, 32], [35.001, 32], [35.002, 32]];

test('active planned-drive arrow snaps visually to the road centerline', () => {
  const snap = snapToRoute([35.0005, 32.0001], eastRoad);
  assert.ok(snap);
  assert.ok(Math.abs(snap.point[1] - 32) < 0.000001);
  assert.ok(Math.abs(snap.bearing - 90) < 0.001);
  assert.equal(snap.segmentIndex, 0);
});

test('do not fake road position when the driver is off route', () => {
  assert.equal(snapToRoute([35.0005, 32.001], eastRoad), null);
});

test('driven part of the planned route stops at the arrow', () => {
  const snap = snapToRoute([35.0015, 32.0001], eastRoad);
  assert.ok(snap);
  const past = traversedRoute(eastRoad, snap);
  assert.equal(past.length, 3);
  assert.deepEqual(past[0], eastRoad[0]);
  assert.ok(past[2][0] > 35.001 && past[2][0] < 35.002);
});
