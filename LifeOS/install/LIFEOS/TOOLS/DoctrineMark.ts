/**
 * DoctrineMark.ts — the statusline's doctrine mark
 *
 * One small per-session file, `MEMORY/STATE/doctrine-mark/<session>.json`, holds three facts written by three hooks
 * that already run: `asked` (MemoryTurnStart: the prompt said "from now on"), `writes` (SystemChangeSurface: a doctrine
 * file was written) and `ended` (TabState Stop: the turn finished). Each writer changes only its own field, so the
 * order the hooks finish in cannot change the answer; `doctrineView()` folds the three into one mark.
 *
 * Doctrine is the system prompt, the Algorithm and the operating rules. No model call, nothing
 * printed; every entry point is fail-open for its host hook.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "./Invariant";

export type DoctrineWrite = { label: string; at: number };
export type DoctrineRecord = { asked: number | null; ended: number | null; writes: DoctrineWrite[] };
export type DoctrineView = { state: "writing" | "updated" | "missed"; labels: string[] };

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_WRITES = 20;
/** How long a finished mark stays on the line, as the docs mark. */
export const DOCTRINE_TTL_MS = 15 * 60_000;
/** A "from now on" turn can run long before it reaches the doctrine file. */
export const DOCTRINE_WRITING_TTL_MS = 30 * 60_000;

/** Path tails, so a write under either spelling of the USER symlink matches. */
const TAILS: Array<[string, string]> = [
  ["LIFEOS/LIFEOS_SYSTEM_PROMPT.md", "SYSTEM_PROMPT"],
  ["USER/CONFIG/OPERATIONAL_PREFERENCES.md", "OPERATIONAL_PREFERENCES"],
];

/** The doctrine label for a path, or null when the file is not doctrine. */
export function doctrineLabel(path: string): string | null {
  if (!path) return null;
  const p = path.replace(/\/+$/, "");
  for (const [tail, label] of TAILS) if (p.endsWith("/" + tail)) return label;
  const algo = /\/LIFEOS\/ALGORITHM\/(v[\d.]+\.md|LATEST)$/.exec(p);
  if (algo) return `ALGORITHM ${algo[1].replace(/\.md$/, "")}`;
  return null;
}

const MACHINE = /^(<(task-notification|system-reminder|agent-message|cross-session-message)\b|Another Claude session sent a message)/i;
const ASK = /\b(from now on|from here on|from this point (on|forward)|going forward)\b/i;

