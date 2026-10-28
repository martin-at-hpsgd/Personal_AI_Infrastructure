#!/usr/bin/env bun
/**
 * @version 1.9.4
 * LoadContext.hook.ts - Inject LifeOS dynamic context into Claude's Context (SessionStart)
 *
 * LifeOS v5.0 Context Architecture:
 * - Constitutional rules     → LIFEOS/LIFEOS_SYSTEM_PROMPT.md (system prompt via --append-system-prompt-file)
 * - Operational procedures   → CLAUDE.md (loaded natively by Claude Code)
 * - Contextual knowledge     → @imports in CLAUDE.md (native Claude Code mechanism, v5.0)
 * - Dynamic context          → this hook (learning, advisory, work)
 *
 * This hook handles dynamic context only (v5.0 — static files moved to @imports):
 * - Injects dynamic, session-specific context:
 *   - Learning readback (wisdom frames)
 *   - Advisory readback (last session's doc/memory integrity findings)
 *   - Work board digest
 *   - Active work summary (last 48h WORK sessions)
 *
 * Removed 2026-08-17: the relationship-notes reader and the session-progress
 * reader (cold sources with no producer since 2026-05/06). See the comments at
 * their former sites before re-adding either. public issue #1712, @jacobo-ortiz
 *
 * TRIGGER: SessionStart
 *
 * INPUT:
 * - Environment: LIFEOS_DIR
 *          MEMORY/WORK/*
 *
 * OUTPUT:
 * - stdout: <system-reminder> containing dynamic context (learning, advisory, work digest)
 * - stdout: Active work summary if previous sessions have pending work
 * - stderr: Status messages and errors
 * - exit(0): Normal completion
 *
 * DESIGN (v5.0):
 * Constitutional rules live in the system prompt (LIFEOS/LIFEOS_SYSTEM_PROMPT.md).
 * Operational procedures + contextual knowledge live in CLAUDE.md (@imports, native).
 * This hook injects dynamic, session-specific context only (learning, advisory, work).
 *
 * PERFORMANCE:
 * - Blocking: Yes (context is essential)
 * - Typical execution: <50ms (no SKILL.md rebuild needed)
 * - Skipped for subagents: Yes
 */

import { readFileSync, existsSync, readdirSync, realpathSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getClaudeDir, getLifeosDir, getSettingsPath, lifeosPath } from './lib/paths';
import { recordSessionStart } from './lib/notifications';
import { loadWisdomFrames } from './lib/learning-readback';
import { loadAdvisoryDigest } from './lib/advisory-readback';
import { isSubagentContext } from './lib/subagent';
import { isDesktopChannel, getNotificationChannel } from './lib/notification-channel';
import { PHASE_TO_ASCENT } from '../LIFEOS/TOOLS/ascent';

/**
 * The phases that mean a run is finished, derived from the ONE ascent table
 * rather than hand-listed here (extracted from public PR #1714, @anikinsasha).
 * `cairn` is the terminal bracket, so `learn` and `complete` resolve into this
 * set today and any future terminal phase joins it for free. Hand-listing is
 * exactly how two consumers ended up asserting the retired 8-station enum and
 * reading a modern run as "nothing has happened yet" — see the note on
 * `phaseHasWorkStarted` in ascent.ts.
 */
const TERMINAL_PHASES = new Set(
  Object.entries(PHASE_TO_ASCENT)
    .filter(([, bracket]) => bracket === 'cairn')
    .map(([phase]) => phase),
);

/**
 * True when an ISA's declared `status:`/`phase:` means done. ISAs carry either
 * key: the legacy `status: COMPLETED` and the current `phase: complete|learn`.
 * Routing both through one predicate is what stops a finished session from
 * holding an ACTIVE WORK slot forever.
 */
function isTerminalWorkState(value: string): boolean {
  const v = value.toLowerCase().trim();
  return v === 'completed' || TERMINAL_PHASES.has(v);
}

