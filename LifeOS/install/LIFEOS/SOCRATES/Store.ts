/**
 * Socrates Store — the text answer store for the standing-question ledger.
 *
 * Storage (2026-08-30, supersedes the v0 SQLite store — text-bias doctrine,
 * LifeosSystemArchitecture.md founding principles + AD-1 JSONL for append-heavy
 * state; the Atlas SQLite exception was a graph-concurrency audit result and
 * does not transfer to one hourly writer of flat rows):
 *
 *   ~/.local/state/lifeos/socrates/          (outside both git repos)
 *     runs.jsonl                one line per adapter run                 TRUTH
 *     answers-YYYY-MM.jsonl     one line per answer, monthly rotation    TRUTH
 *     latest.json               folded latest-per-(question,instance) +
 *                               open findings with counters + id counters DERIVED (rebuildable)
 *     snapshot.json             redacted Pulse read surface              DERIVED (Socrates.ts export)
 *   LIFEOS/USER/SOCRATES/findings.jsonl      (inside the USER git repo)
 *     open / resolve events — a few per day, so git is the audit trail   TRUTH
 *
 * Doctrine carried over unchanged:
 * - Three-valued verdicts: pass | fail | unknown. An adapter error is unknown,
 *   never pass, never a skipped row.
 * - Every answer carries computed_from (sources touched AND bearing sources
 *   NOT touched) and the adapter's closer_version.
 * - Findings open on violating answers and resolve ONLY on a same-question
 *   pass — never on error, never on question deletion.
 * - No secret values, ever. Secret-shaped strings are refused at the write path.
 *
 * Concurrency: one writer at a time via an mkdir lock (stale after 10 min);
 * latest.json is written tmp+rename so readers never see a torn fold.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { invariant } from "../TOOLS/Invariant";
import { readJsonl, writeJsonAtomic } from "../TOOLS/TextStore";
export { readJsonl };

const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
export const SOCRATES_DIR = process.env.SOCRATES_DIR ?? join(homedir(), ".local/state/lifeos/socrates");
export const FINDINGS_PATH = process.env.SOCRATES_FINDINGS ?? join(CLAUDE, "LIFEOS/USER/SOCRATES/findings.jsonl");
export const SNAPSHOT_PATH = join(SOCRATES_DIR, "snapshot.json");

const LOCK_STALE_MS = 10 * 60_000;

export type Verdict = "pass" | "fail" | "unknown";

export interface AnswerInput {
  question_id: string;
  /** For expanded instances: question × asset, e.g. "SOC-0007|example.com". Blank for singletons. */
  instance_key?: string;
  verdict: Verdict;
  /** The measured thing (count, days, dollars, grade). Never a secret. */
  value?: string | number | null;
  /** Pointer to evidence — a finding key, report timestamp, probe ref. Never raw sensitive payloads. */
  evidence?: string;
  computed_from: { touched: string[]; untouched: string[] };
  closer_version: string;
}

export interface AdapterRunResult {
  /** True only when the adapter enumerated everything it covers without error. */
  complete: boolean;
  answers: AnswerInput[];
  /** Human-readable reason when complete=false. */
  note?: string;
}

/** One line of runs.jsonl. */
export interface RunRecord {
  id: number;
  adapter: string;
  started_at: string;
  finished_at: string;
  complete: 0 | 1;
  answers: number;
  note: string | null;
}

/** One line of answers-YYYY-MM.jsonl. computed_from stays a JSON string (consumer contract: Pulse parses it). */
export interface AnswerRecord {
  id: number;
  question_id: string;
  instance_key: string;
  ts: string;
  verdict: Verdict;
  value: string | null;
  evidence: string | null;
  computed_from: string;
  closer_version: string;
  run_id: number;
}

/** Where the router sent a finding (Router.ts). Achilles is the registry of record; the work-repo issue is Achilles' ticket. */
export interface Routed {
  achilles_id: string;
  work_issue: number | null;
  routed_at: string;
}

