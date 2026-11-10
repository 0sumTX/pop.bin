# CONSTELLATION — Design Doc

A team game for the Solana Breakpoint 2026 (BP26) conference badge. Teams ("chains") of players ("blocks") mine points ("hashes") by physically standing together. The badge detects nearby teammates over its radio, draws them as a constellation, and a server scores every chain every 10 seconds.

Working title: **CONSTELLATION**. Everything here is a starting point; numbers marked *(tunable)* live in server config so they can change at the venue without republishing the app.

---

## 0. References

Read the Lua API docs in full before writing badge code. When this doc and the official docs disagree, **the official docs win**; flag the difference.

**Hardware** (BP26 badge: ESP32-C5, 320×240 ILI9341 display, D-pad, 8× WS2812B LEDs, microSD, 1000 mAh LiPo, Wi-Fi 6 / BLE 5 / 802.15.4)
- Board overview (interactive board view): https://solana.com/breakpoint/badge/#board
- Compute: https://solana.com/breakpoint/badge/#compute
- Display: https://solana.com/breakpoint/badge/#display
- Input (buttons): https://solana.com/breakpoint/badge/#input
- Light (LEDs): https://solana.com/breakpoint/badge/#light
- Storage (microSD): https://solana.com/breakpoint/badge/#storage
- Connectivity (radios, USB): https://solana.com/breakpoint/badge/#connectivity
- Power (battery): https://solana.com/breakpoint/badge/#power
- Case design / dimensions: https://solana.com/breakpoint/badge/#case