interface DynamicContextConfig {
  learningReadback?: boolean;
  advisoryReadback?: boolean;
  activeWorkSummary?: boolean;
  workDigest?: boolean;
}

/**
 * Work board digest (work-system methodology, 2026-08-15). WorkSweep writes
 * MEMORY/STATE/work-digest.md hourly — top open priorities, overdue reminders,
 * and the recurring-state panel. Injecting it here is what makes "check the
 * board" structural instead of remembered: every desktop session starts knowing
 * what the work system holds. A digest older than 26h is flagged stale rather
 * than trusted (the sweep runs hourly; a day-old file means the sweep is down).
 */
function loadWorkDigest(lifeosDir: string): string | null {
  const digestPath = join(lifeosDir, 'MEMORY', 'STATE', 'work-digest.md');
  if (!existsSync(digestPath)) return null;
  try {
    const content = readFileSync(digestPath, 'utf-8').trim();
    if (!content) return null;
    const m = content.match(/Updated:\s*(\S+)/);
    const ageH = m ? (Date.now() - Date.parse(m[1])) / 3600000 : null;
    const staleNote = ageH !== null && ageH > 26
      ? `\n\n⚠️ Digest is ${Math.round(ageH)}h old — WorkSweep may be down (com.lifeos.worksweep).`
      : '';
    return '\n## Work Board (digest)\n\n' + content + staleNote;
  } catch {
    return null;
  }
}

interface Settings {
  dynamicContext?: DynamicContextConfig;
  [key: string]: unknown;
}

/**
 * Check if a dynamic context section is enabled.
 * Defaults to true if not configured (backward compatible).
 */
function isDynamicEnabled(settings: Settings, key: keyof DynamicContextConfig): boolean {
  if (!settings.dynamicContext) return true;
  const val = settings.dynamicContext[key];
  return val !== false;
}

/**
 * Load settings.json and return the settings object.
 */
function loadSettings(): Settings {
  const settingsPath = getSettingsPath();
  if (existsSync(settingsPath)) {
    try {
      return JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch (err) {
      console.error(`⚠️ Failed to parse settings.json: ${err}`);
    }
  }
  return {};
}

// v5.0: loadStartupFiles removed — static files now loaded via @imports in CLAUDE.md.template

interface WorkSession {
  type: 'recent' | 'project';
  name: string;
  title: string;
  status: string;
  timestamp: string;
  stale: boolean;
  objectives?: string[];
  handoff_notes?: string;
  next_steps?: string[];
  isa?: { id: string; status: string; progress: string } | null;
}

/**
 * Every WORK tree this install writes session dirs into, deduped by resolved
 * path (extracted from public PR #1714, @anikinsasha).
 *
 * Sessions do not all land in one tree: `<LIFEOS_DIR>/MEMORY/WORK` is the
 * primary (a symlink into the private USER data repo on this install), and
 * `~/.claude/MEMORY/WORK` is the second tree some sessions create directly.
 * Scanning only one starves this block of exactly the work it exists to
 * surface. Resolving through realpath before deduping matters here: the two
 * candidates ARE the same directory on installs where LIFEOS_DIR sits under
 * ~/.claude, and scanning it twice would double every row.
 */
function getWorkRoots(lifeosDir: string): string[] {
  const candidates = [join(lifeosDir, 'MEMORY', 'WORK'), join(getClaudeDir(), 'MEMORY', 'WORK')];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    let resolved = dir;
    try {
      resolved = realpathSync(dir);
    } catch { /* unresolvable — dedupe on the literal path */ }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(dir);
  }
  return roots;
}

/**
 * Scan recent WORK/ directories (last 48h) for active sessions.
 */
