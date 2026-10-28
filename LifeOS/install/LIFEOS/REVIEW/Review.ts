#!/usr/bin/env bun
/**
 * Review — LifeOS reviews itself daily, weekly and monthly, and asks the principal for at most three
 * decisions a week. Recommend-only: it writes LIFEOS/USER/REVIEW/ and the Vigil outbox, and files
 * one Upgrades record when the principal says yes. ISA: LIFEOS/REVIEW/ISA.md (maintainer-side, not shipped).
 *
 * Usage:
 *   bun Review.ts daily   [--json]          instruments, control chart, new clusters, due watches
 *   bun Review.ts weekly  [--json] [--dry-run]  pool every generator, rank, one model call, cap 3
 *   bun Review.ts monthly [--json]          score predictions, scorecard, label batch, fire drill, trend
 *   bun Review.ts list    [--json]          open recommendations
 *   bun Review.ts decide <id> y|n [--note "…"]
 *   bun Review.ts label <exchange-id> y|n   y = the detector was right
 *   bun Review.ts watches [--json]          registered before/after watches
 *   bun Review.ts watch add <id> --cut <ISO> --days N --label "…" [--metric m[:k=v]]... [--ref <Upgrades id|Ledger id>]...
 *   bun Review.ts status --json             everything /review shows, with as-of times
 *   bun Review.ts sources [--json]          every producer the weekly pool reads (sources.json), each ok, missing or unwired; exit 1 when one has no reader wired
 * Exit: 0 ok (alarms and model failures reach the principal as Review events, not as exit codes) · 1 crash or refused · 2 usage.
 *
 * @version 1.2.0
 *
 * Uses Assay's judgment layer (LIFEOS/DOCUMENTATION/Assay/AssaySystem.md).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getClaudeDir, lifeosPath } from "../TOOLS/Paths";
import { invariant, InvariantViolation } from "../TOOLS/Invariant";
import { defaultRepos, mdePct, suspects, type Suspect } from "../TOOLS/ChangeImpact";
import { addUpgrade, listUpgrades, setStatus } from "../TOOLS/Upgrades";
import { emitVigilEvent, vigilEvent as event, type VigilEvent } from "../TOOLS/lib/VigilOptional";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { vigilStatePath } from "../TOOLS/lib/VigilOptional";
import { loadQuestions } from "../SOCRATES/Registry";
import { appendJsonl, loadRecs, readJson, readJsonl, reviewPath, saveRecs, writeJson, type Rec } from "./Store";
import { checkSources, loadAdvocateRecs, loadProducers, readAdvocateRecs, readAuditProposals, readHypotheses, readIdealState, readJsonlSource, readOk, readSocratesOpen, readTriageClusters, readV4Recs, readVigilRecs, unread } from "./Sources";
import { exchangesHealth, glanceHealth, healthChanges, jobHealth, LEARNING_JOBS, type Instrument, type InstrumentState, type Job, type LastRun } from "./Health";
import { asOf, compare, errataDir, isMetric, loadData, measure, WORSE, type Data, type MetricId } from "./Metrics";
import { controlChart, dailySeries, newClusters, type Alarm } from "./Watch";
import { applyCooldown, buildPrompt, dedupe, deletionCandidate, expire, gate, MAX_OPEN_CHANGES, poolWithSources, rank, takesDecisionSlot, whatWorked, type MdeFor, type PoolSources, type RawRec, type SourceKey, type SourceStat, type UpgradeLike } from "./Weekly";
import { classTrend, detectorAgreement, fireDrill, labelBatch, scorecard, scoreRec, type LabelBatch } from "./Monthly";

const DAY = 86_400_000;

export interface Deps {
  now: () => Date;
  data: () => Data;
  emit: (e: VigilEvent) => void;
  lastRun: (job: Job) => LastRun | null;
  glanceStatus: () => string;
  suspects: (since: string, until: string) => Suspect[];
  pool: PoolSources;
  infer: (system: string, user: string) => Promise<{ success: boolean; parsed?: unknown; error?: string }>;
  upgrades: () => UpgradeLike[];
  fileUpgrade: (rec: Rec) => string;
  /** Whether `skills/<name>/` exists, so a skill-targeted change also gets that skill's complaint rate watched. */
  skillExists: (name: string) => boolean;
}

// ── Live dependencies ───────────────────────────────────────────────────────

function lastAgentJob(id: string): LastRun | null {
  const rows = readJsonl<{ ts: string; event: string; status?: string; error?: string }>(lifeosPath("USER", "MEMORY", "STATE", "agent-jobs", `${id}.jsonl`)).filter((r) => r.event === "run_end");
  const r = rows.at(-1);
  return r ? { ts: r.ts, ok: r.status === "ok", detail: r.error } : null;
}

function lastWorkflow(id: string): LastRun | null {
  const path = lifeosPath("MEMORY", "STATE", "workflows", "runs.jsonl");
  if (!existsSync(path)) return null;
  // The ledger is append-only and large; scan from the end for the newest finished run.
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(`"workflow":"${id}"`)) continue;
    try {
      const r = JSON.parse(lines[i]) as { status: string; finished_at?: string; started_at?: string };
      if (r.status === "running" || r.status === "queued") continue;
      return { ts: r.finished_at ?? r.started_at ?? "", ok: r.status === "succeeded", detail: r.status };
    } catch {}
  }
  return null;
}

/** The Upgrades records directory (Upgrades.ts storePaths): the queue has no reader result of its own, so presence is checked here. */
const upgradesRecordsDir = () => join(process.env.LIFEOS_UPGRADES_DIR || lifeosPath("MEMORY", "UPGRADES"), "records");

