// lifeos-tex: the always-on front door for Tex. Linq webhooks land here, are verified, and wait in one Durable Object
// inbox until the Mac's bridge takes them over a WebSocket (Relay ISA F28). The Worker never runs a model on a text and
// never decides who may drive tools; admission stays in the bridge.
// Calls (F29): Twilio rings /voice/incoming; an allowlisted caller is connected to a Call Durable Object whose talker
// runs only after the spoken passphrase, and hands real work to the Mac through the same inbox.
// Deployed only through CfEnv.ts (P6).
import { DurableObject } from "cloudflare:workers";
import { InboxCore, type HeldEvent, type InboxStore } from "./inbox-core";
import { safeEqual, verifyStandardWebhook } from "./sig";
import { classify } from "./classify";
import { anthropicStream } from "./anthropic";
import { CallSession, greeting } from "./call-core";
import { namesFrom } from "./names";
import { admitCall, callPronunciations, callToken, callTokenOk, connectTwiml, fishSayBody, parseCallVoice, passphraseMatches, refuseTwiml, sayText, sayUrl, splitPassphraseCheck } from "./voice";
import { verifyTwilio } from "./sig";

export interface Env {
	INBOX: DurableObjectNamespace<Inbox>;
	LINQ_WEBHOOK_SECRET: string;
	LINQ_API_KEY: string;
	BRIDGE_TOKEN: string;
	/** {{PRINCIPAL_NAME}}'s number(s), comma-separated E.164: used only to decide who gets the offline notice. */
	PRINCIPAL_HANDLES: string;
	CALL: DurableObjectNamespace<Call>;
	TWILIO_AUTH_TOKEN: string;
	/** The talker's model key and id (set from .env and models.ts by deploy.ts). */
	ANTHROPIC_API_KEY: string;
	TALKER_MODEL: string;
	/** The text countersign's hash as "<salt>:<sha256 hex>" (salt empty on pre-3.1 configs); the spoken passphrase
	 *  is checked against it. */
	PASSPHRASE_CHECK: string;
	/** The call voice: "Fish:<reference id>:<speed>" ({{DA_NAME}}'s own voice, ISC-396), or a ConversationRelay "provider:voice". */
	CALL_VOICE: string;
	/** Fish Audio key and model, for the call voice. */
	FISH_API_KEY: string;
	FISH_MODEL: string;
	/** USER/PRINCIPAL/PRONUNCIATIONS.json, pushed by deploy.ts; absent means no rules. */
	PRONUNCIATIONS?: string;
	/** The assistant's name and the principal's first name, pushed by deploy.ts from the install's identity; absent means plain wording (names.ts). */
	DA_NAME?: string;
	PRINCIPAL_NAME?: string;
}

