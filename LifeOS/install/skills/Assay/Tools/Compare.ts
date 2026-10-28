#!/usr/bin/env bun
/**
 * Compare — paired-difference comparison of two configurations on ONE suite.
 *
 * The only sanctioned way to compare prompts, levels, or ablations: both arms
 * run the SAME cases, per-case mean scores are paired, and the verdict comes
 * from the paired 95% CI (Anthropic statistical doctrine — paired differences
 * cancel case-difficulty variance; two independent runs need far more cases to
 * see the same effect).
 *
 * Arms are JSON overrides of the suite (system_prompt / system_prompt_file /
 * agent_level). The with/without ablation is arm B carrying a system prompt
 * with the component under test removed — the score delta IS the component's
 * measured contribution (the skill-creator benchmark shape).
 *
 *   bun Compare.ts -s <suite> --b '{"agent_level":"low"}'                 # A = suite as-is
 *   bun Compare.ts -s <suite> --a '{"system_prompt_file":"v1.md"}' --b '{"system_prompt_file":"v2.md"}'
 *   bun Compare.ts -s <suite> --b '{}' --label-a with --label-b without
 *
 * Subscription-billed via the runner. Duration per arm is reported; token
 * counts are not available from the Inference envelope.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { runSuite, type EvalSuiteV2 } from './EvalRunner.ts';
import { pairedDiff, pairedPowerN } from './Stats.ts';

const RESULTS_DIR = join(homedir(), '.claude', 'LIFEOS', 'MEMORY', 'STATE', 'Evals-Results');

interface ArmSpec {
  system_prompt?: string;
  system_prompt_file?: string;
  agent_level?: EvalSuiteV2['agent_level'];
}

function toOverride(spec: ArmSpec): Partial<EvalSuiteV2> {
  const o: Partial<EvalSuiteV2> = {};
  if (spec.system_prompt_file) o.system_prompt = readFileSync(spec.system_prompt_file, 'utf-8');
  else if (spec.system_prompt) o.system_prompt = spec.system_prompt;
  if (spec.agent_level) o.agent_level = spec.agent_level;
  return o;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      suite: { type: 'string', short: 's' },
      a: { type: 'string' },
      b: { type: 'string' },
      'label-a': { type: 'string' },
      'label-b': { type: 'string' },
      trials: { type: 'string', short: 't' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !values.suite || !values.b) {
    console.log(`Compare — paired A/B comparison on one suite\n\n  bun Compare.ts -s <suite> [--a '<json>'] --b '<json>' [--label-a A --label-b B] [-t trials]\n\nArm JSON keys: system_prompt | system_prompt_file | agent_level. Arm A defaults to the suite as-is.`);
    process.exit(values.help ? 0 : 1);
  }
  const labelA = values['label-a'] ?? 'A';
  const labelB = values['label-b'] ?? 'B';
  const trials = values.trials ? { trials: parseInt(values.trials) } : {};
  const armA = { ...toOverride(JSON.parse(values.a ?? '{}') as ArmSpec), ...trials };
  const armB = { ...toOverride(JSON.parse(values.b) as ArmSpec), ...trials };

  console.log(`\n== Arm ${labelA}: ${values.suite} ==`);
  const ra = await runSuite(values.suite, armA);
  if (ra.verifier_unavailable) { console.error(`No comparison verdict: ${ra.summary}`); process.exit(2); }
  if (ra.run_id === 'error') { console.error(ra.summary); process.exit(1); }
  console.log(`\n== Arm ${labelB}: ${values.suite} ==`);
  const rb = await runSuite(values.suite, armB);
  if (rb.verifier_unavailable) { console.error(`No comparison verdict: ${rb.summary}`); process.exit(2); }
  if (rb.run_id === 'error') { console.error(rb.summary); process.exit(1); }

  // Pair per-case means, index-aligned by case id (same suite → same order,
  // but align by id defensively so a filtered arm fails loud, not misaligned).
  const byIdB = new Map(rb.cases.map((c) => [c.id, c.mean_score]));
  const ids = ra.cases.map((c) => c.id).filter((id) => byIdB.has(id));
  if (ids.length !== ra.cases.length || ids.length !== rb.cases.length) {
    console.error(`case sets differ between arms (${ra.cases.length} vs ${rb.cases.length}, ${ids.length} shared) — refusing to compare`);
    process.exit(1);
  }
  const a = ids.map((id) => ra.cases.find((c) => c.id === id)!.mean_score);
  const b = ids.map((id) => byIdB.get(id)!);
  const d = pairedDiff(a, b);

  const verdict = !d.significant ? 'TIE (95% CI includes 0)' : d.mean_diff > 0 ? `${labelB} WINS` : `${labelA} WINS`;
  const sdDiff = d.sem * Math.sqrt(d.n);
  const powerHint = d.significant || sdDiff === 0 ? null : pairedPowerN(Math.max(Math.abs(d.mean_diff), 0.02), sdDiff);

  const report = {
    suite: values.suite,
    ts: new Date().toISOString(),
    arms: { [labelA]: { score: ra.score, pass_to_k: ra.pass_to_k, duration_ms: ra.duration_ms }, [labelB]: { score: rb.score, pass_to_k: rb.pass_to_k, duration_ms: rb.duration_ms } },
    paired: d,
    verdict,
    per_case: ids.map((id, i) => ({ id, [labelA]: a[i], [labelB]: b[i], diff: b[i] - a[i] })),
  };
  mkdirSync(join(RESULTS_DIR, values.suite), { recursive: true });
  const outPath = join(RESULTS_DIR, values.suite, `compare_${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n⚖️  ${verdict}`);
    console.log(`   ${labelB} − ${labelA}: ${(d.mean_diff * 100).toFixed(1)} pts, 95% CI [${(d.ci95_lo * 100).toFixed(1)}, ${(d.ci95_hi * 100).toFixed(1)}], n=${d.n}, r=${d.correlation.toFixed(2)}`);
    if (powerHint) console.log(`   underpowered? detecting this delta reliably needs ~${powerHint} cases (have ${d.n})`);
    for (const row of report.per_case) console.log(`   - ${row.id}: ${labelA} ${((row as Record<string, number | string>)[labelA] as number * 100).toFixed(0)}% → ${labelB} ${((row as Record<string, number | string>)[labelB] as number * 100).toFixed(0)}%`);
    console.log(`   saved: ${outPath}`);
  }
  process.exit(0);
}
