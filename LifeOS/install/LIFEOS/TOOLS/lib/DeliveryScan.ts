/**
 * DeliveryScan — the one walk of the delivery roots. Its shipped consumer is the independent denominator
 * (LIFEOS/TOOLS/OutputReconciler.ts). The maintainer-side OutputRecord hook (not shipped) uses the same walk, so the two
 * can never disagree about which files exist.
 *
 * Ideal state: every regular file that lands in a delivery root is a candidate output line, whatever its type, its depth or
 * how it got there. The kind of a file only decides how it is proofed (ProofKinds.ts), never whether it counts.
 *
 * Roots: the list in LIFEOS/USER/CONFIG/delivery-roots.json (`{"roots":["~/Downloads", ...]}`) when present, else
 * ~/Downloads, ~/Desktop, ~/Documents, ~/Library/Mobile Documents/com~apple~CloudDocs and every directory under
 * ~/Library/CloudStorage. A root that does not exist is skipped silently; a root nested inside another is dropped.
 *
 * The walk: breadth first across all roots at once (so top-level files of every root are seen before anything deep), lstat
 * on every entry, bounded to depth 6 and 20,000 entries. Dotfiles are included; only .DS_Store, .localized and partial
 * downloads (.part .crdownload .download .tmp .partial .icloud) are skipped only while their changed-time is within the last 10
 * minutes (TRANSIENT_WINDOW_MS); an older one is an ordinary file (kind "other"). Symlinks to files are entries (read through to
 * the target, so a hash is the target's); a symlink whose target is gone is an entry flagged `dangling`; a symlink to a
 * directory is never entered. Overflow, or a directory that cannot be read, marks the result incomplete: the files not
 * visited are unknown, and the caller must NOT treat them as seen. Directories below the depth bound are counted in
 * `truncated_dirs` and are informational (a documented bound, not a fault).
 *
 * This module emits nothing: it returns what happened and the caller raises the one Vigil event.
 *
 * @version 1.0.0
 */
import { lstatSync as realLstat, readFileSync, readdirSync as realReaddir, realpathSync, statSync as realStat, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { lifeosDirFor } from "../Paths.ts";
import { IGNORED_NAMES, TRANSIENT_NAME } from "./ProofKinds.ts";

/** The legacy bounds, used when scanDelivery is called without a mode. */
export const SCAN_MAX_DEPTH = 6;
export const SCAN_MAX_ENTRIES = 20_000;

/**
 * Two scan modes (2026-09-30). "hot" runs on every tool call (the maintainer-side OutputRecord hook, not shipped) and is change-driven for Downloads and
 * Desktop: a root whose own mtime and ctime are not past the stamp has had nothing added or removed at its top level and is not listed (one
 * stat); otherwise its top level is listed in full with no entry cap and every entry is lstat'ed, and a depth-1 subdirectory is
 * entered only when its own mtime or ctime is past the stamp. Deeper landings are the daily full scan's, and the directories and
 * files a call names are walked or stat'ed directly. Named directories keep the old bounded walk (depth 3, 5,000 entries), and
 * running out of that bound is not a fault. "full" is the reconciler's: every root, depth 8, 500,000 entries, overflow is a fault
 * the caller reports once.
 *
 * Full mode walks only the hand-off roots (HANDOFF_WALK_CHANNELS: Downloads and Desktop), each with its own entry budget, so one root can
 * never starve the other and a cloud tree can never eat the budget. Every other root is never walked (a cloud placeholder listing can
 * trigger downloads and time out); the caller reaches those through paths and directories it names (`walkChannels` widens the walk for one
 * such named directory).
 */
export type ScanMode = "hot" | "full";
export const HOT_MAX_DEPTH = 3;
export const HOT_MAX_ENTRIES = 5_000;
export const FULL_MAX_DEPTH = 8;
export const FULL_MAX_ENTRIES = 500_000;
/** Channels the hot walk covers on its own; any other root is reached in hot mode only through a directory the call names. */
export const HOT_CHANNELS: readonly string[] = ["downloads", "desktop"];
/** Channels the full walk covers by default; every other root is never listed. */
export const HANDOFF_WALK_CHANNELS: readonly string[] = HOT_CHANNELS;

/** Directory names never entered in hot or full mode: bundles and dependency trees hold thousands of files nobody delivered. */
const SKIP_DIR_SUFFIXES = [".app", ".photoslibrary", ".bundle", ".framework"];
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "library"]);
/** A partial-download name is ignored only while its changed-time is this recent; an older one is a stalled file nobody is still writing. */
export const TRANSIENT_WINDOW_MS = 10 * 60 * 1000;
/** The known-subfolder cache: keys under this prefix in the scan state hold a depth-1 subdirectory's max(mtime, ctime). Capped, most recent first. */
export const SUB_KEY = "\0sub\0";
export const MAX_KNOWN_SUBS = 2_000;
/**
 * Bundle suffixes are skipped at any depth. The names node_modules, .git and library are skipped only BELOW depth 1 (`depth` is the
 * directory's depth under its delivery root; a direct child of a root is depth 1), so ~/Downloads/Library/x.mp4 is still an output.
 */