/** The live deps with the record-backed pool sources read first: the advocate's recommendations come from the cloud record (STATVS migration ISA ISC-179). */
export async function withRecord(deps: Deps, load = loadAdvocateRecs): Promise<Deps> {
  const advocate = await load();
  return { ...deps, pool: { ...deps.pool, vigilAdvocate: () => advocate } };
}

export function liveDeps(): Deps {
  let cached: Data | null = null;
  const root = getClaudeDir();
  return {
    now: () => new Date(),
    data: () => (cached ??= loadData()),
    emit: (e) => { emitVigilEvent(e); },
    lastRun: (job) => (job.kind === "agent-job" ? lastAgentJob(job.id) : lastWorkflow(job.id)),
    glanceStatus: () => { try { return execFileSync("bun", [join(root, "LIFEOS/ASSAY/Assay.ts"), "status"], { encoding: "utf8", timeout: 60_000 }); } catch { return ""; } },
    suspects: (since, until) => suspects(defaultRepos(), since, until),
    pool: {
      upgrades: () => (existsSync(upgradesRecordsDir()) ? readOk(listUpgrades() as unknown as UpgradeLike[]) : unread(`missing: ${upgradesRecordsDir()}`)),
      idealRecs: () => readIdealState(join(process.env.HOME ?? "", ".local/state/lifeos/ideal-state/recommendations.json"), join(process.env.HOME ?? "", ".local/state/lifeos/ideal-state/reconcile.json")),
      v4Recs: () => readV4Recs(join(lifeosPath("USER", "ERRATA"), "v4")),
      // A survey that fails or answers without a hills list is unread; poolWithSources records the error.
      hills: () => {
        const out = JSON.parse(execFileSync("bun", [join(root, "skills/HillClimb/Tools/HillClimb.ts"), "survey", "--top", "15", "--json"], { encoding: "utf8", timeout: 120_000 })) as { hills?: unknown };
        if (!Array.isArray(out.hills)) throw new Error("HillClimb survey answered without a hills list");
        return out.hills as never;
      },
      alarms: () => readJsonlSource(reviewPath("alarms.jsonl")),
      auditProposals: () => readAuditProposals(process.env.ERRATA_AUDIT_DIR || join(errataDir(), "audit")),
      triageClusters: () => readTriageClusters(join(errataDir(), "reports")),
      socrates: () => readSocratesOpen(process.env.SOCRATES_FINDINGS ?? lifeosPath("USER", "SOCRATES", "findings.jsonl"), loadQuestions),
      hypotheses: () => readHypotheses(lifeosPath("MEMORY", "WISDOM", "FRAMES", "_hypotheses"), new Date()),
      modelAdvisor: () => readVigilRecs(vigilStatePath("outbox.jsonl"), "model-advisor"),
      shadowExpiry: () => readVigilRecs(vigilStatePath("outbox.jsonl"), "shadow-expiry"),
      vigilAdvocate: () => readAdvocateRecs(),
    },
    infer: async (system, user) => {
      const { inference } = await import("../TOOLS/Inference");
      const res = await inference({ systemPrompt: system, userPrompt: user, level: "high", expectJson: true, vendor: "openai", allowVendorFallback: false, timeout: 300_000 });
      return { success: res.success, parsed: res.parsed, error: res.error };
    },
    upgrades: () => listUpgrades() as unknown as UpgradeLike[],
    skillExists: (name) => existsSync(join(root, "skills", name)),
    fileUpgrade: (rec) => {
      const pred = rec.prediction ? `Prediction: ${rec.prediction.metric}${rec.prediction.args ? ` ${JSON.stringify(rec.prediction.args)}` : ""} ${rec.prediction.direction} ${rec.prediction.size_pct}% by ${rec.prediction.due} (p ${rec.prediction.p})` : "No prediction (deletion)";
      const res = addUpgrade({ claim: rec.title, source: "review", recommendation: rec.change, target_surface: rec.target, current_state: pred, evidence: [`review:${rec.id}`, ...rec.evidence] });
      invariant(!!res.id, `Upgrades record filed for ${rec.id}: ${res.reason ?? ""}`);
      setStatus(res.id, "accepted", { note: `Principal: y on Review ${rec.id}` });
      return res.id;
    },
  };
}

/**
 * Every Review event passes here, so this is where its text is made safe for Vigil. Vigil refuses any
 * event whose title, ref or key carries a long unbroken run or a token prefix, and refusal loses the
 * event. Ids, labels and class names come from records and watch files, so each such run is shortened
 * to its head plus a hash of the whole (a long id in a watch ref can crash a scheduled run).
 */
const TOKENISH = /\b(?:sk|pk|ghp|glpat|csk)-|[A-Za-z0-9_+\/=.~-]{24,}/gi;
const safe = (text: string): string => text.replace(TOKENISH, (m) => m.length < 24 ? m.replace("-", "\u2010") : `${m.slice(0, 8).replace(/-/g, "\u2010")}…${createHash("sha256").update(m).digest("hex").slice(0, 6)}`);
const ev = (ref: string, state: string, severity: VigilEvent["severity"], title: string, summary: string, occurrence?: string) =>
  event("review", safe(ref), state, severity, safe(title), safe(summary), "infra", null, occurrence === undefined ? undefined : safe(occurrence));

// ── Daily ───────────────────────────────────────────────────────────────────

