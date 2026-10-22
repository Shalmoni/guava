-- Showing a single player's live road visit is a wider disclosure than the
-- previous notice allowed. Existing players must explicitly accept it.
alter table public.guava_profiles add column open_territory_consent_at timestamptz;
grant update (open_territory_consent_at) on public.guava_profiles to authenticated;

create function guava_private.require_open_territory_consent()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.guava_profiles p where p.user_id = new.user_id
      and p.community_opt_in and p.open_territory_consent_at is not null
  ) then
    raise exception 'Live contest visibility consent is required';
  end if;
  return new;
end;
$$;
revoke all on function guava_private.require_open_territory_consent() from public, anon, authenticated;
create trigger guava_live_visit_open_consent before insert on public.guava_live_unit_visits
  for each row execute function guava_private.require_open_territory_consent();

create function private.guava_is_open_participant()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.guava_profiles p
    where p.user_id = (select auth.uid()) and p.community_opt_in
      and p.open_territory_consent_at is not null);
$$;
revoke all on function private.guava_is_open_participant() from public, anon, authenticated;
grant execute on function private.guava_is_open_participant() to authenticated;

-- Keep the previous day's closed contest visible until settlement completes.
-- This helper only considers visits from players who accepted the new notice.
create function private.guava_active_contest_road(p_unit_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.guava_live_unit_visits v
    join public.guava_profiles p on p.user_id = v.user_id
    where v.unit_id = p_unit_id and v.counts_for_territory
      and p.community_opt_in and p.open_territory_consent_at is not null
      and (v.round_date = (now() at time zone 'Asia/Jerusalem')::date
        or (v.round_date = (now() at time zone 'Asia/Jerusalem')::date - 1
          and not exists (select 1 from public.guava_territory_rounds r
            where r.round_date = v.round_date)))
  );
$$;
revoke all on function private.guava_active_contest_road(text) from public, anon, authenticated;
grant execute on function private.guava_active_contest_road(text) to authenticated;

drop policy "Participant captured or aggregate roads" on public.guava_road_units;
create policy "Participant captured or aggregate roads"
on public.guava_road_units for select to authenticated
using (
  (select private.guava_is_participant()) and (
    (owner_id is not null and exists (
      select 1 from public.guava_profiles p
      where p.user_id = guava_road_units.owner_id and p.community_opt_in
    ))
    or (owner_id is null and decided_on is not null and unique_drivers >= 2)
    or unique_drivers >= 3
    or ((select private.guava_is_open_participant())
      and private.guava_active_contest_road(guava_road_units.id))
  )
);

-- Service-only aggregate counts; each drive is still one vote per road/day.
create or replace function public.guava_territory_public_scores(p_viewer uuid, p_unit_ids text[])
returns table(unit_id text, round_date date, top_score integer, player_count integer, your_score integer)
language sql security invoker stable set search_path = '' as $$
  with eligible as (
    select r.id, r.decided_on, r.owner_id from public.guava_road_units r
    where r.id = any(p_unit_ids) and (
      (r.owner_id is not null and exists (
        select 1 from public.guava_profiles p where p.user_id = r.owner_id and p.community_opt_in
      )) or r.decided_on is not null or r.unique_drivers >= 3
      or exists (select 1 from public.guava_live_unit_visits v
        join public.guava_profiles p on p.user_id = v.user_id
        where v.unit_id = r.id and v.counts_for_territory and p.community_opt_in
          and p.open_territory_consent_at is not null
          and (v.round_date = (now() at time zone 'Asia/Jerusalem')::date
            or (v.round_date = (now() at time zone 'Asia/Jerusalem')::date - 1
              and not exists (select 1 from public.guava_territory_rounds x
                where x.round_date = v.round_date))))
    )
  ), visits as (
    select drive_id as session_id, unit_id, user_id, round_date from public.guava_unit_visits
    union
    select session_id, unit_id, user_id, round_date from public.guava_live_unit_visits
      where counts_for_territory
  ), votes as (
    select v.unit_id, v.round_date, v.user_id, count(*)::integer as score
    from visits v join eligible e on e.id = v.unit_id
    join public.guava_profiles p on p.user_id = v.user_id and p.community_opt_in
    where (
      p.open_territory_consent_at is not null and (
        v.round_date = (now() at time zone 'Asia/Jerusalem')::date
        or (v.round_date = (now() at time zone 'Asia/Jerusalem')::date - 1
          and not exists (select 1 from public.guava_territory_rounds r
            where r.round_date = v.round_date))
      )
    ) or (e.owner_id is null and v.round_date = e.decided_on)
    group by v.unit_id, v.round_date, v.user_id
  )
  select v.unit_id, v.round_date, max(v.score)::integer,
    count(*)::integer, coalesce(max(v.score) filter (where v.user_id = p_viewer), 0)::integer
  from votes v group by v.unit_id, v.round_date;
$$;
revoke all on function public.guava_territory_public_scores(uuid,text[]) from public, anon, authenticated;
grant execute on function public.guava_territory_public_scores(uuid,text[]) to service_role;
