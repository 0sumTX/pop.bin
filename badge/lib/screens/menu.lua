-- Screen 8: star color (LEFT/RIGHT), leave chain, about, DEMO (demo badges only).
return function(G)
  local T = G.T
  T.title("> MENU")
  local about_open = false
  local list

  local function items()
    local out = {
      { title = "STAR COLOR", right = "< " .. T.STAR_NAMES[G.star] .. " >" },
      { title = "LEAVE CHAIN", sub = G.chain },
      { title = "ABOUT" },
    }
    if G.demo then out[#out + 1] = { title = "DEMO", sub = "TEST TOOLS (DEMO WORLD ONLY)" } end
    return out
  end

  local function set_star(d)
    G.star = (G.star + d) % 6
    list:items(items())
    list:select(1)
    G.net.star(G.star, function(ok, data) if not ok then ui.toast("NOT SAVED: " .. tostring(data)) end end)
    local mb = G.my_block()
    if mb then mb.star = G.star end
  end

  list = ui.list(0, 20, ui.W, ui.H - 36, items(), { on_select = function(i)
    if i == 1 then
      set_star(1)
    elseif i == 2 then
      G.modal = true
      ui.confirm("LEAVE " .. (G.chain or "CHAIN") .. "?", function(yes)
        G.modal = false
        if not yes then return end
        G.net.leave(function(ok, data)
          if ok then G.left("YOU LEFT THE CHAIN") else ui.toast("LEAVE FAILED: " .. tostring(data)) end
        end)
      end)
    elseif i == 3 then
      ui.clear()
      ui.bg(T.BLACK)
      T.dialog({ "CONSTELLATION v0.1", "STAND TOGETHER.", "MINE HASHES.", "PRESS SELECT IN ROUNDS." }, "i")
      about_open = true
    elseif i == 4 then
      G.go("demo")
    end
  end })
  ui.hint("LEFT/RIGHT COLOR   CANCEL BACK")

  return {
    key = function(k)
      if about_open then
        if k == "select" or k == "back" then G.go("menu") end
        return true
      end
      if k == "back" then G.go("chain") return true end
      if (k == "left" or k == "right") and list:selected() == 1 then set_star(k == "left" and -1 or 1) end
      return true
    end,
  }
end
