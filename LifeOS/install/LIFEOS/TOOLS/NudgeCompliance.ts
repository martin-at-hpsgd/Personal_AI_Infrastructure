#!/usr/bin/env bun
/**
 * @version 1.0.1
 * NudgeCompliance.ts — are skill-routing nudges actually FOLLOWED, split by
 * session carrier rung (2026-08-18).
 *
 * The capability-composition instrument for the carrier-default trial. AlgorithmNudge
 * logs every skill it suggests; the skill system logs every skill that actually ran.
 * Neither alone answers "does a below-pin core loop still route to the right skill" —
 * this joins them and attributes each fire to the carrier that was flying at the time.
 *
 * Sources (all append-only JSONL, read whole — they are small):
 *   MEMORY/OBSERVABILITY/algo-nudge-routing.jsonl  fires  {ts, session, fired[]}
 *   MEMORY/SKILLS/execution.jsonl                  runs   {ts, skill, workflow, status}
 *   MEMORY/OBSERVABILITY/session-costs.jsonl       carrier {sessionId, primaryModel, ...}
 *
 * Join: a fire COMPLIED when a skill run with the same name lands in
 * [fire.ts, fire.ts + 2h]. Carrier comes from the routing log's 8-char session
 * prefix matched against a full sessionId. Uppercase pseudo-skills (DEPTH,
 * DESIGN-CLASS, DOCTRINE-CLASS) are directives, not routings — counted, never scored.
 *
 * Read-only. Telemetry, not governance — no threshold, no gate, no write.
 *
 * Usage:
 *   bun NudgeCompliance.ts             # last 14 days
 *   bun NudgeCompliance.ts --days 30
 *   bun NudgeCompliance.ts --json
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getLifeosDir } from './Paths'; // public issue #1974 @sabo961, PR #1918 @PigLardLord

// Normalize env path vars that Claude Code injects without shell expansion (LifeOS#1404)
for (const k of ['LIFEOS_DIR']) {
  const v = process.env[k];
  if (v && /^\$\{?HOME\}?(\/|$)/.test(v)) process.env[k] = v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? '~');
}

const BASE_DIR = getLifeosDir();
const ROUTING_LOG = join(BASE_DIR, 'MEMORY', 'OBSERVABILITY', 'algo-nudge-routing.jsonl');
const EXECUTION_LOG = join(BASE_DIR, 'MEMORY', 'SKILLS', 'execution.jsonl');
const COSTS_LOG = join(BASE_DIR, 'MEMORY', 'OBSERVABILITY', 'session-costs.jsonl');

const COMPLIANCE_WINDOW_MS = 2 * 60 * 60 * 1000;
const CAVEAT = 'Trend instrument only: task mixes differ across carriers, and a skill invoked without its nudge firing counts nowhere — never read this as a verdict.';

/** Directive pseudo-skills the nudge hook emits — routing advice, not a skill to run. */
const PSEUDO_SKILLS = new Set(['DEPTH', 'DESIGN-CLASS', 'DOCTRINE-CLASS']);
const RUNGS = ['fable', 'opus', 'sonnet', 'haiku', 'unknown'] as const;
type Rung = (typeof RUNGS)[number];

interface RoutingRow { ts: string; session?: string; fired?: string[] }
interface ExecutionRow { ts: string; skill?: string }
interface CostRow { sessionId?: string; primaryModel?: string; firstTimestamp?: string; lastTimestamp?: string }

interface Fire {
  tsMs: number;
  session: string;
  skill: string;      // as logged, before normalization
  pseudo: boolean;
  rung: Rung;
  complied: boolean;
}

interface Tally { fires: number; complied: number; directives: number }

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip malformed */ }
  }
  return out;
}

/** Skill names join case-insensitively and ignore the private-skill underscore. */
function normalizeSkill(name: string): string {
  return name.replace(/^_+/, '').toLowerCase();
}

/** A `fired` entry is "<skill>:<trigger phrase>" — the trigger may itself contain colons. */
function skillOf(fired: string): string {
  const i = fired.indexOf(':');
  return (i === -1 ? fired : fired.slice(0, i)).trim();
}

/** Pseudo-skills are the known set plus anything ALL-CAPS with no leading underscore. */
function isPseudo(skill: string): boolean {
  return PSEUDO_SKILLS.has(skill) || (!skill.startsWith('_') && /^[A-Z0-9][A-Z0-9-]*$/.test(skill));
}

