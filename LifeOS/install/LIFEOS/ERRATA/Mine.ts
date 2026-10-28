#!/usr/bin/env bun
/**
 * @version 1.0.0
 * Mine.ts — backfill Errata from session transcripts in ~/.claude/projects/.
 *
 * Streams JSONL files, maintains a rolling window (last response, last real user
 * prompt, last three tool calls), runs frustrationRead on every user text message,
 * and appends errata for firing signals. Resumable via a state file.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { createHash } from "crypto";
import { homedir } from "os";
import { invariant } from "../TOOLS/Invariant";
import { getClaudeDir } from "../TOOLS/Paths";
import { ErrataStore, stateDirFor } from "./Store";
import { frustrationRead } from "./Signals";
import type { NewErratum, ToolCallSummary } from "./Schema";

export interface MineOptions {
  root?: string;
  dryRun?: boolean;
  limitFiles?: number;
}

export interface MineResult {
  files: number;
  skipped_unchanged: number;
  user_turns: number;
  hits: number;
  appended: number;
  deduped: number;
  errors: number;
}

interface FileState {
  size: number;
  mtimeMs: number;
}

const PROJECTS_ROOT = join(getClaudeDir(), "projects");
/** The sweep's cursor: in the real state dir for the real ledger, inside the store for any other (Store.stateDirFor), so a sweep into a test ledger never marks real transcripts as read. */
const stateFileFor = (store: ErrataStore): string => join(stateDirFor(store), "mine-state.json");

const RELAY_REGEX = /<(task-notification|teammate-message|system-reminder|cross-session-message|agent-message)/;

function loadState(stateFile: string): Map<string, FileState> {
  if (!existsSync(stateFile)) return new Map();
  try {
    const data = JSON.parse(readFileSync(stateFile, "utf8"));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveState(stateFile: string, state: Map<string, FileState>): void {
  invariant([...state.values()].every((v) => Number.isFinite(v.size) && Number.isFinite(v.mtimeMs)), "mine cursor entries are size and mtime");
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(Object.fromEntries(state)), "utf8");
}

/** Recursively find all .jsonl files under root. */
function findJsonlFiles(root: string, limit?: number): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= (limit ?? Infinity)) return;
    try {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= (limit ?? Infinity)) break;
        const path = join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(path);
        } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
          out.push(path);
        }
      }
    } catch {
      /* skip inaccessible directories */
    }
  };
  walk(root);
  return out.sort();
}

interface WindowLine {
  type?: string;
  sessionId?: string;
  message?: { content?: unknown; model?: string };
  cwd?: string;
  timestamp?: string;
}

