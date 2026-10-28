/**
 * Sources — every producer the weekly pool reads, each from the file it already writes, and the check
 * that every producer listed in sources.json has a reader wired in code and a file on disk.
 *
 * Read-only. Every reader takes its path so tests run on synthesized files, and every reader returns
 * whether it actually read its source (ISC-72): a missing or unparseable file yields no items and
 * `read: false` with the reason, so an empty source and a dead one never look the same in the run record.
 *
 * @version 1.3.0
 *
 * 1.3.0: producer vigil-advocate reads the continuous advocate's recommendation rows from the STATVS record.
 * 1.2.0: the ideal-state producer also reads needs-input rows from the loop's reconcile.json
 * (current-ideal delta ISC-57).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readJson } from "./Store";
import { scan, statvsDir } from "../STATVS/index";
import { recordRows, type CloudConn, type RecordRow } from "../STATVS/lib/cloudRead";
import { wordsByHash } from "../VIGIL/Decision";
import type { AdvocateRecLike, AuditProposalLike, HypothesisLike, SocratesFindingLike, TriageClusterLike, V4RecLike, VigilRecLike } from "./Weekly";

// ── Read results ────────────────────────────────────────────────────────────

/** What one reader got: its items, whether the source was read at all, and why not (or what it skipped). */
export interface SourceRead<T> { items: T[]; read: boolean; detail?: string }

export const readOk = <T>(items: T[], detail?: string): SourceRead<T> => (detail ? { items, read: true, detail } : { items, read: true });
export const unread = <T>(detail: string): SourceRead<T> => ({ items: [], read: false, detail });

/**
 * A JSONL file, line by line. Missing or unreadable is unread; a file whose every line fails to parse is
 * unread (unparseable); a file with some bad lines is read, with the skipped count in `detail`.
 */
export function readJsonlSource<T>(path: string): SourceRead<T> {
  if (!existsSync(path)) return unread(`missing: ${path}`);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) { return unread(`unreadable: ${(e as Error).message}`); }
  const lines = text.split("\n").filter((l) => l.trim());
  const items: T[] = [];
  for (const l of lines) { try { items.push(JSON.parse(l) as T); } catch {} }
  const bad = lines.length - items.length;
  if (lines.length && !items.length) return unread(`unparseable: ${path}`);
  return readOk(items, bad ? `${bad} unparseable line${bad === 1 ? "" : "s"} skipped` : undefined);
}

/** One JSON file whose list `pick` extracts; a file that parses but holds no such list is unparseable too. */
export function readJsonSource<T>(path: string, pick: (v: unknown) => T[] | null): SourceRead<T> {
  if (!existsSync(path)) return unread(`missing: ${path}`);
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { return unread(`unparseable: ${path}`); }
  const items = pick(value);
  return items ? readOk(items) : unread(`unparseable: ${path} has no list where one was expected`);
}

// ── Ideal-state loop, Errata v4, Review alarms ──────────────────────────────

export interface IdealRecRow { id: string; status: string; created: string; kind?: string; title?: string; text?: string; why?: string }

export const readIdealRecs = (path: string): SourceRead<IdealRecRow> =>
  readJsonSource(path, (v) => { const recs = (v as { recs?: unknown } | null)?.recs; return Array.isArray(recs) ? (recs as IdealRecRow[]) : null; });

type TieredRow = { key?: unknown; file?: unknown; tier?: unknown; tier_why?: unknown };
/** Ideal-state target rows whose gap tier is needs-input in the latest reconcile, each an open decision for him. */
export const readIdealNeedsInput = (path: string): SourceRead<IdealRecRow> =>
  readJsonSource(path, (v) => {
    const r = v as { generated_at?: unknown; rows?: unknown } | null;
    if (!r || !Array.isArray(r.rows)) return null;
    return (r.rows as TieredRow[]).filter((x) => x?.tier === "needs-input" && typeof x.key === "string").map((x) => ({
      id: `NI-${x.key}`, status: "open", created: typeof r.generated_at === "string" ? r.generated_at : "", kind: "needs-input",
      title: `Ideal-state target ${x.key}${typeof x.file === "string" ? ` (${x.file})` : ""} needs your call: ${typeof x.tier_why === "string" ? x.tier_why : "its next move needs your judgment"}`,
    }));
  });

