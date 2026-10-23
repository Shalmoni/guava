-- Edge Functions use service_role to verify consent and call the invoker-rights
-- game RPCs. The initial migrations granted EXECUTE but omitted table DML;
-- every real drive upload failed at the first guava_profiles read.
grant select on public.guava_profiles, public.guava_game_drives,
  public.guava_game_scores, public.guava_road_units,
  public.guava_unit_visits, public.guava_territory_rounds to service_role;

-- SELECT ... FOR SHARE in the RPCs also requires UPDATE on one profile column.
grant update (community_opt_in) on public.guava_profiles to service_role;

grant insert on public.guava_game_drives, public.guava_game_scores,
  public.guava_road_units, public.guava_territory_rounds to service_role;
grant update on public.guava_game_scores, public.guava_road_units to service_role;
