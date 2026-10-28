/**
 * Unit tests for leak-scan structural rules and the injected-term rule.
 * Run: bun test .github/scripts/leak-scan.test.ts
 */
import { test, expect } from 'bun:test';
import { allowedSpans, scanText } from './leak-scan.ts';

// scanText is the exported pure function; these assert rule behavior directly.

// ISC-3: structural error rules fire.
test('home path, private IP, and secret assignment are caught', () => {
  const homeRule = { id: 'home', severity: 'error' as const, desc: 'home',
    re: /\/(?:Users|home)\/[a-z][a-z0-9._-]{1,31}\//gi };
  const ipRule = { id: 'ip', severity: 'error' as const, desc: 'ip',
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g };
  const envRule = { id: 'env', severity: 'error' as const, desc: 'env',
    re: /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY)[A-Z0-9_]*\s*[:=]\s*['"]?[^\s'"`$]{8,}/g };

  const text = [
    'const p = "/Users/example/secret/file"',
    'host = 10.11.12.13',
    'MY_API_KEY=' + 'abcdef' + '123456xyz', // split so secret scanners see no literal fixture
  ].join('\n');

  expect(scanText('f.ts', text, [homeRule], []).length).toBe(1);
  expect(scanText('f.ts', text, [ipRule], []).length).toBe(1);
  expect(scanText('f.ts', text, [envRule], []).length).toBe(1);
});

// ISC-3: env indirection is NOT a finding.
test('secret indirection via ${{ secrets }} / process.env is ignored', () => {
  const envRule = { id: 'env', severity: 'error' as const, desc: 'env',
    re: /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY)[A-Z0-9_]*\s*[:=]\s*['"]?[^\s'"`$]{8,}/g,
    keep: (line: string) => !/\$\{\{\s*secrets\./.test(line) && !/process\.env/.test(line) };
  const text = [
    'API_TOKEN: ${{ secrets.API_TOKEN }}',
    'const k = process.env.MY_SECRET_KEYFILE',
  ].join('\n');
  expect(scanText('f.yml', text, [envRule], []).length).toBe(0);
});

// ISC-4: injected term rule toggles on SENSITIVE_TERMS presence.
test('injected term matches only when the term is supplied', () => {
  const build = (raw: string) => {
    const terms = raw.split('|').map(t => t.trim()).filter(t => t.length >= 3)
      .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!terms.length) return null;
    return { id: 'term', severity: 'error' as const, desc: 'term',
      re: new RegExp(`(?<![A-Za-z0-9])(?:${terms.join('|')})(?![A-Za-z0-9])`, 'gi') };
  };
  const text = 'welcome to Acme Corp and their widget';
  const withTerm = build('Acme Corp');
  const without = build('');
  expect(without).toBeNull();
  expect(scanText('f.md', text, [withTerm!], []).length).toBe(1);
});

// ISC-7: allowlist line suppression works.
test('allowlisted substrings suppress findings', () => {
  const emailRule = { id: 'email', severity: 'warn' as const, desc: 'email',
    re: /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi };
  const text = 'contact user@example.com for help';
  expect(scanText('f.md', text, [emailRule], []).length).toBe(1);
  expect(scanText('f.md', text, [emailRule], ['@example.com']).length).toBe(0);
});

test('an allow string excuses only the match it covers, and only at a name boundary', () => {
  const term = { id: 'term', severity: 'error' as const, desc: 'term', re: /(?<![A-Za-z0-9])owner(?![A-Za-z0-9])/gi };
  const allow = ['github.com/owner/fabric'];
  const hits = (line: string) => scanText('f.md', line, [term], allow).length;
  expect(hits('see https://github.com/owner/fabric')).toBe(0);
  expect(hits('clone github.com/owner/fabric/main/x')).toBe(0);
  expect(hits('github.com/owner/fabric-private')).toBe(1);
  expect(hits('github.com/owner/fabric.private')).toBe(1);
  expect(hits('see github.com/owner/fabric and github.com/owner/fabric-private')).toBe(1);
  expect(hits('github.com/owner/fabric by owner')).toBe(1);
  expect(allowedSpans('use 192.168.1.1-style placeholders', ['192.168.1.1']).length).toBe(1);
  expect(allowedSpans('host 192.168.0.17', ['192.168.0.1']).length).toBe(0);
  const repo = [/export const REPO = "[A-Za-z0-9-]+\/LifeOS";/g];
  const home = { id: 'home', severity: 'error' as const, desc: 'home', re: /\/Users\/[a-z]+/g };
  expect(hits('export const REPO = "owner/LifeOS";')).toBe(1);
  expect(scanText('f.ts', 'export const REPO = "owner/LifeOS";', [term], repo).length).toBe(0);
  expect(scanText('f.ts', 'export const REPO = "owner/private";', [term], repo).length).toBe(1);
  expect(scanText('f.ts', 'export const REPO = "/Users/someone/LifeOS";', [home], repo).length).toBe(1);
  expect(scanText('f.ts', 'export const REPO = "owner/LifeOS"; // owner', [term], repo).length).toBe(1);
  const addr = (severity: 'error' | 'warn') => ({ id: 'addr', severity, desc: 'addr', re: /someuser@privcorp/g });
  expect(scanText('f.md', 'mail someuser@privcorp.example', [addr('error')], ['user@']).length).toBe(1);
  expect(scanText('f.md', 'mail someuser@privcorp.example', [addr('warn')], ['user@']).length).toBe(0);
  const q = ['"da-line.internal"'];
  expect(scanText('f.ts', 'h("da-line.internal", "/Users/someone")', [home], q).length).toBe(1);
});
