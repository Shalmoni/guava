import { lazy, Suspense, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { isSupabaseConfigured, signInWithGoogle, supabase } from './supabase';
import { enterGuest, guestIsActive, leaveGuest, savedGuestName, saveGuestName } from './guest';

const requiresAccount = import.meta.env.VITE_REQUIRE_AUTH === 'true';
const PlayerApp = lazy(() => import('./App'));

export default function AuthApp() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!supabase);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [guestName, setGuestName] = useState(() => savedGuestName());
  const [guestActive, setGuestActive] = useState(() => guestIsActive());
  const [guestSetup, setGuestSetup] = useState(false);
  const [guestDraftName, setGuestDraftName] = useState(() => savedGuestName());
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

  if (!ready || (requiresAccount && !user && !guestActive)) {
    return <main className="signin-screen"><div className="signin-card">
      <div className="signin-brand"><img className="brand-logo" src={`${import.meta.env.BASE_URL}guava-logo.png`} alt="" />Guava</div>
      <h1>{guestSetup ? 'What should we call you?' : <>Your roads.<br />Your progress.</>}</h1>
      <p>{guestSetup ? 'Try Guava without Google. Your name and drives stay in this browser; guests cannot appear on the leaderboard or capture territory.' : 'Keep track of your drives. Join the community when you want to compete for roads.'}</p>
      {!ready ? <p className="signin-wait" role="status">Checking your session…</p> : guestSetup ? <form onSubmit={event => {
          event.preventDefault();
          try { setGuestName(enterGuest(guestDraftName)); setGuestActive(true); setError(''); }
          catch { setError('This browser could not save guest progress. Check its storage settings or use Google sign-in.'); }
        }}>
        <label className="settings-label guest-name-field">Username<input value={guestDraftName} maxLength={32} autoComplete="nickname" autoFocus placeholder="Your name on this device" onChange={event => setGuestDraftName(event.target.value)} /></label>
        <button className="pink-button" type="submit" disabled={!guestDraftName.trim()}>Continue as guest</button>
        <button className="subtle-action signin-back" type="button" onClick={() => { setGuestSetup(false); setError(''); }}>Back to sign-in choices</button>
      </form>
        : isSupabaseConfigured ? <button className="pink-button" disabled={busy} onClick={() => {
          setBusy(true); setError('');
          void signInWithGoogle().catch(cause => {
            setError(cause instanceof Error ? cause.message : 'Sign-in failed.'); setBusy(false);
          });
        }}>{busy ? 'Connecting…' : 'Continue with Google'}</button>
          : <p role="alert">Sign-in is unavailable. Please try again later.</p>}
      {ready && !guestSetup && <button className="subtle-action signin-back" onClick={() => { setGuestSetup(true); setError(''); }}>Try as guest</button>}
      {error && <p className="signin-error" role="alert">{error}</p>}
      <p className="signin-privacy"><a href={`${import.meta.env.BASE_URL}privacy.html`} target="_blank" rel="noreferrer">Privacy & driving safety</a></p>
    </div></main>;
  }
  // Changing identity unmounts all private state and cancels its UI callbacks.
  return <Suspense fallback={<main className="signin-screen"><p role="status">Opening your map…</p></main>}>
    <PlayerApp key={user?.id || 'local'} authUser={user} guestMode={!user && guestActive} guestName={guestName}
      onGuestNameChange={name => { const saved = saveGuestName(name); setGuestName(saved); }}
      onExitGuest={() => { leaveGuest(); setGuestActive(false); setGuestSetup(false); }} />
  </Suspense>;
}
