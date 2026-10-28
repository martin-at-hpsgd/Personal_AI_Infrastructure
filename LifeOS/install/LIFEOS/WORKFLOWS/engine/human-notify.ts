#!/usr/bin/env bun
/**
 * Relay approval for human steps (ISC-130). When a run parks on a human step,
 * one text goes to the principal's own line through the existing Relay send
 * path (`LIFEOS/RELAY/bridge/send.ts`), and the message id the transport
 * acknowledged is bound to that run and step. The Relay bridge maps a 👍 or 👎
 * tapback on exactly that message to `answerHumanStep` with approved true or
 * false, then resumes the run through this file's CLI.
 *
 * The binding is the whole authority a tapback carries, so it is narrow:
 *   - only 👍 and 👎 answer; any other tapback on a bound message is noted;
 *   - only the bound message answers its step (never "the newest message");
 *   - an answered step, or a run no longer parked on that step, changes nothing;
 *   - the bridge admits only the principal's own iMessage line before calling
 *     in here, and checks the target is a notification it recorded in that
 *     principal's thread (workflow-tapback.ts).
 *
 * Layout, beside the ledger (next to waiting/ and answers/):
 *   relay/<run_id>/<step_id>.json   {state: sending|sent, message_id, ...} (0600)
 *
 * CLI (argv only, no shell):
 *   bun LIFEOS/WORKFLOWS/engine/human-notify.ts notify
 *   bun LIFEOS/WORKFLOWS/engine/human-notify.ts resume <run_id>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { invariant } from "../../TOOLS/Invariant.ts";
import { textCard } from "../../TOOLS/TextFormat.ts";
import { answerHumanStep, listWaiting, readAnswer, readWaiting } from "./human.ts";
import { ensureInside } from "./ledger.ts";
import { ledgerPath } from "./paths.ts";

export const YES_TAPBACK = "👍";
export const NO_TAPBACK = "👎";
/** The Relay text limit for anything sent to the principal's line (OPERATIONAL_PREFERENCES § Urgent notifications). */
export const TEXT_LIMIT = 400;
export const RELAY_ORIGIN = "workflows";
/** A send that has not finished in this long is killed and counted as failed. */
export const SEND_TIMEOUT_MS = 60_000;

const LIFEOS_DIR = resolve(import.meta.dir, "..", "..");
const SEND_TS = join(LIFEOS_DIR, "RELAY", "bridge", "send.ts");
const BRIDGE_CONFIG = join(LIFEOS_DIR, "USER", "RELAY", "state", "bridge-config.json");
export const CLI_PATH = join(import.meta.dir, "human-notify.ts");

// Same shapes human.ts enforces on its own files; repeated here because these ids also name paths.
const RUN_ID_RE = /^[A-Za-z0-9-]{8,}$/;
const STEP_ID_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

export interface RelayBinding {
  schema: 1;
  run_id: string;
  step_id: string;
  workflow: string;
  /** `sending` is the claim written before the text goes out; `sent` carries the transport's message id. */
  state: "sending" | "sent";
  message_id: string | null;
  claimed_at: string;
  sent_at: string | null;
}

export const relayDir = (ledger: string = ledgerPath()): string => join(dirname(ledger), "relay");

function bindingFile(ledger: string, runId: string, stepId: string): string {
  invariant(RUN_ID_RE.test(runId), `Not a run id: ${runId}`);
  invariant(STEP_ID_RE.test(stepId), `Not a step id: ${stepId}`);
  return join(relayDir(ledger), runId, `${stepId}.json`);
}

function assertBinding(b: RelayBinding): void {
  invariant(b.schema === 1, "A relay binding needs schema 1");
  invariant(b.state === "sending" || b.state === "sent", `Relay binding state must be sending or sent, got ${String(b.state)}`);
  invariant(b.state !== "sent" || (typeof b.message_id === "string" && b.message_id.length > 0), "A sent relay binding needs the transport's message id");
  invariant(typeof b.workflow === "string" && b.workflow.length > 0, "A relay binding needs its workflow name");
}

/** One line of plain text: control characters and runs of whitespace become single spaces. */
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

/** The text for one waiting step (F13): a ⚙️ card with the workflow name in bold, the step's prompt, and the answer line last. Always under TEXT_LIMIT. */
export function approvalText(workflow: string, prompt: string): string {
  const text = textCard({
    kind: "workflow",
    title: `Workflow ${oneLine(workflow).slice(0, 64)} is waiting`,
    body: oneLine(prompt) || "Approve this step?",
    footer: "👍 approves, 👎 declines.",
    cap: TEXT_LIMIT - 1,
  });
  invariant(text.length < TEXT_LIMIT, `Approval text is ${text.length} characters; the limit is ${TEXT_LIMIT}`);
  return text;
}