/** The one ideal-state producer: open loop recommendations plus needs-input decisions. Read when either file was. */
export function readIdealState(recsPath: string, reconcilePath: string): SourceRead<IdealRecRow> {
  const a = readIdealRecs(recsPath), b = readIdealNeedsInput(reconcilePath);
  const detail = [a.detail, b.detail].filter(Boolean).join("; ") || undefined;
  if (!a.read && !b.read) return unread(detail ?? "unread");
  return readOk([...a.items, ...b.items], detail);
}

/** The newest `recommendations-<date>.jsonl`; no such file is unread. */
export function readV4Recs(dir: string): { date: string; recs: V4RecLike[]; read: boolean; detail?: string } {
  if (!existsSync(dir)) return { date: "", recs: [], read: false, detail: `missing: ${dir}` };
  const f = readdirSync(dir).filter((x) => /^recommendations-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort().at(-1);
  if (!f) return { date: "", recs: [], read: false, detail: `missing: no recommendations-<date>.jsonl in ${dir}` };
  const r = readJsonlSource<V4RecLike>(join(dir, f));
  return { date: f.slice(16, 26), recs: r.items, read: r.read, ...(r.detail ? { detail: r.detail } : {}) };
}

// ── Errata weekly audit proposals ───────────────────────────────────────────

/** The newest taxonomy's proposals file (`proposals-v<N>.jsonl`); rows that failed carry no proposal and are not counted. */
export function readAuditProposals(auditDir: string): SourceRead<AuditProposalLike> {
  if (!existsSync(auditDir)) return unread(`missing: ${auditDir}`);
  const files = readdirSync(auditDir).map((f) => ({ f, v: Number(f.match(/^proposals-v(\d+)\.jsonl$/)?.[1]) })).filter((x) => Number.isFinite(x.v)).sort((a, b) => a.v - b.v);
  const f = files.at(-1)?.f;
  if (!f) return unread(`missing: no proposals-v<N>.jsonl in ${auditDir}`);
  const r = readJsonlSource<AuditProposalLike>(join(auditDir, f));
  return { ...r, items: r.items.filter((p) => !p.error && typeof p.failure_class === "string" && typeof p.title === "string") };
}

// ── Errata triage clusters ──────────────────────────────────────────────────

const CLUSTER = /^## (\S+) — (.+) \((\d+) entr(?:y|ies)\)$/;
const ENTRY = /^- \*\*(ERR-[\w-]+)\*\* \(how_upset (\d)\):/;
const FIX = /^ {2}proposed fix: (.*)$/;
/** The report sections Triage appends after its clusters (OutputJoin per-skill rows, reconciler gaps). */
const AFTER = /^## (Per-skill output quality|Reconciler gaps)/;

/**
 * One cluster per `## <system> — <class> (N entries)` heading of a Triage report. A quoted complaint can
 * span lines and carry its own markdown headings, so a cluster ends only at the next cluster heading or
 * at the sections Triage writes after the clusters, and its size is the heading's N.
 */
export function parseTriage(text: string, date: string): TriageClusterLike[] {
  const out: TriageClusterLike[] = [];
  let cur: TriageClusterLike | null = null;
  for (const line of text.split("\n")) {
    const h = line.match(CLUSTER);
    if (h) { cur = { date, system: h[1], class: h[2], entries: Number(h[3]), ids: [], fix: "", max_upset: 0 }; out.push(cur); continue; }
    if (AFTER.test(line)) { cur = null; continue; }
    if (!cur) continue;
    const e = line.match(ENTRY);
    if (e) { cur.ids.push(e[1]); cur.max_upset = Math.max(cur.max_upset, Number(e[2])); continue; }
    const f = line.match(FIX);
    if (f && !cur.fix) cur.fix = f[1].trim();
  }
  return out;
}

/** The latest triage report; a report with no clusters is a read, quiet day. */
export function readTriageClusters(reportsDir: string): SourceRead<TriageClusterLike> {
  if (!existsSync(reportsDir)) return unread(`missing: ${reportsDir}`);
  const f = readdirSync(reportsDir).filter((x) => /^triage-\d{4}-\d{2}-\d{2}\.md$/.test(x)).sort().at(-1);
  if (!f) return unread(`missing: no triage-<date>.md in ${reportsDir}`);
  try { return readOk(parseTriage(readFileSync(join(reportsDir, f), "utf8"), f.slice(7, 17))); }
  catch (e) { return unread(`unreadable: ${(e as Error).message}`); }
}

// ── Socrates open findings ──────────────────────────────────────────────────

/** Open means an `open` event with no later `resolve` for the same finding id: the journal folds the way Socrates' Store does. */
export function readSocratesOpen(findingsPath: string, questions: () => Array<{ id: string; text: string; severity?: string }>): SourceRead<SocratesFindingLike> {
  const journal = readJsonlSource<{ event: string; id: number; question_id: string; instance_key: string; first_seen: string; last_value?: string | null }>(findingsPath);
  if (!journal.read) return unread(journal.detail ?? "unread");
  const open = new Map<number, SocratesFindingLike>();
  for (const e of journal.items) {
    if (e.event === "open") open.set(e.id, { id: e.id, question_id: e.question_id, instance_key: e.instance_key ?? "", first_seen: e.first_seen, last_value: e.last_value ?? null });
    else if (e.event === "resolve") open.delete(e.id);
  }
  if (!open.size) return readOk([], journal.detail);
  let byId = new Map<string, { text: string; severity?: string }>();
  // A malformed question pack must not hide the findings; they still enter the pool by id.
  try { byId = new Map(questions().map((q) => [q.id, q])); } catch {}
  return readOk([...open.values()].map((f) => ({ ...f, text: byId.get(f.question_id)?.text, severity: byId.get(f.question_id)?.severity })), journal.detail);
}

// ── LearningPatternSynthesis hypotheses ─────────────────────────────────────

/** Frontmatter scalars and the evidence_signals list; the claim is the body's `## Claim` paragraph. */
export function parseHypothesis(text: string): (HypothesisLike & { status: string; expires: string }) | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, string> = {}, evidence: string[] = [];
  let list: string | null = null;
  for (const line of m[1].split("\n")) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && list === "evidence_signals") { evidence.push(item[1].trim()); continue; }
    const kv = line.match(/^([\w]+):\s*(.*)$/);
    if (!kv) continue;
    list = kv[2] === "" ? kv[1] : null;
    fm[kv[1]] = kv[2].replace(/^"|"$/g, "");
  }
  const claim = m[2].match(/## Claim\n+([\s\S]*?)(?:\n## |$)/)?.[1].trim() ?? "";
  if (!fm.slug || !fm.status) return null;
  return { slug: fm.slug, status: fm.status, expires: fm.expires ?? "", generated: fm.generated ?? "", confidence: Number(fm.confidence) || 0.5, evidence, claim: claim || fm.slug };
}

