#!/usr/bin/env bun
/**
 * @version 1.0.1
 * RungBurn.ts — main-loop vs sidechain token split, by model (2026-08-18).
 *
 * Answers one question: what fraction of subscription burn is the MAIN LOOP
 * versus SIDECHAINS (subagents), broken out by model? That number is the
 * kill-test for any proposed carrier-default change — if the main loop is a
 * small slice of total burn, moving its rung down saves little.
 *
 * Source: the harness's own transcripts under ~/.claude/projects/. Every
 * assistant message carries a real `usage` block; `isSidechain` marks subagent
 * rows, and per-session `subagents/agent-*.jsonl` files are sidechain by
 * construction. Files are STREAMED line by line — the corpus is multi-GB.
 *
 * Rows are deduped by message id: resuming or compacting a session copies the
 * parent transcript into a new file, so the same assistant message appears in
 * several files and would otherwise be counted more than once.
 *
 * Read-only. Telemetry, not governance — it writes nothing and gates nothing.
 *
 * Usage:
 *   bun RungBurn.ts              # last 7 days
 *   bun RungBurn.ts --days 30    # last 30 days
 *   bun RungBurn.ts --json       # machine-readable
 */

import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { getClaudeDir } from './Paths'; // public issue #1974 @sabo961, PR #1918 @PigLardLord

const PROJECTS = join(getClaudeDir(), 'projects');

/**
 * Relative consumption weights, USD per million tokens, by rung.
 * These are NOT a bill: subscription billing is quota-based, not metered. They
 * exist only to make one token class comparable to another so a SHARE can be
 * computed (an output token costs far more than a cache-read token, and a
 * fable token far more than a haiku one). Unknown models are weighted as opus
 * and counted in `unknownModels`.
 */
const WEIGHTS = {
  fable:  { input: 30, output: 150, cacheWrite: 37.5, cacheRead: 3 },
  opus:   { input: 15, output: 75,  cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3,  output: 15,  cacheWrite: 3.75, cacheRead: 0.3 },
  haiku:  { input: 1,  output: 5,   cacheWrite: 1.25, cacheRead: 0.1 },
} as const;

type Rung = keyof typeof WEIGHTS;
type Scope = 'main' | 'sidechain';

interface Bucket {
  scope: Scope;
  model: string;
  rung: Rung;
  messages: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

interface Skips {
  filesOldByMtime: number;
  filesUnreadable: number;
  linesUnparsed: number;
  rowsNoUsage: number;
  rowsNoTimestamp: number;
  rowsOutsideWindow: number;
  rowsDuplicate: number;
}

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const daysArg = argv.indexOf('--days');
const days = daysArg !== -1 ? Number(argv[daysArg + 1]) : 7;
if (!Number.isFinite(days) || days <= 0) {
  console.error('RungBurn: --days must be a positive number');
  process.exit(2);
}
const cutoff = Date.now() - days * 86_400_000;

// ── transcript discovery ──────────────────────────────────────────────────
/** Session transcripts plus their subagent transcripts, newer than the cutoff. */
function findTranscripts(skips: Skips): { path: string; sidechainFile: boolean }[] {
  const out: { path: string; sidechainFile: boolean }[] = [];

  const consider = (path: string, sidechainFile: boolean) => {
    // A file untouched since before the window cannot hold a row inside it.
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      skips.filesUnreadable++;
      return;
    }
    if (mtime < cutoff) { skips.filesOldByMtime++; return; }
    out.push({ path, sidechainFile });
  };

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(PROJECTS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }

  for (const project of projectDirs) {
    const projectPath = join(PROJECTS, project);
    let entries;
    try {
      entries = readdirSync(projectPath, { withFileTypes: true });
    } catch { skips.filesUnreadable++; continue; }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        consider(join(projectPath, entry.name), false);
        continue;
      }
      if (!entry.isDirectory()) continue;
      // <session-uuid>/subagents/agent-*.jsonl — sidechain by construction.
      const subDir = join(projectPath, entry.name, 'subagents');
      let subs;
      try {
        subs = readdirSync(subDir, { withFileTypes: true });
      } catch { continue; }
      for (const s of subs) {
        if (s.isFile() && s.name.endsWith('.jsonl')) consider(join(subDir, s.name), true);
      }
    }
  }
  return out;
}

