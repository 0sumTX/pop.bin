-- Local demo (§9): the same interface as lib/net.lua + lib/mesh.lua, the whole world simulated.
-- 3 fake chains nearby, joins accepted after 2 s, bots whose signal drifts, real formulas, rounds every 30 s.
local C = { EPOCH = 10, RSSI_LINK = -65, BASE = 100, CLICK_HS = 2, CAP = 50, EVERY = 30, WIN = 10,
  NEED = 10, MULT = 3, BOT_P = 0.8, BOT_CLICKS = 30, MAX = 8, BOT_MAX = 7 }
local FAKE = {
  { name = "SATOSHIS", n = 3, rssi = -52, id = "m1", handle = "@sato", hashes = 182000 },
  { name = "GOSSIP NODES", n = 5, rssi = -61, id = "m2", handle = "@gossip", hashes = 96000 },
  { name = "VALIDATORZ", n = 2, rssi = -78, id = "m3", handle = "@vz", hashes = 41000 },
}

local W = { chain = nil, blocks = {}, hashes = 0, cu = 0, last = { at = 0, ok = false }, checked = 0,
  override = 0, next_h = 0, ready = {}, ready_at = 0, sim = -55 }
local N, R = {}, { rc = {} }
local START = sys.time() or 1790000000

local function now() return sys.time() or (START + sys.millis() // 1000) end
local function me_id() return badge.id() or "e0local" end
local function later(ms, fn) timer.after(ms, fn) end

local function scale(n, units, d)
  local i = 1
  while n >= 1000 and i < #units do n = n / 1000; i = i + 1 end
  if i == 1 then return string.format("%d", math.floor(n + 0.5)) .. units[1] end
  return string.format("%." .. d .. "f", n) .. units[i]
end
local function fmt_hashes(n) return scale(n, { "", "K", "M", "B" }, 1) end
local function fmt_rate(n) return scale(n, { " H/s", " kH/s", " MH/s" }, 2) end

local function bots()
  local out = {}
  for _, b in ipairs(W.blocks) do if b.bot then out[#out + 1] = b end end
  return out
end

local function add_block(id, handle, star, bot)
  W.blocks[#W.blocks + 1] = { id = id, h = W.next_h, handle = handle, star = star, bot = bot,
    rssi = -50 - math.random(0, 25), linked = true }
  W.next_h = W.next_h + 1
end

local function add_bot()
  local list = bots()
  if #list >= C.BOT_MAX or #W.blocks >= C.MAX then return false end
  local used, n = {}, 1
  for _, b in ipairs(list) do used[b.handle] = true end
  while used["@bot" .. n] do n = n + 1 end
  add_block("bot-" .. n, "@bot" .. n, n % 6, true)
  return true
end

local function make_chain(name, genesis)
  W.chain, W.blocks, W.next_h, W.hashes, W.cu, W.checked = name:upper(), {}, 0, 0, 0, now()
  W.last = { at = 0, ok = false }
  if genesis then add_block(me_id(), badge.owner() or "@you", 1, false) end
  for _ = 1, 3 do add_bot() end
  if not genesis then add_block(me_id(), badge.owner() or "@you", 1, false) end
end

local function round_at(t)
  local cur = t // C.EVERY * C.EVERY
  local reg = (t < cur + C.WIN) and cur or cur + C.EVERY
  if W.override > 0 and t < W.override + C.WIN and W.override < reg then return W.override end
  return reg
end

local function last_ended(t)
  local reg = (t - C.WIN) // C.EVERY * C.EVERY
  if W.override > 0 and W.override + C.WIN <= t and W.override > reg then return W.override end
  return reg
end

-- Bots decide once per round whether they'll be ready.
local function bot_ready(id, at)
  if W.ready_at ~= at then W.ready, W.ready_at = {}, at end
  if W.ready[id] == nil then W.ready[id] = math.random() < C.BOT_P end
  return W.ready[id]
end

local function me_block()
  for _, b in ipairs(W.blocks) do if b.id == me_id() then return b end end
end

-- The same shape as the server's /v1/report response.
local last_state
local function compute(body)
  local t, me = now(), me_block()
  local heard = {}
  for _, e in ipairs(body and body.nearby or {}) do heard[e.id] = e.rssi end
  local canon, edges, n = {}, {}, 0
  for _, b in ipairs(W.blocks) do
    if b.bot and b.linked and (heard[b.id] or -127) >= C.RSSI_LINK then
      canon[b.id] = true
      edges[#edges + 1] = { me.h, b.h }
      n = n + 1
    end
  end
  if n > 0 then canon[me.id] = true; n = n + 1 else edges = {} end

  local ended = last_ended(t)
  if ended > W.checked then
    W.checked = ended
    local r = body and body.round
    local ok = n >= 2 and r ~= nil and r.id == ended and r.clicks >= C.NEED
    for id in pairs(canon) do
      if ok and id ~= me.id and not bot_ready(id, ended) then ok = false end
    end
    W.last = { at = ended, ok = ok }
    if ok then W.cu = (ended + C.WIN + C.EVERY - 1) // C.EVERY * C.EVERY end
  end

  local mult = t < W.cu and C.MULT or 1
  local hr = 0
  if n >= 2 then
    local clicks = math.min(body and body.clicks or 0, C.CAP)
    for id in pairs(canon) do
      if id ~= me.id then clicks = clicks + math.random(0, C.BOT_CLICKS) end
    end
    hr = (C.BASE * (n - 1) + C.CLICK_HS * clicks) * mult
  end
  if body then W.hashes = W.hashes + hr * C.EPOCH end

  local rank = 1
  for _, f in ipairs(FAKE) do if f.hashes > W.hashes then rank = rank + 1 end end
  local blocks = {}
  for _, b in ipairs(W.blocks) do
    blocks[#blocks + 1] = { id = b.id, h = b.h, handle = b.handle, star = b.star, linked = canon[b.id] == true, canon = canon[b.id] == true }
  end
  last_state = { chain = W.chain, blocks = blocks, edges = edges, hashrate = fmt_rate(hr), mult = mult,
    hashes = fmt_hashes(W.hashes), rank = rank, orphaned = #W.blocks > 1 and n == 0,
    round = { at = round_at(t), len = C.WIN }, last = W.last }
  return last_state
end

local function me_data()
  local b = W.chain and me_block()
  return { block = b and { h = b.h, star = b.star } or nil, chain = W.chain,
    state = W.chain and (last_state or compute(nil)) or nil, demo = true,
    config = { epoch = C.EPOCH, max_blocks = C.MAX, round_clicks = C.NEED, consensus_mult = C.MULT, round_window = C.WIN, round_every = C.EVERY } }
end

-- net interface ----------------------------------------------------------
local function reply(cb, ok, data, status) later(150, function() cb(ok, data, status or (ok and 200 or 409)) end) end

function N.me(cb) reply(cb, true, me_data()) end
function N.create(name, handle, cb)
  if W.chain then return reply(cb, false, "in chain") end
  for _, f in ipairs(FAKE) do if f.name == name:upper() then return reply(cb, false, "exists") end end
  make_chain(name, true)
  last_state = nil
  reply(cb, true, me_data())
end
function N.join_request(chain, via, handle, cb)
  later(2000, function() if not W.chain then make_chain(chain, false); last_state = nil end end)
  reply(cb, true, { ok = true, joined = false })
end
function N.accept(joiner, cb) reply(cb, true, { ok = true, joined = false }) end
function N.leave(cb) W.chain, W.blocks, last_state = nil, {}, nil; reply(cb, true, { ok = true }) end
function N.star(i, cb)
  local b = me_block()
  if b then b.star = i end
  reply(cb, true, { ok = true })
end
function N.report(body, cb)
  if not W.chain then return reply(cb, false, "not in a chain") end
  reply(cb, true, compute(body))
end
function N.board(cb)
  local rows = {}
  for _, f in ipairs(FAKE) do rows[#rows + 1] = { name = f.name, h = f.hashes, mine = false } end
  if W.chain then rows[#rows + 1] = { name = W.chain, h = W.hashes, mine = true } end
  table.sort(rows, function(a, b) return a.h > b.h end)
  for i, r in ipairs(rows) do r.rank, r.hashes, r.h = i, fmt_hashes(r.h), nil end
  reply(cb, true, { demo = true, rows = rows })
end
function N.demo(op, body, cb)
  body = body or {}
  if op == "join" then
    return N.join_request(body.chain or "TESTNET", nil, nil, function()
      later(2100, function() reply(cb, W.chain ~= nil, W.chain and me_data() or "join failed") end)
    end)
  end
  if not W.chain then return reply(cb, false, "not in a demo chain") end
  if op == "bots" then
    if body.op == "add" then
      if not add_bot() then return reply(cb, false, "full") end
    elseif body.op == "remove" then
      local list = bots()
      if #list == 0 then return reply(cb, false, "no such bot") end
      for i, b in ipairs(W.blocks) do if b == list[#list] then table.remove(W.blocks, i) break end end
    elseif body.op == "toggle_link" then
      for _, b in ipairs(bots()) do if body.on == nil then b.linked = not b.linked else b.linked = body.on end end
    end
    return reply(cb, true, compute(nil))
  elseif op == "round" then
    W.override = now() + 3
    return reply(cb, true, { ok = true, round = { at = round_at(now()), len = C.WIN } })
  elseif op == "reset" then
    W.hashes = 0
    return reply(cb, true, { ok = true })
  end
  reply(cb, false, "unknown op")
end
function N.now() return now() end
function N.online() return true end

-- radio interface --------------------------------------------------------
local last_drift = 0
function R.tick(G)
  local ms = sys.millis()
  if ms - last_drift < 1000 then return end
  last_drift = ms
  local t = now()
  local at = round_at(t)
  local open = t >= at and t < at + C.WIN
  for _, b in ipairs(bots()) do
    b.rssi = math.max(-85, math.min(-45, b.rssi + math.random(-3, 3)))
    if open then
      local secs = t - at + 1
      R.rc[b.id] = { r = at, k = bot_ready(b.id, at) and math.min(15, secs * 2) or math.min(6, secs) }
    end
  end
end
function R.nearby()
  local out = {}
  for _, b in ipairs(bots()) do
    out[#out + 1] = { id = b.id, name = b.handle, level = 1, rssi = b.rssi, kind = "badge", bridged = false }
  end
  return out
end
function R.send(to, msg) end
function R.on_mesh(from, msg, G) end
function R.chains(demo)
  local out = {}
  for _, f in ipairs(FAKE) do
    out[#out + 1] = { name = f.name, n = f.n, rssi = f.rssi + math.random(-2, 2), id = f.id, handle = f.handle }
  end
  return out
end

return { net = N, radio = R }
