/**
 * Compile — writes one eval per ISA criterion, sized to it, on the top model.
 *
 * eval-compile ISA, F3 stage a (ISC-18, 20, 22, 23, 39). The ISA
 * carries its own evals (ISAFormat § `## Evals`). Compile reads the criteria,
 * anti-criteria and Test Strategy, finds every criterion with no eval (or whose
 * text changed since its eval was compiled), and asks the top model, in one
 * call or a small parallel batch, for the cheapest eval each criterion allows:
 *
 *   literal  → a code check (a one-line bash/bun-test row, or a code stage)
 *   readable → a glance question over existing state, with a bounded producer
 *   holistic → an anchored rubric (an existing suite, else an inline rubric per
 *              dimension); when its output is a file, page or screenshot, the
 *              rubric is followed by a pairwise stage against champion:last-accepted
 *   several kinds of check → one staged block, cheapest stage first
 *   compound → flagged "split this", never crushed into one question
 *
 * Everything the model returns is checked in code before it is shown: the tier
 * guard (a literal criterion must reach a code check, a readable one may not
 * start on a judge), the code-check refusals, and the M1 parser itself
 * (`parseEvalsText`), plus two machine-dependent rules: every path is made
 * relative to where its command runs and a home path is refused (ISC-42), and
 * every judge stage resolves to an existing suite, an inline anchored rubric
 * grading one dimension, or a champion that exists or is a declared slot (ISC-43). A judged eval whose output is
 * capturable carries a pairwise stage against champion:last-accepted after its rubric, never before it, and that slot
 * never stands without a rubric to decide while no champion is recorded (ISC-49, ISC-54; LIFEOS/TOOLS/lib/PairwiseGap.ts,
 * the same rule EvalCensus counts gaps with). Every pairwise candidate is written by an earlier code stage of the same
 * block, a page by one plain call of Interceptor's Capture.sh on a page the eval grades, so a pairwise row is refused (it
 * has no earlier stage) (ISC-57); a recompile keeps every output the criterion's previous eval named, its code gates on
 * each, and its rubric or suite judge (ISC-58); every `skills/...` or `LIFEOS/...` script a command names is one Bunker
 * finds: started where it resolves it from the config root, or present from the probe directory (ISC-59,
 * LIFEOS/TOOLS/lib/ProbeCommand.ts). A criterion whose eval fails
 * is regenerated once with the reasons, then reported. A broken block is never emitted.
 *
 * Compile never writes ISA.md. It prints the proposed text, or with --write puts
 * it in `<ISA dir>/Evals.proposed.md` for the main session to merge. Glance
 * questions name a caller and start in shadow; the registerQuestion calls they
 * need are reported, never made.
 *
 * Incremental (ISC-23): each compiled eval records `criterion_sha`, a hash of its
 * criterion's text, inside the ISA's `## Evals` section. A block carries it as a
 * yaml comment (`# criterion_sha: <hex>`, invisible to the parser, which refuses
 * any key but `stages:`); a one-line row's hash sits on an HTML comment line in
 * the same section. A recompile touches only criteria whose hash moved, whose
 * block is broken, whose compiled eval has a pairwise gap, or that have no eval.
 * A hand-written eval is never recompiled; the census reports its gap.
 *
 * Usage:
 *   bun Compile.ts <ISA.md> [--dry-run] [--json] [--write] [--only ISC-n[,ISC-m]] [--caller <name>] [--batch N]
 *   bun Compile.ts merge <ISA.md> [--dry-run] [--json]   # fold Evals.proposed.md into the ISA (CompileMerge.ts)
 *   bun Compile.ts split <ISA.md> [--dry-run] [--json]   # apply its "Split these" as [container] parents with ISC-N.M children (CompileSplit.ts)
 *
 * A `[container]` criterion with nested children is verified through them and
 * needs no eval of its own: IsaClaims leaves it out, so compile never sends it
 * to the model and never reports it missing (ISC-46).
 * Exit 0 compiled (or nothing to do) · 1 some criteria failed validation · 2 usage or inference unavailable.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inference, type InferenceOptions, type InferenceResult } from "../../../LIFEOS/TOOLS/Inference.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { claimText, isaBody, isaRevision, parseIsaClaimsText, stripBulletPrefix } from "../../../LIFEOS/TOOLS/lib/IsaClaims.ts";
import {
  DEPLOY_CALL_TOOL, MODEL_CALL_TOOL, UNFAILABLE_BUN_E, TIER_RANK, isProbeType, parseEvalsText,
  parseTestStrategyDiagnostic, probeCwdOf, type ProbeTier, type StagedEval,
} from "../../../LIFEOS/TOOLS/lib/IsaTestStrategy.ts";
import { idsWithEval } from "../../../LIFEOS/TOOLS/lib/IsaScope.ts";
import {
  CAPTURE_DIR, CAPTURE_TOOL, againstLastAccepted, capturableOutputs, codeCommands, codeGates, namedOutputs, pairwiseCandidates, pairwiseGaps,
  previousEvalOf, problemReason, problemsOf, recompileProblems, shapeOfStaged, suggestedPairwise, type PairwiseProblem, type PreviousEval,
} from "../../../LIFEOS/TOOLS/lib/PairwiseGap.ts";
import { unresolvedScripts } from "../../../LIFEOS/TOOLS/lib/ProbeCommand.ts";
import { listSuites } from "./SuiteManager.ts";

export type InferenceFn = (o: InferenceOptions) => Promise<InferenceResult>;

/** ISC-39: authoring runs on the top rung. Inference.ts resolves "max" through models.ts and falls back max → high. */
export const COMPILE_LEVEL = "max" as const;
/** The registered glance-row caller (assay-callers.json `bunker-glance`, shadow). */
export const DEFAULT_CALLER = "bunker-glance";
export const PROPOSED_FILE = "Evals.proposed.md";
export const DEFAULT_BATCH = 8;
const SHA_LEN = 12;

export type CriterionClass = "literal" | "readable" | "holistic" | "compound";
/** "gap": compiled and current, but its eval breaks the comparison rule (ISC-49: no pairwise stage against champion:last-accepted after the rubric, or a PairwiseGap problem), so a recompile fixes it. */
export type CriterionState = "missing" | "changed" | "broken" | "gap" | "forced" | "current" | "hand";

export interface Criterion {
  id: string; text: string; anti: boolean; sha: string; state: CriterionState;
  /** state "gap" only: what the current eval breaks (PairwiseGap's problem), told to the model on recompile. */
  pairwise?: { problem: PairwiseProblem; outputs: string[]; detail?: string[] };
  /** A recompile (state changed, broken, gap or forced) of a criterion that has an eval: what that eval named and whether it was judged (ISC-58). */
  previous?: PreviousEval;
}

/** The model's answer for one criterion, before validation. */
export interface ModelEval {
  isc: string;
  class: CriterionClass;
  form: "row" | "block" | "split";
  row?: { type: string; check: string; threshold?: string; tool: string };
  block?: { title?: string; stages: Record<string, unknown>[] };
  split?: string[];
  reason?: string;
}

export interface CompiledEval {
  isc: string;
  class: CriterionClass;
  form: "row" | "block";
  sha: string;
  tier: ProbeTier;
  /** row form: the Test Strategy row. block form: its `eval:#ISC-n` row. */
  row: string;
  /** block form: `### ISC-n · title` plus the fenced yaml, criterion_sha included. */
  block?: string;
  /** row form: the ledger comment that carries its hash in `## Evals`. */
  ledger?: string;
  questions: { caller: string; id: string }[];
  suites: string[];
  /** Inline anchored rubrics this eval carries, as `rubric:#<ISC>/<id>`. Provisional until each one's calibration earns. */
  rubrics: string[];
}

export interface Registration { caller: string; id: string; call: string; mode: "shadow"; callerRegistered: boolean | null }

/** ISC-21: the shared check libraries an ISA inherits, compiled in code with no model call. */
export interface InheritedResult {
  /** The libraries in force and how each was chosen. */
  libraries: { name: string; source: "declared" | "inferred" }[];
  /** Library checks this compile emits (missing, changed or broken in the ISA). */
  compiled: CompiledEval[];
  /** Library check ids already present and current in the ISA. */
  current: string[];
  /** Checks the ISA switched off, each with its reason. */
  disabled: { id: string; reason: string }[];
  /** Checks that cannot be bound yet: a placeholder's frontmatter value is missing or unsafe. */
  unbound: { id: string; missing: string[] }[];
  /** Problems that stop inheritance being trusted: an unknown library, a disable with no reason, a broken library check. */
  errors: string[];
}

export interface CompileResult {
  isa: string;
  revision: string;
  criteria: { id: string; state: CriterionState; sha: string }[];
  inherited: InheritedResult;
  compiled: CompiledEval[];
  split: { isc: string; parts: string[]; reason: string }[];
  failed: { isc: string; reasons: string[] }[];
  registrations: Registration[];
  calls: number;
  latencyMs: number;
  proposed: string;
}

// ── criterion text and hashes ───────────────────────────────────────────────

/** The hash of a criterion's meaning: whitespace-normalized text, checkbox state ignored. */
export function criterionSha(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, SHA_LEN);
}

const BLOCK_SHA_RE = /^\s*#\s*criterion_sha:\s*([0-9a-f]{6,64})\s*$/m;
const LEDGER_RE = /^<!--\s*criterion_sha\s+([A-Za-z][\w.-]*)\s+([0-9a-f]{6,64})\s*(?:\(row\))?\s*-->\s*$/;

