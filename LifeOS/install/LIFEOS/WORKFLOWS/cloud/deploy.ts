#!/usr/bin/env bun
/**
 * The gated deploy script for one cloud workflow (ISC-134, ISC-135).
 *
 *   bun LIFEOS/WORKFLOWS/cloud/deploy.ts <name> [--confirm <name>] [--allow-dirty <reason>] [--waive-blockers <reason>] [--json]
 *
 * `workflow deploy <name>` runs this file and nothing else. The order is fixed:
 *
 *   1. read the definition (it must be runs_on: cloud);
 *   2. preflight, read-only (GET): every action Worker the runner binds must
 *      exist, the runner's state namespace and the shared claims database must
 *      exist, and, once the runner is
 *      deployed, every secret name it needs must be present. Any failure refuses
 *      here, before a build and before any upload;
 *   3. the approval gate: `--confirm <name>` AND env WORKFLOWS_DEPLOY_APPROVED=<name>;
 *   4. build the runner from the engine source on disk (cloud/build.ts);
 *   5. hand the build to the fleet's sanctioned deploy path (the CfEnv helper,
 *      LIFEOS/TOOLS/CfEnv.ts), which reads the Cloudflare credentials itself.
 *      `--allow-dirty <reason>` (uncommitted files ship; the model review still
 *      runs) and `--waive-blockers <reason>` (ship past model blockers, a
 *      reviewer outage or an over-limit diff) are passed on to CfEnv for its code
 *      review, which records each reason; an empty, blank or flag-shaped reason
 *      refuses first. The retired `--accept` is refused as a usage error that
 *      names the two flags (2026-10-11).
 *
 * A first deploy has no runner Worker yet, so its secrets cannot exist: they are
 * reported as pending, not as a refusal. A missing action Worker always refuses.
 * Tests inject the builder, the deployer and fetch; nothing here is exercised
 * against the live account by them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { declaredSecrets, parseDefinitionText } from "../engine/format.ts";
import { resolveDefinition } from "../engine/paths.ts";
import { textHash } from "../engine/definitions.ts";
import { recordDeploy } from "../engine/deploy-record.ts";
import { buildRunner, PLACEHOLDER_KV, scriptFor, type BuildResult } from "./build.ts";
import { cloudCredentials, loadCloudEnvFile } from "./credentials.ts";
import { CLAIMS_DATABASE } from "./claims.ts";
import { d1DatabaseExists, findKvNamespace, preflight, type FetchLike, type PreflightVerdict } from "./preflight.ts";
import { runnerNameFor } from "./secret-check.ts";

const CLOUD_DIR = import.meta.dir;
const CF_ENV = resolve(CLOUD_DIR, "..", "..", "TOOLS", "CfEnv.ts");
/** The secret every runner holds; the runner fails closed without it. */
export const RUNNER_SECRET = "RUNNER_TOKEN";

export type DeployReason = "bad-waiver" | "not-cloud" | "no-credentials" | "missing-workers" | "missing-secrets" | "missing-kv" | "missing-d1" | "not-approved" | "build-failed" | "deploy-failed";

export type DeployResult =
  | { status: "deployed"; name: string; runner: string; pendingSecrets: string[]; build: BuildResult }
  | { status: "refused"; reason: DeployReason; name: string; message: string; preflight?: PreflightVerdict };

/** What the deploy step is told beyond the build: the code-review waiver reasons, when given. */
export interface DeployCall {
  /** `--allow-dirty <reason>`: lifts only the review's uncommitted-files block. */
  allowDirty?: string;
  /** `--waive-blockers <reason>`: ships past model blockers, a reviewer outage or an over-limit diff; never uncommitted files. */
  waiveBlockers?: string;
}

/** The review waiver flags, in the order they are forwarded. */
const WAIVER_FLAGS = [["--allow-dirty", "allowDirty"], ["--waive-blockers", "waiveBlockers"]] as const;

