#!/usr/bin/env bun
/**
 * @version 1.1.1
 * ProjectsBackup.ts — the offsite backup of the projects folder: an encrypted, deduplicated rustic
 * repository in a private, bucket-locked R2 bucket.
 *
 * WHY: the projects folder is outside iCloud, so it has no off-machine copy of its own. A
 * LifeOS service never runs from a project checkout, so this lives here and the schedule is a
 * LifeOS Workflow.
 *
 * CREDENTIALS: no R2 key is stored. Each run derives one from the master Cloudflare token as
 * Cloudflare documents it (key id = the token's id, secret = sha256 of the token value). rustic gets
 * an allowlisted environment: the derived pair plus what it needs to run, never the rest of .env.
 * The repository password is a Keychain item the rustic profile reads.
 *
 * LOCK: the bucket refuses deletes and overwrites under data/, snapshots/, keys/ and config for
 * 14 days. forget keeps every snapshot inside 15 days and prune runs with --keep-pack 15d, so prune
 * never repacks or deletes a pack young enough to be locked (repack output and orphans included).
 *
 *   bun ProjectsBackup.ts init              create the repository (once)
 *   bun ProjectsBackup.ts run               back up now; forget and prune once a day
 *   bun ProjectsBackup.ts drill             restore one random unchanged file from the last good
 *                                           snapshot and compare its sha256; fail on a stale backup
 *   bun ProjectsBackup.ts lockprobe [dr]    prove the bucket lock refuses delete and overwrite
 *                                           (dr probes the bucket named by config.json drBucket)
 *   bun ProjectsBackup.ts status [--live]   last run and drill; --live asks the repository
 *
 * Config: $LIFEOS_USER/CONFIG/ProjectsBackup/{config.json,projects.toml,excludes.glob}.
 * Every run, skip-on-stale-lock and drill writes a STATVS event; event text never carries file
 * names or rustic output, which stay in the local state file. Output is one JSON line.
 */
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { invariant } from "./Invariant";
import { writeEvent } from "../STATVS";
import { lifeosPath } from "./Paths";

const CONFIG_DIR = lifeosPath("USER", "CONFIG", "ProjectsBackup");
const STATE_FILE = lifeosPath("MEMORY", "STATE", "projects-backup.json");
const LOCK_FILE = lifeosPath("MEMORY", "STATE", "projects-backup.lock");

type Config = { source: string; bucket: string; drBucket?: string; host: string; forget: string[]; forgetEveryHours: number; forgetBackoffHours: number; staleLockHours: number; maxRunHours: number };
type RunRecord = { at: string; ok: boolean; seconds: number; source: string; snapshot?: string; filesTotal?: number; filesNew?: number; bytesAdded?: number; error?: string };
type DrillRecord = { at: string; ok: boolean; source: string; snapshot?: string; file?: string; sha256?: string; error?: string };
type State = { lastRun?: RunRecord; lastOk?: RunRecord; lastForget?: string; lastForgetAttempt?: string; forgetError?: string | null; lastDrill?: DrillRecord; lastEvent?: { at: string; ok: boolean; title: string } };

const config = (): Config => {
  const c = JSON.parse(readFileSync(join(CONFIG_DIR, "config.json"), "utf8")) as Config;
  // PROJECTS_BACKUP_SOURCE points a trial run at one small folder; the state records which source ran,
  // and the drill and the weekly report only count runs of the configured source.
  return { ...c, source: (process.env.PROJECTS_BACKUP_SOURCE ?? c.source).replace(/^~(?=\/)/, homedir()) };
};
const configuredSource = (): string => (JSON.parse(readFileSync(join(CONFIG_DIR, "config.json"), "utf8")).source as string).replace(/^~(?=\/)/, homedir());

function readState(): State {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return {}; } // writes are atomic (writeState), so a torn file means someone else wrote it; start fresh
}

