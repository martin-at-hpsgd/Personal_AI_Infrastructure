/**
 * STATVS core Worker (lifeos-statvs-core) — the intake, read API and tlog surface of the one
 * permanent record (statvs-full-migration ISA, F2). Deployed only through CfEnv.ts (P6); the release history is
 * worker/CHANGELOG.md.
 *
 * Routes (all but /health need "Authorization: Bearer <token>", checked against the control
 * database's credentials table; an entry is cached at most AUTH_CACHE_MS, so a revoked token
 * stops within a minute, ISC-74):
 *   POST /rows                    write scope. Validate, bind the chain to its writer, recheck the
 *                                 hash, apply provenance, mask any secret left, then hand the
 *                                 batch to the shard sequencer.
 *   PUT  /bodies/:sha256          write scope. Store a body over 4096 bytes once, by its hash,
 *                                 after provenance and a secret scan of its bytes.
 *   GET  /bodies/:sha256          read scope (a scoped reader only for bodies of rows it can see).
 *   GET  /rows                    read scope. Index query, full rows read back from segments;
 *                                 ?order=ts|offset, ts by default when from or to is given;
 *                                 ?subject=<kind>:<key> narrows to one RES's rows (schema v4).
 *   GET  /checkpoint              read scope. The latest signed checkpoint (C2SP signed note).
 *   GET  /proof/consistency       read scope. ?first=N&second=M, hex hashes.
 *   GET  /tile/<L>/<N>[.p/<W>]    read scope. C2SP tlog-tiles hash tiles.
 *   GET  /key                     read scope. The checkpoint verifier key.
 *   GET  /gaps?chain=             read:*. Missing origin sequence numbers of a chain.
 *   GET  /refusals                read:*. Refusal counts by reason.
 *   GET  /health                  open, touches no binding. Reports the release and `schema`, the newest row schema
 *                                 the intake reads, which the shipper checks before it sends a v4 row (CENSVS ISC-64).
 *
 * Scopes: "write:*", "write:<writer>", "write:<prefix>*"; "read:*"; "read:stream:<name>",
 * "read:class:<name>". A scoped reader sees only rows of its streams (any, when it names none) and
 * its classes (public and system, when it names none), so a token issued for one stream reads
 * nothing outside it and personal rows need an explicit class grant (ISC-49).
 *
 * A shipped row's writer is <writer>@<machine>, so one hook on two machines is two writers. An exact
 * "write:<writer>" scope covers that writer on every machine; "write:<writer>@<machine>" covers one.
 * A row's chain is writer-slug|app|class|day, four parts: its first field must be the slug of the row's writer
 * and the sequencer binds each chain to the writer that first stored on it, so no credential can
 * squat another writer's chain. The marker writer is reserved.
 *
 * Secrets: a row still holding one is stored with each secret replaced by its mask token and the
 * flag "intake-masked" (ISC-51); the masking is deterministic, so a resend of the same row is a
 * duplicate. A body holding one is stored masked under the sha256 of its masked bytes, and the
 * rows that name the original sha256 are rewritten to the masked one. A body that is not UTF-8
 * is scanned through a lossy decode; if a secret shows there it cannot be masked byte-safely, so
 * the body is refused and so are the rows naming it. Only a secret in a row's identity fields
 * (chain, writer, stream) refuses the row "unmasked-secret".
 *
 * Customers: provenance runs on every row and on every body's content. A body is judged as if it
 * came from a Vector app, the strictest reading, because a PUT carries no envelope. A customer
 * row, or a row naming a withheld body, is refused "withheld" and leaves a content-free marker.
 * A row on a customer chain is a customer row unless it is one of the shipper's content-free
 * markers (withheld, integrity-failed, local-only), whatever its content names.
 * Withheld and refused bodies are never stored. A withhold is a decision about the content, so a
 * content-free note under bodynote/<sha256> remembers it and retries stay idempotent. A refusal
 * for an unmasked secret is a verdict on the masker, not the content: it leaves no note, and every
 * upload judges the body again with the masker deployed then (ISC-162). Every refusal is counted.
 * The record is permanent (ISC-47). Its one exception is POST /erase (erasure.ts), taken only with the erase
 * credential and {{PRINCIPAL_NAME}}'s approval, for a leaked secret, customer data or another person's personal data; it clears
 * whole groups of a v3 row, keeps every hash, and writes a signed tombstone first (ISC-65 to ISC-67).
 */
