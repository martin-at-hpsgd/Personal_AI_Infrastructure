/**
 * DocCrossRefIntegrity.ts - Hybrid doc integrity checker (deterministic + inference)
 *
 * Two-layer approach:
 * Layer 1 (Deterministic): Grep-based pattern checks for broken refs, counts, timestamps
 * Layer 2 (Inference): AI analysis of semantic drift using TOOLS/Inference.ts medium tier
 *
 * The deterministic layer detects WHAT changed. The inference layer understands
 * HOW docs need updating — generating surgical edit pairs, never full rewrites.
 *
 * TRIGGER: SessionEnd hook (via DocIntegrity.hook.ts)
 *
 * TEARDOWN BUDGET: the harness kills the whole hook at 30s and reports only
 * "Hook cancelled" — the hook cannot self-report, because its fatal path exits
 * 0 and every handler call is individually try/caught. Measured worst case
 * before this change: up to 15s inference (a spawned `claude` subprocess) + a
 * deliberate 3s sleep + a 3s voice fetch = ~21s, BEFORE RebuildArchSummary's
 * then-unbounded generator subprocess even started. The inference layer is
 * therefore OFF on the SessionEnd path; set DOCINTEGRITY_INFERENCE=1 to opt
 * back in for a manual run. public PR #1682, @pkumaschow
 *
 * PATTERN TYPES CHECKED (deterministic):
 * 1. Hook file references (*.hook.ts) - diff against disk
 * 2. Handler file references (handlers/*.ts) - diff against disk
 * 3. Shared lib references (hooks/lib/*.ts) - diff against disk
 * 4. SYSTEM doc path references - validate files exist
 * 5. Numeric counts (e.g., "21 hooks active") - recount from disk
 * 6. Last Updated timestamps - update on modification
 *
 * INFERENCE ANALYSIS:
 * 7. Semantic drift - doc descriptions vs actual file behavior
 *    Uses Inference.ts medium tier (~500ms), constrained to surgical edits only
 *
 * AUDIT TRAIL: All operations logged to stderr via [DocAutoUpdate] prefix
 *
 * SIDE EFFECTS:
 * - Updates timestamps, counts (deterministic)
 * - Applies surgical text edits (inference-generated)
 * - Emits doc.integrity event to events.jsonl
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, realpathSync } from 'fs';
import { join, basename, relative, sep, isAbsolute } from 'path';
import { lifeosPath, getLifeosDir, getClaudeDir } from '../lib/paths';
import { invariant } from '../../LIFEOS/TOOLS/Invariant';
import { getIdentity } from '../lib/identity';
import { inference } from '../../LIFEOS/TOOLS/Inference';
import { redact } from '../../LIFEOS/TOOLS/lib/Boundary';
import type { ParsedTranscript } from '../../LIFEOS/TOOLS/TranscriptParser';
import { isDesktopChannel, logSkippedVoice, getNotificationChannel } from '../lib/notification-channel';
import { PULSE_BASE } from '../../LIFEOS/PULSE/endpoint';


// ============================================================================
// Types
// ============================================================================

interface HookInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
}

interface DriftItem {
  doc: string;
  pattern: string;
  reference: string;
  issue: string;
}

// ============================================================================
// Constants
// ============================================================================

const SYSTEM_DIR = getLifeosDir();
const DOCS_DIR = join(SYSTEM_DIR, 'DOCUMENTATION');
const HOOKS_DIR = join(getClaudeDir(), 'hooks');
const HANDLERS_DIR = join(HOOKS_DIR, 'handlers');
const LIB_DIR = join(HOOKS_DIR, 'lib');
const TAG = '[DocAutoUpdate]';

// ============================================================================
// Filesystem Inventory
// ============================================================================

/**
 * Recursive listing, returned as paths RELATIVE to `dir` so every caller's
 * `join(<dir>, entry)` still resolves. Recursion is a no-op on the flat hook /
 * handler / lib trees; it is load-bearing for DOCUMENTATION/, which is almost
 * entirely nested — the previous non-recursive readdir saw 5 of 51 docs and
 * reported "all cross-references valid" over the 10% it could see.
 */
function listFiles(dir: string, suffix: string, prefix = ''): string[] {
  try {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(...listFiles(join(dir, entry.name), suffix, rel));
      } else if (entry.name.endsWith(suffix)) {
        out.push(rel);
      }
    }
    return out.sort();
  } catch {
    return [];
  }
}

function getHookFilesOnDisk(): string[] {
  return listFiles(HOOKS_DIR, '.hook.ts');
}

function getHandlerFilesOnDisk(): string[] {
  return listFiles(HANDLERS_DIR, '.ts');
}

function getLibFilesOnDisk(): string[] {
  return listFiles(LIB_DIR, '.ts');
}

function getSystemDocsOnDisk(): string[] {
  return listFiles(DOCS_DIR, '.md');
}

// ============================================================================
// Transcript Parsing
// ============================================================================

