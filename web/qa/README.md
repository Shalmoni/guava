# Browser drive regression fixture

Run the local development server with Supabase disabled:

```sh
VITE_REQUIRE_AUTH=false VITE_SUPABASE_URL='' VITE_SUPABASE_PUBLISHABLE_KEY='' npm run dev -- --host 127.0.0.1 --port 4175
```

Open `/qa/drive.html`. This separate Vite development entry is not included in `dist`.
It supplies synthetic coordinates and clock increments through visible controls.
It never requests the device's location and refuses to run when Supabase is configured.
Local test drives use the `local` account scope.

Checks:

1. Quick Start, move twice, inject a GPS gap, move again. Only the three observed
   movements should count; the gap should not draw a connecting line.
   Park for 15 minutes after at least 50 m. The drive should auto-save, and
   moving time should exclude the parked interval.
2. Reload while recording. Resume should recover distance and start a new segment.
3. Save. The recap and Profile should contain the drive after another reload.
4. Open a second tab. It should be read-only. Close the original and retry the
   storage lock; the second tab should reload current saved records before recording.
   Hide the fixture controls before clicking the app's top notices so the test
   toolbar does not cover them.
5. Deny and restore synthetic GPS. The UI must explain the failure and recover.
6. Reload an unfinished session after advancing eight hours. Offer to save the
   recorded part; do not resume a session that exceeds the server duration limit.
7. Open Leaderboard. Dismiss the explanation and reopen: it should not appear
   automatically again. The “How it works” button should always reopen it.