function getRecentWorkSessions(lifeosDir: string): WorkSession[] {
  const workRoots = getWorkRoots(lifeosDir);
  if (workRoots.length === 0) return [];

  let sessionNames: Record<string, string> = {};
  const namesPath = join(lifeosDir, 'MEMORY', 'STATE', 'session-names.json');
  try {
    if (existsSync(namesPath)) {
      sessionNames = JSON.parse(readFileSync(namesPath, 'utf-8'));
    }
  } catch { /* ignore parse errors */ }

  const sessions: WorkSession[] = [];
  const now = Date.now();
  const cutoff48h = 48 * 60 * 60 * 1000;
  const seenSessionIds = new Set<string>();

  try {
    // Newest 30 across BOTH trees. The dir-name prefix is a chronological
    // timestamp, so a descending name sort is a descending time sort and the
    // window `break` below is the real bound — the cap just keeps the scan cheap.
    const allDirs = workRoots
      .flatMap(root =>
        readdirSync(root, { withFileTypes: true })
          .filter(d => d.isDirectory() && /^\d{8}-\d{6}_/.test(d.name))
          .map(d => ({ name: d.name, root })))
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, 30);

    for (const { name: dirName, root: workDir } of allDirs) {
      const match = dirName.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})_(.+)$/);
      if (!match) continue;

      const [, y, mo, d, h, mi, s, slug] = match;
      const dirTime = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).getTime();

      if (now - dirTime > cutoff48h) break;

      const dirPath = join(workDir, dirName);

      // Read metadata from ISA.md frontmatter (v4.1 canonical), legacy PRD.md
      // (v4.0 consolidated, pre-rename), or META.yaml (pre-v4.0 layout).
      let status = 'UNKNOWN';
      let rawTitle = slug.replace(/-/g, ' ');
      let sessionId: string | undefined;
      // Resolve the artifact inside THIS dir's own tree. The shared
      // findArtifactPath() is pinned to one WORK root, so it misresolves every
      // dir that came from the other one.
      let isaPath: string | null = join(dirPath, 'ISA.md');
      if (!existsSync(isaPath)) isaPath = join(dirPath, 'PRD.md');
      if (!existsSync(isaPath)) isaPath = null;
      const metaPath = join(dirPath, 'META.yaml');

      if (isaPath) {
        // v4.0+: Read from ISA.md / PRD.md frontmatter. Modern ISAs carry
        // `phase:`; `status:` is the legacy key, and wins when both are present.
        try {
          const head = readFileSync(isaPath, 'utf-8').substring(0, 600);
          const statusMatch = head.match(/^status:\s*"?(\w+)"?/m);
          const phaseMatch = head.match(/^phase:\s*"?([\w-]+)"?/m);
          const titleMatch = head.match(/^title:\s*"?(.+?)"?\s*$/m);
          const sessionIdMatch = head.match(/^session_id:\s*"?(.+?)"?\s*$/m);
          if (statusMatch) status = statusMatch[1];
          else if (phaseMatch) status = phaseMatch[1];
          if (titleMatch) rawTitle = titleMatch[1];
          if (sessionIdMatch) sessionId = sessionIdMatch[1]?.trim();
        } catch { /* skip */ }
      } else if (existsSync(metaPath)) {
        // Legacy: Read from META.yaml
        try {
          const meta = readFileSync(metaPath, 'utf-8');
          const statusMatch = meta.match(/^status:\s*"?(\w+)"?/m);
          const titleMatch = meta.match(/^title:\s*"?(.+?)"?\s*$/m);
          const sessionIdMatch = meta.match(/^session_id:\s*"?(.+?)"?\s*$/m);
          if (statusMatch) status = statusMatch[1];
          if (titleMatch) rawTitle = titleMatch[1];
          if (sessionIdMatch) sessionId = sessionIdMatch[1]?.trim();
        } catch { /* skip */ }
      } else {
        continue; // No ISA.md / PRD.md / META.yaml — skip
      }

      try {

        // ONE terminal vocabulary. This filter used to hardcode COMPLETED, so a
        // modern ISA sitting at `phase: complete` (or `learn`) kept occupying an
        // ACTIVE WORK slot for 48h after it finished.
        if (isTerminalWorkState(status)) continue;
        if (rawTitle.toLowerCase().startsWith('tasknotification') || rawTitle.length < 10) continue;
        if (sessionId && seenSessionIds.has(sessionId)) continue;
        if (sessionId) seenSessionIds.add(sessionId);

        const title = (sessionId && sessionNames[sessionId]) || rawTitle;

        if (sessions.length >= 8) break;

        let isa: WorkSession['isa'] = null;
        try {
          // v4.1: ISA.md at root; v4.0: PRD.md at root; pre-v4.0: PRD-*.md.
          // isaPath above already covers v4.0/v4.1; fall back to date-stamped
          // PRD-*.md files only when neither ISA.md nor PRD.md is present.
          let artifactFile: string | null = isaPath;
          if (!artifactFile) {
            const files = readdirSync(dirPath).filter(f =>
              (f.startsWith('ISA-') || f.startsWith('PRD-')) && f.endsWith('.md')
            );
            if (files.length > 0) artifactFile = join(dirPath, files[0]);
          }
          if (artifactFile) {
            const isaContent = readFileSync(artifactFile, 'utf-8');
            const idMatch = isaContent.match(/^id:\s*(.+)$/m);
            const statusMatch2 = isaContent.match(/^status:\s*(.+)$/m);
            const verifyMatch = isaContent.match(/^verification_summary:\s*"?(.+?)"?$/m);
            // Modern ISA frontmatter carries slug/phase/progress, not id/status/
            // verification_summary (public PR #2122, @pai-scaffolde).
            const slugMatch2 = isaContent.match(/^slug:\s*(.+)$/m);
            const phaseMatch2 = isaContent.match(/^phase:\s*(.+)$/m);
            const progressMatch2 = isaContent.match(/^progress:\s*"?([^"\n]*)"?/m);
            isa = {
              id: idMatch?.[1]?.trim() || slugMatch2?.[1]?.trim() || 'ISA',
              status: statusMatch2?.[1]?.trim() || phaseMatch2?.[1]?.trim() || 'UNKNOWN',
              progress: verifyMatch?.[1]?.trim() || progressMatch2?.[1]?.trim() || '0/0'
            };
          }
        } catch { /* no artifacts */ }

        sessions.push({
          type: 'recent',
          name: dirName,
          title: title.length > 60 ? title.substring(0, 57) + '...' : title,
          status,
          timestamp: `${y}-${mo}-${d} ${h}:${mi}`,
          stale: false,
          isa
        });
      } catch { /* skip malformed */ }
    }
  } catch (err) {
    console.error(`⚠️ Error scanning WORK dirs: ${err}`);
  }

  return sessions;
}

