import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedTerritory, israelRoundRemaining, territoryAge } from './territory';
import type { CloudRoad } from './cloud';
import { cloudTerritoryLayers } from './territoryLayers';

const road = (id: string, owner_id: string | null, contested = false): CloudRoad => ({
  id, owner_id, contested, length_m: 25, line: [[35, 32], [35.0001, 32.0001]],
  decided_on: '2026-10-19', captured_on: '2026-10-18', traversal_count: 1,
  unique_drivers: 1, active_contest: contested, vote_round_date: null,
  player_count: null, top_score: null, your_score: null,
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

test('a one-driver live contest paints as up for grabs beside captured roads', () => {
  const active = { ...road('h:3:0', null, true), active_contest: true, vote_round_date: '2026-10-20', player_count: 1, top_score: 1, your_score: 1 };
  const layers = cloudTerritoryLayers({
    roads: [road('h:0:0', 'me'), road('h:1:0', 'other'), active],
    profiles: [{ user_id: 'me', display_name: 'Me', community_opt_in: true, live_territory_consent_at: 'yes', territory_detail_consent_at: 'yes', open_territory_consent_at: 'yes' },
      { user_id: 'other', display_name: 'Other', community_opt_in: true, live_territory_consent_at: 'yes', territory_detail_consent_at: 'yes', open_territory_consent_at: 'yes' }],
    scores: [], drives: [],
  }, 'me');
  assert.deepEqual(layers.me.unitIds, ['h:0:0']);
  assert.deepEqual(layers.other.unitIds, ['h:1:0']);
  assert.deepEqual(layers.contested.unitIds, ['h:3:0']);
});

test('capture age uses Israel calendar days', () => {
  assert.equal(territoryAge('2026-10-18', Date.parse('2026-10-20T12:00:00Z')), '2 days ago');
});
