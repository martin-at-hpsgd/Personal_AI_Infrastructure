/**
 * Recommend — the weekly recommendations pass, and the yes/no that follows.
 *
 * Gathers a candidate pool (recent complaints, goals no ideal-state row covers,
 * unanswerable standing questions, unbound numeric targets, off-pace rows), asks
 * one cheap OpenAI-lane model for at most 3 proposed ideal-state rows and at most
 * 2 watchers or builds, gates every answer in code, and stores what survives.
 *
 * Nothing here changes the system. A row reaches its ideal-state file only through
 * `acceptRec`, which runs on the principal's yes; a build recommendation stays a
 * brief until he asks for it to be built.
 *
 * @version 1.6.0
 *
 * 1.6.0: every store and ideal-state write holds the shared per-file locks from its read through its
 * write (review round 3). accept takes the store, the row's file and (for a new row) the id registry up
 * front, so a busy lock refuses before anything is written; recommend calls the model outside the lock
 * and re-gates its answer against the store as it is when it saves, so a yes or no given meanwhile stays.
 *
 * 1.5.0: a binding carries its measurement reason or is refused, at the gate and again at accept
 * (current-ideal delta ISC-78); reconcile reads that reason to tier the row.
 *
 * 1.4.0: the principal's measurable wants (Wants.ts) join the pool; a row proposed from one quotes the want
 * verbatim and, like every row, lands only on accept (current-ideal-delta ISC-39).
 *
 * 1.3.0: the binding catalog reads the state-evidence cache first; a proposed row may
 * hold no number its source quote lacks.
 *
 * 1.2.0: builds are pursuit proposals: each names the row or goal id it serves (checked
 * against the graph in code) and who moves it; unpursued, stalled and new rows lead the pool.
 *
 * 1.1.0: Superior lens in the prompt, level high; `binding` recommendations propose a
 * `measure:` suffix the code verifies against a live data file; daily schedule, but the
 * model is called only when the open set changed or a week passed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { VIGIL_SEVERITIES as SEVERITIES, emitVigilEvent, vigilEvent } from "../TOOLS/lib/VigilOptional";
import { readValue, type ReconcileReport } from "./Reconcile";
import { allRows, dimensionFiles, formatMeasure, goalRows, ID_RE, OWNERS, parseGoals, parseRows, rowRef, sections, type Measure, type NumericMeasure, type Owner, type Row } from "./Rows";
import { issueRowId, liveGoals } from "./Ids";
import { idealDir, readJson, statePath, userDir, withLocks, writeFileLocked, writeState, type TelosLockOptions } from "./Store";
import { activeWants, type Want } from "./Wants";

export const MAX_OPEN_ROWS = 3;
export const MAX_OPEN_BUILDS = 2;
export const MAX_OPEN_BINDINGS = 2;
export const EXPIRE_DAYS = 14;
export const QUIET_DAYS = 7;
const DAY = 86_400_000;

export type Candidate = { id: string; kind: "unpursued" | "errata" | "goal" | "socrates" | "unbound" | "off-track" | "vigil" | "want"; text: string };
export type RecStatus = "open" | "accepted" | "dismissed" | "expired";
export type Rec = {
  id: string; kind: "row" | "build" | "binding"; status: RecStatus; created: string; decided?: string;
  source_id: string; source_kind: Candidate["kind"]; why?: string;
  file?: string; section?: string; text?: string; source_quote?: string;
  title?: string; gap?: string; data_source?: string; cadence?: string; severity?: string; brief?: string;
  row_key?: string; measure?: Measure;
  /** Bindings accepted together by `IdealState.ts bind --accept`: the batch id (Bind.ts). */
  batch?: string;
  /** Build (pursuit) proposals: the row or goal id the mechanism moves, and who moves it. */
  serves?: string; owner?: Owner;
};
export type RecStore = { recs: Rec[]; last_run?: { ts: string; open_ids: string[] } };

