/**
 * tapback.ts — Tex tapbacks (Relay ISA F10). Pure decisions, no transport.
 *
 * A 👍 or 👎 on {{DA_NAME}}'s newest reply is a yes or a no to what that reply asked. Every other tapback, and any
 * tapback on an older message, is noted and nothing runs: a thumbs-up on last week's question must never
 * approve today's held action.
 */
import type { ConversationMessage } from "./conversation.ts";
import { getDAName } from "../../../hooks/lib/identity.ts";

export const YES_TAPBACK = "👍";
export const NO_TAPBACK = "👎";
/** {{DA_NAME}}'s own tapback for a thank-you or an "ok" that needs no answer. */
export const ACK_TAPBACK = "❤️";

const GUID = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i;
/** iMessage ids arrive bare, part-prefixed ("p:0/…") or part-suffixed; the message GUID is the identity. */
export function sameMessage(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ga = a.match(GUID)?.[0], gb = b.match(GUID)?.[0];
  return !!ga && !!gb && ga.toUpperCase() === gb.toUpperCase();
}

/** The newest thing {{DA_NAME}} said that the principal could be answering: a reply or a notification, never a status line. */
export function latestAnswerable(messages: ConversationMessage[]): ConversationMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.direction === "outbound" && (m.source === "reply" || m.source === "notification")) return m;
  }
  return undefined;
}

/** Did this message ask the principal something? A question mark near the end is the signal. */
export function asksQuestion(text: string): boolean {
  return /\?/.test(text.trim().slice(-160));
}

export type TapbackIntent =
  | { kind: "answer"; text: "yes" | "no"; replyTo: string }
  | { kind: "ignore"; why: "not-yes-no" | "stale" | "nothing-asked" };

/** Decide what a principal's tapback means. `confirmOpen` is whether the guard holds an action for a yes. */
export function tapbackIntent(emoji: string, targetId: string | undefined, latest: ConversationMessage | undefined, confirmOpen: boolean): TapbackIntent {
  if (emoji !== YES_TAPBACK && emoji !== NO_TAPBACK) return { kind: "ignore", why: "not-yes-no" };
  if (!latest || !sameMessage(targetId, latest.id)) return { kind: "ignore", why: "stale" };
  // A held guard action is answered only on {{DA_NAME}}'s reply (the confirm question is sent as one); a thumbs-up
  // on a notification that landed after it, such as a Vigil alert, must never approve the held action.
  if (confirmOpen && latest.source !== "reply") return { kind: "ignore", why: "nothing-asked" };
  // Relay ISA F16 (ISC-181): a reply that asked nothing answers nothing, hold or no hold. A 👍 on a refusal or a
  // status-like reply must never approve an older held action.
  if (!asksQuestion(latest.text)) return { kind: "ignore", why: "nothing-asked" };
  return { kind: "answer", text: emoji === YES_TAPBACK ? "yes" : "no", replyTo: latest.id };
}

// The DA name comes from identity config so "thanks, <name>" counts as a pure ack on every install.
const DA_NAME_RE = getDAName().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
const PURE_ACK = new RegExp(String.raw`^(?:thanks?(?: you| so much)?|thx|ty|ok(?:ay)?(?: cool| thanks?)?|cool|nice|great|perfect|awesome|got it|sounds good|love it|👍|🙏|❤️|🙌)(?:[\s,]+${DA_NAME_RE})?[\s!.]*$`, "i");
/** A text that thanks or acknowledges and asks for nothing. */
export function isPureAck(text: string): boolean {
  return PURE_ACK.test(text.trim());
}
