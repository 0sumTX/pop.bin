-- Screen 1: chains heard nearby, strongest first; last row creates a new chain.
return function(G)
  local T = G.T
  T.title("> CHAINS NEARBY")
  local rows, sig = {}, ""
  local list, empty

  local function items()
    local out = {}
    for _, c in ipairs(rows) do
      out[#out + 1] = { title = c.name, sub = c.n .. "/" .. G.cfg.max_blocks .. " BLOCKS", right = T.bars(c.rssi) }
    end
    out[#out + 1] = { title = "+ CREATE NEW CHAIN", sub = "BECOME THE GENESIS BLOCK" }
    return out
  end

  local function refresh()
    rows = G.radio.chains(G.demo)
    local s = ""
    for _, c in ipairs(rows) do s = s .. c.name .. c.n .. T.bars(c.rssi) end
    if s == sig then return end   -- unchanged: keep the selection still
    sig = s
    local keep = list:selected()
    list:items(items())
    list:select(math.min(keep or 1, #rows + 1))
    empty:text(#rows == 0 and "> NO CHAINS IN RANGE" or "")
  end

  list = ui.list(0, 20, ui.W, ui.H - 36, items(), { on_select = function(i)
    if rows[i] then G.go("joining", rows[i]) else G.go("create") end
  end })
  empty = T.text(10, 72, "", T.DIM)
  ui.hint("SELECT PICK   CANCEL EXIT")
  refresh()

  local acc = 0
  return {
    tick = function(ms)
      acc = acc + ms
      if acc >= 1000 then acc = 0; refresh() end
    end,
  }
end
