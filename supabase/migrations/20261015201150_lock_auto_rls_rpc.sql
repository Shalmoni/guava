-- Supabase's automatic-RLS trigger function is SECURITY DEFINER. It should
-- still run as an event trigger, but never be callable through the Data API.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