function rungOf(model: string | undefined): Rung {
  const m = (model ?? '').toLowerCase();
  for (const r of RUNGS) if (r !== 'unknown' && m.includes(r)) return r;
  return 'unknown';
}

/**
 * The routing log stores only the first 8 chars of a session id. Resolve them against
 * full session ids, preferring the session whose lifetime actually contains the fire.
 */
function buildCarrierResolver(costs: CostRow[]) {
  const byPrefix = new Map<string, CostRow[]>();
  for (const c of costs) {
    if (!c.sessionId) continue;
    const p = c.sessionId.slice(0, 8);
    const bucket = byPrefix.get(p);
    if (bucket) bucket.push(c); else byPrefix.set(p, [c]);
  }
  return {
    prefixes: byPrefix.size,
    resolve(session: string, tsMs: number): { rung: Rung; matched: boolean } {
      const candidates = byPrefix.get(session.slice(0, 8));
      if (!candidates || candidates.length === 0) return { rung: 'unknown', matched: false };
      let best: CostRow | undefined;
      for (const c of candidates) {
        const start = Date.parse(c.firstTimestamp ?? '');
        const end = Date.parse(c.lastTimestamp ?? c.firstTimestamp ?? '');
        if (Number.isFinite(start) && Number.isFinite(end) && tsMs >= start && tsMs <= end) { best = c; break; }
      }
      if (!best) {
        // No lifetime contains the fire: take the latest session that had already started.
        const started = candidates
          .filter(c => Date.parse(c.firstTimestamp ?? '') <= tsMs)
          .sort((a, b) => Date.parse(b.firstTimestamp ?? '') - Date.parse(a.firstTimestamp ?? ''));
        best = started[0] ?? candidates[0];
      }
      return { rung: rungOf(best?.primaryModel), matched: true };
    },
  };
}

/** Sorted run timestamps per normalized skill, for a binary-search window probe. */
function buildExecutionIndex(rows: ExecutionRow[]) {
  const index = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.skill) continue;
    const ms = Date.parse(r.ts ?? '');
    if (!Number.isFinite(ms)) continue;
    const key = normalizeSkill(r.skill);
    const bucket = index.get(key);
    if (bucket) bucket.push(ms); else index.set(key, [ms]);
  }
  for (const list of index.values()) list.sort((a, b) => a - b);
  return index;
}

function ranWithin(index: Map<string, number[]>, skill: string, fromMs: number, toMs: number): boolean {
  const list = index.get(normalizeSkill(skill));
  if (!list) return false;
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < fromMs) lo = mid + 1; else hi = mid;
  }
  return lo < list.length && list[lo]! <= toMs;
}

