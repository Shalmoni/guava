import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSync } from 'esbuild';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  DriveRequestError, MAX_DRIVE_POINTS, matchTrace, metres, readDriveBody,
  sampleForMatching, traceSections, traceStats, type Fix,
} from '../../supabase/functions/_shared/drive.ts';
import { uploadError } from './cloudErrors.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const point = (lng: number, timestamp: number, altitude = 100): Fix => ({ position: [lng, 32], timestamp, altitude, accuracy: 5 });
const fixes = (count: number, end = Date.now() - 1000) => Array.from({ length: count }, (_, i) => point(35 + i * 0.0001, end - (count - 1 - i) * 1000));
const distance = (points: number[][]) => points.reduce((sum, p, i) => sum + (i ? metres(points[i - 1] as [number, number], p as [number, number]) : 0), 0);
const matchingFetch: typeof fetch = async input => {
  const url = new URL(String(input));
  const coordinates = url.pathname.split('/').at(-1)!.split(';').map(p => p.split(',').map(Number));
  return Response.json({ code: 'Ok', tracepoints: coordinates.map(() => ({})), matchings: [{ distance: distance(coordinates), geometry: { coordinates } }] });
};

test('server splits GPS gaps and does not award missing distance or altitude', () => {
  const points = [point(35, 1000), point(35.001, 11000, 110), { ...point(35.1, 61000, 500), segmentStart: true }, point(35.101, 71000, 510)];
  assert.equal(traceSections(points).length, 2);
  const stats = traceStats(points, 1000, 71000);
  assert.ok(stats.distance > 180 && stats.distance < 200);
  assert.equal(stats.height, 20);
  assert.throws(() => traceStats([points[0], { ...points[1], timestamp: 1000 }], 1000, 71000), /timestamps/);
});

test('bounded reader rejects malformed/null and oversized bodies without Content-Length', async () => {
  await assert.rejects(readDriveBody(new Request('https://example.test', { method: 'POST', body: 'null' })), /Invalid drive/);
  await assert.rejects(readDriveBody(new Request('https://example.test', { method: 'POST', body: 'x'.repeat(33) }), 32), error => error instanceof DriveRequestError && error.status === 413);
});

test('multi-hour traces retain nearby matching samples and bound each request', async () => {
  const points = fixes(16_000);
  const sampled = sampleForMatching(points);
  assert.ok(sampled.length > 2000);
  let requests = 0;
  const result = await matchTrace(points, 'https://matcher.test', async (input, init) => {
    requests++;
    assert.ok(new URL(String(input)).pathname.split('/').at(-1)!.split(';').length <= 80);
    return matchingFetch(input, init);
  });
  assert.ok(requests > 20 && requests < 100);
  assert.ok(result.distance > 140_000);
  assert.ok(result.units.length > 1500 && result.units.length < 20_000);
});

test('matcher never asks the road service to bridge an unrecorded gap', async () => {
  const points = [point(35, 1000), point(35.001, 11000), { ...point(35.1, 61000), segmentStart: true }, point(35.101, 71000)];
  let requests = 0;
  const result = await matchTrace(points, 'https://matcher.test', async (input, init) => {
    requests++;
    const lngs = new URL(String(input)).pathname.split('/').at(-1)!.split(';').map(p => Number(p.split(',')[0]));
    assert.ok(Math.max(...lngs) - Math.min(...lngs) < .01);
    return matchingFetch(input, init);
  });
  assert.equal(requests, 2);
  assert.ok(result.distance < 200);
});

test('upload errors distinguish recoverable outages from validation and consent', async () => {
  for (const status of [408, 429, 500, 503]) assert.equal((await uploadError({ message: 'error', context: Response.json({ error: 'retry' }, { status }) })).retryable, true);
  for (const status of [400, 401, 403, 413, 422]) assert.equal((await uploadError({ message: 'error', context: Response.json({ error: 'review' }, { status }) })).retryable, false);
  assert.equal((await uploadError({ message: 'network' })).retryable, true);
});

