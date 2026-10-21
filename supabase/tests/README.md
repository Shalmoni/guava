# Backend reliability checks

Run the application and edge-handler tests from `web`:

```sh
npm ci
npm test
npm run build
```

In a sandbox that blocks the `tsx` command's IPC socket, the equivalent test
command is `node --import tsx --test src/*.test.ts`.

`web/src/driveUpload.test.ts` executes the actual bundled Edge Function handlers
with isolated authentication, database and road-matcher doubles. It also checks
long traces, GPS gaps, request limits, retryable errors and account-bound upload
credentials. No real route or user trace is submitted.

The database test applies the repository's real schema and the pending
`20261020141615_reliable_saved_drives.sql` migration to isolated PostgreSQL using
PGlite. Only the unsupported cron scheduler setup is omitted; settlement is
called directly. It verifies ingestion beyond the old limit, late uploads,
idempotency, exploration credit, consent, ownership and RPC permissions.

From the repository root, with Node and npm available:

```sh
guava_sql_test_dir="$(mktemp -d)"
npm install --prefix "$guava_sql_test_dir" --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.5.10
GUAVA_PGLITE_MODULE="$guava_sql_test_dir/node_modules/@electric-sql/pglite/dist/index.js" node --test supabase/tests/reliable_saved_drives.test.mjs
```

These checks do not apply migrations or deploy functions to a Supabase project.
The GitHub workflow runs web tests, this isolated database test and the Vite
production build for pull requests and relevant pushes to `main`. Pull requests
receive no deployment permissions. Only a successful validation of `main` can
publish its exact built artifact to Pages. CI does not change Supabase.

## Backend configuration and release order

| Setting | Location | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | GitHub repository variable / local web environment | HTTPS project URL used by the browser. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | GitHub repository variable / local web environment | Public `sb_publishable_…` browser key. |
| `VITE_REQUIRE_AUTH=true` | Production web build | Require sign-in before the app opens. The workflow sets this. |
| `VITE_GEOCODER_URL` | Optional GitHub repository variable / local web environment | Photon-compatible search endpoint, including `/api/`; requires browser CORS. Defaults to public Photon. |
| `VITE_ROUTER_URL` | Optional GitHub repository variable / local web environment | OSRM-compatible routing base URL; requires browser CORS. Defaults to public OSRM. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase Edge runtime only | Supabase supplies these runtime values. Handlers verify the caller JWT with Auth before privileged database work. |
| `ROAD_MATCH_URL` | Supabase Edge secret/environment setting | Base URL of an OSRM-compatible matching service. No `/match/v1/driving` suffix. |

Keep the service-role key and Google OAuth client secret out of the browser
environment, GitHub public variables and this repository. Configure Google Auth
and the exact site/redirect URLs for each target project in Supabase. The
production web callback is the Pages base URL, including `/guava/`; staging
must use its own URL and project.

Set `ROAD_MATCH_URL` to an OSRM-compatible service with capacity for production.
If unset, the current public OSRM fallback remains in use and has no availability
guarantee. Matching failures preserve the local drive for retry.
This setting affects server drive verification only. Browser search and route
planning use `VITE_GEOCODER_URL` and `VITE_ROUTER_URL` independently, with
15-second and 20-second timeouts. Provider capacity and service terms must match
the intended rollout before treating these services as production dependencies.

Use a staging project first. With an authenticated Supabase CLI, inspect
`supabase --version` and the relevant `--help` output, then choose the intended
project explicitly. The following are release commands, not part of tests:

```sh
supabase link --project-ref "$GUAVA_PROJECT_REF"
supabase migration list --linked
supabase db push --linked --dry-run
# Inspect the pending migration list before applying it to the chosen project.
supabase db push --linked
supabase secrets set --project-ref "$GUAVA_PROJECT_REF" "ROAD_MATCH_URL=$GUAVA_ROAD_MATCH_URL"
supabase functions deploy submit-drive --project-ref "$GUAVA_PROJECT_REF" --use-api
supabase functions deploy record-territory --project-ref "$GUAVA_PROJECT_REF" --use-api
```

The function bundle automatically includes its imported `_shared/drive.ts`.
Retain authenticated invocation: each handler must validate a real user JWT;
neither a public API key alone nor a client-supplied owner ID grants access.
Check existing gateway JWT settings against the target project's signing-key
configuration during staging deployment, and verify a real signed-in request.
Do not disable authentication to make a failed probe pass.

After deploying to staging, verify sign-in, explicit sharing consent, a real
completed upload, an idempotent retry, an offline retry, account switching, and
next-day settlement. Check the project's database advisors and migration history.
Verify the existing `guava-territory-daily` cron job is active and invokes the
Israel-time settlement function. The isolated test cannot validate hosted
authentication, scheduling, provider capacity or physical-phone GPS behavior.

Apply the tested migration and function version to production before merging
the matching web changes to `main`, since that merge triggers Pages deployment.
Existing tabs must reload: the new handlers require the drive owner's account ID
in the request. In a fresh tab, use Settings → Check community connection, then
verify an opted-in drive on the deployed build before inviting testers.
Do not remove the added column on rollback; earlier handlers can run against the
additive schema, while this web build needs the matching updated handlers.

Limits are aligned across handler and SQL: completed drives have 15 seconds to
8 hours of elapsed time, 50 m to 200 km of verified distance, up to 40,000 GPS
fixes in an 8 MiB request, and up to 20,000 day/road-unit visits. New completed
uploads are accepted for seven days; an already-saved ID can recover its original
receipt afterward. Late road visits count toward lifetime progress and aggregate
Road Pulse, but cannot change territory after the next-day 09:05 Israel cutoff.
