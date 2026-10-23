import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudRankings } from './leaderboard';
import type { CloudGame } from './cloud';

test('community players appear at zero before they save a drive', () => {
  const game: CloudGame = {
    profiles: [
      { user_id: 'me', display_name: 'Mango', community_opt_in: true, live_territory_consent_at: null, territory_detail_consent_at: null, open_territory_consent_at: null },
      { user_id: 'other', display_name: 'Banana', community_opt_in: true, live_territory_consent_at: null, territory_detail_consent_at: null, open_territory_consent_at: null },
      { user_id: 'private', display_name: 'Hidden', community_opt_in: false, live_territory_consent_at: null, territory_detail_consent_at: null, open_territory_consent_at: null },
    ],
    scores: [{ user_id: 'other', xp: 20, distance_m: 1000, height_m: 10, territory_m: 0, drive_count: 1 }],
    roads: [], drives: [],
  };
  assert.deepEqual(cloudRankings(game, 'XP', 'me').map(({ name, value }) => [name, value]), [['Banana', 20], ['You', 0]]);
  assert.deepEqual(cloudRankings(game, 'Territory', 'me').map(({ name, value }) => [name, value]), [['Banana', 0], ['You', 0]]);
});