/** Every recorded criterion_sha in the ISA's `## Evals` section: block comments and row ledger lines. */
export function recordedShas(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split("\n");
  let inSection = false;
  let fence: string | null = null;
  let heading: string | null = null;
  let body: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (fence) {
      if (line === fence) {
        fence = null;
        const m = BLOCK_SHA_RE.exec(body.join("\n"));
        if (inSection && heading && m) out.set(heading, m[1]!);
      } else body.push(raw);
      continue;
    }
    const open = /^(`{3,}|~{3,})/.exec(line);
    if (open) { fence = open[1]!; body = []; continue; }
    if (/^##\s/.test(line)) { inSection = /^##\s+Evals\s*$/i.test(line); heading = null; continue; }
    if (!inSection) continue;
    const h = /^###\s+([A-Za-z][\w.-]*?)(?:\s*$|\s+[·—–:-])/.exec(line);
    if (h) { heading = h[1]!; continue; }
    const l = LEDGER_RE.exec(line);
    if (l) out.set(l[1]!, l[2]!);
  }
  return out;
}

const TOMBSTONE = /\[DROPPED\b/;

/** Every criterion and anti-criterion with its compile state. Read-only. */
export function planCriteria(isaPath: string, text: string, only: ReadonlySet<string> = new Set()): Criterion[] {
  const { claims } = parseIsaClaimsText(text, { path: isaPath });
  const ts = parseTestStrategyDiagnostic(isaPath);
  const evals = parseEvalsText(text, isaPath);
  // A manual-only or invalid-only criterion has no eval, so it compiles (state "missing");
  // the same predicate is EvalCensus --without-eval's, so compile's work list is the probe's.
  const covered = idsWithEval(ts.probes, evals.evals.keys());
  const broken = new Set(evals.errors.map((e) => /^([A-Za-z][\w.-]*):/.exec(e.reason)?.[1]).filter((x): x is string => !!x));
  const shas = recordedShas(text);
  // ISC-49: a compiled eval with a pairwise problem (most often a rubric over a captured output, no comparison after it) is recompiled.
  const gaps = new Map(pairwiseGaps(isaPath, text, ts).map((g) => [g.isc, { problem: g.problem, outputs: g.outputs, ...(g.detail ? { detail: g.detail } : {}) }] as const));
  const bodyLines = isaBody(text).split(/\r?\n/);
  const out: Criterion[] = [];
  for (const c of claims) {
    const raw = bodyLines[c.line - 1] ?? "";
    const body = (raw.trim().startsWith("|") ? raw.split("|").slice(2).join(" ").trim() : claimText(stripBulletPrefix(raw))?.body ?? raw).trim();
    if (TOMBSTONE.test(body)) continue;
    const sha = criterionSha(body);
    const recorded = shas.get(c.id);
    let state: CriterionState;
    if (only.has(c.id)) state = "forced";
    else if (broken.has(c.id)) state = "broken";
    else if (recorded !== undefined) state = recorded !== sha ? "changed" : gaps.has(c.id) ? "gap" : "current";
    else state = covered.has(c.id) ? "hand" : "missing";
    const pairwise = state === "gap" ? gaps.get(c.id) : undefined;
    // ISC-58: a recompile is held to what the criterion's eval already names and how it judges (block plus other rows).
    const previous = state === "missing" || state === "current" || state === "hand" ? null
      : previousEvalOf(evals.evals.get(c.id), ts.probes.filter((p) => p.isc === c.id));
    out.push({ id: c.id, text: body, anti: c.anti, sha, state, ...(pairwise ? { pairwise } : {}), ...(previous ? { previous } : {}) });
  }
  return out;
}

export const NEEDS_COMPILE: ReadonlySet<CriterionState> = new Set(["missing", "changed", "broken", "gap", "forced"]);

// ── the prompt ──────────────────────────────────────────────────────────────

const CLAUDE_DIR = resolve(import.meta.dir, "../../..");

/** A markdown section by its heading line prefix, up to the next heading of the same or higher level. */
export function sectionOf(markdown: string, headingPrefix: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.startsWith(headingPrefix));
  if (start < 0) return "";
  const level = /^#+/.exec(lines[start]!)![0].length;
  let end = lines.length;
  let fence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*(`{3,}|~{3,})/.test(lines[i]!)) fence = !fence;
    if (fence) continue;
    const m = /^(#+)\s/.exec(lines[i]!);
    if (m && m[1]!.length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

/** Reference text handed to the model: ISAFormat's Evals contract and row types, QuestionDesign's engine facts. Read live so the model always sees the current contract. */
export function referenceText(claudeDir: string = CLAUDE_DIR): string {
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const fmt = read(join(claudeDir, "LIFEOS/DOCUMENTATION/ISA/ISAFormat.md"));
  const qd = read(join(claudeDir, "skills/Assay/References/QuestionDesign.md"));
  const parts = [
    sectionOf(fmt, "### `## Evals`"),
    sectionOf(fmt, "### ISC Type Vocabulary"),
    ...["## What the engine is", "## Does the judgment layer fit", "## Deterministic first", "## Choosing the primitive", "## Writing a question", "## Designing the state"].map((h) => sectionOf(qd, h)),
  ].filter(Boolean);
  invariant(parts.length >= 2, "compile reference missing: ISAFormat.md § Evals and QuestionDesign.md must both be readable");
  return parts.join("\n\n---\n\n");
}

export const SYSTEM_PROMPT = `You write the evals for an ISA's criteria. Each criterion gets exactly one eval, sized to it, at the cheapest tier the criterion allows. Output JSON only.

Classify each criterion:
- "literal": a command can decide it (a file exists, a test passes, a string is present, a count is under N, an HTTP status). Its eval is code: a one-line row (type bash, bun-test or curl) when one command suffices, else a block whose first stage is code.
- "readable": a person would decide it by reading state that already exists (a rendered page, a built payload, a config, a diff) and a typed question can carry it. Its eval is a block with a glance stage (noul, score with every level anchored, or choice), each question carrying a bounded read-only producer that prints that state. Put any code check that can gate it in an earlier code stage.
- "holistic": it will not split into typed questions (taste, overall quality). Its eval is a block whose judge stage is an anchored rubric. Rubric: name an existing suite ("eval": "suite:<name>", only a suite listed as existing) when one fits; otherwise write the rubric inline ("eval": [{rubric map}], rules below). Never invent a suite name. Gate it with code or glance stages when any part is checkable more cheaply.
- Side by side: when a holistic criterion's output is a file, a page (URL) or a screenshot, the rubric stage is followed by a pairwise stage that compares the new output with the last one the principal accepted: {"pairwise": "bun skills/Assay/Tools/Tournament.ts --candidates champion:last-accepted,<candidate> --question \\"...\\" --json"}. The candidate is this run's output, so an earlier code stage of the same block writes it and the candidate names exactly the path that stage writes: for a page (a URL), capture it with the sanctioned browser tool as its own plain command on the same URL the rubric grades, {"code": ["bash ${CAPTURE_TOOL} <url> --out ${CAPTURE_DIR}/<isc>.png"]} (nothing chained to it, never --current or --allow-unchecked; never curl, wget, Playwright or another screenshot tool, and no script of its own, for a page image); for a file the block builds, its build command writing the path (--out <path>, -o <path> or > <path>). A file already on disk that no earlier stage writes (an old screenshot, a checked-in image) is never the candidate: test -s names a file without writing it, and cat, cp, echo or >> only copy old bytes. A side-by-side check is always a block stage, never a row. Keep any code check that gates the page (a curl status or content check) beside the capture: the capture does not replace it. The champion comes first and is always the slot champion:last-accepted (Bunker fills it at run time); a fixed file is not the last accepted output. The pairwise stage always comes after the rubric, never before it: the rubric decides while no champion is recorded, so a pairwise stage against the slot never stands without a rubric. The question asks which output better meets the criterion. A holistic criterion with no file, page or screenshot output keeps its rubric alone.

Inline rubric (an "eval" item that is a map instead of "suite:<name>"):
- Keys: "id" (letters, digits, . _ -; unique in the block), "dimension", "rubric" (the judge's question), "anchors", "subject", optional "scale" (2..10) and "threshold" (0..1]. No other keys.
- One dimension per rubric. "dimension" names a single quality on one line, never two joined by "and". When the quality has several dimensions (calm and premium), write one rubric per dimension, each with its own id, in one eval stage's list.
- "anchors" is a map keyed "1".."scale", every level present and described concretely: what an output at that level looks like.
- "subject" prints the output to grade: one read-only command under the glance producer rules, run from the ISA's folder (cat ./out/hero.txt).
- "compound": it states two or more independent things. Do not write an eval; return form "split" with the separate criteria it should become.

Rules:
- Stages run cheapest first: code, then glance, then eval/pairwise, then manual. Never put a cheaper stage after a costlier one.
- Code checks are real commands that can fail: no deploys, no model calls, no bare words, no bun -e that cannot exit non-zero. Run tests with a ./ prefix (bun test ./path). Prefer rg, test, jq, curl -fsS.
- A glance producer is one read-only command from: cat, curl (GET only), bun (a script inside the ISA directory or under LIFEOS/TOOLS), rg, jq, git, head, tail, ls. No pipes, redirects, $ or ;. Never read secrets or LIFEOS/USER.
- "manual" only when no automatic check exists today; say why in reason.
- Use paths and commands the ISA itself names. Do not invent files the ISA gives no hint of.
- Every path is relative to where its command runs (code checks, rows and pairwise from the probe directory named below; glance producers from the ISA's folder), written ./like/this. Never an absolute path, and never a path under the home directory.
- Never include labels, cases, results, receipts, verdicts or history.

Return {"evals":[...]} with one entry per requested criterion:
{"isc":"ISC-n","class":"literal|readable|holistic|compound","form":"row|block|split","reason":"one line",
 "row":{"type":"bash|bun-test|curl|eval|pairwise|manual","check":"what it checks","threshold":"exit 0","tool":"the command"},
 "block":{"title":"short title","stages":[{"code":["cmd"]},{"glance":[{"id":"kebab-id","kind":"noul","instructions":"...","criteria":{"true":"...","false":"..."},"producer":"cat path"}]},{"eval":"suite:name"}]},
 a side-by-side block on a built file: {"code":["bun ./scripts/hero.ts --out ./out/hero.txt"]}, then an inline rubric stage: {"eval":[{"id":"calm","dimension":"calm","rubric":"How calm does the hero copy read?","scale":3,"anchors":{"1":"loud, salesy","2":"calm but generic","3":"calm, specific, quietly confident"},"subject":"cat ./out/hero.txt"}]},
 and the pairwise stage after it: {"pairwise":"bun skills/Assay/Tools/Tournament.ts --candidates champion:last-accepted,./out/hero.txt --question \\"Which hero copy reads calmer?\\" --json"},
 on a page: {"code":["bash ${CAPTURE_TOOL} https://example.com/ --out ${CAPTURE_DIR}/ISC-7.png"]}, the rubric stage, then {"pairwise":"bun skills/Assay/Tools/Tournament.ts --candidates champion:last-accepted,${CAPTURE_DIR}/ISC-7.png --question \\"Which page looks calmer?\\" --json"},
 "split":["first criterion","second criterion"]}
Give "row" for form row, "block" for form block, "split" for form split. Score questions give "criteria" as an ordered array, one anchor per level. Choice questions give "options" as a map of option to meaning.`;

export interface PromptEnv { probeLabel: string; suites: string[] }

export function userPrompt(isaPath: string, isaText: string, targets: Criterion[], retry?: Map<string, string[]>, env: PromptEnv = { probeLabel: "the ISA's folder", suites: [] }): string {
  const body = isaText.length > 40_000 ? `${isaText.slice(0, 40_000)}\n…(truncated)` : isaText;
  const list = targets.map((c) => {
    const why = retry?.get(c.id);
    const gap = c.state !== "gap" ? ""
      : c.pairwise && c.pairwise.problem !== "gap" ? `\n  Its current eval breaks the side-by-side rule: ${problemReason(c.pairwise.problem, c.pairwise.outputs, c.pairwise.detail, c.id)}. Write it again with the rubric, then the pairwise stage against champion:last-accepted.`
      : "\n  Its current eval grades a captured output with its rubric and no pairwise stage after it; write it again with the rubric, then the pairwise stage against champion:last-accepted.";
    // ISC-58: say up front what the recompile must keep, so the first answer does not escape the rule.
    const p = c.previous;
    const keep = p ? [
      ...(p.outputs.length ? [`keeps naming ${p.outputs.join(", ")}`] : []),
      ...(p.gates.length ? [`keeps its code checks (${p.gates.map((g) => `\`${g}\``).join("; ")}) in a code stage; a capture does not replace them`] : []),
      ...(p.judged ? ["keeps a rubric or suite stage (then the pairwise stage on a fresh capture), never a glance question or code check alone"] : []),
    ] : [];
    const prev = keep.length ? `\n  This is a recompile of an existing eval: the new eval ${keep.join("; ")}.` : "";
    return `- ${c.id}${c.anti ? " (anti-criterion: the eval passes when the bad thing is absent)" : ""}: ${c.text}${gap}${prev}${why ? `\n  Your last eval for this was refused: ${why.join("; ")}. Fix it.` : ""}`;
  }).join("\n");
  const where = `Code checks, rows and pairwise commands run from ${env.probeLabel}; glance producers run from the ISA's folder. Write every path relative to where it runs (./out/page.html), never absolute.`;
  const suites = env.suites.length
    ? `Existing eval suites (an eval stage may name only these): ${[...env.suites].sort().join(", ")}. When none fits a criterion, write an inline rubric per dimension instead.`
    : "No eval suites exist yet: judge a holistic criterion with an inline rubric per dimension, followed by a pairwise stage against the champion when its output is a file, page or screenshot.";
  return `ISA file: ${basename(isaPath)}\n${where}\n${suites}\n\nWrite one eval for each of these criteria:\n${list}\n\nThe whole ISA, for context (paths, commands, existing rows):\n\n${body}`;
}

// ── yaml emission ───────────────────────────────────────────────────────────

const PLAIN_KEY = /^[A-Za-z_][\w-]*$/;
const scalar = (s: string) => JSON.stringify(s);
function emit(value: unknown, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const inner = emit(item, indent + 2);
      if (typeof item === "object" && item !== null) return [`${pad}- ${inner[0]!.trimStart()}`, ...inner.slice(1)];
      return [`${pad}- ${inner[0]!.trim()}`];
    });
  }
  if (value && typeof value === "object") {
    // An undefined field is absent, as in JSON: emitting it would write the word "undefined".
    return Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).flatMap(([k, v]) => {
      const key = PLAIN_KEY.test(k) ? k : scalar(k);
      if (v === null) return [`${pad}${key}: null`];
      if (typeof v === "object") return [`${pad}${key}:`, ...emit(v, indent + 2)];
      return [`${pad}${key}: ${typeof v === "string" ? scalar(v) : String(v)}`];
    });
  }
  return [`${pad}${typeof value === "string" ? scalar(value) : String(value)}`];
}

