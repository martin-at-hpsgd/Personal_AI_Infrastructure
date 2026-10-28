/**
 * @version 1.0.0
 * Classify.ts — which transcript rows are typed prompts, and where each prompt came from.
 *
 * Origin is derived from the transcript alone. Rows that tests write under MEMORY/OBSERVABILITY are
 * not ground truth, so nothing here reads them. Every prompt gets exactly one origin, never null:
 *
 *   test      a known fixture prompt (fake private key, "Reply with exactly the word…", "Is a tomato…")
 *   task      a background task or subagent coming back (<task-notification>, [Subagent hand-back]),
 *             or the brief that opens a subagent transcript
 *   peer      another session or teammate talking (cross-session, teammate and agent messages)
 *   headless  an SDK-driven prompt (entrypoint sdk-*, promptSource/turnOrigin sdk), or no signal at all
 *   human     an interactive prompt (origin.kind human, typed/queued, entrypoint cli or desktop)
 *
 * The order of the checks is the precedence: fixture text beats every other signal, a hand-back beats
 * the peer wrapper it sometimes arrives in, and the entrypoint is consulted only after the text markers.
 */

export const ORIGINS = ["human", "peer", "task", "headless", "test"] as const;
export type Origin = (typeof ORIGINS)[number];

export interface OriginResult { origin: Origin; signal: string }

type Row = Record<string, any>;

const FIXTURES: Array<[string, RegExp]> = [
  ["fixture:private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["fixture:reply-exactly", /^Reply with exactly the word\b/i],
  ["fixture:tomato", /^Is a tomato\b/i],
];

/** Harness markers that ride on a user row but are not something anyone typed. */
const NON_PROMPT = /^(\[Request interrupted|<local-command-caveat>|<local-command-stdout>|<bash-stdout>|<bash-stderr>)/;

const HANDBACK = /^(<agent-message[^>]*>\s*)?\[Subagent hand-back\]/;
const TASK_NOTE = /^<task-notification\b/;
const PEER = /^(Another Claude session sent a message|<cross-session-message\b|<teammate-message\b|<agent-message\b)/;

/** Text of a message's content: the string itself, or every text block joined by newlines. */
export function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as Row).type === "text" && typeof (b as Row).text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** A typed prompt: a user row with a promptId that is not meta, not a tool result, and not a harness marker. */
export function isTypedPrompt(row: Row): boolean {
  if (row?.type !== "user" || typeof row.promptId !== "string" || !row.promptId) return false;
  if (row.isMeta === true || row.toolUseResult !== undefined) return false;
  const content = row.message?.content;
  if (Array.isArray(content) && content.some((b: Row) => b?.type === "tool_result")) return false;
  return !NON_PROMPT.test(promptText(content).trimStart());
}

export function classifyOrigin(row: Row, text: string, inSubagentFile: boolean): OriginResult {
  const t = text.trimStart();
  for (const [signal, re] of FIXTURES) if (re.test(t.slice(0, 400))) return { origin: "test", signal };

  if (HANDBACK.test(t)) return { origin: "task", signal: "text:subagent-hand-back" };
  if (TASK_NOTE.test(t)) return { origin: "task", signal: "text:task-notification" };
  if (row.origin?.kind === "task-notification" || row.turnOrigin === "task_notification") return { origin: "task", signal: "field:task-notification" };
  if (PEER.test(t)) return { origin: "peer", signal: "text:peer-message" };
  if (inSubagentFile || row.isSidechain === true) return { origin: "task", signal: "subagent-brief" };

  const entry = typeof row.entrypoint === "string" ? row.entrypoint : "";
  if (entry.startsWith("sdk")) return { origin: "headless", signal: `entrypoint:${entry}` };
  if (row.promptSource === "sdk" || row.turnOrigin === "sdk") return { origin: "headless", signal: "field:sdk" };
  if (row.origin?.kind === "human" || row.turnOrigin === "human") return { origin: "human", signal: "field:origin-human" };
  if (row.promptSource === "typed" || row.promptSource === "queued") return { origin: "human", signal: `promptSource:${row.promptSource}` };
  if (entry === "cli" || entry === "claude-desktop") return { origin: "human", signal: `entrypoint:${entry}` };
  return { origin: "headless", signal: "fallback:no-interactive-signal" };
}

const INTERRUPT = /^\[Request interrupted by user/;

/** The harness marker for the principal stopping a turn. A shutdown writes the same text with interruptedByShutdown, which is not a reaction. */
export function isUserInterrupt(row: Row): boolean {
  if (row?.type !== "user" || row.interruptedByShutdown === true || row.toolUseResult !== undefined) return false;
  return INTERRUPT.test(promptText(row.message?.content).trimStart());
}
