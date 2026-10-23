import test from 'node:test';
import assert from 'node:assert/strict';
import { canShare, canShareSavedDrive, retryDelay, uploadReady } from './sharing';
import type { Trip } from './model';

test('active sharing requires persisted opt-in and current live-map notice', () => {
  const profile = { community_opt_in: true, live_territory_consent_at: 'accepted', territory_detail_consent_at: 'accepted', open_territory_consent_at: 'accepted' };
  assert.equal(canShare(profile), true);
  assert.equal(canShare({ ...profile, community_opt_in: false }), false);
  assert.equal(canShare({ ...profile, territory_detail_consent_at: null }), false);
  assert.equal(canShare({ ...profile, open_territory_consent_at: null }), false);
  assert.equal(canShare(null), false);
});

test('queued drives cannot upload as another account or retry terminal failures', () => {
  const trip = { ownerId: 'alice', communityStatus: 'pending', retryAfter: 2000 } as Trip;
  assert.equal(uploadReady(trip, 'bob', 3000), false);
  assert.equal(uploadReady(trip, 'alice', 1000), false);
  assert.equal(uploadReady(trip, 'alice', 3000), true);
  assert.equal(uploadReady({ ...trip, communityStatus: 'failed' }, 'alice', 3000), false);
  assert.equal(uploadReady({ ...trip, ownerId: undefined }, 'alice', 3000), false);
  assert.ok(retryDelay(20) <= 300_000);
});

test('only a recent private drive from this account can be shared later', () => {
  const now = Date.parse('2026-10-23T04:00:00Z');
  const trip = { ownerId: 'alice', startedAt: now - 3_660_000, endedAt: now - 3_600_000,
    distanceMeters: 1000, points: [{}, {}] } as Trip;
  assert.equal(canShareSavedDrive(trip, 'alice', now), true);
  assert.equal(canShareSavedDrive(trip, 'bob', now), false);
  assert.equal(canShareSavedDrive({ ...trip, communityStatus: 'uploaded' }, 'alice', now), false);
  assert.equal(canShareSavedDrive({ ...trip, endedAt: now - 8 * 86400_000 }, 'alice', now), false);
  assert.equal(canShareSavedDrive({ ...trip, distanceMeters: 20 }, 'alice', now), false);
});
