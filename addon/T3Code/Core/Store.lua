-- The latest snapshot from the bridge, plus derived views of it.

local _, ns = ...

local Store = {
	data = { threads = {}, projects = {}, usage = {}, bridge = {} },
	byId = {},
	projectsById = {},
	applied = 0,
}
ns.Store = Store

local GROUP_OF = {
	working = "working", input = "working", plan = "working",
	open = "open", failed = "open",
	settled = "settled",
}
Store.GROUP_OF = GROUP_OF

function Store:Apply(data)
	data.threads = data.threads or {}
	data.projects = data.projects or {}
	data.usage = data.usage or {}
	data.bridge = data.bridge or {}
	local before = self.byId
	local byId, projectsById = {}, {}
	for _, t in ipairs(data.threads) do byId[t.id] = t end
	for _, p in ipairs(data.projects) do projectsById[p.id] = p end
	self.data, self.byId, self.projectsById = data, byId, projectsById
	self.applied = self.applied + 1

	if self.applied > 1 then
		for id, t in pairs(byId) do
			local old = before[id]
			if old and old.s ~= t.s then
				ns:Fire("ThreadTransition", t, old.s, t.s)
			elseif not old and (t.s == "working" or t.s == "input") then
				ns:Fire("ThreadTransition", t, nil, t.s)
			end
		end
	end
	ns:Fire("DataChanged")
	if data.view and data.view.id == ns.viewId then ns:Fire("ViewChanged") end
end

function Store:Thread(id)
	return id and self.byId[id]
end

function Store:ProjectName(id)
	local p = id and self.projectsById[id]
	return p and p.name or ""
end

-- Threads grouped for the sidebar, filtered by project.
-- projectFilter: "all", a project id, or "m:<machine>" ("m:local" for this one).
function Store:Groups(projectFilter, query)
	local groups = { working = {}, open = {}, settled = {} }
	local machine = projectFilter and projectFilter:match("^m:(.+)$")
	for _, t in ipairs(self.data.threads) do
		local match
		if machine then
			match = (machine == "local" and not t.env) or t.env == machine
		else
			match = projectFilter == "all" or projectFilter == nil or t.p == projectFilter
		end
		if match and query and query ~= "" then
			match = t.title:lower():find(query, 1, true) or self:ProjectName(t.p):lower():find(query, 1, true)
		end
		if match then
			local g = GROUP_OF[t.s] or "open"
			table.insert(groups[g], t)
		end
	end
	return groups
end

function Store:Active()
	local list = {}
	for _, t in ipairs(self.data.threads) do
		if t.s == "working" or t.s == "input" or t.s == "plan" then table.insert(list, t) end
	end
	return list
end

function Store:View()
	local v = self.data.view
	if v and v.id == ns.viewId then return v end
end

---------------------------------------------------------------------------
-- Status words and colors

local STATUS_TEXT = {
	working = "Working", input = "Waiting", plan = "Plan ready",
	open = "Finished", failed = "Failed", settled = "Settled",
}
local STATUS_COLOR = {
	working = "blue", input = "orange", plan = "orange",
	open = "white", failed = "red", settled = "grey",
}

function Store.StatusText(s)
	return STATUS_TEXT[s] or s or ""
end

function Store.StatusColor(s)
	return STATUS_COLOR[s] or "white"
end

---------------------------------------------------------------------------
-- Speech: the game's own voices when it has any, otherwise the desktop's.

function ns.StripMarkup(text)
	text = tostring(text or "")
	text = text:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", ""):gsub("||", "|")
	return text
end

local function GameVoices()
	if not C_VoiceChat or not C_VoiceChat.GetTtsVoices then return nil end
	local ok, voices = pcall(C_VoiceChat.GetTtsVoices)
	return ok and voices and #voices > 0 and voices or nil
end

function ns.SpeechEngine()
	local pref = ns.db and ns.db.settings.tts or "auto"
	if pref == "off" then return "off" end
	if pref == "game" then return GameVoices() and "game" or "off" end
	if pref == "system" then return "system" end
	-- auto: the desktop voice when the bridge has one (Wine rarely has game voices).
	if Store.data.bridge and Store.data.bridge.tts then return "system" end
	if GameVoices() then return "game" end
	return "off"
end

function ns.Speak(text, threadId, messageIndex)
	local engine = ns.SpeechEngine()
	if engine == "system" then
		if threadId and threadId ~= "" then
			ns.Transport:Send("speak", threadId, messageIndex or "last")
		else
			ns.Transport:Send("say", ns.StripMarkup(text):sub(1, 1200))
		end
		return true
	elseif engine == "game" then
		local voices = GameVoices()
		local voice = voices and voices[1].voiceID or 0
		if C_TTSSettings and C_TTSSettings.GetVoiceOptionID and Enum.TtsVoiceType then
			voice = C_TTSSettings.GetVoiceOptionID(Enum.TtsVoiceType.Standard) or voice
		end
		local rate = C_TTSSettings and C_TTSSettings.GetSpeechRate and C_TTSSettings.GetSpeechRate() or 0
		local volume = C_TTSSettings and C_TTSSettings.GetSpeechVolume and C_TTSSettings.GetSpeechVolume() or 100
		C_VoiceChat.StopSpeakingText()
		C_VoiceChat.SpeakText(voice, ns.StripMarkup(text):sub(1, 2000), rate, volume, false)
		return true
	end
	ns.Print("No text-to-speech voice is available. Pick one in T3 Code settings.")
	return false
end

function ns.Hush()
	if ns.SpeechEngine() == "game" then
		C_VoiceChat.StopSpeakingText()
	else
		ns.Transport:Send("hush")
	end
end
