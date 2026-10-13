import type { Point } from './model';

export type DriverId = 'you' | 'maya' | 'noam';
export type RoadVisit = { unitId: string; driverId: DriverId; driveId: string };
export type RoadPiece = { unitId: string; line: Point[] };
export type RoundResult = { owners: Map<string, DriverId | null>; contested: Set<string> };

export const DEMO_DRIVERS: Record<DriverId, { name: string; color: string; xp: number; distanceKm: number; heightM: number }> = {
  you: { name: 'You', color: '#f18ca0', xp: 192, distanceKm: 31.4, heightM: 410 },
  maya: { name: 'Maya · demo', color: '#67b8a2', xp: 225, distanceKm: 26.7, heightM: 365 },
  noam: { name: 'Noam · demo', color: '#e9af66', xp: 164, distanceKm: 35.2, heightM: 290 },
};

// Each drive contributes at most one visit per road unit, regardless of loops.
export function settleRound(previous: Map<string, DriverId | null>, visits: RoadVisit[]): RoundResult {
  const counts = new Map<string, Map<DriverId, Set<string>>>();
  for (const visit of visits) {
    const byDriver = counts.get(visit.unitId) ?? new Map<DriverId, Set<string>>();
    const drives = byDriver.get(visit.driverId) ?? new Set<string>();
    drives.add(visit.driveId);
    byDriver.set(visit.driverId, drives);
    counts.set(visit.unitId, byDriver);
  }
  const owners = new Map(previous);
  const contested = new Set<string>();
  for (const [unitId, byDriver] of counts) {
    const maximum = Math.max(...[...byDriver.values()].map(drives => drives.size));
    const leaders = [...byDriver.entries()].filter(([, drives]) => drives.size === maximum);
    if (leaders.length === 1) owners.set(unitId, leaders[0][0]);
    else { owners.set(unitId, null); contested.add(unitId); }
  }
  return { owners, contested };
}

export function settleDailyRound(previous: Map<string, DriverId | null>, visits: RoadVisit[], roundStart: number, at: number): RoundResult {
  if (!Number.isFinite(roundStart) || roundStart % 86_400_000 !== 0) throw new Error('Round must start at 00:00 UTC.');
  if (at < roundStart + 86_400_000 + 300_000) throw new Error('Daily round cannot settle before 00:05 UTC the next day.');
  return settleRound(previous, visits);
}

export function territoryScores(owners: Map<string, DriverId | null>, metresPerUnit = 25): Record<DriverId, number> {
  const scores: Record<DriverId, number> = { you: 0, maya: 0, noam: 0 };
  for (const owner of owners.values()) if (owner) scores[owner] += metresPerUnit;
  return scores;
}

function webMercatorCell(point: Point): string {
  const longitude = 6378137 * point[0] * Math.PI / 180;
  const latitude = Math.max(-85, Math.min(85, point[1])) * Math.PI / 180;
  const northing = 6378137 * Math.log(Math.tan(Math.PI / 4 + latitude / 2));
  return `${Math.floor(longitude / 25)}:${Math.floor(northing / 25)}`;
}

// The review simulation uses 25 m proxy cells. Real competition needs stable
// map-matched road-plus-hex IDs; this does not award anybody live territory.
export function roadPieces(points: Point[]): RoadPiece[] {
  const pieces: RoadPiece[] = [];
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1];
    const b = points[index];
    const distance = Math.hypot((a[0] - b[0]) * 94000, (a[1] - b[1]) * 111000);
    const steps = Math.max(1, Math.ceil(distance / 12));
    for (let step = 0; step < steps; step++) {
      const from: Point = [a[0] + (b[0] - a[0]) * step / steps, a[1] + (b[1] - a[1]) * step / steps];
      const to: Point = [a[0] + (b[0] - a[0]) * (step + 1) / steps, a[1] + (b[1] - a[1]) * (step + 1) / steps];
      pieces.push({ unitId: webMercatorCell(from), line: [from, to] });
    }
  }
  return pieces;
}

export function demoRound(pieces: RoadPiece[][], completed: boolean): RoundResult {
  const [main = [], spur = []] = pieces;
  const visits: RoadVisit[] = [];
  const add = (road: RoadPiece[], driverId: DriverId, driveId: string) => {
    for (const piece of road) visits.push({ unitId: piece.unitId, driverId, driveId });
  };
  add(main, 'you', 'you-am');
  add(main, 'maya', 'maya-am');
  add(spur, 'noam', 'noam-am');
  if (completed) {
    add(main.slice(0, Math.round(main.length * .54)), 'you', 'you-pm');
    add(main.slice(Math.round(main.length * .4)), 'maya', 'maya-pm');
    add(spur, 'noam', 'noam-pm');
  }
  const roundStart = Date.UTC(2026, 9, 13);
  return completed
    ? settleDailyRound(new Map(), visits, roundStart, roundStart + 86_400_000 + 300_000)
    : settleRound(new Map(), visits); // provisional leaders, not committed ownership
}

export function sortedDemoLeaderboard(metric: 'XP' | 'Distance' | 'Height' | 'Territory', owners: Map<string, DriverId | null>) {
  const territory = territoryScores(owners);
  return (Object.keys(DEMO_DRIVERS) as DriverId[]).map(id => ({
    id, name: DEMO_DRIVERS[id].name, color: DEMO_DRIVERS[id].color,
    value: metric === 'XP' ? DEMO_DRIVERS[id].xp : metric === 'Distance' ? DEMO_DRIVERS[id].distanceKm : metric === 'Height' ? DEMO_DRIVERS[id].heightM : territory[id],
  })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}
