import type { DrivePoint, Point, Trip } from './model';
import { israelDay } from './territory';
import { supabase } from './supabase';
import { CloudUploadError, uploadError } from './cloudErrors';
export { CloudUploadError } from './cloudErrors';
export { cloudTerritoryLayers } from './territoryLayers';
export { cloudRankings } from './leaderboard';

export type CloudScore = {
  user_id: string;
  xp: number;
  distance_m: number;
  height_m: number;
  territory_m: number;
  drive_count: number;
};
export type CloudRoad = {
  id: string;
  line: Point[];
  length_m: number;
  owner_id: string | null;
  decided_on: string | null;
  captured_on: string | null;
  traversal_count: number;
  unique_drivers: number;
  contested: boolean;
  active_contest: boolean;
  vote_round_date: string | null;
  player_count: number | null;
  top_score: number | null;
  your_score: number | null;
};
export type CloudProfile = { user_id: string; display_name: string; community_opt_in: boolean; live_territory_consent_at: string | null; territory_detail_consent_at: string | null; open_territory_consent_at: string | null };
export type CloudDrive = {
  id: string;
  started_at: string;
  ended_at: string;
  distance_m: number;
  height_m: number;
  xp: number;
};
export type CloudGame = {
  scores: CloudScore[];
  roads: CloudRoad[];
  profiles: CloudProfile[];
  drives: CloudDrive[];
};

export async function loadCloudGame(viewerId: string, hasDetailsConsent: boolean): Promise<CloudGame> {
  if (!supabase) throw new Error('Guava community is not connected.');
  const [scores, roads, profiles, drives] = await Promise.all([
    supabase.from('guava_game_scores').select('user_id,xp,distance_m,height_m,territory_m,drive_count').limit(200),
    supabase.from('guava_road_units').select('id,line,length_m,owner_id,decided_on,captured_on,traversal_count,unique_drivers').limit(5000),
    supabase.from('guava_profiles').select('user_id,display_name,community_opt_in').limit(200),
    supabase.from('guava_game_drives').select('id,started_at,ended_at,distance_m,height_m,xp').order('ended_at', { ascending: false }).limit(30),
  ]);
  for (const result of [scores, roads, profiles, drives]) if (result.error) throw result.error;
  const visibleRoads = (roads.data || []) as CloudRoad[];
  const ownProfile = (profiles.data || []).find(profile => profile.user_id === viewerId);
  const voteRows: Array<{ unit_id: string; round_date: string; top_score: number; player_count: number; your_score: number }> = [];
  if (ownProfile?.community_opt_in && hasDetailsConsent && visibleRoads.length) {
    const response = await supabase.functions.invoke('territory-snapshot', {
      body: { unitIds: visibleRoads.map(road => road.id) },
    });
    if (response.error) throw response.error;
    voteRows.push(...(response.data?.scores || []));
  }
  const today = israelDay(Date.now());
  const voteByUnit = new Map<string, typeof voteRows[number]>();
  for (const vote of voteRows) {
    const prior = voteByUnit.get(vote.unit_id);
    if (!prior || vote.round_date === today) voteByUnit.set(vote.unit_id, vote);
  }
  const enrichedRoads = visibleRoads.map(road => {
    const vote = voteByUnit.get(road.id);
    const activeContest = Boolean(vote && (vote.round_date === today || road.decided_on !== vote.round_date));
    return {
      ...road,
      contested: activeContest || Boolean(road.owner_id === null && road.decided_on),
      active_contest: activeContest,
      vote_round_date: vote?.round_date ?? null,
      player_count: vote?.player_count ?? null,
      top_score: vote?.top_score ?? null,
      your_score: vote?.your_score ?? null,
    };
  });
  return {
    scores: (scores.data || []) as CloudScore[], roads: enrichedRoads,
    profiles: (profiles.data || []) as CloudProfile[], drives: (drives.data || []) as CloudDrive[],
  };
}

async function uploadAuthorization(ownerId: string): Promise<{ Authorization: string }> {
  if (!supabase) throw new CloudUploadError('Guava community is not connected.', true);
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new CloudUploadError('Sign in again before sharing this drive.', false, 401);
  if (!ownerId || ownerId === 'local' || data.session.user.id !== ownerId) {
    throw new CloudUploadError('This drive belongs to a different account.', false, 403);
  }
  // Capture the token before invoking: switching accounts during a queued upload
  // must never submit A's trip with B's credentials.
  return { Authorization: `Bearer ${data.session.access_token}` };
}

export async function uploadCommunityDrive(trip: Trip, ownerId: string): Promise<{ xp: number; distance_m: number; height_m: number; late_units: number }> {
  if (!supabase) throw new CloudUploadError('Guava community is not connected.', true);
  if (trip.ownerId !== ownerId) throw new CloudUploadError('This drive belongs to a different account.', false, 403);
  const headers = await uploadAuthorization(ownerId);
  const { data, error } = await supabase.functions.invoke('submit-drive', {
    headers,
    body: { id: trip.id, ownerId, startedAt: trip.startedAt, endedAt: trip.endedAt, points: trip.points },
  });
  if (error) throw await uploadError(error);
  if (!data || !Number.isFinite(data.xp) || !Number.isFinite(data.distance_m) || !Number.isFinite(data.height_m)) {
    throw new CloudUploadError('The shared drive response was incomplete. Retry to confirm it was saved.', true);
  }
  return { xp: data.xp, distance_m: data.distance_m, height_m: data.height_m, late_units: Number(data.late_units || 0) };
}

export async function bankTerritorySegment(sessionId: string, startedAt: number, points: DrivePoint[], ownerId: string): Promise<number> {
  if (!supabase) throw new CloudUploadError('Guava community is not connected.', true);
  const headers = await uploadAuthorization(ownerId);
  const { data, error } = await supabase.functions.invoke('record-territory', {
    headers,
    body: { sessionId, ownerId, startedAt, points },
  });
  if (error) throw await uploadError(error);
  return Number(data?.banked || 0);
}

export function cloudPulseLayers(game: CloudGame) {
  const bins: Array<{ color: string; lines: Point[][]; width: number }> = [
    { color: '#f7d3d0', lines: [], width: 6 },
    { color: '#eeaaa7', lines: [], width: 7 },
    { color: '#df7e7a', lines: [], width: 8 },
    { color: '#c84e4a', lines: [], width: 9 },
  ];
  for (const road of game.roads) {
    if (road.unique_drivers < 3 || !Array.isArray(road.line) || road.line.length < 2) continue;
    const bin = Math.min(3, Math.floor(Math.log2(Math.max(1, road.traversal_count / 3))));
    bins[bin].lines.push(road.line);
  }
  return bins;
}