/** `Routed.work_issue` was `ul_issue` before 2026-10-13. Readers accept both keys; every write carries only `work_issue`. */
export function normalizeRouted<T extends Routed | undefined>(r: T): T {
  if (!r) return r;
  const legacy = r as Routed & { ul_issue?: number | null };
  if (!("ul_issue" in legacy)) return r;
  const { ul_issue, ...rest } = legacy;
  return { ...rest, work_issue: rest.work_issue ?? ul_issue ?? null } as T;
}

/** A journal or fold line with its `routed` (if any) read through normalizeRouted. */
function withRouted<E extends { routed?: Routed }>(e: E): E {
  return e.routed ? { ...e, routed: normalizeRouted(e.routed) } : e;
}

export interface FindingRecord {
  id: number;
  question_id: string;
  instance_key: string;
  first_seen: string;
  last_seen: string;
  seen_count: number;
  resolved_at: string | null;
  last_verdict: Verdict;
  last_value: string | null;
  routed?: Routed;
}

/** One line of findings.jsonl. `resolve` carries the final counters so the journal is self-contained. */
export type FindingEvent =
  | { event: "open"; ts: string; id: number; question_id: string; instance_key: string; first_seen: string; last_value: string | null }
  | { event: "route"; ts: string; id: number; question_id: string; instance_key: string; first_seen: string; routed: Routed }
  | { event: "resolve"; ts: string; id: number; question_id: string; instance_key: string; first_seen: string; resolved_at: string; last_seen: string; seen_count: number; last_value: string | null; routed?: Routed; reason?: "pass" | "instance-gone" };

interface Fold {
  version: 1;
  next_run_id: number;
  next_answer_id: number;
  next_finding_id: number;
  answer_count: number;
  /** key "question_id|instance_key" → latest answer */
  answers: Record<string, AnswerRecord>;
  /** key "question_id|instance_key" → open finding */
  open: Record<string, FindingRecord>;
  /** key "question_id|instance_key" → when the router last sent that key out (flap guard) */
  last_routed?: Record<string, string>;
}

const SECRET_SHAPES =
  /(AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|password\s*=\s*\S|api[_-]?key\s*[:=]\s*[A-Za-z0-9_\-]{16,}|Bearer\s+[A-Za-z0-9_\-.]{20,}|sk-[A-Za-z0-9]{20,})/i;

const key = (q: string, i: string) => `${q}|${i}`;
const monthOf = (ts: string) => ts.slice(0, 7);
const emptyFold = (): Fold => ({ version: 1, next_run_id: 1, next_answer_id: 1, next_finding_id: 1, answer_count: 0, answers: {}, open: {} });

export class Store {
  readonly dir: string;
  readonly findingsPath: string;
  private readonly readonly: boolean;
  private fold: Fold;

  constructor(dir: string = SOCRATES_DIR, opts: { readonly?: boolean; findingsPath?: string } = {}) {
    this.dir = dir;
    this.findingsPath = opts.findingsPath ?? FINDINGS_PATH;
    this.readonly = !!opts.readonly;
    if (!this.readonly) {
      mkdirSync(this.dir, { recursive: true });
      mkdirSync(dirname(this.findingsPath), { recursive: true });
    }
    this.fold = this.readFold();
  }

  close() {
    /* nothing to release — files are closed per operation */
  }

  // ---------------------------------------------------------------- paths
  private latestPath() { return join(this.dir, "latest.json"); }
  private runsPath() { return join(this.dir, "runs.jsonl"); }
  private answersPath(month: string) { return join(this.dir, `answers-${month}.jsonl`); }
  private lockPath() { return join(this.dir, ".lock"); }