/** Re-reads before writing and applies only this caller's fields, so an overlapping run and drill do not clobber each other. */
function updateState(patch: (s: State) => void): State {
  const s = readState();
  patch(s);
  invariant(s.lastRun === undefined || !Number.isNaN(Date.parse(s.lastRun.at)), "lastRun.at must be an ISO time");
  invariant(s.lastOk === undefined || (s.lastOk.ok && !!s.lastOk.snapshot), "lastOk must record a successful run with its snapshot");
  invariant(s.lastDrill === undefined || !Number.isNaN(Date.parse(s.lastDrill.at)), "lastDrill.at must be an ISO time");
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, STATE_FILE);
  return s;
}

/** R2 S3 keys derived from the master token, per Cloudflare's "S3 credentials from an API token". */
async function r2Keys(): Promise<{ account: string; id: string; secret: string }> {
  const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be in the environment (run from ~/.claude)");
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const id = ((await res.json()) as { result?: { id?: string } })?.result?.id;
  if (!id) throw new Error(`could not read the token id (HTTP ${res.status})`);
  return { account, id, secret: new Bun.CryptoHasher("sha256").update(token).digest("hex") };
}

/** The child's whole environment: an allowlist, so no other .env value (and no stray RUSTIC_*) reaches rustic. */
async function rusticEnv(): Promise<Record<string, string>> {
  const k = await r2Keys();
  const env: Record<string, string> = { RUSTIC_PROFILE_SUBSTITUTE_ENV: "true", CLOUDFLARE_ACCOUNT_ID: k.account, PROJECTS_BACKUP_KEY_ID: k.id, PROJECTS_BACKUP_SECRET: k.secret };
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"]) if (process.env[name]) env[name] = process.env[name]!;
  return env;
}

function rustic(env: Record<string, string>, args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["rustic", "-P", "projects", ...args], { cwd: CONFIG_DIR, env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
}
const tail = (s: string) => s.trim().split("\n").slice(-4).join(" | ").slice(0, 400);

/** Writes the event; when STATVS refuses the text, writes a fixed-text event so a run never goes unrecorded. */
function event(ok: boolean, title: string, summary: string, meta: Record<string, string | number | boolean | null>, severity: "info" | "high" = ok ? "info" : "high"): boolean {
  const base = { source: "projects-backup", ts: new Date().toISOString(), kind: "infra" as const, severity, title, privacy_class: "personal" as const };
  const hour = base.ts.slice(0, 13);
  let r = writeEvent({ ...base, summary, meta, dedup_key: `projects-backup:${title}:${hour}` });
  if (!r.ok) r = writeEvent({ ...base, summary: "Event text was refused by STATVS; details are in projects-backup.json.", meta: { ok }, dedup_key: `projects-backup:${title}:fallback:${hour}` });
  updateState((s) => { s.lastEvent = { at: base.ts, ok: r.ok, title }; });
  return r.ok;
}

type Lock = { pid: number; startedAt: string };
const isOurs = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const p = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  return p.exitCode === 0 && /ProjectsBackup\.ts|rustic -P projects/.test(p.stdout.toString());
};

/** Atomic (O_EXCL) lock. A lock is stale when its holder is not a ProjectsBackup process, or it outlived maxRunHours. */
function takeLock(c: Config): { taken: true } | { taken: false; ageHours: number } {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() } satisfies Lock));
      closeSync(fd);
      return { taken: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const raw = (() => { try { return readFileSync(LOCK_FILE, "utf8"); } catch { return ""; } })();
      // 1.0.0 wrote a bare pid, which JSON.parse reads as a number, not a Lock: an unreadable shape is read as a pid.
      let parsed: unknown = null;
      try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
      const lock: Lock = parsed && typeof parsed === "object" && typeof (parsed as Lock).pid === "number" && typeof (parsed as Lock).startedAt === "string"
        ? (parsed as Lock)
        : { pid: Number(String(raw).trim()), startedAt: statSync(LOCK_FILE).mtime.toISOString() };
      const ageHours = (Date.now() - Date.parse(lock.startedAt)) / 3_600_000;
      if (isOurs(lock.pid) && ageHours < c.maxRunHours) return { taken: false, ageHours };
      try { unlinkSync(LOCK_FILE); } catch { /* raced with another cleaner */ }
    }
  }
  return { taken: false, ageHours: 0 };
}
function releaseLock(): void {
  try { if ((JSON.parse(readFileSync(LOCK_FILE, "utf8")) as Lock).pid === process.pid) unlinkSync(LOCK_FILE); } catch { /* not ours or gone */ }
}

