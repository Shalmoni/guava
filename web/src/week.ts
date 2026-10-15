import { distanceMeters, type Point } from './model';
import { capturedStretches, DEMO_DRIVERS, WEEK_DRIVER_IDS, settleDailyRound, territoryScores, type DriverId, type RoadPiece, type RoadVisit, type RoundResult } from './game';

export type WeekStats = Record<DriverId, { xp: number; distanceMeters: number; heightMeters: number; drives: number }>;
export type PulseUnit = { count: number; drivers: Set<DriverId> };
export type WeekSnapshot = { day: number; result: RoundResult; stats: WeekStats; pulse: Map<string, PulseUnit>; driveCount: number };
export type WeekScene = { roads: RoadPiece[][]; snapshots: WeekSnapshot[]; linesByUnit: Map<string, Point[][]> };

const START = Date.UTC(2026, 9, 5); // deterministic Monday-to-Sunday scenario

function emptyStats(): WeekStats {
  return Object.fromEntries(WEEK_DRIVER_IDS.map(id => [id, { xp: 0, distanceMeters: 0, heightMeters: 0, drives: 0 }])) as WeekStats;
}

function routeDistance(road: RoadPiece[]): number {
  return road.reduce((sum, piece) => sum + distanceMeters(piece.line[0], piece.line[1]), 0);
}

export function simulateWeek(roads: RoadPiece[][]): WeekScene {
  if (roads.length < WEEK_DRIVER_IDS.length || roads.some(road => !road.length)) throw new Error('The week scenario requires ten road routes.');
  const linesByUnit = new Map<string, Point[][]>();
  for (const piece of roads.flat()) {
    const lines = linesByUnit.get(piece.unitId) || [];
    lines.push(piece.line);
    linesByUnit.set(piece.unitId, lines);
  }
  let owners = new Map<string, DriverId | null>();
  const stats = emptyStats();
  const pulse = new Map<string, PulseUnit>();
  const seen = Object.fromEntries(WEEK_DRIVER_IDS.map(id => [id, new Set<string>()])) as Record<DriverId, Set<string>>;
  const snapshots: WeekSnapshot[] = [];
  let driveCount = 0;

  for (let day = 0; day < 7; day++) {
    const visits: RoadVisit[] = [];
    for (let index = 0; index < WEEK_DRIVER_IDS.length; index++) {
      const driverId = WEEK_DRIVER_IDS[index];
      const primary = index;
      // One home commute per player, at varying daily frequency. A few take
      // side trips; overlaps create competition without making every road a tie.
      const tripRoutes = Array.from({ length: 1 + (index * 7 + day * 3) % 3 }, () => primary);
      if ((day * 3 + index) % 5 === 0) tripRoutes.push((primary + 1) % roads.length);

      tripRoutes.forEach((routeIndex, withinDay) => {
        const route = roads[routeIndex];
        const uniqueUnits = new Set(route.map(piece => piece.unitId));
        const driveId = `day${day + 1}-${driverId}-${withinDay}`;
        const distance = routeDistance(route);
        const height = Math.round(distance / 1000 * (9 + (index * 3 + day) % 12));
        const newUnits = [...uniqueUnits].filter(unit => !seen[driverId].has(unit));
        for (const unit of newUnits) seen[driverId].add(unit);
        const player = stats[driverId];
        player.distanceMeters += distance;
        player.heightMeters += height;
        player.drives++;
        player.xp += 10 + Math.floor(distance / 1000 * 8) + Math.floor(height / 20) + newUnits.length * 2;
        driveCount++;
        for (const unitId of uniqueUnits) {
          visits.push({ unitId, driverId, driveId });
          const existing = pulse.get(unitId) || { count: 0, drivers: new Set<DriverId>() };
          existing.count++;
          existing.drivers.add(driverId);
          pulse.set(unitId, existing);
        }
      });
    }
    const roundStart = START + day * 86_400_000;
    const result = settleDailyRound(owners, visits, roundStart, roundStart + 86_400_000 + 300_000);
    owners = result.owners;
    snapshots.push({
      day: day + 1, result,
      stats: Object.fromEntries(WEEK_DRIVER_IDS.map(id => [id, { ...stats[id] }])) as WeekStats,
      pulse: new Map([...pulse].map(([unit, entry]) => [unit, { count: entry.count, drivers: new Set(entry.drivers) }])),
      driveCount,
    });
  }
  return { roads, snapshots, linesByUnit };
}

export function weekLeaderboard(metric: 'XP' | 'Distance' | 'Height' | 'Territory', snapshot: WeekSnapshot) {
  const territory = territoryScores(snapshot.result.owners);
  return WEEK_DRIVER_IDS.map(id => ({
    id, name: DEMO_DRIVERS[id].name, color: DEMO_DRIVERS[id].color,
    value: metric === 'XP' ? snapshot.stats[id].xp
      : metric === 'Distance' ? snapshot.stats[id].distanceMeters
        : metric === 'Height' ? snapshot.stats[id].heightMeters : territory[id],
  })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

export function weekMapLayers(scene: WeekScene, snapshot: WeekSnapshot) {
  const territory = Object.fromEntries(WEEK_DRIVER_IDS.map(id => [id, { color: DEMO_DRIVERS[id].color, lines: [] as Point[][], unitIds: [] as string[], stretchMeters: [] as number[], width: id === 'you' ? 11 : 8 }])) as Record<string, { color: string; lines: Point[][]; unitIds: string[]; stretchMeters: number[]; width: number }>;
  for (const stretch of capturedStretches(scene.roads, snapshot.result.owners)) {
    const layer = territory[stretch.ownerId];
    layer.lines.push(stretch.line);
    layer.unitIds.push(stretch.unitId);
    layer.stretchMeters.push(stretch.lengthMeters);
  }
  const pulse = Array.from({ length: 4 }, (_, index) => ({ color: ['#edc7c8', '#e7a1aa', '#d9718b', '#a94d68'][index], lines: [] as Point[][], width: 6 + index * 1.2 }));
  const eligibleCounts = [...snapshot.pulse.values()].filter(use => use.drivers.size >= 3).map(use => use.count).sort((a, b) => a - b);
  const quantile = (fraction: number) => eligibleCounts[Math.floor((eligibleCounts.length - 1) * fraction)] ?? Infinity;
  const cutoffs = [quantile(.25), quantile(.5), quantile(.75)];
  for (const [unitId, lines] of scene.linesByUnit) {
    const use = snapshot.pulse.get(unitId);
    // Provisional privacy floor: do not reveal a road used by fewer than three drivers.
    if (use && use.drivers.size >= 3) {
      const bucket = use.count > cutoffs[2] ? 3 : use.count > cutoffs[1] ? 2 : use.count > cutoffs[0] ? 1 : 0;
      pulse[bucket].lines.push(...lines);
    }
  }
  return { territory, pulse };
}
