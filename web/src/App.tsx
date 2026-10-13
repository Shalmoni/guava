import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, ChevronDown, Compass, Flag, Globe2, Layers3,
  LocateFixed, Map as MapIcon, Mountain, Navigation, Play, Search,
  Settings, Square, Trophy, UserRound, X, Minus, Plus, Route, Timer,
} from 'lucide-react';
import GuavaMap from './GuavaMap';
import {
  distanceMeters, finishTrip, fmtClock, fmtDistance, fmtTime, ISRAEL_CENTER,
  loadTrips, routeFromOSRM, saveTrips, tripUnits,
} from './model';
import type { DrivePoint, DrivingRoute, MapView, Point, RoadScope, Trip } from './model';
import { demoRound, sortedDemoLeaderboard, territoryScores, type DriverId, type RoadPiece } from './game';
import { loadDemoRoads } from './demo';
import { isSupabaseConfigured, signInWithGoogle, supabase } from './supabase';
import type { User } from '@supabase/supabase-js';

type Panel = 'none' | 'drive' | 'tools' | 'maps' | 'search' | 'profile' | 'settings' | 'leaderboard' | 'recap';
type Place = { name: string; detail: string; position: Point };
type LiveDrive = { startedAt: number; points: DrivePoint[]; distance: number; height: number; altitudeAnchor: number | null };
const mapViews: MapView[] = ['Regular', 'Satellite', 'Territory', 'Road Pulse', 'Altitude'];
const hasSatellite = Boolean(import.meta.env.VITE_MAPTILER_KEY);

function placeName(properties: Record<string, string>): string {
  return properties.name || properties.street || properties.city || 'Place';
}

function statValue(value: number, suffix = '') {
  return `${Math.round(value).toLocaleString()}${suffix}`;
}

