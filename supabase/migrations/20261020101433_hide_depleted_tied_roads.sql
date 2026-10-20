-- A settled tie must not remain publicly visible after everyone but one
-- participant opts out and their visits are deleted by leave_community().
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
  )
);