const LINQ_API = "https://api.linqapp.com/api/partner/v3";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const inbox = () => env.INBOX.get(env.INBOX.idFromName("main"));
		if (url.pathname === "/linq/webhook" && request.method === "POST") {
			const raw = await request.text();
			if (!(await verifyStandardWebhook(env.LINQ_WEBHOOK_SECRET, request.headers, raw))) { await audit(env, "linq_webhook_rejected"); return new Response("bad signature", { status: 401 }); }
			const c = classify(raw, env.PRINCIPAL_HANDLES ?? "");
			if (!c.keep) return new Response("ignored", { status: 200 });
			const fresh = await inbox().enqueue({ eventId: c.eventId, body: raw, principal: c.principal, chatId: c.chatId });
			return new Response(fresh ? "held" : "duplicate", { status: 200 });
		}
		if (url.pathname === "/bridge") {
			const auth = request.headers.get("Authorization") ?? "";
			if (!env.BRIDGE_TOKEN || !safeEqual(auth, `Bearer ${env.BRIDGE_TOKEN}`)) { await audit(env, "bridge_auth_rejected"); return new Response("unauthorized", { status: 401 }); }
			if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
			return inbox().fetch(request);
		}
		if (url.pathname === "/voice/incoming" && request.method === "POST") {
			const params = Object.fromEntries([...(await request.formData()).entries()].map(([k, v]) => [k, String(v)]));
			if (!(await verifyTwilio(env.TWILIO_AUTH_TOKEN, request.url, params, request.headers.get("X-Twilio-Signature")))) { await audit(env, "twilio_signature_rejected"); return new Response("forbidden", { status: 403 }); }
			const twiml = (body: string) => new Response(body, { headers: { "Content-Type": "text/xml" } });
			const admitted = admitCall(params, env.PRINCIPAL_HANDLES ?? "");
			await audit(env, "call_incoming", { call: params.CallSid ?? "", from: params.From ?? "", allow: admitted.allow, ...(admitted.allow ? { stir: admitted.stir } : { reason: admitted.reason }) });
			if (!admitted.allow) return twiml(refuseTwiml());
			const cv = parseCallVoice(env.CALL_VOICE);
			const relayUrl = `wss://${url.host}/voice/relay?call=${encodeURIComponent(params.CallSid ?? "")}`;
			const token = await callToken(env.BRIDGE_TOKEN, params.CallSid ?? "");
			// In Fish mode Twilio's own voice never speaks {{DA_NAME}}'s words; it stays named because the TwiML requires one.
			return twiml(cv.kind === "fish"
				? connectTwiml({ relayUrl, token, ttsProvider: "Google", voice: "en-US-Journey-D" })
				: connectTwiml({ relayUrl, token, greeting: greeting(namesFrom(env)), ttsProvider: cv.provider, voice: cv.voice }));
		}
		// ISC-396: one signed line rendered in {{DA_NAME}}'s Fish voice, for ConversationRelay to play.
		if (url.pathname === "/voice/say" && (request.method === "GET" || request.method === "HEAD")) {
			const text = await sayText(env.BRIDGE_TOKEN, url.searchParams);
			const cv = parseCallVoice(env.CALL_VOICE);
			if (text === null || cv.kind !== "fish") { await audit(env, "say_rejected"); return new Response("forbidden", { status: 403 }); }
			const res = await fetch("https://api.fish.audio/v1/tts", {
				method: "POST",
				headers: { Authorization: `Bearer ${env.FISH_API_KEY}`, "Content-Type": "application/json", model: env.FISH_MODEL || "drama-3" },
				body: JSON.stringify(fishSayBody(text, cv, callPronunciations(env.PRONUNCIATIONS))),
			});
			if (!res.ok || !res.body) {
				await audit(env, "fish_tts_failed", { status: res.status });
				return new Response("voice unavailable", { status: 502 });
			}
			return new Response(request.method === "HEAD" ? null : res.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
		}
		if (url.pathname === "/voice/relay") {
			const call = url.searchParams.get("call") ?? "";
			if (!/^CA[0-9a-f]{32}$/i.test(call) || request.headers.get("Upgrade") !== "websocket") { await audit(env, "call_relay_rejected"); return new Response("bad request", { status: 400 }); }
			return env.CALL.get(env.CALL.idFromName(call)).fetch(request);
		}
		if (url.pathname === "/health") return Response.json({ ok: true, ...(await inbox().status()) });
		return new Response("not found", { status: 404 });
	},
};