export type ErrataLike = { id: string; ts: string; kind?: string; source?: string; complaint?: string | null };
export type SocratesLike = { id: string; status: string; text: string };
export type VigilLike = { source: string; ts: string; severity: string; title: string };
export type Sources = {
  errata: () => ErrataLike[];
  socrates: () => SocratesLike[];
  vigil: () => VigilLike[];
  telos: () => string;
  rows: () => Row[];
  reconcile: () => ReconcileReport | null;
  /** Numeric JSON paths available for bindings, as `<file>#<dot.path>`. Paths only, never values. */
  catalog: () => string[];
  /** When each row or goal id was first seen (reconcile writes it). */
  seen?: () => Record<string, string>;
  /** TELOS goals as rows with their registry ids (read-only; reconcile records new ids). */
  goals?: () => Row[];
  /** The principal's own wants, from the wants store; only active, measurable ones enter the pool. */
  wants?: () => Want[];
};
export type Infer = (system: string, user: string) => Promise<{ success: boolean; parsed?: unknown; error?: string; vendor?: string }>;

// ── sources ────────────────────────────────────────────────────────────────

function runJsonCli(args: string[]): string {
  const r = Bun.spawnSync(["bun", ...args], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", env: { ...process.env, LIFEOS_NOTIFICATION_CHANNEL: "headless" } });
  if (r.exitCode !== 0) throw new Error(`${args[0]} exited ${r.exitCode}: ${r.stderr.toString().slice(0, 200)}`);
  return r.stdout.toString();
}

export function parseSocratesList(text: string): SocratesLike[] {
  return text.split("\n").flatMap((l) => { const m = l.match(/^(SOC-\d+)\s+\[[^\]]*\]\s+(\S+)\s+—\s+(.+)$/); return m ? [{ id: m[1]!, status: m[2]!, text: m[3]!.trim() }] : []; });
}

export const liveSources: Sources = {
  errata: () => JSON.parse(runJsonCli(["ERRATA/Errata.ts", "list", "--json"])) as ErrataLike[],
  socrates: () => parseSocratesList(runJsonCli(["SOCRATES/Socrates.ts", "list"])),
  vigil: () => { const a = JSON.parse(runJsonCli(["VIGIL/Vigil.ts", "list", "--limit", "2000", "--json"])); return (Array.isArray(a) ? a : a.events ?? []) as VigilLike[]; },
  telos: () => readFileSync(join(userDir(), "TELOS", "TELOS" + ".md"), "utf8"),
  rows: () => allRows(),
  reconcile: () => readJson<ReconcileReport | null>(statePath("reconcile.json"), null),
  catalog: () => dataCatalog(),
  seen: () => readJson<Record<string, string>>(statePath("seen.json"), {}),
  goals: () => { const g = liveGoals(); return goalRows(g.goals, g.ids); },
  wants: () => activeWants(),
};

/**
 * Single files read before the data dirs, each from one subtree: the state-evidence cache
 * already averages the wearable, activity and money readings, so its paths lead the catalog
 * and the cap never cuts them.
 */
export const CATALOG_FILES: ReadonlyArray<{ file: string; under: string }> = [{ file: "CACHE/state-evidence.json", under: "domains" }];
const CATALOG_DIRS = ["HEALTH", "FINANCES"];
/** Every numeric leaf (depth ≤ 4, arrays skipped) in the catalog files, then the top-level JSON files of the data dirs. */
export function dataCatalog(root = userDir(), max = 150): string[] {
  const out: string[] = [];
  const walk = (file: string, v: unknown, path: string[], depth: number) => {
    if (out.length >= max || depth > 4 || v === null || Array.isArray(v)) return;
    if (typeof v === "number" && Number.isFinite(v)) { out.push(`${file}#${path.join(".")}`); return; }
    if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (/^[A-Za-z0-9_-]+$/.test(k)) walk(file, x, [...path, k], depth + 1);
  };
  for (const { file, under } of CATALOG_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    try { const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; walk(file, doc?.[under], [under], 1); } catch { /* unreadable file: not in the catalog */ }
  }
  for (const d of CATALOG_DIRS) {
    const dir = join(root, d);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      try { walk(`${d}/${name}`, JSON.parse(readFileSync(join(dir, name), "utf8")), [], 0); } catch { /* unreadable file: not in the catalog */ }
    }
  }
  return out;
}

// ── candidate pool ─────────────────────────────────────────────────────────

const STOP = new Set(["about", "after", "before", "every", "least", "month", "their", "there", "these", "which", "with", "from", "into", "that", "this", "have", "will", "only", "more", "than", "year", "years", "full", "fully", "first", "next"]);
const words = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9$]{4,}/g) ?? []).filter((w) => !STOP.has(w));

