-- Screen 9: demo panel (§9). LEFT/RIGHT changes a value, SELECT runs an action.
local SIMS = { -45, -55, -65, -75, -90 }

return function(G)
  local T = G.T
  T.title("> DEMO PANEL" .. (G.local_demo and " (LOCAL)" or ""))
  local list

  local function items()
    return {
      { title = "SIM SIGNAL", right = "[" .. G.sim .. "]" },
      { title = "ADD BOT" },
      { title = "REMOVE BOT" },
      { title = "BOT LINKS", right = G.bot_links and "[ON]" or "[OFF]" },
      { title = "FORCE ROUND" },
      { title = "RESET SCORE" },
    }
  end

  local function redraw()
    local i = list:selected()
    list:items(items())
    list:select(i)
  end

  local function done(msg)
    return function(ok, data)
      if not ok then return ui.toast("FAILED: " .. tostring(data)) end
      if type(data.blocks) == "table" then G.apply(data) end
      if type(data.round) == "table" and G.state then G.state.round = data.round end
      ui.toast(msg)
    end
  end

  local function cycle_sim(d)
    local idx = 2
    for i, v in ipairs(SIMS) do if v == G.sim then idx = i end end
    G.sim = SIMS[(idx - 1 + d) % #SIMS + 1]
    redraw()
  end

  local function toggle_links()
    G.bot_links = not G.bot_links
    redraw()
    G.net.demo("bots", { op = "toggle_link", on = G.bot_links }, done(G.bot_links and "BOTS LINKED" or "BOTS UNLINKED"))
  end

  list = ui.list(0, 20, ui.W, ui.H - 36, items(), { on_select = function(i)
    if i == 1 then cycle_sim(1)
    elseif i == 2 then G.net.demo("bots", { op = "add" }, done("BOT ADDED"))
    elseif i == 3 then G.net.demo("bots", { op = "remove" }, done("BOT REMOVED"))
    elseif i == 4 then toggle_links()
    elseif i == 5 then G.net.demo("round", nil, done("ROUND IN 3s"))
    elseif i == 6 then
      G.modal = true
      ui.confirm("RESET DEMO SCORE?", function(yes)
        G.modal = false
        if yes then G.net.demo("reset", nil, done("SCORE RESET")) end
      end)
    end
  end })
  ui.hint("LEFT/RIGHT CHANGE   CANCEL BACK")

  return {
    key = function(k)
      if k == "back" then G.go("menu") return true end
      local i = list:selected()
      if k == "left" or k == "right" then
        if i == 1 then cycle_sim(k == "left" and -1 or 1)
        elseif i == 4 then toggle_links() end
      end
      return true
    end,
  }
end
