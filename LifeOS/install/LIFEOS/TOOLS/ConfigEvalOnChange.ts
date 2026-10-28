#!/usr/bin/env bun
/**
 * @version 1.2.4
 * ConfigEvalOnChange — runs the DA behavioural-disposition regression suite
 * after a change to a behaviour-defining file, and notifies on regression.
 *
 * Runs detached after a Write/Edit lands on a sentinel file (system prompt, DA/principal identity, CLAUDE.md, OPERATIONAL_PREFERENCES,
 * a hook). Never runs inline in a session — the hook returns immediately.
 *
 * Billing: routes through the Assay runner, which uses Inference.ts (subscription).
 * The spawner deletes ANTHROPIC_API_KEY/AUTH_TOKEN so no API billing is possible.
 *
 * Single-flight: a lockfile prevents overlapping runs when several sentinel files
 * change together. Regression (suite below threshold) POSTs a voice/Pulse notice.
 */

import { mkdirSync, writeFileSync, rmSync, readFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runSuite } from '../../skills/Assay/Tools/EvalRunner.ts';
import { PULSE_BASE } from '../PULSE/endpoint';
import { assayUserDir, getClaudeDir } from './Paths'; // public issue #1974 @sabo961, PR #1918 @PigLardLord

const CLAUDE_ROOT = getClaudeDir();
const RESULTS_DIR = join(CLAUDE_ROOT, 'LIFEOS', 'MEMORY', 'STATE', 'Evals-Results');
const LOCK = join(RESULTS_DIR, '.config-eval.lock');
const DIRTY_MARKER_DIR = resolve(getClaudeDir(), 'LIFEOS/MEMORY/STATE/config-eval-dirty');
const LOG = join(CLAUDE_ROOT, 'LIFEOS', 'MEMORY', 'OBSERVABILITY', 'config-eval-fires.jsonl');
// Which suite to fire. Identity-bound suites live in the USER customization
// layer (never the public skill tree), so the name is USER-configured too:
// LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Assay/config.json {"config_change_suite": "..."}.
// Default is the generic core-dispositions suite that ships with the skill —
// a fresh install fires a suite that actually exists (Forge 7.10.2 audit).
//
// Was 'core-behaviors' until public issue #1752, @ozdreamwalk: that suite is a
// legacy v1 `tasks:` file EvalRunner cannot execute, so this path errored on
// every single config change and no config edit was ever actually verified.
// core-behaviors stays in the tree as SKILL.md's anti-pattern example.
function resolveSuite(): string {
  try {
    const cfgPath = join(assayUserDir(join(CLAUDE_ROOT, 'LIFEOS')), 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    if (typeof cfg.config_change_suite === 'string' && cfg.config_change_suite.length > 0) return cfg.config_change_suite;
  } catch { /* no user config — generic default */ }
  return 'core-dispositions';
}
const SUITE = resolveSuite();


interface DirtyMarker {
  path: string;
  content_hash: string;
  ts: string;
}

function collectDirtyMarkers(): DirtyMarker[] {
  if (!existsSync(DIRTY_MARKER_DIR)) return [];
  try {
    const files = readdirSync(DIRTY_MARKER_DIR);
    const markers: DirtyMarker[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const markerPath = join(DIRTY_MARKER_DIR, file);
      try {
        const content = readFileSync(markerPath, 'utf8');
        markers.push(JSON.parse(content));
        rmSync(markerPath); // Delete after reading
      } catch { /* skip corrupted markers */ }
    }
    return markers;
  } catch {
    return [];
  }
}

function log(payload: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...payload }) + '\n');
  } catch { /* best-effort */ }
}