/** The usage error for the retired one-reason override; Review.ts and CfEnv refuse it with the same pointer to the two flags. */
export const RETIRED_ACCEPT = `--accept is retired. Use --allow-dirty "<reason>" to ship uncommitted files in the deploy dir (the model review still runs), or --waive-blockers "<reason>" to ship past model blockers, a reviewer outage or an over-limit diff (never uncommitted files).`;

/** `call` is optional so a deployer written for the build alone still fits; deployWorkflow always passes it. */
export type Deployer = (build: BuildResult, call?: DeployCall) => Promise<{ ok: boolean; detail?: string }> | { ok: boolean; detail?: string };

export interface DeployOptions {
  definitionPath: string;
  name: string;
  confirm?: string;
  /** `--allow-dirty <reason>` for the CfEnv code review (it records the reason). Refused before anything else when empty, blank or flag-shaped. */
  allowDirty?: string;
  /** `--waive-blockers <reason>` for the CfEnv code review (it records the reason). Refused the same way. */
  waiveBlockers?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  build?: (definitionPath: string, scripts: Record<string, string>) => Promise<BuildResult>;
  deployer?: Deployer;
  scripts?: Record<string, string>;
  /** Where the deploy record goes (ISC-174). The real deploy path records to engine/deploy-record.ts's default; an injected deployer records only when this is set. */
  deployLog?: string;
}

/**
 * Why a review waiver reason cannot be used, or undefined when it can. CfEnv refuses a
 * missing, blank or flag-shaped reason (one starting with "-" would read as a flag), so
 * it is refused here first, before any request or build.
 */
export function waiverReasonProblem(flag: "--allow-dirty" | "--waive-blockers", reason: string): string | undefined {
  if (reason.trim() === "") return `${flag} needs a reason (it is recorded with the code review); an empty or blank one is refused.`;
  if (reason.startsWith("-")) return `${flag} needs a reason, not a flag ("${reason}").`;
  return undefined;
}

/** The first problem with the waivers in `call`, or undefined. */
function waiverProblem(call: DeployCall): string | undefined {
  for (const [flag, key] of WAIVER_FLAGS) {
    const reason = call[key];
    const problem = reason === undefined ? undefined : waiverReasonProblem(flag, reason);
    if (problem) return problem;
  }
  return undefined;
}

/** The argv after `bun` for a prebuilt deploy through CfEnv: each waiver flag is added only when its reason was given. */
export function cfEnvDeployArgv(helper: string, call: DeployCall): string[] {
  return [helper, "deploy", "--prebuilt", ...WAIVER_FLAGS.flatMap(([flag, key]) => (call[key] !== undefined ? [flag, call[key]!] : []))];
}

/** The one process call the CfEnv deployer makes; injectable so tests read the argv without running CfEnv. */
export type Spawn = (command: string, args: string[], options: { cwd: string; stdio: "inherit"; env: NodeJS.ProcessEnv }) => { status: number | null };

const realSpawn: Spawn = (command, args, options) => spawnSync(command, args, options);

/** Builds a deployer that runs `cf deploy --prebuilt` through CfEnv, from the build's output directory (the compiled bundle deploys as is). */
export function makeCfEnvDeployer(spawn: Spawn = realSpawn, helper: string = CF_ENV): Deployer {
  return (build, call) => {
    if (!existsSync(helper)) return { ok: false, detail: "no Cloudflare deploy helper on this install (LIFEOS/TOOLS/CfEnv.ts is absent); inject a deployer" };
    const result = spawn("bun", cfEnvDeployArgv(helper, call ?? {}), { cwd: build.dir, stdio: "inherit", env: process.env });
    return { ok: result.status === 0, detail: `exit ${result.status ?? "signal"}` };
  };
}

/** The fleet's sanctioned deploy step. */
export const cfEnvDeployer: Deployer = makeCfEnvDeployer();

const refuse = (name: string, reason: DeployReason, message: string, verdict?: PreflightVerdict): DeployResult => ({ status: "refused", reason, name, message, ...(verdict ? { preflight: verdict } : {}) });