interface Window {
  lastResponse: { text: string; hash: string } | null;
  lastRequestedPrompt: string | null;
  lastThreeToolCalls: ToolCallSummary[];
  lastSessionId: string | null;
  lastModel: string | null;
  lastCwd: string | null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === "string" ? c : c?.type === "text" && c?.text ? c.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function toolSummary(block: any): ToolCallSummary {
  const input = block?.input ?? {};
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.prompt ?? input.description ?? "";
  return { name: String(block?.name ?? "?"), summary: String(pick).slice(0, 160) };
}

function responseHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function tildePath(p: string): string {
  const h = homedir();
  return p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

/** Process one line, update the rolling window, capture errata. */
async function processLine(
  line: string,
  window: Window,
  store: ErrataStore,
  dryRun: boolean,
  result: MineResult,
): Promise<void> {
  let e: WindowLine;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }

  if (typeof e.sessionId === "string") window.lastSessionId = e.sessionId;
  if (typeof e.cwd === "string") window.lastCwd = tildePath(e.cwd);

  if (e.type === "assistant" && e.message?.content) {
    if (typeof e.message?.model === "string") window.lastModel = e.message.model;
    const content = Array.isArray(e.message.content) ? e.message.content : [];
    // Rolling window of the latest three, oldest first. A `length < 3` guard once froze it on a file's first three calls.
    for (const b of content) {
      if (b?.type === "tool_use") {
        window.lastThreeToolCalls.push(toolSummary(b));
        if (window.lastThreeToolCalls.length > 3) window.lastThreeToolCalls.shift();
      }
    }
    const text = textOf(e.message.content);
    if (text) {
      window.lastResponse = { text, hash: responseHash(text) };
    }
  } else if (e.type === "user" && !e.message?.content?.some?.((b: any) => b?.type === "tool_result")) {
    const raw = e.message?.content;
    const text = typeof raw === "string" ? raw : textOf(raw);
    const isRelay = RELAY_REGEX.test(text) || /^\[SYSTEM NOTIFICATION/.test(text);
    if (text && !isRelay) {
      result.user_turns++;

      const read = frustrationRead(text);
      if (read.fires && window.lastResponse) {
        result.hits++;
        const dedupeSuffix = createHash("sha256").update(text.trim()).digest("hex").slice(0, 12);
        const dedupe_key = `transcript:${window.lastSessionId}:${dedupeSuffix}`;

        // The erratum keeps the moment it happened, never the sweep time; a first run once stamped every mined row with the sweep date.
        const lineTs = typeof e.timestamp === "string" && !Number.isNaN(Date.parse(e.timestamp)) ? new Date(e.timestamp).toISOString() : undefined;
        const input: NewErratum = {
          system: "lifeos",
          source: "backfill",
          channel: "backfill",
          ...(lineTs ? { ts: lineTs } : {}),
          kind: read.correction ? "correction" : "complaint",
          frustration: read.score,
          complaint: text,
          context: {
            requested: window.lastRequestedPrompt,
            response_preview: window.lastResponse?.text ?? null,
            response_hash: window.lastResponse?.hash ?? null,
            session_id: window.lastSessionId,
            doing: window.lastThreeToolCalls.length
              ? window.lastThreeToolCalls.map((c) => `${c.name}: ${c.summary}`).join(" · ")
              : null,
            cwd: window.lastCwd,
            model: window.lastModel,
            tool_calls: window.lastThreeToolCalls,
          },
          reporter: { id: "principal", role: "principal" },
          tags: ["transcript-mined", ...(lineTs && lineTs < "2026-08-17" ? ["pre-turn-anchoring"] : [])],
          dedupe_key,
        };
        if (!dryRun) {
          const appended = store.append(input);
          if (appended) result.appended++;
          else result.deduped++;
        } else {
          result.appended++;
        }
      } else if (!read.fires) {
        // Only update lastRequestedPrompt if this is NOT a complaint itself
        window.lastRequestedPrompt = text;
      }
    }
  }
}

/** Process one file, maintaining a rolling window. Plain chunked reads: readline's async iterator hung twice at 0% CPU mid-sweep (2026-09-17). */
async function processFile(
  filePath: string,
  startOffset: number,
  store: ErrataStore,
  dryRun: boolean,
  result: MineResult,
): Promise<void> {
  const window: Window = { lastResponse: null, lastRequestedPrompt: null, lastThreeToolCalls: [], lastSessionId: null, lastModel: null, lastCwd: null };
  const file = Bun.file(filePath);
  const blob = startOffset > 0 ? file.slice(startOffset) : file;
  const reader = blob.stream().getReader();
  const dec = new TextDecoder();
  let buf = "";
  const handle = async (line: string) => { try { await processLine(line, window, store, dryRun, result); } catch { result.errors++; } };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) await handle(line);
    }
  }
  buf += dec.decode();
  if (buf.trim()) await handle(buf);
}

export async function mine(store: ErrataStore, opts: MineOptions = {}): Promise<MineResult> {
  const root = opts.root ?? PROJECTS_ROOT;
  const dryRun = opts.dryRun ?? false;
  const limitFiles = opts.limitFiles;

  const result: MineResult = { files: 0, skipped_unchanged: 0, user_turns: 0, hits: 0, appended: 0, deduped: 0, errors: 0 };

  if (!existsSync(root)) {
    return result;
  }

  const files = findJsonlFiles(root, limitFiles);
  const stateFile = stateFileFor(store);
  const state = loadState(stateFile);
  const newState = new Map(state);

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    try {
      const stat = statSync(filePath);
      const currentEntry: FileState = { size: stat.size, mtimeMs: stat.mtimeMs };
      const previous = state.get(filePath);

      if (previous && previous.size === currentEntry.size && previous.mtimeMs === currentEntry.mtimeMs) {
        result.skipped_unchanged++;
        continue;
      }

      result.files++;

      // Re-read from the recorded size for a grown file; from 0 for a new file or changed mtime.
      const startOffset = previous && previous.mtimeMs === currentEntry.mtimeMs ? previous.size : 0;
      await processFile(filePath, startOffset, store, dryRun, result);
      newState.set(filePath, currentEntry);

      if ((i + 1) % 500 === 0) {
        process.stderr.write(`Progress: ${i + 1}/${files.length} files\n`);
      }
      if (!dryRun && (i + 1) % 200 === 0) saveState(stateFile, newState); // a killed run keeps its progress
    } catch (e) {
      result.errors++;
    }
  }

  if (!dryRun) {
    saveState(stateFile, newState);
  }

  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const root = (() => {
    const i = args.indexOf("--root");
    return i >= 0 ? args[i + 1] : undefined;
  })();
  const limitFiles = (() => {
    const i = args.indexOf("--limit-files");
    return i >= 0 ? Number(args[i + 1]) : undefined;
  })();

  const store = new ErrataStore();
  mine(store, { root, dryRun, limitFiles })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}
