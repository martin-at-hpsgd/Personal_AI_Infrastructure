#!/usr/bin/env bun
/**
 * Dictation — set up and check push-to-talk dictation: the dictation app driven by a
 * Stream Deck foot pedal and by Right Ctrl+J through Hammerspoon.
 *
 *   bun LIFEOS/DICTATION/Dictation.ts check             one line per piece, exit 1 naming failures
 *   bun LIFEOS/DICTATION/Dictation.ts setup [--dry-run] clone/update, build, link, set the engine; then the by-hand steps
 *
 * Doc: LIFEOS/DOCUMENTATION/Dictation/DictationSystem.md
 * Principal-specific values come from the USER zone at runtime: the repo URL and
 * clone path from LIFEOS/USER/CUSTOMIZATIONS/DICTATION/config.json, and the
 * dictation app itself (name, bundle id, history table, mic probe) from App.ts
 * beside it. This file names no current dictation vendor; the one vendor word left
 * is in the retired mute app's old label and bundle name (RETIRED_MUTE_ID,
 * retiredMuteLeftovers), which must match those leftovers on disk to remove them.
 *
 * Every file-system location and every side effect (commands) is injected
 * through `DictationEnv`, so tests run against a synthesized fixture tree and
 * never touch the live install.
 *
 * The pedal repo and its identifiers (plugin UUID, Hammerspoon module, support
 * folder, log, preroll helper) are vendor-neutral since 2026-10-04.
 *
 * @version 2.0.0
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { invariant } from "../TOOLS/Invariant";
import { expandPath, lifeosPath } from "../TOOLS/Paths";

// ─── Constants ────────────────────────────────────────────────────────────────

export const PLUGIN_UUID = "com.lifeos.dictationpedal";
export const ACTION_UUID = `${PLUGIN_UUID}.dictate`;
export const ACTION_NAME = "Dictate (tap or hold)";
export const PLUGIN_DIR_NAME = `${PLUGIN_UUID}.sdPlugin`;
export const MODULE_FILE = "dictation_keys.lua";
export const DEFAULT_REPO_DIR = "~/Projects/dictation-pedal";
/** Files a usable clone must contain. */
export const REPO_FILES = ["install.ts", "src/plugin.ts", "src/dictate.ts", "src/keyboard.ts", `keyboard/${MODULE_FILE}`];
/** Label of the retired CoreAudio mute app. Its leftovers make check fail; setup removes them. */
export const RETIRED_MUTE_ID = "com.lifeos.typelessmute";
export const PREROLL_ID = "com.lifeos.dictationpreroll";

/** The dictation app, as the USER zone's App.ts describes it. */
export interface DictationApp {
  label: string;
  bundleId: string;
  cask: string;
  /** The word the pedal repo's engine file must hold. */
  engine: string;
  /** Auto-Enter's source: a SQLite table, db path relative to ~/Library/Application Support. */
  history: { db: string; table: string; columns: string[] };
  /** The by-hand step that gets the app signed in and permitted. */
  onboarding: string;
  /** Where the user picks the app's microphone. */
  micSetting: string;
  /** Whether the app records from the preroll bridge; absent means it cannot tell. */
  usesPreroll?: (home: string) => boolean;
}

/** The two helper apps, found by bundle identifier so an install anywhere under an Applications folder counts. */
export const HELPER_APPS = [
  { label: "Hammerspoon", bundleId: "org.hammerspoon.Hammerspoon", cask: "hammerspoon" },
  { label: "Stream Deck", bundleId: "com.elgato.StreamDeck", cask: "elgato-stream-deck" },
] as const;

