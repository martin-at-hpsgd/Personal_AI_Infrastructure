/**
 * WorkflowCard.ts — one workflow run drawn as ANSI lines for an answer (WORKFLOW BOARD ISA F7).
 *
 * The answer card is a short form of the run's drawing (F9): the run is read through WorkflowView and
 * board-view's `workflowCardRows` + `toAnsi` draw its header, counts, attention lanes and one fold row
 * (board-view is the shared row library). A dim `as of HH:mm` line closes the card, because the card is a
 * snapshot taken when the answer streamed, never refreshed.
 *
 * Read-only. Called by `HookBridge.ts workflow-card <session> <runId> <columns>`, which RichFormat runs
 * when an answer holds a closed `workflow` fence. An unknown run, or a run board-view draws nothing for,
 * gives no lines, and the fence then shows as written.
 */
import { C, toAnsi, workflowCardRows, type WfRun } from "../../skills/LifeOSHooks/hooks/lib/board-view.ts";
import { readWorkflowView, type Model } from "./WorkflowView.ts";

/** A run id as the Workflow tool reports it. Anything else is never looked up. */
export const RUN_ID = /^wf_[A-Za-z0-9_-]{1,120}$/;

export const MIN_COLUMNS = 20;
export const MAX_COLUMNS = 400;
export const DEFAULT_COLUMNS = 80;

export interface CardOptions {
  session: string;
  runId: string;
  columns: number;
  /** The clock: an ISO string or epoch ms; absent is now. */
  now?: string | number;
  configRoot?: string;
  /** IANA zone for the `as of` time; absent is this process's local zone. */
  timeZone?: string;
}

/** The terminal width a card is drawn at: a finite integer inside [MIN_COLUMNS, MAX_COLUMNS], else the default. */
export function cardColumns(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_COLUMNS;
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.floor(n)));
}

/** `HH:mm` on a 24-hour clock in `timeZone` (or the local zone). */
export function clockTime(ms: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).formatToParts(new Date(ms));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

/**
 * The card for one run of an already-read model. Board-view's brief rows for that run, each rendered by
 * `toAnsi`, then the `as of HH:mm` line. No such run, or no rows for it, gives `[]`.
 */
export function cardFromModel(model: Model, runId: string, nowMs: number, columns: number, timeZone?: string): string[] {
  const run = model.runs.find((r) => r.runId === runId);
  if (!run) return [];
  // Board-view declares the structural subset of WorkflowView's Run it draws from (a hooks module
  // cannot import outside its plugin folder); WorkflowView's Run carries every field it reads.
  // The brief rows (F9): header, counts, attention lanes and one fold row counting the rest.
  const rows = workflowCardRows(run as unknown as WfRun, nowMs, columns);
  if (rows.length === 0) return [];
  return [...rows.map(toAnsi), toAnsi([{ text: `as of ${clockTime(nowMs, timeZone)}`, color: C.faint }])];
}

/** Read the session's workflow model and draw one run's card. A malformed run id gives `[]` without a read. */
export function workflowCardLines(opts: CardOptions): string[] {
  if (!RUN_ID.test(opts.runId)) return [];
  const nowMs = opts.now === undefined ? Date.now() : typeof opts.now === "number" ? opts.now : Date.parse(opts.now);
  if (!Number.isFinite(nowMs)) throw new Error(`workflow-card: unreadable clock ${String(opts.now)}`);
  const model = readWorkflowView({ session: opts.session, now: nowMs, configRoot: opts.configRoot });
  return cardFromModel(model, opts.runId, nowMs, cardColumns(opts.columns), opts.timeZone);
}
