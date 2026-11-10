-- Server calls. Every callback is cb(ok, data, status):
--   ok=true:  data = decoded JSON table
--   ok=false: data = server error string ("exists", "in chain", ...) or a display message for transport errors
local N = {}
local BASE = ""

local MSG = {
  offline = "NO SIGNAL", ["not linked"] = "BADGE NOT CLAIMED", ["too fast"] = "TOO MANY REQUESTS",
  timeout = "SERVER TIMEOUT", ["host not allowed"] = "HOST NOT ALLOWED", denied = "APP NOT ALLOWED",
  busy = "RADIO BUSY", unreachable = "SERVER UNREACHABLE", ["socket open"] = "SOCKET OPEN",
}

function N.init(base) BASE = base end

local function wrap(cb)
  return function(ok, res)
    if not ok then return cb(false, MSG[res] or string.upper(tostring(res)), 0) end
    local data = res.body and res.body ~= "" and json.decode(res.body) or nil
    if res.status == 200 then
      if type(data) ~= "table" then return cb(false, "BAD REPLY", 200) end
      return cb(true, data, 200)
    end
    return cb(false, type(data) == "table" and data.error or ("HTTP " .. tostring(res.status)), res.status)
  end
end

local function get(path, cb) http.get(BASE .. path, wrap(cb)) end
local function post(path, body, cb) http.post(BASE .. path, body, wrap(cb)) end

function N.me(cb) get("/v1/me", cb) end
function N.create(name, handle, cb) post("/v1/chains", { name = name, handle = handle }, cb) end
function N.join_request(chain, via, handle, cb) post("/v1/join/request", { chain = chain, via = via, handle = handle }, cb) end
function N.accept(joiner, cb) post("/v1/join/accept", { joiner = joiner }, cb) end
function N.leave(cb) post("/v1/leave", { x = 0 }, cb) end
function N.star(i, cb) post("/v1/star", { star = i }, cb) end
function N.report(body, cb) post("/v1/report", body, cb) end
function N.board(cb) get("/v1/board", cb) end
-- op: "join" | "bots" | "round" | "reset"
function N.demo(op, body, cb) post("/v1/demo/" .. op, body or { x = 0 }, cb) end

function N.now() return sys.time() end
function N.online() return badge.online() end

return N
