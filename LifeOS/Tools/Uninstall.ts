#!/usr/bin/env bun
/**
 * Uninstall — manifest-keyed removal of everything LifeOS placed, and only that.
 *
 * Dry-run by default: prints the plan as JSON and writes nothing. `--apply`
 * executes it. Nothing is ever deleted: every tree and file that leaves the
 * config root is MOVED into one trash directory (`--trash <dir>`, default
 * `~/.lifeos-uninstalled-<timestamp>`, mode 0700), so the whole operation is
 * reversible until the user removes that directory themselves. The user's data
 * home (`<configDir>`, default ~/.config/LIFEOS) is never touched unless
 * `--purge-user` is passed, and even then it is moved, not deleted.
 *
 * Ownership is decided by what the installer wrote, never by where a file sits:
 *   - shared dirs hooks/, agents/, commands/, workflows/: ONLY the files the
 *     payload shipped (listed from `install/<dir>/`); a user's own file in one
 *     of them stays, and the directory itself moves only once it is empty.
 *   - CLAUDE.md: moved only when it carries the LifeOS routing-table marker;
 *     a user's pre-existing CLAUDE.md is kept and reported.
 *   - LIFEOS/ whole (system-owned by the SystemUserBoundary contract). Its USER
 *     and MEMORY entries must be symlinks: they are unlinked first and their
 *     targets are user data. If either is a REAL directory, or the data home
 *     resolves inside anything that would move, the plan REFUSES without
 *     `--purge-user` — that is user data, and moving it silently while the
 *     report says "kept" is the failure this refusal exists to prevent.
 *   - the payload's skills (never a user's own skill), checkpoint-repos.txt,
 *     `.retired-*` parking dirs, and the runtime bundle (`package.json`,
 *     `bun.lock*`, `node_modules/`) when package.json equals the shipped one.
 *   - settings.json: hook entries by manifest key, plus entries that run a
 *     script under LIFEOS/ (that tree moves whole) and http hooks whose URL the
 *     template's allowedHttpHookUrls names; template-equal top-level keys; the
 *     statusLine when its command lives under LIFEOS/; spinner keys when equal
 *     to the shipped enhancements; template allow entries. `permissions.deny`
 *     is NEVER pruned — removing a deny rule widens permissions, and default-keep
 *     is the rule. The skip-permission flags go only when `permissions.defaultMode`
 *     goes with them, so a user is never left in auto mode with the prompts off.
 *     With no manifest, hook entries the tool cannot attribute are left in place.
 *   - every alias line that points at the LifeOS launcher (`lifeos`, and the
 *     pre-7.x names install.sh repointed) in the shell rc files, plus the fish
 *     function, rc backed up first.
 *   - background services first, via `Services.ts uninstall --only <every label>`
 *     (it refuses a blanket uninstall by design); on win32 the Pulse scheduled
 *     task via manage.ps1. A services failure ABORTS before any move: a live
 *     launchd/systemd job must never point at trashed files.
 *
 * Order inside --apply: services → unlink data symlinks → moves (rename, or
 * copy + verify + remove across volumes) → settings.json → aliases → optional
 * purge. Settings are pruned only AFTER every move succeeded, so a failed move
 * leaves a coherent, still-registered install. Any failure still prints the
 * report so far with the trash path and the step that failed.
 *
 * Refuses on a dev tree with no override: this is the one tool whose worst case
 * is the author's live source tree.
 *
 * Usage:
 *   bun Uninstall.ts [--config-root <dir>] [--config-dir <dir>] [--skill-root <dir>]
 *                    [--home <dir>] [--trash <dir>] [--apply] [--purge-user]
 *
 * Public issue #920 (no uninstall instructions, 2026-03). Shape set by the
 * 2026-09-04 cross-vendor (Forge) and in-family (Max) audits of the first draft.
 */

