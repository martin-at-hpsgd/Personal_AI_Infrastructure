#!/usr/bin/env bun
/**
 * @version 1.1.3
 * BillingPathAssertion — verify which credential path a `claude -p` run actually used.
 *
 * Anthropic's stream-json event feed exposes two forensic signals that prove,
 * unambiguously, which billing path won the credential precedence chain:
 *
 *   - system/init.apiKeySource:
 *       "none"               -> OAuth subscription (CLAUDE_CODE_OAUTH_TOKEN)
 *       "ANTHROPIC_API_KEY"  -> API-key billing (Console)
 *       (other values exist for managed-key / Bedrock / Vertex paths)
 *
 *   - rate_limit_event.rateLimitType:
 *       "five_hour"          -> Pro/Max 5-hour rolling window  (subscription)
 *       (no event emitted)   -> API key  (RPM/TPM tiers, never emits five_hour)
 *
 * An April 2026 billing incident happened because LifeOS lacked a check like this:
 * Pulse heartbeats believed they were billing OAuth while ANTHROPIC_API_KEY in
 * env silently won. This tool catches that class of leak at the FIRST run.
 *
 * Reference: https://github.com/disler/max-your-cc-sub  (engineering walkthrough)
 *            https://code.claude.com/docs/en/authentication#authentication-precedence
 *
 * USAGE
 *
 *   Library:
 *     import { assertBillingPath, parseStreamJson } from "./BillingPathAssertion";
 *     const result = parseStreamJson(stdoutString);
 *     assertBillingPath(result, "oauth");  // throws on mismatch
 *
 *   CLI:
 *     bun LIFEOS/TOOLS/BillingPathAssertion.ts oauth /path/to/events.ndjson
 *     bun LIFEOS/TOOLS/BillingPathAssertion.ts api  /path/to/events.ndjson
 *     # Or pipe stdout from a `claude -p ... --output-format stream-json --verbose` run:
 *     claude -p "ping" --verbose --output-format stream-json | \
 *       bun LIFEOS/TOOLS/BillingPathAssertion.ts oauth -
 *
 *   Exit codes:
 *     0 — actual path matches expected
 *     1 — mismatch (the leak case)
 *     2 — usage error / unparseable input
 */

import { readFileSync } from "fs";

export type BillingPath = "oauth" | "api";

export interface BillingSignals {
  apiKeySource: string | null;
  rateLimitType: string | null;
  /** Detected path inferred from signals; null if neither signal was present. */
  detected: BillingPath | null;
  /** Number of newline-delimited JSON events parsed from input. */
  eventCount: number;
  /** Non-empty lines that were not a JSON object. Any at all makes the trace incomplete, so it never passes. */
  malformedLines: number;
  /** Distinct apiKeySource values seen across init events; more than one is a conflicting trace. */
  apiKeySources: string[];
}

const OAUTH_API_KEY_SOURCE = "none";
const API_KEY_API_KEY_SOURCE = "ANTHROPIC_API_KEY";
const SUBSCRIPTION_RATE_LIMIT = "five_hour";

/**
 * Parse the stream-json output of `claude -p ... --output-format stream-json --verbose`
 * and extract the two forensic billing signals.
 */
export function parseStreamJson(stdout: string): BillingSignals {
  let apiKeySource: string | null = null;
  let rateLimitType: string | null = null;
  let eventCount = 0;
  let malformedLines = 0;
  const sources = new Set<string>();

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      malformedLines++;
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      malformedLines++;
      continue;
    }
    eventCount++;

    if (event?.type === "system" && event?.subtype === "init") {
      if (typeof event.apiKeySource === "string") {
        apiKeySource = event.apiKeySource;
        sources.add(event.apiKeySource);
      }
    } else if (event?.type === "rate_limit_event") {
      const info = event.rate_limit_info ?? {};
      if (typeof info.rateLimitType === "string" && rateLimitType === null) {
        rateLimitType = info.rateLimitType;
      }
    }
  }

  let detected: BillingPath | null = null;
  // A trace with unparseable lines or conflicting init sources is incomplete: it detects nothing.
  if (malformedLines > 0 || sources.size > 1) {
    detected = null;
  } else if (apiKeySource === OAUTH_API_KEY_SOURCE) {
    detected = "oauth";
  } else if (apiKeySource === API_KEY_API_KEY_SOURCE) {
    detected = "api";
  } else if (rateLimitType === SUBSCRIPTION_RATE_LIMIT) {
    detected = "oauth";
  }

  return { apiKeySource, rateLimitType, detected, eventCount, malformedLines, apiKeySources: [...sources] };
}

