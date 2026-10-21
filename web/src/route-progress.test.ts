import test from 'node:test';
import assert from 'node:assert/strict';
import { routeProgress } from './navigation';
import type { DrivingRoute } from './model';
const route: DrivingRoute = {
  coordinates: [[35, 32], [35.01, 32], [35.02, 32]], distance: 2000, duration: 200,
  steps: [
    { distance: 1000, name: '', instruction: 'Depart', maneuver: [35, 32], type: 'depart' },
    { distance: 1000, name: '', instruction: 'Continue', maneuver: [35.01, 32], type: 'turn' },
    { distance: 0, name: '', instruction: 'Arrive', maneuver: [35.02, 32], type: 'arrive' },
  ],
};
test('remaining distance follows route position and can increase when moving away', () => {
  const farther = routeProgress([35.005, 32], route)!;
  const closer = routeProgress([35.015, 32], route)!;
  assert.ok(farther.remaining > closer.remaining);
  assert.equal(closer.nextStep, 2);
  assert.equal(routeProgress([35.015, 32.02], route), null);
  assert.equal(routeProgress([35.02, 32], route)?.arrived, true);
});
