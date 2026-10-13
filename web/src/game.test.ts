import assert from 'node:assert/strict';
import test from 'node:test';
import { settleDailyRound, settleRound, territoryScores, type RoadVisit } from './game.ts';

test('one driver wins a completed road-unit round', () => {
  const visits: RoadVisit[] = [
    { unitId: 'a', driverId: 'you', driveId: '1' },
    { unitId: 'a', driverId: 'you', driveId: '2' },
    { unitId: 'a', driverId: 'maya', driveId: '3' },
  ];
  assert.equal(settleRound(new Map(), visits).owners.get('a'), 'you');
});

test('one drive cannot inflate its count by crossing repeatedly', () => {
  const visits: RoadVisit[] = [
    { unitId: 'a', driverId: 'you', driveId: '1' },
    { unitId: 'a', driverId: 'you', driveId: '1' },
    { unitId: 'a', driverId: 'maya', driveId: '2' },
  ];
  assert.equal(settleRound(new Map(), visits).owners.get('a'), null);
});

test('tie clears owner; untouched roads retain prior owner', () => {
  const previous = new Map([['a', 'you'], ['b', 'maya']] as const);
  const result = settleRound(new Map(previous), [
    { unitId: 'a', driverId: 'you', driveId: '1' },
    { unitId: 'a', driverId: 'noam', driveId: '2' },
  ]);
  assert.equal(result.owners.get('a'), null);
  assert.equal(result.owners.get('b'), 'maya');
  assert.equal(territoryScores(result.owners).maya, 25);
});

test('next day can transfer a road', () => {
  const dayOne = settleRound(new Map(), [{ unitId: 'a', driverId: 'you', driveId: '1' }]);
  const dayTwo = settleRound(dayOne.owners, [{ unitId: 'a', driverId: 'noam', driveId: '2' }]);
  assert.equal(dayTwo.owners.get('a'), 'noam');
});

test('daily round cannot settle before the 00:05 UTC job', () => {
  const start = Date.UTC(2026, 9, 13);
  assert.throws(() => settleDailyRound(new Map(), [], start, start + 86_400_000), /00:05 UTC/);
  assert.doesNotThrow(() => settleDailyRound(new Map(), [], start, start + 86_400_000 + 300_000));
  assert.throws(() => settleDailyRound(new Map(), [], start + 1, start + 86_400_000 + 300_000), /00:00 UTC/);
});