async function run(): Promise<number> {
  const started = Date.now();
  let c: Config;
  try { c = config(); } catch (e) {
    event(false, "Projects backup failed", "config.json could not be read.", { ok: false });
    console.log(JSON.stringify({ ok: false, error: (e as Error).message })); return 1;
  }
  const lock = takeLock(c);
  if (!lock.taken) {
    // A run still uploading is normal; one holding the lock past staleLockHours means backups have stopped landing.
    if (lock.ageHours > c.staleLockHours) event(false, "Projects backup stuck", `A backup run has held the lock for ${lock.ageHours.toFixed(1)}h; new runs are skipping.`, { ok: false, lockHours: +lock.ageHours.toFixed(1) });
    console.log(JSON.stringify({ ok: true, skipped: "a run is already in progress", lockHours: +lock.ageHours.toFixed(1) }));
    return 0;
  }
  let rec: RunRecord;
  let forgetNote: string | null = null;
  try {
    const env = await rusticEnv();
    const b = rustic(env, ["backup", c.source, "--iglob-file", join(CONFIG_DIR, "excludes.glob"), "--host", c.host, "--label", "projects", "--json"]);
    if (b.code !== 0) throw new Error(`backup exit ${b.code}: ${tail(b.err)}`);
    const s = JSON.parse(b.out.slice(b.out.indexOf("{")));
    const sum = s.summary ?? s;
    const filesTotal = Number(sum.total_files_processed ?? NaN);
    // An empty or moved source exits 0 with an empty snapshot; that is a failure, not a backup.
    if (!(filesTotal > 0)) throw new Error(`snapshot ${String(s.id ?? "").slice(0, 8)} holds no files; is ${c.source} empty or moved?`);
    rec = { at: new Date().toISOString(), ok: true, seconds: Math.round((Date.now() - started) / 1000), source: c.source, snapshot: String(s.id),
      filesTotal, filesNew: sum.files_new, bytesAdded: sum.data_added_packed ?? sum.data_added };
    const done = rec;
    updateState((st) => { st.lastOk = done; st.lastRun = done; });

    // Forget/prune is housekeeping: its failure is reported on its own and never turns a good backup into a failed run.
    const st = readState();
    const due = !st.lastForget || Date.now() - Date.parse(st.lastForget) > c.forgetEveryHours * 3_600_000;
    const backedOff = st.forgetError && st.lastForgetAttempt && Date.now() - Date.parse(st.lastForgetAttempt) < c.forgetBackoffHours * 3_600_000;
    if (due && !backedOff) {
      const f = rustic(env, ["forget", ...c.forget]);
      const at = new Date().toISOString();
      if (f.code === 0) updateState((x) => { x.lastForget = at; x.lastForgetAttempt = at; x.forgetError = null; });
      else {
        forgetNote = `forget/prune exit ${f.code}: ${tail(f.err)}`;
        const note = forgetNote;
        updateState((x) => { x.lastForgetAttempt = at; x.forgetError = note; });
        event(false, "Projects backup prune failed", `Forget/prune exited ${f.code}; the backup itself succeeded. Retrying in ${c.forgetBackoffHours}h.`, { ok: false, exit: f.code });
      }
    }
  } catch (e) {
    rec = { at: new Date().toISOString(), ok: false, seconds: Math.round((Date.now() - started) / 1000), source: c.source, error: (e as Error).message };
    const failed = rec;
    updateState((st) => { st.lastRun = failed; });
  } finally {
    releaseLock();
  }
  event(rec.ok, rec.ok ? "Projects backup ran" : "Projects backup failed",
    rec.ok ? `Snapshot ${rec.snapshot!.slice(0, 8)}: ${rec.filesNew ?? 0} new files, ${Math.round((rec.bytesAdded ?? 0) / 1e6)} MB added, ${rec.seconds}s.`
      : `The backup run failed after ${rec.seconds}s; details are in projects-backup.json.`,
    { ok: rec.ok, seconds: rec.seconds, snapshot: rec.snapshot?.slice(0, 8) ?? null, filesNew: rec.filesNew ?? null, bytesAdded: rec.bytesAdded ?? null });
  console.log(JSON.stringify(forgetNote ? { ...rec, forgetError: forgetNote } : rec));
  return rec.ok ? 0 : 1;
}

