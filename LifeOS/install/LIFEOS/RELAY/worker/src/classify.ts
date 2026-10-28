// Which Linq webhook events the Tex Worker keeps, and which earn {{PRINCIPAL_NAME}} the offline notice (Relay ISA F28).
// No Cloudflare imports, so bun test can load it.

/** The events the bridge acts on. Everything else Linq sends is answered 200 and dropped. */
export const KEPT_EVENTS = new Set(["message.received", "reaction.added"]);
/** Relay F33 ISC-413: facts the bridge records, never acts on. Kept even though a delivery is about our own message. */
export const RECORDED_EVENTS = new Set(["message.delivered", "message.failed", "participant.added", "participant.removed"]);

export function classify(raw: string, principalHandles: string): { keep: false } | { keep: true; eventId: string; principal: boolean; chatId: string | null } {
	let e: any;
	try { e = JSON.parse(raw); } catch { return { keep: false }; }
	if (typeof e?.event_id !== "string") return { keep: false };
	const d = e.data ?? {};
	if (RECORDED_EVENTS.has(e.event_type)) return { keep: true, eventId: e.event_id, principal: false, chatId: d.chat?.id ?? d.chat_id ?? null };
	if (!KEPT_EVENTS.has(e.event_type)) return { keep: false };
	if (d.is_from_me || d.sender_handle?.is_me || d.from_handle?.is_me) return { keep: false };
	const sender: string | undefined = d.sender_handle?.handle ?? d.from_handle?.handle ?? d.from;
	const chatId: string | null = d.chat?.id ?? d.chat_id ?? null;
	const principals = principalHandles.split(",").map(s => s.trim()).filter(Boolean);
	// Only {{PRINCIPAL_NAME}}'s direct chat earns the offline notice; a group never hears from the Worker.
	const isGroup = !!(d.chat?.is_group ?? d.is_group);
	const principal = e.event_type === "message.received" && !isGroup && !!sender && principals.includes(sender);
	return { keep: true, eventId: e.event_id, principal, chatId };
}
