/**
 * Lib.ts — shared types, constants, paths and small pure helpers for the StoryFilm pipeline.
 *
 * A run lives under the configured runs root (never inside a git repo):
 *   <run>/run.json            slug, title, author, voice, source path
 *   <run>/Beats.json          one beat per paragraph, scene index from the story's `* * *` breaks
 *   <run>/Storyboard.json     the bible (style, characters, places) and one shot per beat
 *   <run>/Bible/<id>.<hash>.png   reference sheets + style plate
 *   <run>/Shots/<beat>.<hash>.png one painting per beat
 *   <run>/Narration/...       per-beat chunks, narration.wav, timeline.json
 *   <run>/Out/film.mp4  verify.json  review/
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lifeosUserDir } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
/** Silence between beats, and the longer breath at a scene break. */
export const BEAT_GAP_SECONDS = 0.55;
export const SCENE_GAP_SECONDS = 2.2;
export const TARGET_LUFS = -16;
export const DISSOLVE_SECONDS = 1.1;
export const TITLE_SECONDS = 5;
export const END_SECONDS = 5;

export const MOTIONS = ["push", "pull", "pan-left", "pan-right", "tilt-up", "tilt-down", "hold"] as const;
export type Motion = (typeof MOTIONS)[number];

export interface Beat { id: string; index: number; scene: number; text: string }
export interface Beats { slug: string; title: string; author?: string; voice?: string; scenes: number; beats: Beat[] }

/** `key` is the word the lint matches in shot prompts (default: the first capitalized word of the name, or its last word). */
export interface BibleEntry { name: string; desc: string; kind?: "person" | "place" | "object"; key?: string }
export interface Bible { style: string; characters: Record<string, BibleEntry>; places: Record<string, BibleEntry> }
export interface Shot { beat: string; prompt: string; refs: string[]; motion: Motion; focus?: { x: number; y: number } }
export interface Storyboard { bible: Bible; shots: Shot[] }

export interface Word { w: string; s: number; e: number }
export interface TimelineBeat { id: string; scene: number; start: number; end: number; words: Word[]; chunk: string }
export interface Timeline { fps: number; gap: number; sceneGap: number; lead: number; tail: number; total: number; narration: string; beats: TimelineBeat[] }

export interface RunMeta { slug: string; title: string; author?: string; voice?: string; source: string; createdAt: string }

export function sha256(s: string | Buffer): string { return createHash("sha256").update(s).digest("hex"); }
export function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T; }
export function writeJson(path: string, value: unknown): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); }
export function ensureDir(path: string): string { mkdirSync(path, { recursive: true }); return path; }

export function configRoot(): string { return process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "~", ".claude"); }
export function skillDir(): string { return resolve(import.meta.dir, ".."); }
/** The skill's USER store: Config.json (runs root, fonts). Runs never live here. */
export function userStoreDir(): string { return join(lifeosUserDir(), "CUSTOMIZATIONS", "SKILLS", "StoryFilm"); }