  /** Answer log files, oldest first. */
  answerLogs(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => /^answers-\d{4}-\d{2}\.jsonl$/.test(f)).sort().map((f) => join(this.dir, f));
  }

  private readFold(): Fold {
    const p = this.latestPath();
    if (!existsSync(p)) return emptyFold();
    const f = JSON.parse(readFileSync(p, "utf8")) as Fold;
    for (const k of Object.keys(f.open ?? {})) f.open[k] = withRouted(f.open[k]!);
    return f;
  }

  private writeFold(): void {
    writeJsonAtomic(this.latestPath(), this.fold);
  }

  // ---------------------------------------------------------------- lock
  private acquire(): void {
    const p = this.lockPath();
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        mkdirSync(p);
        return;
      } catch {
        try {
          if (Date.now() - statSync(p).mtimeMs > LOCK_STALE_MS) { rmdirSync(p); continue; }
        } catch { continue; }
        Bun.sleepSync(50);
      }
    }
    throw new Error(`socrates store: could not acquire ${p} — another writer holds it`);
  }

  private release(): void {
    try { rmdirSync(this.lockPath()); } catch { /* already gone */ }
  }

  private withLock<T>(fn: () => T): T {
    invariant(!this.readonly, "store opened readonly");
    this.acquire();
    try {
      this.fold = this.readFold(); // re-read under the lock: another writer may have advanced it
      return fn();
    } finally {
      this.release();
    }
  }

  // ---------------------------------------------------------------- writes
  /**
   * Apply one adapter run: append the run line, append every answer line,
   * advance the findings lifecycle, rewrite the fold. Invariants asserted
   * before any write (Invariant doctrine: mutating persistent state).
   */
  applyRun(adapter: string, result: AdapterRunResult): { runId: number } {
    const now = new Date().toISOString();
    invariant(adapter.length > 0, "adapter name required");
    for (const a of result.answers) {
      invariant(/^SOC-\d{4}$/.test(a.question_id), `bad question id ${a.question_id}`);
      invariant(["pass", "fail", "unknown"].includes(a.verdict), `bad verdict ${a.verdict}`);
      invariant(a.closer_version.length > 0, `answer for ${a.question_id} missing closer_version`);
      invariant(Array.isArray(a.computed_from?.touched) && Array.isArray(a.computed_from?.untouched),
        `answer for ${a.question_id} missing computed_from contract`);
      const blob = JSON.stringify(a);
      invariant(!SECRET_SHAPES.test(blob), `answer for ${a.question_id} contains a credential-shaped string`);
    }

    return this.withLock(() => {
      const runId = this.fold.next_run_id++;
      const run: RunRecord = {
        id: runId, adapter, started_at: now, finished_at: now,
        complete: result.complete ? 1 : 0, answers: result.answers.length, note: result.note ?? null,
      };
      const answerLines: string[] = [];
      const findingLines: string[] = [];
      for (const a of result.answers) {
        const rec: AnswerRecord = {
          id: this.fold.next_answer_id++,
          question_id: a.question_id,
          instance_key: a.instance_key ?? "",
          ts: now,
          verdict: a.verdict,
          value: a.value === undefined || a.value === null ? null : String(a.value),
          evidence: a.evidence ?? null,
          computed_from: JSON.stringify(a.computed_from),
          closer_version: a.closer_version,
          run_id: runId,
        };
        answerLines.push(JSON.stringify(rec));
        this.fold.answers[key(rec.question_id, rec.instance_key)] = rec;
        this.fold.answer_count++;
        for (const ev of this.advanceFinding(rec)) findingLines.push(JSON.stringify(ev));
      }
      for (const ev of this.resolveGoneInstances(result, now)) findingLines.push(JSON.stringify(ev));
      // One append per file per run. Order: truth logs first, then the fold.
      appendFileSync(this.runsPath(), JSON.stringify(run) + "\n");
      if (answerLines.length) appendFileSync(this.answersPath(monthOf(now)), answerLines.join("\n") + "\n");
      if (findingLines.length) appendFileSync(this.findingsPath, findingLines.join("\n") + "\n");
      this.writeFold();
      return { runId };
    });
  }

  /**
   * Instance-gone. A COMPLETE run that answered per-instance for a question but
   * did not name the instance an open finding carries means that instance no
   * longer exists (a retired launchd job, a removed target). The condition can
   * never recur for it, so the finding resolves with reason "instance-gone" —
   * otherwise a retired instance leaves a zombie finding that no same-question
   * pass can ever clear. An incomplete run, a run with no
   * instanced answers for that question, or an un-instanced finding never
   * triggers this: absence of evidence is only evidence when the run claims to
   * have enumerated everything.
   */
  private resolveGoneInstances(result: { complete: boolean; answers: Array<Pick<AnswerInput, "question_id" | "instance_key">> }, now: string): FindingEvent[] {
    if (!result.complete) return [];
    const seen = new Map<string, Set<string>>();
    for (const a of result.answers) {
      const ik = a.instance_key ?? "";
      if (!ik) continue;
      if (!seen.has(a.question_id)) seen.set(a.question_id, new Set());
      seen.get(a.question_id)!.add(ik);
    }
    const out: FindingEvent[] = [];
    for (const open of Object.values(this.fold.open)) {
      const s = seen.get(open.question_id);
      if (!s || !open.instance_key || s.has(open.instance_key)) continue;
      delete this.fold.open[key(open.question_id, open.instance_key)];
      out.push({
        event: "resolve", ts: now, id: open.id, question_id: open.question_id, instance_key: open.instance_key,
        first_seen: open.first_seen, resolved_at: now, last_seen: open.last_seen, seen_count: open.seen_count, last_value: open.last_value,
        reason: "instance-gone", ...(open.routed ? { routed: open.routed } : {}),
      });
    }
    return out;
  }

  /**
   * Findings lifecycle. fail → open or extend. pass → resolve any open finding
   * for the same (question, instance). unknown → extend last_seen on an open
   * finding but NEVER resolve (an error is not evidence of health).
   * Pure over the fold; returns the journal events to append.
   */
  private advanceFinding(a: AnswerRecord): FindingEvent[] {
    const k = key(a.question_id, a.instance_key);
    const open = this.fold.open[k];
    if (a.verdict === "fail") {
      if (open) {
        open.last_seen = a.ts; open.seen_count++; open.last_verdict = "fail"; open.last_value = a.value;
        return [];
      }
      const f: FindingRecord = {
        id: this.fold.next_finding_id++, question_id: a.question_id, instance_key: a.instance_key,
        first_seen: a.ts, last_seen: a.ts, seen_count: 1, resolved_at: null, last_verdict: "fail", last_value: a.value,
      };
      this.fold.open[k] = f;
      return [{ event: "open", ts: a.ts, id: f.id, question_id: f.question_id, instance_key: f.instance_key, first_seen: f.first_seen, last_value: f.last_value }];
    }
    if (a.verdict === "pass" && open) {
      delete this.fold.open[k];
      return [{
        event: "resolve", ts: a.ts, id: open.id, question_id: open.question_id, instance_key: open.instance_key,
        first_seen: open.first_seen, resolved_at: a.ts, last_seen: open.last_seen, seen_count: open.seen_count, last_value: open.last_value,
        reason: "pass", ...(open.routed ? { routed: open.routed } : {}),
      }];
    }
    if (a.verdict === "unknown" && open) {
      open.last_seen = a.ts; open.last_verdict = "unknown";
    }
    return [];
  }

  /**
   * Record where the router sent an open finding. Journal event + fold, under
   * the lock. Refuses a finding that is not open (routing is for live state).
   */
  markRouted(questionId: string, instanceKey: string, routed: Routed): void {
    invariant(/^ACH-\d{4}$/.test(routed.achilles_id), `bad achilles id ${routed.achilles_id}`);
    routed = normalizeRouted(routed);
    invariant(!("ul_issue" in routed), "routed is written with work_issue only");
    this.withLock(() => {
      const k = key(questionId, instanceKey);
      const open = this.fold.open[k];
      invariant(!!open, `finding ${k} is not open — nothing to route`);
      open.routed = routed;
      this.fold.last_routed = { ...(this.fold.last_routed ?? {}), [k]: routed.routed_at };
      appendFileSync(this.findingsPath, JSON.stringify({
        event: "route", ts: routed.routed_at, id: open.id, question_id: questionId, instance_key: instanceKey, first_seen: open.first_seen, routed,
      } satisfies FindingEvent) + "\n");
      this.writeFold();
    });
  }

  /** When the router last sent this (question, instance) out, if ever. */
  lastRoutedAt(questionId: string, instanceKey: string): string | null {
    return this.fold.last_routed?.[key(questionId, instanceKey)] ?? null;
  }

  /** Findings the journal says were routed and later resolved, but Achilles was not yet told (crash between the two). */
  resolvedButRoutedOpen(): Array<Extract<FindingEvent, { event: "resolve" }>> {
    const closedIds = new Set<number>();
    const out: Array<Extract<FindingEvent, { event: "resolve" }>> = [];
    for (const e of readJsonl<FindingEvent>(this.findingsPath)) {
      if (e.event === "resolve" && e.routed) out.push(withRouted(e));
      if ((e as { event: string }).event === "achilles-closed") closedIds.add(e.id);
    }
    return out.filter((e) => !closedIds.has(e.id));
  }

  /** Journal that Achilles was told a routed finding cleared (idempotency marker for the close leg). */
  markAchillesClosed(findingId: number, achillesId: string, ts: string): void {
    this.withLock(() => {
      appendFileSync(this.findingsPath, JSON.stringify({ event: "achilles-closed", ts, id: findingId, achilles_id: achillesId }) + "\n");
    });
  }

  /**
   * Rebuild the derived fold from the truth logs, and reconcile the findings
   * journal append-only (events the replay produces that the journal lacks are
   * appended; nothing is ever removed). Returns what changed.
   */
  rebuild(): { answers: number; runs: number; open_findings: number; journal_appended: number } {
    return this.withLock(() => {
      const runs = readJsonl<RunRecord>(this.runsPath());
      const fresh = emptyFold();
      fresh.next_run_id = runs.reduce((m, r) => Math.max(m, r.id), 0) + 1;
      const existing = readJsonl<FindingEvent>(this.findingsPath).filter((e) => e.event === "open" || e.event === "route" || e.event === "resolve");
      const seen = new Set(existing.map((e) => `${e.event}|${e.question_id}|${e.instance_key}|${e.first_seen}`));
      // Reuse journal ids for findings it already knows so ids stay stable across rebuilds.
      const knownIds = new Map(existing.filter((e) => e.event === "open").map((e) => [`${e.question_id}|${e.instance_key}|${e.first_seen}`, e.id]));
      // Routing state lives only in the journal; carry it back into the fold.
      const routedByKey = new Map(existing.filter((e) => e.event === "route").map((e) => [`${e.question_id}|${e.instance_key}|${e.first_seen}`, normalizeRouted((e as Extract<FindingEvent, { event: "route" }>).routed)]));
      fresh.next_finding_id = Math.max(0, ...existing.map((e) => e.id)) + 1;
      fresh.last_routed = {};
      for (const e of existing) if (e.event === "route") fresh.last_routed[key(e.question_id, e.instance_key)] = e.ts;

      this.fold = fresh;
      const appended: string[] = [];
      const record = (ev: FindingEvent) => {
        const known = knownIds.get(`${ev.question_id}|${ev.instance_key}|${ev.first_seen}`);
        if (known !== undefined) {
          ev.id = known;
          if (ev.event === "open") this.fold.open[key(ev.question_id, ev.instance_key)].id = known;
        }
        if (ev.event === "open") {
          const routed = routedByKey.get(`${ev.question_id}|${ev.instance_key}|${ev.first_seen}`);
          if (routed) this.fold.open[key(ev.question_id, ev.instance_key)].routed = routed;
        }
        const sig = `${ev.event}|${ev.question_id}|${ev.instance_key}|${ev.first_seen}`;
        if (!seen.has(sig)) { appended.push(JSON.stringify(ev)); seen.add(sig); }
      };
      // applyRun resolves instance-gone findings after each complete run's answers, so the
      // replay does the same per run_id; otherwise a retired instance's finding comes back open.
      const completeRun = new Map(runs.map((r) => [r.id, r.complete === 1]));
      let batch: AnswerRecord[] = [];
      const endRun = () => {
        if (batch.length && completeRun.get(batch[0]!.run_id)) {
          for (const ev of this.resolveGoneInstances({ complete: true, answers: batch }, batch[0]!.ts)) record(ev);
        }
        batch = [];
      };
      for (const log of this.answerLogs()) {
        for (const a of readJsonl<AnswerRecord>(log)) {
          if (batch.length && batch[0]!.run_id !== a.run_id) endRun();
          batch.push(a);
          this.fold.answers[key(a.question_id, a.instance_key)] = a;
          this.fold.answer_count++;
          this.fold.next_answer_id = Math.max(this.fold.next_answer_id, a.id + 1);
          for (const ev of this.advanceFinding(a)) record(ev);
        }
      }
      endRun();
      if (appended.length) appendFileSync(this.findingsPath, appended.join("\n") + "\n");
      this.writeFold();
      return { answers: this.fold.answer_count, runs: runs.length, open_findings: Object.keys(this.fold.open).length, journal_appended: appended.length };
    });
  }

  // ---------------------------------------------------------------- reads
  /** Latest answer per (question, instance), ordered by question then instance. */
  latestAnswers(): AnswerRecord[] {
    return Object.values(this.fold.answers).sort((a, b) =>
      a.question_id.localeCompare(b.question_id) || a.instance_key.localeCompare(b.instance_key));
  }

  openFindings(): FindingRecord[] {
    return Object.values(this.fold.open).sort((a, b) => a.first_seen.localeCompare(b.first_seen));
  }

  /** Every finding the journal knows, open and resolved, oldest first. */
  allFindings(): FindingRecord[] {
    const byId = new Map<number, FindingRecord>();
    for (const e of readJsonl<FindingEvent>(this.findingsPath)) {
      if (e.event === "open") {
        byId.set(e.id, { id: e.id, question_id: e.question_id, instance_key: e.instance_key, first_seen: e.first_seen, last_seen: e.first_seen, seen_count: 1, resolved_at: null, last_verdict: "fail", last_value: e.last_value });
      } else if (e.event === "route") {
        const f = byId.get(e.id);
        if (f) f.routed = normalizeRouted(e.routed);
      } else if (e.event === "resolve") {
        const f = byId.get(e.id);
        if (f) Object.assign(f, { resolved_at: e.resolved_at, last_seen: e.last_seen, seen_count: e.seen_count, last_value: e.last_value, last_verdict: "pass", ...(e.routed ? { routed: normalizeRouted(e.routed) } : {}) });
      }
    }
    for (const f of Object.values(this.fold.open)) byId.set(f.id, f);
    return [...byId.values()].sort((a, b) => a.first_seen.localeCompare(b.first_seen));
  }

  history(questionId: string, limit = 50): Array<Pick<AnswerRecord, "ts" | "instance_key" | "verdict" | "value" | "closer_version">> {
    const out: AnswerRecord[] = [];
    for (const log of this.answerLogs().reverse()) {
      for (const a of readJsonl<AnswerRecord>(log)) if (a.question_id === questionId) out.push(a);
      if (out.length >= limit) break;
    }
    return out
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, limit)
      .map(({ ts, instance_key, verdict, value, closer_version }) => ({ ts, instance_key, verdict, value, closer_version }));
  }

  status() {
    const runs = readJsonl<RunRecord>(this.runsPath());
    const byAdapter = new Map<string, { adapter: string; last_run: string; runs: number; complete_runs: number }>();
    for (const r of runs) {
      const s = byAdapter.get(r.adapter) ?? { adapter: r.adapter, last_run: "", runs: 0, complete_runs: 0 };
      s.runs++; s.complete_runs += r.complete; if (r.finished_at > s.last_run) s.last_run = r.finished_at;
      byAdapter.set(r.adapter, s);
    }
    return {
      runs: [...byAdapter.values()].sort((a, b) => a.adapter.localeCompare(b.adapter)),
      answers: { n: this.fold.answer_count },
      open_findings: { n: Object.keys(this.fold.open).length },
    };
  }
}
