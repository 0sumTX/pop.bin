-- Screen 5: the constellation and the HUD. SELECT mines, DOWN board, LEFT menu.
-- Slots follow join order (sorted block height), since heights aren't reused after a leave.
local SLOTS = { { 30, 100 }, { 72, 48 }, { 116, 118 }, { 160, 62 }, { 204, 128 }, { 248, 50 }, { 290, 104 }, { 160, 146 } }
local DOTS_PER_EDGE = 4

return function(G)
  local T = G.T
  local me = badge.id()
  local title = T.title("")
  local dots, stars = {}, {}
  for i = 1, 7 * DOTS_PER_EDGE do
    dots[i] = ui.rect(0, 0, 2, 2, { color = T.DIM })
    dots[i]:show(false)
  end
  for i = 1, 8 do
    stars[i] = ui.rect(0, 0, 10, 10, { color = T.GRAY, radius = 5 })
    stars[i]:show(false)
  end
  local my_label = T.text(0, 0, "", T.WHITE)
  local hud1 = T.text(6, 166, "", T.GREEN)
  local hud2 = T.text(6, 179, "", T.GREEN)
  local status = T.text(6, 192, "", T.GREEN)
  ui.hint("SELECT MINE   DOWN BOARD   LEFT MENU")

  local function update()
    local s = G.state
    if not s then
      title:text("> " .. (G.chain or "?"))
      status:text("> SYNCING...")
      return
    end
    local slot_of, n_canon = {}, 0
    for i = 1, 8 do
      local b = s.blocks[i]
      local st = stars[i]
      if b then
        slot_of[b.h] = i
        local mine = b.id == me
        local size = mine and 16 or 10
        st:size(size, size)
        st:pos(SLOTS[i][1] - size // 2, SLOTS[i][2] - size // 2)
        st:color(b.canon and (T.STARS[b.star] or T.WHITE) or T.GRAY)
        st:show(true)
        if b.canon then n_canon = n_canon + 1 end
        if mine then
          my_label:text(b.handle ~= "" and b.handle or "YOU")
          local x = SLOTS[i][1] + 12
          if x > ui.W - 90 then x = SLOTS[i][1] - 90 end
          my_label:pos(x, SLOTS[i][2] - 6)
        end
      else
        st:show(false)
      end
    end
    local d = 0
    for _, e in ipairs(s.edges or {}) do
      local a, b = slot_of[e[1]], slot_of[e[2]]
      if a and b and d + DOTS_PER_EDGE <= #dots then
        local ax, ay, bx, by = SLOTS[a][1], SLOTS[a][2], SLOTS[b][1], SLOTS[b][2]
        for k = 1, DOTS_PER_EDGE do
          d = d + 1
          dots[d]:pos(ax + (bx - ax) * k // (DOTS_PER_EDGE + 1) - 1, ay + (by - ay) * k // (DOTS_PER_EDGE + 1) - 1)
          dots[d]:show(true)
        end
      end
    end
    for i = d + 1, #dots do dots[i]:show(false) end

    title:text("> " .. s.chain .. "  " .. #s.blocks .. "/" .. G.cfg.max_blocks)
    hud1:text("HASHRATE " .. s.hashrate .. (s.mult > 1 and ("  x" .. s.mult) or ""))
    hud2:text("HASHES " .. s.hashes .. "   RANK #" .. (s.rank > 0 and s.rank or "-"))
    status:color(s.orphaned and T.RED or T.GREEN)
    if s.orphaned then status:text("> ORPHANED. FIND YOUR CHAIN.")
    elseif #s.blocks < 2 then status:text("> ALONE. BRING BLOCKS NEARBY TO JOIN.")
    elseif n_canon == 0 then status:text("> NO LINKS. HUDDLE UP.")
    else status:text("> " .. n_canon .. " BLOCKS LINKED. MINE!") end
  end

  update()
  return {
    update = update,
    key = function(k)
      if k == "select" then G.click() return true end
      if k == "down" or k == "up" then G.go("board") return true end
      if k == "left" then G.go("menu") return true end
      return nil
    end,
  }
end