export interface SkillConfig { runsRoot?: string; fonts?: { serif?: string; serifItalic?: string }; provingRun?: string; }
export function loadSkillConfig(): SkillConfig {
  const p = join(userStoreDir(), "Config.json");
  return existsSync(p) ? readJson<SkillConfig>(p) : {};
}
/** The run slug the skill ISA's proving-run checks target; fails loudly naming the file and key when unset. */
export function provingRun(): string {
  const slug = loadSkillConfig().provingRun;
  if (!slug) throw new Error(`provingRun is not set in ${join(userStoreDir(), "Config.json")} (key: provingRun, the run slug the ISA proving-run checks use)`);
  return slug;
}
export function expandHome(p: string): string { return p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"); }
export function runsRoot(): string {
  const env = process.env.LIFEOS_STORYFILM_DIR;
  const cfg = loadSkillConfig().runsRoot;
  return expandHome(env ?? cfg ?? "~/StoryFilms");
}

/** Dereference symlinks; for a path that does not exist yet, dereference its nearest existing ancestor and keep the rest lexical. */
export function canonical(p: string): string {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { /* fall through */ }
  let head = abs;
  while (!existsSync(head) && dirname(head) !== head) head = dirname(head);
  try { return join(realpathSync(head), abs.slice(head.length)); } catch { return abs; }
}
export function forbiddenRunRoots(): string[] { return [configRoot(), lifeosUserDir()].map(canonical); }
/** The nearest directory at or above `dir` (canonicalized) that holds a `.git` entry, or undefined when none does. */
export function gitRepoAncestor(dir: string): string | undefined {
  for (let d = canonical(dir); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return undefined;
  }
}
/** A run dir must never sit inside the config tree, the user-data repo, or any git repo; both sides are canonicalized (symlinks dereferenced) before the boundary check. */
export function assertRunDirAllowed(dir: string, roots: string[] = forbiddenRunRoots()): void {
  const real = canonical(dir);
  for (const r of roots.map(canonical)) invariant(real !== r && !real.startsWith(r + "/"), `run dir ${dir} is inside ${r} — runs never live in the config tree or the user-data repo`);
  const repo = gitRepoAncestor(real);
  invariant(!repo, `run dir ${dir} is inside the git repo ${repo} — set runsRoot (skill Config.json or LIFEOS_STORYFILM_DIR) to a folder outside any repo`);
}
export function resolveRunDir(arg: string): string {
  const dir = arg.includes("/") ? resolve(expandHome(arg)) : join(runsRoot(), arg);
  assertRunDirAllowed(dir);
  return dir;
}

export function runPaths(dir: string) {
  return {
    dir,
    run: join(dir, "run.json"),
    beats: join(dir, "Beats.json"),
    storyboard: join(dir, "Storyboard.json"),
    bible: join(dir, "Bible"),
    shots: join(dir, "Shots"),
    narration: join(dir, "Narration"),
    narrationWav: join(dir, "Narration", "narration.wav"),
    timeline: join(dir, "Narration", "timeline.json"),
    pronunciations: join(dir, "pronunciations.json"),
    out: join(dir, "Out"),
    video: join(dir, "Out", "film.mp4"),
    composition: join(dir, "Out", "composition"),
    renderLog: join(dir, "Out", "render.log"),
    verify: join(dir, "Out", "verify.json"),
    review: join(dir, "Out", "review"),
    frames: join(dir, "Out", "frames"),
  };
}

export function loadBeats(dir: string): Beats { return readJson<Beats>(runPaths(dir).beats); }
export function loadStoryboard(dir: string): Storyboard { return readJson<Storyboard>(runPaths(dir).storyboard); }
export function loadTimeline(dir: string): Timeline { return readJson<Timeline>(runPaths(dir).timeline); }
export function loadRun(dir: string): RunMeta { return readJson<RunMeta>(runPaths(dir).run); }

export function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i !== -1) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(flag + "="));
  return eq ? eq.slice(flag.length + 1) : undefined;
}
export function hasFlag(argv: string[], flag: string): boolean { return argv.includes(flag); }
export function mmss(seconds: number): string { const m = Math.floor(seconds / 60); const s = Math.floor(seconds % 60); return `${m}:${String(s).padStart(2, "0")}`; }

/** Lowercase, strip punctuation, collapse whitespace — for transcript comparison. */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Split a beat's text into sentences for the caption line. Keeps the original characters. */
export function splitSentences(text: string): string[] {
  const parts = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+["”’)]?|[^.!?]+$/g);
  return (parts ?? [text]).map((s) => s.trim()).filter(Boolean);
}

export async function sh(cmd: string[], opts: { cwd?: string; allowFail?: boolean } = {}): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0 && !opts.allowFail) throw new Error(`${cmd[0]} ${cmd.slice(1, 4).join(" ")} failed (${code}): ${err.slice(-500)}`);
  return { code, out, err };
}
/** True while a process with this pid exists. EPERM means it exists under another user. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * When the process with this pid started, as `ps` prints it in UTC and the C locale (one-second resolution), or
 * undefined when ps cannot say (no such process, or no ps on the PATH). A lock records it beside its holder's pid, so a
 * pid the system has since handed to another process is not mistaken for the holder.
 */
export function processStart(pid: number): string | undefined {
  try {
    const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, stdout: "pipe", stderr: "ignore" });
    const out = r.stdout.toString().trim();
    return r.exitCode === 0 && out ? out : undefined;
  } catch {
    return undefined; // ps could not be run: the pid check alone decides
  }
}

let ownStartMemo: { value: string | undefined } | undefined;
function ownStart(): string | undefined { return (ownStartMemo ??= { value: processStart(process.pid) }).value; }

/** What a lock file holds. `token` is random per acquisition; `started` is processStart(pid) when it could be read. */
interface LockRecord { pid: number; started?: string; token?: string }
/** One read of a lock file: `key` names that exact file (its inode and its bytes); `record` is undefined when the bytes do not parse. */
interface LockSeen { key: string; record?: LockRecord; ageMs: number }

/**
 * An unparseable lock younger than this counts as live. Every lock withFileLock writes is whole from the instant it
 * exists, so an unparseable one came from somewhere else; it is taken over only once it is clearly abandoned.
 */
const UNPARSEABLE_GRACE_MS = 60_000;

function parseLockRecord(text: string): LockRecord | undefined {
  try {
    const r = JSON.parse(text) as Record<string, unknown>;
    if (!(typeof r.pid === "number" && Number.isInteger(r.pid) && r.pid > 0)) return undefined;
    return { pid: r.pid, started: typeof r.started === "string" ? r.started : undefined, token: typeof r.token === "string" ? r.token : undefined };
  } catch {
    return undefined; // not JSON, or JSON that is not an object
  }
}

