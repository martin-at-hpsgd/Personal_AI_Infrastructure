/**
 * STATVS core — the RES subject a row is about (CENSVS ISA F4, ISC-19..ISC-25).
 *
 * From schema v4 a row may name the RES it changes in `subject` ("<kind>:<key>") and say how in `op`. `op` is covered
 * by the row's hash and Merkle leaf and is never erasable: it is one word from a closed list. `subject` sits in the
 * text group (row.ts TEXT_FIELDS), so content_hash commits to it and the erasure route can clear it with the title.
 * A subject should carry no personal content, because the local writer and this intake both refuse a key that looks
 * personal; erasure is the remedy for one that slips through.
 *
 * The kind list is GENERA's (LIFEOS/CENSVS/genera.ts), inlined here because the Worker bundle ships only what sits
 * under core/ and its release record covers only core/. A test holds this list equal to Object.keys(GENERA), with
 * each kind's key scheme and key grammar, and holds KEY_GRAMMARS equal to GENERA's source for source, so a kind or
 * grammar changed there fails the core suite until it is changed here in the same commit (CENSVS ISA ISC-60).
 *
 * The local writer also refuses a natural key that holds a first name then a surname from the People store; that
 * list lives only on the principal's machine, so the Worker applies the key grammars and opaque kinds, never names.
 *
 * Rows written before v4 carry no subject. deriveSubject() is the one deterministic resolver that names the RES an
 * old row is about, from fields the row already carries; the index stores its answer (a rebuildable view), never
 * R2, so no stored row changes. The live index, tools/rebuild.ts and tools/backfill-subject.ts all call it through
 * indexSubject(), so a rebuilt index equals the live one.
 *
 * Pure: no node: imports, so the Worker bundle can import it.
 *
 * @version 0.1.0
 */

/** How a row changes its subject; the same list as GENERA's OPS. */
export const OPS = ["create", "set", "move", "link", "unlink", "observe", "retire"] as const;
export type Op = (typeof OPS)[number];

/** GENERA's key grammars (KEY_GRAMMARS), source for source; tests/v4.test.ts fails when the two differ. */
export const KEY_GRAMMARS = Object.freeze({
  slug: /^[a-z0-9][a-z0-9_-]*$/,
  dotted: /^[a-z0-9][a-z0-9._:-]*$/,
  code: /^_?[A-Za-z][A-Za-z0-9_-]*$/,
  isa: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  criterion: /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Z][A-Za-z0-9._#-]*$/,
  ref: /^[A-Za-z]{1,6}-?\d{1,6}$/,
  scoped_ref: /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z]{1,6}-?\d{1,6}$/,
  errata: /^ERR-\d{1,8}(?:-\d{6})?(?:-[0-9a-z]{1,12})?$/,
  achilles: /^ACH-\d{1,6}$/,
  socrates: /^SOC-\d{1,6}$/,
  proposal: /^(?:[a-z0-9][a-z0-9_-]*|[A-Z]{1,6}-\d{1,6})$/,
  hostname: /^(?:\*\.)?[a-z0-9_][a-z0-9_-]*(?:\.[a-z0-9_][a-z0-9_-]*)+$/,
  dns: /^(?:dns:)?[a-z0-9][a-z0-9._-]*[/:][A-Z]{1,10}[/:][a-z0-9_*@][a-z0-9._*-]*$/,
  repo: /^[a-z0-9-]+:(?:[a-z]+:)?[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9._-]+$/,
  model: /^[a-z0-9][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._@/:-]*$/,
  env: /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
  id: /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/,
  release: /^[a-z0-9][a-z0-9._-]*[@:]v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
} as const);
export type GrammarName = keyof typeof KEY_GRAMMARS;

/**
 * Every GENERA kind and its key scheme: "opaque" kinds take a minted key, never a readable one; every other kind
 * names the key grammar its keys must match. Generated from LIFEOS/CENSVS/genera.ts; tests/v4.test.ts fails when the
 * two differ.
 */
export const RES_KINDS: Readonly<Record<string, "opaque" | GrammarName>> = Object.freeze({
  goal: "ref", risk: "ref", question: "socrates", decision: "scoped_ref",
  isa: "isa", criterion: "criterion", issue: "errata", followup: "slug", proposal: "proposal", finding: "achilles", release: "release",
  session: "id", run: "id", case: "id", suite: "slug",
  skill: "code", hook: "code", agent: "code", workflow: "slug", tool: "code", model: "model", system: "slug", stream: "slug", view: "slug",
  app: "dotted", service: "dotted", domain: "hostname", dns_record: "dns", store: "dotted", repo: "repo", machine: "dotted",
  credential: "env", ingest: "slug", capability: "slug", control: "slug", account: "opaque", project: "slug",
  person: "opaque", org: "opaque", place: "opaque",
  note: "opaque", source: "opaque", piece: "opaque", media: "opaque",
});

