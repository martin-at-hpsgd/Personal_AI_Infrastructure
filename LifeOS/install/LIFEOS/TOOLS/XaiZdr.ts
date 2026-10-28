#!/usr/bin/env bun
/**
 * @version 1.0.4
 * XaiZdr.ts — does xAI still keep what we send it? One live test, one state file.
 *
 * The Grok route's data-class ceiling is PUBLIC unless this file says, recently, that
 * zero data retention (ZDR) is on for our xAI team; then it is INTERNAL (non-personal work
 * only). The test asks xAI to store a throwaway response (`store: true`) and then fetch it
 * back. ZDR is verified only on a SPECIFIC confirmation: (a) a client-error refusal
 * (HTTP 400, 403 or 422) whose error code or message names zero data retention itself, or
 * (b) a fetch-back 404 on a created response whose creation reply carried xAI's documented
 * `x-zero-data-retention: true` header. A generic storage error, a 5xx or 429, a bare 404
 * or any network error is "not verified", and the reported ceiling is PUBLIC.
 *
 *   bun LIFEOS/TOOLS/XaiZdr.ts check     run the live test, write the state, print the verdict
 *   bun LIFEOS/TOOLS/XaiZdr.ts status    print the stored state and whether it is still fresh
 *
 * State: LIFEOS/MEMORY/STATE/xai-zdr.json. zdrVerifiedNow() reads it (fresh for 36 h) for the
 * ceiling `check` and `status` print, and GrokQuery.ts refreshes it when older than 24 h. No hook
 * gates a call on it. A verified → not-verified flip emits a high-severity Vigil security event,
 * which Vigil texts to the principal.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CROSS_VENDOR } from "./models";
import { getClaudeDir, lifeosPath } from "./Paths";
import { invariant } from "./Invariant";

export type ZdrState = { verified: boolean; checkedAt: string; evidence: string };

/** The guard trusts a verdict this long; past it the route is PUBLIC again. */
export const ZDR_FRESH_MS = 36 * 3_600_000;
/** GrokQuery re-tests once the verdict is this old, so a daily user never hits the stale window. */
export const ZDR_REFRESH_MS = 24 * 3_600_000;

export const statePath = (): string => process.env.LIFEOS_XAI_ZDR_STATE || lifeosPath("MEMORY", "STATE", "xai-zdr.json");

export function readZdr(path = statePath()): ZdrState | null {
  try {
    const s = JSON.parse(readFileSync(path, "utf8"));
    return typeof s?.verified === "boolean" && typeof s?.checkedAt === "string" ? s : null;
  } catch { return null; }
}

/** True only for a verified verdict younger than ZDR_FRESH_MS. Missing, unreadable, stale or unverified → false. */
export function zdrVerifiedNow(state: ZdrState | null = readZdr(), now = Date.now()): boolean {
  if (!state?.verified) return false;
  const at = Date.parse(state.checkedAt);
  return Number.isFinite(at) && at <= now && now - at < ZDR_FRESH_MS;
}

export function needsRefresh(state: ZdrState | null = readZdr(), now = Date.now()): boolean {
  const at = state ? Date.parse(state.checkedAt) : NaN;
  return !Number.isFinite(at) || now - at >= ZDR_REFRESH_MS;
}

/** A flip worth texting: the last verdict said ZDR was on and this one does not. */
export function isFlipOff(prev: ZdrState | null, next: ZdrState): boolean {
  return prev?.verified === true && next.verified === false;
}

// Only codes that name zero data retention itself count as evidence. Generic storage or retention
// policy codes (store_disabled, data_retention_*) can mean many things and never verify ZDR.
const RETENTION_CODE = /^(zero[_-]?data[_-]?retention([_-].*)?|zdr([_-].*)?)$/i;
const RETENTION_MESSAGE = /\bzero[ _-]?data[ _-]?retention\b|\bZDR\b/i;

/**
 * Is this failed create-call the retention refusal, and not just some storage-flavoured error?
 * Needs a client-error status that a policy refusal uses (400/403/422) AND a retention-specific
 * code or message. "Unable to store response" or "storage temporarily unavailable" matches neither,
 * and a 5xx/429 never qualifies whatever it says.
 */
export function isRetentionRefusal(status: number, body: any): boolean {
  if (status !== 400 && status !== 403 && status !== 422) return false;
  const err = body?.error;
  const code = String((typeof err === "object" && err ? err.code : undefined) ?? body?.code ?? "");
  const msg = String((typeof err === "object" && err ? err.message : err) ?? "");
  return RETENTION_CODE.test(code) || RETENTION_MESSAGE.test(msg);
}

