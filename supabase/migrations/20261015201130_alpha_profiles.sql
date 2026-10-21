-- An account exists independently of competition. A driver must explicitly opt
-- into the community before their alias is visible to other signed-in users.
-- Email addresses and raw location traces never live in this table.
create table public.guava_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 32),
  community_opt_in boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.guava_profiles enable row level security;
revoke all on public.guava_profiles from anon, authenticated;
grant select, insert, delete on public.guava_profiles to authenticated;
grant update (display_name, community_opt_in) on public.guava_profiles to authenticated;

create policy "Read own or participating aliases"
on public.guava_profiles for select to authenticated
using (user_id = (select auth.uid()) or community_opt_in);

create policy "Create own profile"
on public.guava_profiles for insert to authenticated
with check (user_id = (select auth.uid()));

create policy "Update own profile"
on public.guava_profiles for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "Delete own profile"
on public.guava_profiles for delete to authenticated
using (user_id = (select auth.uid()));
;