// MEMORY/STATE/progress/*-progress.json is deliberately NOT read here, and neither the
// "Tracked Projects" block nor the SessionProgress.ts resume/complete tips are emitted:
// nothing writes an active row to that store, so the block was always empty and the tips
// pointed at a store with nothing to resume. ISA frontmatter carries the open/closed
// signal. Recent WORK sessions below still have a producer, so that half stays.
// public issue #1712, @jacobo-ortiz

/** Activity dashboard — recent WORK sessions (last 48h). */
async function checkActiveProgress(lifeosDir: string): Promise<string | null> {
  const recentSessions = getRecentWorkSessions(lifeosDir);
  if (recentSessions.length === 0) return null;

  let summary = '\n📋 ACTIVE WORK:\n';
  summary += '\n  ── Recent Sessions (last 48h) ──\n';
  for (const s of recentSessions) {
    summary += `\n  ⚡ ${s.title}\n`;
    summary += `     ${s.timestamp} | Status: ${s.status}\n`;
    if (s.isa) {
      summary += `     ISA: ${s.isa.id} (${s.isa.status}, ${s.isa.progress})\n`;
    }
  }

  return summary;
}

/** Append {ts, sessionId, channel} for a non-desktop session. Best-effort; never blocks startup. */
function recordSessionChannel(hookInput: unknown): void {
  try {
    const channel = getNotificationChannel();
    if (channel === 'desktop') return;
    const sessionId = (hookInput as { session_id?: string } | null)?.session_id;
    if (!sessionId) return;
    const dir = lifeosPath('MEMORY', 'OBSERVABILITY');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'session-channels.jsonl'), JSON.stringify({ ts: new Date().toISOString(), sessionId, channel }) + '\n');
  } catch { /* observability never breaks a session start */ }
}

