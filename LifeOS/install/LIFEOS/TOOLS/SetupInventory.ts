#!/usr/bin/env bun
/**
 * SetupInventory — which USER files the shipped LifeOS code depends on, and
 * whether a new install can get each system that reads them working.
 *
 * The list of systems is never hand-kept. It is derived from the code: every
 * USER path a shipped file reads is extracted, then matched against the setup
 * manifest (`LIFEOS/SETUP/SetupManifest.json`), which dispositions each path
 * (`template`, `runtime-created`, `private-only`) and names the system and its
 * setup guide. A read the manifest does not cover is a gap; the release gate
 * fails on any gap, so a new system cannot ship without a template and a guide.
 *
 *   bun LIFEOS/TOOLS/SetupInventory.ts list   [--json] [--root DIR] [--files-from FILE]
 *   bun LIFEOS/TOOLS/SetupInventory.ts check  [--templates DIR] [--guides] [--orphans] [--root DIR] [--files-from FILE]
 *   bun LIFEOS/TOOLS/SetupInventory.ts status [--json] [--user DIR] [--probe]
 *   bun LIFEOS/TOOLS/SetupInventory.ts hashes --templates DIR --out FILE
 *
 * Exit codes: 0 clean · 1 gaps found / systems need setup (status --strict) · 2 usage or IO error,
 * including any input file or directory that could not be read (list and check then print INCOMPLETE
 * and never exit 0 on the reduced inventory).
 *
 * @version 1.0.1
 */

import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { invariant } from "./Invariant";

const CLAUDE_DIR = resolve(import.meta.dir, "..", "..");
export const MANIFEST_PATH = join(CLAUDE_DIR, "LIFEOS", "SETUP", "SetupManifest.json");
const HASHES_PATH = join(CLAUDE_DIR, "LIFEOS", "SETUP", "template-hashes.json");

/** template: ships in the release USER tree · runtime-created: the system writes it on first run · private-only: read only by maintainer or excluded code, never shipped · not-a-path: an extractor false positive (env names, examples), with a note. */
export type Disposition = "template" | "runtime-created" | "private-only" | "not-a-path";

export interface ManifestPath { path: string; system: string; disposition: Disposition; note?: string }
export interface ManifestSystem {
  name: string;
  /** What it does, one sentence. */
  summary: string;
  /** Setup guide, relative to the config root. Required unless `setup: "none"`. */
  guide?: string;
  /** `required`: the system does not work until set up. `optional`: off until the user opts in. `none`: works from templates alone. */
  setup: "required" | "optional" | "none";
  /** USER-relative files that must exist (and differ from the shipped template) for the system to count as set up. */
  requires?: string[];
  /** A read-only command that proves the system works; run only with `status --probe`. */
  probe?: string;
  /** A core component this system needs that the release does not ship; status prints it on every row. */
  external?: string;
}
export interface Manifest { version: number; systems: Record<string, ManifestSystem>; paths: ManifestPath[] }

export interface Read { path: string; files: string[] }

// ── Ship set ────────────────────────────────────────────────────────────────

const CODE_EXT = /\.(ts|tsx|js|mjs|sh)$/;
const NEVER_SHIPS = [
  /^LIFEOS\/(USER|MEMORY|LIFEOS_RELEASES|tmp|EVIDENCE)\//,
  /^skills\/_/,
  /(^|\/)(node_modules|\.next)\//,
  /^LIFEOS\/TOOLS\/SetupInventory\.ts$/,
  /(^|\/)(test|tests|__tests__)\//,
  /\.test\.(ts|tsx|js)$/,
];
const SHIP_ROOTS = ["LIFEOS", "hooks", "skills", "commands", "agents"];

/**
 * Code files under `root` that ship by the coarse public-zone rule, and every directory that could not
 * be listed. A ship root that does not exist is absent (an install without a `commands` tree); any other
 * listing failure is unreadable input, which a gate must not evaluate as if it were complete.
 */
export function shippedCodeFilesChecked(root: string): { files: string[]; unreadable: string[] } {
  const out: string[] = [];
  const unreadable: string[] = [];
  const walk = (dir: string, top: boolean): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) {
      if (!(top && (e as NodeJS.ErrnoException).code === "ENOENT")) unreadable.push(relative(root, dir) || dir);
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs);
      if (NEVER_SHIPS.some((re) => re.test(e.isDirectory() ? `${rel}/` : rel))) continue;
      if (e.isDirectory()) walk(abs, false);
      else if (e.isFile() && CODE_EXT.test(e.name)) out.push(rel);
    }
  };
  for (const top of SHIP_ROOTS) walk(join(root, top), true);
  return { files: out.sort(), unreadable: unreadable.sort() };
}

