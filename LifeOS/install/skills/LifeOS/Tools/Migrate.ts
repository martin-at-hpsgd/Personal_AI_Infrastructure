#!/usr/bin/env bun
/**
 * Migrate — brings an older install's USER tree to the shape the current release reads.
 *
 * It finds the version the install came from, then runs every migration in the ledger (`lib/migrations.ts`) that is
 * newer than that version and not yet applied, in ledger order, each exactly once. Applied ids are recorded in
 * `<USER>/CONFIG/migrations.json`. Every file a migration replaces or moves is copied first to
 * `<USER>/../.lifeos-migration-backups/<run>/<path>`, and the copy is read back before the original is touched.
 * Without --apply it is a dry run: it prints what each migration would do and writes nothing.
 *
 * From-version, first match wins:
 *   1. --from <version>                     (e.g. the old install's VERSION after ImportPrevious)
 *   2. `pendingFrom` in migrations.json      (set by --mark-from before the overlay rewrites VERSION)
 *   3. <configRoot>/LIFEOS/VERSION           (the install marker, shipped since 7.1.1)
 *   4. 0.0.0                                 (no marker: an install older than the marker, so every entry is a candidate)
 *
 * Usage:
 *   bun Tools/Migrate.ts [--config-root <dir>] [--user-dir <dir>] [--templates <dir>] [--from <version>] [--apply] [--allow-dev]
 *   bun Tools/Migrate.ts --mark-from <version> [--apply]     # remember the pre-upgrade version (InstallAll does this)
 *
 * Imports stay inside the skill: this runs from the download directory before ../../../LIFEOS exists.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { claudeDirFor } from "./lib/claude-dir";
import { refuseDevInstallWrites } from "./InstallEngine";
import { atomicWriteJSON, atomicWriteText } from "./lib/atomic-write";
import { configuredTemplatesDir } from "./lib/skill-config";
import { MIGRATIONS, type Effects, type Migration } from "./lib/migrations";

class InvariantViolation extends Error { constructor(m: string) { super(`invariant violated: ${m}`); this.name = "InvariantViolation"; } }
function invariant(cond: unknown, msg: string): asserts cond { if (!cond) throw new InvariantViolation(msg); }

// ── versions ─────────────────────────────────────────────────────────

export function parseVersion(v: string): [number, number, number] | null {
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error(`not a three-level version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Ledger sanity: unique ids, valid versions, introducedIn never goes backwards in ledger order. */
export function assertLedger(ledger: readonly Migration[]): void {
  const ids = new Set<string>();
  ledger.forEach((m, i) => {
    invariant(!ids.has(m.id), `duplicate migration id ${m.id}`);
    ids.add(m.id);
    invariant(parseVersion(m.introducedIn), `migration ${m.id} has a bad introducedIn ${m.introducedIn}`);
    if (i > 0) invariant(compareVersions(ledger[i - 1].introducedIn, m.introducedIn) <= 0, `migration ${m.id} is out of version order`);
  });
}

// ── the record ───────────────────────────────────────────────────────

export interface AppliedEntry { id: string; appliedAt: string; fromVersion: string; backupDir: string | null; notes: string[] }
export interface MigrationRecord { schema: 1; pendingFrom?: string; applied: AppliedEntry[] }

export const recordPath = (userDir: string): string => join(userDir, "CONFIG", "migrations.json");

export function readRecord(userDir: string): MigrationRecord {
  const p = recordPath(userDir);
  if (!existsSync(p)) return { schema: 1, applied: [] };
  const v = JSON.parse(readFileSync(p, "utf8"));
  if (!v || typeof v !== "object" || !Array.isArray(v.applied)) throw new Error(`${p} is not a migration record (needs an "applied" array)`);
  if (v.pendingFrom !== undefined && (typeof v.pendingFrom !== "string" || !parseVersion(v.pendingFrom))) throw new Error(`${p}: pendingFrom must be a version`);
  return { schema: 1, ...(v.pendingFrom ? { pendingFrom: v.pendingFrom } : {}), applied: v.applied };
}

function writeRecord(userDir: string, rec: MigrationRecord): void {
  const ids = rec.applied.map((a) => a.id);
  invariant(new Set(ids).size === ids.length, "an applied migration id is recorded twice");
  invariant(rec.pendingFrom === undefined || parseVersion(rec.pendingFrom), `pendingFrom is not a version: ${rec.pendingFrom}`);
  atomicWriteJSON(recordPath(userDir), rec);
}

// ── from-version ─────────────────────────────────────────────────────

export interface FromVersion { version: string; source: "--from" | "pendingFrom" | "VERSION" | "none" }

