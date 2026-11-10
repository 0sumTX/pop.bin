# CONSTELLATION

Team game for the Breakpoint 2026 badge: chains of badges mine hashes by standing together. The design doc is in `DESIGN.md`.

```
badge/    the Solana OS app (main.lua, app.json, lib/)        → upload this folder at /apps/submit
server/   Bun + bun:sqlite: /v1 badge API, /admin, scoring loop
tools/    badge_sim.lua: headless smoke test of the badge app (not shipped)
```

## Server

```sh
cd server && bun install
ADMIN_PASSWORD=... PUBLIC_ORIGIN=https://your.host DB_PATH=/data/constellation.db bun src/index.ts
bun test                     # scoring, auth, joins, demo isolation
```

| env | |
|---|---|
| `ADMIN_PASSWORD` | basic-auth password for `/admin` (unset = admin disabled) |
| `PUBLIC_ORIGIN` | your public `https://` origin. Needed behind a proxy, because the signature covers the URL the badge asked for |
| `DB_PATH` | SQLite file on the persistent disk (default `./constellation.db`) |
| `APP_ID` | store app id (default `constellation`) |
| `PORT` | default 3000 |

Every tunable in §8 can be edited live at `/admin`.

## Badge

1. Put your server host in `badge/main.lua` (`HOST`) and `badge/app.json` (`hosts`).
2. `lua tools/badge_sim.lua` runs every screen against the mock and checks the object, label, mesh and instruction limits.
3. Try it in the emulator with `DEMO_LOCAL = true` (no server needed), or as a test run against the server (needs X linked).

**Before every publish:** `DEMO_LOCAL = false`, the host is in `app.json`, and `lua tools/badge_sim.lua` passes.

**Venue day one:** check that `http` works while mesh is on; measure RSSI at 1, 3 and 6 m and set `RSSI_LINK`; watch battery drain for an hour.
