#!/usr/bin/env bun
/**
 * @version 1.0.5
 * CoachReview.ts — the daily DA-coaching miner.
 *
 * The Upgrades pattern pointed at the assistant instead of the system: turn the
 * principal's CORRECTIONS of the DA (signals already on disk) into concrete
 * "the DA should change X" recommendations in the existing Upgrades store, tagged
 * `source: coach`, surfaced on Pulse /upgrades (Coach source filter) for
 * Implement/Pass disposition.
 *
 * ── The loop (one run) ────────────────────────────────────────────────────
 *   1. Gather deterministically from three on-disk sources since a persisted
 *      per-source cursor, bounded by a lookback window (no raw-transcript sweep):
 *        · FAILURES incidents  (SatisfactionCapture's correction corpus)
 *        · Errata ledger entries ≤ rating_threshold (replacement since 2026-09-20)
 *        · REFLECTIONS/algorithm-reflections.jsonl self-critiques (failed budget
 *          or insufficient-context entries)
 *   2. ONE schema-forced Inference call judges coachability, extracts a VERBATIM
 *      quote, clusters, and drafts claim/recommendation/category/confidence.
 *   3. Enqueue gates, in order: quote present (byte-substring of its source) →
 *      confidence ≥ min → claim-hash dedupe (Upgrades store) → semantic near-dupe
 *      folds a recurrence note onto the existing record → daily cap.
 *   4. Write `source: coach` records via Upgrades.ts. Cursor advances ONLY on a
 *      clean run (at-least-once gather + claim-hash dedupe = exactly-once at the
 *      store). Overflow past the cap is PERSISTED (never dropped) for tomorrow.
 *
 * ZERO EGRESS (CL-A1): reads local jsonl/dirs, writes local records + cursor +
 * an observability line. The single Inference call is subscription inference,
 * not a CoachLoop-specific network write. The downstream app mirror is PHASE 2 and is
 * NOT in this file.
 *
 * HEADLESS (CL-6): this tool makes ZERO VoiceServer calls on any path. The
 * launchd job sets LIFEOS_NOTIFICATION_CHANNEL=headless; results surface only
 * via the Pulse /upgrades queue (Coach source filter).
 *
 * Usage:
 *   bun CoachReview.ts run [--headless] [--dry-run]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, statSync } from "fs";
import { join } from "path";
import { invariant } from "./Invariant";
import { addUpgrade, listUpgrades, appendNote, type UpgradeSource } from "./Upgrades";
import { inference } from "./Inference";
import { ErrataStore } from "../ERRATA/Store";
import { getLifeosDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

// Normalize env path vars that Claude Code injects without shell expansion (LifeOS#1404)
for (const k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const v = process.env[k];
  if (v && /^\$\{?HOME\}?(\/|$)/.test(v)) process.env[k] = v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}

const BASE_DIR = getLifeosDir();

export const CATEGORIES = ["voice", "format", "process", "verification", "delegation", "judgment"] as const;
export type Category = (typeof CATEGORIES)[number];

// ── Config ──

export interface CoachConfig {
  lookback_hours: number;
  rating_threshold: number;
  min_confidence: number;
  max_new_per_day: number;
  push_to_vector: boolean;      // Downstream mirror phase; unused here
  vector_tenant: string;        // Downstream mirror phase; unused here
  schema_version: number;
}

const DEFAULT_CONFIG: CoachConfig = {
  lookback_hours: 26,
  rating_threshold: 4,
  min_confidence: 0.6,
  max_new_per_day: 5,
  push_to_vector: false,
  vector_tenant: "",
  schema_version: 1,
};

export function loadConfig(configPath: string): CoachConfig {
  try {
    if (existsSync(configPath)) return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configPath, "utf-8")) };
  } catch { /* malformed config → defaults, never crash the job */ }
  return { ...DEFAULT_CONFIG };
}

// ── Candidate + judgment + drafted shapes ──

export type SourceKind = "failures" | "ratings" | "reflections";

