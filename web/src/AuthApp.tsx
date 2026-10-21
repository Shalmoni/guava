import { lazy, Suspense, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { isSupabaseConfigured, signInWithGoogle, supabase } from './supabase';

const requiresAccount = import.meta.env.VITE_REQUIRE_AUTH === 'true';
const PlayerApp = lazy(() => import('./App'));

export default function AuthApp() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!supabase);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    let authEventReceived = false;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      authEventReceived = true;
      if (alive) { setUser(session?.user || null); setReady(true); setBusy(false); }
    });
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!alive || authEventReceived) return;
      setUser(data.session?.user || null);
      setReady(true);
      if (sessionError) setError('Your session could not be restored. Please sign in again.');
    }).catch(() => {
      if (alive && !authEventReceived) { setReady(true); setError('Could not restore your session.'); }
    });
    return () => { alive = false; subscription.unsubscribe(); };
  }, []);

  if (!ready || (requiresAccount && !user)) {
    return <main className="signin-screen"><div className="signin-card">
      <div className="signin-brand"><img className="brand-logo" src={`${import.meta.env.BASE_URL}guava-logo.png`} alt="" />Guava</div>
      <h1>Your roads.<br />Your progress.</h1>
      <p>Keep track of your drives. Join the community when you want to compete for roads.</p>
      {!ready ? <p className="signin-wait" role="status">Checking your session…</p>
        : isSupabaseConfigured ? <button className="pink-button" disabled={busy} onClick={() => {
          setBusy(true); setError('');
          void signInWithGoogle().catch(cause => {
            setError(cause instanceof Error ? cause.message : 'Sign-in failed.'); setBusy(false);
          });
        }}>{busy ? 'Connecting…' : 'Continue with Google'}</button>
          : <p role="alert">Sign-in is unavailable. Please try again later.</p>}
      {error && <p className="signin-error" role="alert">{error}</p>}
      <p className="signin-privacy"><a href={`${import.meta.env.BASE_URL}privacy.html`} target="_blank" rel="noreferrer">Privacy & driving safety</a></p>
    </div></main>;
  }
  // Changing identity unmounts all private state and cancels its UI callbacks.
  return <Suspense fallback={<main className="signin-screen"><p role="status">Opening your map…</p></main>}>
    <PlayerApp key={user?.id || 'local'} authUser={user} />
  </Suspense>;
}
