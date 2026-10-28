import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function sessionKey(sender: string, thread?: string): string {
  return thread ? `${sender}:${createHash("sha256").update(thread).digest("hex")}` : sender;
}

export function toolMap(root: string): string {
  const rows = [
    ["LIFEOS/TOOLS/gmail.ts", 'mail = bun ~/.claude/LIFEOS/TOOLS/gmail.ts list "<gmail query>" [max] / fetchfull <id> / threads "<q>" (put --account <name> right after gmail.ts for the other mailbox)'],
    ["LIFEOS/PEOPLE/People.ts", 'people = bun ~/.claude/LIFEOS/PEOPLE/People.ts who "<name or email>" / list --class personal / stats'],
    ["LIFEOS/USER/WORK/work_repo.json", "work = gh issue list/view in the work repo"],
  ];
  // Private rows (calendar, lifelog, smart home, …) live in the USER zone, never in shipped
  // code: LIFEOS/USER/RELAY/tool-map.json is [{ "path": "<repo-relative guard file>", "text": "<map line>" }]
  // (Fable in-family audit, 7.52.0 cut — the shipped array composed a private-life inventory).
  const userMap = join(root, "LIFEOS", "USER", "RELAY", "tool-map.json");
  if (existsSync(userMap)) {
    try {
      const extra = JSON.parse(readFileSync(userMap, "utf8")) as Array<{ path: string; text: string }>;
      for (const r of extra) if (typeof r?.path === "string" && typeof r?.text === "string") rows.push([r.path, r.text]);
    } catch { /* a malformed map adds nothing; the public rows still serve */ }
  }
  return rows.filter(([path]) => existsSync(join(root, path!))).map(([, text]) => text).join("; ");
}

/** How a text on the delivered-history path sees its history: said only by that path's soul (Tex ISA ISC-240). */
export const DELIVERED_HISTORY = "You receive delivered conversation history with each request, including proactive messages sent outside this model session. It is the conversation the principal sees on their phone.";

/** How a text reads its conversation, whichever history block it carries; the soul says what that block is (ISC-240). */
export const CONTINUITY_CONTRACT = `A short follow-up normally refers to the relevant preceding exchange; an explicit reply target takes precedence over recency. Identify the subject from the conversation before asking for clarification. If context supports multiple materially different subjects, ask one specific question naming them. Never invent an event, invitation, date, or completed action to fill a gap.
When two subjects are equally plausible and neither an explicit reply nor the wording selects one, the useful answer is one direct question naming those subjects, such as "Do you mean the workshop or the dinner?" Unrelated calendar entries do not resolve that ambiguity and do not belong in the answer.
For a start command such as "let's go" after a briefing, make useful progress on the most actionable item: deliver an outline or draft IN THE TEXT REPLY, or perform an available read. State your assumption briefly and produce that work. An outline in the reply completes this first step; do not create a file, offer to save it, or turn optional persistence into an authorization question. Do not ask the principal to choose merely because the briefing mentioned multiple topics. Ask only when the ambiguity prevents useful safe progress. Vague assent never authorizes an external commitment or lifts an authorization hold.
An available read needed to answer the question is already requested: perform the lookup and answer, without offering to search or asking whether to check. A factual lookup ends with the answer or the concrete limits of the sources checked, never an offer to run another available read. A question about an event is not a request to create or change it; do not add unsolicited proposals to mutate the calendar.
For current public information, native WebSearch is an available read. Use it directly; tool discovery is not a prerequisite for this built-in tool. A broad news request calls for a short sourced digest using reasonable defaults, not a question about which digest to fetch. Source-specific fetches, archives, and notifications are optional unless requested; do not make them prerequisites for answering. Respect any actual refusal and do not route around it.
A statement in previous conversation is not current source verification. Corrected dates and titles supersede older ones. When the answer is already in the conversation, answer it directly and attribute it to the message when appropriate. Requests to verify current status or invitation details require checking the relevant available sources; requests to recall what was said do not require a new calendar search.
The tool map is a set of verified shortcuts, not a capability limit. For any other task, discover and read the relevant installed SKILL.md and its dependencies using native Read/Glob/Grep, or invoke Skill when permitted. Use the installed skill's actual tool contract; do not infer that a missing named tool means the capability is unavailable. Authorization refusals remain binding, and a denied operation must never be routed through an alternate tool.
When the principal directly asks for an action other than a message to someone else, the request is the authorization: do it and report it done, never reply with a draft plus "Should I …?" about that same action. If a hold message says an action is held, follow that message exactly; a hold on a spelling (shell indirection) is fixed by rewriting the command plainly, not by asking. Never end a reply by offering further work nobody asked for.
Finish the authorized task and verify its result before reporting completion. If an operation fails, distinguish the observed failure from missing capability. Preserve partial completion, avoid repeating successful mutations, and name what remains. Never promise a later action unless a durable continuation actually exists.`;

/** A text session's appended system prompt. LifeOS memory is content, so it rides here every turn, after the
 *  soul so the prefix stays stable; the hook's memory telemetry never reaches a text (Tex ISA F17). */
export function textSystemPrompt(soul: string, toolContract: string, memory: string | null): string {
  const base = `${soul}\n${toolContract}`;
  return memory?.trim() ? `${base}\n\n## LifeOS memory\nWhat you know about the principal and your standing corrections. Use it; never quote or relay it as a status note.\n${memory.trim()}` : base;
}

export function parseAgentEnvelope(output: string, exitCode: number | null): { ok: boolean; text?: string; sessionId?: string; error?: string } {
  try {
    const j = JSON.parse(output);
    if (exitCode !== 0 || j.is_error || (j.subtype && j.subtype !== "success")) return { ok: false, error: typeof j.result === "string" ? j.result : "Agent execution failed" };
    if (typeof j.result !== "string" || !j.result.trim()) return { ok: false, error: "Agent returned no answer" };
    return { ok: true, text: j.result, sessionId: typeof j.session_id === "string" ? j.session_id : undefined };
  } catch { return { ok: false, error: "Agent returned an invalid result" }; }
}

/** A voluntary offer to do a lookup leaves the requested work unfinished.
 * Real guard holds are exempt: repairing those would route around policy. */
export function needsCompletionRepair(reply: string, held: boolean): boolean {
  return !held && /\b(?:want me to|would you like me to|shall i|should i|the (?:explicit )?reply target is|per (?:the )?24-hour rule)\b/i.test(reply);
}

/** The resumed-session request sent when a reply offered more work instead of finishing (needsCompletionRepair). The
 *  ask-first question before a message to someone else also reads "Should I …?", so the repair keeps it (ISC-239). */
export function completionRepairPrompt(prompt: string): string {
  return `Complete the original request: ${prompt}\n\nYour draft offered further action instead of ending with the requested answer. That draft has NOT been sent. Deliver the answer, or complete an available read required by the original request. If the answer was already in the conversation, state it with attribution. Do not offer or perform unrequested mutations. Do not repeat completed actions. Respect every tool refusal. If your draft asked for their yes before a message to anyone other than the principal, that question is required: reply with it unchanged. If a material ambiguity remains, ask the specific missing fact rather than offering to do a lookup. Reply with only the final text.`;
}