/** The fenced block text for one criterion, criterion_sha first. Throws when the emitted yaml does not round-trip. */
export function blockText(isc: string, title: string, sha: string, stages: Record<string, unknown>[]): string {
  const yaml = [`# criterion_sha: ${sha}`, "stages:", ...emit(stages, 2)].join("\n");
  const back = Bun.YAML.parse(yaml) as { stages?: unknown };
  invariant(JSON.stringify(back?.stages) === JSON.stringify(stages), `${isc}: emitted yaml does not round-trip`);
  const heading = title ? `### ${isc} · ${title.replace(/\s+/g, " ").trim()}` : `### ${isc}`;
  return `${heading}\n\n\`\`\`yaml\n${yaml}\n\`\`\``;
}

const cell = (s: string) => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
export function rowText(isc: string, type: string, check: string, threshold: string, tool: string): string {
  const t = tool.startsWith("eval:#") ? tool : `\`${cell(tool)}\``;
  return `| ${isc} | ${type} | ${cell(check)} | ${cell(threshold)} | ${t} |`;
}

// ── portable paths (ISC-42) ─────────────────────────────────────────────────
// ISAs ship in repos and some go public, so an emitted eval never carries an
// absolute home path: it leaks the user's name and breaks when the ISA moves.
// Code checks, rows and pairwise commands run from the probe directory (the
// ISA's folder, or the config root under `probe_cwd: config-root`); glance
// producers always run from the ISA's folder (Bunker glance.ts). An absolute
// path inside the directory its command runs from is rewritten to `./<rel>`.
// A home path anywhere else is refused, so the model regenerates it.

export interface PathContext {
  /** Where code checks, rows and pairwise commands run. */
  probeCwd: string;
  /** Where glance producers run: always the ISA's folder. */
  isaDir: string;
  /** The real home directory; any path under it, or under /Users/<x> or /home/<x>, is a home path. */
  home: string;
  /** How the prompt and the reasons name the probe directory. */
  probeLabel: string;
}

export function pathContext(isaPath: string, opts: { configRoot?: string; home?: string } = {}): PathContext {
  const isaDir = dirname(resolve(isaPath));
  const probeCwd = opts.configRoot ? probeCwdOf(isaPath, opts.configRoot) : probeCwdOf(isaPath);
  return { probeCwd, isaDir, home: resolve(opts.home ?? homedir()), probeLabel: probeCwd === isaDir ? "the ISA's folder" : "the config root (probe_cwd: config-root)" };
}

/** An absolute path token: a slash not glued to a word, a dot, a tilde, a `$`, a `}`, a slash or a colon (so URLs, `./x` and `${VAR}/x` never match). */
const ABS_PATH = /(?<![\w.~$/:@}-])\/[^\s"'`;|&()<>,]+/g;
const GENERIC_HOME = /^\/(?:Users|home)\/[^/]+/;

function isHomePath(p: string, home: string): boolean {
  return p === home || p.startsWith(`${home}/`) || GENERIC_HOME.test(p);
}

/** A home path with the home part masked, safe to print in reasons and the proposal. */
function maskHome(p: string, home: string): string {
  if (p === home || p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  return p.replace(GENERIC_HOME, "~");
}

/** `./<rel>` when `p` sits inside `root` (lexically or through its realpath), else null. */
function relativeInside(p: string, root: string): string | null {
  const roots = [resolve(root)];
  try { const real = realpathSync(root); if (!roots.includes(real)) roots.push(real); } catch { /* root not on disk: lexical only */ }
  for (const r of roots) {
    const rel = relative(r, resolve(p));
    if (rel === "") return ".";
    if (!rel.startsWith("..") && !isAbsolute(rel)) return `./${rel}`;
  }
  return null;
}

export interface PortableResult<T> { value: T; rewrites: { from: string; to: string }[]; problems: string[] }

/**
 * ISC-42, the one rule: every string in an emitted eval is made portable. An absolute path inside
 * the directory its command runs from becomes `./<rel>`; a home path outside it is a problem. Paths
 * outside home (/dev/null, /tmp) are left alone. `root` picks the directory per field: glance
 * producers resolve from the ISA's folder, everything else from the probe directory.
 */
export function portablePaths<T>(value: T, ctx: PathContext, root: "probe" | "isa" = "probe"): PortableResult<T> {
  const rewrites: PortableResult<T>["rewrites"] = [];
  const problems: string[] = [];
  const fix = (s: string, base: string, label: string): string => s.replace(ABS_PATH, (raw) => {
    const trail = /[.:]+$/.exec(raw)?.[0] ?? "";
    const tok = trail ? raw.slice(0, -trail.length) : raw;
    const rel = relativeInside(tok, base);
    if (rel !== null) { rewrites.push({ from: maskHome(tok, ctx.home), to: rel }); return rel + trail; }
    if (isHomePath(tok, ctx.home)) problems.push(`"${maskHome(tok, ctx.home)}" is an absolute home path outside ${label}; write it relative to ${label}`);
    return raw;
  });
  const walk = (x: unknown, where: "probe" | "isa"): unknown => {
    const base = where === "isa" ? ctx.isaDir : ctx.probeCwd;
    const label = where === "isa" ? "the ISA's folder (glance producers run there)" : ctx.probeLabel;
    if (typeof x === "string") return fix(x, base, label);
    if (Array.isArray(x)) return x.map((v) => walk(v, where));
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.entries(x).map(([k, v]) => {
        // Glance producers and inline rubric subjects run from the ISA's folder; every other string keeps its stage's base.
        const next = k === "glance" || k === "eval" ? "isa" : where;
        return [k, walk(v, next)];
      }));
    }
    return x;
  };
  return { value: walk(value, root) as T, rewrites, problems: [...new Set(problems)] };
}

