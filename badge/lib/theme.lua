-- Colors, text, the Win95 dialog, signal bars. Fixed colors everywhere (§6).
local T = {}

T.BLACK, T.GREEN, T.DIM, T.WHITE, T.RED, T.AMBER = 0x000000, 0x00FF41, 0x00802A, 0xFFFFFF, 0xFF2A2A, 0xFFB000
T.GRAY = 0x404040
T.STARS = { [0] = 0xFFFFFF, 0x00FFFF, 0xFFB000, 0xFF4FD8, 0x7DF9FF, 0xB388FF }
T.STAR_NAMES = { [0] = "WHITE", "CYAN", "AMBER", "PINK", "BLUE", "VIOLET" }

-- Mono 12 label by default.
function T.text(x, y, s, color, size, w, align)
  return ui.label(x, y, s, { size = size or 12, color = color or T.GREEN, w = w, align = align })
end

function T.title(s)
  return T.text(6, 4, s, T.GREEN)
end

function T.demo_tag()
  return T.text(ui.W - 40, 4, "DEMO", T.AMBER)
end

-- Bright top-left edge, shadow bottom-right, black face.
local function bevel(x, y, w, h)
  ui.rect(x, y, w, h, { color = T.GREEN })
  ui.rect(x + 2, y + 2, w - 2, h - 2, { color = T.DIM })
  ui.rect(x + 2, y + 2, w - 4, h - 4, { color = T.BLACK })
end

-- Windows 95 style dialog in the green palette. lines: up to 4 strings (~26 chars each).
-- icon: "x" (red error) or "i" (info). The caller handles keys (SELECT/CANCEL = OK).
function T.dialog(lines, icon)
  local x, y, w, h = 30, 36, 260, 140
  bevel(x, y, w, h)
  ui.rect(x + 4, y + 4, w - 8, 16, { color = T.GREEN })
  T.text(x + 8, y + 6, "POP.BIN", T.BLACK)
  ui.rect(x + w - 20, y + 6, 12, 12, { color = T.BLACK })
  T.text(x + w - 17, y + 6, "x", T.GREEN)
  local err = icon ~= "i"
  ui.rect(x + 14, y + 34, 24, 24, { color = err and T.RED or T.GREEN })
  T.text(x + 14, y + 37, err and "X" or "i", err and T.WHITE or T.BLACK, 14, 24, "center")
  for i = 1, math.min(#lines, 4) do
    T.text(x + 50, y + 22 + i * 14, lines[i], err and T.WHITE or T.GREEN)
  end
  bevel(x + w // 2 - 32, y + h - 30, 64, 22)
  T.text(x + w // 2 - 32, y + h - 25, "OK", T.WHITE, 12, 64, "center")
end

function T.bars(rssi)
  if not rssi or rssi == 0 then return "[BRDG]" end
  local n = rssi >= -50 and 4 or rssi >= -60 and 3 or rssi >= -70 and 2 or rssi >= -80 and 1 or 0
  return "[" .. string.rep("|", n) .. string.rep(".", 4 - n) .. "]"
end

-- "hello world" -> lines of at most n chars, split on spaces.
function T.wrap(s, n)
  local out, line = {}, ""
  for word in s:gmatch("%S+") do
    if #line > 0 and #line + 1 + #word > n then
      out[#out + 1] = line
      line = word
    else
      line = #line > 0 and (line .. " " .. word) or word
    end
  end
  if #line > 0 then out[#out + 1] = line end
  return out
end

return T