/** The goal lines of TELOS `## GOALS`, skipping dropped and achieved ones. */
export function telosGoals(telos: string): string[] {
  return parseGoals(telos).filter((g) => g.status === "active").map((g) => g.text);
}

/** A goal is covered when some row carries at least half of its significant words. */
export function goalCovered(goal: string, rows: Row[]): boolean {
  const g = new Set(words(goal));
  if (g.size === 0) return true;
  return rows.some((r) => { const rw = new Set(words(r.text)); let hit = 0; for (const w of g) if (rw.has(w)) hit++; return hit / g.size >= 0.5; });
}

const VIGIL_SKIP = new Set(["workflows", "vigil", "ideal-state"]);
const VIGIL_FLOOR = new Set(["medium", "high", "critical"]);
export const MAX_VIGIL_GROUPS = 25;

export const MAX_UNPURSUED = 25;
export const MAX_WANTS = 20;
/** A want can become a target only when it carries a quantity: a digit or a counting word. */
export const measurableWant = (text: string): boolean => /\d|\b(?:once|twice|daily|weekly|monthly|yearly|every\s+(?:day|night|morning|week|month|year)|one(?!\s+day)|two|three|four|five|six|seven|eight|nine|ten|twelve|dozen|hundred|thousand|million|double|half)\b/i.test(text);
export const NEW_DAYS = 7;

export function candidatePool(src: Sources, now = new Date()): Candidate[] {
  const pool: Candidate[] = [];
  // What nothing is moving: newly seen first, then stalled, then the rest. Text comes from the live rows, never the report.
  const rec0 = src.reconcile();
  const seen = src.seen?.() ?? {};
  const liveRows = new Map([...src.rows(), ...(src.goals?.() ?? [])].map((r) => [rowRef(r), r]));
  const isNew = (id: string) => !!seen[id] && now.getTime() - Date.parse(seen[id]!) <= NEW_DAYS * DAY;
  const open = (rec0?.pursuit ?? []).filter((p) => (p.state === "unpursued" || p.state === "stalled") && (p.type === "target" || (p.type === "goal" && p.status === "active")));
  open.sort((a, b) => Number(isNew(b.id)) - Number(isNew(a.id)) || Number(b.state === "stalled") - Number(a.state === "stalled"));
  for (const p of open.slice(0, MAX_UNPURSUED)) {
    const row = liveRows.get(p.id);
    if (!row) continue; // gone since the last reconcile
    const text = row.type === "goal" ? `TELOS goal: ${row.text}` : `${row.file} § ${row.section}: ${row.text}`;
    const label = `${p.state}${isNew(p.id) ? ", new" : ""}${p.links.length ? `; links: ${p.links.map((l) => `${l.kind}/${l.name} (${l.why})`).join(", ")}` : ""}`;
    pool.push({ id: p.id, kind: "unpursued", text: `${text} [${label}]` });
  }
  const since = now.getTime() - 7 * DAY;
  for (const e of src.errata()) {
    if (!e.complaint || e.source === "backfill") continue;
    if (Date.parse(e.ts) < since || Date.parse(e.ts) > now.getTime()) continue;
    pool.push({ id: e.id, kind: "errata", text: e.complaint });
  }
  // His own measurable wants, newest first, verbatim: a row proposed from one must quote it.
  const wants = (src.wants?.() ?? []).filter((w) => !w.superseded_by && !w.archived && measurableWant(w.text)).sort((a, b) => b.last_seen.localeCompare(a.last_seen)).slice(0, MAX_WANTS);
  for (const w of wants) pool.push({ id: w.id, kind: "want", text: w.text });
  const rows = src.rows();
  telosGoals(src.telos()).forEach((g, i) => { if (!goalCovered(g, rows)) pool.push({ id: `GOAL-${i + 1}`, kind: "goal", text: g }); });
  for (const q of src.socrates()) if (q.status === "unanswerable") pool.push({ id: q.id, kind: "socrates", text: q.text });
  for (const r of rows) if (r.type === "target" && !r.measure && /\d/.test(r.text) && !/\bTBD\b/.test(r.text)) pool.push({ id: `ROW-${rowRef(r)}`, kind: "unbound", text: `${r.file} § ${r.section}: ${r.text}` });
  // What Vigil kept seeing this week: a repeat is the signal for a missing watcher or fix.
  const groups = new Map<string, number>();
  for (const e of src.vigil()) {
    if (VIGIL_SKIP.has(e.source) || !VIGIL_FLOOR.has(e.severity)) continue;
    if (Date.parse(e.ts) < since || Date.parse(e.ts) > now.getTime()) continue;
    const k = `${e.source}: ${e.title}`; groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_VIGIL_GROUPS).forEach(([k, n], i) => pool.push({ id: `VIGIL-${i + 1}`, kind: "vigil", text: `${k} (×${n} in 7 days)` }));
  const rec = src.reconcile();
  const byKey = new Map(rows.map((r) => [rowRef(r), r]));
  for (const r of rec?.rows ?? []) if (r.state === "off-track") { const row = byKey.get(r.key); pool.push({ id: `OFF-${r.key}`, kind: "off-track", text: row ? `${row.file} § ${row.section}: ${row.text}` : `${r.file} row ${r.key}` }); }
  return pool;
}

