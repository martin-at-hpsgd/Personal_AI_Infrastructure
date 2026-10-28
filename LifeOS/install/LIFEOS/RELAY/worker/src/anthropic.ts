// The call talker's model stream (Relay ISA F29): Anthropic Messages, streamed, parsed into text and tool_use events.
// Ported from LIFEOS/PULSE/modules/gptlive.ts parseAnthropicStream, which runs the outbound booking calls.

export type LlmBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_result"; tool_use_id: string; content: string };
export interface LlmMessage { role: "user" | "assistant"; content: string | LlmBlock[] }
export interface LlmTool { name: string; description: string; input_schema: Record<string, unknown> }
export type LlmEvent =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "stop"; reason: string };
export type LlmStream = (req: { system: string; messages: LlmMessage[]; tools: LlmTool[]; signal: AbortSignal }) => AsyncIterable<LlmEvent>;

export async function* parseAnthropicStream(body: ReadableStream<Uint8Array>): AsyncGenerator<LlmEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const tools = new Map<number, { id: string; name: string; json: string }>();
	let buf = "";
	let reason = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let cut: number;
		while ((cut = buf.indexOf("\n\n")) >= 0) {
			const frame = buf.slice(0, cut);
			buf = buf.slice(cut + 2);
			const data = frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("");
			if (!data) continue;
			let ev: any;
			try { ev = JSON.parse(data); } catch { continue; }
			if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") tools.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: "" });
			else if (ev.type === "content_block_delta") {
				if (ev.delta?.type === "text_delta" && ev.delta.text) yield { type: "text", text: ev.delta.text };
				else if (ev.delta?.type === "input_json_delta") { const t = tools.get(ev.index); if (t) t.json += ev.delta.partial_json ?? ""; }
			} else if (ev.type === "content_block_stop") {
				const t = tools.get(ev.index);
				if (!t) continue;
				tools.delete(ev.index);
				let input: Record<string, unknown> = {};
				try { input = t.json ? JSON.parse(t.json) : {}; } catch { input = {}; }
				yield { type: "tool_use", id: t.id, name: t.name, input };
			} else if (ev.type === "message_delta") reason = ev.delta?.stop_reason ?? reason;
			else if (ev.type === "error") throw new Error(`anthropic stream error: ${ev.error?.type ?? "unknown"}`);
		}
	}
	yield { type: "stop", reason };
}

export function anthropicStream(apiKey: string, model: string, maxTokens = 300): LlmStream {
	return async function* ({ system, messages, tools, signal }) {
		const res = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			signal,
			headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
			body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, system, messages, ...(tools.length ? { tools } : {}) }),
		});
		if (!res.ok || !res.body) throw new Error(`anthropic ${res.status}`);
		yield* parseAnthropicStream(res.body);
	};
}
