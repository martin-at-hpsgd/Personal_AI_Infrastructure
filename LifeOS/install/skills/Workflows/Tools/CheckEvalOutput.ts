#!/usr/bin/env bun
/**
 * CheckEvalOutput — run the real `workflow validate` over the definitions a
 * `workflows-authoring` eval run produced.
 *
 * The eval runner is single-shot and has no assert that shells out, so the
 * suite scores structure and this tool scores truth: it pulls every YAML fence
 * out of each trial's output, writes them into a scratch definitions home and
 * validates each with the CLI. A trial passes only when it holds at least one
 * definition and every definition validates. A case passes when every trial does.
 *
 * Usage:
 *   bun skills/Workflows/Tools/CheckEvalOutput.ts                   # latest run of the suite
 *   bun skills/Workflows/Tools/CheckEvalOutput.ts --run <run.json>
 *   bun skills/Workflows/Tools/CheckEvalOutput.ts --file <text-file>  # one output, any text
 *   Options: --suite <name> (default workflows-authoring), --min <cases> (default 9), --json
 * Exit: 0 at or above --min passing cases (or a valid --file), 1 below, 2 usage.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const CLI = join(ROOT, 'LIFEOS', 'WORKFLOWS', 'workflow.ts');
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface DefinitionVerdict {
  name: string | null;
  valid: boolean;
  detail: string;
}

/** Every ```yaml fence in the text; the whole text when it has none and looks like a definition. */
export function extractDefinitions(text: string): string[] {
  const fences = [...text.matchAll(/```(?:yaml|yml)[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (fences.length > 0) return fences;
  return /^\s*version:\s*2\b/m.test(text) ? [text] : [];
}

/** Validate every definition in one output against the real CLI, inside a scratch home. */
export function validateOutput(text: string): DefinitionVerdict[] {
  const defs = extractDefinitions(text);
  if (defs.length === 0) return [{ name: null, valid: false, detail: 'no YAML definition found' }];
  const home = mkdtempSync(join(tmpdir(), 'wf-check-'));
  try {
    const staged: Array<{ name: string | null; path: string | null; error?: string }> = [];
    for (const body of defs) {
      let parsed: unknown;
      try {
        parsed = Bun.YAML.parse(body);
      } catch (e) {
        staged.push({ name: null, path: null, error: `YAML parse error: ${(e as Error).message.split('\n')[0]}` });
        continue;
      }
      const name = (parsed as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || !NAME_RE.test(name)) {
        staged.push({ name: typeof name === 'string' ? name : null, path: null, error: 'missing or non-kebab-case name' });
        continue;
      }
      // Staging is by name, so a second fence with the same name would overwrite the
      // first and both verdicts would score the last body; refuse the repeat instead.
      if (staged.some((s) => s.name === name && s.path)) {
        staged.push({ name, path: null, error: 'duplicate name: an earlier definition in this output already uses it' });
        continue;
      }
      const path = join(home, `${name}.workflow.yaml`);
      writeFileSync(path, body);
      staged.push({ name, path });
    }
    return staged.map((s) => {
      if (!s.path) return { name: s.name, valid: false, detail: s.error ?? 'unstaged' };
      const r = Bun.spawnSync(['bun', CLI, 'validate', s.path, '--json'], {
        env: { ...process.env, LIFEOS_WORKFLOWS_DIR: home },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = r.stdout.toString();
      let detail = out.trim().split('\n')[0] ?? '';
      try {
        const j = JSON.parse(out) as { ok?: boolean; errors?: unknown[] };
        detail = j.ok ? 'valid' : `invalid: ${JSON.stringify(j.errors ?? j).slice(0, 300)}`;
      } catch {
        detail = `${detail} ${r.stderr.toString().trim().split('\n')[0] ?? ''}`.trim();
      }
      return { name: s.name, valid: r.exitCode === 0, detail };
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function trialPasses(verdicts: DefinitionVerdict[]): boolean {
  return verdicts.length > 0 && verdicts.every((v) => v.valid);
}

interface RunFile {
  detail?: Array<{ id: string; trials?: Array<{ output?: string }> }>;
}

export function scoreRun(run: RunFile): { id: string; passed: boolean; trials: DefinitionVerdict[][] }[] {
  return (run.detail ?? []).map((c) => {
    const trials = (c.trials ?? []).map((t) => validateOutput(t.output ?? ''));
    return { id: c.id, passed: trials.length > 0 && trials.every(trialPasses), trials };
  });
}

function latestRun(suite: string): string | null {
  const dir = join(ROOT, 'LIFEOS', 'MEMORY', 'STATE', 'Evals-Results', suite);
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir)
    .map((d) => join(dir, d, 'run.json'))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return runs[0] ?? null;
}

function main(argv: string[]): number {
  const opt = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const json = argv.includes('--json');
  const min = Number(opt('--min') ?? 9);
  if (!Number.isFinite(min)) {
    console.error('--min must be a number');
    return 2;
  }
  const file = opt('--file');
  if (file) {
    if (!existsSync(file)) {
      console.error(`no such file: ${file}`);
      return 2;
    }
    const verdicts = validateOutput(readFileSync(file, 'utf8'));
    const ok = trialPasses(verdicts);
    console.log(json ? JSON.stringify({ ok, verdicts }) : verdicts.map((v) => `${v.valid ? 'valid  ' : 'INVALID'} ${v.name ?? '?'} ${v.detail}`).join('\n'));
    return ok ? 0 : 1;
  }
  const suite = opt('--suite') ?? 'workflows-authoring';
  const runPath = opt('--run') ?? latestRun(suite);
  if (!runPath || !existsSync(runPath)) {
    console.error(`no run.json for suite ${suite}; run the eval first`);
    return 2;
  }
  const results = scoreRun(JSON.parse(readFileSync(runPath, 'utf8')) as RunFile);
  const passed = results.filter((r) => r.passed).length;
  const ok = results.length > 0 && passed >= min;
  if (json) {
    console.log(JSON.stringify({ ok, run: runPath, passed, total: results.length, min, cases: results }));
  } else {
    for (const r of results) {
      const bad = r.trials.flat().filter((v) => !v.valid);
      console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.id}${bad.length ? ` :: ${bad[0].detail}` : ''}`);
    }
    console.log(`${passed}/${results.length} cases produce definitions that pass workflow validate (need ${min}) -> ${ok ? 'OK' : 'BELOW THRESHOLD'}`);
  }
  return ok ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
