# Guava friend alpha

Guava is a mobile-first driving map and road-territory game. The shareable app is the web build in `web/`, deployed through GitHub Pages at [shalmoni.github.io/guava](https://shalmoni.github.io/guava/). The older iOS prototype in `Mappy/` is a design reference, not the app that link opens.

The alpha requires Google sign-in. Community play is opt-in and off by default. A player can explore the map and save private drives without joining the shared game. After opting in, **newly finished** drives can add shared XP, distance, height traveled, road use and daily territory. Older private drives are not silently uploaded.

## Rules

- Drives shorter than 50 m do not score. Guava records only after Start and saves only after Finish & Save.
- The authenticated `submit-drive` Supabase function validates GPS timing and movement, map-matches sampled coordinates against OSRM, then writes a summary and short road-cell geometry. Full GPS samples remain in the browser, not the hosted database.
- Each separate verified drive contributes one vote per road cell, regardless of loops or travel direction. A daily UTC round settles at 00:05 the following day. The unique top driver wins; ties clear ownership; untouched cells keep their owner.
- **Current cutoff limitation:** a whole drive is assigned to the UTC date when it ends. A drive crossing midnight is not split by the time each road was traveled; this can reward stopping before midnight. It must be redesigned before territory competition is considered fair.
- Territory paints only captured road sections. A tap identifies the owner and approximate section length. Road Pulse shows community roads only after three distinct opted-in drivers have used them. Names are displayed only for participants.
- The live leaderboard uses hosted scores. The clearly labeled Game Lab remains a separate ten-player simulation for reviewing how a populated map might look.
- Turning community play off deletes that player's shared drive summaries, scores and ownership; local browser drives remain.

## Limits — important for testers

This is **not safety-grade navigation** and does not have live traffic, dependable closures, speed limits, background GPS, voice instructions, or robust rerouting. Phone browsers can pause location updates when locked or backgrounded. Public Photon and OSRM services can be unavailable or throttled. Use a trusted navigation app for important directions and never operate game controls while driving.

Regular and Altitude views work. Satellite remains disabled until an imagery provider is configured. The friend alpha is Israel-only. Territory cells are approximately 25 m hexes on map-matched roads; nearby parallel roads can still collide in one cell. Scores and matching are experimental, not fraud-proof. See the [alpha privacy notice](https://shalmoni.github.io/guava/privacy.html).

During planned drives, the displayed arrow snaps to the selected route only when the GPS fix is nearby; recorded GPS is never silently altered. Manual zoom or pan pauses camera following, and the recenter control restores the close driving view. Elevation gain/loss needs usable device altitude samples; an unavailable measurement is shown as a dash instead of a false zero.

## Local development

Requires Node.js 22 or newer.

```bash
cd web
npm ci
npm test
npm run dev
```

`npm run build` creates `web/dist`. Pushes to `main` deploy through `.github/workflows/deploy-pages.yml`. The workflow reads the public `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` GitHub variables and sets `VITE_REQUIRE_AUTH=true`. Never put a Supabase service-role key or Google OAuth client secret into `VITE_*` variables or the repository.

The hosted Guava Supabase project is separate from other products. `supabase/migrations/` records the profile and game schema, `supabase/functions/submit-drive/` contains the authenticated ingestion function, and a `pg_cron` job settles territory daily. `supabase/drafts/` is not deployed. Browser drives are stored in `localStorage` and can be exported in Settings.
