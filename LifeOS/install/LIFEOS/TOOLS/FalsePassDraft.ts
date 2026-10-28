#!/usr/bin/env bun
/**
 * @version 1.0.1
 * FalsePassDraft.ts — a false pass or a principal overrule drafts that criterion's eval revision
 * (ISA 20261010-evals-in-the-isa, ISC-40).
 *
 * Two events count as a miss of the eval that let an output through:
 *   - false pass: a principal rejection (an erratum citing exactly one output, or a principal `artifact` fail label)
 *     joins to a receipt for the same bytes whose verdict at the boundary was pass;
 *   - overrule: the principal picks a different candidate than a tournament's winner.
 *
 * For each, this drafts the check that would have caught it, in the ISA's `## Evals` format (ISAFormat.md § "## Evals"):
 * when the receipt names an ISA criterion that already has a block, the draft is that block revised (the new glance
 * question joins its glance stage, or a new glance stage sits after the code stages, so stages stay cheapest first);
 * otherwise it is a new block. Every draft is round-tripped through parseEvalsText and the result recorded.
 *
 * It files ONE Upgrades item (source "assay-miss") per receipt and check. It is a recommendation: nothing lands in an
 * ISA without the principal's yes (OPERATIONAL_PREFERENCES § Autonomy & approval). This module never writes an ISA.
 *
 * Cost: no model call, ever. The question text is drafted deterministically from the complaint words; a complaint too
 * thin to word a question (fewer than three content words) drafts an `<EDIT: …>` placeholder and is marked
 * needs_wording, so the Upgrades item itself is the queue for its wording.
 *
 * Dedupe key: `<receipt id or overrule fingerprint>:<check id>`, where the check id is `fp-`/`ov-` plus 8 hex of the
 * normalized complaint. It rides in the item's evidence as `fpd:<key>` and in the claim, so both the evidence scan
 * here and the store's claim-hash dedup catch a repeat. The output id rides in evidence too, so Errata's
 * `misses --file-upgrades` (OutputJoin.fileAssayMissUpgrades) does not file the same output a second time.
 *
 * CLI:
 *   bun LIFEOS/TOOLS/FalsePassDraft.ts scan-labels [--since ISO] [--dry-run] [--json]
 *   bun LIFEOS/TOOLS/FalsePassDraft.ts overrule --question Q --winner W --pick P [--note N] [--isa PATH]
 *                                      [--criterion ID] [--receipt ID] [--dry-run] [--json]
 *   bun LIFEOS/TOOLS/FalsePassDraft.ts help
 *
 * Capture path: LIFEOS/ERRATA/Capture.ts recordHookErratum calls draftFalsePassForErratum after the erratum lands.
 */
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { extname, join } from "path";
import { invariant } from "./Invariant";
import { addUpgrade as addUpgradeReal, listUpgrades as listUpgradesReal, type UpgradeInput } from "./Upgrades";
import { parseEvalsText, type EvalCheckKind, type StagedEval } from "./lib/IsaTestStrategy";
import { readOutputLines, type OutputLine } from "./lib/OutputLedger";
import { receiptDir } from "./lib/ProofReceipt";
import { readLabels, type Label } from "./lib/LabelStore";
import { suggestMissCommand, NO_SKILL } from "../ERRATA/OutputJoin";

export const DRAFT_SOURCE = "assay-miss" as const;
/** The Glance caller a drafted question registers under; compiled ISA evals use the same caller. */
export const DRAFT_CALLER = "isa-evals";
/** The heading id a draft uses when no ISA criterion is known; the reviewer assigns it. */
export const UNASSIGNED_ISC = "ISC-NEW";
const HEX64 = /^[0-9a-f]{64}$/;
const COMPLAINT_KINDS: ReadonlySet<string> = new Set(["complaint", "correction", "bug", "incident"]);
/** Kinds whose bytes a text producer (`cat`) can hand to a judgment-layer question as state. */
const TEXT_KINDS: ReadonlySet<string> = new Set(["text", "doc", "page", "diff"]);
const MIN_CONTENT_WORDS = 3;

