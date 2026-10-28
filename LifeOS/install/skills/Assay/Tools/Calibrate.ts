#!/usr/bin/env bun
/**
 * Calibrate — judge governance: calibration, shrinkage, and disagreement mining.
 *
 * Anthropic doctrine: model graders "require calibration with human graders."
 * The principal labels a small set of real outputs pass/fail per judged
 * assertion; the judge runs the same set; the record decides whether the suite
 * earns the calibrated-cheap judge. What "earns" means lives in ONE place,
 * LIFEOS/TOOLS/lib/Calibration.ts: agreement ≥ 85%, Cohen's kappa ≥ 0.4, at
 * least two labels per rung, and nothing stale (judge chain, rubric, labels).
 *
 * Judge-shrinkage doctrine (see the Assay SKILL.md § Doctrine): judges are debt.
 * Every judge↔principal DISAGREEMENT is a discovery — some part of "good" not
 * yet articulated — and the mining output turns each into a candidate
 * deterministic assert. The per-suite judged-residue metric (EvalRunner
 * reports it every run) is the number that should fall over time.
 *
 * Calibration set (principal-labeled, USER layer — never the public tree):
 *   LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Assay/Calibration/<suite>.yaml
 *   either a bare list of entries, or { isa: <path>, claim: <ISC-id>, entries: [...] }
 *   entries:
 *     - output: "the agent output text"
 *       assert: { type: llm-rubric, value: "..." }   # the judged assertion
 *       label: pass | fail                            # the principal's verdict
 *       note: "why"                                   # optional; seeds mining
 *       moved: claim | judge | label                  # optional, after mining: which side moved
 *       why: "..."                                    # optional, after mining: why it moved
 *
 *   bun Calibrate.ts -s <suite> [--level low] [--json] [--append-log]   # run calibration, write result.json
 *   bun Calibrate.ts --recheck [--page]                                  # re-run every STALE record (ModelSync daily); --page texts on a drop
 *   bun Calibrate.ts --residue                                           # shrinkage report + judge-ready attested seeds
 *
 * Every run writes <suite>.log.md — the Articulation Log block for the ISA
 * that owns the criterion. Only --append-log appends it to that ISA (the
 * interactive Calibrate intent); an unattended recheck never writes an ISA.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { judgeAssertion } from './Judge.ts';
import { isJudgedAssert, isModelAssert, type Assertion } from './Assertions.ts';
import { applyImageAsserts, type ImageCase } from './ImageEvalRunner.ts';
import { judgeImageRubric, judgeMeaningLadder } from './VisionJudge.ts';
import type { InferenceLevel } from '../../../LIFEOS/TOOLS/Inference.ts';
import { sendOwnText } from '../../../LIFEOS/TOOLS/SchedulerWatch.ts';
import { assayUserDir, getSkillsDir, lifeosPath } from '../../../LIFEOS/TOOLS/Paths.ts';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant.ts';
import { textCard } from '../../../LIFEOS/TOOLS/TextFormat.ts';
import {
  calibrationDir, readSet, readRecord, recordPathOf, scoreCalibration, judgeChain, imageJudgeChain, chainHashOf, rubricHashOf, stalenessOf, resolveSuiteDefinition, coversSuiteAssertions, validCalibrationEntries, imageEvidenceHashOf, imagePipelineHash,
  renderCalibrationLogBlock, seedSummaries, seedsDir, resolveVendors, calibrationFloors, MIN_PER_RUNG, JUDGE_READY_LABELS,
  calibrationLabelsHash, calibrationState, type CalibrationRecord, type CalibrationState, type Verdict, type Vendor,
} from '../../../LIFEOS/TOOLS/lib/Calibration.ts';

export type JudgeFn = (output: string, assert: Assertion, level: InferenceLevel) => Promise<Verdict>;

const realJudge: JudgeFn = async (output, assert, level) => {
  const r = await judgeAssertion(output, assert, { level });
  return { passed: r.passed, reason: r.reason, available: !r.unavailable };
};

export interface CalibrateOptions {
  dir?: string;
  judge?: JudgeFn;
  /** Test-only injections still route through ImageEvalRunner's production assertion dispatcher. */
  imageRubric?: typeof judgeImageRubric;
  imageLadder?: typeof judgeMeaningLadder;
  vendors?: { default: Vendor; fallback?: Vendor };
  /** Suite roots, in the same USER-first order as EvalRunner. Injectable for tests. */
  suiteDirs?: string[];
  json?: boolean;
  /** Append the rendered Articulation Log block to the ISA named in the set. Interactive runs only. */
  appendLog?: boolean;
  quiet?: boolean;
  now?: Date;
}

