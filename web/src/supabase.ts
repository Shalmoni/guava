import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && publishableKey && publishableKey.startsWith('sb_publishable_'));
export const supabase = isSupabaseConfigured
  ? createClient(url!, publishableKey!, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

export async function signInWithGoogle() {
  if (!supabase) throw new Error('Guava sign-in is not connected yet.');
  const redirectTo = new URL(import.meta.env.BASE_URL, window.location.origin).toString();
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) throw error;
}
