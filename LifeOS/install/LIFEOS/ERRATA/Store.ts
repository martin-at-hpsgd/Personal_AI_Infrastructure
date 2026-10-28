/**
 * @version 1.0.0
 * Store.ts — the Errata ledger on disk.
 *
 *   LIFEOS/USER/ERRATA/errata-YYYY-MM.jsonl        current months (USER git repo)
 *   LIFEOS/USER/ERRATA/archive/errata-YYYY-MM.jsonl.gz   rotated months, still read
 *   ~/.local/state/lifeos/errata/<id>/             attachments, outside git
 *
 * Every line is one JSON object: an Erratum, or a Patch that folds onto an
 * earlier erratum by id at read time. Appends are one write() each so two
 * writers never interleave inside a line; a torn trailing line is skipped on
 * read. Nothing is rewritten in place and no entry is ever deleted.
 *
 * STATVS dual-write (STATVS ISA F16, Errata ISA F-STATVS, step 1 of the five-step migration): every erratum this store
 * appends, and every patch that sets a status or an enrichment, is also one row on the record's `errata` stream
 * (LIFEOS/STATVS/lib/quality.ts recordErratum): id, kind, system, the status after the change, session and output ids.
 * Never the complaint, the context text or the enrichment prose. The ledger keeps writing exactly as before and stays the
 * store every Errata reader uses. Only the real ledger mirrors to the live record; a fixture or scratch ledger mirrors
 * only while the record itself is a scratch one (bun test, STATVS_DIR). A record fault is logged, never thrown.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, unlinkSync } from "fs";
import { createHash, randomBytes } from "crypto";
import { homedir } from "os";
import { join, resolve } from "path";
import { gzipSync, gunzipSync } from "zlib";
import { invariant } from "../TOOLS/Invariant";
import { getClaudeDir } from "../TOOLS/Paths";
import { redactSecrets } from "../TOOLS/FailureCapture";
import {
  SCHEMA_VERSION, SYSTEMS, validateErratum, validatePatch, isPatch, MACHINE_SOURCES,
  type Erratum, type NewErratum, type Patch, type LedgerLine, type Status,
} from "./Schema";

export const ERRATA_DIR = process.env.ERRATA_DIR ?? join(getClaudeDir(), "LIFEOS/USER/ERRATA");
export const ERRATA_STATE_DIR = process.env.ERRATA_STATE_DIR ?? join(homedir(), ".local/state/lifeos/errata");
/** App-sourced rows (customer, user) never enter the USER git repo: they live outside git, per tenant boundary (absence review A-1). */
export const ERRATA_TENANT_DIR = process.env.ERRATA_TENANT_DIR ?? join(ERRATA_STATE_DIR, "tenants");
export const TENANT_SOURCES: ReadonlySet<string> = new Set(["customer", "user"]);

/** A path with symlinks resolved when it exists, so the symlinked and real spellings of the ledger compare equal. */
const canonical = (p: string): string => { const abs = resolve(p); return existsSync(abs) ? realpathSync(abs) : abs; };

/** True only for the real ledger: the default ledger and tenant directories (after any env override at load). */
export function isDefaultLedger(store: { dir: string; tenantDir: string }): boolean {
  return canonical(store.dir) === canonical(ERRATA_DIR) && canonical(store.tenantDir) === canonical(ERRATA_TENANT_DIR);
}

/**
 * Where a ledger's run state lives (the daily state file, the transcript sweep's cursor). The real ledger keeps it in
 * ERRATA_STATE_DIR; any other ledger (a test fixture, a scratch copy) keeps it in a `.state` directory inside its own
 * directory, so a run over a synthesized ledger can never rewrite the real run state.
 */
export function stateDirFor(store: { dir: string; tenantDir: string }): string {
  return isDefaultLedger(store) ? ERRATA_STATE_DIR : join(store.dir, ".state");
}