export interface CalibrateOutcome { code: number; record?: CalibrationRecord; logPath?: string; appendedTo?: string; error?: string }

function imageCase(entry: import('../../../LIFEOS/TOOLS/lib/Calibration.ts').CalEntry, definition: NonNullable<ReturnType<typeof resolveSuiteDefinition>>): ImageCase {
  if (!entry.image) throw new Error('image calibration entry lacks image evidence');
  const source = definition.image_cases?.find((c) => c.id === entry.image!.case_id);
  if (!source) throw new Error('image calibration case is absent from the resolved suite');
  return { id: entry.image.case_id, image: entry.image.artifact, reference: entry.image.reference,
    assert: [...source.assert.filter((a) => !isJudgedAssert(a.type)), entry.assert] as ImageCase['assert'] };
}

/** Execute the same image assertion dispatcher as ImageEvalRunner; a text output can never stand in for pixels. */
async function judgeImageEntry(entry: import('../../../LIFEOS/TOOLS/lib/Calibration.ts').CalEntry, level: InferenceLevel, opts: CalibrateOptions, definition: NonNullable<ReturnType<typeof resolveSuiteDefinition>>, suite: string): Promise<Verdict> {
  if (!entry.image) return { passed: false, reason: 'image calibration entry lacks image evidence', available: false };
  const rows = await applyImageAsserts(entry.image.artifact, imageCase(entry, definition), {
    suite, level, rubric: opts.imageRubric, ladder: opts.imageLadder,
  });
  const result = rows.at(-1);
  if (!result) return { passed: false, reason: 'image assertion returned no result', available: false };
  return { passed: result.passed, reason: result.reason, available: !result.unavailable && !result.skipped };
}