/**
 * A before/after watch on a landed change. `refs` names the Upgrades record ids and Ledger ids it measures:
 * /review joins an applied change to a watch only on exact equality of a ref, or the watch id, to the
 * record id or Ledger id (ISC-69). `rollback_held` is when a worse verdict found the decision cap full.
 */
export interface WatchDef { id: string; label: string; cut: string; days: number; metrics: Array<{ metric: MetricId; args?: Record<string, string> }>; refs?: string[]; result?: unknown; rollback_held?: string; cut_source?: CutSource }

/** Where an auto-registered watch took its cut from: the record's last applied note, or its created time when it has none. Kept out of the label, which people read (ISC-91). */
export type CutSource = "applied note" | "created time";

/** Window, in days, of a watch Review registers for an applied change. */
export const UPGRADE_WATCH_DAYS = 14;
export const UPGRADE_WATCH_PREFIX = "upgrade-";

/**
 * The id of the watch Review registers for an Upgrades record: the prefix, the first 15 characters of the record id,
 * and 6 hex characters of a hash of the whole id. Record ids run to 75 characters, and a watch id lands in Vigil
 * dedup keys and event text, where a long unbroken run is refused as credential-shaped (ISC-85). The full record id
 * stays in the watch's refs, which is what /review joins on.
 */
export function upgradeWatchId(recordId: string): string {
  const head = recordId.slice(0, 15).replace(/[^A-Za-z0-9_.-]/g, "-");
  return `${UPGRADE_WATCH_PREFIX}${head}-${createHash("sha256").update(recordId).digest("hex").slice(0, 6)}`;
}

/** An applied change older than this many days gets no new watch: /review labels it "applied before watches" (ISC-73, ISC-78). */
export const WATCH_REGISTER_DAYS = 28;

/** When a record was applied: the time on its last "applied" note, else its created time (fromNote false). */
export function appliedCut(u: { notes?: string[]; created: string }): { cut: string; fromNote: boolean } {
  const stamp = [...(u.notes ?? [])].reverse().map((n) => /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+—\s+applied\b/.exec(n)?.[1]).find((t) => t && !Number.isNaN(Date.parse(t)));
  return stamp ? { cut: stamp, fromNote: true } : { cut: u.created, fromNote: false };
}

/** The skill a record's target_surface names (`skills/<Name>/...`) when that skill exists, else null. */
function targetSkill(deps: Deps, surface: string | undefined): string | null {
  for (const m of (surface ?? "").matchAll(/skills\/([A-Za-z0-9_-]+)/g)) if (deps.skillExists(m[1])) return m[1];
  return null;
}

/**
 * ISC-73: a watch for every Upgrades record in status applied or verified, applied within the last 28 days,
 * that no existing watch names. An older change is not watched: its measurement would be the overall complaint
 * rates since, which measure everything else that changed too (/review labels it instead, ISC-78).
 * A watch names a record when its id or one of its refs is the record id, or (for a watch not made here)
 * the record's Ledger id: one Ledger entry can cover several records, so a watch registered here for one
 * record never covers the others. The cut is the time of the record's last "applied" note; with no such
 * note it is the record's created time, and `cut_source` says so; the label is the claim alone (ISC-91). Writes only watches.json, through addWatch,
 * so a second run registers nothing new.
 */
/** More than this many records marked applied inside one hour is a reconciliation sweep, not changes landing (ISC-97). */
export const BURST_MAX = 10;
const HOUR = 3_600_000;

/** Ids of records whose applied time falls in a one-hour window holding more than BURST_MAX applied times. */
export function burstApplied(ups: UpgradeLike[]): Set<string> {
  const times = ups.filter((u) => u.status === "applied" || u.status === "verified")
    .map((u) => ({ id: u.id, t: Date.parse(appliedCut(u).cut) })).filter((x) => !Number.isNaN(x.t)).sort((a, b) => a.t - b.t);
  const out = new Set<string>();
  for (let i = 0, j = 0; j < times.length; j++) {
    while (times[j].t - times[i].t > HOUR) i++;
    if (j - i + 1 > BURST_MAX) for (let k = i; k <= j; k++) out.add(times[k].id);
  }
  return out;
}

export function registerUpgradeWatches(deps: Deps): string[] {
  const registered: string[] = [];
  const named = (ws: WatchDef[]) => new Set(ws.flatMap((w) => [w.id, ...(w.refs ?? [])]));
  const ups = deps.upgrades();
  const burst = burstApplied(ups);
  for (const u of ups) {
    if (u.status !== "applied" && u.status !== "verified") continue;
    if (burst.has(u.id)) continue;
    const existing = readJson<WatchDef[]>(reviewPath("watches.json"), []);
    const ledger = u.ledger_id ? u.ledger_id : null;
    const own = named(existing.filter((w) => !w.id.startsWith(UPGRADE_WATCH_PREFIX)));
    if (named(existing).has(u.id) || (ledger && own.has(ledger))) continue;
    const { cut, fromNote } = appliedCut(u);
    if (Number.isNaN(Date.parse(cut))) continue;
    if (Date.parse(cut) < deps.now().getTime() - WATCH_REGISTER_DAYS * DAY) continue;
    const skill = targetSkill(deps, u.target_surface);
    const claim = u.claim.length > 70 ? `${u.claim.slice(0, 67).trimEnd()}...` : u.claim;
    const id = upgradeWatchId(u.id);
    const refs = [u.id, ...(ledger ? [ledger] : [])];
    addWatch({
      id, label: claim, cut, cut_source: fromNote ? "applied note" : "created time", days: UPGRADE_WATCH_DAYS,
      metrics: [{ metric: "complaint_rate" }, { metric: "turn_corrections" }, ...(skill ? [{ metric: "skill_complaint_rate" as const, args: { skill } }] : [])],
      refs,
    });
    invariant(readJson<WatchDef[]>(reviewPath("watches.json"), []).some((w) => w.id === id && w.refs?.includes(u.id)), `watch ${id} was written with refs naming ${u.id}`);
    registered.push(id);
  }
  return registered;
}

