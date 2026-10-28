/** Read-only bridge to the installed provider's underlying Apple-message API.
 * Spectrum 8 drops replyTargetGuid while normalizing inbound text. Reuse its
 * existing authenticated client; never create a second stream or fetch other chats.
 */
import type { ConversationStore } from "./conversation.ts";

interface AppleMessage {
  guid: string; chatGuids: readonly string[]; content: { text?: string };
  dateCreated: Date; dateRetracted?: Date; dateEdited?: Date;
  isFromMe: boolean; isSent: boolean; isDelivered: boolean;
  sender?: { address?: string }; replyTargetGuid?: string; threadOriginatorGuid?: string;
}
interface AppleClient {
  messages: {
    get(id: string): Promise<AppleMessage>;
    listInChat(thread: string, options: { pageSize: number; before?: Date }): Promise<{ messages: readonly AppleMessage[] }>;
  };
}
export function providerClient(app: any, phone: string): AppleClient {
  const entries = app.__internal?.platforms?.get("iMessage")?.client;
  if (!Array.isArray(entries)) throw new Error("iMessage remote client unavailable");
  const entry = entries.find(e => e.phone === phone);
  if (!entry?.client?.messages?.get || !entry.client.messages.listInChat) throw new Error("iMessage history contract unavailable");
  return entry.client;
}
export async function hydrateConversation(
  client: AppleClient, store: ConversationStore, sender: string, thread: string,
  currentId: string, safeHistoryText: (text: string) => boolean,
): Promise<{ replyTo?: string; count: number }> {
  const current = await client.messages.get(currentId);
  if (!current.chatGuids.includes(thread) || current.isFromMe || current.sender?.address !== sender) throw new Error("Message scope mismatch");
  const targetId = current.replyTargetGuid || current.threadOriginatorGuid;
  const page = await client.messages.listInChat(thread, { pageSize: 60, before: new Date(current.dateCreated.getTime() + 1) });
  const rows = [...page.messages];
  if (targetId && !rows.some(m => m.guid === targetId)) {
    try { rows.push(await client.messages.get(targetId)); }
    catch { /* The known explicit target remains marked unavailable in context. */ }
  }
  let count = 0;
  for (const m of rows) {
    const body = m.content.text;
    if (m.guid === currentId || !m.chatGuids.includes(thread)) continue;
    if (m.isFromMe ? !(m.isSent || m.isDelivered) : m.sender?.address !== sender) continue;
    if (m.dateRetracted) { store.retract(sender, thread, m.guid); continue; }
    if (!body?.trim() || !safeHistoryText(body)) {
      if (m.dateEdited) store.retract(sender, thread, m.guid, "[Updated message omitted from context]");
      continue;
    }
    store.record(sender, thread, {
      id: m.guid, timestamp: m.dateCreated.toISOString(), text: body,
      direction: m.isFromMe ? "outbound" : "inbound", source: m.isFromMe ? "notification" : "principal",
      replyTo: m.replyTargetGuid || m.threadOriginatorGuid,
      editedAt: m.dateEdited?.toISOString(),
    });
    count++;
  }
  store.prune(sender, thread);
  return { replyTo: targetId, count };
}
