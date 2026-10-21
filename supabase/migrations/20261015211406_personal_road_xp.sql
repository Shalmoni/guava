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
;
