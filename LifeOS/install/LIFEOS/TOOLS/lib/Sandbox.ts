/**
 * Sandbox.ts — the one macOS (Seatbelt) confinement for running code LifeOS did not write and nobody has ratified.
 *
 * Two callers share it: the Achilles lander runs worker-made tests under it (AchillesRemediate.makeSandboxedSpawn),
 * and IscTier runs every unratified probe under it (a criterion's quoted command, a test file a criterion names, a
 * drafted producer), so criterion text can no longer execute code with write access before a person ratifies it.
 *
 * The profile: the whole filesystem is readable except the credential stores (credentialReadDenies: keychains, ssh,
 * cloud and package-manager credentials, gh, netrc, git credentials, agent CLI auth files, browser profiles, every
 * .env and the config root's .env), writes land only in the scratch roots (the temp dirs) and never under the Bun
 * install (bunInstallRoots, denied after the scratch allow so no scratch root can re-open it), and the network
 * reaches only this machine unless the caller opens it for a fixed-shape fetch. Where the sandbox cannot be applied (not macOS, or sandbox-exec missing) nothing runs: the
 * result is SANDBOX_UNAVAILABLE_CODE, never an unconfined run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invariant } from "../Invariant";
import { claudeDirFor } from "../Paths";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Exit code a refused run reports: the sandbox could not be applied, so nothing ran. */
export const SANDBOX_UNAVAILABLE_CODE = 126;

export interface SandboxProfileOptions {
  /** Let the confined process reach remote hosts (a fixed-shape curl probe). Default: local only. */
  network?: boolean;
  /** Directories no confined write may touch. Default: bunInstallRoots() for this process and home. */
  bunInstallRoots?: string[];
  /** The LifeOS config root whose .env is denied by name. Default: CLAUDE_CONFIG_DIR, else <home>/.claude. */
  configRoot?: string;
}

/** A path and, when it resolves elsewhere, its real path: Seatbelt matches the resolved path, so both are listed. */
function withReal(p: string): string[] {
  try { const r = realpathSync(p); return r === p ? [p] : [p, r]; } catch { return [p]; }
}

/**
 * The Bun install a confined probe must never write: ~/.bun (bin/ shims and install/global packages run unconfined
 * later), $BUN_INSTALL, and the install the running bun came from (the binary's grandparent, e.g. a Cellar/<version>
 * dir, or its own bin dir when the grandparent is the filesystem root or the home itself).
 */
export function bunInstallRoots(seams: { execPath?: string; home?: string; bunInstall?: string } = {}): string[] {
  const home = seams.home ?? process.env.HOME ?? "";
  const bunInstall = seams.bunInstall ?? process.env.BUN_INSTALL;
  const roots = new Set<string>();
  if (home) roots.add(join(home, ".bun"));
  if (bunInstall) roots.add(bunInstall);
  const exec = seams.execPath ?? process.execPath;
  if (exec && exec.startsWith("/")) {
    for (const bin of withReal(exec)) {
      const binDir = dirname(bin);
      const top = dirname(binDir);
      roots.add(top === "/" || top === home ? binDir : top);
    }
  }
  return [...new Set([...roots].filter((r) => r !== "/" && r !== home).flatMap(withReal))];
}

/**
 * The credential stores a confined probe may not read, as Seatbelt filters: directories as subpaths, single files as
 * literals. Ordinary home and repo files stay readable, since probes still read source, config and ~/.bunfig.toml.
 */
