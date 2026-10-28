#!/usr/bin/env bun
/**
 * @version 1.3.0
 * Shape.ts — the shape and the deadline of one request (Router ISA F5, R94-R107), and the session's standing
 * ultracode and parallel level (F7, R117-R119): `uc`/`u` and `p`/`pp`/`ppp`/`ff`/`fff` as the first or last word, kept
 * per session in MEMORY/STATE/session-shape/<session>.json for the statusline's SESSION line. A single `f` is the
 * per-session fast toggle (F10, R145), never a level.
 *
 * Two tokens in the principal's own prompt set the shape: `dw` (or `/dw`) as the first or last word is his
 * Workflow opt-in, and a time at the end ("10m", "2h", "by 15:30") is a deadline that also counts as that
 * opt-in. parseShape reads them deterministically at submit, formatShapeLine turns them into the one line the
 * DA reads as context, and the deadlines report joins each logged deadline to the transcript to say whether
 * the reply landed in time. The Router never starts a Workflow; this file only tells the DA what was asked.
 *
 *   bun LIFEOS/ROUTER/Router.ts deadlines [--days N]   (the report; wired in Router.ts)
 *
 * Pure except appendDeadline, the report's reads, and the one frontmatter read per command name (R123). No prompt text is ever logged (the R28 precedent):
 * a row carries ids and times only.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { atomicWrite, confinedPath } from "../TOOLS/lib/Boundary";
import { getClaudeDir, lifeosPath } from "../TOOLS/Paths";

export type ParallelLevel = 1 | 2 | 3;
export type Shape = {
  /** `dw` or `/dw` as the first or last word: run as a Workflow, tier named in the first line. */
  dw: boolean;
  /** The time allowed in ms, or null when the prompt names no deadline. */
  budgetMs: number | null;
  /** Epoch ms the reply is due, or null. */
  due: number | null;
  /** F7: `uc`/`/uc` as the first or last word, or a bare `u`/`/u` prompt, turns ultracode on. Present only when set. */
  ultracode?: true;
  /** F7: a `uc off` or `u off` prompt turns it off. Present only when set. */
  ultracodeOff?: true;
  /** F7: `p`/`pp`/`ppp` or `ff`/`fff` (slash forms too) as the first or last word; a lone `f` is the fast toggle (F10). Present only when set. */
  parallel?: ParallelLevel;
  /** R119: a `p off` prompt clears the standing level. Present only when set. */
  parallelOff?: true;
};

/** A duration of a day or more is a number in a sentence ("5m" people, "100h" of video), not a deadline. */
const MAX_BUDGET_MS = 24 * 3_600_000;
/** Nobody is waiting on a reply in under ten seconds, so "6s" (the iPhone) is a model name, not a deadline. */
const MIN_BUDGET_MS = 10_000;
/** "400m" is meters far more often than 6.7 hours: a minutes figure is a deadline only up to four hours. */
const MAX_MINUTES_MS = 4 * 3_600_000;
const UNIT_MS: Record<string, number> = { s: 1000, sec: 1000, secs: 1000, m: 60_000, min: 60_000, mins: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000 };
const DURATION = /^(\d+(?:\.\d+)?)(s|secs?|m|mins?|h|hrs?)$/i;
const CLOCK = /^(\d{1,2}):(\d{2})$/;
const DW = /^\/?dw$/i;
/** A sentence that opens with one of these asks something; a trailing figure in it is the answer's unit, not a deadline. */
const QUESTION_WORDS = new Set(["how", "what", "why", "when", "where", "who", "whom", "whose", "which", "is", "are", "was", "were", "does", "did", "can", "could", "should", "would", "will", "has", "had", "am"]);
/** The word before a figure that makes it a quantity in a phrase ("the 90s", "about 400m", "takes 3h"), never a deadline. */
const QUANTITY_LEAD = new Set(["the", "a", "an", "of", "from", "about", "around", "roughly", "approx", "approximately", "nearly", "almost", "only", "is", "are", "was", "were", "be", "been", "take", "takes", "took", "taking", "for", "over", "than", "to", "at", "per", "each", "every", "last", "past", "next", "this", "that", "these", "those", "my", "your", "its", "his", "her", "our", "their", "some", "any", "another", "and", "or", "with"]);

