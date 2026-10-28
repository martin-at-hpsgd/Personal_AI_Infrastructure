#!/usr/bin/env bun
/**
 * RenderIdentity — fill the identity placeholders across an installed LifeOS tree from the
 * install's own LIFEOS_CONFIG.toml, then verify the surfaces Doctor checks.
 *
 *   bun Tools/RenderIdentity.ts                          # dry run: what would be filled, nothing written
 *   bun Tools/RenderIdentity.ts --apply                  # render; scaffold names wait for the Interview
 *   bun Tools/RenderIdentity.ts --apply --strict         # render, and fail unless the identity is complete
 *
 * Why it exists (upgrade record 20261014-162518): identity substitution had no tool. Setup told the agent
 * to call `substituteTree` by hand, and it ran before the Interview had captured any names, so installs
 * either skipped it or baked the scaffold's "Aria"/"Your Name" into hooks and the system prompt, after
 * which the real names had no token left to fill.
 *
 * The contract:
 *  - Values come only from `OverlaySystem.resolveIdentityVars` (LIFEOS_CONFIG.toml + LIFEOS/VERSION).
 *  - A scaffold name is never rendered; it is reported as `pending`. InstallAll runs this before the
 *    Interview (pending names are expected there), and the Interview hand-off runs it again with
 *    `--strict` once the names are real.
 *  - It walks only LifeOS-owned roots, with the same directory skips as the Doctor's checker, so user
 *    transcripts (`projects/`), MEMORY and the redistribution payload are never touched.
 *  - Idempotent: a rendered token is gone, so a second run modifies nothing.
 *
 * Imports stay inside the skill: this runs from the install skill before hooks/ or LIFEOS/TOOLS exist.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { checkSurvivingPlaceholders, refuseDevInstallWrites, substituteTree, type TemplateVars } from "./InstallEngine";
import { resolveIdentityVars } from "./OverlaySystem";

class InvariantViolation extends Error { constructor(m: string) { super(`invariant violated: ${m}`); this.name = "InvariantViolation"; } }
function invariant(cond: unknown, msg: string): asserts cond { if (!cond) throw new InvariantViolation(msg); }

/** LifeOS-owned roots, relative to the config root. Everything else in the harness dir belongs to the user or the harness. */
export const RENDER_ROOTS: readonly string[] = ["CLAUDE.md", "settings.json", "hooks", "skills", "agents", "commands", "workflows", "LIFEOS"];

/**
 * The model-facing surfaces Doctor's `identity-placeholders` probe scans (LIFEOS/TOOLS/Doctor.ts). A test
 * holds the two lists in step, so a pass here is a pass there.
 */
export const MODEL_FACING_ROOTS: readonly string[] = [
  "hooks", "commands", "agents", "LIFEOS/ALGORITHM", "LIFEOS/LIFEOS_SYSTEM_PROMPT.md", "CLAUDE.md", "settings.json",
];

/** The prose forms substituteTree fills, keyed to the token whose value they take. */
const DOTTED_TO_TOKEN: Readonly<Record<string, string>> = {
  "{PRINCIPAL.NAME}": "{{PRINCIPAL_NAME}}", "{PRINCIPAL.FULL_NAME}": "{{PRINCIPAL_FULL_NAME}}",
  "{DA_IDENTITY.NAME}": "{{DA_NAME}}", "{DA_IDENTITY.FULL_NAME}": "{{DA_FULL_NAME}}",
  "{DA_IDENTITY.DISPLAY_NAME}": "{{DA_NAME}}", "{DA_IDENTITY.VOICEID}": "{{PRIMARY_VOICE_ID}}",
};

export interface Site { file: string; placeholder: string; count: number }

export interface RenderReport {
  ok: boolean;
  dryRun: boolean;
  strict: boolean;
  configRoot: string;
  configPath: string;
  /** Tokens that had a value this run (values are not echoed). */
  resolved: string[];
  /** Required tokens still on the scaffold names: the Interview has not captured them. */
  pending: string[];
  /** Required tokens with no value at all. */
  missing: string[];
  scanned: number;
  /** Files changed (or, in a dry run, files that would change). */
  modified: number;
  applied: number;
  /** Identity placeholders on the Doctor's surfaces after this run (predicted in a dry run). */
  survivors: { total: number; sites: Site[] };
  error?: string;
  next?: string;
}

export interface RenderOpts {
  configRoot: string;
  apply: boolean;
  strict: boolean;
  /** Override for LIFEOS_CONFIG.toml; default `<configRoot>/LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml`. */
  configPath?: string;
}

/** Identity placeholders currently on the Doctor's surfaces. */
export function modelFacingSurvivors(configRoot: string): { total: number; sites: Site[] } {
  const sites: Site[] = [];
  for (const rel of MODEL_FACING_ROOTS) {
    const p = join(configRoot, rel);
    if (!existsSync(p)) continue;
    sites.push(...checkSurvivingPlaceholders(p).files);
  }
  return { total: sites.reduce((n, s) => n + s.count, 0), sites };
}