export async function deployWorkflow(opts: DeployOptions): Promise<DeployResult> {
  const env = opts.env ?? process.env;
  const { name } = opts;
  // 0. A review waiver must carry a usable reason; a bad one refuses before any read, request or build.
  const call: DeployCall = { ...(opts.allowDirty !== undefined ? { allowDirty: opts.allowDirty } : {}), ...(opts.waiveBlockers !== undefined ? { waiveBlockers: opts.waiveBlockers } : {}) };
  const badWaiver = waiverProblem(call);
  if (badWaiver) return refuse(name, "bad-waiver", badWaiver);
  const definitionText = readFileSync(opts.definitionPath, "utf8");
  const def = parseDefinitionText(definitionText, opts.definitionPath);
  if (def.name !== name) return refuse(name, "not-cloud", `The definition at ${opts.definitionPath} is named "${def.name}", not "${name}".`);
  if (def.runs_on !== "cloud") return refuse(name, "not-cloud", `${name} is runs_on: ${def.runs_on}; only a cloud workflow deploys.`);

  const creds = cloudCredentials(env);
  if (!creds) return refuse(name, "no-credentials", "No Cloudflare credentials in the environment, so the preflight cannot run and nothing is uploaded.");

  const scripts = opts.scripts ?? {};
  const runner = runnerNameFor(name);
  const actionScripts = [...new Set(Object.values(def.steps).flatMap(s => (s.kind === "action" && s.uses ? [scriptFor(s.uses, scripts)] : [])))];
  const secrets = [...new Set([RUNNER_SECRET, ...declaredSecrets(def).map(s => s.name)])];

  // 2. Preflight, read-only. Refuses before any build or upload.
  const verdict = await preflight({ ...creds, runner, actionScripts, secrets, fetch: opts.fetch });
  if (verdict.missingWorkers.length) return refuse(name, "missing-workers", `Action Workers not deployed: ${verdict.missingWorkers.join(", ")}. Deploy them first.`, verdict);
  if (verdict.runnerExists && verdict.missingSecrets.length) return refuse(name, "missing-secrets", `Secrets missing on ${runner}: ${verdict.missingSecrets.join(", ")}. Set them (names only shown) before deploying.`, verdict);
  const kvTitle = `${runner}-state`;
  const kvId = await findKvNamespace({ ...creds, title: kvTitle, fetch: opts.fetch });
  if (!kvId) return refuse(name, "missing-kv", `No KV namespace titled ${kvTitle}; create it first (kv verb of the fleet deploy helper).`, verdict);
  if (!(await d1DatabaseExists({ ...creds, name: CLAIMS_DATABASE, fetch: opts.fetch }))) {
    return refuse(name, "missing-d1", `No D1 database named ${CLAIMS_DATABASE} for occurrence claims; create it first (d1 verb of the fleet deploy helper).`, verdict);
  }

  // 3. The approval gate: both the flag and the env value must name this workflow.
  if (opts.confirm !== name || env.WORKFLOWS_DEPLOY_APPROVED !== name) {
    return refuse(name, "not-approved", `Preflight passed. Deploying needs --confirm ${name} and env WORKFLOWS_DEPLOY_APPROVED=${name}; neither alone is enough.`, verdict);
  }

  // 4. Build.
  let built: BuildResult;
  try {
    built = await (opts.build ?? ((p, s) => buildRunner(p, s)))(opts.definitionPath, scripts);
  } catch (error) {
    return refuse(name, "build-failed", error instanceof Error ? error.message : String(error), verdict);
  }
  const workerConfig = JSON.parse(readFileSync(built.config, "utf8")) as { env?: Record<string, { type: string; id?: string }> };
  for (const binding of Object.values(workerConfig.env ?? {})) if (binding.type === "kv" && binding.id === PLACEHOLDER_KV) binding.id = kvId;
  writeFileSync(built.config, `${JSON.stringify(workerConfig, null, 2)}\n`);

  // 5. The sanctioned deploy path.
  const done = await (opts.deployer ?? cfEnvDeployer)(built, call);
  if (!done.ok) return refuse(name, "deploy-failed", `The deploy step failed (${done.detail ?? "no detail"}).`, verdict);
  if (opts.deployLog !== undefined || opts.deployer === undefined) {
    recordDeploy({ name, definition_hash: textHash(definitionText), runner, deployed_at: new Date().toISOString() }, ...(opts.deployLog !== undefined ? [opts.deployLog] : []));
  }
  if (!verdict.runnerExists) return { status: "deployed", name, runner, pendingSecrets: verdict.missingSecrets, build: built };
  // 6. Read the secrets back. `cf deploy` has dropped a Worker's secrets before (Surface outage and the
  // summarize-content redeploy, both 2026-09-30); a runner without RUNNER_TOKEN answers every call 401.
  const after = await preflight({ ...creds, runner, actionScripts, secrets, fetch: opts.fetch });
  return { status: "deployed", name, runner, pendingSecrets: after.missingSecrets, build: built };
}

