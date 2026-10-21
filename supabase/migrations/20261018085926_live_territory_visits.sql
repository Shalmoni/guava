-- A territory visit is banked during an opted-in drive, independently of
-- Finish & Save. No raw GPS is stored here. One session gets one vote per
-- road unit per Israel-calendar day; retries are idempotent.
alter table public.guava_profiles add column live_territory_consent_at timestamptz;
grant update (live_territory_consent_at) on public.guava_profiles to authenticated;

create table public.guava_live_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  last_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  check (last_at >= started_at),
  check (ended_at is null or ended_at >= started_at)
);
create index guava_live_sessions_user_idx on public.guava_live_sessions(user_id, started_at desc);

create table public.guava_live_unit_visits (
  session_id uuid not null references public.guava_live_sessions(id) on delete cascade,
  unit_id text not null references public.guava_road_units(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  round_date date not null,
  observed_at timestamptz not null,
  primary key (session_id, unit_id, round_date)
);
create index guava_live_visits_round_idx on public.guava_live_unit_visits(round_date, unit_id, user_id);
create index guava_live_visits_user_idx on public.guava_live_unit_visits(user_id);
create index guava_live_visits_unit_idx on public.guava_live_unit_visits(unit_id);
alter table public.guava_live_sessions enable row level security;
alter table public.guava_live_unit_visits enable row level security;
revoke all on public.guava_live_sessions, public.guava_live_unit_visits from public, anon, authenticated;
grant select, insert, update, delete on public.guava_live_sessions, public.guava_live_unit_visits to service_role;

-- Service-role-only RPC. The Edge Function verifies the user JWT and
-- map-matches a plausible trace before calling this transaction.
create function public.guava_record_live_units(
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
  if not exists (select 1 from public.guava_profiles p
    where p.user_id = p_user_id and p.community_opt_in
      and p.live_territory_consent_at is not null) then
    raise exception 'Live territory consent is required';
  end if;
  if p_started_at > p_observed_at or p_observed_at > now() + interval '2 minutes'
     or p_observed_at < now() - interval '9 hours'
     or p_observed_at - p_started_at > interval '8 hours'
     or jsonb_typeof(p_units) <> 'array'
     or jsonb_array_length(p_units) not between 1 and 200 then
    raise exception 'Live territory segment is outside alpha limits';
  end if;
  if exists (select 1 from public.guava_territory_rounds where round_date = v_day) then
    raise exception 'Territory round is already final';
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

-- Completed drives use the same session ID and only add visits missed by
-- live sync. Lifetime XP/distance/height still post once at completion.
create or replace function public.guava_ingest_matched_drive(
  p_id uuid, p_user_id uuid, p_started_at timestamptz,
  p_ended_at timestamptz, p_distance_m integer, p_height_m integer,
  p_units jsonb
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_unit jsonb;
  v_id text;
  v_new integer := 0;
  v_xp integer;
  v_day date;
  v_seen text[] := array[]::text[];
  v_session uuid;
  v_inserted text;
begin
  if not exists (select 1 from public.guava_profiles p
                 where p.user_id = p_user_id and p.community_opt_in) then
    raise exception 'Community play is not enabled';
  end if;
  if p_ended_at > now() + interval '2 minutes'
     or p_ended_at < now() - interval '1 hour'
     or p_ended_at <= p_started_at
     or p_ended_at - p_started_at > interval '8 hours'
     or p_distance_m not between 50 and 200000
     or p_height_m not between 0 and 10000
     or jsonb_typeof(p_units) <> 'array'
     or jsonb_array_length(p_units) not between 1 and 1500 then
    raise exception 'Drive is outside alpha limits';
  end if;
  if exists (select 1 from public.guava_game_drives where id = p_id) then
    return jsonb_build_object('already_saved', true);
  end if;
  for v_unit in select value from jsonb_array_elements(p_units) loop
    v_id := v_unit->>'id';
    if v_id is null or length(v_id) not between 3 and 90
       or jsonb_typeof(v_unit->'line') <> 'array'
       or jsonb_array_length(v_unit->'line') <> 2
       or (v_unit->>'length_m')::integer not between 1 and 50
       or (v_unit->>'observed_at') is null then
      raise exception 'Invalid road unit';
    end if;
    if (v_unit->>'observed_at')::timestamptz < p_started_at - interval '2 minutes'
       or (v_unit->>'observed_at')::timestamptz > p_ended_at + interval '2 minutes' then
      raise exception 'Road-unit time is outside drive';
    end if;
    v_day := ((v_unit->>'observed_at')::timestamptz at time zone 'Asia/Jerusalem')::date;
    if exists (select 1 from public.guava_territory_rounds where round_date = v_day) then
      raise exception 'Territory round is already final';
    end if;
    if not v_id = any(v_seen) then
      v_seen := array_append(v_seen, v_id);
      if not exists (
        select 1 from public.guava_unit_visits where unit_id = v_id and user_id = p_user_id
        union all
        select 1 from public.guava_live_unit_visits where unit_id = v_id and user_id = p_user_id
      ) then v_new := v_new + 1; end if;
    end if;
  end loop;
  v_xp := least(5000, 10 + floor(p_distance_m / 1000.0 * 8)::integer
          + floor(p_height_m / 20.0)::integer + least(v_new, 500) * 2);
  insert into public.guava_live_sessions(id, user_id, started_at, last_at, ended_at)
    values (p_id, p_user_id, p_started_at, p_ended_at, p_ended_at)
    on conflict (id) do update set
      last_at = greatest(public.guava_live_sessions.last_at, excluded.last_at),
      ended_at = excluded.ended_at
    where public.guava_live_sessions.user_id = excluded.user_id
      and public.guava_live_sessions.started_at = excluded.started_at
    returning id into v_session;
  if v_session is null then raise exception 'Drive session does not match this driver'; end if;
  insert into public.guava_game_drives
    (id, user_id, started_at, ended_at, distance_m, height_m, xp)
  values (p_id, p_user_id, p_started_at, p_ended_at, p_distance_m, p_height_m, v_xp);
  for v_unit in select value from jsonb_array_elements(p_units) loop
    v_id := v_unit->>'id';
    v_day := ((v_unit->>'observed_at')::timestamptz at time zone 'Asia/Jerusalem')::date;
    insert into public.guava_road_units(id, line, length_m)
      values (v_id, v_unit->'line', (v_unit->>'length_m')::integer)
      on conflict (id) do nothing;
    v_inserted := null;
    insert into public.guava_live_unit_visits(session_id, unit_id, user_id, round_date, observed_at)
      values (p_id, v_id, p_user_id, v_day, (v_unit->>'observed_at')::timestamptz)
      on conflict do nothing returning unit_id into v_inserted;
    if v_inserted is not null then
      update public.guava_road_units r set
        traversal_count = r.traversal_count + 1,
        unique_drivers = (
          select count(distinct x.user_id)::integer from (
            select user_id from public.guava_unit_visits where unit_id = v_id
            union select user_id from public.guava_live_unit_visits where unit_id = v_id
          ) x
        ),
        updated_at = now() where r.id = v_id;
    end if;
  end loop;
  insert into public.guava_game_scores(user_id, xp, distance_m, height_m, drive_count)
    values (p_user_id, v_xp, p_distance_m, p_height_m, 1)
    on conflict (user_id) do update set
      xp = public.guava_game_scores.xp + excluded.xp,
      distance_m = public.guava_game_scores.distance_m + excluded.distance_m,
      height_m = public.guava_game_scores.height_m + excluded.height_m,
      drive_count = public.guava_game_scores.drive_count + 1,
      updated_at = now();
  return jsonb_build_object('already_saved', false, 'xp', v_xp,
    'new_units', v_new, 'unit_count', jsonb_array_length(p_units));
end;
$$;

-- Finalization is at 09:05 Israel time. This leaves the current maximum
-- eight-hour drive plus one-hour finish-upload window after midnight.
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

create or replace function guava_private.leave_community() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.community_opt_in and not new.community_opt_in then
    update public.guava_road_units set owner_id = null, updated_at = now()
      where owner_id = new.user_id;
    delete from public.guava_game_drives where user_id = new.user_id;
    delete from public.guava_live_sessions where user_id = new.user_id;
    delete from public.guava_game_scores where user_id = new.user_id;
    update public.guava_road_units r set
      traversal_count = (
        select count(*)::integer from (
          select drive_id as session_id, round_date from public.guava_unit_visits where unit_id = r.id
          union
          select session_id, round_date from public.guava_live_unit_visits where unit_id = r.id
        ) x
      ),
      unique_drivers = (
        select count(distinct user_id)::integer from (
          select user_id from public.guava_unit_visits where unit_id = r.id
          union select user_id from public.guava_live_unit_visits where unit_id = r.id
        ) x
      ),
      updated_at = now()
      where r.traversal_count > 0;
  end if;
  return new;
end;
$$;

create function public.guava_settle_due_round() returns integer
language plpgsql security invoker set search_path = ''
as $$
begin
  if extract(hour from now() at time zone 'Asia/Jerusalem') <> 9
     or extract(minute from now() at time zone 'Asia/Jerusalem') <> 5 then
    return 0;
  end if;
  return public.guava_settle_round((now() at time zone 'Asia/Jerusalem')::date - 1);
end;
$$;
revoke all on function public.guava_settle_due_round() from public, anon, authenticated;
grant execute on function public.guava_settle_due_round() to service_role;
select cron.unschedule('guava-territory-daily');
select cron.schedule(
  'guava-territory-daily', '5 * * * *',
  $$select public.guava_settle_due_round()$$
);
;
