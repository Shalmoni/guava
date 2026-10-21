export type Point = [number, number];
export type Fix = { position: Point; altitude: number | null; timestamp: number; accuracy?: number; segmentStart?: boolean };
export type Unit = { id: string; line: Point[]; length_m: number };
export type TimedUnit = Unit & { observed_at: string };
export const MAX_DRIVE_POINTS = 40_000;
export const MAX_ROAD_UNITS = 20_000;
export const MAX_DRIVE_BODY_BYTES = 8 * 1024 * 1024;
export const SAVED_DRIVE_MAX_AGE_MS = 7 * 24 * 3600_000;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
});
export const localDay = (timestamp: number) => dayFormatter.format(timestamp);

export function metres(a: Point, b: Point): number {
  const lat = (a[1] + b[1]) / 2 * Math.PI / 180;
  return Math.hypot((a[0] - b[0]) * 111320 * Math.cos(lat), (a[1] - b[1]) * 111320);
}

function hexKey([longitude, latitude]: Point): string {
  const x = 6378137 * longitude * Math.PI / 180;
  const clipped = Math.max(-85, Math.min(85, latitude)) * Math.PI / 180;
  const y = 6378137 * Math.log(Math.tan(Math.PI / 4 + clipped / 2));
  const radius = 15;
  const q = (Math.sqrt(3) / 3 * x - y / 3) / radius;
  const r = 2 / 3 * y / radius;
  let cq = Math.round(q), cr = Math.round(r), cs = Math.round(-q - r);
  const dq = Math.abs(cq - q), dr = Math.abs(cr - r), ds = Math.abs(cs + q + r);
  if (dq > dr && dq > ds) cq = -cr - cs;
  else if (dr > ds) cr = -cq - cs;
  return `h:${cq}:${cr}`;
}

export function roadUnits(lines: Point[][]): Unit[] {
  const units = new Map<string, Unit>();
  for (const line of lines) for (let index = 1; index < line.length; index++) {
    const a = line[index - 1], b = line[index];
    const distance = metres(a, b);
    if (distance < 0.5 || distance > 500) continue;
    const steps = Math.ceil(distance / 8);
    for (let part = 0; part < steps; part++) {
      const from: Point = [a[0] + (b[0] - a[0]) * part / steps, a[1] + (b[1] - a[1]) * part / steps];
      const to: Point = [a[0] + (b[0] - a[0]) * (part + 1) / steps, a[1] + (b[1] - a[1]) * (part + 1) / steps];
      const mid: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
      const id = hexKey(mid);
      const existing = units.get(id);
      if (!existing) units.set(id, { id, line: [from, to], length_m: 25 });
      else if (metres(existing.line[existing.line.length - 1], from) < 2) existing.line[1] = to;
    }
  }
  return [...units.values()];
}

export function validFix(value: unknown): value is Fix {
  if (!value || typeof value !== 'object') return false;
  const fix = value as Partial<Fix>;
  return Array.isArray(fix.position) && fix.position.length === 2
    && fix.position.every(Number.isFinite)
    && fix.position[0] >= 34 && fix.position[0] <= 36.5
    && fix.position[1] >= 29 && fix.position[1] <= 34
    && Number.isFinite(fix.timestamp)
    && (fix.segmentStart === undefined || typeof fix.segmentStart === 'boolean')
    && (fix.altitude === null || typeof fix.altitude === 'number' && Number.isFinite(fix.altitude))
    && (fix.accuracy === undefined || typeof fix.accuracy === 'number' && Number.isFinite(fix.accuracy)
      && fix.accuracy >= 0 && fix.accuracy <= 100);
}

export function startsSegment(previous: Fix, current: Fix): boolean {
  return current.segmentStart === true || current.timestamp - previous.timestamp > 30_000
    || metres(previous.position, current.position) > 300;
}

/** Keep gaps separate, and assign a midnight crossing to its arrival day. */
export function traceSections(points: Fix[]): Fix[][] {
  const sections: Fix[][] = [];
  let section: Fix[] = [];
  for (const current of points) {
    const previous = section.at(-1);
    if (previous && (startsSegment(previous, current) || localDay(previous.timestamp) !== localDay(current.timestamp))) {
      if (section.length >= 2) sections.push(section);
      section = startsSegment(previous, current) ? [current] : [previous, current];
    } else section.push(current);
  }
  if (section.length >= 2) sections.push(section);
  return sections;
}

/** Validation runs on every original fix; sampling is only for the matcher. */
export function traceStats(points: Fix[], startedAt: number, endedAt: number) {
  let distance = 0, height = 0, altitudeAnchor: number | null = null;
  for (let index = 0; index < points.length; index++) {
    const fix = points[index], previous = points[index - 1];
    if (fix.timestamp < startedAt - 120_000 || fix.timestamp > endedAt + 120_000) {
      throw new Error('GPS time outside drive');
    }
    if (previous) {
      const seconds = (fix.timestamp - previous.timestamp) / 1000;
      const step = metres(previous.position, fix.position);
      if (seconds <= 0) throw new Error('GPS timestamps must increase');
      if (startsSegment(previous, fix)) altitudeAnchor = null;
      else {
        if (step > Math.max(150, seconds * 58)) throw new Error('Implausible GPS movement');
        distance += step;
      }
    }
    if (fix.altitude !== null) {
      if (altitudeAnchor !== null && Math.abs(fix.altitude - altitudeAnchor) >= 3) {
        height += Math.min(50, Math.abs(fix.altitude - altitudeAnchor));
        altitudeAnchor = fix.altitude;
      } else if (altitudeAnchor === null) altitudeAnchor = fix.altitude;
    }
  }
  return { distance, height: Math.min(10_000, Math.round(height)) };
}

