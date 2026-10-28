#!/usr/bin/env bun
/**
 * @version 1.4.15
 * DocCheck.ts — Documentation integrity verifier
 *
 * Extracts path references from markdown docs, verifies they exist on disk,
 * and checks freshness (is the referenced file newer than the doc?).
 *
 * Replaces: DocumentationUpdate mapping table, DocCrossRefIntegrity (31KB + LLM),
 * IntegrityCheck + SystemIntegrity handlers.
 *
 * Usage:
 *   bun DocCheck.ts              # full scan of all LifeOS docs
 *   bun DocCheck.ts --changed    # incremental — only git-dirty files and their dependents
 *   bun DocCheck.ts --json       # machine-readable output
 *   bun DocCheck.ts --quiet      # only report issues, no OK lines
 */

import { readFileSync, statSync, existsSync, readdirSync } from 'fs';
import { join, resolve, dirname, relative } from 'path';
import { execFileSync } from 'child_process';
import { homedir } from "node:os";
import { getClaudeDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const CLAUDE_DIR = getClaudeDir();
const LIFEOS_DIR = join(CLAUDE_DIR, 'LIFEOS');
const HOOKS_DIR = join(CLAUDE_DIR, 'hooks');

const args = process.argv.slice(2);
const changedOnly = args.includes('--changed');
const jsonOutput = args.includes('--json');
const quiet = args.includes('--quiet');

// ── Path Reference Extraction ──

// The tree is LIFEOS/, case-sensitive; the LifeOS/ alternation alone matched
// nothing, so backticked LIFEOS/ refs and every @-import went unchecked. Both
// casings stay: a legacy LifeOS/ ref is itself broken and should be reported.
// public PR #2198 (issue #2191), @Bowlerjim
const PATH_PATTERNS = [
  // Backtick-quoted paths, e.g. `LIFEOS/DOCUMENTATION/Hooks/HookSystem.md` or `hooks/StopGates.hook.ts`
  /`((?:LIFEOS|LifeOS|hooks|skills|agents|Pulse|USER|MEMORY|Components|Algorithm|Tools)\/[\w/.@-]+\.\w+)`/g,
  // Backtick-quoted paths with ~/.claude/ prefix
  /`~\/\.claude\/([\w/.@-]+\.\w+)`/g,
  // Backtick-quoted paths with $HOME/.claude/ prefix
  /`\$HOME\/\.claude\/([\w/.@-]+\.\w+)`/g,
  // @-imports: @LIFEOS/USER/FILE.md
  /^@((?:LIFEOS|LifeOS)\/[\w/.@-]+\.md)/gm,
  // Table cell paths: | `path` | or | path |
  /\|\s*`?((?:LIFEOS|LifeOS|hooks|skills|Pulse|USER)\/[\w/.@-]+\.\w+)`?\s*\|/g,
  // Arrow notation in TOPOLOGY.md: → file: `path`
  /→\s+[\w\s]+:\s+`([\w/.@-]+\.\w+)`/g,
];

interface PathRef {
  raw: string;       // matched text
  resolved: string;  // absolute path
  line: number;
}

// Parse `## ... (paths under `X`)` headings and build a sorted list of
// `[startCharPos, sectionRoot]` pairs. The default root applies before any
// heading is seen. Mirrors the section-awareness logic in
// LIFEOS/TOOLS/ArchitectureSummaryGenerator.ts and LIFEOS/TOOLS/ReferenceCheck.ts
// so all three tools agree on what a relative path under a routing section
// means.
function extractSectionRoots(content: string): Array<{ pos: number; root: string }> {
  const out: Array<{ pos: number; root: string }> = [{ pos: 0, root: '' }];
  const headingPathHint = /paths under\s+`?([A-Za-z_/.0-9-]+?)`?(?:\s|\)|$)/;
  const lines = content.split('\n');
  let pos = 0;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      const hint = h2[1].match(headingPathHint);
      if (hint) {
        let root = hint[1];
        if (!root.endsWith('/')) root += '/';
        out.push({ pos, root });
      } else {
        out.push({ pos, root: '' });
      }
    }
    pos += line.length + 1;
  }
  return out;
}

