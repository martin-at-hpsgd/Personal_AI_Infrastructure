#!/usr/bin/env bun
/**
 * @version 1.9.0
 * 1.9.0 (2026-10-14): --verbose no longer prints Redacted or
 *   ExtraData. Human output and --json share one allowlist (safeFinding): file, line, detector,
 *   decoder, verified. ExtraData carries credential material and personal account metadata.
 * 1.8.0 (2026-10-13): --json no longer prints
 *   the scanner's stdout verbatim (its Raw and RawV2 fields are the credential values); it emits an
 *   allowlisted report of file, line, detector, decoder and verified, nothing else. A record whose
 *   Verified is not a boolean is malformed (incomplete scan, exit 2), so an unreadable verification
 *   status can no longer pass for "unverified". Banners go to stderr under --json.
 * 1.7.0 (2026-10-13, LOSIntegrity security rank 15): a scanner record that is not JSON, or is
 *   not a filesystem finding, makes the scan INCOMPLETE (exit 2) and never prints "No sensitive
 *   information found"; an unexpected crash exits 2 instead of 0; main runs only as a CLI, so
 *   the parser and the exit rule are testable.
 * SecretScan.ts - Secret Scanning CLI
 *
 * Scan directories for sensitive information using TruffleHog.
 * Detects 700+ credential types with entropy analysis and pattern matching.
 * Part of LifeOS CORE Tools.
 *
 * Usage:
 *   bun ~/.claude/LIFEOS/TOOLS/SecretScan.ts <directory>
 *   bun ~/.claude/LIFEOS/TOOLS/SecretScan.ts . --verbose
 *   bun ~/.claude/LIFEOS/TOOLS/SecretScan.ts . --verify
 *
 * Exit: 0 no verified secret (unverified candidates are listed, not blocking) · 1 verified
 *       secret found · 2 scan error or incomplete scan (TruffleHog missing or failed, or
 *       output that could not be read as findings)
 *
 * @see the release skill's SecretScanning intent
 */

/*

## Options
- --verbose: Show detailed information about each finding
- --json: Output results in JSON format
- --verify: Attempt to verify if credentials are active

## What it detects
- API keys (OpenAI, AWS, GitHub, Stripe, etc.)
- OAuth tokens
- Private keys
- Database connection strings
- And 700+ other credential types
*/

import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';

export interface TruffleHogFinding {
  SourceMetadata: {
    Data: {
      Filesystem: {
        file: string;
        line: number;
      }
    }
  };
  DetectorType: string;
  DecoderName: string;
  Verified: boolean;
  Raw: string;
  RawV2: string;
  Redacted: string;
  ExtraData: any;
}

/** Parsed scanner stdout: the findings, and every record that could not be read as one. */
export interface ParsedScan {
  findings: TruffleHogFinding[];
  /** 1-based stdout line numbers of records that were not JSON or not a filesystem finding. */
  malformed: number[];
}

export const EXIT_CLEAN = 0;
export const EXIT_VERIFIED = 1;
export const EXIT_SCAN_ERROR = 2;

async function runTruffleHog(targetDir: string, options: string[], quiet = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['filesystem', targetDir, '--json', '--no-update', ...options];

    const say = quiet ? console.error : console.log;
    say(`🔍 Running TruffleHog scan on: ${targetDir}\n`);
    say(`⏳ This may take a moment...\n`);

    const trufflehog = spawn('trufflehog', args);
    let output = '';
    let errorOutput = '';

    trufflehog.stdout.on('data', (data) => {
      output += data.toString();
    });

    trufflehog.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    trufflehog.on('close', (code) => {
      if (code !== 0 && code !== 183) { // 183 = findings detected
        reject(new Error(`TruffleHog exited with code ${code}: ${errorOutput}`));
      } else {
        resolve(output);
      }
    });

    trufflehog.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * With `--json`, TruffleHog writes one finding per stdout line and its logs to stderr, so every
 * non-empty stdout line must be a filesystem finding. Anything else is counted, never skipped: a
 * dropped line could be the one secret in the tree.
 */
export function parseTruffleHogOutput(output: string): ParsedScan {
  const findings: TruffleHogFinding[] = [];
  const malformed: number[] = [];
  const lines = output.split('\n');

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      malformed.push(i + 1);
      return;
    }
    const r = record as { SourceMetadata?: { Data?: { Filesystem?: { file?: unknown } } }; Verified?: unknown } | null;
    const meta = r?.SourceMetadata?.Data?.Filesystem;
    // A finding needs a location and a boolean verification status; anything less is incomplete, not "unverified".
    if (typeof meta?.file === 'string' && meta.file.length > 0 && typeof r?.Verified === 'boolean') findings.push(record as TruffleHogFinding);
    else malformed.push(i + 1);
  });

  return { findings, malformed };
}

