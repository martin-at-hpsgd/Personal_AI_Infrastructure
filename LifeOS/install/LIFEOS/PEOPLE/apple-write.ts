/**
 * @version 0.1.0
 *
 * People — the Apple Contacts WRITE half (ISC-11, ISC-13, ISC-33).
 *
 * This module exists so that the guarantee "a sync or a merge never writes an
 * Apple card" is structural rather than a convention. Before 2026-09-11 the
 * whole adapter lived in `apple.ts`, and the only thing standing between an
 * ingest module and `createCard` was an origin token — a public string any
 * importer could name. The token is still here as defense in depth, but it is
 * no longer the boundary.
 *
 * The boundary is the import graph. Only `People.ts` imports this file, and
 * only inside the `add` command branch, through a dynamic `import()`. The
 * scheduled tick, the merge pass and every ingest source have no static path to
 * it, which `tests/boundary.test.ts` asserts by walking the graph.
 *
 * `apple.ts` is the read half — `readAllCards`, `countCards` — and is imported
 * freely. Reads need no capability.
 *
 * Two rules still hold on both sides of the process boundary, in Swift and
 * again here, because either side can be called alone:
 *
 *   1. Identity fields only. A patch key outside IDENTITY_FIELDS is refused
 *      before the Swift process is spawned (ISC-13). There is no delete path.
 *   2. Commanded writes only. createCard/updateCard take an origin token and
 *      accept exactly one value, "people-cli" (ISC-33).
 */
import { AppleAdapterError, appleId, contactIdentifier, ensureContactsBin, toCard, type AppleCard, type SwiftRow } from "./apple";
import { IDENTITY_FIELDS, type IdentityFields } from "./types";

// ── typed refusal ─────────────────────────────────────────────────────────────

/** Thrown before any Swift process starts. Carries the offending keys (ISC-13). */
export class AppleWriteRefused extends Error {
  constructor(
    public readonly reason: "foreign-fields" | "read-only-field" | "bad-origin" | "empty-patch",
    public readonly detail: string,
  ) {
    super(`apple write refused (${reason}): ${detail}`);
    this.name = "AppleWriteRefused";
  }
}

// ── the origin gate (ISC-33) ──────────────────────────────────────────────────

/**
 * The one token that authorizes an Apple write. It exists so that the capability to
 * write a card is something a caller must be handed, not something any importer has.
 * Only `people add` passes it; the tick, the merge pass and every ingest
 * source do not, and cannot invent a different one that passes.
 *
 * Defense in depth only. The import graph is the primary control: a module with
 * no path to this file cannot reach the token either.
 */
export type WriteOrigin = "people-cli";
export const PEOPLE_CLI: WriteOrigin = "people-cli";

/** Runtime check, because TypeScript's is erased and a cast would slip past it. */
export function writeOrigin(origin: unknown): WriteOrigin {
  if (origin !== PEOPLE_CLI) {
    throw new AppleWriteRefused(
      "bad-origin",
      `only ${JSON.stringify(PEOPLE_CLI)} may write Apple cards, got ${JSON.stringify(origin)}`,
    );
  }
  return origin;
}

// ── the write-scope guard (ISC-13) ────────────────────────────────────────────

const IDENTITY_KEYS: ReadonlySet<string> = new Set<string>(IDENTITY_FIELDS);
/** Identity, but written by the photo path (`ContactImages.ts set`), never by this adapter. */
const READ_ONLY_KEYS: ReadonlySet<string> = new Set(["hasPhoto"]);

/** Throws unless every key of `patch` is a writable identity field. Never mutates. */
export function assertIdentityOnly(patch: object): void {
  const keys = Object.keys(patch);
  const foreign = keys.filter((k) => !IDENTITY_KEYS.has(k)).sort();
  if (foreign.length) {
    throw new AppleWriteRefused("foreign-fields", `outside the identity set: ${foreign.join(", ")}`);
  }
  const readOnly = keys.filter((k) => READ_ONLY_KEYS.has(k)).sort();
  if (readOnly.length) {
    throw new AppleWriteRefused(
      "read-only-field",
      `read-only here: ${readOnly.join(", ")} — photo bytes are written by ContactImages set, so omit this key`,
    );
  }
}

// ── writes ────────────────────────────────────────────────────────────────────

/** Max argv payload. An identity patch is a few hundred bytes; macOS ARG_MAX is ~1MB. */
const MAX_PATCH_BYTES = 128_000;

async function runWrite(argv: string[], patch: object): Promise<string> {
  const bin = await ensureContactsBin();
  const json = JSON.stringify(patch);
  // The patch goes on argv, not stdin. The Swift CLI accepts both, but a piped stdin
  // between Bun and a short-lived child raced under `bun test` (the child blocked on
  // readDataToEndOfFile, or died before the flush landed); argv has no such window.
  if (Buffer.byteLength(json, "utf8") > MAX_PATCH_BYTES) {
    throw new AppleWriteRefused("foreign-fields", `patch is ${Buffer.byteLength(json, "utf8")} bytes, over the ${MAX_PATCH_BYTES} limit`);
  }
  const proc = Bun.spawn([bin, ...argv, json], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    const msg = err.trim() || out.trim() || "(no output)";
    // Exit 3 is the Swift side's own write-scope refusal; report it as the same typed error.
    if (code === 3) throw new AppleWriteRefused("foreign-fields", msg);
    throw new AppleAdapterError(`ContactsCli ${argv[0]} exited ${code}: ${msg}`);
  }
  return out;
}

/**
 * Creates one card in Contacts.app and returns its store id (ISC-11).
 * `origin` must be PEOPLE_CLI: only an explicit command creates cards.
 */
export async function createCard(fields: IdentityFields, origin: WriteOrigin): Promise<{ id: string }> {
  writeOrigin(origin);
  assertIdentityOnly(fields);
  const named = [fields.name, fields.givenName, fields.familyName, fields.org].some((v) => v?.trim());
  if (!named) throw new AppleWriteRefused("empty-patch", "create needs one of name, givenName, familyName, org");
  const out = await runWrite(["create"], fields);
  const parsed = JSON.parse(out) as { id?: string };
  if (!parsed.id) throw new AppleAdapterError(`ContactsCli create returned no id: ${out.trim()}`);
  return { id: appleId(parsed.id) };
}

/**
 * Replaces only the identity fields present in `patch` on an existing card (ISC-13).
 * Arrays replace wholesale: a patch carrying `emails` defines the card's full email list.
 * `origin` must be PEOPLE_CLI, so a sync-derived merge cannot reach this (ISC-33).
 */
export async function updateCard(
  id: string,
  patch: Partial<IdentityFields>,
  origin: WriteOrigin,
): Promise<AppleCard> {
  writeOrigin(origin);
  assertIdentityOnly(patch);
  if (Object.keys(patch).length === 0) throw new AppleWriteRefused("empty-patch", `nothing to write on ${id}`);
  const identifier = contactIdentifier(id);
  const out = await runWrite(["update", identifier], patch);
  return toCard(JSON.parse(out) as SwiftRow);
}