// ── the one model call ─────────────────────────────────────────────────────

/** The Superior Mind, verbatim from skills/Superior/SKILL.md. */
export const SUPERIOR_MIND = `- **It knows the field.** The best existing methods, the frontier work, the tools and prior art we have not heard of, how experts in adjacent fields solve the same shape of problem.
- **It sees the goal, not the ticket.** It may reframe the task, solve a bigger version that makes this one trivial, or show that the task should not exist.
- **It invents no limits.** Time, cost, tooling and "how it's done here" are questioned unless they are physics or a constraint the principal actually set. Real constraints it respects completely.
- **It reaches for leverage.** It looks for the one move that makes most of the work unnecessary before doing the work.
- **It is not anchored.** It never saw our first idea, so it is not improving our plan; it is producing its own.`;

export const SYSTEM_PROMPT = `You recommend changes to a person's ideal-state documents and to the monitoring that tracks them. You never decide; the person approves each recommendation with a yes.

Think as the Superior Mind: a far smarter, fully informed intelligence looking at this person's goals, gaps and complaints, asking what it would build to move their life to its ideal state.
${SUPERIOR_MIND}

Use that mind to pick the few recommendations with the most leverage: the watcher, workflow or Vigil monitor that would answer several gaps at once, the target that is missing, the measurement that would make a goal visible.

You get a candidate pool (each item has an id, a kind and its text), the ideal-state files with their section names, a data catalog of numeric JSON paths that exist today (paths only), and how many open slots remain.

Return JSON only, this shape:
{"rows":[{"file":"<one of the files>","section":"<an existing section in that file>","text":"<the new target row, one line, no trailing type tag>","source_id":"<candidate id>","source_quote":"<an exact substring copied from that candidate's text>","why":"<one sentence>"}],
 "builds":[{"serves":"<the IS- id of the target or goal it moves>","owner":"system|principal|others","title":"<short name>","gap":"<that target or goal, in a few words>","data_source":"<where the data comes from>","cadence":"<how often it runs>","severity":"info|low|medium|high|critical","brief":"<two or three sentences: what it does or watches, and the first move>","source_id":"<candidate id>"}],
 "bindings":[{"row_id":"<an unbound candidate id, ROW-...>","measure":"<a catalog entry, file#path>","target":<number from the row's text>,"by":"YYYY-MM-DD","why":"<one sentence>"}]}

Rules:
- A row describes the ideal state as already true, in the person's own first-person present tense, like the rows already in the files ("My calendar has two meeting-free days a week"). Never "should", never an instruction to a system, at most 25 words.
- Put a row in the file whose domain it belongs to: life targets in HEALTH, MONEY, FREEDOM, CREATIVE, RELATIONSHIPS or RHYTHMS; what the assistant and its tools do in INFRASTRUCTURE.
- Propose a row only where the candidate states or clearly implies a lasting target the files lack. Never invent a number the candidate does not contain.
- A "want" candidate is the person's own words about what they want. A row from one restates that want as already true, with source_quote copied from the want and no number the want lacks.
- Prefer sources in this order: an unpursued or stalled target or goal (marked "new" when it was just added), an uncovered goal, a want, an unanswerable standing question, an unbound or off-track target, a recurring Vigil event, then a complaint. A Vigil event that repeats is the best evidence for a missing watcher, a broken monitor or a fix worth building. A complaint earns a row only when it reveals a lasting target, not a one-off bug.
- source_quote must be copied character for character from the candidate's text.
- A build is a pursuit: the Workflow, watcher, nudge or small tool that would move one target or goal toward its ideal state, or measure it. Every build serves exactly one IS- id from an "unpursued" candidate (or another IS- id named in the candidates), and owner says who moves it: system (the assistant can do the work itself), principal (the person acts; the build nudges, schedules or removes friction) or others (someone else acts; the build tracks and follows up). Unpursued and newly seen targets come first. Its data_source names a concrete file, API or command; its cadence is a schedule ("daily 06:00", "every 4 hours", "weekly Monday"). Pick the builds that would close the biggest gap toward the person's goals.
- A binding connects an unbound target row to a catalog path that measures it, so the daily check can track its pace. Only use a catalog entry that truly measures the row, a target number stated in the row, and the row's own date or the end of its stated period.
- Call the person's system LifeOS, never PAI.
- Fewer is better. Return empty arrays when nothing earns a slot.`;