function getSectionRootAt(roots: Array<{ pos: number; root: string }>, charPos: number): string {
  let active = '';
  for (const r of roots) {
    if (r.pos <= charPos) active = r.root;
    else break;
  }
  return active;
}

function extractPathRefs(content: string, docPath: string): PathRef[] {
  const refs: PathRef[] = [];
  const seen = new Set<string>();
  const sectionRoots = extractSectionRoots(content);
  const refDir = dirname(docPath);

  for (const pattern of PATH_PATTERNS) {
    // Reset regex state
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const raw = match[1];
      if (!raw || seen.has(raw)) continue;
      seen.add(raw);

      // Skip vX.Y.Z placeholder strings
      if (raw.includes('vX.Y.Z')) continue;

      // Resolve path — try ~/.claude/ first, then ~/.claude/LIFEOS/, then
      // section-aware root from `## ... (paths under `X`)` heading hint, then
      // referrer-dir relative.
      let resolved = resolve(CLAUDE_DIR, raw);
      if (!existsSync(resolved)) {
        const lifeosResolved = resolve(LIFEOS_DIR, raw);
        if (existsSync(lifeosResolved)) {
          resolved = lifeosResolved;
        } else {
          const sectionRoot = getSectionRootAt(sectionRoots, match.index);
          if (sectionRoot) {
            const sectionResolved = resolve(CLAUDE_DIR, sectionRoot, raw);
            if (existsSync(sectionResolved)) resolved = sectionResolved;
          }
          if (!existsSync(resolved)) {
            const refDirResolved = resolve(refDir, raw);
            if (existsSync(refDirResolved)) resolved = refDirResolved;
          }
        }
      }

      // Find line number
      const pos = match.index;
      const lineNum = content.substring(0, pos).split('\n').length;

      refs.push({ raw, resolved, line: lineNum });
    }
  }

  return refs;
}

// ── File Discovery ──

/**
 * Everything that stopped a check from running. A non-empty list means "all
 * references valid" can no longer be claimed, and the exit code says so.
 */
const incomplete: string[] = [];