/** Directory names the backup excludes, read from excludes.glob so the drill never samples a file that was never backed up. */
function excludedNames(): Set<string> {
  const lines = readFileSync(join(CONFIG_DIR, "excludes.glob"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("!**/"));
  return new Set(lines.map((l) => l.slice(4).split("/")[0]!));
}

/** A random regular file (never a symlink) under the source, unchanged since the cutoff, outside every excluded name. */
function pickFile(source: string, cutoffMs: number, skip: Set<string>): string | null {
  let dir = source;
  for (let depth = 0; depth < 14; depth++) {
    let names: string[];
    try { names = readdirSync(dir).filter((n) => !skip.has(n)); } catch { return null; }
    const paths = names.map((n) => join(dir, n));
    const files = paths.filter((p) => { try { const s = lstatSync(p); return s.isFile() && s.size > 0 && s.mtimeMs < cutoffMs; } catch { return false; } });
    const dirs = paths.filter((p) => { try { return lstatSync(p).isDirectory(); } catch { return false; } });
    // Weight by count so deep trees are sampled, not just the top of each project.
    if (files.length && Math.random() < files.length / (files.length + dirs.length)) return files[Math.floor(Math.random() * files.length)]!;
    if (!dirs.length) return files.length ? files[Math.floor(Math.random() * files.length)]! : null;
    dir = dirs[Math.floor(Math.random() * dirs.length)]!;
  }
  return null;
}

async function drill(): Promise<number> {
  let rec: DrillRecord;
  const work = mkdtempSync(join(tmpdir(), "projects-drill-"));
  let source = "";
  try {
    const c = config();
    source = c.source;
    const ok = readState().lastOk;
    if (!ok || ok.source !== c.source) throw new Error(`no successful backup of ${c.source} on record`);
    // The daily drill is also the freshness alarm: an hourly job that stopped running writes no event.
    const ageH = (Date.now() - Date.parse(ok.at)) / 3_600_000;
    if (ageH > 6) throw new Error(`last successful backup was ${ageH.toFixed(1)}h ago`);
    const env = await rusticEnv();
    const cutoff = Date.parse(ok.at) - (ok.seconds + 3600) * 1000; // unchanged since before that run started
    const skip = excludedNames();
    let file: string | null = null;
    for (let i = 0; i < 30 && !file; i++) file = pickFile(c.source, cutoff, skip);
    if (!file) throw new Error("found no unchanged file to drill");
    // Restore from the exact snapshot the last good run made, not whatever is "latest".
    const r = rustic(env, ["restore", `${ok.snapshot}:${file}`, join(work, "restored")]);
    if (r.code !== 0) throw new Error(`restore exit ${r.code}: ${tail(r.err)}`);
    const out = join(work, "restored");
    const restored = existsSync(out) && statSync(out).isFile() ? out : join(out, basename(file));
    const hash = (p: string) => new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex");
    const want = hash(file), got = hash(restored);
    if (want !== got) throw new Error(`sha256 mismatch on ${relative(c.source, file)}`);
    rec = { at: new Date().toISOString(), ok: true, source: c.source, snapshot: ok.snapshot, file: relative(c.source, file), sha256: want.slice(0, 16) };
  } catch (e) {
    rec = { at: new Date().toISOString(), ok: false, source, error: (e as Error).message };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const done = rec;
  updateState((s) => { s.lastDrill = done; });
  event(rec.ok, rec.ok ? "Projects backup restore drill passed" : "Projects backup restore drill failed",
    rec.ok ? `Restored one random file from snapshot ${rec.snapshot!.slice(0, 8)}; its sha256 matched the source.` : "The restore drill failed; details are in projects-backup.json.",
    { ok: rec.ok, snapshot: rec.snapshot?.slice(0, 8) ?? null });
  console.log(JSON.stringify(rec));
  return rec.ok ? 0 : 1;
}

/** Writes lockprobe/<time> and confirms R2 refuses both its delete and its overwrite. The object expires with the lock. */
async function lockprobe(target: string | undefined): Promise<number> {
  const k = await r2Keys();
  // The disaster-recovery bucket is named in config.json (drBucket), never in this shared tool.
  const bucket = target === "dr" ? config().drBucket : config().bucket;
  if (!bucket) {
    console.error(target === "dr" ? "lockprobe dr: set drBucket in config.json first" : "lockprobe: no bucket in config.json");
    return 2;
  }
  const s3 = new Bun.S3Client({ accessKeyId: k.id, secretAccessKey: k.secret, bucket, endpoint: `https://${k.account}.r2.cloudflarestorage.com`, region: "auto" });
  const key = `lockprobe/${new Date().toISOString()}.txt`;
  await s3.write(key, "original");
  const refused = async (op: () => Promise<unknown>) => { try { await op(); return false; } catch (e) { return (e as { code?: string }).code === "ObjectLockedByBucketPolicy"; } };
  const del = await refused(() => s3.delete(key));
  const over = await refused(() => s3.write(key, "tampered"));
  const intact = (await s3.file(key).text()) === "original";
  const ok = del && over && intact;
  console.log(JSON.stringify({ ok, bucket, deleteRefused: del, overwriteRefused: over, intact }));
  return ok ? 0 : 1;
}

async function init(): Promise<number> {
  const r = rustic(await rusticEnv(), ["init"]);
  console.log(JSON.stringify({ ok: r.code === 0, detail: tail(r.code === 0 ? r.out + r.err : r.err) }));
  return r.code;
}

async function status(live: boolean): Promise<number> {
  const s = readState();
  const src = configuredSource();
  const full = s.lastOk?.source === src ? s.lastOk : undefined;
  const out: Record<string, unknown> = { ...s, configuredSource: src, lastFullOkAgeHours: full ? +((Date.now() - Date.parse(full.at)) / 3_600_000).toFixed(2) : null };
  if (live) {
    const r = rustic(await rusticEnv(), ["snapshots", "--json"]);
    if (r.code !== 0) out.live = { error: tail(r.err) };
    else {
      const groups = JSON.parse(r.out.slice(r.out.indexOf("[")));
      const snaps = groups.flatMap((g: any) => (Array.isArray(g) ? g[1] ?? g : g.snapshots ?? [])).filter((x: any) => x?.time);
      const ofSource = snaps.filter((x: any) => (x.paths ?? []).includes(src)).map((x: any) => Date.parse(x.time)).sort((a: number, b: number) => b - a);
      out.live = { snapshots: snaps.length, latestFullAgeHours: ofSource.length ? +((Date.now() - ofSource[0]) / 3_600_000).toFixed(2) : null };
    }
  }
  console.log(JSON.stringify(out));
  return 0;
}

const cmd = process.argv[2];
const code = cmd === "run" ? await run() : cmd === "drill" ? await drill() : cmd === "init" ? await init()
  : cmd === "lockprobe" ? await lockprobe(process.argv[3])
  : cmd === "status" ? await status(process.argv.includes("--live"))
  : (console.error("usage: ProjectsBackup.ts init|run|drill|lockprobe [dr]|status [--live]"), 2);
process.exit(code);
