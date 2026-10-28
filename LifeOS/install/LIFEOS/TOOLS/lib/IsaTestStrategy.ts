/**
 * @version 1.1.0
 * IsaTestStrategy.ts — parse an ISA's `## Test Strategy` table into runnable
 * probes, plus criterion coverage over it. The harness speaks ISA: this is the
 * load-bearing idea — the ISA's criteria ARE the test cases.
 *
 * Lifted out of Bunker (whose own module now re-exports this one) so ISAGate's
 * H3 / A2 / H8 checks run on every install. Before the lift the parser shipped
 * only with the private Bunker tree, so H3 could never fire on a public install
 * and `phase: complete` passed with zero anchors_to. One source of truth: edit
 * here, never in Bunker's copy. public issue #2037, @lowk3y
 */

import { readFileRetry } from "./RetryEintr.ts";
import { dirname, resolve } from "node:path";
import { parseIsaClaims } from "./IsaClaims";
import { getClaudeDir } from "../Paths";
import { readOnlyRefusal, validateGlanceQuestion, validateProducer, type GlanceQuestion } from "./GlanceQuestion.ts";

// A probe that cannot fail is worse than no probe: it reports green forever.
// Bun 1.3.6 runs a `bun -e` script containing require() and no await as
// CommonJS, and an uncaught throw there exits 0 (verified 2026-09-24: rc=0 for
// `require("fs");throw new Error("x")`, rc=1 with process.exit(1) or any
// await). Found by a mutation run in the eval backlog program.
export const UNFAILABLE_BUN_E = (tool: string): boolean =>
  /\bbun\s+-e\b/.test(tool) && /\brequire\(/.test(tool) && /\bthrow\b/.test(tool) && !/\bawait\b/.test(tool);

// The same failure one level down: a tool cell that is a single bare word
// (`bash`, `bun`, `jq`, `ls`) runs as `bash -c "<word>"` and checks nothing.
// Several of those words exit 0 on empty stdin, so done criteria across the
// estate were green on a probe that never looked at them (2026-09-24). A
// command needs an argument or a path to assert anything. Enforced where
// coverage is counted (EvalCensus `unfailable`), not as a parse drop: the
// runner's own fixtures use bare `true`/`false` on purpose.
export const BARE_WORD_TOOL = (tool: string, type: string): boolean =>
  // Every type Bunker hands to `bash -c` verbatim; eval rows expand a suite name first.
  (type === "bash" || type === "bun-test" || type === "bun-property" || type === "curl" || type === "screenshot") && /^[A-Za-z][A-Za-z0-9_.+-]*$/.test(tool.trim());

// Single-quoted text is a pattern or literal (`rg '…claude -p…'`), never a call,
// EXCEPT the body of a shell wrapper: `bash -c '…'`, `sh -lc '…'`, `eval '…'`,
// `xargs … sh -c '…'`. That body is a command the shell runs, so blanking it hid
// `bash -c 'wrangler deploy'` from the deploy and model guards (LOSIntegrity
// ). The text a call predicate reads is the command with
// ordinary quoted spans blanked, plus every wrapper body as its own command.
const SHELL_WRAPPER_BODY = /(?:\b(?:ba|z|da|k)?sh\b[^'|;&\n]*?\s-[A-Za-z]*c[A-Za-z]*\s+|\beval\s+)'([^']*)'/g;
export function callableText(tool: string): string {
  const bodies = [...tool.matchAll(SHELL_WRAPPER_BODY)].map((m) => m[1]!);
  return [tool.replace(/'[^']*'/g, "''"), ...bodies].join(" ; ");
}

// A deterministic-typed row can still spend a model: `claude -p`, codex, or the
// Inference/ApiLane/Worker wrappers. Liveness runs on every monitor tick, so such
// a row there bills a model session each tick. Rows of one ISA sat on
// liveness this way, harmless only because they had never run (2026-09-24).
export const MODEL_CALL_TOOL = (tool: string): boolean =>
  /\bclaude\s+(?:-p|--print)\b|\bcodex\s+exec\b|\bbun\s+(?:run\s+)?[^\s|;&]*\b(?:Inference|ApiLane|Worker|CodexProgress)\.ts\b/.test(callableText(tool));

// A probe observes; it never ships. Rows in a production app's ISA ran `bash scripts/deploy.sh`
// on the liveness lane, so any run of them attempted a production deploy
// (2026-09-25: an eval sweep executed them; the deploy failed before shipping).
// Refused on every lane. Single-quoted text is a pattern, never a call, except a
// shell-wrapper body (see callableText).
export const DEPLOY_CALL_TOOL = (tool: string): boolean =>
  /(?:^|[;&|(]\s*|\b(?:bash|sh)\s+)(?:\.\/)?(?:scripts\/)?deploy\.sh\b|\bwrangler\s+(?:deploy|publish)\b|CfEnv\.ts\s+(?:deploy|pages\s+deploy)\b|\bbun\s+run\s+deploy\b/.test(callableText(tool));

// Where a row's tool command runs. Default is the ISA's own directory, so a
// project repo's rows stay app-relative. `probe_cwd: config-root` in the ISA
// frontmatter runs them from the LifeOS config root instead: the rows of a
// subsystem ISA under LIFEOS/ are written as `bun test ./LIFEOS/<X>`, and a
// USER-tree ISA's code lives in the system tree. Before this key those rows
// parsed, counted as covered, and could never execute (eval backlog
// remediation, fifth bucket, 2026-09-20). An unknown value throws: a typo here
// would silently move every probe of the ISA to the wrong directory.
export const PROBE_CWD_VALUES = ["isa", "config-root"] as const;

export function probeCwdOf(isaPath: string, configRoot: string = getClaudeDir()): string {
  const isaAbs = resolve(isaPath);
  const fm = readFileRetry(isaAbs).match(/^---\n([\s\S]*?)\n---/);
  const value = fm?.[1]?.match(/^probe_cwd:\s*["']?([^"'\s#]+)/m)?.[1] ?? "isa";
  if (value === "isa") return dirname(isaAbs);
  if (value === "config-root") return configRoot;
  throw new Error(`${isaAbs}: probe_cwd "${value}" is not one of ${PROBE_CWD_VALUES.join(", ")}`);
}

// Closed vocabulary of probe kinds. A typo'd kind must be caught here, not at
// dispatch — "the ISA's criteria ARE the test cases", so an unrecognized type
// that parses clean would silently skip a criterion and let `bunker test` go
// green while a criterion was never verified.
//
// Reconciliation note (source of truth = ISA format spec § ISC Type Vocabulary,
// LIFEOS/DOCUMENTATION/ISA/ISAFormat.md): the spec lists SIX types and folds
// curl probes under `bash`. Bunker keeps `curl` as a distinct SEVENTH kind
// because the executor (src/test.ts) and the local/cloud jurisdiction split
// (src/synccloud.ts) both key on it. Dropping it would reject real adopted ISAs
// that already carry `type: curl` rows — so the code deliberately diverges from
// the spec by one member, documented here.
//
// `proof` and `text` (assay-everywhere): rows Proof reads from the ISA's Test Strategy (skills/Assay/Tools/Proof.ts
// isaProofChecks reads type `proof` or `text`; the Tool cell is a Proof check such as `non-empty`, `text-present "x"`
// or `count min=3`, not a shell command). They are parsed and listed here so no row is dropped as an unknown type; Bunker
// does not execute them (they need an artifact, and Proof measures it at the hand-off).
export const PROBE_TYPES = [
  "bash",
  "bun-test",
  "bun-property",
  "curl",
  "manual",
  "screenshot",
  "eval",
  "pairwise",
  "glance",
  "proof",
  "text",
] as const;

export type ProbeType = (typeof PROBE_TYPES)[number];

/**
 * The model-priced row types: `eval` (EvalRunner, judged asserts) and
 * `pairwise` (Tournament.ts, a flipped bracket). Every rule that keys on
 * "this row calls a model" goes through here — lane default, liveness
 * rejection, stage default, Bunker's eval gating and cadence — so a second
 * judged type can never be deterministic-by-accident on one path.
 */
export function isJudgedType(type: string): boolean {
  return type === "eval" || type === "pairwise" || type === "glance";
}

const PROBE_TYPE_SET: ReadonlySet<string> = new Set(PROBE_TYPES);

export function isProbeType(x: string): x is ProbeType {
  return PROBE_TYPE_SET.has(x);
}

// Severity says what a FAILURE means, orthogonal to how the probe runs.
// "critical" marks a probe that asserts the app is doing its job at all — its
// failure is an outage, not a degraded corner. A live site serving 200 over a
// dead content pipeline is DOWN even when every shell probe stays green.
export const PROBE_SEVERITIES = ["normal", "critical"] as const;
export type ProbeSeverity = (typeof PROBE_SEVERITIES)[number];

export function isCritical(p: Probe): boolean {
  return p.severity === "critical";
}

// Legacy execution-tier cell says WHEN a probe runs, orthogonal to what
// its failure means (severity). "fast" (default) is the blocking surface — dev
// loop, deploy gate, `bunker test`. "deep" (soak, load, full sweeps — minutes
// to hours) runs only on Bunker's clock (`bunker monitor`, the cloud schedule)
// and can alert and open criteria, never block a ship. Doctrine:
// ISAFormat v2.20.0 § Verifier classes and execution tiers.
export const LEGACY_LANES = ["fast", "deep"] as const;
/** Compatibility for consumers outside this worker's owned paths. */
export const PROBE_TIERS = LEGACY_LANES;
export type ProbeTier = "code" | "glance" | "judge" | "human";
export function tierOfType(type: ProbeType): ProbeTier {
  return type === "manual" ? "human" : type === "glance" ? "glance" : isJudgedType(type) ? "judge" : "code";
}

export function isDeep(p: Probe): boolean {
  return p.lane === "integrity" || p.lane === "build";
}

// Lanes (ISAFormat v2.27.0, 20260908-universal-eval-reeval F1): WHAT a row
// proves, which fixes how often it may run and what it may spend.
//   liveness  — is the thing up. Every monitor tick, the deploy gate, cloud.
//               Deterministic only; inference never runs on this lane (an
//               `eval` row here is a dropped row, not a quiet default).
//   integrity — is the thing right. Bunker's clock, may carry a cadence, may
//               dispatch a judge. `eval` rows default here.
//   build     — was it built to the ISA. Only `bunker test --deep`; never the
//               monitor, never cloud.
// `fast` → liveness and `deep` → integrity are the legacy aliases, so every
// existing table keeps its execution lane. The legacy two-way
// vocabulary remains accepted in markdown; Probe.tier now describes verification cost.
export const PROBE_LANES = ["liveness", "integrity", "build"] as const;
export type ProbeLane = (typeof PROBE_LANES)[number];
const LANE_ALIASES: Readonly<Record<string, ProbeLane>> = { fast: "liveness", deep: "integrity" };
export const LANE_WORDS: readonly string[] = [...LEGACY_LANES, ...PROBE_LANES];

/** `fast`/`deep`/`liveness`/`integrity`/`build` → lane; null otherwise. */
export function laneOf(word: string): ProbeLane | null {
  const w = word.toLowerCase();
  return LANE_ALIASES[w] ?? ((PROBE_LANES as readonly string[]).includes(w) ? (w as ProbeLane) : null);
}
export function tierOfLane(lane: ProbeLane): "fast" | "deep" {
  return lane === "liveness" ? "fast" : "deep";
}
export function isBuild(p: Probe): boolean {
  return p.lane === "build";
}

// Per-row cadence (ISAFormat v2.25.0). A deep row may carry `@<N><m|h|d>`
// in the tier cell — `deep@6h` — meaning: on Bunker's clock, run this row at
// most once per that window and carry its last verdict between runs. Born of
// A production app once had a live probe that asked the app a question ran
// on every monitor tick, a model call each time from an app proving to
// itself that it could answer. The cadence belongs on the ROW, next to the
// tier it refines, not in a self-throttling probe body nobody can see.
const CADENCE_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const TIER_CELL = /^([a-z]+)(?:@(\d+)([mhd]))?$/;

/** `6h` → 21600000; null when the text is not a cadence. Exported for tests. */
export function parseCadence(text: string): number | null {
  const m = /^(\d+)([mhd])$/.exec(text.trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * CADENCE_UNIT_MS[m[2]!]!;
}

export interface Probe {
  isc: string;
  type: ProbeType;
  check: string;
  threshold: string;
  tool: string;
  anchors_to: string;
  // Optional 7th column. Absent/blank = "normal", so every existing 5- and
  // 6-column row keeps parsing byte-identically.
  severity: ProbeSeverity;
  // Derived verification tier; the markdown tier column still names the lane.
  tier: ProbeTier;
  // The 8th column's real meaning (v2.27.0): which lane the row runs on.
  lane: ProbeLane;
  // Optional 9th column. A positive integer; rows of one ISC run stage by stage
  // and a failing lower stage gates every higher one (the asserts-gate-judges
  // rule). Absent = 1 for deterministic rows, 2 for `eval`, so every existing
  // ISA gets the gate with zero row edits.
  stage: number;
  // Explicit per-row cadence in ms from a `deep@6h`-style tier cell. Absent =
  // the row runs on every scheduled tick (deep) or every run (fast); `eval`
  // rows without one fall to the monitor's day-cycle default.
  every?: number;
  // An `eval` row whose tool cell is `eval:#<id>` points at that id's block in
  // the ISA's `## Evals` section (ISAFormat v2.29.0). `evalRef` is the id and
  // `staged` the parsed block; `tier` is then the block's highest stage tier.
  evalRef?: string;
  staged?: StagedEval;
}

// ── `## Evals` — staged evals keyed by criterion id (ISAFormat v2.29.0) ──────
// One fenced yaml block per criterion that needs more than a one-line row,
// under a `### <ISC id>` heading. A block is `stages:`, an ordered list; each
// stage is a one-key map whose key names the kind of every check in it, so a
// stage holds one tier by construction. Stages run in order and a failure
// skips the rest. Labels, cases, results and receipts never live here: they
// change constantly, live in their own stores, and would move the ISA's hash
// (and stale every recorded result) on every label (20261010-evals-in-the-isa
// ISC-6). A block that carries one of those keys is refused, not ignored.
export const EVAL_CHECK_KINDS = ["code", "glance", "eval", "pairwise", "manual"] as const;
export type EvalCheckKind = (typeof EVAL_CHECK_KINDS)[number];
const EVAL_KIND_ALIASES: Readonly<Record<string, EvalCheckKind>> = { tournament: "pairwise" };
const EVAL_KIND_TIER: Readonly<Record<EvalCheckKind, ProbeTier>> = { code: "code", glance: "glance", eval: "judge", pairwise: "judge", manual: "human" };
/** Cost order of the four tiers; a later stage never sits on a cheaper tier than an earlier one. */
export const TIER_RANK: Readonly<Record<ProbeTier, number>> = { code: 0, glance: 1, judge: 2, human: 3 };
export const EVAL_HISTORY_KEYS: ReadonlySet<string> = new Set(["labels", "label", "cases", "results", "result", "receipts", "receipt", "verdicts", "verdict", "history", "attestations"]);
const EVAL_REF = /^eval:#([A-Za-z][\w.-]*)$/;
const EVAL_HEADING = /^###\s+([A-Za-z][\w.-]*?)(?:\s*$|\s+[·—–:-]\s*(.*)$)/;

export interface EvalCheck {
  kind: EvalCheckKind;
  /** The probe type Bunker dispatches this check as: `bash`/`bun-test` for code, else the kind. */
  type: ProbeType;
  tier: ProbeTier;
  /** code: the command · eval: `suite:<name>` · pairwise: the Tournament.ts command · manual: what a person checks · glance: `glance:#<isc>/<question id>`. */
  tool: string;
  /** glance only: the inline question, validated by GlanceQuestion.validateGlanceQuestion. */
  question?: GlanceQuestion;
  /** eval only: an inline anchored rubric (tool `rubric:#<isc>/<id>`); absent when the stage names a suite. */
  rubric?: InlineRubric;
}

/**
 * An inline anchored rubric on an `eval` stage (ISC-44): one dimension, every level 1..scale anchored, and a subject
 * producer that yields the output to grade, bounded exactly like a glance producer. Bunker grades it through
 * skills/Assay/Tools/Judge.ts (the judgment layer's engine score first, the model judge only for the uncertain band).
 */
export interface InlineRubric {
  id: string;
  /** The one dimension this rubric grades. */
  dimension: string;
  /** The question the judge answers about the subject. */
  rubric: string;
  /** Top level; anchors cover 1..scale exactly. */
  scale: number;
  /** Level ("1".."scale") → what that level looks like. */
  anchors: Record<string, string>;
  /** The bounded command or ISA-local file whose output is graded. */
  subject: string;
  /** Pass bar on the normalized 0..1 score; Judge.ts's default when absent. */
  threshold?: number;
}
export const INLINE_RUBRIC_KEYS: ReadonlySet<string> = new Set(["id", "dimension", "rubric", "scale", "anchors", "subject", "threshold"]);
export const RUBRIC_SCALE_MIN = 2;
export const RUBRIC_SCALE_MAX = 10;
const RUBRIC_TOOL = /^rubric:#([A-Za-z][\w.-]*)\/([A-Za-z0-9_.-]+)$/;
/** `rubric:#ISC-4/calm` → { isc, id }; null when the tool is not an inline rubric pointer. */
export function rubricRefOf(tool: string): { isc: string; id: string } | null {
  const m = RUBRIC_TOOL.exec(tool.trim());
  return m ? { isc: m[1]!, id: m[2]! } : null;
}

/** One inline rubric object → its validated form. Throws with the reason it cannot be used. Never executes the subject. */
export function validateInlineRubric(raw: unknown, isaPath?: string): InlineRubric {
  if (!isRecord(raw)) throw new Error("an inline rubric is a map (id, dimension, rubric, anchors, subject)");
  const extra = Object.keys(raw).filter((k) => !INLINE_RUBRIC_KEYS.has(k));
  if (extra.length) throw new Error(`inline rubric: unknown key(s) ${extra.map((k) => `\`${k}\``).join(", ")}; a rubric grades one dimension (keys: ${[...INLINE_RUBRIC_KEYS].join(", ")})`);
  const text = (k: string): string => {
    const v = raw[k];
    if (typeof v !== "string" || !v.trim()) throw new Error(`inline rubric requires \`${k}\` (a non-empty string)`);
    return v.trim();
  };
  const id = text("id");
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error(`inline rubric id "${id}" must be letters, digits, dot, dash or underscore`);
  const dimension = text("dimension");
  if (/\n/.test(dimension)) throw new Error("inline rubric `dimension` names one dimension on one line");
  const rubric = text("rubric");
  const subject = text("subject");
  if (!isRecord(raw.anchors)) throw new Error("inline rubric requires `anchors`, a map of level → description");
  const keys = Object.keys(raw.anchors);
  const bad = keys.find((k) => !/^[1-9]\d*$/.test(k));
  if (bad !== undefined) throw new Error(`inline rubric anchor key "${bad}" is not a level; anchors are keyed 1..scale`);
  const levels = keys.map(Number);
  let scale: number;
  if (raw.scale === undefined) scale = Math.max(0, ...levels);
  else if (typeof raw.scale === "number" && Number.isInteger(raw.scale)) scale = raw.scale;
  else throw new Error("inline rubric `scale` is an integer");
  if (scale < RUBRIC_SCALE_MIN || scale > RUBRIC_SCALE_MAX) throw new Error(`inline rubric scale ${scale} is outside ${RUBRIC_SCALE_MIN}..${RUBRIC_SCALE_MAX}`);
  const over = levels.find((l) => l > scale);
  if (over !== undefined) throw new Error(`inline rubric anchors level ${over} above its scale ${scale}`);
  const anchors: Record<string, string> = {};
  for (let level = 1; level <= scale; level++) {
    const a = (raw.anchors as Record<string, unknown>)[String(level)];
    if (typeof a !== "string" || !a.trim()) throw new Error(`inline rubric level ${level} has no anchor; every level 1..${scale} is anchored`);
    anchors[String(level)] = a.trim();
  }
  let threshold: number | undefined;
  if (raw.threshold !== undefined) {
    if (typeof raw.threshold !== "number" || !(raw.threshold > 0 && raw.threshold <= 1)) throw new Error("inline rubric `threshold` is a number in (0, 1]");
    threshold = raw.threshold;
  }
  // Same producer contract as a glance question. A file the build has not written yet is allowed here
  // (Bunker re-validates and refuses at run time); any other refusal fails the block now.
  try { validateProducer(subject, isaPath); }
  catch (e) {
    const msg = (e as Error).message;
    if (!/ENOENT|no such file/i.test(msg)) throw new Error(`inline rubric subject refused: ${msg}`);
  }
  if (isaPath) {
    const refusal = readOnlyRefusal(subject, dirname(resolve(isaPath)));
    if (refusal) throw new Error(`inline rubric subject refused: ${refusal}`);
  }
  return { id, dimension, rubric, scale, anchors, subject, ...(threshold !== undefined ? { threshold } : {}) };
}
export interface EvalStage { stage: number; tier: ProbeTier; checks: EvalCheck[] }
export interface StagedEval {
  isc: string;
  /** 1-based line of the `### <id>` heading in the ISA file. */
  line: number;
  stages: EvalStage[];
  /** The highest stage tier: the most a full run of this eval can cost. */
  tier: ProbeTier;
}
export interface EvalsSection {
  evals: Map<string, StagedEval>;
  /** Blocks that cannot become a staged eval, each with its reason. Never silently skipped. */
  errors: DroppedRow[];
}

/** `eval:#ISC-4` → `ISC-4`; null when the tool cell is not an eval ref. */
export function evalRefOf(tool: string): string | null {
  return EVAL_REF.exec(unwrapCode(tool).trim())?.[1] ?? null;
}

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** The first history key found anywhere in a parsed block, with its path; null when clean. */
function historyKeyIn(x: unknown, path: string): string | null {
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) { const hit = historyKeyIn(x[i], `${path}[${i}]`); if (hit) return hit; }
    return null;
  }
  if (!isRecord(x)) return null;
  for (const [k, v] of Object.entries(x)) {
    if (EVAL_HISTORY_KEYS.has(k.toLowerCase())) return `${path}.${k}`;
    const hit = historyKeyIn(v, `${path}.${k}`);
    if (hit) return hit;
  }
  return null;
}

// Code checks get the same refusals as code rows, plus two the row parser
// leaves to the census because legacy fixtures depend on them: a bare word and
// a model call. A new format has no legacy, so the code tier means code.
function codeCheckProblem(command: string): string | null {
  if (DEPLOY_CALL_TOOL(command)) return "a code check deploys; a check never ships";
  if (UNFAILABLE_BUN_E(command)) return "unfailable bun -e: a require() script with no await that fails by throw exits 0 (Bun 1.3.6); fail with process.exit(1)";
  if (MODEL_CALL_TOOL(command)) return "a code check starts a model; put it on a glance, eval or pairwise stage";
  if (/^[A-Za-z][A-Za-z0-9_.+-]*$/.test(command)) return `a bare word ("${command}") checks nothing; give the command an argument or a path`;
  return null;
}

function stageChecks(kind: EvalCheckKind, value: unknown, isc: string, title: string, isaPath: string | undefined): EvalCheck[] {
  const tier = EVAL_KIND_TIER[kind];
  const items = Array.isArray(value) ? value : [value];
  if (!items.length) throw new Error(`a ${kind} stage has no checks`);
  return items.map((item): EvalCheck => {
    if (kind === "glance") {
      if (!isRecord(item)) throw new Error("a glance check is a question object (id, kind, instructions, producer, caller)");
      // `producer:` is shorthand for the question file's `state.producer`; the claim defaults to the heading.
      const { producer, ...rest } = item;
      const raw = { claim: title || isc, ...rest, ...(producer !== undefined && rest.state === undefined ? { state: { producer } } : {}) };
      let question: GlanceQuestion;
      try { question = validateGlanceQuestion(raw, isaPath); }
      catch (e) { throw new Error(`glance question invalid: ${(e as Error).message}`); }
      return { kind, type: "glance", tier, tool: `glance:#${isc}/${question.id}`, question };
    }
    if (kind === "eval" && isRecord(item)) {
      const rubric = validateInlineRubric(item, isaPath);
      return { kind, type: "eval", tier, tool: `rubric:#${isc}/${rubric.id}`, rubric };
    }
    if (typeof item !== "string" || !item.trim()) throw new Error(`a ${kind} check is a non-empty string${kind === "eval" ? " (suite:<name>) or an inline rubric map" : ""}`);
    const text = item.trim();
    if (kind === "code") {
      const problem = codeCheckProblem(text);
      if (problem) throw new Error(problem);
      return { kind, type: /^bun\s+test\b/.test(text) ? "bun-test" : "bash", tier, tool: text };
    }
    if (kind === "eval") {
      const suite = /^(?:suite:\s*)?([A-Za-z0-9._-]+)$/.exec(text)?.[1];
      if (!suite) throw new Error(`an eval check names a suite (suite:<name>), got "${text}"`);
      return { kind, type: "eval", tier, tool: `suite:${suite}` };
    }
    if (kind === "pairwise" && DEPLOY_CALL_TOOL(text)) throw new Error("a pairwise check deploys; a check never ships");
    return { kind, type: kind === "pairwise" ? "pairwise" : "manual", tier, tool: text };
  });
}

/** One block's yaml → its staged eval. Throws with the reason a block cannot be used. */
function stagedEvalOf(isc: string, title: string, line: number, yaml: string, isaPath: string | undefined): StagedEval {
  let doc: unknown;
  try { doc = Bun.YAML.parse(yaml); }
  catch (e) { throw new Error(`yaml does not parse: ${(e as Error).message}`); }
  if (!isRecord(doc)) throw new Error("the block must be a map with a `stages:` list");
  const history = historyKeyIn(doc, isc);
  if (history) throw new Error(`\`${history}\` is history; labels, cases, results and receipts live in their stores, never in the ISA`);
  const extra = Object.keys(doc).filter((k) => k !== "stages");
  if (extra.length) throw new Error(`unknown key(s) ${extra.map((k) => `\`${k}\``).join(", ")}; a block holds only \`stages:\``);
  if (!Array.isArray(doc.stages) || !doc.stages.length) throw new Error("`stages:` must be a non-empty list");
  const stages: EvalStage[] = doc.stages.map((s, i): EvalStage => {
    if (!isRecord(s) || Object.keys(s).length !== 1) throw new Error(`stage ${i + 1} must be a one-key map naming its kind (${EVAL_CHECK_KINDS.join(", ")})`);
    const word = Object.keys(s)[0]!;
    const kind = (EVAL_KIND_ALIASES[word] ?? word) as EvalCheckKind;
    if (!(EVAL_CHECK_KINDS as readonly string[]).includes(kind)) throw new Error(`stage ${i + 1}: unknown kind "${word}" (valid: ${EVAL_CHECK_KINDS.join(", ")}, tournament)`);
    let checks: EvalCheck[];
    try { checks = stageChecks(kind, s[word], isc, title, isaPath); }
    catch (e) { throw new Error(`stage ${i + 1} (${word}): ${(e as Error).message}`); }
    return { stage: i + 1, tier: EVAL_KIND_TIER[kind], checks };
  });
  for (let i = 1; i < stages.length; i++) {
    if (TIER_RANK[stages[i]!.tier] < TIER_RANK[stages[i - 1]!.tier]) {
      throw new Error(`stage ${i + 1} (${stages[i]!.tier}) is cheaper than stage ${i} (${stages[i - 1]!.tier}); stages run cheapest first, so a costly check never gates a cheap one`);
    }
  }
  const rubricIds = stages.flatMap((s) => s.checks.flatMap((c) => (c.rubric ? [c.rubric.id] : [])));
  const dup = rubricIds.find((id, i) => rubricIds.indexOf(id) !== i);
  if (dup) throw new Error(`inline rubric id "${dup}" appears twice; each rubric in a block has its own id`);
  const tier = stages.reduce<ProbeTier>((hi, s) => (TIER_RANK[s.tier] > TIER_RANK[hi] ? s.tier : hi), "code");
  return { isc, line, stages, tier };
}

/** Parse the `## Evals` section of ISA text. Read-only: nothing here writes, and no history is read. */
export function parseEvalsText(text: string, isaPath?: string): EvalsSection {
  const evals = new Map<string, StagedEval>();
  const errors: DroppedRow[] = [];
  const lines = text.split("\n");
  let inSection = false;
  let fence: { open: string; startLine: number; body: string[] } | null = null;
  let current: { isc: string; title: string; line: number; raw: string; blocks: number; yaml: string; lang?: string } | null = null;
  const seen = new Set<string>();
  const finish = () => {
    if (!current) return;
    const c = current;
    current = null;
    if (c.lang !== undefined) { errors.push({ raw: c.raw, reason: `${c.isc}: fenced block language "${c.lang}" is not yaml` }); return; }
    if (c.blocks === 0) { errors.push({ raw: c.raw, reason: `${c.isc}: heading with no fenced yaml block` }); return; }
    if (c.blocks > 1) { errors.push({ raw: c.raw, reason: `${c.isc}: ${c.blocks} fenced blocks; one block per criterion` }); return; }
    try { evals.set(c.isc, stagedEvalOf(c.isc, c.title, c.line, c.yaml, isaPath)); }
    catch (e) { errors.push({ raw: c.raw, reason: `${c.isc}: ${(e as Error).message}` }); }
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    // Fences are tracked in every section, so a `## Evals` line inside some
    // other section's code example never opens the section.
    if (fence) {
      if (line.startsWith(fence.open) && line.slice(fence.open.length).trim() === "") {
        if (inSection && current) { current.blocks++; current.yaml = fence.body.join("\n"); }
        fence = null;
      } else fence.body.push(raw);
      continue;
    }
    const open = /^(`{3,}|~{3,})\s*([A-Za-z]*)\s*$/.exec(line);
    if (open) {
      if (inSection && current && !/^(ya?ml|json)?$/i.test(open[2]!)) current.lang = open[2]!;
      fence = { open: open[1]!, startLine: i + 1, body: [] };
      continue;
    }
    if (/^##\s/.test(line)) {
      finish();
      inSection = /^##\s+Evals\s*$/i.test(line);
      continue;
    }
    if (!inSection) continue;
    if (/^###\s/.test(line)) {
      finish();
      const m = EVAL_HEADING.exec(line);
      if (!m) { errors.push({ raw: line, reason: "an Evals heading is `### <ISC id>`, optionally followed by ` · <title>`" }); continue; }
      if (seen.has(m[1]!)) { errors.push({ raw: line, reason: `${m[1]}: duplicate Evals block` }); continue; }
      seen.add(m[1]!);
      current = { isc: m[1]!, title: (m[2] ?? "").trim(), line: i + 1, raw: line, blocks: 0, yaml: "" };
    }
  }
  if (fence && inSection) errors.push({ raw: `line ${fence.startLine}`, reason: `${current?.isc ?? "Evals"}: fenced block never closes` });
  else finish();
  return { evals, errors };
}

export function parseEvalsSection(isaPath: string): EvalsSection {
  return parseEvalsText(readFileRetry(isaPath), isaPath);
}

// A Test Strategy row whose type word is not a probe type and whose tool cell
// is not a command (20261010-evals-in-the-isa ISC-4). It used to become a
// `manual` row, which satisfied H8 and read as an honest attestation. It is now
// kept apart from `probes`: never run, never counted as coverage, reported in
// `repaired` and here. ISAGate warns on it; it blocks H8 only on `isa_format: 3`
// ISAs until the M4 migration.
export interface InvalidRow {
  isc: string;
  type: "invalid";
  rawType: string;
  check: string;
  tool: string;
  anchors_to: string;
  raw: string;
}

// A Test Strategy row that LOOKS like a data row (in-section, pipe-delimited,
// not header/separator) but cannot become a Probe. Surfaced, never silently
// dropped — a silently-skipped row let `bunker test` go green over an
// unverified criterion (the EIF 3-column zero-probe-green incident, 2026-07-23).
export interface DroppedRow {
  raw: string;
  reason: string; // e.g. "too few columns (3 < 6)"
}

export interface RepairedRow {
  isc: string;
  reason: string;
}

export interface TestStrategy {
  probes: Probe[];
  dropped: DroppedRow[];
  /** Rows that parsed only after a deterministic repair (today: an unescaped pipe folded
   *  back into the tool command). Reported so the author fixes the table; never a failure. */
  repaired?: RepairedRow[];
  /** Rows whose type word is not a probe type and whose tool cell is not a command. Never probes. */
  invalid?: InvalidRow[];
  /** The ISA's `## Evals` section, parsed once with the table. */
  evals?: EvalsSection;
}

const SEPARATOR = /^:?-+:?$/;

// COLUMN CONTRACT (source of truth — the parser, not the prose spec):
//   isc | type | check | threshold | tool | anchors_to | severity | tier | stage
// A conforming data row has at least 5 cells; anchors_to, severity, tier, and
// stage are all optional, so older 5/6/7/8-column tables parse unchanged.
const MIN_CELLS = 5;
// The full column contract: isc | type | check | threshold | tool | anchors_to | severity | tier | stage.
export const DEFAULT_COLUMNS = 9;

// Column IDENTITY comes from the table's own header row, never a fixed
// position. Real ISAs already disagree on column order — this task's own ISA
// declares `isc | type | lane | stage | check | threshold | tool | anchors_to`
// (lane before check/threshold, no severity column at all), and older
// closed ISAs (20260511-isa-absorbs-goal-semantics-design and siblings)
// declare `isc | anchors_to | type | check | threshold | tool` (anchors_to
// right after isc). A positional parser misread the first real table's `tool`
// cell as `severity`, dropping a valid row as `unknown severity "eyes"` — the
// identical row with a two-word tool value ("human eyes") parsed by accident,
// since the bare-word severity guard doesn't fire on a value with a space.
// Found live 2026-09-10.
export type Field = "isc" | "type" | "check" | "threshold" | "tool" | "anchors_to" | "severity" | "tier" | "stage";
const HEADER_ALIASES: Readonly<Record<string, Field>> = {
  isc: "isc", type: "type", check: "check", threshold: "threshold", tool: "tool",
  anchors_to: "anchors_to", "anchors to": "anchors_to", severity: "severity",
  tier: "tier", lane: "tier", stage: "stage",
  // The words authors actually write (an estate census found rows sitting
  // under headers like `| Criterion | Probe |` and `| Criterion | Verifier | Assert |`
  // and were dropped wholesale). `probe` is resolved per table in
  // resolveColumns: the command when no other column names one, else the check.
  claim: "isc", id: "isc", "isc range": "isc", "isc id": "isc", criterion: "isc",
  verifier: "type", kind: "type", class: "type", method: "type",
  assert: "tool", command: "tool", cmd: "tool", "tool / command": "tool",
  evidence: "check", expected: "threshold", pass: "threshold",
  anchor: "anchors_to",
};
// First cells that name the criterion column. A header is recognized when its first
// cell is one of these and every other cell is a column word (below), so no
// data row — whose first cell is an ID like `ISC-3` — can ever read as one.
const ID_HEADER_WORDS: ReadonlySet<string> = new Set(["isc", "id", "claim", "isc range", "isc id", "criterion"]);
const EXTRA_HEADER_WORDS: ReadonlySet<string> = new Set(["probe", "notes", "note", "status", "result", "why", "owner", "cadence"]);
const isHeaderWord = (cell: string): boolean => {
  const c = cell.trim().toLowerCase();
  return c in HEADER_ALIASES || EXTRA_HEADER_WORDS.has(c);
};
// Legacy fixed order, used only as a fallback for a field the header never
// names — so a table whose header is silent about a column (Bunker's own test
// fixtures never name `stage`) keeps parsing exactly as it always has.
const LEGACY_INDEX: Readonly<Record<Field, number>> = {
  isc: 0, type: 1, check: 2, threshold: 3, tool: 4, anchors_to: 5, severity: 6, tier: 7, stage: 8,
};

// Resolve each semantic field to a cell index for THIS table's header. A
// header-named column always wins. An unnamed field falls back to its legacy
// position, but NEVER onto an index another column already claimed by name —
// that collision is exactly how "tool" got read as "severity": a header that
// renames/reorders columns must not have an unrelated field's blind guess
// land on the same cell. The fallback applies regardless of whether the
// legacy position is numerically beyond the header's own declared width:
// real tables routinely name only the "core" columns (isc/type/check/
// threshold/tool[/anchors_to]) and still supply severity/tier/stage as
// trailing cells the header never bothered to label — an out-of-range read on
// a short row is already `undefined` downstream (every extraction site falls
// back to `""`), so there is no unsafe case to guard against, only the
// same-cell collision above.
export function resolveColumns(header: string[] | null): Record<Field, number> {
  const idx: Partial<Record<Field, number>> = {};
  const claimed = new Set<number>();
  if (header) {
    const words = header.map((cell) => cell.trim().toLowerCase());
    const namesCommand = words.some((w) => HEADER_ALIASES[w] === "tool");
    words.forEach((word, i) => {
      const key = word === "probe" ? (namesCommand ? "check" : "tool") : HEADER_ALIASES[word];
      if (key && idx[key] === undefined) {
        idx[key] = i;
        claimed.add(i);
      }
    });
  }
  for (const key of Object.keys(LEGACY_INDEX) as Field[]) {
    if (idx[key] !== undefined) continue;
    const legacyPos = LEGACY_INDEX[key];
    if (claimed.has(legacyPos)) continue; // another named column already owns this cell
    idx[key] = legacyPos;
  }
  return idx as Record<Field, number>;
}

// Markdown authors wrap a probe command in backticks so the table renders as
// code. The backticks are FORMATTING, not part of the command — strip a single
// wrapping pair. This is load-bearing: `compileTool` anchors its patterns with
// ^…$, so a backticked command never compiles to a cloud check and silently
// falls back to local-only. A production app ISA rewrite backticked its rows and
// quietly dropped them all out of the cloud plane (found 2026-07-26 when the
// regenerated manifest came back shorter than the deployed one).
//
// Only an ENTIRELY wrapped cell is unwrapped, so genuine inline substitution
// (`echo \`date\``) is untouched.
export function unwrapCode(cell: string): string {
  const t = cell.trim();
  return t.length > 1 && t.startsWith("`") && t.endsWith("`") ? t.slice(1, -1).trim() : cell;
}

export function splitRow(line: string): string[] {
  // Split on unescaped pipes only. A probe command can contain a literal pipe
  // by escaping it as `\|` (standard markdown table escaping) — split on `|`
  // not preceded by a backslash, then unescape. Without this, any probe with a
  // shell pipe or `||` gets truncated mid-command (seen in a real app ISA).
  return line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

export function isTestStrategyHeader(cells: string[]): boolean {
  const first = cells[0]?.trim().toLowerCase() ?? "";
  // Preserve the long-standing ISC recognition for reordered legacy headers;
  // ID/claim aliases require the canonical type cell so ordinary data cannot
  // be mistaken for a header.
  if (first === "isc" || ((first === "id" || first === "claim")
    && cells[1]?.trim().toLowerCase() === "type")) return true;
  // Author headers (`| Claim | Probe |`, `| ID | Probe | Tool |`): an ID word
  // first and nothing but column words after it.
  return ID_HEADER_WORDS.has(first) && cells.length >= 2 && cells.slice(1).every(isHeaderWord);
}

// ── Type inference for rows whose type word is not a probe type ──────────────
// Authors write what they meant to check (`grep`, `code`, `structural`,
// `behavioral`, common in the 2026-09-24 census). The word says intent;
// the TOOL cell says what actually runs, so the type is read from the tool.
// Inference only ever yields bash, bun-test, curl, or manual: it never turns a
// row into a model-priced one, and anything that is not unmistakably a shell
// command is manual — an honest visible exception, never a probe that runs prose.
const COMMAND_WORDS: ReadonlySet<string> = new Set([
  "rg", "grep", "test", "[", "[[", "bash", "sh", "zsh", "bun", "bunx", "git", "jq", "wc", "diff", "cmp",
  "ls", "fd", "find", "cat", "head", "tail", "sed", "awk", "sqlite3", "gh", "stat", "shasum",
  "sha256sum", "plutil", "launchctl", "printf", "echo", "curl", "wrangler", "cd", "!",
]);
// A shell command carries at least one of: a flag, a path or file name, a quote,
// a shell operator, or a variable. "grep new class strings in source" has none.
const SHELL_EVIDENCE = /(^|\s)-{1,2}[A-Za-z]|[\/~]|\.[A-Za-z]{1,5}\b|["']|&&|\|\||\||;|>|\$[\w{(]/;

/** The probe type a tool cell implies, or null when the cell is not a runnable command. */
export function inferTypeFromTool(toolCell: string): "bash" | "bun-test" | "curl" | null {
  let t = unwrapCode(toolCell).trim();
  // Leading env assignments (`FOO=1 cmd`) don't change what runs.
  while (/^[A-Z_][A-Z0-9_]*=\S*\s/.test(t)) t = t.replace(/^[A-Z_][A-Z0-9_]*=\S*\s+/, "");
  const first = t.split(/\s+/)[0] ?? "";
  const isScriptPath = /^(\.{1,2}\/|~\/|\/)\S+/.test(first);
  if (!COMMAND_WORDS.has(first) && !isScriptPath) return null;
  if (!isScriptPath && !SHELL_EVIDENCE.test(t.slice(first.length))) return null;
  if (looksLikeProse(t)) return null;
  if (/^bun\s+test\b/.test(t)) return "bun-test";
  // A curl that writes (a method other than GET/HEAD, or a body) is never
  // inferred: an author who never wrote `curl` never agreed to send it.
  if (first === "curl") return /(^|\s)(-X\s*(?!GET\b|HEAD\b)\w+|--request\s+(?!GET\b|HEAD\b)\w+|-d\b|--data\S*|-F\b|--form\b|-T\b|--upload-file\b)/i.test(t) ? null : "curl";
  return "bash";
}

// Prose that happens to start with a command word and mention a file
// ("grep src/foo.ts for the new handler"): once quoted strings are removed, a run
// of three bare lowercase words that includes a function word is English, not
// arguments. Real commands put their words inside quotes.
const FUNCTION_WORDS: ReadonlySet<string> = new Set(["the", "a", "an", "for", "that", "with", "and", "is", "are", "of", "to", "in", "on", "it", "its", "was", "has", "each", "every", "all", "new", "shows", "exists"]);
function looksLikeProse(command: string): boolean {
  const tokens = command.replace(/"[^"]*"|'[^']*'/g, " ").split(/\s+/).filter(Boolean);
  let run: string[] = [];
  for (const tok of tokens) {
    if (/^[a-z]+[,.]?$/.test(tok)) {
      run.push(tok.replace(/[,.]$/, ""));
      if (run.length >= 3 && run.some((w) => FUNCTION_WORDS.has(w))) return true;
    } else run = [];
  }
  return false;
}

/** A type word that is a probe type once case, backticks and spaces are normalized. */
export function normalizeTypeWord(word: string): ProbeType | null {
  const w = unwrapCode(word).trim().toLowerCase().replace(/\s+/g, "-");
  return isProbeType(w) ? w : null;
}

// Full diagnostic parse: every in-section data row becomes EITHER a probe OR a
// dropped row with a reason. Nothing is silently discarded. This is the honest
// primitive; `parseTestStrategy` is the back-compat view over it.
export function parseTestStrategyDiagnostic(isaPath: string): TestStrategy {
  return parseTestStrategyText(readFileRetry(isaPath), isaPath);
}

/** The same diagnostic parse over ISA text already in hand (the ISA row repair tool re-parses a candidate before it writes). `isaPath` resolves the Evals section's ISA-relative producers. */
export function parseTestStrategyText(text: string, isaPath: string): TestStrategy {
  const probes: Probe[] = [];
  const dropped: DroppedRow[] = [];
  const rawRows = new Map<Probe, string>();
  const repaired: RepairedRow[] = [];
  const invalid: InvalidRow[] = [];
  const evals = parseEvalsText(text, isaPath);
  let inSection = false;
  let header: string[] | null = null;
  let col: Record<Field, number> = resolveColumns(null);

  for (const raw of text.split("\n")) {
    const line = raw.trim();

    if (line.startsWith("## ")) {
      inSection = /^##\s+Test Strategy\b/i.test(line);
      if (!inSection) { header = null; col = resolveColumns(null); }
      continue;
    }
    if (!inSection || !line.startsWith("|")) continue;

    let cells = splitRow(line);

    if (isTestStrategyHeader(cells)) { header = cells; col = resolveColumns(header); continue; } // header row
    if (cells.every((c) => c === "" || SEPARATOR.test(c))) continue; // separator row

    // An unescaped shell pipe inside the tool command splits the row into MORE cells
    // than the header names, and the command runs truncated at the pipe (a production app lost
    // RPT-7b and RPT-A4 to this, 2026-09-15).
    // The extra cells can only have come from the command, so fold them back into it —
    // the row parses exactly as the author meant, and the repair is recorded so the
    // author can escape the pipe as `\|` and make the table honest.
    // A header may legitimately be narrower than the row (severity/tier/stage supplied
    // positionally), so the trigger is a cell past the header that could never be one of
    // those: not blank, not a bare word or word@cadence, not an integer.
    const expected = header ? header.length : DEFAULT_COLUMNS;
    const couldBePositional = (c: string): boolean => c === "" || /^[a-z]+(@[a-z0-9]*)?$/i.test(c) || /^\d+$/.test(c);
    if (cells.length > expected && col.tool < cells.length && cells.slice(expected).some((c) => !couldBePositional(c))) {
      const extra = cells.length - expected;
      const folded = cells.slice(col.tool, col.tool + extra + 1).join(" | ");
      cells = [...cells.slice(0, col.tool), folded, ...cells.slice(col.tool + extra + 1)];
      repaired.push({ isc: cells[0] ?? "", reason: `unescaped pipe in the tool command split the row into ${expected + extra} cells; folded ${extra} back into the command — escape it as \\| in the ISA` });
    }

    // A data row that can't be a probe is SURFACED, never silently skipped.
    // Under a recognized header the header says which cell is which, so a short
    // row parses when it names its criterion and carries something to run or read;
    // without a header the positional contract still needs five cells.
    const shortOk = header !== null && (cells[col.isc] ?? "").trim() !== ""
      && ((cells[col.tool] ?? "").trim() !== "" || (cells[col.check] ?? "").trim() !== "");
    if (cells.length < MIN_CELLS && !shortOk) {
      dropped.push({
        raw: line,
        reason: header
          ? `no ISC id or nothing to check under this header (needs an ISC cell plus a tool or probe cell)`
          : `too few columns (${cells.length} < ${MIN_CELLS}; expected isc | type | check | threshold | tool [| anchors_to])`,
      });
      continue;
    }

    // A type word that is not a probe type takes its type from the tool cell
    // (see inferTypeFromTool) and is REPORTED in `repaired`, so the author sees
    // the row was read differently from how it was written. When the tool cell
    // is not a command either, the row is INVALID (20261010-evals-in-the-isa
    // ISC-4): kept out of `probes`, never coverage, listed in `invalid` and
    // `repaired`. It used to become `manual`, an attestation nobody wrote.
    // `parseTestStrategy` does not throw on it (ISAGate warns until the M4
    // migration), so live ISAs of peer sessions do not start failing mid-flight.
    const rawType = cells[col.type] ?? "";
    let type: ProbeType;
    let typeRepaired = false;
    let isInvalid = false;
    let toolCell = cells[col.tool] ?? "";
    const normalized = normalizeTypeWord(rawType);
    if (normalized && normalized === rawType) {
      type = normalized;
    } else {
      // A header with no command column (`| Criterion | Verifier | Probe |` after
      // `probe` resolved to the command, or `| ID | Probe | Anchors to |`) keeps
      // the runnable text in whichever cell it has; read it from there.
      const runnable = toolCell.trim() || (cells[col.check] ?? "");
      const read = normalized ?? inferTypeFromTool(runnable);
      if (read === null) {
        // Validated below as an inert `manual` row, so a typo'd
        // severity, lane or cadence still drops loudly (fail-closed parity);
        // then routed to `invalid` instead of `probes`.
        isInvalid = true;
        repaired.push({
          isc: cells[col.isc] ?? "",
          reason: `type "${rawType || "(none)"}" is not a probe type and the tool cell is not a command; the row is invalid and counts as no coverage — write a probe type (\`manual\` when a person checks it)`,
        });
      }
      type = read ?? "manual";
      if (!toolCell.trim() && type !== "manual") toolCell = runnable;
      typeRepaired = true;
      const runsWhen = type === "manual" ? "" : "; until then it runs only on `bunker test --deep`, never on a monitor";
      if (!isInvalid) repaired.push({
        isc: cells[col.isc] ?? "",
        reason: normalized
          ? `type "${rawType}" read as ${type}; write it as \`${type}\` in the ISA${runsWhen}`
          : `type "${rawType || "(none)"}" is not a probe type; read as ${type} from the tool cell — write \`${type}\` in the ISA${runsWhen}`,
      });
    }

    // `eval:#<id>` in the tool cell points at that id's `## Evals` block. The row
    // must be written `eval`, and the block must exist and parse; anything else
    // is dropped with its reason, never run as a suite name.
    const ref = evalRefOf(toolCell);
    let staged: StagedEval | undefined;
    if (ref) {
      if (type !== "eval" || typeRepaired) {
        dropped.push({ raw: line, reason: `eval ref "eval:#${ref}" needs type \`eval\` (got "${rawType || "(none)"}")` });
        continue;
      }
      staged = evals.evals.get(ref);
      if (!staged) {
        const why = evals.errors.find((e) => e.reason.startsWith(`${ref}:`));
        dropped.push({ raw: line, reason: why ? `eval ref "eval:#${ref}": ${why.reason}` : `eval ref "eval:#${ref}" has no block under ## Evals` });
        continue;
      }
    }

    // Column 6 is severity ONLY when it looks like a severity token — a single
    // bare word. Rows with an unescaped shell pipe in the tool command split
    // into extra cells, landing things like "derived: versioning" in slot 6;
    // those predate this column and must keep parsing exactly as before
    // (caught when probes vanished from a real ISA).
    //
    // A single bare word that ISN'T a valid severity is a real authoring typo,
    // and it's dropped loudly: "criticl" silently becoming a normal row would
    // page an outage as a yellow footnote — the one direction that must never
    // fail quietly.
    const sevCell = (cells[col.severity] ?? "").toLowerCase();
    const looksLikeSeverity = /^[a-z]+$/.test(sevCell);
    if (looksLikeSeverity && !PROBE_SEVERITIES.includes(sevCell as ProbeSeverity)) {
      dropped.push({
        raw: line,
        reason: `unknown severity "${cells[col.severity]}" (valid: ${PROBE_SEVERITIES.join(", ")}, or blank)`,
      });
      continue;
    }
    const severity: ProbeSeverity = looksLikeSeverity ? (sevCell as ProbeSeverity) : "normal";

    // Column 7 is tier under the same bare-word guard as severity: pipe-split
    // rows landing prose in slot 7 keep parsing as fast, and a typo'd tier is
    // dropped loudly — "depe" quietly becoming fast would put an hours-long
    // soak probe into the blocking deploy gate.
    // The cell may also carry a cadence suffix (`deep@6h`, v2.25.0). Anything
    // made only of tier-shaped characters is an authoring ATTEMPT and must
    // either parse fully or drop loudly — `deep@6` (no unit) or `fast@1h` (a
    // cadence on the blocking tier) silently becoming a fast row is exactly the
    // spend-in-the-deploy-gate failure the suffix exists to prevent.
    const tierCell = (cells[col.tier] ?? "").toLowerCase();
    const looksLikeTier = /^[a-z][a-z0-9@]*$/.test(tierCell);
    const tierMatch = looksLikeTier ? TIER_CELL.exec(tierCell) : null;
    const explicitLane = tierMatch ? laneOf(tierMatch[1]!) : null;
    if (looksLikeTier && (!tierMatch || explicitLane === null)) {
      dropped.push({
        raw: line,
        reason: `unknown tier "${cells[col.tier]}" (valid: ${LANE_WORDS.join(", ")}, optionally integrity@<N>m|h|d, or blank)`,
      });
      continue;
    }
    const every = tierMatch?.[2] ? parseCadence(`${tierMatch[2]}${tierMatch[3]}`) : null;
    if (tierMatch?.[2] && (every === null || explicitLane !== "integrity")) {
      dropped.push({
        raw: line,
        reason: `bad cadence "${cells[col.tier]}" (a cadence rides the integrity lane only: integrity@<N>m|h|d or the legacy deep@…, N > 0)`,
      });
      continue;
    }
    // `eval` rows are model-priced (EvalRunner dispatch) and default to the
    // integrity lane — Bunker's clock, never the blocking dev/deploy loop, never
    // the liveness lane. Anything checked often is 100% asserts (the principal,
    // 2026-09-08), so an explicit liveness/fast on an eval row is a dropped
    // row, not a deliberate choice. (Supersedes M4, 20260831-eval-assert-system.)
    // A row whose type was read rather than written runs only when someone asks
    // for a full run (`bunker test --deep`): the build lane never reaches a
    // monitor tick or the cloud manifest. It counts for coverage at once, and
    // starts running on the clock the day its author writes the type.
    const typeWasRead = typeRepaired;
    const lane: ProbeLane = typeWasRead && type !== "manual" ? "build" : explicitLane ?? (isJudgedType(type) ? "integrity" : "liveness");
    if (type !== "manual" && DEPLOY_CALL_TOOL(unwrapCode(toolCell))) {
      dropped.push({ raw: line, reason: "probe deploys: a check never ships; make it manual or check the deployed state instead" });
      continue;
    }
    if (lane === "liveness" && !isJudgedType(type) && MODEL_CALL_TOOL(unwrapCode(toolCell))) {
      dropped.push({
        raw: line,
        reason: `inference on the liveness lane (a ${type} row that starts a model): move it to integrity or build`,
      });
      continue;
    }
    if (lane === "liveness" && isJudgedType(type)) {
      dropped.push({
        raw: line,
        reason: `inference on the liveness lane ("${cells[col.tier]}"): ${type === "eval" ? "an eval" : `a ${type}`} row runs on integrity or build only`,
      });
      continue;
    }
    if (type === "glance" && !/^glance:[A-Za-z0-9_-]+(?:\.json)?#[A-Za-z0-9_.-]+$/.test(unwrapCode(toolCell))) {
      dropped.push({ raw: line, reason: "invalid glance pointer (expected glance:<question-file>#<question-id>)" });
      continue;
    }
    if (UNFAILABLE_BUN_E(unwrapCode(toolCell))) {
      dropped.push({ raw: line, reason: "unfailable bun -e: a require() script with no await that fails by throw exits 0 (Bun 1.3.6); fail with process.exit(1)" });
      continue;
    }
    const tier = staged ? staged.tier : tierOfType(type);

    // Column 8 is stage. Only a positive integer is read as one; anything else
    // in slot 8 (a bare word, a `0`, prose) is left alone, because rows with an
    // unescaped pipe in the check or tool cell shift a threshold or a tool word
    // into this slot (live ISAs did on 2026-09-08) and none of those can
    // express a stage-2 intent — the only intent whose loss would be dangerous.
    const stageCell = (cells[col.stage] ?? "").trim();
    const stage = /^[1-9]\d*$/.test(stageCell) ? Number(stageCell) : isJudgedType(type) ? 2 : 1;

    if (isInvalid) {
      invalid.push({
        isc: cells[col.isc] ?? "", type: "invalid", rawType, check: cells[col.check] ?? "",
        tool: unwrapCode(toolCell), anchors_to: cells[col.anchors_to] ?? "", raw: line,
      });
      continue;
    }
    probes.push({
      isc: cells[col.isc] ?? "",
      type,
      check: cells[col.check] ?? "",
      threshold: cells[col.threshold] ?? "",
      tool: unwrapCode(toolCell),
      anchors_to: cells[col.anchors_to] ?? "",
      severity,
      tier,
      lane,
      stage,
      ...(every ? { every } : {}),
      ...(staged ? { evalRef: ref!, staged } : {}),
    });
    rawRows.set(probes[probes.length - 1]!, line);
  }

  const accepted = probes.filter(p => {
    if (p.type !== "glance") return true;
    const highest = Math.max(1, ...probes.filter(other => other.isc === p.isc && !isJudgedType(other.type) && other.type !== "manual").map(other => other.stage));
    if (p.stage > highest) return true;
    dropped.push({ raw: rawRows.get(p)!, reason: `glance stage must exceed stage 1 and every deterministic stage of the same criterion (highest: ${highest})` });
    return false;
  });
  // A broken block no row points at is still surfaced: nothing in the ISA is silently skipped.
  for (const e of evals.errors) {
    if (!dropped.some((d) => d.reason.endsWith(e.reason))) dropped.push({ raw: e.raw, reason: `Evals block: ${e.reason}` });
  }
  return { probes: accepted, dropped, repaired, invalid, evals };
}

// Back-compat view: probes only, and STILL fail-closed on a row whose author
// stated an intent the parser cannot honor — a misspelled severity, lane or
// cadence, inference on the liveness lane, a malformed glance pointer. sync-cloud,
// the monitor and claim-hash binding rely on this: such a row must not compile to
// a half-valid manifest or run as something its author did not write.
// A non-canonical TYPE word is no longer in this class (2026-09-24): its type is
// read from the tool cell, reported in `repaired`, and kept on the build lane.
// Under-column rows don't throw here; callers that want them use the diagnostic.
// An `eval:#<id>` row whose block is missing, malformed or mistyped, and a broken
// `## Evals` block, are in this class too (S067, 2026-10-15): dropping them here
// made the criterion's staged eval vanish from sync-cloud, the monitor and attest
// with no error, the same quiet half-manifest this view exists to refuse.
const FAIL_CLOSED = /^(unknown probe type|unknown severity|unknown tier|bad cadence|inference on the liveness lane|invalid glance pointer|unfailable bun -e|probe deploys|eval ref "eval:#|Evals block: )/;
export function parseTestStrategy(isaPath: string): Probe[] {
  const { probes, dropped } = parseTestStrategyDiagnostic(isaPath);
  const bad = dropped.find((d) => FAIL_CLOSED.test(d.reason));
  if (bad) {
    throw new Error(
      `Unparseable Test Strategy row in ${isaPath}: ${bad.reason} — row: ${bad.raw}`,
    );
  }
  return probes;
}

// ── Criterion coverage ────────────────────────────────────────────────────────
// "The spec IS the test suite" is only true to the degree each CRITERION has a
// runnable probe. Coverage makes the gap visible: a green board over an
// under-probed ISA is itself a finding.

// Every criterion/ISC id in the ISA body — checkbox lines under Criteria/Claims (legacy)/
// Features. The id may contain hyphens (ISC-7.2, H-AUTH-GATE, CRS-PAGE); the
// separator that ENDS it is `:` or an em-dash, never a plain hyphen — so lazy-
// match the id up to the first `:`/`—` to avoid truncating `H-AUTH-GATE` to
// `H-AUTH`.
//
// Three shapes the 2026-08-31 retrofit found invisible to the old regex, now
// parsed (every criterion must carry an assert, so an unseen criterion is a hole):
//   `- [ ] Anti: ISC-70: …`            → id ISC-70 (was the pseudo-id "Anti")
//   `- [ ] CRS-FULFILL \`[MARK]\`: …`  → id CRS-FULFILL (backtick marker before the colon)
//   `- [x] ISC-149 (REVISED …): …`     → id ISC-149 (parenthetical before the colon)

export function parseClaimIds(isaPath: string): string[] {
  return parseIsaClaims(isaPath).claims.map(c => c.id);
}

export interface Coverage {
  totalClaims: number;
  coveredClaims: number; // criteria with >=1 runnable (non-manual, tooled) probe
  probedClaims: number; // criteria with any Test Strategy row (incl. manual)
  // Assert-coverage view (2026-08-31, every-ISC-an-assert doctrine): an ASSERT
  // is any non-`manual` row — deterministic (bash/bun-test/bun-property/curl/
  // screenshot) or judged (eval, pairwise). `manual` is the attested exception class.
  assertedClaims: number; // criteria with >=1 non-manual row
  manualOnly: string[]; // criterion ids whose ONLY rows are manual — the exceptions
  unprobed: string[]; // criterion ids with ZERO rows of any kind
  droppedRows: number;
  uncovered: string[]; // criterion ids with no runnable probe
  // Criterion ids whose only rows are invalid (an unknown type word over a
  // non-command tool). Never coverage: they are in none of the counts above and
  // not in `unprobed` (they have a row; ISAGate decides what that row is worth).
  invalid: string[];
}

const RUNNABLE = new Set(["bash", "bun-test", "bun-property", "curl"]);

// A tombstone (`- [ ] ISC-N: [DROPPED — see Decisions]`, ISAFormat § IDs) keeps its id
// for history but is no longer a criterion, so coverage neither counts it nor asks it for a row.
const TOMBSTONE_RE = /^\s*[-*]\s+\[[ xX~]\]\s+([A-Za-z][\w.-]*)\s*:\s*\[DROPPED\b/gm;

export function coverageOf(isaPath: string): Coverage {
  const tombstones = new Set([...readFileRetry(isaPath).matchAll(TOMBSTONE_RE)].map((m) => m[1]!));
  const claims = parseClaimIds(isaPath).filter((id) => !tombstones.has(id));
  const { probes, dropped, invalid = [] } = parseTestStrategyDiagnostic(isaPath);
  // A criterion is covered when a runnable probe EITHER carries its id directly OR
  // anchors_to it — two-level ISAs (H3: feature criterion H-AVAIL, probe rows H-1..H-6
  // with anchors_to H-AVAIL) probe the feature through its leaves. Credit both.
  const idsOf = (subset: Probe[]): Set<string> => {
    const ids = new Set<string>();
    for (const p of subset) {
      if (p.isc) ids.add(p.isc);
      if (p.anchors_to) ids.add(stripAnchorPrefix(p.anchors_to));
    }
    return ids;
  };
  // An eval-ref row is runnable when its block has a code stage, and an assert
  // unless every stage is manual.
  const runnableIds = idsOf(probes.filter((p) => (RUNNABLE.has(p.type) && p.tool) || p.staged?.stages.some((s) => s.tier === "code")));
  const probedIds = idsOf(probes);
  const assertedIds = idsOf(probes.filter((p) => p.type !== "manual" && (!p.staged || p.staged.stages.some((s) => s.tier !== "human"))));
  const invalidIds = new Set(invalid.flatMap((r) => [r.isc, ...(r.anchors_to ? [stripAnchorPrefix(r.anchors_to)] : [])]));
  const uncovered = claims.filter((id) => !runnableIds.has(id));
  return {
    totalClaims: claims.length,
    coveredClaims: claims.filter((id) => runnableIds.has(id)).length,
    probedClaims: claims.filter((id) => probedIds.has(id)).length,
    assertedClaims: claims.filter((id) => assertedIds.has(id)).length,
    manualOnly: claims.filter((id) => probedIds.has(id) && !assertedIds.has(id)),
    unprobed: claims.filter((id) => !probedIds.has(id) && !invalidIds.has(id)),
    droppedRows: dropped.length,
    uncovered,
    invalid: claims.filter((id) => invalidIds.has(id) && !probedIds.has(id)),
  };
}

// anchors_to cells carry a prefix on derived/cross anchors: `derived: session-security`,
// `cross: some-slug`, or a bare criterion id / `literal`. Return the referenced id.
function stripAnchorPrefix(a: string): string {
  const m = a.match(/^(?:derived|cross)\s*:\s*(.+)$/i);
  return (m ? m[1]! : a).trim();
}
