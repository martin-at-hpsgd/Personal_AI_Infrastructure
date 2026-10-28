/**
 * LabelStore: the ONE place a human verdict lands (assay-everywhere S6, ISC-8).
 *
 * The Glance system reads its human labels here, and this module reads each Glance caller's label floor and bar from the registry.
 * Append-only JSONL at LIFEOS/USER/ASSAY/labels.jsonl (override: LIFEOS_LABEL_STORE), mode 0600.
 * A label is {v:1, id, ts, source, kind, receipt_id?, artifact_sha256?, check_id?, caller?, question?, verdict, note?, by}.
 *
 *   source "principal"  a verdict the principal gave (or a delegated attestation recorded as theirs)
 *   source "proxy"      a dismissal, a model agreement, anything that is not the principal's own call
 *
 * "Earned" is computed from this store alone and from principal labels alone: a proxy label can be written and read,
 * and it can never count toward earning (addLabel stamps it, earnedStatus filters it, and a test holds both).
 *
 * verdict meaning: right / wrong = was the CHECK's call right (a flag confirmed or refuted); pass / fail = the human's
 * own verdict on the artifact or claim (ground truth, not a vote on a check); unsure = recorded, counts for nothing.
 * Only right / wrong carry agreement, so only they enter earnedStatus.
 *
 * Under `bun test` with no LIFEOS_LABEL_STORE override the store lives in a per-process OS temp dir, so a suite that exercises a
 * writer can never touch the real store.
 *
 * Engine (ISA LIFEOS/ASSAY M7, ISC-59): a check label naming a caller and question records `engine`, the engine whose verdict it
 * judged ("clef-omni"). addLabel stamps it when the writer does not. A label naming a Proof receipt takes that receipt's
 * `evaluators.glance`; when the receipt is missing, unreadable or names no glance evaluator the engine is "unknown", never the live
 * engine, because the verdict judged an answer whose engine nobody recorded. Only a label naming no receipt (a verdict given now
 * on the engine's current answer: an attestation, a direct check label) takes the live engine. A joined label takes the engine of
 * the receipt run it was joined to, else "unknown". A row written before the field existed reads as its recorded `model`, else
 * "unknown" (labelEngine). For a caller registered in the judgment layer's registry, earnedStatus counts only labels from the
 * engine answering now, and an "unknown" label never counts, so unknown history never earns enforce on Clef-omni.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { invariant } from "../Invariant.ts";
import { getLifeosDir } from "../Paths.ts";
import { liveEngineId, readRegistry, thresholdRows, type CallerRegistry } from "../../ASSAY/Registry.ts";
import { receiptDir, type ProofFinding, type ProofReceipt, type ProofTier } from "./ProofReceipt.ts";

export const LABEL_SOURCES = ["principal", "proxy"] as const;
export const LABEL_KINDS = ["check", "artifact", "reaction"] as const;
export const LABEL_VERDICTS = ["right", "wrong", "pass", "fail", "unsure"] as const;
/** The agreement bar when the registry names none: the same floor a judge needs to read earned (the judge-calibration agreement row in assay-callers.json, read by Calibration.calibrationFloors). */
export const DEFAULT_AGREEMENT_BAR = 0.85;
/** The label floor when neither the question row nor the registry defaults name one. */
export const DEFAULT_MIN_LABELS = 10;

export type LabelSource = (typeof LABEL_SOURCES)[number];
export type LabelKind = (typeof LABEL_KINDS)[number];
export type LabelVerdict = (typeof LABEL_VERDICTS)[number];

export type Label = {
  v: 1;
  id: string;
  ts: string;
  source: LabelSource;
  kind: LabelKind;
  receipt_id?: string;
  artifact_sha256?: string;
  check_id?: string;
  caller?: string;
  question?: string;
  verdict: LabelVerdict;
  /** On a right/wrong label: the true class of the case (what the principal says the answer was). Lets earnedStatus check each class. */
  truth?: "pass" | "fail";
  /** On a label derived by the join (joinPrincipalVerdict): the id of the principal verdict it was derived from. */
  from_label?: string;
  /** On a check label naming caller+question: the engine whose verdict this label judged (labelEngine reads old rows). */
  engine?: string;
  note?: string;
  by: string;
};
/** `id` is optional and additive: a caller that derives a stable id makes its write idempotent (an existing id is returned, never appended again). */
export type LabelInput = Omit<Label, "v" | "id" | "ts"> & { ts?: string; id?: string };

export type LabelQuery = { caller: string; question: string } | { check_id: string };

export function labelStorePath(): string {
  if (process.env.LIFEOS_LABEL_STORE) return process.env.LIFEOS_LABEL_STORE;
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `lifeos-label-store-test-${process.pid}`, "labels.jsonl");
  return join(getLifeosDir(), "USER", "ASSAY", "labels.jsonl");
}