/** Code files under `root` that ship by the coarse public-zone rule. The release gate passes the exact list instead. */
export function shippedCodeFiles(root: string): string[] {
  return shippedCodeFilesChecked(root).files;
}

// ── Extraction ──────────────────────────────────────────────────────────────

const SEG = /^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/;

/** Cut a raw USER-relative path back to its last fully static segment. */
export function normalizeUserPath(raw: string): string | null {
  const segs: string[] = [];
  for (const s of raw.split("/")) {
    if (!s) break;
    if (!SEG.test(s) || /[-._]$/.test(s) || /YYYY|<|\*/.test(s)) break;
    segs.push(s);
  }
  if (!segs.length || !/^[A-Z_]/.test(segs[0])) return null;
  return segs.join("/");
}

const LITERAL_USER = /(?:^|[/"'`])USER\/([A-Za-z0-9_][A-Za-z0-9_./@${}<>*-]*)/g;
const JOIN_USER = /(?:["'`]USER["'`]|\b[A-Z_]*USER[A-Z_]*|userDir|userRoot|lifeosUser\w*|lifeosUserDir\(\))\s*,\s*((?:["'`][^"'`\n]*["'`]\s*,?\s*)+)/g;

/** Every USER-relative path a source file names, by literal path or by join(userDir, "<DIR>", "<file>"). */
export function extractUserPaths(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(LITERAL_USER)) {
    const p = normalizeUserPath(m[1]);
    if (p) found.add(p);
  }
  for (const m of source.matchAll(JOIN_USER)) {
    const parts = [...m[1].matchAll(/["'`]([^"'`\n]*)["'`]/g)].map((x) => x[1]);
    const p = normalizeUserPath(parts.join("/"));
    if (p) found.add(p);
  }
  return [...found];
}

/**
 * The USER paths the listed files read. A file that cannot be read is pushed onto `unreadable` when the
 * caller passes one: the inventory is then incomplete and a gate must say so, never call it clean.
 */
export function collectReads(root: string, files: string[], unreadable?: string[]): Read[] {
  const byPath = new Map<string, Set<string>>();
  for (const rel of files) {
    let src: string;
    try { src = readFileSync(join(root, rel), "utf8"); } catch { unreadable?.push(rel); continue; }
    for (const p of extractUserPaths(src)) {
      if (!byPath.has(p)) byPath.set(p, new Set());
      byPath.get(p)!.add(rel);
    }
  }
  return [...byPath].map(([path, f]) => ({ path, files: [...f].sort() })).sort((a, b) => a.path.localeCompare(b.path));
}

/** Exit status for an inventory: unreadable input outranks every finding, because the findings come from a reduced inventory. */
export const EXIT_INCOMPLETE = 2;

// ── Manifest matching ───────────────────────────────────────────────────────

export function loadManifest(path = MANIFEST_PATH): Manifest {
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  invariant(m && typeof m.systems === "object" && Array.isArray(m.paths), `malformed setup manifest at ${path}`);
  for (const e of m.paths) invariant(["template", "runtime-created", "private-only", "not-a-path"].includes(e.disposition) && (e.disposition !== "not-a-path" || !!e.note), `bad manifest entry ${e.path}: disposition ${e.disposition}${e.disposition === "not-a-path" ? " needs a note" : ""}`);
  return m;
}

/** The manifest entry covering a read: an exact match, or the deepest entry that is a parent directory of it. A read that is a parent of an entry is covered too (the code walks into it). */
export function coveringEntry(manifest: Manifest, readPath: string): ManifestPath | undefined {
  let best: ManifestPath | undefined;
  for (const e of manifest.paths) {
    if (e.path === readPath) return e;
    if (readPath.startsWith(`${e.path}/`) && (!best || e.path.length > best.path.length)) best = e;
  }
  if (best) return best;
  return manifest.paths.find((e) => e.path.startsWith(`${readPath}/`));
}

export interface CheckResult { gaps: Read[]; missingTemplates: ManifestPath[]; missingGuides: string[]; unknownSystems: string[]; orphans: string[] }

export function check(manifest: Manifest, reads: Read[], opts: { templates?: string; guidesRoot?: string; orphans?: boolean }): CheckResult {
  const gaps = reads.filter((r) => !coveringEntry(manifest, r.path));
  const unknownSystems = [...new Set(manifest.paths.map((p) => p.system).filter((s) => !manifest.systems[s]))];
  const missingTemplates = opts.templates
    ? manifest.paths.filter((p) => p.disposition === "template" && !existsSync(join(opts.templates!, p.path)))
    : [];
  const missingGuides = opts.guidesRoot
    ? Object.entries(manifest.systems)
        .filter(([, s]) => s.setup !== "none")
        .filter(([, s]) => !s.guide || !existsSync(join(opts.guidesRoot!, s.guide)) || !guideIsComplete(readFileSync(join(opts.guidesRoot!, s.guide), "utf8")))
        .map(([id]) => id)
    : [];
  const orphans = opts.orphans && opts.templates ? templateOrphans(manifest, reads, opts.templates) : [];
  return { gaps, missingTemplates, missingGuides, unknownSystems, orphans };
}

/** A guide is complete when it carries the four parts a new user needs. */
export function guideIsComplete(text: string): boolean {
  return ["## What it does", "## Fill in", "## Accounts and secrets", "## Prove it works"].every((h) => text.includes(h));
}

/** Top-level template entries nothing reads and the manifest does not claim. */
export function templateOrphans(manifest: Manifest, reads: Read[], templates: string): string[] {
  const claimed = (p: string): boolean =>
    reads.some((r) => r.path === p || r.path.startsWith(`${p}/`) || p.startsWith(`${r.path}/`)) ||
    manifest.paths.some((e) => e.path === p || e.path.startsWith(`${p}/`) || p.startsWith(`${e.path}/`));
  const out: string[] = [];
  for (const top of readdirSync(templates)) {
    if (top === "README.md" || top.startsWith(".")) continue;
    const abs = join(templates, top);
    if (statSync(abs).isDirectory()) {
      if (claimed(top)) {
        for (const child of readdirSync(abs)) {
          const rel = `${top}/${child}`;
          if (child !== "README.md" && !child.startsWith(".") && !claimed(rel) && !claimed(top + "/")) out.push(rel);
        }
      } else out.push(top);
    } else if (!claimed(top) && !claimed(top.replace(/\.md$/, ""))) out.push(top);
  }
  return out.sort();
}

// ── Status ──────────────────────────────────────────────────────────────────

export type SystemState = "ready" | "needs-setup" | "optional-off";
export interface SystemStatus { id: string; name: string; state: SystemState; missing: string[]; unchanged: string[]; next: string; external?: string; probe?: { ok: boolean; output: string } }

function sha256(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

export function systemStatus(manifest: Manifest, userDir: string, hashes: Record<string, string>, opts: { probe?: boolean } = {}): SystemStatus[] {
  // A system with nothing to set up and no guide (maintainer tooling, extractor noise) is bookkeeping, not something a user acts on.
  return Object.entries(manifest.systems).filter(([, s]) => s.setup !== "none" || !!s.guide).sort(([a], [b]) => a.localeCompare(b)).map(([id, s]) => {
    const req = s.requires ?? [];
    const missing = req.filter((p) => !existsSync(join(userDir, p)));
    const unchanged = req.filter((p) => existsSync(join(userDir, p)) && statSync(join(userDir, p)).isFile() && hashes[p] && sha256(join(userDir, p)) === hashes[p]);
    const untouched = missing.length + unchanged.length;
    let state: SystemState = "ready";
    if (s.setup === "required" && untouched > 0) state = "needs-setup";
    if (s.setup === "optional" && req.length > 0 && untouched === req.length) state = "optional-off";
    if (s.setup === "optional" && untouched > 0 && untouched < req.length) state = "needs-setup";
    const next = state === "ready" ? "" : s.guide ? `follow ${s.guide}` : `fill in ${[...missing, ...unchanged].join(", ")}`;
    const status: SystemStatus = { id, name: s.name, state, missing, unchanged, next, ...(s.external ? { external: s.external } : {}) };
    if (opts.probe && s.probe && state === "ready") {
      const r = spawnSync("sh", ["-c", s.probe], { cwd: CLAUDE_DIR, encoding: "utf8", timeout: 30_000 });
      status.probe = { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-1)[0] ?? "" };
      if (!status.probe.ok) { status.state = "needs-setup"; status.next = s.guide ? `probe failed; follow ${s.guide}` : "probe failed"; }
    }
    return status;
  });
}

export function templateHashes(manifest: Manifest, templates: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of Object.values(manifest.systems)) for (const p of s.requires ?? []) {
    const abs = join(templates, p);
    if (existsSync(abs) && statSync(abs).isFile()) out[p] = sha256(abs);
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function flag(args: string[], name: string): string | undefined { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

function readsFor(args: string[]): { reads: Read[]; unreadable: string[] } {
  const root = resolve(flag(args, "--root") ?? CLAUDE_DIR);
  const from = flag(args, "--files-from");
  const unreadable: string[] = [];
  let files: string[];
  if (from) files = readFileSync(from, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && CODE_EXT.test(l) && !NEVER_SHIPS.some((re) => re.test(l)));
  else { const walked = shippedCodeFilesChecked(root); files = walked.files; unreadable.push(...walked.unreadable); }
  const reads = collectReads(root, files, unreadable);
  return { reads, unreadable };
}

/** Says which inputs could not be read; paths only, never file content. */
function reportUnreadable(unreadable: string[]): void {
  const shown = unreadable.slice(0, 20).join(", ");
  console.error(`INCOMPLETE: ${unreadable.length} input(s) could not be read (${shown}${unreadable.length > 20 ? `, +${unreadable.length - 20} more` : ""}). The inventory is partial, so this result is not a clean bill.`);
}

function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  const json = args.includes("--json");
  const manifest = existsSync(flag(args, "--manifest") ?? MANIFEST_PATH) ? loadManifest(flag(args, "--manifest") ?? MANIFEST_PATH) : { version: 1, systems: {}, paths: [] };

  if (cmd === "list") {
    const inv = readsFor(args);
    const rows = inv.reads.map((r) => { const e = coveringEntry(manifest, r.path); return { path: r.path, system: e?.system ?? null, disposition: e?.disposition ?? null, readBy: r.files }; });
    if (json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) console.log(`${(r.disposition ?? "GAP").padEnd(16)} ${(r.system ?? "-").padEnd(18)} ${r.path}  (${r.readBy.length} file${r.readBy.length === 1 ? "" : "s"})`);
    if (inv.unreadable.length) { reportUnreadable(inv.unreadable); return EXIT_INCOMPLETE; }
    return 0;
  }

  if (cmd === "check") {
    const templates = flag(args, "--templates");
    const inv = readsFor(args);
    const res = { ...check(manifest, inv.reads, { templates, guidesRoot: args.includes("--guides") ? resolve(flag(args, "--root") ?? CLAUDE_DIR) : undefined, orphans: args.includes("--orphans") }), unreadable: inv.unreadable };
    if (json) { console.log(JSON.stringify(res, null, 2)); }
    else {
      for (const g of res.gaps) console.log(`GAP        USER/${g.path}  read by ${g.files.slice(0, 3).join(", ")}${g.files.length > 3 ? ` +${g.files.length - 3}` : ""}`);
      for (const t of res.missingTemplates) console.log(`NO-TEMPLATE USER/${t.path}  (${t.system})`);
      for (const s of res.missingGuides) console.log(`NO-GUIDE   ${s}  (needs a guide with: What it does / Fill in / Accounts and secrets / Prove it works)`);
      for (const s of res.unknownSystems) console.log(`UNKNOWN-SYSTEM ${s}`);
      for (const o of res.orphans) console.log(`ORPHAN     template ${o} is read by nothing and claimed by no system`);
    }
    const bad = res.gaps.length + res.missingTemplates.length + res.missingGuides.length + res.unknownSystems.length + res.orphans.length;
    // Unreadable input is its own outcome: a reduced inventory can show no gaps, so it never reads as clean.
    if (inv.unreadable.length) { reportUnreadable(inv.unreadable); if (!json) console.log(bad ? `\n${bad} problem(s) in the part that could be read` : "no problems in the part that could be read; result INCOMPLETE"); return EXIT_INCOMPLETE; }
    if (!json) console.log(bad ? `\n${bad} problem(s)` : "clean");
    return bad ? 1 : 0;
  }

  if (cmd === "status") {
    const userDir = resolve(flag(args, "--user") ?? join(CLAUDE_DIR, "LIFEOS", "USER"));
    const hashes = existsSync(HASHES_PATH) ? JSON.parse(readFileSync(HASHES_PATH, "utf8")) as Record<string, string> : {};
    const rows = systemStatus(manifest, userDir, hashes, { probe: args.includes("--probe") });
    if (json) { console.log(JSON.stringify(rows, null, 2)); }
    else {
      const mark = { "ready": "✓", "needs-setup": "✗", "optional-off": "·" } as const;
      for (const r of rows) console.log(`${mark[r.state]} ${r.name.padEnd(26)} ${r.state.padEnd(13)} ${r.next}${r.external ? `\n    ⚠ ${r.external}` : ""}`);
      const need = rows.filter((r) => r.state === "needs-setup").length;
      console.log(`\n${rows.filter((r) => r.state === "ready").length} ready · ${need} need setup · ${rows.filter((r) => r.state === "optional-off").length} optional and off`);
    }
    return args.includes("--strict") && rows.some((r) => r.state === "needs-setup") ? 1 : 0;
  }

  if (cmd === "hashes") {
    const templates = flag(args, "--templates"), out = flag(args, "--out");
    if (!templates || !out) { console.error("hashes needs --templates DIR --out FILE"); return 2; }
    const h = templateHashes(manifest, templates);
    invariant(Object.values(h).every((v) => /^[0-9a-f]{64}$/.test(v)), "template hash is not sha256 hex");
    writeFileSync(out, `${JSON.stringify(h, null, 2)}\n`);
    console.log(`wrote ${Object.keys(h).length} template hashes to ${out}`);
    return 0;
  }

  console.error("usage: SetupInventory.ts list|check|status|hashes  (see header)");
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