/**
 * Pending: still `status: hypothesis` and not past its expiry. Archived files live in `_archive/` and are
 * not read. Notes that do not parse are counted in `detail`; a directory where none parse is unread.
 */
export function readHypotheses(dir: string, now: Date): SourceRead<HypothesisLike> {
  if (!existsSync(dir)) return unread(`missing: ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md");
  let bad = 0;
  const items = files.flatMap((f) => {
    const h = parseHypothesis(readFileSync(join(dir, f), "utf8"));
    if (!h) { bad++; return []; }
    if (h.status !== "hypothesis" || !(Date.parse(h.expires) > now.getTime())) return [];
    const { status: _s, expires: _e, ...rest } = h;
    return [rest];
  });
  if (files.length && bad === files.length) return unread(`unparseable: none of ${files.length} notes in ${dir} parse`);
  return readOk(items, bad ? `${bad} unparseable note${bad === 1 ? "" : "s"} skipped` : undefined);
}

// ── The model advisor and ShadowExpiry, through the Vigil outbox ─────────────────

/**
 * Recommendation events from the local Vigil outbox (14 days kept before rotation), newest per dedup key.
 * The model advisor's quiet and error runs are not recommendations: only its `medium` events name new ones.
 * The outbox is large, so lines are filtered by source text before parsing. Each event is a digest that
 * Weekly.vigilItems splits into its separate recommendations (ISC-71).
 */
export function readVigilRecs(outboxPath: string, source: "model-advisor" | "shadow-expiry"): SourceRead<VigilRecLike> {
  if (!existsSync(outboxPath)) return unread(`missing: ${outboxPath}`);
  let text: string;
  try { text = readFileSync(outboxPath, "utf8"); } catch (e) { return unread(`unreadable: ${(e as Error).message}`); }
  const needle = `"source":"${source}"`, byKey = new Map<string, VigilRecLike>();
  let lines = 0, parsed = 0, bad = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    lines++;
    let e: VigilRecLike;
    try { e = JSON.parse(line) as VigilRecLike; parsed++; } catch { if (line.includes(needle)) bad++; continue; }
    if (e.source !== source || (source === "model-advisor" && e.severity !== "medium")) continue;
    const have = byKey.get(e.dedup_key);
    if (!have || e.ts > have.ts) byKey.set(e.dedup_key, e);
  }
  if (lines && !parsed) return unread(`unparseable: ${outboxPath}`);
  return readOk([...byKey.values()], bad ? `${bad} unparseable ${source} line${bad === 1 ? "" : "s"} skipped` : undefined);
}

// ── The continuous advocate, through the STATVS record ──────────────────────

/**
 * The advocate's recommendations from the STATVS record (stream vigil-log, kind recommendation), last 14
 * days. Each is a change an advocate run proposed and did not make: Review puts it in front of the principal.
 * `dir` is the record (tests pass a temp one). A record that does not exist is unread.
 * A row carries ids and `words_sha256` only (P10, design §1.3); the change, why and target are joined back from
 * Vigil's local editor-words.jsonl by that hash (`words`, injectable for tests). A row written before that rule
 * still carries `change` and `why` and reads as before. A hash with no local words is skipped as malformed.
 */
export function readAdvocateRecs(dir?: string, now = new Date(), words: (hash: string) => Record<string, string> | null = wordsByHash): SourceRead<AdvocateRecLike> {
  const root = dir ?? statvsDir();
  if (!existsSync(root)) return unread(`missing: ${root}`);
  const from = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
  const r = scan({ dir: root, streams: ["vigil-log"], fromDate: from });
  return advocateRecsFrom(r.rows, r.problems ?? [], words);
}

/** The same recommendations from the cloud record plus this machine's unshipped rows (STATVS migration ISA ISC-179): the weekly run reads them this way. */
export async function loadAdvocateRecs(now = new Date(), words: (hash: string) => Record<string, string> | null = wordsByHash, conn?: CloudConn): Promise<SourceRead<AdvocateRecLike>> {
  const from = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
  const r = await recordRows({ streams: ["vigil-log"], fromDate: from }, conn ? { conn } : {});
  return advocateRecsFrom(r.rows, r.problems, words);
}

function advocateRecsFrom(rows: RecordRow[], problems: string[], words: (hash: string) => Record<string, string> | null): SourceRead<AdvocateRecLike> {
  let bad = 0;
  const items = rows.flatMap((row) => {
    if (row.kind !== "recommendation") return [];
    const raw = (row.data ?? {}) as Record<string, unknown>;
    const joined = typeof raw.change !== "string" && typeof raw.words_sha256 === "string" ? words(raw.words_sha256) : null;
    const d: Record<string, unknown> = joined ? { ...raw, ...joined } : raw;
    if (typeof d.change !== "string" || typeof d.decision !== "string") { bad++; return []; }
    return [{ id: row.id, ts: row.ts, decision: d.decision, advocate: String(d.advocate ?? "advocate"), change: d.change, why: String(d.why ?? ""), ...(typeof d.target === "string" ? { target: d.target } : {}) }];
  });
  // An unreachable cloud is named as itself: the read is this machine's rows only, which a bare count would hide.
  const down = problems.find((p) => p.startsWith("cloud record unreachable"));
  const rest = problems.length - (down ? 1 : 0);
  const detail = [down ?? "", rest ? `${rest} record problem${rest === 1 ? "" : "s"}` : "", bad ? `${bad} malformed recommendation row${bad === 1 ? "" : "s"} skipped` : ""].filter(Boolean).join("; ");
  return readOk(items, detail || undefined);
}

// ── sources.json and the wiring check ───────────────────────────────────────

/** One producer: `reader` is its PoolSources key, `prefix` the first segment of every pool id it makes (Weekly.producerOf). */
export interface Producer { id: string; reader: string; prefix: string; path: string; what: string }
/** ok: wired and its file is on disk · missing: wired, but no file matches its path · unwired: no reader in code. */
export type ProducerState = "ok" | "missing" | "unwired";

export const sourcesPath = (): string => process.env.REVIEW_SOURCES ?? join(import.meta.dir, "sources.json");
export const loadProducers = (path = sourcesPath()): Producer[] => readJson<{ producers: Producer[] }>(path, { producers: [] }).producers;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a file the listed path names exists. `~/` is the home directory, an absolute path is itself,
 * anything else is under ~/.claude. A trailing `/` names a directory. A `<placeholder>` or `*` in the
 * file name must match a real file in its directory: an empty directory is not a producer's output.
 */
export function present(path: string, home: string, claude: string): boolean {
  const abs = path.startsWith("~/") ? join(home, path.slice(2)) : path.startsWith("/") ? path : join(claude, path);
  try {
    if (abs.endsWith("/")) return existsSync(abs) && statSync(abs).isDirectory();
    const dir = dirname(abs), base = basename(abs);
    if (/[<*]/.test(dir)) return false;
    if (!/[<*]/.test(base)) return existsSync(abs) && statSync(abs).isFile();
    const re = new RegExp(`^${base.split(/(<[^>]+>|\*)/).map((s) => (s === "*" || /^<[^>]+>$/.test(s) ? ".+" : escapeRe(s))).join("")}$`);
    return existsSync(dir) && readdirSync(dir).some((f) => re.test(f));
  } catch { return false; }
}

/**
 * Every listed producer must name a reader the live pool wires, and every wired reader must be listed,
 * so the list cannot drift from the code in either direction (`wired`, ISC-51: the CLI exits 1 on that).
 * A wired producer whose file is absent is `missing`, never `ok` (ISC-67): it is reported, and `ok` is
 * false, but it does not fail the exit, because a fresh install has none of these files yet.
 */
export function checkSources(listed: Producer[], wired: string[], o: { home: string; claude: string }) {
  const producers = listed.map((p) => {
    const isWired = wired.includes(p.reader), isPresent = present(p.path, o.home, o.claude);
    const state: ProducerState = !isWired ? "unwired" : isPresent ? "ok" : "missing";
    return { ...p, wired: isWired, present: isPresent, state };
  });
  const unlisted = wired.filter((w) => !listed.some((p) => p.reader === w));
  const unwired = producers.filter((p) => p.state === "unwired").map((p) => p.id);
  const missing = producers.filter((p) => p.state === "missing").map((p) => p.id);
  const wiredOk = listed.length > 0 && unwired.length === 0 && unlisted.length === 0;
  return { ok: wiredOk && missing.length === 0, wired: wiredOk, producers, unwired, unlisted, missing };
}
