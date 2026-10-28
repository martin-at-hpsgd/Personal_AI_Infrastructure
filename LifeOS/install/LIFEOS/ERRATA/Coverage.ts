/**
 * Coverage.ts — is there already a rule for this failure? (Errata ISA F6, ISC-45, ISC-46)
 *
 * Glance caller named errata-coverage (shadow). See LIFEOS/DOCUMENTATION/Assay/AssaySystem.md,
 * section The caller contract. Fail-open: a disabled engine, a missing key or a spent budget
 * becomes error rows the next run retries; nothing else in Errata waits on this file.
 *
 * For every diagnosed defect (a v4 failure whose primary class is not `external`), a deterministic
 * BM25 retriever (Rules.ts) picks the RULES_PER_FAILURE best-matching rules from the index, weighing
 * the complaint twice beside the reply it reacts to. Glance then asks one `rule_covers` noul per
 * (exchange, rule) pair. The pairs of one exchange travel in one call, each at its own position id
 * joined back to `rule_covers` in the ledger, and all exchanges go as judgeMany pools. A failure is
 * covered, and so `enforce_rule`, when any candidate reaches the registry cut; otherwise it is
 * `add_rule` (ActQuestions.composeCoverage). No free-text answer decides the fix type.
 *
 * Answers are stored per (exchange, rule id, rule hash) in LIFEOS/USER/ERRATA/v4/coverage.jsonl, so
 * a rule whose words change is asked again and an unchanged one never is. The state sent to the engine
 * carries no exchange id, rule id, session id or home path, passes `redactForEngine`, and is at most
 * STATE_MAX chars (ISC-50). This file writes only coverage.jsonl.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { judgeMany, loadCallers, thresholdRows, type CallerConfig, type ManyItem } from "../ASSAY/Assay";
import { invariant } from "../TOOLS/Invariant";
import type { Questions } from "../ASSAY/Engine";
import { loadExchanges, v4Dir, type Exchange } from "./Exchanges";
import { callerCuts, diagnosisOf, exchangeView, isFailure, loadAnswers, scrub, STATE_MAX } from "./Triage4";
import { loadTriageModel, type TriageModel } from "./Combiner";
import type { Cuts, Diagnosis } from "./Questions";
import { ACT_CALLER, RULES_PER_FAILURE, actCutsFrom, composeCoverage, ruleCoversQuestion, ruleWireId, type ActCuts, type Coverage } from "./ActQuestions";
import { loadRuleIndex, normalizeRuleText, retriever, ruleSince, tokens, weightedQuery, type Rule, type RuleRetriever } from "./Rules";

const CALL_TIMEOUT_MS = 15_000;
const DEFAULT_CHUNK = 500;

export type Failure = { ex: Exchange; dx: Diagnosis };
export type CoverageRow = { id: string; ts: string; rule: string; hash: string; p?: number; model?: string; error?: string };

export const coveragePath = (dir = v4Dir()): string => join(dir, "coverage.jsonl");

/** The M7b caller's registry row and cuts; the row must exist and stay shadow. */
export function actCaller(cfg: CallerConfig | undefined = loadCallers()[ACT_CALLER]): { cfg: CallerConfig; cuts: ActCuts } {
  invariant(cfg, `${ACT_CALLER} caller missing from the Glance registry`);
  invariant(cfg.mode === "shadow", `${ACT_CALLER} must stay shadow until its questions are calibrated`);
  const cuts = actCutsFrom(thresholdRows(cfg));
  invariant(cuts, `${ACT_CALLER}: an M7b question has no registered threshold (run bun LIFEOS/ERRATA/Act.ts register)`);
  return { cfg, cuts };
}

/** Every v4 failure that is a LifeOS defect (primary class not `external`), with its diagnosis, in ledger order. */
export function diagnosedFailures(opts: { dir?: string; cuts?: Cuts; model?: TriageModel | null } = {}): Failure[] {
  const dir = opts.dir ?? v4Dir();
  const cuts = opts.cuts ?? callerCuts();
  const model = opts.model === undefined ? loadTriageModel() : opts.model;
  const answers = loadAnswers(dir);
  const out: Failure[] = [];
  for (const ex of loadExchanges(dir)) {
    const a = answers.detect.get(ex.id);
    if (!a || isFailure(ex, a, cuts, model) !== true) continue;
    const b = answers.diagnose.get(ex.id);
    if (!b) continue;
    const dx = diagnosisOf(ex, { ...a, ...b }, cuts, model);
    if (dx?.is_failure && dx.defect) out.push({ ex, dx });
  }
  return out;
}

