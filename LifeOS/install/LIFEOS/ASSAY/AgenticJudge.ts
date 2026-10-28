/**
 * AgenticJudge — Assay's one read-only, file-reading judge transport (AssaySystem.md § One eval system).
 * JudgeCall.ts covers judges that answer from text handed to them; this covers judges that must open files
 * themselves. The caller passes the prompt, the directory the judge works in, a strict JSON schema and a model
 * (a registry name or an id). The transport owns the sandboxed run: a read-only sandbox, no session persisted,
 * a private CLI home so the judge shares none of the host install's persona or hooks, the schema enforced by the
 * CLI, and a kill timer. Model ids come from LIFEOS/TOOLS/models.ts, never from this file.
 *
 * Moved here from CrossVendorAudit.ts (2026-10-13) so every eval that needs an agentic judge gets this one.
 * Only an OpenAI model has an agentic transport today; any other vendor returns an honest `ok: false`.
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferenceDisabledBy } from '../TOOLS/Inference';
import { codexHomesRoot } from '../TOOLS/lib/CacheDir';
import { judgeModelId, vendorOf } from './JudgeCall';

/** The registry name used when a caller names no model: the OpenAI lane in models.ts. */
export const DEFAULT_AGENTIC_MODEL = 'sol';
/** The CLI falls back to no reasoning without a config file, and the private home has none, so effort is pinned on the command line. */
export const DEFAULT_AGENTIC_EFFORT = 'low';
export const DEFAULT_AGENTIC_TIMEOUT_MS = 300_000;

// ---- Binary and private home ------------------------------------------------------------------------------

