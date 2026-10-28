#!/usr/bin/env bun
// Normalize env path vars Claude Code may inject unexpanded — literal $HOME/${HOME}
// in LIFEOS_DIR/LIFEOS_CONFIG_DIR/PROJECTS_DIR resolves to a shadow dir (#1404 / PR #1451, author jbmml).
for (const __k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const __v = process.env[__k];
  if (__v && /^\$\{?HOME\}?(\/|$)/.test(__v)) process.env[__k] = __v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}

/**
 * @version 1.7.2
 * SessionCleanup.hook.ts - Mark Work Complete and Clear State (SessionEnd)
 *
 * PURPOSE:
 * Finalizes a Claude Code session by marking the current work directory as
 * COMPLETED, clearing session state, resetting Kitty tab, and cleaning up
 * session name entries.
 *
 * TRIGGER: SessionEnd
 *
 * INPUT:
 * - stdin: Hook input JSON (session_id, transcript_path)
 * - Files: MEMORY/STATE/work.json (canonical session registry)
 *
 * OUTPUT:
 * - stdout: None
 * - stderr: Status messages
 * - exit(0): Always (non-blocking)
 *
 * SIDE EFFECTS:
 * - Updates: MEMORY/WORK/<slug>/ISA.md (or legacy PRD.md) or META.yaml (status: COMPLETED)
 * - Marks ALL work.json rows owned by this session UUID as phase=complete
 * - Resets: Kitty tab title and color to defaults
 * - Cleans: session-names.json entry (prevents ghost entries)
 *
 * INTER-HOOK RELATIONSHIPS:
 * - COORDINATES WITH: WorkCompletionLearning (both run at SessionEnd)
 * - MUST RUN AFTER: WorkCompletionLearning (learning capture uses state before clear)
 *
 * PERFORMANCE:
 * - Non-blocking: Yes
 * - Typical execution: <50ms
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getISOTimestamp } from './lib/time';
import { setTabState, cleanupKittySession, clearSessionLabel } from './lib/tab-setter';
import { readRegistry, writeRegistry, findArtifactPath, findActiveSessionByUUID, applyAscent, countCriteria } from './lib/isa-utils';
import { PHASE_TO_ASCENT } from '../LIFEOS/TOOLS/ascent';
import { invariant } from '../LIFEOS/TOOLS/Invariant';
import { unregisterSession } from '../LIFEOS/TOOLS/LiveSessions';
import { getLifeosDir } from "./lib/paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

// Normalize env path vars that Claude Code injects without shell expansion (LifeOS#1404)
for (const k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const v = process.env[k];
  if (v && /^\$\{?HOME\}?(\/|$)/.test(v)) process.env[k] = v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}


const BASE_DIR = getLifeosDir();
const MEMORY_DIR = join(BASE_DIR, 'MEMORY');
const STATE_DIR = join(MEMORY_DIR, 'STATE');
const WORK_DIR = join(MEMORY_DIR, 'WORK');

/**
 * The ISA frontmatter a session end leaves behind. Pure.
 *
 * A session ending is not a criterion closing (leaf criteria, #1938; public PR #1978
 * / issue #1977, @bnkath2o). With open criteria the ISA keeps whatever phase it
 * declared (learn, observe, build, climbing…) — a derived climbing/scoping
 * overwrote all of those on every session end (2026-09-03 /LI audit, finding
 * 3) — and only a bare-fraction `progress:` is refreshed: `progress: true`
 * and annotated forms are left as written. Only a fully-closed ISA (or one
 * with no criteria at all — unchanged behavior) reads complete.
 *
 * Returns `phase: 'complete'` when the ISA closed, `null` when it stays open.
 */
