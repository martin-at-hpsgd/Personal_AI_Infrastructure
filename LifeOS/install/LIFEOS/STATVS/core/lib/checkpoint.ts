/**
 * STATVS core checkpoints — C2SP tlog-checkpoint bodies signed as C2SP signed notes with Ed25519.
 *
 * Checkpoint body (https://c2sp.org/tlog-checkpoint): the origin line, the tree size in decimal,
 * the root hash in standard base64, then any extension lines, each ending in a newline.
 *
 * Signed note (https://c2sp.org/signed-note): the note text, one blank line, then one signature
 * line per signer: "— <key name> <base64(key id ‖ signature)>". For Ed25519 the key id is the
 * first 4 bytes of SHA-256(key name ‖ 0x0A ‖ 0x01 ‖ 32-byte public key). A verifier key is written
 * `<name>+<key id hex>+<base64(0x01 ‖ public key)>`, a signer key
 * `PRIVATE+KEY+<name>+<key id hex>+<base64(0x01 ‖ 32-byte seed)>`, the same strings Go's
 * golang.org/x/mod/sumdb/note reads, so any tlog tool can check our checkpoints.
 *
 * Verification is typed: a bad note returns { ok: false, reason }, never throws. A signature line
 * from a key the verifier does not know is ignored; one from a known key that does not verify
 * fails the whole note, as the spec requires.
 *
 * Pure: WebCrypto Ed25519 only, so the Worker can bundle it.
 *
 * @version 0.1.0
 */
import { sha256Bytes } from "./canonical.ts";
import { HASH_SIZE, bytesEqual, fromHex, toHex, verifyConsistency } from "./merkle.ts";

const ED25519 = 0x01;
const SIG_PREFIX = "— ";
/** PKCS#8 DER header for a raw 32-byte Ed25519 seed (RFC 8410). */
const PKCS8_ED25519_HEADER = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const enc = new TextEncoder();

export type Checkpoint = { origin: string; size: number; root: Uint8Array; extensions?: string[] };
export type VerifyResult = { ok: true; text: string; signers: string[] } | { ok: false; reason: string };
export type CheckpointResult = { ok: true; checkpoint: Checkpoint; signers: string[] } | { ok: false; reason: string };

