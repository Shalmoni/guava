import assert from 'node:assert/strict';
import test from 'node:test';
import { shownAltitude, trustedGpsAltitude } from './altitude.ts';

test('unknown GPS altitude is not presented as zero', () => {
  assert.equal(trustedGpsAltitude(0, null), null);
  assert.equal(trustedGpsAltitude(0, 0), null);
  assert.equal(trustedGpsAltitude(0, 80), null);
  assert.equal(shownAltitude(null, null, 'harish'), null);
});

test('a current terrain sample can replace unknown GPS altitude', () => {
  const terrain = { grid: 'harish', meters: 101 };
  assert.equal(shownAltitude(null, terrain, 'harish'), 101);
  assert.equal(shownAltitude(null, terrain, 'elsewhere'), null);
});

test('a reliable sea-level GPS reading is allowed to show zero', () => {
  assert.equal(trustedGpsAltitude(0, 5), 0);
  assert.equal(shownAltitude(0, { grid: 'coast', meters: 12 }, 'coast'), 0);
});