// ── inputs ──────────────────────────────────────────────────────────────────

/** The receipt fields a draft reads. Both receipt schemas carry these; assay-receipt/1 adds the boundary and ideal state. */
export interface ReceiptForDraft {
  artifact?: string;
  sha256: string;
  kind?: string;
  verdict: string;
  verdict_at_boundary?: { verdict?: string } | null;
  ideal_state?: { kind: string; path?: string; criteria?: string[] } | null;
}

export type MissEvent =
  | {
      type: "false-pass";
      receipt_id: string;
      receipt: ReceiptForDraft;
      /** What the principal said was wrong. */
      complaint: string;
      /** The erratum or label that carried the rejection. */
      rejection_id: string;
      output_id?: string;
      skill?: string;
    }
  | {
      type: "overrule";
      question: string;
      winner: string;
      pick: string;
      /** Why the principal picked differently, in their words. */
      note?: string;
      receipt_id?: string;
      isa?: string;
      criterion?: string;
      rejection_id?: string;
    };

export interface EvalDraft {
  key: string;
  check_id: string;
  event: MissEvent["type"];
  receipt_id: string | null;
  artifact_kind: string;
  isa: string | null;
  criterion: string | null;
  /** The `### <ISC> · <title>` heading plus its yaml fence: paste-ready ISA Evals format. */
  block: string;
  /** True when the block is the criterion's existing eval with the new check added. */
  revises_existing: boolean;
  validated: boolean;
  validation_error?: string;
  needs_wording: boolean;
  /** Set when the drafted producer cannot hand these bytes to a question as they stand (media kinds). */
  producer_note?: string;
}

export interface DraftDeps {
  readFile?: (path: string) => string | null;
}

// ── small pure helpers ──────────────────────────────────────────────────────

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const STOP = new Set(["this", "that", "with", "from", "have", "were", "what", "when", "your", "they", "them", "then", "than", "just", "into", "also", "very", "really", "still", "again", "there", "their", "about", "would", "could", "should"]);
export function contentWords(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !STOP.has(w));
}

/** The check id for a drafted question: stable for the same complaint, different for a different defect. */
export function checkIdFor(event: MissEvent["type"], text: string): string {
  return `${event === "overrule" ? "ov" : "fp"}-${sha1(squash(text).toLowerCase()).slice(0, 8)}`;
}

/** The verdict the receipt carried when it was checked. A finding appended later never turns a boundary pass into a non-miss. */
export function passedAtBoundary(r: ReceiptForDraft): boolean {
  return (r.verdict_at_boundary?.verdict ?? r.verdict) === "pass";
}

/** Criterion id → its text, from the ISA's criterion lines (`- ISC-n: …`, with or without a checkbox). */
export function criterionTitles(isaText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of isaText.split("\n")) {
    const m = /^\s*-\s*(?:\[[ xX]\]\s*)?([A-Za-z][\w.-]*-[\w.]+):\s*(.+?)\s*$/.exec(line);
    if (m && !out.has(m[1]!)) out.set(m[1]!, m[2]!);
  }
  return out;
}

/**
 * The criterion a miss is about: the receipt's only criterion, or among several the one whose text shares the most
 * content words with the complaint. Several with no overlap, or a tie at the top, names none: a guess is worse than
 * leaving it for the reviewer.
 */
export function pickCriterion(criteria: string[] | undefined, titles: Map<string, string>, complaint: string): string | null {
  if (!criteria?.length) return null;
  if (criteria.length === 1) return criteria[0]!;
  const cw = new Set(contentWords(complaint));
  const scored = criteria.map((id) => ({ id, n: contentWords(titles.get(id) ?? "").filter((w) => cw.has(w)).length })).sort((a, b) => b.n - a.n);
  if (scored[0]!.n === 0 || scored[0]!.n === scored[1]?.n) return null;
  return scored[0]!.id;
}

