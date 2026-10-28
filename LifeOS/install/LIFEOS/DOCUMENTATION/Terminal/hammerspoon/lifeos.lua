-- LifeOS hotkeys for Hammerspoon (optional, macOS). Doc: Terminal/Helm.md § Hammerspoon.
-- install.sh links this file to ~/.hammerspoon/lifeos.lua and adds one line to
-- ~/.hammerspoon/init.lua:  pcall(require, "lifeos")
-- It is a link into the LifeOS tree, so updating LifeOS updates it. Put your own hotkeys
-- in init.lua, never here.
--
--   Cmd+Shift+K   new LifeOS session in Helm (kitty, or a herdr session when herdr runs)
--   Cmd+Ctrl+K    the same, then starts dictation if the Dictation module is loaded
--   F18           the same as Cmd+Ctrl+K, for a pedal or macro key that sends F18
--   Shift+Cmd+M   mute or unmute the DA's voice (Pulse /voice/mute)
--   Shift+Cmd+V   toggle voice mode in the focused session (kitty only)

local M = {}

-- The shell command that starts a LifeOS session. Set LIFEOS_LAUNCH in init.lua before
-- the require to change it (for example a shorter alias of your own).
M.launch = LIFEOS_LAUNCH or "lifeos"
M.pulse = LIFEOS_PULSE_URL or "http://127.0.0.1:31337"

local KITTY = "net.kovidgoyal.kitty"

-- New session: bring kitty forward, Cmd+T, type the launch command, Enter. Cmd+T is a new
-- herdr session when herdr has focus, a new kitty tab otherwise. The pauses let each step
-- land before the next. DictationToggle comes from the Dictation module
-- (LIFEOS/DOCUMENTATION/Dictation/DictationSystem.md); without it, dictation is skipped.
local function startDictation()
    hs.timer.doAfter(1.0, function() if DictationToggle then DictationToggle() end end)
end

-- Keystrokes go to whatever app is frontmost, so every step checks kitty still is and
-- stops with an alert otherwise, rather than typing the launch command somewhere else.
local function kittyFront()
    local app = hs.application.frontmostApplication()
    if app and app:bundleID() == KITTY then return true end
    hs.alert.show("New LifeOS session cancelled: kitty is not in front", 2)
    return false
end

function LifeosNewSession(withDictation)
    local function typeLaunch()
        if not kittyFront() then return end
        hs.eventtap.keyStrokes(M.launch)
        hs.timer.doAfter(0.15, function()
            if not kittyFront() then return end
            hs.eventtap.keyStroke({}, "return", 0)
            if withDictation then startDictation() end
        end)
    end
    local kitty = hs.application.get(KITTY)
    if not kitty then
        -- Cold start: wait (up to 10 s) for kitty to come to the front, then give its
        -- first shell a moment before typing.
        hs.application.launchOrFocusByBundleID(KITTY)
        local tries = 0
        local function waitForKitty()
            local app = hs.application.frontmostApplication()
            if app and app:bundleID() == KITTY then hs.timer.doAfter(0.7, typeLaunch); return end
            tries = tries + 1
            if tries >= 40 then kittyFront(); return end
            hs.timer.doAfter(0.25, waitForKitty)
        end
        waitForKitty()
        return
    end
    kitty:activate()
    hs.timer.doAfter(0.3, function()
        if not kittyFront() then return end
        hs.eventtap.keyStroke({"cmd"}, "t", 0)
        hs.timer.doAfter(0.8, typeLaunch)
    end)
end
hs.hotkey.bind({"shift", "cmd"}, "K", function() LifeosNewSession(false) end)
hs.hotkey.bind({"ctrl", "cmd"}, "K", function() LifeosNewSession(true) end)
hs.hotkey.bind({}, "f18", function() LifeosNewSession(true) end)

-- Mute or unmute the DA's voice, for recordings and calls. Same switch as the Pulse menu
-- bar row. Shift matters: bare Cmd+M is system-wide minimize.
function LifeosToggleVoice()
    hs.http.asyncPost(M.pulse .. "/voice/mute", '{"source":"hammerspoon"}',
        { ["Content-Type"] = "application/json" },
        function(status, body)
            if status == 200 then
                local ok, obj = pcall(hs.json.decode, body)
                if ok and obj and obj.muted ~= nil then
                    hs.alert.show(obj.muted and "🔇 DA voice muted" or "🔊 DA voice on", 1.5)
                    return
                end
            end
            hs.alert.show("Voice toggle failed. Is Pulse running?", 3)
        end)
end
hs.hotkey.bind({"shift", "cmd"}, "M", LifeosToggleVoice)

-- Voice mode: types /voice + Enter into the focused Claude Code session. Live only while
-- kitty is frontmost, so Shift+Cmd+V keeps its normal meaning in every other app.
LifeosVoiceModeHotkey = hs.hotkey.new({"shift", "cmd"}, "V", function()
    hs.eventtap.keyStrokes("/voice")
    hs.timer.doAfter(0.05, function() hs.eventtap.keyStroke({}, "return", 0) end)
end)
local function syncVoiceMode()
    local app = hs.application.frontmostApplication()
    if app and app:bundleID() == KITTY then LifeosVoiceModeHotkey:enable() else LifeosVoiceModeHotkey:disable() end
end
LifeosVoiceModeWatcher = hs.application.watcher.new(function(_, event)
    if event == hs.application.watcher.activated then syncVoiceMode() end
end)
LifeosVoiceModeWatcher:start()
syncVoiceMode()
-- A dropped activation event would leave the hotkey stuck on the wrong app until the next
-- switch, so a slow watchdog re-syncs it.
LifeosVoiceModeWatchdog = hs.timer.new(3, syncVoiceMode)
LifeosVoiceModeWatchdog:start()

return M