export interface Candidate {
  source: SourceKind;
  marker: string;        // cursor-advancement key: FAILURES dir name, or the entry's ISO timestamp
  session_id: string;
  quoteSource: string;   // the ONLY text the verbatim quote may come from (quote-fidelity anchor)
  context: string;       // extra context for the judge; NOT quote-checked
  rating?: number;
  evidenceRef: string;   // human-readable evidence pointer stored on the record
}

export interface Judgment {
  index: number;
  coachable: boolean;
  discard_reason?: string;
  quote?: string;
  category?: string;
  claim?: string;
  current_state?: string;
  recommendation?: string;
  target_surface?: string;
  confidence?: number;
  cluster_with?: string | null;   // id of an existing PENDING coach record this recurs on, else null
}

export interface DraftedCandidate {
  quote: string;
  category: string;
  claim: string;
  current_state: string;
  recommendation: string;
  target_surface: string;
  confidence: number;
  session_id: string;
  evidence: string[];
  cluster_with: string | null;
}

// ── Cursor / deferred state ──

export interface CoachState {
  schema_version: number;
  cursors: Record<SourceKind, string>;
  deferred: DraftedCandidate[];
}

export function defaultState(): CoachState {
  return { schema_version: 1, cursors: { failures: "", ratings: "", reflections: "" }, deferred: [] };
}

export function loadState(statePath: string): CoachState {
  try {
    if (existsSync(statePath)) {
      const s = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<CoachState>;
      return {
        schema_version: s.schema_version ?? 1,
        cursors: { failures: "", ratings: "", reflections: "", ...(s.cursors ?? {}) },
        deferred: Array.isArray(s.deferred) ? s.deferred : [],
      };
    }
  } catch { /* corrupt cursor file → start clean rather than crash */ }
  return defaultState();
}

export function saveState(statePath: string, st: CoachState): void {
  // Cursor + deferred are persistent state; a wrong write silently re-mines or
  // drops signals, so assert the shape before it lands (CL-10).
  invariant(st.cursors && typeof st.cursors === "object", "coach state has no cursors map");
  invariant(Array.isArray(st.deferred), "coach state deferred is not an array");
  mkdirSync(join(statePath, ".."), { recursive: true });
  writeFileSync(statePath, JSON.stringify(st, null, 2));
}

// ── Timestamp helpers ──

/** Epoch ms for a marker. ratings/reflections carry ISO timestamps (Z or offset);
 *  FAILURES markers are `YYYY-MM-DD-HHMMSS_<slug>` dir names, PST-stamped at
 *  capture, parsed as machine-local time (the machine's local zone). */
export function markerEpoch(source: SourceKind, marker: string): number {
  if (!marker) return 0;
  if (source === "failures") {
    const m = marker.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
    if (!m) return 0;
    const [, y, mo, d, h, mi, s] = m;
    const t = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).getTime();  // local tz
    return Number.isNaN(t) ? 0 : t;
  }
  const t = Date.parse(marker);
  return Number.isNaN(t) ? 0 : t;
}

// ── Quote fidelity (CL-3) ──

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** True when `quote` is present in `sourceText` (exact, or modulo whitespace).
 *  A model reliably reproduces the words but may re-wrap whitespace, so a
 *  whitespace-normalized substring is the fair reading of "verbatim". */
export function quotePresent(quote: string, sourceText: string): boolean {
  if (!quote || !quote.trim() || !sourceText) return false;
  if (sourceText.includes(quote)) return true;
  return collapse(sourceText).includes(collapse(quote));
}

// ── Deterministic gather (no LLM, no transcript sweep) ──

