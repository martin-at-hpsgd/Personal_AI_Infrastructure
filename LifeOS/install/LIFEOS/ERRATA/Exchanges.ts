#!/usr/bin/env bun
/**
 * Exchanges.ts — every prompt the principal typed in an interactive session, with its context (Errata v4, ISC-39).
 *
 *   bun LIFEOS/ERRATA/Exchanges.ts [--root DIR] [--full] [--dry-run]
 *   bun LIFEOS/ERRATA/Errata.ts exchanges [same flags]
 *
 * One exchange = one typed prompt plus what it reacted to: the tail of the assistant's reply since
 * the principal's previous ask, that previous ask, and the last three tool calls the assistant made
 * in that reply. The typed-prompt filter is the router's `typedText` (entrypoint "cli", promptSource
 * typed/queued/suggestion_accepted, no sidechain, no meta, no harness notice), imported so both
 * systems read one definition of "the principal typed this".
 *
 * Transcripts are streamed in chunks: readline hung twice at 0% CPU on the 11 GB corpus (Mine.ts,
 * 2026-09-17). Unchanged files (same size and mtime) are skipped; a changed file is re-read from
 * the start because the context window needs its earlier rows, and ids dedupe the rest, so a rerun
 * appends zero. The id is a hash of the transcript row's uuid, which a resumed session copies
 * unchanged, so a prompt carried into a resumed session collapses onto its first sighting.
 *
 * `captured` joins each exchange to the existing ledger: same session id and either the same
 * prompt text (normalized) or an erratum stamped within CAPTURE_WINDOW_MS after the prompt and
 * before the session's next typed prompt. Mined rows carry the prompt's own timestamp (median
 * delta 0 s on the real ledger); hook rows land within 9 s; rating-backfill summaries within ~13 s.
 * A 90 s window matched a later prompt's complaint onto the one before it, hence 30 s plus the
 * next-prompt bound.
 *
 * Output is private and lives only under LIFEOS/USER/ERRATA/v4/ (the USER repo).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { invariant, InvariantViolation } from "../TOOLS/Invariant";
import { getClaudeDir } from "../TOOLS/Paths";
import { contextTail, typedText } from "../ROUTER/RealPrompts";
import { ERRATA_DIR, ErrataStore } from "./Store";
import type { Erratum, ToolCallSummary } from "./Schema";

export type Exchange = {
  id: string;
  ts: string;
  session: string;
  prompt: string;
  /** The end of everything the assistant wrote since the previous typed prompt; "" on a session's first prompt. */
  reply_tail: string;
  /** The principal's previous typed prompt in this session, head-clipped; "" when none. */
  prior_ask: string;
  /** The last three tool calls of the assistant's reply to the previous ask, oldest first. */
  tools: ToolCallSummary[];
  /** The existing ledger already holds an erratum for this turn. */
  captured: boolean;
};

export type ExtractResult = {
  files: number;
  skipped_unchanged: number;
  typed_prompts: number;
  appended: number;
  duplicates: number;
  captured: number;
  capture_by_text: number;
  capture_by_time: number;
  bad_lines: number;
  errors: number;
};

const MAX_PROMPT = 4000;
const MAX_PRIOR = 400;
const REPLY_TAIL = 800;
const TOOL_SUMMARY = 160;
/** An erratum stamped this long after (or 5 s before) a prompt, in the same session and before the next prompt, is that prompt's capture. */
export const CAPTURE_WINDOW_MS = 30_000;
const CAPTURE_LEAD_MS = 5_000;

export function v4Dir(): string {
  return process.env.ERRATA_V4_DIR || join(ERRATA_DIR, "v4");
}
export const exchangesPath = (dir = v4Dir()): string => join(dir, "exchanges.jsonl");
const statePath = (dir: string): string => join(dir, "exchanges-state.json");
const PROJECTS_ROOT = join(getClaudeDir(), "projects");

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Stable exchange id: the transcript row's uuid when present, else session + timestamp + text. */
export function exchangeId(row: Record<string, unknown>, text: string): string {
  const basis = typeof row.uuid === "string" && row.uuid ? `uuid:${row.uuid}` : `row:${String(row.sessionId ?? "")}:${String(row.timestamp ?? "")}:${text}`;
  return `X-${sha(basis).slice(0, 16)}`;
}

