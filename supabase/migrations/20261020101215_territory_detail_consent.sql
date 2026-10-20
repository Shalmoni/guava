-- New live contest and tied-road visibility requires a fresh opt-in.
-- Existing account/game data is preserved, but future shared drives must be re-consented.
alter table public.guava_profiles add column territory_detail_consent_at timestamptz;
grant update (territory_detail_consent_at) on public.guava_profiles to authenticated;