/** Reads a lock file through one descriptor, so the inode, the age and the bytes all come from the same file. */
function readLock(path: string): LockSeen | undefined {
  let fd: number;
  try { fd = openSync(path, "r"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const st = fstatSync(fd), text = readFileSync(fd, "utf8");
    return { key: `${st.ino}-${sha256(text).slice(0, 16)}`, record: parseLockRecord(text), ageMs: Date.now() - st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/** A recorded holder is live while its pid exists and, when a start time was recorded, that pid still has it. */
function lockIsLive(seen: LockSeen, graceMs: number): boolean {
  const r = seen.record;
  if (!r) return seen.ageMs < graceMs;
  if (!pidAlive(r.pid)) return false;
  if (r.started === undefined) return true; // a lock from before start times were recorded
  const now = processStart(r.pid);
  return now === undefined || now === r.started; // ps unavailable or the pid just exited: not proof of a recycled pid
}

/**
 * Creates `path` holding `record` whole, or returns false when `path` already exists. The bytes go to a private temp
 * file first and are hard-linked into place; link() never replaces an existing name, so the name appears only once its
 * contents are complete, and only one creator succeeds.
 */
function createWhole(path: string, record: LockRecord): boolean {
  const tmp = `${path}.${record.token}.tmp`;
  writeFileSync(tmp, JSON.stringify(record) + "\n", { flag: "wx" });
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Removes the stale lock file `seen` read, and never a newer one, with exactly one contender doing it. Every contender
 * that judged that file stale races to create a takeover marker named after its key; only the marker's creator goes
 * on, re-reads the lock, and unlinks it only if it is still that same file. Nothing else unlinks a stale holder's file,
 * and keys never repeat (each lock carries a random token), so once it is gone no later marker can match a new lock.
 * A marker whose creator died mid-takeover passes the turn to the next numbered marker. Returns true when that stale
 * file is gone (by this call or another), false while a live contender is still taking it over.
 */
function takeOverStale(lockPath: string, seen: LockSeen, me: LockRecord, graceMs: number): boolean {
  const marker = (n: number) => `${lockPath}.takeover-${seen.key}-${n}`;
  for (let n = 1; ; n++) {
    if (createWhole(marker(n), me)) {
      try {
        if (readLock(lockPath)?.key === seen.key) rmSync(lockPath, { force: true });
      } finally {
        for (let i = 1; i <= n; i++) rmSync(marker(i), { force: true }); // ours, and any left by contenders that died
      }
      return true;
    }
    const other = readLock(marker(n));
    if (other === undefined) return readLock(lockPath)?.key !== seen.key; // that contender just finished
    if (lockIsLive(other, graceMs)) return false;
  }
}

/**
 * Runs fn while holding an exclusive lock file, so two processes never write the same files at once (the early
 * narration Full starts after Intake, and Run.ts's own narrate leg). A second caller waits, polling, until the holder
 * releases it; the wait is bounded by timeoutMs and then fails loud naming the holder.
 *
 * The lock file holds its holder's pid, that process's start time and a random token, and it is whole from the instant
 * it exists (createWhole). It is stale when its pid is gone or now belongs to a process with a different start time; an
 * unparseable lock is stale only once it is older than unparseableGraceMs. A stale lock is taken over by exactly one
 * contender (takeOverStale). Release removes the file only while it still carries this holder's token.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts: { timeoutMs?: number; pollMs?: number; unparseableGraceMs?: number; log?: (s: string) => void } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 2 * 60 * 60 * 1000, pollMs = opts.pollMs ?? 2000, graceMs = opts.unparseableGraceMs ?? UNPARSEABLE_GRACE_MS;
  invariant(existsSync(dirname(lockPath)), `lock dir missing: ${dirname(lockPath)}`);
  const me: LockRecord = { pid: process.pid, started: ownStart(), token: randomBytes(16).toString("hex") };
  const start = Date.now();
  let announced = false;
  while (!createWhole(lockPath, me)) {
    const seen = readLock(lockPath);
    if (seen === undefined) continue; // released between our attempt and our read
    if (!lockIsLive(seen, graceMs) && takeOverStale(lockPath, seen, me, graceMs)) continue;
    const holder = seen.record ? `pid ${seen.record.pid}` : `an unreadable lock ${Math.round(seen.ageMs / 1000)}s old`;
    invariant(Date.now() - start < timeoutMs, `${lockPath} still held by ${holder} after ${Math.round(timeoutMs / 1000)}s`);
    if (!announced) { (opts.log ?? ((m) => console.log(m)))(`… waiting for ${holder} to release ${lockPath}`); announced = true; }
    await Bun.sleep(pollMs);
  }
  try {
    return await fn();
  } finally {
    if (readLock(lockPath)?.record?.token === me.token) rmSync(lockPath, { force: true });
  }
}

export async function probeDuration(path: string): Promise<number> {
  const { out } = await sh(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  const d = Number(out.trim());
  invariant(Number.isFinite(d) && d > 0, `ffprobe duration unreadable for ${path}`);
  return d;
}
