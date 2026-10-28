#!/usr/bin/env bun
// CfEnv — single-purpose helper used by the Cloudflare Deploy intent.
//
// Spawns ONE cf CLI invocation with Cloudflare credentials read from
// ~/.claude/.env scoped to the child process only. The parent shell
// environment is never touched, and the helper refuses any verb outside the
// allowlist below — this is not a generic credential injector that arbitrary
// callers can use to exfiltrate via cf.
//
// cf is the only Cloudflare CLI this tool runs (no Wrangler). A leading `cf` argument is accepted and ignored, so
// `CfEnv.ts cf deploy` and `CfEnv.ts deploy` are the same call.
//
// Usage (only from Deploy.md, never directly from Bash):
//   bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts deploy
//   bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts d1 migrations apply <database-id> --dir migrations
//   printf '%s' "$VALUE" | bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts secret put NAME --name <worker>
//   bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts secret put NAME --name <worker> --from-env [ENV_KEY]
//
// `secret put` is the one translated verb. cf's `workers secrets update` takes the
// value as a flag, which would put it in the process list. CfEnv instead builds the
// request body and hands it to cf on stdin (`--body @/dev/stdin`), so the value is
// never an argument, never printed, and never returned to the calling session.
// --from-env reads the value from ~/.claude/.env (the deny list blocks reading .env
// in-session, rightly); without it the value comes from CfEnv's own stdin.
//
// Exit code mirrors cf's. stdio inherited.

import { spawnSync } from "node:child_process";
/** The one cf this tool runs, pinned so a launchd job and a terminal run the same commands. A bare `bunx cf` uses whatever `cf` is on PATH, and under launchd (no ~/.bun/bin) fetches the newest release, and a later beta dropped `observability telemetry query`, which a scheduled reader depends on, so every read failed until someone noticed. Move the pin on purpose, after checking the commands callers use. */
export const CF_PACKAGE = "cf@1.0.0-beta.5";
/** Runs the pin's installed bin by full path, never `bunx`, which re-links a shared temp dir per call and broke overlapping calls (CfBin.ts). */
const cfBin = (): string[] => cfCommand(CF_PACKAGE);
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { getEnvPath } from "./Paths";
import { cfCommand } from "./CfBin";
import { invariant } from "./Invariant";
import { parseReviewFlags } from "./Review";
import { DEFAULT_OBSERVABILITY, observabilityAfterDeploy, readConfigObservability } from "./Observability";
import { cfExitForCaller, configWorkerName, declaredSecretNames, DEPLOYED_BUT_CHECK_FAILED, probeOutcome, retryReason, socialCardOutcome, THROTTLED } from "./CfEnvChecks";
import { appNameFor, recordDeploy } from "./StatvsAppRows";
import { readVersion } from "./ReleaseRecord";

const ENV_PATH = getEnvPath();

// Verbs the Deploy, Query and Troubleshoot intents are contracted to invoke.
// Anything else is a bug in the caller (or an exfiltration attempt).
const ALLOWED_VERBS = new Set([
  "deploy", "build", "auth", "workers", "d1", "kv", "r2", "queues", "pages",
  "dns", "zones", "observability", "vectorize", "analytics", "cache", "secret",
  "zero-trust", // Access only; narrowed to access/organizations-list below
  "observability-default", // the account observability default: runs Observability.ts, not cf
  "workers-crashes", // hourly Worker crash counts, one fixed read-only analytics query: runs WorkerCrashes.ts, not cf
]);

// Only these env keys cross into the subprocess. Adding more here means
// expanding the trust surface — keep this tight.
const NEEDED_KEYS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];

function parseEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(`CfEnv: cannot read ${path}`);
    process.exit(2);
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function fail(message: string): never {
  console.error(`CfEnv: ${message}`);
  process.exit(2);
}

/** A check after a successful upload failed: the new version is live, so exit with its own code (CfEnvChecks). */
function failLive(message: string): never {
  console.error(`CfEnv: ${message}`);
  process.exit(DEPLOYED_BUT_CHECK_FAILED);
}

