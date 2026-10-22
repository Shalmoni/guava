import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';
import { DriveRequestError, UUID_PATTERN, localDay, matchTrace, readDriveBody, traceStats, validFix, type TimedUnit } from '../_shared/drive.ts';

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
    const body = await readDriveBody(request, 64 * 1024);
    if (body.ownerId !== identity.user.id) return reply(403, { error: 'This drive belongs to a different account' });
    const admin = createClient(url, service, { auth: { persistSession: false } });
    const { data: profile, error: profileError } = await admin.from('guava_profiles')
      .select('community_opt_in,territory_detail_consent_at,open_territory_consent_at').eq('user_id', identity.user.id).single();
    if (profileError) return reply(503, { error: 'Could not check community settings. Try again.' });
    if (!profile?.community_opt_in) return reply(403, { error: 'Community play is off' });
    if (!profile.territory_detail_consent_at) return reply(403, { error: 'Review the updated territory sharing notice in Guava first' });
    if (!profile.open_territory_consent_at) return reply(403, { error: 'Accept live contest visibility in Guava before sharing a drive' });
    if (typeof body.sessionId !== 'string' || !UUID_PATTERN.test(body.sessionId)
        || typeof body.startedAt !== 'number' || !Number.isFinite(body.startedAt) || !Array.isArray(body.points)
        || body.points.length < 2 || body.points.length > 80 || !body.points.every(validFix)) return reply(400, { error: 'Invalid territory segment' });
    const points = body.points, startedAt = body.startedAt, endedAt = points.at(-1)!.timestamp;
    if (startedAt > points[0].timestamp + 120000 || startedAt < Date.now() - 8 * 3600000
        || endedAt > Date.now() + 120000 || endedAt < Date.now() - 9 * 3600000
        || endedAt - startedAt > 8 * 3600000) return reply(400, { error: 'Territory segment time is outside supported limits' });
    let rawDistance: number;
    try { rawDistance = traceStats(points, startedAt, endedAt).distance; }
    catch (error) { return reply(400, { error: (error as Error).message }); }
    if (rawDistance < 10) return reply(200, { banked: 0 });
    if (rawDistance > 15000) return reply(400, { error: 'Territory segment is too long' });
    const matched = await matchTrace(points, Deno.env.get('ROAD_MATCH_URL') || 'https://router.project-osrm.org');
    if (matched.distance < 10 || matched.distance > rawDistance * 1.75 || matched.distance < rawDistance * .5) return reply(422, { error: 'Could not verify this road segment' });
    const days = new Map<string, TimedUnit[]>();
    for (const unit of matched.units) {
      const day = localDay(Date.parse(unit.observed_at));
      const units = days.get(day) || [];
      units.push(unit);
      days.set(day, units);
    }
    let banked = 0;
    for (const units of days.values()) {
      // Match the SQL's bounded batch size without silently dropping long segments.
      for (let index = 0; index < units.length; index += 200) {
        const batch = units.slice(index, index + 200);
        const observedAt = batch.reduce((latest, unit) => unit.observed_at > latest ? unit.observed_at : latest, batch[0].observed_at);
        const { data, error } = await admin.rpc('guava_record_live_units', {
          p_session_id: body.sessionId, p_user_id: identity.user.id,
          p_started_at: new Date(startedAt).toISOString(), p_observed_at: observedAt, p_units: batch,
        });
        if (error) return reply(error.code === 'P0001' ? 400 : 503, { error: error.code === 'P0001' ? error.message : 'Could not sync road visits. Try again.' });
        banked += Number(data || 0);
      }
    }
    return reply(200, { banked });
  } catch (error) {
    if (error instanceof DriveRequestError) return reply(error.status, { error: error.message });
    return reply(503, { error: 'Road sharing is temporarily unavailable; Guava will retry.' });
  }
});
