-- A pure-Lua stand-in for the client's `bit` library, for running the addon under
-- plain Lua 5.1. Results are unsigned 32-bit, like WoW's; LuaJIT's built-in BitOp
-- (signed results) covers the other convention. Slow, but only tests use it.
if bit then return bit end

local M = 4294967296
local floor = math.floor

local function norm(x) return floor(x) % M end

local function op(a, b, f)
	a, b = norm(a), norm(b)
	local r, p = 0, 1
	for _ = 1, 32 do
		local x, y = a % 2, b % 2
		r = r + f(x, y) * p
		a, b, p = (a - x) / 2, (b - y) / 2, p * 2
	end
	return r
end

local AND = function(x, y) return (x == 1 and y == 1) and 1 or 0 end
local OR = function(x, y) return (x == 1 or y == 1) and 1 or 0 end
local XOR = function(x, y) return x ~= y and 1 or 0 end

bit = {
	band = function(a, b, ...) local r = op(a, b, AND); if ... then return bit.band(r, ...) end return r end,
	bor = function(a, b, ...) local r = op(a, b, OR); if ... then return bit.bor(r, ...) end return r end,
	bxor = function(a, b, ...) local r = op(a, b, XOR); if ... then return bit.bxor(r, ...) end return r end,
	bnot = function(a) return M - 1 - norm(a) end,
	lshift = function(a, n) return (norm(a) * 2 ^ n) % M end,
	rshift = function(a, n) return floor(norm(a) / 2 ^ n) end,
}
return bit