/**
 * The --json report: an allowlist of location, detector and verification status. Raw, RawV2,
 * Redacted and ExtraData carry credential material and are never copied, so a log, an agent
 * transcript or a release artifact holding this output holds no secret value.
 */
export interface SafeFinding { file: string; line: number | null; detector: string; decoder: string; verified: boolean }

/** The only fields any report shows for a finding, human or --json. Everything else on the record stays unread. */
export function safeFinding(f: TruffleHogFinding): SafeFinding {
  const fs = f.SourceMetadata.Data.Filesystem;
  return {
    file: fs.file,
    line: typeof fs.line === 'number' ? fs.line : null,
    detector: String(f.DetectorType),
    decoder: String(f.DecoderName ?? ''),
    verified: f.Verified,
  };
}

export function redactedReport(scan: ParsedScan): {
  findings: SafeFinding[];
  malformed: number[];
  verifiedCount: number;
  exitCode: number;
} {
  const findings = scan.findings.map(safeFinding);
  return { findings, malformed: scan.malformed, verifiedCount: findings.filter((f) => f.verified).length, exitCode: exitCodeFor(scan) };
}

/** Exit code for a parsed scan: a verified secret outranks an incomplete scan; only a fully read, verified-free scan is clean. */
export function exitCodeFor(scan: ParsedScan): number {
  if (scan.findings.some((f) => f.Verified)) return EXIT_VERIFIED;
  if (scan.malformed.length > 0) return EXIT_SCAN_ERROR;
  return EXIT_CLEAN;
}

/** Says which records could not be read, by line number only: a raw record may hold a secret. */
function reportMalformed(scan: ParsedScan): void {
  if (scan.malformed.length === 0) return;
  const shown = scan.malformed.slice(0, 20).join(', ');
  const more = scan.malformed.length > 20 ? ` (+${scan.malformed.length - 20} more)` : '';
  console.error(`❌ Scan INCOMPLETE: ${scan.malformed.length} scanner output record(s) could not be read as findings (stdout line ${shown}${more}). The result cannot be called clean; rerun with --json to inspect the raw output.`);
}

function formatFindings(scan: ParsedScan, verbose: boolean) {
  const { findings } = scan;
  if (findings.length === 0) {
    if (scan.malformed.length === 0) console.log('✅ No sensitive information found!');
    return;
  }

  console.log(`🚨 Found ${findings.length} potential secret${findings.length > 1 ? 's' : ''}:\n`);
  console.log('─'.repeat(60));

  // Group by severity
  const verified = findings.filter(f => f.Verified);
  const unverified = findings.filter(f => !f.Verified);

  if (verified.length > 0) {
    console.log('\n🔴 VERIFIED SECRETS (ACTIVE CREDENTIALS!)');
    console.log('─'.repeat(60));
    for (const finding of verified) {
      displayFinding(finding, verbose);
    }
  }

  if (unverified.length > 0) {
    console.log('\n⚠️  POTENTIAL SECRETS (Unverified)');
    console.log('─'.repeat(60));
    for (const finding of unverified) {
      displayFinding(finding, verbose);
    }
  }

  // Summary
  console.log('\n📋 SUMMARY & URGENT ACTIONS:');
  console.log('─'.repeat(60));

  if (verified.length > 0) {
    console.log('\n🚨 CRITICAL - VERIFIED ACTIVE CREDENTIALS FOUND:');
    console.log('1. IMMEDIATELY rotate/revoke these credentials');
    console.log('2. Check if these were ever pushed to a public repository');
    console.log('3. Audit logs for any unauthorized access');
    console.log('4. Move all secrets to environment variables or secret vaults');
  }

  console.log('\n🛡️  RECOMMENDATIONS:');
  console.log('1. Never commit secrets to git repositories');
  console.log('2. Use .env files for local development (add to .gitignore)');
  console.log('3. Use secret management services for production');
  console.log('4. Set up pre-commit hooks to prevent secret commits');
  console.log('5. Run: git filter-branch or BFG to remove secrets from git history');
}

