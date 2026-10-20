import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, ChevronDown, Compass, Flag, Layers3, Moon,
  LocateFixed, Map as MapIcon, Mountain, Navigation, Play, Search,
  Settings, Square, Trophy, UserRound, UsersRound, X, Minus, Plus, Route, Timer,
} from 'lucide-react';
import GuavaMap, { type TerritorySelection } from './GuavaMap';
import {
  distanceMeters, finishTrip, fmtClock, fmtDistance, fmtTime, ISRAEL_CENTER,
  loadTrips, routeFromOSRM, saveTrips, tripUnits,
} from './model';
import type { DrivePoint, DrivingRoute, MapView, Point, RoadScope, Trip } from './model';
import { isSupabaseConfigured, signInWithGoogle, supabase } from './supabase';
import { bankTerritorySegment, cloudPulseLayers, cloudRankings, cloudTerritoryLayers, loadCloudGame, uploadCommunityDrive, type CloudGame, type CloudProfile } from './cloud';
import { connectedTerritory, israelRoundRemaining, territoryAge } from './territory';
import { shownAltitude, trustedGpsAltitude, type TerrainSample } from './altitude';
import type { User } from '@supabase/supabase-js';

type Panel = 'none' | 'drive' | 'tools' | 'maps' | 'search' | 'profile' | 'settings' | 'leaderboard' | 'recap';
type Place = { name: string; detail: string; position: Point };
type LiveDrive = { id: string; startedAt: number; points: DrivePoint[]; distance: number; height: number; altitudeAnchor: number | null; share: boolean };
const mapViews: MapView[] = ['Regular', 'Dark', 'Territory', 'Road Pulse', 'Altitude'];
const requiresAccount = import.meta.env.VITE_REQUIRE_AUTH === 'true';
const privacyUrl = new URL(`${import.meta.env.BASE_URL}privacy.html`, window.location.origin).toString();

function placeName(properties: Record<string, string>): string {
  return properties.name || properties.street || properties.city || 'Place';
}

function statValue(value: number, suffix = '') {
  return `${Math.round(value).toLocaleString()}${suffix}`;
}