const PRIORITY: Candidate["kind"][] = ["unpursued", "goal", "want", "socrates", "off-track", "unbound", "vigil", "errata"];
export const MAX_PROMPT_ERRATA = 40;

/** Goals, questions and targets go in whole; complaints fill in after them, newest first, capped. */
export function promptCandidates(pool: Candidate[]): Candidate[] {
  const ordered = PRIORITY.flatMap((k) => pool.filter((c) => c.kind === k));
  const errata = ordered.filter((c) => c.kind === "errata").reverse().slice(0, MAX_PROMPT_ERRATA);
  return [...ordered.filter((c) => c.kind !== "errata"), ...errata];
}

export function userPrompt(pool: Candidate[], files: Record<string, string[]>, slots: { rows: number; builds: number; bindings: number }, catalog: string[] = []): string {
  return JSON.stringify({ open_slots: slots, files, data_catalog: catalog, candidates: promptCandidates(pool) });
}

// ── store ──────────────────────────────────────────────────────────────────

export const loadStore = (): RecStore => readJson<RecStore>(statePath("recommendations.json"), { recs: [] });
const STORE = "recommendations.json";

/** Read-modify-write of the store under its lock: `fn` changes the store it is given, which is then saved. */
export function mutateStore<T>(fn: (store: RecStore) => T, opts: TelosLockOptions = {}): T {
  return withLocks([statePath(STORE)], () => {
    const store = loadStore();
    const out = fn(store);
    saveStore(store);
    return out;
  }, opts);
}

export function saveStore(store: RecStore): void {
  const open = store.recs.filter((r) => r.status === "open");
  invariant(open.filter((r) => r.kind === "row").length <= MAX_OPEN_ROWS, `at most ${MAX_OPEN_ROWS} open row proposals`);
  invariant(open.filter((r) => r.kind === "build").length <= MAX_OPEN_BUILDS, `at most ${MAX_OPEN_BUILDS} open build recommendations`);
  invariant(open.filter((r) => r.kind === "binding").length <= MAX_OPEN_BINDINGS, `at most ${MAX_OPEN_BINDINGS} open binding recommendations`);
  invariant(new Set(store.recs.map((r) => r.id)).size === store.recs.length, "recommendation ids are unique");
  writeState(STORE, store);
}

export function expire(store: RecStore, now = new Date()): number {
  let n = 0;
  for (const r of store.recs) if (r.status === "open" && now.getTime() - Date.parse(r.created) > EXPIRE_DAYS * DAY) { r.status = "expired"; r.decided = now.toISOString(); n++; }
  return n;
}