import { canonicalJson, sha256Hex, SHA256_HEX, utf8 } from "../../lib/canonical";
import { parseCheckpoint, parseSignerKey } from "../../lib/checkpoint";
import { mask, scan } from "../../lib/mask";
import { consistencyProof, parseTilePath, tileHashReader, toHex } from "../../lib/merkle";
import { decide, decideBatch, parseProvenanceConfig, WITHHOLD_REASONS, type Decision, type ProvenanceConfig, type WithholdReason } from "../../lib/provenance";
import { finalizeRow, needsBody, parseAnyRow, SCHEMA_VERSION, verifyRowHash, WRITER_RE, writerSlug, type CoreRow, type Ingested, type RowFields } from "../../lib/row";
import { parseSubject, subjectProblem } from "../../lib/subject";
import pkg from "../package.json";
import { ERASE_SCOPE, ERASURE_WRITER } from "./erasure";
import { bodyVisible, chainClass, indexDatabases, queryIndex, type D1Like } from "./index-store";
import {
  bodyKey, bodyNoteKey, checkpointKey, MARKER_WRITER, r2TileStore, readSegment, tileKey, writeImmutable,
  type AppendInput, type AppendResult, type R2Like, type Refusal, type RowStatus, type WithheldRow, type Withholding,
} from "./sequencer";

export { Sequencer } from "./sequencer";

/** The release this build carries: package.json is the one place ReleaseRecord writes it, so /health cannot drift. */
export const VERSION: string = pkg.version;
export const SHARD = "main";
/** How long a credential lookup is trusted; must stay at or under 60 s (ISC-74). */
export const AUTH_CACHE_MS = 30_000;
export const MAX_ROWS = 500;
export const MAX_BATCH_BYTES = 1_000_000;
export const MAX_BODY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

interface DurableObjectStubLike { fetch(input: string | Request, init?: RequestInit): Promise<Response> }
interface DurableObjectNamespaceLike { idFromName(name: string): unknown; get(id: unknown): DurableObjectStubLike }
export type Env = {
  CONTROL: D1Like;
  RECORD: R2Like;
  SEQUENCER: DurableObjectNamespaceLike;
  STATVS_MASK_KEY?: string;
  STATVS_SIGNING_KEY?: string;
  STATVS_PROVENANCE?: unknown;
} & Record<string, unknown>;

/** The six headers the estate scanner checks. The Worker serves JSON, text and bytes, so the CSP allows nothing. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
};

const json = (value: unknown, status = 200) => Response.json(value, { status });
const ROW_KEYS = new Set(["v", "chain", "seq", "ts", "ts_basis", "writer", "stream", "subject", "op", "app", "kind", "severity", "title", "session", "ref", "data", "body", "data_hash", "content_hash", "masked", "flags", "src", "hash"]);

// ── Credentials ──

export interface Credential { name: string; scopes: string[] }

function parseScopes(raw: unknown): string[] {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
  } catch {
    return [];
  }
}

export function canWrite(c: Credential, writer: string): boolean {
  return c.scopes.some((s) => {
    if (!s.startsWith("write:")) return false;
    const p = s.slice(6);
    // An exact scope covers its writer on every machine: "write:hook:turn-record" covers "hook:turn-record@mac-studio".
    return p === "*" || p === writer || (!p.endsWith("*") && !p.includes("@") && writer.startsWith(`${p}@`)) || (p.endsWith("*") && p.length > 1 && writer.startsWith(p.slice(0, -1)));
  });
}
const canWriteAny = (c: Credential) => c.scopes.some((s) => s.startsWith("write:") && s.length > 6);
const readsAll = (c: Credential) => c.scopes.includes("read:*");
const scoped = (c: Credential, prefix: string) => c.scopes.filter((s) => s.startsWith(prefix) && s.length > prefix.length).map((s) => s.slice(prefix.length));

/** Classes a scoped reader sees when its token names none. */
export const DEFAULT_READ_CLASSES: readonly string[] = ["public", "system"];

/** What a reader may see: undefined fields mean any. Null when the credential cannot read. */
export interface Visibility { streams?: string[]; classes?: string[] }
export function visibility(c: Credential): Visibility | null {
  if (readsAll(c)) return {};
  const streams = scoped(c, "read:stream:"), classes = scoped(c, "read:class:");
  if (streams.length === 0 && classes.length === 0) return null;
  return { streams: streams.length > 0 ? streams : undefined, classes: classes.length > 0 ? classes : [...DEFAULT_READ_CLASSES] };
}
const readsAny = (c: Credential) => visibility(c) !== null;

// ── Small helpers ──

function bearer(request: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
  return m ? m[1]! : null;
}