// ── judges that resolve (ISC-43) ────────────────────────────────────────────
// A judge stage compile emits always resolves: an `eval` item names a suite
// that exists (SuiteManager's inventory, whose `name:` matches the file name
// EvalRunner looks up) or carries an inline anchored rubric grading one
// dimension, and a `pairwise` stage's first candidate, the champion, is a path
// that exists from the probe directory or a declared champion slot.

/**
 * Champion slots a pairwise stage may name in place of a path. `champion:last-accepted` is the last output the
 * principal accepted: Bunker's champion.ts (CHAMPION_SLOT) fills it at run time and reports skip, never pass, when none
 * is recorded, so Tournament.ts never judges the slot's literal text. Compile.test.ts pins this to Bunker's constant.
 */
export const CHAMPION_SLOTS: ReadonlySet<string> = new Set<string>(["champion:last-accepted"]);

export interface JudgeContext { suites: () => ReadonlySet<string>; probeCwd: string; probeLabel: string }

/** Every v2 suite EvalRunner can find by name: the inventory's `name:` must equal its file name. */
export function knownSuites(): Set<string> {
  return new Set(listSuites().filter((s) => basename(s.path, extname(s.path)) === s.name).map((s) => s.name));
}

const SUITE_OF = /^(?:suite:\s*)?([A-Za-z0-9._-]+)$/;
const CANDIDATES = /--candidates(?:=|\s+)(["']?)([^\s"']+)\1/;

function suiteProblem(name: string, ctx: JudgeContext): string | null {
  const known = ctx.suites();
  if (known.has(name)) return null;
  const list = known.size ? [...known].sort().join(", ") : "none";
  return `suite "${name}" does not exist (known suites: ${list}); name an existing suite, or judge it pairwise against the champion`;
}

function championProblem(cmd: string, ctx: JudgeContext): string | null {
  const m = CANDIDATES.exec(cmd);
  if (!m) return "a pairwise check names its candidates: --candidates <champion>,<candidate>";
  const parts = m[2]!.split(",").filter(Boolean);
  if (parts.length < 2) return "a pairwise check compares at least two candidates, the champion first";
  const champion = parts[0]!;
  if (CHAMPION_SLOTS.has(champion)) return null;
  if (existsSync(resolve(ctx.probeCwd, champion))) return null;
  return `champion "${champion}" does not exist from ${ctx.probeLabel}; name an existing champion file${CHAMPION_SLOTS.size ? ` or the slot ${[...CHAMPION_SLOTS].join(", ")}` : ""}`;
}

/** A dimension that joins two qualities ("calm and premium", "tone; pacing") is two rubrics, not one. */
const JOINED_DIMENSION = /\s(?:and|&|plus|\+)\s|;/i;

/**
 * Compile's own rules for an inline rubric, beyond the M1 parser's shape check: it grades exactly one dimension, and no
 * two rubrics in a block grade the same one. Read-only.
 */
function rubricProblem(item: Record<string, unknown>, seen: Set<string>): string | null {
  const dim = typeof item.dimension === "string" ? item.dimension.replace(/\s+/g, " ").trim() : "";
  const id = typeof item.id === "string" ? item.id : "?";
  if (!dim) return null; // a missing dimension is the parser's to refuse
  if (JOINED_DIMENSION.test(dim)) return `inline rubric "${id}" grades "${dim}", more than one dimension; write one rubric per dimension`;
  const key = dim.toLowerCase();
  if (seen.has(key)) return `two inline rubrics grade the same dimension "${dim}"; one rubric per dimension`;
  seen.add(key);
  return null;
}

/** Reasons any judge stage in these stages would not resolve. Read-only. */
export function judgeProblems(stages: unknown[], ctx: JudgeContext): string[] {
  const out: string[] = [];
  const dimensions = new Set<string>();
  for (const s of stages) {
    if (!s || typeof s !== "object" || Array.isArray(s)) continue;
    for (const [k, v] of Object.entries(s)) {
      const items = Array.isArray(v) ? v : [v];
      for (const item of items) {
        if (k === "eval" && item && typeof item === "object" && !Array.isArray(item)) {
          const p = rubricProblem(item as Record<string, unknown>, dimensions);
          if (p) out.push(p);
          continue;
        }
        if (typeof item !== "string") continue;
        if (k === "eval") {
          const name = SUITE_OF.exec(item.trim())?.[1];
          const p = name ? suiteProblem(name, ctx) : null; // a malformed suite ref is the parser's to refuse
          if (p) out.push(p);
        } else if (k === "pairwise" || k === "tournament") {
          const p = championProblem(item, ctx);
          if (p) out.push(p);
        }
      }
    }
  }
  return out;
}

// ── validation ──────────────────────────────────────────────────────────────

const ROW_TYPES = new Set(["bash", "bun-test", "curl", "eval", "pairwise", "manual"]);
const CODE_ROW = new Set(["bash", "bun-test", "curl"]);
const STAGE_TIER: Record<string, ProbeTier> = { code: "code", glance: "glance", eval: "judge", pairwise: "judge", tournament: "judge", manual: "human" };
const ID_SAFE = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function codeProblem(cmd: string): string | null {
  if (DEPLOY_CALL_TOOL(cmd)) return "a code check deploys";
  if (UNFAILABLE_BUN_E(cmd)) return "an unfailable bun -e";
  if (MODEL_CALL_TOOL(cmd)) return "a code check starts a model";
  if (/^[A-Za-z][A-Za-z0-9_.+-]*$/.test(cmd.trim())) return `a bare word ("${cmd.trim()}")`;
  if (/^bun\s+test\s+(?!\.\/|\/)/.test(cmd.trim())) return "bun test needs a ./ prefixed path";
  return null;
}

/** Namespaced, registry-safe question id: `<isa slug>-<isc>-<model id>`. */
export function questionId(slug: string, isc: string, id: string): string {
  return [ID_SAFE(slug).slice(0, 32), ID_SAFE(isc), ID_SAFE(id).slice(0, 40)].filter(Boolean).join("-");
}

/** Check one model eval and turn it into emitted text. Returns reasons when it cannot be used. */
export interface ValidateOptions {
  isaPath: string; slug: string; caller: string; paths: PathContext; judges: JudgeContext;
  /** The config root a leading `skills/...` or `LIFEOS/...` script resolves against at run time (ISC-59); default the LifeOS config dir. */
  configRoot?: string;
}

/**
 * ISC-59: every LifeOS script a command names is found when Bunker runs it (lib/ProbeCommand.ts): one it starts
 * resolves from the probe directory or the config root; one in any other position (an argument, inside quotes, after a
 * `cd`) is never rewritten, so it exists from the probe directory. Anything else would fail to start in every run.
 */
function scriptProblem(cmd: string, opts: ValidateOptions): string | null {
  const missing = unresolvedScripts(cmd, opts.paths.probeCwd, opts.configRoot ?? CLAUDE_DIR);
  if (!missing.length) return null;
  return missing.map((u) => u.why === "nowhere"
    ? `"${u.rel}" exists neither from ${opts.paths.probeLabel} nor under the config root; name a LifeOS tool by its path under the config root (skills/... or LIFEOS/...)`
    : `"${u.rel}" is not where the command starts it, so Bunker cannot find it from ${opts.paths.probeLabel}; start the command with it (bun skills/... or bash skills/..., no cd before it)`).join("; ");
}

export function validateEval(mIn: ModelEval, c: Criterion, opts: ValidateOptions): { ok: CompiledEval } | { split: { isc: string; parts: string[]; reason: string } } | { reasons: string[] } {
  const reasons: string[] = [];
  // ISC-42: one rule makes every path portable before anything else reads it. Rewrites stand;
  // a home path it cannot make relative is refused, so the criterion is regenerated, then reported.
  const portable = portablePaths({ row: mIn.row, block: mIn.block }, opts.paths);
  if (portable.problems.length) return { reasons: portable.problems };
  const m: ModelEval = { ...mIn, ...(mIn.row ? { row: portable.value.row } : {}), ...(mIn.block ? { block: portable.value.block } : {}) };
  if (!["literal", "readable", "holistic", "compound"].includes(m.class)) return { reasons: [`unknown class "${m.class}"`] };
  if (m.class === "compound" || m.form === "split") {
    if (m.class !== "compound" || m.form !== "split") return { reasons: ["a compound criterion is split, and only a compound one"] };
    const parts = (m.split ?? []).filter((s) => typeof s === "string" && s.trim());
    if (parts.length < 2) return { reasons: ["split this: give at least two separate criteria"] };
    return { split: { isc: c.id, parts, reason: m.reason ?? "compound criterion" } };
  }
  if (m.form === "row") {
    const r = m.row;
    if (!r || typeof r.tool !== "string" || !r.tool.trim()) return { reasons: ["form row needs row.tool"] };
    if (!isProbeType(r.type) || !ROW_TYPES.has(r.type)) return { reasons: [`row type "${r.type}" is not one of ${[...ROW_TYPES].join(", ")}; a glance question lives in a block`] };
    if (CODE_ROW.has(r.type)) { const p = codeProblem(r.tool); if (p) reasons.push(p); }
    if (CODE_ROW.has(r.type) || r.type === "pairwise") { const p = scriptProblem(r.tool, opts); if (p) reasons.push(p); }
    // ISC-58: a recompiled row keeps what the previous eval named and its judge.
    reasons.push(...recompileProblems(c.previous, {
      outputs: capturableOutputs([r.type === "pairwise" ? pairwiseCandidates(r.tool).slice(1).join(" ") : r.tool]),
      judged: r.type === "eval",
      gates: CODE_ROW.has(r.type) ? codeGates([r.tool]) : [],
    }));
    if (r.type === "bun-test" && !/^bun\s+test\b/.test(r.tool.trim())) reasons.push("a bun-test row runs bun test");
    // ISC-43: a judged row resolves like a judged stage.
    if (r.type === "eval") {
      const named = [...r.tool.matchAll(/-s\s+([A-Za-z0-9._-]+)/g)].map((x) => x[1]!);
      const sugar = SUITE_OF.exec(r.tool.trim())?.[1];
      reasons.push(...judgeProblems([...named, ...(sugar ? [sugar] : [])].map((n) => ({ eval: n })), opts.judges));
    }
    if (r.type === "pairwise") reasons.push(...judgeProblems([{ pairwise: r.tool }], opts.judges));
    // ISC-49: a row holds one check, so a judged row whose output is capturable cannot carry its pairwise stage,
    // and (ISC-54) a pairwise row against the last-accepted slot has no rubric to decide while no champion is recorded.
    if (r.type === "eval") {
      const outputs = capturableOutputs([r.tool]);
      if (outputs.length) reasons.push(`a judged eval whose output is captured (${outputs[0]}) is a block: its rubric stage, then ${suggestedPairwise(outputs, c.id)}`);
    }
    if (r.type === "pairwise" && againstLastAccepted(r.tool)) {
      const outputs = capturableOutputs([pairwiseCandidates(r.tool).slice(1).join(" ")]);
      reasons.push(`${problemReason("no-rubric", outputs)}, so this is a block: its rubric stage, then ${suggestedPairwise(outputs, c.id)}`);
    }
    // ISC-57: a row has no earlier stage, so its candidates are files already on disk, whatever its champion (ISC-43).
    if (r.type === "pairwise") {
      const files = pairwiseCandidates(r.tool).slice(1).filter((x) => !/^champion:/.test(x));
      if (files.length) reasons.push(`${problemReason("stale", capturableOutputs([files.join(" ")]), files, c.id)}; a row has no earlier stage, so a side-by-side check is a block`);
    }
    const tier: ProbeTier = CODE_ROW.has(r.type) ? "code" : r.type === "manual" ? "human" : "judge";
    if (m.class === "literal" && tier !== "code") reasons.push("a literal criterion's eval reaches a code check");
    if (m.class === "readable" && tier === "judge") reasons.push("a readable criterion starts on a glance question, never a judge");
    if (reasons.length) return { reasons };
    const suites = r.type === "eval" ? [...r.tool.matchAll(/-s\s+(\S+)/g)].map((x) => x[1]!) : [];
    return { ok: { isc: c.id, class: m.class, form: "row", sha: c.sha, tier, row: rowText(c.id, r.type, r.check || c.text, r.threshold || "exit 0", r.tool), ledger: `<!-- criterion_sha ${c.id} ${c.sha} (row) -->`, questions: [], suites, rubrics: [] } };
  }
  if (m.form !== "block" || !m.block || !Array.isArray(m.block.stages) || !m.block.stages.length) return { reasons: ["form block needs block.stages"] };
  // Questions: namespace the id, force the caller. A question names a caller and starts in shadow (ISC-22).
  const questions: { caller: string; id: string }[] = [];
  const stages = m.block.stages.map((s) => {
    if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).length !== 1) return s;
    const [k, v] = Object.entries(s)[0]!;
    if (k === "glance") {
      const items = (Array.isArray(v) ? v : [v]).map((q) => {
        if (!q || typeof q !== "object") return q;
        const { caller: _c, claim: _cl, ...rest } = q as Record<string, unknown>;
        const id = questionId(opts.slug, c.id, String(rest.id ?? "q"));
        questions.push({ caller: opts.caller, id });
        return { ...rest, id, caller: opts.caller };
      });
      return { glance: items };
    }
    if (k === "eval") return { eval: Array.isArray(v) ? v.map(anchorsAsMap) : anchorsAsMap(v) };
    return s;
  });
  const tiers = stages.map((s) => STAGE_TIER[Object.keys(s ?? {})[0] ?? ""]).filter((t): t is ProbeTier => !!t);
  if (m.class === "literal" && !tiers.includes("code")) reasons.push("a literal criterion's eval reaches a code check");
  if (m.class === "readable" && (tiers.length === 0 || TIER_RANK[tiers[0]!] > TIER_RANK.glance)) reasons.push("a readable criterion starts on code or a glance question, never a judge");
  if (m.class === "readable" && !tiers.includes("glance")) reasons.push("a readable criterion carries a glance question");
  if (m.class === "holistic" && !tiers.includes("judge")) reasons.push("a holistic criterion carries a rubric or a pairwise stage");
  reasons.push(...judgeProblems(stages, opts.judges));
  for (const s of stages) {
    const rec = (s ?? {}) as Record<string, unknown>;
    const code = rec.code;
    for (const cmd of Array.isArray(code) ? code : code !== undefined ? [code] : []) {
      if (typeof cmd === "string") {
        const p = codeProblem(cmd); if (p) reasons.push(`code check "${cmd}": ${p}`);
        const q = scriptProblem(cmd, opts); if (q) reasons.push(`code check "${cmd}": ${q}`);
      }
    }
    const pairwise = rec.pairwise ?? rec.tournament;
    for (const cmd of Array.isArray(pairwise) ? pairwise : pairwise !== undefined ? [pairwise] : []) {
      if (typeof cmd === "string") { const q = scriptProblem(cmd, opts); if (q) reasons.push(`pairwise check: ${q}`); }
    }
  }
  if (reasons.length) return { reasons };
  let block: string;
  try { block = blockText(c.id, m.block.title ?? "", c.sha, stages as Record<string, unknown>[]); }
  catch (e) { return { reasons: [(e as Error).message] }; }
  // The M1 parser is the judge of a block: anything it drops never ships.
  const parsed = parseEvalsText(`## Evals\n\n${block}\n`, opts.isaPath);
  if (parsed.errors.length) return { reasons: parsed.errors.map((e) => e.reason) };
  const staged = parsed.evals.get(c.id) as StagedEval;
  // ISC-49: a rubric over a capturable output is followed by a pairwise stage against the last accepted output;
  // ISC-54: a pairwise stage against that slot always has a rubric before it; ISC-57: every candidate is written by an
  // earlier code stage of this block, a page by the sanctioned capture. A suite reads the criterion's text when the
  // block names no output, so a suite stage alone never hides the page the criterion is about.
  const shape = shapeOfStaged(staged, [c.text]);
  for (const problem of problemsOf(shape)) {
    reasons.push(problemReason(problem, shape.outputs, problem === "stale" ? shape.stale : problem === "capture" ? shape.badCapture : [], c.id));
  }
  // ISC-58: a recompile keeps every output the previous eval named, and its rubric or suite judge.
  reasons.push(...recompileProblems(c.previous, {
    outputs: namedOutputs(staged),
    judged: staged.stages.some((st) => st.checks.some((ch) => ch.kind === "eval")),
    gates: codeGates(codeCommands(staged)),
  }));
  if (reasons.length) return { reasons };
  return { ok: { isc: c.id, class: m.class, form: "block", sha: c.sha, tier: staged.tier, row: rowText(c.id, "eval", m.block.title || c.text, "pass", `eval:#${c.id}`), block, questions, ...judgesOf(staged) } };
}