function quoteArg(p: string): string {
  if (!/[\s'"]/.test(p)) return p;
  return p.includes("'") ? `"${p}"` : `'${p}'`;
}

function kindOfPath(p: string): string {
  const ext = extname(p).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".webm", ".mkv"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".m4a", ".aac", ".flac"].includes(ext)) return "audio";
  if ([".html", ".htm"].includes(ext)) return "page";
  return "text";
}

// ── YAML rendering (every scalar JSON-quoted, which YAML reads as a double-quoted string) ──

type QuestionDraft = { id: string; kind: string; claim?: string; instructions: string; criteria?: unknown; options?: unknown; producer: string; caller: string };
type DraftStage = { kind: EvalCheckKind; checks: Array<string | QuestionDraft> };

const q = (s: string) => JSON.stringify(s);

function renderQuestion(x: QuestionDraft): string[] {
  const lines = [`      - id: ${q(x.id)}`, `        kind: ${q(x.kind)}`];
  if (x.claim) lines.push(`        claim: ${q(x.claim)}`);
  lines.push(`        instructions: ${q(x.instructions)}`);
  if (x.criteria !== undefined) lines.push(`        criteria: ${JSON.stringify(x.criteria)}`);
  if (x.options !== undefined) lines.push(`        options: ${JSON.stringify(x.options)}`);
  lines.push(`        producer: ${q(x.producer)}`, `        caller: ${q(x.caller)}`);
  return lines;
}

export function renderBlock(isc: string, title: string, stages: DraftStage[]): string {
  const body: string[] = ["stages:"];
  for (const s of stages) {
    body.push(`  - ${s.kind}:`);
    for (const c of s.checks) body.push(...(typeof c === "string" ? [`      - ${q(c)}`] : renderQuestion(c)));
  }
  const heading = title ? `### ${isc} · ${squash(title).slice(0, 120)}` : `### ${isc}`;
  return [heading, "", "```yaml", ...body, "```"].join("\n");
}

/** A parsed staged eval back to renderable stages, so a revision keeps every existing check byte-for-byte in meaning. */
export function stagesOf(e: StagedEval): DraftStage[] {
  return e.stages.map((s) => ({
    kind: s.checks[0]!.kind,
    checks: s.checks.map((c): string | QuestionDraft => {
      if (c.kind !== "glance" || !c.question) return c.tool;
      const g = c.question;
      return { id: g.id, kind: g.kind, claim: g.claim, instructions: g.instructions, criteria: g.criteria, options: g.options, producer: g.state.producer, caller: g.caller };
    }),
  }));
}

/** Add the question to the first glance stage, or as a new glance stage before the first costlier stage. */
export function insertGlance(stages: DraftStage[], question: QuestionDraft): DraftStage[] {
  const out = stages.map((s) => ({ kind: s.kind, checks: [...s.checks] }));
  const glance = out.find((s) => s.kind === "glance");
  if (glance) { glance.checks.push(question); return out; }
  const at = out.findIndex((s) => s.kind !== "code");
  out.splice(at === -1 ? out.length : at, 0, { kind: "glance", checks: [question] });
  return out;
}

// ── drafting ────────────────────────────────────────────────────────────────