/** List a directory. ENOENT on an optional dir is a legitimate absence; any other failure removes checks and is recorded. */
function listDir(dir: string, optional: boolean): string[] {
  try {
    return readdirSync(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (!(optional && code === 'ENOENT')) {
      incomplete.push(`cannot list ${relative(CLAUDE_DIR, dir) || dir}: ${code ?? (e as Error).message}`);
    }
    return [];
  }
}

function findDocs(): string[] {
  const docs: string[] = [];

  // LifeOS system docs (LIFEOS_SYSTEM_PROMPT.md still lives at LifeOS root)
  for (const f of listDir(LIFEOS_DIR, false)) {
    if (f.endsWith('.md')) docs.push(join(LIFEOS_DIR, f));
  }

  // LifeOS documentation subsystem docs (relocated from LifeOS root in v5)
  const docsDir = join(LIFEOS_DIR, 'DOCUMENTATION');
  for (const f of listDir(docsDir, true)) {
    if (f.endsWith('.md')) docs.push(join(docsDir, f));
  }

  // Security docs
  const secDir = join(LIFEOS_DIR, 'USER', 'SECURITY');
  for (const f of listDir(secDir, true)) {
    // ported from public PR #1741, @elhoim — `.yml` is as valid a YAML suffix as `.yaml`
    if (f.endsWith('.md') || f.endsWith('.yaml') || f.endsWith('.yml')) docs.push(join(secDir, f));
  }

  // hooks README
  const hooksReadme = join(HOOKS_DIR, 'README.md');
  if (existsSync(hooksReadme)) docs.push(hooksReadme);

  // CLAUDE.md
  const claudeMd = join(CLAUDE_DIR, 'CLAUDE.md');
  if (existsSync(claudeMd)) docs.push(claudeMd);

  return docs;
}

/**
 * Git-dirty files, or null when git could not answer. null is NOT "nothing
 * changed": the caller falls back to a full scan and records the gap.
 */
function getChangedFiles(): Set<string> | null {
  try {
    const out: string[] = [];
    for (const gitArgs of [['diff', '--name-only', 'HEAD'], ['diff', '--cached', '--name-only']]) {
      out.push(execFileSync('git', gitArgs, { cwd: CLAUDE_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }));
    }
    return new Set(out.join('\n').split('\n').filter(Boolean).map(f => resolve(CLAUDE_DIR, f)));
  } catch (e) {
    incomplete.push(`--changed: git could not list changed files (${(e as Error).message.split('\n')[0]}); scanned every doc instead`);
    return null;
  }
}

// ── Main ──

interface Finding {
  doc: string;
  ref: string;
  line: number;
  type: 'missing' | 'stale';
  detail?: string;
}

const findings: Finding[] = [];
let docsChecked = 0;
let refsChecked = 0;

const changedFiles = changedOnly ? getChangedFiles() : null;
const allDocs = findDocs();

// If --changed, filter to docs that changed OR docs whose dependencies changed
const docsToCheck = changedFiles
  ? allDocs.filter(doc => {
      if (changedFiles.has(doc)) return true;
      // Also check docs whose referenced files changed
      try {
        const content = readFileSync(doc, 'utf-8');
        const refs = extractPathRefs(content, doc);
        return refs.some(r => changedFiles.has(r.resolved));
      } catch { return true; } // unreadable: keep it so the main loop reports the failure
    })
  : allDocs;

for (const docPath of docsToCheck) {
  docsChecked++;
  let content: string;
  try {
    content = readFileSync(docPath, 'utf-8');
  } catch (e) {
    incomplete.push(`cannot read ${relative(CLAUDE_DIR, docPath)}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    continue;
  }

  const refs = extractPathRefs(content, docPath);
  let docMtime: number;
  try {
    docMtime = statSync(docPath).mtimeMs;
  } catch (e) {
    incomplete.push(`cannot stat ${relative(CLAUDE_DIR, docPath)}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    continue;
  }

  for (const ref of refs) {
    refsChecked++;

    // Check existence
    if (!existsSync(ref.resolved)) {
      findings.push({
        doc: relative(CLAUDE_DIR, docPath),
        ref: ref.raw,
        line: ref.line,
        type: 'missing',
      });
      continue;
    }

    // Check freshness — is the referenced file newer than the doc?
    try {
      const refMtime = statSync(ref.resolved).mtimeMs;
      if (refMtime > docMtime) {
        const daysStale = Math.round((refMtime - docMtime) / (1000 * 60 * 60 * 24));
        findings.push({
          doc: relative(CLAUDE_DIR, docPath),
          ref: ref.raw,
          line: ref.line,
          type: 'stale',
          detail: `ref modified ${daysStale}d after doc`,
        });
      }
    } catch (e) {
      incomplete.push(`cannot stat ${ref.raw} (referenced from ${relative(CLAUDE_DIR, docPath)}:${ref.line}): ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }
}

// ── Output ──

if (jsonOutput) {
  console.log(JSON.stringify({ docsChecked, refsChecked, findings, incomplete }, null, 2));
} else {
  const missing = findings.filter(f => f.type === 'missing');
  const stale = findings.filter(f => f.type === 'stale');

  if (missing.length > 0) {
    console.error(`\n❌ MISSING REFERENCES (${missing.length}):`);
    for (const f of missing) {
      console.error(`  ${f.doc}:${f.line} → ${f.ref}`);
    }
  }

  if (stale.length > 0) {
    console.error(`\n⚠️  STALE DOCS (${stale.length}):`);
    for (const f of stale) {
      console.error(`  ${f.doc}:${f.line} → ${f.ref} (${f.detail})`);
    }
  }

  if (!quiet || findings.length > 0) {
    console.error(`\nDocCheck: ${docsChecked} docs, ${refsChecked} refs, ${missing.length} missing, ${stale.length} stale`);
  }

  if (incomplete.length > 0) {
    console.error(`\n🚫 INCOMPLETE CHECK (${incomplete.length}) — some references could not be inspected:`);
    for (const m of incomplete) console.error(`  ${m}`);
  }

  if (findings.length === 0 && incomplete.length === 0 && !quiet) {
    console.error('✅ All references valid and fresh.');
  }
}

// 1 = a reference is missing; 2 = nothing proven missing but some checks could not run.
process.exit(findings.filter(f => f.type === 'missing').length > 0 ? 1 : incomplete.length > 0 ? 2 : 0);
