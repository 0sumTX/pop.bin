# PoP.bin: Proof of Presence

**Stand with your chain. Mine together.** A team game for the Solana Breakpoint 2026 badge. Teams ("chains") of badges ("blocks") mine hashes by physically standing together: each badge hears its teammates over the radio, draws them as a constellation, and a server scores every chain every 10 seconds. Every 2 minutes a consensus round opens, and if everyone in the chain mashes SELECT, the chain mines at 3x. The full design is in [`DESIGN.md`](DESIGN.md).

## Try it in the emulator

The emulator is the real badge firmware running in your browser. No badge needed.

**Download:** [`pop-bin-local-demo.zip`](https://github.com/0sumTX/pop.bin/releases/latest/download/pop-bin-local-demo.zip) · [`pop-bin.zip`](https://github.com/0sumTX/pop.bin/releases/latest/download/pop-bin.zip) (also on the [Releases page](https://github.com/0sumTX/pop.bin/releases/latest))

| Zip | What it is | Needs |
|---|---|---|
| `pop-bin-local-demo.zip` | A simulated world on the badge: fake chains nearby, bots, rounds. No server. | Nothing. Start here. |
| `pop-bin.zip` | The real app, talking to the live server at `pop-bin.vercel.app` | Signed in at solana.com with X linked |

### Local demo (quickest)

1. Open **https://solana.com/breakpoint/badge/apps/submit** in desktop Chrome or Edge.
2. Drop `pop-bin-local-demo.zip` onto the editor. Its `app.json` fills in the form.
3. Click **Try in emulator**. `print()` output and errors show below the badge.
4. Play:
   - **CHAINS NEARBY** lists three fake chains. Pick one to join it (accepted after ~2 s), or pick **+ CREATE NEW CHAIN** and type a name with the D-pad keyboard.
   - On the chain screen, three bots appear as stars. Their signal drifts, so links (dotted lines) form and break, and the HUD shows hashrate, hashes and rank.
   - **SELECT** mines. **DOWN** opens the leaderboard, **LEFT** the menu (star color, leave chain, about, DEMO panel).
   - A **consensus round** opens every 30 s: press SELECT 10+ times before the countdown ends to reach consensus (x3).
   - **MENU → DEMO**: add/remove bots, unlink bots (orphan test), force a round, reset the score.

An amber **DEMO** tag in the corner means you're in a demo world.

### Real app against the live server

1. Sign in on https://solana.com/breakpoint/badge/apps/submit with an account that has **X linked** (badge profile: https://solana.com/breakpoint/badge/profile). An unpublished app can only reach its server in a signed-in test run (12 hours).
2. Drop `pop-bin.zip` onto the editor and click **Try in emulator**.
3. You should see `> SYNCING...`, then CHAINS NEARBY. Emulator badges (ids starting with `e`) are always **demo badges**: they play in a separate demo world that never touches the real leaderboard.
4. Create a chain, then **MENU → DEMO → ADD BOT** a couple of times. Within ~10 s the stars link and hashrate climbs. **FORCE ROUND** opens a consensus round 3 s later.
5. **Two players:** open a second emulator tab and connect them with the page's **Bridge a badge** panel. In the DEMO panel, **SIM SIGNAL** sets the signal strength the bridged link reports (-45 strong ... -90 out of range).

### On a real badge

**Run on badge** on the same submit page copies the app over USB-C (desktop Chrome/Edge). The badge needs a microSD card and Solana OS 0.5.0 or later (update at https://solana.com/breakpoint/badge/stock).

## Layout

```
badge/    the Solana OS app (main.lua, app.json, lib/): what the zips contain
server/   Bun + libSQL/Turso on Vercel: /v1 badge API, /admin, scoring
tools/    badge_sim.lua (headless test of the badge app), build_zips.sh
```

## Badge development

```sh
lua tools/badge_sim.lua      # drives every screen against stubs of the badge API; checks the
                             # 64-object, 200-byte label, 4 mesh/s and 200k-instruction limits
tools/build_zips.sh          # checks, then writes dist/pop-bin.zip and dist/pop-bin-local-demo.zip
```

The server host is `HOST` in `badge/main.lua` and `hosts` in `badge/app.json`. Screens talk only to `G.net` / `G.radio`, which `main.lua` wires to the real modules or to `lib/mock.lua` when `DEMO_LOCAL = true` (emulator only).

**Before every publish:** `DEMO_LOCAL = false` in `badge/main.lua` (`build_zips.sh` refuses otherwise), the host is in `app.json`, and the sim passes. Publishing needs X linked; max 20 versions a day.

## Server

Live at **https://pop-bin.vercel.app** (Vercel project `pop-bin`, Bun runtime, Turso for storage). Admin console at `/admin`.

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
| `ADMIN_PASSWORD` | basic-auth password for `/admin` (unset = admin disabled) |
| `PUBLIC_ORIGIN` | public `https://` origin. The badge signature covers the URL, and Vercel's internal `req.url` differs |
| `APP_ID` | store app id (default `pop-bin`) |

Every tunable in DESIGN.md §8 can be edited live at `/admin`.

**Venue day one:** check that `http` works while mesh is on; measure RSSI at 1, 3 and 6 m and set `RSSI_LINK`; watch battery drain for an hour.
