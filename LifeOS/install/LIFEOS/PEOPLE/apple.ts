/**
 * @version 0.1.0
 *
 * People — the Apple Contacts READ adapter (ISC-10, ISC-12, ISC-14).
 *
 * Reads every card out of Contacts.app and shapes it as the store's identity
 * half. It shells out to the compiled Swift CLI
 * (ContactsCli.swift, next to this file), which owns the CNContactStore
 * calls; this file owns the typing.
 *
 * Reads are unconditional and need no capability, which is why anything may
 * import this module. The WRITE half lives in `apple-write.ts` and is imported
 * by `People.ts` alone, inside the `add` command, through a dynamic `import()`.
 * That split is the structural form of ISC-33: a sync or merge module has no
 * import path to a card write at all, so the guarantee does not rest on anyone
 * respecting a token. `ensureContactsBin`, `toCard`, `appleId` and
 * `contactIdentifier` are shared with the write half and exported for it.
 */
import { $ } from "bun";
import { existsSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { type IdentityFields, type PostalAddress } from "./types";

// ── the compiled Swift CLI ────────────────────────────────────────────────────
// The source ships here, in the system tree, so a public install needs no private skill. Same cache path and
// same compile-when-stale rule as the contact-photos tool, whose copy of the source tests/apple.test.ts keeps identical.
// That file is a command script (it runs a switch at import), so it cannot be imported
// for its helper; the three lines are replicated rather than the module executed.

const SWIFT_SRC = join(import.meta.dir, "ContactsCli.swift");
const BIN_DIR = join(homedir(), ".cache", "lifeos");
const BIN = join(BIN_DIR, "ContactsCli");

/** Compiles the Swift CLI when stale and returns its path. Shared with apple-write.ts. */
export async function ensureContactsBin(): Promise<string> {
  if (!existsSync(SWIFT_SRC)) throw new AppleAdapterError(`Swift source missing at ${SWIFT_SRC}`);
  mkdirSync(BIN_DIR, { recursive: true });
  if (!existsSync(BIN) || statSync(SWIFT_SRC).mtimeMs > statSync(BIN).mtimeMs) {
    await $`swiftc -O -o ${BIN} ${SWIFT_SRC}`.quiet();
  }
  return BIN;
}

// ── typed errors ──────────────────────────────────────────────────────────────

export class AppleAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleAdapterError";
  }
}

// ── reads ─────────────────────────────────────────────────────────────────────

/** One Apple card, shaped as the store's identity half. `id` is always "ab:<CNContact id>". */
export type AppleCard = IdentityFields & { id: string };

/** The raw row the Swift `audit` subcommand emits. Shared with apple-write.ts. */
export type SwiftRow = {
  id: string;
  name: string;
  givenName: string;
  familyName: string;
  nickname: string;
  org: string;
  type: "person" | "org";
  hasImage: boolean;
  emails: string[];
  phones: string[];
  urls: string[];
  addresses?: { label?: string; street?: string; city?: string; state?: string; postalCode?: string; country?: string }[];
};

type SwiftAudit = { generatedAt: string; total: number; contacts: SwiftRow[] };

/** "ab:" + the CNContact identifier. The one place the prefix is applied. */
export function appleId(identifier: string): string {
  return `ab:${identifier}`;
}

/** Strips the "ab:" prefix back off. Throws on an id that is not Apple-mirrored. */
export function contactIdentifier(id: string): string {
  if (!id.startsWith("ab:")) throw new AppleAdapterError(`not an Apple-mirrored id: ${id}`);
  return id.slice(3);
}

function nonEmpty(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t ? t : undefined;
}

function toAddress(a: NonNullable<SwiftRow["addresses"]>[number]): PostalAddress {
  const out: PostalAddress = {};
  if (nonEmpty(a.label)) out.label = a.label!.trim();
  if (nonEmpty(a.street)) out.street = a.street!.trim();
  if (nonEmpty(a.city)) out.city = a.city!.trim();
  if (nonEmpty(a.state)) out.state = a.state!.trim();
  if (nonEmpty(a.postalCode)) out.postalCode = a.postalCode!.trim();
  if (nonEmpty(a.country)) out.country = a.country!.trim();
  return out;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

export function toCard(row: SwiftRow): AppleCard {
  const card: AppleCard = {
    id: appleId(row.id),
    // An org card's display name lives in organizationName, so `name` falls back to it
    // rather than coming back empty for every company card.
    name: nonEmpty(row.name) ?? nonEmpty(row.org) ?? "",
    emails: dedupe(row.emails.map((e) => e.trim().toLowerCase())),
    phones: dedupe(row.phones.map((p) => p.trim())),
    addresses: (row.addresses ?? []).map(toAddress).filter((a) => Object.keys(a).length > 0),
    urls: dedupe(row.urls.map((u) => u.trim())),
    hasPhoto: row.hasImage,
  };
  if (nonEmpty(row.givenName)) card.givenName = row.givenName.trim();
  if (nonEmpty(row.familyName)) card.familyName = row.familyName.trim();
  if (nonEmpty(row.nickname)) card.nickname = row.nickname.trim();
  if (nonEmpty(row.org)) card.org = row.org.trim();
  if (row.type === "org") card.isOrganization = true;
  return card;
}

async function runAudit(): Promise<SwiftAudit> {
  const bin = await ensureContactsBin();
  const proc = Bun.spawn([bin, "audit"], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new AppleAdapterError(`ContactsCli audit exited ${code}: ${err.trim() || "(no stderr)"}`);
  let parsed: SwiftAudit;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new AppleAdapterError(`ContactsCli audit emitted unparseable JSON (${out.length} bytes)`);
  }
  if (!Array.isArray(parsed.contacts)) {
    throw new AppleAdapterError("ContactsCli audit carried no contacts array");
  }
  return parsed;
}

/** Every card in Contacts.app, as identity records (ISC-10, ISC-12). */
export async function readAllCards(): Promise<AppleCard[]> {
  const audit = await runAudit();
  return audit.contacts.map(toCard);
}

/** Card count straight from the Swift audit total, for the ISC-10 probe. */
export async function countCards(): Promise<number> {
  const audit = await runAudit();
  return typeof audit.total === "number" ? audit.total : audit.contacts.length;
}

// ── writes ────────────────────────────────────────────────────────────────────
//
// There are none here, by design. `createCard`, `updateCard` and the origin gate
// live in `apple-write.ts`, which only `People.ts` imports, and only inside the
// `add` command through a dynamic `import()`. A module that ingests or merges
// has no path to a card write (ISC-33).