import {
  closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, type Dirent,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { detectDevTree, findDevWriteViolation, hookKey, rewriteHookRoots } from "./InstallEngine";
import { atomicWriteText } from "./lib/atomic-write";
import { expandEnvValue, expandLeadingHome } from "./lib/env-expand";

type HookEntry = { type?: string; command?: string; url?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookEntry[] };
type HooksMap = Record<string, HookGroup[]>;

export interface UninstallOptions {
  configRoot: string;
  configDir: string;
  skillRoot: string;
  home: string;
  purgeUser: boolean;
  /** where moved things land; default ~/.lifeos-uninstalled-<timestamp> */
  trash?: string;
  /** rc files to scan for the alias; defaults to the usual four under `home` plus the fish function */
  rcFiles?: string[];
  platform?: NodeJS.Platform;
  now?: Date;
}

export interface UninstallPlan {
  ok: boolean;
  refused?: string;
  configRoot: string;
  configDir: string;
  trash: string;
  hooks: { remove: Array<{ event: string; matcher: string; key: string; by: "manifest" | "lifeos-tree" | "pulse-http" }>; keepForeign: number; manifestPresent: boolean };
  settings: {
    present: boolean;
    removeKeys: string[]; keepModified: string[];
    removeAllow: number; removeAllowEntries: string[];
    removePermissionKeys: string[];
    removeEnv: string[];
    removeStatusLine: boolean; removeSpinnerKeys: string[];
  };
  trees: { move: string[]; unlink: string[]; keepUserSkills: string[]; keepUserFiles: string[] };
  alias: Array<{ file: string; lines: string[] }>;
  services: { command: string[]; labels: string[] } | null;
  userData: { path: string; action: "keep" | "move" };
  leftInPlace: string[];
  notes: string[];
}

const SHARED_DIRS = ["hooks", "agents", "commands", "workflows"];
const RC_NAMES = [".zshrc", ".bashrc", ".bash_profile", ".profile"];
const FISH_FN = join(".config", "fish", "functions", "lifeos.fish");
/** any alias that points at the LifeOS launcher — the `lifeos` alias and the pre-7.x names install.sh repointed at it; never an alias that points elsewhere */
const ALIAS_RE = /^\s*alias\s+\w+=.*(?:LIFEOS_SYSTEM_PROMPT|LIFEOS\/TOOLS\/lifeos\.ts)/;
const ALIAS_HEADER_RE = /^\s*#\s*LifeOS .*launch alias/i;
/** a registry label as `Services.ts status` prints it, `(reverse.dns.label)`: com.lifeos.* and the vendor-labelled sidecar (ai.hermes.gateway) alike */
const SERVICE_LABEL_RE = /\(([a-z][a-z0-9-]*(?:\.[A-Za-z0-9_-]+){2,})\)/g;

function readJson(p: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}
function deepEqual(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function isSymlink(p: string): boolean { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
function isRealDir(p: string): boolean { try { const st = lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } }
/** realpath of p, or of its nearest existing ancestor with the rest appended (a trash dir not yet made still resolves /var → /private/var). */
function realOrSelf(p: string): string {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { /* not there yet */ }
  const parent = dirname(abs);
  return parent === abs ? abs : join(realOrSelf(parent), basename(abs));
}
function norm(p: string): string { return p.replace(/\\/g, "/"); }
function under(child: string, parent: string): boolean {
  const c = norm(realOrSelf(child)), p = norm(realOrSelf(parent));
  return c === p || c.startsWith(p.endsWith("/") ? p : p + "/");
}

function expandTemplate(tpl: Record<string, unknown>, home: string, configRoot: string): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(tpl)) as Record<string, unknown>;
  const env = out.env;
  if (env && typeof env === "object") {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) if (typeof v === "string") (env as Record<string, unknown>)[k] = expandEnvValue(v, home, configRoot);
  }
  return out;
}

/** Every file under a directory, as paths relative to it. */
export function listFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try { entries = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r)); else out.push(r);
  }
  return out;
}

/** Every hook key the payload manifest would have merged, resolved to this configRoot. */
function manifestKeys(skillRoot: string, configRoot: string): { keys: Set<string>; present: boolean } {
  const p = join(skillRoot, "install", "hooks", "hooks.json");
  const keys = new Set<string>();
  if (!existsSync(p)) return { keys, present: false };
  const raw = (readJson(p)?.hooks ?? {}) as HooksMap;
  const incoming = rewriteHookRoots(raw as never, configRoot) as unknown as HooksMap;
  for (const groups of Object.values(incoming)) for (const g of groups ?? []) for (const h of g.hooks ?? []) keys.add(hookKey(h as never, configRoot));
  return { keys, present: true };
}

