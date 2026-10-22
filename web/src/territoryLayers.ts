import type { Point } from './model';
import type { CloudGame } from './cloud';

export function cloudTerritoryLayers(game: CloudGame, me: string) {
  const optedIn = new Set(game.profiles.filter(profile => profile.community_opt_in).map(profile => profile.user_id));
  const layers: Record<string, { color: string; lines: Point[][]; unitIds: string[]; stretchMeters: number[]; width: number }> = {};
  for (const road of game.roads) {
    if (!Array.isArray(road.line) || road.line.length < 2) continue;
    if (!road.contested && (!road.owner_id || !optedIn.has(road.owner_id))) continue;
    const ownerId = road.contested ? 'contested' : road.owner_id!;
    const layer = layers[ownerId] ||= {
      color: ownerId === 'contested' ? '#d7dadd' : ownerId === me ? '#f18ca0' : '#484d53', lines: [], unitIds: [], stretchMeters: [], width: 9,
    };
    layer.lines.push(road.line);
    layer.unitIds.push(road.id);
    layer.stretchMeters.push(road.length_m);
  }
  return layers;
}
