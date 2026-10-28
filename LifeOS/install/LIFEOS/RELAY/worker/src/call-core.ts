// One phone call with {{DA_NAME}} (Relay ISA F29), without Cloudflare: the Call Durable Object wires it to Twilio's
// ConversationRelay socket, the model, the passphrase check and the inbox. Twilio hears the caller; {{DA_NAME}} speaks through
// Twilio's voice, or in Fish as audio links when CALL_VOICE names a Fish voice (ISC-396).
//
// Nothing reaches the model, and nothing reaches the Mac, until the caller has spoken the passphrase (ISC-390).
// After that a fast model holds the conversation and hands any real request to the Mac as a turn in {{PRINCIPAL_NAME}}'s
// thread (ISC-391); the Mac's answer is spoken when it comes back. The passphrase itself is never stored.
import type { LlmMessage, LlmStream, LlmTool } from "./anthropic";
import { sentences } from "./voice";
import { NEUTRAL_NAMES, type Names } from "./names";

export const greeting = (n: Names): string => `Hey, it's ${n.da}. What's the passphrase?`;
export const AUTH_OK = "Got it. What do you need?";
export const AUTH_RETRY = "That's not it. Try once more.";
export const AUTH_FAIL = "Sorry, I can't let you in. Goodbye.";
export const MAX_PASS_TRIES = 3;
/** Silence after a non-matching piece before {{DA_NAME}} says it was wrong. */
export const PASS_PAUSE_MS = 2_000;
export const PASSPHRASE_PLACEHOLDER = "[passphrase attempt]";

export const talkerSystem = (n: Names): string => `You are ${n.da}, ${n.principal}'s AI assistant, on a live phone call with him. He already passed the passphrase check.
Speak like a friend on the phone: short, plain sentences, one or two at a time. No lists, no markdown, no emoji, no URLs.
You cannot see his mail, calendar, files or systems yourself, and you never guess at them. Anything that needs his LifeOS (reading or sending mail or texts, calendar, files, research, running a skill, building or changing anything, checking on work) goes to the do_work tool with his request in his own words, plus any detail from earlier in the call that it needs. Then say in a few words that you're on it. The answer comes back on its own and is read to him; never invent it.
Answer small talk and quick general-knowledge questions yourself.
When he says yes or no to something the Mac asked, pass his answer to do_work exactly as he said it.`;

export const tools = (n: Names): LlmTool[] => [{
	name: "do_work",
	description: `Hand a request to ${n.da} on ${n.principal}'s Mac, with his full LifeOS, tools and memory. Its answer is spoken on the call when it arrives, or texted if the call has ended.`,
	input_schema: { type: "object", properties: { request: { type: "string", description: `What ${n.principal} wants, in his words, with any needed context from the call.` } }, required: ["request"] },
}];

/** Consecutive turns from the same side merged into one, as the Messages API expects. */
export function collapse(messages: LlmMessage[]): LlmMessage[] {
	const out: LlmMessage[] = [];
	const blocks = (c: LlmMessage["content"]) => typeof c === "string" ? [{ type: "text" as const, text: c }] : c;
	for (const m of messages) {
		const prev = out[out.length - 1];
		if (prev && prev.role === m.role) {
			// The API wants a user turn's tool results before any other content.
			const merged = [...blocks(prev.content), ...blocks(m.content)];
			out[out.length - 1] = { role: m.role, content: [...merged.filter(b => b.type === "tool_result"), ...merged.filter(b => b.type !== "tool_result")] };
		}
		else out.push(m);
	}
	return out;
}

export type Handoff =(request: string) => Promise<"queued" | "offline">;

export interface CallDeps {
	/** One ConversationRelay frame to Twilio. */
	send: (frame: Record<string, unknown>) => void;
	llm: LlmStream;
	passphraseOk: (spoken: string) => Promise<boolean>;
	/** Shape of each passphrase attempt (counts only, never the words), for diagnosing speech-to-text. */
	diag?: (event: string, data: Record<string, unknown>) => void;
	/** Test seam for the wait before "that's not it". */
	setTimer?: (fn: () => void, ms: number) => () => void;
	handoff: Handoff;
	now?: () => number;
	/** Who is speaking, for the model's prompt and the transcript; absent means the plain wording in names.ts. */
	names?: Names;
	/** ISC-396: when set, {{DA_NAME}} speaks in Fish: each sentence becomes this audio link and goes out as a play frame. */
	playUrl?: (line: string) => Promise<string>;
}

/** `who` is the speaker's name as the Worker was told it (the principal's or the assistant's). */
export interface TranscriptLine { at: string; who: string; text: string }

/** One streamed chunk made speakable without touching its spacing: Twilio joins chunks as given, so the spaces
 *  between words must survive. */
export function speakableChunk(text: string): string {
	return text.replace(/\*\*|__|`/g, "").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, "");
}

/** What a speaker can say: no markdown, no emoji, URLs named rather than read. */
export function speakable(text: string): string {
	return text
		.replace(/\*\*|__|`/g, "")
		.replace(/https?:\/\/\S+/g, "a link, which is in your texts")
		.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, "")
		.replace(/[ \t]+/g, " ")
		.trim();
}