/**
 * R123: a command that declares `durations: length` in its frontmatter reads a trailing figure as a running length
 * ("lc video 5m"), so a prompt it opens sets no deadline. The command declares it; the parser never guesses it from the
 * word before the figure. Read once per command name per process.
 */
const LENGTH_COMMAND = new Map<string, boolean>();
function declaresLength(word: string | undefined): boolean {
  const name = word ? bare(word).replace(/^\//, "").toLowerCase() : "";
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) return false;
  const known = LENGTH_COMMAND.get(name);
  if (known !== undefined) return known;
  let yes = false;
  try {
    const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(getClaudeDir(), "commands", `${name}.md`), "utf8"));
    yes = !!front && /^durations:\s*["']?length["']?\s*$/m.test(front[1]);
  } catch { /* no such command: an ordinary word */ }
  LENGTH_COMMAND.set(name, yes);
  return yes;
}

/** One word with sentence punctuation trimmed off its end, so "10m." and "dw!" still read as the token. */
const bare = (w: string): string => w.replace(/[.!?,;]+$/, "");

// ── F7: the ultracode and parallel shortcuts (OPERATIONAL_PREFERENCES § Vocabulary) ────────────────────────────────
const UC = /^\/?(uc|ultracode)$/;
/** A word before a trailing `ultracode` that turns it into a request to stop it ("turn off ultracode"). */
const UC_NEGATION = new Set(["off", "no", "not", "without", "disable", "stop"]);
/** F10 (R145): `f` alone is the fast toggle, so only `ff` and `fff` are levels on the f side. F11 (R148): `p1`–`p3` name the level by number. */
const LEVEL = /^\/?(?:(p{1,3}|f{2,3})|p([123]))$/;
/** The bare shortcuts that keep a parallel level standing: status, continue, yes, elaborate, visualize, a level, uc, u, and the fast toggle f. */
const KEEPS_LEVEL = /^\/?(s|c|y|e|v|uc|u|f|p{1,3}|f{2,3}|p[123])$/i;
/** The word before a trailing shortcut that makes it a word in a sentence ("an f", "press the p", "applied to uc"). */
const SHORTCUT_LEAD = new Set(["a", "an", "the", "to", "at", "from", "of", "in", "into", "letter", "grade", "press", "type", "key", "my", "your"]);
/**
 * The level a word names, or null. The first word matches in any case (dictation capitalizes it); a trailing word
 * must be lowercase, so "FF" or a grade written "F" at the end is never read as a level.
 */
function levelOf(word: string, first: boolean): ParallelLevel | null {
  const w = bare(word);
  const m = LEVEL.exec(first ? w.toLowerCase() : w);
  return m ? ((m[1] ? m[1].length : Number(m[2])) as ParallelLevel) : null;
}
const isUc = (word: string, first: boolean): boolean => UC.test(first ? bare(word).toLowerCase() : bare(word));

/**
 * Whether the whole prompt is bare shortcuts (s, c, y, e, v, a level, uc, u, f, and `uc off`/`uc status`/`f off`): such a prompt
 * keeps the standing parallel level; any other prompt without a level of its own clears it (R119).
 */
export function isBareShortcut(prompt: string): boolean {
  const words = prompt.trim().split(/\s+/).filter(Boolean).map(w => bare(w));
  if (!words.length) return false;
  if (words.length === 2 && /^\/?uc?$/i.test(words[0]) && /^(on|off|status)$/i.test(words[1])) return true;
  if (words.length === 2 && /^\/?f$/i.test(words[0]) && /^(on|off)$/i.test(words[1])) return true; // F10: `f on`/`f off`
  return words.every(w => KEEPS_LEVEL.test(w));
}

/** The duration in ms for a word like `90s`, `1.5h`, `10min`; null for anything else or an implausible value. */
function durationMs(word: string): number | null {
  const m = DURATION.exec(bare(word));
  if (!m) return null;
  if (m[1].split(".")[0].length > 3) return null; // "1990s" is a decade, "5000m" a distance
  const unit = m[2].toLowerCase();
  const ms = Math.round(Number(m[1]) * UNIT_MS[unit]);
  if (ms < MIN_BUDGET_MS || ms > MAX_BUDGET_MS) return null;
  if (unit.startsWith("m") && ms > MAX_MINUTES_MS) return null;
  return ms;
}