/** Run one suite's calibration set through the judge and write the record. Pure over its options: tests inject the judge and the dir. */
export async function calibrate(suiteName: string, level: InferenceLevel, opts: CalibrateOptions = {}): Promise<CalibrateOutcome> {
  const dir = opts.dir ?? calibrationDir();
  const log = (s: string) => { if (!opts.quiet) console.log(s); };
  const set = readSet(suiteName, dir);
  if (!set) {
    const error = `No calibration set at ${join(dir, `${suiteName}.yaml`)}.\nCreate one: entries of {output, assert, label: pass|fail, note?} — the principal's labels are the ground truth the judge is tuned to.`;
    console.error(error);
    return { code: 1, error };
  }
  const entries = set.set.entries;
  if (entries.length === 0) { console.error('Calibration set is empty.'); return { code: 1, error: 'empty set' }; }
  if (!validCalibrationEntries(entries)) return { code: 1, error: 'Every calibration example needs distinct content for its criterion, a readable image or nonempty output, an assertion, and an explicit pass/fail label; no record was changed.' };
  const suiteDefinition = resolveSuiteDefinition(suiteName, opts.suiteDirs);
  if (!suiteDefinition) {
    const error = `Suite definition unavailable for '${suiteName}'; calibration remains provisional and no record was changed.`;
    console.error(error);
    return { code: 1, error };
  }
  if (!coversSuiteAssertions(entries, suiteDefinition)) {
    const error = `Calibration labels for '${suiteName}' do not cover every judged assertion in the resolved suite; no record was changed.`;
    console.error(error);
    return { code: 1, error };
  }
  const image = suiteDefinition.modality === 'image';
  if (image && entries.some((entry) => !entry.image)) return { code: 1, error: 'Image calibration requires a case id, local image artifact, and effective reference for every principal label; no record was changed.' };
  if (!image && entries.some((entry) => entry.image)) return { code: 1, error: 'Text calibration cannot certify image evidence; no record was changed.' };
  if (!image && suiteDefinition.judged_assertions.some((a) => !isModelAssert(a.type))) return { code: 1, error: "Calibration requires the actual judge modality; pairwise calibration is not implemented by this runner." };
  if (suiteDefinition.judge_model != null) return { code: 1, error: "Explicit judge_model calibration is not supported by this level-based runner; no record was changed." };
  if (suiteDefinition.judge_level != null && suiteDefinition.judge_level !== level) return { code: 1, error: "Requested calibration level differs from the suite's executing judge_level; no record was changed." };
  const judge = opts.judge ?? realJudge;
  const initialImageEvidence = image ? imageEvidenceHashOf(entries) : undefined;
  const initialImagePipeline = image ? imagePipelineHash(suiteName) : undefined;
  if (image && (!initialImageEvidence || !initialImagePipeline)) return { code: 1, error: 'Image evidence or pipeline is unavailable before calibration; no record was changed.' };
  const verdicts: Verdict[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    let v: Verdict;
    try { v = image ? await judgeImageEntry(e, level, opts, suiteDefinition, suiteName) : await judge(e.output!, e.assert as Assertion, level); }
    catch (error) { return { code: 1, error: `judge unavailable on label #${i}: ${(error as Error).message}` }; }
    if (v.available === false || /^judge (?:error|exception|returned unparseable verdict|returned no assertion verdicts)/i.test(v.reason)) {
      return { code: 1, error: `judge unavailable on label #${i}: ${v.reason}` };
    }
    verdicts.push(v);
    const judgeSays = v.passed ? 'pass' : 'fail';
    log(`  ${judgeSays === e.label ? '✅' : '❌'} #${i}: label=${e.label} judge=${judgeSays}`);
  }
  const vendors = opts.vendors ?? resolveVendors();
  const chain = image ? imageJudgeChain(level, suiteDefinition.judged_assertions, vendors, undefined, suiteName) : judgeChain(level, vendors);
  const evidence = image ? imageEvidenceHashOf(entries) : undefined;
  const pipeline = image ? imagePipelineHash(suiteName) : undefined;
  if (image && (!evidence || !pipeline)) return { code: 1, error: 'Image calibration evidence or pipeline binding is unavailable; no record was changed.' };
  if (image && (evidence !== initialImageEvidence || pipeline !== initialImagePipeline)) return { code: 1, error: 'Image evidence or pipeline changed during calibration; no record was changed.' };
  const currentSet = readSet(suiteName, dir);
  if (!currentSet || calibrationLabelsHash(currentSet.set.entries) !== calibrationLabelsHash(entries)) return { code: 1, error: 'Principal labels changed during calibration; no record was changed.' };
  const record = scoreCalibration({ suite: suiteName, level, entries, verdicts, chain, labels_ts: set.labels_ts, ts: (opts.now ?? new Date()).toISOString(), suite_definition: suiteDefinition,
    modality: image ? 'image' : 'text', image_evidence_hash: evidence, image_pipeline_hash: pipeline });
  invariant(record.suite_rubric_hash === suiteDefinition.suite_rubric_hash, 'calibration record must bind the resolved suite rubric before persistence');
  invariant(record.judge_config_hash === suiteDefinition.judge_config_hash, 'calibration record must bind resolved judge configuration before persistence');
  writeFileSync(recordPathOf(suiteName, dir), JSON.stringify(record, null, 2));

  // The Articulation Log block: always written beside the record; appended to the owning ISA only on request.
  const block = renderCalibrationLogBlock(record, entries, { claim: set.set.claim, ts: opts.now });
  const logPath = join(dir, `${suiteName}.log.md`);
  writeFileSync(logPath, block);
  let appendedTo: string | undefined;
  if (opts.appendLog) {
    const isa = set.set.isa ? set.set.isa.replace(/^~(?=\/)/, process.env.HOME ?? '') : null;
    if (!isa || !existsSync(isa)) {
      console.error(`--append-log: the set names no readable ISA (isa: ${set.set.isa ?? 'missing'}); block left at ${logPath}`);
    } else {
      appendArticulationLog(isa, block);
      appendedTo = isa;
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(record, null, 2));
  } else if (!opts.quiet) {
    const agree = Math.round(record.agreement * record.n);
    console.log(`Label basis: ${record.label_basis} · human validation: ${record.human_validated ? 'recorded' : 'not recorded'}`);
    console.log(`\n🎯 agreement ${(record.agreement * 100).toFixed(0)}% (${agree}/${record.n}) · kappa ${record.kappa.toFixed(2)} · ${record.per_rung.pass} pass / ${record.per_rung.fail} fail · judge='${level}' (${record.judge_model_id})`);
    const floors = calibrationFloors();
    console.log(record.earned
      ? `   EARNED: agreement ≥ ${floors.agreement * 100}%, kappa ≥ ${floors.kappa}, ≥ ${MIN_PER_RUNG} labels per rung. EvalRunner defaults this suite's judge to '${level}'.`
      : `   PROVISIONAL: ${record.agreement < floors.agreement ? `agreement below ${floors.agreement * 100}%` : record.kappa < floors.kappa ? `kappa ${record.kappa.toFixed(2)} below ${floors.kappa} (the judge is not separating the rungs)` : `fewer than ${MIN_PER_RUNG} labels on a rung`}. Judge stays 'high'. Fix the rubric anchors or grow the set, then re-run.`);
    if (record.disagreements.length) {
      console.log(`\n⛏️  REVIEW DISAGREEMENTS (diagnose criterion ambiguity, judge error, or a label needing principal review; preserve the intended standard, record moved:/why:, and validate revisions on held-out labels):`);
      for (const d of record.disagreements) console.log(`   - #${d.i}: label said ${d.label}, judge said ${d.judge} — ${d.note ?? d.reason}${d.moved !== 'undecided' ? ` [moved: ${d.moved}]` : ''}`);
    }
    console.log(`\n📝 Articulation Log block → ${logPath}${appendedTo ? ` (appended to ${appendedTo})` : set.set.isa ? ' (re-run with --append-log to append it to the ISA)' : ' (set names no isa:; add one to route it)'}`);
  }
  return { code: 0, record, logPath, appendedTo };
}