export class CallSession {
	authed = false;
	ended = false;
	private tries = 0;
	/** The last words {{PRINCIPAL_NAME}} said before getting in, across misses: speech-to-text cuts a phrase at pauses, and a late
	 *  second half must still join its first, so pieces are always checked together and nothing is cleared on a miss. */
	private passWords: string[] = [];
	/** Twilio has a partial piece in flight: {{PRINCIPAL_NAME}} is mid-sentence, so no miss is called yet. */
	private hearing = false;
	/** Pauses waited out on a partial that never got its final; after three the miss is called anyway. */
	private heardWaits = 0;
	private missTimer?: () => void;
	/** Written only inside the serialized utterance chain, so no two writers can interleave. */
	private messages: LlmMessage[] = [];
	/** The Mac's answers, already spoken, waiting to join the history at the start of the next turn. */
	private notes: string[] = [];
	private gen?: AbortController;
	private chain: Promise<void> = Promise.resolve();
	readonly transcript: TranscriptLine[] = [];

	constructor(private readonly d: CallDeps) {}

	private stamp(): string { return new Date((this.d.now ?? Date.now)()).toISOString(); }
	private get names(): Names { return this.d.names ?? NEUTRAL_NAMES; }
	private log(who: "da" | "principal", text: string): void { if (text.trim()) this.transcript.push({ at: this.stamp(), who: this.names[who], text: text.trim() }); }

	/** True while a streamed reply is going out; a whole line said meanwhile waits for it to finish. */
	private streaming = false;
	private queued: string[] = [];

	/** Fish mode: play frames leave in order through one chain; an interrupt bumps the epoch so unsent lines are dropped. */
	private out: Promise<void> = Promise.resolve();
	private epoch = 0;
	/** Fish mode: streamed text not yet ending in a full sentence. */
	private pending = "";

	private play(line: string): void {
		const epoch = this.epoch;
		for (const s of sentences(line)) {
			this.out = this.out.then(async () => {
				if (this.ended || epoch !== this.epoch) return;
				const source = await this.d.playUrl!(s);
				if (!this.ended && epoch === this.epoch) this.d.send({ type: "play", source, interruptible: true, preemptible: false });
			}).catch(() => {});
		}
	}

	/** Resolves once every line handed out so far has gone to Twilio (tests await it). */
	flushed(): Promise<void> { return this.out; }

	/** One streamed chunk out: as a text token, or in Fish mode held until it completes a sentence. */
	private stream(t: string): void {
		this.streaming = true;
		if (!this.d.playUrl) { this.d.send({ type: "text", token: t, last: false }); return; }
		this.pending += t;
		const m = this.pending.match(/^([\s\S]*[.!?])\s+([\s\S]*)$/);
		if (m) { this.play(m[1]!); this.pending = m[2]!; }
	}

	/** Speak a whole line: now, or right after the reply being streamed, never inside it. */
	say(text: string): void {
		const t = speakable(text);
		if (!t || this.ended) return;
		if (this.streaming) { this.queued.push(t); return; }
		this.log("da", t);
		if (this.d.playUrl) this.play(t);
		else this.d.send({ type: "text", token: t, last: true });
	}

	/** Close the streamed reply (its talk cycle ends) and say whatever waited for it. */
	private endStream(): void {
		if (!this.streaming) return;
		this.streaming = false;
		if (this.d.playUrl) { const rest = this.pending.trim(); this.pending = ""; if (rest && !this.ended) this.play(rest); }
		else if (!this.ended) this.d.send({ type: "text", token: "", last: true });
		for (const line of this.queued.splice(0)) this.say(line);
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.gen?.abort();
		this.missTimer?.();
		this.queued = [];
		this.streaming = false;
		this.d.send({ type: "end" });
	}

	/** One frame from ConversationRelay. Resolves when the work it started is done (tests await it). */
	async onFrame(raw: string): Promise<void> {
		let m: any;
		try { m = JSON.parse(raw); } catch { return; }
		// {{PRINCIPAL_NAME}} still talking (a partial piece, or speaking over {{DA_NAME}}) restarts the pause before a passphrase miss.
		if (m.type === "prompt") { this.hearing = m.last === false; this.heardWaits = 0; }
		if ((m.type === "interrupt" || (m.type === "prompt" && m.last === false)) && this.missTimer) this.armMiss();
		if (m.type === "interrupt") { this.gen?.abort(); this.epoch++; this.pending = ""; return; }
		if (m.type !== "prompt" || m.last === false || this.ended) return;
		const text = String(m.voicePrompt ?? "").trim();
		if (!text) return;
		// One failed turn never blocks the next: each link starts from a settled chain and catches its own error.
		this.chain = this.chain.catch(() => {}).then(() => this.onUtterance(text)).catch(() => {
			this.say("Sorry, something broke on my side. Say that again?");
		});
		await this.chain;
	}