/** The prompt asks for a standing rule, which is a doctrine change (the principal's rule). */
export function isDoctrineAsk(prompt: string): boolean {
  const t = (prompt ?? "").trim();
  if (!t || t.startsWith("/") || MACHINE.test(t)) return false;
  return ASK.test(t.replace(/[‘’ʼ`]/g, "'"));
}

export function doctrineDir(lifeosRoot: string, env: Record<string, string | undefined> = process.env): string {
  return env.LIFEOS_DOCTRINE_MARK_DIR || join(lifeosRoot, "MEMORY", "STATE", "doctrine-mark");
}

/** This session's file, or "" when the id cannot name one. */
export function doctrinePath(dir: string, sessionId: string): string {
  return SAFE_SESSION.test(sessionId ?? "") ? join(dir, `${sessionId}.json`) : "";
}

export function readDoctrine(path: string): DoctrineRecord {
  const empty: DoctrineRecord = { asked: null, ended: null, writes: [] };
  if (!path) return empty;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Partial<DoctrineRecord>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const writes = Array.isArray(j.writes)
      ? j.writes.filter((w): w is DoctrineWrite => !!w && typeof w.label === "string" && typeof w.at === "number")
      : [];
    return { asked: num(j.asked), ended: num(j.ended), writes };
  } catch { return empty; }
}

function update(dir: string, sessionId: string, change: (r: DoctrineRecord) => DoctrineRecord): void {
  const path = doctrinePath(dir, sessionId);
  if (!path) return;
  const next = change(readDoctrine(path));
  invariant(next.writes.length <= MAX_WRITES, "doctrine mark keeps at most 20 writes");
  invariant(next.writes.every((w) => w.label.length > 0 && Number.isFinite(w.at)), "doctrine writes carry a label and a time");
  invariant([next.asked, next.ended].every((v) => v === null || Number.isFinite(v)), "doctrine times are numbers or null");
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, path);
}

export const markAsked = (dir: string, sessionId: string, at = Date.now()): void =>
  update(dir, sessionId, (r) => ({ ...r, asked: at }));

export const markEnded = (dir: string, sessionId: string, at = Date.now()): void =>
  update(dir, sessionId, (r) => ({ ...r, ended: at }));

export const recordWrite = (dir: string, sessionId: string, label: string, at = Date.now()): void =>
  update(dir, sessionId, (r) => ({ ...r, writes: [...r.writes, { label, at }].slice(-MAX_WRITES) }));

/** Stop only closes a turn that asked; any other turn leaves the file alone, so a quiet session writes nothing. */
export function endTurn(dir: string, sessionId: string, at = Date.now()): void {
  const path = doctrinePath(dir, sessionId);
  if (!path) return;
  const r = readDoctrine(path);
  if (r.asked !== null && (r.ended === null || r.ended < r.asked)) markEnded(dir, sessionId, at);
}

// ── Writes made by any tool ──
//
// PostToolObserver sees Edit and Write only, so a doctrine file rewritten from a shell (`bun -e`, a heredoc) went
// unseen (a shortcut added to a doctrine file from a Bash call fired no mark).
// At Stop the turn's tool calls are read back: a doctrine file whose modified time falls inside a call that names the
// file was written by this turn, whatever the tool. A peer session's write cannot be credited, because it would have
// to land inside one of this session's calls that also names that exact file.

export type CallSpan = { text: string; start: number; end: number; ok: boolean };
export type DoctrineFile = { label: string; path: string; needle: string };

/** The doctrine files under a LifeOS install root (`~/.claude`), with the text a call names them by. */
export function doctrineFiles(claudeRoot: string): DoctrineFile[] {
  const lifeos = join(claudeRoot, "LIFEOS");
  let version = "";
  try { version = readFileSync(join(lifeos, "ALGORITHM", "LATEST"), "utf8").trim() } catch { /* no Algorithm */ }
  const files: DoctrineFile[] = [
    { label: "SYSTEM_PROMPT", path: join(lifeos, "LIFEOS_SYSTEM_PROMPT.md"), needle: "LIFEOS_SYSTEM_PROMPT.md" },
    ...TAILS.slice(1).map(([tail, label]) => ({ label, path: join(lifeos, tail), needle: tail.split("/").pop()! })),
    { label: "ALGORITHM LATEST", path: join(lifeos, "ALGORITHM", "LATEST"), needle: "ALGORITHM/LATEST" },
  ];
  if (/^[\d.]+$/.test(version)) files.push({ label: `ALGORITHM v${version}`, path: join(lifeos, "ALGORITHM", `v${version}.md`), needle: `v${version}.md` });
  return files;
}

/** Slack around a call's start and finish, for clock skew and the transcript stamping a call after it began. */
const SPAN_SLACK_MS = 3000;

/** The doctrine writes this turn's calls made: each file whose mtime falls inside a successful call that names it. */
export function writesInTurn(calls: CallSpan[], files: Array<DoctrineFile & { mtime: number }>): DoctrineWrite[] {
  const out: DoctrineWrite[] = [];
  for (const f of files) {
    if (!Number.isFinite(f.mtime) || f.mtime <= 0) continue;
    const hit = calls.some((c) => c.ok && c.text.includes(f.needle) && f.mtime >= c.start - SPAN_SLACK_MS && f.mtime <= c.end + SPAN_SLACK_MS);
    if (hit) out.push({ label: f.label, at: f.mtime });
  }
  return out;
}

/** Record writes the post-tool leg missed; one already recorded within the slack is the same write. */
export function recordTurnWrites(dir: string, sessionId: string, writes: DoctrineWrite[]): void {
  const path = doctrinePath(dir, sessionId);
  if (!path || writes.length === 0) return;
  const known = readDoctrine(path).writes;
  const fresh = writes.filter((w) => !known.some((k) => k.label === w.label && Math.abs(k.at - w.at) <= SPAN_SLACK_MS));
  if (fresh.length) update(dir, sessionId, (r) => ({ ...r, writes: [...r.writes, ...fresh].sort((a, b) => a.at - b.at).slice(-MAX_WRITES) }));
}

/**
 * Stop: record this turn's doctrine writes from its calls, then close an asking turn. `readCalls` runs only when a
 * doctrine file changed in the last six hours, so an ordinary turn costs a few stats.
 */
export async function closeTurn(dir: string, sessionId: string, claudeRoot: string, readCalls: () => CallSpan[] | Promise<CallSpan[]>, now = Date.now()): Promise<void> {
  if (!doctrinePath(dir, sessionId)) return;
  const files = doctrineFiles(claudeRoot).map((f) => {
    let mtime = 0;
    try { mtime = statSync(f.path).mtimeMs } catch { /* absent */ }
    return { ...f, mtime };
  });
  if (files.some((f) => now - f.mtime < 6 * 3_600_000)) recordTurnWrites(dir, sessionId, writesInTurn(await readCalls(), files));
  endTurn(dir, sessionId, now);
}

/** The mark to draw, or null for none. */
export function doctrineView(r: DoctrineRecord, now: number): DoctrineView | null {
  const last = r.writes.reduce((m, w) => Math.max(m, w.at), -Infinity);
  const since = (from: number) => [...new Set(r.writes.filter((w) => w.at >= from).map((w) => w.label))];
  if (r.asked !== null && last < r.asked) {
    if (r.ended === null || r.ended < r.asked) return now - r.asked > DOCTRINE_WRITING_TTL_MS ? null : { state: "writing", labels: [] };
    return now - r.ended > DOCTRINE_TTL_MS ? null : { state: "missed", labels: [] };
  }
  if (!Number.isFinite(last) || now - last > DOCTRINE_TTL_MS) return null;
  return { state: "updated", labels: since(r.asked !== null ? r.asked : now - DOCTRINE_TTL_MS) };
}
