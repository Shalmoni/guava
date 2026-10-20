import type { CloudRoad } from './cloud';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function israelDay(timestamp: number): string {
  const parts = dayFormatter.formatToParts(timestamp);
  const value = (type: string) => parts.find(part => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function israelRoundRemaining(timestamp: number): string {
  const today = israelDay(timestamp);
  let low = timestamp;
  let high = timestamp + 48 * 60 * 60 * 1000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (israelDay(mid) === today) low = mid;
    else high = mid;
  }
  const seconds = Math.max(0, Math.ceil((high - timestamp) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function territoryAge(capturedOn: string | null, timestamp: number): string {
  if (!capturedOn) return 'date unavailable';
  const today = Date.parse(`${israelDay(timestamp)}T00:00:00Z`);
  const capture = Date.parse(`${capturedOn}T00:00:00Z`);
  if (!Number.isFinite(capture)) return 'date unavailable';
  const days = Math.max(0, Math.round((today - capture) / 86_400_000));
  return days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
}

const neighbors: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];

export function connectedTerritory(roads: CloudRoad[], startId: string): { cells: number; meters: number } | null {
  const byId = new Map(roads.map(road => [road.id, road]));
  const first = byId.get(startId);
  if (!first) return null;
  const same = (road: CloudRoad) => first.contested ? road.contested : !road.contested && road.owner_id === first.owner_id;
  const visited = new Set<string>();
  const queue = [startId];
  let meters = 0;
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    if (visited.has(id)) continue;
    const road = byId.get(id);
    if (!road || !same(road)) continue;
    visited.add(id);
    meters += road.length_m;
    const match = /^h:(-?\d+):(-?\d+)$/.exec(id);
    if (!match) continue;
    const q = Number(match[1]), r = Number(match[2]);
    for (const [dq, dr] of neighbors) {
      const next = `h:${q + dq}:${r + dr}`;
      if (!visited.has(next) && byId.has(next)) queue.push(next);
    }
  }
  return { cells: visited.size, meters };
}