function intParam(v: string | null, fallback: number, min: number, max: number): number | null {
  if (v === null || v === "") return fallback;
  if (!/^-?\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

function timeParam(v: string | null): number | undefined | null {
  if (v === null || v === "") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function verifierFromSigner(name: string, id: Uint8Array, publicKey: Uint8Array): string {
  const bytes = new Uint8Array(33);
  bytes[0] = 0x01;
  bytes.set(publicKey, 1);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `${name}+${toHex(id)}+${btoa(s)}`;
}

function sequencer(env: Env): DurableObjectStubLike {
  return env.SEQUENCER.get(env.SEQUENCER.idFromName(SHARD));
}

async function latestCheckpoint(env: Env): Promise<{ note: string; size: number } | null> {
  const obj = await env.RECORD.get(checkpointKey(SHARD, "latest"));
  if (!obj) return null;
  const note = await obj.text();
  const cp = parseCheckpoint(note.slice(0, note.indexOf("\n\n") + 1));
  return cp ? { note, size: cp.size } : null;
}

// ── Intake ──

/** Row fields the intake may mask in place; a secret anywhere else (chain, writer, stream) refuses the row. */
const MASKABLE = ["app", "kind", "severity", "title", "session", "ref", "data", "src"] as const;
const INTAKE_MASKED = "intake-masked";

/** What the intake decided about a body it did not store as sent. Content-free: codes and hashes only. */
export type BodyNote =
  | { status: "masked"; sha256: string; masked: string[] }
  | { status: "withheld"; reason: WithholdReason };

/**
 * Where a body's note lives. Releases up to 0.4.4 wrote a permanent "refused" note for an unmasked secret; that note is
 * read as no decision, and since notes are immutable, the decision that replaces it goes to a key of its own (ISC-162).
 */
async function noteKey(env: Env, sha: string): Promise<{ key: string; note: BodyNote | null }> {
  const parse = async (key: string): Promise<BodyNote | { status: "refused" } | null> => {
    const obj = await env.RECORD.get(key);
    if (!obj) return null;
    const note = JSON.parse(await obj.text()) as BodyNote | { status: "refused"; reason?: unknown };
    if (note.status === "masked" && SHA256_HEX.test(note.sha256) && Array.isArray(note.masked)) return note;
    if (note.status === "withheld" && WITHHOLD_REASONS.includes(note.reason)) return note;
    if (note.status === "refused" && key === bodyNoteKey(sha)) return { status: "refused" };
    throw new Error(`body note ${key} is malformed`);
  };
  const first = await parse(bodyNoteKey(sha));
  if (first?.status !== "refused") return { key: bodyNoteKey(sha), note: first };
  const key = `${bodyNoteKey(sha)}.rejudged`;
  return { key, note: (await parse(key)) as BodyNote | null };
}

async function readNote(env: Env, sha: string): Promise<BodyNote | null> {
  return (await noteKey(env, sha)).note;
}

async function writeNote(env: Env, sha: string, note: BodyNote): Promise<unknown> {
  return writeImmutable(env.RECORD, (await noteKey(env, sha)).key, utf8(canonicalJson(note)), "application/json");
}

/** The working directory a payload reports, lifted to the top so the consulting-project rule sees it (as the shipper does). */
function liftCwd(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  for (const k of ["cwd", "project_dir", "projectDir"]) if (typeof d[k] === "string") return d[k] as string;
  const ws = d.workspace as Record<string, unknown> | undefined;
  return ws && typeof ws.current_dir === "string" ? ws.current_dir : undefined;
}

/** A posted row as the provenance rules read it: its payload's cwd lifted to the top, as decideRow does. Non-objects pass through. */
function liftedForDecision(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const cwd = liftCwd((raw as { data?: unknown }).data);
  return cwd ? { ...(raw as object), cwd } : raw;
}

function decideRow(row: CoreRow, provenance: ProvenanceConfig): Decision {
  // A customer chain carries only the shipper's content-free stand-ins; anything else is withheld for its class alone,
  // whatever its content says (the same rule the shipper applies to a v1 customer row).
  if (chainClass(row.chain) === "customer" && !isContentFreeMarker(row)) return { action: "withhold", reason: "customer_class", scope: "row" };
  const cwd = liftCwd(row.data);
  return decide(cwd ? { ...row, cwd } : row, provenance);
}

/** The data keys of each content-free stand-in a shipper sends in a row's place (provenance withheldMarker, ship's integrity and local-only markers). */
const MARKER_DATA_KEYS: Readonly<Record<string, readonly string[]>> = { withheld: ["source", "count", "reason"], "integrity-failed": ["source", "reason"], "local-only": ["source", "stream"] };
/** A marker's string values are store names, opaque ids and reason codes, never text (provenance SOURCE_RE). */
const MARKER_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,159}$/;
const MARKER_ABSENT = ["subject", "op", "app", "severity", "title", "session", "ref", "body", "masked", "flags", "src"] as const;

/** Is this row one of the shipper's content-free markers: stream statvs, a marker kind, data of opaque codes only, no text field? */
function isContentFreeMarker(row: CoreRow): boolean {
  // Own keys only: a kind like "constructor" must not reach Object.prototype.
  const keys = row.stream === "statvs" && typeof row.kind === "string" && Object.prototype.hasOwnProperty.call(MARKER_DATA_KEYS, row.kind) ? MARKER_DATA_KEYS[row.kind] : undefined;
  if (!keys || MARKER_ABSENT.some((k) => row[k] !== undefined)) return false;
  const d = row.data;
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  return Object.entries(d as Record<string, unknown>).every(([k, v]) =>
    keys.includes(k) && (k === "count" ? Number.isInteger(v) && (v as number) >= 1 : typeof v === "string" && MARKER_VALUE_RE.test(v)));
}

/** A body's content judged on its own and as if it came from a Vector app, the strictest reading. */
function decideBody(value: unknown, provenance: ProvenanceConfig): Decision {
  const plain = decide(value, provenance);
  if (plain.action === "withhold") return plain;
  return decide({ app: provenance.vector?.apps[0], cwd: liftCwd(value), data: value }, provenance);
}

const union = (...lists: (readonly string[] | undefined)[]) => [...new Set(lists.flatMap((l) => l ?? []))];

type Checked = { ok: true; row: CoreRow } | { ok: false; reason: string; withhold?: WithholdReason };

/**
 * Every intake check on one row, in order. A row comes back unchanged, or rewritten only to mask a
 * secret, point at a masked body or move masked data that grew past the body threshold into a body.
 */
async function checkRow(raw: unknown, cred: Credential, env: Env, provenance: ProvenanceConfig, maskKey: string): Promise<Checked> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "invalid" };
  const o = raw as Record<string, unknown>;
  // Only v3 and v4 are written now: a v2 row's hash covers its content, so the erasure route could not clear it (ISC-163).
  if ((o.v !== 3 && o.v !== 4) || Object.keys(o).some((k) => !ROW_KEYS.has(k))) return { ok: false, reason: "invalid" };
  if (!parseAnyRow(o).ok) return { ok: false, reason: "invalid" };
  const row = o as unknown as CoreRow;
  // A v4 row names a RES of a GENERA kind, with no personal content in its key (CENSVS ISA F4, ISC-22).
  if (row.v === 4) {
    const problem = subjectProblem(row.subject);
    if (problem) return { ok: false, reason: problem };
  }
  if (row.writer === MARKER_WRITER || row.writer === ERASURE_WRITER) return { ok: false, reason: "reserved-writer" };
  if (!WRITER_RE.test(row.writer)) return { ok: false, reason: "bad-writer" };
  if (!canWrite(cred, row.writer)) return { ok: false, reason: "forbidden-writer" };
  const parts = row.chain.split("|");
  if (parts.length !== 4 || parts.some((p) => p.length === 0) || chainClass(row.chain) === null) return { ok: false, reason: "bad-chain" };
  if (parts[0] !== writerSlug(row.writer)) return { ok: false, reason: "chain-writer-mismatch" };
  if (!(await verifyRowHash(row))) return { ok: false, reason: "bad-hash" };

  let bodySha = row.body;
  let bodyMasked: string[] = [];
  if (row.body !== undefined) {
    const note = await readNote(env, row.body);
    if (note?.status === "withheld") return { ok: false, reason: "withheld", withhold: note.reason };
    if (note?.status === "masked") { bodySha = note.sha256; bodyMasked = note.masked.map((p) => p.replace(/^\$/, "$.data")); }
    if (!(await env.RECORD.head(bodyKey(bodySha!)))) return { ok: false, reason: "missing-body" };
  }
  const d = decideRow(row, provenance);
  if (d.action === "withhold") return { ok: false, reason: "withheld", withhold: d.reason };

  const maskable: Record<string, unknown> = {};
  for (const k of MASKABLE) if (row[k] !== undefined) maskable[k] = row[k];
  const found = scan(maskable);
  if (found.length === 0 && bodySha === row.body) return scan(row).length === 0 ? { ok: true, row } : { ok: false, reason: "unmasked-secret" };

  const fields = { ...row } as unknown as RowFields & { v?: number; hash?: string };
  delete fields.v; delete fields.hash; delete (fields as { content_hash?: string }).content_hash;
  let paths: string[] = [];
  if (found.length > 0) {
    const m = await mask(maskable, maskKey);
    const out = m.value as Record<string, unknown>;
    for (const k of MASKABLE) if (out[k] !== undefined) (fields as Record<string, unknown>)[k] = out[k];
    paths = m.masked;
  }
  if (bodySha !== row.body) { fields.body = bodySha; fields.data_hash = bodySha; }
  if (fields.data !== undefined && needsBody(fields.data)) {
    const text = canonicalJson(fields.data);
    const sha = await sha256Hex(text);
    await writeImmutable(env.RECORD, bodyKey(sha), utf8(text));
    delete fields.data;
    fields.body = sha; fields.data_hash = sha;
  }
  fields.masked = union(row.masked, bodyMasked, paths);
  fields.flags = union(row.flags, [INTAKE_MASKED]);
  const rebuilt = await finalizeRow(fields);
  if (scan(rebuilt).length > 0) return { ok: false, reason: "unmasked-secret" };
  return { ok: true, row: rebuilt };
}