export function resolveFromVersion(configRoot: string, rec: MigrationRecord, explicit?: string): FromVersion {
  if (explicit !== undefined) {
    if (!parseVersion(explicit)) throw new Error(`--from must be a three-level version, got ${explicit}`);
    return { version: explicit.replace(/^v/, ""), source: "--from" };
  }
  if (rec.pendingFrom) return { version: rec.pendingFrom, source: "pendingFrom" };
  const marker = join(configRoot, "LIFEOS", "VERSION");
  if (existsSync(marker)) {
    const v = readFileSync(marker, "utf8").trim();
    if (!parseVersion(v)) throw new Error(`${marker} does not hold a version: ${v.slice(0, 40)}`);
    return { version: v.replace(/^v/, ""), source: "VERSION" };
  }
  return { version: "0.0.0", source: "none" };
}

// ── effects ──────────────────────────────────────────────────────────

export interface Action { op: "write" | "retire"; path: string; backup: string | null }

/** Confine a USER-relative path to the real USER root (symlinks resolved before the boundary check). */
function confine(userReal: string, rel: string): string {
  invariant(!isAbsolute(rel) && !normalize(rel).split(sep).includes(".."), `migration path escapes USER: ${rel}`);
  const abs = join(userReal, rel);
  let probe = dirname(abs);
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  invariant(real === userReal || real.startsWith(userReal + sep), `migration path resolves outside USER: ${rel} → ${real}`);
  if (existsSync(abs)) {
    if (lstatSync(abs).isSymbolicLink()) throw new Error(`refusing to touch a symlink in USER: ${rel}`);
  }
  return abs;
}