/** The next local HH:mm strictly after `now`: today when still ahead, otherwise tomorrow. Null when not a clock time. */
function nextClock(word: string, now: number): number | null {
  const m = CLOCK.exec(bare(word));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const n = new Date(now);
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate(), h, min, 0, 0).getTime();
  return today > now ? today : new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, h, min, 0, 0).getTime();
}

/** A request, not a question or a bare figure: the words left once the shape tokens are taken off the ends. */
const asksSomething = (rest: string[]): boolean => (rest.length > 0 && QUESTION_WORDS.has(bare(rest[0]).toLowerCase())) || rest.some(w => w.endsWith("?"));

/**
 * Reads the shape out of a prompt. `dw` counts only as the first or last word; a duration or `by HH:mm` counts
 * only at the very end, and `dw` and the time may sit in either order there ("10m dw", "dw 10m", "dw 10m dw").
 * Anywhere else the same characters are just words. A time with no `dw` beside it must also read as a request:
 * at least two other words ("ship the report 10m"; three before a `by HH:mm`), no question, and no quantity word
 * right before the figure ("about 400m", "the 90s", "takes 3h"). An explicit `dw` waives the word count. A bare
 * "10m" is a likely answer to a question, so it sets nothing; a bare "dw" is still the opt-in. Callers pass the
 * unwrapped prompt (FrontDoor.unwrapPasted).
 */
export function parseShape(prompt: string, now: Date | number = Date.now()): Shape {
  const at = now instanceof Date ? now.getTime() : now;
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  const shape: Shape = { dw: false, budgetMs: null, due: null };
  if (!words.length) return shape;
  // dw and the deadline are read exactly as before F7 (R94-R101). The F7 shortcuts never decide either: a shortcut can
  // neither promote an inner dw ("uc dw fix it") nor expose a figure that a trailing word kept from being the last
  // token ("ship the report 10m uc").
  let start = 0;
  if (DW.test(bare(words[0]))) { shape.dw = true; start = 1; }
  // Peel the end: any number of dw tokens and at most one time, in either order. The time is validated afterwards,
  // once every dw beside it is known.
  let end = words.length;
  let time: { ms: number; clock: boolean } | null = null;
  while (end > start) {
    const last = words[end - 1];
    if (DW.test(bare(last))) { shape.dw = true; end--; continue; }
    if (time) break;
    const ms = durationMs(last);
    if (ms !== null) { time = { ms, clock: false }; end--; continue; }
    const due = end - start >= 2 && /^by$/i.test(words[end - 2]) ? nextClock(last, at) : null;
    if (due !== null) { time = { ms: due - at, clock: true }; end -= 2; continue; }
    break;
  }
  if (time && !declaresLength(words[start])) {
    const rest = words.slice(start, end);
    const lead = rest.length ? bare(rest[rest.length - 1]).toLowerCase() : "";
    const request = shape.dw || (rest.length >= (time.clock ? 3 : 2) && !asksSomething(rest));
    if (request && (time.clock || !QUANTITY_LEAD.has(lead))) { shape.budgetMs = time.ms; shape.due = at + time.ms; }
  }
  // F7 whole-prompt forms: a bare `u` or `/u`, and `uc`/`u` followed by on, off or status.
  const lower = words.map(w => bare(w).toLowerCase());
  if (lower.length === 1 && /^\/?u$/.test(lower[0])) { shape.ultracode = true; return shape; }
  if (lower.length === 2 && /^\/?uc?$/.test(lower[0]) && /^(on|off|status)$/.test(lower[1])) {
    if (lower[1] === "on") shape.ultracode = true;
    else if (lower[1] === "off") shape.ultracodeOff = true;
    return shape;
  }
  if (lower.length === 2 && /^\/?p$/.test(lower[0]) && lower[1] === "off") { shape.parallelOff = true; return shape; }
  // F7 shortcuts, on a pass of their own that sets only ultracode and the level: uc and a parallel level at either end,
  // past any dw and one time there. The first word of a longer prompt matches in any case, since dictation capitalizes
  // it; `/u` opens a slash command with arguments.
  let uc = false;
  let level: ParallelLevel | null = null;
  const raise = (l: ParallelLevel): void => { level = level === null || l > level ? l : level; };
  let s = 0;
  while (s < words.length) {
    const w = words[s], loose = s === 0 && words.length > 1;
    if (DW.test(bare(w))) { s++; continue; }
    if (isUc(w, loose) || (s === 0 && /^\/u$/i.test(bare(w)))) { uc = true; s++; continue; }
    const l = levelOf(w, loose);
    if (l !== null) { raise(l); s++; continue; }
    break;
  }
  // A trailing shortcut after an article or preposition is a word in a sentence ("an f", "applied to uc").
  let e = words.length;
  let timed = false;
  while (e > s) {
    const last = words[e - 1];
    if (DW.test(bare(last))) { e--; continue; }
    if (e - 1 === s || !SHORTCUT_LEAD.has(bare(words[e - 2]).toLowerCase())) {
      if (isUc(last, false) && (e - 1 === s || !UC_NEGATION.has(bare(words[e - 2]).toLowerCase()))) { uc = true; e--; continue; }
      const l = levelOf(last, false);
      if (l !== null) { raise(l); e--; continue; }
    }
    if (timed) break;
    if (durationMs(last) !== null) { timed = true; e--; continue; }
    if (e - s >= 2 && /^by$/i.test(words[e - 2]) && nextClock(last, at) !== null) { timed = true; e -= 2; continue; }
    break;
  }
  if (uc) shape.ultracode = true;
  if (level !== null) shape.parallel = level;
  return shape;
}