const HEX64 = /^[0-9a-f]{64}$/;
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Append one label. Asserts the schema before the write; never rewrites a line. */
export function addLabel(input: LabelInput, opts: { path?: string } = {}): Label {
  invariant((LABEL_SOURCES as readonly string[]).includes(input.source), `label source must be principal or proxy, got ${String(input.source)}`);
  invariant((LABEL_KINDS as readonly string[]).includes(input.kind), `label kind must be check, artifact or reaction, got ${String(input.kind)}`);
  invariant((LABEL_VERDICTS as readonly string[]).includes(input.verdict), `label verdict invalid: ${String(input.verdict)}`);
  invariant(str(input.by), "a label names who gave it (by)");
  invariant(!!input.receipt_id || !!input.artifact_sha256 || !!input.check_id || !!(input.caller && input.question), "a label must name what it is about: receipt_id, artifact_sha256, check_id, or caller+question");
  if (input.artifact_sha256 !== undefined) invariant(HEX64.test(input.artifact_sha256), "artifact_sha256 must be 64 hex chars");
  if (input.kind === "check") invariant(!!input.check_id || !!(input.caller && input.question), "a check label names a check_id or caller+question");
  if (input.verdict === "right" || input.verdict === "wrong") invariant(input.kind === "check", "right/wrong is a verdict on a check; artifact and reaction labels use pass/fail/unsure");
  const ts = input.ts ?? new Date().toISOString();
  invariant(Number.isFinite(Date.parse(ts)), "label ts must be an ISO timestamp");
  if (input.id !== undefined) invariant(str(input.id), "a supplied label id must be a non-empty string");
  if (input.from_label !== undefined) invariant(str(input.from_label) && input.kind === "check" && (input.verdict === "right" || input.verdict === "wrong"), "from_label is set only on a derived right/wrong check label");
  if (input.engine !== undefined) invariant(str(input.engine) && input.kind === "check" && !!(input.caller && input.question), "engine is set only on a check label naming caller+question, as a non-empty id");
  const engine = input.engine ?? (input.kind === "check" && input.caller && input.question ? stampedEngine(input.receipt_id) : undefined);
  const path = opts.path ?? labelStorePath();
  if (input.id) { const existing = readLabels({ path }).find((l) => l.id === input.id); if (existing) return existing; }
  const label: Label = {
    v: 1, id: input.id ?? randomUUID(), ts, source: input.source, kind: input.kind,
    ...(input.receipt_id ? { receipt_id: input.receipt_id } : {}),
    ...(input.artifact_sha256 ? { artifact_sha256: input.artifact_sha256 } : {}),
    ...(input.check_id ? { check_id: input.check_id } : {}),
    ...(input.caller ? { caller: input.caller } : {}),
    ...(input.question ? { question: input.question } : {}),
    verdict: input.verdict,
    ...(input.truth === "pass" || input.truth === "fail" ? { truth: input.truth } : {}),
    ...(input.from_label ? { from_label: input.from_label } : {}),
    ...(engine ? { engine } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    by: input.by,
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(label) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  if (labelMirrorsToRecord(opts.path)) recordLabelOnStatvs(label);
  return label;
}

// ── STATVS dual-write (STATVS ISA F16, step 1) ──────────────────────────────────────────────────────────────────────────
// Every label addLabel appends is also one row on the record's `label` stream (LIFEOS/STATVS/lib/quality.ts recordLabel):
// ids, keys and the verdict, never the note. labels.jsonl keeps writing exactly as before and stays the store earnedStatus
// reads. The record module loads on first use, so a reader of labels never pays for it, and a record that refuses,
// spools or throws is logged and never fails addLabel. A label returned for an id already in the store writes nothing.

type QualityModule = typeof import("../../STATVS/lib/quality.ts");
let quality: QualityModule | null | undefined;
function qualityModule(): QualityModule | null {
  if (quality === undefined) {
    try { quality = require("../../STATVS/lib/quality.ts") as QualityModule; }
    catch (e) { quality = null; console.error(`[LabelStore] STATVS quality writer unavailable: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return quality;
}

/**
 * True when this label write should reach the record: a write to the live store (by default or by its explicit path, as
 * a caller passing the live path does), or a write to any store while the record itself is a scratch one (bun test, STATVS_DIR).
 */
export function labelMirrorsToRecord(pathArg?: string): boolean {
  if (process.env.NODE_ENV === "test" || process.env.STATVS_DIR) return true;
  return resolve(pathArg ?? labelStorePath()) === resolve(getLifeosDir(), "USER", "ASSAY", "labels.jsonl");
}

const ID_SHAPE = /^[^\s\u0000-\u001f]{1,160}$/;
const idOr = (v: string | undefined): string | undefined => (v && ID_SHAPE.test(v) ? v : undefined);

/** One label as a `label` row. Fields the record would refuse (a receipt id that is not a sha256 key, a key with spaces) are left out. Never throws. */
export function recordLabelOnStatvs(l: Label): void {
  try {
    const q = qualityModule();
    if (!q) return;
    const row: Record<string, string> = { id: l.id, source: l.source, kind: l.kind, verdict: l.verdict };
    const opt: Record<string, string | undefined> = {
      check_id: idOr(l.check_id), caller: idOr(l.caller), question: idOr(l.question), from_label: idOr(l.from_label),
      artifact_sha256: l.artifact_sha256 && HEX64.test(l.artifact_sha256) ? l.artifact_sha256 : undefined,
      receipt_id: l.receipt_id && HEX64.test(l.receipt_id) ? l.receipt_id : undefined,
    };
    for (const [k, v] of Object.entries(opt)) if (v) row[k] = v;
    q.recordLabel(row as Parameters<QualityModule["recordLabel"]>[0]);
  } catch (e) {
    console.error(`[LabelStore] STATVS label row not written: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The engine a new caller+question check label judged when its writer names none. Named receipt: the receipt's glance evaluator,
 * else "unknown" (missing, unreadable or unstamped provenance stays unknown). No receipt: the live engine, since the verdict is on
 * the answer it gives now.
 */
function stampedEngine(receiptId: string | undefined): string {
  if (!receiptId) return liveEngineId();
  return receiptGlanceEngine(receiptId) ?? UNKNOWN_ENGINE;
}

/** The engine id of a label whose provenance is not recorded. It never matches an engine, so it never earns. */
export const UNKNOWN_ENGINE = "unknown";

/** The engine a Proof receipt's glance-tier answers came from (`evaluators.glance`), or null when the receipt is absent or names none. */
function receiptGlanceEngine(receiptId: string | undefined): string | null {
  if (!receiptId || !HEX64.test(receiptId)) return null;
  try {
    const r = JSON.parse(readFileSync(join(receiptDir(), `${receiptId}.json`), "utf8")) as { evaluators?: Record<string, unknown> };
    return str(r?.evaluators?.glance) ? r.evaluators!.glance as string : null;
  } catch { return null; }
}

/** The engine whose verdict a label judged: its `engine`, else a legacy recorded `model`, else "unknown". */
export function labelEngine(l: Pick<Label, "engine"> & { model?: unknown }): string {
  if (str(l.engine)) return l.engine;
  return str(l.model) ? l.model : UNKNOWN_ENGINE;
}

/** Every well-formed label, oldest first, plus the 1-based numbers of the non-blank lines that are not labels (never their contents). */
export function scanLabels(opts: { path?: string } = {}): { labels: Label[]; corrupt: number[] } {
  const path = opts.path ?? labelStorePath();
  if (!existsSync(path)) return { labels: [], corrupt: [] };
  const labels: Label[] = [];
  const corrupt: number[] = [];
  readFileSync(path, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const l = JSON.parse(line) as Label;
      if (isSeedRecord(l)) return; // a seed record shares the file but is not a label, and it is not damage
      if (l?.v === 1 && str(l.id) && (LABEL_SOURCES as readonly string[]).includes(l.source) && (LABEL_VERDICTS as readonly string[]).includes(l.verdict)) labels.push(l);
      else corrupt.push(i + 1);
    } catch { corrupt.push(i + 1); }
  });
  return { labels, corrupt };
}

/** Every well-formed label, oldest first. A malformed line is skipped here, never repaired; earnedStatus refuses to earn while one exists. */
export function readLabels(opts: { path?: string } = {}): Label[] {
  return scanLabels(opts).labels;
}

export function labelsFor(q: LabelQuery, opts: { path?: string; source?: LabelSource } = {}): Label[] {
  return readLabels(opts).filter((l) =>
    ("check_id" in q ? l.check_id === q.check_id : l.caller === q.caller && l.question === q.question) && (!opts.source || l.source === opts.source));
}

export type EarnedStatus = {
  earned: boolean; n: number; agreement: number | null; min_labels: number; bar: number;
  per_class?: { pass: { n: number; agreement: number | null }; fail: { n: number; agreement: number | null } }; reason?: string;
  /** For a registered judgment-layer caller: the engine labels were counted for, and how many principal right/wrong labels judged another engine. */
  engine?: string; other_engine?: number;
};
/** With truth-tagged labels, each class needs this many labels and better-than-coin agreement, so a judge that always answers one way cannot earn. */
export const MIN_PER_CLASS = 2;
export const CLASS_AGREEMENT_BAR = 0.5;

/**
 * Earned from principal right/wrong labels only, including the ones the join derives from the principal's reactions and
 * attestations (joinPrincipalVerdict). The label floor is the registry's (thresholds[question].min_labels, then
 * defaults.min_labels); the bar is the caller's enforce_bar. A proxy label, an "unsure", and a pass/fail ground-truth
 * label are never counted.
 */
export function earnedStatus(q: LabelQuery, opts: { path?: string; callersPath?: string; registry?: CallerRegistry; engine?: string } = {}): EarnedStatus {
  // A torn or corrupted line may be a "wrong" verdict that vanished from the count, which would raise agreement and
  // earn a check it should not. A line cannot be attributed to a question, so any malformed line blocks every earning
  // decision until the store is repaired. The reason names line numbers only, never contents.
  const { corrupt } = scanLabels({ path: opts.path });
  if (corrupt.length) {
    const shown = corrupt.slice(0, 5).join(", ") + (corrupt.length > 5 ? `, +${corrupt.length - 5} more` : "");
    return { earned: false, n: 0, agreement: null, min_labels: DEFAULT_MIN_LABELS, bar: DEFAULT_AGREEMENT_BAR, reason: `the label store has malformed line(s) at ${shown}; nothing earns until it is repaired` };
  }
  const all = labelsFor(q, { path: opts.path, source: "principal" }).filter((l) => l.verdict === "right" || l.verdict === "wrong");
  // Floors come from the leaf read (Registry.ts), never Assay.ts loadRegistry: that would import the runtime back into
  // the label store, and validateCallers already passes the registry it is validating.
  const { callers, defaults } = opts.registry ?? readRegistry(opts.callersPath);
  // A registered judgment-layer caller earns only on labels that judged the engine answering now (ISC-59). Other keys (a
  // deterministic check_id, an unregistered model-judge key such as proof-judge) are not engine answers and are not filtered.
  const engine = "caller" in q && Object.hasOwn(callers, q.caller) ? opts.engine ?? liveEngineId() : null;
  const principal = engine ? all.filter((l) => { const e = labelEngine(l); return e !== UNKNOWN_ENGINE && e === engine; }) : all;
  const engineInfo = engine ? { engine, other_engine: all.length - principal.length } : {};
  const n = principal.length;
  const agreement = n ? principal.filter((l) => l.verdict === "right").length / n : null;
  let minLabels = DEFAULT_MIN_LABELS;
  let bar = DEFAULT_AGREEMENT_BAR;
  if (defaults.min_labels !== undefined) minLabels = defaults.min_labels;
  if ("caller" in q) {
    const cfg = callers[q.caller];
    const row = thresholdRows(cfg)[q.question];
    if (row?.min_labels !== undefined) minLabels = row.min_labels;
    if (cfg?.enforce_bar !== undefined) bar = cfg.enforce_bar;
  }
  const overall = n >= minLabels && agreement !== null && agreement >= bar;
  const tagged = principal.filter((l) => l.truth === "pass" || l.truth === "fail");
  if (!tagged.length) return { earned: overall, n, agreement, min_labels: minLabels, bar, ...engineInfo };
  const cls = (t: "pass" | "fail") => { const xs = tagged.filter((l) => l.truth === t); return { n: xs.length, agreement: xs.length ? xs.filter((l) => l.verdict === "right").length / xs.length : null }; };
  const per_class = { pass: cls("pass"), fail: cls("fail") };
  const weak = (["pass", "fail"] as const).filter((t) => per_class[t].n < MIN_PER_CLASS || (per_class[t].agreement ?? 0) < CLASS_AGREEMENT_BAR);
  const reason = weak.length ? `needs at least ${MIN_PER_CLASS} principal labels per class at ${CLASS_AGREEMENT_BAR * 100}%+ agreement; weak: ${weak.join(", ")}` : undefined;
  return { earned: overall && !weak.length, n, agreement, min_labels: minLabels, bar, per_class, ...(reason ? { reason } : {}), ...engineInfo };
}

// ── Earning by join (ISA 20261010-evals-in-the-isa F4, ISC-12..ISC-14) ────────────────────────────────────────────────────
//
// The principal rarely says "that check was right". They react to the artifact (Errata: rejected, ERR-…) or attest a
// criterion (bunker attest). A check's agreement is derived by joining that verdict to what the check itself said about
// the SAME bytes, read from the Proof receipt bound to the artifact's sha256:
//
//   principal rejected + check said fail  -> right   (truth fail)
//   principal rejected + check said pass  -> no label (the rejection may be about something this check never covered)
//   principal accepted + check said fail  -> wrong   (truth pass)
//   principal accepted + check said pass  -> right   (truth pass)
//   a verdict naming one check (check_id)  -> right/wrong for that check only, by the same table with "rejected" meaning
//                                            the named check should have failed
//
// A derived label is a principal check label (the verdict is the principal's; the join only routes it), carries `truth`
// so earnedStatus's per-class rule stops a check seen on one class from earning, and has an id derived from the bytes, the
// check and the principal's verdict, so a re-run writes nothing new and two complaints about one artifact count once. Findings appended after the boundary run (added_at) are later
// catches, often the principal's own, and are never read as the check's call.

/** The Glance caller and question Proof's glance-tier checks are asked under (skills/Assay/Tools/Proof.ts GLANCE_CALLER, GLANCE_QUESTION; a test holds them equal). */
export const PROOF_GLANCE_CALLER = "proof";
export const PROOF_GLANCE_QUESTION = "intent";

export type CheckCall = "pass" | "fail";
/** One check's own call in one boundary run. Glance-tier calls carry the caller and question earnedStatus is asked with. */
export type RecordedCheck = { check: string; call: CheckCall; tier: ProofTier | null; caller?: string; question?: string };
/** One boundary run of one artifact's bytes, as the join reads it. `engine` is the receipt's `evaluators.glance`: the engine its glance-tier calls came from. */
export type RecordedRun = { receipt_id: string; sha256: string; ran_at: string; run_id: string | null; checks: RecordedCheck[]; engine?: string | null };

/** A profile entry that names a check that ran: a bare id. Notes ("bar:8.5", "ask:…", "escalate:…") and relabels ("x:n/a(…)") carry a colon or a space. */
const BARE_CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * What each check said in one receipt run. A check said fail when it has a boundary finding of severity fail, or a flag
 * that is not unsure. It said nothing (absent from the result) when its only findings are unavailable or unsure. It said
 * pass when the profile names it as run and it has no boundary finding. A finding whose id extends a run check ("x:major:ab12")
 * belongs to that check. Checks that ran without a profile entry and passed are invisible, so they get no call.
 */
export function recordedChecks(receipt: Pick<ProofReceipt, "profile" | "findings" | "verdict">): RecordedCheck[] {
  if (receipt.verdict === "reference") return [];
  const profile = receipt.profile ?? [];
  // Glance checks the run asked (Proof's `glance:<id>` notes): they ran even when no bare id names them, and a pass among them is a Glance call.
  const glanceAsked = new Set(profile.filter((p) => p.startsWith(GLANCE_NOTE)).map((p) => p.slice(GLANCE_NOTE.length)).filter((id) => BARE_CHECK_ID.test(id)));
  const ran = new Set([...profile.filter((p) => BARE_CHECK_ID.test(p)), ...glanceAsked]);
  const owner = (id: string): string => (ran.has(id) ? id : [...ran].find((p) => id.startsWith(`${p}:`)) ?? id);
  const byCheck = new Map<string, ProofFinding[]>();
  for (const f of receipt.findings ?? []) {
    if (f.added_at || !str(f.check)) continue;
    const id = owner(f.check);
    byCheck.set(id, [...(byCheck.get(id) ?? []), f]);
  }
  const out: RecordedCheck[] = [];
  for (const [check, fs] of byCheck) {
    const decisive = fs.find((f) => f.severity === "fail" || (f.severity === "flag" && f.unsure !== true));
    if (!decisive) continue; // unavailable or unsure only: the check made no call
    out.push({ check, call: "fail", tier: decisive.tier, ...glanceKey(decisive) });
  }
  for (const check of ran) {
    if (byCheck.has(check)) continue;
    out.push(glanceAsked.has(check) ? { check, call: "pass", tier: "glance", caller: PROOF_GLANCE_CALLER, question: PROOF_GLANCE_QUESTION } : { check, call: "pass", tier: null });
  }
  const judge = judgeCall(profile);
  if (judge) out.push(judge);
  return out;
}

// ── One way of filing labels (STATVS ISA F16 step 1; Assay label keying) ─────────────────────────────────────────────────
//
// A label is filed under exactly the key its earned reader asks earnedStatus with:
//   - a registered judgment-layer caller (Glance tier): {caller, question}, which the join writes from the finding, and for
//     a pass (no finding) from the receipt profile's `glance:<id>` note;
//   - every other judged check: {check_id}, the receipt's check id, which the join writes as the label's check_id;
//   - Proof's escalation judge, one judge calibrated across the checks it is asked about: {check_id: proofJudgeCheckId(..)},
//     declared in the receipt profile as `judge-key:<id>` with one `<check>:judge-yes…` or `<check>:judge-no` note per
//     answer, so the join files the judge's own call (no if any check got a no, else yes) under the id Proof reads.
// LIFEOS/TOOLS/lib/LabelStore.keying.test.ts holds each writer and reader to the same key.

/** The profile note naming one Glance check the run asked; a pass among them is filed under Proof's glance caller and question. */
export const GLANCE_NOTE = "glance:";
/** The profile note that names the escalation judge's label key. */
export const JUDGE_KEY_NOTE = "judge-key:";
/** The check id Proof's escalation judge is calibrated under: one judge prompt on one vendor, so a new prompt or vendor starts unearned. */
export function proofJudgeCheckId(promptHash: string, vendor: string): string {
  return `proof-judge:${PROOF_GLANCE_QUESTION}@${promptHash}:${vendor}`;
}

/** The escalation judge's own call in one run, from the profile notes Proof writes; null when no judge key or no yes/no answer. */
export function judgeCall(profile: readonly string[]): RecordedCheck | null {
  const keyNote = profile.find((p) => p.startsWith(JUDGE_KEY_NOTE));
  const key = keyNote?.slice(JUDGE_KEY_NOTE.length) ?? "";
  if (!key || /\s/.test(key)) return null;
  const no = profile.some((p) => /:judge-no$/.test(p));
  const yes = profile.some((p) => /:judge-yes(\(|$)/.test(p));
  if (!no && !yes) return null;
  return { check: key, call: no ? "fail" : "pass", tier: "judge" };
}

function glanceKey(f: ProofFinding): { caller?: string; question?: string } {
  if (f.tier !== "glance") return {};
  const own = f as ProofFinding & { caller?: unknown; question?: unknown };
  return { caller: str(own.caller) ? own.caller : PROOF_GLANCE_CALLER, question: str(own.question) ? own.question : PROOF_GLANCE_QUESTION };
}

/** The stable id of the label one principal verdict on these bytes yields for one check: re-deriving, or a second complaint about the same bytes, never appends twice. */
export function joinedLabelId(sha256: string, check: string, principalVerdict: "pass" | "fail"): string {
  return `join-${createHash("sha256").update(`${sha256}\u0000${check}\u0000${principalVerdict}`).digest("hex").slice(0, 32)}`;
}

/** A principal pass/fail verdict the join can route: the principal's own, about an artifact or a named check. */
export function isJoinableVerdict(l: Label): boolean {
  return l.source === "principal" && (l.verdict === "pass" || l.verdict === "fail") && (l.kind === "reaction" || l.kind === "artifact" || (l.kind === "check" && str(l.check_id)));
}

/**
 * THE join (ISC-12): derive right/wrong check labels from one principal verdict and the run it is joined to. Returns the
 * labels to write (each with a stable id) and nothing for a pair the table calls unknown. Pure: reads and writes nothing.
 */
export function joinPrincipalVerdict(principal: Label, run: RecordedRun): Array<LabelInput & { id: string }> {
  if (!isJoinableVerdict(principal)) return [];
  const rejected = principal.verdict === "fail";
  const truth: "pass" | "fail" = rejected ? "fail" : "pass";
  const named = str(principal.check_id) ? principal.check_id : undefined;
  const checks = named ? run.checks.filter((c) => c.check === named) : run.checks;
  const out: Array<LabelInput & { id: string }> = [];
  for (const c of checks) {
    let verdict: "right" | "wrong" | null;
    if (named) verdict = (c.call === "fail") === rejected ? "right" : "wrong";
    else verdict = rejected ? (c.call === "fail" ? "right" : null) : c.call === "pass" ? "right" : "wrong";
    if (!verdict) continue;
    out.push({
      id: joinedLabelId(run.sha256, c.check, principal.verdict as "pass" | "fail"), ts: principal.ts, source: "principal", kind: "check",
      check_id: c.check, ...(c.caller && c.question ? { caller: c.caller, question: c.question, engine: str(run.engine) ? run.engine : "unknown" } : {}),
      receipt_id: run.receipt_id, artifact_sha256: run.sha256, verdict, truth, from_label: principal.id,
      note: `joined: principal ${principal.verdict} x check said ${c.call} in run ${run.run_id ?? run.ran_at}`,
      by: principal.by,
    });
  }
  return out;
}

// ── Receipt index: every boundary run on disk, by artifact sha256 ────────────────────────────────────────────────────────

/** Every readable receipt run (current files and their superseded-run history) grouped by artifact sha256. Unreadable lines are skipped. */
export function indexReceiptRuns(dir: string = receiptDir()): Map<string, RecordedRun[]> {
  const bySha = new Map<string, RecordedRun[]>();
  if (!existsSync(dir)) return bySha;
  const add = (receipt_id: string, raw: unknown): void => {
    const r = raw as Partial<ProofReceipt> | null;
    if (!r || typeof r !== "object" || !str(r.sha256) || !HEX64.test(r.sha256) || !Array.isArray(r.findings) || !str(r.ran_at)) return;
    const glance = (r as { evaluators?: Record<string, unknown> }).evaluators?.glance;
    const run: RecordedRun = { receipt_id, sha256: r.sha256, ran_at: r.ran_at, run_id: str(r.run_id) ? r.run_id : null, checks: recordedChecks(r as ProofReceipt), engine: str(glance) ? glance : null };
    bySha.set(r.sha256, [...(bySha.get(r.sha256) ?? []), run]);
  };
  for (const f of readdirSync(dir)) {
    const id = f.replace(/\.history\.jsonl$|\.json$/, "");
    if (!HEX64.test(id)) continue;
    try {
      if (f.endsWith(".history.jsonl")) for (const line of readFileSync(join(dir, f), "utf8").split("\n")) { if (line.trim()) { try { add(id, JSON.parse(line)); } catch { /* skip */ } } }
      else if (f.endsWith(".json")) add(id, JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch { /* unreadable file: skip */ }
  }
  return bySha;
}

/** The run a verdict reacted to: on the same bytes (and receipt, when the label names one), the latest run at or before the verdict, else the earliest after. */
export function runForVerdict(principal: Label, index: ReadonlyMap<string, readonly RecordedRun[]>): RecordedRun | null {
  if (!principal.artifact_sha256) return null;
  const runs = (index.get(principal.artifact_sha256) ?? []).filter((r) => !principal.receipt_id || r.receipt_id === principal.receipt_id);
  if (!runs.length) return null;
  const at = Date.parse(principal.ts);
  const sorted = [...runs].sort((a, b) => Date.parse(a.ran_at) - Date.parse(b.ran_at));
  return sorted.filter((r) => Date.parse(r.ran_at) <= at).at(-1) ?? sorted[0]!;
}

export type JoinReport = {
  principal_verdicts: number;
  joined: number;
  unjoined: { no_artifact: number; no_receipt: number; no_call: number };
  derived: number;
  new_labels: number;
  per_check: Record<string, { right: number; wrong: number }>;
  per_caller_question: Record<string, { right: number; wrong: number }>;
  labels: Array<LabelInput & { id: string }>;
};

/** Derive every joined label the store's principal verdicts yield, and say which are new. Reads only. */
export function deriveJoinedLabels(opts: { path?: string; receiptsDir?: string; index?: ReadonlyMap<string, readonly RecordedRun[]> } = {}): JoinReport {
  const all = readLabels({ path: opts.path });
  const have = new Set(all.map((l) => l.id));
  const index = opts.index ?? indexReceiptRuns(opts.receiptsDir);
  const report: JoinReport = { principal_verdicts: 0, joined: 0, unjoined: { no_artifact: 0, no_receipt: 0, no_call: 0 }, derived: 0, new_labels: 0, per_check: {}, per_caller_question: {}, labels: [] };
  const seen = new Set<string>();
  for (const l of all) {
    if (!isJoinableVerdict(l)) continue;
    report.principal_verdicts++;
    if (!l.artifact_sha256) { report.unjoined.no_artifact++; continue; }
    const run = runForVerdict(l, index);
    if (!run) { report.unjoined.no_receipt++; continue; }
    const derived = joinPrincipalVerdict(l, run).filter((d) => !seen.has(d.id));
    if (!derived.length) { report.unjoined.no_call++; continue; }
    report.joined++;
    for (const d of derived) {
      seen.add(d.id);
      report.derived++;
      const v = d.verdict as "right" | "wrong";
      (report.per_check[d.check_id!] ??= { right: 0, wrong: 0 })[v]++;
      if (d.caller && d.question) (report.per_caller_question[`${d.caller}.${d.question}`] ??= { right: 0, wrong: 0 })[v]++;
      if (!have.has(d.id)) { report.new_labels++; report.labels.push(d); }
    }
  }
  return report;
}

/**
 * Append the joined labels a report names (ISC-13). Append-only and idempotent: each label's id is derived from its
 * source verdict and check, and addLabel returns an existing id without appending. Every write is asserted against the
 * source label it was derived from before it lands.
 */
export function writeJoinedLabels(labels: ReadonlyArray<LabelInput & { id: string }>, opts: { path?: string } = {}): number {
  const sources = new Map(readLabels({ path: opts.path }).map((l) => [l.id, l]));
  let written = 0;
  for (const d of labels) {
    const src = d.from_label ? sources.get(d.from_label) : undefined;
    invariant(!!src && isJoinableVerdict(src), `joined label ${d.id} must name a principal pass/fail source label in the store`);
    invariant(!!d.artifact_sha256 && d.artifact_sha256 === src.artifact_sha256 && d.id === joinedLabelId(d.artifact_sha256, d.check_id ?? "", src.verdict as "pass" | "fail"), `joined label ${d.id} id must derive from its source bytes, check and verdict`);
    invariant(d.source === "principal" && d.kind === "check" && (d.verdict === "right" || d.verdict === "wrong"), `joined label ${d.id} must be a principal right/wrong check label`);
    invariant(d.truth === (src.verdict === "fail" ? "fail" : "pass"), `joined label ${d.id} truth must be the principal's verdict`);
    invariant(!(d.caller && d.question) || str(d.engine), `joined label ${d.id} names a caller and question, so it must record the engine of the run it was joined to`);
    const before = sources.has(d.id);
    addLabel(d, { path: opts.path });
    if (!before) { written++; sources.set(d.id, d as Label); }
  }
  return written;
}

// ── Seed view (ISA 20261010-evals-in-the-isa F4, ISC-15) ─────────────────────────────────────────────────────────────────
//
// The per-criterion calibration seed (Calibration/seeds/<isa-key>/<claim>.yaml) is a READ VIEW of this store. Every seed
// entry lives here as a seed record on the same JSONL file; the YAML is regenerated from those records after every write
// and is written by nothing outside this section. A seed record is not a label (it has no `source`), so readLabels,
// earnedStatus and labelStats never see it; the verdict the same attestation carries lands as an ordinary label beside it.
//
//   {v:1, type:"seed", id, ts, key, claim, index, prev, shape, header, entry}
//
// `index` is the entry's position in the seed. A later record at the same index supersedes the earlier one (an attached
// engine answer, a legacy file whose entry was edited in place); `entry: null` retracts it (a failed miss rolled back).
// `prev` is the id of the record it supersedes, so every id is unique and re-adopting an unchanged file writes nothing.
// `header` is the seed's top-level object with `entries: null` holding its key position, so the view reproduces the file.
// Two writers taking the same index at once leave the later one in the view: the same last-writer-wins the YAML had.

export type SeedShape = "object" | "array";
export type SeedRecord = {
  v: 1; type: "seed"; id: string; ts: string; key: string; claim: string; index: number; prev: string | null;
  shape: SeedShape; header: Record<string, unknown>; entry: Record<string, unknown> | null;
};
export type SeedView = { shape: SeedShape; header: Record<string, unknown>; entries: Array<Record<string, unknown>>; indices: number[] };

const SEED_KEY = /^[0-9a-f]{16}$/;
const SEED_CLAIM = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function seedFilePath(seedsDir: string, key: string, claim: string): string {
  invariant(SEED_KEY.test(key), `seed key must be the 16-hex ISA key, got ${key}`);
  invariant(SEED_CLAIM.test(claim), `seed claim must be a plain criterion id, got ${claim}`);
  return join(seedsDir, key, `${claim}.yaml`);
}

/** A well-formed seed record: the shape appendSeedRecord writes. */
function isSeedRecord(r: unknown): r is SeedRecord {
  const s = r as SeedRecord | null;
  return !!s && s.v === 1 && s.type === "seed" && str(s.id) && str(s.key) && str(s.claim) && Number.isInteger(s.index) && s.index >= 0 && isObj(s.header) && (s.entry === null || isObj(s.entry));
}

/** Every well-formed seed record, oldest first. */
export function readSeedRecords(opts: { path?: string } = {}): SeedRecord[] {
  const path = opts.path ?? labelStorePath();
  if (!existsSync(path)) return [];
  const out: SeedRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"type":"seed"')) continue;
    try {
      const r = JSON.parse(line) as SeedRecord;
      if (isSeedRecord(r)) out.push(r);
    } catch { /* skip */ }
  }
  return out;
}

function foldSeed(records: readonly SeedRecord[]): { view: SeedView | null; latest: Map<number, SeedRecord>; nextIndex: number } {
  const latest = new Map<number, SeedRecord>();
  for (const r of records) latest.set(r.index, r);
  const nextIndex = records.length ? Math.max(...records.map((r) => r.index)) + 1 : 0;
  if (!records.length) return { view: null, latest, nextIndex };
  const last = records.at(-1)!;
  const live = [...latest.values()].filter((r) => r.entry !== null).sort((a, b) => a.index - b.index);
  return { view: { shape: last.shape, header: last.header, entries: live.map((r) => r.entry!), indices: live.map((r) => r.index) }, latest, nextIndex };
}

const recordsFor = (key: string, claim: string, path: string): SeedRecord[] => readSeedRecords({ path }).filter((r) => r.key === key && r.claim === claim);

/** The seed one criterion's records fold to, or null when the store holds none. */
export function seedViewOf(key: string, claim: string, opts: { path?: string } = {}): SeedView | null {
  return foldSeed(recordsFor(key, claim, opts.path ?? labelStorePath())).view;
}

function seedRecordId(key: string, claim: string, index: number, entry: Record<string, unknown> | null, prev: string | null): string {
  return `seed-${createHash("sha256").update([key, claim, String(index), JSON.stringify(entry), prev ?? ""].join("\u0000")).digest("hex").slice(0, 32)}`;
}

function appendSeedRecord(input: Omit<SeedRecord, "v" | "type" | "id" | "ts"> & { ts?: string }, path: string): SeedRecord {
  invariant(SEED_KEY.test(input.key) && SEED_CLAIM.test(input.claim), `seed record must name a 16-hex key and a plain claim id (${input.key}/${input.claim})`);
  invariant(Number.isInteger(input.index) && input.index >= 0, "seed record index must be a non-negative integer");
  invariant(input.shape === "object" || input.shape === "array", "seed shape must be object or array");
  invariant(isObj(input.header) && (input.shape === "array" || input.header.entries === null), "an object seed header holds entries: null where the entries go");
  invariant(input.entry === null || (isObj(input.entry) && (input.entry.label === "pass" || input.entry.label === "fail")), "a seed entry is an object labelled pass or fail, or null for a retraction");
  const ts = input.ts ?? new Date().toISOString();
  invariant(Number.isFinite(Date.parse(ts)), "seed record ts must be an ISO timestamp");
  const rec: SeedRecord = { v: 1, type: "seed", id: seedRecordId(input.key, input.claim, input.index, input.entry, input.prev), ts, key: input.key, claim: input.claim, index: input.index, prev: input.prev, shape: input.shape, header: input.header, entry: input.entry };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return rec;
}

function parseSeedFile(text: string): { shape: SeedShape; header: Record<string, unknown>; entries: Array<Record<string, unknown>> } {
  const y = parseYaml(text) as unknown;
  if (Array.isArray(y)) return { shape: "array", header: {}, entries: y.filter(isObj) };
  if (isObj(y) && Array.isArray(y.entries)) {
    const header: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(y)) header[k] = k === "entries" ? null : v;
    return { shape: "object", header, entries: (y.entries as unknown[]).filter(isObj) };
  }
  return { shape: "object", header: { entries: null }, entries: [] };
}

/** The YAML text a view renders to: the header with its entries slot filled, or the bare list for a legacy array seed. */
export function renderSeedView(view: SeedView): string {
  if (view.shape === "array") return stringifyYaml(view.entries);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(view.header)) out[k] = k === "entries" ? view.entries : v;
  if (!("entries" in out)) out.entries = view.entries;
  return stringifyYaml(out);
}

/**
 * Bring a seed file the store does not yet hold into the store: every entry whose content differs from the store's entry
 * at the same position becomes a record superseding it, and the file's header rides on those records. Run before every
 * write so a legacy seed's entries are never dropped by the regeneration. Idempotent: an unchanged file appends nothing.
 */
export function adoptSeedFile(seedsDir: string, key: string, claim: string, opts: { path?: string; ts?: string } = {}): number {
  const file = seedFilePath(seedsDir, key, claim);
  if (!existsSync(file)) return 0;
  const path = opts.path ?? labelStorePath();
  let parsed: ReturnType<typeof parseSeedFile>;
  try { parsed = parseSeedFile(readFileSync(file, "utf8")); } catch { return 0; } // unreadable seed: nothing to adopt, the store stays authoritative
  const { view, latest, nextIndex } = foldSeed(recordsFor(key, claim, path));
  const indices = view?.indices ?? [];
  let next = nextIndex;
  let written = 0;
  parsed.entries.forEach((entry, p) => {
    const index = p < indices.length ? indices[p]! : next++;
    const prior = latest.get(index);
    if (prior?.entry && JSON.stringify(prior.entry) === JSON.stringify(entry)) return;
    if (entry.label !== "pass" && entry.label !== "fail") return; // a malformed legacy entry is not carried into the store
    appendSeedRecord({ key, claim, index, prev: prior?.id ?? null, shape: parsed.shape, header: parsed.header, entry, ts: opts.ts }, path);
    written++;
  });
  return written;
}

/** Regenerate one criterion's seed YAML from the store. No live entries: the file (and an emptied key dir) is removed. Returns the file path, or null when removed. */
export function writeSeedView(seedsDir: string, key: string, claim: string, opts: { path?: string } = {}): string | null {
  const file = seedFilePath(seedsDir, key, claim);
  const view = seedViewOf(key, claim, opts);
  if (!view || view.entries.length === 0) {
    rmSync(file, { force: true });
    if (existsSync(dirname(file)) && readdirSync(dirname(file)).length === 0) rmdirSync(dirname(file));
    return null;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderSeedView(view));
  return file;
}

/** Append one seed entry (adopting the existing file first), regenerate the view, and say where it landed. */
export function addSeedEntry(seedsDir: string, key: string, claim: string, header: Record<string, unknown>, entry: Record<string, unknown>, opts: { path?: string; ts?: string } = {}): { path: string; index: number; before: number; entries: Array<Record<string, unknown>>; record: SeedRecord } {
  const store = opts.path ?? labelStorePath();
  adoptSeedFile(seedsDir, key, claim, { path: store });
  const { view: before, nextIndex } = foldSeed(recordsFor(key, claim, store));
  // A legacy array seed keeps its shape only until something new is written; the attest writer has always emitted the object form.
  const header0 = { ...(before?.shape === "object" ? before.header : {}), ...header, entries: null };
  const record = appendSeedRecord({ key, claim, index: nextIndex, prev: null, shape: "object", header: header0, entry, ts: opts.ts }, store);
  const path = writeSeedView(seedsDir, key, claim, { path: store });
  const view = seedViewOf(key, claim, { path: store });
  const prior = before?.entries.length ?? 0;
  invariant(path !== null && !!view && view.indices.includes(record.index) && view.entries.length === prior + 1, "the appended seed entry must appear in the regenerated view, exactly once");
  return { path, index: record.index, before: prior, entries: view.entries, record };
}

/** Replace the entry at one index (an attached engine answer), refusing when the stored entry is not the one the caller read. */
export function amendSeedEntry(seedsDir: string, key: string, claim: string, index: number, expected: Record<string, unknown>, entry: Record<string, unknown>, opts: { path?: string } = {}): string {
  const store = opts.path ?? labelStorePath();
  const { view, latest } = foldSeed(recordsFor(key, claim, store));
  const prior = latest.get(index);
  invariant(!!view && !!prior?.entry && JSON.stringify(prior.entry) === JSON.stringify(expected), "recorded label changed before answer attachment");
  appendSeedRecord({ key, claim, index, prev: prior.id, shape: view.shape, header: view.header, entry }, store);
  return writeSeedView(seedsDir, key, claim, { path: store })!;
}

/** The ids of one criterion's current seed records: a rollback point for retractSeedEntriesSince. */
export function seedRecordIds(key: string, claim: string, opts: { path?: string } = {}): Set<string> {
  return new Set(recordsFor(key, claim, opts.path ?? labelStorePath()).map((r) => r.id));
}

/** Undo every seed record appended since a rollback point (append-only: each index goes back to its prior entry or is retracted), then regenerate the view. */
export function retractSeedEntriesSince(seedsDir: string, key: string, claim: string, before: ReadonlySet<string>, opts: { path?: string } = {}): number {
  const store = opts.path ?? labelStorePath();
  const records = recordsFor(key, claim, store);
  const { latest } = foldSeed(records);
  const touched = new Set(records.filter((r) => !before.has(r.id)).map((r) => r.index));
  let n = 0;
  for (const i of touched) {
    const cur = latest.get(i)!;
    const restore = records.filter((r) => r.index === i && before.has(r.id)).at(-1);
    const target = restore?.entry ?? null;
    if (JSON.stringify(cur.entry) === JSON.stringify(target)) continue;
    appendSeedRecord({ key, claim, index: i, prev: cur.id, shape: restore?.shape ?? cur.shape, header: restore?.header ?? cur.header, entry: target }, store);
    n++;
  }
  writeSeedView(seedsDir, key, claim, { path: store });
  return n;
}

/** Adopt every seed file under a seeds dir into the store (the one-time backfill; safe to re-run). Reads the files, writes only the store. */
export function importSeeds(seedsDir: string, opts: { path?: string } = {}): { files: number; records: number } {
  let files = 0, records = 0;
  if (!existsSync(seedsDir)) return { files, records };
  for (const d of readdirSync(seedsDir, { withFileTypes: true })) {
    if (!d.isDirectory() || !SEED_KEY.test(d.name)) continue;
    for (const f of readdirSync(join(seedsDir, d.name))) {
      const claim = f.replace(/\.ya?ml$/, "");
      if (claim === f || !SEED_CLAIM.test(claim)) continue;
      files++;
      records += adoptSeedFile(seedsDir, d.name, claim, opts);
    }
  }
  return { files, records };
}
