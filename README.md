# PoP.bin: Proof of Presence

Team game for the Breakpoint 2026 badge: chains of badges mine hashes by standing together. The design doc is in `DESIGN.md`.

```
badge/    the Solana OS app (main.lua, app.json, lib/)        → upload this folder at /apps/submit
server/   Bun + libSQL/Turso on Vercel: /v1 badge API, /admin, scoring
tools/    badge_sim.lua: headless smoke test of the badge app (not shipped)
```

## Server

Live at **https://pop-bin.vercel.app** (Vercel project `pop-bin`, Bun runtime, Turso for storage).

```sh
cd server && bun install
bun test                                   # scoring, auth, joins, demo isolation, replay, epoch claim
ADMIN_PASSWORD=pw bun src/server.ts        # local, stores in ./pop-bin.db
vercel deploy --prod                       # from server/
```

No timers on serverless: the first request after each epoch boundary claims it (atomic UPDATE on `meta.epoch_at`) and scores every chain. Badges report every 10 s, which keeps epochs on time.

| env | |
|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | set by the Turso Marketplace integration (local default: `file:pop-bin.db`, or `DB_URL`) |
| `ADMIN_PASSWORD` | basic-auth password for `/admin` (unset = admin disabled). Production value is in `server/.env.admin` (gitignored) |
| `PUBLIC_ORIGIN` | public `https://` origin. The badge signature covers the URL, and Vercel's internal `req.url` differs |
| `APP_ID` | store app id (default `pop-bin`) |

Every tunable in §8 can be edited live at `/admin`.

## Badge

1. Put your server host in `badge/main.lua` (`HOST`) and `badge/app.json` (`hosts`).
2. `lua tools/badge_sim.lua` runs every screen against the mock and checks the object, label, mesh and instruction limits.
3. Try it in the emulator with `DEMO_LOCAL = true` (no server needed), or as a test run against the server (needs X linked).

**Before every publish:** `DEMO_LOCAL = false`, the host is in `app.json`, and `lua tools/badge_sim.lua` passes.

**Venue day one:** check that `http` works while mesh is on; measure RSSI at 1, 3 and 6 m and set `RSSI_LINK`; watch battery drain for an hour.
