#!/usr/bin/env bun
/**
 * HerdrDisplayAgent.ts — who is working in a herdr pane right now, for the agents row's
 * first line.
 *
 * The row used to name the assistant, then the carrier family ("Opus"), and both
 * read the same on every row, so they told the reader nothing. A row earns its space by naming the
 * worker: the delegates running in that session, or the carrier only when the session is
 * working alone.
 *
 * The source is herdr's own `$agents` token. The LifeOSHooks plugin writes it from its live
 * in-memory roster whenever the set changes, and that roster is the only source that is
 * actually right: `subagent-events.jsonl` and `agent-starts.json` both carry orphaned starts
 * going back months, and two panes showing a running delegate at the time of writing had no
 * row in either file. Reading the token back has a second benefit that decided the design —
 * it works in sessions that started before this file existed, because the plugin writing the
 * token is already running inside all of them, and a plugin change would have reached none.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { agentLaneTag, laneLabel, fitWidth, displayWidth } from '../../hooks/lib/route-label';
import { syncHerdrWorkers } from '../../hooks/lib/herdr-tabs';

/** The row clips at the sidebar edge; this is the room the first line's name has. */
export const MAX_AGENT_WIDTH = 14;

export interface Delegate { type: string; model?: string }

const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, '').trim();

/**
 * Fit a primary worker name plus its tail ("x2", "+3") into the row.
 *
 * The order matters and cost a live regression to get right. A name like
 * `Explore⇢ant:Opus` does not fit, and an earlier draft dropped the type and kept the lane —
 * so the row read `ant:Opus` while Explore was the thing actually running, which is the
 * carrier-shaped label this whole change exists to kill. The type is what distinguishes one
 * row from another, so the type wins: the lane is appended only when the whole thing fits,
 * and replaces the type only when the type alone is too long for the row (`general-purpose`,
 * where the lane is the more informative half anyway).
 */
function compact(name: string, suffix: string): string {
  const room = Math.max(1, MAX_AGENT_WIDTH - displayWidth(suffix));
  const fit = (s: string) => fitWidth(s + suffix, MAX_AGENT_WIDTH);
  if (displayWidth(name) <= room) return fit(name);
  const arrow = name.indexOf('⇢');
  if (arrow < 0) return fit(fitWidth(name, room));
  const type = name.slice(0, arrow);
  const lane = name.slice(arrow + 1);
  if (displayWidth(type) <= room) return fit(type);
  if (displayWidth(lane) <= room) return fit(lane);
  return fit(fitWidth(type, room));
}

/** Turn a counted roster into the row's label: the first worker, its repeat count, and how
 * many other workers are running behind it. */
function label(counts: Map<string, number>, total: number, carrier: string): string {
  if (!counts.size) return fitWidth(clean(carrier) || 'Assistant', MAX_AGENT_WIDTH);
  const [name, count] = counts.entries().next().value!;
  const others = total - count;
  return compact(name, `${count > 1 ? ` x${count}` : ''}${others > 0 ? ` +${others}` : ''}`);
}

/** The label for a known delegate list. Kept for callers that hold the roster directly. */
export function displayAgent(delegates: readonly Delegate[], carrier: string): string {
  const counts = new Map<string, number>();
  for (const d of delegates) {
    const lane = d.model && d.model !== 'inherited' ? laneLabel(d.model) : undefined;
    const name = clean(agentLaneTag(d.type, lane));
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return label(counts, delegates.length, carrier);
}

/**
 * The label for herdr's `$agents` token, whose shape is `agentsLabel` in
 * hooks/lib/herdr-tabs.ts: `→ Sol ×2 · general-purpose⇢oai:Sol`. An empty or absent token
 * means the session is working alone, which is the carrier.
 */
export function displayAgentFromToken(token: string | null | undefined, carrier: string): string {
  const body = clean(token ?? '').replace(/^→\s*/, '');
  const counts = new Map<string, number>();
  let total = 0;
  for (const raw of body.split('·')) {
    const entry = clean(raw);
    if (!entry) continue;
    const m = entry.match(/^(.*?)\s*[×x](\d+)$/);
    const name = clean(m ? m[1] : entry);
    const count = m ? Math.max(1, parseInt(m[2], 10) || 1) : 1;
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + count);
    total += count;
  }
  return label(counts, total, carrier);
}

function herdrBin(): string {
  const local = join(process.env.HOME || '', '.local', 'bin', 'herdr');
  return existsSync(local) ? local : 'herdr';
}

/** Read the pane's `$agents` token back from herdr. Null when herdr cannot answer — absent,
 * down, or slow — which the caller reads as "carrier", never as an error. */
export function paneAgentsToken(paneId: string): string | null {
  if (!/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/.test(paneId)) return null;
  try {
    const raw = execFileSync(herdrBin(), ['pane', 'get', paneId], {
      encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Delegates (`$agents`, from the plugin) and Worker.ts legs (`$workers`, from the codex
    // helper) share one label shape, so the row's name is read from both, delegates first.
    const tokens = JSON.parse(raw)?.result?.pane?.tokens;
    // The workers line is corrected against the live pids first, so a killed leg stops being named.
    const workers = syncHerdrWorkers(paneId, typeof tokens?.workers === 'string' ? tokens.workers : '');
    const parts = [tokens?.agents, workers]
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.replace(/^→\s*/, ''));
    return parts.length ? `→ ${parts.join(' · ')}` : null;
  } catch {
    return null;
  }
}

export function paneDisplayAgent(paneId: string, carrier: string): string {
  return displayAgentFromToken(paneAgentsToken(paneId), carrier);
}

if (import.meta.main) {
  const [paneId, carrier] = process.argv.slice(2);
  try { console.log(paneDisplayAgent(paneId ?? '', carrier ?? '')); }
  catch { console.log(displayAgentFromToken('', carrier ?? '')); }
}