/**
 * The words a rule about each failure class uses. The diagnosis's classes come from Glance nouls
 * composed by code, so expanding the query with them keeps retrieval deterministic while pointing
 * it at the kind of failure rather than only at the topic of the conversation.
 */
export const CLASS_VOCABULARY: Record<string, string> = {
  ignored_instruction: "explicit instruction ask asked told standing rule preference every always never follow",
  misunderstood_intent: "intent ambiguity interpretation meant goal clarify question referent fork",
  incomplete_work: "complete completion every explicit ask met partial finish done sweep sibling class",
  unverified_claim: "verify verified verification evidence claim done tool screenshot probe browser should work",
  broke_something: "restore parity previous functionality baseline broke regression replace delete lost",
  format_or_voice: "format length short concise words bullets prose paragraph voice writing style answer lead",
  overreach: "asked scope only unrequested approval permission destructive plan stop",
  needless_question: "ask asking question permission proceed act without asking confirm build over ask",
  wrong_routing: "model agent skill route routing delegate lane workflow opus fable astra",
  harness_mechanics: "hook guard gate permission prompt block setting statusline",
  context_or_memory: "context memory load loaded already known prior decision exists source lookup",
  security_or_privacy: "secret privacy public security leak redact credential restricted data",
};

/**
 * The retrieval query for one failure: the complaint three times, its classes' vocabulary (primary
 * twice, secondary once), the reply and prior ask at half, the tools at a quarter. The reply names
 * the topic; the complaint and the class name the failure, which is what a rule forbids. Pure.
 */
export function failureQuery(ex: Exchange, dx?: Pick<Diagnosis, "primary" | "secondary">): Map<string, number> {
  return weightedQuery([
    { text: ex.prompt, weight: 3 },
    { text: dx ? CLASS_VOCABULARY[dx.primary] ?? "" : "", weight: 2 },
    { text: dx ? dx.secondary.map((c) => CLASS_VOCABULARY[c] ?? "").join(" ") : "", weight: 1 },
    { text: ex.reply_tail, weight: 0.5 },
    { text: ex.prior_ask, weight: 0.5 },
    { text: ex.tools.map((t) => `${t.name} ${t.summary}`).join(" "), weight: 0.25 },
  ]);
}

/** At most this many candidates from one heading, so one dense section cannot fill every slot. */
const PER_HEADING = 2;

/** The top rules for a failure, diversified across headings. Deterministic. */
export function candidatesFor(f: Failure, r: RuleRetriever, k = RULES_PER_FAILURE): Rule[] {
  const out: Rule[] = [];
  const perHeading = new Map<string, number>();
  for (const rule of r.search(failureQuery(f.ex, f.dx), k * 6)) {
    const h = rule.id.replace(/\.[0-9a-f]{6}(-\d+)?$/, "");
    if ((perHeading.get(h) ?? 0) >= PER_HEADING) continue;
    perHeading.set(h, (perHeading.get(h) ?? 0) + 1);
    out.push(rule);
    if (out.length === k) break;
  }
  return out;
}

/**
 * Pure: a rule's text cut to `max` chars for the state. Short rules go whole; a long one keeps its
 * first sentence plus the sentences sharing the most words with the query, in document order.
 */