function draftQuestion(event: MissEvent, checkId: string, artifactPath: string | null, artifactKind: string): { question: QuestionDraft; needs_wording: boolean; producer_note?: string } {
  const text = event.type === "false-pass" ? event.complaint : (event.note ?? "");
  const said = squash(text).slice(0, 200);
  const thin = contentWords(text).length < MIN_CONTENT_WORDS;
  let claim: string, instructions: string, falseCase: string, trueCase: string;
  if (event.type === "false-pass") {
    claim = thin ? "<EDIT: what is true of the output when the reported defect is absent>" : `The output is free of the defect the principal reported: ${said}`;
    instructions = thin
      ? `<EDIT: the yes/no question the missed defect answers>. The principal rejected this output saying: ${q(said)}.`
      : `The principal rejected an earlier output that passed every check, saying: ${q(said)}. Is this output free of that defect? Answer false if it is present.`;
    trueCase = "the reported defect is absent";
    falseCase = thin ? "<EDIT: the defect>" : said.slice(0, 120);
  } else {
    const why = thin ? "<EDIT: the quality that made the principal prefer the pick>" : said;
    claim = `The candidate has the quality the principal preferred over the tournament winner: ${why}`;
    instructions = `For "${squash(event.question).slice(0, 160)}", the principal overruled the tournament winner and picked another candidate because: ${q(why)}. Does this candidate have that quality?`;
    trueCase = "has the quality the principal chose for";
    falseCase = "lacks it, as the overruled winner did";
  }
  const producer = artifactPath ? `cat ${quoteArg(artifactPath)}` : "cat <EDIT: path to the artifact under check>";
  const producer_note = !artifactPath
    ? "No artifact path was recorded; set the producer before compiling."
    : TEXT_KINDS.has(artifactKind) ? undefined
    : `A ${artifactKind} artifact: \`cat\` hands raw bytes to the question, so replace the producer with a frame or description source, or move this check to a vision eval, before compiling.`;
  return { question: { id: checkId, kind: "noul", claim, instructions, criteria: { true: trueCase, false: falseCase }, producer, caller: DRAFT_CALLER }, needs_wording: thin, ...(producer_note ? { producer_note } : {}) };
}

function defaultRead(path: string): string | null {
  try { return existsSync(path) ? readFileSync(path, "utf8") : null; } catch { return null; }
}

/** Draft the eval revision for one miss. Pure apart from reading the ISA; never writes anything. */
export function draftEval(event: MissEvent, deps: DraftDeps = {}): EvalDraft {
  const read = deps.readFile ?? defaultRead;
  const text = event.type === "false-pass" ? event.complaint : `${event.question}\n${event.winner}\n${event.pick}\n${event.note ?? ""}`;
  const checkId = checkIdFor(event.type, text);
  const receiptId = event.receipt_id ?? null;
  const fingerprint = receiptId ?? `ov:${sha1(`${event.type === "overrule" ? `${event.question}|${event.winner}|${event.pick}` : ""}`).slice(0, 16)}`;
  const key = `${fingerprint}:${checkId}`;

  let isa: string | null = null;
  let criteria: string[] | undefined;
  let artifactPath: string | null = null;
  let artifactKind = "text";
  if (event.type === "false-pass") {
    const ref = event.receipt.ideal_state;
    if (ref?.kind === "isa" && ref.path) { isa = ref.path; criteria = ref.criteria; }
    artifactPath = event.receipt.artifact ?? null;
    artifactKind = event.receipt.kind ?? (artifactPath ? kindOfPath(artifactPath) : "text");
  } else {
    isa = event.isa ?? null;
    criteria = event.criterion ? [event.criterion] : undefined;
    artifactPath = event.pick;
    artifactKind = kindOfPath(event.pick);
  }

  const isaText = isa ? read(isa) : null;
  const titles = isaText ? criterionTitles(isaText) : new Map<string, string>();
  const criterion = pickCriterion(criteria, titles, event.type === "false-pass" ? event.complaint : event.note ?? "");
  const { question, needs_wording, producer_note } = draftQuestion(event, checkId, artifactPath, artifactKind);

  const existing = criterion && isaText ? parseEvalsText(isaText, isa ?? undefined).evals.get(criterion) : undefined;
  const isc = criterion ?? UNASSIGNED_ISC;
  const title = criterion ? (titles.get(criterion) ?? "") : `${event.type === "false-pass" ? "false pass" : "overrule"} on ${artifactKind}`;
  const stages = existing ? insertGlance(stagesOf(existing), question) : [{ kind: "glance" as const, checks: [question] }];
  const block = renderBlock(isc, title, stages);

  let validated = false;
  let validation_error: string | undefined;
  try {
    const parsed = parseEvalsText(`## Evals\n\n${block}\n`, isa && isaText ? isa : undefined);
    if (parsed.errors.length) validation_error = parsed.errors.map((e) => e.reason).join("; ");
    else if (!parsed.evals.has(isc)) validation_error = "the draft parsed to no eval";
    else validated = true;
  } catch (e) { validation_error = (e as Error).message; }

  return {
    key, check_id: checkId, event: event.type, receipt_id: receiptId, artifact_kind: artifactKind, isa, criterion, block,
    revises_existing: !!existing, validated, ...(validation_error ? { validation_error } : {}), needs_wording, ...(producer_note ? { producer_note } : {}),
  };
}