async function postRows(request: Request, env: Env, cred: Credential, now: number): Promise<Response> {
  if (!canWriteAny(cred)) return json({ error: "this credential cannot write" }, 403);
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BATCH_BYTES) return json({ error: `a batch is at most ${MAX_BATCH_BYTES} bytes` }, 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BATCH_BYTES) return json({ error: `a batch is at most ${MAX_BATCH_BYTES} bytes` }, 413);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ error: "body is not JSON" }, 400); }
  const rows = (body as { rows?: unknown })?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return json({ error: "body must be {rows: CoreRow[]} with at least one row" }, 400);
  if (rows.length > MAX_ROWS) return json({ error: `a batch is at most ${MAX_ROWS} rows` }, 413);
  let provenance: ProvenanceConfig;
  try { provenance = parseProvenanceConfig(env.STATVS_PROVENANCE); } catch { return json({ error: "provenance config is not configured" }, 503); }
  const maskKey = env.STATVS_MASK_KEY;
  if (typeof maskKey !== "string" || maskKey.length === 0) return json({ error: "STATVS_MASK_KEY is not configured; the intake cannot mask" }, 503);

  const results: (RowStatus | null)[] = [];
  const accepted: { row: CoreRow; at: number }[] = [];
  const refusals: Refusal[] = [];
  const withheldBy = new Map<WithholdReason, WithheldRow[]>();
  // Whole-session memory within this batch: once any row of a session names a consulting project, every row of that
  // session in the batch is withheld, earlier ones included, whether or not the row itself carries a consulting cwd.
  // The memory is per request; the shipper's cursor carries it between batches.
  const sessionDecisions = decideBatch(rows.map(liftedForDecision), provenance, new Map<string, WithholdReason>());
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] as Record<string, unknown> | null;
    const chain = typeof raw?.chain === "string" ? raw.chain : "";
    const seq = Number.isSafeInteger(raw?.seq) ? (raw!.seq as number) : 0;
    let checked: Checked = await checkRow(raw, cred, env, provenance, maskKey);
    const session = sessionDecisions[i]!;
    if (checked.ok && session.action === "withhold") checked = { ok: false, reason: "withheld", withhold: session.reason };
    if (checked.ok) { accepted.push({ row: checked.row, at: i }); results.push(null); continue; }
    results.push({ chain, seq, status: "refused", reason: checked.reason });
    refusals.push({ chain, seq, reason: checked.reason, hash: typeof raw?.hash === "string" ? raw.hash : undefined });
    if (checked.withhold) {
      // The withheld row's identity, so a resend of this batch is counted once (the sequencer keeps it masked).
      const id: WithheldRow = { chain, seq, ...(typeof raw?.hash === "string" ? { hash: raw.hash } : {}) };
      withheldBy.set(checked.withhold, [...(withheldBy.get(checked.withhold) ?? []), id]);
    }
  }
  const source = `intake:${writerSlug(cred.name).replace(/^[^A-Za-z0-9]+/, "").slice(0, 120) || "writer"}`;
  const withheld: Withholding[] = [...withheldBy].map(([reason, ids]) => ({ source, count: ids.length, reason, rows: ids }));
  const payload: AppendInput = { shard: SHARD, now: new Date(now).toISOString(), rows: accepted.map((a) => a.row), refusals, withheld };
  const res = await sequencer(env).fetch("https://sequencer/append", { method: "POST", body: JSON.stringify(payload) });
  if (!res.ok) return json({ error: "the sequencer refused the batch", detail: ((await res.json()) as { error?: string }).error }, 503);
  const out = (await res.json()) as AppendResult;
  accepted.forEach((a, k) => { results[a.at] = out.results[k]!; });
  return json({ results, markers: out.markers, checkpoint: out.checkpoint });
}

