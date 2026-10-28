#!/usr/bin/env bun
/**
 * @version 1.2.10
 */
// Normalize env path vars Claude Code may inject unexpanded — literal $HOME/${HOME}
// in LIFEOS_DIR/LIFEOS_CONFIG_DIR/PROJECTS_DIR resolves to a shadow dir (#1404 / PR #1451, author jbmml).
for (const __k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const __v = process.env[__k];
  if (__v && /^\$\{?HOME\}?(\/|$)/.test(__v)) process.env[__k] = __v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}

/**
 * PangramScore.ts — score text for AI-detectability via the Pangram API.
 *
 * Use it as a voice-eval probe: feed in my (or anyone's) writing and get back
 * how much of it reads as AI-generated. Lower fraction_ai = sounds more human.
 *
 * Two-step async flow (from the official docs, June 2026):
 *   1. POST https://text.external-api.pangram.com/task  -> { task_id }
 *      headers: Content-Type: application/json, x-api-key: <key>
 *      body:    { "text": "...", "public_dashboard_link": false }
 *   2. GET  https://text.external-api.pangram.com/task/<task_id>  (poll)
 *      done when stage === "STAGE_SUCCESS" | "STAGE_FAILED"
 * Docs: https://docs.pangram.com/quickstart-rest
 *
 * Key: PANGRAM_API_KEY in ~/.claude/.env (not present yet — add it before running).
 * Override the endpoint with PANGRAM_API_URL if Pangram moves it; the override must still be an https
 * URL on an approved Pangram host (resolvePangramUrl), because that URL receives the key and the text.
 */

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { parseEnv } from "./Env";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { getClaudeDir, getLifeosDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

// Normalize env path vars that Claude Code injects without shell expansion (LifeOS#1404)
for (const k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const v = process.env[k];
  if (v && /^\$\{?HOME\}?(\/|$)/.test(v)) process.env[k] = v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}


const ENV_PATH = `${getClaudeDir()}/.env`;

// Run-record: proof the detector actually executed on a specific text. The
// The pass condition was "Pangram ran on this content", not "a token string is present" (cross-vendor audit 2026-07-01).
const RUNS_PATH = join(
  getLifeosDir(),
  "MEMORY", "OBSERVABILITY", "pangram-runs.jsonl",
);
export function normalizeForHash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
function appendRunRecord(text: string, aiPct: unknown): void {
  try {
    mkdirSync(dirname(RUNS_PATH), { recursive: true });
    const sha256 = createHash("sha256").update(normalizeForHash(text)).digest("hex");
    appendFileSync(RUNS_PATH, JSON.stringify({
      ts: new Date().toISOString(), sha256, chars: text.length,
      ai_pct: typeof aiPct === "number" ? aiPct : null, source: "PangramScore",
    }) + "\n", "utf-8");
  } catch (err) {
    console.error("[PangramScore] run-record write failed:", err);
  }
}
const DEFAULT_URL = "https://text.external-api.pangram.com/task";

/** Hosts that may receive the Pangram key and the submitted text. HTTPS only. */
export const APPROVED_PANGRAM_HOSTS: readonly string[] = ["text.external-api.pangram.com"];

/**
 * The endpoint the key and the text are sent to, or an Error. An override (PANGRAM_API_URL) is honoured only
 * when it is an https URL on an approved host, with no embedded credentials and no non-default port: a
 * caller-controlled URL must never receive the credential. Redirects are refused at the fetch sites.
 */
export function resolvePangramUrl(override: string | undefined = process.env.PANGRAM_API_URL): string {
  const raw = override && override.length > 0 ? override : DEFAULT_URL;
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`PANGRAM_API_URL is not a valid URL: refusing to send the key or text`); }
  if (u.protocol !== "https:") throw new Error(`PANGRAM_API_URL must be https (got ${u.protocol.replace(":", "")}): refusing to send the key or text`);
  if (u.username || u.password) throw new Error("PANGRAM_API_URL must not embed credentials");
  if (u.port) throw new Error("PANGRAM_API_URL must use the default https port");
  if (!APPROVED_PANGRAM_HOSTS.includes(u.hostname.toLowerCase())) throw new Error(`PANGRAM_API_URL host ${u.hostname} is not an approved Pangram origin: refusing to send the key or text`);
  return u.toString().replace(/\/+$/, "");
}

