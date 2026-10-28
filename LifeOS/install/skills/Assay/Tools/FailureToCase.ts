#!/usr/bin/env bun
/**
 * FailureToCase — turn a real observed failure into a v2 eval case.
 *
 * Anthropic roadmap step 1: seed suites from 20-50 REAL failures — effect
 * sizes are large early, so small curated sets beat invented ones. This tool
 * takes one failure (the prompt that failed + what went wrong) and appends a
 * runnable case skeleton to a draft suite in the USER layer, where it is
 * reviewed, sharpened, and promoted into a real suite.
 *
 *   bun FailureToCase.ts --suite <draft-name> --id <case_id> \
 *     --prompt "the user turn that failed" \
 *     --banned "phrase the bad output contained" \
 *     --expect "NL assertion of what a good output does"
 *
 * Drafts land at LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Assay/Suites/_drafts/<name>.yaml
 * (the _drafts dir is excluded from SuiteManager listing until promoted).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assayUserDir } from '../../../LIFEOS/TOOLS/Paths.ts';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const DRAFTS = join(assayUserDir(join(homedir(), '.claude', 'LIFEOS')), 'Suites', '_drafts');

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      suite: { type: 'string' },
      id: { type: 'string' },
      prompt: { type: 'string' },
      banned: { type: 'string' },
      expect: { type: 'string' },
      negative: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !values.suite || !values.id || !values.prompt) {
    console.log(`FailureToCase — real failure → v2 case skeleton\n\n  bun FailureToCase.ts --suite <draft> --id <case_id> --prompt "..." [--banned "..."] [--expect "..."] [--negative]`);
    process.exit(values.help ? 0 : 1);
  }
  mkdirSync(DRAFTS, { recursive: true });
  const path = join(DRAFTS, `${values.suite}.yaml`);
  const suite = existsSync(path)
    ? (parseYaml(readFileSync(path, 'utf-8')) as Record<string, unknown> & { cases: unknown[] })
    : { name: values.suite, type: 'capability', trials: 3, pass_threshold: 0.75, cases: [] as unknown[] };

  const assert: Record<string, unknown>[] = [];
  if (values.banned) assert.push({ type: 'not-icontains', value: values.banned, weight: 1 });
  if (values.expect) assert.push({ type: 'llm-assert', value: [values.expect], weight: 1 });
  if (assert.length === 0) assert.push({ type: 'llm-assert', value: ['REPLACE: what must be true of a good output'], weight: 1 });

  const cases = suite.cases as Record<string, unknown>[];
  if (cases.some((c) => c.id === values.id)) {
    console.error(`Case id '${values.id}' already exists in ${path}`);
    process.exit(1);
  }
  cases.push({ id: values.id, ...(values.negative ? { negative: true } : {}), prompt: values.prompt, assert });
  writeFileSync(path, stringifyYaml(suite));
  console.log(`📥 ${values.id} appended to ${path} (${cases.length} cases). Sharpen the asserts — prefer deterministic; every judged clause is debt.`);
  process.exit(0);
}
