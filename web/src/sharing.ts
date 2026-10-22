import type { Trip } from './model';

export function canShare(profile: {
  community_opt_in: boolean;
  live_territory_consent_at: string | null;
  territory_detail_consent_at: string | null;
  open_territory_consent_at: string | null;
} | null): boolean {
  return Boolean(profile?.community_opt_in && profile.live_territory_consent_at
    && profile.territory_detail_consent_at && profile.open_territory_consent_at);
}

export function uploadReady(trip: Trip, ownerId: string, now: number): boolean {
  return ownerId !== 'local' && trip.ownerId === ownerId && trip.communityStatus === 'pending'
    && (!trip.retryAfter || trip.retryAfter <= now);
}

export function retryDelay(attempt: number): number {
  return Math.min(300_000, 15_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 5));
}