/** Append a block under `## Articulation Log`, creating the section at the end when the ISA has none. */
export function appendArticulationLog(isaPath: string, block: string): void {
  const text = readFileSync(isaPath, 'utf8');
  const hasSection = /^## Articulation Log\s*$/m.test(text);
  writeFileSync(isaPath, `${text.replace(/\s*$/, '')}\n\n${hasSection ? '' : '## Articulation Log\n\n'}${block.replace(/\s*$/, '')}\n`);
}

// ── --recheck: re-run every stale record (ModelSync daily) ────────────────────

export interface RecheckReport { rechecked: string[]; dropped: string[]; fresh: string[]; errors: string[] }

/** Which records no longer describe today's judge, and why. Pure over the dir. */
export function staleRecords(dir = calibrationDir(), vendors = resolveVendors(), model?: (v: Vendor, l: InferenceLevel) => string, suiteDirs?: string[]): { suite: string; record: CalibrationRecord; stale: string[] }[] {
  if (!existsSync(dir)) return [];
  const out: { suite: string; record: CalibrationRecord; stale: string[] }[] = [];
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.pairwise.result.json')) continue;
    const m = f.match(/^(.+)\.result\.json$/);
    if (!m) continue;
    const suite = m[1]!;
    const record = readRecord(suite, dir);
    if (!record) continue;
    if (!Array.isArray(record.chain) || typeof record.kappa !== 'number') { out.push({ suite, record, stale: ['record predates kappa/chain'] }); continue; }
    if (!record.suite_rubric_hash || !record.judge_config_hash || typeof record.coverage_ok !== 'boolean') { out.push({ suite, record, stale: ['record predates suite binding'] }); continue; }
    const set = readSet(suite, dir);
    if (!set) { out.push({ suite, record, stale: ['calibration labels unavailable'] }); continue; }
    const suiteDefinition = resolveSuiteDefinition(suite, suiteDirs);
    if (!suiteDefinition) { out.push({ suite, record, stale: ['suite definition unavailable'] }); continue; }
    const image = suiteDefinition.modality === 'image';
    const stale = stalenessOf(record, {
      chain_hash: chainHashOf(image ? imageJudgeChain(record.judge_level, suiteDefinition.judged_assertions, vendors, model, suite) : judgeChain(record.judge_level, vendors, model)),
      rubric_hash: rubricHashOf(set.set.entries),
      labels_ts: set.labels_ts,
      labels_hash: calibrationLabelsHash(set.set.entries),
      suite_rubric_hash: suiteDefinition.suite_rubric_hash,
      judge_config_hash: suiteDefinition.judge_config_hash,
      ...(image ? { image_evidence_hash: imageEvidenceHashOf(set.set.entries), image_pipeline_hash: imagePipelineHash(suite) } : {}),
    });
    if (stale.length) out.push({ suite, record, stale });
  }
  return out;
}