/**
 * Wraps deps.emit so a refused or failed event is counted instead of thrown (ISC-86): the day's writes and its run line
 * matter more than any one event. An InvariantViolation is a programmer error and still propagates. The first error's
 * message is kept, truncated; the event itself is never recorded.
 */
function guardEmit(deps: Deps): { deps: Deps; failures: () => { count: number; first?: string } } {
  let count = 0, first: string | undefined;
  const emit = (e: VigilEvent) => {
    try { deps.emit(e); } catch (err) {
      if (err instanceof InvariantViolation) throw err;
      count++;
      first ??= String((err as Error)?.message ?? err).slice(0, 160);
    }
  };
  return { deps: { ...deps, emit }, failures: () => ({ count, first }) };
}

export function daily(rawDeps: Deps) {
  const guard = guardEmit(rawDeps), deps = guard.deps;
  const now = deps.now(), d = deps.data();
  const sources = asOf(d);
  // An unreadable Upgrades store must not stop the day's instruments; it only means no new watch today.
  let registered: string[] = [], registerError: string | undefined;
  try { registered = registerUpgradeWatches(deps); } catch (e) { if (e instanceof InvariantViolation) throw e; registerError = String((e as Error).message ?? e).slice(0, 200); }
  // Watches are measured first, so a watch that could not be measured is an instrument fault in the same run.
  const watches = evaluateWatches(deps, now, d);
  const instruments: Instrument[] = [
    ...jobHealth(LEARNING_JOBS, deps.lastRun, now),
    exchangesHealth(sources.exchanges, now),
    ...glanceHealth(deps.glanceStatus(), now),
    ...overdueWatches(readJson<WatchDef[]>(reviewPath("watches.json"), []), watches.failed, now),
  ];
  const prev = readJson<Record<string, InstrumentState>>(reviewPath("health.json"), {});
  const changed = healthChanges(prev, instruments);
  // A dead learning job or data feed blinds every number downstream (high); a noisy Glance caller is worth knowing, not a page (medium).
  for (const i of changed) deps.emit(ev(`instrument:${i.id}`, i.state, i.state === "ok" ? "info" : i.kind === "glance" ? "medium" : "high", `Review: ${i.id} is ${i.state}`, i.detail));
  writeJson(reviewPath("health.json"), Object.fromEntries(instruments.map((i) => [i.id, i.state])));

  // A stale exchange feed would read as a quiet day, so the chart runs only on fresh data.
  const fresh = instruments.find((i) => i.id === "errata-exchanges")?.state === "ok";
  const series = dailySeries(d.exchanges, d.isFailure, new Date(now.getTime() - DAY), 60);
  const alarms: Array<Alarm & { suspects: Suspect[] }> = [];
  if (fresh) {
    const found = [...controlChart(series), ...newClusters(d.exchanges, d.classOf, now)];
    const sus = found.length ? deps.suspects(new Date(now.getTime() - 2 * DAY).toISOString(), now.toISOString()) : [];
    for (const a of found) {
      const already = readJsonl<Alarm>(reviewPath("alarms.jsonl")).some((x) => x.date === a.date && x.rule === a.rule && x.class === a.class);
      if (already) continue;
      alarms.push({ ...a, suspects: sus.slice(0, 15) });
      appendJsonl(reviewPath("alarms.jsonl"), { ...a, suspects: sus.slice(0, 15).map((s) => `${s.sha} ${s.subject}`) });
      deps.emit(ev(`alarm:${a.rule}${a.class ? `:${a.class}` : ""}`, "fired", "medium", `Review: ${a.rule === "new-cluster" ? "new failure cluster" : "failure rate shifted"}`, `${a.detail}. ${sus.length} behavior commits in the prior 48h.`, a.date));
    }
  }
  const run = { ts: now.toISOString(), cadence: "daily", as_of: sources, instruments: instruments.length, changed: changed.length, alarms: alarms.length, watches: watches.measured.length, watches_registered: registered.length, ...(registerError ? { watch_register_error: registerError } : {}), rollbacks: watches.rollbacks.length, rollbacks_held: watches.held.length, ...(guard.failures().count ? { emit_failures: guard.failures().count, emit_first_error: guard.failures().first } : {}) };
  appendJsonl(reviewPath("runs.jsonl"), run);
  return { run, instruments, changed, series: series.slice(-14), alarms, watches: watches.measured, registered, rollbacks: watches.rollbacks, held: watches.held };
}

/** Days after its due date a watch not yet measured may wait before it is an alarm. A failed measurement gets none. */
export const WATCH_GRACE_DAYS = 2;

/**
 * A watch past its due date with no verdict is a dead instrument (ISC-64). One whose measurement failed
 * after its due date alarms at once; one the daily run has not reached yet gets WATCH_GRACE_DAYS. As an
 * instrument it rides the health path: one high Vigil event when it goes stale, none while it stays so.
 */