export function gatherFailures(failuresDir: string, floorEpoch: number): Candidate[] {
  if (!existsSync(failuresDir)) return [];
  const out: Candidate[] = [];
  for (const month of readdirSync(failuresDir)) {
    const monthDir = join(failuresDir, month);
    let isDir = false;
    try { isDir = statSync(monthDir).isDirectory(); } catch { continue; }
    if (!isDir || !/^\d{4}-\d{2}$/.test(month)) continue;
    for (const dir of readdirSync(monthDir)) {
      if (markerEpoch("failures", dir) <= floorEpoch) continue;
      const incDir = join(monthDir, dir);
      const sentimentPath = join(incDir, "sentiment.json");
      if (!existsSync(sentimentPath)) continue;
      let s: any;
      try { s = JSON.parse(readFileSync(sentimentPath, "utf-8")); } catch { continue; }
      const summary = typeof s.summary === "string" ? s.summary : "";
      if (!summary) continue;
      out.push({
        source: "failures",
        marker: dir,
        session_id: typeof s.session_id === "string" ? s.session_id : "",
        quoteSource: summary,
        context: typeof s.detailed_context === "string" ? s.detailed_context.slice(0, 2000) : "",
        rating: typeof s.rating === "number" ? s.rating : undefined,
        evidenceRef: `FAILURES/${month}/${dir}/`,
      });
    }
  }
  return out;
}

export function gatherRatings(store: ErrataStore, floorEpoch: number, threshold: number): Candidate[] {
  const out: Candidate[] = [];
  for (const r of store.all()) {
    const ts = r.ts;
    const rating = r.rating;
    if (typeof rating !== "number" || !Number.isFinite(rating) || rating > threshold) continue;
    if (markerEpoch("ratings", ts) <= floorEpoch) continue;
    const comment = r.complaint;
    // No comment → no verbatim quote to anchor a coach rec → skip at gather time.
    if (!comment.trim()) continue;
    out.push({
      source: "ratings",
      marker: ts,
      session_id: r.context.session_id ?? "",
      quoteSource: comment,
      context: [r.context.response_preview ?? "", r.links.failure_dir ?? ""].filter(Boolean).join(" ").slice(0, 2000),
      rating,
      evidenceRef: `Errata id=${r.id} ts=${ts} rating=${rating}`,
    });
  }
  return out;
}

export function gatherReflections(reflectionsFile: string, floorEpoch: number): Candidate[] {
  if (!existsSync(reflectionsFile)) return [];
  const out: Candidate[] = [];
  for (const line of readFileSync(reflectionsFile, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    const ts = typeof r.ts === "string" ? r.ts : "";
    if (markerEpoch("reflections", ts) <= floorEpoch) continue;
    // Admit only self-critiques that flag something went wrong (precision over recall).
    const flagged = r.within_budget === false || r.context_sufficient === false;
    if (!flagged) continue;
    const reflection = typeof r.reflection === "string" ? r.reflection : "";
    if (!reflection.trim()) continue;
    out.push({
      source: "reflections",
      marker: ts,
      session_id: typeof r.session_id === "string" ? r.session_id : "",
      quoteSource: reflection,
      context: `${typeof r.slug === "string" ? r.slug : ""} ${typeof r.notes === "string" ? r.notes : ""}`.trim(),
      evidenceRef: `algorithm-reflections.jsonl ts=${ts} slug=${typeof r.slug === "string" ? r.slug : "?"}`,
    });
  }
  return out;
}

// ── The single inference call ──

export type InferFn = (
  candidates: Candidate[],
  existingClaims: { id: string; claim: string; status: string; category?: string }[],
) => Promise<Judgment[]>;

const SYSTEM_PROMPT = `You review a batch of candidate signals about how an AI assistant behaved, and decide which ones are COACHABLE — a recurring behavioral pattern the assistant should change — versus not.

For EACH candidate you receive (identified by index), return one judgment object.

COACHABLE means: the signal points to a change in how the assistant should behave going forward (its voice, output format, working process, verification discipline, delegation, or judgment). NOT coachable: a one-off task fix, a tooling/infra failure, an external cause, praise, or a signal with no correction in it. When not coachable, set coachable=false and give a short discard_reason; leave the other fields empty.

When coachable:
- quote: a VERBATIM span copied exactly from that candidate's quote_source text. It must appear character-for-character in quote_source. Never paraphrase, invent, or pull from context. If no usable verbatim span exists in quote_source, mark it NOT coachable with discard_reason "no verbatim quote".
- category: exactly one of the provided categories.
- claim: the derived behavioral rule, one sentence, in the third person ("the assistant should ...").
- current_state: what happens today, one sentence.
- recommendation: where/how to encode the change (which doctrine file, hook, or contract).
- target_surface: one of hook | doctrine | rule | skill | settings | context.
- confidence: 0-1, how strongly this is a real recurring coaching signal.
- cluster_with: if this candidate is the SAME behavioral issue as one of the existing pending claims provided, set cluster_with to that existing claim's id (so it folds in as a recurrence rather than a duplicate). Otherwise null. If several candidates in THIS batch are the same issue, still emit each, but only the strongest should omit cluster_with.

Write claims in plain, direct language. Do not copy any example phrasing; derive every field from the candidate in front of you.

Return ONLY JSON: {"judgments":[{"index":0,"coachable":true,"quote":"...","category":"voice","claim":"...","current_state":"...","recommendation":"...","target_surface":"doctrine","confidence":0.8,"cluster_with":null}, ...]}`;

const INFER_CHUNK = 8;

const realInfer: InferFn = async (candidates, existingClaims) => {
  const payload = {
    categories: CATEGORIES,
    existing_pending_claims: existingClaims,
    candidates: candidates.map((c, i) => ({
      index: i,
      source: c.source,
      rating: c.rating ?? null,
      quote_source: c.quoteSource.slice(0, 4000),
      context: c.context.slice(0, 1500),
    })),
  };
  const res = await inference({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: JSON.stringify(payload),
    level: "medium",
    expectJson: true,
    timeout: 180000,
  });
  if (!res.success) throw new Error(`coach inference failed: ${res.error ?? "unknown"}`);
  const parsed: any = res.parsed;
  const judgments = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.judgments) ? parsed.judgments : null;
  if (!judgments) throw new Error("coach inference returned no judgments array");
  return judgments as Judgment[];
};