export class Inbox extends DurableObject<Env> {
	private readonly core: InboxCore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		sql.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, body TEXT NOT NULL, principal INTEGER NOT NULL, chat_id TEXT, received_at INTEGER NOT NULL, noticed INTEGER NOT NULL DEFAULT 0)");
		sql.exec("CREATE TABLE IF NOT EXISTS seen (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
		sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
		sql.exec("CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL)");
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		const store: InboxStore = {
			seen: id => sql.exec("SELECT 1 FROM seen WHERE event_id = ?", id).toArray().length > 0,
			markSeen: (id, at) => { sql.exec("INSERT INTO seen (event_id, at) VALUES (?, ?) ON CONFLICT(event_id) DO UPDATE SET at = excluded.at", id, at); },
			put: e => { sql.exec("INSERT OR IGNORE INTO events (event_id, body, principal, chat_id, received_at) VALUES (?, ?, ?, ?, ?)", e.eventId, e.body, e.principal ? 1 : 0, e.chatId, e.receivedAt); },
			remove: id => { sql.exec("DELETE FROM events WHERE event_id = ?", id); },
			pending: () => sql.exec("SELECT event_id, body, principal, chat_id, received_at, noticed FROM events ORDER BY seq").toArray()
				.map((r: any): HeldEvent => ({ eventId: r.event_id, body: r.body, principal: r.principal === 1, chatId: r.chat_id, receivedAt: r.received_at, noticed: r.noticed === 1 })),
			markNoticed: ids => { for (const id of ids) sql.exec("UPDATE events SET noticed = 1 WHERE event_id = ?", id); },
			meta: k => (sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0] as any)?.v,
			setMeta: (k, v) => { sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v); },
			outboxPut: (text, at) => { sql.exec("INSERT INTO outbox (text, next_at) VALUES (?, ?)", text, at); },
			outboxDue: now => sql.exec("SELECT id, text, attempts FROM outbox WHERE next_at <= ? ORDER BY id", now).toArray() as any,
			outboxDone: id => { sql.exec("DELETE FROM outbox WHERE id = ?", id); },
			outboxRetry: (id, nextAt) => { sql.exec("UPDATE outbox SET attempts = attempts + 1, next_at = ? WHERE id = ?", nextAt, id); },
			outboxNext: () => (sql.exec("SELECT MIN(next_at) AS n FROM outbox").toArray()[0] as any)?.n ?? undefined,
			pruneSeen: before => { sql.exec("DELETE FROM seen WHERE at < ? AND event_id NOT IN (SELECT event_id FROM events)", before); },
		};
		this.core = new InboxCore({
			store,
			daName: namesFrom(env).da,
			textPrincipal: async (text, key) => {
				try { await textPrincipal(env, text, key); } catch (e) { this.auditEvent("text_to_principal_failed", { key, text, error: String(e).slice(0, 120) }); throw e; }
				this.auditEvent("text_to_principal", { key, text });
			},
			sockets: () => ctx.getWebSockets("bridge"),
			setAlarm: at => { void ctx.storage.getAlarm().then(cur => { if (cur === null || cur > at) return ctx.storage.setAlarm(at); }); },
			notify: async (chatId, text) => {
				const res = await fetch(`${LINQ_API}/chats/${chatId}/messages`, {
					method: "POST",
					headers: { Authorization: `Bearer ${env.LINQ_API_KEY}`, "Content-Type": "application/json" },
					body: JSON.stringify({ message: { parts: [{ type: "text", value: text }] } }),
				});
				if (!res.ok) {
					this.auditEvent("offline_notice_failed", { chatId, status: res.status, text });
					throw new Error(`offline notice ${res.status}`);
				}
				this.auditEvent("offline_notice", { chatId, text });
			},
		});
	}

	enqueue(e: Omit<HeldEvent, "receivedAt">): boolean { return this.core.enqueue(e); }

	/** Relay F33 ISC-412: a fact only the Worker saw, held for the bridge like any text so it reaches the STATVS record
	 *  even while the Mac is offline. Rejections are capped at REJECT_CAP a minute so a flood cannot fill the record;
	 *  the one that reaches the cap says so, and the rest stay in the Worker log. */
	auditEvent(event: string, data: Record<string, unknown> = {}): void {
		console.log(JSON.stringify({ event, ...data }));
		let fields = data;
		if (/_rejected$/.test(event)) {
			const sql = this.ctx.storage.sql;
			const k = `audit_rejects_${Math.floor(Date.now() / 60_000)}`;
			const n = (((sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0] as any)?.v as number | undefined) ?? 0) + 1;
			sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, n);
			if (n === 1) sql.exec("DELETE FROM meta WHERE k LIKE 'audit_rejects_%' AND k <> ?", k);
			if (n > REJECT_CAP) return;
			if (n === REJECT_CAP) fields = { ...data, capped: true };
		}
		const eventId = crypto.randomUUID();
		this.core.enqueue({ eventId, body: JSON.stringify({ event_id: eventId, event_type: "tex.audit", created_at: new Date().toISOString(), data: { ...fields, event } }), principal: false, chatId: null });
	}

	/** F29: a request spoken on a call, or a finished call's transcript, for the bridge. Held like any text. */
	callEvent(type: "call.turn" | "call.ended", data: Record<string, unknown>): "queued" | "offline" {
		const eventId = crypto.randomUUID();
		this.core.enqueue({ eventId, body: JSON.stringify({ event_id: eventId, event_type: type, data }), principal: false, chatId: null });
		return this.core.status().bridge ? "queued" : "offline";
	}
	status(): { bridge: boolean; held: number } { return this.core.status(); }

	async fetch(_request: Request): Promise<Response> {
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		const existing = this.ctx.getWebSockets("bridge");
		this.ctx.acceptWebSocket(server, ["bridge"]);
		this.core.attach(server, existing);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== "string") return;
		let f: any;
		try { f = JSON.parse(message); } catch { return; }
		if (f?.type === "ack" && typeof f.event_id === "string") this.core.ack(f.event_id);
		// F29: the Mac's answer to a spoken request is read on the call when it is live, and always texted to {{PRINCIPAL_NAME}}, so
		// no answer depends on whether he heard it before hanging up.
		if (f?.type === "call_result" && typeof f.call_id === "string" && typeof f.text === "string" && f.text.trim()) {
			await this.env.CALL.get(this.env.CALL.idFromName(f.call_id)).deliver(f.text).catch(() => false);
			await this.core.queueText(`📞 ${f.text}`);
		}
	}

	async webSocketClose(): Promise<void> { this.core.detached(); }
	async webSocketError(): Promise<void> { this.core.detached(); }
	async alarm(): Promise<void> { await this.core.alarm(); }
}