export function overdueWatches(watches: WatchDef[], failed: Record<string, string>, now: Date): Instrument[] {
  return watches.filter((w) => {
    if (w.result) return false;
    const due = Date.parse(w.cut) + w.days * DAY;
    return failed[w.id] ? due <= now.getTime() : due + WATCH_GRACE_DAYS * DAY < now.getTime();
  }).map((w) => {
    const due = new Date(Date.parse(w.cut) + w.days * DAY);
    const late = Math.floor((now.getTime() - due.getTime()) / DAY);
    return { id: `watch:${w.id}`, kind: "data" as const, state: "stale" as const, last: null, detail: `${w.label}: due ${due.toISOString().slice(0, 10)}, ${late} days with no verdict${failed[w.id] ? ` (measuring failed: ${failed[w.id].slice(0, 160)})` : ""}` };
  });
}

interface MeasuredMetric { metric: string; args?: Record<string, string>; change_pct: number | null; mde_pct: number; state: string }
const resultsOf = (w: WatchDef): MeasuredMetric[] => (w.result as { results?: MeasuredMetric[] } | undefined)?.results ?? [];
const worseOf = (w: WatchDef): MeasuredMetric[] => resultsOf(w).filter((r) => isMetric(r.metric) && r.state === WORSE[r.metric]);
/**
 * Metrics that name one skill, class or rule. complaint_rate, failure_rate and turn_corrections count the whole system,
 * so they move with everything else that landed in the window and say nothing about one change (ISC-84).
 */
export const SPECIFIC_METRICS: ReadonlySet<string> = new Set(["skill_complaint_rate", "class_rate", "rule_breaks"]);
/** The worse numbers that can justify a rollback decision: worse and specific to the change. */
const rollbackWorse = (w: WatchDef): MeasuredMetric[] => worseOf(w).filter((r) => SPECIFIC_METRICS.has(r.metric));
export const rollbackKey = (watchId: string): string => `rollback:${watchId}`;

/** Open decisions sharing the cap of three (ISC-17, ISC-70), counted as the weekly run would after expiry. */
export const openDecisions = (recs: Rec[], now: Date): Rec[] => expire(recs, now).filter((r) => r.status === "open" && takesDecisionSlot(r));

/** Watches measured worse on a number specific to the change (ISC-84) whose rollback decision was never filed, under any status: each waits for a decision slot. */
export function pendingRollbacks(watches: WatchDef[], recs: Rec[]): WatchDef[] {
  return watches.filter((w) => rollbackWorse(w).length > 0 && !recs.some((r) => r.key === rollbackKey(w.id)));
}

/**
 * Measures every due watch, then files one rollback decision per watch measured worse, this run's and any
 * held from earlier runs, while the cap of three open decisions has room (ISC-70). With the cap full the
 * rollback is held: one high Vigil event names the worse watch, and the first daily run with room files it.
 */
export function evaluateWatches(deps: Deps, now: Date, d: Data) {
  const all = readJson<WatchDef[]>(reviewPath("watches.json"), []);
  const done: WatchDef[] = [], failed: Record<string, string> = {};
  let watchesChanged = false;
  for (const w of all) {
    if (w.result || Date.parse(w.cut) + w.days * DAY > now.getTime()) continue;
    // One watch that cannot be measured must not stop the others; it stays unmeasured and overdueWatches reports it.
    let results: MeasuredMetric[];
    try {
      results = w.metrics.map((m) => {
        const c = compare(m.metric, m.args, Date.parse(w.cut), w.days * DAY, d);
        const thin = c.before.n < 200 || c.after.n < 200;
        const state = thin ? "insufficient-data" : c.change_pct === null ? "no-change" : Math.abs(c.change_pct) < c.mde_pct ? "underpowered" : c.change_pct < 0 ? "down" : "up";
        return { ...m, ...c, state };
      });
    } catch (e) { failed[w.id] = String((e as Error).message ?? e); continue; }
    w.result = { ts: now.toISOString(), results };
    done.push(w);
    watchesChanged = true;
  }

  const store = loadRecs();
  const openBefore = openDecisions(store.recs, now);
  let room = MAX_OPEN_CHANGES - openBefore.length;
  const filed: Rec[] = [], held: string[] = [];
  for (const w of pendingRollbacks(all, store.recs)) {
    if (room > 0) {
      filed.push(rollbackRec(w, rollbackWorse(w), now));
      room--;
      if (w.rollback_held) {
        deps.emit(ev(`watch:${w.id}`, "rollback-filed", "high", `Review: ${w.label} got worse; a rollback decision is now open`, `Held since ${w.rollback_held} for want of a decision slot.`));
        delete w.rollback_held; watchesChanged = true;
      }
      continue;
    }
    held.push(w.id);
    if (w.rollback_held) continue;
    w.rollback_held = now.toISOString();
    watchesChanged = true;
    deps.emit(ev(`rollback:${w.id}`, "held", "high", `Review: ${w.label} got worse; its rollback decision waits for a slot`,
      `The ${w.id} watch measured ${movedText(rollbackWorse(w))}. The ${MAX_OPEN_CHANGES} open decisions are full (${openBefore.map((r) => r.id).join(", ")}), so the rollback decision is filed on the first daily run with room. Nothing was changed.`));
  }
  for (const w of done) {
    const rb = filed.find((r) => r.key === rollbackKey(w.id));
    const note = rb ? `. Worse: review or roll back, decision ${rb.id}.` : held.includes(w.id) ? ". Worse: the rollback decision is held until a decision slot opens." : worseOf(w).length ? ". Worse on system-wide numbers only, which any other change can move: no rollback decision." : "";
    deps.emit(ev(`watch:${w.id}`, "measured", "medium", `Review: ${w.label} measured`, resultsOf(w).map((r) => `${r.metric} ${r.state}${r.change_pct !== null ? ` (${r.change_pct}%, detectable ±${r.mde_pct}%)` : ""}`).join("; ") + note));
  }
  if (watchesChanged) writeJson(reviewPath("watches.json"), all);
  if (filed.length) {
    store.recs.push(...filed);
    invariant(openDecisions(store.recs, now).length <= MAX_OPEN_CHANGES, `filing ${filed.length} rollback decision(s) keeps open decisions within ${MAX_OPEN_CHANGES}`);
    saveRecs(store);
  }
  return { measured: done, failed, rollbacks: filed, held };
}

