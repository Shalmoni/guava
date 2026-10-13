-- Guava's community scoring foundation. No raw GPS points are stored here.
-- A trusted ingestion service must map-match and verify each drive before it calls
-- ingest_verified_drive; this function is deliberately unavailable to app clients.

create table public.guava_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 32),
  created_at timestamptz not null default now()
);

create table public.road_units (
  id uuid primary key default gen_random_uuid(),
  road_key text not null,
  hex_key text not null,
  length_m numeric(9,2) not null check (length_m > 0 and length_m <= 1000),
  -- Server-curated road centerline only; never individual trip geometry.
  geometry_geojson jsonb not null,
  unique (road_key, hex_key)
);

create table public.verified_drives (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  occurred_at timestamptz not null,
  distance_m numeric(12,2) not null check (distance_m >= 50),
  created_at timestamptz not null default now()
);

create table public.road_crossings (
  drive_id uuid not null references public.verified_drives(id) on delete cascade,
  unit_id uuid not null references public.road_units(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  round_start timestamptz not null,
  primary key (drive_id, unit_id)
);
create index road_crossings_round_unit_user_idx on public.road_crossings (round_start, unit_id, user_id);
create index road_crossings_user_idx on public.road_crossings (user_id);

create table public.road_use_totals (
  unit_id uuid primary key references public.road_units(id),
  traversal_count bigint not null default 0 check (traversal_count >= 0),
  unique_drivers bigint not null default 0 check (unique_drivers >= 0),
  updated_at timestamptz not null default now()
);

create table public.road_use_drivers (
  unit_id uuid not null references public.road_units(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (unit_id, user_id)
);

create table public.territory_rounds (
  round_start timestamptz primary key,
  closes_at timestamptz not null,
  settled_at timestamptz not null default now(),
  check (closes_at = round_start + interval '24 hours')
);

create table public.territory_owners (
  unit_id uuid primary key references public.road_units(id),
  owner_id uuid references auth.users(id) on delete set null,
  decided_round timestamptz not null,
  updated_at timestamptz not null default now()
);
create index territory_owners_owner_idx on public.territory_owners (owner_id);

alter table public.guava_profiles enable row level security;
alter table public.road_units enable row level security;
alter table public.verified_drives enable row level security;
alter table public.road_crossings enable row level security;
alter table public.road_use_totals enable row level security;
alter table public.road_use_drivers enable row level security;
alter table public.territory_rounds enable row level security;
alter table public.territory_owners enable row level security;

create policy "Public profile names" on public.guava_profiles for select to authenticated using (true);
create policy "Public road units" on public.road_units for select to authenticated using (true);
create policy "Own verified drives" on public.verified_drives for select to authenticated using (user_id = (select auth.uid()));
create policy "Own crossings" on public.road_crossings for select to authenticated using (user_id = (select auth.uid()));
-- A single person's quiet road should not reveal their route to the whole community.
create policy "Shared road frequency" on public.road_use_totals for select to authenticated using (unique_drivers >= 3);
create policy "Shared round clock" on public.territory_rounds for select to authenticated using (true);
create policy "Shared territory" on public.territory_owners for select to authenticated using (true);

-- App users can read only the intended public aggregates and their own records.
revoke all on public.guava_profiles, public.road_units, public.verified_drives,
  public.road_crossings, public.road_use_totals, public.road_use_drivers, public.territory_rounds,
  public.territory_owners from anon, authenticated;
grant select on public.guava_profiles, public.road_units, public.road_use_totals,
  public.territory_rounds, public.territory_owners to authenticated;
grant select on public.verified_drives, public.road_crossings to authenticated;

create or replace function public.ingest_verified_drive(
  p_drive_id uuid,
  p_user_id uuid,
  p_occurred_at timestamptz,
  p_distance_m numeric,
  p_unit_ids uuid[]
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_round_start timestamptz;
begin
  if p_distance_m < 50 or p_unit_ids is null or array_length(p_unit_ids, 1) is null then
    raise exception 'Drive is not eligible';
  end if;
  -- Offline drives can still be saved locally, but closed competitive rounds are immutable.
  v_round_start := date_trunc('day', p_occurred_at at time zone 'UTC') at time zone 'UTC';
  if v_round_start <> date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' then
    raise exception 'Competitive round is closed';
  end if;
  insert into public.verified_drives (id, user_id, occurred_at, distance_m)
  values (p_drive_id, p_user_id, p_occurred_at, p_distance_m)
  on conflict (id) do nothing;
  if not found then return false; end if;

  insert into public.road_crossings (drive_id, unit_id, user_id, round_start)
  select p_drive_id, units.id, p_user_id, v_round_start
  from public.road_units units
  join (select distinct unnest(p_unit_ids) as id) submitted on submitted.id = units.id;

  insert into public.road_use_drivers (unit_id, user_id)
  select unit_id, p_user_id from public.road_crossings where drive_id = p_drive_id
  on conflict do nothing;

  insert into public.road_use_totals (unit_id, traversal_count, unique_drivers)
  select c.unit_id, 1,
    (select count(*) from public.road_use_drivers d where d.unit_id = c.unit_id)
  from public.road_crossings c where c.drive_id = p_drive_id
  on conflict (unit_id) do update set
    traversal_count = public.road_use_totals.traversal_count + 1,
    unique_drivers = excluded.unique_drivers,
    updated_at = now();
  return true;
end;
$$;
revoke all on function public.ingest_verified_drive(uuid, uuid, timestamptz, numeric, uuid[]) from public, anon, authenticated;
grant execute on function public.ingest_verified_drive(uuid, uuid, timestamptz, numeric, uuid[]) to service_role;

create or replace function public.settle_territory_round(p_round_start timestamptz)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_round_start <> date_trunc('day', p_round_start at time zone 'UTC') at time zone 'UTC'
     or p_round_start + interval '24 hours' > now() then
    raise exception 'Round must be a closed UTC day';
  end if;
  if exists (select 1 from public.territory_rounds where round_start = p_round_start) then
    return;
  end if;

  -- A unique leader wins; a positive tie clears ownership. Untouched units retain
  -- their previous owner. Direction has no effect because both use one unit ID.
  with counts as (
    select unit_id, user_id, count(*) as visits
    from public.road_crossings
    where round_start = p_round_start
    group by unit_id, user_id
  ), maxima as (
    select unit_id, max(visits) as top_visits
    from counts group by unit_id
  ), winners as (
    select c.unit_id,
      case when count(*) = 1 then (array_agg(c.user_id))[1] else null end as owner_id
    from counts c join maxima m on c.unit_id = m.unit_id and c.visits = m.top_visits
    group by c.unit_id
  )
  insert into public.territory_owners (unit_id, owner_id, decided_round)
  select unit_id, owner_id, p_round_start from winners
  on conflict (unit_id) do update set
    owner_id = excluded.owner_id,
    decided_round = excluded.decided_round,
    updated_at = now();

  insert into public.territory_rounds (round_start, closes_at)
  values (p_round_start, p_round_start + interval '24 hours');
end;
$$;
revoke all on function public.settle_territory_round(timestamptz) from public, anon, authenticated;
grant execute on function public.settle_territory_round(timestamptz) to service_role;

-- On a hosted project, enable Supabase Cron and schedule this once at 00:05 UTC:
-- select cron.schedule('guava-daily-territory', '5 0 * * *',
--   $$select public.settle_territory_round((date_trunc('day', now() at time zone 'UTC') - interval '1 day') at time zone 'UTC')$$);
