#!/usr/bin/env bun
/**
 * AuditProvenance — do the USER copies of the release templates say whether they are still the template?
 *
 * Every `*.md` under the template tree that carries `provenance: template` is a file LifeOS ships as a
 * starter. Its copy under `LIFEOS/USER/` (same relative path) should say `provenance: template` while it
 * is untouched and `provenance: customized` once the principal has written into it; MarkCustomized.ts and
 * TelosFreshness.stampContextWrite flip the first to the second. A copy with no stamp, or another value,
 * reads as customized (it never ships) and is reported as unstamped.
 *
 * Until 2026-10-14 the source list came from the Pulse Data Plane page manifests; the Data Plane is
 * retired, so the release template tree is the source list now.
 *
 * Usage:
 *   bun AuditProvenance.ts --templates <dir> [--user <dir>] [-v|--verbose] [--strict]
 *
 *   --templates  the USER template tree (required)
 *   --user       the USER tree to audit (default: LIFEOS/USER beside this tool's LIFEOS tree)
 *   --strict     an unstamped copy is an issue and fails the run
 *
 * Exit 0 when no issue was found, 1 when one was, 2 on bad arguments.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { getProvenance } from "../lib/frontmatter";

export type Stamp = "template" | "customized" | "unknown";
export interface ProvenanceRow { rel: string; userPath: string; stamp: Stamp }

/** Relative paths of every `*.md` under `dir` whose own frontmatter says `provenance: template`. */
export function templateSources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".md") && getProvenance(full) === "template") out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

/** The stamp on each USER copy that exists; templates with no USER copy are not this audit's concern. */
export function auditProvenance(templatesDir: string, userDir: string): ProvenanceRow[] {
  return templateSources(templatesDir)
    .map((rel) => ({ rel, userPath: join(userDir, rel) }))
    .filter((r) => existsSync(r.userPath) && statSync(r.userPath).isFile())
    .map((r) => ({ ...r, stamp: getProvenance(r.userPath) }));
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const strict = args.includes("--strict");
  const templates = argValue(args, "--templates");
  const user = resolve(argValue(args, "--user") ?? join(import.meta.dir, "..", "..", "USER"));

  if (!templates || !existsSync(templates) || !statSync(templates).isDirectory()) {
    console.error(`error: --templates <dir> must name an existing template tree (got ${templates ?? "nothing"})`);
    process.exit(2);
  }
  if (!existsSync(user) || !statSync(user).isDirectory()) {
    console.error(`error: USER tree ${user} does not exist`);
    process.exit(2);
  }

  const rows = auditProvenance(resolve(templates), user);
  console.log(`Auditing provenance of the USER copies of release templates in ${resolve(templates)}…\n`);
  if (verbose) for (const r of rows) console.log(`  ${r.stamp.padEnd(11)} ${r.userPath}`);

  const unstamped = rows.filter((r) => r.stamp === "unknown");
  console.log(`\nScanned ${rows.length} unique source file(s).`);
  if (!strict || unstamped.length === 0) {
    console.log(`✓ every copy reads as template or customized (${unstamped.length} unstamped, read as customized)`);
    process.exit(0);
  }
  console.error(`\n✗ ${unstamped.length} issue(s):`);
  for (const r of unstamped) console.error(`  ${r.userPath} → no \`provenance: template|customized\` frontmatter`);
  process.exit(1);
}

if (import.meta.main) main();