const movedText = (worse: Array<{ metric: string; args?: Record<string, string>; change_pct: number | null; mde_pct: number }>): string =>
  worse.map((r) => `${r.metric}${r.args ? ` ${Object.values(r.args).join(",")}` : ""} +${r.change_pct}% (detectable ±${r.mde_pct}%)`).join("; ");

/**
 * A watch that measured its change making a number worse files one open decision: review the change or
 * roll it back (ISC-63). It applies nothing; a yes goes the normal way, through one Upgrades record.
 * It is one of the three open decisions (ISC-70), so it takes a slot a new change would otherwise get.
 */
export function rollbackRec(w: WatchDef, worse: Array<{ metric: string; args?: Record<string, string>; change_pct: number | null; mde_pct: number }>, now: Date): Rec {
  return {
    id: `rv-${now.toISOString().slice(0, 10).replace(/-/g, "")}-rb-${randomBytes(2).toString("hex")}`,
    kind: "rollback", status: "open", created: now.toISOString(), fix_type: "delete",
    title: `Review or roll back "${w.label}": ${worse.length === 1 ? "a number" : `${worse.length} numbers`} got worse after it landed`,
    change: `The ${w.id} watch measured ${w.days} days after ${w.cut.slice(0, 10)}: ${movedText(worse)}. Decide whether to roll the change back or keep it and find why. Nothing was changed.`,
    target: w.label, evidence: [`watch:${w.id}`], generators: ["review-watch"], key: rollbackKey(w.id),
  };
}

// ── Weekly ──────────────────────────────────────────────────────────────────

export async function weekly(deps: Deps, opts: { dryRun?: boolean } = {}) {
  const now = deps.now(), d = deps.data();
  const store = loadRecs();
  store.recs = expire(store.recs, now);
  const open = store.recs.filter((r) => r.status === "open");
  // Open rollbacks share the cap of three, and a rollback held for want of a slot keeps its place (ISC-70).
  const held = pendingRollbacks(readJson<WatchDef[]>(reviewPath("watches.json"), []), store.recs).length;
  const slots = Math.max(0, MAX_OPEN_CHANGES - open.filter(takesDecisionSlot).length - held);
  const built = poolWithSources(deps.pool, now);
  const pool = rank(applyCooldown(dedupe(built.pool), store.recs, now));
  const top = pool.slice(0, 15);
  const mdeFor: MdeFor = (metric, args, spanMs) => {
    const before = measure(metric, args, now.getTime() - spanMs, now.getTime(), d);
    return { mde_pct: compareMde(before.count, before.n), baseline: before.rate };
  };
  const baselines = Object.fromEntries((["failure_rate", "complaint_rate", "turn_corrections"] as MetricId[]).map((m) => {
    const b = measure(m, undefined, now.getTime() - 14 * DAY, now.getTime(), d), w = measure(m, undefined, now.getTime() - 28 * DAY, now.getTime(), d);
    return [m, { rate: b.rate === null ? null : Math.round(10000 * b.rate) / 10000, detectable_pct_28d: compareMde(w.count, w.n) }];
  }));
  let accepted: Rec[] = [], rejected: Array<{ title: string; reason: string }> = [], modelCalls = 0, error: string | undefined;
  if (slots > 0 && top.length) {
    const { system, user } = buildPrompt(top, slots, baselines, now);
    if (!opts.dryRun) {
      modelCalls++;
      const res = await deps.infer(system, user);
      if (!res.success) error = res.error ?? "inference failed";
      else {
        const raw = ((res.parsed as { recommendations?: RawRec[] } | undefined)?.recommendations ?? []);
        ({ accepted, rejected } = gate(raw, top, mdeFor, now, slots));
      }
    }
  }
  let deletion: Rec | null = null;
  if (!open.some((r) => r.kind === "deletion")) {
    deletion = deletionCandidate(deps.upgrades(), now);
    if (deletion && store.recs.some((r) => r.key === deletion!.key && r.status === "dismissed" && now.getTime() - Date.parse(r.decided ?? r.created) < 30 * DAY)) deletion = null;
  }
  const lastWeekly = readJsonl<{ ts: string; cadence: string }>(reviewPath("runs.jsonl")).filter((r) => r.cadence === "weekly").at(-1)?.ts ?? null;
  const worked = whatWorked(store.recs, lastWeekly);
  const sources = sourceRecord(built.sources);
  if (!opts.dryRun) {
    invariant(accepted.length <= slots, `weekly accepts at most its ${slots} free decision slot(s)`);
    store.recs.push(...accepted, ...(deletion ? [deletion] : []));
    saveRecs(store);
    const added = accepted.length + (deletion ? 1 : 0);
    if (added) deps.emit(ev("weekly", "ready", "medium", `Review: ${added} decision${added === 1 ? "" : "s"} ready`, `${accepted.length} change, ${deletion ? 1 : 0} deletion, ${worked.length} predictions came true. Open /review or run: bun LIFEOS/REVIEW/Review.ts list`, now.toISOString().slice(0, 10)));
    if (error) deps.emit(ev("weekly", "model-failed", "medium", "Review: weekly model call failed", error.slice(0, 300), now.toISOString().slice(0, 10)));
    appendJsonl(reviewPath("runs.jsonl"), { ts: now.toISOString(), cadence: "weekly", as_of: asOf(d), pool: pool.length, slots, model_calls: modelCalls, accepted: accepted.length, rejected: rejected.length, deletion: !!deletion, worked: worked.length, error: error ?? null, sources });
  }
  return { sources, pool: pool.length, top: top.map((c) => ({ id: c.id, generator: c.generator, claim: c.claim.slice(0, 160) })), slots, model_calls: modelCalls, accepted, rejected, deletion, worked, error };
}

