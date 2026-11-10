-- Headless smoke test for the badge app: stubs the Solana OS Lua API (docs/LUA_API.md) closely enough
-- to drive every screen, and enforces the limits that bite (64 UI objects, 200-byte labels, 4 mesh/s,
-- 200k instructions per callback). Run from the repo root:  lua tools/badge_sim.lua
-- Not shipped: everything in badge/ goes to the store, so this lives outside it.
local BADGE = "badge/"
package.path = BADGE .. "?.lua;" .. package.path

local function new_world(opts)
  local W = { ms = 0, objs = 0, labels = {}, lists = {}, timers = {}, toasts = {}, sends = {}, exited = false,
    input = nil, confirm = nil, store = {}, online = opts.online, wifi = opts.wifi or "on", near = {}, http_log = {} }
  local function obj(kind, extra)
    W.objs = W.objs + 1
    assert(W.objs <= 64, "more than 64 UI objects")
    local o = extra or {}
    o.kind, o.shown = kind, true
    function o:pos() end
    function o:size() end
    function o:color(c) self.c = c end
    function o:show(b) self.shown = b end
    function o:remove() W.objs = W.objs - 1; self.removed = true end
    return o
  end
  local function label_obj(text)
    local l = obj("label", { t = text })
    function l:text(s) assert(#s <= 200, "label over 200 bytes"); self.t = s end
    l:text(text)
    W.labels[#W.labels + 1] = l
    return l
  end
  _G.ui = {
    W = 320, H = 218,
    bg = function() end,
    label = function(_, _, text) return label_obj(text) end,
    rect = function() return obj("rect") end,
    bar = function() local b = obj("bar"); function b:set(v) assert(v >= 0 and v <= 100) end return b end,
    list = function(_, _, _, _, items, o)
      local l = obj("list", { rows = items, sel = 1, on_select = o and o.on_select })
      function l:items(i) self.rows = i end
      function l:selected() return self.sel end
      function l:select(i) self.sel = i end
      W.lists[#W.lists + 1] = l
      return l
    end,
    hint = function() end,
    toast = function(s) W.toasts[#W.toasts + 1] = s end,
    confirm = function(msg, cb) W.confirm = { msg = msg, cb = cb } end,
    input = function(p, n, cb) W.input = cb end,
    clear = function() W.objs, W.labels, W.lists = 0, {}, {} end,
  }
  _G.led = {
    count = 8,
    set = function(i, r, g, b)
      assert(math.type(i) == "integer" and i >= 1 and i <= 8, "led index")
      for _, v in ipairs({ r, g, b }) do assert(math.type(v) == "integer" and v >= 0 and v <= 255, "led value " .. tostring(v)) end
    end,
    fill = function(r, g, b) _G.led.set(1, r, g, b) end,
    off = function() end,
  }
  _G.timer = {
    after = function(ms, fn) W.timers[#W.timers + 1] = { at = W.ms + ms, fn = fn } return #W.timers end,
    every = function(ms, fn) W.timers[#W.timers + 1] = { at = W.ms + ms, fn = fn, every = ms } return #W.timers end,
    cancel = function(id) if W.timers[id] then W.timers[id].dead = true end end,
  }
  _G.sys = {
    millis = function() return W.ms end,
    time = function() return 1790000022 + W.ms // 1000 end,   -- first 30 s mock round opens at +18 s
    battery = function() return 80 end,
    exit = function() W.exited = true end,
  }
  _G.badge = { id = function() return opts.id end, owner = function() return opts.owner end, online = function() return W.online end }
  _G.wifi = { status = function() return W.wifi end, ssid = function() return "venue" end }
  _G.storage = { get = function(k) return W.store[k] end, set = function(k, v) W.store[k] = v end, remove = function(k) W.store[k] = nil end }
  _G.mesh = {
    nearby = function() return W.near end,
    send = function(to, msg)
      W.sends[#W.sends + 1] = W.ms
      local n = 0
      for _, t in ipairs(W.sends) do if W.ms - t < 1000 then n = n + 1 end end
      assert(n <= 4, "more than 4 mesh messages a second")
    end,
  }
  _G.http = {
    get = function(url, cb) W.http_log[#W.http_log + 1] = "GET " .. url; timer.after(100, function() cb(false, "offline") end) end,
    post = function(url, body, cb) W.http_log[#W.http_log + 1] = "POST " .. url; timer.after(100, function() cb(false, "offline") end) end,
  }
  _G.json = { decode = function() return nil end }
  _G.fs = { load = function(p) return loadfile(BADGE .. p) end }
  for _, m in ipairs({ "lib.theme", "lib.net", "lib.mesh", "lib.mock" }) do package.loaded[m] = nil end
  _G.on_tick, _G.on_key, _G.on_mesh, _G.on_exit = nil, nil, nil, nil

  -- Every callback gets the badge's instruction budget.
  local function guarded(fn, ...)
    debug.sethook(function() error("Script took too long") end, "", 200000)
    local ok, err = pcall(fn, ...)
    debug.sethook()
    if not ok then error(err, 0) end
  end
  local src = assert(io.open(BADGE .. "main.lua")):read("a")
  if opts.demo_local then src = src:gsub("local DEMO_LOCAL = false", "local DEMO_LOCAL = true", 1) end
  guarded(assert(load(src, "main.lua")))

  function W.tick(ms_total)
    local stop = W.ms + ms_total
    while W.ms < stop do
      W.ms = W.ms + 50
      for _, t in ipairs(W.timers) do
        if not t.dead and t.at <= W.ms then
          if t.every then t.at = t.at + t.every else t.dead = true end
          guarded(t.fn)
        end
      end
      if on_tick then guarded(on_tick, 50) end
    end
  end
  function W.key(k) local r; guarded(function() r = on_key(k, false) end) return r end
  function W.pick(i) local l = W.lists[#W.lists]; assert(l, "no list"); l.sel = i; guarded(l.on_select, i, l.rows[i]) end
  function W.answer_input(text) local cb = W.input; W.input = nil; guarded(cb, text) end
  function W.answer_confirm(yes) local c = W.confirm; W.confirm = nil; guarded(c.cb, yes) end
  function W.mesh_in(from, msg) guarded(on_mesh, from, msg) end
  function W.has(pattern)
    for _, l in ipairs(W.labels) do if not l.removed and l.t:find(pattern) then return true end end
    return false
  end
  return W
end

local function check(cond, msg) if not cond then error("FAIL: " .. msg, 2) end print("ok  " .. msg) end

-- 1. Local demo, emulator id: the full loop against lib/mock.lua.
local W = new_world({ demo_local = true, id = "e7K2Q9", owner = "@tester", online = false })
W.tick(1000)
check(#W.lists == 1 and #W.lists[1].rows == 4, "chains nearby lists 3 fake chains + create")
check(W.has("DEMO"), "DEMO tag shown in local demo")
W.pick(4)
check(W.input ~= nil, "create opens the name input")
W.answer_input("  zero   sum ")
W.tick(500)
check(W.has("ZERO SUM"), "created chain shows on the chain screen")
check(W.store.chain == "ZERO SUM", "chain saved to storage")
W.tick(12000)
check(W.has("HASHRATE"), "HUD shows hashrate after a report")
for _ = 1, 30 do W.key("select") end
-- Run until a round opens (every 30 s in mock), vote in it, and see its result.
local saw_round = false
for _ = 1, 40 do
  W.tick(1000)
  if W.has("CONSENSUS ROUND") then saw_round = true; break end
end
check(saw_round, "round overlay opens")
for _ = 1, 12 do W.key("select") end
local result
for _ = 1, 40 do
  W.tick(1000)
  if W.has("CONSENSUS REACHED") then result = "reached" elseif W.has("CONSENSUS FAILED") then result = "failed" end
  if result then break end
end
check(result ~= nil, "round ends with a result: " .. tostring(result))
W.tick(4000)
check(W.has("HASHRATE"), "back on the chain screen after the round")
W.key("down"); W.tick(500)
check(W.has("LEADERBOARD") and W.has("ZERO SUM"), "board lists our chain")
W.key("up"); W.key("left"); W.tick(100)
check(W.has("MENU"), "menu opens")
W.key("right")
check(W.lists[1].rows[1].right:find("AMBER"), "star color cycles")
W.pick(4); W.tick(100)
check(W.has("DEMO PANEL"), "demo panel opens from the menu")
W.pick(2); W.tick(300)
W.key("down"); W.lists[1].sel = 4; W.key("left"); W.tick(300)
W.pick(5); W.tick(300)
check(W.toasts[#W.toasts] == "ROUND IN 3s", "force round")
W.key("back"); W.tick(100)
W.pick(2)
check(W.confirm ~= nil, "leave asks to confirm")
W.answer_confirm(true); W.tick(500)
check(W.store.chain == nil and #W.lists == 1, "left the chain, back to chains nearby")
W.pick(1); W.tick(3000)
check(W.store.chain == "SATOSHIS", "demo join puts us in the chosen chain")
check(W.objs <= 64, "object budget held")

-- 2. Real path, Wi-Fi off: fatal dialog, SELECT exits.
W = new_world({ id = "7K2Q9M", owner = "@tester", online = false, wifi = "off" })
W.tick(200)
check(W.has("POP%.BIN") and W.has("WI%-FI IS OFF"), "Wi-Fi off -> Win95 fatal dialog")
W.key("select")
check(W.exited, "SELECT on the fatal dialog exits")

-- 3. Real path, connecting forever: dial-in then fatal after 8 s.
W = new_world({ id = "7K2Q9M", owner = "@tester", online = false, wifi = "connecting" })
W.tick(1000)
check(W.has("DIALING IN"), "connecting -> DIALING IN")
W.tick(8000)
check(W.has("POP%.BIN"), "no server after 8 s -> fatal")

-- 4. Real path, online but unclaimed.
W = new_world({ id = "7K2Q9M", owner = nil, online = true })
W.tick(100)
check(W.has("NOT CLAIMED"), "unclaimed badge -> fatal")

-- 5. Real path online, server unreachable: chains nearby from heartbeats, join attempt, dropout countdown.
W = new_world({ id = "7K2Q9M", owner = "@tester", online = true })
W.tick(500)
check(#W.lists == 1, "server down without a cached chain -> chains nearby")
W.near = { { id = "AAA111", name = "@toly", rssi = -48, kind = "badge", bridged = false } }
W.mesh_in("AAA111", { t = "hb", c = "ZERO SUM", h = 0, n = 3, s = 2 })
W.mesh_in("AAA111", { t = "hb", c = 5 })       -- junk is ignored
W.mesh_in("AAA111", "not a table")
W.tick(1100)
check(W.lists[1].rows[1].title == "ZERO SUM" and W.lists[1].rows[1].sub == "3/8 BLOCKS", "heartbeat shows a nearby chain")
W.pick(1); W.tick(4000)
check(W.has("BROADCASTING JOIN REQUEST"), "joining screen")
local joins = 0
for _, l in ipairs(W.http_log) do if l:find("join/request") then joins = joins + 1 end end
check(joins >= 1, "join request posted to the server")
W.tick(57000)
check(W.toasts[#W.toasts] == "NO ANSWER. TRY ANOTHER BLOCK.", "joining gives up after 60 s")
W.online = false
W.tick(2000)
check(W.has("SIGNAL LOST. RETRY"), "dropout countdown")
W.tick(29000)
check(W.has("POP%.BIN"), "dropout -> fatal after 30 s")
print("all badge checks passed")
