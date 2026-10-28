#!/usr/bin/env bun
/**
 * UltracodeState.ts — is ultracode on for this session?
 *
 * The statusline stdin reports ultracode as effort `xhigh` and nothing else carries it
 * (public issue #2168), so the state is read from the session transcript:
 *   - attachment rows `ultra_effort_enter` (on) and `ultra_effort_exit` (off), which the
 *     engine writes while ultracode stays on and when it ends;
 *   - the `/effort` command's output row, `<local-command-stdout>Ultracode on …` or the
 *     older `Set effort level to ultracode …` (on) and `Ultracode off …` (off), which lands
 *     before the next turn's attachment.
 * The last decisive row wins; no decisive row reads off. Rows are matched by structure,
 * never by text anywhere in the line, so a tool result quoting these strings changes nothing.
 *
 * The cached reader keeps a byte offset per transcript under MEMORY/STATE/ultracode/ and
 * reads only what was appended since, because the statusline asks every few seconds.
 *
 * CLI:  bun UltracodeState.ts <transcript.jsonl>      prints `on` or `off`
 *       bun UltracodeState.ts --session <session-id>  finds the transcript under projects/
 * FUNCTIONHOOKS ISA F10 (ISC-101..113).
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { invariant } from "./Invariant";
import { getClaudeDir } from "./Paths";
import { readSessionShape } from "../ROUTER/Shape";

const CLAUDE_DIR = getClaudeDir();
const CACHE_DIR = process.env.ULTRACODE_STATE_DIR || join(CLAUDE_DIR, "LIFEOS", "MEMORY", "STATE", "ultracode");

/** One transcript row's verdict: true (on), false (off), null (says nothing). */
export function rowVerdict(row: unknown): boolean | null {
  if (!row || typeof row !== "object") return null;
  const r = row as { type?: string; attachment?: { type?: string }; message?: { role?: string; content?: unknown } };
  const at = r.attachment?.type;
  if (at === "ultra_effort_enter") return true;
  if (at === "ultra_effort_exit") return false;
  if (r.type === "user" && typeof r.message?.content === "string") {
    const c = r.message.content;
    if (!c.startsWith("<local-command-stdout>")) return null;
    const body = c.slice("<local-command-stdout>".length);
    if (/^(Ultracode on\b|Set effort level to ultracode\b)/.test(body)) return true;
    if (/^Ultracode off\b/.test(body)) return false;
  }
  return null;
}

/** Folds JSONL text onto a starting state; the last decisive row wins. */
export function ultracodeFromRows(text: string, start = false): boolean {
  let on = start;
  for (const line of text.split("\n")) {
    // Cheap prefilter: only lines that could be decisive are parsed.
    if (!line.includes("ultra_effort_") && !line.includes("<local-command-stdout>")) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    const v = rowVerdict(row);
    if (v !== null) on = v;
  }
  return on;
}

interface CacheRow { path: string; offset: number; on: boolean }

function cachePath(transcript: string): string {
  return join(CACHE_DIR, createHash("sha1").update(transcript).digest("hex").slice(0, 16) + ".json");
}

/** Reads the transcript from the cached offset; rescans when the file shrank. Off when the file is missing. */
export function ultracodeFromTranscript(transcript: string): boolean {
  if (!transcript || !existsSync(transcript)) return false;
  const size = statSync(transcript).size;
  const cp = cachePath(transcript);
  let cache: CacheRow = { path: transcript, offset: 0, on: false };
  try {
    const c = JSON.parse(readFileSync(cp, "utf8")) as CacheRow;
    if (c.path === transcript && Number.isInteger(c.offset) && c.offset >= 0 && c.offset <= size) cache = c;
  } catch { /* first read or bad cache: scan from the start */ }
  if (cache.offset === size) return cache.on;
  const len = size - cache.offset;
  const buf = Buffer.alloc(len);
  const fd = openSync(transcript, "r");
  try { readSync(fd, buf, 0, len, cache.offset); } finally { closeSync(fd); }
  // Only whole lines: a row still being written is read next time.
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return cache.on;
  const on = ultracodeFromRows(buf.subarray(0, lastNl + 1).toString("utf8"), cache.on);
  const next: CacheRow = { path: transcript, offset: cache.offset + lastNl + 1, on };
  invariant(next.offset <= size && next.offset > cache.offset, `ultracode cache offset must advance within the file (prev ${cache.offset}, next ${next.offset}, size ${size})`);
  try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(cp, JSON.stringify(next)); } catch { /* read-only state dir: answer anyway */ }
  return on;
}

/** The transcript for a session id: projects/<any>/<sid>.jsonl. */
export function transcriptForSession(sid: string): string | null {
  if (!/^[0-9a-f-]{8,}$/i.test(sid)) return null;
  const root = join(CLAUDE_DIR, "projects");
  try {
    for (const d of readdirSync(root)) {
      const p = join(root, d, `${sid}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch { /* no projects dir */ }
  return null;
}

/**
 * On when the principal's `uc`/`u` shortcut set it in the session-shape file (Router F7) or the engine's own rows say
 * so. `/uc` cannot run `/effort ultracode`, so a transcript-only read missed every `uc` session in the prompt footer
 * while the statusline, which reads both, showed it (principal directive, 2026-10-15).
 */
export function ultracodeForSession(sid: string): boolean {
  if (readSessionShape(sid).ultracode) return true;
  const t = transcriptForSession(sid);
  return t ? ultracodeFromTranscript(t) : false;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const on = a[0] === "--session" ? ultracodeForSession(a[1] ?? "") : ultracodeFromTranscript(a[0] ?? "");
  process.stdout.write(on ? "on\n" : "off\n");
}
