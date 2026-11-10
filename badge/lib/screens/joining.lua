-- Screen 3: ask a nearby member to let us in. Mesh request every 3 s, poll /v1/me every 3 s, give up at 60 s.
-- target = {name, n, rssi, id, handle} from the chains-nearby list.
return function(G, target)
  local T = G.T
  T.title("> JOIN " .. target.name)
  local line = T.text(10, 70, "", T.GREEN)
  T.text(10, 90, "> VIA " .. (target.handle or target.id), T.WHITE)
  local status = T.text(10, 120, "WAITING FOR A MEMBER TO ACCEPT", T.DIM)
  ui.hint("CANCEL BACK")

  local start = sys.millis()
  local last_mesh, last_poll, last_req = -3000, 0, -30000
  local done = false

  local function fail(msg)
    if done then return end
    done = true
    G.go("chains")
    ui.toast(msg)
  end

  if G.demo then   -- §9: demo chains join instantly, no accept needed
    status:text("DEMO: JOINING DIRECTLY")
    G.net.demo("join", { chain = target.name, handle = badge.owner() }, function(ok, data)
      if done then return end
      if ok then done = true; return G.enter(data) end
      fail("JOIN FAILED: " .. tostring(data))
    end)
  end

  return {
    tick = function()
      if done then return end
      local now = sys.millis()
      line:text("> BROADCASTING JOIN REQUEST" .. string.rep(".", now // 400 % 4))
      if now - start > 60000 then return fail("NO ANSWER. TRY ANOTHER BLOCK.") end
      if G.demo then return end
      if now - last_mesh >= 3000 then
        last_mesh = now
        G.radio.send(target.id, { t = "join", c = target.name })
      end
      if now - last_req >= 30000 then   -- server-side request lives 60 s
        last_req = now
        G.net.join_request(target.name, target.id, badge.owner(), function(ok, data, status_code)
          if not ok and status_code ~= 0 then fail("CAN'T JOIN: " .. string.upper(tostring(data))) end
        end)
      end
      if now - last_poll >= 3000 then
        last_poll = now
        G.net.me(function(ok, me)
          if ok and me.chain and not done then done = true; G.enter(me) end
        end)
      end
    end,
    key = function(k)
      if k == "back" then done = true; G.go("chains") end
      return true
    end,
  }
end
