import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';

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
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const url = Deno.env.get('SUPABASE_URL');
  const publishable = Deno.env.get('SUPABASE_ANON_KEY');
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!token || !url || !publishable || !service) return reply(401, { error: 'Authentication unavailable' });
  const auth = createClient(url, publishable, { auth: { persistSession: false } });
  const { data: identity, error: identityError } = await auth.auth.getUser(token);
  if (identityError || !identity.user || identity.user.is_anonymous) return reply(401, { error: 'Sign in again' });
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: profile, error: profileError } = await admin.from('guava_profiles')
    .select('community_opt_in,territory_detail_consent_at,open_territory_consent_at').eq('user_id', identity.user.id).single();
  if (profileError || !profile?.community_opt_in || !profile.territory_detail_consent_at || !profile.open_territory_consent_at) return reply(403, { error: 'Review territory sharing in Guava' });
  let body: { unitIds?: unknown };
  try { body = await request.json(); } catch { return reply(400, { error: 'Invalid request' }); }
  if (!Array.isArray(body.unitIds) || body.unitIds.length > 5000
    || !body.unitIds.every(id => typeof id === 'string' && /^h:-?\d+:-?\d+$/.test(id))) {
    return reply(400, { error: 'Invalid road units' });
  }
  if (!body.unitIds.length) return reply(200, { scores: [] });
  const { data, error } = await admin.rpc('guava_territory_public_scores', {
    p_viewer: identity.user.id, p_unit_ids: [...new Set(body.unitIds)],
  });
  if (error) return reply(503, { error: 'Territory scores are temporarily unavailable' });
  return reply(200, { scores: data || [] });
});