function endpoint(name: string, options: { existing?: { user_id: string; xp: number; distance_m: number; height_m: number }; fetcher?: typeof fetch; sharing?: boolean; openConsent?: boolean } = {}) {
  let handler: (request: Request) => Promise<Response> = () => { throw new Error('No handler'); };
  let rpcCalls = 0;
  const createClient = (_url: string, key: string) => key === 'anon' ? {
    auth: { getUser: async () => ({ data: { user: { id: owner } }, error: null }) },
  } : {
    from: (table: string) => ({ select: () => ({ eq: () => ({
      single: async () => ({ data: table === 'guava_profiles' ? { community_opt_in: options.sharing ?? true, territory_detail_consent_at: '2026-01-01', open_territory_consent_at: options.openConsent === false ? null : '2026-01-01' } : null, error: null }),
      maybeSingle: async () => ({ data: options.existing || null, error: null }),
    }) }) }),
    rpc: async (_name: string, params: Record<string, unknown>) => {
      rpcCalls++;
      return { data: { xp: 100, distance_m: params.p_distance_m, height_m: params.p_height_m }, error: null };
    },
  };
  const built = buildSync({ entryPoints: [fileURLToPath(new URL(`../../supabase/functions/${name}/index.ts`, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['https://esm.sh/@supabase/supabase-js@2.117.3'] });
  vm.runInNewContext(built.outputFiles[0].text, {
    require: () => ({ createClient }), Response, Request, TextDecoder, AbortSignal, URL,
    fetch: options.fetcher || matchingFetch,
    Deno: { env: { get: (name: string) => ({ SUPABASE_URL: 'https://test.invalid', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' })[name] }, serve: (fn: typeof handler) => { handler = fn; } },
  });
  return {
    invoke: (body: unknown) => handler(new Request('https://test.invalid', { method: 'POST', headers: { Authorization: 'Bearer fake' }, body: JSON.stringify(body) })),
    rpcCalls: () => rpcCalls,
  };
}
const bodyFor = (points: Fix[]) => ({ id, ownerId: owner, startedAt: points[0].timestamp, endedAt: points.at(-1)!.timestamp, points });

test('submit-drive accepts 1,801 GPS points and a drive saved three days ago', async () => {
  const api = endpoint('submit-drive');
  const response = await api.invoke(bodyFor(fixes(1801, Date.now() - 3 * 86400_000)));
  assert.equal(response.status, 200, await response.text());
  assert.equal(api.rpcCalls(), 1);
});

test('server rejects wrong owner, excessive point count, expired and disabled uploads', async () => {
  const api = endpoint('submit-drive');
  assert.equal((await api.invoke({ ...bodyFor(fixes(20)), ownerId: other })).status, 403);
  assert.equal((await api.invoke(bodyFor(fixes(MAX_DRIVE_POINTS + 1)))).status, 400);
  assert.equal((await api.invoke(bodyFor(fixes(20, Date.now() - 8 * 86400_000)))).status, 400);
  assert.equal(api.rpcCalls(), 0);
  assert.equal((await endpoint('submit-drive', { sharing: false }).invoke(bodyFor(fixes(20)))).status, 403);
  assert.equal((await endpoint('submit-drive', { openConsent: false }).invoke(bodyFor(fixes(20)))).status, 403);
});

test('idempotent receipt recovery returns original metrics without matching or age expiry', async () => {
  const api = endpoint('submit-drive', { existing: { user_id: owner, xp: 42, distance_m: 500, height_m: 20 }, fetcher: async () => { throw new Error('Must not rematch'); } });
  const response = await api.invoke(bodyFor(fixes(20, Date.now() - 9 * 86400_000)));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { already_saved: true, xp: 42, distance_m: 500, height_m: 20 });
  assert.equal(api.rpcCalls(), 0);
});

test('provider outages return retryable status and never write a score', async () => {
  const api = endpoint('submit-drive', { fetcher: async () => new Response(null, { status: 503 }) });
  assert.equal((await api.invoke(bodyFor(fixes(20)))).status, 503);
  assert.equal(api.rpcCalls(), 0);
});

test('live territory endpoint also rejects another account before writes', async () => {
  const api = endpoint('record-territory');
  const points = fixes(20);
  assert.equal((await api.invoke({ sessionId: id, ownerId: other, startedAt: points[0].timestamp, points })).status, 403);
  assert.equal(api.rpcCalls(), 0);
});

function uploadClient(sessionOwner: string) {
  const calls: Array<{ name: string; options: { headers: { Authorization: string }; body: { ownerId: string } } }> = [];
  const supabase = {
    auth: { getSession: async () => ({ data: { session: { user: { id: sessionOwner }, access_token: `token-for-${sessionOwner}` } }, error: null }) },
    functions: { invoke: async (name: string, options: typeof calls[number]['options']) => {
      calls.push({ name, options });
      return { data: { xp: 10, distance_m: 100, height_m: 0 }, error: null };
    } },
  };
  const built = buildSync({ entryPoints: [fileURLToPath(new URL('./cloud.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['./supabase'] });
  const module = { exports: {} as { uploadCommunityDrive: (trip: { ownerId?: string }, ownerId: string) => Promise<unknown> } };
  vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, require: () => ({ supabase }), Response });
  return { client: module.exports, calls };
}

test('cloud uploads bind both captured authorization and drive owner to the same account', async () => {
  const { client, calls } = uploadClient(owner);
  await client.uploadCommunityDrive({ ownerId: owner }, owner);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, `Bearer token-for-${owner}`);
  assert.equal(calls[0].options.body.ownerId, owner);
});

test('cloud refuses unowned trips and an account switch before sending location data', async () => {
  const { client, calls } = uploadClient(other);
  await assert.rejects(client.uploadCommunityDrive({ ownerId: owner }, owner), /different account/);
  await assert.rejects(client.uploadCommunityDrive({}, other), /different account/);
  assert.equal(calls.length, 0);
});
