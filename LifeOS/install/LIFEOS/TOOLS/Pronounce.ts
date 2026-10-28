/**
 * Pronounce.ts — the principal's pronunciation rules, read from the one file, plus the pure passes re-exported, so a
 * caller needs a single import (Fish voice ISA F7). The rules live only in USER/PRINCIPAL/PRONUNCIATIONS.json; a run
 * may layer its own file on top (StoryFilm, VideoEssay). The file is re-read when it changes, so an edit is spoken on
 * the next line even inside a long-running process like Pulse.
 *
 *   principalPronunciations()          → the principal's map, current as of its last edit
 *   pronunciationMap(...runFiles)      → the principal's map with each run file merged on top, later files winning
 *   pronounce(text, map)               → what a voice says (homographs, then overrides) · from PronounceCore.ts
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { lifeosUserDir } from "./LifeosConfig"

export { applyPronunciations, disambiguateHomographs, pronounce } from "./PronounceCore"

/** A rules file as a string map; a missing, unreadable or non-object file is empty, and non-string values are dropped. */
export function readPronunciationFile(path: string): Record<string, string> {
  if (!path || !existsSync(path)) return {}
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as unknown
    if (!j || typeof j !== "object" || Array.isArray(j)) return {}
    return Object.fromEntries(Object.entries(j as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>
  } catch { return {} }
}

export const principalPronunciationPath = (): string => join(lifeosUserDir(), "PRINCIPAL", "PRONUNCIATIONS.json")

let cached: { path: string; mtime: number; map: Record<string, string> } | null = null

/** The principal's map; the same object while the file is unchanged, so its compiled rules are reused. */
export function principalPronunciations(path: string = principalPronunciationPath()): Record<string, string> {
  let mtime = -1
  try { mtime = statSync(path).mtimeMs } catch { /* absent: empty map */ }
  if (cached && cached.path === path && cached.mtime === mtime) return cached.map
  cached = { path, mtime, map: mtime < 0 ? {} : readPronunciationFile(path) }
  return cached.map
}

/** The principal's map with each run file merged on top. */
export function pronunciationMap(...runFiles: string[]): Record<string, string> {
  if (runFiles.length === 0) return principalPronunciations()
  return Object.assign({}, principalPronunciations(), ...runFiles.map(readPronunciationFile))
}