// ── filing ──────────────────────────────────────────────────────────────────

export interface FileDeps {
  addUpgrade?: (input: UpgradeInput) => { created: boolean; id: string; reason?: string };
  listUpgrades?: (filter: { source: string }) => { evidence?: string[] }[];
}
export type FileResult = { status: "filed"; id: string } | { status: "duplicate"; id?: string } | { status: "refused"; reason: string };

export const evidenceToken = (key: string) => `fpd:${key}`;

/** File one Upgrades item for a draft, unless one already carries its key. The item is a recommendation; nothing lands without the principal's yes. */
export function fileDraft(draft: EvalDraft, event: MissEvent, deps: FileDeps = {}): FileResult {
  invariant(draft.key.length > 0 && draft.key.includes(":"), "a draft key is <receipt or fingerprint>:<check id>");
  invariant(draft.receipt_id === null || HEX64.test(draft.receipt_id), "a draft's receipt id is a 64-hex receipt id or null");
  invariant(draft.block.startsWith("### "), "a draft block opens with its ### heading");
  const add = deps.addUpgrade ?? addUpgradeReal;
  const list = deps.listUpgrades ?? ((f) => listUpgradesReal(f));
  const token = evidenceToken(draft.key);
  if (list({ source: DRAFT_SOURCE }).some((r) => (r.evidence ?? []).includes(token))) return { status: "duplicate" };

  const where = draft.isa ? `${draft.isa}${draft.criterion ? ` ${draft.criterion}` : " (criterion unknown)"}` : "no ISA recorded";
  const what = event.type === "false-pass"
    ? `A passing receipt (${draft.receipt_id!.slice(0, 12)}) let a ${draft.artifact_kind} output through and the principal rejected it (${event.rejection_id}): ${squash(event.complaint).slice(0, 300)}`
    : `The principal overruled the tournament winner ${event.winner} and picked ${event.pick} for "${squash(event.question).slice(0, 160)}"${event.note ? `: ${squash(event.note).slice(0, 300)}` : " (no reason given)"}.`;
  const skill = event.type === "false-pass" ? (event.skill ?? NO_SKILL) : NO_SKILL;
  const caveats = [
    draft.validated ? "The draft parses under the ISA Evals parser." : `The draft does NOT parse yet: ${draft.validation_error}. Fix it before pasting.`,
    ...(draft.needs_wording ? ["The complaint was too thin to word the question; fill each <EDIT: …>."] : []),
    ...(draft.producer_note ? [draft.producer_note] : []),
    ...(draft.criterion ? [] : [`No criterion was identified; replace ${UNASSIGNED_ISC} with the criterion this check measures.`]),
  ];
  const recommendation = [
    `Recommendation only: nothing lands without the principal's yes. On yes, ${draft.revises_existing ? `replace the \`### ${draft.criterion}\` block` : "add this block"} in the ISA's \`## Evals\` section (${where}), and point the criterion's Test Strategy row at \`eval:#${draft.criterion ?? UNASSIGNED_ISC}\` with type \`eval\` if it is not already.`,
    "",
    draft.block,
    "",
    ...caveats.map((c) => `- ${c}`),
    ...(event.type === "false-pass" ? ["", `Without an ISA, the same miss can become a standing check for the skill: ${suggestMissCommand(skill, draft.artifact_kind, event.complaint)}`] : []),
  ].join("\n");

  const evidence = [token, ...(draft.receipt_id ? [draft.receipt_id] : []), ...(event.type === "false-pass" && event.output_id ? [event.output_id] : []), ...(event.rejection_id ? [event.rejection_id] : []), ...(draft.isa ? [draft.isa] : [])];
  invariant(evidence[0] === token, "the dedupe token is the first evidence entry");
  const res = add({
    claim: `${event.type === "false-pass" ? "False pass" : "Tournament overrule"} ${draft.key}: add check ${draft.check_id} to ${draft.criterion ?? "the eval"}${draft.isa ? ` in ${draft.isa.split("/").slice(-2).join("/")}` : ""} so this miss fails next time.`,
    source: DRAFT_SOURCE,
    current_state: what,
    recommendation,
    target_surface: draft.isa ? "isa" : "skill",
    confidence: event.type === "false-pass" ? 0.6 : 0.5,
    evidence,
  });
  if (res.created) return { status: "filed", id: res.id };
  if (res.reason === "duplicate") return { status: "duplicate", id: res.id };
  return { status: "refused", reason: res.reason ?? "unknown" };
}