function getModifiedFiles(transcriptPath: string): Set<string> {
  const modified = new Set<string>();
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Handle both transcript formats
        if (entry.type === 'tool_use' && (entry.name === 'Write' || entry.name === 'Edit')) {
          const path = entry.input?.file_path || '';
          if (path) modified.add(path);
        }
        if (entry.type === 'assistant' && entry.message?.content) {
          const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
          for (const block of blocks) {
            if (block.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit')) {
              const path = block.input?.file_path || '';
              if (path) modified.add(path);
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch (error) {
    console.error(`${TAG} Failed to parse transcript:`, error);
  }
  return modified;
}

function isSystemDocModified(modifiedFiles: Set<string>): boolean {
  for (const path of modifiedFiles) {
    if (path.includes('LIFEOS/') && path.endsWith('.md')) return true;
  }
  return false;
}

function isHookModified(modifiedFiles: Set<string>): boolean {
  for (const path of modifiedFiles) {
    if (path.includes('/hooks/') && path.endsWith('.ts')) return true;
  }
  return false;
}

/**
 * Check if ANY meaningful LifeOS system file was modified.
 * LifeOS spans TWO root directories:
 *   - CLAUDE_DIR (~/.claude) — hooks, skills, settings, agents, CLAUDE.md
 *   - LIFEOS_DIR (~/.claude/LIFEOS) — LifeOS data, Tools, Components, Workflows, SYSTEM docs
 * Excludes MEMORY/WORK, MEMORY/LEARNING, MEMORY/STATE, and other non-system paths.
 */
function isSystemFileModified(modifiedFiles: Set<string>): boolean {
  const LIFEOS_DIR = getLifeosDir();
  const CLAUDE_DIR = getClaudeDir();
  const LIFEOS_EXCLUDED = ['MEMORY/WORK/', 'MEMORY/LEARNING/', 'MEMORY/STATE/', 'Plans/', '.git/', 'node_modules/', 'ShellSnapshots/', 'MEMORY/VOICE/', 'MEMORY/RELATIONSHIP/', 'history.jsonl', '.quote-cache'];
  const CLAUDE_EXCLUDED = ['projects/', '.git/', 'node_modules/', 'history.jsonl'];

  for (const filePath of modifiedFiles) {
    // --- Check ~/.claude/LIFEOS/ paths FIRST ---
    // LIFEOS_DIR sits inside CLAUDE_DIR by default, so the shorter prefix used
    // to win and this arm was unreachable: editing LIFEOS/DOCUMENTATION never
    // ran the cross-ref check. The arm also carried a double `LIFEOS/` prefix
    // and a lowercase `/Tools/` for a `TOOLS/` tree. public issue #2043, @MatiasBarboza
    if (filePath.startsWith(LIFEOS_DIR + '/')) {
      const relPath = filePath.slice(LIFEOS_DIR.length + 1);
      if (LIFEOS_EXCLUDED.some(ex => relPath.includes(ex))) continue;

      if (relPath.startsWith('DOCUMENTATION/') && relPath.endsWith('.md')) return true;
      if (relPath.startsWith('TOOLS/') && relPath.endsWith('.ts')) return true;
      // .tsx counts as system source too (ported from public PR #1742, @elhoim).
      if (relPath.includes('skills/') && (relPath.endsWith('.md') || relPath.endsWith('.ts') || relPath.endsWith('.tsx') || relPath.endsWith('.yaml') || relPath.endsWith('.yml'))) return true;
      if (relPath.includes('/Tools/') && relPath.endsWith('.ts')) return true;
      if (relPath.includes('/Intents/') && relPath.endsWith('.md')) return true;
      continue;
    }

    // --- Check ~/.claude/ paths ---
    if (filePath.startsWith(CLAUDE_DIR + '/')) {
      const relPath = filePath.slice(CLAUDE_DIR.length + 1);
      if (CLAUDE_EXCLUDED.some(ex => relPath.includes(ex))) continue;

      if (relPath.startsWith('hooks/') && (relPath.endsWith('.ts') || relPath.endsWith('.sh'))) return true;
      // .tsx counts as system source too (ported from public PR #1742, @elhoim).
      if (relPath.startsWith('skills/') && (relPath.endsWith('.md') || relPath.endsWith('.ts') || relPath.endsWith('.tsx') || relPath.endsWith('.yaml') || relPath.endsWith('.yml'))) return true;
      if (relPath === 'settings.json') return true;
      if (relPath === 'CLAUDE.md') return true;
      if (relPath.startsWith('agents/') && relPath.endsWith('.md')) return true;
      if (relPath.startsWith('custom-agents/') && relPath.endsWith('.md')) return true;
      if (relPath.startsWith('commands/') && relPath.endsWith('.md')) return true;
      continue;
    }
  }
  return false;
}

/**
 * Public-install awareness (public issue #2043, @MatiasBarboza — landing note).
 * The release scrubs private hooks out of the payload but the shipped docs may
 * still name them, so on an install that is NOT the source tree a doc reference
 * to an absent hook is only real drift when settings.json still REGISTERS that
 * hook (registered-but-absent = broken install; unregistered-and-absent =
 * scrubbed by design). The source tree reports every absent reference. The
 * test is existence of the private release skill — the same marker
 * InstallEngine.detectDevTree uses — never a hook-name pattern.
 */
function isSourceTree(): boolean {
  return existsSync(join(getClaudeDir(), 'skills', '_LIFEOS'));
}

function registeredHookNames(): Set<string> {
  const names = new Set<string>();
  try {
    const raw = readFileSync(join(getClaudeDir(), 'settings.json'), 'utf-8');
    for (const m of raw.matchAll(/([\w-]+\.hook\.ts)/g)) names.add(m[1]);
  } catch { /* no settings → nothing registered */ }
  return names;
}

// ============================================================================
// Pattern Checkers
// ============================================================================

/**
 * Check Pattern 2: Hook file references in docs vs actual files on disk.
 */
function checkHookFileRefs(docsToCheck: string[], hooksOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  const hookRefRegex = /(\w+)\.hook\.ts/g;
  const sourceTree = isSourceTree();
  const registered = sourceTree ? null : registeredHookNames();

  for (const docFile of docsToCheck) {
    const docPath = join(DOCS_DIR, docFile);
    if (!existsSync(docPath)) continue;

    const content = readFileSync(docPath, 'utf-8');
    let match: RegExpExecArray | null;

    while ((match = hookRefRegex.exec(content)) !== null) {
      const hookName = match[0]; // e.g., "LoadContext.hook.ts"
      // Public install: an unregistered absent hook was scrubbed by design (#2043).
      if (registered && !registered.has(hookName) && !hooksOnDisk.has(hookName)) continue;
      if (!hooksOnDisk.has(hookName)) {
        drift.push({
          doc: docFile,
          pattern: 'hook_file_ref',
          reference: hookName,
          issue: `References "${hookName}" but file does not exist on disk`,
        });
      }
    }
  }

  return drift;
}

/**
 * Check Pattern 3: Handler file references in docs vs actual files on disk.
 */
function checkHandlerFileRefs(docsToCheck: string[], handlersOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  const handlerRefRegex = /handlers\/(\w+)\.ts/g;

  for (const docFile of docsToCheck) {
    const docPath = join(DOCS_DIR, docFile);
    if (!existsSync(docPath)) continue;

    const content = readFileSync(docPath, 'utf-8');
    let match: RegExpExecArray | null;

    while ((match = handlerRefRegex.exec(content)) !== null) {
      const handlerFilename = `${match[1]}.ts`;
      if (!handlersOnDisk.has(handlerFilename)) {
        drift.push({
          doc: docFile,
          pattern: 'handler_file_ref',
          reference: match[0],
          issue: `References "${match[0]}" but "${handlerFilename}" does not exist in handlers/`,
        });
      }
    }
  }

  return drift;
}

/**
 * Check Pattern 4: Shared lib file references in docs vs actual files on disk.
 */
function checkLibFileRefs(docsToCheck: string[], libsOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  const libRefRegex = /hooks\/lib\/([\w-]+)\.ts/g;

  for (const docFile of docsToCheck) {
    const docPath = join(DOCS_DIR, docFile);
    if (!existsSync(docPath)) continue;

    const content = readFileSync(docPath, 'utf-8');
    let match: RegExpExecArray | null;

    while ((match = libRefRegex.exec(content)) !== null) {
      const libFilename = `${match[1]}.ts`;
      if (!libsOnDisk.has(libFilename)) {
        drift.push({
          doc: docFile,
          pattern: 'lib_file_ref',
          reference: match[0],
          issue: `References "${match[0]}" but "${libFilename}" does not exist in hooks/lib/`,
        });
      }
    }
  }

  return drift;
}

/**
 * Check Pattern 1: SYSTEM doc cross-references validate target files exist.
 */
function checkSystemDocRefs(docsToCheck: string[], systemDocsOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  // Match backtick-wrapped or plain doc references under LifeOS/ (legacy skills/LifeOS/ included).
  // The `skills/` prefix is CAPTURED (group 1) and resolved under the LifeOS
  // skill, instead of being discarded so the ref resolved against the wrong
  // root. public issue #2043 (3), @MatiasBarboza
  const sysDocRefRegex = /(?:`|'|")(?:~\/\.(?:claude|config\/PAI)\/)?(skills\/)?LifeOS\/([\w/]+\.md)(?:`|'|")/g;

  for (const docFile of docsToCheck) {
    // docsToCheck holds paths relative to DOCS_DIR — the five sibling checks
    // all join against DOCS_DIR. Joining SYSTEM_DIR here resolved nothing, so
    // `continue` fired on every doc and Pattern 1 silently scanned zero files.
    const docPath = join(DOCS_DIR, docFile);
    if (!existsSync(docPath)) continue;

    const content = readFileSync(docPath, 'utf-8');
    let match: RegExpExecArray | null;

    while ((match = sysDocRefRegex.exec(content)) !== null) {
      const skillPrefixed = !!match[1];
      const refTarget = match[2]; // e.g., "DOCUMENTATION/LifeosSystemArchitecture.md" or "USER/SECURITY/SecurityPosture.md"
      const shown =`${skillPrefixed ? 'skills/' : ''}LifeOS/${refTarget}`;
      // skills/LifeOS/<ref> lives under the LifeOS skill, not SYSTEM_DIR (#2043).
      // Otherwise check SYSTEM_DIR first (nested paths like USER/SECURITY/SecurityPosture.md),
      // then DOCS_DIR (bare basenames that refer to files relocated under DOCUMENTATION/).
      const candidates = skillPrefixed
        ? [join(getClaudeDir(), 'skills', 'LifeOS', refTarget)]
        : [join(SYSTEM_DIR, refTarget), join(DOCS_DIR, refTarget)];
      if (!candidates.some((p) => existsSync(p))) {
        drift.push({
          doc: docFile,
          pattern: 'system_doc_ref',
          reference: shown,
          issue: `References "${shown}" but file does not exist`,
        });
      }
    }
  }

  return drift;
}

/**
 * Check Pattern 5: Numeric hook counts in docs vs actual count on disk.
 */
function checkHookCounts(docsToCheck: string[], actualCount: number): DriftItem[] {
  const drift: DriftItem[] = [];
  // Match "N hooks active" or "N hooks running" patterns, NOT in example/anti-pattern contexts
  const countRegex = /\*\*Status:\*\*.*?(\d+) hooks? active/g;

  for (const docFile of docsToCheck) {
    const docPath = join(DOCS_DIR, docFile);
    if (!existsSync(docPath)) continue;

    const content = readFileSync(docPath, 'utf-8');
    let match: RegExpExecArray | null;

    while ((match = countRegex.exec(content)) !== null) {
      const docCount = parseInt(match[1], 10);
      if (docCount !== actualCount) {
        drift.push({
          doc: docFile,
          pattern: 'hook_count',
          reference: match[0],
          issue: `States "${docCount} hooks active" but actual count on disk is ${actualCount}`,
        });
      }
    }
  }

  return drift;
}

// ============================================================================
// Voice Notification (fire-and-forget)
// ============================================================================

async function notifyVoice(message: string): Promise<void> {
  // Desktop channel only. Remote channels (iMessage, Siri) do not surface
  // doc-integrity drift audibly — the integrity scan itself still runs.
  if (!isDesktopChannel()) {
    const channel = getNotificationChannel();
    console.error(`[DocCrossRefIntegrity] Voice OFF (remote channel: ${channel})`);
    logSkippedVoice({ hookLabel: 'DocCrossRefIntegrity', message });
    return;
  }
  try {
    await fetch(`${PULSE_BASE}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ message, voice_id: getIdentity().mainDAVoiceID }),
    });
  } catch {
    // Voice server may not be running — silent fail
  }
}

// ============================================================================
// Inference-Powered Semantic Analysis
// ============================================================================

interface InferenceEdit {
  doc: string;
  old_text: string;
  new_text: string;
  reason: string;
}

const INFERENCE_SYSTEM_PROMPT = `You are a documentation accuracy checker. You receive:
1. A list of source files that were modified, by path and line count only (their content is withheld)
2. Documentation sections that reference those files

Your job: identify where documentation is now FACTUALLY INCORRECT given the source changes.

OUTPUT FORMAT: Return a JSON array of surgical edits:
[{"doc": "filename.md", "old_text": "exact text to replace", "new_text": "corrected text", "reason": "brief explanation"}]

RULES (CRITICAL):
- Update anything that is NOW FACTUALLY WRONG because of the source changes
- This includes: file names, descriptions of behavior, counts, paths, handler lists, process descriptions
- If a system was fundamentally redesigned, update the doc sections that describe it to match the new reality
- old_text must be an EXACT substring from the doc (copy-paste precision)
- new_text should change ONLY the parts affected by the source change — preserve everything else exactly
- The user's original INTENT and PHILOSOPHY must be preserved — update facts, never change the "why" or design rationale unless it was explicitly invalidated by the change
- Writing style, tone, and voice must stay exactly as-is
- DO NOT "improve" or "clean up" text that wasn't affected by the change
- DO NOT add commentary, opinions, or explanations beyond what was already there
- If nothing is factually wrong given the changes, return an empty array: []
- Maximum 10 edits per response

Return ONLY the JSON array, no other text.`;

/**
 * Build context for inference: what changed and what docs say about it.
 * Keeps context small for fast inference (~500ms target).
 *
 * Confidentiality boundary (ISA 20261015-boundary-primitives, probe 7): modified files are named by their
 * path (relative to the Claude dir, else the basename) and line count, never their content, so no config
 * or source body reaches the model. Doc sections are read only through confinedDocPath, so a doc
 * symlinked out of the docs tree is never read, and the whole context passes through Boundary.redact.
 */
export function buildInferenceContext(
  modifiedFiles: Set<string>,
  docsToCheck: string[],
  docsDir: string = DOCS_DIR,
  claudeDir: string = getClaudeDir(),
): string {
  const parts: string[] = [];

  // Collect modified system files (paths only) — must match isSystemFileModified scope
  const relevantFiles = Array.from(modifiedFiles).filter(f =>
    f.includes('/hooks/') ||
    f.includes('/LIFEOS/') ||
    f.includes('skills/') ||
    f.endsWith('settings.json') ||
    f.includes('/agents/') ||
    f.includes('/custom-agents/') ||
    f.endsWith('CLAUDE.md'),
  );

  for (const filePath of relevantFiles.slice(0, 5)) { // Cap at 5 files
    try {
      if (!existsSync(filePath)) continue;
      // Read locally for the line count only; the body never enters the context.
      const content = readFileSync(filePath, 'utf-8');
      const lineCount = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      const shown = filePath.startsWith(claudeDir + sep) ? relative(claudeDir, filePath) : basename(filePath);
      parts.push(`=== MODIFIED FILE: ${shown} (${lineCount} lines) ===\n`);
    } catch {
      // Skip unreadable
    }
  }

  // Collect doc sections that reference modified files
  // For each affected doc, extract the FULL section (## heading to next ## heading)
  // so inference has enough context to make quality corrections
  for (const docFile of docsToCheck) {
    // Same DOCS_DIR-relative contract as the deterministic checks. This site
    // had the same wrong root, so the doc half of the inference context was
    // always empty — inference only ever saw source files, never the prose it
    // was asked to correct. Only a doc whose real path stays inside the real
    // docs tree is read, so a doc symlinked out of it is skipped.
    let docPath: string | null = null;
    try { docPath = confinedDocPath(docFile, docsDir); } catch { /* vanished or looped mid-read: skipped */ }
    if (!docPath) continue;

    try {
      const content = readFileSync(docPath, 'utf-8');
      // Check if this doc references any modified file
      const referencesModified = relevantFiles.some(f => {
        const name = basename(f, '.ts').replace('.hook', '');
        return content.includes(name);
      });

      if (referencesModified) {
        // Extract full sections that reference changed files
        const lines = content.split('\n');
        const sections: string[] = [];
        let currentSection: string[] = [];
        let currentSectionRelevant = false;

        for (let i = 0; i < lines.length; i++) {
          const isHeading = lines[i].match(/^#{1,3} /);

          if (isHeading && currentSection.length > 0) {
            // End of section — include if it referenced a changed file
            if (currentSectionRelevant) {
              sections.push(currentSection.join('\n'));
            }
            currentSection = [lines[i]];
            currentSectionRelevant = false;
          } else {
            currentSection.push(lines[i]);
          }

          // Check if this line references any modified file
          if (!currentSectionRelevant) {
            currentSectionRelevant = relevantFiles.some(f => {
              const name = basename(f, '.ts').replace('.hook', '');
              return lines[i].includes(name);
            });
          }
        }
        // Don't forget the last section
        if (currentSectionRelevant && currentSection.length > 0) {
          sections.push(currentSection.join('\n'));
        }

        if (sections.length > 0) {
          // Cap total doc context to prevent token explosion
          const docContext = sections.join('\n\n---\n\n').slice(0, 4000);
          parts.push(`=== DOC: ${docFile} (affected sections) ===\n${docContext}\n`);
        }
      }
    } catch {
      // Skip unreadable
    }
  }

  // Redact the whole context before it leaves: doc prose can carry labelled values and secret shapes.
  return redact(parts.join('\n'));
}

/**
 * Run inference to detect semantic drift and generate surgical edits.
 * Uses Inference.ts medium tier (Sonnet, ~500ms).
 */
async function runInferenceAnalysis(
  modifiedFiles: Set<string>,
  docsToCheck: string[],
): Promise<InferenceEdit[]> {
  const startTime = Date.now();

  const context = buildInferenceContext(modifiedFiles, docsToCheck);
  if (!context.trim()) {
    console.error(`${TAG} [INFERENCE] No relevant context for inference, skipping`);
    return [];
  }

  console.error(`${TAG} [INFERENCE] Running semantic analysis (medium tier)...`);
  console.error(`${TAG} [INFERENCE] Context size: ${context.length} chars`);

  try {
    const result = await inference({
      systemPrompt: INFERENCE_SYSTEM_PROMPT,
      userPrompt: `Analyze these source file changes and documentation sections for factual inaccuracies:\n\n${context}`,
      level: 'medium',
      expectJson: true,
      timeout: 15000, // Sonnet needs more time but produces better quality
    });

    const elapsed = Date.now() - startTime;
    console.error(`${TAG} [INFERENCE] Completed in ${elapsed}ms (success: ${result.success})`);

    if (!result.success) {
      console.error(`${TAG} [INFERENCE] Failed: ${result.error}`);
      return [];
    }

    // Parse and validate edits
    const rawEdits = result.parsed as InferenceEdit[] | undefined;
    if (!Array.isArray(rawEdits)) {
      console.error(`${TAG} [INFERENCE] Response was not a JSON array, skipping`);
      return [];
    }

    // Validate each edit has required fields and old_text actually exists in doc
    const validEdits: InferenceEdit[] = [];
    for (const edit of rawEdits.slice(0, 10)) { // Max 10 edits
      if (!edit.doc || !edit.old_text || !edit.new_text || !edit.reason) {
        console.error(`${TAG} [INFERENCE] Skipping malformed edit: ${JSON.stringify(edit)}`);
        continue;
      }

      // The model names the doc; only a doc we sent it, inside the docs tree by realpath, may be edited.
      const docPath = resolveDocEditPath(edit.doc, docsToCheck);
      if (!docPath) {
        console.error(`${TAG} [INFERENCE] Doc not in the checked docs tree: ${String(edit.doc).slice(0, 120)}, skipping edit`);
        continue;
      }

      const docContent = readFileSync(docPath, 'utf-8');
      if (!docContent.includes(edit.old_text)) {
        console.error(`${TAG} [INFERENCE] old_text not found in ${edit.doc}, skipping: "${edit.old_text.slice(0, 60)}..."`);
        continue;
      }

      // Reject no-ops
      if (edit.old_text === edit.new_text) {
        continue;
      }

      validEdits.push(edit);
    }

    console.error(`${TAG} [INFERENCE] ${validEdits.length} valid edits from ${rawEdits.length} raw`);
    return validEdits;
  } catch (error) {
    console.error(`${TAG} [INFERENCE] Error: ${error}`);
    return [];
  }
}

/**
 * The file a model-proposed edit may touch, or null. `doc` is model output, so it is trusted for nothing:
 * it must name a Markdown doc this run sent the model (`inventory`, DOCS_DIR-relative; a leading
 * `DOCUMENTATION/` is accepted), contain no absolute or `..` part, and resolve by realpath to a file
 * inside the docs tree, so a symlinked path component cannot lead out of it.
 */
export function resolveDocEditPath(doc: unknown, inventory: readonly string[], docsDir: string = DOCS_DIR): string | null {
  if (typeof doc !== 'string' || !doc || doc.includes('\0') || isAbsolute(doc)) return null;
  const rel = doc.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^DOCUMENTATION\//, '');
  if (!rel.endsWith('.md') || rel.split('/').some((part) => part === '..' || part === '.' || part === '')) return null;
  if (!inventory.includes(rel)) return null;
  const candidate = join(docsDir, rel);
  if (!existsSync(candidate)) return null;
  const realDocs = realpathSync(docsDir);
  const real = realpathSync(candidate);
  if (!real.startsWith(realDocs + sep)) return null;
  return real;
}

/**
 * Apply inference-generated edits to documentation files.
 * Each edit is a surgical find-and-replace with full audit logging.
 */
export function applyInferenceEdits(edits: InferenceEdit[], inventory: readonly string[], docsDir: string = DOCS_DIR): string[] {
  const applied: string[] = [];

  for (const edit of edits) {
    // Re-resolved here, not trusted from validation: the tree can change between the two (symlink swap).
    const docPath = resolveDocEditPath(edit.doc, inventory, docsDir);
    if (!docPath) {
      console.error(`${TAG} [INFERENCE-APPLY] refused ${String(edit.doc).slice(0, 120)}: not an inventoried doc inside the docs tree`);
      continue;
    }
    try {
      const content = readFileSync(docPath, 'utf-8');
      if (!content.includes(edit.old_text)) {
        console.error(`${TAG} [INFERENCE-APPLY] old_text no longer found in ${edit.doc}, skipping`);
        continue;
      }

      // Function replacer: new_text is model-written, and a string replacement
      // would expand `$&`, `$'`, `` $` `` and `$$` inside it (public issue #2271, @jacobo-ortiz).
      const updated = content.replace(edit.old_text, () => edit.new_text);
      invariant(docPath.startsWith(realpathSync(docsDir) + sep), `inference edit escaped the docs tree: ${docPath}`);
      writeFileSync(docPath, updated);

      const summary = `[INFERENCE] ${edit.doc}: ${edit.reason} ("${edit.old_text.slice(0, 40)}..." → "${edit.new_text.slice(0, 40)}...")`;
      console.error(`${TAG} [UPDATED] ${summary}`);
      applied.push(summary);
    } catch (error) {
      console.error(`${TAG} [INFERENCE-APPLY] Failed on ${edit.doc}: ${error}`);
    }
  }

  return applied;
}

// ============================================================================
// Deterministic Updates (safe auto-fixes)
// ============================================================================

/**
 * The DOCUMENTATION-relative path of an edited file, or null when the file is
 * not under the docs tree. Keyed by relative path, never basename: the docs
 * tree is almost entirely nested, so a basename join resolved nothing for any
 * doc that carries the marker (2026-09-03 /LI audit, finding 6).
 */
export function docsRelativePath(absPath: string, docsDir: string = DOCS_DIR): string | null {
  return absPath.startsWith(docsDir + sep) ? relative(docsDir, absPath) : null;
}

/**
 * Update Pattern 6: Last Updated timestamps in modified docs. `docFile` is
 * DOCS_DIR-relative and comes only from the session's own Write/Edit calls,
 * so an untouched doc is never restamped.
 */
/**
 * The real path of a DOCUMENTATION-relative file, or null when it is missing or its real path (every symlink,
 * final component included, dereferenced) leaves the real docs tree. The
 * deterministic rewrites write only to the returned path.
 */
export function confinedDocPath(docFile: string, docsDir: string = DOCS_DIR): string | null {
  if (!docFile || docFile.includes('\0') || isAbsolute(docFile)) return null;
  if (docFile.replace(/\\/g, '/').split('/').some((part) => part === '..')) return null;
  const candidate = join(docsDir, docFile);
  if (!existsSync(candidate)) return null;
  const realDocs = realpathSync(docsDir);
  const real = realpathSync(candidate);
  return real.startsWith(realDocs + sep) ? real : null;
}

export function updateLastUpdatedTimestamp(docFile: string, docsDir: string = DOCS_DIR): string | null {
  const docPath = confinedDocPath(docFile, docsDir);
  if (!docPath) return null;

  const content = readFileSync(docPath, 'utf-8');
  const today = new Date().toISOString().split('T')[0];
  const timestampRegex = /(\*\*Last Updated:\*\* )\d{4}-\d{2}-\d{2}/;

  const match = content.match(timestampRegex);
  if (match && !content.includes(`**Last Updated:** ${today}`)) {
    invariant(docPath.startsWith(realpathSync(docsDir) + sep), `Last Updated rewrite escaped the docs tree: ${docPath}`);
    const updated = content.replace(timestampRegex, `$1${today}`);
    writeFileSync(docPath, updated);
    return `Updated "Last Updated" in ${docFile}: ${match[0]} -> **Last Updated:** ${today}`;
  }

  return null;
}

/**
 * One count line plus at most `cap` items per pattern — a DOCUMENTATION edit
 * used to print ~70 stale-reference lines at SessionEnd (audit finding 6).
 */
const DRIFT_PRINT_CAP = 10;
function printDrift(label: string, unit: string, items: DriftItem[]): void {
  if (items.length === 0) {
    console.error(`${TAG} [OK] ${label}: all valid`);
    return;
  }
  console.error(`${TAG} [DRIFT] ${label}: ${items.length} ${unit} found`);
  for (const item of items.slice(0, DRIFT_PRINT_CAP)) {
    console.error(`${TAG}   - ${item.doc}: ${item.issue}`);
  }
  if (items.length > DRIFT_PRINT_CAP) console.error(`${TAG}   … and ${items.length - DRIFT_PRINT_CAP} more`);
}

/**
 * Update Pattern 5: Hook count in DOCUMENTATION/Hooks/HookSystem.md.
 */
export function updateHookCount(actualCount: number, docsDir: string = DOCS_DIR): string | null {
  const docPath = confinedDocPath('Hooks/HookSystem.md', docsDir);
  if (!docPath) return null;

  const content = readFileSync(docPath, 'utf-8');
  const countRegex = /(\*\*Status:\*\* Production - )\d+( hooks? active)/;

  const match = content.match(countRegex);
  if (match) {
    const oldCount = parseInt(content.match(/\*\*Status:\*\* Production - (\d+)/)?.[1] || '0', 10);
    if (oldCount !== actualCount) {
      const updated = content.replace(countRegex, `$1${actualCount}$2`);
      invariant(docPath.startsWith(realpathSync(docsDir) + sep), `hook-count rewrite escaped the docs tree: ${docPath}`);
      writeFileSync(docPath, updated);
      return `Updated hook count in Hooks/HookSystem.md: ${oldCount} -> ${actualCount}`;
    }
  }

  return null;
}

// ============================================================================
// Main Handler
// ============================================================================

export async function handleDocCrossRefIntegrity(
  parsed: ParsedTranscript,
  hookInput: HookInput
): Promise<void> {
  const handlerStart = Date.now();
  console.error(`${TAG} === Starting hybrid doc integrity check (deterministic + inference) ===`);

  // Step 1: Parse transcript for modified files
  const modifiedFiles = getModifiedFiles(hookInput.transcript_path);
  console.error(`${TAG} Modified files in session: ${modifiedFiles.size}`);

  // Run if ANY meaningful LifeOS system file was modified (skills, hooks, tools, config, components, intents, SYSTEM docs)
  const hasDocChanges = isSystemDocModified(modifiedFiles);
  const hasHookChanges = isHookModified(modifiedFiles);
  const hasAnySystemChange = isSystemFileModified(modifiedFiles);

  if (!hasAnySystemChange) {
    console.error(`${TAG} No meaningful system files modified, skipping`);
    return;
  }

  console.error(`${TAG} System docs modified: ${hasDocChanges}`);
  console.error(`${TAG} Hook files modified: ${hasHookChanges}`);
  console.error(`${TAG} System file change detected: ${hasAnySystemChange}`);

  // Step 2: Build filesystem inventory
  const hooksOnDisk = new Set(getHookFilesOnDisk());
  const handlersOnDisk = new Set(getHandlerFilesOnDisk());
  const libsOnDisk = new Set(getLibFilesOnDisk());
  const systemDocsOnDisk = new Set(getSystemDocsOnDisk());

  console.error(`${TAG} Inventory: ${hooksOnDisk.size} hooks, ${handlersOnDisk.size} handlers, ${libsOnDisk.size} libs, ${systemDocsOnDisk.size} system docs`);

  // Step 3: Determine which docs to check
  // Check all SYSTEM docs that reference hooks/handlers/libs
  const docsToCheck = Array.from(systemDocsOnDisk);
  console.error(`${TAG} Checking ${docsToCheck.length} SYSTEM docs for cross-reference drift`);

  // Step 4: Run all pattern checks
  const allDrift: DriftItem[] = [];

  // Pattern 2: Hook file references
  const hookDrift = checkHookFileRefs(docsToCheck, hooksOnDisk);
  printDrift('Hook file references', 'broken refs', hookDrift);
  allDrift.push(...hookDrift);

  // Pattern 3: Handler file references
  const handlerDrift = checkHandlerFileRefs(docsToCheck, handlersOnDisk);
  printDrift('Handler file references', 'broken refs', handlerDrift);
  allDrift.push(...handlerDrift);

  // Pattern 4: Lib file references
  const libDrift = checkLibFileRefs(docsToCheck, libsOnDisk);
  printDrift('Lib file references', 'broken refs', libDrift);
  allDrift.push(...libDrift);

  // Pattern 1: System doc cross-references
  const sysDocDrift = checkSystemDocRefs(docsToCheck, systemDocsOnDisk);
  printDrift('System doc references', 'broken refs', sysDocDrift);
  allDrift.push(...sysDocDrift);

  // Pattern 5: Hook counts
  const hookCountDrift = checkHookCounts(docsToCheck, hooksOnDisk.size);
  printDrift('Hook counts', 'mismatches', hookCountDrift);
  allDrift.push(...hookCountDrift);

  // Step 5: Apply safe deterministic updates
  const updatesApplied: string[] = [];

  // Update Last Updated timestamps — only in docs THIS session wrote or edited,
  // resolved by their DOCS_DIR-relative path (audit finding 6: basename keying
  // never resolved a nested doc, and could only ever have hit the wrong one).
  for (const path of modifiedFiles) {
    if (!path.endsWith('.md')) continue;
    const docFile = docsRelativePath(path);
    if (!docFile) continue;
    const result = updateLastUpdatedTimestamp(docFile);
    if (result) {
      console.error(`${TAG} [UPDATED] ${result}`);
      updatesApplied.push(result);
    }
  }

  // Auto-fix hook count if drifted
  if (hasHookChanges) {
    const countResult = updateHookCount(hooksOnDisk.size);
    if (countResult) {
      console.error(`${TAG} [UPDATED] ${countResult}`);
      updatesApplied.push(countResult);
    }
  }

  // Step 6: Inference-powered semantic analysis — NOT on teardown.
  // Catches what grep can't (a doc saying "this hook does X" when it now does Y),
  // but it spawns a `claude` subprocess capped at 15s, which is half the harness's
  // 30s kill window for the whole hook. On SessionEnd the session is already
  // ending, so a semantic correction bought at the cost of losing the entire
  // deterministic pass — which is the part that actually fixes broken refs and
  // counts — is a bad trade. Opt in explicitly for a manual run.
  // public PR #1682, @pkumaschow
  const inferenceEnabled =
    hookInput.hook_event_name !== 'SessionEnd' || process.env.DOCINTEGRITY_INFERENCE === '1';

  if (!inferenceEnabled) {
    console.error(`${TAG} [INFERENCE] Skipped on SessionEnd (teardown budget). Set DOCINTEGRITY_INFERENCE=1 to force.`);
  } else {
    console.error(`${TAG} === Running inference analysis ===`);
    const inferenceEdits = await runInferenceAnalysis(modifiedFiles, docsToCheck);
    if (inferenceEdits.length > 0) {
      const inferenceApplied = applyInferenceEdits(inferenceEdits, docsToCheck);
      updatesApplied.push(...inferenceApplied);
    } else {
      console.error(`${TAG} [INFERENCE] No semantic corrections needed`);
    }
  }

  // Step 7: Summary
  const totalElapsed = Date.now() - handlerStart;
  console.error(`${TAG} === Summary (${totalElapsed}ms) ===`);
  console.error(`${TAG} Docs checked: ${docsToCheck.length}`);
  console.error(`${TAG} Drift items found: ${allDrift.length}`);
  console.error(`${TAG} Updates applied: ${updatesApplied.length}`);
  if (allDrift.length > 0) {
    console.error(`${TAG} WARNING: ${allDrift.length} cross-reference drift items need manual attention`);
  } else {
    console.error(`${TAG} All cross-references valid`);
  }
  console.error(`${TAG} Wall time: ${totalElapsed}ms`);
  console.error(`${TAG} === Check complete ===`);

  // Step 10: Voice notification — ONLY when actual documentation edits were applied
  // No voice for "queued for review" or "in sync" — that's noise
  if (updatesApplied.length > 0) {
    // The 3s delay below exists to let the DA's main 🗣️ voice line play first. On
    // SessionEnd there is no main voice line to sequence against — the session
    // is ending — so it was 3 seconds of a 30s teardown budget spent ordering
    // audio nobody is waiting for. Sequence only where sequencing is real.
    // public PR #1682, @pkumaschow
    if (hookInput.hook_event_name !== 'SessionEnd') {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    const affectedDocs = new Set<string>();
    for (const update of updatesApplied) {
      const docMatch = update.match(/(?:in |] )(\w+\.md)/);
      if (docMatch) affectedDocs.add(docMatch[1].replace('.md', ''));
    }

    const docNames = Array.from(affectedDocs).slice(0, 3).join(', ') || 'system';
    const reason = hasHookChanges ? 'hook system changes' : hasDocChanges ? 'system documentation changes' : 'system file changes';
    await notifyVoice(`Updated ${docNames} documentation after detecting ${reason}.`);
  }
}