export default function App() {
  const [view, setView] = useState<MapView>('Regular');
  const [roadScope, setRoadScope] = useState<RoadScope>('Everybody');
  const [panel, setPanel] = useState<Panel>('none');
  const [position, setPosition] = useState<Point | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [altitude, setAltitude] = useState<number | null>(null);
  const [locationError, setLocationError] = useState('');
  const [trips, setTrips] = useState<Trip[]>(loadTrips);
  const [routeOptions, setRouteOptions] = useState<DrivingRoute[]>([]);
  const [selectedRoute, setSelectedRoute] = useState(0);
  const [destination, setDestination] = useState<Place | null>(null);
  const [searchText, setSearchText] = useState('');
  const [suggestions, setSuggestions] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [routing, setRouting] = useState(false);
  const [error, setError] = useState('');
  const [driving, setDriving] = useState(false);
  const [live, setLive] = useState<LiveDrive | null>(null);
  const [driveMode, setDriveMode] = useState<'Navigation' | 'Game'>('Game');
  const [northUp, setNorthUp] = useState(false);
  const [zoomCommand, setZoomCommand] = useState(0);
  const [centerCommand, setCenterCommand] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [lastTrip, setLastTrip] = useState<Trip | null>(null);
  const [now, setNow] = useState(Date.now());
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [profileName, setProfileName] = useState(() => localStorage.getItem('guava.web.name') || 'Driver');
  const [leaderboardMetric, setLeaderboardMetric] = useState<'XP' | 'Distance' | 'Height' | 'Territory'>('XP');
  const [demoRoads, setDemoRoads] = useState<RoadPiece[][] | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [demoSettled, setDemoSettled] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoFocusCommand, setDemoFocusCommand] = useState(0);
  const driveRef = useRef<LiveDrive | null>(null);
  const stepRef = useRef(0);
  const lastPositionRef = useRef<Point | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    void supabase.auth.getUser().then(({ data }) => { if (alive) setAuthUser(data.user); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => setAuthUser(session?.user || null));
    return () => { alive = false; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationError('This browser does not support location.');
      return;
    }
    const watcher = navigator.geolocation.watchPosition(fix => {
      const next: Point = [fix.coords.longitude, fix.coords.latitude];
      setPosition(next);
      lastPositionRef.current = next;
      if (fix.coords.heading != null && Number.isFinite(fix.coords.heading)) setHeading(fix.coords.heading);
      if (fix.coords.altitude != null && fix.coords.altitudeAccuracy != null && fix.coords.altitudeAccuracy <= 35) setAltitude(fix.coords.altitude);
      setLocationError('');
      const current = driveRef.current;
      if (!current || fix.coords.accuracy > 50) return;
      const previous = current.points.at(-1);
      const movement = previous ? distanceMeters(previous.position, next) : 0;
      if (previous && (movement < 5 || movement > 300)) return;
      const sample: DrivePoint = { position: next, timestamp: fix.timestamp, altitude: fix.coords.altitudeAccuracy != null && fix.coords.altitudeAccuracy <= 30 ? fix.coords.altitude : null };
      let height = current.height;
      let altitudeAnchor = current.altitudeAnchor;
      if (sample.altitude != null) {
        if (altitudeAnchor != null && Math.abs(sample.altitude - altitudeAnchor) >= 3) {
          height += Math.abs(sample.altitude - altitudeAnchor);
          altitudeAnchor = sample.altitude;
        } else if (altitudeAnchor == null) altitudeAnchor = sample.altitude;
      }
      const updated = { ...current, points: [...current.points, sample], distance: current.distance + movement, height, altitudeAnchor };
      driveRef.current = updated;
      setLive(updated);
    }, () => setLocationError('Allow location to navigate and record a drive.'), {
      enableHighAccuracy: true, maximumAge: 2000, timeout: 15000,
    });
    return () => navigator.geolocation.clearWatch(watcher);
  }, []);

  useEffect(() => {
    if (altitude != null || !position) return;
    let cancelled = false;
    const controller = new AbortController();
    fetch(`https://api.open-meteo.com/v1/elevation?latitude=${position[1].toFixed(4)}&longitude=${position[0].toFixed(4)}`, { signal: controller.signal })
      .then(result => result.json())
      .then(data => { if (!cancelled && typeof data.elevation?.[0] === 'number') setAltitude(data.elevation[0]); })
      .catch(() => {});
    return () => { cancelled = true; controller.abort(); };
  }, [position && `${position[0].toFixed(3)},${position[1].toFixed(3)}`, altitude]);

  useEffect(() => {
    if (panel !== 'search' || searchText.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const center = lastPositionRef.current || ISRAEL_CENTER;
        const url = new URL('https://photon.komoot.io/api/');
        url.searchParams.set('q', searchText.trim());
        url.searchParams.set('limit', '6');
        url.searchParams.set('lat', String(center[1]));
        url.searchParams.set('lon', String(center[0]));
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error('Search is unavailable right now.');
        const data = await response.json() as { features: Array<{ geometry: { coordinates: Point }; properties: Record<string, string> }> };
        setSuggestions(data.features.map(item => ({
          name: placeName(item.properties),
          detail: [item.properties.street, item.properties.city, item.properties.state].filter(Boolean).join(' · '),
          position: item.geometry.coordinates,
        })));
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Search failed.');
      } finally { if (!controller.signal.aborted) setSearching(false); }
    }, 550);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [searchText, panel]);

  async function chooseDestination(place: Place) {
    if (!position) { setError('Allow location first so Guava can route from where you are.'); return; }
    setDestination(place);
    setSearchText(place.name);
    setSuggestions([]);
    setRouting(true);
    try {
      const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${position[0]},${position[1]};${place.position[0]},${place.position[1]}?overview=full&geometries=geojson&steps=true&alternatives=true`);
      if (!response.ok) throw new Error('Routing is unavailable right now.');
      const routes = routeFromOSRM(await response.json());
      setRouteOptions(routes);
      setSelectedRoute(0);
      setPanel('search');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not calculate route.'); }
    finally { setRouting(false); }
  }

  function startDrive() {
    if (!position) { setError('Allow location to start a drive.'); return; }
    const start: LiveDrive = {
      startedAt: Date.now(),
      points: [{ position, altitude, timestamp: Date.now() }],
      distance: 0, height: 0, altitudeAnchor: altitude,
    };
    driveRef.current = start;
    setLive(start);
    setDriving(true);
    setDriveMode(routeOptions.length ? 'Navigation' : 'Game');
    setStepIndex(0); stepRef.current = 0;
    setPanel('none');
    setCenterCommand(value => value + 1);
  }

  function endDrive(save: boolean) {
    const current = driveRef.current;
    driveRef.current = null;
    setDriving(false);
    setLive(null);
    setPanel('none');
    if (save && current) {
      const trip = finishTrip(current.points, current.startedAt, current.distance, current.height, trips, destination?.name);
      if (trip) {
        const updated = [trip, ...trips].slice(0, 100);
        setTrips(updated); saveTrips(updated); setLastTrip(trip); setPanel('recap');
      } else setError('Drive was under 50 metres, so no progress was saved.');
    }
    setRouteOptions([]); setDestination(null); setSearchText('');
  }

  function clearRoute() {
    setRouteOptions([]); setDestination(null); setSearchText(''); setSuggestions([]); setPanel('none');
  }

  const selected = routeOptions[selectedRoute];
  const currentStep = selected?.steps[stepIndex];
  if (driving && currentStep && position && distanceMeters(position, currentStep.maneuver) < 35 && stepIndex < selected.steps.length - 1) {
    // Advancing a cue is best-effort in the web preview, not robust map matching.
    const following = stepIndex + 1;
    if (stepRef.current !== following) {
      stepRef.current = following;
      queueMicrotask(() => setStepIndex(following));
    }
  }
  const remaining = selected && live ? Math.max(0, selected.distance - live.distance) : selected?.distance || 0;
  const estimatedSeconds = selected && live ? Math.max(0, selected.duration * remaining / selected.distance) : selected?.duration || 0;
  const driveSeconds = live ? (now - live.startedAt) / 1000 : 0;
  const totalDistance = trips.reduce((sum, trip) => sum + trip.distanceMeters, 0);
  const totalHeight = trips.reduce((sum, trip) => sum + trip.heightMeters, 0);
  const totalXP = trips.reduce((sum, trip) => sum + trip.xp, 0);
  const totalTime = trips.reduce((sum, trip) => sum + (trip.endedAt - trip.startedAt), 0);
  const highestAltitude = trips.reduce((top, trip) => trip.points.reduce((inner, point) => Math.max(inner, point.altitude ?? -Infinity), top), -Infinity);
  const totalUnits = new Set(trips.flatMap(trip => [...tripUnits(trip.points)])).size;
  const localRoadUnits = live ? tripUnits(live.points).size : 0;
  const demoResult = useMemo(() => demoRoads ? demoRound(demoRoads, demoSettled) : null, [demoRoads, demoSettled]);
  const demoTerritory = useMemo(() => {
    if (!demoMode || !demoRoads || !demoResult) return null;
    const lines: Record<DriverId | 'contested', Point[][]> = { you: [], maya: [], noam: [], contested: [] };
    for (const piece of demoRoads.flat()) {
      const owner = demoResult.owners.get(piece.unitId) || 'contested';
      lines[owner].push(piece.line);
    }
    return lines;
  }, [demoMode, demoRoads, demoResult]);
  const localMetric = leaderboardMetric === 'XP' ? `${totalXP.toLocaleString()} XP`
    : leaderboardMetric === 'Distance' ? fmtDistance(totalDistance)
      : leaderboardMetric === 'Height' ? `${Math.round(totalHeight)} m` : `${Math.round(totalUnits * 25)} m`;
  const demoRankings = demoResult ? sortedDemoLeaderboard(leaderboardMetric, demoResult.owners) : [];

  async function openGameLab() {
    if (!demoRoads) {
      setDemoLoading(true);
      try { setDemoRoads(await loadDemoRoads()); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load demo.'); setDemoLoading(false); return; }
      setDemoLoading(false);
    }
    setDemoMode(true);
    setDemoSettled(false);
  }

  function viewDemoMap() {
    setDemoMode(true);
    setView('Territory');
    setPanel('none');
    setDemoFocusCommand(value => value + 1);
  }

  async function googleSignIn() {
    setAuthBusy(true);
    try { await signInWithGoogle(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in failed.'); setAuthBusy(false); }
  }

  async function signOut() {
    if (!supabase) return;
    setAuthBusy(true);
    const { error: authError } = await supabase.auth.signOut();
    setAuthBusy(false);
    if (authError) setError(authError.message);
  }

  return <div className="app-shell">
    <GuavaMap view={view} roadScope={roadScope} trips={trips} livePoints={live?.points || []}
      routes={routeOptions} selectedRoute={selectedRoute} position={position} heading={heading}
      isDriving={driving} northUp={northUp} zoomCommand={zoomCommand} centerCommand={centerCommand}
      demoTerritory={demoTerritory} demoFocusCommand={demoFocusCommand} />

    {demoMode && view === 'Territory' && !driving && <button className="demo-map-tag" onClick={() => setPanel('leaderboard')}>GAME LAB · {demoSettled ? 'ROUND SETTLED' : 'ROUND IN PROGRESS'} · View scores</button>}

    <div className="top-row">
      {!driving && <div className="brand-pill"><span className="brand-dot" />Guava <span className="brand-tag">WEB PREVIEW</span></div>}
      {!driving && <button className="round-control profile-control" onClick={() => setPanel('profile')} aria-label="Profile"><UserRound size={23} /></button>}
    </div>

    {driving && selected && <div className="turn-banner">
      <div className="turn-icon">{currentStep?.modifier?.includes('left') ? <ArrowLeft /> : currentStep?.modifier?.includes('right') ? <ArrowRight /> : <Navigation />}</div>
      <div><small>UP NEXT</small><strong>{currentStep?.instruction || 'Continue on route'}</strong></div>
    </div>}

    {view === 'Road Pulse' && !driving && <div className="scope-card">
      <div className="segmented">{(['Everybody', 'Mine'] as RoadScope[]).map(scope => <button key={scope} className={roadScope === scope ? 'selected' : ''} onClick={() => setRoadScope(scope)}>{scope}</button>)}</div>
      <small>{roadScope === 'Everybody' ? 'Community road use is not connected yet.' : trips.length ? 'Repeated drives make roads darker.' : 'Finish a drive to see your road use.'}</small>
    </div>}

    {view === 'Altitude' && <div className="altitude-pill"><Mountain size={15} /> {altitude == null ? '— m' : `${Math.round(altitude)} m`} <small>altitude</small></div>}

    <div className="map-controls">
      <div className="zoom-stack">
        <button onClick={() => setZoomCommand(value => Math.abs(value) + 1)} aria-label="Zoom in"><Plus size={23} /></button>
        <button onClick={() => setZoomCommand(value => -Math.abs(value) - 1)} aria-label="Zoom out"><Minus size={23} /></button>
      </div>
      <button className="round-control" onClick={() => { setNorthUp(value => !value); setCenterCommand(value => value + 1); }} aria-label="Center and change orientation"><LocateFixed size={21} /></button>
    </div>

    {!driving && panel === 'none' && <div className="bottom-actions">
      <button className="large-play" onClick={() => setPanel('drive')} aria-label="Start a drive"><Play fill="currentColor" size={30} /></button>
      <button className="round-control tools-control" onClick={() => setPanel('tools')} aria-label="Maps and leaderboard"><Layers3 size={25} /></button>
    </div>}

    {!driving && panel === 'drive' && <div className="bubble-menu left-menu">
      <button onClick={() => { setRouteOptions([]); setDestination(null); startDrive(); }}><span><Navigation size={20} /></span>Quick Start</button>
      <button onClick={() => { setPanel('search'); setSearchText(''); }}><span><Search size={20} /></span>Plan Drive</button>
      <button className="bubble-anchor" onClick={() => setPanel('none')} aria-label="Close drive menu"><X size={24} /></button>
    </div>}

    {!driving && panel === 'tools' && <div className="bubble-menu right-menu">
      <button onClick={() => setPanel('leaderboard')}>Leaderboard<span><Trophy size={20} /></span></button>
      <button onClick={() => setPanel('maps')}>Maps<span><Layers3 size={20} /></span></button>
      <button className="bubble-anchor" onClick={() => setPanel('none')} aria-label="Close tools menu"><X size={24} /></button>
    </div>}

    {!driving && panel === 'search' && <div className="planner-card">
      <div className="planner-heading"><strong>Plan Drive</strong><button onClick={clearRoute} aria-label="Close search"><X size={19} /></button></div>
      {!selected && <>
        <div className="search-field"><Search size={20} /><input value={searchText} onChange={event => setSearchText(event.target.value)} placeholder="Where to?" autoFocus /></div>
        <div className="search-results">{searching && <small>Searching places…</small>}{suggestions.map((place, index) => <button key={`${place.name}-${index}`} onClick={() => chooseDestination(place)}><span><strong>{place.name}</strong><small>{place.detail}</small></span><Navigation size={16} /></button>)}</div>
        {!searchText && <p className="hint">Search for a destination, or use Quick Start for a free drive.</p>}
      </>}
      {routing && <p className="hint">Finding a road route…</p>}
      {selected && <>
        <div className="destination-title"><Flag size={19} /><div><strong>{destination?.name}</strong><small>{fmtTime(selected.duration)} · {fmtDistance(selected.distance)}</small></div></div>
        {routeOptions.length > 1 && <div className="route-options">{routeOptions.map((route, index) => <button key={index} className={selectedRoute === index ? 'selected' : ''} onClick={() => setSelectedRoute(index)}>{index === 0 ? 'Fastest' : `Option ${index + 1}`}<small>{fmtTime(route.duration)}</small></button>)}</div>}
        <div className="planner-footer"><small>Preview routing · no live traffic</small><button className="pink-button" onClick={startDrive}><Play size={17} fill="currentColor" />Start</button></div>
      </>}
    </div>}

    {driving && <div className="drive-dock">
      <div className="dock-top"><span className="driving-status"><span /> DRIVE ACTIVE</span><span>{destination?.name || 'Quick Start'}</span></div>
      <div className="dock-metrics">
        {driveMode === 'Navigation' && selected ? <>
          <div><strong>{fmtTime(estimatedSeconds)}</strong><small>REMAINING</small></div>
          <div><strong>{fmtDistance(remaining)}</strong><small>TO GO</small></div>
          <div><strong>{fmtClock(now + estimatedSeconds * 1000)}</strong><small>ARRIVAL</small></div>
        </> : <>
          <div><strong>{fmtTime(driveSeconds)}</strong><small>TIME</small></div>
          <div><strong>{fmtDistance(live?.distance || 0)}</strong><small>DISTANCE</small></div>
          <div><strong>{statValue(live?.height || 0, ' m')}</strong><small>HEIGHT</small></div>
          <div><strong>{fmtDistance(localRoadUnits * 25)}</strong><small>ROAD*</small></div>
        </>}
      </div>
      <div className="dock-footer">
        <button className="dock-stop" onClick={() => setPanel('drive')} aria-label="End drive"><Square size={16} fill="currentColor" /></button>
        {selected && <button className="dock-mode" onClick={() => setDriveMode(value => value === 'Navigation' ? 'Game' : 'Navigation')}>{driveMode === 'Navigation' ? 'Game view' : 'Navigation view'} <ChevronDown size={16} /></button>}
        <button className="dock-map" onClick={() => setPanel('maps')}><Layers3 size={17} /> Map</button>
      </div>
    </div>}

    {panel === 'maps' && <div className="sheet-backdrop" onClick={() => setPanel('none')}><section className="bottom-sheet map-sheet" onClick={event => event.stopPropagation()}>
      <div className="sheet-header"><h2>Change your world</h2><button onClick={() => setPanel('none')} aria-label="Close"><X size={22} /></button></div>
      <p>Switch views anytime. Everything in this preview is free.</p>
      <div className="view-list">{mapViews.map(option => <button key={option} disabled={option === 'Satellite' && !hasSatellite} className={view === option ? 'active' : ''} onClick={() => { setView(option); setPanel('none'); }}>
        <span className="view-icon">{option === 'Altitude' ? <Mountain /> : option === 'Road Pulse' ? <Route /> : option === 'Satellite' ? <Globe2 /> : option === 'Territory' ? <Flag /> : <MapIcon />}</span>
        <span><strong>{option}</strong><small>{option === 'Satellite' && !hasSatellite ? 'Imagery provider not connected yet' : option === 'Road Pulse' ? 'How often roads are used' : option === 'Territory' ? 'Painted roads and future daily ownership' : option === 'Altitude' ? 'Elevation colors and current altitude' : option === 'Regular' ? 'Everyday road map' : 'Imagery from above'}</small></span>
        {view === option && <span className="selected-mark">✓</span>}
      </button>)}</div>
    </section></div>}

    {panel === 'drive' && driving && <div className="sheet-backdrop" onClick={() => setPanel('none')}><section className="bottom-sheet" onClick={event => event.stopPropagation()}>
      <div className="sheet-header"><h2>End this drive?</h2><button onClick={() => setPanel('none')} aria-label="Close"><X size={22} /></button></div>
      <p>Save your progress after parking. A drive under 50 metres earns nothing.</p>
      <button className="sheet-action pink-button" onClick={() => endDrive(true)}>Finish & Save</button>
      <button className="sheet-action subtle-action" onClick={() => endDrive(false)}>Discard Drive</button>
      <button className="sheet-action text-action" onClick={() => setPanel('none')}>Keep Driving</button>
    </section></div>}

    {panel === 'profile' && <div className="full-screen-panel"><div className="full-header"><button onClick={() => setPanel('none')} aria-label="Close profile"><X /></button><h2>Profile</h2><button onClick={() => setPanel('settings')} aria-label="Settings"><Settings size={20} /></button></div>
      <div className="profile-body"><div className="xp-card"><div className="xp-topline"><small>GUAVA XP</small><small>LEVEL {Math.floor(totalXP / 500) + 1}</small></div><strong>{totalXP.toLocaleString()}</strong><div className="xp-track"><span style={{ width: `${totalXP % 500 / 5}%` }} /></div><span>{500 - totalXP % 500} XP to next level</span></div>
      <div className="identity-card"><div className="avatar"><UserRound /></div><div><strong>{authUser?.user_metadata?.name || profileName}</strong><small>{authUser ? 'Signed in · cloud progress not connected yet' : 'Local profile · this browser'}</small></div></div>
      <div className="stats-grid"><div><Navigation /><small>Total distance</small><strong>{fmtDistance(totalDistance)}</strong></div><div><Timer /><small>Drive time</small><strong>{fmtTime(totalTime / 1000)}</strong></div><div><Mountain /><small>Height traveled</small><strong>{fmtDistance(totalHeight)}</strong></div><div><Flag /><small>Road explored*</small><strong>{fmtDistance(totalUnits * 25)}</strong></div></div>
      <h3>Personal insights</h3><div className="stats-grid"><div><Navigation /><small>Average speed</small><strong>{totalTime > 0 ? `${Math.round(totalDistance / (totalTime / 1000) * 3.6)} km/h` : '—'}</strong></div><div><Mountain /><small>Highest altitude</small><strong>{Number.isFinite(highestAltitude) ? `${Math.round(highestAltitude)} m` : '—'}</strong></div></div>
      <h3>Recent drives</h3>{trips.length ? trips.slice(0, 8).map(trip => <div className="history-row" key={trip.id}><span><strong>{trip.destination || 'Quick Start'}</strong><small>{new Date(trip.endedAt).toLocaleDateString()} · {fmtDistance(trip.distanceMeters)} · {fmtTime((trip.endedAt - trip.startedAt) / 1000)} · {Math.round(trip.heightMeters)} m height</small></span><strong>+{trip.xp} XP</strong></div>) : <p className="empty-note">Your finished drives will appear here.</p>}
      <p className="privacy-note">Location and drives stay in this browser for now. There is no account or shared leaderboard yet. Browser recording may stop if the screen locks or the tab closes. *Road explored is a local estimate, not competitive ownership.</p></div>
    </div>}

    {panel === 'settings' && <div className="full-screen-panel"><div className="full-header"><button onClick={() => setPanel('profile')} aria-label="Back to profile"><ArrowLeft /></button><h2>Settings</h2><span /></div><div className="profile-body">
      <h3>Account</h3><label className="settings-label">Display name<input value={profileName} maxLength={32} onChange={event => { setProfileName(event.target.value); localStorage.setItem('guava.web.name', event.target.value); }} /></label>
      {authUser ? <><p className="empty-note">Signed in as {authUser.email}. Your local drives are not yet uploaded.</p><button className="subtle-action sheet-action" disabled={authBusy} onClick={() => void signOut()}>Sign out</button></> : isSupabaseConfigured ? <button className="pink-button sheet-action" disabled={authBusy} onClick={() => void googleSignIn()}>{authBusy ? 'Connecting…' : 'Continue with Google'}</button> : <p className="empty-note">Google sign-in awaits Guava’s separate Supabase project. You can still test the map and local progress.</p>}
      <h3>Navigation & privacy</h3><p className="privacy-note">Guava requests location while its web page is open. It records a trip only after you tap Start, and you choose Save or Discard when ending it. The web preview stores GPS samples in this browser; no drive is uploaded to a community server yet. Browser recording may pause when locked or backgrounded.</p>
      <button className="subtle-action sheet-action" onClick={() => { const blob = new Blob([JSON.stringify(trips, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'guava-drives.json'; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Export my local drives</button>
    </div></div>}

    {panel === 'leaderboard' && <div className="full-screen-panel"><div className="full-header"><button onClick={() => setPanel('none')}><X /></button><h2>Leaderboard</h2><Trophy size={20} /></div><div className="profile-body">
      <div className="leaderboard-categories">{(['XP', 'Distance', 'Height', 'Territory'] as const).map(metric => <button key={metric} className={leaderboardMetric === metric ? 'active' : ''} onClick={() => setLeaderboardMetric(metric)}>{metric === 'Height' ? 'Height Traveled' : metric}</button>)}</div>
      {!demoMode ? <>
        <div className="xp-card score-card"><small>YOUR LOCAL {leaderboardMetric.toUpperCase()}</small><strong>{localMetric}</strong><span>Recorded on this browser. Shared rankings are not live yet.</span></div>
        <p className="empty-note">To review how Guava’s competition will feel before accounts are connected, open the separate test round below. Its other drivers are simulations, not real users.</p>
        <button className="pink-button sheet-action" disabled={demoLoading} onClick={() => void openGameLab()}>{demoLoading ? 'Loading real road geometry…' : 'Open game lab'}</button>
      </> : <>
        <div className="lab-warning"><strong>TEST SIMULATION · NOT LIVE SCORES</strong><span>Three sample drivers on actual road geometry near Harish. Nothing here is published to the community.</span></div>
        <div className="round-clock"><span>SIMULATED 24-HOUR UTC ROUND</span><strong>{demoSettled ? 'Day 2 · 00:05 · settled' : 'Day 1 · 00:00–24:00'}</strong><small>{demoSettled ? 'Winner owns each road unit; tied units are unclaimed.' : 'These are provisional leaders. More drives may change each road before the 00:05 settlement.'}</small></div>
        <div className="demo-podium">{demoRankings.slice(0, 3).map((entry, index) => <div key={entry.id}><span className="podium-rank">{index + 1}</span><span className="podium-avatar" style={{ background: entry.color }}>{entry.name[0]}</span><strong>{entry.name}</strong><small>{leaderboardMetric === 'Distance' ? `${entry.value.toFixed(1)} km` : leaderboardMetric === 'XP' ? `${entry.value} XP` : `${entry.value} m`}</small></div>)}</div>
        <div className="ranking-list">{demoRankings.map((entry, index) => <div key={entry.id}><b>{index + 1}</b><span className="ranking-dot" style={{ background: entry.color }} /><strong>{entry.name}</strong><span>{leaderboardMetric === 'Distance' ? `${entry.value.toFixed(1)} km` : leaderboardMetric === 'XP' ? `${entry.value} XP` : `${entry.value} m`}</span></div>)}</div>
        {leaderboardMetric === 'Territory' && demoResult && <p className="empty-note">{demoResult.contested.size} contested road units · {Object.values(territoryScores(demoResult.owners)).reduce((a, b) => a + b, 0)} m currently owned</p>}
        <button className="pink-button sheet-action" onClick={() => setDemoSettled(value => !value)}>{demoSettled ? 'Reset to before settlement' : 'Advance to Day 2, 00:05 & settle'}</button>
        <button className="subtle-action sheet-action" onClick={viewDemoMap}>View territory map</button>
        <button className="text-action sheet-action" onClick={() => setDemoMode(false)}>Leave game lab</button>
      </>}
    </div></div>}

    {panel === 'recap' && lastTrip && <div className="full-screen-panel"><div className="full-header"><button onClick={() => setPanel('none')}><X /></button><h2>Drive complete</h2><Flag size={20} /></div><div className="profile-body">
      <div className="xp-card"><small>YOU EARNED</small><strong>+{lastTrip.xp} XP</strong><span>{lastTrip.destination || 'Quick Start'} · {fmtClock(lastTrip.endedAt)}</span></div>
      <div className="stats-grid"><div><Navigation /><small>Distance</small><strong>{fmtDistance(lastTrip.distanceMeters)}</strong></div><div><Timer /><small>Time</small><strong>{fmtTime((lastTrip.endedAt - lastTrip.startedAt) / 1000)}</strong></div><div><Mountain /><small>Height</small><strong>{fmtDistance(lastTrip.heightMeters)}</strong></div><div><Flag /><small>New road*</small><strong>{fmtDistance(lastTrip.newRoadUnits * 25)}</strong></div></div>
      <p className="privacy-note">Saved on this device only. *Road is approximate local exploration, not an awarded community territory claim.</p>
      <button className="pink-button sheet-action" onClick={() => setPanel('none')}>Back to map</button>
    </div></div>}

    {error && <div className="error-toast" role="alert"><span>{error}</span><button onClick={() => setError('')}><X size={16} /></button></div>}
    {locationError && !position && <div className="location-note"><Compass size={17} /> {locationError}</div>}
  </div>;
}
