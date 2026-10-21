# Guava

Guava is a mobile-first driving map and road-territory game. The shareable app is the web build in `web/`, deployed through GitHub Pages at [shalmoni.github.io/guava](https://shalmoni.github.io/guava/). The older iOS prototype in `Mappy/` is a design reference, not the app that link opens.

The app requires Google sign-in. Community play is opt-in and off by default. A player can explore the map and save private drives without joining the shared game. After explicit consent to the live-territory notice, road-unit visits sync during opted-in drives; shared XP, distance, and height update only after a finished drive is saved. Older private drives are not silently uploaded.

## Rules

- Territory live sync begins only after at least 50 m of accepted driving. Its authenticated `record-territory` function validates movement and map-matches short segments via OSRM; private visits are banked while driving. They remain counted even if the driver later discards the trip record. Full raw GPS traces are not stored in the hosted database.
- The authenticated `submit-drive` function validates the complete drive, map-matches sampled coordinates, fills eligible missed road visits, and writes the summary plus XP/distance/height only after Finish & Save. Saved community drives can retry for up to seven days. Uploads after the next morning's 09:05 Israel-time deadline can still add lifetime scores and Road Pulse usage, but never change settled territory ownership.
- Each session contributes at most one vote per road cell per Israel-calendar day, regardless of loops or travel direction. The daily contest closes at local midnight; ownership becomes final at about 09:05 Israel time the following morning to admit late uploads. The unique top driver wins; ties clear ownership; untouched cells keep their owner.
- Territory paints only captured road sections. A tap identifies the owner and approximate section length. Road Pulse shows community roads only after three distinct opted-in drivers have used them. Names are displayed only for participants.
- The leaderboard and territory map show real opted-in community data.
- The map picker has seven views: Regular, Dark, Satellite, My Roads, Territory, Road Pulse, and Altitude. My Roads draws only saved drives from this device; it works without community play. Satellite combines 2025 Sentinel-2 imagery with road labels.
- Turning community play off deletes that player's shared drive summaries, scores, live visits and ownership; local browser drives remain.

## Current limits

This is **not safety-grade navigation** and does not have live traffic, dependable closures, speed limits, background GPS, voice instructions, or robust rerouting. Phone browsers can pause location updates when locked or backgrounded. Public Photon and OSRM services can be unavailable or throttled. Use a trusted navigation app for important directions and never operate game controls while driving.

Regular, Dark, and Altitude views work. Guava currently supports Israel. Territory cells are approximately 25 m hexes on map-matched roads; nearby parallel roads can still collide in one cell. Scores and matching are not fraud-proof. See the [privacy notice](https://shalmoni.github.io/guava/privacy.html).

Satellite uses the public [EOxCloudless 2025 WMTS](https://cloudless.eox.at/documentation/usage) and displays its required map credit. Its 10 m resolution is lower than commercial aerial maps; it is licensed for **noncommercial** use only. Obtain a commercial license or replace the imagery provider before a commercial release. If EOX is unavailable, road and place labels still load from OpenFreeMap, but the imagery may be missing.

During planned drives, the displayed arrow snaps to the selected route only when the GPS fix is nearby; recorded GPS is never silently altered. Manual zoom or pan pauses camera following, and the recenter control restores the close driving view. The Altitude badge uses trustworthy GPS altitude or a current terrain-elevation estimate; it shows `-- m` when neither is available. Elevation gain/loss needs usable device altitude samples and does not treat terrain estimates as measured climb.

## Local development

Requires Node.js 22 or newer.

```bash
cd web
npm ci
npm test
npm run dev
```

`npm run build` creates `web/dist`. Pushes to `main` deploy through `.github/workflows/deploy-pages.yml`. The workflow reads the public `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` GitHub variables and sets `VITE_REQUIRE_AUTH=true`. Never put a Supabase service-role key or Google OAuth client secret into `VITE_*` variables or the repository.

The hosted Guava Supabase project is separate from other products. `supabase/migrations/` records the profile and game schema, `supabase/functions/record-territory/` banks active-drive visits, `supabase/functions/submit-drive/` saves completed scores, and a `pg_cron` job finalizes territory daily. `supabase/drafts/` is not deployed. Drive history and active-drive recovery copies are stored in this browser, separately for each account. Reopen with the same account and browser to resume or save an interrupted recording. Saved drives can be exported in Settings; local storage does not transfer across devices.

## Release verification

Follow [backend validation and release order](supabase/tests/README.md) before
merging this release to `main`: apply the database migration and deploy both
updated functions before the matching web build. CI validates the web and isolated
database tests but does not deploy Supabase. The [synthetic browser fixture](web/qa/README.md)
exercises drive recovery without device GPS or cloud writes.

Production sign-off also requires a real iPhone/Android drive, background/lock
recovery, authenticated upload/retry, and hosted next-day settlement. Browser
search and routing can use configured providers via `VITE_GEOCODER_URL` and
`VITE_ROUTER_URL`; server road matching uses `ROAD_MATCH_URL` separately.