function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("\n");
}

function toolSummary(block: Record<string, unknown>): ToolCallSummary {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? input.prompt ?? "";
  return { name: String(block.name ?? "?"), summary: String(pick).replace(/\s+/g, " ").trim().slice(0, TOOL_SUMMARY) };
}

export function clipHead(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)} …` : t;
}

/** Normalized prompt text for the capture join: whitespace collapsed, first 200 chars. */
export function captureKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);
}

export type CaptureIndex = Map<string, { tsMs: number; key: string }[]>;

/** Session-keyed index of the ledger for the capture join. Pure. */
export function captureIndex(errata: Erratum[]): CaptureIndex {
  const idx: CaptureIndex = new Map();
  for (const e of errata) {
    const sid = e.context?.session_id;
    if (!sid) continue;
    const list = idx.get(sid) ?? [];
    list.push({ tsMs: Date.parse(e.ts), key: captureKey(e.complaint ?? "") });
    idx.set(sid, list);
  }
  return idx;
}

/** How an exchange joins the ledger: by identical text, by timestamp window, or not at all. Pure. */
export function captureMatch(ex: Pick<Exchange, "session" | "ts" | "prompt">, idx: CaptureIndex, nextPromptMs = Infinity): "text" | "time" | null {
  const rows = idx.get(ex.session);
  if (!rows) return null;
  const key = captureKey(ex.prompt);
  if (key && rows.some((r) => r.key === key)) return "text";
  const t = Date.parse(ex.ts);
  if (!Number.isFinite(t)) return null;
  const end = Math.min(t + CAPTURE_WINDOW_MS, nextPromptMs - CAPTURE_LEAD_MS);
  return rows.some((r) => r.tsMs >= t - CAPTURE_LEAD_MS && r.tsMs <= end) ? "time" : null;
}

type Window = { replyParts: string[]; tools: ToolCallSummary[]; priorAsk: string };

/** Feed one transcript row through the context window; returns an exchange when the row is a typed prompt. Pure over `w`. */
export function stepRow(r: Record<string, unknown>, w: Window): Omit<Exchange, "captured"> | null {
  if (r.isSidechain) return null;
  if (r.type === "assistant") {
    const content = (r.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const b of content as Record<string, unknown>[]) {
        if (b?.type === "tool_use") { w.tools.push(toolSummary(b)); if (w.tools.length > 3) w.tools.shift(); }
      }
    }
    const text = textBlocks(content).trim();
    if (text) w.replyParts.push(text);
    return null;
  }
  const prompt = typedText(r);
  if (prompt === null) return null;
  const ts = typeof r.timestamp === "string" && Number.isFinite(Date.parse(r.timestamp)) ? new Date(r.timestamp).toISOString() : "";
  const session = typeof r.sessionId === "string" ? r.sessionId : "";
  const ex = {
    id: exchangeId(r, prompt),
    ts,
    session,
    prompt: prompt.length > MAX_PROMPT ? `${prompt.slice(0, MAX_PROMPT)} …` : prompt,
    reply_tail: contextTail(w.replyParts.join("\n"), REPLY_TAIL),
    prior_ask: clipHead(w.priorAsk, MAX_PRIOR),
    tools: [...w.tools],
  };
  w.replyParts = []; w.tools = []; w.priorAsk = prompt;
  return ex.ts && ex.session ? ex : null;
}

/** Stream one transcript and return its exchanges. Chunked reads, never readline. */
export async function exchangesOfFile(path: string): Promise<{ rows: Omit<Exchange, "captured">[]; badLines: number }> {
  const w: Window = { replyParts: [], tools: [], priorAsk: "" };
  const rows: Omit<Exchange, "captured">[] = [];
  let badLines = 0;
  const handle = (line: string): void => {
    // Only user and assistant rows move the window; skip parsing the rest (most of 11 GB).
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line); } catch { badLines++; return; }
    const ex = stepRow(r, w);
    if (ex) rows.push(ex);
  };
  const reader = Bun.file(path).stream().getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line) handle(line);
    }
  }
  buf += dec.decode();
  if (buf.trim()) handle(buf);
  return { rows, badLines };
}

/** Top-level session transcripts only: subagent transcripts live one level deeper and are never typed prompts. */
function sessionFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const p = join(root, dir.name);
    try {
      for (const f of readdirSync(p, { withFileTypes: true })) if (f.isFile() && f.name.endsWith(".jsonl")) out.push(join(p, f.name));
    } catch { /* unreadable project dir: skipped, never fatal */ }
  }
  return out.sort();
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((l) => {
    if (!l.trim()) return [];
    try { return [JSON.parse(l) as T]; } catch { return []; }
  });
}

export function loadExchanges(dir = v4Dir()): Exchange[] {
  return readJsonl<Exchange>(exchangesPath(dir));
}

export function validExchange(x: unknown): x is Exchange {
  if (!x || typeof x !== "object") return false;
  const e = x as Exchange;
  return /^X-[0-9a-f]{16}$/.test(e.id) && typeof e.session === "string" && e.session.length > 0 &&
    Number.isFinite(Date.parse(e.ts)) && typeof e.prompt === "string" && e.prompt.length > 0 &&
    typeof e.reply_tail === "string" && typeof e.prior_ask === "string" && Array.isArray(e.tools) && e.tools.length <= 3 &&
    typeof e.captured === "boolean";
}

export type ExtractOptions = { root?: string; dir?: string; full?: boolean; dryRun?: boolean; store?: ErrataStore };

export async function extract(opts: ExtractOptions = {}): Promise<ExtractResult> {
  const dir = opts.dir ?? v4Dir();
  const root = opts.root ?? PROJECTS_ROOT;
  const result: ExtractResult = { files: 0, skipped_unchanged: 0, typed_prompts: 0, appended: 0, duplicates: 0, captured: 0, capture_by_text: 0, capture_by_time: 0, bad_lines: 0, errors: 0 };
  const state: Record<string, { size: number; mtimeMs: number }> = !opts.full && existsSync(statePath(dir))
    ? JSON.parse(readFileSync(statePath(dir), "utf8")) : {};
  const seen = new Set(loadExchanges(dir).map((e) => e.id));
  const idx = captureIndex((opts.store ?? new ErrataStore()).all());
  const next = { ...state };
  if (!opts.dryRun) mkdirSync(dir, { recursive: true });
  const flush = (batch: Exchange[]): void => {
    if (opts.dryRun || !batch.length) return;
    for (const e of batch) invariant(validExchange(e), `invalid exchange row ${e.id}`);
    appendFileSync(exchangesPath(dir), batch.map((e) => JSON.stringify(e)).join("\n") + "\n");
  };
  const saveState = (): void => {
    if (opts.dryRun) return;
    const tmp = `${statePath(dir)}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, statePath(dir));
  };
  const files = sessionFiles(root);
  for (const [i, f] of files.entries()) {
    try {
      const st = statSync(f);
      // Keyed relative to the transcript root, so the state file carries no home path.
      const key = relative(root, f);
      const prev = state[key];
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) { result.skipped_unchanged++; continue; }
      result.files++;
      const { rows, badLines } = await exchangesOfFile(f);
      result.bad_lines += badLines; // a torn trailing line in a live transcript is normal, counted apart from errors
      const batch: Exchange[] = [];
      for (const [k, r] of rows.entries()) {
        result.typed_prompts++;
        if (seen.has(r.id)) { result.duplicates++; continue; }
        seen.add(r.id);
        const after = rows[k + 1];
        const how = captureMatch(r, idx, after && after.session === r.session ? Date.parse(after.ts) : Infinity);
        if (how === "text") result.capture_by_text++;
        if (how === "time") result.capture_by_time++;
        if (how) result.captured++;
        batch.push({ ...r, captured: how !== null });
      }
      flush(batch);
      result.appended += batch.length;
      next[key] = { size: st.size, mtimeMs: st.mtimeMs };
      if ((i + 1) % 500 === 0) { saveState(); process.stderr.write(`exchanges: ${i + 1}/${files.length} files\n`); }
    } catch (e) {
      if (e instanceof InvariantViolation) throw e;
      result.errors++;
      process.stderr.write(`exchanges: ${relative(root, f)}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  saveState();
  return result;
}

function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(args: string[]): Promise<number> {
  const r = await extract({ root: argVal(args, "--root"), full: args.includes("--full"), dryRun: args.includes("--dry-run") });
  console.log(JSON.stringify(r));
  return r.errors ? 1 : 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
