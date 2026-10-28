/**
 * The per-turn row (STATVS ISA ISC-85, CENSVS ISA ISC-55): what a replay needs to put a human turn back together
 * and that the transcript does not hold. The transcript has what was said; this row ties that prompt to the exact
 * code, model and record as they stood when it was submitted.
 *
 * Written by hooks/TurnRecord.hook.ts on UserPromptSubmit, async, so the turn waits on none of it.
 * Rewind (LIFEOS/STATVS/Rewind.ts) reads it back by session and time; a CENSVS situation carries it to Replay.
 *
 * 1.2.0 (CENSVS ISC-55): full commit ids (`head_sha1`) and a full diff digest (`dirty_sha256`) beside the old
 * prefixes, the model id and effort the turn ran on, the notification channel, and the uncommitted changes plus
 * untracked, non-ignored files under the body scope stored once in the record's object store by sha256. A body is
 * built only when the tree's fingerprint moved since this session's last turn, and a body over the cap is recorded
 * as `too-large`, never stored in part. Bodies are local: the object store is never shipped, and the encrypted
 * backup copies only objects a row's `obj` names, so a body is not in it.
 * @version 1.2.0
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { invariant } from "../../TOOLS/Invariant";
import { getClaudeDir } from "../../TOOLS/Paths";
import * as record from "./record";
import { append, listSegments, statvsDir, statvsStateDir, utcDate } from "./record";
import type { AppendResult } from "./types";

/**
 * The record's object-store writer, read off the module so this file still loads where record.ts predates it
 * (the turn row then records the body as unreadable instead of failing the hook at import).
 */
function objectStore(): ((content: string) => string) | null {
  const put = (record as { putObject?: (content: string) => string }).putObject;
  return typeof put === "function" ? put : null;
}

/**
 * `head` and `dirty` are the 1.1 prefixes, kept for readers of older rows. The full values sit under keys the
 * record reads as named digests (`…sha1`, `…sha256`), so its credential-shape refusal does not take a commit id
 * for a token.
 */
export interface RepoState {
  /** The commit checked out, first 12 characters. */
  head: string;
  /** The full 40-character commit id. */
  head_sha1: string;
  /** First 16 characters of `dirty_sha256`. */
  dirty: string;
  /** sha256 of `git diff HEAD --binary`: the tracked uncommitted changes of the whole repo. */
  dirty_sha256: string;
}

/** Where a repo's uncommitted body went. `stored` wrote it now; `unchanged` points at the body this session last stored. */
export type BodyRef =
  | { status: "stored" | "unchanged"; body_sha256: string; bytes: number; untracked: number }
  | { status: "too-large"; bytes: number; cap: number }
  | { status: "unreadable"; reason: string };

export interface TurnData {
  transcript_path: string;
  /** Bytes in the transcript when the prompt was submitted; the prompt's own line lands at or after it. */
  transcript_offset: number;
  heads: Record<string, RepoState | null>;
  /** Minutes since this Mac last saw keyboard or mouse input, or null when unreadable. */
  seat_idle_min: number | null;
  /**
   * Bytes in every record segment dated today or yesterday (UTC) at that moment, so the record can
   * be cut back to this point. Appends land only in the current day's segment and older days are
   * sealed, so earlier segments cannot have moved; yesterday covers a turn that crosses midnight.
   * Listing every segment grew this row with the record's whole history.
   */
  segments: Record<string, number>;
  /** The model the turn ran on: the hook input's, else the transcript's last assistant message's. */
  model?: { id: string; source: "hook-input" | "transcript" } | null;
  /** The reasoning effort: the hook input's `effort.level`, else `$CLAUDE_EFFORT`. */
  effort?: { level: string; source: "hook-input" | "env" } | null;
  /** The notification channel the session resolved to (desktop, headless …); guards read it. */
  channel?: string | null;
  /** Per repo with a body scope: the uncommitted diff and untracked files under the scope, by hash. */
  bodies?: Record<string, BodyRef>;
}

