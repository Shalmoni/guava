import assert from 'node:assert/strict';
import test from 'node:test';
import { finishTrip, routeFromOSRM, tripUnits, type DrivePoint } from './model.ts';

const samples: DrivePoint[] = [
  { position: [35.0435, 32.46096], altitude: 100, timestamp: 1_000 },
  { position: [35.0445, 32.46196], altitude: 112, timestamp: 11_000 },
];

test('a stationary or under-50-metre drive earns nothing', () => {
  assert.equal(finishTrip(samples, 1_000, 49, 12, []), null);
  assert.equal(finishTrip(samples.slice(0, 1), 1_000, 100, 12, []), null);
});

test('a qualifying drive earns the declared local XP formula', () => {
  const trip = finishTrip(samples, 1_000, 1_500, 40, []);
  assert.ok(trip);
  assert.equal(trip.xp, 10 + 12 + 2 + trip.newRoadUnits * 2);
  assert.ok(tripUnits(trip.points).size > 0);
  const repeat = finishTrip(samples, 2_000, 1_500, 40, [trip]);
  assert.equal(repeat?.newRoadUnits, 0);
});

test('route parser rejects missing routes instead of showing a fake line', () => {
  assert.throws(() => routeFromOSRM({ code: 'NoRoute', routes: [] }), /No driving route/);
});
