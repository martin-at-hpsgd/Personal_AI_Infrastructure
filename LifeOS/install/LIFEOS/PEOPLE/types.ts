/**
 * @version 0.1.0
 *
 * People — shared type contract for the one local people system.
 * ISA: LIFEOS/PEOPLE/ISA.md (maintainer-side state of record, not in the release). Every module under LIFEOS/PEOPLE imports from here;
 * nothing here reads or writes files.
 *
 * Data lives under lifeosUserDir()/CONTACTS/ (private USER tree, release-excluded):
 *   contacts.jsonl       one PersonRecord per line — THE store
 *   interactions.jsonl   append-only InteractionEvent per line
 *   runs.jsonl           one TickRun per tick
 * All three are plain JSONL, mode 0600 (ISC-1, ISC-37).
 */

// ── identity (the Apple-synced half) ──────────────────────────────────────────

/** Fields Apple Contacts and the store keep in step, both ways (ISC-11..13). */
export type IdentityFields = {
  name: string;
  givenName?: string;
  familyName?: string;
  nickname?: string;
  org?: string;
  /** true when the Apple card is an organization card (company: true). */
  isOrganization?: boolean;
  emails: string[]; // normalized lowercase, deduped
  phones: string[]; // as stored by Contacts (display form), deduped
  addresses: PostalAddress[];
  urls: string[];
  hasPhoto?: boolean; // photo bytes never live in the store
};

export type PostalAddress = {
  label?: string; // home | work | other
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

export const IDENTITY_FIELDS = [
  "name", "givenName", "familyName", "nickname", "org", "isOrganization",
  "emails", "phones", "addresses", "urls", "hasPhoto",
] as const satisfies readonly (keyof IdentityFields)[];

// ── provenance (ISC-6, ISC-7, ISC-7.1) ────────────────────────────────────────

export type Source = "addressbook" | "email" | "calendar" | "curated" | "stripe" | "beehiiv" | "people-cli";

export type FieldProvenance = { source: Source; at: string }; // at = ISO-8601

/** A value that lost a per-field merge, kept so the merge is reversible. */
export type RetainedValue = { field: string; value: unknown; source: Source; at: string; replacedAt: string };

// ── class (ISC-8, ISC-8.1) ────────────────────────────────────────────────────

export type PersonClass = "personal" | "business" | "both" | "unknown";

// ── customer state (ISC-19..21) ───────────────────────────────────────────────

export type CustomerState = {
  stripe?: { active: boolean; lifetime_paid_cents: number; first?: string; last?: string; customer_ids: string[] };
  newsletter?: { status: string; tier?: string; subscribed_at?: string };
};

// ── the record ────────────────────────────────────────────────────────────────

export type PersonRecord = IdentityFields & {
  /** "ab:<CNContact identifier>" for Apple-mirrored records, "email:<addr>" otherwise. Stable. */
  id: string;
  sources: Source[];
  provenance: Partial<Record<keyof IdentityFields, FieldProvenance>>;
  history: RetainedValue[];
  /** Derived by the one rule function in class.ts. */
  class: PersonClass;
  /** Curated hand override; wins over `class` when present (ISC-8.1). */
  class_override?: PersonClass;
  /** Curated "these ids are one human" edges; the only non-identifier way records fold (ISC-32). */
  same_as?: string[];
  relationship?: string; // curated annotation, verbatim
  tags?: string[];
  customer?: CustomerState;
  /** Cached rollup from interactions.jsonl; recomputed on merge, never authoritative. */
  interactions?: InteractionRollup;
  summary?: string;
  summary_updated?: string;
  updated: string; // ISO-8601
};

// ── interaction ledger (ISC-15..18, ISC-40) ───────────────────────────────────

export type InteractionKind = "email" | "calendar" | "text" | "call" | "meeting" | "note";

export type InteractionEvent = {
  /** PersonRecord.id */
  person: string;
  kind: InteractionKind;
  at: string; // ISO-8601
  source: Source;
  /** Source-unique reference (Gmail message id, calendar event id). (source, ref) is the dedupe key (ISC-18). */
  ref: string;
  direction?: "in" | "out" | "both";
  /** email only: derived from List-Unsubscribe / Auto-Submitted / Precedence (ISC-40). */
  automated?: boolean;
  subject?: string;
};

export type InteractionRollup = {
  total: number; // human interactions (automated excluded, ISC-40.1)
  automated: number;
  byKind: Partial<Record<InteractionKind, number>>;
  first?: string;
  last?: string;
};

// ── tick (ISC-26, ISC-27, ISC-38, ISC-39) ─────────────────────────────────────

export type SourceName = "apple" | "gmail" | "calendar" | "stripe" | "beehiiv" | "merge";
/**
 * `blocked` is deliberately distinct from `failed`: a blocked source is waiting on a
 * human grant (a macOS TCC permission, a re-auth) and no amount of fixing code will
 * clear it, while `failed` is ours to repair. Collapsing the two cost 11 days of dark
 * Apple ingest in 2026-09, because a permission prompt read as just another error.
 */
export const SOURCE_STATUSES = ["ok", "failed", "skipped", "blocked"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export type TickRun = {
  at: string;
  sources: Record<SourceName, { status: SourceStatus; ms: number; note?: string }>;
};

// ── Business projection (ISC-30, ISC-35, ISC-36) ────────────────────────────────

/**
 * The ONLY shape that may leave the machine. Allowlist, never the record.
 *
 * It carries no personal VALUES, only business-domain identity and the shape of
 * the contact history. Two fields were removed on 2026-09-11 after an audit:
 * `role` was copied from `relationship`, a hand-written personal annotation
 * about how the principal knows someone, and per-interaction `subject` was the
 * literal subject line of private mail. Both were business-adjacent by
 * position and personal by content, which is the exact failure this projection
 * exists to prevent. An interaction is now a kind and a timestamp: enough to
 * answer "how often and through what channel", never what was said.
 */
export type BusinessProjection = {
  name: string;
  org?: string;
  emails: string[]; // business-domain emails only
  interactions: { kind: "email" | "calendar" | "meeting"; at: string }[];
};

export class PushRefused extends Error {
  constructor(public readonly id: string, public readonly effectiveClass: PersonClass) {
    super(`push refused: ${id} is classed ${effectiveClass}; only business records may leave the machine`);
    this.name = "PushRefused";
  }
}

export function effectiveClass(r: Pick<PersonRecord, "class" | "class_override">): PersonClass {
  return r.class_override ?? r.class;
}