/** The trace itself cannot be trusted: malformed lines, no events, or conflicting init sources. */
export class BillingTraceIncompleteError extends Error {
  constructor(public signals: BillingSignals) {
    super(
      `Billing trace is incomplete or malformed (events=${signals.eventCount}, malformedLines=${signals.malformedLines}, ` +
        `apiKeySources=${JSON.stringify(signals.apiKeySources)})`
    );
    this.name = "BillingTraceIncompleteError";
  }
}

export class BillingPathMismatchError extends Error {
  constructor(public expected: BillingPath, public signals: BillingSignals) {
    super(
      `Expected billing path "${expected}" but detected "${signals.detected ?? "unknown"}" ` +
        `(apiKeySource=${JSON.stringify(signals.apiKeySource)}, ` +
        `rateLimitType=${JSON.stringify(signals.rateLimitType)})`
    );
    this.name = "BillingPathMismatchError";
  }
}

/**
 * Assert the actual billing path matches the expected one. Throws on mismatch.
 */
export function assertBillingPath(
  signals: BillingSignals,
  expected: BillingPath
): void {
  if (signals.malformedLines > 0 || signals.eventCount === 0 || signals.apiKeySources.length > 1) {
    throw new BillingTraceIncompleteError(signals);
  }
  if (signals.detected !== expected) {
    throw new BillingPathMismatchError(expected, signals);
  }
}

function readStdinSync(): string {
  const chunks: Buffer[] = [];
  let buf: Buffer;
  try {
    buf = readFileSync(0);
  } catch {
    return "";
  }
  chunks.push(buf);
  return Buffer.concat(chunks).toString("utf-8");
}

function printUsage(): void {
  process.stderr.write(
    [
      "Usage:",
      "  bun LIFEOS/TOOLS/BillingPathAssertion.ts <oauth|api> <path-to-events.ndjson | ->",
      "",
      "  Pass `-` to read stream-json from stdin.",
      "",
      "Exit codes:",
      "  0 — actual path matches expected",
      "  1 — mismatch (subscription leak)",
      "  2 — usage error / unparseable input",
      "",
    ].join("\n")
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    printUsage();
    process.exit(2);
  }

  const expected = args[0];
  if (expected !== "oauth" && expected !== "api") {
    process.stderr.write(`expected must be "oauth" or "api", got "${expected}"\n`);
    process.exit(2);
  }

  const source = args[1];
  let stdout: string;
  if (source === "-") {
    stdout = readStdinSync();
  } else {
    try {
      stdout = readFileSync(source, "utf-8");
    } catch (err: any) {
      process.stderr.write(`failed to read ${source}: ${err?.message ?? err}\n`);
      process.exit(2);
    }
  }

  const signals = parseStreamJson(stdout);
  process.stderr.write(
    `parsed ${signals.eventCount} events: ` +
      `apiKeySource=${JSON.stringify(signals.apiKeySource)}, ` +
      `rateLimitType=${JSON.stringify(signals.rateLimitType)}, ` +
      `malformedLines=${signals.malformedLines}, ` +
      `detected=${signals.detected ?? "unknown"}\n`
  );

  try {
    assertBillingPath(signals, expected as BillingPath);
    process.stderr.write(`OK — billing path is "${expected}" as expected\n`);
    process.exit(0);
  } catch (err) {
    if (err instanceof BillingPathMismatchError) {
      process.stderr.write(`MISMATCH — ${err.message}\n`);
      process.exit(1);
    }
    if (err instanceof BillingTraceIncompleteError) {
      process.stderr.write(`UNPARSEABLE — ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}
