-- PoP.bin (Proof of Presence): stand with your chain, mine together. Design doc: DESIGN.md.
local DEMO_LOCAL = false   -- RELEASE CHECKLIST: must be false in every published version (§9)
local HOST = "https://pop-bin.vercel.app"   -- also in app.json "hosts"
local GRACE_BOOT, GRACE_LOST = 8000, 30000

local T = require("lib.theme")
local bid = badge.id()
local LOCAL = DEMO_LOCAL and (bid == nil or bid:sub(1, 1) == "e")
if DEMO_LOCAL then print("WARNING: DEMO_LOCAL is true. Never publish this build.") end

-- Screens only ever talk to G.net / G.radio: the real modules or the local mock.
local net, radio
if LOCAL then
  local m = require("lib.mock")
  net, radio = m.net, m.radio
else
  net, radio = require("lib.net"), require("lib.mesh")
  net.init(HOST)
end

local G = {
  net = net, radio = radio, T = T, local_demo = LOCAL, demo = LOCAL,
  phase = "gate", chain = storage.get("chain"), state = nil, modal = false,
  cfg = { epoch = 10, max_blocks = 8, round_clicks = 10, round_window = 10 },
  clicks = 0, rc = { id = 0, k = 0 }, star = storage.get("star") or 1,
  sim = -55, bot_links = true, ignored = {}, flash_until = 0, flash_i = 1, chase_until = 0,
}
local screen, screen_name
local lost_at, lost_bg, lost_label
local boot_at = sys.millis()

function G.now() return net.now() end

function G.go(name, args)
  if screen and screen.exit then screen.exit() end
  ui.clear()
  ui.bg(T.BLACK)
  G.modal = false
  lost_bg, lost_label = nil, nil
  local chunk = assert(fs.load("lib/screens/" .. name .. ".lua"))
  screen_name = name
  screen = chunk()(G, args) or {}
  if G.demo then T.demo_tag() end
end

function G.fatal(msg)
  if G.phase == "fatal" then return end
  G.phase = "fatal"
  ui.clear()
  ui.bg(T.BLACK)
  T.dialog(T.wrap(msg, 26), "x")
  screen, screen_name = { key = function(k) if k == "select" or k == "back" then sys.exit() end return true end }, "fatal"
end

function G.my_block()
  if not G.state then return nil end
  for _, b in ipairs(G.state.blocks) do if b.id == bid then return b end end
end

function G.round()
  local r = G.state and G.state.round
  local now = G.now()
  if r and now and now >= r.at and now < r.at + r.len then return r.at, r.at + r.len - now end
end

-- A new chain state (report response, create, join, demo bots).
function G.apply(s)
  if type(s) ~= "table" or type(s.blocks) ~= "table" then return end
  G.state = s
  if s.chain and s.chain ~= G.chain then G.chain = s.chain; storage.set("chain", s.chain) end
  if screen and screen.update then screen.update() end
end

-- /v1/me with a chain: we're in.
function G.enter(me)
  G.demo = me.demo == true or LOCAL
  if type(me.config) == "table" then G.cfg = me.config end
  if not me.chain then return G.go("chains") end
  G.chain = me.chain
  storage.set("chain", me.chain)
  G.state = me.state
  G.go("chain")
end

function G.left(msg)
  G.chain, G.state = nil, nil
  storage.remove("chain")
  G.go("chains")
  if msg then ui.toast(msg) end
end

function G.click()
  G.clicks = G.clicks + 1
  local at = G.round()
  if at then
    if G.rc.id ~= at then G.rc = { id = at, k = 0 } end
    G.rc.k = G.rc.k + 1
  end
  G.flash_i = G.clicks % 8 + 1
  G.flash_until = sys.millis() + 80
end

function G.handle_of(id)
  for _, p in ipairs(radio.nearby()) do if p.id == id then return p.name ~= "" and p.name or id end end
  return id
end

function G.on_join_request(from, chain)
  if G.phase ~= "game" or G.modal or not G.chain or chain ~= G.chain then return end
  if (G.ignored[from] or 0) > sys.millis() then return end
  G.ignored[from] = sys.millis() + 60000   -- one prompt per joiner per minute
  G.modal = true
  ui.confirm(G.handle_of(from) .. " WANTS TO JOIN. ACCEPT?", function(yes)
    G.modal = false
    if not yes then return end
    net.accept(from, function(ok, data)
      ui.toast(ok and "ACCEPTED. WELCOME THEM." or ("ACCEPT FAILED: " .. tostring(data)))
    end)
  end)
end

-- Report loop (§4.4) -------------------------------------------------------
local reporting, last_report = false, -60000

