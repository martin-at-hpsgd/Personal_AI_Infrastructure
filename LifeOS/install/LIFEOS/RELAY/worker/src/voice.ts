// The phone line's front door (Relay ISA F29), without Cloudflare: who may get through, the TwiML that connects an
// allowed call to the talker, the single-use token that proves the relay socket belongs to that call, and the
// spoken passphrase check against the same salted hash the text countersign uses.
import { safeEqual } from "./sig";
import { pronounce } from "../../../TOOLS/PronounceCore";

const enc = new TextEncoder();

async function hmacHex(key: string, data: string): Promise<string> {
	const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)))].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string): Promise<string> {
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** The carrier's top caller-ID grade. Any other grade present on the call is refused; an absent one is logged. */
export const STIR_PASS_A = "TN-Validation-Passed-A";

export type Admission = { allow: true; stir: "A" | "absent" | "forwarded" } | { allow: false; reason: "not-allowlisted" | "stir-not-A" };

/**
 * ISC-389: only {{PRINCIPAL_NAME}}'s numbers get past the greeting. A direct call must carry attestation A when it carries any. A call
 * the Linq line forwarded is re-signed by the forwarding carrier (seen live 2026-10-25: {{PRINCIPAL_NAME}}'s own call arrived below A),
 * so its grade says nothing about him; it is admitted on his number and the spoken passphrase carries the check (ISC-390).
 */
export function admitCall(params: Record<string, string>, principalHandles: string): Admission {
	const principals = principalHandles.split(",").map(s => s.trim()).filter(Boolean);
	const from = params.From ?? params.Caller ?? "";
	if (!from || !principals.includes(from)) return { allow: false, reason: "not-allowlisted" };
	if (params.ForwardedFrom) return { allow: true, stir: "forwarded" };
	const verstat = params.StirVerstat;
	if (verstat && verstat !== STIR_PASS_A) return { allow: false, reason: "stir-not-A" };
	return { allow: true, stir: verstat ? "A" : "absent" };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function refuseTwiml(): string {
	return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not taking calls.</Say><Hangup/></Response>`;
}

/** A greeting is optional: when {{DA_NAME}} speaks in Fish, the Worker plays it once the socket is up instead. */
export function connectTwiml(o: { relayUrl: string; token: string; greeting?: string; ttsProvider: string; voice: string }): string {
	const attrs = [
		`url="${xml(o.relayUrl)}"`, ...(o.greeting ? [`welcomeGreeting="${xml(o.greeting)}"`, `welcomeGreetingInterruptible="speech"`] : []),
		`language="en-US"`, `ttsProvider="${xml(o.ttsProvider)}"`, `voice="${xml(o.voice)}"`,
		// ISC-395: Deepgram, named explicitly. Older accounts default to Google, which mis-hears spoken
		// passphrases.
		`transcriptionProvider="Deepgram"`, `speechModel="nova-3-general"`,
		`interruptible="speech"`, `interruptSensitivity="medium"`, `profanityFilter="false"`,
	].join(" ");
	return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><ConversationRelay ${attrs}><Parameter name="token" value="${xml(o.token)}"/></ConversationRelay></Connect></Response>`;
}

/** The token Twilio carries into the relay socket's setup message: an HMAC of the call id under a Worker secret. */
export function callToken(key: string, callSid: string): Promise<string> { return hmacHex(key, `tex-call:${callSid}`); }
export async function callTokenOk(key: string, callSid: string, token: unknown): Promise<boolean> {
	if (typeof token !== "string" || !callSid) return false;
	return safeEqual(token, await callToken(key, callSid));
}

/**
 * ISC-396: {{DA_NAME}}'s call voice is his Fish clone. ConversationRelay speaks only its own providers (Google, Amazon), but it
 * plays any audio URL, so each line becomes a link back to this Worker that renders it in Fish. The link is signed
 * per call and per line, so nobody else can spend the Fish account through it.
 */
export type CallVoice = { kind: "fish"; referenceId: string; speed: number } | { kind: "twilio"; provider: string; voice: string };

/** CALL_VOICE: "Fish:<reference id>[:<speed>]" or "<Google|Amazon>:<voice>". */
export function parseCallVoice(v: string): CallVoice {
	const [provider, rest = ""] = (v || "Google:en-US-Journey-D").split(/:(.*)/s);
	if (provider === "Fish") {
		const [referenceId = "", speed] = rest.split(":");
		return { kind: "fish", referenceId, speed: Number(speed) > 0 ? Number(speed) : 1 };
	}
	return { kind: "twilio", provider: provider!, voice: rest };
}

/** ISC-404: the Fish request for one call line, at full quality like every other place {{DA_NAME}} speaks (latency "normal", 192k). */
/**
 * The principal's pronunciation rules as the PRONUNCIATIONS secret carries them (deploy.ts pushes USER/PRINCIPAL/
 * PRONUNCIATIONS.json), parsed once per value; missing or malformed is no rules, so a call never fails on them.
 */
let rulesMemo: { raw: string; map: Record<string, string> } = { raw: "", map: {} };
export function callPronunciations(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	if (rulesMemo.raw === raw) return rulesMemo.map;
	let map: Record<string, string> = {};
	try {
		const j = JSON.parse(raw) as unknown;
		if (j && typeof j === "object" && !Array.isArray(j)) map = Object.fromEntries(Object.entries(j as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
	} catch { /* malformed: no rules */ }
	rulesMemo = { raw, map };
	return map;
}

/** The Fish request for one call line: spoken through the one LifeOS pronunciation pass (Fish voice ISA F7, Relay ISC-405). */
export function fishSayBody(text: string, cv: Extract<CallVoice, { kind: "fish" }>, rules: Record<string, string> = {}): Record<string, unknown> {
	text = pronounce(text, rules);
	return { text, reference_id: cv.referenceId, format: "mp3", mp3_bitrate: 192, latency: "normal", ...(cv.speed !== 1 ? { prosody: { speed: cv.speed } } : {}) };
}

const b64url = (s: string) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)));

export async function sayUrl(host: string, key: string, callSid: string, text: string): Promise<string> {
	const s = b64url(text);
	return `https://${host}/voice/say?c=${encodeURIComponent(callSid)}&s=${s}&t=${await hmacHex(key, `tex-say:${callSid}:${s}`)}`;
}

/** The line a /voice/say link carries, or null when its signature does not match. */
export async function sayText(key: string, params: URLSearchParams): Promise<string | null> {
	const c = params.get("c") ?? "", s = params.get("s") ?? "", t = params.get("t") ?? "";
	if (!c || !s || !safeEqual(t, await hmacHex(key, `tex-say:${c}:${s}`))) return null;
	try { return fromB64url(s); } catch { return null; }
}

/** Text split into short spoken lines at sentence ends, so the first one plays while the rest render. */
export function sentences(text: string, max = 280): string[] {
	const out: string[] = [];
	for (const part of text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? []) {
		let p = part.trim();
		while (p.length > max) { const cut = p.lastIndexOf(" ", max) > 0 ? p.lastIndexOf(" ", max) : max; out.push(p.slice(0, cut).trim()); p = p.slice(cut).trim(); }
		if (p) out.push(p);
	}
	return out;
}

/** "<salt>:<sha256 hex>" → its parts; the hash is the last 64 hex characters, so a salt may hold a colon. */
export function splitPassphraseCheck(v: string): { salt: string; hash: string } {
	const m = v.match(/^(.*):([0-9a-f]{64})$/i);
	return m ? { salt: m[1]!, hash: m[2]!.toLowerCase() } : { salt: "", hash: "" };
}

/** The text countersign's normalization (hooks/lib/texting-guard-core.ts normalizePhrase). */
export function normalizePhrase(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]/g, ""); }

/**
 * ISC-390: the spoken passphrase, checked against sha256(salt + normalized phrase). Speech-to-text wraps it in other
 * words ("it's blue falcon"), so every run of up to 12 consecutive words is tried; nothing but the hash is compared.
 */
export async function passphraseMatches(spoken: string, hashHex: string, salt = ""): Promise<boolean> {
	if (!hashHex) return false;
	const words = spoken.split(/\s+/).map(normalizePhrase).filter(Boolean).slice(0, 40);
	for (let i = 0; i < words.length; i++) {
		let joined = "";
		for (let j = i; j < Math.min(words.length, i + 12); j++) {
			joined += words[j];
			if (safeEqual(await sha256Hex(`${salt}${joined}`), hashHex.toLowerCase())) return true;
		}
	}
	return false;
}