export const newId = (now: Date): string => `ISR-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
/** The model's own words name the system LifeOS (vocabulary rule); quotes of the principal stay verbatim. */
const own = (v: unknown): string => str(v).replace(/\bPAI\b/g, "LifeOS");

/** Every number written in a text, thousands separators dropped: "$1,000.50 for 24-months" gives ["1000.50", "24"]. */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
}

/** True when every number in the row text also appears in the quote it claims to come from. */
export function numbersFromQuote(text: string, quote: string): boolean {
  const have = new Set(numbersIn(quote).map(Number));
  return numbersIn(text).every((n) => have.has(Number(n)));
}

/** Code gates on the model's answer. Returns only what survives. */
export function gate(parsed: unknown, pool: Candidate[], store: RecStore, files: Record<string, string[]>, now: Date, rows: Row[] = [], catalog: string[] = [], knownIds: Set<string> = new Set()): Rec[] {
  const p = (parsed && typeof parsed === "object" ? parsed : {}) as { rows?: unknown[]; builds?: unknown[]; bindings?: unknown[] };
  const byId = new Map(pool.map((c) => [c.id, c]));
  const open = store.recs.filter((r) => r.status === "open");
  const seen = new Set(store.recs.filter((r) => r.status !== "expired").map((r) => (r.text ?? r.title ?? "").toLowerCase()));
  let rowSlots = MAX_OPEN_ROWS - open.filter((r) => r.kind === "row").length;
  let buildSlots = MAX_OPEN_BUILDS - open.filter((r) => r.kind === "build").length;
  let bindSlots = MAX_OPEN_BINDINGS - open.filter((r) => r.kind === "binding").length;
  const out: Rec[] = [];
  for (const raw of Array.isArray(p.rows) ? p.rows : []) {
    if (rowSlots <= 0) break;
    const r = raw as Record<string, unknown>;
    const c = byId.get(str(r.source_id)), file = str(r.file), section = str(r.section), text = own(r.text).replace(/\.+$/, ""), quote = str(r.source_quote);
    if (!c || !text || !quote || !c.text.includes(quote)) continue;
    if (!numbersFromQuote(text, quote)) continue; // a number the quote lacks is invented
    if (!files[file] || !files[file]!.includes(section)) continue;
    if (/north.?star/i.test(section)) continue; // proposals are targets; north stars are his to write
    if (/—\s*type:/.test(text) || text.includes("\n") || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase()); rowSlots--;
    out.push({ id: newId(now), kind: "row", status: "open", created: now.toISOString(), source_id: c.id, source_kind: c.kind, file, section, text, source_quote: quote, why: own(r.why) || undefined });
  }
  for (const raw of Array.isArray(p.builds) ? p.builds : []) {
    if (buildSlots <= 0) break;
    const b = raw as Record<string, unknown>;
    const c = byId.get(str(b.source_id)), title = own(b.title), gap = own(b.gap), data_source = own(b.data_source), cadence = str(b.cadence), severity = str(b.severity), brief = own(b.brief);
    const serves = str(b.serves), owner = (str(b.owner) || "system") as Owner;
    if (!c || !title || !gap || !data_source || !cadence || !brief || !(SEVERITIES as readonly string[]).includes(severity)) continue;
    if (!ID_RE.test(serves) || !knownIds.has(serves) || !(OWNERS as readonly string[]).includes(owner)) continue; // a pursuit moves a row that exists
    if (seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase()); buildSlots--;
    out.push({ id: newId(now), kind: "build", status: "open", created: now.toISOString(), source_id: c.id, source_kind: c.kind, serves, owner, title, gap, data_source, cadence, severity, brief });
  }
  const openKeys = new Set(open.filter((r) => r.kind === "binding").map((r) => r.row_key));
  for (const raw of Array.isArray(p.bindings) ? p.bindings : []) {
    if (bindSlots <= 0) break;
    const b = raw as Record<string, unknown>;
    const rowId = str(b.row_id), key = rowId.replace(/^ROW-/, ""), measureRef = str(b.measure), by = str(b.by), target = typeof b.target === "number" ? b.target : Number(b.target), why = own(b.why);
    if (!why) continue; // a binding with no measurement reason is refused (ISC-78)
    const row = rows.find((r) => rowRef(r) === key || r.key === key);
    if (!row || row.type !== "target" || row.measure || openKeys.has(key) || !byId.has(rowId)) continue;
    if (!catalog.includes(measureRef) || !Number.isFinite(target) || !/^\d{4}-\d{2}-\d{2}$/.test(by) || Date.parse(`${by}T00:00:00Z`) <= now.getTime()) continue;
    const [mfile, mpath] = measureRef.split("#") as [string, string];
    const measure: NumericMeasure = { file: mfile, path: mpath, target, by };
    try { readValue({ ...row, measure }); } catch { continue; } // the path must read a number today
    openKeys.add(key); bindSlots--;
    out.push({ id: newId(now), kind: "binding", status: "open", created: now.toISOString(), source_id: rowId, source_kind: "unbound", row_key: rowRef(row), file: row.file, section: row.section, text: row.text, measure, why });
  }
  return out;
}

export function fileSections(dir = idealDir()): Record<string, string[]> {
  return Object.fromEntries(dimensionFiles(dir).map((f) => [f, sections(readFileSync(join(dir, f), "utf8"))]));
}

export async function defaultInfer(system: string, user: string): ReturnType<Infer> {
  const { inference } = await import("../TOOLS/Inference");
  return inference({ systemPrompt: system, userPrompt: user, level: "high", expectJson: true, vendor: "openai", allowVendorFallback: false, timeout: 300_000 });
}

export async function recommend(opts: { sources?: Sources; infer?: Infer; now?: Date; lock?: TelosLockOptions } = {}): Promise<{ added: Rec[]; expired: number; pool: number; skipped?: string }> {
  const now = opts.now ?? new Date();
  const src = opts.sources ?? liveSources;
  // A snapshot decides whether to ask the model and what to ask for. Every save re-reads the store under its
  // lock, so a decision taken while the model is thinking (minutes) is never written over.
  const store = loadStore();
  expire(store, now);
  const open = store.recs.filter((r) => r.status === "open");
  const slots = { rows: MAX_OPEN_ROWS - open.filter((r) => r.kind === "row").length, builds: MAX_OPEN_BUILDS - open.filter((r) => r.kind === "build").length, bindings: MAX_OPEN_BINDINGS - open.filter((r) => r.kind === "binding").length };
  const openIds = open.map((r) => r.id).sort();
  const expireOnly = () => mutateStore((s) => expire(s, now), opts.lock);
  // Daily schedule, but the model only runs when he decided something, something expired, or a week passed.
  const last = store.last_run;
  if (last && last.open_ids.join(",") === openIds.join(",") && now.getTime() - Date.parse(last.ts) < QUIET_DAYS * DAY) {
    return { added: [], expired: expireOnly(), pool: 0, skipped: "nothing decided since the last run" };
  }
  const pool = candidatePool(src, now);
  if (slots.rows + slots.builds + slots.bindings === 0 || pool.length === 0) {
    return { added: [], expired: expireOnly(), pool: pool.length, skipped: pool.length === 0 ? "empty pool" : "no open slots" };
  }
  const files = fileSections();
  const rows = src.rows(), catalog = src.catalog();
  const res = await (opts.infer ?? defaultInfer)(SYSTEM_PROMPT, userPrompt(pool, files, slots, catalog));
  if (!res.success) { expireOnly(); throw new Error(`inference failed: ${res.error ?? "unknown"}`); }
  // Only ids that exist now: live rows and goals, never a report's content hash or a deleted row.
  const knownIds = new Set([...rows, ...(src.goals?.() ?? [])].flatMap((r) => (r.id && ID_RE.test(r.id) ? [r.id] : [])));
  // The answer is gated against the store as it is now, so the caps and duplicate checks see any decision made meanwhile.
  const { added, expired } = mutateStore((fresh) => {
    const expired = expire(fresh, now);
    const added = gate(res.parsed, pool, fresh, files, now, rows, catalog, knownIds);
    fresh.recs.push(...added);
    fresh.last_run = { ts: now.toISOString(), open_ids: fresh.recs.filter((r) => r.status === "open").map((r) => r.id).sort() };
    return { added, expired };
  }, opts.lock);
  if (added.length) {
    const rows = added.filter((r) => r.kind === "row").length, builds = added.filter((r) => r.kind === "build").length, binds = added.filter((r) => r.kind === "binding").length;
    emitVigilEvent(vigilEvent("ideal-state", "recommendations", "ready", "medium", "New ideal-state recommendations are ready",
      `${rows} proposed ideal-state row(s), ${builds} recommended watcher or build(s) and ${binds} proposed measurement(s), waiting for a yes or no. See Pulse or run: bun LIFEOS/IDEALSTATE/IdealState.ts list`, "life", null, now.toISOString().slice(0, 10)));
  }
  return { added, expired, pool: pool.length };
}

// ── decisions (run on the principal's word) ────────────────────────────────

export function setFrontmatter(content: string, key: string, value: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return content;
  const fm = content.slice(0, end), re = new RegExp(`^${key}:.*$`, "m");
  return (re.test(fm) ? fm.replace(re, `${key}: ${value}`) : `${fm}\n${key}: ${value}`) + content.slice(end);
}

/** Inserts `- <text> — type: target` after the last row of the section, or right under its heading. */
export function insertRow(content: string, section: string, text: string, today: string, id?: string): string {
  const lines = content.split("\n");
  const h = lines.findIndex((l) => l.replace(/^##\s+/, "").trim() === section && /^##\s/.test(l));
  invariant(h >= 0, `section exists: ${section}`);
  let end = lines.findIndex((l, i) => i > h && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  let at = h + 1;
  for (let i = h + 1; i < end; i++) if (/^\s*-\s/.test(lines[i]!)) at = i + 1;
  lines.splice(at, 0, `- ${text} — type: target${id ? ` — id: ${id}` : ""}`);
  return setFrontmatter(setFrontmatter(lines.join("\n"), "last_updated", today), "last_updated_by", "da");
}

/**
 * The principal said yes. Takes the store's lock, the lock of the ideal-state file the recommendation
 * writes and, for a new row, the id registry's, all up front in lock order, then re-reads everything under
 * them. A busy lock throws TelosLockTimeout before anything is written.
 */
export function acceptRec(id: string, now = new Date(), opts: { lock?: TelosLockOptions } = {}): Rec {
  const peek = loadStore().recs.find((r) => r.id === id);
  if (!peek) throw new Error(`no recommendation ${id}`);
  const paths = [statePath(STORE)];
  if ((peek.kind === "binding" || peek.kind === "row") && peek.file) paths.push(join(idealDir(), peek.file));
  if (peek.kind === "row") paths.push(statePath("ids.json"));
  return withLocks(paths, () => acceptLocked(id, peek, now), opts.lock);
}

function acceptLocked(id: string, peek: Rec, now: Date): Rec {
  const store = loadStore();
  const rec = store.recs.find((r) => r.id === id);
  if (!rec) throw new Error(`no recommendation ${id}`);
  if (rec.status !== "open") throw new Error(`${id} is ${rec.status}, not open`);
  // A recommendation never changes kind or file; if it did between the peek and the lock, the wrong file is held.
  invariant(rec.kind === peek.kind && rec.file === peek.file, `${id} kept its kind and file while its locks were taken`);
  if (rec.kind === "binding") {
    invariant(rec.file && rec.row_key && rec.measure, "binding carries file, row key, measure");
    if (!(rec.why ?? "").trim()) throw new Error(`${id}: a binding needs a measurement reason before it can be accepted`);
    const path = join(idealDir(), rec.file);
    const content = readFileSync(path, "utf8");
    const row = parseRows(rec.file, content).find((r) => rowRef(r) === rec.row_key || r.key === rec.row_key);
    if (!row) throw new Error(`${id}: its row is no longer in ${rec.file}`);
    if (row.measure) throw new Error(`${id}: that row already has a measurement`);
    const lines = content.split("\n");
    lines[row.line - 1] = `${lines[row.line - 1]!.replace(/\s+$/, "")} — measure: ${formatMeasure(rec.measure)}`;
    const next = setFrontmatter(lines.join("\n"), "last_updated", now.toISOString().slice(0, 10));
    invariant(parseRows(rec.file, next).find((r) => rowRef(r) === rec.row_key || r.key === rec.row_key)?.measure, "the row parses as bound after accept");
    writeFileLocked(path, next);
  }
  if (rec.kind === "row") {
    invariant(rec.file && rec.section && rec.text, "row recommendation carries file, section, text");
    const path = join(idealDir(), rec.file);
    invariant(existsSync(path) && dimensionFiles().includes(rec.file), `target is an ideal-state dimension file: ${rec.file}`);
    writeFileLocked(path, insertRow(readFileSync(path, "utf8"), rec.section, rec.text, now.toISOString().slice(0, 10), issueRowId()));
  }
  rec.status = "accepted"; rec.decided = now.toISOString();
  saveStore(store);
  return rec;
}

export function dismissRec(id: string, now = new Date(), opts: { lock?: TelosLockOptions } = {}): Rec {
  return mutateStore((store) => {
    const rec = store.recs.find((r) => r.id === id);
    if (!rec) throw new Error(`no recommendation ${id}`);
    if (rec.status !== "open") throw new Error(`${id} is ${rec.status}, not open`);
    rec.status = "dismissed"; rec.decided = now.toISOString();
    return rec;
  }, opts.lock);
}