const rawArgs = process.argv.slice(2);
// `--drop-secret NAME` (repeatable) names a live secret the deploy may delete on purpose because
// nothing reads it any more. Only the names given are released; every other undeclared secret
// still stops the deploy. Never reaches cf.
const dropSecrets = new Set<string>();
const withoutDrops: string[] = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] !== "--drop-secret") { withoutDrops.push(rawArgs[i]); continue; }
  const name = rawArgs[++i];
  if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) fail("--drop-secret needs a secret NAME.");
  dropSecrets.add(name);
}
const cfOrNot = withoutDrops[0] === "cf" ? withoutDrops.slice(1) : withoutDrops;
// `--allow-dirty "<reason>"` and `--waive-blockers "<reason>"` belong to the code review, not to
// cf: they are forwarded to Review.ts on a deploy (which records each reason) and never reach cf.
// --allow-dirty lifts only the uncommitted-files block; --waive-blockers lifts model blockers, a
// reviewer outage, an over-limit diff, or a review that could not run, never uncommitted files.
// Review.ts owns the parser, so the retired one-reason override is refused here with the same
// exit-2 message the review prints.
const reviewFlags = parseReviewFlags(cfOrNot);
if (!reviewFlags.ok) fail(reviewFlags.error);
// --past-round-cap lets a span the review has blocked ROUND_CAP (four) times be reviewed again (the principal's call).
const { allowDirty, waiveBlockers, pastRoundCap } = reviewFlags;
const args = reviewFlags.rest;
const verb = args[0];

if (!verb || !ALLOWED_VERBS.has(verb)) {
  console.error(`CfEnv: verb "${verb ?? ""}" not in allowlist.`);
  console.error("Allowed verbs:", Array.from(ALLOWED_VERBS).sort().join(", "));
  console.error("If you need a new verb, update the Cloudflare skill's Intents/Deploy.md AND this allowlist.");
  process.exit(2);
}

// A secret never has a dry run. cf's --dry-run prints the request body, and the body is the
// secret value, from stdin or from .env alike, so a preview would put the value into the calling
// session's output (only --from-env was refused). Refused here,
// before any stdin or credential is read.
if (verb === "secret" && args.includes("--dry-run")) {
  fail("--dry-run is refused for `secret put`: cf's dry run prints the request body, which is the secret value. Check the name and worker with `workers secrets list --worker <worker>` instead.");
}

// zero-trust is admitted for Access only (applications, policies, identity providers) plus a
// read of the organization, so sign-in gates can be managed. Gateway, tunnels, devices and the
// rest stay out.
if (verb === "zero-trust") {
  const sub = args[1];
  const read = (sub === "organizations" || sub === "identity-providers") && args[2] === "list";
  if (sub !== "access" && !read) {
    fail(`zero-trust is limited to "access …", "organizations list" and "identity-providers list" (got "${args.slice(1, 3).join(" ")}").`);
  }
}