**Solana OS and apps**
- Solana OS overview: https://solana.com/breakpoint/badge/#solana-os
- **Emulator** (the real firmware in the browser, with bridging): https://solana.com/breakpoint/badge/emulator
- **Lua API docs** (canonical reference for everything in §2): https://solana.com/breakpoint/badge/apps/docs
- Same reference in the repo: https://github.com/solana-foundation/solana-os/blob/main/docs/LUA_API.md
- Solana OS source (MIT; mesh and bridges are documented in `docs/MESH.md`): https://github.com/solana-foundation/solana-os
- Submit / web editor (Try in emulator, Run on badge, publish): https://solana.com/breakpoint/badge/apps/submit
- App Store (see what's published): https://solana.com/breakpoint/badge/apps
- Building quests: https://solana.com/breakpoint/badge/apps/docs/quests
- Stock firmware flasher (update badges to Solana OS ≥ 0.5.0): https://solana.com/breakpoint/badge/stock
- Badge profile (claim badge, link X; needed for test runs and publishing): https://solana.com/breakpoint/badge/profile

**Server-side**
- Badge request signing public key: https://badge-api.solana.com/api/http/key
- Badge server API base (escrows etc., not needed for v1): `https://badge-api.solana.com/api/...`

**Related apps worth reading** (they publish their `main.lua` on their store pages)
- SOLMATES, nearby discovery with a radar: https://solana.com/breakpoint/badge/apps/app?id=solmates

**Support:** Telegram, linked from the badge site's top navigation.

---

## 1. Glossary

| Term | Meaning |
|---|---|
| **Chain** | A team. Has a unique name. Max 8 blocks *(tunable)*. |
| **Block** | A player (one badge). Belongs to at most one chain. |
| **Genesis block** | The block that created the chain. Cosmetic only, no special powers. |
| **Block height** | Join order within a chain: genesis = 0, next = 1, … Used for display order and LED mapping. |
| **Link** | Two blocks of the same chain that both detect each other's badge at or above the signal threshold in the same epoch. |
| **Canonical chain** | The largest connected group of linked blocks in a chain. Ties: the group containing the lowest block height. Only the canonical chain mines. |
| **Orphaned blocks** | Blocks of a chain that are not in the canonical chain. They mine nothing until they reconnect. |
| **Hashrate (H/s)** | A chain's current mining rate. |
| **Hashes** | Score. Each epoch adds hashrate × epoch length. |
| **Epoch** | The 10-second scoring interval *(tunable)*. |
| **Consensus round** | A periodic 10-second window when every block in the canonical chain must press SELECT enough times to earn a multiplier. |

---

## 2. Platform constraints (read before writing any badge code)

Badge apps are **Lua 5.5** programs running sandboxed on **Solana OS** (ESP32-C5, open source: `github.com/solana-foundation/solana-os`). The canonical API reference is `docs/LUA_API.md` in that repo, also at https://solana.com/breakpoint/badge/apps/docs. Read it fully before building; this section summarizes what shapes the design.

### Hard limits

| Resource | Limit |
|---|---|
| Lua heap | **48 KB**. Exceeding it kills the app ("Out of memory"). |
| CPU | **200,000 VM instructions per callback** ("Script took too long"). |
| UI objects | **64 on screen at once** (labels, rects, bars, lists, QR). |
| Label text | 200 bytes per label, 6 KB total on screen. |
| Timers | 8 at once, ≥ 20 ms. |
| `storage` | 16 KB per app (JSON-encodable key/values, persists across launches). |
| `main.lua` | ≤ 64 KB. Up to 64 bundled files (≤ 256 KB each, ≤ 1 MB total), loaded via `require("lib.x")`. |
| `mesh` | **4 messages/sec**, ≤ 200 bytes each (as JSON). |
| `http` | **60 requests/min per badge**, ≤ 2 KB request body, ≤ ~3.5 KB response (longer is truncated), 6 s timeout, `https://` only, only hosts listed in the manifest (≤ 8). |
| Numbers | **32-bit integers** (wrap at ±2,147,483,647) and 32-bit floats. Server must send big numbers as pre-formatted strings. |

### Display and input
Hardware detail: https://solana.com/breakpoint/badge/#display and https://solana.com/breakpoint/badge/#input. Test everything visual in the emulator first: https://solana.com/breakpoint/badge/emulator
- Screen below the status bar: **320 × 218 px** (`ui.W`, `ui.H`), origin top-left.
- Primitives: `ui.label`, `ui.rect` (with `radius`), `ui.bar`, `ui.gradient`, `ui.list`, `ui.qr`, `ui.hint`, `ui.toast`, `ui.confirm`, `ui.input`, `ui.clear`. **There is no line primitive**: draw links as dotted rows of small rects.
- Label sizes 12 / 14 / 20 / 32. **Size 12 is always monospace**: use it for the retro look.
- Colors: theme names or fixed `0xRRGGBB`. We use fixed colors everywhere.
- Keys in `on_key(key, rep)`: `"up" "down" "left" "right" "select" "back"`. Returning false/nil for `"back"` exits the app. HOME (BOOT button) always exits.
- `ui.input(prompt, maxLen, cb)` is a D-pad keyboard: slow, so only founders type.

### Lifecycle
- Top-level chunk runs once (build UI there). Then `on_tick(ms)` every **50 ms**, `on_key`, `on_mesh(from, msg)`, `on_exit()`.
- Only one app runs at a time. The game only exists while the app is open.

### Radio (`mesh`, permission `mesh`)
Hardware detail: https://solana.com/breakpoint/badge/#connectivity (Solana OS uses Wi-Fi + ESP-NOW; BLE is not in the firmware).
- `mesh.nearby()` → `{ {id, name, level, rssi, kind, bridged}, ... }`. `name` is the owner's X handle. `rssi` in dBm (e.g. -48). `kind` is `"badge"` for badges.
- `mesh.send(to, msg)`: `to` = badge id or `"*"`; delivered to `on_mesh` on badges **running the same app**.
- **Bridged badges** (emulator ↔ badge via server) appear with `bridged=true` and `rssi=0`. The server must ignore bridged links in scoring except for demo badges (see §9), or remote players could link from anywhere.
- **Emulator badges have ids starting with `"e"`** (`badge.id()` on the badge, `X-Badge-Id` on the server). The emulator has no radio. During a test run it joins a demo Wi-Fi network, so `badge.online()` can be true there.
- Opening an app with `mesh` moves the radio to the mesh channel. **Verify on real hardware on day one that `http` still works while mesh is active.** The whole game depends on both.

### Server calls (`http`, permission `http`)
- Async: `cb(ok, res)`; `res = {status, body, type, truncated}`. Failure strings include `"offline"`, `"not linked"`, `"too fast"`, `"timeout"`, `"host not allowed"`.
- Every request carries **signed headers** (`X-Badge-App`, `X-Badge-Id`, `X-Badge-User`, `X-Badge-Time`, `X-Badge-Request`, `X-Badge-Key`, `X-Badge-Signature`, Ed25519). Public key: `GET https://badge-api.solana.com/api/http/key`. The docs include a TypeScript `fromBadge()` verifier: copy it.
- **Do not use `ws` (WebSockets).** While a socket is open, `badge.online()` is false and every other server call fails with `"socket open"`. That breaks the Wi-Fi gate.

### Other APIs we use
- `badge.id()`, `badge.owner()` (e.g. `"@toly"`), `badge.online()` (Wi-Fi joined **and** registered with the badge server).
- `wifi.status()` → `"off" | "connecting" | "on" | "failed"`, `wifi.ssid()` (permission `wifi`).
- `sys.time()` → unix seconds from the server clock (nil if never synced), `sys.millis()`, `sys.exit()`.
- `led.set(i, r, g, b)`, `led.fill`, `led.off` (permission `led`). 8 LEDs: 1–6 across the top, 7–8 on the right edge. The OS caps brightness. Hardware: https://solana.com/breakpoint/badge/#light
- Battery: 1000 mAh LiPo, percentage via `sys.battery()`. Hardware: https://solana.com/breakpoint/badge/#power
- `storage.get/set/remove`.

### Manifest
`permissions: ["wifi", "led", "mesh", "http"]`, `hosts: ["<our server host>"]`, `category: "games"`. Requires Solana OS ≥ 0.5.0.

### Security reality
Anyone can read `main.lua` and run a modified copy under our app id. **The server decides everything.** Never put secrets (admin password, keys) in badge code. The signed headers prove *which badge* is calling, not that it runs our code.

---

## 3. Game rules

### Chains
- Names: 3–16 characters. Normalize for uniqueness: lowercase, trim, collapse internal spaces. Display in UPPERCASE.
- First come, first served, on good faith. Admins can delete or rename chains (§7).
- One chain per badge. Leaving frees the slot; block heights are not reused.
- Max blocks per chain: **8** *(tunable)*. Matches the 8 LEDs and the screen's object budget.

### Joining
- You can only join by being physically near an existing member running the app.
- **Any** member can accept a join request (not just genesis), so the team isn't stuck when the founder is away.

### Links and the canonical chain (computed by the server each epoch)
1. For each pair of blocks A, B in the same chain: they are linked if **both** reported each other in this epoch with `rssi ≥ RSSI_LINK` (default **-65 dBm**, *tunable*, calibrate at the venue) and neither entry was bridged (demo chains excepted, §9).
2. Find connected components of linked blocks.
3. The largest component is the canonical chain (tie → lowest block height). Everyone else in the chain is orphaned.
4. A chain whose largest component has 1 block has no links and mines nothing.

### Hashrate and score
Per epoch (10 s), for a canonical chain of `n` blocks:

| Part | Formula | Default *(tunable)* |
|---|---|---|
| Base | `BASE_PER_LINK × (n − 1)` | 100 H/s per link |
| Clicks | `CLICK_HS × Σ min(clicks_i, CLICK_CAP)` over canonical blocks | 2 H/s per click, cap 50 per epoch (5/s) |
| Multiplier | `CONSENSUS_MULT` if consensus is active, else 1 | 3× |

`hashrate = (base + clicks) × multiplier`; `hashes += hashrate × EPOCH_SECONDS`.

Orphaned blocks' clicks count for nothing.

### Consensus rounds
- Every `ROUND_EVERY` seconds (default **120**), a round opens for `ROUND_WINDOW` seconds (default **10**), aligned to server unix time: round `r` opens at `t = r × ROUND_EVERY`. Badges compare `sys.time()` against the **next round time the server sends** in every report response (§5), rather than computing it themselves. That way demo mode can speed up rounds or force one immediately (§9).
- If **every block in the canonical chain** (n ≥ 2) presses SELECT at least `ROUND_CLICKS` times (default **10**) inside the window, the chain reaches **consensus**: multiplier active until the next round opens.
- If anyone misses, there's no multiplier for that cycle.
- Badges report round clicks separately from epoch clicks, tagged with round id `r`, so the server can check them.

---

## 4. Badge app

### File layout
```
badge/
  main.lua          state machine, callbacks
  app.json
  lib/theme.lua     colors, fonts, Win95 dialog, star/dot drawing helpers
  lib/net.lua       http wrapper: report loop, retries, error mapping
  lib/mock.lua      local demo: same interface as net.lua + mesh.lua, all simulated (§9)
  lib/mesh.lua      heartbeat, join messages, nearby-chains table
  lib/screens/*.lua one module per screen (gate, chains, create, joining, chain, board, round, menu, demo)
```
**Screens must never call `http` or `mesh` directly.** They go through one interface (`net` + `mesh`) that `main.lua` wires to either the real modules or `lib/mock.lua`. That is what makes local demo mode possible.
Use `fs.load` for screens that are only needed briefly, to keep the heap low. Free UI objects with `ui.clear()` on every screen change.

An existing `main.lua` (built earlier) already implements the **Wi-Fi gate and Win95 error dialog** (§4.2, screen 0). Reuse it as the reference for both.

### 4.1 State machine
```
GATE ──ok──► (storage has chain?) ──yes──► CHAIN
  │                    │no
  │error               ▼
  ▼               CHAINS_NEARBY ──pick──► JOINING ──accepted──► CHAIN
FATAL (exit)           │ "+ create"           │timeout ──► CHAINS_NEARBY
                       ▼
                    CREATE ──ok──► CHAIN
                       │409 exists
                       ▼
                 dialog "CHAIN EXISTS. FIND A BLOCK TO JOIN." ──► CHAINS_NEARBY

CHAIN ◄──► BOARD (UP / DOWN)
CHAIN ──► MENU (LEFT): star color, leave chain, about, DEMO (demo badges only)
ROUND overlay appears over CHAIN/BOARD while a round is open
Incoming join request ──► confirm overlay on any screen (except FATAL)
```
On launch after the gate, call `GET /v1/me` so a badge that lost its `storage` recovers its chain.

### 4.2 Screens

**0. Gate** (built). `badge.online()` → straight through, no screen. Wi-Fi off/failed → fatal dialog. Still connecting → "> DIALING IN..." for up to 8 s, then pass or fail. Online but unclaimed → fatal dialog. Mid-game dropout → red "SIGNAL LOST. RETRY 27s" countdown for 30 s *(tunable)*, then fatal dialog. Fatal dialog: Win95 window titled `CONSTLN.EXE`, red X icon, bevelled frame, OK button, red blinking LEDs; SELECT/CANCEL exits.

**1. Chains nearby.** A `ui.list` of chains heard via heartbeats in the last ~10 s, strongest signal first: title = chain name, sub = "3/8 BLOCKS", right = signal bars. The last item is always "+ CREATE NEW CHAIN". Empty state: "> NO CHAINS IN RANGE". SELECT on a chain → send a join request to the nearest member of it → JOINING.

**2. Create.** `ui.input("CHAIN NAME", 16)` → `POST /v1/chains`. Success → you're genesis → CHAIN. 409 → dialog, back to CHAINS_NEARBY.

**3. Joining.** "> BROADCASTING JOIN REQUEST" with animated dots and the target member's handle. Re-send the mesh request every 3 s (messages can drop). Poll `GET /v1/me` every 3 s until membership appears. Give up after 60 s.

**4. Join confirm (member side).** On `on_mesh` join message: `ui.confirm("@handle WANTS TO JOIN. ACCEPT?")`. Yes → `POST /v1/join/accept`.

**5. Chain (main screen).**
- Top ~170 px: the constellation. Blocks are placed at fixed slots by block height along a zigzag or arc. Each block is a star: a small rounded rect in that block's star color, larger for yourself, dim gray if orphaned or absent. Links are dotted lines, 3–4 small rects per edge, only for the canonical chain's spanning tree (≤ 7 edges). Only your own handle is labeled by default.
- Bottom HUD (mono 12): `HASHRATE 1.40 kH/s  x3`, `HASHES 1.2M`, `RANK #3`, and the status line.
- Orphaned: HUD shows "> ORPHANED. FIND YOUR CHAIN." in red.
- SELECT = mine (count a click, flash one LED).
- Object budget: 8 stars + 8 handle labels max + 28 dots + ~6 HUD labels + hint ≈ 51 of 64. Stay under.

**6. Board.** `ui.list` of the top 10 chains: rank, name, hashes. Highlight yours. Refreshes every 30 s.

**7. Round overlay.** Appears when `sys.time()` is inside a round window: big "CONSENSUS ROUND" + seconds left, a `ui.bar` of your clicks toward `ROUND_CLICKS`, and "4/6 BLOCKS READY" (from mesh round broadcasts). Ends with "CONSENSUS REACHED x3" or "CONSENSUS FAILED".

**8. Menu.** Star color picker (palette below), leave chain (`ui.confirm`), about. Demo badges also get **DEMO** → the demo panel (§9).

**9. Demo panel.** Demo badges only; see §9.

**All screens:** when demo mode is active, show an amber `DEMO` tag in the top-right corner of every screen, so recordings and screenshots are never mistaken for the real game.

### 4.3 Radio protocol (mesh, JSON ≤ 200 bytes)

| Message | When | Body |
|---|---|---|
| Heartbeat | every 2 s, to `"*"` | `{"t":"hb","c":"<chain or empty>","h":<height>,"n":<size>,"s":<star color index>}` |
| Join request | every 3 s while joining, to a member id | `{"t":"join","c":"<chain>"}` |
| Round progress | every 1 s during a round, to `"*"` | `{"t":"rc","c":"<chain>","r":<round id>,"k":<clicks>}` |

Keep total sends under 4/s. Heartbeats tell the badge which nearby badges run our app and which chain they're in; `mesh.nearby()` supplies the RSSI.

### 4.4 Report loop (http)
Every 10 s *(tunable)*, `POST /v1/report`:
```json
{
  "handle": "@0sumTX",
  "nearby": [{"id": "7K2Q9M", "rssi": -58, "bridged": false, "sim": -55}],
  "clicks": 23,
  "round": {"id": 14982734, "clicks": 12}
}
```
- `nearby` includes **only badges on our chain's roster** (from the last response), at most 7 entries, so it fits 2 KB even in a crowd.
- `sim` (optional) = simulated signal strength set in the demo panel. The server uses it **only** for demo badges and ignores it otherwise.
- `clicks` = SELECT presses since the last successful report (the server caps them).
- `round` is present only if the badge pressed during the current or just-ended round.
- The response carries everything the chain screen needs (§5). That keeps us at ~6 requests/min against the limit of 60. Board refreshes and join polling add a few more.

### 4.5 LEDs
- Idle: LED *i* = block height *i − 1*. Lit in that block's star color if linked, very dim if in the chain but not linked, off if the slot is empty.
- Click: brief white flash on one LED.
- Round open: all LEDs pulse green. Consensus reached: fast green chase.
- Fatal: red blink.

---

## 5. Server

### Stack
Bun + `bun:sqlite`, one process, deployed with a persistent disk on a public `https://` host (that host goes in the manifest's `hosts`). It serves the badge API, the admin console and the scoring loop.

### Auth
Every `/v1/*` request: verify the signed headers with `fromBadge()` from the Lua API docs (check signature, `X-Badge-App` = our app id, time within 60 s, request id not replayed). Identity: **block id = `X-Badge-Id`**; also store `X-Badge-User`. Reject otherwise with 403.

### Data model
```
chains(id, name UNIQUE, display_name, genesis_badge, created_at,
       hashes INTEGER, consensus_until INTEGER, deleted INTEGER,
       demo INTEGER, round_override_at INTEGER)                          -- demo: §9
blocks(badge_id PK, user_id, handle, chain_id, height, star INTEGER, joined_at,
       bot INTEGER, bot_linked INTEGER)                                  -- bots: §9
reports(badge_id PK, at, nearby_json, clicks, round_id, round_clicks)   -- latest per badge
join_requests(joiner_badge, chain_id, via_badge, at)
join_accepts(member_badge, joiner_badge, at)
config(key PK, value)                                                    -- all tunables
epochs(chain_id, at, n, hashrate, multiplier)                            -- optional history
```

### Endpoints

| Method | Path | Does |
|---|---|---|
| GET | `/v1/me` | My block + chain (or null) + config the badge needs (round timing, epoch length, max blocks) + `"demo": true/false` (§9). |
| POST | `/v1/chains` | `{name}` → create; caller becomes genesis. 409 if the normalized name exists. 409 if the caller is already in a chain. |
| GET | `/v1/chains/:name` | Exists? Size? |
| POST | `/v1/join/request` | `{chain, via}` → record. |
| POST | `/v1/join/accept` | `{joiner}` → record; caller must be a member. |
| POST | `/v1/leave` | Leave my chain. |
| POST | `/v1/star` | `{star}` → set my star color index. |
| POST | `/v1/report` | §4.4 body → store latest; respond with chain state. |
| GET | `/v1/board` | Top 10 chains. Real chains for real badges, demo chains for demo badges (§9). |
| POST | `/v1/demo/*` | Demo-only controls (§9). 403 for non-demo badges. |

**Join matching:** whenever a request or accept arrives, look for its counterpart (same joiner, `via` = accepting member, both within 60 s, chain not full, joiner not in a chain). On match: add the joiner at the next height and delete both records.

**`/v1/report` response** (must stay well under 3.5 KB):
```json
{
  "chain": "ZEROSUM",
  "blocks": [{"id":"7K2Q9M","h":0,"handle":"@toly","star":2,"linked":true,"canon":true}],
  "edges": [[0,1],[1,2]],
  "hashrate": "1.40 kH/s",
  "mult": 3,
  "hashes": "1.2M",
  "rank": 3,
  "orphaned": false,
  "round": {"at": 1794000120, "len": 10}
}
```
`round.at` is the unix time the next (or current) round opens; `round.len` is its length in seconds. Badges always use these values.
Big numbers go out as display strings (32-bit Lua). `edges` is the canonical spanning tree by block height.

### Scoring loop
Every `EPOCH_SECONDS`, for every chain:
1. Take each block's latest report if it's no older than 15 s.
2. Build links (§3), find the canonical chain.
3. Compute hashrate (§3); add to `hashes`.
4. At the end of each round window: check consensus with round reports for that round id; set `consensus_until` to the next round's open time if reached.

---

## 6. Art direction

- Black background `0x000000`. **All UI** in matrix green `0x00FF41`; secondary text and bevel shadows `0x00802A`; accents white `0xFFFFFF`; errors `0xFF2A2A`.
- **Stars are the only other colors.** Palette (index → color): 0 white `0xFFFFFF`, 1 cyan `0x00FFFF`, 2 amber `0xFFB000`, 3 pink `0xFF4FD8`, 4 electric blue `0x7DF9FF`, 5 violet `0xB388FF`.
- Type: monospace size 12 almost everywhere, UPPERCASE, terminal-prompt prefixes ("> "). Size 20/32 only for big numbers and round countdowns.
- Dialogs: Windows 95 structure in the green palette: bevelled frame (bright top-left, shadow bottom-right), title bar with a close box, icon, focused OK button. See the existing `main.lua` `fatal()`.
- Square corners everywhere except stars (rounded).

---

## 7. Admin console

A web page served by our server at `/admin`, protected by a password from an environment variable (never in badge code). Stakes are low; basic auth over HTTPS is fine. Actions:
- List chains with members, heights, hashes.
- Delete chain, rename chain, kick block, reset a chain's score, reset everything.
- Edit every tunable in `config` live.
- Demo controls: turn demo mode on/off, edit the `DEMO_BADGES` allowlist, add or remove bots on any demo chain, force a round, wipe all demo chains.

---

## 8. Tunables (server `config`, editable in admin)

| Key | Default | Notes |
|---|---|---|
| `EPOCH_SECONDS` | 10 | Also the badge report interval (sent in `/v1/me`). |
| `RSSI_LINK` | -65 | dBm. **Calibrate at the venue on day one.** |
| `MAX_BLOCKS` | 8 | |
| `BASE_PER_LINK` | 100 | H/s |
| `CLICK_HS` | 2 | H/s per click |
| `CLICK_CAP` | 50 | Clicks per block per epoch |
| `ROUND_EVERY` | 120 | Seconds |
| `ROUND_WINDOW` | 10 | Seconds |
| `ROUND_CLICKS` | 10 | Per block, to count as ready |
| `CONSENSUS_MULT` | 3 | |
| `REPORT_MAX_AGE` | 15 | Seconds |
| `JOIN_WINDOW` | 60 | Seconds for a request/accept pair |
| `DEMO_ENABLED` | true | Master switch for server demo mode (§9). Safe to leave on during the event, because demo chains are isolated. |
| `DEMO_BADGES` | `[]` | Real badge ids that also get demo mode (dev hardware). Emulator ids (`e…`) are always eligible. |
| `DEMO_BRIDGED_RSSI` | -55 | RSSI used for a demo badge's bridged entry when it sends no `sim`. |
| `DEMO_ROUND_EVERY` | 30 | Round interval for demo chains, so rounds can be tested quickly. |
| `BOT_MAX` | 7 | Bots per demo chain. |
| `BOT_CLICKS` | 30 | Each bot clicks a random 0–N times per epoch. |
| `BOT_ROUND_P` | 0.8 | Chance each bot is "ready" in a round, so consensus sometimes fails. |

The badge-side `GRACE_BOOT` (8 s), `GRACE_LOST` (30 s) and `DEMO_LOCAL` (§9) live in `main.lua`.

---

## 9. Demo mode

**Not part of the badge platform.** The official docs only provide the emulator, bridges and 12-hour test runs. Everything in this section is ours to build.

### Why
The emulator has no radio, bridged badges all report signal strength 0, one developer can't form an 8-block chain alone, and 2-minute rounds are slow to test. Demo mode fakes past all of that **without letting anyone cheat the real competition**, so we can keep testing (and demoing to people) during the event.

### Who gets it
The **server** decides. A badge is a demo badge when `DEMO_ENABLED` is true **and** either its `X-Badge-Id` starts with `"e"` (an emulator; this header is signed by the badge server, so it can't be faked) or its id is in `DEMO_BADGES`. `/v1/me` tells the badge with `"demo": true`. The badge never decides it is a demo badge on its own, except for local demo (below).

### Isolation (the rule that keeps the real game fair)
- A chain created by a demo badge is a **demo chain** (`chains.demo = 1`). Demo badges can only create or join demo chains; real badges can only create or join real chains.
- Heartbeats from demo chains carry `"d":1`. Real badges hide demo chains from their nearby list, and vice versa.
- Demo chains never appear on the real board. `/v1/board` shows demo badges a separate demo board.
- Opening the emulator gives a player demo powers, but only inside the demo world, where they're harmless.

### Server demo (online)
Needs the app running somewhere with server access: published, or in a test run (which requires X linked on the developer's account; that limit can't be bypassed). For demo chains only:

| Fake | How |
|---|---|
| **Proximity** | Bridged entries count as links. Signal strength comes from the report's `sim` field (set in the demo panel), or `DEMO_BRIDGED_RSSI` if absent. |
| **Teammates** | **Bots**: server-side blocks with ids `bot-1` … `bot-7` in a demo chain. A bot counts as linked to the badge that added it whenever that badge reported this epoch, unless its `bot_linked` flag is off (to test orphaning). Bots click a random 0–`BOT_CLICKS` per epoch and are ready in a round with probability `BOT_ROUND_P`. Bots appear in reports and on screen like real blocks, with handles `@bot1` etc. |
| **Joining** | `POST /v1/demo/join {chain}` joins a demo chain instantly, no accept needed. |
| **Time** | Demo chains use `DEMO_ROUND_EVERY` instead of `ROUND_EVERY`. `POST /v1/demo/round` sets `round_override_at` so the next round opens 3 s from now; the report response's `round.at` reflects it. |
| **Score** | `POST /v1/demo/reset` zeroes the demo chain's hashes. |

Demo endpoints: `POST /v1/demo/join`, `/v1/demo/bots` (`{"op": "add" | "remove" | "toggle_link", "bot": "bot-3"}`), `/v1/demo/round`, `/v1/demo/reset`. All return 403 for non-demo badges.

### Local demo (offline, no server at all)
For UI and animation work before the server exists, or without an X-linked test run.
- `local DEMO_LOCAL = false` at the top of `main.lua`. When true **and** `badge.id()` starts with `"e"` (or is nil, as before the first hello), `main.lua` wires screens to `lib/mock.lua` instead of `net` + `mesh`, and skips the Wi-Fi gate.
- `mock.lua` implements the same interface and simulates the world: 3 fake chains in the nearby list, joining always accepted after 2 s, a chain with 3 bots whose signal drifts randomly (so links form and break), scoring with the real formulas from §3, rounds every 30 s.
- **Release checklist:** `DEMO_LOCAL` must be `false` in every published version. Add a startup `print()` warning when it's true.

### Demo panel (badge screen 9)
Reachable from MENU → DEMO, demo badges only. A `ui.list`; LEFT/RIGHT changes a value, SELECT runs an action:

| Item | Does |
|---|---|
| `SIM SIGNAL  [-55]` | Cycles -45 / -55 / -65 / -75 / -90 dBm; sent as `sim` on every bridged entry. |
| `ADD BOT` / `REMOVE BOT` | Calls `/v1/demo/bots`. |
| `BOT LINKS  [ON]` | Toggles `bot_linked` on all bots (orphan test). |
| `FORCE ROUND` | Calls `/v1/demo/round`. |
| `RESET SCORE` | Calls `/v1/demo/reset` (with `ui.confirm`). |

In local demo, the same panel drives `mock.lua` instead.

### What demo mode can't fake
- Real radio behavior: RSSI in a crowded hall, body blocking, mesh and Wi-Fi coexisting. Only real hardware at the venue answers those (see the day-one checklist in §11).
- Platform rules: test runs need X linked, publishing needs X linked, and the store's limits (§2) still apply.

---

## 10. Build order

Each milestone is playable without the next. Breakpoint is days away: ship in this order and stop wherever time runs out.

0. **Interface + local demo.** The `net`/`mesh` interface and `lib/mock.lua`, so screens can be built and tested in the emulator before the server exists.
1. **Chains.** Server: auth, `/v1/me` (with the `demo` flag), `/v1/chains`, join request/accept matching, `/v1/leave`, demo isolation, `/v1/demo/join`. Badge: gate → chains nearby → create / join → a plain chain screen listing members. *Done when two badges (or badge + bridged emulator in demo mode) can create and join a chain.*
2. **Linking + base hashrate.** Report loop, scoring loop, constellation drawing, HUD. *Done when standing together raises hashrate and walking apart orphans a block.*
3. **Board.** `/v1/board` + the Board screen.
4. **Clicks + consensus rounds.** Click counting, round overlay, mesh round progress, multiplier. Bots click and join rounds; `/v1/demo/round`.
5. **Polish.** Star colors, LED states, the full demo panel, admin console niceties.

Milestone 2 should include bots and `sim` signal strength, since that's the only way to test linking and orphaning from the emulator.

---

## 11. Testing

- **Emulator:** https://solana.com/breakpoint/badge/emulator, or "Try in emulator" on https://solana.com/breakpoint/badge/apps/submit. Two emulator tabs can bridge to each other (`mesh.bridge()` / the page's "Bridge a badge" panel). Bridged badges show `rssi=0`; demo mode (§9) handles that with `sim` signal strength and bots.
- **Before the server exists:** set `DEMO_LOCAL = true` and work against `lib/mock.lua` (§9).
- **Real badge:** "Run on badge" on `/apps/submit` (desktop Chrome/Edge, USB-C, Web Serial). Needs a microSD card (name brand) and Solana OS ≥ 0.5.0.
- **Test runs:** `http` calls from an unpublished app only work in a signed-in test run, which needs **X linked** on the developer's account. Test runs last 12 hours.
- Use the badge console's `lua mem` to watch peak heap and instruction counts.
- **Venue day-one checklist:** confirm http works while mesh is on; walk two badges apart and record RSSI at 1 m / 3 m / 6 m to set `RSSI_LINK`; check battery drain over an hour.

## 12. Publishing

Publishing needs an account with X linked. The store compiles every Lua file (it refuses code that doesn't compile) and runs an automatic safety check, usually within a minute. Max 20 versions a day, so batch fixes. Once published, `http` hosts and permissions come from the published version: add the server host before publishing. Confirm `DEMO_LOCAL = false` before every publish.
