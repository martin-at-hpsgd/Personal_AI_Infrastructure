/**
 * workflow-tapback.ts — a 👍 or 👎 on a workflow approval text answers that
 * workflow's human step (Workflows ISA ISC-130).
 *
 * handler.ts calls this only for a reaction from the principal's own direct
 * iMessage line (contacts, groups, SMS and unknown senders are dropped before
 * it). On top of that, a tapback is routed here only when its target is a
 * notification recorded in THIS principal's thread and the Workflows engine
 * has that exact message bound to a waiting step. Everything else returns
 * unhandled and the ordinary Tex tapback rules (tapback.ts) apply
 * unchanged, so this can never approve a guard-held action.
 */
import type { ConversationStore } from "./conversation.ts";
import { sameMessage } from "./tapback.ts";
import { answerFromTapback, resumeArgv, type TapbackOutcome } from "../../WORKFLOWS/engine/human-notify.ts";

export interface WorkflowTapbackResult {
  handled: boolean;
  reply?: string;
  log?: Record<string, unknown>;
}

export interface WorkflowTapbackDeps {
  /** Answers the bound step; injected in tests to point at a sandbox ledger. */
  answer?: (emoji: string, isTarget: (messageId: string) => boolean) => TapbackOutcome;
  /** Starts the resume of an answered run; must not block the thread. */
  resume: (runId: string) => void;
}

export function routeWorkflowTapback(sender: string, thread: string, content: any, store: ConversationStore, deps: WorkflowTapbackDeps): WorkflowTapbackResult {
  if (content?.type !== "reaction" || typeof content.emoji !== "string") return { handled: false };
  const targetId: unknown = content.target?.id;
  if (typeof targetId !== "string" || !targetId) return { handled: false };
  if (content.target?.space?.id && content.target.space.id !== thread) return { handled: false };
  const ours = store.messages(sender, thread).some(m => m.direction === "outbound" && m.source === "notification" && sameMessage(m.id, targetId));
  if (!ours) return { handled: false };
  const outcome = (deps.answer ?? answerFromTapback)(content.emoji, id => sameMessage(targetId, id));
  if (!outcome.handled) return { handled: false };
  if (outcome.result === "approved" || outcome.result === "declined") deps.resume(outcome.run_id);
  return {
    handled: true,
    ...(outcome.reply ? { reply: outcome.reply } : {}),
    log: { result: outcome.result, run_id: outcome.run_id, step_id: outcome.step_id, workflow: outcome.workflow },
  };
}

/**
 * Resumes the run in a child process so the thread is free at once. The child
 * is not detached; it is bounded by the run's own step timeouts and deadline
 * (runner.ts runDeadlineMs), and its exit is logged. It runs headless and
 * outside any texting session.
 */
export function spawnResume(runId: string, log: (event: string, data?: Record<string, unknown>) => void): void {
  const env: Record<string, string | undefined> = { ...process.env, LIFEOS_NOTIFICATION_CHANNEL: "headless" };
  delete env.LIFEOS_TEXTING_SESSION;
  delete env.LIFEOS_TEXTING_STATE;
  const proc = Bun.spawn(resumeArgv(runId), { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  log("workflow_resume_started", { run_id: runId, pid: proc.pid });
  void Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(
    ([code, out, err]) => log("workflow_resume_exit", { run_id: runId, code, result: out.trim().split("\n").pop()?.slice(0, 300) ?? "", ...(code === 0 ? {} : { error: err.trim().slice(0, 300) }) }),
    error => log("workflow_resume_failed", { run_id: runId, error: String(error).slice(0, 300) }),
  );
}