// ── Bodies ──

function noteAnswer(sha: string, note: BodyNote): Response {
  return note.status === "masked"
    ? json({ status: "masked", sha256: sha, masked_sha256: note.sha256 })
    : json({ status: note.status, sha256: sha, reason: note.reason });
}

/**
 * Store a body. Answers 201 stored or masked, or 200 with status duplicate, withheld or refused; a
 * withheld or refused body is never stored and its rows are refused at POST /rows. Every answer is
 * 2xx so a shipper never retries a final decision forever.
 */
/**
 * Count a body the intake refused or withheld when it is first decided, so GET /refusals sees every refusal. It runs
 * before the body note is written: a failure answers 503 and the retry counts it, so a refusal is never lost.
 */
async function countBodyRefusal(env: Env, cred: Credential, sha: string, reason: string): Promise<boolean> {
  const chain = `body:${writerSlug(cred.name).replace(/^[^A-Za-z0-9]+/, "").slice(0, 120) || "writer"}`;
  const payload: AppendInput = { shard: SHARD, now: new Date().toISOString(), rows: [], refusals: [{ chain, seq: -1, reason, hash: sha }], withheld: [] };
  const res = await sequencer(env).fetch("https://sequencer/append", { method: "POST", body: JSON.stringify(payload) });
  return res.ok;
}