/** The repo paths whose uncommitted state a turn body carries: the code the guards and tools run from. */
export const BODY_SCOPE = ["hooks", "LIFEOS", "skills"];
/** A body over this is recorded as too-large: 4 MB. */
export const BODY_CAP = 4 * 1024 * 1024;
/** How far back from the transcript's end the model is looked for. */
const MODEL_TAIL_BYTES = 256 * 1024;

async function readAll(stream: ReadableStream<Uint8Array>, cap = Infinity): Promise<{ bytes: Buffer; over: boolean }> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of stream) {
    n += chunk.byteLength;
    if (n > cap) return { bytes: Buffer.alloc(0), over: true };
    parts.push(Buffer.from(chunk));
  }
  return { bytes: Buffer.concat(parts), over: false };
}

/** HEAD and a hash of the uncommitted tracked changes of one repo, or null when it is not a repo. */
export async function repoState(dir: string): Promise<RepoState | null> {
  const head = Bun.spawn(["git", "-C", dir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  const diff = Bun.spawn(["git", "-C", dir, "diff", "HEAD", "--no-ext-diff", "--binary"], { stdout: "pipe", stderr: "ignore" });
  const hash = createHash("sha256");
  for await (const chunk of diff.stdout) hash.update(chunk);
  const [h, hc, dc] = [(await new Response(head.stdout).text()).trim(), await head.exited, await diff.exited];
  if (hc !== 0 || dc !== 0 || !/^[0-9a-f]{40}$/.test(h)) return null;
  const full = hash.digest("hex");
  return { head: h.slice(0, 12), head_sha1: h, dirty: full.slice(0, 16), dirty_sha256: full };
}

/** The UTC days whose segments a turn row sizes: today and yesterday. */
export function turnSegmentDays(now = Date.now()): string[] {
  return [utcDate(now - 86_400_000), utcDate(now)];
}

/** The hook input fields a turn row reads. */
export interface TurnHookInput {
  model?: unknown;
  effort?: { level?: unknown } | null;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$/;
const EFFORT = /^[a-z]{1,16}$/;

/** The model id from the hook input (`model` as a string or `{ id }`), else the last assistant message in the transcript tail. */
export function turnModel(hook: TurnHookInput | undefined, transcriptPath: string): TurnData["model"] {
  const m = hook?.model;
  const fromHook = typeof m === "string" ? m : m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" ? (m as { id: string }).id : null;
  if (fromHook && MODEL_ID.test(fromHook)) return { id: fromHook, source: "hook-input" };
  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, MODEL_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!;
      if (!l.includes('"assistant"') || !l.includes('"model"')) continue;
      try {
        const j = JSON.parse(l) as { type?: string; message?: { model?: unknown } };
        const id = j.type === "assistant" ? j.message?.model : undefined;
        if (typeof id === "string" && MODEL_ID.test(id)) return { id, source: "transcript" };
      } catch { /* the first line of the tail may be cut: skip it */ }
    }
  } catch { /* no transcript yet */ } finally { if (fd !== null) closeSync(fd); }
  return null;
}

/** The effort level from the hook input, else `$CLAUDE_EFFORT`. */
export function turnEffort(hook: TurnHookInput | undefined, env: Record<string, string | undefined> = process.env): TurnData["effort"] {
  const level = hook?.effort?.level;
  if (typeof level === "string" && EFFORT.test(level)) return { level, source: "hook-input" };
  const e = env.CLAUDE_EFFORT;
  if (typeof e === "string" && EFFORT.test(e)) return { level: e, source: "env" };
  return null;
}

function git(dir: string, args: string[]) {
  return Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
}

/** The last body this session stored for a repo, keyed by the tree's fingerprint. */
function bodyStatePath(session: string, repo: string): string {
  invariant(/^[A-Za-z0-9_-]{1,80}$/.test(session) && /^[A-Za-z0-9_-]{1,40}$/.test(repo), "a body state key is a safe session id and repo name");
  return join(statvsStateDir(), "turn-body", `${session}.${repo}.json`);
}

function readBodyState(p: string): { fp: string; body_sha256: string; bytes: number; untracked: number } | null {
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return s && typeof s.fp === "string" && /^[a-f0-9]{64}$/.test(s.body_sha256) && Number.isInteger(s.bytes) && Number.isInteger(s.untracked) ? s : null;
  } catch { return null; }
}