	private async onUtterance(text: string): Promise<void> {
		if (this.ended) return;
		if (!this.authed) {
			this.log("principal", PASSPHRASE_PLACEHOLDER);
			this.missTimer?.();
			this.missTimer = undefined;
			this.passWords = [...this.passWords, ...text.split(/\s+/).filter(Boolean)].slice(-24);
			const joined = this.passWords.join(" ");
			const ok = await this.d.passphraseOk(joined).catch(() => false);
			this.d.diag?.("passphrase_piece", { pieceWords: text.split(/\s+/).filter(Boolean).length, heldWords: this.passWords.length, chars: joined.replace(/[^a-z0-9]/gi, "").length, digits: (joined.match(/\d/g) ?? []).length, ok });
			if (ok) { this.authed = true; this.passWords = []; this.say(AUTH_OK); return; }
			// A miss is called only after a pause, so the rest of a phrase that was cut mid-way can still arrive.
			this.armMiss();
			return;
		}
		this.log("principal", text);
		const notes = this.notes.splice(0).map(n => `[The Mac's answer, already read to ${this.names.principal}:] ${n}`);
		this.messages.push({ role: "user", content: [...notes, text].join("\n") });
		await this.runTurn();
	}

	/** (Re)start the pause after which a non-matching passphrase counts as a miss. */
	private armMiss(): void {
		this.missTimer?.();
		this.missTimer = (this.d.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); }))(() => this.miss(), PASS_PAUSE_MS);
	}

	private miss(): void {
		this.missTimer = undefined;
		if (this.authed || this.ended) return;
		if (this.hearing && this.heardWaits++ < 3) { this.armMiss(); return; }
		this.tries++;
		if (this.tries >= MAX_PASS_TRIES) { this.say(AUTH_FAIL); this.end(); }
		else this.say(AUTH_RETRY);
	}

	/** The Mac's answer to a handed-off request, spoken if the call is live. The Worker texts every answer as well,
	 *  so none depends on whether {{PRINCIPAL_NAME}} heard it before hanging up. */
	deliver(text: string): boolean {
		if (this.ended) return false;
		this.say(text);
		// Spoken now; it joins the history when the next turn starts, never in the middle of one.
		this.notes.push(speakable(text));
		return true;
	}

	/**
	 * One talker turn. A turn ends cancelled when {{PRINCIPAL_NAME}} talks over it or the call ends; the rule for history is that a
	 * cancelled turn keeps only the words already spoken, never a tool call, so every tool_use in history has its
	 * tool_result and the next request to the model stays valid. Cancellation is checked before every hand-off.
	 */
	private async runTurn(): Promise<void> {
		const ctl = new AbortController();
		this.gen = ctl;
		const cancelled = () => ctl.signal.aborted || this.ended;
		for (let round = 0; round < 3 && !cancelled(); round++) {
			let spoken = "";
			const calls: { id: string; name: string; input: Record<string, unknown> }[] = [];
			let failed = false;
			try {
				for await (const ev of this.d.llm({ system: talkerSystem(this.names), messages: collapse(this.messages), tools: tools(this.names), signal: ctl.signal })) {
					if (cancelled()) break;
					if (ev.type === "text") { const t = speakableChunk(ev.text); if (t) { spoken += t; this.stream(t); } }
					else if (ev.type === "tool_use") calls.push(ev);
				}
			} catch {
				failed = true;
			} finally {
				if (spoken && !this.ended) this.log("da", speakable(spoken));
				this.endStream();
			}
			if (failed) {
				if (!cancelled()) this.say("Sorry, I lost my train of thought. Say that again?");
				if (spoken) this.messages.push({ role: "assistant", content: spoken });
				return;
			}
			if (cancelled()) { if (spoken) this.messages.push({ role: "assistant", content: spoken }); return; }
			this.messages.push({ role: "assistant", content: [...(spoken ? [{ type: "text" as const, text: spoken }] : []), ...calls.map(c => ({ type: "tool_use" as const, ...c }))] });
			if (calls.length === 0) return;
			const results = [];
			const p = this.names.principal;
			for (const c of calls) {
				const request = typeof c.input.request === "string" ? c.input.request.trim() : "";
				const outcome = cancelled() ? "cancelled" : c.name === "do_work" && request ? await this.d.handoff(request).catch(() => "failed" as const) : undefined;
				results.push({
					type: "tool_result" as const, tool_use_id: c.id,
					content: outcome === "queued" ? `Handed to the Mac. Its answer will be read to ${p} when it arrives; tell him in a few words you're on it.`
						: outcome === "offline" ? `The Mac is offline. The request is queued and its answer will be texted to ${p}. Tell him that in one sentence.`
						: outcome === "cancelled" ? `Not sent: ${p} spoke over this or the call ended.`
						: outcome === "failed" ? `It did not go through: the inbox could not be reached. Tell ${p} in one sentence and offer to try again.`
						: `That tool call was not understood; ask ${p} to say it again.`,
				});
			}
			this.messages.push({ role: "user", content: results });
		}
	}

	transcriptText(): string {
		return this.transcript.map(l => `${l.at.slice(11, 16)} ${l.who}: ${l.text}`).join("\n");
	}
}
