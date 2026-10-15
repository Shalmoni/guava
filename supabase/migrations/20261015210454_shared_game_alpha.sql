-- Guava friend alpha. Raw GPS is accepted by an Edge Function for transient
-- map matching, but never stored in Postgres. Only road-cell geometry is kept.
create table public.guava_game_drives (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  distance_m integer not null check (distance_m between 50 and 200000),
  height_m integer not null check (height_m between 0 and 10000),
  xp integer not null check (xp between 0 and 5000),
  created_at timestamptz not null default now(),
  check (ended_at > started_at)
);
create index guava_game_drives_user_idx on public.guava_game_drives(user_id, ended_at desc);

create table public.guava_game_scores (
  user_id uuid primary key references auth.users(id) on delete cascade,
  xp bigint not null default 0 check (xp >= 0),
  distance_m bigint not null default 0 check (distance_m >= 0),
  height_m bigint not null default 0 check (height_m >= 0),
  territory_m bigint not null default 0 check (territory_m >= 0),
  drive_count integer not null default 0 check (drive_count >= 0),
  updated_at timestamptz not null default now()
);

-- Hex key is computed from map-matched road geometry. One 25-ish metre hex
-- can contain multiple nearby roads; that is a known alpha approximation.
create table public.guava_road_units (
  id text primary key check (length(id) between 3 and 90),
  line jsonb not null,
  length_m integer not null check (length_m between 1 and 50),
  owner_id uuid references auth.users(id) on delete set null,
  traversal_count integer not null default 0 check (traversal_count >= 0),
  unique_drivers integer not null default 0 check (unique_drivers >= 0),
  decided_on date,
  updated_at timestamptz not null default now()
);
create index guava_road_units_owner_idx on public.guava_road_units(owner_id);