export function skippedDir(name: string, depth = 2): boolean {
  const n = name.toLowerCase();
  return (depth > 1 && SKIP_DIR_NAMES.has(n)) || SKIP_DIR_SUFFIXES.some((x) => n.endsWith(x));
}

/** A delivery root and the channel name its files are recorded under (a plain token, never a path). */
export type DeliveryRoot = { channel: string; path: string };

export type ScanEntry = {
  path: string;
  channel: string;
  /** The scan unit (a root, or a directory a tool call named) this entry was found under. */
  scope: string;
  /** Latest of mtime and ctime (and, for a symlink, the target's): the "something changed here" clock. */
  changed: number;
  mtimeMs: number;
  birthtimeMs: number;
  size: number;
  symlink: boolean;
  /** A symlink whose target cannot be resolved. */
  dangling: boolean;
};

export type ScanResult = {
  entries: ScanEntry[];
  /** Directory entries examined (files and directories), the number bounded by SCAN_MAX_ENTRIES. */
  visited: number;
  overflow: boolean;
  /** Directories (or roots) that could not be read. */
  unreadable_dirs: number;
  /** Directories not entered because they sit below SCAN_MAX_DEPTH. Informational. */
  truncated_dirs: number;
  /** True only when nothing the walk was meant to see was left unvisited because of overflow or an unreadable directory. */
  complete: boolean;
  /** The mode the walk ran in; "legacy" when scanDelivery was called with no mode (the old 6 / 20,000 bounds, no skip list). */
  mode: ScanMode | "legacy";
  /** Bundle and dependency directories not entered (hot and full). Informational. */
  skipped_dirs: number;
  /** Each scan unit (a root, or a directory a hot call named) and whether the walk finished it. A unit that is not covered keeps its stamp. */
  units: { path: string; channel: string; covered: boolean }[];
  /** Hot only: the refreshed known-subfolder cache (depth-1 subdirectory path -> max(mtime, ctime) ms) for every hot root, to persist under SUB_KEY. Empty when no `subs` was given. */
  subs: Record<string, number>;
};

