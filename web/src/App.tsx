import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, ChevronDown, Compass, Flag, Layers3, Moon,
  LocateFixed, Map as MapIcon, Mountain, Navigation, Play, Search,
  Settings, Square, Trophy, UserRound, X, Minus, Plus, Route, Timer,
} from 'lucide-react';
import GuavaMap, { type TerritorySelection } from './GuavaMap';
import {
  distanceMeters, finishTrip, fmtClock, fmtDistance, fmtTime, ISRAEL_CENTER,
  routeFromOSRM, tripUnits,
} from './model';
import type { DrivePoint, DrivingRoute, MapView, Point, Trip } from './model';
import { isSupabaseConfigured, signInWithGoogle, supabase } from './supabase';
import { bankTerritorySegment, cloudPulseLayers, cloudRankings, cloudTerritoryLayers, loadCloudGame, uploadCommunityDrive, type CloudGame, type CloudProfile } from './cloud';
import { connectedTerritory, israelDay, israelRoundRemaining, territoryAge } from './territory';
import { shownAltitude, trustedGpsAltitude, type TerrainSample } from './altitude';
import type { User } from '@supabase/supabase-js';
import { loadTrips, saveTrips, loadDraft, saveDraft, exportAccountData } from './driveDatabase';
import { hasLegacyTrips, exportLegacyTrips } from './storage';
import { advanceMotionState, appendDriveFix, canAutoFinishDrive, isUsableDriveFix, movingTimeMs, startMotionState, stationaryDurationMs, type ActiveDrive, type MotionState } from './recording';
import { preference, setPreference } from './preferences';
import { canShare, canShareSavedDrive, retryDelay, uploadReady } from './sharing';
import { routeProgress } from './navigation';
import LeaderboardIntro from './LeaderboardIntro';
import MapContext from './MapContext';

type Panel = 'none' | 'drive' | 'tools' | 'maps' | 'search' | 'profile' | 'settings' | 'leaderboard' | 'recap';
type Place = { name: string; detail: string; position: Point };
type LiveDrive = ActiveDrive;
const mapViews: MapView[] = ['Regular', 'Dark', 'Satellite', 'My Roads', 'Territory', 'Road Pulse', 'Altitude'];
const requiresAccount = import.meta.env.VITE_REQUIRE_AUTH === 'true';
const privacyUrl = new URL(`${import.meta.env.BASE_URL}privacy.html`, window.location.origin).toString();
const geocoderUrl = import.meta.env.VITE_GEOCODER_URL || 'https://photon.komoot.io/api/';
const routerUrl = (import.meta.env.VITE_ROUTER_URL || 'https://router.project-osrm.org').replace(/\/$/, '');

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

type AppProps = {
  authUser: User | null;
  guestMode: boolean;
  guestName: string;
  onGuestNameChange: (name: string) => void;
  onExitGuest: () => void;
};

