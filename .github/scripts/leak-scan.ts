#!/usr/bin/env bun
/**
 * leak-scan.ts — LifeOS public-repo sensitive-content scanner.
 *
 * A name-free, dependency-free backstop that runs in CI (and pre-commit) to
 * stop personal data, private infrastructure, and secrets from reaching the
 * public repo. It complements gitleaks (which handles deep secret detection):
 * this catches the LifeOS-specific classes gitleaks does not — private home
 * paths, internal hosts, `.env`-style assignments, and a runtime-injected list
 * of identity/customer terms.
 *
 * IMPORTANT — this file is PUBLIC. It must contain NONE of the specific names,
 * hostnames, addresses, or tokens it protects. Structural patterns only. The
 * actual sensitive strings are injected at runtime via the SENSITIVE_TERMS env
 * var (a GitHub Actions repo secret), never committed here.
 *
 * Usage:
 *   bun .github/scripts/leak-scan.ts            # scan all git-tracked files
 *   bun .github/scripts/leak-scan.ts --staged   # scan only staged files (pre-commit)
 *   SENSITIVE_TERMS="foo|bar|baz" bun .github/scripts/leak-scan.ts
 *
 * Exit: 0 when clean (no error-severity findings), 1 otherwise.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

type Severity = 'error' | 'warn';
interface Rule {
  id: string;
  severity: Severity;
  desc: string;
  re: RegExp;
  /** optional per-line guard: return true to keep the match, false to drop it */
  keep?: (line: string, match: string) => boolean;
}
interface Finding {
  file: string;
  line: number;
  rule: Rule;
  snippet: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const ALLOWLIST_PATH = join(HERE, 'leak-scan.allowlist.txt');

// ── Structural rules (name-free, committed-safe) ────────────────────────────
const RULES: Rule[] = [
  {
    id: 'home-path',
    severity: 'error',
    desc: 'Private user home path',
    // Case-SENSITIVE: macOS `/Users/` and Linux `/home/` only — not lowercase
    // `/users/` REST path segments. Username placeholders are allowed.
    re: /\/(?:Users|home)\/[A-Za-z][A-Za-z0-9._-]{1,31}(?=[/"'`\s]|$)/g,
    keep: (_l, m) =>
      !/\/(?:Users|home)\/(?:runner|example|username|user|test|you|me|USER_ID|FUZZ|\$)/i.test(m),
  },
  {
    id: 'private-ip',
    severity: 'error',
    desc: 'Private/internal IPv4 address',
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
    // Doc placeholders like 10.0.0.0 / 192.168.1.1 are common — real internal
    // hosts get caught by the octet variety; allowlist handles known examples.
  },
  {
    id: 'internal-tld',
    severity: 'error',
    desc: 'Internal hostname (.lan/.internal)',
    // `.local` intentionally excluded — it is a config-filename convention
    // (`.env.local`, `settings.local.json`) and a non-identifying mDNS TLD.
    // Specific private hostnames belong in SENSITIVE_TERMS.
    re: /\b[a-z][a-z0-9-]{1,}\.(?:lan|internal)\b/gi,
  },
  {
    id: 'env-assignment',
    severity: 'error',
    desc: 'Hardcoded secret assignment',
    re: /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[:=]\s*['"`]([^\s'"`$]{8,})['"`]/g,
    // Keep only real literal values. Drop: env/secret indirection, string
    // values that are themselves ALLCAPS env-var NAMES, regex literals, and
    // parsing/slice code that merely mentions a key name.
    keep: (line, m) => {
      const val = m.match(/['"`]([^\s'"`$]{8,})['"`]/)?.[1] ?? '';
      if (/\$\{\{\s*secrets\./.test(line)) return false;
      if (/process\.env|import\.meta\.env|os\.environ|Deno\.env|getenv|\.slice\(|\.length|new RegExp|=\s*\/\^/.test(line)) return false;
      if (/^[A-Z][A-Z0-9_]+$/.test(val)) return false; // value is an env-var NAME, not a secret
      if (/example|placeholder|your[-_]|generate|xxx|dummy|redacted|<[^>]+>/i.test(val)) return false;
      return true;
    },
  },
  {
    id: 'aws-key',
    severity: 'error',
    desc: 'AWS access key id',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'gh-token',
    severity: 'error',
    desc: 'GitHub token',
    re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    id: 'openai-key',
    severity: 'error',
    desc: 'OpenAI-style key',
    // Boundary before `sk-` so "task-complete" / "risk-averse" don't match.
    // Require a real key body (letters+digits mix, not hyphenated words).
    re: /(?<![A-Za-z0-9-])sk-(?:proj-)?[A-Za-z0-9]{20,}(?![A-Za-z0-9-])/g,
  },
  {
    id: 'slack-token',
    severity: 'error',
    desc: 'Slack token',
    re: /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'private-key-block',
    severity: 'error',
    desc: 'PEM private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: 'cf-workers-subdomain',
    severity: 'warn',
    desc: 'Cloudflare workers.dev subdomain (may name private infra)',
    re: /\b[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/gi,
  },
  {
    id: 'email',
    severity: 'warn',
    desc: 'Email address',
    re: /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi,
    keep: (_l, m) =>
      !/@(?:example\.(?:com|org|net)|test\.|localhost|sentry\.io|users\.noreply\.github\.com)/i.test(m) &&
      !/@\d+x\.(?:png|jpe?g|webp|gif|svg)/i.test(m), // retina asset filenames, not emails
  },
  {
    id: 'us-phone',
    severity: 'warn',
    desc: 'US phone number',
    re: /(?<!\d)(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g,
  },
  {
    id: 'python-file',
    severity: 'warn',
    desc: 'Python file (TypeScript-always policy)',
    re: /\.py$/,
  },
];

// ── Runtime-injected identity/customer terms (never committed) ──────────────
function buildTermRule(): Rule | null {
  const raw = (process.env.SENSITIVE_TERMS ?? '').trim();
  if (!raw) return null;
  const terms = raw
    .split('|')
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (terms.length === 0) return null;
  return {
    id: 'sensitive-term',
    severity: 'error',
    desc: 'Injected identity/customer term (from SENSITIVE_TERMS secret)',
    re: new RegExp(`(?<![A-Za-z0-9])(?:${terms.join('|')})(?![A-Za-z0-9])`, 'gi'),
  };
}

/** A file the scanner could not read was not scanned, so it blocks rather than passing silently. */
const UNREADABLE: Rule = { id: 'unreadable', severity: 'error', desc: 'File could not be read, so it was not scanned', re: /(?!)/g };

// ── File selection ──────────────────────────────────────────────────────────
function trackedFiles(staged: boolean): string[] {
  const cmd = staged
    ? ['git', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT']
    : ['git', 'ls-files', '-z'];
  // -z keeps names with accents or quotes literal; without it git C-quotes them and the file is never read.
  const out = Bun.spawnSync(cmd, { cwd: REPO_ROOT }).stdout.toString();
  return out.split('\0').filter(Boolean);
}

// Binary / vendored paths we never scan the *contents* of (path rules still apply).
const SKIP_CONTENT = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|lock|woff2?|ttf|otf|mp[34]|mov|wav|bin|map)$|\.min\.js$|(?:^|\/)(?:node_modules|dist|build|\.git|_next|out)\//i;

/** An allow entry: an exact string (`line:`) or a pattern whose matches are the excused text (`re:`). */
export type Allow = string | RegExp;

/** Staged mode reads the allowlist from the index, so an unstaged edit to it never excuses a staged line. */
function loadAllowlist(staged: boolean): { paths: RegExp[]; lines: Allow[] } {
  let text: string;
  if (staged) {
    const r = Bun.spawnSync(['git', 'show', ':.github/scripts/leak-scan.allowlist.txt'], { cwd: REPO_ROOT });
    if (r.exitCode !== 0) return { paths: [], lines: [] };
    text = r.stdout.toString();
  } else {
    if (!existsSync(ALLOWLIST_PATH)) return { paths: [], lines: [] };
    text = readFileSync(ALLOWLIST_PATH, 'utf8');
  }
  const paths: RegExp[] = [];
  const lines: Allow[] = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const v = l.slice(l.indexOf(':') + 1).trim();
    if (!v) continue; // an empty entry would excuse everything
    if (l.startsWith('path:')) {
      try { paths.push(new RegExp(v)); } catch { /* skip bad regex */ }
    } else if (l.startsWith('line:')) {
      lines.push(v);
    } else if (l.startsWith('re:')) {
      try { lines.push(new RegExp(v, 'g')); } catch { /* skip bad regex */ }
    }
  }
  return { paths, lines };
}

/** The spans of a line that allow strings cover. An allow string excuses only the matches it overlaps, never the
 *  rest of the line. One ending in a letter or digit counts only where the name or number ends there, so
 *  `github.com/owner/fabric` never excuses `github.com/owner/fabric-private` and an address entry never
 *  excuses a longer address that starts with it. A `re:` pattern excuses exactly the text it matches (8.761.0 publish audit). */
export function allowedSpans(line: string, allowLines: Allow[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const a of allowLines) {
    if (a instanceof RegExp) {
      a.lastIndex = 0;
      for (let m = a.exec(line); m; m = a.exec(line)) {
        if (m[0].length === 0) { a.lastIndex++; continue; }
        spans.push([m.index, m.index + m[0].length]);
      }
      continue;
    }
    for (let i = line.indexOf(a); i !== -1; i = line.indexOf(a, i + 1)) {
      const next = line[i + a.length] ?? '';
      if (/[A-Za-z]$/.test(a) && /[A-Za-z0-9_.-]/.test(next)) continue;
      if (/[0-9]$/.test(a) && /[0-9.]/.test(next)) continue;
      spans.push([i, i + a.length]);
    }
  }
  return spans;
}

// ── Scan ────────────────────────────────────────────────────────────────────
export function scanText(file: string, text: string, rules: Rule[], allowLines: Allow[]): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (const rule of rules) {
    if (rule.id === 'python-file') continue; // path-only rule, handled separately
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const spans = allowedSpans(line, allowLines);
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(line)) !== null) {
        const match = m[0];
        if (rule.keep && !rule.keep(line, match)) continue;
        const end = m.index + match.length;
        // A blocking match is excused only when an entry contains all of it; a warning only needs to overlap one.
        const covered = rule.severity === 'error'
          ? spans.some(([a, b]) => a <= m!.index && end <= b)
          : spans.some(([a, b]) => m!.index < b && end > a);
        if (covered) continue;
        findings.push({ file, line: i + 1, rule, snippet: line.trim().slice(0, 120) });
        if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
      }
    }
  }
  return findings;
}

function main() {
  const staged = process.argv.includes('--staged');
  const termRule = buildTermRule();
  const rules = termRule ? [...RULES, termRule] : RULES;
  const { paths: allowPaths, lines: allowLines } = loadAllowlist(staged);
  const pyRule = RULES.find((r) => r.id === 'python-file')!;

  const files = trackedFiles(staged);
  const findings: Finding[] = [];

  for (const file of files) {
    if (allowPaths.some((p) => p.test(file))) continue;
    if (pyRule.re.test(file)) {
      findings.push({ file, line: 0, rule: pyRule, snippet: '(python file present)' });
    }
    if (SKIP_CONTENT.test(file)) continue;
    // Staged mode scans the index blob, the bytes the commit will carry, never the working-tree file.
    let text: string;
    if (staged) {
      const r = Bun.spawnSync(['git', 'show', `:${file}`], { cwd: REPO_ROOT });
      if (r.exitCode !== 0) { findings.push({ file, line: 0, rule: UNREADABLE, snippet: '(staged blob could not be read)' }); continue; }
      text = r.stdout.toString();
    } else {
      const abs = join(REPO_ROOT, file);
      try { text = readFileSync(abs, 'utf8'); } catch { findings.push({ file, line: 0, rule: UNREADABLE, snippet: '(file could not be read)' }); continue; }
    }
    findings.push(...scanText(file, text, rules, allowLines));
  }

  const errors = findings.filter((f) => f.rule.severity === 'error');
  const warns = findings.filter((f) => f.rule.severity === 'warn');

  const render = (list: Finding[], icon: string) => {
    const byRule = new Map<string, Finding[]>();
    for (const f of list) (byRule.get(f.rule.id) ?? byRule.set(f.rule.id, []).get(f.rule.id)!).push(f);
    for (const [, fs] of byRule) {
      console.log(`\n${icon} ${fs[0].rule.desc} [${fs[0].rule.id}] — ${fs.length} hit(s)`);
      for (const f of fs.slice(0, 20)) {
        console.log(`   ${f.file}${f.line ? `:${f.line}` : ''}  ${f.snippet}`);
      }
      if (fs.length > 20) console.log(`   … and ${fs.length - 20} more`);
    }
  };

  console.log(`🔎 leak-scan: ${files.length} files${termRule ? ' (SENSITIVE_TERMS active)' : ' (no SENSITIVE_TERMS set)'}`);
  if (errors.length) render(errors, '🔴');
  if (warns.length) render(warns, '🟡');

  if (errors.length === 0) {
    console.log(`\n✅ No blocking findings.${warns.length ? ` (${warns.length} warning(s) to review.)` : ''}`);
    process.exit(0);
  }
  console.log(`\n🚨 ${errors.length} blocking finding(s). Failing.`);
  process.exit(1);
}

if (import.meta.main) main();