/** The script a command entry executes (first non-interpreter token of each segment), $HOME/~ expanded against `home`. */
function scriptPaths(command: string, home: string): string[] {
  return command.split(/;|&&|\|\|/).map((seg) => {
    const toks = seg.trim().split(/\s+/);
    const t = ["bun", "bash", "sh", "node", "powershell"].includes(toks[0] ?? "") ? toks[1] ?? "" : toks[0] ?? "";
    return norm(expandLeadingHome(t.replace(/^~(?=\/)/, "$HOME"), home));
  }).filter(Boolean);
}

/** Does this CLAUDE.md carry the LifeOS routing table, or is it the user's own file? */
export function isLifeosClaudeMd(text: string): boolean {
  return /^# LifeOS \d/m.test(text) || text.includes("@LIFEOS/DOCUMENTATION/ARCHITECTURE_SUMMARY.md");
}

/**
 * Services.ts resolves its tree from CLAUDE_CONFIG_DIR (Paths.getClaudeDir), never from this tool's
 * --config-root, so both service calls are handed the target root. Without it a custom-root uninstall
 * enumerates and removes the ambient profile's services and leaves the target's running.
 */
function servicesEnv(configRoot: string): NodeJS.ProcessEnv {
  return { ...process.env, CLAUDE_CONFIG_DIR: configRoot, LIFEOS_DIR: join(configRoot, "LIFEOS") };
}