export function closeIsaOnSessionEnd(isaContent: string, nowIso: string): { content: string; phase: 'complete' | null; open: number; checked: number; total: number } {
  const { checked, total } = countCriteria(isaContent);
  const open = total - checked;
  let content = isaContent.replace(/^updated:.*$/m, `updated: ${nowIso}`);
  if (open > 0) {
    // progress must not go stale while the ISA stays open
    content = content.replace(/^progress:\s*"?\d+\/\d+"?\s*$/m, `progress: ${checked}/${total}`);
    return { content, phase: null, open, checked, total };
  }
  const phase = 'complete';
  invariant(phase in PHASE_TO_ASCENT, `SessionCleanup derived an unknown phase "${phase}"`);
  content = content.replace(/^phase:.*$/m, `phase: ${phase}`);
  // status: COMPLETED / completed_at are legacy compat for old artifacts.
  content = content.replace(/^status: ACTIVE$/m, 'status: COMPLETED');
  content = content.replace(/^completed_at: null$/m, `completed_at: "${nowIso}"`);
  return { content, phase, open, checked, total };
}

/**
 * Mark active work as completed.
 *
 * Active work is resolved by sessionUUID against MEMORY/STATE/work.json
 * (the canonical session registry). Updates the ISA frontmatter
 * (or legacy META.yaml) for the resolved slug, then marks every work.json
 * row owned by this UUID as phase=complete so dashboards close the row.
 */
function clearSessionWork(sessionId?: string): void {
  try {
    // Resolve the active session row for this hook UUID. If none, there is
    // nothing to mark — most native sessions hit this path on harness exit.
    const active = sessionId ? findActiveSessionByUUID(sessionId) : null;
    // Phase the registry rows should carry — derived from the ISA when one
    // exists, `complete` for native/placeholder rows with nothing to keep open.
    let sessionPhase: 'complete' | null = 'complete';

    if (active) {
      const slug = active.slug;
      const workPath = join(WORK_DIR, slug);
      const isaPath = findArtifactPath(slug);
      const metaPath = join(workPath, 'META.yaml');
      let marked = false;
      // Phase the ISA closed to — `complete`, or null when open criteria keep it
      // open (see closeIsaOnSessionEnd). Null means the work.json row for this
      // ISA keeps its existing phase too.
      let phase: 'complete' | null = 'complete';

      // Primary: update the ISA frontmatter.
      // findArtifactPath prefers ISA.md and falls back to legacy PRD.md.
      if (isaPath && existsSync(isaPath)) {
        const closed = closeIsaOnSessionEnd(readFileSync(isaPath, 'utf-8'), getISOTimestamp());
        phase = closed.phase;
        if (closed.open > 0) {
          console.error(`[SessionCleanup] ${slug}: phase left as declared — ${closed.open} criteria still open. A session ending does not close criteria.`);
        }
        writeFileSync(isaPath, closed.content, 'utf-8');
        marked = true;
      }

      // Legacy fallback: update META.yaml if it exists
      if (existsSync(metaPath)) {
        let metaContent = readFileSync(metaPath, 'utf-8');
        metaContent = metaContent.replace(/^status: "ACTIVE"$/m, 'status: "COMPLETED"');
        metaContent = metaContent.replace(/^completed_at: null$/m, `completed_at: "${getISOTimestamp()}"`);
        writeFileSync(metaPath, metaContent, 'utf-8');
        marked = true;
      }

      if (marked && phase === 'complete') {
        console.error(`[SessionCleanup] Marked work directory as COMPLETED: ${slug}`);
      }
      sessionPhase = phase;
    } else if (sessionId) {
      console.error(`[SessionCleanup] No active work session for sessionId=${sessionId}`);
    } else {
      console.error('[SessionCleanup] No session_id from hook input — nothing to mark');
    }

    // Close every work.json entry owned by this session UUID. Without this,
    // native tabs and interrupted algorithms linger as "live" on the agents
    // dashboard until their stale window elapses. An ISA with open criteria keeps
    // its row exactly as it is (phase untouched, not `complete`) so the ISA and
    // the row agree — otherwise applyAscent derives "done" from the row while
    // the ISA still reads open. public PR #1978 / issue #1977, @bnkath2o
    if (sessionId) {
      try {
        const registry = readRegistry();
        // work.json updatedAt must be UTC toISOString() like every other writer.
        // getISOTimestamp() emits local "-07:00" format, which corrupts string
        // sorts in readers (statusline MODE picker) against Z-format rows.
        const ts = new Date().toISOString();
        let touched = 0;
        for (const [slug, session] of Object.entries(registry.sessions) as [string, any][]) {
          if (session.sessionUUID !== sessionId) continue;
          if (session.phase === 'complete') continue;
          // The active ISA row closes only when the ISA did (null = the ISA stayed
          // open, so its row keeps its existing phase); any other row owned by
          // this UUID (native/starting placeholders) closes as before.
          const rowPhase = active && slug === active.slug ? sessionPhase : 'complete';
          if (rowPhase === null || session.phase === rowPhase) continue;
          session.phase = rowPhase;
          // `ascent` is derived from phase — recompute it here or the closed row
          // keeps rendering 🧗 Ascending on the board and the status line
          // (2026-07-30 sweep: two of three row writers skipped this).
          applyAscent(session);
          session.updatedAt = ts;
          touched++;
        }
        if (touched > 0) {
          writeRegistry(registry);
          console.error(`[SessionCleanup] Updated ${touched} work.json session(s) for UUID ${sessionId} (ISA row phase: ${sessionPhase ?? 'kept'})`);
        }
      } catch (e) {
        console.error(`[SessionCleanup] Failed to mark work.json sessions complete: ${e}`);
      }
    }

    // Clean session-names.json entry to prevent IDLE ghost on activity page
    if (sessionId) {
      const snPath = join(STATE_DIR, 'session-names.json');
      try {
        if (existsSync(snPath)) {
          const names = JSON.parse(readFileSync(snPath, 'utf-8'));
          if (names[sessionId]) {
            delete names[sessionId];
            writeFileSync(snPath, JSON.stringify(names, null, 2), 'utf-8');
            console.error(`[SessionCleanup] Removed session ${sessionId} from session-names.json`);
          }
        }
      } catch (e) {
        console.error(`[SessionCleanup] Failed to clean session-names.json: ${e}`);
      }
      // Same for the tab label the namer authored — it dies with the session.
      try { clearSessionLabel(sessionId); } catch { /* silent */ }
    }
  } catch (error) {
    console.error(`[SessionCleanup] Error clearing session work: ${error}`);
  }
}