function pct(complied: number, fires: number): string {
  return fires === 0 ? '—' : ((complied / fires) * 100).toFixed(1) + '%';
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const daysArg = args.indexOf('--days');
  const days = daysArg !== -1 && args[daysArg + 1] ? Number(args[daysArg + 1]) : 14;
  if (!Number.isFinite(days) || days <= 0) {
    console.error('--days must be a positive number');
    process.exit(1);
  }

  const routing = readJsonl<RoutingRow>(ROUTING_LOG);
  const executions = readJsonl<ExecutionRow>(EXECUTION_LOG);
  const costs = readJsonl<CostRow>(COSTS_LOG);

  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const carriers = buildCarrierResolver(costs);
  const execIndex = buildExecutionIndex(executions);

  const fires: Fire[] = [];
  const sessionsSeen = new Set<string>();
  const sessionsMatched = new Set<string>();
  let rowsInWindow = 0;

  for (const row of routing) {
    const tsMs = Date.parse(row.ts ?? '');
    if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
    if (!Array.isArray(row.fired) || row.fired.length === 0) continue;
    rowsInWindow += 1;
    const session = row.session ?? '';
    sessionsSeen.add(session);
    const { rung, matched } = carriers.resolve(session, tsMs);
    if (matched) sessionsMatched.add(session);
    for (const entry of row.fired) {
      const skill = skillOf(entry);
      if (!skill) continue;
      const pseudo = isPseudo(skill);
      fires.push({
        tsMs,
        session,
        skill,
        pseudo,
        rung,
        complied: pseudo ? false : ranWithin(execIndex, skill, tsMs, tsMs + COMPLIANCE_WINDOW_MS),
      });
    }
  }

  const byRung = new Map<Rung, Tally>(RUNGS.map(r => [r, { fires: 0, complied: 0, directives: 0 }]));
  const bySkill = new Map<string, Tally>();
  for (const f of fires) {
    const rt = byRung.get(f.rung)!;
    if (f.pseudo) { rt.directives += 1; continue; }
    rt.fires += 1;
    if (f.complied) rt.complied += 1;
    const st = bySkill.get(f.skill) ?? { fires: 0, complied: 0, directives: 0 };
    st.fires += 1;
    if (f.complied) st.complied += 1;
    bySkill.set(f.skill, st);
  }

  const totals: Tally = { fires: 0, complied: 0, directives: 0 };
  for (const t of byRung.values()) {
    totals.fires += t.fires;
    totals.complied += t.complied;
    totals.directives += t.directives;
  }

  const attributedFires = fires.filter(f => !f.pseudo && f.rung !== 'unknown').length;
  const topSkills = [...bySkill.entries()]
    .sort((a, b) => b[1].fires - a[1].fires || a[0].localeCompare(b[0]))
    .slice(0, 10);

  if (asJson) {
    console.log(JSON.stringify({
      window_days: days,
      routing_rows_in_window: rowsInWindow,
      execution_rows_total: executions.length,
      cost_sessions_total: costs.length,
      skill_fires: totals.fires,
      directive_fires: totals.directives,
      complied: totals.complied,
      compliance_pct: totals.fires === 0 ? null : Number(((totals.complied / totals.fires) * 100).toFixed(1)),
      join: {
        sessions_seen: sessionsSeen.size,
        sessions_matched_to_carrier: sessionsMatched.size,
        skill_fires_attributed: attributedFires,
        skill_fires_unattributed: totals.fires - attributedFires,
        attribution_pct: totals.fires === 0 ? null : Number(((attributedFires / totals.fires) * 100).toFixed(1)),
      },
      by_rung: RUNGS.map(r => {
        const t = byRung.get(r)!;
        return { rung: r, fires: t.fires, complied: t.complied, compliance_pct: t.fires === 0 ? null : Number(((t.complied / t.fires) * 100).toFixed(1)), directive_fires: t.directives };
      }),
      by_skill: topSkills.map(([skill, t]) => ({ skill, fires: t.fires, complied: t.complied, compliance_pct: Number(((t.complied / t.fires) * 100).toFixed(1)) })),
      caveat: CAVEAT,
    }, null, 2));
    console.error(CAVEAT);
    return;
  }

  console.log(`\n  Nudge compliance — last ${days}d · ${rowsInWindow} routing rows · ${totals.fires} skill fires · ${totals.directives} directive fires\n`);
  console.log('  ' + 'rung'.padEnd(10) + 'fires'.padStart(7) + 'complied'.padStart(10) + 'compliance'.padStart(12) + 'directives'.padStart(12));
  console.log('  ' + '─'.repeat(51));
  for (const r of RUNGS) {
    const t = byRung.get(r)!;
    if (t.fires === 0 && t.directives === 0) continue;
    console.log('  ' + r.padEnd(10) + String(t.fires).padStart(7) + String(t.complied).padStart(10) + pct(t.complied, t.fires).padStart(12) + String(t.directives).padStart(12));
  }
  console.log('  ' + '─'.repeat(51));
  console.log('  ' + 'ALL'.padEnd(10) + String(totals.fires).padStart(7) + String(totals.complied).padStart(10) + pct(totals.complied, totals.fires).padStart(12) + String(totals.directives).padStart(12));

  console.log(`\n  Join: ${sessionsMatched.size}/${sessionsSeen.size} sessions resolved to a carrier · ` +
    `${attributedFires}/${totals.fires} skill fires attributed (${pct(attributedFires, totals.fires)}) · ` +
    `${executions.length} execution rows on file`);

  if (topSkills.length > 0) {
    console.log('\n  Top skills by nudge fires\n');
    console.log('  ' + 'skill'.padEnd(24) + 'fires'.padStart(7) + 'complied'.padStart(10) + 'compliance'.padStart(12));
    console.log('  ' + '─'.repeat(53));
    for (const [skill, t] of topSkills) {
      console.log('  ' + skill.slice(0, 23).padEnd(24) + String(t.fires).padStart(7) + String(t.complied).padStart(10) + pct(t.complied, t.fires).padStart(12));
    }
  }

  console.log(`\n  ${CAVEAT}\n`);
}

main();
