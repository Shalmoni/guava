import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';

type Point = [number, number];
type Fix = { position: Point; altitude: number | null; timestamp: number; accuracy?: number };
type Unit = { id: string; line: Point[]; length_m: number };
type TimedUnit = Unit & { observed_at: string };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: cors });
const localDay = (timestamp: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(timestamp);

function daySections(points: Fix[]): Fix[][] {
  const sections: Fix[][] = [];
  let section: Fix[] = [points[0]];
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1], current = points[index];
    if (localDay(previous.timestamp) !== localDay(current.timestamp)) {
      if (section.length >= 2) sections.push(section);
      section = [previous, current];
    } else section.push(current);
  }
  if (section.length >= 2) sections.push(section);
  return sections;
}

function metres(a: Point, b: Point): number {
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

function roadUnits(lines: Point[][]): Unit[] {
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

function validFix(value: unknown): value is Fix {
  if (!value || typeof value !== 'object') return false;
  const fix = value as Partial<Fix>;
  return Array.isArray(fix.position) && fix.position.length === 2
    && fix.position.every(Number.isFinite)
    && fix.position[0] >= 34 && fix.position[0] <= 36.5
    && fix.position[1] >= 29 && fix.position[1] <= 34
    && Number.isFinite(fix.timestamp)
    && (fix.altitude === null || typeof fix.altitude === 'number' && Number.isFinite(fix.altitude))
    && (fix.accuracy === undefined || typeof fix.accuracy === 'number' && Number.isFinite(fix.accuracy)
      && fix.accuracy >= 0 && fix.accuracy <= 100);
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reply(405, { error: 'POST required' });
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const url = Deno.env.get('SUPABASE_URL');
  const publishable = Deno.env.get('SUPABASE_ANON_KEY');
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!token || !url || !publishable || !service) return reply(401, { error: 'Authentication unavailable' });
  const auth = createClient(url, publishable, { auth: { persistSession: false } });
  const { data: identity, error: identityError } = await auth.auth.getUser(token);
  if (identityError || !identity.user || identity.user.is_anonymous) return reply(401, { error: 'Sign in again' });
  if ((await request.clone().json().catch(() => null))?.health === true) return reply(200, { ok: true });
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: profile, error: profileError } = await admin.from('guava_profiles')
    .select('community_opt_in').eq('user_id', identity.user.id).single();
  if (profileError || !profile?.community_opt_in) return reply(403, { error: 'Turn on community play in Settings before sharing a drive' });

  let body: { id?: string; startedAt?: number; endedAt?: number; points?: Fix[] };
  try { body = await request.json(); } catch { return reply(400, { error: 'Invalid drive data' }); }
  if (!body.id || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(body.id)
      || !Array.isArray(body.points) || body.points.length < 2 || body.points.length > 1200
      || !body.points.every(validFix)
      || !Number.isFinite(body.startedAt) || !Number.isFinite(body.endedAt)) return reply(400, { error: 'Invalid drive data' });
  const points = body.points;
  const startedAt = body.startedAt!;
  const endedAt = body.endedAt!;
  const duration = (endedAt - startedAt) / 1000;
  if (duration < 15 || duration > 8 * 3600 || endedAt > Date.now() + 120000 || endedAt < Date.now() - 3600000
      || Math.abs(points[0].timestamp - startedAt) > 120000) return reply(400, { error: 'Drive time is outside alpha limits' });
  let rawDistance = 0;
  let height = 0;
  let altitudeAnchor: number | null = null;
  for (let index = 0; index < points.length; index++) {
    const fix = points[index];
    if (fix.timestamp < startedAt - 120000 || fix.timestamp > endedAt + 120000) return reply(400, { error: 'GPS time outside drive' });
    if (index > 0) {
      const previous = points[index - 1];
      const seconds = (fix.timestamp - previous.timestamp) / 1000;
      const step = metres(previous.position, fix.position);
      if (seconds <= 0 || step > Math.max(150, seconds * 58)) return reply(400, { error: 'Implausible GPS movement' });
      rawDistance += step;
    }
    if (fix.altitude !== null) {
      if (altitudeAnchor !== null && Math.abs(fix.altitude - altitudeAnchor) >= 3) {
        height += Math.min(50, Math.abs(fix.altitude - altitudeAnchor));
        altitudeAnchor = fix.altitude;
      } else if (altitudeAnchor === null) altitudeAnchor = fix.altitude;
    }
  }
  if (rawDistance < 50 || rawDistance > 200000 || rawDistance / duration > 58) return reply(400, { error: 'Drive distance is outside alpha limits' });

  // Public OSRM is suitable for a small friend alpha, not production traffic
  // or a reliable always-on map-matching contract. Never send user identifiers.
  const matched: Array<{ distance: number; geometry: { coordinates: Point[] } }> = [];
  const timedUnits = new Map<string, TimedUnit>();
  try {
    for (const section of daySections(points)) {
      const stride = Math.max(1, Math.ceil(section.length / 40));
      const sampled = section.filter((_, index) => index % stride === 0 || index === section.length - 1);
      const sectionMatched: typeof matched = [];
      for (let index = 0; index < sampled.length - 1; index += 9) {
        const batch = sampled.slice(index, index + 10);
        const coordinates = batch.map(fix => `${fix.position[0].toFixed(6)},${fix.position[1].toFixed(6)}`).join(';');
        const radiuses = batch.map(fix => Math.max(5, Math.min(20, fix.accuracy ?? 15))).join(';');
        const endpoint = `https://router.project-osrm.org/match/v1/driving/${coordinates}?geometries=geojson&overview=full&tidy=true&gaps=ignore&radiuses=${radiuses}`;
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error('Road matching unavailable');
        const match = await response.json() as {
          code?: string; tracepoints?: Array<unknown | null>;
          matchings?: Array<{ distance: number; geometry: { coordinates: Point[] } }>;
        };
        if (match.code !== 'Ok' || !match.matchings?.length
            || (match.tracepoints?.filter(point => point === null).length || 0) > batch.length / 3) {
          return reply(422, { error: 'Could not verify that this drive followed roads' });
        }
        sectionMatched.push(...match.matchings.filter(item => item.geometry?.coordinates?.length > 1));
      }
      matched.push(...sectionMatched);
      const observed_at = new Date(section.at(-1)!.timestamp).toISOString();
      const day = localDay(section.at(-1)!.timestamp);
      for (const unit of roadUnits(sectionMatched.map(item => item.geometry.coordinates))) {
        timedUnits.set(`${day}:${unit.id}`, { ...unit, observed_at });
      }
    }
  } catch { return reply(503, { error: 'Road matching is temporarily unavailable. Your drive is still saved on this device; retry later.' }); }
  const distance = matched.reduce((sum, item) => sum + item.distance, 0);
  if (!matched.length || distance < 50 || distance > 200000
      || distance > rawDistance * 1.75 || distance < rawDistance * 0.5
      || distance / duration > 58) return reply(422, { error: 'Could not verify that this drive followed roads' });
  const units = [...timedUnits.values()];
  if (units.length < 1 || units.length > 1500) return reply(422, { error: 'Could not divide this drive into road units' });
  const { data, error } = await admin.rpc('guava_ingest_matched_drive', {
    p_id: body.id, p_user_id: identity.user.id,
    p_started_at: new Date(startedAt).toISOString(), p_ended_at: new Date(endedAt).toISOString(),
    p_distance_m: Math.round(distance), p_height_m: Math.min(10000, Math.round(height)), p_units: units,
  });
  if (error) return reply(400, { error: error.message });
  return reply(200, { ...data, distance_m: Math.round(distance), height_m: Math.round(height) });
});