async function main() {
  try {
    // Read input from stdin with timeout — SessionEnd hooks may receive
    // empty or slow stdin. Proceed regardless since state is read from disk.
    let sessionId: string | undefined;
    try {
      const input = await Promise.race([
        Bun.stdin.text(),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]);
      if (input && input.trim()) {
        const parsed = JSON.parse(input);
        sessionId = parsed.session_id;
      }
    } catch {
      // Timeout or parse error — proceed without session_id
    }

    // Mark work as complete and clear state
    clearSessionWork(sessionId);

    // Reset Kitty tab to neutral styling — no lingering colored backgrounds
    try {
      setTabState({ title: '', state: 'idle', sessionId });
      console.error('[SessionCleanup] Tab reset to default styling');
    } catch {
      console.error('[SessionCleanup] Tab reset failed (non-critical)');
    }

    // Clean up per-session kitty env file (prevents unbounded file accumulation)
    if (sessionId) {
      cleanupKittySession(sessionId);
      try { unregisterSession(sessionId); } catch { /* registry entry already gone */ }
      console.error(`[SessionCleanup] Cleaned up kitty session: ${sessionId}`);
    }

    console.error('[SessionCleanup] Session ended, work marked complete');
    process.exit(0);
  } catch (error) {
    // Silent failure - don't disrupt workflow
    console.error(`[SessionCleanup] SessionEnd hook error: ${error}`);
    process.exit(0);
  }
}

if (import.meta.main) main();