export function ruleExcerpt(text: string, query: Map<string, number>, max: number): string {
  const t = normalizeRuleText(text);
  if (t.length <= max) return t;
  const sentences = t.split(/(?<=[.;:!?])\s+(?=[A-Z0-9*`"(\[-])/);
  const score = (s: string): number => tokens(s).reduce((acc, w) => acc + (query.get(w) ?? 0), 0);
  const order = sentences.map((s, i) => ({ s, i, sc: i === 0 ? Infinity : score(s) })).sort((a, b) => b.sc - a.sc || a.i - b.i);
  const keep = new Set<number>();
  let len = 0;
  for (const o of order) {
    if (len + o.s.length + 3 > max) continue;
    keep.add(o.i);
    len += o.s.length + 3;
  }
  if (!keep.size) return `${t.slice(0, Math.max(0, max - 2))} …`;
  const parts: string[] = [];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) { if (prev >= 0 && i !== prev + 1) parts.push("…"); parts.push(sentences[i]!); prev = i; }
  return parts.join(" ").slice(0, max);
}

const head = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)} …` : s);
const tail = (s: string, n: number): string => (s.length > n ? `… ${s.slice(-n)}` : s);

/**
 * JSON state for one exchange and its candidate rules (positions "1".."k"), at most STATE_MAX chars:
 * the reply end, prior ask, tools, rule excerpts and then the message shrink in that order. Pure.
 */
export function coverageState(f: Failure, rules: Rule[]): string {
  const ex = f.ex;
  const v = exchangeView(ex);
  const query = failureQuery(ex, f.dx);
  const scrubbed = rules.map((r) => scrub(r.text, ex.session));
  const lim = { reply: 600, prior: 200, tools: 200, message: 900, rule: 380 };
  for (let round = 0; round < 60; round++) {
    const out = JSON.stringify({
      user_previous_request: head(v.user_previous_request, lim.prior),
      assistant_recent_tool_calls: head(v.assistant_recent_tool_calls, lim.tools),
      assistant_previous_reply_end: tail(v.assistant_previous_reply_end, lim.reply),
      user_message: head(v.user_message, lim.message),
      rules: Object.fromEntries(scrubbed.map((t, i) => [String(i + 1), ruleExcerpt(t, query, lim.rule)])),
    });
    if (out.length <= STATE_MAX) return out;
    if (lim.reply > 120) lim.reply = Math.floor(lim.reply * 0.7);
    else if (lim.prior > 60) lim.prior = Math.floor(lim.prior / 2);
    else if (lim.tools > 60) lim.tools = Math.floor(lim.tools / 2);
    else if (lim.rule > 160) lim.rule = Math.floor(lim.rule * 0.85);
    else lim.message = Math.floor(lim.message * 0.8);
  }
  return JSON.stringify({ user_message: head(v.user_message, 400), rules: Object.fromEntries(scrubbed.map((t, i) => [String(i + 1), head(t, 200)])) }).slice(0, STATE_MAX);
}

// ── Stored answers ──────────────────────────────────────────────────────────

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((l) => {
    if (!l.trim()) return [];
    try { return [JSON.parse(l) as T]; } catch { return []; }
  });
}

export function validCoverageRow(x: unknown): x is CoverageRow {
  if (!x || typeof x !== "object") return false;
  const r = x as CoverageRow;
  if (!/^X-[0-9a-f]{16}$/.test(r.id) || typeof r.ts !== "string" || typeof r.rule !== "string" || !r.rule || !/^[0-9a-f]{16}$/.test(r.hash)) return false;
  if (typeof r.error === "string") return r.error.length > 0 && r.p === undefined;
  return typeof r.p === "number" && Number.isFinite(r.p) && r.p >= 0 && r.p <= 1;
}

/** Answered pairs, latest row wins, keyed exchange id → rule id → { hash, p }. */
export function loadCoverage(dir = v4Dir()): Map<string, Map<string, { hash: string; p: number }>> {
  const out = new Map<string, Map<string, { hash: string; p: number }>>();
  for (const r of readJsonl<CoverageRow>(coveragePath(dir))) {
    if (!validCoverageRow(r) || r.p === undefined) continue;
    (out.get(r.id) ?? out.set(r.id, new Map()).get(r.id)!).set(r.rule, { hash: r.hash, p: r.p });
  }
  return out;
}

/**
 * `predates`: the covering rule is dated (Rules.ruleSince) on or after the failure's own day, so it
 * did not exist when the failure happened; it was most likely written because of it. Such a
 * failure broke no rule and is already answered by one, so the leaderboard and the clusters leave
 * it out.
 */
export type CoverageEntry = { candidates: Rule[]; coverage: Coverage | null; predates: boolean };

/** Pure: each failure's candidates and, when every candidate is answered at its current hash, its coverage. */
export function coverageTable(failures: Failure[], r: RuleRetriever, stored: ReturnType<typeof loadCoverage>, cuts: ActCuts): Map<string, CoverageEntry> {
  const out = new Map<string, CoverageEntry>();
  for (const f of failures) {
    const candidates = candidatesFor(f, r);
    const have = stored.get(f.ex.id);
    const answers = candidates.map((rule) => { const a = have?.get(rule.id); return a && a.hash === rule.hash ? { rule: rule.id, p: a.p } : null; });
    const complete = candidates.length > 0 && answers.every((a) => a !== null);
    const coverage = complete ? composeCoverage(answers as { rule: string; p: number }[], cuts) : null;
    const since = coverage?.covered ? ruleSince(r.byId.get(coverage.rule!)?.text ?? "") : null;
    out.set(f.ex.id, { candidates, coverage, predates: since !== null && f.ex.ts.slice(0, 10) <= since });
  }
  return out;
}

// ── The run ─────────────────────────────────────────────────────────────────

export type CoverOptions = {
  dir?: string; limit?: number; chunk?: number; dryRun?: boolean;
  judge?: typeof judgeMany; failures?: Failure[]; log?: (s: string) => void; cfg?: CallerConfig;
};
export type CoverResult = { failures: number; exchanges_asked: number; pairs_asked: number; answered: number; errors: number; example?: string };

/** Ask `rule_covers` of every (defect, candidate rule) pair not yet answered at the rule's current text. */
export async function cover(opts: CoverOptions = {}): Promise<CoverResult> {
  const dir = opts.dir ?? v4Dir();
  const log = opts.log ?? ((s: string) => process.stderr.write(`${s}\n`));
  const index = loadRuleIndex(dir);
  invariant(index, "no rule index under the v4 dir; run `Rules.ts build` first");
  const r = retriever(index);
  const failures = opts.failures ?? diagnosedFailures({ dir });
  const stored = loadCoverage(dir);
  const todo: { f: Failure; ex: Exchange; rules: Rule[] }[] = [];
  for (const f of failures) {
    const have = stored.get(f.ex.id);
    const missing = candidatesFor(f, r).filter((rule) => have?.get(rule.id)?.hash !== rule.hash);
    if (missing.length) todo.push({ f, ex: f.ex, rules: missing });
  }
  const work = opts.limit === undefined ? todo : todo.slice(0, opts.limit);
  const pairs = work.reduce((s, w) => s + w.rules.length, 0);
  const example = work[0] ? coverageState(work[0].f, work[0].rules) : undefined;
  if (opts.dryRun || !work.length) return { failures: failures.length, exchanges_asked: work.length, pairs_asked: opts.dryRun ? pairs : 0, answered: 0, errors: 0, example };
  // The registry row must exist, be shadow and carry every cut before the first real call.
  if (opts.cfg) actCaller(opts.cfg); else if (!opts.judge) actCaller();
  const chunk = opts.chunk ?? DEFAULT_CHUNK;
  invariant(Number.isInteger(chunk) && chunk > 0, "chunk must be a positive integer");
  mkdirSync(dir, { recursive: true });
  let answered = 0, errors = 0;
  const t0 = performance.now();
  for (let start = 0; start < work.length; start += chunk) {
    const slice = work.slice(start, start + chunk);
    const items: ManyItem[] = slice.map((w) => {
      const questions: Questions = {};
      const joins: Record<string, { question: string; turn: string }> = {};
      w.rules.forEach((rule, i) => {
        questions[ruleWireId(i + 1)] = ruleCoversQuestion(i + 1);
        joins[ruleWireId(i + 1)] = { question: "rule_covers", turn: `${w.ex.id}~${rule.id}` };
      });
      return { key: w.ex.id, state: coverageState(w.f, w.rules), questions, questionJoins: joins };
    });
    // One pool per chunk; each item carries its own pairs. Bounded: ceil(n / 32) waves × 2 attempts × the per-call timeout.
    const results = await (opts.judge ?? judgeMany)(items, { [ruleWireId(1)]: ruleCoversQuestion(1) }, { caller: ACT_CALLER, timeoutMs: CALL_TIMEOUT_MS });
    const byKey = new Map(results.map((x) => [x.key, x]));
    const now = new Date().toISOString();
    const rows: CoverageRow[] = [];
    for (const w of slice) {
      const res = byKey.get(w.ex.id);
      w.rules.forEach((rule, i) => {
        const a = res?.result?.[ruleWireId(i + 1)]?.answer;
        const p = a && a.type === "noul" ? a.noul : undefined;
        if (res && res.error === null && typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1) {
          rows.push({ id: w.ex.id, ts: now, rule: rule.id, hash: rule.hash, p, ...(res.result?.[ruleWireId(i + 1)]?.model ? { model: res.result[ruleWireId(i + 1)]!.model } : {}) });
        } else rows.push({ id: w.ex.id, ts: now, rule: rule.id, hash: rule.hash, error: res?.error || "missing or invalid rule_covers answer" });
      });
    }
    for (const row of rows) invariant(validCoverageRow(row), `invalid coverage row for ${row.id} × ${row.rule}`);
    appendFileSync(coveragePath(dir), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
    answered += rows.filter((x) => x.p !== undefined).length;
    errors += rows.filter((x) => x.error).length;
    log(`cover: ${start + slice.length}/${work.length} exchanges (${errors} pair errors, ${Math.round((performance.now() - t0) / 1000)} s)`);
  }
  return { failures: failures.length, exchanges_asked: work.length, pairs_asked: pairs, answered, errors, example };
}

// ── Leaderboard (ISC-46) ────────────────────────────────────────────────────

export type LeaderRow = { rule: string; text: string; count: number; sessions: number; severity: Record<"0" | "1" | "2" | "3", number>; exemplars: string[] };
export type CoverageSummary = { failures: number; covered: number; uncovered: number; pending: number; stale: number; predates: number };

/** One-line scrubbed user message for a report row. Pure. */
export const exemplarLine = (ex: Exchange, n = 160): string => head(scrub(ex.prompt, ex.session).replace(/\s+/g, " ").trim(), n);

/**
 * Pure: the rules most often broken. Every covered failure counts once under its covering rule;
 * rows sort by distinct sessions, then count, then rule id. A covering rule id missing from the
 * current index is stale: it is counted apart and never shown, so every row carries rule text.
 */
export function leaderboard(failures: Failure[], table: Map<string, CoverageEntry>, byId: Map<string, Rule>, top = 15): { rows: LeaderRow[]; summary: CoverageSummary } {
  const summary: CoverageSummary = { failures: failures.length, covered: 0, uncovered: 0, pending: 0, stale: 0, predates: 0 };
  const groups = new Map<string, Failure[]>();
  for (const f of failures) {
    const entry = table.get(f.ex.id);
    const c = entry?.coverage;
    if (!c) { summary.pending++; continue; }
    if (!c.covered) { summary.uncovered++; continue; }
    if (!byId.has(c.rule!)) { summary.stale++; continue; }
    if (entry!.predates) { summary.predates++; continue; }
    summary.covered++;
    (groups.get(c.rule!) ?? groups.set(c.rule!, []).get(c.rule!)!).push(f);
  }
  const rows: LeaderRow[] = [...groups].map(([rule, fs]) => {
    const severity = { "0": 0, "1": 0, "2": 0, "3": 0 } as LeaderRow["severity"];
    for (const f of fs) severity[String(f.dx.severity) as keyof LeaderRow["severity"]]++;
    const picked: string[] = [];
    const seen = new Set<string>();
    // A bare "y" or "fix it" says nothing about the rule; a message that names the problem goes first.
    const says = (f: Failure) => (f.ex.prompt.trim().split(/\s+/).length >= 6 ? 1 : 0);
    for (const f of [...fs].sort((a, b) => says(b) - says(a) || b.dx.severity - a.dx.severity || b.ex.ts.localeCompare(a.ex.ts))) {
      if (seen.has(f.ex.session)) continue;
      seen.add(f.ex.session);
      picked.push(exemplarLine(f.ex));
      if (picked.length === 2) break;
    }
    return { rule, text: normalizeRuleText(byId.get(rule)!.text), count: fs.length, sessions: new Set(fs.map((f) => f.ex.session)).size, severity, exemplars: picked };
  });
  rows.sort((a, b) => b.sessions - a.sessions || b.count - a.count || a.rule.localeCompare(b.rule));
  for (const row of rows) invariant(row.text.length > 0, `leaderboard row ${row.rule} has no rule text`);
  return { rows: rows.slice(0, top), summary };
}

export function formatLeaderboard(board: { rows: LeaderRow[]; summary: CoverageSummary }): string[] {
  const s = board.summary;
  const lines = [
    "## Most-broken rules",
    `Coverage over ${s.failures} diagnosed defects: ${s.covered} break an existing rule (enforce_rule), ${s.uncovered} have no rule (add_rule), ${s.predates} happened on or before the date their covering rule was written, ${s.pending} not yet asked${s.stale ? `, ${s.stale} under a rule that no longer exists` : ""}. Cuts come from the \`${ACT_CALLER}\` registry row; \`bun LIFEOS/ASSAY/Assay.ts status\` shows which are calibrated.`,
    "",
  ];
  if (!board.rows.length) return [...lines, "No covered failures yet.", ""];
  lines.push("| # | rule | sessions | count | severity 0/1/2/3 |", "|---|---|---|---|---|");
  board.rows.forEach((r, i) => lines.push(`| ${i + 1} | \`${r.rule}\` | ${r.sessions} | ${r.count} | ${r.severity["0"]}/${r.severity["1"]}/${r.severity["2"]}/${r.severity["3"]} |`));
  lines.push("");
  board.rows.forEach((r, i) => {
    lines.push(`${i + 1}. \`${r.rule}\`: ${head(r.text, 220).replace(/\|/g, "\\|")}`);
    for (const e of r.exemplars) lines.push(`   - "${e}"`);
  });
  lines.push("");
  return lines;
}