// ── base64 ───────────────────────────────────────────────────────────────────

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  try {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ── keys ─────────────────────────────────────────────────────────────────────

/** A key name is non-empty, has no whitespace and no "+". */
export function validKeyName(name: string): boolean {
  return name.length > 0 && !/[\s+]/u.test(name);
}

/** The 4-byte signed-note key id for an Ed25519 public key. */
export async function keyId(name: string, publicKey: Uint8Array): Promise<Uint8Array> {
  // sha256Bytes, not crypto.subtle.digest: the input is 34+ bytes plus the name, and Bun 1.3.6 can drop a 64+ byte digest (canonical.ts).
  return sha256Bytes(concat(enc.encode(name), new Uint8Array([0x0a, ED25519]), publicKey)).subarray(0, 4);
}

/** Splits a key string into n fields on "+"; the last field (base64) may itself hold "+". */
function splitKey(key: string, n: number): string[] | null {
  const out: string[] = [];
  let rest = key;
  for (let i = 0; i < n - 1; i++) {
    const at = rest.indexOf("+");
    if (at < 0) return null;
    out.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  out.push(rest);
  return out;
}

type ParsedVerifier = { name: string; id: Uint8Array; publicKey: Uint8Array };
type ParsedSigner = ParsedVerifier & { seed: Uint8Array };

/** Parses a verifier key string; null if malformed or its key id does not match. */
export async function parseVerifierKey(vkey: string): Promise<ParsedVerifier | null> {
  const parts = splitKey(vkey, 3);
  if (!parts || !validKeyName(parts[0]) || !/^[0-9a-f]{8}$/.test(parts[1])) return null;
  const key = unb64(parts[2]);
  if (!key || key.length !== 33 || key[0] !== ED25519) return null;
  const publicKey = key.subarray(1);
  const id = await keyId(parts[0], publicKey);
  if (toHex(id) !== parts[1]) return null;
  return { name: parts[0], id, publicKey };
}

async function importSeed(seed: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", concat(PKCS8_ED25519_HEADER, seed), { name: "Ed25519" }, true, ["sign"]);
}

async function publicFromPrivate(key: CryptoKey): Promise<Uint8Array> {
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  const x = (jwk.x ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const pub = unb64(x.padEnd(Math.ceil(x.length / 4) * 4, "="));
  if (!pub || pub.length !== 32) throw new Error("could not derive the Ed25519 public key");
  return pub;
}

/** Parses a signer key string; null if malformed, if the seed does not match the key id, or if the name is invalid. */
export async function parseSignerKey(skey: string): Promise<ParsedSigner | null> {
  const parts = splitKey(skey, 5);
  if (!parts || parts[0] !== "PRIVATE" || parts[1] !== "KEY") return null;
  const [, , name, idHex, keyB64] = parts;
  if (!validKeyName(name) || !/^[0-9a-f]{8}$/.test(idHex)) return null;
  const key = unb64(keyB64);
  if (!key || key.length !== 33 || key[0] !== ED25519) return null;
  const seed = key.slice(1);
  const publicKey = await publicFromPrivate(await importSeed(seed));
  const id = await keyId(name, publicKey);
  if (toHex(id) !== idHex) return null;
  return { name, id, publicKey, seed };
}

/** Generates a fresh Ed25519 signer key and its verifier key, in signed-note string form. */
export async function generateKeys(name: string): Promise<{ signerKey: string; verifierKey: string }> {
  if (!validKeyName(name)) throw new Error(`invalid key name: ${JSON.stringify(name)}`);
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const id = toHex(await keyId(name, publicKey));
  const tag = new Uint8Array([ED25519]);
  return {
    signerKey: `PRIVATE+KEY+${name}+${id}+${b64(concat(tag, seed))}`,
    verifierKey: `${name}+${id}+${b64(concat(tag, publicKey))}`,
  };
}

// ── notes ────────────────────────────────────────────────────────────────────

/** Note text must be non-empty, end in a newline, hold no blank line and no control character but newline. */
function validNoteText(text: string): boolean {
  if (text.length === 0 || !text.endsWith("\n") || text.startsWith("\n") || text.includes("\n\n")) return false;
  return !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text);
}

/** Signs `text` with a signer key, returning the signed note (text, blank line, signature line). */
export async function signNote(text: string, signerKey: string): Promise<string> {
  if (!validNoteText(text)) throw new Error("note text must be non-empty, end in a newline and hold no blank line");
  const signer = await parseSignerKey(signerKey);
  if (!signer) throw new Error("malformed signer key");
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await importSeed(signer.seed), enc.encode(text)));
  return `${text}\n${SIG_PREFIX}${signer.name} ${b64(concat(signer.id, sig))}\n`;
}

/** Verifies a signed note against the given verifier keys; at least one must sign it. */
export async function verifyNote(signed: string, verifierKeys: readonly string[]): Promise<VerifyResult> {
  const split = signed.lastIndexOf("\n\n");
  if (split < 0) return { ok: false, reason: "no signature block" };
  const text = signed.slice(0, split + 1);
  if (!validNoteText(text)) return { ok: false, reason: "malformed note text" };
  const block = signed.slice(split + 2);
  if (!block.endsWith("\n")) return { ok: false, reason: "signature block must end in a newline" };
  const lines = block.slice(0, -1).split("\n");
  const known: ParsedVerifier[] = [];
  for (const v of verifierKeys) {
    const k = await parseVerifierKey(v);
    if (!k) return { ok: false, reason: `malformed verifier key ${v.split("+")[0]}` };
    known.push(k);
  }
  const signers: string[] = [];
  for (const line of lines) {
    if (!line.startsWith(SIG_PREFIX)) return { ok: false, reason: "malformed signature line" };
    const rest = line.slice(SIG_PREFIX.length).split(" ");
    if (rest.length !== 2 || !validKeyName(rest[0])) return { ok: false, reason: "malformed signature line" };
    const raw = unb64(rest[1]);
    if (!raw || raw.length < 5) return { ok: false, reason: "malformed signature" };
    const id = raw.subarray(0, 4);
    const key = known.find((k) => k.name === rest[0] && bytesEqual(k.id, id));
    if (!key) continue;
    const sig = raw.subarray(4);
    if (sig.length !== 64) return { ok: false, reason: `bad signature length from ${key.name}` };
    const pub = await crypto.subtle.importKey("raw", new Uint8Array(key.publicKey), { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, pub, new Uint8Array(sig), enc.encode(text)))) {
      return { ok: false, reason: `signature from ${key.name} does not verify` };
    }
    if (!signers.includes(key.name)) signers.push(key.name);
  }
  if (signers.length === 0) return { ok: false, reason: "no signature from a known key" };
  return { ok: true, text, signers };
}