function liveTime(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

export default function App() {
  const [view, setView] = useState<MapView>('Regular');
  const [roadScope, setRoadScope] = useState<RoadScope>('Everybody');
  const [panel, setPanel] = useState<Panel>('none');
  const [position, setPosition] = useState<Point | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [gpsAltitude, setGpsAltitude] = useState<number | null>(null);
  const [terrainSample, setTerrainSample] = useState<TerrainSample | null>(null);
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
  const [authReady, setAuthReady] = useState(!requiresAccount);
  const [authBusy, setAuthBusy] = useState(false);
  const [profileName, setProfileName] = useState(() => localStorage.getItem('guava.web.name') || 'Driver');
  const [cloudProfile, setCloudProfile] = useState<CloudProfile | null>(null);
  const [cloudGame, setCloudGame] = useState<CloudGame | null>(null);
  const [cloudError, setCloudError] = useState('');
  const [territorySyncError, setTerritorySyncError] = useState('');
  const [connectionResult, setConnectionResult] = useState('');
  const [communityOptIn, setCommunityOptIn] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [dismissedLiveConsent, setDismissedLiveConsent] = useState(false);
  const [leaderboardMetric, setLeaderboardMetric] = useState<'XP' | 'Distance' | 'Height' | 'Territory'>('XP');
  const [selectedTerritory, setSelectedTerritory] = useState<TerritorySelection | null>(null);
  const driveRef = useRef<LiveDrive | null>(null);
  const stepRef = useRef(0);
  const lastPositionRef = useRef<Point | null>(null);
  const uploadingRef = useRef(new Set<string>());
  const territoryCheckpointRef = useRef({ sessionId: '', nextIndex: 0, busy: false });
  const elevationGrid = position ? `${(Math.round(position[0] * 2000) / 2000).toFixed(4)},${(Math.round(position[1] * 2000) / 2000).toFixed(4)}` : '';
  const gpsAltitudeAvailable = gpsAltitude != null;
  const altitude = shownAltitude(gpsAltitude, terrainSample, elevationGrid);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    void supabase.auth.getUser().then(({ data }) => {
      if (alive) { setAuthUser(data.user); setAuthReady(true); }
    }).catch(() => { if (alive) setAuthReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUser(session?.user || null);
      setAuthReady(true);
      setAuthBusy(false);
    });
    return () => { alive = false; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!supabase || !authUser) { setCloudProfile(null); setCommunityOptIn(false); return; }
    setCloudProfile(null);
    const client = supabase;
    const userId = authUser.id;
    let alive = true;
    async function loadCloudProfile() {
      const { error: createError } = await client.from('guava_profiles').insert({
        user_id: userId, display_name: (profileName.trim() || 'Driver').slice(0, 32),
      });
      if (createError && createError.code !== '23505') {
        if (alive) setError(`Could not create your profile: ${createError.message}`);
        return;
      }
      const { data, error: readError } = await client.from('guava_profiles')
        .select('user_id,display_name,community_opt_in,live_territory_consent_at,territory_detail_consent_at').eq('user_id', userId).single();
      if (!alive) return;
      if (readError) { setError(`Could not load your profile: ${readError.message}`); return; }
      const profile = data as CloudProfile;
      setCloudProfile(profile);
      setProfileName(profile.display_name);
      setCommunityOptIn(profile.community_opt_in);
      localStorage.setItem('guava.web.name', profile.display_name);
    }
    void loadCloudProfile();
    return () => { alive = false; };
  // The local name is read once when an account session starts; edits are saved explicitly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  useEffect(() => {
    if (!authUser) { setCloudGame(null); return; }
    let active = true;
    const refresh = async () => {
      try {
        const game = await loadCloudGame(authUser.id, Boolean(cloudProfile?.territory_detail_consent_at));
        if (active) { setCloudGame(game); setCloudError(''); }
      } catch (cause) {
        if (active) setCloudError(cause instanceof Error ? cause.message : 'Community data is unavailable.');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [authUser?.id, cloudProfile?.territory_detail_consent_at]);

  useEffect(() => {
    if (!authUser || !cloudProfile?.community_opt_in || !cloudProfile.territory_detail_consent_at) return;
    for (const trip of trips.filter(item => item.communityStatus === 'pending')) {
      if (uploadingRef.current.has(trip.id)) continue;
      uploadingRef.current.add(trip.id);
      void uploadCommunityDrive(trip).then(result => {
        setTrips(current => {
          const updated = current.map(item => item.id === trip.id
            ? { ...item, xp: result.xp, communityStatus: 'uploaded' as const } : item);
          saveTrips(updated);
          return updated;
        });
        setLastTrip(current => current?.id === trip.id
          ? { ...current, xp: result.xp, communityStatus: 'uploaded' } : current);
        void loadCloudGame(authUser.id, true).then(setCloudGame).catch(() => {});
      }).catch(cause => {
        setCloudError(cause instanceof Error ? cause.message : 'Could not share this drive.');
      }).finally(() => uploadingRef.current.delete(trip.id));
    }
  }, [authUser?.id, cloudProfile?.community_opt_in, cloudProfile?.territory_detail_consent_at, trips]);

  useEffect(() => {
    if (!driving || !live?.share || !authUser || !cloudProfile?.community_opt_in || !cloudProfile.live_territory_consent_at || !cloudProfile.territory_detail_consent_at) return;
    const timer = window.setInterval(() => {
      const current = driveRef.current;
      const checkpoint = territoryCheckpointRef.current;
      if (!current?.share || current.distance < 50 || checkpoint.busy || current.id !== checkpoint.sessionId) return;
      const end = Math.min(current.points.length, checkpoint.nextIndex + 40);
      const segment = current.points.slice(checkpoint.nextIndex, end);
      const segmentDistance = segment.reduce((sum, fix, index) =>
        index ? sum + distanceMeters(segment[index - 1].position, fix.position) : sum, 0);
      if (segment.length < 2 || segmentDistance < 10) return;
      checkpoint.busy = true;
      void bankTerritorySegment(current.id, current.startedAt, segment)
        .then(() => { checkpoint.nextIndex = end - 1; setTerritorySyncError(''); })
        .catch(cause => setTerritorySyncError(cause instanceof Error ? cause.message : 'Territory is waiting to sync.'))
        .finally(() => { checkpoint.busy = false; });
    }, 15000);
    return () => window.clearInterval(timer);
  }, [driving, live?.id, live?.share, authUser?.id, cloudProfile?.community_opt_in, cloudProfile?.live_territory_consent_at, cloudProfile?.territory_detail_consent_at]);

  useEffect(() => {
    if (authUser && cloudProfile && !cloudProfile.community_opt_in) setShowWelcome(localStorage.getItem(`guava.welcome.${authUser.id}`) !== 'done');
    else setShowWelcome(false);
  }, [authUser?.id, cloudProfile?.user_id]);

  useEffect(() => {
    if (requiresAccount && (!authUser || !cloudProfile || showWelcome
      || (!cloudProfile.community_opt_in && localStorage.getItem(`guava.welcome.${authUser.id}`) !== 'done'))) return;
    if (!navigator.geolocation) {
      setLocationError('This browser does not support location.');
      return;
    }
    const watcher = navigator.geolocation.watchPosition(fix => {
      const next: Point = [fix.coords.longitude, fix.coords.latitude];
      setPosition(next);
      lastPositionRef.current = next;
      if (fix.coords.heading != null && Number.isFinite(fix.coords.heading)) setHeading(fix.coords.heading);
      const deviceAltitude = trustedGpsAltitude(fix.coords.altitude, fix.coords.altitudeAccuracy);
      setGpsAltitude(deviceAltitude);
      setLocationError('');
      const current = driveRef.current;
      if (!current || fix.coords.accuracy > 50) return;
      const previous = current.points.at(-1);
      const movement = previous ? distanceMeters(previous.position, next) : 0;
      if (previous && (movement < 2 || movement > 300)) return;
      const sample: DrivePoint = { position: next, timestamp: fix.timestamp, altitude: deviceAltitude, accuracy: fix.coords.accuracy };
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
  }, [authUser?.id, cloudProfile?.user_id, cloudProfile?.community_opt_in, showWelcome]);

  useEffect(() => {
    if (gpsAltitudeAvailable || !elevationGrid) return;
    let cancelled = false;
    const controller = new AbortController();
    const [longitude, latitude] = elevationGrid.split(',');
    fetch(`https://api.open-meteo.com/v1/elevation?latitude=${latitude}&longitude=${longitude}`, { signal: controller.signal })
      .then(result => { if (!result.ok) throw new Error('Elevation unavailable'); return result.json(); })
      .then(data => { if (!cancelled && Number.isFinite(data.elevation?.[0])) setTerrainSample({ grid: elevationGrid, meters: data.elevation[0] }); })
      .catch(() => {});
    return () => { cancelled = true; controller.abort(); };
  }, [elevationGrid, gpsAltitudeAvailable]);

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
      id: crypto.randomUUID(),
      startedAt: Date.now(),
      points: [{ position, altitude: gpsAltitudeAvailable ? altitude : null, timestamp: Date.now() }],
      distance: 0, height: 0, altitudeAnchor: gpsAltitudeAvailable ? altitude : null,
      share: Boolean(authUser && cloudProfile?.community_opt_in && cloudProfile.live_territory_consent_at && cloudProfile.territory_detail_consent_at),
    };
    driveRef.current = start;
    territoryCheckpointRef.current = { sessionId: start.id, nextIndex: 0, busy: false };
    setTerritorySyncError('');
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
      const trip = finishTrip(current.points, current.startedAt, current.distance, current.height, trips, destination?.name, current.id);
      if (trip) {
        if (current.share && cloudProfile?.community_opt_in) trip.communityStatus = 'pending';
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
    // Advancing a cue is best-effort in the browser, not robust map matching.
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
  const liveTerritory = communityOptIn && cloudGame && authUser ? cloudTerritoryLayers(cloudGame, authUser.id) : null;
  const livePulse = communityOptIn && cloudGame ? cloudPulseLayers(cloudGame) : null;
  const selectedRoad = cloudGame?.roads.find(road => road.id === selectedTerritory?.unitId);
  const selectedTerritoryOwner = selectedRoad?.owner_id || null;
  const inspectedName = selectedTerritoryOwner === authUser?.id ? 'You'
    : cloudGame?.profiles.find(profile => profile.user_id === selectedTerritoryOwner)?.display_name || 'Driver';
  const connected = selectedRoad && cloudGame ? connectedTerritory(cloudGame.roads, selectedRoad.id) : null;
  const cloudScore = cloudGame?.scores.find(score => score.user_id === authUser?.id);
  const displayXP = communityOptIn ? cloudScore?.xp || 0 : totalXP;
  const liveRankings = communityOptIn && cloudGame && authUser ? cloudRankings(cloudGame, leaderboardMetric, authUser.id) : [];
  const liveRankValue = (value: number) => leaderboardMetric === 'XP' ? `${value.toLocaleString()} XP` : fmtDistance(value);
  const localMetric = leaderboardMetric === 'XP' ? `${totalXP.toLocaleString()} XP`
    : leaderboardMetric === 'Distance' ? fmtDistance(totalDistance)
      : leaderboardMetric === 'Height' ? `${Math.round(totalHeight)} m` : `${Math.round(totalUnits * 25)} m`;

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

  async function saveCloudProfile(nextOptIn = communityOptIn): Promise<boolean> {
    if (!supabase || !authUser || !cloudProfile) return false;
    const name = profileName.trim();
    if (!name || name.length > 32) { setError('Choose a name between 1 and 32 characters.'); return false; }
    if (cloudProfile.community_opt_in && !nextOptIn && !window.confirm('Leave community play? This removes your shared scores, drives and captured roads. Drives saved in this browser remain here.')) return false;
    setProfileBusy(true);
    const { data, error: profileError } = await supabase.from('guava_profiles')
      .update({ display_name: name, community_opt_in: nextOptIn,
        live_territory_consent_at: nextOptIn ? cloudProfile.live_territory_consent_at || new Date().toISOString() : null,
        territory_detail_consent_at: nextOptIn ? cloudProfile.territory_detail_consent_at || new Date().toISOString() : null })
      .eq('user_id', authUser.id).select('user_id,display_name,community_opt_in,live_territory_consent_at,territory_detail_consent_at').single();
    setProfileBusy(false);
    if (profileError) { setError(`Could not save your profile: ${profileError.message}`); return false; }
    setCloudProfile(data as CloudProfile);
    setCommunityOptIn(nextOptIn);
    localStorage.setItem('guava.web.name', name);
    if (cloudProfile.community_opt_in && !nextOptIn) setTrips(current => {
      const updated = current.map(trip => ({ ...trip, communityStatus: undefined }));
      saveTrips(updated);
      return updated;
    });
    void loadCloudGame(authUser.id, nextOptIn).then(setCloudGame).catch(cause => setCloudError(cause instanceof Error ? cause.message : 'Could not refresh community.'));
    return true;
  }

  function finishWelcome() {
    if (!authUser) return;
    localStorage.setItem(`guava.welcome.${authUser.id}`, 'done');
    setShowWelcome(false);
  }

  async function checkCommunityConnection() {
    if (!supabase) return;
    setConnectionResult('Checking…');
    const { data, error: checkError } = await supabase.functions.invoke('submit-drive', {
      body: { health: true },
    });
    setConnectionResult(checkError ? `Connection failed: ${checkError.message}`
      : data?.ok ? 'Connected. Your account can reach the game server.' : 'Unexpected response from game server.');
  }

  if (requiresAccount && (!authReady || !authUser)) return <main className="signin-screen">
    <div className="signin-card">
      <div className="signin-brand"><img className="brand-logo" src={`${import.meta.env.BASE_URL}guava-logo.png`} alt="" /> Guava</div>
      <h1>Let’s go.</h1>
      <p>Sign in to open your map.</p>
      {!authReady ? <p className="signin-wait">Checking your session…</p> : isSupabaseConfigured ?
        <button className="pink-button" disabled={authBusy} onClick={() => void googleSignIn()}>{authBusy ? 'Connecting…' : 'Continue with Google'}</button> :
        <p className="signin-wait">Sign-in is being set up. Please try again later.</p>}
      {error && <p className="signin-error" role="alert">{error}</p>}
      <p className="signin-privacy"><a href={privacyUrl} target="_blank" rel="noreferrer">Privacy & driving safety</a></p>
    </div>
  </main>;

  return <div className="app-shell">
    <GuavaMap view={view} roadScope={roadScope} trips={trips} livePoints={live?.points || []}
      routes={routeOptions} selectedRoute={selectedRoute} position={position} heading={heading}
      isDriving={driving} northUp={northUp} zoomCommand={zoomCommand} centerCommand={centerCommand}
      liveTerritory={liveTerritory} livePulse={livePulse}
      selectedTerritoryOwner={selectedTerritoryOwner}
      onTerritorySelect={setSelectedTerritory} />

    <div className="top-row">
      {!driving && <div className="brand-pill"><img className="brand-logo" src={`${import.meta.env.BASE_URL}guava-logo.png`} alt="" />Guava</div>}
      {!driving && <button className="round-control profile-control" onClick={() => setPanel('profile')} aria-label="Profile"><UserRound size={23} /></button>}
    </div>

    {view === 'Territory' && selectedRoad && !driving && <div className={`territory-inspector ${selectedTerritoryOwner === authUser?.id ? 'is-mine' : ''}`}>
      <div className="territory-inspector-head"><strong>{selectedRoad.contested ? 'Contested territory' : selectedTerritoryOwner ? 'Captured territory' : 'Unclaimed territory'}</strong><button onClick={() => setSelectedTerritory(null)} aria-label="Close territory details"><X size={17} /></button></div>
      <b>{connected?.cells || 1} connected road {connected?.cells === 1 ? 'cell' : 'cells'} · {fmtDistance(connected?.meters || selectedRoad.length_m)}</b>
      {selectedRoad.contested ? <div className="territory-inspector-scores"><span>Top score <strong>{selectedRoad.top_score ?? '—'}</strong></span><span>You <strong>{selectedRoad.your_score ?? '—'}</strong></span></div>
        : selectedTerritoryOwner ? <small>Captured by {inspectedName} · {territoryAge(selectedRoad.captured_on, now)}</small> : <small>No owner yet</small>}
    </div>}

    {driving && selected && <div className="turn-banner">
      <div className="turn-icon">{currentStep?.modifier?.includes('left') ? <ArrowLeft /> : currentStep?.modifier?.includes('right') ? <ArrowRight /> : <Navigation />}</div>
      <div><small>UP NEXT</small><strong>{currentStep?.instruction || 'Continue on route'}</strong></div>
    </div>}

    {view === 'Altitude' && <div className="altitude-pill"><Mountain size={15} /> {altitude == null ? '-- m' : `${Math.round(altitude)} m`} <small>altitude</small></div>}

    <div className="map-controls">
      <div className="zoom-stack">
        <button onClick={() => setZoomCommand(value => Math.abs(value) + 1)} aria-label="Zoom in"><Plus size={23} /></button>
        <button onClick={() => setZoomCommand(value => -Math.abs(value) - 1)} aria-label="Zoom out"><Minus size={23} /></button>
      </div>
      <button className="round-control" onClick={() => { setNorthUp(value => !value); setCenterCommand(value => value + 1); }} aria-label="Center and change orientation"><LocateFixed size={21} /></button>
      {view === 'Road Pulse' && !driving && <button className="round-control" onClick={() => setRoadScope(scope => scope === 'Everybody' ? 'Mine' : 'Everybody')} aria-label={`Road Pulse: ${roadScope}. Switch to ${roadScope === 'Everybody' ? 'Mine' : 'Everybody'}`} title={`Road Pulse: ${roadScope}`}>
        {roadScope === 'Everybody' ? <UsersRound size={21} /> : <UserRound size={21} />}
      </button>}
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
        <div className="planner-footer"><small>Routes do not use live traffic</small><button className="pink-button" onClick={startDrive}><Play size={17} fill="currentColor" />Start</button></div>
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
          <div><strong>{liveTime(driveSeconds)}</strong><small>DRIVE TIME</small></div>
          <div><strong>{fmtDistance(live?.distance || 0)}</strong><small>DISTANCE</small></div>
          <div><strong>{live?.altitudeAnchor == null ? '—' : statValue(live?.height || 0, ' m')}</strong><small>UP + DOWN</small></div>
          <div><strong>{fmtDistance(localRoadUnits * 25)}</strong><small>ROAD EXPLORED*</small></div>
        </>}
      </div>
      <div className="dock-footer">
        <button className="dock-stop" onClick={() => setPanel('drive')} aria-label="End drive"><Square size={16} fill="currentColor" /></button>
        {selected && <button className="dock-mode" onClick={() => setDriveMode(value => value === 'Navigation' ? 'Game' : 'Navigation')}>{driveMode === 'Navigation' ? 'Show progress' : 'Show route'} <ChevronDown size={16} /></button>}
        <button className="dock-map" onClick={() => setPanel('maps')}><Layers3 size={17} /> Map</button>
      </div>
      {territorySyncError && live?.share && <small className="territory-sync-warning">Territory is waiting to sync. Guava will retry while this page is open.</small>}
    </div>}

    {showWelcome && authUser && cloudProfile && !driving && <div className="sheet-backdrop welcome-backdrop"><section className="bottom-sheet welcome-sheet" aria-label="Welcome to Guava">
      <div className="sheet-header"><h2>Welcome to Guava</h2><button onClick={finishWelcome} aria-label="Not now"><X size={22} /></button></div>
      <p>Drive with the map and explore roads. After this screen, your browser will ask for location so Guava can show where you are and record drives on this device.</p>
      <div className="welcome-choice"><strong>Join community play?</strong><span>If you join, road segments are sent for matching while you drive so territory visits count immediately. Your completed trip, XP, distance and height are shared when you finish and save. Other players may see your name on roads you capture, settled tied roads, and anonymous live contest counts on already-shared roads. Quiet roads near home or work can reveal your habits. If you stay private, you won’t see other players’ scores or roads.</span></div>
      <button className="pink-button sheet-action" disabled={profileBusy} onClick={() => void saveCloudProfile(true).then(saved => { if (saved) finishWelcome(); })}>{profileBusy ? 'Joining…' : 'Join community play'}</button>
      <button className="subtle-action sheet-action" onClick={finishWelcome}>Not now — keep my drives private</button>
      <small>You can change this later in Profile → Settings. The map needs location permission to navigate; sharing is separate.</small>
    </section></div>}

    {!showWelcome && authUser && cloudProfile?.community_opt_in && (!cloudProfile.live_territory_consent_at || !cloudProfile.territory_detail_consent_at) && !dismissedLiveConsent && !driving && <div className="sheet-backdrop welcome-backdrop"><section className="bottom-sheet welcome-sheet" aria-label="Territory sharing has changed">
      <div className="sheet-header"><h2>Territory sharing has changed</h2><button onClick={() => setDismissedLiveConsent(true)} aria-label="Not now"><X size={22} /></button></div>
      <p>Community territory now shows settled tied roads and anonymous contest counts on already-shared roads. It still sends short GPS segments for matching during opted-in drives, while XP, distance and height share only when you save. Roads near home or work can reveal travel habits.</p>
      <p>Your old progress stays. New drives remain private until you accept this updated sharing.</p>
      <button className="pink-button sheet-action" disabled={profileBusy} onClick={() => void saveCloudProfile(true).then(saved => { if (saved) setDismissedLiveConsent(true); })}>{profileBusy ? 'Saving…' : 'Accept updated territory sharing'}</button>
      <button className="subtle-action sheet-action" onClick={() => setDismissedLiveConsent(true)}>Not now — new drives stay private</button>
    </section></div>}

    {panel === 'maps' && <div className="sheet-backdrop" onClick={() => setPanel('none')}><section className="bottom-sheet map-sheet" onClick={event => event.stopPropagation()}>
      <div className="sheet-header"><h2>Change your world</h2><button onClick={() => setPanel('none')} aria-label="Close"><X size={22} /></button></div>
      <p>Switch views anytime. All map views are free.</p>
      <div className="view-list">{mapViews.map(option => <div key={option} className="view-group"><button className={view === option ? 'active' : ''} onClick={() => { setView(option); setSelectedTerritory(null); setPanel('none'); }}>
        <span className="view-icon">{option === 'Altitude' ? <Mountain /> : option === 'Road Pulse' ? <Route /> : option === 'Dark' ? <Moon /> : option === 'Territory' ? <Flag /> : <MapIcon />}</span>
        <span><strong>{option}</strong><small>{!communityOptIn && (option === 'Road Pulse' || option === 'Territory') ? 'Join community play to see shared roads' : option === 'Road Pulse' ? 'How often roads are used' : option === 'Territory' ? 'Captured road sections' : option === 'Altitude' ? 'Elevation colors and current altitude' : option === 'Dark' ? 'Dark everyday road map' : 'Everyday road map'}</small></span>
        {view === option && <span className="selected-mark">✓</span>}
      </button></div>)}</div>
    </section></div>}

    {panel === 'drive' && driving && <div className="sheet-backdrop" onClick={() => setPanel('none')}><section className="bottom-sheet" onClick={event => event.stopPropagation()}>
      <div className="sheet-header"><h2>End this drive?</h2><button onClick={() => setPanel('none')} aria-label="Close"><X size={22} /></button></div>
      <p>Save your trip and shared XP after parking. On an opted-in drive, territory visits already synced will still count if you discard the trip record.</p>
      <button className="sheet-action pink-button" onClick={() => endDrive(true)}>Finish & Save</button>
      <button className="sheet-action subtle-action" onClick={() => endDrive(false)}>Discard trip record</button>
      <button className="sheet-action text-action" onClick={() => setPanel('none')}>Keep Driving</button>
    </section></div>}

    {panel === 'profile' && <div className="full-screen-panel"><div className="full-header"><button onClick={() => setPanel('none')} aria-label="Close profile"><X /></button><h2>Profile</h2><button onClick={() => setPanel('settings')} aria-label="Settings"><Settings size={20} /></button></div>
      <div className="profile-body"><div className="xp-card"><div className="xp-topline"><small>{communityOptIn ? 'COMMUNITY XP' : 'LOCAL XP'}</small><small>LEVEL {Math.floor(displayXP / 500) + 1}</small></div><strong>{displayXP.toLocaleString()}</strong><div className="xp-track"><span style={{ width: `${displayXP % 500 / 5}%` }} /></div><span>{500 - displayXP % 500} XP to next level</span></div>
      <div className="identity-card"><div className="avatar"><UserRound /></div><div><strong>{cloudProfile?.display_name || profileName}</strong><small>{communityOptIn ? 'Community play on · drives backed up in this browser' : authUser ? 'Signed in · community play off' : 'Local profile · this browser'}</small></div></div>
      <div className="stats-grid"><div><Navigation /><small>Total distance</small><strong>{fmtDistance(totalDistance)}</strong></div><div><Timer /><small>Drive time</small><strong>{fmtTime(totalTime / 1000)}</strong></div><div><Mountain /><small>Height traveled</small><strong>{fmtDistance(totalHeight)}</strong></div><div><Flag /><small>Road explored*</small><strong>{fmtDistance(totalUnits * 25)}</strong></div></div>
      <h3>Personal insights</h3><div className="stats-grid"><div><Navigation /><small>Average speed</small><strong>{totalTime > 0 ? `${Math.round(totalDistance / (totalTime / 1000) * 3.6)} km/h` : '—'}</strong></div><div><Mountain /><small>Highest altitude</small><strong>{Number.isFinite(highestAltitude) ? `${Math.round(highestAltitude)} m` : '—'}</strong></div></div>
      <h3>Recent drives</h3>{trips.length ? trips.slice(0, 8).map(trip => <div className="history-row" key={trip.id}><span><strong>{trip.destination || 'Quick Start'}</strong><small>{new Date(trip.endedAt).toLocaleDateString()} · {fmtDistance(trip.distanceMeters)} · {fmtTime((trip.endedAt - trip.startedAt) / 1000)} · {Math.round(trip.heightMeters)} m height · {trip.communityStatus === 'uploaded' ? 'shared' : trip.communityStatus === 'pending' ? 'waiting to share' : 'private'}</small></span><strong>+{trip.xp} XP</strong></div>) : <p className="empty-note">Your finished drives will appear here.</p>}
      <p className="privacy-note">Full GPS tracks stay in this browser. With community play on, short segments are sent for road matching during a drive so private territory visits count then; completed drives are sent for XP, distance and height when saved. Only road visits and scores are stored for the shared game. Browser recording may stop when locked or backgrounded. *Road explored is a local estimate.</p></div>
    </div>}

    {panel === 'settings' && <div className="full-screen-panel"><div className="full-header"><button onClick={() => setPanel('profile')} aria-label="Back to profile"><ArrowLeft /></button><h2>Settings</h2><span /></div><div className="profile-body">
      <h3>Account</h3><label className="settings-label">Display name<input value={profileName} maxLength={32} onChange={event => { setProfileName(event.target.value); localStorage.setItem('guava.web.name', event.target.value); }} /></label>
      {authUser ? <><p className="empty-note">Signed in as {authUser.email}. Drive tracks are saved in this browser.</p>
        <label className="settings-label community-toggle">Join community play <input type="checkbox" checked={communityOptIn} disabled={!cloudProfile || profileBusy} onChange={event => setCommunityOptIn(event.target.checked)} /></label>
        <p className="privacy-note">When on, short GPS segments are sent for road matching during a drive so territory visits count immediately, even if the drive ends after midnight. A completed trip adds shared XP, distance and height only when saved. Other participating drivers can see your name on roads you capture after the daily round, settled tied roads, and anonymous contest counts on already-shared roads. Quiet roads may reveal where you travel, including near home or work. Turning this off deletes cloud game progress, but keeps local drives in this browser.</p>
        <button className="pink-button sheet-action" disabled={!cloudProfile || profileBusy} onClick={() => void saveCloudProfile()}>{profileBusy ? 'Saving…' : 'Save profile'}</button>
        <button className="subtle-action sheet-action" onClick={() => void checkCommunityConnection()}>Check community connection</button>
        {connectionResult && <p className="empty-note" role="status">{connectionResult}</p>}
        <button className="subtle-action sheet-action" disabled={authBusy} onClick={() => void signOut()}>Sign out</button></> : isSupabaseConfigured ? <button className="pink-button sheet-action" disabled={authBusy} onClick={() => void googleSignIn()}>{authBusy ? 'Connecting…' : 'Continue with Google'}</button> : <p className="empty-note">Google sign-in is unavailable here. You can still use the map and keep local progress.</p>}
      <h3>Navigation & privacy</h3><p className="privacy-note">Guava requests location while its web page is open. It records a trip only after you tap Start, and you choose Save or Discard when ending it. Full GPS tracks are stored only in this browser; opted-in territory segments are matched while driving, with summary scores shared after Save. Browser recording may pause when locked or backgrounded. <a href={privacyUrl} target="_blank" rel="noreferrer">Read the privacy notice</a>.</p>
      <button className="subtle-action sheet-action" onClick={() => { const blob = new Blob([JSON.stringify(trips, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'guava-drives.json'; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Export my local drives</button>
    </div></div>}

    {panel === 'leaderboard' && <div className="full-screen-panel"><div className="full-header"><button onClick={() => setPanel('none')}><X /></button><h2>Leaderboard</h2><Trophy size={20} /></div><div className="profile-body">
      <div className="leaderboard-categories">{(['XP', 'Distance', 'Height', 'Territory'] as const).map(metric => <button key={metric} className={leaderboardMetric === metric ? 'active' : ''} onClick={() => setLeaderboardMetric(metric)}>{metric === 'Height' ? 'Height Traveled' : metric}</button>)}</div>
        <div className="xp-card score-card"><small>{communityOptIn ? `YOUR SHARED ${leaderboardMetric.toUpperCase()}` : `YOUR LOCAL ${leaderboardMetric.toUpperCase()}`}</small><strong>{communityOptIn ? liveRankValue(leaderboardMetric === 'XP' ? cloudScore?.xp || 0 : leaderboardMetric === 'Distance' ? cloudScore?.distance_m || 0 : leaderboardMetric === 'Height' ? cloudScore?.height_m || 0 : cloudScore?.territory_m || 0) : localMetric}</strong><span>{communityOptIn ? 'Scores from verified community drives.' : 'Join community play in Settings to appear on the live board.'}</span></div>
        {cloudError && <p className="empty-note">Community connection: {cloudError}</p>}
        {!communityOptIn && <button className="pink-button sheet-action" onClick={() => setPanel('settings')}>Join community play</button>}
        {leaderboardMetric === 'Territory' && <div className="round-clock" aria-label="Time until territory round ends"><span>ROUND ENDS IN</span><strong>{israelRoundRemaining(now)}</strong></div>}
        {liveRankings.length ? <><div className="live-podium">{liveRankings.slice(0, 3).map((entry, index) => <div key={entry.id} className={`place-${index + 1}`}><span className="podium-avatar">{entry.name[0]}</span><strong>{entry.name}</strong><small>{liveRankValue(entry.value)}</small><b>{index + 1}</b></div>)}</div><div className="ranking-list">{liveRankings.slice(3).map((entry, index) => <div key={entry.id}><b>{index + 4}</b><strong>{entry.name}</strong><span>{liveRankValue(entry.value)}</span></div>)}</div></> : <p className="empty-note">{communityOptIn ? 'No shared drives yet. The first opted-in drive starts the board.' : 'Join community play to see other players and appear on the board.'}</p>}
    </div></div>}

    {panel === 'recap' && lastTrip && <div className="full-screen-panel"><div className="full-header"><button onClick={() => setPanel('none')}><X /></button><h2>Drive complete</h2><Flag size={20} /></div><div className="profile-body">
      <div className="xp-card"><small>YOU EARNED</small><strong>+{lastTrip.xp} XP</strong><span>{lastTrip.destination || 'Quick Start'} · {fmtClock(lastTrip.endedAt)}</span></div>
      <div className="stats-grid"><div><Navigation /><small>Distance</small><strong>{fmtDistance(lastTrip.distanceMeters)}</strong></div><div><Timer /><small>Time</small><strong>{fmtTime((lastTrip.endedAt - lastTrip.startedAt) / 1000)}</strong></div><div><Mountain /><small>Height</small><strong>{fmtDistance(lastTrip.heightMeters)}</strong></div><div><Flag /><small>New road*</small><strong>{fmtDistance(lastTrip.newRoadUnits * 25)}</strong></div></div>
      <p className="privacy-note">{lastTrip.communityStatus === 'uploaded' ? 'Added to the community leaderboard. Territory visits were banked during the drive; ownership becomes final at about 09:05 Israel time the next morning.' : lastTrip.communityStatus === 'pending' ? `Saved here, but not yet fully shared. ${cloudError || 'Guava is checking the roads.'}` : 'Private drive saved on this device. Join community play in Settings before your next drive to compete.'} *Road is approximate local exploration, not awarded territory.</p>
      {lastTrip.communityStatus === 'pending' && <button className="subtle-action sheet-action" onClick={() => { uploadingRef.current.delete(lastTrip.id); setTrips(current => [...current]); }}>Retry sharing</button>}
      <button className="pink-button sheet-action" onClick={() => setPanel('none')}>Back to map</button>
    </div></div>}

    {error && <div className="error-toast" role="alert"><span>{error}</span><button onClick={() => setError('')}><X size={16} /></button></div>}
    {locationError && !position && panel === 'none' && <div className="location-note"><Compass size={17} /> {locationError}</div>}
  </div>;
}
