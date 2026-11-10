-- Screen 2: name a new chain. 409 "exists" -> dialog -> back to chains nearby.
return function(G)
  local T = G.T
  T.title("> CREATE CHAIN")
  local status = T.text(10, 100, "", T.GREEN)
  local dialog_open = false

  local function dialog(msg, icon)
    ui.clear()
    ui.bg(T.BLACK)
    T.dialog(T.wrap(msg, 26), icon)
    dialog_open = true
  end

  G.modal = true
  ui.input("CHAIN NAME", 16, function(text)
    G.modal = false
    if not text then return G.go("chains") end
    local name = (text:gsub("^%s+", ""):gsub("%s+$", ""):gsub("%s+", " "))
    if #name < 3 then
      ui.toast("3-16 CHARACTERS")
      return G.go("create")
    end
    status:text("> MINING GENESIS BLOCK...")
    G.net.create(name, badge.owner(), function(ok, data)
      if ok then return G.enter(data) end
      if data == "exists" then return dialog("CHAIN EXISTS. FIND A BLOCK TO JOIN.", "i") end
      if data == "in chain" then
        return G.net.me(function(ok2, me) if ok2 then G.enter(me) else G.go("chains") end end)
      end
      dialog("COULD NOT CREATE: " .. tostring(data), "x")
    end)
  end)

  return {
    key = function(k)
      if dialog_open and (k == "select" or k == "back") then G.go("chains") end
      return true
    end,
  }
end
