import { existsSync } from "fs"
import { join } from "path"

/**
 * The house-control script (hue.ts, roomba.ts, eightsleep.ts) inside the private home skill, or null when this
 * install does not have it. The skills directory comes from the caller (Paths.getSkillsDir()), so a relocated
 * Claude home resolves the same way as every other optional private tool, and an install without the home skill
 * gets a clear "not installed" answer instead of a failed spawn.
 */
export function houseScript(skillsDir: string, skillName: string, script: string): string | null {
  const path = join(skillsDir, skillName, script)
  return existsSync(path) ? path : null
}

export type HouseActionBody = { device?: unknown; target?: unknown; action?: unknown; value?: unknown }

/**
 * The house-control CLI argv for one allow-listed device action, or null when the device, action or value is not
 * one the route accepts. Brightness and bed temperature take a number; a light color takes the hue.ts color name,
 * a short string. The first element names the script inside the home skill.
 */
export function houseCommand(body: HouseActionBody): string[] | null {
  const { device, target, action } = body
  const value = typeof body.value === "number" ? body.value : undefined
  const safe = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9 _-]{1,32}$/.test(v)
  if (!safe(target)) return null

  if (device === "light") {
    if (action === "on" || action === "off") return ["hue.ts", "light", target, action]
    if (action === "bri" && value !== undefined && value >= 0 && value <= 100) return ["hue.ts", "bri", target, String(Math.round(value))]
    if (action === "color" && safe(body.value)) return ["hue.ts", "color", target, body.value]
  } else if (device === "vacuum") {
    const map: Record<string, string> = { clean: "clean", stop: "stop", pause: "pause", resume: "resume", dock: "dock", locate: "locate" }
    if (typeof action === "string" && Object.hasOwn(map, action)) return ["roomba.ts", map[action]!, target]
  } else if (device === "bed") {
    // target is the side: left | right | mine | both (a solo Pod ignores it)
    const side = ["left", "right", "mine", "both"].includes(target) ? target : "mine"
    if (action === "on" || action === "off") return ["eightsleep.ts", action, "--side", side]
    if (action === "temp" && value !== undefined && value >= 13 && value <= 44) return ["eightsleep.ts", "temp", String(Math.round(value)), "--side", side]
  }
  return null
}
