#!/usr/bin/env bun
/**
 * IsaAsks — the ISA ask queue: read it, record an answer, settle what nobody answered.
 *
 *   bun LIFEOS/TOOLS/IsaAsks.ts list   <isa> [--open] [--json]
 *   bun LIFEOS/TOOLS/IsaAsks.ts answer <isa> --id <id> --value <v>[,<v>] [--note "<verbatim>"]
 *                                      [--source terminal|relay|pulse|voice] [--now <ISO>] [--json]
 *   bun LIFEOS/TOOLS/IsaAsks.ts settle <isa> [--now <ISO>] [--json]
 *
 * An ask is the existing `ask` exhibit fence (ISAFormat § Exhibits; ISARender.renderAsk draws it):
 *
 *   ```ask id="retry" status="open" blocks="ISC-4 ISC-7" raised-by="drift" looked-up="..." answered="2026-10-10"
 *   Question text (one or more lines before the first option)
 *   (x) 3 | Yes, 3 times | optional note
 *   ( ) no | No
 *   text: optional free-text placeholder
 *   ```
 *
 * `(x)` / `( )` is single choice, `[x]` / `[ ]` multiple choice; the x marks the recommended pick.
 * The lifecycle attributes are all optional: `status` is open | answered | default-unratified
 * (absent = open), `blocks` is a space-separated list of ISC ids, `answered` is YYYY-MM-DD.
 *
 * What the writers may do, and the whole of it:
 *   - answer: move the x to the chosen option(s), set status="answered" and answered="<date>" on
 *     the fence's info string (other attributes kept), and APPEND the question, the chosen value
 *     and label, the source and the verbatim note to `## Articulation Log` (a `### date time · refine`
 *     block; the Log's last block is reused when it is today's refine block; the section is created
 *     at the end when absent). No line written inside the block starts with `#`.
 *   - settle: stamp every still-open ask status="default-unratified" (the pick stays) and add one
 *     `## Decisions` bullet per ask saying it was a default, not the principal's agreement.
 *   Anything else in the file is left byte-identical. A refusal (unknown id or value, several values
 *   on a single-choice ask, the Log not last) writes nothing and exits 2.
 *
 * Writes are atomic (temp file + rename) and assert their invariants first (Invariant.ts).
 * `--now` takes the wall clock literally when it is `YYYY-MM-DD[T ]HH:MM...`; otherwise the local clock. An impossible date or time is refused.
 * A CRLF ISA is read and written with its CRLFs kept; a file mixing CRLF and LF is refused for writing.
 * `--value` splits on commas except where a comma is part of an option's own value (`1,000`).
 *
 * @version 1.0.0
 */
import { existsSync, readFileSync, realpathSync, renameSync, statSync, chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { invariant } from "./Invariant";

export type AskStatus = "open" | "answered" | "default-unratified";

export interface AskOption {
  value: string;
  label: string;
  note: string;
  picked: boolean;
}

export interface Ask {
  id: string;
  question: string;
  options: AskOption[];
  multi: boolean;
  /** Values of the picked (x-marked) options. */
  defaults: string[];
  status: AskStatus;
  blocks: string[];
  raisedBy: string | null;
  lookedUp: string | null;
  answered: string | null;
  /** ISC id of the nearest `- [ ] ISC-N:` / `- [x] ISC-N:` line above the fence, if any. */
  under: string | null;
  /** 1-based line of the opening fence. */
  line: number;
}

/** A parsed ask plus where its pieces sit, so a writer can edit exactly those lines. */
interface RawAsk extends Ask {
  openIdx: number;
  closeIdx: number;
  /** Line index of each option, aligned with `options`. */
  optionIdx: number[];
  fence: Fence;
}

interface Fence {
  open: number;
  close: number;
  char: string;
  len: number;
  indent: string;
  gap: string;
  info: string;
}

export class AsksRefusal extends Error {}

const STATUSES: ReadonlySet<string> = new Set(["open", "answered", "default-unratified"]);
const SOURCES: ReadonlySet<string> = new Set(["terminal", "relay", "pulse", "voice"]);

// ── Fence scanning ────────────────────────────────────────────────────────────

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

/** CommonMark-style fences: a fence inside another fence is content, never an opener. */
function scanFences(lines: string[]): { fences: Fence[]; fenced: boolean[] } {
  const fences: Fence[] = [];
  const fenced: boolean[] = new Array(lines.length).fill(false);
  let cur: Fence | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (cur) {
      fenced[i] = true;
      const c = lines[i].match(FENCE_CLOSE);
      if (c && c[1][0] === cur.char && c[1].length >= cur.len) { cur.close = i; fences.push(cur); cur = null; }
      continue;
    }
    const m = lines[i].match(FENCE_OPEN);
    if (!m) continue;
    if (m[2][0] === "`" && m[3].includes("`")) continue; // inline code that starts a line, not a fence
    cur = { open: i, close: -1, char: m[2][0], len: m[2].length, indent: m[1], gap: m[3].match(/^\s*/)![0], info: m[3].trim() };
    fenced[i] = true;
  }
  // An unclosed fence swallows the rest of the file and is not an exhibit.
  return { fences, fenced };
}