async function putBody(request: Request, env: Env, cred: Credential, sha: string): Promise<Response> {
  if (!canWriteAny(cred)) return json({ error: "this credential cannot write" }, 403);
  if (Number(request.headers.get("Content-Length") ?? "0") > MAX_BODY_BYTES) return json({ error: "body too large" }, 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) return json({ error: "body too large" }, 413);
  if ((await sha256Hex(bytes)) !== sha) return json({ error: "hash-mismatch" }, 400);
  const prior = await readNote(env, sha);
  if (prior) return noteAnswer(sha, prior);
  if (await env.RECORD.head(bodyKey(sha))) return json({ status: "duplicate", sha256: sha });
  let provenance: ProvenanceConfig;
  try { provenance = parseProvenanceConfig(env.STATVS_PROVENANCE); } catch { return json({ error: "provenance config is not configured" }, 503); }

  let text: string | null = null;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { text = null; }
  // Not UTF-8: scan a lossy decode. Invalid bytes become U+FFFD and ASCII survives, so a credential still shows.
  let value: unknown = text ?? new TextDecoder().decode(bytes);
  let isJson = false;
  if (text !== null) { try { value = JSON.parse(text); isJson = true; } catch { value = text; } }
  // JSON is inspected as parsed but stored as sent, so the two must be the same document: a duplicate key, whose first
  // value JSON.parse drops, would otherwise be stored unread. Writers send canonical JSON (externalizeBody).
  if (isJson && canonicalJson(value) !== text) return json({ error: "non-canonical-json" }, 400);

  const d = decideBody(value, provenance);
  if (d.action === "withhold") {
    if (!(await countBodyRefusal(env, cred, sha, "withheld"))) return json({ error: "the sequencer did not record the refusal" }, 503);
    const note: BodyNote = { status: "withheld", reason: d.reason };
    await writeNote(env, sha, note);
    return noteAnswer(sha, note);
  }
  if (scan(value).length === 0) {
    await writeImmutable(env.RECORD, bodyKey(sha), bytes);
    return json({ status: "stored", sha256: sha }, 201);
  }
  // No note: the next upload is judged again, so a masker fix rescues the body (ISC-162). The count stays once per body.
  const refuse = async () => {
    if (!(await countBodyRefusal(env, cred, sha, "unmasked-secret"))) return json({ error: "the sequencer did not record the refusal" }, 503);
    return json({ status: "refused", sha256: sha, reason: "unmasked-secret" });
  };
  if (text === null) return refuse();
  const maskKey = env.STATVS_MASK_KEY;
  if (typeof maskKey !== "string" || maskKey.length === 0) return json({ error: "STATVS_MASK_KEY is not configured; the intake cannot mask" }, 503);
  const m = await mask(value, maskKey);
  const out = isJson ? canonicalJson(m.value) : String(m.value);
  if (scan(isJson ? m.value : out).length > 0) return refuse();
  const maskedBytes = utf8(out);
  const maskedSha = await sha256Hex(maskedBytes);
  await writeImmutable(env.RECORD, bodyKey(maskedSha), maskedBytes);
  await writeNote(env, sha, { status: "masked", sha256: maskedSha, masked: m.masked });
  return json({ status: "masked", sha256: sha, masked_sha256: maskedSha }, 201);
}

async function getBody(env: Env, cred: Credential, sha: string): Promise<Response> {
  const vis = visibility(cred);
  if (!vis) return json({ error: "this credential cannot read" }, 403);
  if (!readsAll(cred) && !(await bodyVisible(indexDatabases(env), sha, vis.streams, vis.classes))) return json({ error: "outside this credential's streams and classes" }, 403);
  const obj = await env.RECORD.get(bodyKey(sha));
  if (!obj) return json({ error: "not found" }, 404);
  return new Response(await obj.arrayBuffer(), { headers: { "Content-Type": "application/octet-stream", "X-Sha256": sha } });
}

