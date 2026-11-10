-- Screen 6: top 10 chains, yours in white. Refreshes every 30 s.
return function(G)
  local T = G.T
  T.title(G.demo and "> DEMO LEADERBOARD" or "> LEADERBOARD")
  local rows = {}
  for i = 1, 10 do rows[i] = T.text(6, 10 + i * 16, i == 1 and "> LOADING..." or "", T.GREEN) end
  ui.hint("UP CHAIN   CANCEL BACK")
  local alive = true

  local function load()
    G.net.board(function(ok, data)
      if not alive then return end
      if not ok then rows[1]:text("> " .. tostring(data)) return end
      for i = 1, 10 do
        local r = data.rows and data.rows[i]
        if r then
          rows[i]:text(string.format("%s#%-2d %-16s %8s", r.mine and ">" or " ", r.rank, r.name, r.hashes))
          rows[i]:color(r.mine and T.WHITE or T.GREEN)
        else
          rows[i]:text(i == 1 and "> NO CHAINS YET" or "")
        end
      end
    end)
  end
  load()

  local acc = 0
  return {
    tick = function(ms)
      acc = acc + ms
      if acc >= 30000 then acc = 0; load() end
    end,
    key = function(k)
      if k == "up" or k == "down" or k == "back" then G.go("chain") end
      return true
    end,
    exit = function() alive = false end,
  }
end