/** Resolve the CLI robustly: env override, then PATH, then common install dirs (public issue #1500: one hard-coded path silently skipped audits). */
export function resolveAgenticBin(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.CODEX_BIN;
  if (override && existsSync(override)) return override;
  const fromPath = Bun.which('codex');
  if (fromPath) return fromPath;
  const candidates = [join(home, '.bun', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
  return candidates.find((p) => existsSync(p)) ?? join(home, '.bun', 'bin', 'codex');
}

/**
 * A distinct private CLI home per process. The user's real home hosts a separate LifeOS-for-Codex install whose
 * AGENTS.md, hooks and read-refusal would put the judge in the DA's persona and stop it reading the work: a
 * "cross-vendor pass" on an audit that never read anything (2026-07-25). Under the 0700 cache root, never tmpdir().
 */
export function isolatedHomePath(prefix: string, pid = process.pid, homesRoot = codexHomesRoot()): string {
  return join(homesRoot, `${prefix}-${pid}`);
}

export async function removeIsolatedHome(home: string): Promise<void> {
  // Bun 1.3 on macOS can return EFAULT recursively removing a directory holding the external auth symlink.
  // Removing the link never touches the credential it points at.
  try { await unlink(join(home, 'auth.json')); } catch { /* absent auth is valid */ }
  await rm(home, { recursive: true, force: true });
}

export function removeIsolatedHomeSync(home: string): void {
  try { unlinkSync(join(home, 'auth.json')); } catch { /* absent auth is valid */ }
  rmSync(home, { recursive: true, force: true });
}

/**
 * Builds one process's private home without touching another run's. Auth is SYMLINKED, never copied, so no
 * credential is duplicated onto disk; absent auth means the user authenticates by API key, which the env carries.
 */
export async function buildIsolatedHome(home: string, realAuth = join(homedir(), '.codex', 'auth.json')): Promise<string> {
  await removeIsolatedHome(home);
  await mkdir(home, { recursive: true });
  if (existsSync(realAuth)) await symlink(realAuth, join(home, 'auth.json'));
  return home;
}

// ---- One run ---------------------------------------------------------------------------------------------

export type AgenticRun = { stdout: string; stderr: string; code: number | null; timedOut?: boolean };
/** The injectable process boundary: tests pass a fake, production spawns the CLI. */
export type AgenticExec = (req: { bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; stdin: string; timeoutMs: number }) => Promise<AgenticRun>;

export type AgenticJudgeOptions = {
  /** The whole judge prompt; piped on stdin. */
  prompt: string;
  /**
   * The run's working directory, where the judge starts reading. Default: the system temp dir. It is not a read
   * boundary: the read-only sandbox stops writes, not reads, so the judge can open any file this user can read.
   */
  readDir?: string;
  /** A strict JSON schema file the CLI enforces on the final answer. */
  schemaPath?: string;
  /** Or the schema itself, written into the private home for this run. `schemaPath` wins when both are given. */
  schema?: object;
  /** A registry name (a models.ts key) or a model id. Default: the OpenAI lane. */
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  /** A private home the caller built and will clean (so it can run preflight in it). Absent: built and removed for this call. */
  home?: string;
  exec?: AgenticExec;
  bin?: string;
  env?: NodeJS.ProcessEnv;
  /** Whether a configured CLI auth file exists; drives the env scrub. Default: look. */
  authConfigured?: boolean;
};

export type AgenticJudgeResult = {
  ok: boolean;
  /** The CLI's stdout: the judge's final answer. Empty on failure. */
  text: string;
  /** The answer parsed as one JSON object, when it holds one. */
  json?: unknown;
  /** The model that ran: the id the CLI reported, else the requested id marked unverified. */
  model: string;
  error?: string;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
};

/** The model's id and vendor for a registry name or id; throws on a model with no agentic transport. */
export function agenticModel(name = DEFAULT_AGENTIC_MODEL): string {
  const id = judgeModelId(name) ?? name;
  if (vendorOf(id) !== 'openai') throw new Error(`no agentic judge transport for ${name} (${id}, vendor ${vendorOf(id)}): only OpenAI models run through the codex transport`);
  return id;
}

/** The CLI argv for one read-only run. Pure. */
export function agenticArgs(o: { schemaPath: string; model: string; reasoningEffort?: string }): string[] {
  return [
    'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral',
    '-c', `model_reasoning_effort="${o.reasoningEffort ?? DEFAULT_AGENTIC_EFFORT}"`,
    '--output-schema', o.schemaPath, '--model', o.model, '-',
  ];
}

/**
 * The child's environment. The CLI's auth precedence puts OPENAI_API_KEY and OPENAI_BASE_URL above its auth file,
 * so a stray key in the parent shell silently flips a subscription run to API billing; they are scrubbed only when
 * an auth file is configured (a user who authenticates solely by key keeps working). CODEX_HOME is the private home.
 */
export function agenticEnv(base: NodeJS.ProcessEnv, home: string, authConfigured: boolean): NodeJS.ProcessEnv {
  const env = { ...base };
  if (authConfigured) { delete env.OPENAI_API_KEY; delete env.OPENAI_BASE_URL; }
  env.CODEX_HOME = home;
  return env;
}

/** The first JSON object in a text: the whole text, else the span from its first `{` to its last `}`. */
export function parseJsonObject(text: string): unknown | undefined {
  const t = text.trim();
  for (const candidate of [t, t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) {
    if (!candidate.startsWith('{')) continue;
    try { return JSON.parse(candidate); } catch { /* try the next span */ }
  }
  return undefined;
}

/** The model id the CLI prints in its run header (`model: <id>` on stderr), when it prints one. */
export function reportedModel(stderr: string): string | undefined {
  return stderr.match(/^model:\s*(\S+)/im)?.[1];
}

const spawnExec: AgenticExec = ({ bin, args, env, cwd, stdin, timeoutMs }) => new Promise((resolvePromise) => {
  const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => {
    proc.kill('SIGTERM');
    resolvePromise({ stdout, stderr: stderr + `\n[TIMEOUT after ${timeoutMs / 1000}s]`, code: 124, timedOut: true });
  }, timeoutMs);
  proc.stdout.on('data', (c) => (stdout += c.toString()));
  proc.stderr.on('data', (c) => (stderr += c.toString()));
  proc.on('error', (e) => { clearTimeout(timer); resolvePromise({ stdout, stderr: stderr + String(e), code: 127 }); });
  proc.on('close', (code) => { clearTimeout(timer); resolvePromise({ stdout, stderr, code }); });
  proc.stdin.write(stdin);
  proc.stdin.end();
});

const fail = (model: string, error: string, run?: Partial<AgenticRun>): AgenticJudgeResult =>
  ({ ok: false, text: '', model, error, stdout: run?.stdout ?? '', stderr: run?.stderr ?? '', code: run?.code ?? null, timedOut: run?.timedOut ?? false });

/** One agentic judge run. Never throws: a refusal, a missing CLI, a timeout or a bad exit is `ok: false` with the reason. */
export async function agenticJudge(o: AgenticJudgeOptions): Promise<AgenticJudgeResult> {
  let id: string;
  try { id = agenticModel(o.model); } catch (e) { return fail(o.model ?? DEFAULT_AGENTIC_MODEL, (e as Error).message); }
  const disabled = inferenceDisabledBy(o.env ?? process.env);
  if (disabled) return fail(`${id} (not run)`, `inference disabled in this context (LIFEOS_INFERENCE_DISABLED=${disabled})`);
  if (!o.schemaPath && !o.schema) return fail(id, 'agentic judge needs a schema or schemaPath: the answer must be schema-enforced');

  const ownsHome = !o.home;
  const home = o.home ?? isolatedHomePath('judge');
  try {
    if (ownsHome) await buildIsolatedHome(home);
    let schemaPath = o.schemaPath;
    if (!schemaPath) {
      schemaPath = join(home, 'schema.json');
      await mkdir(home, { recursive: true });
      await writeFile(schemaPath, JSON.stringify(o.schema), 'utf8');
    }
    const authConfigured = o.authConfigured ?? existsSync(join(homedir(), '.codex', 'auth.json'));
    const run = await (o.exec ?? spawnExec)({
      bin: o.bin ?? resolveAgenticBin(),
      args: agenticArgs({ schemaPath, model: id, reasoningEffort: o.reasoningEffort }),
      env: agenticEnv(o.env ?? process.env, home, authConfigured),
      cwd: o.readDir ?? tmpdir(),
      stdin: o.prompt,
      timeoutMs: o.timeoutMs ?? DEFAULT_AGENTIC_TIMEOUT_MS,
    });
    const model = reportedModel(run.stderr) ?? `${id} (unverified)`;
    if (run.timedOut || run.code === 124) return { ...fail(model, `timeout at ${(o.timeoutMs ?? DEFAULT_AGENTIC_TIMEOUT_MS) / 1000}s`, run), code: 124, timedOut: true };
    if (run.code !== 0) return fail(model, `exit ${run.code}: ${run.stderr.slice(0, 200)}`, run);
    return { ok: true, text: run.stdout, json: parseJsonObject(run.stdout), model, stdout: run.stdout, stderr: run.stderr, code: 0, timedOut: false };
  } catch (e) {
    return fail(id, (e as Error).message);
  } finally {
    if (ownsHome) await removeIsolatedHome(home).catch(() => { /* best effort */ });
  }
}

// ---- Preflight --------------------------------------------------------------------------------------------

/**
 * `codex doctor --json` reports overallStatus across install, config, auth and runtime. Fail-OPEN by design: only
 * an explicit "fail" blocks a run. If doctor cannot run or parse, proceed; a preflight must never become a new
 * failure source. 30s cap.
 */
export function agenticPreflight(home: string, bin = resolveAgenticBin()): Promise<{ healthy: boolean; summary: string }> {
  return new Promise((resolvePromise) => {
    const proc = spawn(bin, ['doctor', '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: home } });
    let out = '';
    const timer = setTimeout(() => { proc.kill('SIGTERM'); resolvePromise({ healthy: true, summary: 'doctor timed out (proceeding)' }); }, 30_000);
    proc.stdout.on('data', (c) => (out += c.toString()));
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const status = (JSON.parse(out) as { overallStatus?: string }).overallStatus ?? 'unknown';
        resolvePromise({ healthy: status !== 'fail', summary: `overallStatus=${status}` });
      } catch {
        resolvePromise({ healthy: true, summary: 'doctor unparseable (proceeding)' });
      }
    });
    proc.on('error', () => { clearTimeout(timer); resolvePromise({ healthy: true, summary: 'doctor unavailable (proceeding)' }); });
  });
}