function makeEffects(userReal: string, backupDir: string, apply: boolean, actions: Action[]): Effects {
  const backup = (rel: string, abs: string): string => {
    const dest = join(backupDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    invariant(readFileSync(dest).equals(readFileSync(abs)), `backup of ${rel} does not match the original`);
    return dest;
  };
  return {
    write(rel, content) {
      const abs = confine(userReal, rel);
      const exists = existsSync(abs);
      if (exists && readFileSync(abs, "utf8") === content) return;
      if (!apply) { actions.push({ op: "write", path: rel, backup: exists ? join(backupDir, rel) : null }); return; }
      const b = exists ? backup(rel, abs) : null;
      atomicWriteText(abs, content);
      actions.push({ op: "write", path: rel, backup: b });
    },
    retire(rel) {
      const abs = confine(userReal, rel);
      if (!existsSync(abs)) return;
      if (!apply) { actions.push({ op: "retire", path: rel, backup: join(backupDir, rel) }); return; }
      const b = backup(rel, abs);
      unlinkSync(abs);
      invariant(!existsSync(abs), `${rel} is still in USER after it was retired`);
      actions.push({ op: "retire", path: rel, backup: b });
    },
  };
}

// ── run ──────────────────────────────────────────────────────────────

export type EntryStatus = "applied" | "would-apply" | "noop" | "already-applied" | "not-needed" | "failed" | "not-run";
export interface EntryReport { id: string; introducedIn: string; title: string; status: EntryStatus; notes: string[]; actions: Action[]; error?: string }

export interface MigrateReport {
  ok: boolean;
  dryRun: boolean;
  userDir: string;
  from: FromVersion;
  backupDir: string | null;
  record: string;
  migrations: EntryReport[];
  error?: string;
}

export interface RunOpts {
  configRoot: string;
  userDir: string;
  templateDir: string | null;
  apply: boolean;
  from?: string;
  now?: Date;
  ledger?: readonly Migration[];
}

export function runMigrations(o: RunOpts): MigrateReport {
  const ledger = o.ledger ?? MIGRATIONS;
  assertLedger(ledger);
  invariant(existsSync(o.userDir), `no USER tree at ${o.userDir}`);
  const userReal = realpathSync(o.userDir);
  const now = o.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupDir = join(dirname(userReal), ".lifeos-migration-backups", stamp);
  const rec = readRecord(userReal);
  const from = resolveFromVersion(o.configRoot, rec, o.from);
  const report: MigrateReport = { ok: true, dryRun: !o.apply, userDir: userReal, from, backupDir: null, record: recordPath(userReal), migrations: [] };

  for (const m of ledger) {
    const base = { id: m.id, introducedIn: m.introducedIn, title: m.title, notes: [] as string[], actions: [] as Action[] };
    if (!report.ok) { report.migrations.push({ ...base, status: "not-run" }); continue; }
    if (rec.applied.some((a) => a.id === m.id)) { report.migrations.push({ ...base, status: "already-applied" }); continue; }
    if (compareVersions(m.introducedIn, from.version) <= 0) { report.migrations.push({ ...base, status: "not-needed" }); continue; }
    const actions: Action[] = [];
    try {
      const out = m.run({ userDir: userReal, templateDir: o.templateDir, now: now.toISOString(), effects: makeEffects(userReal, backupDir, o.apply, actions) });
      const changed = out.changed && actions.length > 0;
      const status: EntryStatus = !changed ? "noop" : o.apply ? "applied" : "would-apply";
      report.migrations.push({ ...base, status, notes: out.notes, actions });
      if (o.apply && changed) {
        if (actions.some((a) => a.backup)) report.backupDir = backupDir;
        rec.applied.push({ id: m.id, appliedAt: now.toISOString(), fromVersion: from.version, backupDir: actions.some((a) => a.backup) ? backupDir : null, notes: out.notes });
        writeRecord(userReal, rec);
      }
    } catch (e) {
      if (e instanceof InvariantViolation) throw e;
      report.ok = false;
      report.error = `migration ${m.id} failed: ${(e as Error).message}`;
      report.migrations.push({ ...base, status: "failed", actions, error: (e as Error).message });
    }
  }
  // The pre-upgrade version has done its job once every candidate ran clean.
  if (o.apply && report.ok && rec.pendingFrom !== undefined) {
    delete rec.pendingFrom;
    writeRecord(userReal, rec);
  }
  return report;
}

/** Remember the version an install had before an upgrade rewrites VERSION; an earlier remembered version wins. */
export function markFrom(userDir: string, version: string, apply: boolean): { ok: boolean; dryRun: boolean; pendingFrom: string; record: string } {
  if (!parseVersion(version)) throw new Error(`--mark-from must be a three-level version, got ${version}`);
  invariant(existsSync(userDir), `no USER tree at ${userDir}`);
  const userReal = realpathSync(userDir);
  const rec = readRecord(userReal);
  const v = version.replace(/^v/, "");
  const pendingFrom = rec.pendingFrom && compareVersions(rec.pendingFrom, v) <= 0 ? rec.pendingFrom : v;
  if (apply && rec.pendingFrom !== pendingFrom) writeRecord(userReal, { ...rec, pendingFrom });
  return { ok: true, dryRun: !apply, pendingFrom, record: recordPath(userReal) };
}

// ── CLI ──────────────────────────────────────────────────────────────

function arg(a: string[], flag: string): string | undefined {
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
}

/** The shipped USER template tree: --templates, else `pulse_templates_dir`, else the payload beside this tool. */
export function resolveTemplates(configRoot: string, home: string, explicit?: string): string | null {
  if (explicit) return resolve(explicit);
  const configured = configuredTemplatesDir(configRoot, home);
  if (configured && existsSync(configured.dir)) return configured.dir;
  const shipped = join(import.meta.dir, "..", "install", "USER");
  return existsSync(shipped) ? shipped : null;
}

function main(): void {
  const a = process.argv.slice(2);
  if (a.includes("--help") || a.includes("-h")) {
    console.log(readFileSync(join(import.meta.dir, "Migrate.help.md"), "utf8"));
    process.exit(0);
  }
  for (const f of ["--config-root", "--user-dir", "--templates", "--from", "--mark-from"]) {
    if (a.includes(f) && arg(a, f) === undefined) {
      console.log(JSON.stringify({ ok: false, error: `${f} needs a value` }, null, 2));
      process.exit(1);
    }
  }
  const home = process.env.HOME || homedir();
  const configRoot = resolve(arg(a, "--config-root") || claudeDirFor(process.env, home));
  const userDir = resolve(arg(a, "--user-dir") || join(configRoot, "LIFEOS", "USER"));
  const apply = a.includes("--apply") || a.includes("--yes");
  if (!existsSync(userDir)) {
    console.log(JSON.stringify({ ok: false, error: `no USER tree at ${userDir}` }, null, 2));
    process.exit(1);
  }
  if (apply) refuseDevInstallWrites(configRoot, [userDir], a.includes("--allow-dev"));
  try {
    const mark = arg(a, "--mark-from");
    if (mark !== undefined) {
      console.log(JSON.stringify(markFrom(userDir, mark, apply), null, 2));
      process.exit(0);
    }
    const report = runMigrations({ configRoot, userDir, templateDir: resolveTemplates(configRoot, home, arg(a, "--templates")), apply, from: arg(a, "--from") });
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: (e as Error).message }, null, 2));
    process.exit(e instanceof InvariantViolation ? 2 : 1);
  }
}

if (import.meta.main) main();