/** True when a run with `vars` fills this placeholder ({{TIMEZONE}} always fills: substituteTree uses the machine's zone). */
export function fillable(placeholder: string, vars: TemplateVars): boolean {
  if (placeholder === "{{TIMEZONE}}") return true;
  const token = DOTTED_TO_TOKEN[placeholder] ?? placeholder;
  return typeof vars[token] === "string" && vars[token].length > 0;
}

export function renderIdentity(o: RenderOpts): RenderReport {
  invariant(isAbsolute(o.configRoot) && resolve(o.configRoot) !== "/", `config root must be an absolute, non-root path: ${o.configRoot}`);
  const configPath = o.configPath ?? join(o.configRoot, "LIFEOS", "USER", "CONFIG", "LIFEOS_CONFIG.toml");
  // The installed tree carries LIFEOS/VERSION, so the config root doubles as the version source.
  const ident = resolveIdentityVars(o.configRoot, o.configRoot, configPath);
  for (const [k, v] of Object.entries(ident.vars)) {
    invariant(/^\{\{[A-Z0-9_]+\}\}$/.test(k), `identity var key must be a braced token: ${k}`);
    invariant(v.length > 0, `identity var ${k} resolved to an empty value`);
  }

  let scanned = 0, modified = 0, applied = 0;
  for (const rel of RENDER_ROOTS) {
    const p = join(o.configRoot, rel);
    if (!existsSync(p)) continue;
    const r = substituteTree(p, ident.vars, { dryRun: !o.apply });
    scanned += r.scanned; modified += r.modified; applied += r.applied;
  }

  const current = modelFacingSurvivors(o.configRoot);
  const survivors = o.apply ? current : (() => {
    const sites = current.sites.filter((s) => !fillable(s.placeholder, ident.vars));
    return { total: sites.reduce((n, s) => n + s.count, 0), sites };
  })();

  const report: RenderReport = {
    ok: false, dryRun: !o.apply, strict: o.strict, configRoot: o.configRoot, configPath: ident.configPath,
    resolved: Object.keys(ident.vars).sort(), pending: ident.pending, missing: ident.missing,
    scanned, modified, applied, survivors: { total: survivors.total, sites: survivors.sites.slice(0, 25) },
  };

  if (ident.missing.length) {
    report.error = `no value for ${ident.missing.join(", ")} in ${ident.configPath}`;
    report.next = "the config is absent or incomplete: run ScaffoldUser, then the Interview, then this tool again";
  } else if (o.strict && ident.pending.length) {
    report.error = `${ident.pending.join(", ")} still carry the scaffold names in ${ident.configPath}`;
    report.next = "capture the real names in the Interview (written to LIFEOS_CONFIG.toml), then run this tool again with --apply --strict";
  } else if (o.strict && survivors.total > 0) {
    report.error = `${survivors.total} identity placeholder(s) remain on Doctor's surfaces, e.g. ${survivors.sites.slice(0, 3).map((s) => `${s.placeholder} in ${s.file}`).join("; ")}`;
    report.next = "set the missing value (a voice id lives in [da.voices.main] of LIFEOS_CONFIG.toml), then run this tool again";
  } else if (ident.pending.length) {
    report.next = "names are still the scaffold defaults: the Interview runs this tool again with --apply --strict once it has them";
  }
  if (!o.apply && !report.error) report.next = report.next ?? "dry run: re-run with --apply to write";
  report.ok = !report.error;
  return report;
}

// ── CLI ──────────────────────────────────────────────────────────────

function arg(a: string[], flag: string): string | undefined {
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
}

const KNOWN_FLAGS = new Set(["--config-root", "--config", "--apply", "--dry-run", "--strict", "--allow-dev", "--json", "--help", "-h"]);

export function parseArgs(a: string[], env: Record<string, string | undefined> = process.env, home: string = homedir()): (RenderOpts & { allowDev: boolean }) | { error: string } {
  for (const f of ["--config-root", "--config"]) if (a.includes(f) && arg(a, f) === undefined) return { error: `${f} needs a value` };
  const valued = new Set(["--config-root", "--config"]);
  for (let i = 0; i < a.length; i++) {
    if (valued.has(a[i]!)) { i++; continue; }
    if (!KNOWN_FLAGS.has(a[i]!)) return { error: `unknown argument: ${a[i]}` };
  }
  if (a.includes("--apply") && a.includes("--dry-run")) return { error: "--apply and --dry-run contradict each other" };
  const config = arg(a, "--config");
  return {
    configRoot: resolve(arg(a, "--config-root") || env.CLAUDE_CONFIG_DIR || join(env.HOME || home, ".claude")),
    apply: a.includes("--apply"),
    strict: a.includes("--strict"),
    ...(config ? { configPath: resolve(config) } : {}),
    allowDev: a.includes("--allow-dev"),
  };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  if (a.includes("--help") || a.includes("-h")) {
    console.log(readFileSync(join(import.meta.dir, "RenderIdentity.help.md"), "utf8"));
    process.exit(0);
  }
  const parsed = parseArgs(a);
  if ("error" in parsed) {
    console.log(JSON.stringify({ ok: false, error: parsed.error }, null, 2));
    process.exit(64);
  }
  if (parsed.apply) {
    refuseDevInstallWrites(parsed.configRoot, RENDER_ROOTS.map((r) => join(parsed.configRoot, r)), parsed.allowDev);
  }
  const report = renderIdentity(parsed);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
