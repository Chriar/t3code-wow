-- Load the addon against the stub with one slot file, queue a command, and print the
-- strip as drawn (one digit 0..7 per cell). bridge/test/crypto.test.js decodes it
-- with the bridge's code.
--   lua5.1|luajit tools/strip_e2e.lua <addon dir> <slot.lua> <thread id> <text>
local addonDir, slotFile, threadId, text = arg[1], arg[2], arg[3], arg[4]
local Stub = dofile("tools/wowstub.lua")
Stub.slotData.default = slotFile

local ns = {}
for line in io.lines(addonDir .. "/T3Code.toc") do
	line = line:gsub("\r", "")
	if line ~= "" and not line:match("^#") and line:match("%.lua$") then
		assert(loadfile(addonDir .. "/" .. line:gsub("\\", "/")))("T3Code", ns)
	end
end
Stub.Fire("ADDON_LOADED", "T3Code")
Stub.Fire("PLAYER_LOGIN")
ns.viewId = threadId
ns.Transport:Send("send", threadId, text, "auto")
io.write(table.concat(Stub.StripCells()), "\n")
io.write(ns.Transport:Encrypted() and "encrypted" or "plain", "\n")