export type ScanLimits = {
  maxDepth?: number;
  maxEntries?: number;
  /** "hot" or "full" set the bounds, the roots and the skip list; omitted keeps the legacy behavior. Explicit maxDepth / maxEntries still win. */
  mode?: ScanMode;
  /**
   * Hot only: the "past this means new" clock of a scan unit (a hot root's path), in ms. A hot root whose own mtime and ctime are not
   * past it is not listed, and a depth-1 subdirectory is entered only when its own mtime or ctime is past it. Omitted: everything
   * is new (top level listed, every depth-1 subdirectory entered).
   */
  since?: (unitPath: string) => number;
  /** Hot only: directories the current tool call names. Each inside a root is walked first, as its own unit. */
  extraDirs?: readonly string[];
  /** Hot only: files the current tool call names; each is lstat'ed directly, so a file in a huge directory is never missed. */
  extraFiles?: readonly string[];
  /**
   * Hot only: the known depth-1 subfolders of the hot roots with the clock they had when last seen (the persisted cache). When a hot
   * root is unchanged, each is stat'ed and any whose clock moved past its cached one is listed one level, so a file added to an
   * existing subfolder is found without listing the root. Omitted: no cache is kept.
   */
  subs?: ReadonlyMap<string, number> | Record<string, number>;
  /** The clock "now" is read from for the transient-name window (ms epoch); default Date.now(). A test seam. */
  now?: number;
  /** Full only: the root channels the walk lists, each on its own entry budget. Default HANDOFF_WALK_CHANNELS; a root of any other channel is not a unit. */
  walkChannels?: readonly string[];
};

/** The file-system calls the walk makes. A test seam: count what is listed per root. */
export type ScanFs = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => import("node:fs").Dirent[];
  lstatSync: (path: string) => Stats;
  statSync: (path: string) => Stats;
};

/** The options form: `scanDelivery({ mode: "full" })` walks the delivery roots under `home` (default: the real home). */
export type ScanOptions = ScanLimits & { roots?: readonly DeliveryRoot[]; keep?: (e: ScanEntry) => boolean; home?: string; fs?: ScanFs };

const CONFIG_REL = join("USER", "CONFIG", "delivery-roots.json");

/** The delivery-roots config under the install root that serves `home`: CLAUDE_CONFIG_DIR / LIFEOS_DIR apply only for the real home. */
export function deliveryConfigPath(home: string, env: Record<string, string | undefined> = process.env): string {
  return join(lifeosDirFor(home === homedir() ? env : {}, home), CONFIG_REL);
}

/** The channel a root is recorded under: well-known roots by name, every CloudStorage directory as "cloud", anything else "custom". */
export function channelFor(path: string, home: string): string {
  const p = resolve(path);
  if (p === join(home, "Downloads")) return "downloads";
  if (p === join(home, "Desktop")) return "desktop";
  if (p === join(home, "Documents")) return "documents";
  if (p === join(home, "Library", "Mobile Documents", "com~apple~CloudDocs")) return "icloud";
  if (p.startsWith(join(home, "Library", "CloudStorage") + "/")) return "cloud";
  return "custom";
}

function isDir(p: string): boolean { try { return realStat(p).isDirectory(); } catch { return false; } }

/** The configured roots, or null when the config is absent or does not parse to a list of strings. */
function configuredRoots(home: string, configFile?: string): string[] | null {
  try {
    const raw = JSON.parse(readFileSync(configFile ?? deliveryConfigPath(home), "utf8")) as { roots?: unknown };
    if (!Array.isArray(raw.roots) || !raw.roots.every((r) => typeof r === "string" && r.length > 0)) return null;
    return (raw.roots as string[]).map((r) => (r.startsWith("~") ? join(home, r.slice(1)) : resolve(r)));
  } catch { return null; }
}

/** The delivery roots that exist under `home`. `configFile` is a test seam; the default is the USER config in home's .claude. */
export function deliveryRoots(home: string = homedir(), opts: { configFile?: string } = {}): DeliveryRoot[] {
  let paths = configuredRoots(home, opts.configFile);
  if (paths === null) {
    paths = [join(home, "Downloads"), join(home, "Desktop"), join(home, "Documents"), join(home, "Library", "Mobile Documents", "com~apple~CloudDocs")];
    try {
      for (const e of realReaddir(join(home, "Library", "CloudStorage"), { withFileTypes: true })) {
        if (e.isDirectory() || e.isSymbolicLink()) paths.push(join(home, "Library", "CloudStorage", e.name));
      }
    } catch { /* no CloudStorage */ }
  }
  const existing = [...new Set(paths)].filter(isDir);
  // A root inside another root is walked by the parent: dropping it keeps one file from being counted twice.
  const kept = existing.filter((p) => !existing.some((o) => o !== p && p.startsWith(o + "/")));
  return kept.map((path) => ({ channel: channelFor(path, home), path }));
}