// ── Judgment → drafted candidate (deterministic gates on the model output) ──

/** Apply the quote + confidence + category gates to raw judgments, pairing each
 *  back to its candidate. Returns the drafted survivors and the discard log.
 *  Pure — no I/O — so the gates are unit-testable without a store. */
export function draftFromJudgments(
  candidates: Candidate[],
  judgments: Judgment[],
  minConfidence: number,
): { drafted: DraftedCandidate[]; discarded: { index: number; reason: string }[] } {
  const drafted: DraftedCandidate[] = [];
  const discarded: { index: number; reason: string }[] = [];
  for (const j of judgments) {
    const c = candidates[j.index];
    if (!c) { discarded.push({ index: j.index, reason: "no matching candidate" }); continue; }
    if (!j.coachable) { discarded.push({ index: j.index, reason: j.discard_reason || "not coachable" }); continue; }
    const quote = (j.quote ?? "").trim();
    if (!quotePresent(quote, c.quoteSource)) { discarded.push({ index: j.index, reason: "quote not present in source" }); continue; }
    const confidence = typeof j.confidence === "number" ? j.confidence : 0;
    if (confidence < minConfidence) { discarded.push({ index: j.index, reason: `confidence ${confidence} < ${minConfidence}` }); continue; }
    const category = (CATEGORIES as readonly string[]).includes(j.category ?? "") ? (j.category as string) : "judgment";
    const claim = (j.claim ?? "").trim();
    if (claim.length < 10) { discarded.push({ index: j.index, reason: "claim too short" }); continue; }
    drafted.push({
      quote,
      category,
      claim,
      current_state: (j.current_state ?? "").trim() || "(not stated)",
      recommendation: (j.recommendation ?? "").trim() || "(not yet drafted)",
      target_surface: (j.target_surface ?? "").trim() || "doctrine",
      confidence,
      session_id: c.session_id,
      evidence: [c.evidenceRef, c.session_id ? `session:${c.session_id}` : ""].filter(Boolean),
      cluster_with: j.cluster_with ?? null,
    });
  }
  return { drafted, discarded };
}

// ── Orchestration ──

export interface RunOptions {
  configPath?: string;
  failuresDir?: string;
  errataStore?: ErrataStore;
  reflectionsFile?: string;
  statePath?: string;
  obsLog?: string;
  config?: Partial<CoachConfig>;
  infer?: InferFn;
  dryRun?: boolean;
  now?: Date;
}

