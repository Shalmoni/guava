import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedTerritory, israelRoundRemaining, territoryAge } from './territory';
import type { CloudRoad } from './cloud';

const road = (id: string, owner_id: string | null, contested = false): CloudRoad => ({
  id, owner_id, contested, length_m: 25, line: [[35, 32], [35.0001, 32.0001]],
  decided_on: '2026-10-19', captured_on: '2026-10-18', traversal_count: 1,
  unique_drivers: 1, top_score: null, your_score: null,
});

test('Israel round clock counts to local midnight, not UTC midnight', () => {
  assert.equal(israelRoundRemaining(Date.parse('2026-10-20T20:59:30Z')), '00:00:30');
  assert.equal(israelRoundRemaining(Date.parse('2026-10-20T21:00:00Z')), '24:00:00');
});

test('connected territory sums adjacent road cells of the same state only', () => {
  const roads = [road('h:0:0', 'me'), road('h:1:0', 'me'), road('h:2:0', 'other'), road('h:0:1', null, true)];
  assert.deepEqual(connectedTerritory(roads, 'h:0:0'), { cells: 2, meters: 50 });
  assert.deepEqual(connectedTerritory(roads, 'h:0:1'), { cells: 1, meters: 25 });
});

test('capture age uses Israel calendar days', () => {
  assert.equal(territoryAge('2026-10-18', Date.parse('2026-10-20T12:00:00Z')), '2 days ago');
});