// ── Reads ──

async function getRows(url: URL, env: Env, cred: Credential): Promise<Response> {
  const vis = visibility(cred);
  if (!vis) return json({ error: "this credential cannot read" }, 403);
  const p = url.searchParams;
  const fromMs = timeParam(p.get("from")), toMs = timeParam(p.get("to"));
  if (fromMs === null || toMs === null) return json({ error: "from and to must be times" }, 400);
  const limit = intParam(p.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  if (limit === null) return json({ error: "limit must be an integer in range" }, 400);
  const orderParam = p.get("order");
  if (orderParam !== null && orderParam !== "ts" && orderParam !== "offset") return json({ error: "order is ts or offset" }, 400);
  // Time queries sort by when a row happened (ISC-54); an unbounded read folds by ingest offset (ISC-75).
  const order: "ts" | "offset" = orderParam ?? (fromMs !== undefined || toMs !== undefined ? "ts" : "offset");
  let afterOffset = -1;
  let afterTs: { tsMs: number; offset: number } | undefined;
  if (order === "ts") {
    if (p.get("after_offset")) return json({ error: "after_offset pages ingest order; time order pages with next=<ts_ms>:<offset>" }, 400);
    const next = p.get("next");
    if (next) {
      const m = /^(-?\d{1,16}):(\d{1,16})$/.exec(next);
      if (!m) return json({ error: "next must be <ts_ms>:<offset> in time order" }, 400);
      afterTs = { tsMs: Number(m[1]), offset: Number(m[2]) };
    }
  } else {
    const a = intParam(p.get("after_offset") ?? p.get("next"), -1, -1, Number.MAX_SAFE_INTEGER);
    if (a === null) return json({ error: "after_offset must be an integer in range" }, 400);
    afterOffset = a;
  }
  const narrow = (name: string, allowed: string[] | undefined): string[] | undefined | null => {
    const v = p.get(name) || undefined;
    if (v === undefined) return allowed;
    return allowed === undefined || allowed.includes(v) ? [v] : null;
  };
  // One RES's rows (CENSVS ISA F4, ISC-25): in ingest order unless a time window asks for time order.
  const subject = p.get("subject") || undefined;
  if (subject !== undefined && parseSubject(subject) === null) return json({ error: "subject must be <kind>:<key>" }, 400);
  const streams = narrow("stream", vis.streams), classes = narrow("class", vis.classes);
  if (streams === null || classes === null) return json({ error: "outside this credential's streams and classes" }, 403);
  const page = await queryIndex(indexDatabases(env), {
    shard: SHARD, fromMs, toMs, streams, classes, order, afterOffset, afterTs, limit,
    writer: p.get("writer") || undefined, session: p.get("session") || undefined, chain: p.get("chain") || undefined, subject,
  });
  // A page spans many small segments (one per ship run), so they are read side by side, six at a time (the Workers
  // limit on open connections), never one after another (migration ISA ISC-179: 434 rows took six seconds serially).
  const keys = [...new Set(page.entries.map((e) => e.segment))];
  // A failed read is held, not thrown, so the page fails on the first bad entry in index order, as a serial read did.
  const segments = new Map<string, Map<number, Ingested> | { failed: unknown }>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(SEGMENT_READS, keys.length) }, async () => {
    while (next < keys.length) {
      const key = keys[next++]!;
      try { segments.set(key, new Map((await readSegment(env.RECORD, key)).map((r) => [r.offset, r]))); }
      catch (failed) { segments.set(key, { failed }); }
    }
  }));
  const rows: Ingested[] = [];
  for (const e of page.entries) {
    const seg = segments.get(e.segment)!;
    if (!(seg instanceof Map)) throw seg.failed;
    const row = seg.get(e.ingest_offset);
    if (!row || row.hash !== e.hash) throw new Error(`index entry ${e.ingest_offset} does not match segment ${e.segment}`);
    rows.push(row);
  }
  return json(page.next === undefined ? { rows } : { rows, next: page.next });
}

/** Segment reads in flight at once on a rows page. */
const SEGMENT_READS = 6;

async function getProof(url: URL, env: Env): Promise<Response> {
  const latest = await latestCheckpoint(env);
  if (!latest) return json({ error: "no checkpoint yet" }, 404);
  const second = intParam(url.searchParams.get("second"), latest.size, 0, latest.size);
  const first = second === null ? null : intParam(url.searchParams.get("first"), 0, 0, second);
  if (first === null || second === null) return json({ error: `need 0 <= first <= second <= ${latest.size}` }, 400);
  const proof = await consistencyProof(tileHashReader(r2TileStore(env.RECORD, SHARD), second), first, second);
  return json({ first, second, proof: proof.map(toHex) });
}