// ── joins: erratum (capture path), labels (scan), overrule ──────────────────

export interface JoinDeps extends DraftDeps, FileDeps {
  outputs?: () => OutputLine[];
  receipt?: (id: string) => ReceiptForDraft | null;
}

export function readReceiptForDraft(id: string, dir = receiptDir()): ReceiptForDraft | null {
  if (!HEX64.test(id)) return null;
  try {
    const r = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
    return r && typeof r.sha256 === "string" && typeof r.verdict === "string" ? r : null;
  } catch { return null; }
}

export type DraftOutcome = { drafted: false; reason: string } | { drafted: true; draft: EvalDraft; filed: FileResult };

type ErratumLike = { id: string; kind: string; complaint: string; context?: { output_ids?: string[] | null } | null };

/**
 * The capture-path entry: an erratum that names exactly one delivered output whose receipt passed for those bytes drafts
 * and files one eval revision. Several cited outputs name no false pass (the same rule as OutputJoin.falsePasses). Never
 * throws and makes no model call.
 */
export function draftFalsePassForErratum(e: ErratumLike, deps: JoinDeps = {}): DraftOutcome {
  try {
    if (!COMPLAINT_KINDS.has(e.kind)) return { drafted: false, reason: "not a rejection" };
    const ids = e.context?.output_ids ?? [];
    if (ids.length !== 1) return { drafted: false, reason: ids.length ? "cites several outputs" : "cites no output" };
    const out = (deps.outputs ?? (() => readOutputLines()))().find((o) => o.output_id === ids[0]);
    if (!out) return { drafted: false, reason: "output not in the ledger" };
    if (out.decision === "blocked") return { drafted: false, reason: "a blocked hand-off was never delivered" };
    if (!out.receipt_id) return { drafted: false, reason: "output had no receipt" };
    const receipt = (deps.receipt ?? readReceiptForDraft)(out.receipt_id);
    if (!receipt) return { drafted: false, reason: "receipt unreadable" };
    if (receipt.sha256 !== out.sha256) return { drafted: false, reason: "receipt is for other bytes" };
    if (!passedAtBoundary(receipt)) return { drafted: false, reason: "receipt did not pass" };
    const event: MissEvent = { type: "false-pass", receipt_id: out.receipt_id, receipt, complaint: e.complaint, rejection_id: e.id, output_id: out.output_id, ...(out.skill ? { skill: out.skill } : {}) };
    const draft = draftEval(event, deps);
    return { drafted: true, draft, filed: fileDraft(draft, event, deps) };
  } catch (err) {
    return { drafted: false, reason: `error: ${(err as Error).message}` };
  }
}

/**
 * Principal `artifact` fail labels joined to a passing receipt for the same bytes. Reaction labels are skipped: they come
 * from errata, which the capture path already drafted. A label with no note has no complaint to word a question from and
 * still drafts, marked needs_wording.
 */