const TIMEOUT = {
  probe: 5_000,
  git: 15_000,
  fetch: 60_000,
  clone: 180_000,
  install: 300_000,
  codesign: 30_000,
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DictationConfig {
  /** Clone URL of the pedal repo; null when neither config nor an existing clone provides one. */
  repoUrl: string | null;
  /** Absolute path of the local clone. */
  repoDir: string;
}

export interface DictationPaths {
  home: string;
  /** Folders searched for the apps. */
  appDirs: string[];
  /** ~/Library/Application Support, where the app's history database lives. */
  appSupport: string;
  /** One word naming the app the pedal drives, read by the pedal code on every press. */
  engineFile: string;
  pluginDir: string;
  profilesDir: string;
  hammerspoonDir: string;
  log: string;
  repoDir: string;
  launchAgentsDir: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (argv: string[], opts: { cwd?: string; timeoutMs: number }) => CommandResult;

export interface DictationEnv {
  paths: DictationPaths;
  config: DictationConfig;
  configPath: string;
  /** Null when the USER zone names no dictation app. */
  app: DictationApp | null;
  appPath: string;
  run: Runner;
  /** The bun binary used to run the repo's install.ts. */
  bunPath: string;
}

export type CheckStatus = "ok" | "warn" | "fail" | "info";

export interface CheckResult {
  piece: string;
  status: CheckStatus;
  detail: string;
}

export type StepState = "ok" | "todo" | "skip" | "blocked";

export interface Step {
  id: string;
  title: string;
  state: StepState;
  detail: string;
  /** Present only when state is "todo". */
  apply?: () => void;
}

export interface SetupOutcome {
  steps: Step[];
  applied: string[];
  blocked: Step[];
}

// ─── Config and paths ─────────────────────────────────────────────────────────

export function defaultConfigPath(): string {
  return lifeosPath("USER", "CUSTOMIZATIONS", "DICTATION", "config.json");
}

export function defaultAppPath(): string {
  return lifeosPath("USER", "CUSTOMIZATIONS", "DICTATION", "App.ts");
}

/** Loads the USER zone's App.ts. Absent means null; present but malformed is an error, never silently ignored. */
export function loadApp(path: string): DictationApp | null {
  if (!existsSync(path)) return null;
  const mod = require(path) as { app?: Record<string, unknown>; usesPreroll?: unknown };
  const a = mod.app;
  const str = (k: string) => typeof a?.[k] === "string" && (a[k] as string).trim() !== "";
  const h = a?.history as Record<string, unknown> | undefined;
  const ok =
    a && ["label", "bundleId", "cask", "engine", "onboarding", "micSetting"].every(str) &&
    typeof h?.db === "string" && typeof h?.table === "string" && Array.isArray(h?.columns) && (h.columns as unknown[]).every((c) => typeof c === "string");
  if (!ok) throw new Error(`${path} must export app { label, bundleId, cask, engine, history { db, table, columns }, onboarding, micSetting }`);
  return { ...(a as unknown as DictationApp), ...(typeof mod.usesPreroll === "function" ? { usesPreroll: mod.usesPreroll as (home: string) => boolean } : {}) };
}

/**
 * Reads the USER-zone config. A missing file means defaults; a present but
 * malformed file is an error, never silently ignored.
 */
export function loadConfig(path: string, home: string = homedir()): DictationConfig {
  const expand = (p: string) => (p === "~" || p.startsWith("~/") ? join(home, p.slice(1)) : expandPath(p));
  const defaults: DictationConfig = { repoUrl: null, repoDir: expand(DEFAULT_REPO_DIR) };
  if (!existsSync(path)) return defaults;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path} must hold a JSON object`);
  }
  const obj = raw as Record<string, unknown>;

  let repoUrl: string | null = null;
  if (obj.repoUrl !== undefined) {
    if (typeof obj.repoUrl !== "string" || !/^(https:\/\/|git@|ssh:\/\/)\S+$/.test(obj.repoUrl)) {
      throw new Error(`${path}: repoUrl must be an https://, ssh:// or git@ URL`);
    }
    repoUrl = obj.repoUrl;
  }
  let repoDir = defaults.repoDir;
  if (obj.repoDir !== undefined) {
    if (typeof obj.repoDir !== "string" || obj.repoDir.trim() === "") {
      throw new Error(`${path}: repoDir must be a non-empty path`);
    }
    repoDir = resolve(expand(obj.repoDir));
  }
  return { repoUrl, repoDir };
}

export function defaultPaths(repoDir: string, home: string = homedir()): DictationPaths {
  const support = join(home, "Library", "Application Support");
  return {
    home,
    appDirs: ["/Applications", join(home, "Applications")],
    appSupport: support,
    engineFile: join(support, "DictationPedal", "engine"),
    pluginDir: join(support, "com.elgato.StreamDeck", "Plugins", PLUGIN_DIR_NAME),
    profilesDir: join(support, "com.elgato.StreamDeck", "ProfilesV3"),
    hammerspoonDir: join(home, ".hammerspoon"),
    log: join(home, "Library", "Logs", "DictationPedal.log"),
    repoDir,
    launchAgentsDir: join(home, "Library", "LaunchAgents"),
  };
}

/** Real command runner: argv arrays only, never a shell, always a timeout. */
export const realRunner: Runner = (argv, { cwd, timeoutMs }) => {
  const proc = Bun.spawnSync({ cmd: argv, cwd, timeout: timeoutMs, stdout: "pipe", stderr: "pipe" });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  if (proc.exitCode === null) {
    return { code: 124, stdout, stderr: `${stderr}\n${argv.join(" ")}: killed after ${timeoutMs}ms (${proc.signalCode ?? "timeout"})`.trim() };
  }
  return { code: proc.exitCode, stdout, stderr };
};

/**
 * The installed app bundle whose CFBundleIdentifier is `bundleId`, or null.
 * XML plists are parsed directly; a binary plist is confirmed with plutil
 * (`-o -`, which never rewrites the file).
 */
export function findApp(appDirs: readonly string[], bundleId: string, run: Runner): string | null {
  const needle = Buffer.from(bundleId);
  for (const dir of appDirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".app")) continue;
      const plist = join(dir, name, "Contents", "Info.plist");
      let bytes: Buffer;
      try {
        bytes = readFileSync(plist);
      } catch {
        continue; // No Info.plist: not an app bundle we can identify.
      }
      if (!bytes.includes(needle)) continue;
      const text = bytes.toString("utf8");
      if (text.startsWith("<?xml")) {
        const id = text.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
        if (id === bundleId) return join(dir, name);
        continue;
      }
      const r = run(["plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", plist], { timeoutMs: TIMEOUT.probe });
      if (r.code === 0 && r.stdout.trim() === bundleId) return join(dir, name);
    }
  }
  return null;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * A `require("dictation_keys")` line that is not commented out. Accepts both quote
 * styles, the paren-less form, and the guarded `pcall(require, "dictation_keys")`.
 */
