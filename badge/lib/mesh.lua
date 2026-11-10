-- Radio: heartbeats, join messages, round progress, the nearby-chains table (§4.3).
local R = { rc = {} }          -- rc[id] = {r = round id, k = clicks}
local seen = {}                -- seen[id] = {c, n, d, at}
local last_hb = -10000
local HB_MS, SEEN_MS = 2000, 10000

function R.nearby() return mesh.nearby() end
function R.send(to, msg) mesh.send(to, msg) end

function R.tick(G)
  local now = sys.millis()
  if now - last_hb >= HB_MS then
    last_hb = now
    local me = G.my_block and G.my_block() or nil
    local n = G.state and #G.state.blocks or (G.chain and 1 or 0)
    mesh.send("*", { t = "hb", c = G.chain or "", h = me and me.h or 0, n = n,
      s = me and me.star or G.star, d = G.demo and 1 or nil })
  end
end

-- Messages are untrusted: check every field's type.
function R.on_mesh(from, msg, G)
  if type(from) ~= "string" or type(msg) ~= "table" then return end
  if msg.t == "hb" and type(msg.c) == "string" then
    seen[from] = { c = msg.c:sub(1, 16), n = math.tointeger(msg.n) or 1, d = msg.d == 1, at = sys.millis() }
  elseif msg.t == "join" and type(msg.c) == "string" then
    G.on_join_request(from, msg.c)
  elseif msg.t == "rc" and math.tointeger(msg.r) and math.tointeger(msg.k) then
    R.rc[from] = { r = msg.r, k = msg.k }
  end
end

-- Chains heard in the last 10 s, strongest member first: {name, n, rssi, id, handle}.
function R.chains(demo)
  local radio = {}
  for _, p in ipairs(mesh.nearby()) do radio[p.id] = p end
  local by, out, now = {}, {}, sys.millis()
  for id, s in pairs(seen) do
    local p = radio[id]
    if now - s.at > SEEN_MS then
      seen[id] = nil
    elseif p and s.c ~= "" and s.d == (demo and true or false) then
      local rssi = p.rssi or -127
      local c = by[s.c]
      if not c then
        c = { name = s.c, n = s.n, rssi = rssi, id = id, handle = p.name }
        by[s.c] = c
        out[#out + 1] = c
      elseif rssi > c.rssi then
        c.rssi, c.id, c.handle = rssi, id, p.name
      end
      if s.n > c.n then c.n = s.n end
    end
  end
  table.sort(out, function(a, b) return a.rssi > b.rssi end)
  return out
end

return R
