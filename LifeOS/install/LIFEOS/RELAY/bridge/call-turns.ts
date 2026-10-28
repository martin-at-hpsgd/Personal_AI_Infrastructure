/**
 * Calls into {{PRINCIPAL_NAME}}'s thread (Relay ISA F29).
 *
 * The Worker hands the bridge two kinds of call event over the inbox: `call.turn`, a request {{PRINCIPAL_NAME}} spoke after the
 * passphrase, and `call.ended`, the finished call's transcript. A turn becomes an ordinary handler message on his
 * direct thread, marked with the call service, so the request runs exactly like a text (full access, the guard, memory)
 * and its answer is sent back to the call instead of iMessage. A transcript is recorded on the same thread, so a later
 * text can refer to what was said on the phone.
 */
import { invariant } from "../../TOOLS/Invariant.ts";
import type { ConversationMessage } from "./conversation.ts";
import { CALL_SERVICE } from "./handler.ts";
import { threadIdFor, type LinqEvent, type Mapped } from "./linq.ts";

export const CALL_PREFIX = "[Spoken on a phone call with {{DA_NAME}}]";

export function callTurn(event: LinqEvent, principal: string): (Mapped & { callId: string }) | null {
  if (event.event_type !== "call.turn") return null;
  const callId = event.data?.call_id, text = event.data?.text;
  if (typeof callId !== "string" || typeof text !== "string" || !text.trim() || !principal) return null;
  const space = { id: threadIdFor("", false, principal, "iMessage"), type: "direct", chatId: "" };
  return {
    callId, space,
    message: { id: event.event_id, sender: { id: principal, service: CALL_SERVICE }, direction: "inbound", timestamp: new Date(), content: { type: "text", text: `${CALL_PREFIX} ${text.trim()}` } },
  };
}

export function callTranscript(event: LinqEvent, principal: string): { sender: string; thread: string; message: ConversationMessage } | null {
  if (event.event_type !== "call.ended") return null;
  const transcript = event.data?.transcript;
  if (typeof transcript !== "string" || !transcript.trim() || !principal) return null;
  const message: ConversationMessage = {
    id: event.event_id, timestamp: new Date().toISOString(), direction: "inbound", source: "principal",
    text: `[Phone call with {{DA_NAME}}, transcript]\n${transcript.trim()}`,
  };
  invariant(message.text.length > 0, "a call transcript record has text");
  return { sender: principal, thread: threadIdFor("", false, principal, "iMessage"), message };
}