/** Whether the prompt carries anything to act on. */
export const isShaped = (s: Shape): boolean => s.dw || s.due !== null;

/** 24-hour local HH:mm. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

function budgetText(ms: number): string {
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  const h = Math.floor(ms / 3_600_000), min = Math.round((ms - h * 3_600_000) / 60_000);
  return h ? (min ? `${h} h ${min} min` : `${h} h`) : `${min} min`;
}

/**
 * The one line the DA reads. A deadline gives the due time and the aim time (80% of the budget); `dw` makes the
 * request a Workflow with its tier named in the first line (Algorithm § Routing); a deadline alone
 * only permits a Workflow, native execution or a Workflow being the DA's call.
 */
export function formatShapeLine(s: Shape, now: Date | number = Date.now()): string {
  const at = now instanceof Date ? now.getTime() : now;
  const due = s.due !== null && s.budgetMs !== null ? clock(s.due) : null;
  const dueWords = due !== null && !sameDay(s.due!, at) ? `${due} tomorrow` : due;
  const aim = due !== null ? clock(s.due! - Math.round(s.budgetMs! * 0.2)) : null;
  const parts: string[] = ["⏱️ SHAPE"];
  if (due !== null) parts.push(`Due ${dueWords}; aim to finish by ${aim} (${budgetText(s.budgetMs!)} budget).`);
  if (s.dw) parts.push("Run this request as a Workflow (dw is the principal's opt-in), sized to the tier in Algorithm § Routing.");
  else parts.push("A Workflow is permitted for this request (the time suffix is the principal's opt-in); choose native execution or a Workflow by your judgment.");
  const first = s.dw ? `"${due !== null ? `Due ${due} · ` : ""}dw T<n>, <k> lanes"` : `"Due ${due} · inline" or "Due ${due} · dw T<n>, <k> lanes"`;
  parts.push(`Open your reply with ${first}${s.dw ? ", naming the tier" : ""}.`);
  if (due !== null) parts.push(`Deliver what exists at ${due} and name what is unfinished.`);
  return parts.join(" ");
}

export type DeadlineRow = { session: string; turn: string; submitted: string; due: string | null; budget: number | null; dw: boolean; transcript: string | null };

export function deadlinesPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LIFEOS_ROUTER_DEADLINES_LOG || lifeosPath("MEMORY", "OBSERVABILITY", "deadlines.jsonl");
}

/** The row a shape-bearing prompt appends: ids and times only, never any of the prompt's words. */
export function deadlineRow(s: Shape, session: string, turn: string, now: Date | number, transcript?: string): DeadlineRow {
  const at = now instanceof Date ? now.getTime() : now;
  return { session, turn, submitted: new Date(at).toISOString(), due: s.due !== null ? new Date(s.due).toISOString() : null, budget: s.budgetMs, dw: s.dw, transcript: transcript ?? null };
}