// Every deploy gets the independent code review first (LIFEOS/TOOLS/Review.ts). Only exit 0
// deploys. Exit 1 is a blocker, uncommitted files in the deploy dir, or a reviewer outage;
// any other exit (no git repo, git error, crash) also stops the deploy unless --waive-blockers
// names a reason (fail closed). cf deploys the
// directory it runs in (it has no --cwd or --config flag), so the review covers this
// process's cwd. A dry run deploys nothing and skips it.
// A git-ignored cwd is generated build output (the Workflows fleet deploys from cf/build/<Worker>):
// its diff is always empty, so a review scoped to it passes without reading the source that
// produced it. The review then covers the whole repository.
const isDeploy = verb === "deploy" || (verb === "pages" && args[1] === "deploy");
if (!isDeploy && (allowDirty !== undefined || waiveBlockers !== undefined || pastRoundCap !== undefined)) fail("--allow-dirty, --waive-blockers and --past-round-cap apply to a deploy's code review only; this verb runs no review.");
function reviewScope(cwd: string): string {
  const ignored = spawnSync("git", ["check-ignore", "-q", "."], { cwd });
  if (ignored.status !== 0) return cwd;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (top.status !== 0 || !top.stdout.trim()) fail(`deploy dir ${cwd} is git-ignored and its repository root could not be found; refusing an empty review.`);
  console.error(`CfEnv: ${cwd} is generated (git-ignored); reviewing the repository at ${top.stdout.trim()} instead.`);
  return top.stdout.trim();
}
/** The deploy dir itself when git tracks it, else its nearest ancestor that is not ignored. */
function trackedAncestor(cwd: string): string {
  let dir = resolve(cwd);
  while (spawnSync("git", ["check-ignore", "-q", "."], { cwd: dir }).status === 0 && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}
const LIFEOS_DIR = resolve(import.meta.dir, "..");
// Release record: every deploy ships code its
// version and CHANGELOG already record. Pure git, runs before the review so an unrecorded
// deploy stops in a second. LIFEOS_RELEASE_RECORD_WAIVE="<reason>" deploys anyway and the
// reason goes to the deploy ledger.
let releaseRecordNote = "not run";
if (isDeploy && !args.includes("--dry-run")) {
  // The record is found from the nearest tracked folder above a generated deploy dir, so a Worker built into an ignored
  // out/ under a larger repo keeps its own nested record (ReleaseRecord recordRoot); the code review below still
  // covers the whole repo.
  const record = spawnSync("bun", [resolve(LIFEOS_DIR, "TOOLS", "ReleaseRecord.ts"), "check", trackedAncestor(process.cwd())], { stdio: "inherit" });
  const waive = process.env.LIFEOS_RELEASE_RECORD_WAIVE?.trim();
  if (record.status === 0) releaseRecordNote = "ok";
  else if (waive) { releaseRecordNote = `waived: ${waive}`; console.error(`CfEnv: release record not current; deploying on LIFEOS_RELEASE_RECORD_WAIVE (${waive}).`); }
  else fail("deploy stopped: the release record above does not cover this code. Run the prepare command it names, then deploy again.");
}
let reviewNote = "not run";
if (isDeploy && !args.includes("--dry-run")) {
  const reviewTool = resolve(LIFEOS_DIR, "TOOLS", "Review.ts");
  const reviewArgs = [
    reviewTool, reviewScope(process.cwd()),
    ...(allowDirty !== undefined ? ["--allow-dirty", allowDirty] : []),
    ...(waiveBlockers !== undefined ? ["--waive-blockers", waiveBlockers] : []),
    ...(pastRoundCap !== undefined ? ["--past-round-cap", pastRoundCap] : []),
  ];
  const review = spawnSync("bun", reviewArgs, { stdio: "inherit" });
  if (review.status === 1) fail("deploy stopped by the code review above.");
  if (review.status !== 0) {
    if (waiveBlockers === undefined) fail(`code review did not run (exit ${review.status}); deploy stopped. Fix the error above, or pass --waive-blockers "<reason>" to deploy unreviewed.`);
    console.error(`CfEnv: code review did not run (exit ${review.status}); deploying unreviewed on --waive-blockers.`);
    reviewNote = `not run (exit ${review.status}), waived: ${waiveBlockers}`;
  } else {
    reviewNote = waiveBlockers !== undefined || allowDirty !== undefined ? "ran, with a waiver" : "ran";
  }
}
// Each waiver given on this deploy, verbatim, for the deploy ledger.
const reviewWaivers = { ...(allowDirty !== undefined ? { allowDirty } : {}), ...(waiveBlockers !== undefined ? { waiveBlockers } : {}), ...(pastRoundCap !== undefined ? { pastRoundCap } : {}) };

const envFile = parseEnvFile(ENV_PATH);
const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
for (const key of NEEDED_KEYS) {
  if (envFile[key]) childEnv[key] = envFile[key];
}
if (!childEnv.CLOUDFLARE_API_TOKEN) fail(`no CLOUDFLARE_API_TOKEN in ${ENV_PATH}`);

// `observability-default audit|apply` is the account-wide observability default (Observability.ts).
// It calls the script-settings API, which cf has no command for, with the same master token.
if (verb === "observability-default") {
  if (!childEnv.CLOUDFLARE_ACCOUNT_ID) fail(`no CLOUDFLARE_ACCOUNT_ID in ${ENV_PATH}`);
  const tool = resolve(import.meta.dir, "Observability.ts");
  const r = spawnSync("bun", [tool, ...args.slice(1)], { stdio: "inherit", env: childEnv });
  process.exit(r.status ?? 2);
}

// `workers-crashes [--hours N]` is Bunker's crash read (WorkerCrashes.ts): one fixed analytics query, no
// query text from the caller, so this verb cannot be used to send the token anywhere else.
if (verb === "workers-crashes") {
  if (!childEnv.CLOUDFLARE_ACCOUNT_ID) fail(`no CLOUDFLARE_ACCOUNT_ID in ${ENV_PATH}`);
  const tool = resolve(import.meta.dir, "WorkerCrashes.ts");
  const r = spawnSync(process.execPath, [tool, ...args.slice(1)], { stdio: "inherit", env: childEnv });
  process.exit(r.status ?? 2);
}

// Throttle signal shared by the secrets check and the cf run (see the retry note below).
const MAX_ATTEMPTS = 5;

// Secrets check (a deploy that drops undeclared secrets takes a live app down). cf deploy
// keeps only the secrets cloudflare.config.ts declares as bindings.secret(), and each
// kept value comes from the newest uploaded version, which a rollback does not change.
// Before a deploy: every secret on the live version must be declared, and every declared
// secret needs a value, either on the newest version or in --secrets-file. After it: the
// new version must carry every declared secret. Either failure stops with the names.
const CONFIG_PATH = resolve(process.cwd(), "cloudflare.config.ts");

function cfJson(cfCall: string[]): unknown {
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync(cfBin()[0]!, [...cfBin().slice(1), ...cfCall, "-q"], { env: childEnv, encoding: "utf8" });
    const text = `${r.stdout}${r.stderr}`;
    if (r.status === 0) {
      const start = r.stdout.search(/[[{]/);
      if (start === -1) fail(`secrets check: no JSON from cf ${cfCall.slice(0, 3).join(" ")}.`);
      return JSON.parse(r.stdout.slice(start));
    }
    if (THROTTLED.test(text) && attempt < MAX_ATTEMPTS) {
      Bun.sleepSync(35_000);
      continue;
    }
    if (/not found|10007/i.test(text)) return null;
    fail(`secrets check: cf ${cfCall.slice(0, 3).join(" ")} failed; deploy not attempted.\n${text.slice(0, 400)}`);
  }
}

type NamedBinding = { name: string; type: string };
const SECRET_TYPES = new Set(["secret_text", "secret_key"]);

function latestSecretNames(worker: string): Set<string> {
  const list = (cfJson(["workers", "secrets", "list", "--worker", worker]) ?? []) as NamedBinding[];
  return new Set(list.map((s) => s.name));
}

function liveSecretNames(worker: string): Set<string> {
  const deployments = cfJson(["workers", "deployments", "list", "--worker", worker]) as
    | { deployments?: { versions: { version_id: string }[] }[] }
    | null;
  const live = deployments?.deployments?.[0]?.versions ?? [];
  const names = new Set<string>();
  for (const { version_id } of live) {
    const version = cfJson(["workers", "versions", "get", version_id, "--worker-id", worker]) as { bindings?: NamedBinding[] } | null;
    for (const b of version?.bindings ?? []) if (SECRET_TYPES.has(b.type)) names.add(b.name);
  }
  return names;
}

function secretsFileNames(path: string): Set<string> {
  const text = readFileSync(resolve(process.cwd(), path), "utf8");
  if (text.trimStart().startsWith("{")) return new Set(Object.keys(JSON.parse(text)));
  return new Set(Object.keys(parseEnvFile(resolve(process.cwd(), path))));
}

let secretsGate: { worker: string; declared: string[] } | undefined;
// A dry run runs the check too (it reads Cloudflare, writes nothing); only the after-check needs a real deploy.
if (verb === "deploy") {
  let config = "";
  try {
    config = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    // No cf config here (unconverted or Pages-style project): nothing to check.
  }
  // Both reads skip comments: cf compiles the config, so a commented-out name or secret declares nothing.
  const worker = configWorkerName(config);
  // A config the check cannot read is refused, never skipped: a computed worker name would
  // otherwise let a deploy past this check with no warning.
  if (config && !worker) fail("secrets check: cloudflare.config.ts has no literal worker name (name: \"<worker>\"), so its secrets cannot be checked. Write the name as a string literal.");
  // Observability is the account default on every Worker (Observability.ts). It is applied after
  // the deploy whatever the config says; a config that switches it off is overridden, loudly.
  if (config) {
    const obs = readConfigObservability(config);
    if (obs.optOuts.length) {
      const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout?.trim() || process.cwd();
      console.error(`CfEnv: WARNING ${top} turns off ${obs.optOuts.join(", ")} in cloudflare.config.ts; the account default (logs on, traces at ${DEFAULT_OBSERVABILITY.traces.head_sampling_rate}) is applied after the deploy anyway. Remove the opt-out from the config.`);
    }
  }
  if (worker) {
    const declared = declaredSecretNames(config);
    const fileIndex = args.indexOf("--secrets-file");
    const fromFile = fileIndex === -1 ? new Set<string>() : secretsFileNames(args[fileIndex + 1]);
    const live = liveSecretNames(worker);
    const latest = latestSecretNames(worker);
    const undeclared = [...live].filter((n) => !declared.includes(n) && !dropSecrets.has(n));
    const dropping = [...live].filter((n) => dropSecrets.has(n));
    if (dropping.length) console.error(`CfEnv: ${worker} will drop ${dropping.join(", ")} on purpose (--drop-secret).`);
    if (undeclared.length) {
      fail(`${worker} has live secrets that cloudflare.config.ts does not declare, and cf deploy would delete them: ${undeclared.join(", ")}.\nAdd each as NAME: bindings.secret() under env, then deploy again.`);
    }
    const noValue = declared.filter((n) => !latest.has(n) && !fromFile.has(n));
    if (noValue.length) {
      fail(`${worker}: these declared secrets have no value on the newest version, so the deploy would ship without them: ${noValue.join(", ")}.\nPass --secrets-file <file> with their values (JSON or .env; names beyond the declared set are refused).`);
    }
    const extra = [...fromFile].filter((n) => !declared.includes(n));
    if (extra.length) fail(`--secrets-file holds names the config does not declare: ${extra.join(", ")}. Keep only declared secrets in it.`);
    secretsGate = { worker, declared };
    console.error(`CfEnv: secrets check passed for ${worker} (${declared.length} declared, ${live.size} live).`);
  }
}

let cfArgs = args;
let stdinValue: string | undefined;

if (verb === "secret") {
  // secret put <NAME> --name <worker> [--from-env [ENV_KEY]]
  if (args[1] !== "put") fail("only `secret put` is supported; list with `workers secrets list`.");
  const secretName = args[2];
  if (!secretName || secretName.startsWith("-")) fail("`secret put` needs the secret name.");
  const nameIndex = args.indexOf("--name");
  const worker = nameIndex === -1 ? undefined : args[nameIndex + 1];
  if (!worker || worker.startsWith("-")) fail("`secret put` needs --name <worker>.");

  let value: string;
  const fromEnvIndex = args.indexOf("--from-env");
  if (fromEnvIndex !== -1) {
    const explicitKey = args[fromEnvIndex + 1];
    const sourceKey = explicitKey && !explicitKey.startsWith("-") ? explicitKey : secretName;
    const found = envFile[sourceKey];
    if (!found) fail(`no ${sourceKey} in ${ENV_PATH}`);
    console.error(`CfEnv: ${sourceKey} → secret ${secretName} on ${worker}`);
    value = found;
  } else {
    value = readFileSync(0, "utf8").replace(/\r?\n$/, "");
    if (!value) fail("`secret put` read an empty value on stdin.");
  }

  stdinValue = JSON.stringify({ name: secretName, text: value, type: "secret_text" });
  // No --dry-run reaches here: it is refused for `secret` before the value is read (see above).
  cfArgs = ["workers", "secrets", "update", secretName, "--worker", worker, "--type", "secret_text", "--body", "@/dev/stdin", "-q"];
}

// Cloudflare rate-limits the whole account (API error 971 / HTTP 429) and says how long
// to wait. A throttled call is retried after that wait, up to MAX_ATTEMPTS, so a busy
// account never turns a deploy into a manual rerun. Output streams live and is also scanned for the signal.

async function pump(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream): Promise<string> {
  let seen = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    sink.write(chunk);
    seen += decoder.decode(chunk, { stream: true });
  }
  return seen;
}

async function runCf(): Promise<{ code: number; output: string }> {
  const child = Bun.spawn([...cfBin(), ...cfArgs], {
    stdin: stdinValue === undefined ? "inherit" : new TextEncoder().encode(stdinValue),
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
  });
  const [out, err] = await Promise.all([pump(child.stdout, process.stdout), pump(child.stderr, process.stderr)]);
  return { code: await child.exited, output: out + err };
}

// A throttle waits what Cloudflare asks; a dropped connection on a deploy waits 10s, then 30s (retryReason).
const NETWORK_WAITS_S = [10, 30];
let attempt = 1;
let networkRetries = 0;
let run = await runCf();
while (run.code !== 0 && attempt < MAX_ATTEMPTS) {
  const reason = retryReason(run.output, isDeploy);
  let waitS: number;
  if (reason === "throttled") {
    const retryAfter = Number(run.output.match(/wait (\d+) second/)?.[1] ?? 30);
    waitS = Math.min(Math.max(retryAfter, 5), 120) + 2;
    console.error(`CfEnv: Cloudflare throttled the account; retrying in ${waitS}s (attempt ${attempt + 1} of ${MAX_ATTEMPTS}).`);
  } else if (reason === "network" && networkRetries < NETWORK_WAITS_S.length) {
    waitS = NETWORK_WAITS_S[networkRetries++]!;
    console.error(`CfEnv: the connection to Cloudflare dropped mid-deploy; retrying the deploy in ${waitS}s (attempt ${attempt + 1}).`);
  } else break;
  await Bun.sleep(waitS * 1000);
  attempt += 1;
  run = await runCf();
}

const realDeploy = isDeploy && !args.includes("--dry-run");
let secretsLost: string[] = [];
if (run.code === 0 && secretsGate && realDeploy) {
  const kept = latestSecretNames(secretsGate.worker);
  secretsLost = secretsGate.declared.filter((n) => !kept.has(n));
  if (!secretsLost.length) console.error(`CfEnv: ${secretsGate.worker} carries all ${secretsGate.declared.length} declared secrets after the deploy.`);
}

// cf deploy uploads the observability the config declares, so a config without traces (or with
// logs off) turns them off on every deploy. The default goes back on right after the deploy and is
// read back. The deploy is already live, so a failure here warns loudly and is ledgered; it never
// changes the exit code.
let observability = "not applied (no literal worker name)";
if (run.code === 0 && realDeploy && secretsGate) {
  observability = await observabilityAfterDeploy({ token: childEnv.CLOUDFLARE_API_TOKEN, account: childEnv.CLOUDFLARE_ACCOUNT_ID ?? "" }, secretsGate.worker);
  console.error(`CfEnv: observability after deploy — ${observability}`);
  if (observability.startsWith("failed")) {
    console.error(`CfEnv: WARNING — ${secretsGate.worker} is live but its observability is NOT at the default (logs on, traces at ${DEFAULT_OBSERVABILITY.traces.head_sampling_rate}). Fix with: bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts observability-default apply --worker ${secretsGate.worker}`);
  }
}

// After a successful deploy, the app's ISA probes run against what just went live (Bunker's
// fast lane, asserts only). Before the deploy they would test the previous version, so they
// run here. Bunker exits 1 on a failing probe; exit 2 (manual rows awaiting attestation,
// gated rows) is unresolved evidence, never a failure.
let probes = "no ISA";
const isaPath = resolve(process.cwd(), "ISA.md");
const bunker = resolve(LIFEOS_DIR, "PULSE", "Bunker", "bin", "bunker.ts");
if (run.code === 0 && realDeploy && existsSync(isaPath) && existsSync(bunker)) {
  const p = spawnSync("bun", [bunker, "test", "--isa", isaPath, "--asserts"], { encoding: "utf8", timeout: 300_000 });
  const lines = `${p.stdout ?? ""}`.split("\n");
  const failing = lines.filter((l) => l.startsWith("❌"));
  const summary = lines.find((l) => / passed · /.test(l)) ?? "";
  // A run that did not finish (timeout, crash, signal) verified nothing, so it fails like a failing probe.
  probes = probeOutcome(p.status, p.signal, failing.length);
  console.error(`CfEnv: ISA probes after deploy — ${summary.trim() || probes}`);
  for (const l of failing) console.error(`  ${l}`);
}

// Every public HTML page shows a large link card on X and LinkedIn (og:image alone is not enough;
// X also needs twitter:card). Checked live, on each domain cloudflare.config.ts declares plus a
// sample of its deep pages from the sitemap, since a root can pass while deep pages draw no card;
// a host serving no HTML is skipped.
let socialCard = "no domains";
const socialTool = resolve(LIFEOS_DIR, "TOOLS", "SocialCard.ts");
if (run.code === 0 && realDeploy && existsSync(CONFIG_PATH) && existsSync(socialTool)) {
  const s = spawnSync("bun", [socialTool, "--config", CONFIG_PATH], { encoding: "utf8", timeout: 240_000 });
  const out = `${s.stdout ?? ""}`.trim();
  // Exit 2 with no output is the one honest "nothing public to check" (the config names no domain or
  // route). Any other non-pass, a timeout or crash included, fails: an unrun check is not a pass.
  if (!(s.status === 2 && !out)) {
    socialCard = socialCardOutcome(s.status, s.signal);
    console.error(`CfEnv: social card after deploy — ${socialCard}`);
    for (const l of out.split("\n")) if (l) console.error(`  ${l}`);
  }
}

// One ledger line per real deploy: the commit, the review, the probes and the version that
// went live, so a rollback is a lookup (`rg <worker> LIFEOS/MEMORY/STATE/deploys.jsonl`).
let versionId: string | null = null;
let previous: string | null = null;
if (realDeploy) {
  const worker = secretsGate?.worker;
  if (worker && run.code === 0) {
    // Not cfJson: its fail() would report a deploy that already succeeded as a failure.
    const r = spawnSync(cfBin()[0]!, [...cfBin().slice(1), "workers", "deployments", "list", "--worker", worker, "-q"], { env: childEnv, encoding: "utf8" });
    try {
      const d = JSON.parse((r.stdout ?? "").slice((r.stdout ?? "").search(/[[{]/))) as { deployments?: { versions: { version_id: string }[] }[] };
      versionId = d.deployments?.[0]?.versions?.[0]?.version_id ?? null;
      previous = d.deployments?.[1]?.versions?.[0]?.version_id ?? null;
    } catch {
      console.error("CfEnv: could not read the new version id for the deploy ledger; the deploy itself succeeded.");
    }
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim() || null;
  const dirty = (spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout ?? "").trim().length > 0;
  const entry = { ts: new Date().toISOString(), dir: process.cwd(), head, dirty, worker: worker ?? null, versionId, previousVersionId: previous, cfExit: run.code, review: reviewNote, reviewWaivers, releaseRecord: releaseRecordNote, probes, socialCard, observability, secretsLost };
  invariant(typeof entry.dir === "string" && entry.dir.length > 0 && Number.isInteger(entry.cfExit), "deploy ledger entry needs a dir and cf's exit code");
  invariant(Object.values(entry.reviewWaivers).every((v) => typeof v === "string" && v.trim().length > 0), "every review waiver in the deploy ledger carries its reason");
  const ledger = resolve(LIFEOS_DIR, "MEMORY", "STATE", "deploys.jsonl");
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, JSON.stringify(entry) + "\n");
  // The same deploy, in STATVS (ISC-110) and as a Vigil notice, named for its worker rather than the folder it ran from.
  {
    const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout?.trim() || process.cwd();
    const pi = args.indexOf("--project-name");
    const named = appNameFor(root, { worker, pagesProject: verb === "pages" && pi >= 0 ? args[pi + 1] : null });
    recordDeploy({ app: named.app, appFrom: named.from, version: readVersion(root).version, head, dirty, versionId, previousVersionId: previous, cfExit: run.code,
      review: reviewNote, releaseRecord: releaseRecordNote, probes, socialCard, secretsLost, dir: entry.dir });
  }

  // The estate-wide Ledger event (MEMORY/SYSTEMUPDATES/deploys.jsonl, LedgerSystem.md) for every
  // real deploy, success or failure, so no deploy depends on a hand-run record step. It never
  // changes the deploy's exit code; a failure here only warns.
  const ledgerTool = resolve(LIFEOS_DIR, "TOOLS", "LedgerDeployEvent.ts");
  if (existsSync(ledgerTool)) {
    const repo = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout?.trim() || process.cwd();
    const pi = args.indexOf("--project-name");
    const pagesProject = verb === "pages" && pi >= 0 ? args[pi + 1] : undefined;
    const target = worker ? `worker:${worker}` : pagesProject ? `pages:${pagesProject}` : `worker:${basename(repo)}`;
    const ev = spawnSync("bun", [ledgerTool, "record", "--project", basename(repo), "--target", target, "--repo", repo, run.code === 0 ? "--ok" : "--fail", ...(versionId ? ["--note", `version ${versionId}`] : [])], { encoding: "utf8", timeout: 30_000 });
    if (ev.status !== 0) console.error(`CfEnv: WARNING — the Ledger deploy event was not recorded (exit ${ev.status ?? ev.signal ?? "timeout"}). Record it by hand: bun ${ledgerTool} record --project ${basename(repo)} --target ${target}${run.code === 0 ? "" : " --fail"}`);
  }
}

const rollback = secretsGate ? ` Roll back: CfEnv.ts workers deployments create --worker ${secretsGate.worker} with ${previous ?? "the previous version (workers deployments list)"}.` : "";
if (secretsLost.length) failLive(`DEPLOYED WITHOUT SECRETS: ${secretsGate!.worker} is live missing ${secretsLost.join(", ")}.${rollback}`);
if (probes.startsWith("fail")) failLive(`DEPLOYED, BUT ISA PROBES FAILED OR DID NOT FINISH (${probes}; any failing rows are listed above). Rerun \`bun ${bunker} test --isa ${isaPath}\` to rule out a stale cache, then fix or roll back.${rollback}`);
if (socialCard.startsWith("fail")) failLive(`DEPLOYED, BUT THE SOCIAL CARD IS BROKEN OR UNCHECKED (listed above): X or LinkedIn may show no image. Fix the page head or image and redeploy, or rerun \`bun ${socialTool} --config ${CONFIG_PATH}\` if the check timed out.`);

process.exit(cfExitForCaller(run.code));
