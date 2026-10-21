-- Completed drives may retry for seven days. Late visits retain exploration XP
-- and aggregate pulse, but never change a finalized or expired territory round.
alter table public.guava_live_unit_visits
  add column counts_for_territory boolean not null default true;
create index guava_live_visits_user_unit_idx on public.guava_live_unit_visits(user_id, unit_id);
create index guava_visits_user_unit_idx on public.guava_unit_visits(user_id, unit_id);

create or replace function public.guava_ingest_matched_drive(
  p_id uuid, p_user_id uuid, p_started_at timestamptz,
  p_ended_at timestamptz, p_distance_m integer, p_height_m integer,
  p_units jsonb
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_existing public.guava_game_drives%rowtype;
  v_new integer;
  v_xp integer;
  v_day date;
  v_session uuid;
  v_added text[];
  v_late integer;
begin
  -- Prevent opt-out racing an in-flight completed upload. Never trust cached UI consent.
  perform 1 from public.guava_profiles p where p.user_id = p_user_id
    and p.community_opt_in and p.territory_detail_consent_at is not null for share;
  if not found then raise exception 'Community sharing consent is required'; end if;
  -- One driver's simultaneous retries/finishes cannot duplicate credit or new-road XP.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 1));
  select * into v_existing from public.guava_game_drives where id = p_id;
  if found then
    if v_existing.user_id <> p_user_id then raise exception 'Drive ID belongs to a different account'; end if;
    return jsonb_build_object('already_saved', true, 'xp', v_existing.xp,
      'distance_m', v_existing.distance_m, 'height_m', v_existing.height_m);
  end if;
  if p_id is null or p_user_id is null or p_started_at is null or p_ended_at is null
     or p_ended_at > now() + interval '2 minutes'
     or p_ended_at < now() - interval '7 days'
     or p_ended_at - p_started_at < interval '15 seconds'
     or p_ended_at - p_started_at > interval '8 hours'
     or p_distance_m is null or p_distance_m not between 50 and 200000
     or p_height_m is null or p_height_m not between 0 and 10000
     or p_units is null or jsonb_typeof(p_units) <> 'array'
     or jsonb_array_length(p_units) not between 1 and 20000 then
    raise exception 'Drive is outside supported limits';
  end if;
  if exists (select 1 from jsonb_array_elements(p_units) u where
    coalesce(length(u->>'id'), 0) not between 3 and 90
    or coalesce(jsonb_typeof(u->'line'), '') <> 'array'
    or jsonb_array_length(u->'line') <> 2
    or coalesce((u->>'length_m')::integer, 0) not between 1 and 50
    or (u->>'observed_at') is null
    or (u->>'observed_at')::timestamptz < p_started_at - interval '2 minutes'
    or (u->>'observed_at')::timestamptz > p_ended_at + interval '2 minutes') then
    raise exception 'Invalid road unit';
  end if;
  -- Round locks also protect the cutoff from a concurrent settlement transaction.
  for v_day in select distinct ((u->>'observed_at')::timestamptz at time zone 'Asia/Jerusalem')::date
    from jsonb_array_elements(p_units) u order by 1 loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('guava-round:' || v_day::text, 0));
  end loop;
  select count(*)::integer into v_new from (
    select distinct u->>'id' as id from jsonb_array_elements(p_units) u
  ) units where not exists (select 1 from public.guava_unit_visits v
    where v.user_id = p_user_id and v.unit_id = units.id and v.drive_id <> p_id)
    and not exists (select 1 from public.guava_live_unit_visits v
    where v.user_id = p_user_id and v.unit_id = units.id and v.session_id <> p_id);
  v_xp := least(5000, 10 + floor(p_distance_m / 1000.0 * 8)::integer
    + floor(p_height_m / 20.0)::integer + least(v_new, 500) * 2);
  insert into public.guava_live_sessions(id, user_id, started_at, last_at, ended_at)
    values (p_id, p_user_id, p_started_at, p_ended_at, p_ended_at)
    on conflict (id) do update set
      last_at = greatest(public.guava_live_sessions.last_at, excluded.last_at), ended_at = excluded.ended_at
    where public.guava_live_sessions.user_id = excluded.user_id
      and public.guava_live_sessions.started_at = excluded.started_at
    returning id into v_session;
  if v_session is null then raise exception 'Drive session does not match this driver'; end if;
  insert into public.guava_game_drives(id, user_id, started_at, ended_at, distance_m, height_m, xp)
    values (p_id, p_user_id, p_started_at, p_ended_at, p_distance_m, p_height_m, v_xp);
  insert into public.guava_road_units(id, line, length_m)
    select distinct on (u->>'id') u->>'id', u->'line', (u->>'length_m')::integer
    from jsonb_array_elements(p_units) u order by u->>'id'
    on conflict (id) do nothing;
  with units as (
    select distinct on (u->>'id', ((u->>'observed_at')::timestamptz at time zone 'Asia/Jerusalem')::date)
      u->>'id' as id, (u->>'observed_at')::timestamptz as observed_at,
      ((u->>'observed_at')::timestamptz at time zone 'Asia/Jerusalem')::date as day
    from jsonb_array_elements(p_units) u
  ), inserted as (
    insert into public.guava_live_unit_visits(session_id, unit_id, user_id, round_date, observed_at, counts_for_territory)
    select p_id, u.id, p_user_id, u.day, u.observed_at,
      now() < (((u.day + 1)::timestamp + interval '9 hours 5 minutes') at time zone 'Asia/Jerusalem')
      and not exists (select 1 from public.guava_territory_rounds r where r.round_date = u.day)
    from units u order by u.id, u.day
    on conflict do nothing returning unit_id
  ) select array_agg(unit_id) into v_added from inserted;
  with added as (select id, count(*)::integer as n from unnest(v_added) id group by id)
  update public.guava_road_units r set
    traversal_count = r.traversal_count + added.n,
    unique_drivers = (select count(distinct x.user_id)::integer from (
      select user_id from public.guava_unit_visits where unit_id = r.id
      union select user_id from public.guava_live_unit_visits where unit_id = r.id
    ) x), updated_at = now()
    from added where r.id = added.id;
  select count(*)::integer into v_late from public.guava_live_unit_visits
    where session_id = p_id and not counts_for_territory;
  insert into public.guava_game_scores(user_id, xp, distance_m, height_m, drive_count)
    values (p_user_id, v_xp, p_distance_m, p_height_m, 1)
    on conflict (user_id) do update set
      xp = public.guava_game_scores.xp + excluded.xp,
      distance_m = public.guava_game_scores.distance_m + excluded.distance_m,
      height_m = public.guava_game_scores.height_m + excluded.height_m,
      drive_count = public.guava_game_scores.drive_count + 1, updated_at = now();
  return jsonb_build_object('already_saved', false, 'xp', v_xp, 'distance_m', p_distance_m,
    'height_m', p_height_m, 'new_units', v_new, 'unit_count', jsonb_array_length(p_units),
    'late_units', v_late);