export default function App({ authUser, guestMode, guestName, onGuestNameChange, onExitGuest }: AppProps) {
  const ownerId = authUser?.id || 'local';
  const [storageReady, setStorageReady] = useState(false);
  const [initialStorageError, setInitialStorageError] = useState('');
  const [hasWriteLock, setHasWriteLock] = useState(false);
  const [lockAttempt, setLockAttempt] = useState(0);
  const [storageReadVersion, setStorageReadVersion] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);
  const [view, setView] = useState<MapView>('Regular');
  const [panel, setPanel] = useState<Panel>('none');
  const [position, setPosition] = useState<Point | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [gpsAltitude, setGpsAltitude] = useState<number | null>(null);
  const [terrainSample, setTerrainSample] = useState<TerrainSample | null>(null);
  const [locationError, setLocationError] = useState('');
  const [trips, setTrips] = useState<Trip[]>([]);
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
  const [lastTrip, setLastTrip] = useState<Trip | null>(null);
  const [now, setNow] = useState(Date.now());
  const [authBusy, setAuthBusy] = useState(false);
  const [profileName, setProfileName] = useState(guestMode ? guestName : 'Driver');
  const [cloudProfile, setCloudProfile] = useState<CloudProfile | null>(null);
  const [cloudGame, setCloudGame] = useState<CloudGame | null>(null);
  const [cloudError, setCloudError] = useState('');
  const [territorySyncError, setTerritorySyncError] = useState('');
  const [connectionResult, setConnectionResult] = useState('');
  const [draftOptIn, setDraftOptIn] = useState(false);
  const communityOptIn = Boolean(cloudProfile?.community_opt_in);
  const sharingEnabled = canShare(cloudProfile);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileLoadError, setProfileLoadError] = useState('');
  const [profileLoadAttempt, setProfileLoadAttempt] = useState(0);
  const [showWelcome, setShowWelcome] = useState(false);
  const [welcomeStep, setWelcomeStep] = useState<'name' | 'community'>('name');
  const [dismissedLiveConsent, setDismissedLiveConsent] = useState(false);
  const [leaderboardMetric, setLeaderboardMetric] = useState<'XP' | 'Distance' | 'Height' | 'Territory'>('XP');
  const [selectedTerritory, setSelectedTerritory] = useState<TerritorySelection | null>(null);
  const driveRef = useRef<LiveDrive | null>(null);
  const [recoverable, setRecoverable] = useState<LiveDrive | null>(null);
  const [storageError, setStorageError] = useState('');
  const [lastFixAt, setLastFixAt] = useState(0);
  const [locationRequest, setLocationRequest] = useState(0);
  const [searchComplete, setSearchComplete] = useState(false);
  const [queueTick, setQueueTick] = useState(0);
  const [leaderboardHelp, setLeaderboardHelp] = useState(false);
  const mountedRef = useRef(true);
  const driveActionRef = useRef(false);
  const lockOwnedRef = useRef(false);
  const lockRequestRef = useRef<Promise<void>>(Promise.resolve());
  const draftWriteQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const tripWriteQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const lastFixRef = useRef<DrivePoint | null>(null);
  const motionStateRef = useRef<MotionState | null>(null);
  const autoFinishAttemptRef = useRef<string | null>(null);
  const resumeBreakRef = useRef(false);
  const tripsRef = useRef(trips);
  tripsRef.current = trips;
  const routeRequestRef = useRef<AbortController | null>(null);
  const lastPositionRef = useRef<Point | null>(null);
  const uploadingRef = useRef(new Set<string>());
  const uploadCooldownRef = useRef(new Map<string, number>());
  const consentRef = useRef(sharingEnabled);
  consentRef.current = sharingEnabled;
  const profileSavingRef = useRef(false);
  const territoryCheckpointRef = useRef({ sessionId: '', nextIndex: 0, busy: false });
  const elevationGrid = position ? `${(Math.round(position[0] * 2000) / 2000).toFixed(4)},${(Math.round(position[1] * 2000) / 2000).toFixed(4)}` : '';
  const gpsAltitudeAvailable = gpsAltitude != null;
  const altitude = shownAltitude(gpsAltitude, terrainSample, elevationGrid);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; routeRequestRef.current?.abort(); };
  }, []);

  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    setStorageReady(false);
    setHasWriteLock(false);
    lockOwnedRef.current = false;
    if (!navigator.locks) { setInitialStorageError('This browser cannot safely coordinate drive recording. Please use a current browser.'); setStorageReady(true); return; }
    const request = lockRequestRef.current.then(async () => {
      if (!active) return;
      await navigator.locks.request(`guava-drives-${ownerId}`, { ifAvailable: true }, async lock => {
        if (!active) return;
        lockOwnedRef.current = Boolean(lock);
        setStorageReady(false);
        setHasWriteLock(Boolean(lock));
        setStorageReadVersion(version => version + 1);
        if (lock) await new Promise<void>(resolve => { release = resolve; });
      });
    }).catch(() => { if (active) { setInitialStorageError('Could not reserve drive storage. Close other Guava tabs and try again.'); setStorageReady(true); } });
    lockRequestRef.current = request;
    const releaseAfterWrites = () => {
      active = false; lockOwnedRef.current = false;
      void Promise.allSettled([draftWriteQueueRef.current, tripWriteQueueRef.current]).then(() => release?.());
    };
    const pageHidden = () => {
      // Browsers may keep a navigated-away document in the back/forward cache.
      // Yield its recorder explicitly; a restored document reloads the draft.
      if (driveRef.current) void persistDraft(driveRef.current);
      driveRef.current = null;
      setDriving(false); setLive(null); setHasWriteLock(false); setStorageReady(false);
      releaseAfterWrites();
    };
    const pageShown = (event: PageTransitionEvent) => {
      if (event.persisted) setLockAttempt(value => value + 1);
    };
    window.addEventListener('pagehide', pageHidden);
    window.addEventListener('pageshow', pageShown);
    return () => {
      window.removeEventListener('pagehide', pageHidden);
      window.removeEventListener('pageshow', pageShown);
      releaseAfterWrites();
    };
  }, [ownerId, lockAttempt]);

  useEffect(() => {
    let active = true;
    void Promise.all([loadTrips(ownerId), loadDraft(ownerId)]).then(([saved, draft]) => {
      if (!active) return;
      tripsRef.current = saved; setTrips(saved);
      setRecoverable(saved.some(trip => trip.id === draft?.id) ? null : draft);
      if (lockOwnedRef.current) setInitialStorageError('');
      setStorageReady(true);
    }).catch(cause => {
      if (active) { setInitialStorageError(cause instanceof Error ? cause.message : 'Could not open saved drives.'); setStorageReady(true); }
    });
    return () => { active = false; };
  }, [ownerId, storageReadVersion]);

  function persistDraft(draft: LiveDrive | null): Promise<boolean> {
    if (!mountedRef.current || !lockOwnedRef.current) return Promise.resolve(false);
    const write = draftWriteQueueRef.current.then(async () => {
      try { await saveDraft(ownerId, draft); if (mountedRef.current) setStorageError(''); return true; }
      catch (cause) { if (mountedRef.current) setStorageError(cause instanceof Error ? cause.message : 'Could not save this drive. Keep this page open and export a copy.'); return false; }
    });
    draftWriteQueueRef.current = write;
    return write;
  }

  function updateTrips(change: (current: Trip[]) => Trip[]): Promise<boolean> {
    if (!mountedRef.current || !lockOwnedRef.current) return Promise.resolve(false);
    const write = tripWriteQueueRef.current.then(async () => {
      try {
        const updated = change(tripsRef.current);
        await saveTrips(ownerId, updated);
        tripsRef.current = updated;
        if (mountedRef.current) { setTrips(updated); setStorageError(''); }
        return true;
      } catch (cause) { if (mountedRef.current) setStorageError(cause instanceof Error ? cause.message : 'Could not save your drives.'); return false; }
    });
    tripWriteQueueRef.current = write;
    return write;
  }

  useEffect(() => {
    const refresh = () => setQueueTick(tick => tick + 1);
    const visible = () => { if (!document.hidden) refresh(); };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', visible); };
  }, []);

  useEffect(() => {
    if (!driving) return;
    const checkpoint = () => { if (driveRef.current) persistDraft(driveRef.current); };
    const beforeUnload = (event: BeforeUnloadEvent) => { checkpoint(); event.preventDefault(); };
    window.addEventListener('pagehide', checkpoint);
    window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('pagehide', checkpoint); window.removeEventListener('beforeunload', beforeUnload); };
  }, [driving]);

  useEffect(() => {
    if (!driving || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let active = true;
    const acquire = async () => {
      if (document.hidden || !active) return;
      try {
        const next = await navigator.wakeLock.request('screen');
        if (!active) { await next.release(); return; }
        lock = next;
      } catch { /* Recording state visibly reports missing location updates. */ }
    };
    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => { active = false; document.removeEventListener('visibilitychange', acquire); void lock?.release(); };
  }, [driving]);

  useEffect(() => {
    if (!supabase || !authUser) { setCloudProfile(null); setDraftOptIn(false); return; }
    setCloudProfile(null);
    setProfileLoadError('');
    const client = supabase;
    const userId = authUser.id;
    let alive = true;
    async function loadCloudProfile() {
      const { error: createError } = await client.from('guava_profiles').insert({
        user_id: userId, display_name: 'Driver',
      });
      if (createError && createError.code !== '23505') {
        if (alive) setProfileLoadError(`Could not open your community profile: ${createError.message}`);
        return;
      }
      const { data, error: readError } = await client.from('guava_profiles')
        .select('user_id,display_name,community_opt_in,live_territory_consent_at,territory_detail_consent_at,open_territory_consent_at').eq('user_id', userId).single();
      if (!alive) return;
      if (readError) { setProfileLoadError(`Could not load your profile: ${readError.message}`); return; }
      const profile = data as CloudProfile;
      setCloudProfile(profile);
      setProfileName(profile.display_name === 'Driver' ? '' : profile.display_name);
      setDraftOptIn(profile.community_opt_in);

    }
    void loadCloudProfile().catch(cause => { if (alive) setProfileLoadError(`Could not load your profile: ${cause instanceof Error ? cause.message : String(cause)}`); });
    return () => { alive = false; };
  // The local name is read once when an account session starts; edits are saved explicitly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id, hasWriteLock, profileLoadAttempt]);

  useEffect(() => {
    if (!authUser) { setCloudGame(null); return; }
    let active = true;
    const refresh = async () => {
      try {
        const game = await loadCloudGame(authUser.id, Boolean(cloudProfile?.territory_detail_consent_at && cloudProfile.open_territory_consent_at));
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
  }, [authUser?.id, cloudProfile?.territory_detail_consent_at, cloudProfile?.open_territory_consent_at]);

  useEffect(() => {
    if (!authUser || !sharingEnabled || profileBusy || !navigator.onLine || !storageReady || !hasWriteLock) return;
    const trip = trips.find(item => uploadReady(item, ownerId, Date.now()) && (uploadCooldownRef.current.get(item.id) || 0) <= Date.now() && !uploadingRef.current.has(item.id));
    if (!trip || uploadingRef.current.size) return;
    uploadingRef.current.add(trip.id);
    uploadCooldownRef.current.set(trip.id, Date.now() + 300_000);
    void uploadCommunityDrive(trip, ownerId).then(async result => {
      if (!mountedRef.current || !consentRef.current || profileSavingRef.current) return;
      const updatedTrip: Trip = { ...trip, xp: result.xp, communityStatus: 'uploaded', communityError: undefined, retryAfter: undefined };
      if (await updateTrips(current => current.map(item => item.id === trip.id ? updatedTrip : item))) {
        setLastTrip(current => current?.id === trip.id ? updatedTrip : current);
        setCloudError('');
      }
      void loadCloudGame(ownerId, true).then(game => { if (mountedRef.current) setCloudGame(game); }).catch(() => {});
    }).catch(cause => {
      if (!mountedRef.current || !consentRef.current || profileSavingRef.current) return;
      const message = cause instanceof Error ? cause.message : 'Could not share this drive.';
      const retryable = !(cause && typeof cause === 'object' && 'retryable' in cause && cause.retryable === false);
      const attempts = (trip.uploadAttempts || 0) + 1;
      uploadCooldownRef.current.set(trip.id, Date.now() + retryDelay(attempts));
      const failed: Trip = { ...trip, communityStatus: retryable ? 'pending' : 'failed', communityError: message,
        retryAfter: Date.now() + retryDelay(attempts), uploadAttempts: attempts };
      void updateTrips(current => current.map(item => item.id === trip.id ? failed : item));
      setLastTrip(current => current?.id === trip.id ? failed : current);
      setCloudError(message);
    }).finally(() => { uploadingRef.current.delete(trip.id); if (mountedRef.current) setQueueTick(tick => tick + 1); });
  }, [ownerId, sharingEnabled, profileBusy, storageReady, hasWriteLock, trips, queueTick]);

  useEffect(() => {
    if (!driving || !live?.share || !authUser || !cloudProfile?.community_opt_in || !cloudProfile.live_territory_consent_at || !cloudProfile.territory_detail_consent_at || !cloudProfile.open_territory_consent_at) return;
    const timer = window.setInterval(() => {
      const current = driveRef.current;
      const checkpoint = territoryCheckpointRef.current;
      if (!current?.share || !consentRef.current || profileSavingRef.current || !lockOwnedRef.current || current.distance < 50 || checkpoint.busy || current.id !== checkpoint.sessionId) return;
      let end = Math.min(current.points.length, checkpoint.nextIndex + 40);
      const breakAt = current.points.findIndex((fix, index) => index > checkpoint.nextIndex && index < end && fix.segmentStart);
      if (breakAt >= 0) end = breakAt;
      if (end - checkpoint.nextIndex < 2 && breakAt >= 0) { checkpoint.nextIndex = breakAt; return; }
      const segment = current.points.slice(checkpoint.nextIndex, end);
      const segmentDistance = segment.reduce((sum, fix, index) =>
        index ? sum + distanceMeters(segment[index - 1].position, fix.position) : sum, 0);
      if (segment.length < 2 || segmentDistance < 10) { if (breakAt >= 0) checkpoint.nextIndex = breakAt; return; }
      checkpoint.busy = true;
      void bankTerritorySegment(current.id, current.startedAt, segment, ownerId)
        .then(() => { checkpoint.nextIndex = breakAt >= 0 ? breakAt : end - 1; if (mountedRef.current) setTerritorySyncError(''); })
        .catch(cause => { if (mountedRef.current) setTerritorySyncError(cause instanceof Error ? cause.message : 'Territory is waiting to sync.'); })
        .finally(() => { checkpoint.busy = false; });
    }, 15000);
    return () => window.clearInterval(timer);
  }, [driving, live?.id, live?.share, authUser?.id, cloudProfile?.community_opt_in, cloudProfile?.live_territory_consent_at, cloudProfile?.territory_detail_consent_at, cloudProfile?.open_territory_consent_at]);

  useEffect(() => {
    if (authUser && cloudProfile && !cloudProfile.community_opt_in) setShowWelcome(preference(`guava.welcome.${authUser.id}`) !== 'done');
    else setShowWelcome(false);
  }, [authUser?.id, cloudProfile?.user_id]);

  useEffect(() => {
    if (requiresAccount && !guestMode && (!authUser || showWelcome
      || (!cloudProfile?.community_opt_in && preference(`guava.welcome.${authUser.id}`) !== 'done'))) return;
    if (!navigator.geolocation) {
      setLocationError('This browser does not support location.');
      return;
    }
    const watcher = navigator.geolocation.watchPosition(fix => {
      const next: Point = [fix.coords.longitude, fix.coords.latitude];
      const deviceAltitude = trustedGpsAltitude(fix.coords.altitude, fix.coords.altitudeAccuracy);
      const sample: DrivePoint = { position: next, timestamp: fix.timestamp, altitude: deviceAltitude, accuracy: fix.coords.accuracy };
      if (!isUsableDriveFix(sample)) { setLocationError('Waiting for an accurate GPS signal.'); return; }
      lastFixRef.current = sample;
      setLastFixAt(fix.timestamp);
      setPosition(next);
      lastPositionRef.current = next;
      if (fix.coords.heading != null && Number.isFinite(fix.coords.heading)) setHeading(fix.coords.heading);
      setGpsAltitude(deviceAltitude);
      setLocationError('');
      const current = driveRef.current;
      if (!current || driveActionRef.current) return;
      const updated = appendDriveFix(current, { ...sample, segmentStart: resumeBreakRef.current || undefined });
      const motionState = motionStateRef.current?.driveId === current.id
        ? motionStateRef.current : startMotionState(current.id, current.points.at(-1)!);
      if (updated !== current || distanceMeters(motionState.anchor.position, sample.position) <= 20) {
        motionStateRef.current = advanceMotionState(motionState, sample);
      }
      if (updated === current) return;
      resumeBreakRef.current = false;
      driveRef.current = updated;
      setLive(updated);
      persistDraft(updated);
    }, cause => setLocationError(cause.code === 1
      ? 'Location is blocked. Allow location in your browser’s site settings, then tap Retry GPS.'
      : 'GPS signal lost. Recording will resume when an accurate location returns.'), {
      enableHighAccuracy: true, maximumAge: 2000, timeout: 15000,
    });
    return () => navigator.geolocation.clearWatch(watcher);
  }, [authUser?.id, guestMode, cloudProfile?.user_id, cloudProfile?.community_opt_in, showWelcome, locationRequest]);

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
    setSearchComplete(false);
    setSuggestions([]);
    setSearching(false);
    if (panel !== 'search' || searchText.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const center = lastPositionRef.current || ISRAEL_CENTER;
        const url = new URL(geocoderUrl);
        url.searchParams.set('q', searchText.trim());
        url.searchParams.set('limit', '6');
        url.searchParams.set('lat', String(center[1]));
        url.searchParams.set('lon', String(center[0]));
        const response = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw new Error('Search is unavailable right now.');
        const data = await response.json() as { features: Array<{ geometry: { coordinates: Point }; properties: Record<string, string> }> };
        if (controller.signal.aborted) return;
        setSearchComplete(true);
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
    if (!position || !lastFixRef.current || !isUsableDriveFix(lastFixRef.current)) { setError('Wait for an accurate location before planning a route.'); return; }
    routeRequestRef.current?.abort();
    const controller = new AbortController();
    routeRequestRef.current = controller;
    setDestination(place);
    setSearchText(place.name);
    setSuggestions([]);
    setRouting(true);
    try {
      const response = await fetch(`${routerUrl}/route/v1/driving/${position[0]},${position[1]};${place.position[0]},${place.position[1]}?overview=full&geometries=geojson&steps=true&alternatives=true`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok) throw new Error('Routing is unavailable right now.');
      const routes = routeFromOSRM(await response.json());
      if (controller.signal.aborted || !mountedRef.current) return;
      setRouteOptions(routes);
      setSelectedRoute(0);
      setPanel('search');
    } catch (cause) { if (!controller.signal.aborted && mountedRef.current) setError(cause instanceof Error ? cause.message : 'Could not calculate route.'); }
    finally { if (!controller.signal.aborted && mountedRef.current) setRouting(false); }
  }

  async function startDrive(quick = false) {
    const fix = lastFixRef.current;
    if (!storageReady || !hasWriteLock || driveActionRef.current) return;
    if (initialStorageError) { setError('Saved data needs recovery before starting another drive. Export it in Settings.'); return; }
    if (recoverable) { setError('Resume, save, or discard your unfinished drive first.'); return; }
    if (!fix || !isUsableDriveFix(fix)) { setError('Wait for an accurate location to start a drive.'); return; }
    const startedAt = Date.now();
    const start: LiveDrive = {
      ownerId, id: crypto.randomUUID(), startedAt,
      points: [{ ...fix, timestamp: startedAt, segmentStart: true }],
      distance: 0, height: 0, altitudeAnchor: fix.altitude,
      share: Boolean(authUser && sharingEnabled), destination: quick ? undefined : destination?.name,
    };
    driveActionRef.current = true; setActionBusy(true);
    const stored = await persistDraft(start);
    driveActionRef.current = false;
    if (!mountedRef.current) return;
    setActionBusy(false);
    if (!stored) return;
    if (quick) { setRouteOptions([]); setDestination(null); setSearchText(''); }
    driveRef.current = start;
    motionStateRef.current = startMotionState(start.id, start.points[0]);
    autoFinishAttemptRef.current = null;
    territoryCheckpointRef.current = { sessionId: start.id, nextIndex: 0, busy: false };
    setTerritorySyncError(''); setLive(start); setDriving(true);
    setDriveMode(!quick && routeOptions.length ? 'Navigation' : 'Game');
    setPanel('none'); setCenterCommand(value => value + 1);
  }

  async function resumeDrive() {
    if (!recoverable || !storageReady || !hasWriteLock || driveActionRef.current) return;
    if (Date.now() - recoverable.startedAt >= 7.75 * 60 * 60 * 1000) { setError('Save the recorded part, then start a new drive. This session is too old to resume.'); return; }
    const fix = lastFixRef.current;
    if (!fix || !isUsableDriveFix(fix)) { setError('Wait for an accurate location before resuming.'); return; }
    const resumed = { ...recoverable, share: recoverable.share && sharingEnabled };
    driveActionRef.current = true; setActionBusy(true);
    const stored = await persistDraft(resumed);
    driveActionRef.current = false;
    if (!mountedRef.current) return;
    setActionBusy(false);
    if (!stored) return;
    resumeBreakRef.current = true;
    driveRef.current = resumed;
    motionStateRef.current = startMotionState(resumed.id, fix);
    autoFinishAttemptRef.current = null;
    territoryCheckpointRef.current = { sessionId: resumed.id, nextIndex: Math.max(0, resumed.points.length - 1), busy: false };
    setLive(resumed); setRecoverable(null); setDriving(true); setDriveMode('Game'); setPanel('none');
    setCenterCommand(value => value + 1);
  }

  async function endDrive(save: boolean, recovered = false) {
    if (!hasWriteLock || driveActionRef.current) return;
    const current = recovered ? recoverable : driveRef.current;
    if (!current) return;
    driveActionRef.current = true; setActionBusy(true);
    try {
    let trip: Trip | null = null;
    if (save) {
      trip = finishTrip(current.points, current.startedAt, current.distance, current.height,
        tripsRef.current, current.destination, current.id, ownerId,
        recovered ? current.points.at(-1)!.timestamp : Date.now());
      if (!trip) { setError('At least 50 metres of recorded movement are needed to save. You can continue or discard this drive.'); return; }
      if (current.share && sharingEnabled) trip.communityStatus = 'pending';
      if (!await updateTrips(existing => [trip!, ...existing.filter(item => item.id !== trip!.id)])) return;
      if (!mountedRef.current || !lockOwnedRef.current) return;
    }
    if (!await persistDraft(null) && !save) return;
    if (!mountedRef.current) return;
    driveRef.current = null;
    motionStateRef.current = null;
    setDriving(false); setLive(null); setRecoverable(null); setPanel(trip ? 'recap' : 'none');
    if (trip) setLastTrip(trip);
    setRouteOptions([]); setDestination(null); setSearchText('');
    } finally { driveActionRef.current = false; if (mountedRef.current) setActionBusy(false); }
  }

  useEffect(() => {
    const current = driveRef.current;
    if (!driving || !current || !hasWriteLock || autoFinishAttemptRef.current === current.id
      || !canAutoFinishDrive(current, motionStateRef.current, now)) return;
    autoFinishAttemptRef.current = current.id;
    void endDrive(true);
  }, [driving, hasWriteLock, lastFixAt, now]);

  function clearRoute() {
    routeRequestRef.current?.abort(); setRouting(false);
    setRouteOptions([]); setDestination(null); setSearchText(''); setSuggestions([]); setPanel('none');
  }

  function openLeaderboard() {
    setPanel('leaderboard');
    if (preference(`guava.leaderboard-help.${ownerId}`) !== 'done') setLeaderboardHelp(true);
  }

  function closeLeaderboardHelp() {
    setPreference(`guava.leaderboard-help.${ownerId}`, 'done'); setLeaderboardHelp(false);
  }

  function retrySharing(id?: string) {
    if (!hasWriteLock || !sharingEnabled) return;
    uploadCooldownRef.current.clear();
    void updateTrips(current => current.map(trip => (trip.communityStatus === 'pending' || trip.communityStatus === 'failed') && (!id || trip.id === id)
      ? { ...trip, communityStatus: 'pending', communityError: undefined, retryAfter: 0 } : trip));
    setQueueTick(tick => tick + 1);
  }

  function shareSavedDrive(id: string) {
    if (!hasWriteLock || !sharingEnabled || !authUser) return;
    const trip = tripsRef.current.find(item => item.id === id);
    if (!trip || !canShareSavedDrive(trip, authUser.id, Date.now())) {
      setError('This drive cannot be shared from this account or is outside the seven-day upload window.');
      return;
    }
    void updateTrips(current => current.map(item => item.id === id
      ? { ...item, communityStatus: 'pending', communityError: undefined, retryAfter: 0 }
      : item)).then(saved => { if (saved) setQueueTick(tick => tick + 1); });
  }

  function openSettings() { setDraftOptIn(communityOptIn); setProfileName(guestMode ? guestName : cloudProfile?.display_name || ''); setPanel('settings'); }

  function downloadData(contents: string, filename: string) {
    const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const selected = routeOptions[selectedRoute];
  const progress = useMemo(() => selected && position ? routeProgress(position, selected) : null, [selected, position]);
  const currentStep = selected?.steps[progress?.nextStep || 0];
  const offRoute = Boolean(driving && selected && position && !progress);
  const remaining = progress?.remaining ?? selected?.distance ?? 0;
  const estimatedSeconds = progress?.seconds ?? selected?.duration ?? 0;
  const driveSeconds = useMemo(() => movingTimeMs(live?.points || []) / 1000, [live?.points]);
  const gpsStale = driving && now - lastFixAt > 20_000;
  const stationaryDuration = live ? stationaryDurationMs(live, motionStateRef.current, now) : null;
  const { totalDistance, totalHeight, totalXP, totalTime, highestAltitude } = useMemo(() => ({
    totalDistance: trips.reduce((sum, trip) => sum + trip.distanceMeters, 0),
    totalHeight: trips.reduce((sum, trip) => sum + trip.heightMeters, 0),
    totalXP: trips.reduce((sum, trip) => sum + trip.xp, 0),
    totalTime: trips.reduce((sum, trip) => sum + movingTimeMs(trip.points), 0),
    highestAltitude: trips.reduce((top, trip) => trip.points.reduce((inner, point) => Math.max(inner, point.altitude ?? -Infinity), top), -Infinity),
  }), [trips]);
  const totalUnits = useMemo(() => new Set(trips.flatMap(trip => [...tripUnits(trip.points)])).size, [trips]);
  const localRoadUnits = useMemo(() => live ? tripUnits(live.points).size : 0, [live]);
  const liveTerritory = useMemo(() => communityOptIn && cloudGame && authUser ? cloudTerritoryLayers(cloudGame, authUser.id) : null, [communityOptIn, cloudGame, authUser?.id]);
  const livePulse = useMemo(() => communityOptIn && cloudGame ? cloudPulseLayers(cloudGame) : null, [communityOptIn, cloudGame]);
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

  function saveGuestProfile() {
    try { onGuestNameChange(profileName); setProfileName(profileName.trim()); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save your guest username.'); }
  }

  async function saveCloudProfile(nextOptIn = draftOptIn, acceptOpenTerritory = false): Promise<boolean> {
    if (!supabase || !authUser || !cloudProfile || !mountedRef.current || !lockOwnedRef.current || profileSavingRef.current) return false;
    const name = profileName.trim() || (acceptOpenTerritory ? cloudProfile.display_name : '');
    if (!name || name.length > 32) { setError('Choose a name between 1 and 32 characters.'); return false; }
    if (communityOptIn && !nextOptIn && !window.confirm('Leave community play? This removes your shared scores, drives and captured roads. Drives saved in this browser remain here.')) {
      setDraftOptIn(communityOptIn); return false;
    }
    setProfileBusy(true);
    profileSavingRef.current = true;
    try {
      // Joining again must never revive a queue from a previously deleted game.
      if (!communityOptIn && nextOptIn && !await updateTrips(current => current.map(trip => ({
        ...trip, communityStatus: undefined, communityError: undefined, retryAfter: undefined,
      })))) return false;
      if (!mountedRef.current || !lockOwnedRef.current) return false;
      const { data, error: profileError } = await supabase.from('guava_profiles')
        .update({ display_name: name, community_opt_in: nextOptIn,
          live_territory_consent_at: nextOptIn ? cloudProfile.live_territory_consent_at || new Date().toISOString() : null,
          territory_detail_consent_at: nextOptIn ? cloudProfile.territory_detail_consent_at || new Date().toISOString() : null,
          open_territory_consent_at: nextOptIn ? (cloudProfile.open_territory_consent_at || (acceptOpenTerritory ? new Date().toISOString() : null)) : null })
        .eq('user_id', authUser.id).select('user_id,display_name,community_opt_in,live_territory_consent_at,territory_detail_consent_at,open_territory_consent_at').single();
      if (!mountedRef.current) return false;
      if (profileError) throw profileError;
      setCloudProfile(data as CloudProfile); setDraftOptIn(nextOptIn);
      consentRef.current = canShare(data as CloudProfile);
      if (!nextOptIn) await updateTrips(current => current.map(trip => ({
        ...trip, communityStatus: undefined, communityError: undefined, retryAfter: undefined,
      })));
      void loadCloudGame(authUser.id, nextOptIn).then(game => { if (mountedRef.current) setCloudGame(game); }).catch(cause => { if (mountedRef.current) setCloudError(String(cause)); });
      return true;
    } catch (cause) {
      if (mountedRef.current) { consentRef.current = canShare(cloudProfile); setError(`Could not save your profile: ${cause instanceof Error ? cause.message : String(cause)}`); }
      return false;
    } finally { profileSavingRef.current = false; if (mountedRef.current) setProfileBusy(false); }
  }

  function finishWelcome() {
    if (!authUser) return;
    setPreference(`guava.welcome.${authUser.id}`, 'done');
    setShowWelcome(false);
    setLocationRequest(value => value + 1);
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

  if (!storageReady) return <main className="signin-screen"><p role="status">Opening your saved drives…</p></main>;

  return <div className={`app-shell${view === 'Dark' ? ' is-dark' : ''}`}>
    {!hasWriteLock && <div className="account-tab-notice" role="status">{navigator.locks ? 'This account is open in another Guava tab. Close that tab to record or save here.' : 'Recording needs a current browser with safe local storage support.'}<button onClick={() => setLockAttempt(value => value + 1)}>Try again</button></div>}
    {profileLoadError && !driving && <div className="storage-warning" role="status"><span>{profileLoadError} Community sharing is paused.</span><button onClick={() => setProfileLoadAttempt(value => value + 1)}>Retry profile</button>{authUser && preference(`guava.welcome.${authUser.id}`) !== 'done' && <button onClick={finishWelcome}>Keep tracking privately</button>}</div>}
    <GuavaMap view={view} trips={trips} livePoints={live?.points || []}
      routes={routeOptions} selectedRoute={selectedRoute} position={position} heading={heading}
      isDriving={driving} northUp={northUp} zoomCommand={zoomCommand} centerCommand={centerCommand}
      liveTerritory={liveTerritory} livePulse={livePulse}
      selectedTerritoryOwner={selectedTerritoryOwner}
      onTerritorySelect={setSelectedTerritory} />

    <div className="top-row">
      {!driving && <div className="brand-pill"><img className="brand-logo" src={`${import.meta.env.BASE_URL}guava-logo.png`} alt="" />Guava</div>}
      {!driving && <button className="round-control profile-control" onClick={() => setPanel('profile')} aria-label="Profile"><UserRound size={23} /></button>}
    </div>

    {!driving && panel === 'none' && !selectedTerritory && <MapContext view={view} isCommunity={communityOptIn} isGuest={guestMode}
      hasRoads={view === 'Territory' ? Boolean(liveTerritory && Object.values(liveTerritory).some(layer => layer.lines.length)) : view === 'My Roads' ? trips.length > 0 : Boolean(livePulse?.some(layer => layer.lines.length))}
      pendingCount={trips.filter(trip => trip.communityStatus === 'pending').length} isLoading={communityOptIn && !cloudGame && !cloudError}
      unavailable={Boolean(cloudError)}
      onOpenLeaderboard={() => { setPanel('leaderboard'); setLeaderboardHelp(true); }} />}

    {view === 'Territory' && selectedRoad && !driving && <div className={`territory-inspector ${selectedTerritoryOwner === authUser?.id ? 'is-mine' : ''}`}>
      <div className="territory-inspector-head"><strong>{selectedRoad.active_contest ? 'Live road contest' : selectedRoad.contested ? 'Unclaimed road' : 'Captured territory'}</strong><button onClick={() => setSelectedTerritory(null)} aria-label="Close territory details"><X size={17} /></button></div>
      <b>{connected?.cells || 1} connected road {connected?.cells === 1 ? 'cell' : 'cells'} · {fmtDistance(connected?.meters || selectedRoad.length_m)}</b>
      {selectedRoad.active_contest && <small>{selectedRoad.vote_round_date === israelDay(now) ? 'Today’s round is live' : 'Round closed · awaiting settlement'} · {selectedRoad.player_count ?? 0} {selectedRoad.player_count === 1 ? 'driver' : 'drivers'}</small>}
      {selectedRoad.top_score !== null && <div className="territory-inspector-scores"><span>Top {selectedRoad.vote_round_date === israelDay(now) ? 'today' : 'round'} <strong>{selectedRoad.top_score}</strong></span><span>You <strong>{selectedRoad.your_score ?? 0}</strong></span></div>}
      <small>{selectedTerritoryOwner ? `Current owner: ${inspectedName} · ${territoryAge(selectedRoad.captured_on, now)}` : 'No owner yet'}{selectedRoad.active_contest ? ' · Ownership updates after settlement' : ''}</small>
    </div>}

    {driving && selected && <div className="turn-banner">
      <div className="turn-icon">{currentStep?.modifier?.includes('left') ? <ArrowLeft /> : currentStep?.modifier?.includes('right') ? <ArrowRight /> : <Navigation />}</div>
      <div><small>UP NEXT</small><strong>{progress?.arrived ? 'You have arrived. Finish after parking.' : offRoute ? 'Off route · guidance paused' : currentStep?.instruction || 'Continue on route'}</strong></div>
    </div>}

    {view === 'Altitude' && <div className="altitude-pill"><Mountain size={15} /> {altitude == null ? '-- m' : `${Math.round(altitude)} m`} <small>altitude</small></div>}
    {view === 'Satellite' && <div className="satellite-credit"><span><a href="https://cloudless.eox.at" target="_blank" rel="noopener noreferrer">EOxCloudless</a> by <a href="https://eox.at" target="_blank" rel="noopener noreferrer">EOX IT Services GmbH</a></span><span>Contains modified Copernicus Sentinel data 2025</span></div>}

    <div className="map-controls">
      <div className="zoom-stack">
        <button onClick={() => setZoomCommand(value => Math.abs(value) + 1)} aria-label="Zoom in"><Plus size={23} /></button>
        <button onClick={() => setZoomCommand(value => -Math.abs(value) - 1)} aria-label="Zoom out"><Minus size={23} /></button>
      </div>
      <button className="round-control" onClick={() => { setNorthUp(value => !value); setCenterCommand(value => value + 1); }} aria-label="Center and change orientation"><LocateFixed size={21} /></button>
    </div>

    {!driving && panel === 'none' && <div className="bottom-actions">
      <button disabled={!hasWriteLock || Boolean(initialStorageError)} className="large-play" onClick={() => setPanel('drive')} aria-label="Start a drive"><Play fill="currentColor" size={30} /></button>
      <button className="round-control tools-control" onClick={() => setPanel('tools')} aria-label="Maps and leaderboard"><Layers3 size={25} /></button>
    </div>}

    {!driving && panel === 'drive' && <div className="bubble-menu left-menu">
      <button disabled={actionBusy} onClick={() => void startDrive(true)}><span><Navigation size={20} /></span>Quick Start</button>
      <button onClick={() => { setPanel('search'); setSearchText(''); }}><span><Search size={20} /></span>Plan Drive</button>
      <button className="bubble-anchor" onClick={() => setPanel('none')} aria-label="Close drive menu"><X size={24} /></button>
    </div>}

    {!driving && panel === 'tools' && <div className="bubble-menu right-menu">
      <button onClick={openLeaderboard}>Leaderboard<span><Trophy size={20} /></span></button>
      <button onClick={() => setPanel('maps')}>Maps<span><Layers3 size={20} /></span></button>
      <button className="bubble-anchor" onClick={() => setPanel('none')} aria-label="Close tools menu"><X size={24} /></button>
    </div>}

    {!driving && panel === 'search' && <div className="planner-card">
      <div className="planner-heading"><strong>Plan Drive</strong><button onClick={clearRoute} aria-label="Close search"><X size={19} /></button></div>
      {!selected && <>
        <div className="search-field"><Search size={20} /><input value={searchText} onChange={event => setSearchText(event.target.value)} placeholder="Where to?" autoFocus /></div>
        <div className="search-results">{searchComplete && !searching && !suggestions.length && <p className="hint" role="status">No places found. Try a city, street or a different spelling.</p>}{searching && <small>Searching places…</small>}{suggestions.map((place, index) => <button key={`${place.name}-${index}`} onClick={() => chooseDestination(place)}><span><strong>{place.name}</strong><small>{place.detail}</small></span><Navigation size={16} /></button>)}</div>
        {!searchText && <p className="hint">Search for a destination, or use Quick Start for a free drive.</p>}
      </>}
      {routing && <p className="hint">Finding a road route…</p>}
      {selected && <>
        <div className="destination-title"><Flag size={19} /><div><strong>{destination?.name}</strong><small>{fmtTime(selected.duration)} · {fmtDistance(selected.distance)}</small></div></div>
        {routeOptions.length > 1 && <div className="route-options">{routeOptions.map((route, index) => <button key={index} className={selectedRoute === index ? 'selected' : ''} onClick={() => setSelectedRoute(index)}>{index === 0 ? 'Fastest' : `Option ${index + 1}`}<small>{fmtTime(route.duration)}</small></button>)}</div>}
        <div className="planner-footer"><small>Route guidance has no live traffic or automatic rerouting</small><button className="pink-button" disabled={actionBusy} onClick={() => void startDrive()}><Play size={17} fill="currentColor" />Start</button></div>
      </>}
    </div>}

    {driving && <div className="drive-dock">
      <div className="dock-top"><span className={`driving-status${gpsStale || locationError ? ' is-waiting' : ''}`}><span /> {gpsStale || locationError ? 'WAITING FOR GPS' : 'DRIVE ACTIVE'}</span><span>{live?.destination || 'Quick Start'} · {live?.share ? 'Community' : 'Private'}</span></div>
      <div className="dock-metrics">
        {driveMode === 'Navigation' && selected ? <>
          <div><strong>{offRoute || gpsStale ? '—' : fmtTime(estimatedSeconds)}</strong><small>REMAINING</small></div>
          <div><strong>{offRoute || gpsStale ? '—' : fmtDistance(remaining)}</strong><small>TO GO</small></div>
          <div><strong>{offRoute || gpsStale ? '—' : fmtClock(now + estimatedSeconds * 1000)}</strong><small>ARRIVAL</small></div>
        </> : <>
          <div><strong>{liveTime(driveSeconds)}</strong><small>MOVING TIME</small></div>
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
      {gpsStale && <small className="territory-sync-warning">GPS paused. Keep Guava open; missing travel is not counted.</small>}
      {stationaryDuration != null && stationaryDuration >= 10 * 60_000 && <small className="territory-sync-warning">Still parked? Guava will save this drive after 15 minutes without moving.</small>}
      {territorySyncError && live?.share && <small className="territory-sync-warning">Territory is waiting to sync. Guava will retry while this page is open.</small>}
    </div>}

    {showWelcome && authUser && cloudProfile && !driving && <div className="sheet-backdrop welcome-backdrop"><section className="bottom-sheet welcome-sheet" aria-label="Welcome to Guava">
      <div className="sheet-header"><h2>{welcomeStep === 'name' ? 'What should we call you?' : 'Welcome to Guava'}</h2>{welcomeStep === 'community' && <button onClick={finishWelcome} aria-label="Keep my drives private"><X size={22} /></button>}</div>
      {welcomeStep === 'name' ? <>
        <p>Pick a name for your Guava profile. Only players who join community play can see it.</p>
        <label className="settings-label nickname-field">Username<input value={profileName} maxLength={32} autoComplete="nickname" autoFocus placeholder="Your name on the map" onChange={event => setProfileName(event.target.value)} /></label>
        <button className="pink-button sheet-action" disabled={profileBusy || !hasWriteLock || !profileName.trim()} onClick={() => void saveCloudProfile(false).then(saved => { if (saved) setWelcomeStep('community'); })}>{profileBusy ? 'Saving…' : 'Continue'}</button>
      </> : <>
        <p>Drive with the map and explore roads. After this screen, your browser will ask for location so Guava can show where you are and record drives on this device.</p>
        <div className="welcome-choice"><strong>Join community play?</strong><span>If you join, road sections you drive appear on the live Territory map for other players, even when you are the only driver there. Players see anonymous vote counts on each section; captured roads can show your name. Short GPS segments are sent for matching while you drive, and saved trips add shared XP, distance and height. Quiet roads near home or work can reveal your habits. If you stay private, you won’t see other players’ scores or roads.</span></div>
        <button className="pink-button sheet-action" disabled={profileBusy || !hasWriteLock} onClick={() => void saveCloudProfile(true, true).then(saved => { if (saved) finishWelcome(); })}>{profileBusy ? 'Joining…' : 'Join community play'}</button>
        <button className="subtle-action sheet-action" onClick={finishWelcome}>Not now — keep my drives private</button>
        <small>You can change this later in Profile → Settings. The map needs location permission to navigate; sharing is separate.</small>
      </>}
    </section></div>}

    {!showWelcome && authUser && cloudProfile?.community_opt_in && (!cloudProfile.live_territory_consent_at || !cloudProfile.territory_detail_consent_at || !cloudProfile.open_territory_consent_at) && !dismissedLiveConsent && !driving && <div className="sheet-backdrop welcome-backdrop"><section className="bottom-sheet welcome-sheet" aria-label="Territory sharing has changed">
      <div className="sheet-header"><h2>Territory sharing has changed</h2><button onClick={() => setDismissedLiveConsent(true)} aria-label="Not now"><X size={22} /></button></div>
      <p>Live Territory now shows every road section being played today, even if only one person has driven it. Other players see anonymous vote counts, and captured roads may show your name. Short GPS segments are still sent for road matching during drives; XP, distance and height share when you save. Quiet roads near home or work may reveal your habits.</p>
      <p>Your old progress stays. New drives remain private until you accept this updated sharing.</p>
      <button className="pink-button sheet-action" disabled={profileBusy} onClick={() => void saveCloudProfile(true, true).then(saved => { if (saved) setDismissedLiveConsent(true); })}>{profileBusy ? 'Saving…' : 'Accept updated territory sharing'}</button>
      <button className="subtle-action sheet-action" onClick={() => setDismissedLiveConsent(true)}>Not now — new drives stay private</button>
    </section></div>}

    {panel === 'maps' && <div className="sheet-backdrop" onClick={() => setPanel('none')}><section className="bottom-sheet map-sheet" onClick={event => event.stopPropagation()}>
      <div className="sheet-header"><h2>Change your world</h2><button onClick={() => setPanel('none')} aria-label="Close"><X size={22} /></button></div>
      <p>Switch views anytime. All map views are free.</p>
      <div className="view-list">{mapViews.map(option => <div key={option} className="view-group"><button className={view === option ? 'active' : ''} onClick={() => { setView(option); setSelectedTerritory(null); setPanel('none'); }}>
        <span className="view-icon">{option === 'Altitude' ? <Mountain /> : option === 'My Roads' || option === 'Road Pulse' ? <Route /> : option === 'Satellite' ? <Layers3 /> : option === 'Dark' ? <Moon /> : option === 'Territory' ? <Flag /> : <MapIcon />}</span>
        <span><strong>{option}</strong><small>{!communityOptIn && (option === 'Road Pulse' || option === 'Territory') ? guestMode ? 'Sign in with Google to see shared roads' : 'Join community play to see shared roads' : option === 'My Roads' ? 'Your private saved drives on this device' : option === 'Satellite' ? '2025 imagery with road labels' : option === 'Road Pulse' ? 'How often community roads are used' : option === 'Territory' ? 'Captured and live contested road sections' : option === 'Altitude' ? 'Elevation colors and current altitude' : option === 'Dark' ? 'Dark everyday road map' : 'Everyday road map'}</small></span>
        {view === option && <span className="selected-mark">✓</span>}
      </button></div>)}</div>
    </section></div>}

    {panel === 'drive' && driving && <div className="sheet-backdrop" onClick={() => setPanel('none')}><section className="bottom-sheet" onClick={event => event.stopPropagation()}>
      <div className="sheet-header"><h2>End this drive?</h2><button onClick={() => setPanel('none')} aria-label="Close"><X size={22} /></button></div>
      <p>Save your trip and shared XP after parking. On an opted-in drive, territory visits already synced will still count if you discard the trip record.</p>
      <button className="sheet-action pink-button" disabled={actionBusy} onClick={() => void endDrive(true)}>Finish & Save</button>
      <button className="sheet-action subtle-action" disabled={actionBusy} onClick={() => void endDrive(false)}>Discard trip record</button>
      <button className="sheet-action text-action" onClick={() => setPanel('none')}>Keep Driving</button>
    </section></div>}

    {panel === 'profile' && <div className="full-screen-panel"><div className="full-header"><button onClick={() => setPanel('none')} aria-label="Close profile"><X /></button><h2>Profile</h2><button onClick={openSettings} aria-label="Settings"><Settings size={20} /></button></div>
      <div className="profile-body"><div className="xp-card"><div className="xp-topline"><small>{communityOptIn ? 'COMMUNITY XP' : 'LOCAL XP'}</small><small>LEVEL {Math.floor(displayXP / 500) + 1}</small></div><strong>{displayXP.toLocaleString()}</strong><div className="xp-track"><span style={{ width: `${displayXP % 500 / 5}%` }} /></div><span>{500 - displayXP % 500} XP to next level</span></div>
      <div className="identity-card"><div className="avatar"><UserRound /></div><div><strong>{cloudProfile?.display_name || profileName}</strong><small>{communityOptIn ? 'Community play on · drives saved on this device' : authUser ? 'Signed in · community play off' : 'Local profile · this browser'}</small></div></div>
      <div className="stats-grid"><div><Navigation /><small>Total distance</small><strong>{fmtDistance(totalDistance)}</strong></div><div><Timer /><small>Moving time</small><strong>{fmtTime(totalTime / 1000)}</strong></div><div><Mountain /><small>Height traveled</small><strong>{fmtDistance(totalHeight)}</strong></div><div><Flag /><small>Road explored*</small><strong>{fmtDistance(totalUnits * 25)}</strong></div></div>
      <h3>Personal insights</h3><div className="stats-grid"><div><Navigation /><small>Average moving speed</small><strong>{totalTime > 0 ? `${Math.round(totalDistance / (totalTime / 1000) * 3.6)} km/h` : '—'}</strong></div><div><Mountain /><small>Highest altitude</small><strong>{Number.isFinite(highestAltitude) ? `${Math.round(highestAltitude)} m` : '—'}</strong></div></div>
      <h3>Recent drives</h3>{trips.length ? trips.slice(0, 8).map(trip => <div className="history-row" key={trip.id}><span><strong>{trip.destination || 'Quick Start'}</strong><small>{new Date(trip.endedAt).toLocaleDateString()} · {fmtDistance(trip.distanceMeters)} · {fmtTime(movingTimeMs(trip.points) / 1000)} moving · {Math.round(trip.heightMeters)} m height · {trip.communityStatus === 'uploaded' ? 'shared' : trip.communityStatus === 'pending' ? 'waiting to share' : trip.communityStatus === 'failed' ? 'saved locally · sharing needs attention' : 'private'}</small></span><span><strong>+{trip.xp} XP</strong>{trip.communityError && <small>{trip.communityError}</small>}{sharingEnabled && canShareSavedDrive(trip, ownerId, now) && <button disabled={!hasWriteLock} className="text-action" onClick={() => shareSavedDrive(trip.id)}>Share this drive</button>}{sharingEnabled && (trip.communityStatus === 'pending' || trip.communityStatus === 'failed') && <button disabled={!hasWriteLock} className="text-action" onClick={() => retrySharing(trip.id)}>Retry sharing</button>}</span></div>) : <p className="empty-note">Your finished drives will appear here.</p>}
      <p className="privacy-note">Full GPS tracks stay in this browser. With community play on, short segments are sent for road matching during a drive so live road contests update then; completed drives are sent for XP, distance and height when saved. Other players can see active road sections. Browser recording may stop when locked or backgrounded. *Road explored is a local estimate.</p></div>
    </div>}

    {panel === 'settings' && <div className="full-screen-panel"><div className="full-header"><button onClick={() => setPanel('profile')} aria-label="Back to profile"><ArrowLeft /></button><h2>Settings</h2><span /></div><div className="profile-body">
      <h3>Account</h3><label className="settings-label">{guestMode ? 'Guest username' : 'Display name'}<input value={profileName} maxLength={32} onChange={event => setProfileName(event.target.value)} /></label>
      {authUser ? <><p className="empty-note">Signed in as {authUser.email}. Drive tracks are saved in this browser.</p>
        <label className="settings-label community-toggle">Join community play <input type="checkbox" checked={draftOptIn} disabled={!cloudProfile || profileBusy || !hasWriteLock} onChange={event => setDraftOptIn(event.target.checked)} /></label>
        <p className="settings-status" role="status">Active sharing: <strong>{sharingEnabled ? 'on' : 'off'}</strong>. {draftOptIn !== communityOptIn ? 'Unsaved change — Save profile to apply it.' : ''}</p>
        <p className="privacy-note">When on, short GPS segments are sent for road matching during a drive. Road sections you visit appear on other players’ live Territory maps, even if you are the only driver. Other players see anonymous vote counts and your name on roads you capture. Saved trips add shared XP, distance and height. Quiet roads can reveal where you travel. Turning this off deletes cloud game progress, but keeps local drives in this browser.</p>
        <button className="pink-button sheet-action" disabled={!cloudProfile || profileBusy || !hasWriteLock} onClick={() => void saveCloudProfile()}>{profileBusy ? 'Saving…' : 'Save profile'}</button>
        <button className="subtle-action sheet-action" onClick={() => void checkCommunityConnection()}>Check community connection</button>
        {connectionResult && <p className="empty-note" role="status">{connectionResult}</p>}
        <button className="subtle-action sheet-action" disabled={authBusy || actionBusy} onClick={() => void signOut()}>Sign out</button></> : <>
        {guestMode && <><p className="empty-note">Guest mode: your username and drives stay in this browser. Guest progress cannot be recovered on another device or added to a Google account automatically. Community scores and territory need Google sign-in.</p>
          <button className="pink-button sheet-action" onClick={saveGuestProfile}>Save username</button></>}
        {isSupabaseConfigured ? <button className="subtle-action sheet-action" disabled={authBusy || actionBusy || driving} onClick={() => void googleSignIn()}>{authBusy ? 'Connecting…' : 'Continue with Google for community play'}</button> : <p className="empty-note">Google sign-in is unavailable here. You can still use the map and keep local progress.</p>}
        {guestMode && <button className="text-action sheet-action" disabled={actionBusy || driving} onClick={onExitGuest}>Exit guest mode</button>}
      </>}
      {sharingEnabled && trips.some(trip => trip.communityStatus === 'pending' || trip.communityStatus === 'failed') && <button disabled={!hasWriteLock} className="subtle-action sheet-action" onClick={() => retrySharing()}>Retry waiting drives</button>}
      <h3>Navigation & privacy</h3><p className="privacy-note">Guava requests location while its web page is open. It records a trip only after you tap Start, and you choose Save or Discard when ending it. Full GPS tracks are stored only in this browser; opted-in territory segments are matched while driving, with summary scores shared after Save. Browser recording may pause when locked or backgrounded. <a href={privacyUrl} target="_blank" rel="noreferrer">Read the privacy notice</a>.</p>
      <button className="subtle-action sheet-action" onClick={() => downloadData(JSON.stringify(trips, null, 2), 'guava-drives.json')}>Export my local drives</button>
      <button className="subtle-action sheet-action" onClick={() => { void exportAccountData(ownerId).then(raw => downloadData(raw, 'guava-account-recovery.json')).catch(cause => setError(String(cause))); }}>Export recovery copy</button>
      {(() => { try { return hasLegacyTrips(); } catch { return false; } })() && <>
        <p className="privacy-note">Earlier drives on this browser were saved without an account owner. They are preserved separately and will not be shared automatically.</p>
        <button className="subtle-action sheet-action" onClick={() => { try { const raw = exportLegacyTrips(); if (raw) downloadData(raw, 'guava-earlier-drives.json'); } catch (cause) { setError(String(cause)); } }}>Export earlier browser drives</button>
      </>}

    </div></div>}

    {panel === 'leaderboard' && <div className="full-screen-panel"><div className="full-header"><button onClick={() => setPanel('none')} aria-label="Close leaderboard"><X /></button><h2>Leaderboard</h2><Trophy size={20} /></div><div className="profile-body">
      <button className="how-it-works-button" onClick={() => setLeaderboardHelp(true)}>How it works</button>
      <div className="leaderboard-categories">{(['XP', 'Distance', 'Height', 'Territory'] as const).map(metric => <button key={metric} className={leaderboardMetric === metric ? 'active' : ''} onClick={() => setLeaderboardMetric(metric)}>{metric === 'Height' ? 'Height Traveled' : metric}</button>)}</div>
        <div className="xp-card score-card"><small>{communityOptIn ? `YOUR SHARED ${leaderboardMetric.toUpperCase()}` : leaderboardMetric === 'Territory' ? 'YOUR EXPLORED ROADS' : `YOUR LOCAL ${leaderboardMetric.toUpperCase()}`}</small><strong>{communityOptIn ? liveRankValue(leaderboardMetric === 'XP' ? cloudScore?.xp || 0 : leaderboardMetric === 'Distance' ? cloudScore?.distance_m || 0 : leaderboardMetric === 'Height' ? cloudScore?.height_m || 0 : cloudScore?.territory_m || 0) : localMetric}</strong><span>{communityOptIn ? 'Scores from verified community drives.' : guestMode ? 'Sign in with Google to join the shared leaderboard.' : 'Join community play in Settings to appear on the live board.'}</span></div>
        {cloudError && <p className="empty-note">Community connection: {cloudError}</p>}
        {!communityOptIn && <button className="pink-button sheet-action" onClick={openSettings}>{guestMode ? 'Sign in with Google to play together' : 'Join community play'}</button>}
        {leaderboardMetric === 'Territory' && <div className="round-clock" aria-label="Time until territory round ends"><span>ROUND ENDS IN</span><strong>{israelRoundRemaining(now)}</strong><small>Ownership finalizes around 09:05 Israel time the next morning.</small></div>}
        {liveRankings.length ? <><div className="live-podium">{liveRankings.slice(0, 3).map((entry, index) => <div key={entry.id} className={`place-${index + 1}`}><span className="podium-avatar">{entry.name[0]}</span><strong>{entry.name}</strong><small>{liveRankValue(entry.value)}</small><b>{index + 1}</b></div>)}</div><div className="ranking-list">{liveRankings.slice(3).map((entry, index) => <div key={entry.id}><b>{index + 4}</b><strong>{entry.name}</strong><span>{liveRankValue(entry.value)}</span></div>)}</div></> : <p className="empty-note">{communityOptIn ? 'No community players yet.' : guestMode ? 'Guests have local progress only. Sign in with Google to see other players.' : 'Join community play to see other players and appear on the board.'}</p>}
    </div></div>}

    {panel === 'recap' && lastTrip && <div className="full-screen-panel"><div className="full-header"><button onClick={() => setPanel('none')} aria-label="Close drive recap"><X /></button><h2>Drive complete</h2><Flag size={20} /></div><div className="profile-body">
      <div className="xp-card"><small>YOU EARNED</small><strong>+{lastTrip.xp} XP</strong><span>{lastTrip.destination || 'Quick Start'} · {fmtClock(lastTrip.endedAt)}</span></div>
      {autoFinishAttemptRef.current === lastTrip.id && <p className="privacy-note">Saved automatically after 15 minutes without movement.</p>}
      <div className="stats-grid"><div><Navigation /><small>Distance</small><strong>{fmtDistance(lastTrip.distanceMeters)}</strong></div><div><Timer /><small>Moving time</small><strong>{fmtTime(movingTimeMs(lastTrip.points) / 1000)}</strong></div><div><Mountain /><small>Height</small><strong>{fmtDistance(lastTrip.heightMeters)}</strong></div><div><Flag /><small>New road*</small><strong>{fmtDistance(lastTrip.newRoadUnits * 25)}</strong></div></div>
      <p className="privacy-note">{lastTrip.communityStatus === 'uploaded' ? 'Added to the community leaderboard. Eligible road visits count toward ownership, which becomes final around 09:05 Israel time the next morning. Late uploads do not change finished rounds.' : lastTrip.communityStatus === 'pending' ? `Saved here, but not yet fully shared. ${lastTrip.communityError || 'Guava is checking the roads. It will retry automatically while online.'}` : lastTrip.communityStatus === 'failed' ? `Saved on this device. Sharing needs attention: ${lastTrip.communityError || 'Please check your connection and account.'}` : sharingEnabled && canShareSavedDrive(lastTrip, ownerId, now) ? 'Private drive saved on this device. You can choose to share it now; territory visits count only if it reaches the game before the round settles.' : 'Private drive saved on this device. Join community play in Settings before your next drive to compete.'} *Road is approximate local exploration, not awarded territory.</p>
      {sharingEnabled && canShareSavedDrive(lastTrip, ownerId, now) && <button disabled={!hasWriteLock} className="subtle-action sheet-action" onClick={() => shareSavedDrive(lastTrip.id)}>Share this drive</button>}
      {sharingEnabled && (lastTrip.communityStatus === 'pending' || lastTrip.communityStatus === 'failed') && <button disabled={!hasWriteLock} className="subtle-action sheet-action" onClick={() => retrySharing(lastTrip.id)}>Retry sharing</button>}
      <button className="pink-button sheet-action" onClick={() => setPanel('none')}>Back to map</button>
    </div></div>}

    {error && <div className="error-toast" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss message"><X size={16} /></button></div>}
    {locationError && !driving && panel === 'none' && <div className="location-note"><Compass size={17} /><span>{locationError}</span><button className="text-action" onClick={() => setLocationRequest(value => value + 1)}>Retry GPS</button></div>}
    {(storageError || initialStorageError) && <div className="storage-warning" role="alert"><span>{storageError || initialStorageError}</span><button onClick={() => {
      if (initialStorageError) void exportAccountData(ownerId).then(raw => downloadData(raw, 'guava-account-recovery.json')).catch(cause => setError(String(cause)));
      else downloadData(JSON.stringify({ trips: tripsRef.current, draft: driveRef.current || recoverable }), 'guava-unsaved-recovery.json');
    }}>Export recovery copy</button></div>}
    {recoverable && hasWriteLock && !driving && !showWelcome && (!authUser || cloudProfile || preference(`guava.welcome.${authUser.id}`) === 'done') && <div className="sheet-backdrop welcome-backdrop"><section className="bottom-sheet" role="dialog" aria-modal="true" aria-label="Unfinished drive">
      <div className="sheet-header"><h2>Your drive is still here</h2></div>
      <p>{fmtDistance(recoverable.distance)} recorded on {new Date(recoverable.startedAt).toLocaleDateString()}. Your recorded progress is safe here. Travel while Guava was closed is not counted.</p>
      {now - recoverable.startedAt < 7.75 * 60 * 60 * 1000
        ? <button className="pink-button sheet-action" disabled={actionBusy} onClick={() => void resumeDrive()}>Resume drive</button>
        : <p>This session is too old to resume. Save the recorded part, then start a new drive.</p>}
      <button className="subtle-action sheet-action" disabled={actionBusy} onClick={() => void endDrive(true, true)}>Save recorded part</button>
      <button className="text-action sheet-action" onClick={() => { if (window.confirm('Discard this unfinished trip record? Already synced territory visits may still count.')) endDrive(false, true); }}>Discard unfinished drive</button>
    </section></div>}
    {leaderboardHelp && <LeaderboardIntro onClose={closeLeaderboardHelp} />}
  </div>;
}
