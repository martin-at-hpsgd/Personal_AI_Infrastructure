#!/usr/bin/env bun
/**
 * Calibrate — principal-labeled sessions that tune one workflow's judge.
 *
 * A target (Targets/<name>/target.json in the USER layer) names a pool of real
 * artifacts from one skill intent. A session shows the principal N of them
 * on a loopback page, collects like/dislike plus an optional note, and appends
 * principal-sourced labels. The report measures how well the workflow's judge
 * agrees with those labels; Distill turns the notes into Taste.json, which the
 * judge then reads; rescore re-runs the judge so the before/after is measured.
 *
 *   bun Calibrate.ts targets
 *   bun Calibrate.ts discover "<task in plain words>" [--json]
 *   bun Calibrate.ts pool     --target <t> [--json]
 *   bun Calibrate.ts session  --target <t> --count N [--open] [--port P] [--timeout-min 90] [--scored-only] [--seed S]
 *   bun Calibrate.ts report   --target <t> [--rescored] [--json]
 *   bun Calibrate.ts taste-input --target <t>
 *   bun Calibrate.ts taste    --target <t> --write <draft.json>
 *   bun Calibrate.ts rescore  --target <t> [--session <id>] [--repeats 1] [--concurrency 4] [--dry-run]
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant.ts';
import { MIN_PER_RUNG, calibrationFloors, cohenKappa } from '../../../LIFEOS/TOOLS/lib/Calibration.ts';
import { calibrateRoot, targetDir, tastePath, parseTaste, loadTaste, assertTargetName, type Taste } from '../../../LIFEOS/TOOLS/lib/CalibrateTaste.ts';
import { parse as parseYaml } from 'yaml';
import { renderPage } from './ReviewPage.ts';
import { resolveSuite, USER_SUITES, SKILL_SUITES } from '../../Assay/Tools/EvalRunner.ts';
import { judgeAssertion } from '../../Assay/Tools/Judge.ts';
import { checkThisOne, judgeOrNull, judgedValue, recordPair } from '../../../LIFEOS/ASSAY/HaikuSwap.ts';
import type { Questions } from '../../../LIFEOS/ASSAY/Engine.ts';
import { isJudgedAssert, type Assertion } from '../../Assay/Tools/Assertions.ts';
import { withTasteValue } from '../../../LIFEOS/TOOLS/lib/CalibrateTaste.ts';

// ── types ────────────────────────────────────────────────────────────────────
export type Verdict = 'like' | 'dislike';
export interface JudgeSnapshot { median: number | null; verdict: 'pass' | 'fail' | 'unavailable'; perVendor: Record<string, number | null>; rung: number | null; source: string }
export type ItemKind = 'image' | 'text';
export interface PoolItem { path: string; group: string; source: 'evalround' | 'files' | 'evals' | 'frontmatter'; kind?: ItemKind; context?: string; caseId?: string; date?: string; judge: JudgeSnapshot | null; sha256?: string }
/** frontmatter: published documents (e.g. blog posts) whose frontmatter names an image; the newest real outputs. */
export interface PoolSpec { kind: 'evalround' | 'files' | 'evals' | 'frontmatter'; glob?: string; suite?: string; group?: string; groupPattern?: string; imageField?: string; dateField?: string; titleField?: string; where?: Record<string, string>; urlPrefix?: string; localRoot?: string; exclude?: string[] }
/** judge: 'critique' re-runs ArtDirection on images; 'evals' re-runs the suite's judged asserts on text. */
export interface Target { name: string; title: string; question: string; skill?: string; workflow?: string; pools: PoolSpec[]; brief?: string; judge?: 'critique' | 'evals'; suite?: string; bar?: number; virtual?: boolean; selection?: 'newest' | 'spread'; likeAt?: number; count?: number }
export interface SessionItem { i: number; path: string; sha256: string; group: string; judge: JudgeSnapshot | null; kind?: ItemKind; context?: string; caseId?: string; date?: string }
export interface Session { id: string; target: string; created: string; count: number; items: SessionItem[]; status: 'open' | 'submitted' | 'expired'; submitted?: string; overall?: string }
export interface Label { id: string; target: string; session: string; artifact: string; source_path: string; kind?: ItemKind; case_id?: string; context?: string; sha256: string; score?: number; verdict: Verdict; note: string; labeled_at: string; label_source: { kind: 'principal'; via: 'calibrate-review-page' }; judge: JudgeSnapshot | null }
export interface RescoreRecord { sha256: string; artifact: string; median: number | null; verdict: 'pass' | 'fail' | 'unavailable'; perVendor: Record<string, number | null>; taste_labels_hash: string | null; repeats: number; ts: string }

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const TEXT_TYPES: Record<string, string> = { '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
const kindOf = (path: string): ItemKind => TEXT_TYPES[extname(path).toLowerCase()] ? 'text' : 'image';
export const evalsResultsDir = () => process.env.LIFEOS_EVALS_RESULTS_DIR ?? resolve(import.meta.dir, '../../../LIFEOS/MEMORY/STATE/Evals-Results');
const expandHome = (p: string) => p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
const readJsonl = <T>(path: string): T[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T) : [];
const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export const hashText = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ── paths ────────────────────────────────────────────────────────────────────
export const paths = (target: string) => {
  const dir = targetDir(target);
  return { dir, config: join(dir, 'target.json'), labels: join(dir, 'labels.jsonl'), sessions: join(dir, 'sessions'), rescore: join(dir, 'rescore.jsonl'), rescoreDir: join(dir, 'rescore'), hashCache: join(dir, 'hash-cache.json'), artifacts: join(dir, 'artifacts'), taste: tastePath(target) };
};

// ── suites as targets ──────────────────────────────────────────────────────────
export interface SuiteInfo { name: string; path: string; description: string; cases: { id: string; prompt: string; assert: Assertion[] }[]; passThreshold: number | null; calibration?: string }
export function readSuite(name: string): SuiteInfo | null {
  const path = resolveSuite(name);
  if (!path) return null;
  const raw = readFileSync(path, 'utf8');
  const y = (parseYaml(raw) ?? {}) as Record<string, any>;
  if (!Array.isArray(y.cases)) return null;
  const header = raw.split('\n').filter(l => l.startsWith('#')).map(l => l.replace(/^#+\s?/, '')).slice(0, 2).join(' ').trim();
  return { name: String(y.name ?? name), path, description: String(y.description ?? header ?? ''), cases: y.cases.map((c: any) => ({ id: String(c.id), prompt: String(c.prompt ?? ''), assert: Array.isArray(c.assert) ? c.assert : [] })), passThreshold: typeof y.pass_threshold === 'number' ? y.pass_threshold : null, calibration: y.calibration };
}
export function listSuites(): string[] {
  const names = new Set<string>();
  for (const root of [USER_SUITES, SKILL_SUITES]) for (const dir of [root, join(root, 'Regression'), join(root, 'Capability')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (/\.ya?ml$/.test(f) && !f.includes('template') && !f.startsWith('_')) names.add(f.replace(/\.ya?ml$/, ''));
  }
  return [...names].sort();
}
const humanize = (name: string) => name.replace(/-/g, ' ');
/** Any eval suite is a target with no setup: its stored run outputs are the pool, its judged asserts the judge. */
export function suiteTarget(name: string): Target | null {
  const suite = readSuite(name);
  if (!suite) return null;
  return { name, title: `${humanize(name)} outputs`, question: `Is this a good ${humanize(name)} output? Score it 0–10, and say why when it matters.`, pools: [{ kind: 'evals', suite: name }], judge: 'evals', suite: name, bar: suite.passThreshold !== null ? suite.passThreshold * 10 : 7.5, virtual: true };
}

export function loadTarget(target: string): Target {
  const p = paths(assertTargetName(target));
  if (!existsSync(p.config)) {
    const virtual = suiteTarget(target);
    if (virtual) return virtual;
    throw new Error(`No target or eval suite named "${target}". Run: discover "<task>"`);
  }
  const t = JSON.parse(readFileSync(p.config, 'utf8')) as Target;
  if (t.name !== target || !t.title || !t.question || !Array.isArray(t.pools) || t.pools.length === 0) throw new Error(`Invalid target.json for ${target}: needs name, title, question, pools`);
  for (const s of t.pools) if (!['evalround', 'files', 'evals', 'frontmatter'].includes(s.kind) || (s.kind === 'evals' ? !s.suite : !s.glob) || (s.kind === 'frontmatter' && (!s.imageField || !s.localRoot))) throw new Error(`Invalid pool in ${target}: ${JSON.stringify(s)}`);
  return t;
}

/** Every stored trial output of a suite, with the judge's verdict on its judged asserts. */
export function readSuiteOutputs(suiteName: string, artifactsDir: string): PoolItem[] {
  const dir = join(evalsResultsDir(), suiteName);
  if (!existsSync(dir)) return [];
  const suite = readSuite(suiteName);
  const prompts = new Map((suite?.cases ?? []).map(c => [c.id, c.prompt]));
  const out: PoolItem[] = [];
  mkdirSync(artifactsDir, { recursive: true });
  for (const run of readdirSync(dir)) {
    const file = join(dir, run, 'run.json');
    if (!existsSync(file)) continue;
    let r: Record<string, any>;
    try { r = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    for (const c of Array.isArray(r.detail) ? r.detail : []) {
      for (const trial of Array.isArray(c.trials) ? c.trials : []) {
        if (typeof trial.output !== 'string' || !trial.output.trim()) continue;
        const sha = createHash('sha256').update(trial.output).digest('hex');
        const path = join(artifactsDir, `${sha}.txt`);
        if (!existsSync(path)) writeFileSync(path, trial.output);
        const judged = (Array.isArray(trial.asserts) ? trial.asserts : []).filter((a: any) => isJudgedAssert(String(a.type)) && typeof a.score === 'number');
        const judge: JudgeSnapshot | null = judged.length ? { median: 10 * judged.reduce((x: number, a: any) => x + a.score, 0) / judged.length, verdict: judged.every((a: any) => a.passed) ? 'pass' : 'fail', perVendor: {}, rung: null, source: file } : null;
        out.push({ path, group: `${suiteName}/${c.id}`, source: 'evals', kind: 'text', context: prompts.get(String(c.id)), caseId: String(c.id), judge, sha256: sha });
      }
    }
  }
  return out;
}

export interface Candidate { name: string; kind: 'target' | 'suite'; title: string; description: string; outputs: number; judged: boolean; score: number }
/** Every target and eval suite ranked against a plain-words task, for the principal to pick from. */
export function discover(query: string): Candidate[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !['the', 'and', 'for', 'calibrate', 'images', 'outputs'].includes(w));
  const stem = (w: string) => w.replace(/(ing|es|s)$/, '');
  const scoreOf = (text: string) => { const t = new Set(text.toLowerCase().split(/[^a-z0-9]+/).map(stem)); return words.reduce((n, w) => n + (t.has(stem(w)) ? 1 : 0), 0); };
  const out: Candidate[] = [];
  const configured = listTargets();
  for (const name of configured) {
    const t = loadTarget(name);
    out.push({ name, kind: 'target', title: t.title, description: `${t.skill ?? ''} ${t.workflow ?? ''} · ${t.question}`.trim(), outputs: -1, judged: true, score: scoreOf(`${name} ${t.title} ${t.skill ?? ''} ${t.workflow ?? ''} ${t.question}`) });
  }
  for (const name of listSuites()) {
    if (configured.includes(name) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) continue;
    const suite = readSuite(name);
    if (!suite) continue;
    const dir = join(evalsResultsDir(), name);
    let outputs = 0;
    if (existsSync(dir)) for (const run of readdirSync(dir)) { try { const r = JSON.parse(readFileSync(join(dir, run, 'run.json'), 'utf8')); for (const c of r.detail ?? []) for (const tr of c.trials ?? []) if (typeof tr.output === 'string' && tr.output.trim()) outputs++; } catch {} }
    const judged = suite.cases.some(c => c.assert.some(a => isJudgedAssert(a.type)));
    out.push({ name, kind: 'suite', title: `${humanize(name)} outputs`, description: suite.description.slice(0, 200), outputs, judged, score: scoreOf(`${name} ${suite.description} ${suite.cases.map(c => c.id).join(' ')}`) });
  }
  // Something with nothing to show cannot be calibrated, so usable candidates always rank first.
  const usable = (c: Candidate) => Number(c.outputs !== 0 && c.judged);
  return out.sort((a, b) => usable(b) - usable(a) || b.score - a.score || b.outputs - a.outputs || a.name.localeCompare(b.name));
}

export function listTargets(): string[] {
  const dir = join(calibrateRoot(), 'Targets');
  return existsSync(dir) ? readdirSync(dir).filter(n => existsSync(join(dir, n, 'target.json'))).sort() : [];
}

// ── pool ─────────────────────────────────────────────────────────────────────
function globFiles(pattern: string): string[] {
  const abs = expandHome(pattern);
  const parts = abs.split('/');
  const firstGlob = parts.findIndex(s => /[*?[{]/.test(s));
  if (firstGlob === -1) return existsSync(abs) ? [abs] : [];
  const root = parts.slice(0, firstGlob).join('/') || '/';
  if (!existsSync(root)) return [];
  return [...new Bun.Glob(parts.slice(firstGlob).join('/')).scanSync({ cwd: root, absolute: true, onlyFiles: true, followSymlinks: false })];
}

export function snapshotFromRow(row: Record<string, any>, source: string): JudgeSnapshot | null {
  const c = row.critique;
  if (!c || c.status !== 'ok' || typeof c.median !== 'number') return null;
  return { median: c.median, verdict: c.verdict === 'pass' ? 'pass' : c.verdict === 'fail' ? 'fail' : 'unavailable', perVendor: c.perVendorMedian ?? {}, rung: typeof row.ladder?.rung === 'number' ? row.ladder.rung : null, source };
}

export function readPool(t: Target): PoolItem[] {
  const out: PoolItem[] = [];
  for (const spec of t.pools) {
    if (spec.kind === 'evals') { out.push(...readSuiteOutputs(spec.suite!, paths(t.name).artifacts)); continue; }
    if (spec.kind === 'frontmatter') { out.push(...readFrontmatterPool(spec)); continue; }
    for (const file of globFiles(spec.glob!)) {
      if (spec.kind === 'files') {
        const m = spec.groupPattern ? new RegExp(spec.groupPattern).exec(basename(file)) : null;
        const ext = extname(file).toLowerCase();
        if (IMAGE_TYPES[ext] || TEXT_TYPES[ext]) out.push({ path: file, group: spec.group ?? (m?.[1] ? `${dirname(file)}/${m[1]}` : file), source: 'files', kind: kindOf(file), judge: null });
        continue;
      }
      let record: Record<string, any>;
      try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
      const rows: Record<string, any>[] = Array.isArray(record.rows) ? record.rows : [];
      for (const row of rows) {
        const img = row.judgedFile ?? row.file;
        if (typeof img !== 'string' || !IMAGE_TYPES[extname(img).toLowerCase()] || !existsSync(img)) continue;
        out.push({ path: img, group: dirname(file), source: 'evalround', kind: 'image', judge: snapshotFromRow(row, file) });
      }
    }
  }
  return out;
}

const fmValue = (fm: string, key: string) => new RegExp('^' + key + ':\\s*"?(.*?)"?\\s*$', 'm').exec(fm)?.[1];
/** One item per published document that names an image, newest first; the caption is the document's title. */
export function readFrontmatterPool(spec: PoolSpec): PoolItem[] {
  const out: PoolItem[] = [];
  const root = expandHome(spec.localRoot!);
  for (const file of globFiles(spec.glob!)) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'))?.[1];
    if (!fm) continue;
    if (Object.entries(spec.where ?? {}).some(([k, v]) => fmValue(fm, k) !== v)) continue;
    const ref = fmValue(fm, spec.imageField!), date = fmValue(fm, spec.dateField ?? 'date');
    if (!ref || !date) continue;
    const name = spec.urlPrefix && ref.startsWith(spec.urlPrefix) ? ref.slice(spec.urlPrefix.length) : basename(ref);
    if ((spec.exclude ?? []).includes(name)) continue;
    const path = join(root, name);
    if (!existsSync(path) || !IMAGE_TYPES[extname(path).toLowerCase()]) continue;
    out.push({ path, group: file, source: 'frontmatter', kind: 'image', context: fmValue(fm, spec.titleField ?? 'title'), date, judge: null });
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/** sha256 per file, cached by path+size+mtime so a 700-image pool hashes once. */
export function hashPool(items: PoolItem[], cachePath: string): PoolItem[] {
  let cache: Record<string, { key: string; sha256: string }> = {};
  try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch {}
  let dirty = false;
  const hashed = items.map(item => {
    if (item.sha256) return item;
    const st = statSync(item.path), k = `${st.size}:${st.mtimeMs}`;
    let sha = cache[item.path]?.key === k ? cache[item.path].sha256 : undefined;
    if (!sha) { sha = sha256File(item.path); cache[item.path] = { key: k, sha256: sha }; dirty = true; }
    return { ...item, sha256: sha };
  });
  if (dirty) { mkdirSync(dirname(cachePath), { recursive: true }); writeFileSync(cachePath, JSON.stringify(cache)); }
  return hashed;
}

/** One entry per distinct image; a scored copy beats an unscored one, later rounds beat earlier. */
export function dedupe(items: PoolItem[]): PoolItem[] {
  const by = new Map<string, PoolItem>();
  for (const item of items) {
    invariant(!!item.sha256, 'dedupe needs hashed items');
    const prev = by.get(item.sha256!);
    if (!prev || (!prev.judge && item.judge) || (!!prev.judge === !!item.judge && item.group > prev.group)) by.set(item.sha256!, item);
  }
  return [...by.values()];
}

// ── selection ────────────────────────────────────────────────────────────────
export type Band = 'high' | 'low' | 'mid' | 'unscored';
/** Cuts are the pool's own score tertiles, so a harsh judge still yields three bands. */
export function bandCuts(pool: PoolItem[]): [number, number] {
  const xs = pool.map(p => p.judge?.median).filter((m): m is number => typeof m === 'number').sort((a, b) => a - b);
  if (xs.length < 3) return [6, 8];
  return [xs[Math.floor(xs.length / 3)], xs[Math.floor((2 * xs.length) / 3)]];
}
export function bandOf(item: PoolItem, cuts: [number, number] = [6, 8]): Band {
  const m = item.judge?.median;
  if (typeof m !== 'number') return 'unscored';
  return m >= cuts[1] ? 'high' : m < cuts[0] ? 'low' : 'mid';
}

function rng(seed: string): () => number {
  let h = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0;
  return () => { h = (h + 0x6d2b79f5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Half the picks come from judge-scored bands (spread across tertiles), half unscored, capped per source round. */
export function selectItems(pool: PoolItem[], labeled: Set<string>, count: number, seed: string, opts: { perGroupCap?: number; scoredOnly?: boolean; newest?: boolean } = {}): PoolItem[] {
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer');
  // Newest: the principal's most recent real outputs, in order, skipping what they already scored.
  if (opts.newest) return [...pool].filter(p => !labeled.has(p.sha256!) && (!opts.scoredOnly || p.judge)).sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))).slice(0, count);
  const rand = rng(seed), cap = opts.perGroupCap ?? 2;
  const fresh = pool.filter(p => !labeled.has(p.sha256!) && (!opts.scoredOnly || p.judge));
  const cuts = bandCuts(pool);
  const bands = new Map<Band, PoolItem[]>((['high', 'low', 'mid', 'unscored'] as Band[]).map(b => [b, shuffle(fresh.filter(p => bandOf(p, cuts) === b), rand)]));
  const picked: PoolItem[] = [], perGroup = new Map<string, number>();
  for (const capOn of [true, false]) {
    let progress = true;
    while (picked.length < count && progress) {
      progress = false;
      for (const band of ['high', 'unscored', 'low', 'unscored', 'mid', 'unscored'] as Band[]) {
        const list = bands.get(band)!;
        if (picked.length >= count) break;
        const idx = list.findIndex(p => !capOn || (perGroup.get(p.group) ?? 0) < cap);
        if (idx === -1) continue;
        const [p] = list.splice(idx, 1);
        picked.push(p); perGroup.set(p.group, (perGroup.get(p.group) ?? 0) + 1); progress = true;
      }
    }
  }
  return shuffle(picked, rand);
}

// ── labels ───────────────────────────────────────────────────────────────────
export function readLabels(target: string): Label[] { return readJsonl<Label>(paths(target).labels); }
/** Latest verdict per image wins, so a relabel replaces rather than double-counts. */
export function latestLabels(labels: Label[]): Label[] {
  const by = new Map<string, Label>();
  for (const l of labels) by.set(l.sha256, l);
  return [...by.values()];
}

export interface SubmitBody { labels: { i: number; score: number; note?: string }[]; overall?: string }
/** A score at or above this counts as a like for pass/fail agreement; the raw score is always kept. */
export const DEFAULT_LIKE_AT = 7;
/** The only writer of principal labels: called from the page's POST /submit. */
export function applySubmit(session: Session, body: SubmitBody, now = new Date(), likeAt = DEFAULT_LIKE_AT): Label[] {
  invariant(session.status === 'open', `Session ${session.id} is ${session.status}, not open`);
  if (!body || !Array.isArray(body.labels) || body.labels.length === 0) throw new Error('No labels submitted');
  const seen = new Set<number>();
  const p = paths(session.target);
  mkdirSync(p.artifacts, { recursive: true });
  const labels = body.labels.map(entry => {
    if (!Number.isInteger(entry.i) || entry.i < 0 || entry.i >= session.items.length || seen.has(entry.i)) throw new Error(`Bad item index ${entry.i}`);
    if (typeof entry.score !== 'number' || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 10) throw new Error(`Bad score for item ${entry.i}: 0–10`);
    if (entry.note !== undefined && typeof entry.note !== 'string') throw new Error(`Bad note for item ${entry.i}`);
    seen.add(entry.i);
    const item = session.items[entry.i];
    // Pools live in scratch and Downloads; keep a content-addressed copy so a label outlives its source.
    const kept = join(p.artifacts, `${item.sha256}${extname(item.path).toLowerCase()}`);
    if (!existsSync(kept) && existsSync(item.path)) copyFileSync(item.path, kept);
    return { id: `${session.id}.${entry.i + 1}`, target: session.target, session: session.id, artifact: existsSync(kept) ? kept : item.path, source_path: item.path, kind: item.kind ?? kindOf(item.path), ...(item.caseId ? { case_id: item.caseId } : {}), ...(item.context ? { context: item.context } : {}), sha256: item.sha256, score: entry.score, verdict: (entry.score >= likeAt ? 'like' : 'dislike') as Verdict, note: (entry.note ?? '').slice(0, 4000), labeled_at: now.toISOString(), label_source: { kind: 'principal', via: 'calibrate-review-page' }, judge: item.judge } satisfies Label;
  });
  invariant(labels.every(l => l.sha256.length === 64 && l.target === session.target), 'Every label carries its image hash and target');
  appendFileSync(p.labels, labels.map(l => JSON.stringify(l)).join('\n') + '\n');
  session.status = 'submitted'; session.submitted = now.toISOString();
  if (typeof body.overall === 'string' && body.overall.trim()) session.overall = body.overall.trim().slice(0, 8000);
  writeSession(session);
  return labels;
}

export function writeSession(s: Session) {
  const p = paths(s.target);
  mkdirSync(p.sessions, { recursive: true });
  invariant(s.items.length === s.count, 'Session item count matches');
  writeFileSync(join(p.sessions, `${s.id}.json`), JSON.stringify(s, null, 2) + '\n');
}
export function readSession(target: string, id: string): Session {
  if (!/^S[0-9]{8}-[0-9]{6}$/.test(id)) throw new Error(`Bad session id ${id}`);
  return JSON.parse(readFileSync(join(paths(target).sessions, `${id}.json`), 'utf8'));
}

export function newSessionId(now = new Date()): string {
  const z = (n: number) => String(n).padStart(2, '0');
  return `S${now.getFullYear()}${z(now.getMonth() + 1)}${z(now.getDate())}-${z(now.getHours())}${z(now.getMinutes())}${z(now.getSeconds())}`;
}

// ── server ───────────────────────────────────────────────────────────────────
export function makeHandler(session: Session, t: Target, token: string, onSubmit: (labels: Label[]) => void) {
  const html = renderPage({ sessionId: session.id, title: t.title, question: t.question, count: session.count, token, items: session.items.map(x => ({ kind: x.kind ?? kindOf(x.path), context: x.context })) });
  invariant(!html.includes('"median"'), 'Judge scores never reach the review page');
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    const img = /^\/item\/(\d{1,4})$/.exec(url.pathname);
    if (req.method === 'GET' && img) {
      const i = Number(img[1]);
      if (url.searchParams.get('t') !== token || i >= session.items.length) return new Response('not found', { status: 404 });
      const item = session.items[i];
      return new Response(Bun.file(item.path), { headers: { 'content-type': IMAGE_TYPES[extname(item.path).toLowerCase()] ?? TEXT_TYPES[extname(item.path).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' } });
    }
    if (req.method === 'POST' && url.pathname === '/submit') {
      if (req.headers.get('x-calibrate-token') !== token) return Response.json({ error: 'bad token' }, { status: 403 });
      if (session.status !== 'open') return Response.json({ error: `session is ${session.status}` }, { status: 409 });
      try {
        const labels = applySubmit(session, await req.json() as SubmitBody, new Date(), t.likeAt ?? DEFAULT_LIKE_AT);
        queueMicrotask(() => onSubmit(labels));
        return Response.json({ saved: labels.length });
      } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
    }
    return new Response('not found', { status: 404 });
  };
}

/** The install's Calibrate config file, beside the targets (`<calibrateRoot>/Config.md`). */
export const configPath = () => join(calibrateRoot(), 'Config.md');
/**
 * Which browser `--open` uses, from the `browser` key in Config.md's frontmatter: an app name for `open -a`,
 * or "default" for the system default browser. No Config.md: the system default, with a warning naming the file.
 * A Config.md without the key is an error naming the file and the key, never a silent fallback.
 */
export function browserFor(cfg = configPath()): { app: string | null; warning?: string } {
  if (!existsSync(cfg)) return { app: null, warning: `${cfg} not found; opening with the system default browser (set "browser" there to choose one)` };
  const fm = readFileSync(cfg, 'utf8').match(/^---\n([\s\S]*?)\n---/);
  const browser = fm ? ((parseYaml(fm[1]) ?? {}) as Record<string, unknown>).browser : undefined;
  if (typeof browser !== 'string' || !browser.trim()) throw new Error(`${cfg} has no "browser" key in its frontmatter; set it to an app name such as "Google Chrome", or "default" for the system default browser`);
  return { app: browser.trim() === 'default' ? null : browser.trim() };
}
export const openArgs = (url: string, app: string | null): string[] => app ? ['-a', app, url] : [url];

async function runSession(target: string, opts: { count: number; open: boolean; port: number; timeoutMin: number; scoredOnly: boolean; seed?: string }) {
  const t = loadTarget(target), p = paths(target);
  const pool = dedupe(hashPool(readPool(t), p.hashCache));
  const labeled = new Set(readLabels(target).map(l => l.sha256));
  const id = newSessionId();
  const picked = selectItems(pool, labeled, opts.count, opts.seed ?? id, { scoredOnly: opts.scoredOnly, newest: t.selection === 'newest' });
  if (picked.length === 0) throw new Error(`No unlabeled artifacts left in the ${target} pool (${pool.length} total, ${labeled.size} labeled)`);
  const session: Session = { id, target, created: new Date().toISOString(), count: picked.length, items: picked.map((x, i) => ({ i, path: x.path, sha256: x.sha256!, group: x.group, judge: x.judge, kind: x.kind ?? kindOf(x.path), ...(x.context ? { context: x.context } : {}), ...(x.caseId ? { caseId: x.caseId } : {}), ...(x.date ? { date: x.date } : {}) })), status: 'open' };
  writeSession(session);
  const token = randomBytes(18).toString('hex');
  let finish!: (code: number) => void;
  const done = new Promise<number>(r => { finish = r; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: opts.port, fetch: makeHandler(session, t, token, labels => {
    const likes = labels.filter(l => l.verdict === 'like').length;
    console.log(JSON.stringify({ event: 'submitted', session: id, saved: labels.length, meanScore: labels.reduce((a, l) => a + (l.score ?? 0), 0) / labels.length, likes, dislikes: labels.length - likes, withNotes: labels.filter(l => l.note).length, overall: session.overall ?? null }));
    setTimeout(() => finish(0), 250);
  }) });
  const url = `http://127.0.0.1:${server.port}/`;
  console.log(JSON.stringify({ event: 'ready', session: id, url, count: session.count, requested: opts.count, pool: pool.length, labeled: labeled.size }));
  if (opts.open) {
    try {
      const b = browserFor();
      if (b.warning) console.error(b.warning);
      execFile('open', openArgs(url, b.app), err => { if (err) console.error(`open failed: ${err.message}`); });
    } catch (e) { console.error(`open skipped: ${(e as Error).message}`); }
  }
  const timer = setTimeout(() => { session.status = 'expired'; writeSession(session); console.log(JSON.stringify({ event: 'expired', session: id })); finish(3); }, opts.timeoutMin * 60_000);
  const code = await done;
  clearTimeout(timer);
  server.stop(true);
  process.exit(code);
}

// ── report ───────────────────────────────────────────────────────────────────
type Pair = { label: 'pass' | 'fail'; score: number };
export interface Sweep { threshold: number; agreement: number; kappa: number; balancedAccuracy: number }
export function sweep(pairs: Pair[], at?: number): { best: Sweep | null; at: Sweep | null } {
  if (pairs.length === 0) return { best: null, at: null };
  const evalAt = (th: number): Sweep => {
    const judged = pairs.map(p => ({ label: p.label, judge: (p.score >= th ? 'pass' : 'fail') as 'pass' | 'fail' }));
    const pos = judged.filter(p => p.label === 'pass'), neg = judged.filter(p => p.label === 'fail');
    const tpr = pos.length ? pos.filter(p => p.judge === 'pass').length / pos.length : NaN;
    const tnr = neg.length ? neg.filter(p => p.judge === 'fail').length / neg.length : NaN;
    return { threshold: th, agreement: judged.filter(p => p.label === p.judge).length / judged.length, kappa: cohenKappa(judged), balancedAccuracy: (tpr + tnr) / 2 };
  };
  let best: Sweep | null = null;
  for (let th = 1; th <= 10.0001; th += 0.25) {
    const s = evalAt(Math.round(th * 100) / 100);
    if (!Number.isFinite(s.balancedAccuracy)) continue;
    if (!best || s.balancedAccuracy > best.balancedAccuracy + 1e-9 || (Math.abs(s.balancedAccuracy - best.balancedAccuracy) < 1e-9 && at !== undefined && Math.abs(s.threshold - at) < Math.abs(best.threshold - at))) best = s;
  }
  return { best, at: at === undefined ? null : evalAt(at) };
}

const ranks = (xs: number[]) => { const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]); const r = new Array<number>(xs.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
/** How the judge's 0–10 tracks the principal's 0–10: rank correlation and the average gap (judge minus principal). */
export function scoreAgreement(pairs: { principal: number; judge: number }[]) {
  const n = pairs.length;
  if (n === 0) return { n, spearman: null, meanGap: null, meanPrincipal: null, meanJudge: null };
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const a = ranks(pairs.map(p => p.principal)), b = ranks(pairs.map(p => p.judge)), ma = mean(a), mb = mean(b);
  const cov = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0), va = a.reduce((s, x) => s + (x - ma) ** 2, 0), vb = b.reduce((s, x) => s + (x - mb) ** 2, 0);
  return { n, spearman: n > 2 && va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null, meanGap: mean(pairs.map(p => p.judge - p.principal)), meanPrincipal: mean(pairs.map(p => p.principal)), meanJudge: mean(pairs.map(p => p.judge)) };
}

export interface Report {
  target: string; labels: number; likes: number; dislikes: number; withNotes: number; scored: number; judgeSource: 'label-snapshot' | 'rescored';
  panel: { agreement: number; kappa: number; earned: boolean; floors: { agreement: number; kappa: number; perRung: number }; confusion: Record<string, number> } | null;
  median: { atBar: Sweep | null; best: Sweep | null; bar: number };
  perVendor: Record<string, { atBar: Sweep | null; best: Sweep | null; n: number }>;
  medianOf: { likes: number | null; dislikes: number | null };
  scores: { n: number; spearman: number | null; meanGap: number | null; meanPrincipal: number | null; meanJudge: number | null };
  disagreements: { id: string; verdict: Verdict; score: number | null; judge: string; median: number | null; note: string; artifact: string }[];
  taste: { present: boolean; stale: boolean; label_count: number | null };
}
const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export function labelsHash(labels: Label[]): string { return hashText(labels.map(l => `${l.id}:${l.sha256}:${l.verdict}:${l.note}`).join('\n')); }

export function buildReport(target: string, labels: Label[], judgeOf: (l: Label) => JudgeSnapshot | null, source: Report['judgeSource'], bar = 8.5, taste: Taste | null = null): Report {
  const latest = latestLabels(labels);
  const scored = latest.map(l => ({ l, j: judgeOf(l) })).filter((x): x is { l: Label; j: JudgeSnapshot } => !!x.j && x.j.verdict !== 'unavailable' && typeof x.j.median === 'number');
  const toLabel = (v: Verdict) => v === 'like' ? 'pass' as const : 'fail' as const;
  const pairs = scored.map(({ l, j }) => ({ label: toLabel(l.verdict), judge: j.verdict as 'pass' | 'fail' }));
  const confusion: Record<string, number> = { 'like/pass': 0, 'like/fail': 0, 'dislike/pass': 0, 'dislike/fail': 0 };
  for (const { l, j } of scored) confusion[`${l.verdict}/${j.verdict}`]++;
  const agreement = pairs.length ? pairs.filter(p => p.label === p.judge).length / pairs.length : 0;
  const kappa = cohenKappa(pairs);
  const likesN = pairs.filter(p => p.label === 'pass').length, dislikesN = pairs.length - likesN;
  const floors = calibrationFloors();
  const earned = pairs.length > 0 && agreement >= floors.agreement && kappa >= floors.kappa && likesN >= MIN_PER_RUNG && dislikesN >= MIN_PER_RUNG;
  const vendors = [...new Set(scored.flatMap(({ j }) => Object.keys(j.perVendor)))].sort();
  const perVendor: Report['perVendor'] = {};
  for (const v of vendors) {
    const vp = scored.filter(({ j }) => typeof j.perVendor[v] === 'number').map(({ l, j }) => ({ label: toLabel(l.verdict), score: j.perVendor[v] as number }));
    const vs = sweep(vp, bar);
    perVendor[v] = { atBar: vs.at, best: vs.best, n: vp.length };
  }
  const medianSweep = sweep(scored.map(({ l, j }) => ({ label: toLabel(l.verdict), score: j.median as number })), bar);
  const currentHash = labelsHash(latest);
  return {
    target, labels: latest.length, likes: latest.filter(l => l.verdict === 'like').length, dislikes: latest.filter(l => l.verdict === 'dislike').length, withNotes: latest.filter(l => l.note).length, scored: scored.length, judgeSource: source,
    panel: pairs.length ? { agreement, kappa, earned, floors: { agreement: floors.agreement, kappa: floors.kappa, perRung: MIN_PER_RUNG }, confusion } : null,
    median: { atBar: medianSweep.at, best: medianSweep.best, bar },
    perVendor,
    scores: scoreAgreement(scored.filter(x => typeof x.l.score === 'number').map(x => ({ principal: x.l.score as number, judge: x.j.median as number }))),
    medianOf: { likes: med(scored.filter(x => x.l.verdict === 'like').map(x => x.j.median as number)), dislikes: med(scored.filter(x => x.l.verdict === 'dislike').map(x => x.j.median as number)) },
    disagreements: scored.filter(({ l, j }) => toLabel(l.verdict) !== j.verdict).map(({ l, j }) => ({ id: l.id, verdict: l.verdict, score: l.score ?? null, judge: j.verdict, median: j.median, note: l.note, artifact: l.artifact })),
    taste: { present: !!taste, stale: !!taste && taste.labels_hash !== currentHash, label_count: taste?.label_count ?? null },
  };
}

/** Latest rescore per image, whichever taste version judged it. */
export function latestRescores(target: string): Map<string, RescoreRecord> {
  const by = new Map<string, RescoreRecord>();
  for (const r of readJsonl<RescoreRecord>(paths(target).rescore)) by.set(r.sha256, r);
  return by;
}

/**
 * Images whose latest rescore judged them in-sample. A taste is distilled from every current
 * label at that moment, so its `labels_hash` equals the hash of one prefix of the append-only
 * label log, and every image in that prefix trained it. A rescore with no taste is held out; one
 * whose taste hash matches no prefix cannot be shown held out and counts as in-sample.
 */
export function inSampleShas(allLabels: Label[], rescores: Map<string, RescoreRecord>): Set<string> {
  const needed = new Set([...rescores.values()].map(r => r.taste_labels_hash).filter((h): h is string => !!h));
  const training = new Map<string, Set<string>>();
  const latest = new Map<string, Label>();
  for (const l of allLabels) {
    if (!needed.size) break;
    latest.set(l.sha256, l);
    const h = labelsHash([...latest.values()]);
    if (needed.has(h) && !training.has(h)) training.set(h, new Set(latest.keys()));
  }
  const out = new Set<string>();
  for (const [sha, r] of rescores) {
    if (!r.taste_labels_hash) continue;
    const trained = training.get(r.taste_labels_hash);
    if (!trained || trained.has(sha)) out.add(sha);
  }
  return out;
}

const pct = (x: number | undefined | null) => typeof x === 'number' && Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—';
const f2 = (x: number | undefined | null) => typeof x === 'number' && Number.isFinite(x) ? x.toFixed(2) : '—';
export function printReport(r: Report, baseline?: Report) {
  console.log(`Calibrate · ${r.target} · judge from ${r.judgeSource}`);
  console.log(`Labels ${r.labels} (${r.likes} like, ${r.dislikes} dislike, ${r.withNotes} with notes); ${r.scored} have a judge score.`);
  if (!r.panel) { console.log('No scored labels yet: nothing to measure.'); return; }
  const earned = r.panel.earned ? 'EARNED' : 'not earned';
  console.log(`Panel verdict vs you: agreement ${pct(r.panel.agreement)}, kappa ${f2(r.panel.kappa)} → ${earned} (floors ${pct(r.panel.floors.agreement)} / ${r.panel.floors.kappa}, ≥${r.panel.floors.perRung} per side).`);
  if (baseline?.panel) console.log(`Before, with the scores from when each image was made: agreement ${pct(baseline.panel.agreement)}, kappa ${f2(baseline.panel.kappa)} (${baseline.scored} of these labels had a score then).`);
  console.log(`Confusion (you/judge): ${Object.entries(r.panel.confusion).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (r.scores.n) console.log(`Your scores vs the judge (${r.scores.n}): rank correlation ${f2(r.scores.spearman)}; you average ${f2(r.scores.meanPrincipal)}, the judge ${f2(r.scores.meanJudge)} (gap ${f2(r.scores.meanGap)}).`);
  console.log(`Median score of what you liked ${f2(r.medianOf.likes)}, of what you disliked ${f2(r.medianOf.dislikes)}.`);
  const m = r.median;
  console.log(`Median ≥ bar ${m.bar}: balanced accuracy ${pct(m.atBar?.balancedAccuracy)}. Best cut ${m.best?.threshold ?? '—'}: balanced accuracy ${pct(m.best?.balancedAccuracy)}, agreement ${pct(m.best?.agreement)}, kappa ${f2(m.best?.kappa)}.`);
  for (const [v, s] of Object.entries(r.perVendor)) console.log(`  ${v}: best cut ${s.best?.threshold ?? '—'} → balanced accuracy ${pct(s.best?.balancedAccuracy)} (n ${s.n}); at bar ${pct(s.atBar?.balancedAccuracy)}`);
  console.log(`Taste profile: ${r.taste.present ? (r.taste.stale ? `present but stale (built from ${r.taste.label_count} labels; new labels since)` : `current (${r.taste.label_count} labels)`) : 'none yet'}.`);
  if (r.disagreements.length) {
    console.log(`Disagreements (${r.disagreements.length}):`);
    for (const d of r.disagreements) console.log(`  ${d.id} you ${d.score ?? d.verdict}, judge ${d.judge} @ ${f2(d.median)}${d.note ? ` — "${d.note}"` : ''}\n    ${d.artifact}`);
  }
}

// ── taste ────────────────────────────────────────────────────────────────────
export function tasteInput(target: string) {
  const t = loadTarget(target), latest = latestLabels(readLabels(target));
  const sessions = existsSync(paths(target).sessions) ? readdirSync(paths(target).sessions).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(paths(target).sessions, f), 'utf8')) as Session) : [];
  return { target, title: t.title, question: t.question, labels_hash: labelsHash(latest), overall_notes: sessions.filter(s => s.overall).map(s => ({ session: s.id, note: s.overall })), labels: latest.map(l => ({ id: l.id, verdict: l.verdict, note: l.note, artifact: l.artifact, judge_median: l.judge?.median ?? null, judge_verdict: l.judge?.verdict ?? null })) };
}

/** Validates a drafted profile against the real labels and stamps provenance. */
export function writeTaste(target: string, draft: unknown, now = new Date()): Taste {
  const latest = latestLabels(readLabels(target));
  if (latest.length === 0) throw new Error(`No labels for ${target}; run a session first`);
  const stamped = { ...(draft as object), target, updated: now.toISOString(), labels_hash: labelsHash(latest), label_count: latest.length };
  const taste = parseTaste(stamped, new Set(latest.map(l => l.id)));
  mkdirSync(paths(target).dir, { recursive: true });
  invariant(taste.labels_hash.length === 16 && taste.target === target, 'Taste is stamped for this target');
  writeFileSync(paths(target).taste, JSON.stringify(taste, null, 2) + '\n');
  return taste;
}

// ── rescore ──────────────────────────────────────────────────────────────────
/** The caption the principal saw (post title or prompt); older labels recover it from their session file. */
export function contextFor(l: Label): string | undefined {
  if (l.context) return l.context;
  try { return readSession(l.target, l.session).items.find(x => x.sha256 === l.sha256)?.context; } catch { return undefined; }
}
/** The judge sees what the principal saw: the brief names this item's own subject, so concept-fit is judgeable. */
export function itemBrief(base: Record<string, unknown>, target: string, context?: string): Record<string, unknown> {
  return { ...base, calibration: target, ...(context ? { title: `${String(base.title)} for "${context}"` } : {}) };
}
export function rescorePlan(target: string, sessionId?: string): Label[] {
  const latest = latestLabels(readLabels(target));
  return sessionId ? latest.filter(l => l.session === sessionId) : latest;
}

function runCritique(image: string, brief: string, out: string): Promise<{ median: number | null; verdict: RescoreRecord['verdict']; perVendor: Record<string, number | null> }> {
  const critique = resolve(import.meta.dir, '../../ArtDirection/Tools/Critique.ts');
  return new Promise(res => execFile('bun', [critique, '--image', image, '--brief', brief, '--out', out], { timeout: 240_000, maxBuffer: 16 << 20 }, () => {
    try {
      const r = JSON.parse(readFileSync(join(out, 'Critique.json'), 'utf8'));
      res({ median: typeof r.median === 'number' ? r.median : null, verdict: r.verdict === 'pass' || r.verdict === 'fail' ? r.verdict : 'unavailable', perVendor: r.perVendorMedian ?? {} });
    } catch { res({ median: null, verdict: 'unavailable', perVendor: {} }); }
  }));
}

/** Re-judges one stored text output with the suite's judged asserts, the taste appended to each. */
export async function judgeText(output: string, asserts: Assertion[], taste: Taste | null, judge: typeof judgeAssertion = judgeAssertion) {
  const judged = asserts.filter(a => isJudgedAssert(a.type) && typeof a.value === 'string');
  if (!judged.length) return { median: null, verdict: 'unavailable' as const, perVendor: {} };
  // Assay's judgment layer decides first: once the registry lets "meets" act, its yes/no is the verdict and Haiku is skipped.
  const rubric = withTasteValue(judged.map(a => a.value as string).join("\n"), taste);
  const state = `Criteria:\n${rubric}\n\nOutput:\n${output}`;
  const j = await judgeOrNull("calibrate-taste", state, TASTE_QUESTIONS);
  const judgedMeets = judgedValue(j, "meets");
  if (j?.meets?.verdict.act && judgedMeets && j.meets.answer.type === "noul" && !checkThisOne("calibrate-taste", state)) return { median: 10 * j.meets.answer.noul, verdict: judgedMeets === "yes" ? "pass" as const : "fail" as const, perVendor: {} };
  const results = await Promise.all(judged.map(a => judge(output, { ...a, value: withTasteValue(a.value as string, taste) }, { level: 'low' }).catch(() => null)));
  const ok = results.filter((r): r is NonNullable<typeof r> => !!r && !r.unavailable && typeof r.score === 'number');
  if (ok.length < judged.length) return { median: null, verdict: 'unavailable' as const, perVendor: {} };
  const verdict = ok.every(r => r.passed) ? 'pass' as const : 'fail' as const;
  recordPair("calibrate-taste", "meets", state, judgedMeets, verdict === "pass" ? "yes" : "no");
  return { median: 10 * ok.reduce((x, r) => x + r.score, 0) / ok.length, verdict, perVendor: {} };
}

/** The taste question on Assay's judgment layer: does the output meet every criterion and the taste profile? */
export const TASTE_QUESTIONS: Questions = { meets: { type: "noul", instructions: "Does the output meet every listed criterion and the taste profile given with them? Judge the output only." } };

async function rescore(target: string, opts: { session?: string; repeats: number; concurrency: number; dryRun: boolean }) {
  const t = loadTarget(target), p = paths(target);
  if (t.judge === 'evals') {
    const suite = readSuite(t.suite ?? target);
    if (!suite) throw new Error(`Suite ${t.suite ?? target} not found`);
    const cases = new Map(suite.cases.map(c => [c.id, c.assert]));
    const taste = loadTaste(target);
    const plan = rescorePlan(target, opts.session).filter(l => l.case_id && cases.has(l.case_id));
    console.log(JSON.stringify({ event: 'plan', target, outputs: plan.length, calls: plan.reduce((n, l) => n + cases.get(l.case_id!)!.filter(a => isJudgedAssert(a.type)).length, 0), taste: taste ? taste.labels_hash : null }));
    if (opts.dryRun) return;
    let done = 0;
    await Promise.all(plan.map(async l => {
      const r = await judgeText(readFileSync(l.artifact, 'utf8'), cases.get(l.case_id!)!, taste);
      const rec: RescoreRecord = { sha256: l.sha256, artifact: l.artifact, ...r, taste_labels_hash: taste?.labels_hash ?? null, repeats: 1, ts: new Date().toISOString() };
      invariant(rec.sha256.length === 64, 'Rescore record carries the output hash');
      appendFileSync(p.rescore, JSON.stringify(rec) + '\n');
      console.log(JSON.stringify({ event: 'scored', n: ++done, of: plan.length, id: l.id, median: rec.median, verdict: rec.verdict }));
    }));
    return;
  }
  if (!t.brief) {
    // Labels-only target: no image brief and no evals judge, so there is nothing to rescore with. Say so and stop;
    // the report still measures the labels against whatever judge snapshot the pool carried.
    console.error(`Target ${target} has no judge to rescore with: ${p.config} names no "brief" (image critique) and no "judge": "evals". Rescore skipped.`);
    console.log(JSON.stringify({ event: 'skipped', target, reason: 'labels-only target: no "brief" and no "judge": "evals" in target.json' }));
    return;
  }
  const base = JSON.parse(readFileSync(resolve(p.dir, t.brief), 'utf8'));
  const taste = loadTaste(target);
  const plan = rescorePlan(target, opts.session);
  console.log(JSON.stringify({ event: 'plan', target, images: plan.length, repeats: opts.repeats, calls: plan.length * opts.repeats * 2, taste: taste ? taste.labels_hash : null }));
  if (opts.dryRun || plan.length === 0) return;
  mkdirSync(p.rescoreDir, { recursive: true });
  const stamp = Date.now();
  let next = 0, done = 0;
  const work = async () => {
    while (next < plan.length) {
      const l = plan[next++];
      if (!existsSync(l.artifact)) { console.error(`missing ${l.artifact}`); continue; }
      const runs: Awaited<ReturnType<typeof runCritique>>[] = [];
      const dir = join(p.rescoreDir, l.sha256.slice(0, 16)), briefPath = join(dir, 'Brief.json');
      mkdirSync(dir, { recursive: true });
      writeFileSync(briefPath, JSON.stringify(itemBrief(base, target, contextFor(l)), null, 2) + '\n');
      for (let k = 0; k < opts.repeats; k++) runs.push(await runCritique(l.artifact, briefPath, join(dir, `${stamp}-${k + 1}`)));
      const ok = runs.filter(r => typeof r.median === 'number');
      const vendors = [...new Set(ok.flatMap(r => Object.keys(r.perVendor)))];
      const rec: RescoreRecord = {
        sha256: l.sha256, artifact: l.artifact, median: med(ok.map(r => r.median as number)),
        verdict: ok.length === 0 ? 'unavailable' : ok.filter(r => r.verdict === 'pass').length * 2 > ok.length ? 'pass' : 'fail',
        perVendor: Object.fromEntries(vendors.map(v => [v, med(ok.map(r => r.perVendor[v]).filter((x): x is number => typeof x === 'number'))])),
        taste_labels_hash: taste?.labels_hash ?? null, repeats: opts.repeats, ts: new Date().toISOString(),
      };
      invariant(rec.sha256.length === 64, 'Rescore record carries the image hash');
      appendFileSync(p.rescore, JSON.stringify(rec) + '\n');
      console.log(JSON.stringify({ event: 'scored', n: ++done, of: plan.length, id: l.id, median: rec.median, verdict: rec.verdict }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, plan.length) }, work));
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const [cmd, ...rest] = Bun.argv.slice(2);
  const { values: v } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: {
    target: { type: 'string' }, count: { type: 'string' }, open: { type: 'boolean' }, port: { type: 'string' }, 'timeout-min': { type: 'string' },
    'scored-only': { type: 'boolean' }, seed: { type: 'string' }, json: { type: 'boolean' }, rescored: { type: 'boolean' }, write: { type: 'string' },
    session: { type: 'string' }, repeats: { type: 'string' }, concurrency: { type: 'string' }, 'dry-run': { type: 'boolean' },
  } });
  const need = () => { if (!v.target) throw new Error('--target <name> is required'); return v.target; };
  const int = (s: string | undefined, d: number, lo: number, hi: number, name: string) => { const n = s === undefined ? d : Number(s); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`--${name} must be an integer ${lo}–${hi}`); return n; };
  try {
    if (cmd === 'targets') console.log(JSON.stringify(listTargets()));
    else if (cmd === 'discover') {
      const q = rest.filter(a => !a.startsWith('--')).join(' ');
      const found = discover(q);
      if (v.json) console.log(JSON.stringify(found));
      else for (const c of found.slice(0, 12)) console.log(`${c.score ? '★' : ' '} ${c.name.padEnd(32)} ${c.kind === 'target' ? 'configured target' : `${c.outputs} stored outputs${c.judged ? '' : ', no judged asserts'}`} · ${c.description.slice(0, 90)}`);
    }
    else if (cmd === 'pool') {
      const target = need(), t = loadTarget(target), pool = dedupe(hashPool(readPool(t), paths(target).hashCache));
      const labeled = new Set(readLabels(target).map(l => l.sha256));
      const cuts = bandCuts(pool);
      const bands = Object.fromEntries((['high', 'mid', 'low', 'unscored'] as Band[]).map(b => [b, pool.filter(x => bandOf(x, cuts) === b).length]));
      const out = { target, distinct: pool.length, scored: pool.filter(x => x.judge).length, labeled: pool.filter(x => labeled.has(x.sha256!)).length, unlabeled: pool.filter(x => !labeled.has(x.sha256!)).length, bands, groups: new Set(pool.map(x => x.group)).size };
      console.log(v.json ? JSON.stringify(out) : `${target}: ${out.distinct} distinct artifacts (${out.scored} judge-scored) across ${out.groups} sources; ${out.labeled} labeled, ${out.unlabeled} left. Bands: ${Object.entries(bands).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
    } else if (cmd === 'session') {
      await runSession(need(), { count: int(v.count, loadTarget(need()).count ?? 16, 1, 256, 'count'), open: !!v.open, port: int(v.port, 0, 0, 65535, 'port'), timeoutMin: int(v['timeout-min'], 90, 1, 1440, 'timeout-min'), scoredOnly: !!v['scored-only'], seed: v.seed });
    } else if (cmd === 'report') {
      const target = need(), taste = loadTaste(target);
      const labels = readLabels(target).filter(l => !v.session || l.session === v.session);
      const bar = loadTarget(target).bar ?? 8.5;
      const base = buildReport(target, labels, l => l.judge, 'label-snapshot', bar, taste);
      if (v.rescored) {
        const rs = latestRescores(target);
        const versions: Record<string, number> = {};
        for (const l of latestLabels(labels)) { const x = rs.get(l.sha256); if (x) versions[x.taste_labels_hash ?? 'no-taste'] = (versions[x.taste_labels_hash ?? 'no-taste'] ?? 0) + 1; }
        if (!v.json) console.log(`Rescored with taste versions: ${Object.entries(versions).map(([k, n]) => `${k} ×${n}`).join(', ') || 'none'} (current: ${taste?.labels_hash ?? 'no-taste'})`);
        // Only held-out labels count: a rescore by a taste distilled from the same label flatters it.
        const inSample = inSampleShas(readLabels(target), rs);
        const held = labels.filter(l => rs.has(l.sha256) && !inSample.has(l.sha256));
        const leftOut = latestLabels(labels).filter(l => inSample.has(l.sha256)).length;
        if (!v.json && leftOut) console.log(`Left out ${leftOut} label${leftOut === 1 ? '' : 's'} rescored by a taste distilled from them (in-sample).`);
        const r = buildReport(target, held, l => { const x = rs.get(l.sha256); return x ? { median: x.median, verdict: x.verdict, perVendor: x.perVendor, rung: null, source: 'rescore' } : null; }, 'rescored', bar, taste);
        const before = buildReport(target, held, l => l.judge, 'label-snapshot', bar, taste);
        if (v.json) console.log(JSON.stringify({ before, after: r, in_sample_excluded: leftOut })); else printReport(r, before);
      } else if (v.json) console.log(JSON.stringify(base)); else printReport(base);
    } else if (cmd === 'taste-input') console.log(JSON.stringify(tasteInput(need()), null, 2));
    else if (cmd === 'taste') {
      const target = need(); if (!v.write) throw new Error('--write <draft.json> is required');
      const taste = writeTaste(target, JSON.parse(readFileSync(v.write, 'utf8')));
      console.log(JSON.stringify({ written: paths(target).taste, likes: taste.likes.length, dislikes: taste.dislikes.length, label_count: taste.label_count, labels_hash: taste.labels_hash }));
    } else if (cmd === 'rescore') {
      await rescore(need(), { session: v.session, repeats: int(v.repeats, 1, 1, 5, 'repeats'), concurrency: int(v.concurrency, 4, 1, 16, 'concurrency'), dryRun: !!v['dry-run'] });
    } else {
      console.log(readFileSync(new URL('./Calibrate.help.md', import.meta.url), 'utf8'));
      if (cmd && cmd !== 'help') process.exitCode = 1;
    }
  } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
}