export function credentialReadDenies(home: string, configRoot: string = claudeDirFor(process.env, home)): { subpath: string[]; literal: string[] } {
  const appSupport = join(home, "Library", "Application Support");
  const subpath = [
    ".ssh", ".aws", ".gnupg", ".config/gh", ".config/hub", ".config/gcloud", ".azure", ".kube", ".docker",
    ".password-store", ".config/op", ".gemini", ".codex", "Library/Keychains", "Library/Cookies",
    "Library/Containers/com.apple.Safari", "Library/Safari",
  ].map((r) => join(home, r));
  subpath.push("/Library/Keychains", "/private/var/db/SystemKey");
  for (const b of ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium", "BraveSoftware", "Microsoft Edge", "Arc", "Vivaldi", "com.operasoftware.Opera", "Firefox", "zen"]) subpath.push(join(appSupport, b));
  const literal = [
    ".netrc", ".git-credentials", ".config/git/credentials", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc",
    ".cargo/credentials", ".cargo/credentials.toml", ".gem/credentials", ".terraform.d/credentials.tfrc.json",
  ].map((r) => join(home, r));
  literal.push(join(configRoot, ".env"), join(configRoot, ".credentials.json"));
  return { subpath: [...new Set(subpath.flatMap(withReal))], literal: [...new Set(literal.flatMap(withReal))] };
}

/**
 * The Seatbelt profile. Path values are asserted free of quote, backslash and newline so a path can never close its
 * own string and add a rule.
 */
export function sandboxProfile(writableRoots: string[], home: string, opts: SandboxProfileOptions = {}): string {
  const lit = (p: string) => { invariant(p.length > 0 && !/["\\\n]/.test(p), "sandbox paths carry no quote, backslash or newline"); return `"${p}"`; };
  const bun = opts.bunInstallRoots ?? bunInstallRoots({ home });
  invariant(bun.length > 0 && !bun.includes("/"), "the Bun install roots are named and never the filesystem root");
  const creds = credentialReadDenies(home, opts.configRoot);
  const network = opts.network
    ? ["(allow network*)"]
    : [
      "(deny network*)",
      `(allow network* (local ip "localhost:*") (remote ip "localhost:*") (local ip "*:*"))`,
      "(allow network* (remote unix-socket) (local unix-socket))",
      `(deny network-outbound (remote ip "*:*"))`,
      `(allow network-outbound (remote ip "localhost:*") (remote unix-socket))`,
    ];
  return [
    "(version 1)",
    "(allow default)",
    ...network,
    "(deny file-write*)",
    `(allow file-write* ${["/dev", ...writableRoots].map((p) => `(subpath ${lit(p)})`).join(" ")})`,
    // After the allow: Seatbelt takes the last matching rule, so no scratch root can re-open the Bun install.
    `(deny file-write* ${bun.map((p) => `(subpath ${lit(p)})`).join(" ")})`,
    `(deny file-read* ${creds.subpath.map((p) => `(subpath ${lit(p)})`).join(" ")} ${creds.literal.map((p) => `(literal ${lit(p)})`).join(" ")} (regex #"/\\.env($|\\.)"))`,
  ].join("\n");
}

/**
 * The scratch roots a confined run may write: the temp dirs. Nothing in a repo, the home or the Bun install (~/.bun
 * holds bin/ shims and global packages that run unconfined later; bun test runs without writing it). The `home`
 * parameter stays for callers' signatures.
 */
export function scratchWriteRoots(_home: string = process.env.HOME ?? ""): string[] {
  return [...new Set<string>(["/private/tmp", "/private/var/folders", realpathSync(tmpdir())])];
}

export interface SandboxSeams {
  /** Platform seam; defaults to process.platform. Only darwin has a confinement backend. */
  platform?: NodeJS.Platform;
  /** Sandbox binary seam; defaults to /usr/bin/sandbox-exec. */
  sandboxExec?: string;
  /** Existence seam for the sandbox binary; defaults to fs.existsSync. */
  exists?: (path: string) => boolean;
}

export interface SandboxRunOptions extends SandboxSeams, SandboxProfileOptions {
  cwd?: string;
  input?: string;
  /** The child's whole environment. The caller scrubs it; nothing from process.env is added here. */
  env: Record<string, string | undefined>;
  /** Kill the run (SIGKILL) after this many ms; the run then reports failure. Unset means unbounded (the caller owns the clock). */
  timeoutMs?: number;
  /** The home whose credential stores and ~/.bun are denied. Default: process.env.HOME. */
  home?: string;
}

export interface SandboxRunResult { code: number; out: string; err: string; ran: boolean }

/** Why the sandbox cannot be applied here, or null when it can. */
export function sandboxUnavailable(seams: SandboxSeams = {}): string | null {
  const platform = seams.platform ?? process.platform;
  const sandboxExec = seams.sandboxExec ?? SANDBOX_EXEC;
  const exists = seams.exists ?? existsSync;
  if (platform !== "darwin" || !exists(sandboxExec)) return `sandbox unavailable (platform ${platform}, ${sandboxExec}): refusing to run unratified code unconfined`;
  return null;
}

/** Run argv confined. Never throws for a run failure; a sandbox that cannot be applied runs nothing (`ran: false`). */
export function runSandboxed(argv: string[], o: SandboxRunOptions): SandboxRunResult {
  invariant(argv.length > 0 && typeof argv[0] === "string" && argv[0].length > 0, "a sandboxed run needs a program");
  const refused = sandboxUnavailable(o);
  if (refused) return { code: SANDBOX_UNAVAILABLE_CODE, out: "", err: refused, ran: false };
  const home = o.home ?? process.env.HOME ?? "";
  const profile = sandboxProfile(scratchWriteRoots(home), home || "/nonexistent", { network: o.network, bunInstallRoots: o.bunInstallRoots ?? bunInstallRoots({ home: home || undefined }), configRoot: o.configRoot });
  const cmd = [o.sandboxExec ?? SANDBOX_EXEC, "-p", profile, ...argv];
  const p = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd: o.cwd, input: o.input, encoding: "utf8", env: o.env as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024,
    ...(o.timeoutMs !== undefined ? { timeout: o.timeoutMs, killSignal: "SIGKILL" as const } : {}),
  });
  if (p.error || p.signal) {
    const why = p.signal ? `killed by ${p.signal}${o.timeoutMs !== undefined ? ` (timeout ${o.timeoutMs}ms)` : ""}` : String(p.error);
    return { code: p.status && p.status !== 0 ? p.status : 1, out: p.stdout ?? "", err: `${p.stderr ?? ""}\n${why}`.trim(), ran: true };
  }
  return { code: p.status ?? 1, out: p.stdout ?? "", err: p.stderr ?? "", ran: true };
}