export function appendDeadline(row: DeadlineRow, path: string = deadlinesPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
}

// ── F7: the session-shape file ───────────────────────────────────────────────────────────────────────────────

/**
 * What the statusline reads for one session: ultracode by the principal's `uc`/`u` shortcut and the standing parallel
 * level. The session id, a boolean and a small integer; never any of the prompt's words.
 */
export type SessionShape = { session: string; ultracode: boolean; parallel: ParallelLevel | null };

/** A session id that is safe as one file name. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isLevel = (v: unknown): v is ParallelLevel => v === 1 || v === 2 || v === 3;

export function sessionShapeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LIFEOS_SESSION_SHAPE_DIR || lifeosPath("MEMORY", "STATE", "session-shape");
}

/**
 * The stored shape, or the default (off, no level) when the file is missing, torn or malformed. The one reader for every
 * caller, the statusline included: an id the writer would refuse reads as nothing on, and the path goes through the shared
 * Boundary.confinedPath, so a symlink at it that leaves the shape dir is never followed.
 */
export function readSessionShape(session: string, dir: string = sessionShapeDir()): SessionShape {
  const none: SessionShape = { session, ultracode: false, parallel: null };
  if (!SESSION_ID.test(session)) return none;
  const path = confinedPath(dir, `${session}.json`);
  if (path === null) return none;
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return { session, ultracode: r.ultracode === true, parallel: isLevel(r.parallel) ? r.parallel : null };
  } catch { return none; }
}

/**
 * The shape after one prompt (R119): ultracode turns on with a `uc`/`u`/`ultracode` prompt and off only with `uc off`; the
 * parallel level is set by a prompt that names one and stays standing until another level replaces it or `p off` clears it.
 */
export function nextSessionShape(prev: SessionShape, shape: Shape, _bareShortcut?: boolean): SessionShape {
  const ultracode = shape.ultracodeOff ? false : shape.ultracode ? true : prev.ultracode;
  const parallel = shape.parallelOff ? null : shape.parallel ?? prev.parallel;
  return { session: prev.session, ultracode, parallel };
}

/**
 * Writes the shape through the shared Boundary.atomicWrite (an exclusive, unpredictable temp file, owner-only, then a
 * rename that replaces a symlink at the path rather than writing through it) and returns its path.
 */
export function writeSessionShape(s: SessionShape, dir: string = sessionShapeDir()): string {
  invariant(SESSION_ID.test(s.session), `session-shape: session id must be a plain file name, got ${JSON.stringify(s.session)}`);
  invariant(typeof s.ultracode === "boolean", "session-shape: ultracode must be a boolean");
  invariant(s.parallel === null || isLevel(s.parallel), `session-shape: parallel must be 1, 2, 3 or null, got ${String(s.parallel)}`);
  const body = JSON.stringify({ session: s.session, ultracode: s.ultracode, parallel: s.parallel }) + "\n";
  const path = join(resolve(dir), `${s.session}.json`);
  atomicWrite(path, body);
  return path;
}

// ── the deadlines report ─────────────────────────────────────────────────────────────────────────────────────

type TRow = { type?: unknown; isSidechain?: unknown; isMeta?: unknown; timestamp?: unknown; promptId?: unknown; origin?: { kind?: unknown }; message?: { content?: unknown } };

/** A row the principal typed: origin kind human, or on an older transcript with no origin, a plain non-tool, non-system user row. */
function isTyped(r: TRow): boolean {
  if (r.type !== "user" || r.isSidechain === true || r.isMeta === true) return false;
  if (r.origin) return r.origin.kind === "human";
  const c = r.message?.content;
  if (Array.isArray(c)) return c.some(b => b && typeof b === "object" && (b as { type?: unknown }).type === "text");
  return typeof c === "string" && !c.trimStart().startsWith("<");
}

export type Delivery = { state: "ok"; at: number } | { state: "no-turn" } | { state: "no-reply" };

/**
 * When the reply to one turn landed. The assistant rows carry a timestamp but no turn key (the user rows hold
 * the promptId), so the turn's delivery is the timestamp of the last main-thread assistant row before the next
 * typed human row after the prompt. A task-notification turn does not end it: a background Workflow's answer
 * arrives in one.
 */