/** Relay F33 ISC-412: rejections recorded per minute before the rest go to the Worker log only. */
export const REJECT_CAP = 30;

/** Relay F33 ISC-412: log a fact the Worker saw and hand it to the inbox for the STATVS record. Never throws. */
async function audit(env: Env, event: string, data: Record<string, unknown> = {}): Promise<void> {
	try { await env.INBOX.get(env.INBOX.idFromName("main")).auditEvent(event, data); }
	catch (e) { console.log(JSON.stringify({ event, ...data, audit_lost: String(e).slice(0, 120) })); }
}

async function textPrincipal(env: Env, text: string, idempotencyKey?: string): Promise<void> {
	const to = (env.PRINCIPAL_HANDLES ?? "").split(",")[0]?.trim();
	if (!to) throw new Error("no principal handle configured");
	const res = await fetch(`${LINQ_API}/messages`, {
		method: "POST",
		headers: { Authorization: `Bearer ${env.LINQ_API_KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify({ to: [to], message: { parts: [{ type: "text", value: text }], ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) } }),
	});
	// The Inbox's textPrincipal wrapper records the failure, with this status in its error, as text_to_principal_failed.
	if (!res.ok) throw new Error(`text to principal ${res.status}`);
}

/**
 * One live phone call (F29). Not hibernating: the session lives in memory for the length of the call. Each socket owns
 * only the session it authenticated, so a socket that never proved the call's token can neither read nor end it, and
 * once a call has its session no second socket may take it over.
 */
export class Call extends DurableObject<Env> {
	private session?: CallSession;
	private callSid = "";

	async fetch(request: Request): Promise<Response> {
		const reqUrl = new URL(request.url);
		const callSid = reqUrl.searchParams.get("call") ?? "";
		const fish = parseCallVoice(this.env.CALL_VOICE).kind === "fish";
		if (this.session) return new Response("call already connected", { status: 409 });
		this.callSid = callSid;
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		server.accept();
		const inbox = () => this.env.INBOX.get(this.env.INBOX.idFromName("main"));
		let mine: CallSession | undefined;
		server.addEventListener("message", async (m: MessageEvent) => {
			const raw = typeof m.data === "string" ? m.data : "";
			if (!mine) {
				let setup: any;
				try { setup = JSON.parse(raw); } catch { server.close(1008, "bad setup"); return; }
				if (this.session || setup?.type !== "setup" || setup.callSid !== callSid || !(await callTokenOk(this.env.BRIDGE_TOKEN, callSid, setup.customParameters?.token))) {
					await audit(this.env, "call_socket_rejected", { call: callSid });
					server.close(1008, "unverified");
					return;
				}
				mine = this.session = new CallSession({
					send: frame => { try { server.send(JSON.stringify(frame)); } catch { /* call gone */ } },
					llm: anthropicStream(this.env.ANTHROPIC_API_KEY, this.env.TALKER_MODEL),
					diag: (event, data) => { void audit(this.env, event, { call: callSid, ...data }); },
					passphraseOk: spoken => { const { salt, hash } = splitPassphraseCheck(this.env.PASSPHRASE_CHECK ?? ""); return passphraseMatches(spoken, hash, salt); },
					handoff: request => inbox().callEvent("call.turn", { call_id: callSid, text: request }),
					names: namesFrom(this.env),
					...(fish ? { playUrl: (line: string) => sayUrl(reqUrl.host, this.env.BRIDGE_TOKEN, callSid, line) } : {}),
				});
				// Fish mode has no TwiML greeting, so {{DA_NAME}} says it in his own voice once the socket is proven.
				if (fish) mine.say(greeting(namesFrom(this.env)));
				return;
			}
			await mine.onFrame(raw);
		});
		server.addEventListener("close", async () => {
			const s = mine;
			if (!s) return;
			if (this.session === s) this.session = undefined;
			// End it first: a reply still streaming stops, and a request it was about to hand off never leaves.
			s.end();
			void audit(this.env, s.authed ? "call_ended" : "call_ended_before_passphrase", { call: callSid, lines: s.transcript.length });
			if (s.authed && s.transcript.length > 0) {
				await inbox().callEvent("call.ended", { call_id: callSid, transcript: s.transcriptText() })
					.catch(e => audit(this.env, "call_transcript_lost", { call: callSid, error: String(e).slice(0, 120) }));
			}
		});
		return new Response(null, { status: 101, webSocket: client });
	}

	/** The Mac's answer; false when the call is no longer live. */
	deliver(text: string): boolean { return this.session?.deliver(text) ?? false; }
}
