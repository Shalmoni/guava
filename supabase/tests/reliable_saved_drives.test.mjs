// Run with Node after installing @electric-sql/pglite@0.5.10 in an isolated test
// directory. GUAVA_PGLITE_MODULE may point to that package's dist/index.js.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const { PGlite } = await import(process.env.GUAVA_PGLITE_MODULE || '@electric-sql/pglite');

const migrations = [
  '20261015201130_alpha_profiles.sql', '20261015210752_shared_game_alpha.sql',
  '20261015211406_personal_road_xp.sql', '20261018083906_reciprocal_community_visibility.sql',
  '20261018085926_live_territory_visits.sql', '20261018090209_preserve_new_road_xp.sql',
  '20261020100432_territory_card_and_round_state.sql', '20261020101229_territory_detail_consent.sql',
  '20261020101442_hide_depleted_tied_roads.sql', '20261020141615_reliable_saved_drives.sql',
];
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const tripId = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to authenticated;
  `);
  for (const file of migrations) {
    let sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    // The isolated engine has no scheduler extension; exercise the actual
    // settle functions directly, preserving every table/policy/function body.
    sql = sql.replace(/create extension if not exists pg_cron;[\s\S]*$/, '');
    sql = sql.replace(/select cron\.unschedule\([\s\S]*$/, '');
    await db.exec(sql);
  }
  await db.exec(`grant all on all tables in schema public to service_role;
    insert into auth.users values ('${owner}'), ('${other}');
    insert into guava_profiles(user_id,display_name,community_opt_in,live_territory_consent_at,territory_detail_consent_at)
    values ('${owner}','One',true,now(),now()), ('${other}','Two',true,now(),now());`);
  return db;
}

function units(count, time, prefix = 'h:') {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, line: [[35, 32], [35.0001, 32.0001]], length_m: 25, observed_at: time }));
}
async function ingest(db, id, who, time, roadUnits, distance = 80_000) {
  return (await db.query(`select public.guava_ingest_matched_drive($1,$2,$3::timestamptz - interval '2 hours',$3,$4,100,$5) as result`,
    [id, who, time, distance, JSON.stringify(roadUnits)])).rows[0].result;
}

test('saved-drive SQL: long traces, late retries, ownership, idempotency and consent', async t => {
  const db = await database();
  try {
    const now = new Date().toISOString();
    const late = new Date(Date.now() - 3 * 86400_000).toISOString();
    const lateDay = (await db.query("select ($1::timestamptz at time zone 'Asia/Jerusalem')::date::text as day", [late])).rows[0].day;
    await t.test('2,500 units succeed beyond the old 1,500 cap and retry credits once', async () => {
      const result = await ingest(db, tripId(1), owner, now, units(2500, now));
      assert.equal(result.already_saved, false);
      assert.equal(result.unit_count, 2500);
      assert.equal(result.distance_m, 80_000);
      const retry = await ingest(db, tripId(1), owner, now, units(2500, now));
      assert.equal(retry.already_saved, true);
      assert.equal(retry.xp, result.xp);
      assert.equal((await db.query('select drive_count from guava_game_scores where user_id=$1', [owner])).rows[0].drive_count, 1);
    });
    await t.test('late saved drive earns lifetime credit but cannot reopen a finalized round', async () => {
      await db.query('select guava_settle_round($1)', [lateDay]);
      const result = await ingest(db, tripId(2), owner, late, units(3, late, 'late:'), 1000);
      assert.equal(result.late_units, 3);
      assert.ok(result.xp > 0);
      assert.equal((await db.query('select count(*)::int n from guava_live_unit_visits where session_id=$1 and counts_for_territory', [tripId(2)])).rows[0].n, 0);
      assert.equal((await db.query("select count(*)::int n from guava_road_units where id like 'late:%' and owner_id is not null")).rows[0].n, 0);
      const repeat = await ingest(db, tripId(3), owner, late, units(3, late, 'late:'), 1000);
      assert.equal(repeat.new_units, 0);
      assert.equal((await db.query('select guava_settle_round($1) n', [lateDay])).rows[0].n, 0);
    });
    await t.test('deadline excludes late votes even when scheduled settlement was missed', async () => {
      const older = new Date(Date.now() - 4 * 86400_000).toISOString();
      const day = (await db.query("select ($1::timestamptz at time zone 'Asia/Jerusalem')::date::text as day", [older])).rows[0].day;
      const result = await ingest(db, tripId(4), other, older, units(1, older, 'missed:'), 1000);
      assert.equal(result.late_units, 1);
      await db.query('select guava_settle_round($1)', [day]);
      assert.equal((await db.query("select owner_id from guava_road_units where id='missed:0'")).rows[0].owner_id, null);
    });
    await t.test('same-session live units still earn exploration XP only on completion', async () => {
      await db.query(`select guava_record_live_units($1,$2,$3::timestamptz - interval '2 hours',$3,$4)`, [tripId(5), other, now, JSON.stringify(units(2, now, 'live:'))]);
      const result = await ingest(db, tripId(5), other, now, units(2, now, 'live:'), 1000);
      assert.equal(result.new_units, 2);
      assert.equal((await db.query("select traversal_count from guava_road_units where id='live:0'")).rows[0].traversal_count, 1);
    });
    await t.test('owner mismatch, old drives, and disabled sharing are rejected', async () => {
      await assert.rejects(ingest(db, tripId(1), other, now, units(1, now)), /different account/);
      const tooOld = new Date(Date.now() - 8 * 86400_000).toISOString();
      await assert.rejects(ingest(db, tripId(6), owner, tooOld, units(1, tooOld)), /supported limits/);
      await db.query('update guava_profiles set territory_detail_consent_at=null where user_id=$1', [other]);
      await assert.rejects(ingest(db, tripId(7), other, now, units(1, now)), /consent/);
    });
    await t.test('authenticated browsers cannot invoke privileged score ingestion', async () => {
      await db.exec('set role authenticated');
      await assert.rejects(ingest(db, tripId(8), owner, now, units(1, now)), /permission denied/);
      await db.exec('reset role');
      const permissions = (await db.query(`select proname, prosecdef, has_function_privilege('authenticated', oid, 'EXECUTE') as browser_exec
        from pg_proc where proname in ('guava_ingest_matched_drive','guava_record_live_units','guava_settle_round','guava_territory_public_scores')`)).rows;
      assert.equal(permissions.length, 4);
      assert.ok(permissions.every(fn => !fn.prosecdef && !fn.browser_exec));
    });
  } finally { await db.close(); }
});