// ── Attribute handling ────────────────────────────────────────────────────────

interface AttrSpan { name: string; value: string | null; start: number; end: number }

/** Attributes of an info string that starts with `ask`; quoted values are consumed whole. */
function attrSpans(info: string): AttrSpan[] {
  const re = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/g;
  re.lastIndex = 3; // past "ask"
  const out: AttrSpan[] = [];
  for (let m = re.exec(info); m; m = re.exec(info)) {
    out.push({ name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? null, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const attrOf = (spans: AttrSpan[], name: string): string | null => spans.find((a) => a.name === name)?.value ?? null;

/** Sets name="value" on an info string, replacing the attribute where it sits or appending it. */
function setAttr(info: string, name: string, value: string): string {
  const hit = attrSpans(info).find((a) => a.name === name);
  const rendered = `${name}="${value}"`;
  return hit ? info.slice(0, hit.start) + rendered + info.slice(hit.end) : `${info} ${rendered}`;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

const OPTION_LINE = /^(\(x\)|\( \)|\[x\]|\[ \])\s+(.+)$/i;
const CRITERION_LINE = /^\s*[-*]\s+\[[ xX]\]\s+(?:\*\*)?(ISC-\d+(?:\.\d+)*)\b/;

/** The same Unicode slug ISARender.renderAsk gives a label-only option. */
const slugOf = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

function parseRaw(text: string): { lines: string[]; fenced: boolean[]; asks: RawAsk[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const { fences, fenced } = scanFences(lines);
  const byOpen = new Map(fences.map((f) => [f.open, f]));
  const asks: RawAsk[] = [];
  let under: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const f = byOpen.get(i);
    if (!f) {
      if (!fenced[i]) { const c = lines[i].match(CRITERION_LINE); if (c) under = c[1]; }
      continue;
    }
    if (/^ask(\s|$)/.test(f.info)) asks.push(buildAsk(lines, f, asks.length + 1, under));
    i = f.close; // skip the body
  }
  return { lines, fenced, asks };
}

function buildAsk(lines: string[], f: Fence, ordinal: number, under: string | null): RawAsk {
  const spans = attrSpans(f.info);
  const question: string[] = [];
  const options: AskOption[] = [];
  const optionIdx: number[] = [];
  const used = new Set<string>();
  let controls = 0;
  for (let j = f.open + 1; j < f.close; j++) {
    const line = lines[j].trim();
    if (!line) continue;
    const opt = line.match(OPTION_LINE);
    if (opt) {
      const [valueOrLabel, label, note] = opt[2].split("|").map((x) => x.trim());
      let value = label === undefined ? slugOf(valueOrLabel) : valueOrLabel;
      if (!value) value = `option-${controls + 1}`;
      for (let n = 2, base = value; used.has(value); n++) value = `${base}-${n}`;
      used.add(value);
      options.push({ value, label: label ?? valueOrLabel, note: note ?? "", picked: /x/i.test(opt[1]) });
      optionIdx.push(j);
      controls++;
    } else if (/^text:/i.test(line)) {
      controls++;
    } else if (!controls) {
      question.push(line);
    }
  }
  const status = (attrOf(spans, "status") ?? "").trim().toLowerCase();
  return {
    id: attrOf(spans, "id") || `ask-${ordinal}`,
    question: question.join(" "),
    options,
    multi: lines.slice(f.open + 1, f.close).some((l) => /^\s*\[[ xX]\]\s/.test(l)),
    defaults: options.filter((o) => o.picked).map((o) => o.value),
    status: STATUSES.has(status) ? (status as AskStatus) : "open",
    blocks: (attrOf(spans, "blocks") ?? "").split(/[\s,]+/).filter(Boolean),
    raisedBy: attrOf(spans, "raised-by"),
    lookedUp: attrOf(spans, "looked-up"),
    answered: attrOf(spans, "answered"),
    under,
    line: f.open + 1,
    openIdx: f.open,
    closeIdx: f.close,
    optionIdx,
    fence: f,
  };
}

/** Every top-level `ask` fence in file order. A fence nested inside another fence is not an ask. */
export function parseAsks(text: string): Ask[] {
  return parseRaw(text).asks.map(({ openIdx, closeIdx, optionIdx, fence, ...ask }) => ask);
}

/** The queue as a reader wants it: `open` keeps only open asks, blocking ones first. */
export function listAsks(text: string, opts: { open?: boolean } = {}): Ask[] {
  const asks = parseAsks(text);
  if (!opts.open) return asks;
  const open = asks.filter((a) => a.status === "open");
  return [...open.filter((a) => a.blocks.length), ...open.filter((a) => !a.blocks.length)];
}

// ── Section helpers (fence-aware) ─────────────────────────────────────────────

const H2 = /^##\s+\S/;
const LOG_HEADING = /^##\s+Articulation Log\s*$/;
const DECISIONS_HEADING = /^##\s+Decisions\s*$/;

const unfencedIdx = (lines: string[], fenced: boolean[], re: RegExp): number[] =>
  lines.flatMap((l, i) => (!fenced[i] && re.test(l) ? [i] : []));

/** Index of the last `## Articulation Log` heading, or -1. */
function logIndex(lines: string[], fenced: boolean[]): number {
  const all = unfencedIdx(lines, fenced, LOG_HEADING);
  return all.length ? all[all.length - 1] : -1;
}

/** True when no `## ` heading follows line `idx`. */
const isLastSection = (lines: string[], fenced: boolean[], idx: number): boolean =>
  !unfencedIdx(lines, fenced, H2).some((i) => i > idx);

// ── Time ──────────────────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, "0");

function nowParts(now?: string): { date: string; hhmm: string } {
  if (now === undefined) {
    const d = new Date();
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  const m = now.trim().match(/^((\d{4})-(\d{2})-(\d{2}))(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) throw new AsksRefusal(`--now is not an ISO date or time: ${now}`);
  const [y, mo, d] = [Number(m[2]), Number(m[3]), Number(m[4])];
  const cal = new Date(Date.UTC(y, mo - 1, d));
  const real = cal.getUTCFullYear() === y && cal.getUTCMonth() === mo - 1 && cal.getUTCDate() === d;
  if (!real || (m[5] !== undefined && (Number(m[5]) > 23 || Number(m[6]) > 59))) {
    throw new AsksRefusal(`--now is not a real calendar date or time: ${now}`);
  }
  return { date: m[1], hhmm: m[5] ? `${m[5]}:${m[6]}` : "00:00" };
}

// ── Writing ───────────────────────────────────────────────────────────────────

function canonical(path: string): string | null {
  try { return realpathSync(resolve(path)); } catch { return null; }
}

function atomicWrite(path: string, content: string): void {
  invariant(content.length > 0, "refusing to write an empty ISA");
  const tmp = join(dirname(path), `.${basename(path)}.isaasks-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    chmodSync(tmp, statSync(path).mode & 0o777);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp never created or already renamed */ }
    throw err;
  }
}

/**
 * `before` is the file as it sits on disk; `text` is the same content with CRLF folded to LF, which is
 * what every parser and writer here works on. `crlf` tells commit to put the CRLFs back.
 */
function load(isaPath: string, forWrite = false): { real: string; before: string; text: string; crlf: boolean } {
  const real = canonical(isaPath);
  if (!real || !existsSync(real)) throw new AsksRefusal(`ISA not found: ${isaPath}`);
  const before = readFileSync(real, "utf8");
  const crlf = before.includes("\r\n");
  if (forWrite && crlf && before.replace(/\r\n/g, "").includes("\n")) {
    throw new AsksRefusal("the ISA mixes CRLF and LF line endings; make them consistent before writing");
  }
  return { real, before, text: crlf ? before.replace(/\r\n/g, "\n") : before, crlf };
}

/** The one place a changed ISA reaches disk: the file must still be what we read. */
function commit(real: string, before: string, afterText: string, crlf: boolean): void {
  const after = crlf ? afterText.replace(/\n/g, "\r\n") : afterText;
  invariant(after !== before, "commit called with no change");
  invariant(readFileSync(real, "utf8") === before, `ISA changed on disk while writing: ${real}`);
  atomicWrite(real, after);
}

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** Rewrites the fence opener's info string and returns the new line. */
function openerWith(lines: string[], ask: RawAsk, edits: Array<[string, string]>): string {
  let info = ask.fence.info;
  for (const [name, value] of edits) info = setAttr(info, name, value);
  const cr = lines[ask.openIdx].endsWith("\r") ? "\r" : "";
  return `${ask.fence.indent}${ask.fence.char.repeat(ask.fence.len)}${ask.fence.gap}${info}${cr}`;
}

/**
 * Splits a --value string on commas, except where a comma belongs to an option's own value
 * ("1,000"). Longest run of pieces that names an option wins; a piece that names none is kept
 * as is so answerAsk refuses it by name.
 */
export function splitValues(raw: string, optionValues: string[]): string[] {
  const parts = raw.split(",");
  const out: string[] = [];
  for (let i = 0; i < parts.length;) {
    let took = 1;
    for (let j = parts.length; j > i + 1; j--) {
      if (optionValues.includes(parts.slice(i, j).join(",").trim())) { took = j - i; break; }
    }
    out.push(parts.slice(i, i + took).join(","));
    i += took;
  }
  return out;
}

// ── answer ────────────────────────────────────────────────────────────────────

export interface AnswerOptions {
  id: string;
  values: string[];
  note?: string;
  source?: string;
  now?: string;
}

export interface AnswerResult {
  isa: string;
  id: string;
  values: string[];
  labels: string[];
  status: "answered";
  answered: string;
  source: string;
}

function answerEntry(ask: Ask, picked: AskOption[], source: string, note: string | undefined): string[] {
  const out: string[] = [];
  const blocks = ask.blocks.length ? ` (blocks ${ask.blocks.join(" ")})` : "";
  out.push(`- Ask ${ask.id}${blocks}: ${ask.question}`);
  out.push(`- Answer: ${picked.map((o) => `${o.value} · ${o.label}`).join("; ")}`);
  out.push(`- Source: ${source}`);
  const verbatim = note?.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (verbatim && verbatim.trim()) {
    out.push("- Note, verbatim:");
    for (const l of verbatim.split("\n")) out.push(l === "" ? "  >" : `  > ${l}`);
  }
  return out;
}

export function answerAsk(isaPath: string, opts: AnswerOptions): AnswerResult {
  const { real, before, text: beforeText, crlf } = load(isaPath, true);
  const { date, hhmm } = nowParts(opts.now);
  const source = opts.source ?? "terminal";
  if (!SOURCES.has(source)) throw new AsksRefusal(`--source must be one of ${[...SOURCES].join(", ")}; got "${source}"`);

  const parsed = parseRaw(beforeText);
  const known = parsed.asks.map((a) => a.id);
  const hits = parsed.asks.filter((a) => a.id === opts.id);
  if (hits.length === 0) throw new AsksRefusal(`no ask with id "${opts.id}" (asks here: ${known.join(", ") || "none"})`);
  if (hits.length > 1) throw new AsksRefusal(`${hits.length} asks share the id "${opts.id}"; rename one before answering`);
  const ask = hits[0];

  const values = opts.values.map((v) => v.trim()).filter(Boolean);
  if (!values.length) throw new AsksRefusal(`ask "${ask.id}" needs a --value (one of: ${ask.options.map((o) => o.value).join(", ")})`);
  if (new Set(values).size !== values.length) throw new AsksRefusal(`--value repeats an option: ${values.join(",")}`);
  const unknown = values.filter((v) => !ask.options.some((o) => o.value === v));
  if (unknown.length) throw new AsksRefusal(`ask "${ask.id}" has no option "${unknown.join('", "')}" (options: ${ask.options.map((o) => o.value).join(", ")})`);
  if (!ask.multi && values.length !== 1) throw new AsksRefusal(`ask "${ask.id}" is single choice; got ${values.length} values (${values.join(",")})`);

  const logIdx = logIndex(parsed.lines, parsed.fenced);
  if (logIdx >= 0 && !isLastSection(parsed.lines, parsed.fenced, logIdx)) throw new AsksRefusal("## Articulation Log is not the last section; fix the ISA before answering");
  if (logIdx >= 0 && ask.openIdx > logIdx) throw new AsksRefusal(`ask "${ask.id}" sits inside the Articulation Log, which is append-only`);

  // 1. The fence: opener attributes and option markers, nothing else on the page.
  const lines2 = parsed.lines.slice();
  lines2[ask.openIdx] = openerWith(parsed.lines, ask, [["status", "answered"], ["answered", date]]);
  const editable = new Set<number>([ask.openIdx, ...ask.optionIdx]);
  ask.options.forEach((o, k) => {
    const idx = ask.optionIdx[k];
    const m = parsed.lines[idx].match(/^(\s*)(\(x\)|\( \)|\[x\]|\[ \])(\s+\S.*)$/i);
    invariant(m, `option line ${idx + 1} no longer parses as an option`);
    const on = values.includes(o.value);
    const marker = m[2][0] === "(" ? (on ? "(x)" : "( )") : on ? "[x]" : "[ ]";
    lines2[idx] = `${m[1]}${marker}${m[3]}`;
  });

  // 2. The Articulation Log: append only.
  const picked = ask.options.filter((o) => values.includes(o.value));
  const entry = answerEntry(ask, picked, source, opts.note);
  invariant(entry.every((l) => !/^\s*#/.test(l)), "an Articulation Log line would start with #");
  let text = lines2.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  const header = `### ${date} ${hhmm} · refine`;
  let reuse = false;
  if (logIdx >= 0) {
    const blockHeads = unfencedIdx(lines2, parsed.fenced, /^###\s/).filter((i) => i > logIdx);
    const last = blockHeads.length ? lines2[blockHeads[blockHeads.length - 1]] : "";
    const m = last.match(/^###\s+(\d{4}-\d{2}-\d{2})\b.*·\s*refine/);
    reuse = !!m && m[1] === date;
    if (!text.endsWith("\n\n")) text += "\n";
    if (!reuse) text += `${header}\n\n`;
  } else {
    if (!text.endsWith("\n\n")) text += "\n";
    text += `## Articulation Log\n\n${header}\n\n`;
  }
  const after = `${text}${entry.join("\n")}\n`;

  // 3. Invariants before the write.
  const reparsed = parseRaw(after);
  const mine = reparsed.asks.filter((a) => a.id === ask.id);
  invariant(mine.length === 1, `ask "${ask.id}" must still exist exactly once`);
  invariant(mine[0].status === "answered" && mine[0].answered === date, `ask "${ask.id}" must end answered on ${date}`);
  invariant(sameSet(mine[0].defaults, values), `ask "${ask.id}" picks must equal the chosen values`);
  invariant(ask.multi || mine[0].defaults.length === 1, "a single-choice ask must end with exactly one pick");
  invariant(mine[0].options.length === ask.options.length, "answer must not add or drop options");
  invariant(reparsed.asks.length === parsed.asks.length, "answer must not add or drop asks");
  const newLogIdx = logIndex(reparsed.lines, reparsed.fenced);
  invariant(newLogIdx >= 0, "the Articulation Log must exist after an answer");
  invariant(isLastSection(reparsed.lines, reparsed.fenced, newLogIdx), "the Articulation Log must stay the last section");
  if (logIdx >= 0) {
    invariant(reparsed.lines.slice(newLogIdx).join("\n").startsWith(parsed.lines.slice(logIdx).join("\n")), "earlier Articulation Log lines must stay byte-identical");
  }
  // Without a Log the old file keeps every real line; its final "" is just the trailing newline.
  const realLines = parsed.lines.length - (parsed.lines[parsed.lines.length - 1] === "" ? 1 : 0);
  const untouchedUpTo = logIdx >= 0 ? logIdx : realLines;
  for (let i = 0; i < untouchedUpTo; i++) {
    invariant(editable.has(i) || reparsed.lines[i] === parsed.lines[i], `line ${i + 1} changed outside the ask fence`);
  }

  commit(real, before, after, crlf);
  return { isa: real, id: ask.id, values, labels: picked.map((o) => o.label), status: "answered", answered: date, source };
}

// ── settle ────────────────────────────────────────────────────────────────────

export interface SettleResult {
  isa: string;
  settled: string[];
  wrote: boolean;
}

export function settleAsks(isaPath: string, opts: { now?: string } = {}): SettleResult {
  const { real, before, text: beforeText, crlf } = load(isaPath, true);
  const { date } = nowParts(opts.now);
  const parsed = parseRaw(beforeText);
  const open = parsed.asks.filter((a) => a.status === "open");
  if (!open.length) return { isa: real, settled: [], wrote: false };

  const logAt = logIndex(parsed.lines, parsed.fenced);
  const inLog = logAt >= 0 ? open.filter((a) => a.openIdx > logAt) : [];
  if (inLog.length) throw new AsksRefusal(`ask "${inLog[0].id}" sits inside the Articulation Log, which is append-only; move or close it before settling`);
  if (logAt >= 0 && unfencedIdx(parsed.lines, parsed.fenced, DECISIONS_HEADING).some((i) => i > logAt)) {
    throw new AsksRefusal("## Decisions sits after the append-only Articulation Log; fix the ISA before settling");
  }

  // 1. Stamp each open ask; the pick stays.
  const lines2 = parsed.lines.slice();
  for (const a of open) lines2[a.openIdx] = openerWith(parsed.lines, a, [["status", "default-unratified"]]);

  // 2. One Decisions bullet per ask.
  const bullets = open.map((a) => {
    const picked = a.options.filter((o) => o.picked);
    const taken = picked.length ? `took the default ${picked.map((o) => `"${o.label}"`).join(", ")}` : "had no default pick";
    return `- ${date}: default-unratified: ask ${a.id} ${taken}; the principal did not answer it, so it is not their agreement.`;
  });
  const lines3 = insertDecisions(lines2, bullets);
  let after = lines3.join("\n");
  if (!after.endsWith("\n")) after += "\n";

  // 3. Invariants before the write.
  const reparsed = parseRaw(after);
  invariant(reparsed.asks.length === parsed.asks.length, "settle must not add or drop asks");
  invariant(reparsed.asks.every((a, k) => a.id === parsed.asks[k].id && sameSet(a.defaults, parsed.asks[k].defaults)), "settle must keep every ask's id and pick");
  invariant(!reparsed.asks.some((a) => a.status === "open"), "no ask may stay open after settle");
  invariant(reparsed.asks.filter((a) => a.status === "default-unratified").length >= open.length, "every open ask must end default-unratified");
  const decIdx = unfencedIdx(reparsed.lines, reparsed.fenced, DECISIONS_HEADING);
  invariant(decIdx.length > 0, "a Decisions section must exist after settle");
  invariant(bullets.every((b) => reparsed.lines.includes(b)), "every settled ask needs its Decisions bullet");
  const oldLog = logIndex(parsed.lines, parsed.fenced);
  const newLog = logIndex(reparsed.lines, reparsed.fenced);
  invariant((oldLog >= 0) === (newLog >= 0), "settle must not add or remove the Articulation Log");
  if (oldLog >= 0) {
    invariant(reparsed.lines.slice(newLog).join("\n").startsWith(parsed.lines.slice(oldLog).join("\n")), "the Articulation Log must stay byte-identical");
    if (isLastSection(parsed.lines, parsed.fenced, oldLog)) invariant(isLastSection(reparsed.lines, reparsed.fenced, newLog), "the Articulation Log must stay the last section");
  }

  commit(real, before, after, crlf);
  return { isa: real, settled: open.map((a) => a.id), wrote: true };
}

/** Adds bullets to `## Decisions`; creates the section just before the Log (or at the end). */
function insertDecisions(lines: string[], bullets: string[]): string[] {
  const { fenced } = scanFences(lines);
  const out = lines.slice();
  const dec = unfencedIdx(lines, fenced, DECISIONS_HEADING);
  if (dec.length) {
    const head = dec[dec.length - 1];
    const next = unfencedIdx(lines, fenced, H2).find((i) => i > head) ?? lines.length;
    let last = head;
    for (let i = head + 1; i < next; i++) if (lines[i].trim()) last = i;
    const ins = last === head ? ["", ...bullets] : bullets.slice();
    if (last + 1 < lines.length && lines[last + 1].trim()) ins.push(""); // a heading follows directly
    out.splice(last + 1, 0, ...ins);
    return out;
  }
  const log = logIndex(lines, fenced);
  if (log >= 0) {
    const block = ["## Decisions", "", ...bullets, ""];
    if (log > 0 && lines[log - 1].trim()) block.unshift("");
    out.splice(log, 0, ...block);
    return out;
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  out.push("", "## Decisions", "", ...bullets, "");
  return out;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const USAGE = [
  "usage: IsaAsks.ts list   <isa> [--open] [--json]",
  "       IsaAsks.ts answer <isa> --id <id> --value <v>[,<v>] [--note \"<verbatim>\"] [--source terminal|relay|pulse|voice] [--now <ISO>] [--json]",
  "       IsaAsks.ts settle <isa> [--now <ISO>] [--json]",
].join("\n");

const BOOLEAN_FLAGS = new Set(["--json", "--open"]);
const VALUE_FLAGS = new Set(["--id", "--value", "--note", "--source", "--now"]);

export function main(argv: string[]): number {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOLEAN_FLAGS.has(a)) flags.set(a, true);
    else if (VALUE_FLAGS.has(a)) { flags.set(a, argv[i + 1] ?? ""); i++; }
    else if (a.startsWith("--")) { console.error(`unknown flag ${a}\n${USAGE}`); return 2; }
    else positional.push(a);
  }
  const json = flags.has("--json");
  const [sub, isa] = positional;
  if (!sub || !isa || positional.length > 2) { console.error(USAGE); return 2; }
  const str = (f: string): string | undefined => { const v = flags.get(f); return typeof v === "string" ? v : undefined; };
  const refuse = (reason: string): number => {
    if (json) console.log(JSON.stringify({ ok: false, refused: true, reason }));
    else console.error(`IsaAsks refused: ${reason}`);
    return 2;
  };
  try {
    if (sub === "list") {
      const { real, text } = load(isa);
      const asks = listAsks(text, { open: flags.has("--open") });
      if (json) console.log(JSON.stringify({ isa: real, count: asks.length, asks: asks.map((a) => ({ ...a, default: a.defaults[0] ?? null })) }));
      else if (!asks.length) console.log(flags.has("--open") ? "no open asks" : "no asks");
      else for (const a of asks) {
        console.log(`${a.id} · ${a.status}${a.under ? ` · under ${a.under}` : ""}${a.blocks.length ? ` · blocks ${a.blocks.join(" ")}` : ""} · default ${a.defaults.join(",") || "none"} · line ${a.line}`);
        console.log(`  ${a.question}`);
      }
      return 0;
    }
    if (sub === "answer") {
      const id = str("--id");
      const value = str("--value");
      if (!id || value === undefined) return refuse("answer needs --id and --value");
      const known = parseAsks(load(isa).text).find((a) => a.id === id);
      const values = known ? splitValues(value, known.options.map((o) => o.value)) : value.split(",");
      const r = answerAsk(isa, { id, values, note: str("--note"), source: str("--source"), now: str("--now") });
      if (json) console.log(JSON.stringify({ ok: true, ...r }));
      else console.log(`answered ${r.id}: ${r.values.map((v, k) => `${v} (${r.labels[k]})`).join("; ")} · ${r.answered} · logged`);
      return 0;
    }
    if (sub === "settle") {
      const r = settleAsks(isa, { now: str("--now") });
      if (json) console.log(JSON.stringify({ ok: true, ...r }));
      else console.log(r.wrote ? `settled ${r.settled.length}: ${r.settled.join(", ")} · default-unratified` : "no open asks · nothing to settle");
      return 0;
    }
    console.error(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof AsksRefusal) return refuse(e.message);
    throw e; // an InvariantViolation or I/O failure fails loud
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
