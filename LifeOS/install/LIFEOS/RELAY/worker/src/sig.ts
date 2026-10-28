// Webhook signature checks for the Tex Worker (Relay ISA F28 ISC-377, F29 ISC-388). Web Crypto only, so the same
// code runs in the Worker and under bun test.

const enc = new TextEncoder();

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64encode(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Constant-time string comparison (length is not secret here: every signature has a fixed length). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacB64(key: Uint8Array<ArrayBuffer>, message: string, hash: "SHA-256" | "SHA-1"): Promise<string> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash }, false, ["sign"]);
  return b64encode(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

export const WEBHOOK_TOLERANCE_S = 300;

/**
 * Standard Webhooks verification, as Linq documents it: HMAC-SHA256 over `{id}.{timestamp}.{body}` with the
 * base64-decoded `whsec_` secret, compared against every `v1,` signature in the header, and a timestamp no more
 * than five minutes from now.
 */
export async function verifyStandardWebhook(
  secret: string,
  headers: { get(name: string): string | null },
  body: string,
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sig = headers.get("webhook-signature");
  if (!secret || !id || !ts || !sig || !/^\d+$/.test(ts)) return false;
  if (Math.abs(nowS - Number(ts)) > WEBHOOK_TOLERANCE_S) return false;
  let key: Uint8Array<ArrayBuffer>;
  try { key = b64decode(secret.replace(/^whsec_/, "")); } catch { return false; }
  const expected = await hmacB64(key, `${id}.${ts}.${body}`, "SHA-256");
  return sig.split(" ").some(s => s.startsWith("v1,") && safeEqual(s.slice(3), expected));
}

/**
 * Twilio request validation: HMAC-SHA1 over the full URL plus each POST parameter's name and value, sorted by name,
 * base64-encoded, compared with X-Twilio-Signature.
 */
export async function verifyTwilio(authToken: string, url: string, params: Record<string, string>, signature: string | null): Promise<boolean> {
  if (!authToken || !signature) return false;
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join("");
  const expected = await hmacB64(new Uint8Array(enc.encode(authToken)), data, "SHA-1");
  return safeEqual(signature, expected);
}

/** Sign a body the way Linq does; used by tests and the local probe. */
export async function signStandardWebhook(secret: string, id: string, ts: number, body: string): Promise<string> {
  return `v1,${await hmacB64(b64decode(secret.replace(/^whsec_/, "")), `${id}.${ts}.${body}`, "SHA-256")}`;
}