end;
$$;
revoke all on function public.guava_ingest_matched_drive(uuid,uuid,timestamptz,timestamptz,integer,integer,jsonb) from public, anon, authenticated;
grant execute on function public.guava_ingest_matched_drive(uuid,uuid,timestamptz,timestamptz,integer,integer,jsonb) to service_role;

create or replace function public.guava_record_live_units(
  p_session_id uuid, p_user_id uuid, p_started_at timestamptz,
  p_observed_at timestamptz, p_units jsonb
) returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_unit jsonb;
  v_id text;
  v_session uuid;
  v_inserted text;
  v_count integer := 0;
  v_day date := (p_observed_at at time zone 'Asia/Jerusalem')::date;
begin
  perform 1 from public.guava_profiles p
    where p.user_id = p_user_id and p.community_opt_in
      and p.live_territory_consent_at is not null and p.territory_detail_consent_at is not null for share;
  if not found then
    raise exception 'Live territory consent is required';
  end if;
  if p_started_at > p_observed_at or p_observed_at > now() + interval '2 minutes'
     or p_observed_at < now() - interval '9 hours'
     or p_observed_at - p_started_at > interval '8 hours'
     or jsonb_typeof(p_units) <> 'array'
     or jsonb_array_length(p_units) not between 1 and 200 then
    raise exception 'Live territory segment is outside supported limits';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('guava-round:' || v_day::text, 0));
  if now() >= (((v_day + 1)::timestamp + interval '9 hours 5 minutes') at time zone 'Asia/Jerusalem')
    or exists (select 1 from public.guava_territory_rounds where round_date = v_day) then
    return 0; -- A completed drive can still upload its lifetime score later.
  end if;
  insert into public.guava_live_sessions(id, user_id, started_at, last_at)
  values (p_session_id, p_user_id, p_started_at, p_observed_at)
  on conflict (id) do update
    set last_at = greatest(public.guava_live_sessions.last_at, excluded.last_at)
    where public.guava_live_sessions.user_id = excluded.user_id
      and public.guava_live_sessions.started_at = excluded.started_at
      and (public.guava_live_sessions.ended_at is null
           or excluded.last_at <= public.guava_live_sessions.ended_at + interval '2 minutes')
  returning id into v_session;
  if v_session is null then raise exception 'Live session does not match this driver'; end if;

  for v_unit in select value from jsonb_array_elements(p_units) loop
    v_id := v_unit->>'id';
    if v_id is null or length(v_id) not between 3 and 90
       or jsonb_typeof(v_unit->'line') <> 'array'
       or jsonb_array_length(v_unit->'line') <> 2
       or (v_unit->>'length_m')::integer not between 1 and 50 then
      raise exception 'Invalid road unit';
    end if;
    insert into public.guava_road_units(id, line, length_m)
      values (v_id, v_unit->'line', (v_unit->>'length_m')::integer)
      on conflict (id) do nothing;
    v_inserted := null;
    insert into public.guava_live_unit_visits(session_id, unit_id, user_id, round_date, observed_at)
      values (p_session_id, v_id, p_user_id, v_day, p_observed_at)
      on conflict do nothing returning unit_id into v_inserted;
    if v_inserted is not null then
      v_count := v_count + 1;
      update public.guava_road_units r set
        traversal_count = r.traversal_count + 1,
        unique_drivers = (
          select count(distinct x.user_id)::integer from (
            select user_id from public.guava_unit_visits where unit_id = v_id
            union select user_id from public.guava_live_unit_visits where unit_id = v_id
          ) x
        ),
        updated_at = now()
      where r.id = v_id;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.guava_record_live_units(uuid,uuid,timestamptz,timestamptz,jsonb)
  from public, anon, authenticated;
grant execute on function public.guava_record_live_units(uuid,uuid,timestamptz,timestamptz,jsonb)
  to service_role;


create or replace function public.guava_settle_round(p_round_date date) returns integer
language plpgsql security invoker set search_path = ''
as $$
declare v_count integer;
begin
  if p_round_date >= (now() at time zone 'Asia/Jerusalem')::date
     or now() < ((p_round_date + 1)::timestamp + interval '9 hours 5 minutes') at time zone 'Asia/Jerusalem' then
    raise exception 'Only a completed Israel day can be finalized after 09:05';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('guava-round:' || p_round_date::text, 0));
  if exists (select 1 from public.guava_territory_rounds where round_date = p_round_date) then return 0; end if;
  with visits as (
    select drive_id as session_id, unit_id, user_id from public.guava_unit_visits
      where round_date = p_round_date
    union
    select session_id, unit_id, user_id from public.guava_live_unit_visits
      where round_date = p_round_date and counts_for_territory
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
create or replace function public.guava_territory_public_scores(p_viewer uuid, p_unit_ids text[])
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
    select session_id, unit_id, user_id, round_date from public.guava_live_unit_visits where counts_for_territory
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