async function main() {
  try {
    // A fork carries no distinguishing env var — its stamp (`source: "fork"`)
    // arrives on stdin, so read it before the guard (see lib/subagent.ts).
    // public PR #1958, @theNetworkChuck
    let hookInput: unknown = null;
    try {
      const raw = readFileSync(0, 'utf-8');
      if (raw.trim()) hookInput = JSON.parse(raw);
    } catch { /* best-effort: env-only guard below */ }

    // Subagents don't need dynamic context injection
    if (isSubagentContext(hookInput)) {
      console.error('🤖 Subagent session - skipping context loading');
      process.exit(0);
    }

    const { resetMemoryDelivery } = await import('./lib/memory-reset');
    resetMemoryDelivery(String((hookInput as { session_id?: string } | null)?.session_id ?? ''));
    const lifeosDir = getLifeosDir();

    // Tab reset is handled by KittyEnvPersist.hook.ts (runs before this hook)

    // Record session start time for notification timing. This runs for EVERY
    // channel, remote included — the session did start, and the notification
    // timing that reads this is not the thing being withheld below.
    recordSessionStart();
    console.error('⏱️ Session start time recorded');

    // Session-channel registry (1.9.0, 2026-09-07): every non-desktop session
    // (headless launchd/agent jobs, iMessage, ...) is recorded by id so the
    // usage rollup (UsageAggregator.ts) can split automatic spend from the principal's
    // own work deterministically — transcripts carry no channel field. Desktop
    // sessions are not written: absence from the registry means interactive.
    recordSessionChannel(hookInput);

    // Remote-channel sessions (iMessage, etc. — see lib/notification-channel.ts)
    // serve someone through a bot surface. Injecting the principal's
    // relationship notes, wisdom frames, advisory findings and active work
    // summary into that context is the same class of leak as a desktop /notify
    // fired from a remote turn. One guard here covers every loader below,
    // present and future.
    if (!isDesktopChannel()) {
      console.error(`📵 Remote channel (${getNotificationChannel()}) - skipping dynamic context injection`);
      console.log('\n✅ LifeOS session ready...');
      process.exit(0);
    }

    // Agent SDK hosts (T3 Code) send their own systemPrompt.append in the
    // stream-json initialize request, and the CLI lets it REPLACE the file from
    // --append-system-prompt-file (reproduced 2026-09-27). sdk-ts/sdk-py only:
    // `claude -p` is sdk-cli and its spawners pass the file themselves. After the
    // channel gate on purpose, so bot surfaces never get this.
    // public PR #2240, @pai-scaffolde
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? '';
    const startSource = (hookInput as { source?: unknown } | null)?.source;
    const systemPromptFile = join(lifeosDir, 'LIFEOS_SYSTEM_PROMPT.md');
    if ((entrypoint === 'sdk-ts' || entrypoint === 'sdk-py') && startSource !== 'resume' && existsSync(systemPromptFile)) {
      console.log(`<system-reminder>\nThis ${entrypoint} session's host replaced --append-system-prompt-file, so the LifeOS constitutional layer is not loaded. Before any other tool call or reply, Read ${systemPromptFile} once in full (no offset or limit) and follow it for the rest of the session.\n</system-reminder>`);
    }

    // Load settings for dynamic context controls
    const settings = loadSettings();
    console.error('✅ Loaded settings.json');

    // v5.0: Static startup files now loaded via @imports in CLAUDE.md (native Claude Code mechanism)

    // Load learning readback context
    let learningContext = '';
    if (isDynamicEnabled(settings, 'learningReadback')) {
      // Only the Wisdom Frames load here: the actionable behavioral guidance. Self-rating
      // blocks (performance signals, complaint clusters, failure patterns) stay out of
      // session start, where they prime negatively and cost the most context.
      const wisdomFrames = loadWisdomFrames(lifeosDir);

      learningContext = wisdomFrames
        ? '\n## Learning Context (auto-loaded)\n\n' + wisdomFrames
        : '';

      if (wisdomFrames) {
        console.error(`📚 Loaded learning context: wisdom frames (${learningContext.length} chars)`);
      }
    } else {
      console.error('⏭️ Skipped learning readback (disabled)');
    }

    // Advisory readback: last session's integrity findings, delivered here
    // because SessionEnd — where they are produced — cannot inject context.
    // Emits only on a changed finding set, plus a slow re-announce; steady
    // state is zero characters.
    let advisoryContext = '';
    if (isDynamicEnabled(settings, 'advisoryReadback')) {
      const digest = loadAdvisoryDigest();
      advisoryContext = digest ? '\n## Advisory Findings\n\n' + digest : '';
      if (digest) {
        console.error(`🩺 Loaded advisory digest (${advisoryContext.length} chars)`);
      }
    } else {
      console.error('⏭️ Skipped advisory readback (disabled)');
    }

    // Work board digest — the consumption half of the work system
    let workDigestContext = '';
    if (isDynamicEnabled(settings, 'workDigest')) {
      const digest = loadWorkDigest(lifeosDir);
      workDigestContext = digest ?? '';
      if (digest) {
        console.error(`🗂️ Loaded work board digest (${digest.length} chars)`);
      }
    } else {
      console.error('⏭️ Skipped work digest (disabled)');
    }

    // Inject dynamic context if we have any
    if (learningContext || advisoryContext || workDigestContext) {
      const message = `<system-reminder>
LifeOS Dynamic Context (Auto-loaded at Session Start)
${learningContext ? '\n---\n' + learningContext : ''}${advisoryContext ? '\n---\n' + advisoryContext : ''}${workDigestContext ? '\n---\n' + workDigestContext : ''}
---
Dynamic context loaded. Constitutional rules are in the system prompt (LIFEOS/LIFEOS_SYSTEM_PROMPT.md). Operational procedures are in CLAUDE.md.
</system-reminder>`;

      console.log(message);
      console.log('\n✅ LifeOS dynamic context loaded...');
    } else {
      // Name the enabled-but-empty sources instead of emitting a bare success
      // line: on a fresh install every dynamic source is empty by construction,
      // and a 28-byte "ready" was indistinguishable from the loaders working
      // (public issue #1712, @jacobo-ortiz). Presence is not delivery.
      const emptySources: string[] = [];
      if (isDynamicEnabled(settings, 'learningReadback')) emptySources.push('wisdom-frames');
      if (isDynamicEnabled(settings, 'advisoryReadback')) emptySources.push('advisory-findings');
      const note = emptySources.length
        ? ` (no dynamic context yet — enabled sources empty: ${emptySources.join(', ')})`
        : '';
      console.log(`\n✅ LifeOS session ready...${note}`);
    }

    // Active work summary
    if (isDynamicEnabled(settings, 'activeWorkSummary')) {
      const activeProgress = await checkActiveProgress(lifeosDir);
      if (activeProgress) {
        console.log(activeProgress);
        console.error(`📋 Active work summary loaded (${activeProgress.length} chars)`);
      }
    } else {
      console.error('⏭️ Skipped active work summary (disabled)');
    }

    console.error('✅ LifeOS session initialization complete (v5.0 — static context via @imports)');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error in LoadContext hook:', error);
    process.exit(0); // Non-fatal — don't block session startup
  }
}

main();