/** The live test. Pure over `fetchImpl`, so tests inject both outcomes. */
export async function probe(key: string, fetchImpl: typeof fetch = fetch, model = CROSS_VENDOR.grok): Promise<ZdrState> {
  const checkedAt = new Date().toISOString();
  const headers = { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" };
  try {
    const res = await fetchImpl("https://api.x.ai/v1/responses", {
      method: "POST", headers, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ model, input: "Reply with: ok", store: true, max_output_tokens: 16 }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = String(body?.error?.message ?? body?.error ?? body?.code ?? "");
      // Only a retention-specific refusal is the ZDR signal; any other error, storage-flavoured or not, proves nothing.
      if (isRetentionRefusal(res.status, body)) return { verified: true, checkedAt, evidence: `store refused: HTTP ${res.status} ${msg.slice(0, 160)}` };
      return { verified: false, checkedAt, evidence: `inconclusive: HTTP ${res.status} ${msg.slice(0, 160)}` };
    }
    if (typeof body?.id !== "string" || !body.id) return { verified: false, checkedAt, evidence: "inconclusive: 200 without a response id" };
    const back = await fetchImpl(`https://api.x.ai/v1/responses/${encodeURIComponent(body.id)}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (back.ok) return { verified: false, checkedAt, evidence: `stored: created and fetched back (HTTP ${back.status})` };
    if (back.status === 404) {
      // A bare 404 is ambiguous (lag, a wrong route, an expired id). Only xAI's own header makes it a ZDR confirmation.
      const header = (res.headers.get("x-zero-data-retention") ?? "").trim().toLowerCase();
      if (header === "true") return { verified: true, checkedAt, evidence: "not stored: fetch-back returned 404 and the create reply carried x-zero-data-retention: true" };
      return { verified: false, checkedAt, evidence: `inconclusive: fetch-back 404 without x-zero-data-retention: true (header: ${header || "absent"})` };
    }
    return { verified: false, checkedAt, evidence: `inconclusive: fetch-back HTTP ${back.status}` };
  } catch (e: any) {
    return { verified: false, checkedAt, evidence: `inconclusive: ${String(e?.message ?? e).slice(0, 160)}` };
  }
}

export function writeZdr(state: ZdrState, path = statePath()): void {
  invariant(typeof state.verified === "boolean", "ZDR verdict is boolean");
  invariant(Number.isFinite(Date.parse(state.checkedAt)), "ZDR checkedAt is a timestamp");
  invariant(state.evidence.length > 0, "ZDR verdict carries evidence");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

function xaiKey(): string {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  try {
    const m = readFileSync(join(getClaudeDir(), ".env"), "utf8").match(/^XAI_API_KEY=(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}

async function alertFlipOff(next: ZdrState): Promise<void> {
  try {
    // The event writer: STATVS writeEvent, else Vigil's throwing emit on an install without STATVS (that fallback goes in
    // migration p3). The variable keeps its name: ShadowRelease's OPTIONAL_IMPORT_SITES guards it.
    const vigilEmitPath = [join(import.meta.dir, "../STATVS/lib/event.ts"), join(import.meta.dir, "../VIGIL/Emit.ts")].find((p) => existsSync(p)) ?? "";
    if (!existsSync(vigilEmitPath)) return;
    const mod = await import(vigilEmitPath);
    const event = {
      id: crypto.randomUUID(), source: "xai-zdr", ts: next.checkedAt, kind: "security", severity: "high",
      title: "xAI zero data retention is no longer verified",
      summary: `The daily xAI retention test no longer shows zero retention (${next.evidence}). The Grok route fell back to the PUBLIC data ceiling automatically.`,
      ref: "LIFEOS/TOOLS/XaiZdr.ts", url: null, privacy_class: "public", dedup_key: `xai-zdr-off-${next.checkedAt.slice(0, 10)}`,
    };
    const r: { ok: boolean; refused?: string } = typeof mod.writeEvent === "function" ? mod.writeEvent(event) : (mod.emit(event), { ok: true });
    if (!r.ok) console.error(`xai-zdr: Vigil event refused: ${r.refused}`);
  } catch (e) { console.error(`xai-zdr: Vigil emit failed: ${e}`); }
}

/** Run the test, store it, alert on a flip. Returns the new state. */
export async function check(key = xaiKey()): Promise<ZdrState> {
  const prev = readZdr();
  const next = key ? await probe(key) : { verified: false, checkedAt: new Date().toISOString(), evidence: "inconclusive: XAI_API_KEY not set" };
  writeZdr(next);
  if (isFlipOff(prev, next)) await alertFlipOff(next);
  return next;
}

if (import.meta.main) {
  const cmd = process.argv[2] ?? "status";
  if (cmd === "check") {
    const s = await check();
    console.log(`${s.verified ? "✓ ZDR verified" : "✗ ZDR not verified"} — ${s.evidence}`);
    console.log(`Grok route ceiling: ${zdrVerifiedNow(s) ? "INTERNAL" : "PUBLIC"}`);
  } else if (cmd === "status") {
    const s = readZdr();
    if (!s) console.log(`no verdict yet (${statePath()}) — Grok route ceiling: PUBLIC`);
    else console.log(`${s.verified ? "verified" : "not verified"} at ${s.checkedAt} — ${s.evidence}\nGrok route ceiling: ${zdrVerifiedNow(s) ? "INTERNAL" : "PUBLIC"}${needsRefresh(s) ? " (stale; next GrokQuery call re-tests)" : ""}`);
  } else {
    console.error("usage: XaiZdr.ts check | status");
    process.exit(2);
  }
}