/** Only a drop pages: a suite that HAD the cheap judge and lost it. Never a suite that was already provisional. */
export function shouldPage(before: CalibrationRecord, after: CalibrationRecord): boolean {
  return before.earned === true && after.earned === false;
}

/** The page for a suite that lost its cheap judge (F13): a 🧪 card, what fell, the numbers, the next action. */
export function dropPageText(suite: string, agreement: number, kappa: number): string {
  return textCard({
    kind: 'judge',
    title: 'Judge calibration dropped',
    body: [
      `Eval suite "${suite}" fell below the floor after a model change.`,
      `Agreement ${(agreement * 100).toFixed(0)}%, kappa ${kappa.toFixed(2)}.`,
      "The suite runs provisional at judge 'high'. Review disagreements before changing the judge, criterion, or labels.",
    ],
  });
}

/** The --page sender: the own-line helper with this tool's origin, so the text gets the 🧪 icon even if a caller hands in plain words. */
export function pageSender(send: (text: string, origin?: string) => { ok: boolean; reason: string } = sendOwnText): (text: string) => void {
  return (text: string) => { const r = send(text, 'calibrate'); if (!r.ok) console.error(`page failed: ${r.reason}`); };
}

export async function recheck(opts: CalibrateOptions & { page?: (text: string) => void | Promise<void> } = {}): Promise<RecheckReport> {
  const dir = opts.dir ?? calibrationDir();
  const report: RecheckReport = { rechecked: [], dropped: [], fresh: [], errors: [] };
  const stale = staleRecords(dir, opts.vendors, undefined, opts.suiteDirs);
  const all = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.result.json') && !f.endsWith('.pairwise.result.json')).map((f) => f.replace(/\.result\.json$/, '')) : [];
  report.fresh = all.filter((s) => !stale.some((x) => x.suite === s));
  for (const { suite, record: before, stale: why } of stale) {
    if (!opts.quiet) console.log(`↻ ${suite}: ${why.join('; ')} — recalibrating over the stored labels`);
    const r = await calibrate(suite, before.judge_level, { ...opts, appendLog: false, json: false, quiet: true });
    if (r.code !== 0 || !r.record) { report.errors.push(`${suite}: ${r.error ?? 'calibration failed'}`); continue; }
    report.rechecked.push(suite);
    if (shouldPage(before, r.record)) {
      report.dropped.push(suite);
      const text = dropPageText(suite, r.record.agreement, r.record.kappa);
      // Awaited: the CLI exits right after recheck resolves, so a page that is still in flight would be lost.
      if (opts.page) await opts.page(text);
    }
  }
  if (!opts.quiet) console.log(`recheck: ${report.rechecked.length} recalibrated (${report.dropped.length} dropped below floor) · ${report.fresh.length} fresh · ${report.errors.length} errors`);
  return report;
}

// ── --residue ────────────────────────────────────────────────────────────────

export interface ResidueRow { suite: string; residue: number; det: number; judged: number; /** ISC-18: judged asserts carrying no `derived_from` lineage */ unlineaged: number }

export function residueRows(suiteDirs: string[]): ResidueRow[] {
  const rows: ResidueRow[] = [];
  for (const dir of suiteDirs) {
    if (!existsSync(dir)) continue;
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        if (f.isDirectory() && !f.name.startsWith('_') && !f.name.startsWith('.')) walk(join(d, f.name));
        else if (/\.ya?ml$/.test(f.name)) files.push(join(d, f.name));
      }
    };
    walk(dir);
    for (const f of files) {
      try {
        const suite = parseYaml(readFileSync(f, 'utf-8')) as { name?: string; cases?: { assert?: Assertion[] }[] };
        if (!Array.isArray(suite.cases)) continue;
        const asserts = suite.cases.flatMap((c) => c.assert ?? []);
        if (asserts.length === 0) continue;
        const judgedAsserts = asserts.filter((a) => isJudgedAssert(a.type));
        const judged = judgedAsserts.length;
        const unlineaged = judgedAsserts.filter((a) => !String(a.derived_from ?? '').trim()).length;
        rows.push({ suite: suite.name ?? f, residue: judged / asserts.length, det: asserts.length - judged, judged, unlineaged });
      } catch { /* unparseable suite — skip */ }
    }
  }
  return rows.sort((a, b) => b.residue - a.residue);
}