/**
 * Score questions carry their anchors as an ordered array, so a model may hand an inline rubric the same shape. An
 * array becomes the map the parser requires, level 1 first; anything else passes through for the parser to judge.
 */
function anchorsAsMap(item: unknown): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const rec = item as Record<string, unknown>;
  if (!Array.isArray(rec.anchors)) return item;
  return { ...rec, anchors: Object.fromEntries(rec.anchors.map((a, i) => [String(i + 1), a])) };
}

/** The suites and inline rubrics a parsed staged eval judges with, read from the parser's own checks. */
function judgesOf(staged: StagedEval): { suites: string[]; rubrics: string[] } {
  const checks = staged.stages.flatMap((st) => st.checks).filter((ch) => ch.kind === "eval");
  return {
    suites: checks.filter((ch) => !ch.rubric).map((ch) => ch.tool.replace(/^suite:/, "")),
    rubrics: checks.filter((ch) => ch.rubric).map((ch) => ch.tool),
  };
}

// ── shared check libraries (ISC-21) ─────────────────────────────────────────
// A library holds the checks every output of one type needs (video, image,
// blog-post, code-change, web-app), each already in the ISA Evals stage format
// and tied to a reason. The ISA declares `output: <library>[, <library>]` in
// frontmatter, or Compile infers it from `artifact:`'s extension or a
// frontmatter key the library names. Each check compiles in code, with no model
// call, into an inherited eval `### <library>.<check>` plus its `eval:#` row.
// The ISA switches one off with a line in its `## Evals` section:
// `disable: <library>.<check> because <reason>`; a disable with no reason is
// refused and the check stays on.

export const LIBRARY_DIR = resolve(import.meta.dir, "../Libraries");
const LIB_NAME = /^[a-z][a-z0-9-]*$/;
/** `{{name}}`: doubled braces, so curl`s `%{http_code}` and shell `${VAR}` never read as one. */
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g;
/** A bound value is spliced into shell commands and glance producers unquoted, so it must be one safe word. */
const SAFE_BINDING = /^[A-Za-z0-9._/:@%+=,~-]+$/;

