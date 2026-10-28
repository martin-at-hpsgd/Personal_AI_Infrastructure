#!/usr/bin/env bun
/**
 * @version 1.7.17
 */
// Normalize env path vars Claude Code may inject unexpanded — literal $HOME/${HOME}
// in LIFEOS_DIR/LIFEOS_CONFIG_DIR/PROJECTS_DIR resolves to a shadow dir (#1404 / PR #1451, author jbmml).
for (const __k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const __v = process.env[__k];
  if (__v && /^\$\{?HOME\}?(\/|$)/.test(__v)) process.env[__k] = __v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}


/**
 * GetCounts.ts - Single Source of Truth for LifeOS System Counts
 *
 * PURPOSE:
 * Provides deterministic, consistent counts for LifeOS system metrics.
 * Both Banner.ts and LIFEOS_StatusLine.sh MUST use this tool to ensure
 * the same numbers are displayed everywhere.
 *
 * COUNTING METHODOLOGY:
 * - Skills: Directories in skills/ that contain a SKILL.md file
 * - Intents: .md files in any skill Intents/ directory (recursive)
 * - Hooks: unique commands registered in settings.json hooks.<event>[].hooks[].command (active only)
 * - Signals: .md files in MEMORY/LEARNING/ (recursive)
 * - Files: All files in LIFEOS/USER/ (recursive)
 * - Work: Directories in MEMORY/WORK/ (depth 1)
 * - Research: .md and .json files in MEMORY/RESEARCH/ (recursive)
 *
 * USAGE:
 *   bun run GetCounts.ts           # JSON output
 *   bun run GetCounts.ts --shell   # Shell-sourceable output
 *   bun run GetCounts.ts --single skills  # Single value output
 *
 * OUTPUT (JSON):
 *   {"skills":65,"intents":339,"hooks":18,"signals":3819,"files":172}
 *
 * OUTPUT (--shell):
 *   skills_count=65
 *   intents_count=339
 *   hooks_count=18
 *   signals_count=3819
 *   files_count=172
 */

import { readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "node:os";
import { getClaudeDir, getLifeosDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

// Normalize env path vars that Claude Code injects without shell expansion (LifeOS#1404)
for (const k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const v = process.env[k];
  if (v && /^\$\{?HOME\}?(\/|$)/.test(v)) process.env[k] = v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}


const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const CLAUDE_DIR = getClaudeDir();
// skills/, hooks/, settings.json live under CLAUDE_DIR.
// MEMORY/, USER/ live under LIFEOS_DIR (which is CLAUDE_DIR/LIFEOS).
const LIFEOS_DIR = getLifeosDir(); // resolver owns CLAUDE_CONFIG_DIR > LIFEOS_DIR precedence (public issue #1968)

interface Counts {
  skills: number;
  intents: number;
  hooks: number;
  signals: number;
  files: number;
  work: number;
  research: number;
}

/**
 * Count files matching criteria recursively
 */
function countFilesRecursive(dir: string, extension?: string): number {
  let count = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        count += countFilesRecursive(fullPath, extension);
      } else if (entry.isFile()) {
        if (!extension || entry.name.endsWith(extension)) {
          count++;
        }
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }
  return count;
}

/**
 * Count .md files inside any skill Intents directory
 */
function countIntentFiles(dir: string): number {
  let count = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === 'intents' && !dir.endsWith('/skills')) {
          // Found an Intents directory - count all .md files inside
          count += countFilesRecursive(fullPath, '.md');
        } else {
          // Recurse into subdirectories to find more Intents dirs
          count += countIntentFiles(fullPath);
        }
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }
  return count;
}

/**
 * Count skills (directories with SKILL.md file)
 */
