-- Screen 7: consensus round overlay. args = {back = screen name, at = round open time}.
return function(G, args)
  local T = G.T
  local at = args.at
  local need = G.cfg.round_clicks or 10
  local big = T.text(0, 24, "CONSENSUS ROUND", T.GREEN, 20, ui.W, "center")
  local secs = T.text(0, 54, "", T.WHITE, 32, ui.W, "center")
  local bar = ui.bar(40, 108, 240, 14, 0)
  local mine = T.text(40, 130, "", T.GREEN)
  local ready = T.text(40, 148, "", T.GREEN)
  ui.hint("SELECT MINE   CANCEL HIDE")
  local phase, since = "open", 0

  local function count_ready()
    local s = G.state
    local me = badge.id()
    local n, total = 0, 0
    for _, b in ipairs(s and s.blocks or {}) do
      local rc = G.radio.rc[b.id]
      local is_bot = b.id:sub(1, 4) == "bot-"
      if b.canon and (not is_bot or rc) then   -- server bots don't broadcast: leave them out
        total = total + 1
        local k = b.id == me and (G.rc.id == at and G.rc.k or 0) or (rc and rc.r == at and rc.k or 0)
        if k >= need then n = n + 1 end
      end
    end
    return n, total
  end

  local function result(text, color)
    big:text(text)
    big:color(color)
    phase, since = "done", sys.millis()
  end

  return {
    tick = function()
      local now = G.now() or 0
      if phase == "open" then
        local left = at + (G.state and G.state.round.len or 10) - now
        if left <= 0 then
          phase, since = "verify", sys.millis()
          big:text("VERIFYING...")
          secs:text("")
          return
        end
        local k = G.rc.id == at and G.rc.k or 0
        secs:text(tostring(left))
        bar:set(math.min(100, k * 100 // need))
        mine:text("YOUR VOTES " .. k .. "/" .. need)
        local n, total = count_ready()
        ready:text(n .. "/" .. total .. " BLOCKS READY")
      elseif phase == "verify" then
        local last = G.state and G.state.last
        if last and last.at == at then
          if last.ok then
            result("CONSENSUS REACHED x" .. (G.cfg.consensus_mult or 3), T.GREEN)
            G.chase_until = sys.millis() + 2000
          else
            result("CONSENSUS FAILED", T.RED)
          end
        elseif sys.millis() - since > 25000 then
          result("NO RESULT", T.DIM)
        end
      elseif sys.millis() - since > 3000 then
        G.go(args.back)
      end
    end,
    key = function(k)
      if k == "select" then
        if phase == "open" then G.click() end
      elseif k == "back" then
        G.go(args.back)
      end
      return true
    end,
  }
end