export interface LibraryCheck { id: string; title: string; reason: string; stages: Record<string, unknown>[] }
export interface Library {
  name: string;
  version: number;
  bindings: Record<string, string>;
  match: { extensions?: string[]; frontmatter?: string[] };
  checks: LibraryCheck[];
}

/** Every placeholder name used anywhere in a value. */
function placeholdersIn(x: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof x === "string") for (const m of x.matchAll(PLACEHOLDER)) out.add(m[1]!);
  else if (Array.isArray(x)) for (const v of x) placeholdersIn(v, out);
  else if (x && typeof x === "object") for (const v of Object.values(x)) placeholdersIn(v, out);
  return out;
}

/** Load and shape-check one library. Throws with the reason a library cannot be used. Read-only. */
export function loadLibrary(name: string, dir: string = LIBRARY_DIR): Library {
  if (!LIB_NAME.test(name)) throw new Error(`library name "${name}" is not kebab-case`);
  const path = join(dir, `${name}.yaml`);
  if (!existsSync(path)) throw new Error(`no library "${name}" (looked for ${path})`);
  let doc: Record<string, unknown>;
  try { doc = Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
  catch (e) { throw new Error(`library ${name}: yaml does not parse: ${(e as Error).message}`); }
  if (!doc || typeof doc !== "object") throw new Error(`library ${name}: not a map`);
  if (doc.library !== name) throw new Error(`library ${name}: \`library:\` says ${JSON.stringify(doc.library)}; it must match the file name`);
  const bindings = (doc.bindings ?? {}) as Record<string, string>;
  if (typeof bindings !== "object" || Array.isArray(bindings)) throw new Error(`library ${name}: \`bindings:\` is a map of name to meaning`);
  const match = (doc.match ?? {}) as Library["match"];
  if (!Array.isArray(doc.checks) || !doc.checks.length) throw new Error(`library ${name}: \`checks:\` must be a non-empty list`);
  const seen = new Set<string>();
  const checks = doc.checks.map((raw, i): LibraryCheck => {
    const c = raw as Partial<LibraryCheck>;
    const where = `library ${name} check ${c?.id ?? i + 1}`;
    if (typeof c?.id !== "string" || !LIB_NAME.test(c.id)) throw new Error(`${where}: id must be kebab-case`);
    if (seen.has(c.id)) throw new Error(`${where}: duplicate id`);
    seen.add(c.id);
    if (typeof c.reason !== "string" || c.reason.trim().length < 20) throw new Error(`${where}: every check is tied to a reason`);
    if (!Array.isArray(c.stages) || !c.stages.length) throw new Error(`${where}: stages must be a non-empty list`);
    const undeclared = [...placeholdersIn(c.stages)].filter((p) => !Object.hasOwn(bindings, p));
    if (undeclared.length) throw new Error(`${where}: placeholder(s) ${undeclared.map((p) => `{{${p}}}`).join(", ")} not declared in \`bindings:\``);
    return { id: c.id, title: typeof c.title === "string" ? c.title : c.id, reason: c.reason.replace(/\s+/g, " ").trim(), stages: c.stages as Record<string, unknown>[] };
  });
  return { name, version: typeof doc.version === "number" ? doc.version : 1, bindings, match, checks };
}

/** Every library file's name, sorted. */
export function libraryNames(dir: string = LIBRARY_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)).filter((n) => LIB_NAME.test(n)).sort();
}

/** The ISA's frontmatter as a map; empty when it has none or it does not parse. */
export function frontmatterOf(text: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return {};
  try { const d = Bun.YAML.parse(m[1]!); return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {}; }
  catch { return {}; }
}

/** Which libraries apply: declared `output:` wins; otherwise each library's `match` rules infer it. */
export function selectLibraries(fm: Record<string, unknown>, dir: string = LIBRARY_DIR): { libraries: InheritedResult["libraries"]; errors: string[] } {
  const declared = fm.output;
  if (declared !== undefined && declared !== null && declared !== "") {
    const names = (Array.isArray(declared) ? declared : String(declared).split(",")).map((s) => String(s).trim()).filter(Boolean);
    const known = new Set(libraryNames(dir));
    const errors = names.filter((n) => !known.has(n)).map((n) => `output: ${n} names no library (known: ${[...known].join(", ")})`);
    return { libraries: [...new Set(names)].filter((n) => known.has(n)).map((name) => ({ name, source: "declared" as const })), errors };
  }
  const artifact = typeof fm.artifact === "string" ? fm.artifact : "";
  const ext = /\.([A-Za-z0-9]+)$/.exec(artifact)?.[1]?.toLowerCase();
  const out: InheritedResult["libraries"] = [];
  const errors: string[] = [];
  for (const name of libraryNames(dir)) {
    let lib: Library;
    try { lib = loadLibrary(name, dir); } catch (e) { errors.push((e as Error).message); continue; }
    const byExt = !!ext && (lib.match.extensions ?? []).map((x) => x.toLowerCase()).includes(ext);
    const byKey = (lib.match.frontmatter ?? []).some((k) => fm[k] !== undefined && fm[k] !== null && fm[k] !== "");
    if (byExt || byKey) out.push({ name, source: "inferred" });
  }
  return { libraries: out, errors };
}

const DISABLE_RE = /^disable:\s*([A-Za-z][\w.-]*)(?:\s+because\s+(\S.*))?\s*$/i;

/** `disable:` lines in the ISA's `## Evals` section (outside fences), each with its reason or null. */
export function disablesOf(text: string): { id: string; reason: string | null }[] {
  const out: { id: string; reason: string | null }[] = [];
  let inSection = false;
  let fence: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (fence) { if (line === fence) fence = null; continue; }
    const open = /^(`{3,}|~{3,})/.exec(line);
    if (open) { fence = open[1]!; continue; }
    if (/^##\s/.test(line)) { inSection = /^##\s+Evals\s*$/i.test(line); continue; }
    if (!inSection) continue;
    const m = DISABLE_RE.exec(line);
    if (m) out.push({ id: m[1]!, reason: m[2]?.trim() || null });
  }
  return out;
}

function bindValue(x: unknown, values: Record<string, string>): unknown {
  if (typeof x === "string") return x.replace(PLACEHOLDER, (whole, k: string) => values[k] ?? whole);
  if (Array.isArray(x)) return x.map((v) => bindValue(v, values));
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, bindValue(v, values)]));
  return x;
}

/** The hash of a library check's definition: a library edit recompiles exactly the checks it touched. */
export function librarySha(lib: string, check: LibraryCheck): string {
  return criterionSha(JSON.stringify({ lib, id: check.id, reason: check.reason, stages: check.stages }));
}

/**
 * ISC-21: the library checks this ISA inherits, compiled in code. Never calls a model. Each check
 * becomes a staged eval that the M1 parser must accept with zero errors, or it is reported in errors.
 */
export function compileInherited(isaPath: string, text: string, opts: { caller: string; dir?: string; paths?: PathContext; judges?: JudgeContext }): InheritedResult {
  const dir = opts.dir ?? LIBRARY_DIR;
  const paths = opts.paths ?? pathContext(isaPath);
  const judges = opts.judges ?? { suites: lazySuites(), probeCwd: paths.probeCwd, probeLabel: paths.probeLabel };
  const fm = frontmatterOf(text);
  const sel = selectLibraries(fm, dir);
  const res: InheritedResult = { libraries: sel.libraries, compiled: [], current: [], disabled: [], unbound: [], errors: [...sel.errors] };
  if (!sel.libraries.length) return res;
  const libs: Library[] = [];
  for (const l of sel.libraries) {
    try { libs.push(loadLibrary(l.name, dir)); } catch (e) { res.errors.push((e as Error).message); }
  }
  const fullIds = new Map<string, string>(); // full id → full id, bare id → full id (when unique)
  const bareCount = new Map<string, number>();
  for (const lib of libs) for (const c of lib.checks) { fullIds.set(`${lib.name}.${c.id}`, `${lib.name}.${c.id}`); bareCount.set(c.id, (bareCount.get(c.id) ?? 0) + 1); }
  for (const lib of libs) for (const c of lib.checks) if (bareCount.get(c.id) === 1) fullIds.set(c.id, `${lib.name}.${c.id}`);
  const disabled = new Map<string, string>();
  for (const d of disablesOf(text)) {
    const id = fullIds.get(d.id);
    if (!id) { res.errors.push(`disable: ${d.id} names no inherited check${bareCount.get(d.id)! > 1 ? " uniquely; qualify it as <library>.<check>" : ""}`); continue; }
    if (!d.reason) { res.errors.push(`disable: ${d.id} gives no reason ("disable: ${id} because <reason>"); the check stays on`); continue; }
    disabled.set(id, d.reason);
  }
  const shas = recordedShas(text);
  const parsed = parseEvalsText(text, isaPath);
  const broken = new Set(parsed.errors.map((e) => /^([A-Za-z][\w.-]*):/.exec(e.reason)?.[1]).filter((x): x is string => !!x));
  for (const lib of libs) {
    const values: Record<string, string> = {};
    const unsafe = new Set<string>();
    for (const k of Object.keys(lib.bindings)) {
      const v = fm[k];
      if (typeof v === "string" && SAFE_BINDING.test(v)) values[k] = v;
      else if (v !== undefined) unsafe.add(k);
    }
    for (const check of lib.checks) {
      const id = `${lib.name}.${check.id}`;
      const reason = disabled.get(id);
      if (reason !== undefined) { res.disabled.push({ id, reason }); continue; }
      const sha = librarySha(lib.name, check);
      if (shas.get(id) === sha && !broken.has(id) && parsed.evals.has(id)) { res.current.push(id); continue; }
      const missing = [...placeholdersIn(check.stages)].filter((p) => values[p] === undefined).map((p) => (unsafe.has(p) ? `${p} (unsafe characters; one word of [A-Za-z0-9._/:@%+=,~-])` : p));
      if (missing.length) { res.unbound.push({ id, missing }); continue; }
      // ISC-42/43: a frontmatter binding can carry a home path (artifact: /Users/...), and a library can carry a judge stage; the same rules apply.
      const bound = portablePaths(bindValue(check.stages, values) as Record<string, unknown>[], paths);
      const problems = [...bound.problems, ...judgeProblems(bound.value, judges)];
      if (problems.length) { res.errors.push(...problems.map((p) => `${id}: ${p}`)); continue; }
      const questions: { caller: string; id: string }[] = [];
      const stages = bound.value.map((s) => {
        if (!s || typeof s !== "object" || Object.keys(s)[0] !== "glance") return s;
        const v = (s as { glance: unknown }).glance;
        // Library questions keep one id across every ISA, so labels from every output of the type gather on one question (Design: volume earns).
        const items = (Array.isArray(v) ? v : [v]).map((q) => {
          const rec = q as Record<string, unknown>;
          const qid = ["lib", lib.name, check.id, ID_SAFE(String(rec.id ?? "q"))].join("-");
          questions.push({ caller: opts.caller, id: qid });
          return { ...rec, id: qid, caller: opts.caller };
        });
        return { glance: items };
      });
      let block: string;
      try { block = blockText(id, check.title, sha, stages); }
      catch (e) { res.errors.push(`${id}: ${(e as Error).message}`); continue; }
      const back = parseEvalsText(`## Evals\n\n${block}\n`, isaPath);
      if (back.errors.length) { res.errors.push(...back.errors.map((e) => `library check ${e.reason}`)); continue; }
      const staged = back.evals.get(id) as StagedEval;
      res.compiled.push({ isc: id, class: "literal", form: "block", sha, tier: staged.tier, row: rowText(id, "eval", check.title, "pass", `eval:#${id}`), block, questions, ...judgesOf(staged) });
    }
  }
  return res;
}