export function deliveryFromTranscript(text: string, turn: string): Delivery {
  const rows: TRow[] = [];
  for (const line of text.split("\n")) { if (!line.trim()) continue; try { const r = JSON.parse(line); if (r && typeof r === "object") rows.push(r); } catch { /* a torn line carries nothing */ } }
  const start = rows.findIndex(r => isTyped(r) && r.promptId === turn);
  if (start < 0) return { state: "no-turn" };
  let at: number | null = null;
  for (let i = start + 1; i < rows.length; i++) {
    const r = rows[i];
    if (isTyped(r) && r.promptId !== turn) break;
    if (r.type === "assistant" && r.isSidechain !== true && typeof r.timestamp === "string") { const t = Date.parse(r.timestamp); if (Number.isFinite(t) && (at === null || t > at)) at = t; }
  }
  return at === null ? { state: "no-reply" } : { state: "ok", at };
}

export type DeadlineEntry = { session: string; turn: string; submitted: number; due: number; delivered: number | null; state: "on-time" | "late" | "no-reply" | "no-turn" | "no-transcript"; byAim: boolean | null };
export type DeadlinesReport = { rows: number; dwOnly: number; entries: DeadlineEntry[]; onTime: number; measured: number; byAim: number; unmatched: number; text: string };

const mmss = (ms: number): string => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

/** Joins each logged deadline to its transcript and counts the turns that landed by the due time. */
export function deadlinesReport(opts: { path?: string; days?: number; now?: number } = {}): DeadlinesReport {
  const path = opts.path ?? deadlinesPath();
  const now = opts.now ?? Date.now();
  const rows: DeadlineRow[] = [];
  if (existsSync(path)) for (const line of readFileSync(path, "utf8").split("\n")) {
    try { const r = JSON.parse(line) as DeadlineRow; if (r && typeof r.turn === "string" && (!opts.days || Date.parse(r.submitted) >= now - opts.days * 86_400_000)) rows.push(r); } catch { /* skip a torn line */ }
  }
  const cache = new Map<string, string | null>();
  const read = (p: string): string | null => { if (!cache.has(p)) { try { cache.set(p, readFileSync(p, "utf8")); } catch { cache.set(p, null); } } return cache.get(p)!; };
  const entries: DeadlineEntry[] = [];
  let dwOnly = 0;
  for (const r of rows) {
    if (!r.due) { dwOnly++; continue; }
    const submitted = Date.parse(r.submitted), due = Date.parse(r.due);
    const base = { session: r.session, turn: r.turn, submitted, due, delivered: null as number | null, byAim: null as boolean | null };
    const text = r.transcript ? read(r.transcript) : null;
    if (text === null) { entries.push({ ...base, state: "no-transcript" }); continue; }
    const d = deliveryFromTranscript(text, r.turn);
    if (d.state !== "ok") { entries.push({ ...base, state: d.state }); continue; }
    const aim = due - Math.round((due - submitted) * 0.2);
    entries.push({ ...base, delivered: d.at, state: d.at <= due ? "on-time" : "late", byAim: d.at <= aim });
  }
  const measured = entries.filter(e => e.state === "on-time" || e.state === "late");
  const onTime = measured.filter(e => e.state === "on-time").length;
  const byAim = measured.filter(e => e.byAim).length;
  const unmatched = entries.length - measured.length;
  const lines = [`deadlines${opts.days ? `, last ${opts.days} days` : ""}: ${entries.length} turn${entries.length === 1 ? "" : "s"} with a time${dwOnly ? `, ${dwOnly} dw-only` : ""}`, `${onTime} of ${measured.length} on time · ${byAim} of ${measured.length} by the aim time${unmatched ? ` · ${unmatched} not measurable` : ""}`];
  for (const e of entries) {
    const head = `${e.state.padEnd(13)} submitted ${clock(e.submitted)}  due ${clock(e.due)}`;
    const tail = e.delivered !== null ? `  replied ${clock(e.delivered)}${e.state === "late" ? ` (+${mmss(e.delivered - e.due)})` : ""}` : "";
    lines.push(`  ${head}${tail}  session ${e.session.slice(0, 8)}`);
  }
  return { rows: rows.length, dwOnly, entries, onTime, measured: measured.length, byAim, unmatched, text: lines.join("\n") };
}