// ── streaming ─────────────────────────────────────────────────────────────
async function* readLines(path: string): AsyncGenerator<string> {
  const stream = Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf('\n', start)) !== -1) {
      yield buf.slice(start, nl);
      start = nl + 1;
    }
    buf = buf.slice(start);
  }
  buf += decoder.decode();
  if (buf.length) yield buf;
}

function rungOf(model: string): { rung: Rung; known: boolean } {
  const m = model.toLowerCase();
  for (const r of ['fable', 'opus', 'sonnet', 'haiku'] as Rung[]) {
    if (m.includes(r)) return { rung: r, known: true };
  }
  return { rung: 'opus', known: false }; // unknown → opus weights, flagged
}

function weighted(b: { input: number; output: number; cacheWrite: number; cacheRead: number }, rung: Rung): number {
  const w = WEIGHTS[rung];
  return (b.input * w.input + b.output * w.output + b.cacheWrite * w.cacheWrite + b.cacheRead * w.cacheRead) / 1e6;
}

// ── scan ──────────────────────────────────────────────────────────────────
const skips: Skips = {
  filesOldByMtime: 0, filesUnreadable: 0, linesUnparsed: 0,
  rowsNoUsage: 0, rowsNoTimestamp: 0, rowsOutsideWindow: 0, rowsDuplicate: 0,
};

const files = findTranscripts(skips);
const buckets = new Map<string, Bucket>();
const seenMessageIds = new Set<string>();
const unknownModels = new Set<string>();