export function planUninstall(o: UninstallOptions): UninstallPlan {
  const now = o.now ?? new Date();
  const platform = o.platform ?? process.platform;
  const configRoot = resolve(o.configRoot);
  const trash = o.trash ? resolve(o.trash) : join(o.home, `.lifeos-uninstalled-${now.toISOString().replace(/[:.]/g, "-")}`);
  const plan: UninstallPlan = {
    ok: true, configRoot, configDir: o.configDir, trash,
    hooks: { remove: [], keepForeign: 0, manifestPresent: false },
    settings: { present: false, removeKeys: [], keepModified: [], removeAllow: 0, removeAllowEntries: [], removePermissionKeys: [], removeEnv: [], removeStatusLine: false, removeSpinnerKeys: [] },
    trees: { move: [], unlink: [], keepUserSkills: [], keepUserFiles: [] },
    alias: [], services: null,
    userData: { path: o.configDir, action: o.purgeUser ? "move" : "keep" },
    leftInPlace: [], notes: [],
  };
  const refuse = (why: string): UninstallPlan => { plan.ok = false; plan.refused = why; return plan; };

  if (detectDevTree(configRoot)) return refuse(`${configRoot} is a LifeOS source tree (dev-tree marker present) — Uninstall never runs against the author's source. There is no override.`);
  // Uninstall moves/unlinks under configRoot and, with --purge-user, the data home: neither may
  // resolve into a maintainer install (a clean configRoot with --config-dir at the real data home).
  const devHit = findDevWriteViolation([configRoot, o.configDir], [configRoot]);
  if (devHit) return refuse(`${devHit.target} resolves to ${devHit.resolved}, inside the LifeOS dev install at ${devHit.devRoot} (source tree) — Uninstall never runs against the author's source. There is no override.`);
  if (under(trash, configRoot)) return refuse(`--trash ${trash} is inside the config root it is emptying`);
  if (o.purgeUser && under(trash, o.configDir)) return refuse(`--trash ${trash} is inside the data home --purge-user moves into it`);

  // ── trees ──
  const lifeos = join(configRoot, "LIFEOS");
  if (existsSync(lifeos)) {
    for (const link of ["USER", "MEMORY"]) {
      const lp = join(lifeos, link);
      if (isSymlink(lp)) plan.trees.unlink.push(lp);
      else if (isRealDir(lp) && !o.purgeUser) return refuse(`${lp} is a real directory, not a symlink into the data home — that is user data (identity, TELOS, memory). Pass --purge-user to move it into the trash with the rest, or relocate it first. Nothing was changed.`);
    }
    plan.trees.move.push(lifeos);
  }
  for (const d of SHARED_DIRS) {
    const dir = join(configRoot, d);
    if (!existsSync(dir)) continue;
    // A symlinked shared dir points at the user's own tree: walking it would move files out of that
    // tree, so it is never walked. The link and whatever the installer wrote through it stay put.
    if (isSymlink(dir)) { plan.leftInPlace.push(`${dir}: a symlink to ${realOrSelf(dir)}, never walked, so nothing in that directory moves; remove LifeOS files from it yourself`); continue; }
    const payloadDir = join(o.skillRoot, "install", d);
    if (!existsSync(payloadDir)) { plan.notes.push(`payload ${d}/ listing not found — nothing under ${d}/ is attributed to LifeOS, all of it stays`); continue; }
    const shipped = new Set(listFiles(payloadDir).map(norm));
    const present = listFiles(dir);
    const mine = present.filter((f) => shipped.has(norm(f)));
    const theirs = present.filter((f) => !shipped.has(norm(f)));
    if (theirs.length === 0) plan.trees.move.push(dir);
    else { for (const f of mine) plan.trees.move.push(join(dir, f)); for (const f of theirs) plan.trees.keepUserFiles.push(join(dir, f)); }
  }
  const claudeMd = join(configRoot, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    if (isLifeosClaudeMd(readFileSync(claudeMd, "utf-8"))) plan.trees.move.push(claudeMd);
    else plan.trees.keepUserFiles.push(claudeMd);
  }
  const ckpt = join(configRoot, "checkpoint-repos.txt");
  if (existsSync(ckpt)) plan.trees.move.push(ckpt);
  try { for (const e of readdirSync(configRoot)) if (e.startsWith(".retired-") || e === ".lifeos-overlay-backups") plan.trees.move.push(join(configRoot, e)); } catch { /* unreadable root */ }
  const pkg = join(configRoot, "package.json"), shippedPkg = join(o.skillRoot, "install", "package.json");
  if (existsSync(pkg) && existsSync(shippedPkg) && deepEqual(readJson(pkg), readJson(shippedPkg))) {
    for (const f of ["package.json", "bun.lock", "bun.lockb", "node_modules"]) { const p = join(configRoot, f); if (existsSync(p)) plan.trees.move.push(p); }
  } else if (existsSync(pkg)) plan.leftInPlace.push(`${pkg}: differs from the shipped package.json, so the runtime bundle (package.json, lockfile, node_modules) stays`);
  const payloadSkills = join(o.skillRoot, "install", "skills");
  const skillsDir = join(configRoot, "skills");
  if (existsSync(skillsDir)) {
    const shipped = new Set(existsSync(payloadSkills) ? readdirSync(payloadSkills) : []);
    shipped.add(basename(o.skillRoot));
    for (const s of readdirSync(skillsDir)) { if (shipped.has(s)) plan.trees.move.push(join(skillsDir, s)); else plan.trees.keepUserSkills.push(s); }
    if (!existsSync(payloadSkills)) plan.notes.push("payload skills list not found — only the LifeOS skill directory itself is removed from skills/");
  }
  // Every move renames an entry of a directory inside the config root. A parent that resolves
  // elsewhere (a symlinked skills/, say) would carry the user's own files out, so the plan refuses.
  const escapes = plan.trees.move.find((m) => !under(dirname(m), configRoot));
  if (escapes) return refuse(`${escapes} sits in ${realOrSelf(dirname(escapes))}, outside the config root ${configRoot} (a symlinked directory); moving it would take files from outside the install. Replace that symlink with a real directory or remove it first. Nothing was changed.`);
  // The data home must not be inside anything that moves unless the user asked for that.
  if (!o.purgeUser && existsSync(o.configDir)) {
    const hit = plan.trees.move.find((m) => under(o.configDir, m));
    if (hit) return refuse(`the data home ${o.configDir} resolves inside ${hit}, which the uninstall would move. Pass --purge-user to move it deliberately, or relocate it first. Nothing was changed.`);
  }

  // ── settings.json ──
  const settingsPath = join(configRoot, "settings.json");
  const settings = readJson(settingsPath);
  const templatePath = join(o.skillRoot, "install", "settings.system.json");
  const template = existsSync(templatePath) ? expandTemplate(readJson(templatePath) ?? {}, o.home, o.configRoot) : null;
  const enhancements = readJson(join(o.skillRoot, "install", "settings.enhancements.json"));
  if (!template) plan.notes.push(`template ${templatePath} not found — settings keys cannot be matched, only hook entries are pruned`);
  if (settings) {
    plan.settings.present = true;
    const { keys, present } = manifestKeys(o.skillRoot, configRoot);
    plan.hooks.manifestPresent = present;
    if (!present) plan.notes.push("payload hooks.json not found — hook entries that cannot be attributed are LEFT IN PLACE (a path guess is how a user's own hook gets deleted); only entries running scripts under LIFEOS/ and the Pulse http hooks are removed");
    const httpAllowed = ((template?.allowedHttpHookUrls as string[] | undefined) ?? []).map((u) => u.replace(/\*$/, ""));
    const lifeosTree = norm(lifeos) + "/";
    const hooks = (settings.hooks ?? {}) as HooksMap;
    for (const [event, groups] of Object.entries(hooks)) {
      for (const g of groups ?? []) {
        for (const h of g.hooks ?? []) {
          const key = hookKey(h as never, configRoot);
          const matcher = g.matcher ?? "";
          if (present && keys.has(key)) plan.hooks.remove.push({ event, matcher, key, by: "manifest" });
          else if (typeof h.command === "string" && scriptPaths(h.command, o.home).some((s) => s.startsWith(lifeosTree))) plan.hooks.remove.push({ event, matcher, key, by: "lifeos-tree" });
          else if (h.type === "http" && typeof h.url === "string" && httpAllowed.some((u) => h.url!.startsWith(u))) plan.hooks.remove.push({ event, matcher, key, by: "pulse-http" });
          else plan.hooks.keepForeign++;
        }
      }
    }
    if (template) {
      for (const [k, v] of Object.entries(template)) {
        if (["hooks", "env", "permissions", "$schema", "statusLine", "skipDangerousModePermissionPrompt", "skipAutoPermissionPrompt"].includes(k)) continue;
        if (!(k in settings)) continue;
        if (deepEqual(settings[k], v)) plan.settings.removeKeys.push(k);
        else plan.settings.keepModified.push(k);
      }
      const tplPerm = (template.permissions ?? {}) as Record<string, unknown>;
      const curPerm = (settings.permissions ?? {}) as Record<string, unknown>;
      const tplAllow = new Set(((tplPerm.allow as unknown[]) ?? []).map((x) => JSON.stringify(x)));
      plan.settings.removeAllowEntries = ((curPerm.allow as unknown[]) ?? []).map((x) => JSON.stringify(x)).filter((x) => tplAllow.has(x));
      plan.settings.removeAllow = plan.settings.removeAllowEntries.length;
      for (const k of ["defaultMode", "ask", "additionalDirectories"]) if (k in curPerm && k in tplPerm && deepEqual(curPerm[k], tplPerm[k])) plan.settings.removePermissionKeys.push(k);
      if (Array.isArray(curPerm.deny) && (curPerm.deny as unknown[]).length) plan.leftInPlace.push("permissions.deny: never pruned — removing a deny rule widens permissions");
      // the skip flags leave only together with defaultMode; otherwise a user is left in auto mode with the prompts off
      const modeGoes = plan.settings.removePermissionKeys.includes("defaultMode") || !("defaultMode" in curPerm);
      for (const k of ["skipDangerousModePermissionPrompt", "skipAutoPermissionPrompt"]) {
        if (!(k in settings) || !(k in template)) continue;
        if (modeGoes && deepEqual(settings[k], template[k])) plan.settings.removeKeys.push(k);
        else plan.leftInPlace.push(`${k}: kept because permissions.defaultMode stays`);
      }
      const tplEnv = (template.env ?? {}) as Record<string, unknown>;
      const curEnv = (settings.env ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(tplEnv)) if (k in curEnv && deepEqual(curEnv[k], v)) plan.settings.removeEnv.push(k);
      for (const k of plan.settings.keepModified.filter((k) => ["autoMode", "principal", "dynamicContext", "voiceEnabled", "preferences"].includes(k))) {
        plan.leftInPlace.push(`${k}: LifeOS-only key kept because it differs from the template (autoMode carries permission-widening rules — review it)`);
      }
    }
    const sl = settings.statusLine as { command?: string } | undefined;
    if (sl && typeof sl.command === "string" && scriptPaths(sl.command, o.home).some((s) => s.startsWith(lifeosTree))) plan.settings.removeStatusLine = true;
    if (enhancements) for (const k of ["spinnerVerbs", "spinnerTipsOverride"]) if (k in settings && deepEqual(settings[k], enhancements[k])) plan.settings.removeSpinnerKeys.push(k);
  } else plan.notes.push(`no settings.json at ${settingsPath}`);

  // ── aliases ──
  const rcFiles = o.rcFiles ?? [...RC_NAMES.map((n) => join(o.home, n)), join(o.home, FISH_FN)];
  for (const rc of rcFiles) {
    if (!existsSync(rc)) continue;
    if (rc.endsWith("lifeos.fish")) { plan.alias.push({ file: rc, lines: ["<fish function file — moved whole>"] }); continue; }
    const lines = readFileSync(rc, "utf-8").split("\n").filter((l) => ALIAS_RE.test(l) || ALIAS_HEADER_RE.test(l));
    if (lines.length) plan.alias.push({ file: rc, lines });
  }

  // ── services ──
  const services = join(lifeos, "TOOLS", "Services.ts");
  if (existsSync(services)) {
    let labels: string[] = [];
    let enumerated = false;
    try {
      const out = execFileSync("bun", [services, "status"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: servicesEnv(configRoot) });
      labels = [...new Set([...out.matchAll(SERVICE_LABEL_RE)].map((m) => m[1]!))];
      enumerated = true;
    } catch (e) { plan.notes.push(`Services.ts status failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — services cannot be enumerated; --apply will refuse`); }
    plan.services = { command: enumerated && labels.length ? ["bun", services, "uninstall", "--only", labels.join(",")] : [], labels };
    if (!enumerated) plan.services.labels = ["<enumeration failed>"];
    if (platform === "win32" && existsSync(join(lifeos, "PULSE", "manage.ps1"))) plan.notes.push(`win32: the Pulse scheduled task is unregistered via powershell -File ${join(lifeos, "PULSE", "manage.ps1")} uninstall`);
  }

  // ── known leftovers ──
  plan.leftInPlace.push(`${join(configRoot, ".env")}: never touched — it may hold credentials the user owns`);
  plan.leftInPlace.push(`${join(configRoot, ".gitignore")} capture rules and the config-root git repo (if the installer initialised one): kept`);
  plan.leftInPlace.push("settings.json backups written by the installer (settings.json.backup-*, .lifeos-backup-*): kept");
  if (o.purgeUser) for (const f of listFiles(o.configDir)) if (/(^|\/)\.env(\.|$)/.test(norm(f))) plan.notes.push(`--purge-user moves a credentials file: ${join(o.configDir, f)}`);
  plan.notes.push(`nothing is deleted — everything removed is moved under ${trash} (mode 0700); remove that directory yourself when satisfied`);
  return plan;
}

