import type { Point, Trip } from './model';
import { territoryColor } from './game';
import { supabase } from './supabase';

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
  traversal_count: number;
  unique_drivers: number;
};
export type CloudProfile = { user_id: string; display_name: string; community_opt_in: boolean };
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
  lastSettlement: string | null;
};

export async function loadCloudGame(): Promise<CloudGame> {
  if (!supabase) throw new Error('Guava community is not connected.');
  const [scores, roads, profiles, drives, rounds] = await Promise.all([
    supabase.from('guava_game_scores').select('user_id,xp,distance_m,height_m,territory_m,drive_count').limit(200),
    supabase.from('guava_road_units').select('id,line,length_m,owner_id,traversal_count,unique_drivers').limit(5000),
    supabase.from('guava_profiles').select('user_id,display_name,community_opt_in').limit(200),
    supabase.from('guava_game_drives').select('id,started_at,ended_at,distance_m,height_m,xp').order('ended_at', { ascending: false }).limit(30),
    supabase.from('guava_territory_rounds').select('round_date').order('round_date', { ascending: false }).limit(1),
  ]);
  for (const result of [scores, roads, profiles, drives, rounds]) if (result.error) throw result.error;
  return {
    scores: (scores.data || []) as CloudScore[], roads: (roads.data || []) as CloudRoad[],
    profiles: (profiles.data || []) as CloudProfile[], drives: (drives.data || []) as CloudDrive[],
    lastSettlement: rounds.data?.[0]?.round_date || null,
  };
}

export async function uploadCommunityDrive(trip: Trip): Promise<{ xp: number; distance_m: number; height_m: number }> {
  if (!supabase) throw new Error('Guava community is not connected.');
  const { data, error } = await supabase.functions.invoke('submit-drive', {
    body: { id: trip.id, startedAt: trip.startedAt, endedAt: trip.endedAt, points: trip.points },
  });
  if (error) {
    const response = 'context' in error ? (error as { context?: Response }).context : undefined;
    const payload = response ? await response.clone().json().catch(() => null) as { error?: string } | null : null;
    throw new Error(payload?.error || error.message);
  }
  if (data?.already_saved) {
    const { data: existing, error: readError } = await supabase.from('guava_game_drives')
      .select('xp,distance_m,height_m').eq('id', trip.id).single();
    if (readError || !existing) throw new Error('Drive was saved, but Guava could not load its shared score.');
    return { xp: Number(existing.xp), distance_m: Number(existing.distance_m), height_m: Number(existing.height_m) };
  }
  return { xp: Number(data.xp || 0), distance_m: Number(data.distance_m || 0), height_m: Number(data.height_m || 0) };
}

export function cloudRankings(game: CloudGame, metric: 'XP' | 'Distance' | 'Height' | 'Territory', me: string) {
  const names = new Map(game.profiles.filter(profile => profile.community_opt_in).map(profile => [profile.user_id, profile.display_name]));
  return game.scores.filter(score => names.has(score.user_id)).map(score => ({
    id: score.user_id,
    name: score.user_id === me ? 'You' : names.get(score.user_id) || 'Driver',
    color: territoryColor(score.user_id === me ? 'you' : score.user_id),
    value: metric === 'XP' ? score.xp : metric === 'Distance' ? score.distance_m
      : metric === 'Height' ? score.height_m : score.territory_m,
  })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

export function cloudTerritoryLayers(game: CloudGame, me: string) {
  const optedIn = new Set(game.profiles.filter(profile => profile.community_opt_in).map(profile => profile.user_id));
  const layers: Record<string, { color: string; lines: Point[][]; unitIds: string[]; stretchMeters: number[]; width: number }> = {};
  for (const road of game.roads) {
    if (!road.owner_id || !optedIn.has(road.owner_id) || !Array.isArray(road.line) || road.line.length < 2) continue;
    const ownerId = road.owner_id;
    const layer = layers[ownerId] ||= {
      color: territoryColor(ownerId === me ? 'you' : ownerId), lines: [], unitIds: [], stretchMeters: [], width: 9,
    };
    layer.lines.push(road.line);
    layer.unitIds.push(road.id);
    layer.stretchMeters.push(road.length_m);
  }
  return layers;
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