export function draftFromLabels(labels: Pick<Label, "id" | "ts" | "source" | "kind" | "verdict" | "receipt_id" | "artifact_sha256" | "note">[], deps: JoinDeps & { since?: string } = {}): DraftOutcome[] {
  const read = deps.receipt ?? readReceiptForDraft;
  const out: DraftOutcome[] = [];
  for (const l of labels) {
    if (l.source !== "principal" || l.kind !== "artifact" || l.verdict !== "fail" || !l.receipt_id) continue;
    if (deps.since && l.ts < deps.since) continue;
    const receipt = read(l.receipt_id);
    if (!receipt || (l.artifact_sha256 && receipt.sha256 !== l.artifact_sha256) || !passedAtBoundary(receipt)) continue;
    const event: MissEvent = { type: "false-pass", receipt_id: l.receipt_id, receipt, complaint: l.note ?? "", rejection_id: `label:${l.id}` };
    const draft = draftEval(event, deps);
    out.push({ drafted: true, draft, filed: fileDraft(draft, event, deps) });
  }
  return out;
}

/** The principal picked a different candidate than the tournament's winner. Picking the winner is no overrule. */
export function draftFromOverrule(o: Omit<Extract<MissEvent, { type: "overrule" }>, "type">, deps: JoinDeps = {}): DraftOutcome {
  invariant(o.question.trim().length > 0 && o.winner.trim().length > 0 && o.pick.trim().length > 0, "an overrule names the question, the winner and the pick");
  if (o.winner === o.pick) return { drafted: false, reason: "the pick is the winner; nothing was overruled" };
  const event: MissEvent = { type: "overrule", ...o };
  const draft = draftEval(event, deps);
  return { drafted: true, draft, filed: fileDraft(draft, event, deps) };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const HELP = `FalsePassDraft — a false pass or principal overrule drafts that criterion's eval revision (ISC-40)

  scan-labels [--since ISO] [--dry-run] [--json]
      principal artifact-fail labels joined to a passing receipt -> one assay-miss Upgrades item each
  overrule --question Q --winner W --pick P [--note N] [--isa PATH] [--criterion ID] [--receipt ID] [--dry-run] [--json]
      the principal picked P over the tournament winner W -> one assay-miss Upgrades item
  help

Every item is a recommendation; nothing lands in an ISA without the principal's yes. No model call.
Exit 0 ok · 1 bad usage.`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const DRY_RUN_ID = "(dry-run)";
const dryDeps = (): FileDeps => ({ addUpgrade: () => ({ created: true, id: DRY_RUN_ID }), listUpgrades: (f) => listUpgradesReal(f) });

function report(outcomes: DraftOutcome[], json: boolean): void {
  if (json) { console.log(JSON.stringify(outcomes, null, 2)); return; }
  if (!outcomes.length) { console.log("no misses to draft"); return; }
  for (const o of outcomes) {
    if (!o.drafted) { console.log(`skipped: ${o.reason}`); continue; }
    const status = "id" in o.filed && o.filed.id === DRY_RUN_ID ? "would file (dry run)" : `${o.filed.status}${"id" in o.filed && o.filed.id ? ` ${o.filed.id}` : ""}`;
    console.log(`${status} · ${o.draft.key} · ${o.draft.criterion ?? UNASSIGNED_ISC} · ${o.draft.validated ? "parses" : `does not parse: ${o.draft.validation_error}`}`);
    console.log(o.draft.block, "\n");
  }
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const json = args.includes("--json");
  const fileDeps = args.includes("--dry-run") ? dryDeps() : {};
  if (cmd === "scan-labels") {
    report(draftFromLabels(readLabels(), { ...fileDeps, since: arg(args, "--since") }), json);
  } else if (cmd === "overrule") {
    const question = arg(args, "--question"), winner = arg(args, "--winner"), pick = arg(args, "--pick");
    if (!question || !winner || !pick) { console.error("overrule needs --question, --winner and --pick\n\n" + HELP); process.exit(1); }
    const receipt = arg(args, "--receipt");
    if (receipt && !HEX64.test(receipt)) { console.error("--receipt is a 64-hex receipt id"); process.exit(1); }
    report([draftFromOverrule({ question, winner, pick, note: arg(args, "--note"), isa: arg(args, "--isa"), criterion: arg(args, "--criterion"), receipt_id: receipt }, fileDeps)], json);
  } else if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(HELP);
  } else {
    console.error(`unknown command: ${cmd}\n\n${HELP}`);
    process.exit(1);
  }
}