/**
 * Walk the roots and return every regular-file entry `keep` accepts. `keep` sees the entry before it is stored, so a caller
 * that wants "changed since X" does not pay for a list of every file. Never throws.
 *
 * Two call forms: `scanDelivery(roots, keep, limits)` and `scanDelivery({ mode, roots?, keep?, home?, ... })`.
 *
 * mode "full": the hand-off roots (Downloads, Desktop) only, each walked breadth first on its own budget of 500,000 entries, depth 8,
 * bundle and dependency directories skipped; no other root is ever listed.
 * mode "hot": units in priority order: the directories the tool call names (bounded breadth-first walk, depth 3, 5,000 entries, same
 * skip list; running out of entries is not a fault, `units` says which were finished), then Desktop, then Downloads, each change-driven
 * (see ScanMode) and uncapped, so a huge Downloads is listed in full the moment it changes and costs one stat when it did not.
 * No mode: the legacy walk (depth 6, 20,000 entries, no skip list).
 */
export function scanDelivery(opts: ScanOptions): ScanResult;
export function scanDelivery(roots: readonly DeliveryRoot[], keep: (e: ScanEntry) => boolean, limits?: ScanLimits): ScanResult;
export function scanDelivery(a: readonly DeliveryRoot[] | ScanOptions, keepArg?: (e: ScanEntry) => boolean, limitsArg: ScanLimits = {}): ScanResult {
  const opts: ScanOptions = Array.isArray(a) ? { ...limitsArg, roots: a as readonly DeliveryRoot[], keep: keepArg } : (a as ScanOptions);
  const keep = opts.keep ?? (() => true);
  // The file-system calls go through one seam so a test can count them; the real ones are the default.
  const { readdirSync, lstatSync, statSync } = (opts.fs ?? { readdirSync: realReaddir, lstatSync: realLstat, statSync: realStat }) as ScanFs;
  const mode = opts.mode;
  const allRoots = opts.roots ?? deliveryRoots(opts.home ?? homedir());
  const maxDepth = opts.maxDepth ?? (mode === "hot" ? HOT_MAX_DEPTH : mode === "full" ? FULL_MAX_DEPTH : SCAN_MAX_DEPTH);
  const maxEntries = opts.maxEntries ?? (mode === "hot" ? HOT_MAX_ENTRIES : mode === "full" ? FULL_MAX_ENTRIES : SCAN_MAX_ENTRIES);
  const skips = mode !== undefined;
  const out: ScanResult = { entries: [], visited: 0, overflow: false, unreadable_dirs: 0, truncated_dirs: 0, complete: true, mode: mode ?? "legacy", skipped_dirs: 0, units: [], subs: {} };
  const nowMs = opts.now ?? Date.now();
  const knownSubs = new Map<string, number>(opts.subs instanceof Map ? opts.subs : Object.entries(opts.subs ?? {}));
  const trackSubs = opts.subs !== undefined;
  // Scopes (units) in which a partial-download name is still too fresh to count: hot mode holds those units' stamps so the file is looked at again.
  const freshTransientScopes = new Set<string>();
  const rootDepthOf = (p: string): number => {
    const r = allRoots.find((x) => p === x.path || p.startsWith(x.path + "/"));
    return r ? (p === r.path ? 0 : relative(r.path, p).split("/").length) : 0;
  };

  type Unit = { path: string; channel: string; started: boolean; incomplete: boolean };
  type Dir = { path: string; channel: string; depth: number; /** depth under the delivery root (a direct child of a root is 1) */ rdepth: number; unit: Unit };
  const units: Unit[] = [];
  const queued = new Set<string>();
  const addUnit = (path: string, channel: string): Unit | null => {
    try {
      if (!statSync(path).isDirectory()) return null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") out.unreadable_dirs++; // present but not statable: an unreadable root
      return null;
    }
    if (units.some((x) => x.path === path)) return null;
    const u: Unit = { path, channel, started: false, incomplete: false };
    units.push(u);
    return u;
  };

  if (mode === "hot") {
    // Named directories first (inside any root), then the hot roots smallest-first by priority: Desktop before Downloads.
    for (const d of opts.extraDirs ?? []) {
      const p = resolve(d);
      const ch = channelOfPath(p + "/x", allRoots);
      if (ch === null) continue;
      // channelOfPath is lexical and addUnit stats through links, so `~/Downloads/link -> /` (or a linked
      // component above the named directory) used to walk outside every root (LOSIntegrity
      // ). A named directory is entered only when it is not itself a link and its
      // real path stays inside the real path of the root it was named under.
      if (!namedDirInsideRoot(p, allRoots, lstatSync)) continue;
      if (allRoots.some((r) => r.path === p && HOT_CHANNELS.includes(r.channel))) continue; // a hot root keeps its own place in the order
      addUnit(p, ch);
    }
    for (const want of ["desktop", "downloads"]) for (const r of allRoots) if (r.channel === want) addUnit(r.path, r.channel);
  } else {
    // Full: the hand-off roots only (or the channels the caller widened it to); a cloud root is never a unit, so it is never listed.
    const walked = opts.walkChannels ?? HANDOFF_WALK_CHANNELS;
    for (const r of allRoots) if (mode !== "full" || walked.includes(r.channel)) addUnit(r.path, r.channel);
  }

  const add = (path: string, channel: string, scope: string, lst: Stats): void => {
    // birthtime too: a cp -p or mv keeps an old mtime, and a file born (or restored) here is new whatever its mtime says.
    let changed = Math.max(lst.mtimeMs, lst.ctimeMs, lst.birthtimeMs);
    let size = lst.size;
    let dangling = false;
    const symlink = lst.isSymbolicLink();
    let mtimeMs = lst.mtimeMs;
    if (symlink) {
      try {
        const target = statSync(path);
        if (!target.isFile()) return; // a link to a directory (or a device) is not a regular file
        changed = Math.max(changed, target.mtimeMs, target.ctimeMs);
        mtimeMs = Math.max(mtimeMs, target.mtimeMs);
        size = target.size;
      } catch { dangling = true; }
    }
    if (TRANSIENT_NAME.test(path.slice(path.lastIndexOf("/") + 1)) && changed > nowMs - TRANSIENT_WINDOW_MS) { freshTransientScopes.add(scope); return; }
    const entry: ScanEntry = { path, channel, scope, changed, mtimeMs, birthtimeMs: lst.birthtimeMs, size, symlink, dangling };
    if (keep(entry)) out.entries.push(entry);
  };

  /** One entry budget: the hot named directories share one, and each full root has its own. */
  type Budget = { used: number; halted: boolean };
  /** Breadth first over one group of start directories. Marks the units it could not finish. */
  const walk = (start: Dir[], budget: Budget): void => {
    let level = start;
    for (const d of level) d.unit.started = true;
    while (level.length > 0 && !budget.halted) {
      const next: Dir[] = [];
      for (let i = 0; i < level.length; i++) {
        const dir = level[i]!;
        if (budget.halted) break;
        let dirents;
        try { dirents = readdirSync(dir.path, { withFileTypes: true }); } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") { out.unreadable_dirs++; dir.unit.incomplete = true; } // vanished mid-scan is not a fault
          continue;
        }
        const enter = (p: string, name: string): void => {
          if (skips && skippedDir(name, dir.rdepth + 1)) { out.skipped_dirs++; return; }
          if (dir.depth + 1 > maxDepth) { out.truncated_dirs++; return; }
          if (queued.has(p)) return;
          queued.add(p);
          next.push({ path: p, channel: dir.channel, depth: dir.depth + 1, rdepth: dir.rdepth + 1, unit: dir.unit });
        };
        for (const e of dirents) {
          if (budget.used >= maxEntries) { budget.halted = true; out.overflow = true; dir.unit.incomplete = true; for (const rest of level.slice(i + 1)) rest.unit.incomplete = true; for (const n of next) n.unit.incomplete = true; break; }
          out.visited++; budget.used++;
          if (IGNORED_NAMES.has(e.name)) continue;
          const p = join(dir.path, e.name);
          if (e.isDirectory()) { enter(p, e.name); continue; }
          try {
            // A dirent whose type the filesystem did not report (DT_UNKNOWN) is classified by lstat like any other.
            const lst = lstatSync(p);
            if (lst.isDirectory()) { enter(p, e.name); continue; }
            if (lst.isFile() || lst.isSymbolicLink()) add(p, dir.channel, dir.unit.path, lst);
          } catch { /* vanished mid-scan */ }
        }
      }
      level = next;
    }
  };

  const isHotRoot = (u: Unit): boolean => allRoots.some((r) => r.path === u.path && HOT_CHANNELS.includes(r.channel));

  /**
   * Change-driven walk of one hot root (see the header). No entry cap: the top level is listed in full whenever the root changed.
   * Records an entry when add() says it changed (the caller's keep applies the stamp); enters a depth-1 subdirectory only when its
   * own mtime or ctime is past `since`, and lists it one level, never deeper.
   */
  const hotRoot = (u: Unit): void => {
    u.started = true;
    const since = opts.since ? opts.since(u.path) : Number.NEGATIVE_INFINITY;
    let rootClock: number;
    try {
      const st = statSync(u.path);
      rootClock = Math.max(st.mtimeMs, st.ctimeMs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") { out.unreadable_dirs++; u.incomplete = true; }
      return;
    }
    const prefix = u.path + "/";
    const toList: string[] = [];
    const subClock = new Map<string, number>(); // this root's refreshed depth-1 subfolder cache
    if (rootClock <= since) {
      // Nothing added or removed at the top level: the root is not listed. Each known subfolder is one stat; one whose clock moved
      // past its cached clock has had a file land in it, so it is listed one level.
      if (trackSubs) {
        for (const [p, stamp] of knownSubs) {
          if (!p.startsWith(prefix) || p.indexOf("/", prefix.length) !== -1) continue;
          try {
            const lst = lstatSync(p);
            if (!lst.isDirectory()) continue; // gone or replaced: dropped from the cache
            const clock = Math.max(lst.mtimeMs, lst.ctimeMs);
            subClock.set(p, clock);
            if (clock > stamp) toList.push(p);
          } catch { /* gone: dropped from the cache */ }
        }
      }
    } else {
      let top;
      try { top = readdirSync(u.path, { withFileTypes: true }); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") { out.unreadable_dirs++; u.incomplete = true; }
        return;
      }
      for (const e of top) {
        out.visited++;
        if (IGNORED_NAMES.has(e.name)) continue;
        const p = join(u.path, e.name);
        if (e.isDirectory() && skippedDir(e.name, 1)) { out.skipped_dirs++; continue; }
        try {
          const lst = lstatSync(p);
          if (lst.isDirectory()) {
            if (skippedDir(e.name, 1)) { out.skipped_dirs++; continue; }
            const clock = Math.max(lst.mtimeMs, lst.ctimeMs);
            if (trackSubs) subClock.set(p, clock);
            if (clock > since) toList.push(p); // its own clock moved: something landed inside
          } else if (lst.isFile() || lst.isSymbolicLink()) add(p, u.channel, u.path, lst);
        } catch { /* vanished mid-scan */ }
      }
    }
    for (const dir of toList) {
      let inner;
      try { inner = readdirSync(dir, { withFileTypes: true }); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") { out.unreadable_dirs++; u.incomplete = true; subClock.set(dir, 0); } // clock 0: listed again next call
        else subClock.delete(dir);
        continue;
      }
      for (const e of inner) {
        out.visited++;
        if (IGNORED_NAMES.has(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (skippedDir(e.name, 2)) out.skipped_dirs++; else out.truncated_dirs++; continue; } // depth 2: the daily full scan's
        try {
          const lst = lstatSync(p);
          if (lst.isDirectory()) { if (skippedDir(e.name, 2)) out.skipped_dirs++; else out.truncated_dirs++; continue; }
          if (lst.isFile() || lst.isSymbolicLink()) add(p, u.channel, u.path, lst);
        } catch { /* vanished mid-scan */ }
      }
    }
    for (const [p, c] of subClock) out.subs[p] = c;
  };

  if (mode === "hot") {
    // Files the call named are lstat'ed directly: one entry each, so a file in a huge directory is found without listing it.
    for (const fp of opts.extraFiles ?? []) {
      const p = resolve(fp);
      const ch = channelOfPath(p, allRoots);
      if (ch === null || IGNORED_NAMES.has(p.slice(p.lastIndexOf("/") + 1))) continue;
      try {
        const lst = lstatSync(p);
        out.visited++;
        if (lst.isFile() || lst.isSymbolicLink()) add(p, ch, p, lst);
      } catch { /* not there */ }
    }
    const named: Budget = { used: 0, halted: false };
    for (const u of units) {
      if (isHotRoot(u)) { hotRoot(u); continue; } // uncapped, so a named directory that ran out of entries never starves it
      if (named.halted) continue;
      queued.add(u.path);
      walk([{ path: u.path, channel: u.channel, depth: 0, rdepth: rootDepthOf(u.path), unit: u }], named);
    }
  } else if (mode === "full") {
    // Each root on its own budget: Desktop cannot starve Downloads or the other way round.
    for (const u of units) { queued.add(u.path); walk([{ path: u.path, channel: u.channel, depth: 0, rdepth: 0, unit: u }], { used: 0, halted: false }); }
  } else {
    const start: Dir[] = [];
    for (const u of units) { queued.add(u.path); start.push({ path: u.path, channel: u.channel, depth: 0, rdepth: 0, unit: u }); }
    walk(start, { used: 0, halted: false });
  }
  if (mode === "hot") for (const u of units) if (freshTransientScopes.has(u.path)) u.incomplete = true; // a partial download still being written: look again after the window
  const subKeys = Object.keys(out.subs);
  if (subKeys.length > MAX_KNOWN_SUBS) {
    out.subs = Object.fromEntries(subKeys.map((k) => [k, out.subs[k]!] as const).sort((x, y) => y[1] - x[1]).slice(0, MAX_KNOWN_SUBS));
  }
  out.units = units.map((u) => ({ path: u.path, channel: u.channel, covered: u.started && !u.incomplete }));
  out.complete = !out.overflow && out.unreadable_dirs === 0;
  return out;
}

/**
 * True when a named directory may be walked as a unit: it is not a symlink (lstat), and its realpath
 * lies inside the realpath of a root that lexically contains it. Any lstat or realpath failure is false.
 */
export function namedDirInsideRoot(path: string, roots: readonly DeliveryRoot[], lstat: (p: string) => Stats = realLstat): boolean {
  try {
    if (lstat(path).isSymbolicLink()) return false;
    const real = realpathSync(path);
    return roots.some((r) => {
      if (path !== r.path && !path.startsWith(r.path + "/")) return false;
      const rootReal = realpathSync(r.path);
      return real === rootReal || real.startsWith(rootReal + "/");
    });
  } catch {
    return false;
  }
}

/** True when `path` sits inside a root; the channel of the first such root, else null. */
export function channelOfPath(path: string, roots: readonly DeliveryRoot[]): string | null {
  for (const r of roots) if (path.startsWith(r.path + "/")) return r.channel;
  return null;
}