/** Sends one text to the principal's own line and returns the message id the transport acknowledged, or why not. */
export type RelaySend = (text: string) => Promise<{ messageId: string | null; error?: string }>;

/** The principal's own line from the Relay bridge config (0600), never typed or printed. */
function ownLine(): string | null {
  try {
    const cfg = JSON.parse(readFileSync(BRIDGE_CONFIG, "utf8")) as { ownChannels?: { numbers?: unknown } };
    const numbers = cfg.ownChannels?.numbers;
    const n = Array.isArray(numbers) ? numbers[0] : undefined;
    return typeof n === "string" && /^\+\d{8,15}$/.test(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * The production send: `bun send.ts <own line> <text> --origin workflows`, argv
 * only. Test runs never reach the phone: this refuses under NODE_ENV=test, and
 * send.ts refuses again on its own.
 */
export const relaySend: RelaySend = async text => {
  if (process.env.NODE_ENV === "test") return { messageId: null, error: "refused: test run" };
  const to = ownLine();
  if (!to) return { messageId: null, error: "no own line in the Relay bridge config" };
  const proc = Bun.spawn([process.execPath, SEND_TS, to, text, "--origin", RELAY_ORIGIN], {
    cwd: dirname(SEND_TS), stdout: "pipe", stderr: "pipe", timeout: SEND_TIMEOUT_MS, killSignal: "SIGKILL",
  });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) return { messageId: null, error: `send.ts exited ${code}: ${err.trim().slice(0, 200)}` };
  const last = out.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(last) as { ok?: unknown; messageId?: unknown; skipped?: unknown };
    if (parsed.ok === true && typeof parsed.messageId === "string" && parsed.messageId) return { messageId: parsed.messageId };
    return { messageId: null, error: parsed.skipped ? `send skipped: ${String(parsed.skipped)}` : "send.ts acknowledged no message id" };
  } catch {
    return { messageId: null, error: "send.ts printed no JSON result" };
  }
};

function writeBinding(path: string, b: RelayBinding, exclusive: boolean): boolean {
  assertBinding(b);
  const text = JSON.stringify(b);
  if (exclusive) {
    try {
      writeFileSync(path, text, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  return true;
}

function readBinding(path: string): RelayBinding | null {
  try {
    const b = JSON.parse(readFileSync(path, "utf8")) as RelayBinding;
    return b?.schema === 1 && (b.state === "sending" || b.state === "sent") && typeof b.run_id === "string" && typeof b.step_id === "string" ? b : null;
  } catch {
    return null;
  }
}

/** Every binding on disk; unreadable files are skipped, never trusted. */
export function listBindings(ledger: string = ledgerPath()): RelayBinding[] {
  const root = relayDir(ledger);
  if (!existsSync(root)) return [];
  const out: RelayBinding[] = [];
  for (const run of readdirSync(root)) {
    if (!RUN_ID_RE.test(run)) continue;
    const dir = join(root, run);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const b = readBinding(join(dir, f));
      if (b && b.run_id === run && `${b.step_id}.json` === f) out.push(b);
    }
  }
  return out;
}

export interface NotifyReport {
  sent: Array<{ run_id: string; step_id: string; message_id: string }>;
  failed: Array<{ run_id: string; step_id: string; error: string }>;
  /** Claims left in `sending` by a sweep that died mid-send; never re-sent automatically, so a step is never texted twice. */
  stuck: Array<{ run_id: string; step_id: string }>;
  /** Bindings removed because their run is no longer parked. */
  pruned: number;
}

/**
 * Texts the principal once for every unanswered human step that has no
 * binding yet. The binding is claimed before the send (so two sweeps never
 * both text the same step) and completed with the acknowledged message id;
 * a failed send releases the claim so the next sweep tries again. Bindings of
 * runs that are no longer parked are pruned.
 */
export async function notifyWaiting(opts: { ledger?: string; send?: RelaySend; now?: () => Date } = {}): Promise<NotifyReport> {
  const ledger = opts.ledger ?? ledgerPath();
  const send = opts.send ?? relaySend;
  const now = opts.now ?? (() => new Date());
  const report: NotifyReport = { sent: [], failed: [], stuck: [], pruned: 0 };
  const parked = listWaiting(ledger);
  const live = new Set(parked.map(r => r.run_id));
  for (const b of listBindings(ledger)) {
    if (live.has(b.run_id)) continue;
    rmSync(join(relayDir(ledger), b.run_id), { recursive: true, force: true });
    report.pruned++;
  }
  for (const run of parked) {
    for (const step of run.waiting_on) {
      if (readAnswer(ledger, run.run_id, step) !== null) continue;
      const path = bindingFile(ledger, run.run_id, step);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      ensureInside(relayDir(ledger), path, "Relay binding");
      const claim: RelayBinding = { schema: 1, run_id: run.run_id, step_id: step, workflow: run.workflow, state: "sending", message_id: null, claimed_at: now().toISOString(), sent_at: null };
      if (!writeBinding(path, claim, true)) {
        if (readBinding(path)?.state === "sending") report.stuck.push({ run_id: run.run_id, step_id: step });
        continue;
      }
      let result: Awaited<ReturnType<RelaySend>>;
      try {
        result = await send(approvalText(run.workflow, run.prompts?.[step] ?? ""));
      } catch (error) {
        result = { messageId: null, error: error instanceof Error ? error.message : String(error) };
      }
      if (!result.messageId) {
        unlinkSync(path);
        report.failed.push({ run_id: run.run_id, step_id: step, error: result.error ?? "no message id" });
        continue;
      }
      writeBinding(path, { ...claim, state: "sent", message_id: result.messageId, sent_at: now().toISOString() }, false);
      report.sent.push({ run_id: run.run_id, step_id: step, message_id: result.messageId });
    }
  }
  return report;
}

export type TapbackResult = "approved" | "declined" | "ignored-emoji" | "already-answered" | "not-waiting";

export type TapbackOutcome =
  | { handled: false }
  | { handled: true; result: TapbackResult; run_id: string; step_id: string; workflow: string; reply?: string };

/**
 * Decides and applies what a principal's tapback means for a workflow step.
 * `isTarget` says whether a bound message id is the message the tapback sits
 * on (the bridge passes its GUID-aware comparison). A tapback on no bound
 * message is not handled here and the caller's own tapback rules apply.
 */
export function answerFromTapback(emoji: string, isTarget: (messageId: string) => boolean, opts: { ledger?: string; now?: () => Date } = {}): TapbackOutcome {
  const ledger = opts.ledger ?? ledgerPath();
  const binding = listBindings(ledger).find(b => b.state === "sent" && typeof b.message_id === "string" && isTarget(b.message_id));
  if (!binding) return { handled: false };
  const where = { run_id: binding.run_id, step_id: binding.step_id, workflow: binding.workflow };
  if (emoji !== YES_TAPBACK && emoji !== NO_TAPBACK) return { handled: true, result: "ignored-emoji", ...where };
  const waiting = readWaiting(ledger, binding.run_id);
  if (!waiting || !waiting.waiting_on.includes(binding.step_id)) {
    return { handled: true, result: "not-waiting", ...where, reply: `That ${binding.workflow} step isn't waiting anymore, so nothing changed.` };
  }
  if (readAnswer(ledger, binding.run_id, binding.step_id) !== null) {
    return { handled: true, result: "already-answered", ...where, reply: `That ${binding.workflow} step was already answered, so nothing changed.` };
  }
  const approved = emoji === YES_TAPBACK;
  answerHumanStep(binding.run_id, binding.step_id, { approved, note: `Relay ${approved ? "👍" : "👎"} tapback` }, { ledger, now: opts.now });
  return approved
    ? { handled: true, result: "approved", ...where, reply: `👍 Approved. ${binding.workflow} is resuming.` }
    : { handled: true, result: "declined", ...where, reply: `👎 Declined. ${binding.workflow} is resuming without it.` };
}

/** The argv that resumes one run and texts any human step it parks on next. */
export function resumeArgv(runId: string): string[] {
  invariant(RUN_ID_RE.test(runId), `Not a run id: ${runId}`);
  return [process.execPath, CLI_PATH, "resume", runId];
}

const USAGE = "usage: human-notify.ts notify | resume <run_id>";

async function main(argv: string[]): Promise<number> {
  const [cmd, runId, ...extra] = argv;
  if (cmd === "notify" && runId === undefined) {
    const report = await notifyWaiting();
    console.log(JSON.stringify({ ok: report.failed.length === 0, ...report }));
    return report.failed.length === 0 ? 0 : 1;
  }
  if (cmd === "resume" && runId !== undefined && extra.length === 0) {
    if (!RUN_ID_RE.test(runId)) {
      console.error(`Not a run id: ${runId}`);
      return 2;
    }
    // Loaded here, not at the top, so the Relay bridge importing this file never pulls in the runner.
    const { resumeRun } = await import("./runner.ts");
    const report = await resumeRun(runId);
    const notified = await notifyWaiting();
    console.log(JSON.stringify({ ok: report !== null, run_id: runId, status: report?.status ?? (report ? (report.success ? "succeeded" : "failed") : "not-ready"), notified: notified.sent.length, notify_failed: notified.failed.length }));
    return report === null ? 3 : 0;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