/** rename when the volumes match; copy + verify + remove when they do not (EXDEV). Never a bare delete. */
export function moveOut(src: string, dst: string): "renamed" | "copied" {
  mkdirSync(join(dst, ".."), { recursive: true, mode: 0o700 });
  try { renameSync(src, dst); return "renamed"; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(src, dst, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    const diff = copyMismatch(src, dst);
    if (diff) throw new Error(`cross-volume copy of ${src} not verified (${diff}) — source left in place`);
    rmSync(src, { recursive: true, force: false });
    return "copied";
  }
}

/** Two regular files hold the same bytes, read in chunks so a large file never loads whole. */
function sameBytes(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  const fa = openSync(a, "r"), fb = openSync(b, "r");
  try {
    const ba = Buffer.alloc(1 << 20), bb = Buffer.alloc(1 << 20);
    for (;;) {
      const na = readSync(fa, ba, 0, ba.length, null), nb = readSync(fb, bb, 0, bb.length, null);
      if (na !== nb || !ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
      if (na === 0) return true;
    }
  } finally { closeSync(fa); closeSync(fb); }
}

/**
 * The first way dst fails to be a faithful copy of src, or null: the same relative paths, each
 * symlink with the same target (copied verbatim), each regular file with the same bytes.
 */
export function copyMismatch(src: string, dst: string): string | null {
  const one = (s: string, d: string, rel: string): string | null => {
    const ss = lstatSync(s), ds = lstatSync(d, { throwIfNoEntry: false });
    if (!ds) return `${rel} missing from the copy`;
    if (ss.isSymbolicLink()) return ds.isSymbolicLink() && readlinkSync(s) === readlinkSync(d) ? null : `${rel} symlink differs`;
    if (ss.isFile()) return ds.isFile() && sameBytes(s, d) ? null : `${rel} content differs`;
    return null;
  };
  if (!statSync(src).isDirectory()) return one(src, dst, basename(src));
  const want = listFiles(src), got = new Set(listFiles(dst));
  if (got.size !== want.length) return `${got.size}/${want.length} files`;
  for (const rel of want) {
    if (!got.has(rel)) return `${rel} missing from the copy`;
    const why = one(join(src, rel), join(dst, rel), rel);
    if (why) return why;
  }
  return null;
}

function moveToTrash(src: string, trash: string, configRoot: string): string {
  const rel = relative(configRoot, src);
  if (!rel || rel.startsWith("..")) throw new Error(`refusing to move ${src}: not inside ${configRoot}`);
  if (!under(dirname(src), configRoot)) throw new Error(`refusing to move ${src}: its directory resolves to ${realOrSelf(dirname(src))}, outside ${configRoot}`);
  const dst = join(trash, "config-root", rel);
  moveOut(src, dst);
  return dst;
}

export interface UninstallReport {
  ok: boolean; trash: string; step: string; error?: string;
  moved: string[]; unlinked: string[]; settingsBackup: string | null; rcBackups: string[]; services: string | null; userData: string | null;
  followUp?: string;
}

export function applyUninstall(plan: UninstallPlan, o: UninstallOptions): UninstallReport {
  if (!plan.ok) throw new Error(plan.refused ?? "plan not ok");
  const platform = o.platform ?? process.platform;
  const configRoot = plan.configRoot;
  const report: UninstallReport = { ok: false, trash: plan.trash, step: "start", moved: [], unlinked: [], settingsBackup: null, rcBackups: [], services: null, userData: null };
  try {
    mkdirSync(plan.trash, { recursive: true, mode: 0o700 });

    // 1. services — a failure aborts before any mutation.
    report.step = "services";
    if (plan.services) {
      if (plan.services.labels.includes("<enumeration failed>")) throw new Error("services could not be enumerated (Services.ts status failed) — nothing was moved or changed. Run `bun LIFEOS/TOOLS/Services.ts status` and fix that first.");
      if (plan.services.command.length) execFileSync(plan.services.command[0]!, plan.services.command.slice(1), { stdio: "pipe", env: servicesEnv(configRoot) });
      if (platform === "win32") {
        const ps1 = join(configRoot, "LIFEOS", "PULSE", "manage.ps1");
        if (existsSync(ps1)) execFileSync("powershell", ["-NoProfile", "-File", ps1, "uninstall"], { stdio: "pipe" });
      }
      report.services = plan.services.labels.length ? `uninstalled: ${plan.services.labels.join(", ")}` : "none registered";
    }

    // 2. symlinks out of the tree — unlink only; the targets are user data.
    report.step = "unlink";
    for (const lp of plan.trees.unlink) { unlinkSync(lp); report.unlinked.push(lp); }

    // 3. trees and files → trash. Before settings, so a failed move leaves a coherent install.
    report.step = "move";
    for (const p of plan.trees.move) if (existsSync(p) || isSymlink(p)) report.moved.push(moveToTrash(p, plan.trash, configRoot));

    // 4. settings.json — prune from the PLAN only (the skill root is in the trash by now), atomic write.
    report.step = "settings";
    const settingsPath = join(configRoot, "settings.json");
    const settings = readJson(settingsPath);
    if (settings && plan.settings.present) {
      const backup = `${settingsPath}.lifeos-uninstall-backup-${Date.now()}`;
      copyFileSync(settingsPath, backup);
      report.settingsBackup = backup;
      const removeKeys = new Set(plan.hooks.remove.map((r) => `${r.event}|${r.matcher}|${r.key}`));
      const hooks = (settings.hooks ?? {}) as HooksMap;
      for (const [event, groups] of Object.entries(hooks)) {
        const kept: HookGroup[] = [];
        for (const g of groups ?? []) {
          const hs = (g.hooks ?? []).filter((h) => !removeKeys.has(`${event}|${g.matcher ?? ""}|${hookKey(h as never, configRoot)}`));
          if (hs.length) kept.push({ ...g, hooks: hs });
        }
        if (kept.length) hooks[event] = kept; else delete hooks[event];
      }
      if (Object.keys(hooks).length === 0) delete settings.hooks;
      for (const k of plan.settings.removeKeys) delete settings[k];
      if (plan.settings.removeStatusLine) delete settings.statusLine;
      for (const k of plan.settings.removeSpinnerKeys) delete settings[k];
      const curPerm = settings.permissions as Record<string, unknown> | undefined;
      if (curPerm) {
        const gone = new Set(plan.settings.removeAllowEntries);
        if (Array.isArray(curPerm.allow)) curPerm.allow = (curPerm.allow as unknown[]).filter((x) => !gone.has(JSON.stringify(x)));
        if (Array.isArray(curPerm.allow) && (curPerm.allow as unknown[]).length === 0) delete curPerm.allow;
        for (const k of plan.settings.removePermissionKeys) delete curPerm[k];
        if (Object.keys(curPerm).length === 0) delete settings.permissions;
      }
      const curEnv = settings.env as Record<string, unknown> | undefined;
      if (curEnv) { for (const k of plan.settings.removeEnv) delete curEnv[k]; if (Object.keys(curEnv).length === 0) delete settings.env; }
      atomicWriteText(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    }

    // 5. alias lines and the fish function.
    report.step = "aliases";
    for (const { file } of plan.alias) {
      const backup = `${file}.lifeos-uninstall-backup-${Date.now()}`;
      copyFileSync(file, backup);
      report.rcBackups.push(backup);
      if (file.endsWith("lifeos.fish")) { moveOut(file, join(plan.trash, "fish", "lifeos.fish")); continue; }
      const kept = readFileSync(file, "utf-8").split("\n").filter((l) => !ALIAS_RE.test(l) && !ALIAS_HEADER_RE.test(l));
      atomicWriteText(file, kept.join("\n"));
    }

    // 6. user data — only on explicit request, and still a move.
    report.step = "user-data";
    if (plan.userData.action === "move" && existsSync(o.configDir)) { const dst = join(plan.trash, "user-data"); moveOut(o.configDir, dst); report.userData = dst; }
    else report.userData = `kept at ${o.configDir}`;

    report.step = "done";
    report.ok = true;
    const trashedSkill = join(plan.trash, "config-root", "skills", basename(o.skillRoot));
    if (existsSync(trashedSkill)) report.followUp = `the tool itself is now in the trash; a later --purge-user runs from there: bun ${join(trashedSkill, "Tools", "Uninstall.ts")} --skill-root ${trashedSkill} --config-root ${configRoot} --config-dir ${o.configDir} --trash ${plan.trash} --apply --purge-user`;
    return report;
  } catch (e) { report.error = e instanceof Error ? e.message : String(e); return report; }
}

function parseArgs(): UninstallOptions & { apply: boolean } {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => { const i = a.indexOf(flag); return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined; };
  const home = resolve(get("--home") || process.env.HOME || homedir());
  const configRoot = resolve(get("--config-root") || process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
  return {
    home, configRoot,
    configDir: resolve(get("--config-dir") || process.env.LIFEOS_CONFIG_DIR || join(home, ".config", "LIFEOS")),
    skillRoot: resolve(get("--skill-root") || join(import.meta.dir, "..")),
    trash: get("--trash"),
    apply: a.includes("--apply"),
    purgeUser: a.includes("--purge-user"),
  };
}

if (import.meta.main) {
  const o = parseArgs();
  const plan = planUninstall(o);
  if (!plan.ok) { console.log(JSON.stringify(plan, null, 2)); process.exit(2); }
  if (!o.apply) { console.log(JSON.stringify({ ...plan, dryRun: true, note: `nothing written; re-run with --apply --trash ${plan.trash} after the user confirms this plan (passing --trash keeps the confirmed path)` }, null, 2)); process.exit(0); }
  const report = applyUninstall(plan, o);
  console.log(JSON.stringify({ ok: report.ok, applied: true, plan, report }, null, 2));
  process.exit(report.ok ? 0 : 1);
}