export interface RunResult {
  status: "written" | "skipped" | "aborted" | "dry-run";
  gathered: number;
  written: string[];
  folded: number;
  deferred: number;
  discarded: number;
  error?: string;
}

function paths(opts: RunOptions) {
  return {
    configPath: opts.configPath ?? join(BASE_DIR, "USER", "CONFIG", "coach-review.json"),
    failuresDir: opts.failuresDir ?? join(BASE_DIR, "MEMORY", "LEARNING", "FAILURES"),
    errataStore: opts.errataStore ?? new ErrataStore(),
    reflectionsFile: opts.reflectionsFile ?? join(BASE_DIR, "MEMORY", "LEARNING", "REFLECTIONS", "algorithm-reflections.jsonl"),
    statePath: opts.statePath ?? join(BASE_DIR, "MEMORY", "UPGRADES", ".coach-state.json"),
    obsLog: opts.obsLog ?? join(BASE_DIR, "MEMORY", "OBSERVABILITY", "coach-review.jsonl"),
  };
}

function logRun(obsLog: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(join(obsLog, ".."), { recursive: true });
    appendFileSync(obsLog, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* observability must never break the run */ }
}

export async function run(opts: RunOptions = {}): Promise<RunResult> {
  const p = paths(opts);
  const config: CoachConfig = { ...loadConfig(p.configPath), ...(opts.config ?? {}) };
  const infer = opts.infer ?? realInfer;
  const now = opts.now ?? new Date();
  const state = loadState(p.statePath);

  const lookbackFloor = now.getTime() - config.lookback_hours * 3600_000;
  const floor = (src: SourceKind) => Math.max(lookbackFloor, markerEpoch(src, state.cursors[src]));

  // 1. Deterministic gather since the bounded cursor.
  const gathered: Candidate[] = [
    ...gatherFailures(p.failuresDir, floor("failures")),
    ...gatherRatings(p.errataStore, floor("ratings"), config.rating_threshold),
    ...gatherReflections(p.reflectionsFile, floor("reflections")),
  ];
  const deferred = state.deferred;

  // Empty window: no new signals AND nothing carried over → "skipped", not a
  // parse failure (the memory-reviewer empty-transcript lesson).
  if (gathered.length === 0 && deferred.length === 0) {
    logRun(p.obsLog, { status: "skipped", reason: "empty window", dry_run: !!opts.dryRun });
    return { status: "skipped", gathered: 0, written: [], folded: 0, deferred: 0, discarded: 0 };
  }

  // 2. ONE inference call — only when there are NEW signals to judge. Deferred
  //    candidates were already drafted+gated on a prior run; they skip the model.
  let draftedNew: DraftedCandidate[] = [];
  let discardCount = 0;
  if (gathered.length > 0) {
    const existing = listUpgrades({ source: "coach" }).map((r) => ({ id: r.id, claim: r.claim, status: r.status, category: r.category }));
    let judgments: Judgment[];
    try {
      // Chunked: one 90s call over 20+ candidates timed out on 3 of 8 nights
      // (2026-08-29..09-03). Judgment indices are local to the chunk; re-base them.
      judgments = [];
      for (let start = 0; start < gathered.length; start += INFER_CHUNK) {
        const part = await infer(gathered.slice(start, start + INFER_CHUNK), existing);
        for (const j of part) judgments.push({ ...j, index: j.index + start });
      }
    } catch (err) {
      // Inference failure aborts WITHOUT advancing the cursor — the window is
      // re-mined next run (at-least-once; claim-hash makes it exactly-once).
      logRun(p.obsLog, { status: "aborted", error: String(err), gathered: gathered.length });
      return { status: "aborted", gathered: gathered.length, written: [], folded: 0, deferred: deferred.length, discarded: 0, error: String(err) };
    }
    const d = draftFromJudgments(gathered, judgments, config.min_confidence);
    draftedNew = d.drafted;
    discardCount = d.discarded.length;
  }

  // 3. Pool = carried-over deferred first, then freshly drafted. Partition into
  //    recurrence-folds (onto an existing pending record) vs new records.
  const pendingIds = new Set(
    listUpgrades({ source: "coach" }).filter((r) => r.status === "recommended" || r.status === "accepted").map((r) => r.id),
  );
  const pool = [...deferred, ...draftedNew];
  const folds = pool.filter((d) => d.cluster_with && pendingIds.has(d.cluster_with));
  const newItems = pool.filter((d) => !(d.cluster_with && pendingIds.has(d.cluster_with)));

  // Cap: keep highest-confidence, defer the rest (never dropped). Folds do not
  // consume the cap — they mutate an existing record, not add a new one.
  newItems.sort((a, b) => b.confidence - a.confidence);
  const toWrite = newItems.slice(0, config.max_new_per_day);
  const overflow = newItems.slice(config.max_new_per_day);

  if (opts.dryRun) {
    logRun(p.obsLog, { status: "dry-run", gathered: gathered.length, would_write: toWrite.length, would_fold: folds.length, would_defer: overflow.length, discarded: discardCount });
    return { status: "dry-run", gathered: gathered.length, written: toWrite.map((d) => d.claim), folded: folds.length, deferred: overflow.length, discarded: discardCount };
  }

  // 4a. Fold recurrences onto existing pending records.
  const dateStr = now.toISOString().slice(0, 10);
  let folded = 0;
  for (const d of folds) {
    const ref = d.evidence[0] ?? "recurrence";
    if (appendNote(d.cluster_with!, `recurred: ${dateStr} — ${ref}`).ok) folded++;
  }

  // 4b. Write new coach records (claim-hash dedupe handled by the store).
  const written: string[] = [];
  for (const d of toWrite) {
    const res = addUpgrade({
      claim: d.claim,
      source: "coach" as UpgradeSource,
      current_state: d.current_state,
      recommendation: d.recommendation,
      target_surface: d.target_surface,
      confidence: d.confidence,
      session_id: d.session_id || undefined,
      evidence: d.evidence,
      quote: d.quote,
      category: d.category,
    });
    if (res.created) written.push(res.id);
    // duplicate (claim-hash) → dropped, never deferred: a passed/written claim
    // never re-enqueues (CL-4).
  }

  // 5. Advance each source cursor to the newest gathered marker for that source,
  //    and persist overflow (bounded, highest-confidence kept). Cursor advance +
  //    dedupe = exactly-once at the store.
  const advance = (src: SourceKind) => {
    const markers = gathered.filter((c) => c.source === src).map((c) => c.marker);
    if (markers.length === 0) return state.cursors[src];
    return markers.reduce((a, b) => (markerEpoch(src, b) > markerEpoch(src, a) ? b : a));
  };
  const deferBound = Math.max(config.max_new_per_day * 3, 15);
  const nextDeferred = overflow.sort((a, b) => b.confidence - a.confidence).slice(0, deferBound);
  saveState(p.statePath, {
    schema_version: state.schema_version,
    cursors: { failures: advance("failures"), ratings: advance("ratings"), reflections: advance("reflections") },
    deferred: nextDeferred,
  });

  logRun(p.obsLog, { status: "written", gathered: gathered.length, written: written.length, folded, deferred: nextDeferred.length, discarded: discardCount });
  return { status: "written", gathered: gathered.length, written, folded, deferred: nextDeferred.length, discarded: discardCount };
}

// ── CLI ──

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const headless = args.includes("--headless");
  const dryRun = args.includes("--dry-run");
  // Headless defense-in-depth: the tool never calls the VoiceServer, but a
  // scheduled run also declares its channel so any inherited notification hook
  // resolves to `headless` (CL-6).
  if (headless) process.env.LIFEOS_NOTIFICATION_CHANNEL = "headless";

  if (cmd !== "run") {
    console.log("usage: bun CoachReview.ts run [--headless] [--dry-run]");
    process.exit(cmd ? 1 : 0);
  }

  run({ dryRun })
    .then((r) => {
      console.log(JSON.stringify(r));
      process.exit(r.status === "aborted" ? 1 : 0);
    })
    .catch((err) => {
      console.error(`[CoachReview] fatal: ${err}`);
      process.exit(1);
    });
}
