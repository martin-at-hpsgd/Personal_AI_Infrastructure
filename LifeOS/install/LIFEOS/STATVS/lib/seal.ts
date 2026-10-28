/**
 * STATVS sealer — rows of `ship: false` streams reach the cloud as ciphertext only (migration ISA F9, ISC-177;
 * CENSVS ISC-46: estate rows never leave the machine unsealed).
 *
 * A row of a stream that never ships still ships a content-free `local-only` marker in its own slot (ship.ts). This
 * module gives it a second, sealed home: it encrypts the row's exact local line, and its object when the payload
 * lives in one, with age to the key that seals `.env`, and appends the ciphertext once as a `sealed-copy` row on the
 * `statvs` stream, in the source row's class, which then ships like any other row. The copy's `ref` is the source
 * id (`statvs:<id>`), so the cloud can say which rows are sealed without fetching a body.
 *
 * Why a copy, not the row's own slot: age output differs on every run, and the shipper's rule is that a resend
 * after a crash sends the same bytes the first attempt sent (the sequencer refuses a different hash at a taken slot
 * as a collision). A copy is written to disk once, so every resend of it is identical.
 *
 * `openSealed` turns a copy back into the source line and refuses anything that fails the checks `verify` runs.
 * @version 1.0.0
 */
import { invariant } from "../../TOOLS/Invariant";
import { decryptBytes, encrypt, sealRecipient } from "./backup";
import { append, objectText, rowIntact, scan } from "./record";
import { streamDef } from "../streams";
import type { PrivacyClass, StatvsRow } from "./types";

export const SEALER = "tool:statvs-sealer";
export const SEALED_KIND = "sealed-copy";
const SOURCE_RE = /^statvs:s[0-9a-f]{24}$/;
const SEALED_CLASSES: PrivacyClass[] = ["public", "system", "personal"];

export interface SealResult {
  /** Copies written this run. */
  sealed: number;
  /** Local-only rows that already had a copy. */
  already: number;
  /** Local-only rows not tried because this run reached its limit (`max` attempts, refused ones included). */
  left: number;
  problems: string[];
}

export interface SealedData { source: string; stream: string; cipher: string }

/** A stream ships unless its definition says `ship: false` (the shipper's own rule, ship.ts streamShips). */
const streamShips = (stream: string) => (streamDef(stream) as { ship?: unknown } | null)?.ship !== false;

const isCopy = (r: { stream?: string; kind?: string; writer?: string }) => r.stream === "statvs" && r.kind === SEALED_KIND && r.writer === SEALER;

/** Copy every local-only row that has no sealed copy yet. Customer rows never leave the machine in any form. */
export function sealPending(opts: { recipient?: string; shipStream?: (stream: string) => boolean; max?: number } = {}): SealResult {
  const ships = opts.shipStream ?? streamShips;
  const max = opts.max ?? 5000;
  const res: SealResult = { sealed: 0, already: 0, left: 0, problems: [] };
  const all = scan({ classes: SEALED_CLASSES });
  res.problems.push(...(all.problems ?? []));
  const have = new Set(all.rows.filter(isCopy).map((r) => r.ref));
  let recipient: string | undefined = opts.recipient;
  let tried = 0;
  for (const row of all.rows) {
    if (row.stream === "statvs" || ships(row.stream)) continue;
    const source = `statvs:${row.id}`;
    if (have.has(source)) { res.already++; continue; }
    if (tried >= max) { res.left++; continue; }
    tried++;
    const line = JSON.stringify(row);
    const object = row.obj ? objectText(row.obj) ?? undefined : undefined;
    // A line that fails verify's checks, or whose object is gone, is never sealed: its copy could not open intact.
    if (!rowIntact(line, object)) { res.problems.push(`${source}: not intact, not sealed`); continue; }
    recipient ??= sealRecipient();
    const cipher = Buffer.from(encrypt(Buffer.from(JSON.stringify(object === undefined ? { line } : { line, object }), "utf8"), recipient)).toString("base64");
    invariant(SOURCE_RE.test(source) && cipher.length > 0, `a sealed copy names its source row and carries ciphertext (${source})`);
    const data: SealedData = { source, stream: row.stream, cipher };
    const w = append({ writer: SEALER, stream: "statvs", class: row.class, kind: SEALED_KIND, title: "Sealed copy of a local-only row", ref: source, data });
    if (!w.ok && "refused" in w) { res.problems.push(`${source}: copy refused (${w.refused})`); continue; }
    // Spooled: the copy lands when the spool drains, which this run cannot see, so it stops rather than copy twice.
    if (!w.ok) { res.sealed++; res.problems.push(`${source}: copy spooled (${w.reason}); the run stopped`); break; }
    have.add(source);
    res.sealed++;
  }
  return res;
}

export type Opened = { ok: true; row: StatvsRow; line: string; object?: string } | { ok: false; reason: string };

/** Open a sealed copy back into its source line. Refused unless the bytes pass verify's checks and are the row the copy names. */
export function openSealed(data: unknown, identity: string): Opened {
  const d = data as Partial<SealedData> | null;
  if (!d || typeof d.cipher !== "string" || typeof d.source !== "string" || typeof d.stream !== "string") return { ok: false, reason: "not a sealed copy" };
  const bytes = Buffer.from(d.cipher, "base64");
  if (bytes.subarray(0, 21).toString("utf8") !== "age-encryption.org/v1") return { ok: false, reason: "not age ciphertext" };
  const plain = decryptBytes(bytes, identity);
  if (!plain) return { ok: false, reason: "does not decrypt with this identity" };
  let env: { line?: unknown; object?: unknown };
  try { env = JSON.parse(Buffer.from(plain).toString("utf8")); } catch { return { ok: false, reason: "envelope unreadable" }; }
  if (typeof env.line !== "string" || (env.object !== undefined && typeof env.object !== "string")) return { ok: false, reason: "envelope unreadable" };
  const object = env.object as string | undefined;
  const row = rowIntact(env.line, object);
  if (!row) return { ok: false, reason: "opened bytes fail verify's checks" };
  if (`statvs:${row.id}` !== d.source || row.stream !== d.stream) return { ok: false, reason: "opened row is not the one the copy names" };
  return { ok: true, row, line: env.line, ...(object !== undefined ? { object } : {}) };
}
