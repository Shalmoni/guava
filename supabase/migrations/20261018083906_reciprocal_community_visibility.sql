-- Community visibility is reciprocal: private drivers can see their own
-- account and scores, but not other players' aliases, scores, roads, or round.
-- The helper avoids a recursive RLS check on guava_profiles.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create function private.guava_is_participant()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.guava_profiles p
    where p.user_id = (select auth.uid()) and p.community_opt_in
  );
$$;
revoke all on function private.guava_is_participant() from public, anon, authenticated;
grant execute on function private.guava_is_participant() to authenticated;

drop policy "Read own or participating aliases" on public.guava_profiles;
create policy "Read own or reciprocal participating aliases"
on public.guava_profiles for select to authenticated
using (
  user_id = (select auth.uid())
  or (community_opt_in and (select private.guava_is_participant()))
);

drop policy "Participating scores or own" on public.guava_game_scores;
create policy "Reciprocal participating scores or own"
on public.guava_game_scores for select to authenticated
using (
  user_id = (select auth.uid())
  or ((select private.guava_is_participant()) and exists (
    select 1 from public.guava_profiles p
    where p.user_id = guava_game_scores.user_id and p.community_opt_in
  ))
);

drop policy "Public captured or aggregate roads" on public.guava_road_units;
create policy "Participant captured or aggregate roads"
on public.guava_road_units for select to authenticated
using (
  (select private.guava_is_participant()) and (
    (owner_id is not null and exists (
      select 1 from public.guava_profiles p
      where p.user_id = guava_road_units.owner_id and p.community_opt_in
    )) or unique_drivers >= 3
  )
);

drop policy "Round clock" on public.guava_territory_rounds;
create policy "Participant round clock"
on public.guava_territory_rounds for select to authenticated
using ((select private.guava_is_participant()));