function countSkills(): number {
  let count = 0;
  const skillsDir = join(CLAUDE_DIR, "skills");
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      // Handle both real directories and symlinks to directories
      const isDir = entry.isDirectory() ||
        (entry.isSymbolicLink() && statSync(join(skillsDir, entry.name)).isDirectory());
      if (isDir) {
        const skillFile = join(skillsDir, entry.name, "SKILL.md");
        if (existsSync(skillFile)) {
          count++;
        }
      }
    }
  } catch {
    // skills directory doesn't exist
  }
  return count;
}

/**
 * Count active hooks: unique commands registered under `hooks.<event>[].hooks[].command`
 * in settings.json. Dormant hook files on disk that aren't wired to any event do NOT
 * count — only what Claude Code will actually fire.
 */
function countHooks(): number {
  const settingsPath = join(getClaudeDir(), "settings.json");
  try {
    const fs = require('fs');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const events = settings.hooks ?? {};
    const unique = new Set<string>();
    for (const matchers of Object.values(events)) {
      if (!Array.isArray(matchers)) continue;
      for (const matcher of matchers) {
        const list = (matcher as { hooks?: unknown }).hooks;
        if (!Array.isArray(list)) continue;
        for (const h of list) {
          const cmd = (h as { command?: unknown }).command;
          if (typeof cmd === 'string' && cmd.length > 0) unique.add(cmd);
        }
      }
    }
    return unique.size;
  } catch {
    return 0;
  }
}

// Per-key computation. Each function is invoked only when its key is requested.
// In --single mode we run exactly one; in --shell / default mode we run all.
function countWork(): number {
  let count = 0;
  try {
    for (const entry of readdirSync(join(LIFEOS_DIR, "MEMORY/WORK"), { withFileTypes: true })) {
      if (entry.isDirectory()) count++;
    }
  } catch {}
  return count;
}

const COMPUTERS: Record<keyof Counts, () => number> = {
  skills: countSkills,
  intents: () => countIntentFiles(join(CLAUDE_DIR, "skills")),
  hooks: countHooks,
  signals: () => countFilesRecursive(join(LIFEOS_DIR, "MEMORY/LEARNING"), ".md"),
  files: () => countFilesRecursive(join(LIFEOS_DIR, "USER")),
  work: countWork,
  research: () => countFilesRecursive(join(LIFEOS_DIR, "MEMORY/RESEARCH"), ".md") +
                  countFilesRecursive(join(LIFEOS_DIR, "MEMORY/RESEARCH"), ".json"),
};

function getCounts(only?: keyof Counts): Counts {
  const out: Counts = { skills: 0, intents: 0, hooks: 0, signals: 0, files: 0, work: 0, research: 0 };
  if (only) {
    out[only] = COMPUTERS[only]();
  } else {
    for (const k of Object.keys(COMPUTERS) as Array<keyof Counts>) {
      out[k] = COMPUTERS[k]();
    }
  }
  return out;
}

// CLI handling
const args = process.argv.slice(2);
const shellMode = args.includes('--shell');
const singleArg = args.find(a => a.startsWith('--single'));
// `workflows` and `procedures` are the older keys; they still answer with the intent count.
const singleKeyRaw = singleArg ? args[args.indexOf(singleArg) + 1] : null;
const singleKey = (singleKeyRaw === "workflows" || singleKeyRaw === "procedures") ? "intents" : singleKeyRaw;

const validSingle = singleKey && singleKey in COMPUTERS ? (singleKey as keyof Counts) : undefined;
const counts = getCounts(validSingle);

if (singleKey && singleKey in counts) {
  // Output just the single value (for use in shell scripts)
  console.log(counts[singleKey as keyof Counts]);
} else if (shellMode) {
  // Output as shell-sourceable variables
  console.log(`skills_count=${counts.skills}`);
  console.log(`intents_count=${counts.intents}`);
  console.log(`hooks_count=${counts.hooks}`);
  console.log(`signals_count=${counts.signals}`);
  console.log(`files_count=${counts.files}`);
  console.log(`work_count=${counts.work}`);
  console.log(`research_count=${counts.research}`);
} else {
  // JSON output (default)
  console.log(JSON.stringify(counts));
}