function writeBodyState(p: string, s: { fp: string; body_sha256: string; bytes: number; untracked: number }): void {
  invariant(/^[a-f0-9]{64}$/.test(s.fp) && /^[a-f0-9]{64}$/.test(s.body_sha256), "body state holds two sha256 digests");
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, p);
}

/**
 * The uncommitted diff plus untracked, non-ignored files under `scope` of one repo, stored in the record's object
 * store by sha256. The fingerprint (the scoped diff's hash and each untracked file's path, size and mtime) is
 * compared with this session's last body first, so an unchanged tree reads no file contents and writes nothing.
 */
export async function repoBody(dir: string, scope: string[], opts: { session?: string; repo: string; head: string | null; cap?: number; store?: (content: string) => string }): Promise<BodyRef> {
  const cap = opts.cap ?? BODY_CAP;
  const diffP = git(dir, ["diff", "HEAD", "--no-ext-diff", "--binary", "--", ...scope]);
  const listP = git(dir, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...scope]);
  const [diff, list] = await Promise.all([readAll(diffP.stdout, cap), readAll(listP.stdout)]);
  const [dc, lc] = [await diffP.exited, await listP.exited];
  if (diff.over) return { status: "too-large", bytes: cap + 1, cap };
  if (dc !== 0 || lc !== 0) return { status: "unreadable", reason: "git diff or ls-files failed" };
  const files: { path: string; size: number; mtime: number; link: string | null }[] = [];
  for (const rel of list.bytes.toString("utf8").split("\0").filter(Boolean).sort()) {
    try {
      const st = lstatSync(join(dir, rel));
      if (st.isSymbolicLink()) files.push({ path: rel, size: 0, mtime: st.mtimeMs, link: "symlink" });
      else if (st.isFile()) files.push({ path: rel, size: st.size, mtime: st.mtimeMs, link: null });
    } catch { /* removed since the listing */ }
  }
  const total = diff.bytes.length + files.reduce((n, f) => n + f.size, 0);
  if (total > cap) return { status: "too-large", bytes: total, cap };
  const fp = createHash("sha256").update(diff.bytes).update(JSON.stringify(files)).digest("hex");
  // A session id that cannot name a state file just skips the reuse check; the body is still built and stored.
  const statePath = opts.session && /^[A-Za-z0-9_-]{1,80}$/.test(opts.session) ? bodyStatePath(opts.session, opts.repo) : null;
  const last = statePath ? readBodyState(statePath) : null;
  if (last && last.fp === fp) return { status: "unchanged", body_sha256: last.body_sha256, bytes: last.bytes, untracked: last.untracked };
  const untracked = files.map((f) => {
    if (f.link) return { path: f.path, encoding: "symlink" as const, content: "" };
    const buf = readFileSync(join(dir, f.path));
    const binary = buf.includes(0);
    return { path: f.path, encoding: binary ? "base64" as const : "utf8" as const, content: buf.toString(binary ? "base64" : "utf8") };
  });
  const body = JSON.stringify({ v: 1, repo: opts.repo, head_sha1: opts.head, scope, diff: diff.bytes.toString("utf8"), untracked });
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > cap) return { status: "too-large", bytes, cap };
  const put = opts.store ?? objectStore();
  if (!put) return { status: "unreadable", reason: "record.ts has no putObject" };
  const h = put(body);
  if (statePath) writeBodyState(statePath, { fp, body_sha256: h, bytes, untracked: untracked.length });
  return { status: "stored", body_sha256: h, bytes, untracked: untracked.length };
}