export function residueReport(opts: { suiteDirs?: string[]; seeds?: string; records?: string } = {}): number {
  const suiteDirs = opts.suiteDirs ?? [join(assayUserDir(), 'Suites'), join(getSkillsDir(), 'Assay', 'Suites')];
  console.log(`\n⚖️  JUDGED RESIDUE (shrink this — judges are debt):\n`);
  const rows = residueRows(suiteDirs);
  for (const r of rows) console.log(`   ${(r.residue * 100).toFixed(0).padStart(3)}%  ${r.suite}  (${r.judged} judged / ${r.det} deterministic)${r.unlineaged ? `  ⚠️ ${r.unlineaged} judged assert${r.unlineaged > 1 ? 's' : ''} with no derived_from lineage` : ''}`);
  const orphaned = rows.reduce((s, r) => s + r.unlineaged, 0);
  if (orphaned) console.log(`\n   ${orphaned} judged assert${orphaned > 1 ? 's' : ''} name no owning ISA section (\`derived_from: <isa-path>#<section>\`) — judge content that came from nowhere is the residue to shrink first.`);
  const seeds = seedSummaries(opts.seeds ?? seedsDir());
  const ready = seeds.filter((s) => s.judge_ready);
  console.log(`\n🪜 MANUAL → JUDGED LADDER (attested labels from \`bunker attest\`; ${JUDGE_READY_LABELS}+ labels = judge-ready):\n`);
  if (seeds.length === 0) console.log('   no attested seeds yet');
  for (const s of seeds) console.log(`   ${s.judge_ready ? '🟢 judge-ready' : '⚪ collecting '}  ${s.claim.padEnd(10)} ${String(s.labels).padStart(3)} labels (${s.per_rung.pass} pass / ${s.per_rung.fail} fail)  ${s.isa}`);
  if (ready.length) console.log(`\n   ${ready.length} criteria ready to graduate: write the judged assert from the labels, calibrate it, then retire the manual row.`);
  const recordsDir = opts.records ?? calibrationDir();
  const records: Array<{ suite: string; state: CalibrationState }> = [];
  if (existsSync(recordsDir)) {
    for (const f of readdirSync(recordsDir).filter((name) => name.endsWith('.result.json') && !name.endsWith('.pairwise.result.json')).sort()) {
      try {
        const record = JSON.parse(readFileSync(join(recordsDir, f), 'utf8')) as CalibrationRecord;
        records.push({ suite: record.suite || f.replace(/\.result\.json$/, ''), state: calibrationState(record) });
      } catch { /* unreadable calibration record — skip */ }
    }
  }
  const counts = { earned: 0, provisional: 0, proxy: 0 };
  for (const record of records) counts[record.state] += 1;
  console.log(`\n🧾 PROXY RECORDS (${counts.proxy}):\n`);
  for (const record of records.filter((r) => r.state === 'proxy')) console.log(`   PROXY  ${record.suite}`);
  if (counts.proxy === 0) console.log('   none');
  console.log(`\nCalibration records: ${counts.earned} earned / ${counts.provisional} provisional / ${counts.proxy} proxy`);
  return 0;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      suite: { type: 'string', short: 's' },
      level: { type: 'string' },
      residue: { type: 'boolean' },
      recheck: { type: 'boolean' },
      page: { type: 'boolean' },
      'append-log': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || (!values.suite && !values.residue && !values.recheck)) {
    console.log(`Calibrate — judge calibration + shrinkage\n\n  bun Calibrate.ts -s <suite> [--level low] [--json] [--append-log]\n  bun Calibrate.ts --recheck [--page]\n  bun Calibrate.ts --residue`);
    process.exit(values.help ? 0 : 1);
  }
  if (values.residue) process.exit(residueReport());
  if (values.recheck) {
    // Paging rides the same own-line helper the scheduler watchdog uses: the number comes from the bridge config, never from here.
    const page = values.page ? pageSender() : undefined;
    const rep = await recheck({ page });
    process.exit(rep.errors.length ? 1 : 0);
  }
  const r = await calibrate(values.suite!, (values.level as InferenceLevel) ?? 'low', { json: values.json ?? false, appendLog: values['append-log'] ?? false });
  // Several stop paths return their reason without printing it (2026-10-10: a long run stopped partway with exit 1 and no message).
  if (r.code !== 0 && r.error) console.error(`calibrate: ${r.error}`);
  process.exit(r.code);
}
