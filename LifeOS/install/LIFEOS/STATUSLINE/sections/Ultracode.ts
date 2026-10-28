import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSessionShape } from "../../ROUTER/Shape";
import { invariant } from "../../TOOLS/Invariant";
import { obfuscation } from "../../TOOLS/Obfuscate";
import { ultracodeFromRows } from "../../TOOLS/UltracodeState";
import { RESET } from "../Ansi";
import { GLYPHS } from "../Glyphs";
import { mtime, readText } from "../Cache";
import { docsStatePath, type State } from "../State";
import { doctrineDir, doctrinePath, doctrineView, readDoctrine, type DoctrineView } from "../../TOOLS/DoctrineMark";

/**
 * Every mode chip is its own tag: a solid background in a hue no other chip and no SESSION text uses
 * (P2 had been the SESSION name's exact sky blue). Each tag
 * pads its text with one space a side, as the LifeOSHooks band draws its ULTRACODE and FAST tags; the short form keeps the
 * colour but drops the padding, so a narrow pane still fits every chip (R143).
 */
const tag = (bg: [number, number, number], fg: [number, number, number], text: string, short = false): string =>
  ` \x1b[48;2;${bg.join(";")}m\x1b[1;38;2;${fg.join(";")}m${short ? text : ` ${text} `}${RESET}`;
type Tone = { bg: [number, number, number]; fg: [number, number, number] };
const UC: Tone = { bg: [91, 33, 182], fg: [237, 233, 254] };
/** The parallel tag per level: the lanes icon and P1, P2 or P3, its green deepening to bright as the level climbs. */
const PARALLEL: Record<1 | 2 | 3, Tone> = {
  1: { bg: [6, 95, 70], fg: [209, 250, 229] },
  2: { bg: [4, 120, 87], fg: [236, 253, 245] },
  3: { bg: [16, 185, 129], fg: [2, 44, 34] },
};
const FAST: Tone = { bg: [180, 83, 9], fg: [254, 243, 199] };
const VOICE: Tone = { bg: [190, 18, 60], fg: [255, 228, 230] };
const GHOST: Tone = { bg: [71, 85, 105], fg: [226, 232, 240] };
const DOCS_STATES = new Set(["running", "synced", "clean", "flag", "error"]);
/** How long a finished docs result stays on the line. */
const DOCS_TTL_MS = 15 * 60_000;
const DOCS_RUNNING_TTL_MS = 5 * 60_000;

/** `⇶ P2` long, `⇶P2` short, each as a tag. */
export function parallelChip(level: number, short: boolean): string {
  const tone = PARALLEL[level as 1 | 2 | 3];
  if (!tone) return "";
  return tag(tone.bg, tone.fg, `⇶${short ? "" : " "}P${level}`, short);
}
/** VoiceMode.ts names a session state file only for this id shape; anything else is off, as there. */
const VOICE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The engine's own `/effort ultracode` rows say ultracode is on. The legacy session cache is shared; misses use the helper's pure transcript parser. */
export function engineUltracode(state: State): boolean {
  if (!state.transcript || !mtime(state.transcript)) return false;
  const key = `ultracode-${state.session}.txt`;
  const cached = state.cache.text(key)?.trimEnd().split("\t");
  if (cached && cached[1] === state.transcript && mtime(state.transcript) <= mtime(state.cache.path(key)) && /^(on|off)$/.test(cached[0])) return cached[0] === "on";
  const rows = readText(state.transcript);
  if (rows === null) return false;
  const on = ultracodeFromRows(rows.slice(0, rows.lastIndexOf("\n") + 1));
  state.cache.put(key, `${on ? "on" : "off"}\t${state.transcript}\n`);
  return on;
}

/** The engine-only chip, kept for callers of the original export. */
export function ultracode(state: State): string {
  return engineUltracode(state) ? tag(UC.bg, UC.fg, "⚡ULTRACODE") : "";
}

export type SessionModes = { ultracode: boolean; parallel: 1 | 2 | 3 | null };

/**
 * The session's standing modes from the session-shape file the dispatch hook writes (Router ISA F7, R119): one small JSON
 * read per refresh, never a transcript. The read goes through Shape.readSessionShape, the writer's own reader, so the
 * session-id check and the confinement to the shape dir are the same on both sides. Missing, malformed, an unsafe id or a
 * path that leaves the dir all read as nothing on.
 */
export function sessionModes(state: State): SessionModes {
  if (!state.sessionId) return { ultracode: false, parallel: null };
  const dir = state.env.LIFEOS_SESSION_SHAPE_DIR || join(state.root, "MEMORY", "STATE", "session-shape");
  const { ultracode, parallel } = readSessionShape(state.sessionId, dir);
  return { ultracode, parallel };
}

/**
 * Voice mode is on for this session (VoiceMode.ts `isOn`): its per-session state file exists. One stat per render, no
 * read. The dir follows the statusline's own env and root, so a fixture never sees the live install.
 */
export function voiceOn(state: State): boolean {
  if (!state.sessionId || !VOICE_ID.test(state.sessionId)) return false;
  const dir = state.env.LIFEOS_VOICE_MODE_DIR || join(state.root, "MEMORY", "STATE", "voice-mode");
  return existsSync(join(dir, `${state.sessionId}.json`));
}

export type DocsChip = { state: "running" | "synced" | "clean" | "flag" | "error"; n: number };
export type ChipModes = { ultracode: boolean; parallel: number | null; fast?: boolean; voice?: boolean; ghost?: boolean; docs?: DocsChip | null; doctrine?: DoctrineView | null };