local function report()
  reporting = true
  last_report = sys.millis()
  local roster = {}
  for _, b in ipairs(G.state and G.state.blocks or {}) do roster[b.id] = true end
  local near = {}
  for _, p in ipairs(radio.nearby()) do
    if roster[p.id] and p.id ~= bid and #near < 7 then
      local e = { id = p.id, rssi = p.rssi or 0, bridged = p.bridged == true }
      if G.demo and p.bridged then e.sim = G.sim end
      near[#near + 1] = e
    end
  end
  local sent = G.clicks
  local body = { handle = badge.owner(), nearby = near, clicks = sent }
  local now = G.now() or 0
  if G.rc.id > 0 and G.rc.k > 0 and now < G.rc.id + 40 then body.round = { id = G.rc.id, clicks = G.rc.k } end
  net.report(body, function(ok, data, status)
    reporting = false
    if ok then
      G.clicks = math.max(0, G.clicks - sent)
      G.apply(data)
    elseif status == 409 and G.phase == "game" and not G.modal then
      G.left("YOU ARE NO LONGER IN A CHAIN")
    end
  end)
end

-- Boot: gate, then /v1/me ---------------------------------------------------
local function start_game()
  G.phase = "game"
  ui.clear()
  T.text(10, 100, "> SYNCING...", T.GREEN)
  net.me(function(ok, me)
    if ok then return G.enter(me) end
    if G.chain then return G.go("chain") end     -- server down: show the cached chain, reports retry
    G.go("chains")
    ui.toast(tostring(me))
  end)
end

-- "ok", "wait", or a fatal message.
local function gate()
  if LOCAL then return "ok" end
  if badge.online() then
    if not badge.owner() then return "THIS BADGE IS NOT CLAIMED. CLAIM IT AT SOLANA.COM/BREAKPOINT/BADGE" end
    return "ok"
  end
  local st = wifi.status()
  if st == "off" then return "WI-FI IS OFF. TURN IT ON IN SETTINGS, THEN TRY AGAIN." end
  if st == "failed" then return "WI-FI FAILED TO CONNECT. CHECK THE NETWORK IN SETTINGS." end
  return "wait"
end

local dial_label
local function gate_tick()
  local g = gate()
  if g == "ok" then return start_game() end
  if g ~= "wait" then return G.fatal(g) end
  if sys.millis() - boot_at > GRACE_BOOT then return G.fatal("NO CONNECTION TO THE BADGE SERVER. TRY AGAIN LATER.") end
  if not dial_label then dial_label = T.text(10, 100, "> DIALING IN", T.GREEN) end
  dial_label:text("> DIALING IN" .. string.rep(".", sys.millis() // 400 % 4))
end

-- Mid-game dropout: 30 s countdown, then fatal.
local function lost_tick()
  if LOCAL or badge.online() then
    if lost_at then
      lost_at = nil
      if lost_bg then lost_bg:remove(); lost_label:remove(); lost_bg, lost_label = nil, nil end
    end
    return
  end
  lost_at = lost_at or sys.millis()
  local left = (GRACE_LOST - (sys.millis() - lost_at)) // 1000
  if left < 0 then return G.fatal("SIGNAL LOST. RECONNECT TO WI-FI AND OPEN THE APP AGAIN.") end
  if not lost_label then
    lost_bg = ui.rect(0, 0, ui.W, 18, { color = T.BLACK })
    lost_label = T.text(0, 4, "", T.RED, 12, ui.W, "center")
  end
  lost_label:text("SIGNAL LOST. RETRY " .. left .. "s")
end

-- Rounds: overlay, mesh progress ---------------------------------------------
local last_rc = 0
local function round_tick()
  local at = G.round()
  if not at or not G.chain then return end
  if G.round_shown ~= at and (screen_name == "chain" or screen_name == "board") and not G.modal then
    G.round_shown = at   -- once per round: CANCEL on the overlay really closes it
    G.go("round", { back = screen_name, at = at })
  end
  if sys.millis() - last_rc >= 1000 then
    last_rc = sys.millis()
    radio.send("*", { t = "rc", c = G.chain, r = at, k = G.rc.id == at and G.rc.k or 0 })
  end
end

-- LEDs (§4.5) ------------------------------------------------------------
local last_led = 0
local function dim(c, div) return (c >> 16 & 0xFF) // div, (c >> 8 & 0xFF) // div, (c & 0xFF) // div end

local function led_tick()
  local ms = sys.millis()
  if ms - last_led < 60 then return end
  last_led = ms
  if G.phase == "fatal" then
    if ms // 400 % 2 == 0 then led.fill(255, 0, 0) else led.off() end
    return
  end
  if ms < G.chase_until then
    led.off()
    led.set(ms // 70 % 8 + 1, 0, 255, 0)
    return
  end
  if G.round() then
    local t = ms % 1000
    local v = t < 500 and t or 1000 - t
    led.fill(0, 30 + v * 225 // 500, 0)
  else
    local blocks = G.state and G.state.blocks or {}
    for i = 1, 8 do
      local b = blocks[i]
      if not b then led.set(i, 0, 0, 0)
      elseif b.linked then led.set(i, dim(T.STARS[b.star] or T.WHITE, 1))
      else led.set(i, dim(T.STARS[b.star] or T.WHITE, 12)) end
    end
  end
  if ms < G.flash_until then led.set(G.flash_i, 255, 255, 255) end
end

-- Callbacks ----------------------------------------------------------------
ui.bg(T.BLACK)

function on_tick(ms)
  if G.phase == "gate" then gate_tick()
  elseif G.phase == "game" then
    lost_tick()
    if G.phase ~= "game" then return led_tick() end
    radio.tick(G)
    local every = (G.cfg.epoch or 10) * 1000
    if G.chain and not reporting and sys.millis() - last_report >= every then report() end
    if reporting and sys.millis() - last_report > 15000 then reporting = false end  -- lost callback guard
    round_tick()
  end
  if screen and screen.tick then screen.tick(ms) end
  led_tick()
end

function on_key(k, rep)
  if screen and screen.key then
    local r = screen.key(k, rep)
    if r ~= nil then return r end
  end
  return k ~= "back"
end

function on_mesh(from, msg)
  if G.phase == "game" then radio.on_mesh(from, msg, G) end
end

function on_exit()
  storage.set("star", G.star)
end
