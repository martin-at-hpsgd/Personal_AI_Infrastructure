#!/usr/bin/env bun
/**
 * Config.ts — loads the Dotfiles config for every intent.
 *
 *   DOTFILES_ENV="$(bun ~/.claude/skills/Dotfiles/Tools/Config.ts)" || exit 1; eval "$DOTFILES_ENV"   # export the keys into the shell
 *   (`eval "$(…)" || exit 1` would not stop: eval of empty output returns 0, so the assignment carries the status)
 *   bun ~/.claude/skills/Dotfiles/Tools/Config.ts --check              # human-readable check, exit 0 or 1
 *
 * Reads the Keys table of `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Dotfiles/Config.md`
 * (rows shaped | `KEY` | `value` | notes |). An environment variable of the same name wins over the
 * file. There are NO built-in defaults: a missing file or a missing required key prints what is
 * wrong, points at Setup.md and exits 1 (so `|| exit 1` in the caller stops the intent).
 *
 * Required keys: DOTFILES_DIR, DOTFILES_BACKUPS, DOTFILES_REPO, DOTFILES_CONFIG_DIRS.
 * Derived when absent: DOTFILES_REPO_SLUG (the owner/name tail of DOTFILES_REPO).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";

const HOME = process.env.HOME ?? homedir();
const CONFIG_ROOT = getClaudeDir();
const CONFIG_MD = `${CONFIG_ROOT}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Dotfiles/Config.md`;
const SETUP = "skills/Dotfiles/Setup.md";
const REQUIRED = ["DOTFILES_DIR", "DOTFILES_BACKUPS", "DOTFILES_REPO", "DOTFILES_CONFIG_DIRS"] as const;

function fail(msg: string): never {
  console.error(`Dotfiles config: ${msg}\nSee ${SETUP} to set it up.`);
  process.exit(1);
}

function expand(v: string): string {
  return v.replace(/^~(?=\/|$)/, HOME).replace(/\$HOME\b|\$\{HOME\}/g, HOME);
}

function shq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function load(): Record<string, string> {
  if (!existsSync(CONFIG_MD)) fail(`missing config file ${CONFIG_MD}`);
  const keys = new Map<string, string>();
  for (const line of readFileSync(CONFIG_MD, "utf8").split("\n")) {
    const m = line.match(/^\|\s*`(DOTFILES_[A-Z_]+)`\s*\|\s*`([^`]*)`\s*\|/);
    if (m) keys.set(m[1], m[2]);
  }
  const out: Record<string, string> = {};
  for (const k of [...REQUIRED, "DOTFILES_REPO_SLUG"]) {
    const v = process.env[k] || keys.get(k);
    if (v) out[k] = k === "DOTFILES_DIR" || k === "DOTFILES_BACKUPS" ? expand(v) : v;
  }
  const missing = REQUIRED.filter((k) => !out[k]);
  if (missing.length) fail(`${CONFIG_MD} has no value for: ${missing.join(", ")}`);
  if (!out.DOTFILES_REPO_SLUG) {
    const slug = out.DOTFILES_REPO.replace(/\.git$/, "").match(/[:/]([^/:]+\/[^/:]+)$/)?.[1];
    if (!slug) fail(`cannot derive DOTFILES_REPO_SLUG from DOTFILES_REPO "${out.DOTFILES_REPO}"; set it in ${CONFIG_MD}`);
    out.DOTFILES_REPO_SLUG = slug;
  }
  for (const d of out.DOTFILES_CONFIG_DIRS.split(/\s+/).filter(Boolean)) {
    if (d === "." || d === ".." || !/^[A-Za-z0-9._-]+$/.test(d)) fail(`DOTFILES_CONFIG_DIRS entry "${d}" must be a bare directory name under ~/.config`);
  }
  return out;
}

const cfg = load();
if (process.argv.includes("--check")) {
  for (const [k, v] of Object.entries(cfg)) console.log(`${k}=${v}`);
  console.log(`OK: config loaded from ${CONFIG_MD}`);
} else {
  for (const [k, v] of Object.entries(cfg)) console.log(`export ${k}=${shq(v)}`);
}