export async function turnData(opts: {
  transcriptPath: string;
  repos: Record<string, string>;
  idle: () => number | null;
  recordDir?: string;
  now?: number;
  /** Repo name → the paths whose uncommitted body is stored (BODY_SCOPE for the config repo). */
  bodies?: Record<string, string[]>;
  session?: string;
  hook?: TurnHookInput;
  channel?: string | null;
  bodyCap?: number;
  /** Where a body is written; the record object store by default (a test seam). */
  store?: (content: string) => string;
}): Promise<TurnData> {
  let offset = 0;
  try { offset = statSync(opts.transcriptPath).size; } catch { /* a transcript not written yet starts at 0 */ }
  const names = Object.keys(opts.repos);
  const states = await Promise.all(names.map((n) => repoState(opts.repos[n]!)));
  const bodyNames = Object.keys(opts.bodies ?? {}).filter((n) => opts.repos[n] !== undefined);
  const bodyRefs = await Promise.all(bodyNames.map((n) => {
    const st = states[names.indexOf(n)] ?? null;
    if (!st) return Promise.resolve<BodyRef>({ status: "unreadable", reason: "not a git repo" });
    return repoBody(opts.repos[n]!, opts.bodies![n]!, { session: opts.session, repo: n, head: st.head_sha1, cap: opts.bodyCap, store: opts.store })
      .catch((e: unknown): BodyRef => ({ status: "unreadable", reason: String((e as Error)?.message ?? e).slice(0, 120) }));
  }));
  const segments: Record<string, number> = {};
  const days = new Set(turnSegmentDays(opts.now));
  for (const s of listSegments(opts.recordDir ?? statvsDir())) {
    if (!days.has(s.date)) continue;
    try { segments[s.rel] = statSync(s.abs).size; } catch { /* a segment sealed and moved mid-read is skipped */ }
  }
  const data: TurnData = {
    transcript_path: opts.transcriptPath,
    transcript_offset: offset,
    heads: Object.fromEntries(names.map((n, i) => [n, states[i] ?? null])),
    seat_idle_min: opts.idle(),
    segments,
    model: turnModel(opts.hook, opts.transcriptPath),
    effort: turnEffort(opts.hook),
    channel: opts.channel ?? null,
  };
  if (bodyNames.length) data.bodies = Object.fromEntries(bodyNames.map((n, i) => [n, bodyRefs[i]!]));
  return data;
}

/** The session's own transcript: `<config>/projects/<dir>/<session>.jsonl`, whether or not Claude Code has written it yet. */
export function isOwnTranscript(session: string, transcriptPath: string, projects = join(getClaudeDir(), "projects")): boolean {
  const p = resolve(transcriptPath);
  // The path decides, never the file's existence: Claude Code writes a new session's transcript after
  // UserPromptSubmit fires, so requiring the file dropped every session's first turn (ISC-113, 2026-10-22).
  return basename(p) === `${session}.jsonl` && dirname(dirname(p)) === resolve(projects);
}

export function appendTurn(session: string, data: TurnData): AppendResult {
  invariant(typeof session === "string" && session.length > 0, "a turn row needs its session id");
  invariant(Number.isInteger(data.transcript_offset) && data.transcript_offset >= 0, "a transcript offset is a byte count");
  for (const s of Object.values(data.heads)) if (s) invariant(/^[0-9a-f]{40}$/.test(s.head_sha1) && s.head_sha1.startsWith(s.head), "a repo head is a full commit id that its prefix starts");
  for (const b of Object.values(data.bodies ?? {})) if (b.status === "stored" || b.status === "unchanged") invariant(/^[a-f0-9]{64}$/.test(b.body_sha256), "a body is named by its sha256");
  return append({ writer: "hook:turn-record", stream: "turn", class: "system", kind: "turn", session, title: "Turn", data });
}
