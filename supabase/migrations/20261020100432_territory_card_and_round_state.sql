-- A captured date only changes when ownership changes, not on every daily win.
alter table public.guava_road_units add column captured_on date;
update public.guava_road_units set captured_on = decided_on where owner_id is not null;

drop policy "Participant captured or aggregate roads" on public.guava_road_units;
create policy "Participant captured or aggregate roads"
on public.guava_road_units for select to authenticated
using (
  (select private.guava_is_participant()) and (
    (owner_id is not null and exists (
      select 1 from public.guava_profiles p
      where p.user_id = guava_road_units.owner_id and p.community_opt_in
    ))
    or (owner_id is null and decided_on is not null)
    or unique_drivers >= 3
  )
);

create or replace function public.guava_settle_round(p_round_date date) returns integer
language plpgsql security invoker set search_path = ''
as $$
declare v_count integer;
begin
  if p_round_date >= (now() at time zone 'Asia/Jerusalem')::date
     or now() < ((p_round_date + 1)::timestamp + interval '9 hours 5 minutes') at time zone 'Asia/Jerusalem' then
    raise exception 'Only a completed Israel day can be finalized after 09:05';
  end if;
  if exists (select 1 from public.guava_territory_rounds where round_date = p_round_date) then return 0; end if;
  with visits as (
    select drive_id as session_id, unit_id, user_id from public.guava_unit_visits
      where round_date = p_round_date
    union
    select session_id, unit_id, user_id from public.guava_live_unit_visits
      where round_date = p_round_date
  ), votes as (
    select v.unit_id, v.user_id, count(*) as visits
    from visits v join public.guava_profiles p
      on p.user_id = v.user_id and p.community_opt_in
    group by v.unit_id, v.user_id
  ), maxima as (
    select unit_id, max(visits) as top_visits from votes group by unit_id
  ), winners as (
    select v.unit_id,
      case when count(*) = 1 then (array_agg(v.user_id))[1] else null end as owner_id
    from votes v join maxima m on m.unit_id = v.unit_id and m.top_visits = v.visits
    group by v.unit_id
  )
  update public.guava_road_units r set owner_id = w.owner_id,
    captured_on = case when r.owner_id is distinct from w.owner_id
      then case when w.owner_id is null then null else p_round_date end
      else r.captured_on end,
    decided_on = p_round_date, updated_at = now()
    from winners w where r.id = w.unit_id;
  get diagnostics v_count = row_count;
  insert into public.guava_territory_rounds(round_date) values (p_round_date);
  update public.guava_game_scores s set territory_m = coalesce((
    select sum(r.length_m) from public.guava_road_units r where r.owner_id = s.user_id
  ), 0), updated_at = now();
  return v_count;
end;
$$;
revoke all on function public.guava_settle_round(date) from public, anon, authenticated;
grant execute on function public.guava_settle_round(date) to service_role;

-- Service-only, aggregate vote counts for roads already visible to participants.
-- No raw visits, GPS points, other user IDs, or one-person new-road traces leave this function.
create function public.guava_territory_public_scores(p_viewer uuid, p_unit_ids text[])
returns table(unit_id text, round_date date, top_score integer, player_count integer, your_score integer)
language sql security invoker stable set search_path = ''
as $$
  with eligible as (
    select r.id, r.decided_on, r.owner_id from public.guava_road_units r
    where r.id = any(p_unit_ids) and ((r.owner_id is not null and exists (
      select 1 from public.guava_profiles p where p.user_id = r.owner_id and p.community_opt_in
    )) or r.decided_on is not null or r.unique_drivers >= 3)
  ), visits as (
    select drive_id as session_id, unit_id, user_id, round_date from public.guava_unit_visits
    union
    select session_id, unit_id, user_id, round_date from public.guava_live_unit_visits
  ), votes as (
    select v.unit_id, v.round_date, v.user_id, count(*)::integer as score
    from visits v join eligible e on e.id = v.unit_id
    join public.guava_profiles p on p.user_id = v.user_id and p.community_opt_in
    where v.round_date = (now() at time zone 'Asia/Jerusalem')::date
      or (e.owner_id is null and v.round_date = e.decided_on)
    group by v.unit_id, v.round_date, v.user_id
  )
  select v.unit_id, v.round_date, max(v.score)::integer,
    count(*)::integer, coalesce(max(v.score) filter (where v.user_id = p_viewer), 0)::integer
  from votes v group by v.unit_id, v.round_date;
$$;
revoke all on function public.guava_territory_public_scores(uuid,text[]) from public, anon, authenticated;
grant execute on function public.guava_territory_public_scores(uuid,text[]) to service_role;
;