export function hasActiveRequire(initLua: string): boolean {
  return initLua
    .split("\n")
    .some((line) =>
      /^\s*(?:local\s+[\w\s,]+=\s*)?(?:require\s*\(?\s*["']dictation_keys["']\s*\)?|pcall\s*\(\s*require\s*,\s*["']dictation_keys["']\s*\))/.test(line),
    );
}

/** The engine file's word, or null when it is missing or unreadable. */
export function readEngine(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Files the retired CoreAudio mute app left behind, if any. */
export function retiredMuteLeftovers(paths: DictationPaths): string[] {
  return [
    join(paths.launchAgentsDir, `${RETIRED_MUTE_ID}.plist`),
    join(paths.launchAgentsDir, `${RETIRED_MUTE_ID}.plist.disabled`),
    join(paths.home, "Applications", "TypelessMute.app"),
  ].filter((f) => lstatOrNull(f) !== null);
}

function tilde(p: string, home: string): string {
  return p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else if (entry.isFile()) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

function isExecutableFile(p: string): boolean {
  try {
    const s = statSync(p);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** Why the installed plugin needs a (re)build, or null when it is current. */
export function pluginStaleReason(env: DictationEnv): string | null {
  const { pluginDir, repoDir } = env.paths;
  const bin = join(pluginDir, "bin", "plugin");
  const installedManifest = join(pluginDir, "manifest.json");
  const repoManifest = join(repoDir, "plugin", PLUGIN_DIR_NAME, "manifest.json");
  if (!existsSync(installedManifest)) return "not installed";
  if (!isExecutableFile(bin)) return "plugin binary missing or not executable";
  if (env.run(["codesign", "-v", bin], { timeoutMs: TIMEOUT.codesign }).code !== 0) return "plugin binary signature does not verify";
  if (existsSync(repoManifest) && readFileSync(repoManifest, "utf8") !== readFileSync(installedManifest, "utf8")) {
    return "installed manifest differs from the repo's";
  }
  const builtAt = statSync(bin).mtimeMs;
  const sourceAt = Math.max(newestMtime(join(repoDir, "src")), newestMtime(join(repoDir, "plugin")));
  if (sourceAt > builtAt) return "source changed since the plugin was built";
  return null;
}

interface ProfileHit {
  profile: string;
  slot: string;
}

/** Every Stream Deck profile page slot that holds the Dictate action. */
export function findPedalMappings(profilesDir: string): ProfileHit[] {
  const hits: ProfileHit[] = [];
  if (!existsSync(profilesDir)) return hits;
  for (const profile of readdirSync(profilesDir)) {
    if (!profile.endsWith(".sdProfile")) continue;
    const profileRoot = join(profilesDir, profile);
    let profileName = profile;
    try {
      const top: unknown = JSON.parse(readFileSync(join(profileRoot, "manifest.json"), "utf8"));
      if (typeof top === "object" && top !== null && typeof (top as Record<string, unknown>).Name === "string") {
        profileName = (top as Record<string, string>).Name;
      }
    } catch {
      // A profile without a readable top manifest still has pages worth scanning; keep the directory name.
    }
    const pagesDir = join(profileRoot, "Profiles");
    if (!existsSync(pagesDir)) continue;
    for (const page of readdirSync(pagesDir)) {
      const manifest = join(pagesDir, page, "manifest.json");
      if (!existsSync(manifest)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(manifest, "utf8"));
      } catch {
        continue; // Stream Deck mid-write or a corrupt page: not a mapping we can count on.
      }
      const controllers = (parsed as { Controllers?: unknown })?.Controllers;
      if (!Array.isArray(controllers)) continue;
      for (const controller of controllers) {
        const actions = (controller as { Actions?: unknown })?.Actions;
        if (typeof actions !== "object" || actions === null) continue;
        for (const [slot, action] of Object.entries(actions as Record<string, unknown>)) {
          if ((action as { UUID?: unknown })?.UUID === ACTION_UUID) hits.push({ profile: profileName, slot });
        }
      }
    }
  }
  return hits;
}

/** The bun binary and keyboard script the Hammerspoon module launches, read from its source. */
export function adapterPaths(lua: string, home: string): { bun: string | null; script: string | null } {
  const bun = lua.match(/local\s+BUN\s*=\s*"([^"]+)"/)?.[1] ?? null;
  const rel = lua.match(/local\s+SCRIPT\s*=\s*os\.getenv\(\s*"HOME"\s*\)\s*\.\.\s*"([^"]+)"/)?.[1];
  return { bun, script: rel ? join(home, rel) : null };
}

// ─── check ────────────────────────────────────────────────────────────────────

export function runChecks(env: DictationEnv): CheckResult[] {
  const { paths } = env;
  const t = (p: string) => tilde(p, paths.home);
  const out: CheckResult[] = [];
  const add = (piece: string, status: CheckStatus, detail: string) => out.push({ piece, status, detail });

  const app = env.app;
  if (!app) add("dictation app", "fail", `${t(env.appPath)} names no dictation app`);
  for (const a of [...(app ? [app] : []), ...HELPER_APPS]) {
    const found = findApp(paths.appDirs, a.bundleId, env.run);
    if (found) add(`${a.label.toLowerCase()} app`, "ok", t(found));
    else add(`${a.label.toLowerCase()} app`, "fail", `not installed (${a.bundleId}); brew install --cask ${a.cask}`);
  }

  const missing = REPO_FILES.filter((f) => !existsSync(join(paths.repoDir, f)));
  const repoOk = missing.length === 0;
  if (repoOk) add("repo clone", "ok", t(paths.repoDir));
  else add("repo clone", "fail", `${t(paths.repoDir)} is missing ${missing.join(", ")}`);

  const bin = join(paths.pluginDir, "bin", "plugin");
  const manifestPath = join(paths.pluginDir, "manifest.json");
  let pluginOk = false;
  if (!existsSync(manifestPath)) {
    add("stream deck plugin", "fail", `not installed at ${t(paths.pluginDir)}`);
  } else {
    let uuid: unknown = null;
    try {
      uuid = (JSON.parse(readFileSync(manifestPath, "utf8")) as { UUID?: unknown }).UUID;
    } catch {
      uuid = null;
    }
    if (uuid !== PLUGIN_UUID) add("stream deck plugin", "fail", `manifest UUID is ${String(uuid)}, expected ${PLUGIN_UUID}`);
    else if (!isExecutableFile(bin)) add("stream deck plugin", "fail", "bin/plugin missing or not executable");
    else if (env.run(["codesign", "-v", bin], { timeoutMs: TIMEOUT.codesign }).code !== 0) {
      add("stream deck plugin", "fail", "bin/plugin signature does not verify; macOS will kill it on launch");
    } else {
      pluginOk = true;
      add("stream deck plugin", "ok", "installed, binary signed");
    }
  }
  if (pluginOk && repoOk) {
    const stale = pluginStaleReason(env);
    if (stale) add("plugin freshness", "warn", `${stale}; run setup, then restart Stream Deck`);
    else add("plugin freshness", "ok", "built from the current source");
  }

  if (app) {
    const engineWord = readEngine(paths.engineFile);
    if (engineWord === app.engine) add("engine", "ok", `the pedal drives ${app.label}`);
    else add("engine", "fail", `${t(paths.engineFile)} says ${engineWord ?? "nothing"}, not ${app.engine}; run setup`);
  }

  const link = join(paths.hammerspoonDir, MODULE_FILE);
  const expected = join(paths.repoDir, "keyboard", MODULE_FILE);
  let moduleSource: string | null = null;
  const linkStat = lstatOrNull(link);
  if (!linkStat) {
    add("hammerspoon module", "fail", `${t(link)} does not exist`);
  } else if (linkStat.isSymbolicLink()) {
    let real: string | null = null;
    try {
      real = realpathSync(link);
    } catch {
      real = null;
    }
    if (!real) add("hammerspoon module", "fail", `${t(link)} is a dangling link to ${readlinkSync(link)}`);
    else {
      moduleSource = readFileSync(real, "utf8");
      const expectedReal = existsSync(expected) ? realpathSync(expected) : expected;
      if (real === expectedReal) add("hammerspoon module", "ok", `linked to ${t(expected)}`);
      else add("hammerspoon module", "warn", `links to ${t(real)}, not the configured clone`);
    }
  } else {
    moduleSource = readFileSync(link, "utf8");
    add("hammerspoon module", "warn", `${t(link)} is a copy, not a link; repo changes will not reach it`);
  }

  const initLua = join(paths.hammerspoonDir, "init.lua");
  if (!existsSync(initLua)) add("hammerspoon require", "fail", `${t(initLua)} does not exist`);
  else if (hasActiveRequire(readFileSync(initLua, "utf8"))) add("hammerspoon require", "ok", "init.lua requires dictation_keys");
  else add("hammerspoon require", "fail", `init.lua has no active require("dictation_keys") line`);

  if (moduleSource !== null) {
    const { bun, script } = adapterPaths(moduleSource, paths.home);
    if (!bun || !script) add("keyboard adapter", "warn", "could not read BUN and SCRIPT from the module; paths not verified");
    else if (!existsSync(bun)) add("keyboard adapter", "fail", `module launches ${bun}, which does not exist`);
    else if (!existsSync(script)) add("keyboard adapter", "fail", `module runs ${t(script)}, which does not exist`);
    else if (resolve(script) !== join(paths.repoDir, "src", "keyboard.ts")) {
      add("keyboard adapter", "warn", `module runs ${t(script)}, outside the configured clone`);
    } else add("keyboard adapter", "ok", `${bun} runs ${t(script)}`);
  }

  const leftovers = retiredMuteLeftovers(paths);
  if (leftovers.length) add("retired mute app", "fail", `${leftovers.map(t).join(", ")} still present; run setup to remove`);
  else add("retired mute app", "ok", "not installed");

  // The preroll bridge: DictationPreroll records from the press and plays to BlackHole,
  // which the dictation app records from. The app on BlackHole with the helper down records silence.
  const name = app?.label ?? "the dictation app";
  const onPreroll = app?.usesPreroll?.(paths.home) ?? false;
  const helper = env.run(["launchctl", "print", `gui/${process.getuid?.() ?? 501}/${PREROLL_ID}`], { timeoutMs: TIMEOUT.probe });
  const helperRunning = helper.code === 0 && /state = running/.test(helper.stdout);
  if (onPreroll) {
    if (helperRunning) add("preroll bridge", "ok", `${name} records from Dictation Preroll; DictationPreroll is running`);
    else add("preroll bridge", "fail", `${name} records from Dictation Preroll but DictationPreroll is not running, so dictations are silent; run install.ts in the repo`);
  } else if (helperRunning) {
    add("preroll bridge", "warn", `DictationPreroll runs but ${name} records from another mic; pick Dictation Preroll in ${app?.micSetting ?? "its microphone setting"} or the first ~0.5 s of speech is lost`);
  } else add("preroll bridge", "warn", "not installed; the first ~0.5 s of each dictation is lost (see DictationSystem.md § Preroll bridge)");

  const hits = findPedalMappings(paths.profilesDir);
  if (hits.length === 0) add("stream deck action", "fail", `no profile maps "${ACTION_NAME}"; drag it onto the pedal`);
  else add("stream deck action", "ok", hits.map((h) => `${h.profile} slot ${h.slot}`).join("; "));

  if (app) {
    const { db: rel, table, columns } = app.history;
    const dbPath = join(paths.appSupport, rel);
    if (!existsSync(dbPath)) {
      add("app history", "fail", `${t(dbPath)} not found; auto-Enter cannot see pastes`);
    } else {
      try {
        const db = new Database(dbPath, { readonly: true });
        try {
          const cols = (db.query(`pragma table_info(${JSON.stringify(table)})`).all() as { name: string }[]).map((c) => c.name);
          const lacking = columns.filter((c) => !cols.includes(c));
          if (cols.length === 0) add("app history", "fail", `no ${table} table; auto-Enter will never fire`);
          else if (lacking.length) add("app history", "fail", `${table} lacks ${lacking.join(", ")}; ${app.label} changed its schema`);
          else add("app history", "ok", `${table} readable (${columns.join(", ")})`);
        } finally {
          db.close();
        }
      } catch (e) {
        add("app history", "fail", `${t(dbPath)} unreadable: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (existsSync(paths.log)) {
    const lines = readFileSync(paths.log, "utf8").trimEnd().split("\n");
    add("log", "info", `${t(paths.log)} last: ${lines.at(-1) || "(empty)"}`);
  } else add("log", "info", `${t(paths.log)} not written yet (no presses so far)`);

  add("accessibility", "info", "not readable by a script: Stream Deck and Hammerspoon need it in Privacy & Security → Accessibility");
  return out;
}

// ─── setup: writers (each asserts before it writes) ───────────────────────────

export function cloneRepo(env: DictationEnv): void {
  const { repoDir } = env.paths;
  invariant(env.config.repoUrl, "cloneRepo called without a repoUrl");
  invariant(!existsSync(repoDir), `cloneRepo would clobber existing ${repoDir}`);
  mkdirSync(dirname(repoDir), { recursive: true });
  const r = env.run(["git", "clone", env.config.repoUrl, repoDir], { timeoutMs: TIMEOUT.clone });
  if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr.trim()}`);
}

export function fastForwardRepo(env: DictationEnv): void {
  const { repoDir } = env.paths;
  invariant(existsSync(join(repoDir, ".git")), `fastForwardRepo: ${repoDir} is not a git clone`);
  const status = env.run(["git", "status", "--porcelain"], { cwd: repoDir, timeoutMs: TIMEOUT.git });
  invariant(status.code === 0 && status.stdout.trim() === "", "fastForwardRepo called on a dirty working tree");
  const r = env.run(["git", "merge", "--ff-only", "@{u}"], { cwd: repoDir, timeoutMs: TIMEOUT.git });
  if (r.code !== 0) throw new Error(`git merge --ff-only failed: ${r.stderr.trim()}`);
}

export function installPlugin(env: DictationEnv): void {
  const { repoDir } = env.paths;
  invariant(existsSync(join(repoDir, "install.ts")), `installPlugin: ${repoDir}/install.ts missing`);
  const r = env.run([env.bunPath, "install.ts"], { cwd: repoDir, timeoutMs: TIMEOUT.install });
  if (r.stdout.trim()) console.log(r.stdout.trim().replace(/^/gm, "    "));
  if (r.code !== 0) throw new Error(`bun install.ts failed (exit ${r.code}): ${r.stderr.trim()}`);
}

export function linkModule(paths: DictationPaths): void {
  const target = join(paths.repoDir, "keyboard", MODULE_FILE);
  const link = join(paths.hammerspoonDir, MODULE_FILE);
  invariant(existsSync(target), `linkModule: ${target} does not exist`);
  invariant(dirname(link) === paths.hammerspoonDir, "linkModule: link must sit directly in the Hammerspoon dir");
  const existing = lstatOrNull(link);
  invariant(!existing || existing.isSymbolicLink(), `linkModule: ${link} is a regular file; refusing to replace it`);
  mkdirSync(paths.hammerspoonDir, { recursive: true });
  if (existing) unlinkSync(link);
  symlinkSync(target, link);
}

/** Stops and deletes what the retired mute app left: its LaunchAgent, app bundle and socket. */
export function removeRetiredMute(env: DictationEnv): void {
  const { paths } = env;
  const leftovers = retiredMuteLeftovers(paths);
  for (const f of leftovers) invariant(f.startsWith(`${paths.home}/`), `removeRetiredMute: ${f} is outside the home folder`);
  env.run(["launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/${RETIRED_MUTE_ID}`], { timeoutMs: TIMEOUT.probe });
  for (const f of leftovers) rmSync(f, { recursive: true, force: true });
}

export function appendRequire(paths: DictationPaths): void {
  const initLua = join(paths.hammerspoonDir, "init.lua");
  const current = existsSync(initLua) ? readFileSync(initLua, "utf8") : "";
  invariant(!hasActiveRequire(current), "appendRequire: init.lua already requires dictation_keys; a second line would load it twice");
  mkdirSync(paths.hammerspoonDir, { recursive: true });
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  writeFileSync(initLua, `${current}${sep}require("dictation_keys") -- Dictation: Right Ctrl+J tap-or-hold\n`);
}

/** Points the pedal code at the dictation app. The file is one word, read on every press. */
export function writeEngine(paths: DictationPaths, engine: string): void {
  invariant(/^[a-z][a-z0-9-]*$/.test(engine), `writeEngine: ${JSON.stringify(engine)} is not an engine word`);
  invariant(paths.engineFile.startsWith(`${paths.home}/`), `writeEngine: ${paths.engineFile} is outside the home folder`);
  invariant(readEngine(paths.engineFile) !== engine, "writeEngine: the engine is already set; nothing to write");
  mkdirSync(dirname(paths.engineFile), { recursive: true });
  const tmp = `${paths.engineFile}.tmp-dictation`;
  writeFileSync(tmp, `${engine}\n`);
  renameSync(tmp, paths.engineFile);
}

// ─── setup: plan and apply ────────────────────────────────────────────────────

/**
 * Inspects the machine and returns every step with its state. Writes nothing.
 * With `fetch`, the repo step runs `git fetch` so "behind upstream" is known;
 * a dry run passes fetch=false and reports the update as conditional.
 */
export function planSetup(env: DictationEnv, opts: { fetch: boolean }): Step[] {
  const { paths, config } = env;
  const t = (p: string) => tilde(p, paths.home);
  const steps: Step[] = [];

  // 1. Apps: setup cannot install them.
  const app = env.app;
  const allApps = [...(app ? [app] : []), ...HELPER_APPS];
  const missingApps = allApps.filter((a) => !findApp(paths.appDirs, a.bundleId, env.run));
  steps.push(
    !app
      ? { id: "apps", title: "apps", state: "blocked", detail: `Name the dictation app in ${t(env.appPath)} first` }
      : missingApps.length === 0
      ? { id: "apps", title: "apps", state: "ok", detail: `${allApps.map((a) => a.label).join(", ")} are installed` }
      : {
          id: "apps",
          title: "apps",
          state: "blocked",
          detail: `Install ${missingApps.map((a) => a.label).join(", ")} first: brew install --cask ${missingApps.map((a) => a.cask).join(" ")}`,
        },
  );

  // 2. Repo: clone when absent; fast-forward only a clean tree that is strictly behind.
  let repoChanges = false;
  const repoDir = paths.repoDir;
  if (!existsSync(repoDir)) {
    if (!config.repoUrl) {
      steps.push({ id: "repo", title: "repo", state: "blocked", detail: `No clone at ${t(repoDir)} and no repoUrl; set it in ${t(env.configPath)}` });
    } else {
      repoChanges = true;
      steps.push({ id: "repo", title: "repo", state: "todo", detail: `clone ${config.repoUrl} into ${t(repoDir)}`, apply: () => cloneRepo(env) });
    }
  } else if (!existsSync(join(repoDir, ".git"))) {
    steps.push({ id: "repo", title: "repo", state: "blocked", detail: `${t(repoDir)} exists but is not a git clone; move it aside` });
  } else {
    const status = env.run(["git", "status", "--porcelain"], { cwd: repoDir, timeoutMs: TIMEOUT.git });
    if (status.code !== 0) {
      steps.push({ id: "repo", title: "repo", state: "skip", detail: `git status failed (${status.stderr.trim()}); using the clone as is` });
    } else if (status.stdout.trim() !== "") {
      steps.push({ id: "repo", title: "repo", state: "skip", detail: `${t(repoDir)} has local changes; not updating it` });
    } else if (!opts.fetch) {
      steps.push({ id: "repo", title: "repo", state: "ok", detail: `clean clone at ${t(repoDir)}; a real run fetches and fast-forwards if behind` });
    } else {
      const fetched = env.run(["git", "fetch", "--quiet"], { cwd: repoDir, timeoutMs: TIMEOUT.fetch });
      const head = env.run(["git", "rev-parse", "HEAD"], { cwd: repoDir, timeoutMs: TIMEOUT.git });
      const upstream = env.run(["git", "rev-parse", "@{u}"], { cwd: repoDir, timeoutMs: TIMEOUT.git });
      if (fetched.code !== 0) {
        steps.push({ id: "repo", title: "repo", state: "skip", detail: "git fetch failed (offline?); using the clone as is" });
      } else if (head.code !== 0 || upstream.code !== 0) {
        steps.push({ id: "repo", title: "repo", state: "skip", detail: "no upstream branch; using the clone as is" });
      } else if (head.stdout.trim() === upstream.stdout.trim()) {
        steps.push({ id: "repo", title: "repo", state: "ok", detail: `${t(repoDir)} is up to date` });
      } else {
        const behind = env.run(["git", "merge-base", "--is-ancestor", "HEAD", "@{u}"], { cwd: repoDir, timeoutMs: TIMEOUT.git });
        if (behind.code === 0) {
          repoChanges = true;
          steps.push({ id: "repo", title: "repo", state: "todo", detail: "fast-forward to upstream", apply: () => fastForwardRepo(env) });
        } else {
          steps.push({ id: "repo", title: "repo", state: "skip", detail: "clone has local commits; not updating it" });
        }
      }
    }
  }

  // 3. Plugin: build and install when missing, unsigned, or older than its source.
  if (repoChanges) {
    steps.push({ id: "plugin", title: "stream deck plugin", state: "todo", detail: "build, sign and install after the repo step", apply: () => installPlugin(env) });
  } else if (!existsSync(join(repoDir, "install.ts"))) {
    steps.push({ id: "plugin", title: "stream deck plugin", state: "blocked", detail: `${t(repoDir)}/install.ts missing; cannot build the plugin` });
  } else {
    const stale = pluginStaleReason(env);
    steps.push(
      stale
        ? { id: "plugin", title: "stream deck plugin", state: "todo", detail: `build, sign and install (${stale})`, apply: () => installPlugin(env) }
        : { id: "plugin", title: "stream deck plugin", state: "ok", detail: "installed, signed, built from the current source" },
    );
  }

  // 4. Hammerspoon module link.
  const link = join(paths.hammerspoonDir, MODULE_FILE);
  const target = join(repoDir, "keyboard", MODULE_FILE);
  const linkStat = lstatOrNull(link);
  const linkStep = (state: StepState, detail: string): Step =>
    state === "todo"
      ? { id: "hammerspoon-link", title: "hammerspoon module", state, detail, apply: () => linkModule(paths) }
      : { id: "hammerspoon-link", title: "hammerspoon module", state, detail };
  if (!linkStat) steps.push(linkStep("todo", `link ${t(link)} → ${t(target)}`));
  else if (!linkStat.isSymbolicLink()) steps.push(linkStep("blocked", `${t(link)} is a regular file; move it aside so setup can link the repo's module`));
  else {
    const pointsAt = resolve(dirname(link), readlinkSync(link));
    let same = pointsAt === target;
    if (!same && existsSync(target)) {
      try {
        same = realpathSync(link) === realpathSync(target);
      } catch {
        same = false; // Dangling link: it needs repointing.
      }
    }
    steps.push(same ? linkStep("ok", `${t(link)} → ${t(target)}`) : linkStep("todo", `repoint ${t(link)} (now → ${t(pointsAt)})`));
  }

  // 5. init.lua require line.
  const initLua = join(paths.hammerspoonDir, "init.lua");
  const initText = existsSync(initLua) ? readFileSync(initLua, "utf8") : "";
  steps.push(
    hasActiveRequire(initText)
      ? { id: "hammerspoon-require", title: "hammerspoon require", state: "ok", detail: "init.lua already requires dictation_keys" }
      : {
          id: "hammerspoon-require",
          title: "hammerspoon require",
          state: "todo",
          detail: existsSync(initLua) ? `append require("dictation_keys") to ${t(initLua)}` : `create ${t(initLua)} with require("dictation_keys")`,
          apply: () => appendRequire(paths),
        },
  );

  // 5b. The retired CoreAudio mute app.
  const leftovers = retiredMuteLeftovers(paths);
  steps.push(
    leftovers.length === 0
      ? { id: "retired-mute", title: "retired mute app", state: "ok", detail: "not installed" }
      : { id: "retired-mute", title: "retired mute app", state: "todo", detail: `remove ${leftovers.map(t).join(", ")}`, apply: () => removeRetiredMute(env) },
  );

  // 6. Engine: the pedal code drives whatever this file names.
  if (app) {
    const word = readEngine(paths.engineFile);
    steps.push(
      word === app.engine
        ? { id: "engine", title: "engine", state: "ok", detail: `${t(paths.engineFile)} says ${app.engine}` }
        : { id: "engine", title: "engine", state: "todo", detail: `write ${app.engine} to ${t(paths.engineFile)} (now ${word ?? "missing"})`, apply: () => writeEngine(paths, app.engine) },
    );
  }

  return steps;
}

export const humanSteps = (app: DictationApp | null): string[] => [
  "Grant Accessibility to Stream Deck and Hammerspoon: System Settings → Privacy & Security → Accessibility.",
  "Restart Stream Deck (quit and reopen) so it loads the plugin.",
  `In Stream Deck, drag "${ACTION_NAME}" from the LifeOS category onto the pedal.`,
  "Reload Hammerspoon: menu bar icon → Reload Config.",
  app?.onboarding ?? "Open the dictation app, sign in, and grant it Microphone and Accessibility.",
  "Run: bun LIFEOS/DICTATION/Dictation.ts check",
];

/** Plans, then applies every todo step in order — unless any step is blocked, in which case nothing is written. */
export function runSetup(env: DictationEnv, opts: { dryRun: boolean }): SetupOutcome {
  const steps = planSetup(env, { fetch: !opts.dryRun });
  const blocked = steps.filter((st) => st.state === "blocked");
  const applied: string[] = [];
  if (opts.dryRun || blocked.length > 0) return { steps, applied, blocked };
  for (const step of steps) {
    if (step.state !== "todo") continue;
    invariant(step.apply, `step ${step.id} is todo without an apply function`);
    step.apply();
    applied.push(step.id);
  }
  return { steps, applied, blocked };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const HELP = `Dictation 2.0.0 — pedal and keyboard push-to-talk for the dictation app

  check              verify each piece; exit 1 naming the failed ones
  setup [--dry-run]  clone or update the repo, build the plugin, link and require
                     the Hammerspoon module, remove the retired mute
                     app, point the pedal at the dictation app; then list
                     the by-hand steps. --dry-run writes nothing.

Doc: LIFEOS/DOCUMENTATION/Dictation/DictationSystem.md`;

export function buildEnv(): DictationEnv {
  const configPath = defaultConfigPath();
  const home = homedir();
  const loaded = loadConfig(configPath, home);
  let repoUrl = loaded.repoUrl;
  if (!repoUrl && existsSync(join(loaded.repoDir, ".git"))) {
    const r = realRunner(["git", "remote", "get-url", "origin"], { cwd: loaded.repoDir, timeoutMs: TIMEOUT.git });
    if (r.code === 0 && r.stdout.trim()) repoUrl = r.stdout.trim();
  }
  return {
    paths: defaultPaths(loaded.repoDir, home),
    config: { repoUrl, repoDir: loaded.repoDir },
    configPath,
    app: loadApp(defaultAppPath()),
    appPath: defaultAppPath(),
    run: realRunner,
    bunPath: process.execPath,
  };
}

function printCheck(results: CheckResult[]): number {
  const width = Math.max(...results.map((r) => r.piece.length));
  for (const r of results) console.log(`  ${r.status.padEnd(4)}  ${r.piece.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => r.status === "fail").map((r) => r.piece);
  if (failed.length > 0) {
    console.error(`\ncheck failed: ${failed.join(", ")}`);
    return 1;
  }
  const warned = results.filter((r) => r.status === "warn").length;
  console.log(`\ncheck passed${warned ? ` with ${warned} warning${warned > 1 ? "s" : ""}` : ""}`);
  return 0;
}

function printSetup(outcome: SetupOutcome, dryRun: boolean, app: DictationApp | null): number {
  const width = Math.max(...outcome.steps.map((s) => s.title.length));
  const label = (s: StepState) => (s === "todo" ? (dryRun ? "would" : "do") : s === "blocked" ? "BLOCKED" : s);
  console.log(dryRun ? "Dictation setup — dry run, nothing written\n" : "Dictation setup\n");
  outcome.steps.forEach((s, i) => console.log(`  ${i + 1}. ${label(s.state).padEnd(7)}  ${s.title.padEnd(width)}  ${s.detail}`));
  if (outcome.blocked.length > 0) {
    console.error("\nStopped before writing anything:");
    for (const b of outcome.blocked) console.error(`  ${b.detail}`);
    return 1;
  }
  if (!dryRun) console.log(outcome.applied.length ? `\nApplied: ${outcome.applied.join(", ")}` : "\nNothing to change.");
  console.log("\nThen, by hand:");
  humanSteps(app).forEach((h, i) => console.log(`  ${outcome.steps.length + i + 1}. ${h}`));
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "check") return printCheck(runChecks(buildEnv()));
  if (cmd === "setup") {
    const unknown = rest.filter((a) => a !== "--dry-run");
    if (unknown.length) throw new Error(`setup: unknown argument ${unknown.join(" ")}`);
    const dryRun = rest.includes("--dry-run");
    const env = buildEnv();
    return printSetup(runSetup(env, { dryRun }), dryRun, env.app);
  }
  throw new Error(`unknown command: ${cmd}\n\n${HELP}`);
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