export const SUBJECT_MAX = 256;
const SUBJECT_RE = /^([a-z_]+):(\S+)$/;
/** A minted opaque key (GENERA OPAQUE_KEY_RE): up to two letters, then 5-40 lowercase hex characters, at least one digit. */
const OPAQUE_KEY_RE = /^(?=[a-z0-9]*\d)[a-z]{0,2}[0-9a-f]{5,40}$/;
// GENERA's looksPersonal patterns: an email, an international or grouped phone number outside a YYYYMMDD-HHMMSS
// stamp, a two-word capitalized name.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const PHONE_INTL_RE = /\+\d[\d\s().-]{6,}\d/;
const PHONE_GROUPED_RE = /(?:^|\D)\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}(?!\d)/;
const NAME_RE = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/;
const STAMP_RE = /(?<!\d)(?:19|20)\d{6}[-_T]?\d{6}(?!\d)/g;

/** `<kind>:<key>` → its parts, or null when it does not fit the grammar. Says nothing about whether the kind exists. */
export function parseSubject(s: unknown): { kind: string; key: string } | null {
  if (typeof s !== "string" || s.length > SUBJECT_MAX) return null;
  const m = SUBJECT_RE.exec(s);
  return m ? { kind: m[1]!, key: m[2]! } : null;
}

function looksPersonal(s: string): boolean {
  const t = s.replace(STAMP_RE, "~");
  return EMAIL_RE.test(s) || PHONE_INTL_RE.test(t) || PHONE_GROUPED_RE.test(t) || NAME_RE.test(s);
}

/**
 * Why a subject may not be written, as an intake refusal code, or null when it may. Mirrors GENERA validSubject()
 * without the People name check: a key outside its kind's grammar is a bad subject, a readable key on an opaque
 * kind or an email or phone in any key is a personal one.
 */
export function subjectProblem(s: unknown): null | "bad-subject" | "unregistered-kind" | "personal-subject" {
  const p = parseSubject(s);
  if (!p) return "bad-subject";
  if (!Object.hasOwn(RES_KINDS, p.kind)) return "unregistered-kind";
  if (looksPersonal(p.key)) return "personal-subject";
  const scheme = RES_KINDS[p.kind]!;
  if (scheme === "opaque") return OPAQUE_KEY_RE.test(p.key) ? null : "personal-subject";
  return KEY_GRAMMARS[scheme].test(p.key) ? null : "bad-subject";
}

export function isOp(op: unknown): op is Op {
  return typeof op === "string" && (OPS as readonly string[]).includes(op);
}

/** The fields deriveSubject reads: what an ingested row or an index entry carries. */
export interface SubjectSource {
  stream: string;
  kind?: string | null;
  app?: string | null;
  session?: string | null;
  data?: unknown;
  subject?: string | null;
}

/** Streams whose rows name an app (STATVS ISA F8): each is about the app it names. */
const APP_STREAMS: ReadonlySet<string> = new Set(["deploy", "release", "app-health", "app-event", "app-error"]);
/** Every stream deriveSubject() can name a subject for; a row of any other stream derives none. */
export const DERIVABLE_STREAMS: readonly string[] = ["work", "turn", ...APP_STREAMS];
/** Streams whose subject is read from the payload, which the index does not hold: a backfill fetches the full row. */
export const PAYLOAD_STREAMS: readonly string[] = ["work"];

function candidate(kind: string, key: unknown): string | null {
  if (typeof key !== "string" || key.length === 0) return null;
  const s = `${kind}:${key}`;
  return subjectProblem(s) === null ? s : null;
}

/**
 * The RES an old row is about, from what it already carries, or null. Deterministic and pure:
 *  - a `work` stream row (kind event or seed-row) is about the ISA its data names: isa:<data.slug>;
 *  - a deploy, release or app-* row that names an app is about that app: app:<app>;
 *  - a `turn` row that carries a session is about that session: session:<id>.
 * A derived subject that would not pass the intake (a key with whitespace, a personal-looking key) is null.
 * Streams are matched on their local name; a shipped row keeps its stream unchanged.
 */
export function deriveSubject(row: SubjectSource): string | null {
  if (row.stream === "work") {
    if (row.kind !== "event" && row.kind !== "seed-row") return null;
    const d = row.data;
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    return candidate("isa", (d as { slug?: unknown }).slug);
  }
  if (APP_STREAMS.has(row.stream)) return candidate("app", row.app);
  if (row.stream === "turn") return candidate("session", row.session);
  return null;
}

/** The subject the index records for a row: the one it names (v4), else the derived one. */
export function indexSubject(row: SubjectSource): string | null {
  return typeof row.subject === "string" ? row.subject : deriveSubject(row);
}