// ── compile ─────────────────────────────────────────────────────────────────

/** The suite inventory, read on first use only: most compiles never emit an eval stage. */
function lazySuites(names?: string[]): () => ReadonlySet<string> {
  let known: ReadonlySet<string> | null = names ? new Set(names) : null;
  return () => (known ??= knownSuites());
}

function evalsOf(r: InferenceResult): ModelEval[] {
  const parsed = (r.parsed ?? (() => { try { return JSON.parse(r.output.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return null; } })()) as { evals?: unknown } | null;
  return Array.isArray(parsed?.evals) ? (parsed!.evals as ModelEval[]) : [];
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Read-only registry lookup: is the caller registered? null when the registry cannot be read. */
export function callerRegistered(caller: string, callersPath?: string): boolean | null {
  const path = callersPath ?? process.env.LIFEOS_GLANCE_CALLERS ?? join(CLAUDE_DIR, "LIFEOS/USER/CONFIG/assay-callers.json");
  try { return Object.hasOwn(JSON.parse(readFileSync(path, "utf8")), caller); } catch { return null; }
}

export interface CompileOptions {
  infer?: InferenceFn;
  only?: string[];
  caller?: string;
  batch?: number;
  dryRun?: boolean;
  callersPath?: string;
  reference?: string;
  /** Where the shared check libraries live (tests point this at fixtures). */
  libraryDir?: string;
  /** The suites an eval stage may name; default SuiteManager's inventory (tests inject names). */
  suites?: string[];
  /** The config root `probe_cwd: config-root` resolves to; default the LifeOS config dir. */
  configRoot?: string;
  /** The home directory whose paths never ship; default os.homedir(). */
  home?: string;
}

export async function compile(isaPathIn: string, opts: CompileOptions = {}): Promise<CompileResult> {
  const isaPath = resolve(isaPathIn);
  const text = readFileSync(isaPath, "utf8");
  const caller = opts.caller ?? DEFAULT_CALLER;
  const slug = basename(dirname(isaPath));
  const only = new Set(opts.only ?? []);
  const paths = pathContext(isaPath, { configRoot: opts.configRoot, home: opts.home });
  const judges: JudgeContext = { suites: lazySuites(opts.suites), probeCwd: paths.probeCwd, probeLabel: paths.probeLabel };
  const criteria = planCriteria(isaPath, text, only);
  const containers = new Set(parseIsaClaimsText(text, { path: isaPath, includeParents: true }).claims.filter((c) => c.container).map((c) => c.id));
  const asContainer = [...only].filter((id) => containers.has(id));
  invariant(asContainer.length === 0, `--only names containers, which are verified through their children and get no eval: ${asContainer.join(", ")}`);
  const unknown = [...only].filter((id) => !criteria.some((c) => c.id === id));
  invariant(unknown.length === 0, `--only names criteria not in the ISA: ${unknown.join(", ")}`);
  // --only narrows the run to the named criteria and recompiles them whatever their state.
  const targets = criteria.filter((c) => (only.size ? only.has(c.id) : NEEDS_COMPILE.has(c.state)));
  const result: CompileResult = {
    isa: isaPath, revision: isaRevision(text).slice(0, SHA_LEN),
    criteria: criteria.map(({ id, state, sha }) => ({ id, state, sha })),
    // ISC-21: library checks compile in code before any model call, so they never wait on one.
    inherited: compileInherited(isaPath, text, { caller, dir: opts.libraryDir, paths, judges }),
    compiled: [], split: [], failed: [], registrations: [], calls: 0, latencyMs: 0, proposed: "",
  };
  const finish = (): CompileResult => {
    const registered = callerRegistered(caller, opts.callersPath);
    result.registrations = [...result.compiled, ...result.inherited.compiled].flatMap((e) => e.questions).map((q) => ({
      caller: q.caller, id: q.id, call: `registerQuestion(${JSON.stringify(q.caller)}, ${JSON.stringify(q.id)})`, mode: "shadow" as const, callerRegistered: registered,
    }));
    result.proposed = proposedText(result);
    return result;
  };
  // A dry run never calls the model; inherited checks cost no call, so it still shows them.
  if (opts.dryRun || targets.length === 0) return finish();
  const infer = opts.infer ?? inference;
  const system = `${SYSTEM_PROMPT}\n\n# Reference (current contract, read live)\n\n${opts.reference ?? referenceText()}`;
  const started = Date.now();

  const round = async (batch: Criterion[], retry?: Map<string, string[]>): Promise<Map<string, string[]>> => {
    const failures = new Map<string, string[]>();
    const answers = await Promise.all(chunks(batch, Math.max(1, opts.batch ?? DEFAULT_BATCH)).map(async (group) => {
      result.calls++;
      const r = await infer({ systemPrompt: system, userPrompt: userPrompt(isaPath, text, group, retry, { probeLabel: paths.probeLabel, suites: [...judges.suites()] }), level: COMPILE_LEVEL, expectJson: true });
      if (!r.success) throw new Error(`inference unavailable: ${r.error ?? "no answer"}`);
      return { group, evals: evalsOf(r) };
    }));
    for (const { group, evals } of answers) {
      for (const c of group) {
        const mine = evals.filter((e) => e?.isc === c.id);
        if (mine.length !== 1) { failures.set(c.id, [mine.length ? "more than one eval returned; one eval per criterion" : "no eval returned"]); continue; }
        const v = validateEval(mine[0]!, c, { isaPath, slug, caller, paths, judges, configRoot: opts.configRoot });
        if ("ok" in v) result.compiled.push(v.ok);
        else if ("split" in v) result.split.push(v.split);
        else failures.set(c.id, v.reasons);
      }
    }
    return failures;
  };

  const first = await round(targets);
  if (first.size) {
    const again = await round(targets.filter((c) => first.has(c.id)), first);
    for (const [isc, reasons] of again) result.failed.push({ isc, reasons });
  }
  result.latencyMs = Date.now() - started;
  const order = new Map(criteria.map((c, i) => [c.id, i]));
  result.compiled.sort((a, b) => order.get(a.isc)! - order.get(b.isc)!);
  return finish();
}

/** The text the main session merges: rows for Test Strategy, blocks and ledger lines for `## Evals`. */
export function proposedText(r: CompileResult): string {
  const out: string[] = [`<!-- assay compile · ${basename(r.isa)} · isa revision ${r.revision} · ${new Date().toISOString().slice(0, 10)} -->`, "", "# Proposed evals", ""];
  const inh = r.inherited;
  const all = [...r.compiled, ...inh.compiled];
  if (inh.libraries.length) out.push(`Libraries: ${inh.libraries.map((l) => `${l.name} (${l.source})`).join(", ")}`, "");
  if (!all.length && !r.split.length && !r.failed.length && !inh.unbound.length && !inh.errors.length) {
    const todo = r.criteria.filter((c) => NEEDS_COMPILE.has(c.state)).map((c) => `${c.id} (${c.state})`);
    out.push(todo.length ? `Would compile: ${todo.join(", ")}` : "Nothing to compile: every criterion has an eval and none changed.");
    if (inh.disabled.length) out.push("", ...inh.disabled.map((d) => `- disabled ${d.id}: ${d.reason}`));
    return out.join("\n") + "\n";
  }
  if (all.length) {
    out.push("## Test Strategy rows", "", "Add or replace by ISC id. Rows named <library>.<check> are inherited from a shared check library.", "", "| isc | type | check | threshold | tool |", "|---|---|---|---|---|", ...all.map((e) => e.row), "");
    out.push("## Evals", "", "Add or replace each block by its heading, and each ledger line by its ISC id.", "");
    for (const e of all) out.push(e.form === "block" ? e.block! : e.ledger!, "");
  }
  if (inh.unbound.length) {
    out.push("## Inherited checks waiting on a binding", "", "Set these frontmatter keys to bind them; until then they do not run.", "");
    for (const u of inh.unbound) out.push(`- ${u.id}: needs ${u.missing.join(", ")}`);
    out.push("");
  }
  if (inh.disabled.length) {
    out.push("## Inherited checks switched off", "");
    for (const d of inh.disabled) out.push(`- ${d.id}: ${d.reason}`);
    out.push("");
  }
  if (inh.errors.length) {
    out.push("## Library problems", "");
    for (const e of inh.errors) out.push(`- ${e}`);
    out.push("");
  }
  const rubrics = all.flatMap((e) => e.rubrics);
  if (rubrics.length) {
    out.push("## Inline rubrics (provisional until calibrated)", "", "Each grades one dimension. Its verdict stays provisional, never blocking, until its calibration check (calibration:rubric:<isa key>:<ISC>/<id>) earns on the principal's labels.", "");
    for (const ref of rubrics) out.push(`- ${ref}`);
    out.push("");
  }
  if (r.registrations.length) {
    out.push("## Glance registrations (shadow)", "", "Not made by compile. Each starts in shadow (Assay.ts registerQuestion writes mode shadow).", "");
    for (const g of r.registrations) out.push(`- ${g.call}${g.callerRegistered === false ? ` (caller ${g.caller} is not registered yet)` : ""}`);
    out.push("");
  }
  if (r.split.length) {
    out.push("## Split these", "");
    for (const s of r.split) out.push(`- ${s.isc}: ${s.reason}`, ...s.parts.map((p) => `  - ${p}`));
    out.push("");
  }
  if (r.failed.length) {
    out.push("## Not compiled (refused twice)", "");
    for (const f of r.failed) out.push(`- ${f.isc}: ${f.reasons.join("; ")}`);
    out.push("");
  }
  return out.join("\n");
}

// ── the remnant (ISC-45) ─────────────────────────────────────────────────────

/** Marks a proposal whose rows and blocks are already in the ISA; what is left in it was never applied. */
export const REMNANT_MARK = "merged:";

/** Whether a proposal text is a remnant: its header says its rows and blocks were merged. */
export function isRemnant(text: string): boolean {
  return new RegExp(`isa revision [0-9a-f]{6,64}\\b.*\\b${REMNANT_MARK}`).test(text.split("\n", 1)[0] ?? "");
}

/** Remnant sections a fresh compile never regenerates (they belong to evals already merged): carried line by line. */
const CARRY_BY_LINE = new Set(["Glance registrations (shadow)", "Inline rubrics (provisional until calibrated)"]);
/** Remnant sections keyed by criterion id: carried only for criteria the fresh run did not take up and that still lack an eval. */
const CARRY_BY_ID = new Set(["Split these", "Not compiled (refused twice)"]);
const ITEM_ID = /^-\s+([A-Za-z][\w.-]*):/;

interface Section { name: string; start: number; end: number }

/** `## ` sections of a proposal, outside fences: heading line at `start`, body to `end` (exclusive). */
function proposalSections(lines: readonly string[]): Section[] {
  const out: Section[] = [];
  let fence: string | null = null;
  lines.forEach((l, i) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(l);
    if (fence) { if (m && l.trim().startsWith(fence)) fence = null; return; }
    if (m) { fence = m[1]!; return; }
    if (/^##\s/.test(l)) { if (out.length) out[out.length - 1]!.end = i; out.push({ name: l.replace(/^##\s+/, "").trim(), start: i, end: lines.length }); }
  });
  return out;
}

/** A section body as preamble lines and `- ` items (each with its indented lines). Blank lines are dropped. */
function sectionItems(body: readonly string[]): { preamble: string[]; items: string[][] } {
  const preamble: string[] = [];
  const items: string[][] = [];
  for (const l of body) {
    if (!l.trim()) continue;
    if (/^-\s/.test(l)) items.push([l]);
    else if (/^\s/.test(l) && items.length) items[items.length - 1]!.push(l);
    else preamble.push(l);
  }
  return { preamble, items };
}

/**
 * The fresh proposal plus the unapplied items of the remnant it would replace,
 * so a recompile never drops what merge or split left behind (ISC-45). A
 * non-remnant previous proposal is superseded whole, as before. `open` is the
 * set of criteria that still need an eval; a split or refusal entry for any
 * other criterion is stale and dropped.
 */
export function carryForward(fresh: string, previous: string, open: ReadonlySet<string>): string {
  if (!isRemnant(previous)) return fresh;
  const out = fresh.split("\n");
  const prev = previous.split("\n");
  const freshSections = proposalSections(out);
  // Criteria the fresh run took up: rows, blocks, ledger lines, splits and refusals.
  const taken = new Set<string>();
  for (const sec of freshSections) {
    for (const l of out.slice(sec.start + 1, sec.end)) {
      const id = sec.name === "Test Strategy rows" ? /^\|\s*([A-Za-z][\w.-]*)\s*\|/.exec(l)?.[1]
        : sec.name === "Evals" ? (/^###\s+([A-Za-z][\w.-]*)/.exec(l) ?? /^<!--\s*criterion_sha\s+([A-Za-z][\w.-]*)/.exec(l))?.[1]
        : CARRY_BY_ID.has(sec.name) ? ITEM_ID.exec(l)?.[1] : undefined;
      if (id && id.toLowerCase() !== "isc") taken.add(id);
    }
  }
  const appended: string[] = [];
  // Insert bottom-up into existing fresh sections so earlier indexes stay valid.
  const inserts: { at: number; lines: string[] }[] = [];
  for (const sec of proposalSections(prev)) {
    if (!CARRY_BY_LINE.has(sec.name) && !CARRY_BY_ID.has(sec.name)) continue;
    const { preamble, items } = sectionItems(prev.slice(sec.start + 1, sec.end));
    const target = freshSections.find((x) => x.name === sec.name);
    const have = new Set(target ? sectionItems(out.slice(target.start + 1, target.end)).items.map((it) => it[0]!.trim()) : []);
    const keep = items.filter((it) => {
      if (CARRY_BY_LINE.has(sec.name)) return !have.has(it[0]!.trim());
      const id = ITEM_ID.exec(it[0]!)?.[1];
      return !!id && !taken.has(id) && open.has(id);
    });
    if (!keep.length) continue;
    if (target) {
      let at = target.end;
      while (at > target.start + 1 && !out[at - 1]!.trim()) at--;
      inserts.push({ at, lines: keep.flat() });
    } else appended.push(`## ${sec.name}`, "", ...preamble, ...keep.flat(), "");
  }
  for (const ins of inserts.sort((a, b) => b.at - a.at)) out.splice(ins.at, 0, ...ins.lines);
  if (!appended.length) return out.join("\n");
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  return [...out, "", ...appended].join("\n");
}

/**
 * Writes the proposal beside the ISA. Never ISA.md. When the file it replaces
 * is a remnant (merge or split already applied part of it), the remnant's
 * unapplied items are carried into the new proposal instead of being lost.
 */
export function writeProposed(isaPath: string, text: string): string {
  const target = join(dirname(resolve(isaPath)), PROPOSED_FILE);
  invariant(basename(target) === PROPOSED_FILE && target !== resolve(isaPath), "compile writes only Evals.proposed.md beside the ISA, never the ISA");
  invariant(!/^ISA\.md$/i.test(basename(target)), "compile never writes ISA.md");
  let out = text;
  if (existsSync(target)) {
    const previous = readFileSync(target, "utf8");
    if (isRemnant(previous)) {
      const open = new Set(planCriteria(resolve(isaPath), readFileSync(isaPath, "utf8")).filter((c) => NEEDS_COMPILE.has(c.state)).map((c) => c.id));
      out = carryForward(text, previous, open);
    }
  }
  writeFileSync(target, out);
  return target;
}

async function main(argv: string[]): Promise<number> {
  // `merge` folds Evals.proposed.md into the ISA (CompileMerge.ts); main session only.
  if (argv[0] === "merge") return (await import("./CompileMerge.ts")).mergeMain(argv.slice(1));
  // `split` applies the proposal's "Split these" to the ISA (CompileSplit.ts); main session only.
  if (argv[0] === "split") return (await import("./CompileSplit.ts")).splitMain(argv.slice(1));
  let values: Record<string, string | boolean | string[] | undefined>, positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      "dry-run": { type: "boolean" }, json: { type: "boolean" }, write: { type: "boolean" }, only: { type: "string", multiple: true },
      caller: { type: "string" }, batch: { type: "string" }, help: { type: "boolean", short: "h" },
    } }));
  } catch (e) { console.error(`compile: ${(e as Error).message}`); return 2; }
  if (values.help) { console.log(readFileSync(join(import.meta.dir, "Compile.help.md"), "utf8")); return 0; }
  const isa = positionals[0];
  if (!isa || !existsSync(isa)) { console.error("usage: bun Compile.ts <ISA.md> [--dry-run] [--json] [--write] [--only ISC-n] [--caller name] [--batch N]"); return 2; }
  const only = ((values.only as string[] | undefined) ?? []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  const batch = values.batch ? Number(values.batch) : undefined;
  if (batch !== undefined && (!Number.isInteger(batch) || batch < 1)) { console.error("compile: --batch takes a positive integer"); return 2; }
  let r: CompileResult;
  try { r = await compile(isa, { only, caller: values.caller as string | undefined, batch, dryRun: !!values["dry-run"] }); }
  catch (e) { console.error(`compile: ${(e as Error).message}`); return 2; }
  const written = values.write && !values["dry-run"] && (r.compiled.length || r.inherited.compiled.length || r.split.length || r.failed.length || r.inherited.errors.length) ? writeProposed(isa, r.proposed) : null;
  if (values.json) console.log(JSON.stringify({ ...r, written }, null, 2));
  else { process.stdout.write(r.proposed); if (written) console.error(`compile: wrote ${written}`); console.error(`compile: ${r.compiled.length} compiled, ${r.inherited.compiled.length} inherited, ${r.split.length} to split, ${r.failed.length} refused, ${r.calls} call(s), ${r.latencyMs} ms`); }
  return r.failed.length || r.inherited.errors.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