// PII shapes redacted on every row (absence review A-2): the secret redactor covers vendor keys only.
const PII_SHAPES: [RegExp, string][] = [
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, "[REDACTED]"],
  [/\bxai-[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
  [/(?<![\w-])(?:\d[ -]?){13,19}(?![\w-])/g, "[REDACTED-CARD]"],
];
const PII_SHAPES_NON_PRINCIPAL: [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED-EMAIL]"],
  [/(?:\+?\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, "[REDACTED-PHONE]"],
];
export function redactPii(text: string, principal: boolean): string {
  let out = text;
  for (const [re, sub] of PII_SHAPES) out = out.replace(re, () => sub);
  if (!principal) for (const [re, sub] of PII_SHAPES_NON_PRINCIPAL) out = out.replace(re, () => sub);
  return out;
}

const MAX_COMPLAINT = 8000;
const MAX_FIELD = 4000;
const MONTH_RE = /^errata-(\d{4}-\d{2})\.jsonl$/;
const ARCHIVE_RE = /^errata-(\d{4}-\d{2})\.jsonl\.gz$/;

export function monthOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export function makeId(d: Date = new Date()): string {
  const s = d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  const rand = randomBytes(3).toString("hex").slice(0, 4).replace(/[^a-z0-9]/g, "0");
  return `ERR-${s.slice(0, 8)}-${s.slice(9, 15)}-${rand}`;
}

export function instanceId(): string {
  if (process.env.ERRATA_INSTANCE) return process.env.ERRATA_INSTANCE;
  const host = process.env.HOSTNAME ?? (() => { try { return require("os").hostname(); } catch { return "unknown"; } })();
  return createHash("sha256").update(String(host)).digest("hex").slice(0, 12);
}

/** LifeOS version from the CLAUDE.md banner; null when unreadable. */
export function lifeosVersion(): string | null {
  try {
    const head = readFileSync(join(getClaudeDir(), "CLAUDE.md"), "utf8").slice(0, 400);
    const m = head.match(/LifeOS\s+(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

function clip(s: unknown, max: number): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s);
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** Structural fields never carry free text; redacting them would corrupt ids and hashes. */
const UNREDACTED_KEYS = new Set(["id", "ts", "schema", "response_hash", "session_id", "dedupe_key", "instance"]);

function redactDeep<T>(v: T, principal = true): T {
  if (typeof v === "string") return redactPii(redactSecrets(v.toWellFormed()), principal) as T; // lone surrogates from truncated emoji break strict JSON readers (jq)
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, principal)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = UNREDACTED_KEYS.has(k) ? val : redactDeep(val, principal);
    return out as T;
  }
  return v;
}

export function monthPath(month: string, dir = ERRATA_DIR): string {
  return join(dir, `errata-${month}.jsonl`);
}

/** Text that rides in a user-role turn but no human wrote: skill bodies, relay context dumps, delegate briefs, harness notices. */
const MACHINE_TEXT = [
  /^Base directory for this skill:/,
  /^\(Re-invocation of \//,
  /^## Delivered conversation context\b/,
  /^#\s+\w+ Task\s*\n+##\s*1\.\s*Objective/,
  /^<(command-name|command-message|task-notification|system-reminder|local-command-stdout)>/,
];
export function isMachineText(text: string | null | undefined): boolean {
  const t = (text ?? "").trimStart();
  return MACHINE_TEXT.some((re) => re.test(t));
}

/** One person's words in one system on one day; a different reporter or system is a different complaint. */
function contentKey(e: { system: string; reporter?: { id?: string }; complaint?: string | null; ts: string }): string {
  const norm = (e.complaint ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 500);
  return `${e.system}|${e.reporter?.id ?? ""}|${e.ts.slice(0, 10)}|${norm}`;
}

export class ErrataStore {
  constructor(readonly dir: string = ERRATA_DIR, readonly tenantDir: string = ERRATA_TENANT_DIR, readonly systems: readonly string[] = SYSTEMS) {}

  /** Dedupe keys seen on disk, built once per process and kept current by append(); a full re-read per hit made the transcript sweep crawl. */
  private dedupeCache: Set<string> | null = null;
  private dedupeKeys(): Set<string> {
    if (!this.dedupeCache) {
      this.dedupeCache = new Set();
      for (const l of this.rawLines().lines) if (!isPatch(l) && l.dedupe_key) this.dedupeCache.add(l.dedupe_key);
    }
    return this.dedupeCache;
  }

  private ensure(dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** Where a line lands: app-sourced rows go to the tenant dir outside git, everything else to the ledger. */
  dirFor(source: string): string {
    return TENANT_SOURCES.has(source) ? this.tenantDir : this.dir;
  }

  /** Build a full erratum from caller input: fills id, ts, defaults; redacts; validates. */
  build(input: NewErratum): Erratum {
    const now = input.ts ? new Date(input.ts) : new Date();
    const e: Erratum = {
      schema: SCHEMA_VERSION,
      id: makeId(now),
      ts: now.toISOString(),
      system: input.system,
      instance: input.instance ?? instanceId(),
      target: input.target ?? "instance",
      source: input.source,
      channel: input.channel,
      kind: input.kind,
      rating: input.rating ?? null,
      frustration: input.frustration ?? null,
      complaint: clip(input.complaint, MAX_COMPLAINT) ?? "",
      context: {
        ...input.context,
        requested: clip(input.context?.requested, MAX_FIELD),
        doing: clip(input.context?.doing, MAX_FIELD),
        response_preview: clip(input.context?.response_preview, MAX_FIELD),
        version: input.context?.version ?? (input.system === "lifeos" ? lifeosVersion() : null),
      },
      reporter: input.reporter,
      attachments: input.attachments ?? [],
      enrichment: null,
      status: input.status ?? "new",
      links: input.links ?? {},
      tags: input.tags ?? [],
      ...(input.dedupe_key ? { dedupe_key: input.dedupe_key } : {}),
    };
    return redactDeep(e, !TENANT_SOURCES.has(e.source));
  }

  /** Text + day of every erratum on disk, with the doors (sources) it came through: the same words the same day through a second door is a copy. */
  private contentCache: Map<string, Set<string>> | null = null;
  private contentKeys(): Map<string, Set<string>> {
    if (!this.contentCache) {
      this.contentCache = new Map();
      for (const l of this.rawLines().lines) if (!isPatch(l)) this.noteContent(contentKey(l), l.source);
    }
    return this.contentCache;
  }
  private noteContent(key: string, source: string): void {
    const m = this.contentCache!;
    if (!m.has(key)) m.set(key, new Set());
    m.get(key)!.add(source);
  }

  /**
   * Append one erratum. Returns null when it is not a human's words (machine text the transcript carries in a
   * user-role turn), when its dedupe_key exists, or when the same words were already filed the same day through
   * by the other side of the live/backfill split (the prompt hook and the transcript backfill both filing one message) (2026-10-07: 291 skill
   * bodies and relay dumps sat in the ledger as complaints, 1,211 extra copies). Repeats through one door are kept.
   */
  append(input: NewErratum): Erratum | null {
    if (isMachineText(input.complaint)) return null;
    const e = this.build(input);
    const errs = validateErratum(e, this.systems);
    invariant(errs.length === 0, `erratum invalid: ${errs.join("; ")}`);
    invariant(!(MACHINE_SOURCES.has(e.source) && e.rating !== null), "machine source with a rating");
    if (e.dedupe_key && this.hasDedupeKey(e.dedupe_key)) return null;
    const ck = contentKey(e);
    const doors = this.contentKeys().get(ck);
    // The copies come from the backfill: its feeds (ratings, failures, transcripts) file one message two or three times,
    // and re-file what a live door already caught. Repeats through a live door alone are kept.
    if (doors && (e.source === "backfill" || doors.has("backfill"))) return null;
    this.writeLine(e, monthOf(new Date(e.ts)), this.dirFor(e.source));
    if (e.dedupe_key) this.dedupeKeys().add(e.dedupe_key);
    this.noteContent(ck, e.source);
    this.mirror(e, e.status);
    return e;
  }

  /** Append a patch that folds onto `id` at read time. */
  patch(id: string, patch: Patch["patch"]): Patch {
    const target = this.get(id);
    invariant(target !== null, `patch target not found: ${id}`);
    // A patch is redacted the way its target was built: tenant rows lose PII in enrichment, tags and attachments too.
    const p: Patch = { schema: SCHEMA_VERSION, op: "patch", id, ts: new Date().toISOString(), patch: redactDeep(patch, !TENANT_SOURCES.has(target.source)) };
    const errs = validatePatch(p);
    invariant(errs.length === 0, `patch invalid: ${errs.join("; ")}`);
    this.writeLine(p, monthOf(new Date(p.ts)), this.dirFor(target.source));
    // The status the erratum reads at after this patch, folded the way all() folds it: an explicit status wins, and an
    // enrichment moves a new entry to enriched. A patch touching only links, tags or attachments is not a status change.
    if (patch.status !== undefined || patch.enrichment) {
      const status = patch.status ?? (patch.enrichment && target.status === "new" ? "enriched" : target.status);
      this.mirror(target, status);
    }
    return p;
  }

  /** Whether this store's writes reach the record: the real ledger always; any other ledger only into a scratch record. */
  mirrorsToRecord(): boolean {
    if (process.env.NODE_ENV === "test" || process.env.STATVS_DIR) return true;
    return isDefaultLedger(this);
  }

  /** One `errata` row for this erratum at this status. Ids and classes only. Never throws. */
  private mirror(e: Erratum, status: Status): void {
    if (!this.mirrorsToRecord()) return;
    try {
      const q = errataQuality();
      if (!q) return;
      const session = typeof e.context?.session_id === "string" && /^[^\s\u0000-\u001f]{1,160}$/.test(e.context.session_id) ? e.context.session_id : undefined;
      const ids = Array.isArray(e.context?.output_ids) ? e.context.output_ids.filter((x): x is string => typeof x === "string" && /^[^\s\u0000-\u001f]{1,160}$/.test(x)).slice(0, 100) : [];
      q.recordErratum({ id: e.id, kind: e.kind, system: e.system, status, ...(session ? { session_id: session } : {}), ...(ids.length ? { output_ids: ids } : {}) });
    } catch (err) {
      console.error(`[Errata] STATVS errata row not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  setStatus(id: string, status: Status): Patch {
    return this.patch(id, { status });
  }

  private writeLine(line: LedgerLine, month: string, dir: string) {
    this.ensure(dir);
    const json = JSON.stringify(line);
    invariant(!json.includes("\n"), "ledger line contains a newline");
    invariant(dir === this.dir || dir === this.tenantDir, "unknown ledger dir");
    appendFileSync(monthPath(month, dir), json + "\n", "utf8");
  }

  /**
   * Month files, oldest first. A month can have both an archive and a plain file (a backdated append after rotation
   * recreates the plain file); both are returned, archive first, so neither hides the other's rows.
   */
  files(): { month: string; path: string; gz: boolean; tenant: boolean }[] {
    const out: { month: string; path: string; gz: boolean; tenant: boolean }[] = [];
    for (const [dir, tenant] of [[this.dir, false], [this.tenantDir, true]] as const) {
      if (!existsSync(dir)) continue;
      const arch = join(dir, "archive");
      if (existsSync(arch)) for (const f of readdirSync(arch)) {
        const m = f.match(ARCHIVE_RE); if (m) out.push({ month: m[1], path: join(arch, f), gz: true, tenant });
      }
      for (const f of readdirSync(dir)) {
        const m = f.match(MONTH_RE); if (m) out.push({ month: m[1], path: join(dir, f), gz: false, tenant });
      }
    }
    return out.sort((a, b) => a.month.localeCompare(b.month) || Number(a.tenant) - Number(b.tenant) || Number(b.gz) - Number(a.gz));
  }

  /** Raw lines across every file, in order. Torn or malformed lines are skipped and counted. */
  rawLines(): { lines: LedgerLine[]; skipped: number } {
    const lines: LedgerLine[] = []; let skipped = 0;
    for (const f of this.files()) {
      const buf = readFileSync(f.path);
      const text = f.gz ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
      for (const raw of text.split("\n")) {
        if (!raw.trim()) continue;
        try {
          const obj = JSON.parse(raw) as LedgerLine;
          if (obj && typeof obj === "object" && typeof (obj as { id?: unknown }).id === "string") lines.push(obj); else skipped++;
        } catch { skipped++; }
      }
    }
    return { lines, skipped };
  }

  /** Folded view: every erratum with its patches applied in order. */
  all(): Erratum[] {
    const { lines } = this.rawLines();
    const map = new Map<string, Erratum>();
    for (const l of lines) {
      if (isPatch(l)) {
        const e = map.get(l.id); if (!e) continue;
        Object.assign(e, l.patch);
        if (l.patch.enrichment && e.status === "new") e.status = "enriched";
      } else map.set(l.id, { ...l });
    }
    return [...map.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  }

  get(id: string): Erratum | null {
    return this.all().find((e) => e.id === id) ?? null;
  }

  hasDedupeKey(key: string): boolean {
    return this.dedupeKeys().has(key);
  }

  list(filter: {
    system?: string; kind?: string; status?: string; source?: string; since?: string; limit?: number; enriched?: boolean;
  } = {}): Erratum[] {
    let rows = this.all();
    if (filter.system) rows = rows.filter((e) => e.system === filter.system);
    if (filter.kind) rows = rows.filter((e) => e.kind === filter.kind);
    if (filter.status) rows = rows.filter((e) => e.status === filter.status);
    if (filter.source) rows = rows.filter((e) => e.source === filter.source);
    if (filter.since) rows = rows.filter((e) => e.ts >= filter.since!);
    if (filter.enriched === true) rows = rows.filter((e) => e.enrichment !== null);
    if (filter.enriched === false) rows = rows.filter((e) => e.enrichment === null);
    if (filter.limit) rows = rows.slice(-filter.limit);
    return rows;
  }

  stats(): { total: number; by_system: Record<string, number>; by_kind: Record<string, number>; by_status: Record<string, number>; enriched: number; months: string[]; skipped_lines: number } {
    const { lines, skipped } = this.rawLines();
    const rows = this.all();
    const count = (k: keyof Erratum) => rows.reduce((acc, e) => { const v = String(e[k]); acc[v] = (acc[v] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    return {
      total: rows.length, by_system: count("system"), by_kind: count("kind"), by_status: count("status"),
      enriched: rows.filter((e) => e.enrichment).length, months: [...new Set(this.files().map((f) => f.month))], skipped_lines: skipped + (lines.length - lines.length),
    };
  }

  /**
   * Gzip every plain month file strictly before `beforeMonth` (YYYY-MM) into archive/. An archive already there for that
   * month is kept and the plain lines are appended after it. Verifies the round-trip before removing the plain file.
   */
  rotate(beforeMonth: string): { archived: string[] } {
    invariant(/^\d{4}-\d{2}$/.test(beforeMonth), "rotate needs YYYY-MM");
    this.dedupeCache = null;
    const archived: string[] = [];
    for (const f of this.files()) {
      if (f.gz || f.month >= beforeMonth) continue;
      const arch = join(f.tenant ? this.tenantDir : this.dir, "archive");
      if (!existsSync(arch)) mkdirSync(arch, { recursive: true });
      const target = join(arch, `errata-${f.month}.jsonl.gz`);
      const prior = existsSync(target) ? gunzipSync(readFileSync(target)) : Buffer.alloc(0);
      const sep = prior.length && prior[prior.length - 1] !== 0x0a ? Buffer.from("\n") : Buffer.alloc(0);
      const plain = Buffer.concat([prior, sep, readFileSync(f.path)]);
      const gz = gzipSync(plain);
      invariant(gunzipSync(gz).equals(plain), `gzip round-trip failed for ${f.path}`);
      const tmp = target + ".tmp";
      writeFileSync(tmp, gz); renameSync(tmp, target);
      invariant(statSync(target).size === gz.length, "archive write incomplete");
      unlinkSync(f.path);
      archived.push(target);
    }
    return { archived };
  }

  attachmentDir(id: string): string {
    const d = join(ERRATA_STATE_DIR, id);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return d;
  }
}

type QualityModule = typeof import("../STATVS/lib/quality.ts");
let quality: QualityModule | null | undefined;
/** The record's quality writers, loaded on first use so a reader of the ledger never pays for the engine; null (logged) when unavailable. */
function errataQuality(): QualityModule | null {
  if (quality === undefined) {
    try { quality = require("../STATVS/lib/quality.ts") as QualityModule; }
    catch (e) { quality = null; console.error(`[Errata] STATVS quality writer unavailable: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return quality;
}

export function responseHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