/** Per-source stats keyed by the producer id sources.json gives each reader (ISC-68, ISC-72); a reader it does not list keeps its own key. */
function sourceRecord(stats: Record<SourceKey, SourceStat>): Record<string, SourceStat> {
  const idOf = new Map(loadProducers().map((p) => [p.reader, p.id]));
  return Object.fromEntries(Object.entries(stats).map(([reader, s]) => [idOf.get(reader) ?? reader, s]));
}

/** Same-size before and after windows: the detectable change depends only on the before count. */
const compareMde = (count: number, n: number) => mdePct(count, n, n);

// ── Monthly ─────────────────────────────────────────────────────────────────

export function monthly(deps: Deps) {
  const now = deps.now(), d = deps.data();
  const store = loadRecs();
  const scored: Rec[] = [];
  store.recs = store.recs.map((r) => { const s = scoreRec(r, d, now); if (!s) return r; const n = { ...r, score: s }; scored.push(n); return n; });
  saveRecs(store);
  const card = scorecard(deps.upgrades(), store.recs, now);
  const month = now.toISOString().slice(0, 7);
  const batchPath = reviewPath("labels", `${month}.json`);
  let batch = readJson<LabelBatch | null>(batchPath, null);
  if (!batch) { batch = labelBatch(d, now); writeJson(batchPath, batch); }
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const agreement = detectorAgreement(readJson<LabelBatch>(reviewPath("labels", `${prevMonth}.json`), { month: prevMonth, created: "", items: [] }));
  const drill = fireDrill(now);
  const trend = classTrend(d, now);
  appendJsonl(reviewPath("scorecard.jsonl"), { ts: now.toISOString(), month, card, agreement, drill, scored: scored.map((r) => ({ id: r.id, result: r.score?.result })) });
  appendJsonl(reviewPath("runs.jsonl"), { ts: now.toISOString(), cadence: "monthly", as_of: asOf(d), scored: scored.length, fire_drill: drill.fired });
  if (!drill.fired) deps.emit(ev("fire-drill", "failed", "high", "Review: the daily watch missed an injected spike", "The control chart did not alarm on the fire-drill fixture, so a quiet day means nothing until it is fixed.", month));
  deps.emit(ev("monthly", "ready", "medium", "Review: monthly scorecard ready", `${scored.length} predictions scored, ${batch.items.filter((i) => !i.label).length} labels to confirm, fire drill ${drill.fired ? "passed" : "FAILED"}.`, month));
  return { scored, card, batch: { month: batch.month, items: batch.items.length, unlabeled: batch.items.filter((i) => !i.label).length }, agreement, drill, trend: trend.slice(0, 12) };
}

// ── Decide, label, watches, status ──────────────────────────────────────────

export function decide(deps: Deps, id: string, yes: boolean, note?: string): Rec {
  const store = loadRecs();
  const rec = store.recs.find((r) => r.id === id);
  if (!rec) throw new Error(`no recommendation ${id}`);
  if (rec.status !== "open") throw new Error(`${id} is ${rec.status}, not open`);
  const now = deps.now().toISOString();
  rec.status = yes ? "accepted" : "dismissed";
  rec.decided = now;
  if (note) rec.note = note;
  if (yes) rec.upgrade_id = deps.fileUpgrade(rec);
  saveRecs(store);
  return rec;
}

export function label(deps: Deps, id: string, right: boolean): LabelBatch {
  const month = deps.now().toISOString().slice(0, 7);
  const months = [month, new Date(Date.UTC(deps.now().getUTCFullYear(), deps.now().getUTCMonth() - 1, 1)).toISOString().slice(0, 7)];
  for (const m of months) {
    const path = reviewPath("labels", `${m}.json`);
    const batch = readJson<LabelBatch | null>(path, null);
    const item = batch?.items.find((i) => i.id === id);
    if (!batch || !item) continue;
    item.label = right ? "y" : "n";
    writeJson(path, batch);
    return batch;
  }
  throw new Error(`no label item ${id} in ${months.join(" or ")}`);
}

export function addWatch(w: WatchDef): void {
  invariant(!!w.id && !Number.isNaN(Date.parse(w.cut)) && w.days > 0 && w.metrics.length > 0 && w.metrics.every((m) => isMetric(m.metric)), "watch has id, cut, days and catalog metrics");
  invariant(w.refs === undefined || (Array.isArray(w.refs) && w.refs.every((r) => typeof r === "string" && r.trim() === r && r.length > 0)), "watch refs are non-empty trimmed strings");
  invariant(w.cut_source === undefined || w.cut_source === "applied note" || w.cut_source === "created time", "watch cut_source is applied note or created time");
  const all = readJson<WatchDef[]>(reviewPath("watches.json"), []).filter((x) => x.id !== w.id);
  writeJson(reviewPath("watches.json"), [...all, w]);
}

