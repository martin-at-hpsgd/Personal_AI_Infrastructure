#!/usr/bin/env bun
/**
 * InstallSettings — Setup step 4's settings placement, as a deterministic tool.
 * Places the payload's `install/settings.system.json` into the harness
 * `settings.json` with the one transform the copy-by-hand step kept getting
 * wrong: **`env` values are expanded at write time** (`$HOME`/`${HOME}`/`~` →
 * the real home, and a leading `$HOME/.claude` → the actual config root, so
 * `--config-root` moves LIFEOS_DIR with the settings). The harness injects env values verbatim with NO shell
 * expansion (LifeOS#1404/#1451) — a literal `"$HOME/..."` value creates a real
 * `$HOME/` directory on disk that silently captures runtime state. Command
 * strings (hooks, statusLine) are shell-evaluated and ship untouched.
 *
 * It also places `install/CLAUDE.template.md` → `CLAUDE.md` when no CLAUDE.md
 * exists (an existing one is never touched; its merge stays a Setup decision).
 * This was a hand copy in Setup step 4, and ActivateImports exits 1 when it is
 * skipped (fresh-VM install of RC 8.5.0, 2026-10-09).
 *
 * Semantics match the sibling installers (DeployCore/InstallHooks):
 *   - settings.json absent → write the expanded template whole.
 *   - settings.json present → additive merge: only ABSENT top-level keys and
 *     ABSENT env keys are added (expanded); existing values are never touched.
 *   - Dry-run by default; `--apply` mutates; backup before every write.
 *   - REFUSES the author's live source tree (`--allow-dev` to override).
 *
 * Usage:
 *   bun InstallSettings.ts [--config-root <dir>] [--skill-root <dir>] [--apply] [--allow-dev]
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { atomicWriteText } from "./lib/atomic-write";
import { join } from "node:path";
import { homedir } from "node:os";
import { refuseDevInstallWrites } from "./InstallEngine";
import { expandEnvValue, expandLeadingHome } from "./lib/env-expand";
import { EXEC_ALLOW_ENTRY } from "./lib/exec-allow";

export { expandLeadingHome };

interface Args { configRoot: string; skillRoot: string; apply: boolean; allowDev: boolean; }

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
  };
  const home = process.env.HOME || homedir(); // public issue #1729, @umair-a11y
  return {
    configRoot: get("--config-root") || process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    skillRoot: get("--skill-root") || join(import.meta.dir, ".."),
    apply: a.includes("--apply"),
    allowDev: a.includes("--allow-dev"),
  };
}

function expandEnvBlock(settings: Record<string, unknown>, home: string, configRoot: string): number {
  const env = settings.env;
  if (!env || typeof env !== "object") return 0;
  let n = 0;
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v === "string") {
      const expanded = expandEnvValue(v, home, configRoot);
      if (expanded !== v) { (env as Record<string, unknown>)[k] = expanded; n++; }
    }
  }
  return n;
}

const args = parseArgs();
const home = process.env.HOME || homedir(); // public issue #1729, @umair-a11y
const templatePath = join(args.skillRoot, "install", "settings.system.json");
const targetPath = join(args.configRoot, "settings.json");

refuseDevInstallWrites(args.configRoot, [targetPath, join(args.configRoot, "CLAUDE.md")], args.allowDev);
if (!existsSync(templatePath)) {
  console.log(JSON.stringify({ ok: false, error: `payload settings.system.json not found at ${templatePath}` }, null, 2));
  process.exit(1);
}

const template = JSON.parse(readFileSync(templatePath, "utf8")) as Record<string, unknown>;
const expandedCount = expandEnvBlock(template, home, args.configRoot);

const report: Record<string, unknown> = { ok: true, apply: args.apply, target: targetPath, envValuesExpanded: expandedCount };

if (!existsSync(targetPath)) {
  report.mode = "create";
  report.topLevelKeys = Object.keys(template).length;
  // Atomic — never leave a half-written settings.json (public PR #1643, @elhoim)
  if (args.apply) atomicWriteText(targetPath, JSON.stringify(template, null, 2) + "\n");
} else {
  const current = JSON.parse(readFileSync(targetPath, "utf8")) as Record<string, unknown>;
  const addedKeys: string[] = [];
  for (const [k, v] of Object.entries(template)) {
    if (k === "env") continue;               // handled per-key below
    if (!(k in current)) { current[k] = v; addedKeys.push(k); }
  }
  const curEnv = (current.env && typeof current.env === "object" ? current.env : (current.env = {})) as Record<string, unknown>;
  const tplEnv = (template.env || {}) as Record<string, unknown>;
  const addedEnv: string[] = [];
  for (const [k, v] of Object.entries(tplEnv)) {
    if (!(k in curEnv)) { curEnv[k] = v; addedEnv.push(k); }
  }
  report.mode = "merge";
  const allow = (current.permissions as { allow?: unknown } | undefined)?.allow;
  const preApproved = Array.isArray(allow) ? allow.filter((e): e is string => typeof e === "string" && EXEC_ALLOW_ENTRY.test(e)) : [];
  if (preApproved.length) {
    report.preApprovedExecEntries = preApproved;
    report.execEntriesNote = "settings.json already pre-approves commands that run arbitrary code; this release does not ship them. Left unchanged: ask the user whether to remove them.";
  }
  report.addedKeys = addedKeys;
  report.addedEnv = addedEnv;
  if (args.apply && (addedKeys.length || addedEnv.length)) {
    copyFileSync(targetPath, targetPath + ".backup-" + new Date().toISOString().replace(/[:.]/g, "-"));
    atomicWriteText(targetPath, JSON.stringify(current, null, 2) + "\n");
  } else if (args.apply) {
    report.note = "nothing to add — no write, no backup";
  }
}

const claudeTemplate = join(args.skillRoot, "install", "CLAUDE.template.md");
const claudeTarget = join(args.configRoot, "CLAUDE.md");
if (existsSync(claudeTarget)) {
  report.claudeMd = "kept-existing";
} else if (!existsSync(claudeTemplate)) {
  report.ok = false;
  report.claudeMd = `payload CLAUDE.template.md not found at ${claudeTemplate}`;
} else {
  report.claudeMd = args.apply ? "created" : "would-create";
  if (args.apply) atomicWriteText(claudeTarget, readFileSync(claudeTemplate, "utf8"));
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