/**
 * This session's doctrine mark (LIFEOS/TOOLS/DoctrineMark.ts, ISA 20261025-doctrine-mark): one small JSON read per
 * render, folded by the module's own view, so the hooks and the line agree on what the three facts mean.
 */
export function doctrineState(state: State): DoctrineView | null {
  const path = doctrinePath(doctrineDir(state.root, state.env), state.sessionId);
  return path && existsSync(path) ? doctrineView(readDoctrine(path), state.nowMs) : null;
}

/**
 * The balance scale and the docs marks' pen, check or cross, in the mark's colour with no badge and no words ({{PRINCIPAL_NAME}},
 * 2026-10-25): orange pen while a "from now on" turn has not yet touched doctrine, green check once a doctrine file was
 * written, red cross when a "from now on" turn ended without one.
 */
export function doctrineChip(d: DoctrineView): string {
  const mark = { writing: GLYPHS.pen, updated: GLYPHS.check, missed: GLYPHS.cross }[d.state];
  return ` ${mark.color}${GLYPHS.doctrine.glyph} ${mark.glyph}${RESET} `;
}

/**
 * This session's per-turn doc sync result (hooks/MicroIntegrity.hook.ts, ISA 20261024-micro-integrity): one small JSON
 * read per render. Missing, malformed, an unsafe id, or a finished result older than 15 minutes all read as no chip.
 */
export function docsState(state: State): DocsChip | null {
  const path = docsStatePath(state.root, state.sessionId);
  if (!path) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { state?: unknown; updated?: unknown; flags?: unknown; at?: unknown };
    if (typeof j.state !== "string" || !DOCS_STATES.has(j.state)) return null;
    const at = typeof j.at === "string" ? Date.parse(j.at) : NaN;
    // A run killed at its hook timeout never writes a final state, so "running" ages out too.
    if (!Number.isFinite(at) || state.nowMs - at > (j.state === "running" ? DOCS_RUNNING_TTL_MS : DOCS_TTL_MS)) return null;
    const n = j.state === "flag" ? (Array.isArray(j.flags) ? j.flags.length : 0) : Array.isArray(j.updated) ? j.updated.length : 0;
    return { state: j.state as DocsChip["state"], n };
  } catch { return null; }
}

/**
 * The Nerd Font document page and one mark, drawn in the mark's colour with no badge behind them and no words ({{PRINCIPAL_NAME}},
 * 2026-10-24): orange with a pen while docs are being written, green with a check when they are in line, red with a cross
 * when a mismatch is left unaddressed (a flag, or a check that failed). Each glyph is followed by a space, the second cell
 * kitty draws it across; both forms are the same, since there is no text to drop.
 */
export function docsChip(d: DocsChip, _short: boolean): string {
  const mark = { running: GLYPHS.pen, synced: GLYPHS.check, clean: GLYPHS.check, flag: GLYPHS.cross, error: GLYPHS.cross }[d.state];
  return ` ${mark.color}${GLYPHS.doc.glyph} ${mark.glyph}${RESET} `;
}

/**
 * The mode chips, each with its leading space, in a fixed order: `⚡ULTRACODE ⇶ P3 ↯ FAST 🎤 VOICE 👻 OBFUSCATED`,
 * or `⚡UC ⇶P3 ↯ 🎤 👻` in the short form, then the docs chip (document and mark) when this session has a recent result. FAST is Claude Code's per-session fast mode (Router ISA F10, R142); VOICE is
 * this session's voice mode; the ghost shows while obfuscation (Obfuscate.ts: OBS running, or `ob`) hides the account emails.
 */
export function modeChips(m: ChipModes, short: boolean): string {
  const uc = m.ultracode ? tag(UC.bg, UC.fg, `⚡${short ? "UC" : "ULTRACODE"}`, short) : "";
  const p = m.parallel ? parallelChip(m.parallel, short) : "";
  const fast = m.fast ? tag(FAST.bg, FAST.fg, `↯${short ? "" : " FAST"}`, short) : "";
  const voice = m.voice ? tag(VOICE.bg, VOICE.fg, `🎤${short ? "" : " VOICE"}`, short) : "";
  const g = m.ghost ? tag(GHOST.bg, GHOST.fg, `👻${short ? "" : " OBFUSCATED"}`, short) : "";
  const docs = m.docs ? docsChip(m.docs, short) : "";
  // Each mark already ends on a space; the doctrine mark drops its lead space when it follows the docs mark.
  const doctrine = m.doctrine ? (docs ? doctrineChip(m.doctrine).slice(1) : doctrineChip(m.doctrine)) : "";
  return uc + p + fast + voice + g + docs + doctrine;
}

/** Fills the chip text the header and SESSION rows draw: ultracode from the engine rows or the session-shape file, the rest from their own sources. */
export function prepareUltracode(state: State): string {
  invariant(typeof state.ultracode === "string" && typeof state.ultracodeShort === "string", "ultracode chips must be text");
  const modes = sessionModes(state);
  // The small file answers first; the transcript is consulted only when it does not already say on.
  const on = modes.ultracode || engineUltracode(state);
  const chips: ChipModes = {
    ultracode: on, parallel: modes.parallel, fast: state.fastMode === true, voice: voiceOn(state),
    ghost: obfuscation({ env: state.env, now: state.nowMs }).on,
    docs: docsState(state),
    doctrine: doctrineState(state),
  };
  state.ultracode = modeChips(chips, false);
  state.ultracodeShort = modeChips(chips, true);
  return "";
}