function loadKey(): string {
  const fromEnv = process.env.PANGRAM_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    const env = readFileSync(ENV_PATH, "utf8");
    // public issue #2100, @bowlax: use unified parseEnv to handle CRLF and export prefix
    const parsed = parseEnv(env);
    if (parsed.PANGRAM_API_KEY) return parsed.PANGRAM_API_KEY;
  } catch {}
  console.error("No PANGRAM_API_KEY found. Add it to ~/.claude/.env, then re-run.");
  process.exit(1);
}

function usage(): never {
  console.error(`Usage:
  bun PangramScore.ts "text to score"
  bun PangramScore.ts --file path/to/sample.md
  echo "text" | bun PangramScore.ts
  ... add --json for the raw response`);
  process.exit(1);
}

async function readInput(args: string[]): Promise<string> {
  const fileFlag = args.indexOf("--file");
  if (fileFlag !== -1) {
    const p = args[fileFlag + 1];
    if (!p) usage();
    return readFileSync(p, "utf8");
  }
  const positional = args.filter((a) => a !== "--json");
  if (positional.length) return positional.join(" ");
  if (!process.stdin.isTTY) return await Bun.stdin.text();
  usage();
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const text = (await readInput(args)).trim();
  if (!text) usage();

  const url = resolvePangramUrl();
  const key = loadKey();

  // Step 1: submit the task.
  const submit = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ text, public_dashboard_link: false }),
    signal: AbortSignal.timeout(30_000),
    redirect: "manual", // a redirect would carry the key to another origin
  });
  if (submit.status >= 300 && submit.status < 400) {
    console.error(`Pangram submit redirected (${submit.status}): refusing to follow, the key stays on the approved origin.`);
    process.exit(1);
  }
  if (!submit.ok) {
    console.error(`Pangram submit ${submit.status}: ${await submit.text()}`);
    process.exit(1);
  }
  const { task_id } = (await submit.json()) as { task_id?: string };
  if (!task_id) {
    console.error("No task_id returned from submit.");
    process.exit(1);
  }

  // Step 2: poll until terminal stage (STAGE_SUCCESS | STAGE_FAILED).
  let data: any = {};
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const poll = await fetch(`${url}/${encodeURIComponent(task_id)}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(15_000), redirect: "manual" });
    if (poll.status >= 300 && poll.status < 400) {
      console.error(`Pangram poll redirected (${poll.status}): refusing to follow, the key stays on the approved origin.`);
      process.exit(1);
    }
    if (!poll.ok) {
      console.error(`Pangram poll ${poll.status}: ${await poll.text()}`);
      process.exit(1);
    }
    data = await poll.json();
    if (data.stage === "STAGE_SUCCESS" || data.stage === "STAGE_FAILED") break;
    await Bun.sleep(1000);
  }
  if (data.stage === "STAGE_FAILED") {
    console.error(`Pangram task failed: ${data.error ?? JSON.stringify(data)}`);
    process.exit(1);
  }
  // Anything that is not STAGE_SUCCESS is NOT a measurement. The poll loop can also
  // fall out on the 60s deadline while the task is still running, which used to leave
  // `stage` non-terminal. The old code warned, then printed a full score block of
  // em-dashes and exited 0 — and appendRunRecord had already stamped the text's
  // SHA-256 into pangram-runs.jsonl. Callers treat that record as proof the detector
  // ran on this exact text, so an incomplete request was reported as a score AND
  // given execution proof. Fail closed instead: no record, no score block, non-zero exit.
  if (data.stage !== "STAGE_SUCCESS") {
    console.error(
      `Pangram task did not complete: stage="${data.stage ?? "unknown"}" (no score, no run record). ` +
      `The task may still be running — re-run, or inspect with --json.`,
    );
    process.exit(1);
  }

  appendRunRecord(text, data.fraction_ai);

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const pct = (n: unknown) => (typeof n === "number" ? `${(n * 100).toFixed(1)}%` : "—");
  console.log(`Headline:   ${data.headline ?? data.prediction_short ?? "—"}`);
  console.log(`Verdict:    ${data.prediction ?? "—"}`);
  console.log(`AI:         ${pct(data.fraction_ai)}`);
  console.log(`AI-assisted:${pct(data.fraction_ai_assisted)}`);
  console.log(`Human:      ${pct(data.fraction_human)}`);
  console.log(`Segments:   ${data.num_ai_segments ?? 0} AI / ${data.num_ai_assisted_segments ?? 0} assisted / ${data.num_human_segments ?? 0} human`);
  console.log(`\n→ Lower AI% = reads more human.`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