export class DriveRequestError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

/** Read with a hard byte limit even when Content-Length is absent. */
export async function readDriveBody(request: Request, maxBytes = MAX_DRIVE_BODY_BYTES): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('Content-Length')) > maxBytes) throw new DriveRequestError('Drive upload is too large', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new DriveRequestError('Invalid drive data', 400);
  const decoder = new TextDecoder();
  let size = 0, text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new DriveRequestError('Drive upload is too large', 413);
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    const body = JSON.parse(text + decoder.decode());
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new DriveRequestError('Invalid drive data', 400); }
}

// Keep local turns instead of reducing an entire multi-hour drive to 40 points.
export function sampleForMatching(points: Fix[]): Fix[] {
  const sampled = [points[0]];
  let travelled = 0;
  for (let index = 1; index < points.length; index++) {
    travelled += metres(points[index - 1].position, points[index].position);
    if (travelled >= 50 || points[index].timestamp - sampled.at(-1)!.timestamp >= 20_000 || index === points.length - 1) {
      sampled.push(points[index]);
      travelled = 0;
    }
  }
  return sampled;
}

type Match = { distance: number; geometry: { coordinates: Point[] } };

/** Four requests at a time, each at most 80 points; no request spans a GPS gap. */
export async function matchTrace(points: Fix[], baseUrl: string, fetcher: typeof fetch = fetch) {
  const jobs = traceSections(points).flatMap(section => {
    const sampled = sampleForMatching(section);
    const batches: Array<{ fixes: Fix[]; observedAt: number }> = [];
    for (let index = 0; index < sampled.length - 1; index += 79) {
      const fixes = sampled.slice(index, index + 80);
      batches.push({ fixes, observedAt: fixes.at(-1)!.timestamp });
    }
    return batches;
  });
  if (jobs.length > 512) throw new DriveRequestError('This drive contains too many separate GPS segments', 422);
  const results: Array<{ matches: Match[]; observedAt: number }> = new Array(jobs.length);
  let next = 0, stopped = false;
  const deadline = Date.now() + 90_000;
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
    while (!stopped && next < jobs.length) {
      const index = next++, { fixes, observedAt } = jobs[index];
      if (Date.now() >= deadline) throw new DriveRequestError('Road matching took too long. Your saved drive can be retried.', 503);
      const coordinates = fixes.map(fix => `${fix.position[0].toFixed(6)},${fix.position[1].toFixed(6)}`).join(';');
      const radiuses = fixes.map(fix => Math.max(5, Math.min(20, fix.accuracy ?? 15))).join(';');
      let response: Response;
      try {
        response = await fetcher(`${baseUrl.replace(/\/$/, '')}/match/v1/driving/${coordinates}?geometries=geojson&overview=full&tidy=true&gaps=split&radiuses=${radiuses}`, {
          signal: AbortSignal.timeout(12_000),
        });
      } catch { throw new DriveRequestError('Road matching is temporarily unavailable. Your saved drive can be retried.', 503); }
      if (response.status === 429 || response.status >= 500) {
        throw new DriveRequestError('Road matching is temporarily unavailable. Your saved drive can be retried.', 503);
      }
      const match = await response.json().catch(() => null) as {
        code?: string; tracepoints?: Array<unknown | null>; matchings?: Match[];
      } | null;
      if (!response.ok || match?.code !== 'Ok' || !match.matchings?.length
          || (match.tracepoints?.filter(point => point === null).length || 0) > fixes.length / 3) {
        throw new DriveRequestError('Could not verify that this drive followed roads', 422);
      }
      const matches = match.matchings.filter(item => Number.isFinite(item.distance) && item.distance >= 0
        && item.geometry?.coordinates?.length > 1
        && item.geometry.coordinates.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)));
      const rawDistance = fixes.reduce((sum, fix, i) => sum + (i ? metres(fixes[i - 1].position, fix.position) : 0), 0);
      const distance = matches.reduce((sum, item) => sum + item.distance, 0);
      if (!matches.length || distance > rawDistance * 1.75 || distance < rawDistance * 0.5) {
        throw new DriveRequestError('Could not verify that this drive followed roads', 422);
      }
      results[index] = { matches, observedAt };
    }
  })).catch(error => { stopped = true; throw error; });
  const units = new Map<string, TimedUnit>();
  let distance = 0;
  for (const result of results) {
    distance += result.matches.reduce((sum, item) => sum + item.distance, 0);
    for (const unit of roadUnits(result.matches.map(item => item.geometry.coordinates))) {
      units.set(`${localDay(result.observedAt)}:${unit.id}`, { ...unit, observed_at: new Date(result.observedAt).toISOString() });
    }
  }
  return { distance, units: [...units.values()] };
}