create table public.guava_unit_visits (
  drive_id uuid not null references public.guava_game_drives(id) on delete cascade,
  unit_id text not null references public.guava_road_units(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  round_date date not null,
  primary key (drive_id, unit_id)
);
create index guava_unit_visits_round_idx on public.guava_unit_visits(round_date, unit_id, user_id);
create index guava_unit_visits_user_idx on public.guava_unit_visits(user_id);

create table public.guava_territory_rounds (
  round_date date primary key,
  settled_at timestamptz not null default now()
);

alter table public.guava_game_drives enable row level security;
alter table public.guava_game_scores enable row level security;
alter table public.guava_road_units enable row level security;
alter table public.guava_unit_visits enable row level security;
alter table public.guava_territory_rounds enable row level security;

revoke all on public.guava_game_drives, public.guava_game_scores,
  public.guava_road_units, public.guava_unit_visits,
  public.guava_territory_rounds from anon, authenticated;
grant select on public.guava_game_drives, public.guava_game_scores,
  public.guava_road_units, public.guava_territory_rounds to authenticated;

create policy "Own drive summaries" on public.guava_game_drives
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Participating scores or own" on public.guava_game_scores
  for select to authenticated using (
    user_id = (select auth.uid()) or exists (
      select 1 from public.guava_profiles p
      where p.user_id = guava_game_scores.user_id and p.community_opt_in
    )
  );
create policy "Public captured or aggregate roads" on public.guava_road_units
  for select to authenticated using (
    (owner_id is not null and exists (
      select 1 from public.guava_profiles p
      where p.user_id = guava_road_units.owner_id and p.community_opt_in
    )) or unique_drivers >= 3
  );
create policy "Round clock" on public.guava_territory_rounds
  for select to authenticated using (true);

-- Called only with a service-role key from the Edge Function. It is not
-- SECURITY DEFINER, so direct client calls cannot bypass table privileges.
create function public.guava_ingest_matched_drive(
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
  v_round date;
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
  v_round := (p_ended_at at time zone 'UTC')::date;
  if exists (select 1 from public.guava_territory_rounds where round_date = v_round) then
    raise exception 'This territory round is closed';
  end if;
  if exists (select 1 from public.guava_game_drives where id = p_id) then
    return jsonb_build_object('already_saved', true);
  end if;
  for v_unit in select distinct on (value->>'id') value
      from jsonb_array_elements(p_units) order by value->>'id' loop
    v_id := v_unit->>'id';
    if v_id is null or length(v_id) not between 3 and 90
       or jsonb_typeof(v_unit->'line') <> 'array'
       or jsonb_array_length(v_unit->'line') <> 2
       or (v_unit->>'length_m')::integer not between 1 and 50 then
      raise exception 'Invalid road unit';
    end if;
    if not exists (select 1 from public.guava_unit_visits
                   where unit_id = v_id and user_id = p_user_id) then
      v_new := v_new + 1;
    end if;
  end loop;
  v_xp := least(5000, 10 + floor(p_distance_m / 1000.0 * 8)::integer
          + floor(p_height_m / 20.0)::integer + least(v_new, 500) * 2);
  insert into public.guava_game_drives
    (id, user_id, started_at, ended_at, distance_m, height_m, xp)
  values (p_id, p_user_id, p_started_at, p_ended_at, p_distance_m, p_height_m, v_xp);

  for v_unit in select distinct on (value->>'id') value
      from jsonb_array_elements(p_units) order by value->>'id' loop
    v_id := v_unit->>'id';
    insert into public.guava_road_units(id, line, length_m)
      values (v_id, v_unit->'line', (v_unit->>'length_m')::integer)
      on conflict (id) do nothing;
    insert into public.guava_unit_visits(drive_id, unit_id, user_id, round_date)
      values (p_id, v_id, p_user_id, v_round);
    update public.guava_road_units r set
      traversal_count = r.traversal_count + 1,
      unique_drivers = (select count(distinct v.user_id)::integer
        from public.guava_unit_visits v join public.guava_profiles p
          on p.user_id = v.user_id and p.community_opt_in
        where v.unit_id = v_id),
      updated_at = now()
      where r.id = v_id;
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
revoke all on function public.guava_ingest_matched_drive(uuid,uuid,timestamptz,timestamptz,integer,integer,jsonb) from public, anon, authenticated;
grant execute on function public.guava_ingest_matched_drive(uuid,uuid,timestamptz,timestamptz,integer,integer,jsonb) to service_role;

create function public.guava_settle_round(p_round_date date) returns integer
language plpgsql security invoker set search_path = ''
as $$
declare v_count integer;
begin
  if p_round_date >= (now() at time zone 'UTC')::date
     or now() < (p_round_date + 1)::timestamp at time zone 'UTC' + interval '5 minutes' then
    raise exception 'Only a completed UTC day can be settled after 00:05';
  end if;
  if exists (select 1 from public.guava_territory_rounds where round_date = p_round_date) then
    return 0;
  end if;
  with votes as (
    select v.unit_id, v.user_id, count(*) as visits
    from public.guava_unit_visits v
    join public.guava_profiles p on p.user_id = v.user_id and p.community_opt_in
    where v.round_date = p_round_date group by v.unit_id, v.user_id
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
revoke all on function public.guava_settle_round(date) from public, anon, authenticated;
grant execute on function public.guava_settle_round(date) to service_role;

-- Opting out removes that person's shared-game history and ownership. The
-- browser keeps its own local drives until the user clears them separately.
create schema if not exists guava_private;
revoke all on schema guava_private from public, anon, authenticated;
create function guava_private.leave_community() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.community_opt_in and not new.community_opt_in then
    update public.guava_road_units set owner_id = null, updated_at = now()
      where owner_id = new.user_id;
    delete from public.guava_game_drives where user_id = new.user_id;
    delete from public.guava_game_scores where user_id = new.user_id;
    update public.guava_road_units r set
      traversal_count = (select count(*)::integer from public.guava_unit_visits v where v.unit_id = r.id),
      unique_drivers = (select count(distinct v.user_id)::integer from public.guava_unit_visits v where v.unit_id = r.id),
      updated_at = now()
      where r.traversal_count > 0;
  end if;
  return new;
end;
$$;
revoke all on function guava_private.leave_community() from public, anon, authenticated;
create trigger guava_profile_leave_community
after update of community_opt_in on public.guava_profiles
for each row execute function guava_private.leave_community();

-- Settle the previous UTC day at 00:05. A repeated run is idempotent.
create extension if not exists pg_cron;
select cron.schedule(
  'guava-territory-daily', '5 0 * * *',
  $$select public.guava_settle_round(((now() at time zone 'UTC')::date - 1))$$
);
