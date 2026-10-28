/**
 * Process plumbing for the seam: bounded child processes, the macOS network sandbox, the
 * pinned `bun x hyperframes@<version>` invocation, and one-time provisioning.
 *
 * Every render-time process (HyperFrames and the Chrome it drives, our own probe Chrome) runs
 * under `sandbox-exec` with outbound network denied except loopback, and DNS denied. So a
 * composition that references a CDN script, a Google font, or a remote image fails loudly
 * instead of fetching. Provisioning (installing the pinned CLI, Chrome for Testing, GSAP) is the
 * only step that reaches the network, and it runs only when the cached copy is missing.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GSAP_PROJECT_PATH, GSAP_SHA256, GSAP_VERSION, HYPERFRAMES_VERSION, seamCacheDir } from "./constants";
import { assertSafeArgs, buildEnv } from "./env";
import { atomicWrite, confinedPath } from "../lib/Boundary";
import { invariant } from "../Invariant";

export interface ProcResult { code: number; stdout: string; stderr: string; timedOut: boolean; ms: number }

/** Every live descendant of pid, from one `ps` table. Read before killing: once the parent dies its children reparent to launchd. */
export function descendantPids(pid: number, table?: string): number[] {
  const text = table ?? new TextDecoder().decode(Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" }).stdout);
  const children = new Map<number, number[]>();
  for (const line of text.split("\n")) {
    const [c, p] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(c) || !Number.isInteger(p)) continue;
    children.set(p!, [...(children.get(p!) ?? []), c!]);
  }
  const out: number[] = [];
  const stack = [...(children.get(pid) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (out.includes(next)) continue;
    out.push(next);
    stack.push(...(children.get(next) ?? []));
  }
  return out;
}

/**
 * Kill a child and everything under it. A timed-out `hyperframes render` otherwise leaves its
 * headless Chrome (browser, GPU, renderer processes) running under launchd (seen 2026-09-24).
 */
function killTree(pid: number): void {
  const pids = descendantPids(pid);
  for (const p of [pid, ...pids]) {
    try { process.kill(p, "SIGKILL"); } catch { /* already exited between the ps read and the kill */ }
  }
}

/** Run argv (never a shell string) with a hard timeout. A timeout kills the child and its descendants and reports timedOut. */
export async function runProcess(argv: readonly string[], opts: { env?: Record<string, string>; cwd?: string; timeoutMs: number; stdin?: Uint8Array }): Promise<ProcResult> {
  if (argv.length === 0) throw new Error("runProcess: empty argv");
  const started = performance.now();
  const proc = Bun.spawn([...argv], { env: opts.env, cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: opts.stdin ?? "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(proc.pid); }, opts.timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code: timedOut ? 124 : code, stdout, stderr, timedOut, ms: Math.round(performance.now() - started) };
}

/** Same as runProcess but returns stdout as bytes (ffmpeg raw frames and PCM). */
export async function runProcessBytes(argv: readonly string[], opts: { timeoutMs: number }): Promise<{ code: number; stdout: Uint8Array; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, opts.timeoutMs);
  const [buf, stderr] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code: timedOut ? 124 : code, stdout: new Uint8Array(buf), stderr, timedOut };
}

/**
 * Seatbelt profile: everything allowed except outbound network. Order matters (last match wins):
 * the mDNSResponder socket deny must precede the loopback allow, or the loopback allow stops
 * matching (measured 2026-09-24: with the deny after it, 127.0.0.1 connects failed with EPERM).
 */
export const NETWORK_SANDBOX_PROFILE = [
  "(version 1)",
  "(allow default)",
  '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
  '(deny network-outbound (remote ip "*:*"))',
  '(allow network-outbound (remote ip "localhost:*"))',
].join("\n");

/** Wrap argv in the network sandbox. macOS only; elsewhere the seam refuses rather than render unguarded. */
export function sandboxed(argv: readonly string[]): string[] {
  if (process.platform !== "darwin") {
    throw new Error(`hyperframes seam: the render-time network sandbox is built for macOS only (platform ${process.platform}); no unguarded fallback exists`);
  }
  return ["/usr/bin/sandbox-exec", "-p", NETWORK_SANDBOX_PROFILE, ...argv];
}

function hfArgv(args: readonly string[]): string[] {
  return [process.execPath, "x", `hyperframes@${HYPERFRAMES_VERSION}`, ...args];
}

/** Tool paths HyperFrames should use, pinned so it never goes looking. */
function toolEnv(): Record<string, string> {
  const extra: Record<string, string> = {};
  const ffmpeg = Bun.which("ffmpeg");
  const ffprobe = Bun.which("ffprobe");
  if (ffmpeg) extra.HYPERFRAMES_FFMPEG_PATH = ffmpeg;
  if (ffprobe) extra.HYPERFRAMES_FFPROBE_PATH = ffprobe;
  return extra;
}

/**
 * The only commands allowed to run without the network sandbox: the pinned CLI's version check and its
 * browser download. Anything else (render, snapshot, check, lint, ...) executes composition code and
 * stays sandboxed whatever the caller asks for.
 */
const PROVISIONING_COMMANDS: readonly (readonly string[])[] = [["--version"], ["browser", "ensure"]];

export function isProvisioningCommand(args: readonly string[]): boolean {
  return PROVISIONING_COMMANDS.some((c) => c.length === args.length && c.every((a, i) => a === args[i]));
}

/** Run one HyperFrames command, sandboxed, with the fixed env. Arguments are checked first. */
export async function runHyperFrames(args: readonly string[], opts: { timeoutMs: number; cwd?: string; extraEnv?: Record<string, string>; unsandboxed?: "provisioning" }): Promise<ProcResult> {
  assertSafeArgs(args);
  if (opts.unsandboxed === "provisioning" && !isProvisioningCommand(args)) {
    throw new Error(`hyperframes seam: "${args.slice(0, 2).join(" ")}" cannot run without the network sandbox; only provisioning commands (${PROVISIONING_COMMANDS.map((c) => c.join(" ")).join(", ")}) may`);
  }
  // snapshot runs Gemini vision by default when a key is present; the env carries none, and the opt-out is always passed too.
  const full = args[0] === "snapshot" ? [...args, "--describe", "false"] : [...args];
  const argv = opts.unsandboxed === "provisioning" ? hfArgv(full) : sandboxed(hfArgv(full));
  return runProcess(argv, { env: buildEnv({ ...toolEnv(), ...(opts.extraEnv ?? {}) }), cwd: opts.cwd ?? tmpdir(), timeoutMs: opts.timeoutMs });
}

export interface Installation { version: string; browserPath: string }
let installed: Installation | undefined;

/**
 * Make sure the pinned CLI and its Chrome are cached. First try offline (sandboxed); only when
 * that fails does it run the same command unsandboxed, which downloads from npm / Chrome for Testing.
 */
export async function ensureInstalled(): Promise<Installation> {
  if (installed) return installed;
  let ver = await runHyperFrames(["--version"], { timeoutMs: 60_000 });
  if (ver.code !== 0 || ver.stdout.trim() !== HYPERFRAMES_VERSION) {
    ver = await runHyperFrames(["--version"], { timeoutMs: 300_000, unsandboxed: "provisioning" });
  }
  if (ver.code !== 0 || ver.stdout.trim() !== HYPERFRAMES_VERSION) {
    throw new Error(`hyperframes@${HYPERFRAMES_VERSION} is not runnable (exit ${ver.code}): ${(ver.stderr || ver.stdout).slice(-600)}`);
  }
  let path = await runHyperFrames(["browser", "path"], { timeoutMs: 60_000 });
  if (path.code !== 0 || !existsSync(path.stdout.trim())) {
    const ensure = await runHyperFrames(["browser", "ensure"], { timeoutMs: 600_000, unsandboxed: "provisioning" });
    if (ensure.code !== 0) throw new Error(`hyperframes browser ensure failed (exit ${ensure.code}): ${ensure.stderr.slice(-600)}`);
    path = await runHyperFrames(["browser", "path"], { timeoutMs: 60_000 });
  }
  const browserPath = path.stdout.trim().split("\n").pop() ?? "";
  if (path.code !== 0 || !existsSync(browserPath)) throw new Error(`hyperframes browser path did not resolve to a file: "${browserPath}"`);
  installed = { version: HYPERFRAMES_VERSION, browserPath };
  return installed;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The pinned GSAP file, provisioned from npm into the seam cache once and hash-checked on every use. */
export async function ensureGsap(): Promise<string> {
  const target = join(seamCacheDir(), `gsap-${GSAP_VERSION}`, "gsap.min.js");
  if (existsSync(target) && sha256(target) === GSAP_SHA256) return target;
  const work = mkdtempSync(join(tmpdir(), "lifeos-gsap-"));
  try {
    writeFileSync(join(work, "package.json"), JSON.stringify({ name: "lifeos-gsap-provision", private: true, dependencies: { gsap: GSAP_VERSION } }));
    const res = await runProcess([process.execPath, "install", "--no-save", "--ignore-scripts"], { cwd: work, env: buildEnv(), timeoutMs: 300_000 });
    const src = join(work, "node_modules", "gsap", "dist", "gsap.min.js");
    if (res.code !== 0 || !existsSync(src)) throw new Error(`GSAP ${GSAP_VERSION} provisioning failed (exit ${res.code}): ${res.stderr.slice(-400)}`);
    const got = sha256(src);
    if (got !== GSAP_SHA256) throw new Error(`GSAP ${GSAP_VERSION} hash mismatch: expected ${GSAP_SHA256}, got ${got}`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(src, target);
    return target;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Copy the pinned GSAP into a project and return the relative path to load it from. */
export async function stageGsap(projectDir: string): Promise<string> {
  return placeGsap(projectDir, await ensureGsap());
}

/**
 * Place the GSAP file at src into projectDir/GSAP_PROJECT_PATH (S090, ISA 20261015-security-p1-batch2). The
 * destination is resolved through Boundary.confinedPath, so a symlinked component that leaves the project is
 * refused, a symlink at the destination itself is refused, and the write is atomic (a rename, never a write
 * through whatever sits at the path). A refusal throws with the reason; nothing outside the project is touched.
 */
export function placeGsap(projectDir: string, src: string): string {
  // A project that does not exist yet is created, as HEAD's stageGsap did, so confinedPath has a root to anchor on.
  // Only a path with nothing at it is created; a dangling symlink or other entry is left alone and refused below.
  let rootEntry = true;
  try { lstatSync(projectDir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; rootEntry = false; }
  if (!rootEntry) mkdirSync(projectDir, { recursive: true });
  const lexical = join(projectDir, GSAP_PROJECT_PATH);
  const dest = confinedPath(projectDir, GSAP_PROJECT_PATH);
  if (!dest) throw new Error(`stageGsap: refusing ${lexical}: it resolves outside the project ${projectDir}`);
  let st: ReturnType<typeof lstatSync> | null = null;
  try { st = lstatSync(lexical); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (st?.isSymbolicLink()) throw new Error(`stageGsap: refusing ${lexical}: the destination is a symlink`);
  if (st && !st.isFile()) throw new Error(`stageGsap: refusing ${lexical}: the destination is not a regular file`);
  if (!st || sha256(dest) !== GSAP_SHA256) {
    atomicWrite(dest, readFileSync(src), { mode: 0o644, dirMode: 0o755 });
    invariant(sha256(dest) === sha256(src), `stageGsap: ${dest} does not match its source after the write`);
  }
  return GSAP_PROJECT_PATH;
}