// ── checkpoints ──────────────────────────────────────────────────────────────

/** Writes the checkpoint body (the note text, unsigned). */
export function formatCheckpoint(cp: Checkpoint): string {
  if (cp.origin.length === 0 || /[\n\r]/.test(cp.origin)) throw new Error("checkpoint origin must be one non-empty line");
  if (!Number.isSafeInteger(cp.size) || cp.size < 0) throw new Error(`checkpoint size must be a non-negative safe integer, got ${cp.size}`);
  if (cp.root.length !== HASH_SIZE) throw new Error("checkpoint root must be 32 bytes");
  const ext = cp.extensions ?? [];
  if (ext.some((e) => e.length === 0 || /[\n\r]/.test(e))) throw new Error("checkpoint extension lines must be non-empty single lines");
  return [cp.origin, String(cp.size), b64(cp.root), ...ext].map((l) => `${l}\n`).join("");
}

/** Parses a checkpoint body; null when malformed. */
export function parseCheckpoint(text: string): Checkpoint | null {
  if (!text.endsWith("\n")) return null;
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 3 || lines.some((l) => l.length === 0)) return null;
  const [origin, sizeText, rootText, ...extensions] = lines;
  if (!/^(0|[1-9]\d*)$/.test(sizeText)) return null;
  const size = Number(sizeText);
  const root = unb64(rootText);
  if (!Number.isSafeInteger(size) || !root || root.length !== HASH_SIZE) return null;
  return extensions.length ? { origin, size, root, extensions } : { origin, size, root };
}

/** Formats and signs a checkpoint. */
export function signCheckpoint(cp: Checkpoint, signerKey: string): Promise<string> {
  return signNote(formatCheckpoint(cp), signerKey);
}

/** Verifies a signed checkpoint, optionally pinning its origin line. */
export async function verifyCheckpoint(signed: string, verifierKeys: readonly string[], origin?: string): Promise<CheckpointResult> {
  const note = await verifyNote(signed, verifierKeys);
  if (!note.ok) return note;
  const checkpoint = parseCheckpoint(note.text);
  if (!checkpoint) return { ok: false, reason: "malformed checkpoint body" };
  if (origin !== undefined && checkpoint.origin !== origin) return { ok: false, reason: `origin is ${checkpoint.origin}, expected ${origin}` };
  return { ok: true, checkpoint, signers: note.signers };
}

/**
 * Verifies that `next` extends `prev`: both signed checkpoints verify, share an origin, and the
 * consistency proof (hex hashes, as GET /proof/consistency returns them) shows prev is a prefix of next.
 */
export async function verifyCheckpointPair(
  prev: string,
  next: string,
  proofHex: readonly string[],
  verifierKeys: readonly string[],
): Promise<{ ok: true; prev: Checkpoint; next: Checkpoint } | { ok: false; reason: string }> {
  const a = await verifyCheckpoint(prev, verifierKeys);
  if (!a.ok) return { ok: false, reason: `previous checkpoint: ${a.reason}` };
  const b = await verifyCheckpoint(next, verifierKeys, a.checkpoint.origin);
  if (!b.ok) return { ok: false, reason: `next checkpoint: ${b.reason}` };
  let proof: Uint8Array[];
  try {
    proof = proofHex.map(fromHex);
  } catch {
    return { ok: false, reason: "proof is not hex" };
  }
  const fine = await verifyConsistency(a.checkpoint.size, b.checkpoint.size, a.checkpoint.root, b.checkpoint.root, proof);
  return fine ? { ok: true, prev: a.checkpoint, next: b.checkpoint } : { ok: false, reason: "consistency proof does not verify" };
}