export function status(deps: Deps) {
  const d = deps.data();
  const recs = loadRecs().recs;
  const scorecards = readJsonl<Record<string, unknown>>(reviewPath("scorecard.jsonl"));
  const month = deps.now().toISOString().slice(0, 7);
  const batch = readJson<LabelBatch | null>(reviewPath("labels", `${month}.json`), null);
  return {
    as_of: { ...asOf(d), review_runs: readJsonl<{ ts: string; cadence: string }>(reviewPath("runs.jsonl")).reduce<Record<string, string>>((m, r) => ({ ...m, [r.cadence]: r.ts }), {}) },
    open: recs.filter((r) => r.status === "open"),
    decided: recs.filter((r) => r.status !== "open").slice(-20).reverse(),
    // Null until the first daily run: an empty map would read as "all instruments ok".
    health: readJson<Record<string, InstrumentState> | null>(reviewPath("health.json"), null),
    alarms: readJsonl<Record<string, unknown>>(reviewPath("alarms.jsonl")).slice(-10).reverse(),
    watches: readJson<WatchDef[]>(reviewPath("watches.json"), []),
    scorecard: scorecards.at(-1) ?? null,
    labels: batch ? batch.items.filter((i) => !i.label) : [],
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const json = args.includes("--json");
  const out = (x: unknown, text?: string) => console.log(json || !text ? JSON.stringify(x, null, json ? 0 : 2) : text);
  const deps = liveDeps();
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  try {
    if (cmd === "daily") { const r = daily(deps); out(r, `instruments ${r.instruments.length} (${r.changed.length} changed) · alarms ${r.alarms.length} · watches measured ${r.watches.length}\n${r.instruments.filter((i) => i.state !== "ok").map((i) => `  ${i.state.padEnd(7)} ${i.id}: ${i.detail}`).join("\n")}`); }
    else if (cmd === "weekly") {
      const r = await weekly(await withRecord(deps), { dryRun: args.includes("--dry-run") }); out(r, `pool ${r.pool} · slots ${r.slots} · model calls ${r.model_calls} · accepted ${r.accepted.length} · rejected ${r.rejected.length} · deletion ${r.deletion ? "yes" : "no"} · worked ${r.worked.length}${r.error ? ` · error: ${r.error}` : ""}\n${r.rejected.map((x) => `  rejected: ${x.title} — ${x.reason}`).join("\n")}`); }
    else if (cmd === "monthly") { const r = monthly(deps); out(r); }
    else if (cmd === "list") { const open = loadRecs().recs.filter((r) => r.status === "open"); out(open, open.length ? open.map((r) => `${r.id}  [${r.kind}/${r.fix_type}]  ${r.title}${r.prediction ? `\n    predicts ${r.prediction.metric} ${r.prediction.direction} ${r.prediction.size_pct}% by ${r.prediction.due} (p ${r.prediction.p})` : ""}`).join("\n") : "No open recommendations."); }
    else if (cmd === "decide" && args[0] && /^(y|n)$/.test(args[1] ?? "")) { const r = decide(deps, args[0], args[1] === "y", val("--note")); out(r, `${r.id} ${r.status}${r.upgrade_id ? ` → Upgrades ${r.upgrade_id}` : ""}`); }
    else if (cmd === "label" && args[0] && /^(y|n)$/.test(args[1] ?? "")) { const b = label(deps, args[0], args[1] === "y"); out(detectorAgreement(b)); }
    else if (cmd === "watches") { const w = readJson<WatchDef[]>(reviewPath("watches.json"), []); out(w, w.map((x) => `${x.id}  ${x.label}  cut ${x.cut} +${x.days}d  ${x.result ? "measured" : "pending"}${x.refs?.length ? `  refs ${x.refs.join(",")}` : ""}`).join("\n") || "No watches."); }
    else if (cmd === "watch" && args[0] === "add" && args[1]) {
      const metrics = args.flatMap((a, i) => (a === "--metric" ? [args[i + 1]] : [])).map((s) => { const [metric, kv] = s.split(":"); return { metric: metric as MetricId, args: kv ? Object.fromEntries([kv.split("=")]) : undefined }; });
      const refs = args.flatMap((a, i) => (a === "--ref" && args[i + 1] ? [args[i + 1]] : []));
      addWatch({ id: args[1], label: val("--label") ?? args[1], cut: val("--cut") ?? "", days: Number(val("--days") ?? 28), metrics: metrics.length ? metrics : [{ metric: "complaint_rate" }, { metric: "failure_rate" }], ...(refs.length ? { refs } : {}) });
      out({ ok: true }, `watch ${args[1]} registered`);
    }
    else if (cmd === "status") out(status(deps));
    else if (cmd === "sources") {
      const r = checkSources(loadProducers(), Object.keys(deps.pool), { home: homedir(), claude: getClaudeDir() });
      out(r, [...r.producers.map((p) => `${p.state.padEnd(8)} ${p.id.padEnd(16)} ${p.path}`), ...r.unlisted.map((u) => `UNLISTED reader ${u}: wired in code but missing from sources.json`)].join("\n"));
      // A missing file is reported (state "missing", ok false) but does not fail the exit: a fresh install has none yet (ISC-67). Wiring drift does (ISC-51).
      if (!r.wired) process.exit(1);
    }
    else { console.error("Usage: Review.ts daily|weekly [--dry-run]|monthly|list|decide <id> y|n [--note]|label <id> y|n|watches|watch add <id> --cut ISO --days N [--label] [--metric m[:k=v]] [--ref id]|status [--json]|sources [--json]"); process.exit(2); }
  } catch (e) { console.error(String((e as Error).message ?? e)); process.exit(1); }
}