async function notify(message: string): Promise<void> {
  try {
    await fetch(`${PULSE_BASE}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // voice_enabled must be explicit: /notify defaults voice ON, and background/cadence jobs never voice (2026-08-14)
      body: JSON.stringify({ message, voice_enabled: false }),
      signal: AbortSignal.timeout(4000),
    });
  } catch { /* Pulse may be down; the latest.json + log still record the result */ }
}

// Exit status: 0 verified and passing, 1 the suite ran and regressed, 2 the suite could not run (change unverified),
// 3 skipped because another run holds the lock. A skip is unresolved, never a pass: the run that holds the lock may
// not cover this change's content.
export function exitCodeFor(outcome: 'pass' | 'regression' | 'error' | 'skipped'): 0 | 1 | 2 | 3 {
  return outcome === 'error' ? 2 : outcome === 'regression' ? 1 : outcome === 'skipped' ? 3 : 0;
}

async function main(): Promise<0 | 1 | 2 | 3> {
  let outcome: 'pass' | 'regression' | 'error' | 'skipped' = 'pass';
  const trigger = process.argv[2] ?? 'unknown';
  let dirtyMarkers: DirtyMarker[] = [];

  mkdirSync(RESULTS_DIR, { recursive: true });
  // Single-flight: stale lock older than 10 min is reclaimed. The 'wx' flag is
  // load-bearing — an existsSync-then-write let two sentinel files edited in the
  // same instant both pass the check, both run the suite, and both notify.
  // ported from public PR #1737, @elhoim
  try {
    writeFileSync(LOCK, new Date().toISOString(), { flag: 'wx' });
  } catch {
    let stale = true;
    try {
      const age = Date.now() - Date.parse(readFileSync(LOCK, 'utf8').trim() || '');
      stale = !Number.isFinite(age) || age >= 10 * 60_000;
    } catch { /* unreadable lock — treat as stale and reclaim */ }
    if (!stale) {
      log({ event: 'skip-locked', trigger });
      return exitCodeFor('skipped');
    }
    rmSync(LOCK, { force: true });
    try {
      writeFileSync(LOCK, new Date().toISOString(), { flag: 'wx' });
    } catch {
      // Another run reclaimed the stale lock first; it owns this fire.
      log({ event: 'skip-locked', trigger });
      return exitCodeFor('skipped');
    }
  }

  try {
    const result = await runSuite(SUITE);
    // Collect dirty markers that arrived during the lock
    dirtyMarkers = collectDirtyMarkers();
    const tested_hashes = dirtyMarkers.length > 0 ? dirtyMarkers.map((m) => ({ path: m.path, content_hash: m.content_hash })) : undefined;
    log({
      event: 'run',
      trigger,
      passed: result.passed,
      score: result.score,
      pass_to_k: result.pass_to_k,
      summary: result.summary,
      tested_hashes,
    });

    if (!result.passed) {
      outcome = 'regression';
      const worst = [...result.cases].sort((a, b) => a.mean_score - b.mean_score)[0];
      await notify(
        `Behavioural regression after editing ${trigger}: ${SUITE} at pass^k ${(result.pass_to_k * 100).toFixed(0)}%, mean ${(result.score * 100).toFixed(0)}% (${result.summary}). Weakest: ${worst?.id ?? 'n/a'}.`,
      );
    }
  } catch (e) {
    // Notify, don't just log. A suite that cannot RUN is the same operational
    // fact as a suite that fails: the config change went unverified. Logging to
    // a JSONL nobody tails makes a permanently-broken suite look exactly like a
    // clean pass on every config edit. ported from public PR #1737, @elhoim
    outcome = 'error';
    const msg = (e as Error)?.message ?? String(e);
    log({ event: 'error', trigger, error: msg });
    await notify(`Behavioural eval could not run after editing ${trigger}: ${SUITE} errored (${msg}). The change is unverified.`);
  } finally {
    try { rmSync(LOCK, { force: true }); } catch { /* best-effort */ }
    
    // Check for dirty markers and fire trailing run if any exist
    if (dirtyMarkers.length > 0) {
      try {
        log({ event: 'trailing-run-queued', dirty_marker_count: dirtyMarkers.length });
        const { spawn } = await import('node:child_process');
        const runner = resolve(getClaudeDir(), 'LIFEOS/TOOLS/ConfigEvalOnChange.ts');
        const env = { ...process.env };
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_AUTH_TOKEN;
        delete env.CLAUDECODE;
        const proc = spawn('bun', [runner, 'trailing-after-' + trigger], { env, stdio: 'ignore', detached: true });
        proc.unref();
      } catch { /* best-effort */ }
    }
  }
  return exitCodeFor(outcome);
}

if (import.meta.main) {
  main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(`[ConfigEvalOnChange] fatal: ${String(e)}`); process.exitCode = 2; });
}