const USAGE = "usage: deploy.ts <name> [--confirm <name>] [--allow-dirty <reason>] [--waive-blockers <reason>] [--json]";

export type DeployArgs = { ok: true; name: string; confirm?: string; allowDirty?: string; waiveBlockers?: string; json: boolean } | { ok: false; error: string };

/**
 * Reads this script's argv. `--confirm`, `--allow-dirty` and `--waive-blockers` each take
 * the next argument as their value; a missing value, or a waiver reason CfEnv would
 * refuse, is a usage error, and so is the retired `--accept`. Other `--` arguments are
 * ignored and the first plain argument is the name.
 */
export function parseDeployArgs(args: string[]): DeployArgs {
  let confirm: string | undefined;
  const call: DeployCall = {};
  let json = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") json = true;
    else if (arg === "--accept" || arg.startsWith("--accept=")) return { ok: false, error: RETIRED_ACCEPT };
    else if (arg === "--confirm") {
      const value = args[++i];
      if (value === undefined) return { ok: false, error: "--confirm needs the workflow's name." };
      confirm = value;
    } else if (arg === "--allow-dirty" || arg === "--waive-blockers") {
      const value = args[++i];
      if (value === undefined) return { ok: false, error: `${arg} needs a reason.` };
      call[arg === "--allow-dirty" ? "allowDirty" : "waiveBlockers"] = value;
    } else if (!arg.startsWith("--")) positional.push(arg);
  }
  const badWaiver = waiverProblem(call);
  if (badWaiver) return { ok: false, error: badWaiver };
  const name = positional[0];
  if (!name) return { ok: false, error: USAGE };
  return { ok: true, name, confirm, ...call, json };
}

if (import.meta.main) {
  const parsed = parseDeployArgs(process.argv.slice(2));
  if (!parsed.ok) {
    if (process.argv.includes("--json")) console.log(JSON.stringify({ status: "refused", reason: "usage", message: parsed.error }));
    console.error(parsed.error);
    process.exit(2);
  }
  const { name, confirm, allowDirty, waiveBlockers, json } = parsed;
  const say = (text: string) => (json ? undefined : console.log(text));
  // The real definitions home only: a test home never reads the credentials file.
  if (!process.env.LIFEOS_WORKFLOWS_DIR) loadCloudEnvFile();
  const found = resolveDefinition(name);
  if (!found.ok) {
    console.error(found.error);
    process.exit(2);
  }
  const result = await deployWorkflow({ definitionPath: found.path, name, confirm, allowDirty, waiveBlockers });
  if (json) console.log(JSON.stringify(result, (k, v) => (k === "build" ? undefined : v)));
  else if (result.status === "deployed") say(`Deployed ${result.runner}.${result.pendingSecrets.length ? ` Secrets still to set: ${result.pendingSecrets.join(", ")}.` : ""}`);
  else console.error(`Refused (${result.reason}): ${result.message}`);
  process.exit(result.status === "deployed" ? 0 : 1);
}