// ── The handler ──

export interface WorkerOptions {
  /** Clock in epoch ms (tests inject one to prove the revocation window). */
  now?: () => number;
}

export function createWorker(opts: WorkerOptions = {}) {
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { cred: Credential | null; at: number }>();

  async function authenticate(request: Request, env: Env): Promise<Credential | null> {
    const token = bearer(request);
    if (!token) return null;
    const key = await sha256Hex(token);
    const t = now();
    const hit = cache.get(key);
    if (hit && t - hit.at < AUTH_CACHE_MS && t >= hit.at) return hit.cred;
    const row = await env.CONTROL.prepare("SELECT name, scopes FROM credentials WHERE token_sha256 = ? AND revoked_at IS NULL").bind(key).first<{ name: string; scopes: string }>();
    const cred = row ? { name: row.name, scopes: parseScopes(row.scopes) } : null;
    cache.set(key, { cred, at: t });
    if (cache.size > 10_000) cache.delete(cache.keys().next().value!);
    return cred;
  }

  async function route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/health") return request.method === "GET" ? json({ ok: true, service: "lifeos-statvs-core", version: VERSION, schema: SCHEMA_VERSION }) : json({ error: "method not allowed" }, 405);
    const cred = await authenticate(request, env);
    if (!cred) return json({ error: "unauthorized" }, 401);

    if (path === "/rows") {
      if (request.method === "POST") return postRows(request, env, cred, now());
      if (request.method === "GET") return getRows(url, env, cred);
      return json({ error: "method not allowed" }, 405);
    }
    const bodyMatch = /^\/bodies\/([^/]+)$/.exec(path);
    if (bodyMatch) {
      const sha = bodyMatch[1]!;
      if (!SHA256_HEX.test(sha)) return json({ error: "a body is named by its lowercase sha256" }, 400);
      if (request.method === "PUT") return putBody(request, env, cred, sha);
      if (request.method === "GET") return getBody(env, cred, sha);
      return json({ error: "method not allowed" }, 405);
    }
    if (path === "/erase") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      // Only the erase credential, which no writer or reader holds (ISC-65).
      if (!cred.scopes.includes(ERASE_SCOPE)) return json({ error: "needs the erase scope" }, 403);
      let body: unknown;
      try { body = await request.json(); } catch { return json({ error: "body is not JSON" }, 400); }
      const res = await sequencer(env).fetch("https://sequencer/erase", { method: "POST", body: JSON.stringify({ shard: SHARD, now: new Date(now()).toISOString(), request: body }) });
      return json(await res.json(), res.status);
    }
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

    if (path === "/gaps" || path === "/refusals") {
      if (!readsAll(cred)) return json({ error: "needs read:*" }, 403);
      const chain = url.searchParams.get("chain");
      if (path === "/gaps" && !chain) return json({ error: "chain is required" }, 400);
      const target = path === "/gaps" ? `https://sequencer/gaps?chain=${encodeURIComponent(chain!)}` : "https://sequencer/refusals";
      const res = await sequencer(env).fetch(target);
      return json(await res.json(), res.status);
    }
    if (!readsAny(cred)) return json({ error: "this credential cannot read" }, 403);
    if (path === "/checkpoint") {
      const latest = await latestCheckpoint(env);
      return latest ? new Response(latest.note, { headers: { "Content-Type": "text/plain; charset=utf-8" } }) : json({ error: "no checkpoint yet" }, 404);
    }
    if (path === "/proof/consistency") return getProof(url, env);
    if (path === "/key") {
      const signer = typeof env.STATVS_SIGNING_KEY === "string" ? await parseSignerKey(env.STATVS_SIGNING_KEY) : null;
      return signer ? new Response(verifierFromSigner(signer.name, signer.id, signer.publicKey) + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } }) : json({ error: "signing key not configured" }, 503);
    }
    if (path.startsWith("/tile/")) {
      const tile = path.slice(1);
      const parsed = parseTilePath(tile);
      if (!parsed || parsed.level === "entries") return json({ error: "not a hash tile path" }, 404);
      const obj = await env.RECORD.get(tileKey(SHARD, tile));
      return obj ? new Response(await obj.arrayBuffer(), { headers: { "Content-Type": "application/octet-stream" } }) : json({ error: "not found" }, 404);
    }
    return json({ error: "not found" }, 404);
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      let res: Response;
      try {
        res = await route(request, env);
      } catch (e) {
        console.error(`statvs-core: ${(e as Error).message}`);
        res = json({ error: "internal error" }, 500);
      }
      res = new Response(res.body, res);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.headers.set(name, value);
      return res;
    },
  };
}

export default createWorker();