/**
 * The printed lines for one finding, built from safeFinding only, so --verbose adds the decoder and
 * nothing else. Raw, RawV2, Redacted and ExtraData (credential material, account metadata) never
 * reach a terminal, a log or an agent transcript; the value is read at the file and line.
 */
export function findingLines(finding: TruffleHogFinding, verbose: boolean): string[] {
  const f = safeFinding(finding);
  const lines = [
    `\n📄 ${f.file}`,
    `   Type: ${f.detector} ${f.verified ? '✓ VERIFIED' : '✗ Unverified'}`,
    `   Line: ${f.line ?? 'unknown'}`,
  ];
  if (verbose) lines.push(`   Decoder: ${f.decoder || 'unknown'} (secret value and scanner details withheld; open the file at this line)`);
  return lines;
}

function displayFinding(finding: TruffleHogFinding, verbose: boolean) {
  for (const l of findingLines(finding, verbose)) console.log(l);
  const type = finding.DetectorType;

  // Recommendations based on type
  const recommendations: { [key: string]: string } = {
    'OpenAI': 'Revoke at platform.openai.com, use OPENAI_API_KEY env var',
    'AWS': 'Rotate via AWS IAM immediately, use AWS Secrets Manager',
    'GitHub': 'Revoke at github.com/settings/tokens, use GitHub Secrets',
    'Stripe': 'Roll key at dashboard.stripe.com, use STRIPE_SECRET_KEY env var',
    'Slack': 'Revoke at api.slack.com/apps, use environment variables',
    'Google': 'Revoke at console.cloud.google.com, use Secret Manager',
  };

  const recommendation = Object.entries(recommendations)
    .find(([key]) => String(type).includes(key))?.[1] ||
    'Remove from code and use secure secret management';

  console.log(`   💡 Fix: ${recommendation}`);
}

async function main() {
  const targetDir = process.argv[2] || process.cwd();
  const verbose = process.argv.includes('--verbose');
  const jsonOutput = process.argv.includes('--json');
  const verify = process.argv.includes('--verify');

  if (!existsSync(targetDir)) {
    console.error(`❌ Directory not found: ${targetDir}`);
    process.exit(EXIT_SCAN_ERROR);
  }

  // Check if trufflehog is installed (bounded: a hung binary must not hang the scan forever).
  const probe = spawnSync('trufflehog', ['--version'], { stdio: 'ignore', timeout: 30_000 });
  if (probe.error || probe.status !== 0) {
    console.error('❌ TruffleHog is not installed or not in PATH');
    console.error('Install with: brew install trufflehog');
    process.exit(EXIT_SCAN_ERROR);
  }

  try {
    const options = [];
    if (verify) {
      options.push('--verify');
    }

    // Unbounded by design: a full-tree scan's duration scales with the tree, and the caller owns the clock.
    const output = await runTruffleHog(targetDir, options, jsonOutput);
    const scan = parseTruffleHogOutput(output);

    if (jsonOutput) {
      console.log(JSON.stringify(redactedReport(scan), null, 2));
    } else {
      formatFindings(scan, verbose);
    }
    reportMalformed(scan);
    process.exit(exitCodeFor(scan));
  } catch (error) {
    console.error(`❌ Error running TruffleHog: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_SCAN_ERROR);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`❌ SecretScan failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_SCAN_ERROR);
  });
}
