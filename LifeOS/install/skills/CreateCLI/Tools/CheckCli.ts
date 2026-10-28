#!/usr/bin/env bun
// CheckCli.ts — mechanical checks for a CLI CreateCLI generated or changed.
//
// Usage:
//   bun skills/CreateCLI/Tools/CheckCli.ts <cli-dir> [--entry <file>] [--json-args "<args>"]... [--no-tsc]
//
// Checks, each reported as pass | fail | skip in one JSON report on stdout:
//   tsc      `bunx tsc --noEmit` exits 0 in <cli-dir>
//   help     `--help` exits 0 and names every command found in the source
//            (Tier 1 `case 'name':` arms, Tier 2 `.command('name')` calls)
//   version  `--version` exits 0 and prints something
//   unknown  an unknown command exits 1 with a message on stderr
//   json     each `--json-args` invocation exits 0 and its stdout parses as JSON
// Exit code: 0 when nothing failed, 1 when a check failed or the arguments are wrong.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

type Status = 'pass' | 'fail' | 'skip';
interface Check { name: string; status: Status; detail: string }
interface Report { dir: string; entry: string; commands: string[]; ok: boolean; checks: Check[] }

const UNKNOWN = '__checkcli_unknown_command__';

function usage(msg: string): never {
  console.error(`Error: ${msg}`);
  console.error('Usage: bun CheckCli.ts <cli-dir> [--entry <file>] [--json-args "<args>"]... [--no-tsc]');
  process.exit(1);
}

function run(cmd: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', env: process.env });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

function findEntry(dir: string, explicit?: string): string {
  if (explicit) return explicit;
  const byName = `${basename(dir)}.ts`;
  if (existsSync(join(dir, byName))) return byName;
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin ? Object.values(pkg.bin)[0] : undefined;
    if (bin) return bin.replace(/^\.\//, '');
  }
  usage(`no entry found in ${dir}: expected ${byName} or a package.json "bin" (or pass --entry)`);
}

/** Command names declared in the source: switch arms (Tier 1) and Commander `.command()` calls (Tier 2). */
export function commandsIn(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/case\s+['"]([a-z][\w:-]*)['"]\s*:/g)) names.add(m[1]);
  for (const m of source.matchAll(/\.command\(\s*['"]([a-z][\w:-]*)/g)) names.add(m[1]);
  return [...names].sort();
}

function splitArgs(s: string): string[] {
  return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
}

export function checkCli(dirArg: string, opts: { entry?: string; jsonArgs?: string[]; tsc?: boolean } = {}): Report {
  const dir = resolve(dirArg);
  if (!existsSync(dir)) usage(`directory not found: ${dir}`);
  const entry = findEntry(dir, opts.entry);
  if (!existsSync(join(dir, entry))) usage(`entry not found: ${join(dir, entry)}`);
  const source = readFileSync(join(dir, entry), 'utf-8');
  const commands = commandsIn(source);
  const cli = (args: string[]) => run(['bun', entry, ...args], dir);
  const checks: Check[] = [];

  if (opts.tsc === false) {
    checks.push({ name: 'tsc', status: 'skip', detail: '--no-tsc' });
  } else {
    const t = run(['bunx', 'tsc', '--noEmit'], dir);
    checks.push({ name: 'tsc', status: t.code === 0 ? 'pass' : 'fail',
      detail: t.code === 0 ? 'bunx tsc --noEmit exited 0' : `exit ${t.code}: ${(t.stdout + t.stderr).trim().split('\n').slice(0, 5).join(' | ')}` });
  }

  const h = cli(['--help']);
  const helpText = h.stdout + h.stderr;
  const missing = commands.filter(c => !new RegExp(`(^|[^\\w-])${c.replace(/[-:]/g, '\\$&')}([^\\w-]|$)`, 'm').test(helpText));
  checks.push({ name: 'help',
    status: h.code === 0 && commands.length > 0 && missing.length === 0 ? 'pass' : 'fail',
    detail: h.code !== 0 ? `--help exited ${h.code}`
      : commands.length === 0 ? 'no commands found in the source'
      : missing.length ? `--help omits: ${missing.join(', ')}` : `lists all ${commands.length} commands` });

  const v = cli(['--version']);
  checks.push({ name: 'version', status: v.code === 0 && (v.stdout + v.stderr).trim() ? 'pass' : 'fail',
    detail: v.code === 0 ? (v.stdout + v.stderr).trim().split('\n')[0] || 'printed nothing' : `--version exited ${v.code}` });

  const u = cli([UNKNOWN]);
  checks.push({ name: 'unknown', status: u.code === 1 && u.stderr.trim() ? 'pass' : 'fail',
    detail: u.code !== 1 ? `unknown command exited ${u.code}, expected 1` : u.stderr.trim() ? 'exit 1 with a stderr message' : 'exit 1 but stderr empty' });

  const jsonArgs = opts.jsonArgs ?? [];
  if (jsonArgs.length === 0) checks.push({ name: 'json', status: 'skip', detail: 'no --json-args given' });
  for (const a of jsonArgs) {
    const r = cli(splitArgs(a));
    let parsed = true;
    try { JSON.parse(r.stdout); } catch { parsed = false; }
    checks.push({ name: 'json', status: r.code === 0 && parsed ? 'pass' : 'fail',
      detail: `${a}: ${r.code !== 0 ? `exited ${r.code}` : parsed ? 'exit 0, stdout is JSON' : 'stdout is not valid JSON'}` });
  }

  return { dir, entry, commands, ok: checks.every(c => c.status !== 'fail'), checks };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let dir: string | undefined; let entry: string | undefined; let tsc = true;
  const jsonArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--entry') entry = argv[++i] ?? usage('--entry needs a file');
    else if (a === '--json-args') jsonArgs.push(argv[++i] ?? usage('--json-args needs a value'));
    else if (a === '--no-tsc') tsc = false;
    else if (a === '--help' || a === '-h') { console.log(readFileSync(import.meta.path, 'utf-8').split('\n').slice(1, 15).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
    else if (a.startsWith('-')) usage(`unknown flag ${a}`);
    else if (!dir) dir = a;
    else usage(`unexpected argument ${a}`);
  }
  if (!dir) usage('missing <cli-dir>');
  const report = checkCli(dir, { entry, jsonArgs, tsc });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