for (const { path, sidechainFile } of files) {
  try {
    for await (const line of readLines(path)) {
      if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
      let row: any;
      try { row = JSON.parse(line); } catch { skips.linesUnparsed++; continue; }

      const usage = row?.message?.usage;
      if (row?.type !== 'assistant' || !usage) { if (row?.type === 'assistant') skips.rowsNoUsage++; continue; }

      const ts = row.timestamp ? Date.parse(row.timestamp) : NaN;
      if (!Number.isFinite(ts)) { skips.rowsNoTimestamp++; continue; }
      if (ts < cutoff) { skips.rowsOutsideWindow++; continue; }

      const id = row?.message?.id;
      if (typeof id === 'string') {
        if (seenMessageIds.has(id)) { skips.rowsDuplicate++; continue; }
        seenMessageIds.add(id);
      }

      const model = String(row?.message?.model ?? 'unknown');
      const { rung, known } = rungOf(model);
      if (!known) unknownModels.add(model);
      const scope: Scope = sidechainFile || row.isSidechain === true ? 'sidechain' : 'main';

      const key = `${scope}|${model}`;
      let b = buckets.get(key);
      if (!b) {
        b = { scope, model, rung, messages: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
        buckets.set(key, b);
      }
      b.messages++;
      b.input += usage.input_tokens ?? 0;
      b.output += usage.output_tokens ?? 0;
      b.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      b.cacheRead += usage.cache_read_input_tokens ?? 0;
    }
  } catch {
    skips.filesUnreadable++;
  }
}

// ── numbers ───────────────────────────────────────────────────────────────
const rows = [...buckets.values()]
  .map((b) => ({ ...b, weighted: weighted(b, b.rung) }))
  .sort((a, b) => (a.scope === b.scope ? b.weighted - a.weighted : a.scope === 'main' ? -1 : 1));

const total = rows.reduce((s, r) => s + r.weighted, 0);
const mainTotal = rows.filter((r) => r.scope === 'main').reduce((s, r) => s + r.weighted, 0);
const mainShare = total > 0 ? (mainTotal / total) * 100 : 0;

// Counterfactual: recompute main-loop fable rows at opus weights, hold all else.
const mainFableNow = rows.filter((r) => r.scope === 'main' && r.rung === 'fable').reduce((s, r) => s + r.weighted, 0);
const mainFableAtOpus = rows
  .filter((r) => r.scope === 'main' && r.rung === 'fable')
  .reduce((s, r) => s + weighted(r, 'opus'), 0);
const swapReduction = total > 0 ? ((mainFableNow - mainFableAtOpus) / total) * 100 : 0;

// ── output ────────────────────────────────────────────────────────────────
const CAVEAT =
  'Caveat: subscription billing is quota-based, not metered. The weights are relative consumption factors used only to compute shares — not a dollar bill.';

if (asJson) {
  console.log(JSON.stringify({
    days, cutoff: new Date(cutoff).toISOString(), filesScanned: files.length,
    rows, totals: { weighted: total, mainWeighted: mainTotal, mainSharePct: mainShare },
    fableToOpusMainLoop: { currentWeighted: mainFableNow, atOpusWeighted: mainFableAtOpus, totalBurnReductionPct: swapReduction },
    unknownModels: [...unknownModels], skipped: skips, caveat: CAVEAT,
  }, null, 2));
  process.exit(0);
}

const num = (n: number) => n.toLocaleString('en-US');
const cols = [
  { h: 'SCOPE', w: 9, get: (r: typeof rows[number]) => r.scope },
  { h: 'MODEL', w: 24, get: (r: typeof rows[number]) => r.model },
  { h: 'MSGS', w: 8, get: (r: typeof rows[number]) => num(r.messages), right: true },
  { h: 'OUTPUT', w: 13, get: (r: typeof rows[number]) => num(r.output), right: true },
  { h: 'INPUT', w: 12, get: (r: typeof rows[number]) => num(r.input), right: true },
  { h: 'CACHE-W', w: 15, get: (r: typeof rows[number]) => num(r.cacheWrite), right: true },
  { h: 'CACHE-R', w: 16, get: (r: typeof rows[number]) => num(r.cacheRead), right: true },
  { h: 'WEIGHTED', w: 11, get: (r: typeof rows[number]) => r.weighted.toFixed(2), right: true },
  { h: 'SHARE', w: 8, get: (r: typeof rows[number]) => (total > 0 ? ((r.weighted / total) * 100).toFixed(1) + '%' : '—'), right: true },
];

const line = (cells: string[]) =>
  cells.map((c, i) => (cols[i].right ? c.padStart(cols[i].w) : c.padEnd(cols[i].w))).join(' ');

console.log(`\nRungBurn — last ${days} day(s), ${files.length} transcript file(s) in window\n`);
console.log(line(cols.map((c) => c.h)));
console.log('-'.repeat(cols.reduce((s, c) => s + c.w + 1, -1)));
if (rows.length === 0) console.log('(no assistant rows with usage in window)');
for (const r of rows) console.log(line(cols.map((c) => c.get(r))));

console.log(`\nmain-loop share of weighted burn: ${mainShare.toFixed(1)}%`);
console.log(`sidechain share of weighted burn: ${(100 - mainShare).toFixed(1)}%`);
console.log(`if the main loop moved fable→opus, estimated total-burn reduction: ${swapReduction.toFixed(1)}%`);
if (unknownModels.size > 0) console.log(`\n⚠ unknown models weighted as opus: ${[...unknownModels].join(', ')}`);
console.log(`\nskipped — files stale by mtime: ${num(skips.filesOldByMtime)}, unreadable files: ${num(skips.filesUnreadable)}, ` +
  `unparsed lines: ${num(skips.linesUnparsed)}, assistant rows w/o usage: ${num(skips.rowsNoUsage)}, ` +
  `rows w/o timestamp: ${num(skips.rowsNoTimestamp)}, rows outside window: ${num(skips.rowsOutsideWindow)}, ` +
  `duplicate message ids: ${num(skips.rowsDuplicate)}`);
console.log(`\n${CAVEAT}\n`);
