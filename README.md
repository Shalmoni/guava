# Guava

Guava is a mobile-first map-game and navigation experiment. **The shareable version is now the web app in `web/`**, deployed through GitHub Pages like Wird. The older native iOS prototype remains in `Mappy/` and `Mappy.xcodeproj` as a design/behavior reference; it is not what the public link runs.

## Run the web app

Requires Node.js 22 or newer.

```bash
cd web
npm ci
npm run dev
```

For a production build, run `npm run build` in `web/`. The output goes to `web/dist/`. Pushes to `main` deploy that output through `.github/workflows/deploy-pages.yml`.

## What works in the web preview

- Mobile and landscape map layout, responsive controls, and Avenir Next/Guava-pink visual style
- Regular road map from OpenFreeMap and real 2D Altitude color relief from elevation tiles
- Destination search through Photon and road routes/alternatives through OSRM's public demo
- Explicit Quick Start or planned drive, GPS-based local recording while the browser stays active, map following, a basic instruction banner, navigation/game dock, Stop/Save/Discard, recap, profile, XP, distance, height, and locally explored roads
- Territory visual preview of locally driven paths (not multiplayer ownership)
- Road Pulse Mine preview in which repeated local drives darken a road; Everybody clearly says community data is not connected

The web preview is **not a replacement for a safety-grade navigation app**. It has no live traffic, robust rerouting, background navigation, voice guidance, reliable map matching, or shared accounts. Mobile browsers can suspend location updates when locked or backgrounded. Do not rely on it as your only source of driving directions. The public Photon/OSRM services are intended for a small review group and may be throttled or unavailable. Production routing, search, and traffic require dedicated providers.

Satellite is in the map picker but disabled until an imagery provider is configured. An optional MapTiler browser key can be supplied through `web/.env.local` as `VITE_MAPTILER_KEY`; restrict that public key to the deployment domain. No key or secret is committed.

## Community backend

`supabase/migrations/` holds an **undeployed** first schema for aggregate road frequency and fixed daily road-territory rounds. It is not connected to the web preview. A separate Guava Supabase project, Google sign-in, server-verified/map-matched drive ingestion, scheduled settlement, privacy controls, and real multi-user tests are required before Everybody Road Pulse, public leaderboards, or competitive Territory can go live. Do not reuse Wird's backend or credentials.

The web app currently stores drives only in this browser's `localStorage`; clearing site data removes them. Browser-to-server sync and an export/deletion flow are future work.
