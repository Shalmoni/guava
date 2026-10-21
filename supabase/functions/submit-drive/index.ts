import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';
import {
  DriveRequestError, MAX_DRIVE_POINTS, MAX_ROAD_UNITS, SAVED_DRIVE_MAX_AGE_MS,
  UUID_PATTERN, matchTrace, readDriveBody, traceStats, validFix,
} from '../_shared/drive.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: cors });

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reply(405, { error: 'POST required' });
  try {
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    const url = Deno.env.get('SUPABASE_URL');
    const publishable = Deno.env.get('SUPABASE_ANON_KEY');
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!token) return reply(401, { error: 'Sign in again' });
    if (!url || !publishable || !service) return reply(503, { error: 'Sharing is temporarily unavailable' });
    const auth = createClient(url, publishable, { auth: { persistSession: false } });
    const { data: identity, error: identityError } = await auth.auth.getUser(token);
    if (identityError || !identity.user || identity.user.is_anonymous) return reply(401, { error: 'Sign in again' });
    const body = await readDriveBody(request);
    if (body.health === true) return reply(200, { ok: true });
    if (body.ownerId !== identity.user.id) return reply(403, { error: 'This drive belongs to a different account' });
    const admin = createClient(url, service, { auth: { persistSession: false } });
    const { data: profile, error: profileError } = await admin.from('guava_profiles')
      .select('community_opt_in,territory_detail_consent_at').eq('user_id', identity.user.id).single();
    if (profileError) return reply(503, { error: 'Could not check community settings. Try again.' });
    if (!profile?.community_opt_in) return reply(403, { error: 'Turn on community play in Settings before sharing a drive' });
    if (!profile.territory_detail_consent_at) return reply(403, { error: 'Review the updated territory sharing notice in Guava first' });
    if (typeof body.id !== 'string' || !UUID_PATTERN.test(body.id)
        || !Array.isArray(body.points) || body.points.length < 2 || body.points.length > MAX_DRIVE_POINTS
        || !body.points.every(validFix)
        || typeof body.startedAt !== 'number' || !Number.isFinite(body.startedAt)
        || typeof body.endedAt !== 'number' || !Number.isFinite(body.endedAt)) return reply(400, { error: 'Invalid drive data' });

    // Return the original result before age checks/matching so a lost response can
    // always be recovered, including after the seven-day retry window.
    const { data: existing, error: existingError } = await admin.from('guava_game_drives')
      .select('user_id,xp,distance_m,height_m').eq('id', body.id).maybeSingle();
    if (existingError) return reply(503, { error: 'Could not check this saved drive. Try again.' });
    if (existing) {
      if (existing.user_id !== identity.user.id) return reply(409, { error: 'Drive ID belongs to a different account' });
      return reply(200, { already_saved: true, xp: existing.xp, distance_m: existing.distance_m, height_m: existing.height_m });
    }
    const points = body.points;
    const startedAt = body.startedAt, endedAt = body.endedAt;
    const duration = (endedAt - startedAt) / 1000;
    if (duration < 15 || duration > 8 * 3600 || endedAt > Date.now() + 120000 || endedAt < Date.now() - SAVED_DRIVE_MAX_AGE_MS
        || Math.abs(points[0].timestamp - startedAt) > 120000) return reply(400, { error: 'Sharing supports drives up to 8 hours, saved within the last 7 days' });
    let stats: ReturnType<typeof traceStats>;
    try { stats = traceStats(points, startedAt, endedAt); }
    catch (error) { return reply(400, { error: (error as Error).message }); }
    if (stats.distance < 50 || stats.distance > 200000 || stats.distance / duration > 58) return reply(400, { error: 'Sharing supports recorded drives from 50 m to 200 km' });

    // Configure a production OSRM-compatible service via ROAD_MATCH_URL. The
    // public fallback has no availability SLA; failures preserve the local trip.
    const matched = await matchTrace(points, Deno.env.get('ROAD_MATCH_URL') || 'https://router.project-osrm.org');
    if (matched.distance < 50 || matched.distance > 200000 || matched.distance / duration > 58
        || matched.distance > stats.distance * 1.75 || matched.distance < stats.distance * 0.5) {
      return reply(422, { error: 'Could not verify that this drive followed roads' });
    }
    if (matched.units.length < 1 || matched.units.length > MAX_ROAD_UNITS) return reply(422, { error: 'Could not divide this drive into road units' });
    const { data, error } = await admin.rpc('guava_ingest_matched_drive', {
      p_id: body.id, p_user_id: identity.user.id,
      p_started_at: new Date(startedAt).toISOString(), p_ended_at: new Date(endedAt).toISOString(),
      p_distance_m: Math.round(matched.distance), p_height_m: stats.height, p_units: matched.units,
    });
    if (error) return reply(error.code === 'P0001' ? 400 : 503, { error: error.code === 'P0001' ? error.message : 'Could not save the shared drive. Try again.' });
    return reply(200, data);
  } catch (error) {
    if (error instanceof DriveRequestError) return reply(error.status, { error: error.message });
    return reply(503, { error: 'Sharing is temporarily unavailable. Your drive is still saved on this device.' });
  }
});
