/**
 * @version 1.4.0
 * FrontDoor.ts — the Router's entry point: every prompt gets a rung, a lane, an effort and a runner.
 * Glance decides (v1.2.0, 2026-09-24): eighteen engine nouls plus the previous reply feed the learned
 * lane and effort heads in lane-model.json. On a set of real typed prompts, graded against a blind
 * Opus/Fable/Astra majority with whole sessions held out, it beat the Opus classifier clearly on lane and
 * came close to it on effort, and many of the classifier's hand-offs were wrong. The classifier now
 * runs only as the fallback and for the thinking-skill list on depth prompts.
 *
 * 1.3.0 (2026-09-25, Router ISA R46–R53): the decision carries the effort distribution, the paste flag
 * and the engine failure cause, all logged with turn, binding and agent; long prompts are redacted whole and
 * then cut head-and-tail; secrets are checked before the short/ack rescue; the blast floor holds on the
 * learned pick; the classifier child is bounded by its own budget. The effort distribution is what
 * EffortPolicy.ts acts on for the carrier (R42).
 *
 * 1.4.0 (2026-10-10, Assay ISA ISC-63..65): the lane, effort and thinking heads carry engine_model, the engine their
 * training answers came from, and act only when it is the live engine (CROSS_VENDOR.assayEngine); a stale head sits out,
 * the Opus classifier answers, and the decision row names it in staleHeads. The heads were refitted on Clef-omni answers.
 * The engine state folds whitespace runs in the prompt (engineState), the one builder the live ask and the refit share.
 *
 * Versioned because the turn ledger stamps it on every record (era.router in
 * LIFEOS/TOOLS/TurnOutcomes.ts): a routing change has to be visible as an era boundary, or a
 * before/after comparison silently spans two different routers.
 *
 * Uses Assay's judgment layer (LIFEOS/DOCUMENTATION/Assay/AssaySystem.md).
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ask, decide, safeCallerConfig, yesAt, type Decision } from "../ASSAY/Assay";
import { inference, type InferenceResult } from "../TOOLS/Inference";
import { EngineError, redactForEngine, resolveApiKey, type EngineResponse, type NoulAnswer, type Questions } from "../ASSAY/Engine";
import { CROSS_VENDOR, WORK_LADDER, type EffortLevel } from "../TOOLS/models";
import { lifeosPath } from "../TOOLS/Paths";
import { invariant } from "../TOOLS/Invariant";
import { holdoutArm, loadHoldout, type HoldoutConfig } from "./Holdout";
import { SECRET_VALUE_SHAPES } from "../../hooks/lib/egress-shapes";
import { laneName } from "../../hooks/lib/route-label";
import { loadThinkingModel, predictThinking, type ThinkingModel, type ThinkingPrediction } from "./ThinkingQuestions";
import { DEFAULT_THINKING, THINKING_SHAPES, THINKING_SKILLS, matchDepthDirective, validThinking, type ThinkingSkill } from "./Depth";
import { LANE_QUESTIONS, NOULS, composeLane, loadLaneModel, predictLane, type LaneModel, type Prediction } from "./LaneQuestions";
import { readFableBudget, type FableBudget, type FableStatus } from "./FableBudget";

export type { Effort, Lane } from "../../hooks/lib/lane-rules";
import { EFFORTS, EFFORT_AXIS, EFFORT_LEVELS, clampEffort, type Effort, type Lane } from "../../hooks/lib/lane-rules";
export type FrontDoor = "claude" | "codex";
/** "jev" names Glance's learned pick; the value is kept because router-decisions.jsonl stores it (the engine Jev, retired 2026-10-10). */
export type Source = "directive" | "jev" | "opus" | "skip" | "unavailable";
export type GlancePick = { pick: Lane | null; confidence: number | null; mode: Decision["mode"] };
/**
 * The Algorithm's Route step. Every verdict is advisory (2026-09-29: "the router should just provide guidance, not
 * prescriptive controls"; 2026-10-16 native-unblock ISC-16: depth words too). `binding` records that the principal's
 * own depth words matched; the line reports it with the skills that may fit and prescribes nothing.
 * `effort` is the classifier's effort pick (xhigh on a depth directive, null when nothing picked one).
 * `agent` is the concrete runner: the base Claude agent name for opus/sonnet/haiku/fable (the picked
 * `effort` rides beside it and is passed as the Agent tool's `effort` parameter), a `Worker.ts` command
 * for the codex lanes, null for inline or no pick.
 * `directive` is the principal's own depth phrase when one matched (it forces Opus at xhigh, or Astra
 * when the classifier said astra).
 */
export type RouteDecision = { lane: Lane | null; level: EffortLevel | null; effort: Effort | null; agent: string | null; delegate: boolean; source: Source;
  /** Glance's pick. Named `jev` because router-decisions.jsonl stores it under that key (the engine Jev, retired 2026-10-10). */
  jev: GlancePick | null; classifierPick: Lane | null; latencyMs: number; engineResponse: EngineResponse | null; skipReason?: SkipReason; turn: string; binding: boolean; thinking: ThinkingSkill[]; directive: string | null;
  /** The learned effort head's probability per level; null unless Glance decided (R42 reads it). */
  effortProbs: Record<Effort, number> | null;
  /** The prompt arrived wrapped as a paste, which is how dictation arrives; the labelled set has none (R42 never lowers it). */
  dictated: boolean;
  /** Why the engine gave no answer, when it did not: budget, timeout, no-key, network, http, shape, disabled (R46). Stored under this key in router-decisions.jsonl (Jev, retired 2026-10-10). */
  jevError: string | null;
  /** The learned thinking plan (thinking-model.json): skill or sequence and mode; null when the model or an answer is missing. */
  thinkingPlan?: ThinkingPrediction | null;
  /** The router holdout arm (Holdout.ts): true held out (no route line, no effort change), false routed. Absent when the switch is off or the turn is not in the experiment. */
  holdout?: boolean;
  /** A learned head that sat out because it was fitted on another engine (ISC-63): the engine its file names, per head. Absent when every head fits. */
  staleHeads?: { lane?: string; thinking?: string };
  /** Router ISA F9 (R137): set whenever the pick was Fable. `to` is "fable" when the budget kept it, else the lane it moved to. */
  fable?: { status: FableStatus; room: number | null; to: Lane } };

/**
 * The lane rubric and both axes live in `hooks/lib/lane-rules.ts` — a leaf module the PreToolUse guards can
 * read without pulling Glance, the engine or Inference in. Re-exported here so every existing importer of
 * FrontDoor keeps working and there is still exactly one definition (R34).
 */
export { BLAST_FLOOR, CRAFT_AXIS, LANE_INSTRUCTIONS, LANE_RULES, RESIDUAL_AXIS, laneMenu } from "../../hooks/lib/lane-rules";
import { LANE_INSTRUCTIONS, LANE_RULES } from "../../hooks/lib/lane-rules";

export const ROUTER_QUESTIONS: Questions = {
  lane: { type: "choice", instructions: LANE_INSTRUCTIONS, criteria: LANE_RULES },
};
export const CLASSIFIER_SYSTEM = `${LANE_INSTRUCTIONS} ${EFFORT_AXIS} ${EFFORT_LEVELS} Return JSON only: {"route":"inline|haiku|sol|sonnet|opus|astra|fable","effort":"${EFFORTS.join("|")}","thinking":[...]}. When effort is xhigh or route is astra or fable, thinking names the 1-3 thinking skills whose shape fits the work, from: ${THINKING_SKILLS.join(", ")} (${THINKING_SKILLS.map((s) => `${s}: ${THINKING_SHAPES[s]}`).join("; ")}). Otherwise thinking is [].\n${Object.entries(LANE_RULES).map(([lane, rule]) => `${lane}: ${rule}`).join("\n")}`;
/** Appended to the system prompt only when the user prompt carries the end of the previous reply. */
export const PREVIOUS_REPLY_NOTE = "The user prompt opens with the end of the previous assistant reply, then the principal's prompt. Judge THIS prompt in light of the previous reply: a short follow-up inherits the work that reply was about.";
/** The previous reply is context, not the task: a bounded tail of it is all either runner sees. */
export const PREVIOUS_REPLY_MAX_CHARS = 800;

/** The classifier's two prompts. Without a previous reply both are exactly what they were before it existed. */
export function classifierPrompts(prompt: string, previousReply: string | null): { system: string; user: string } {
  if (!previousReply) return { system: CLASSIFIER_SYSTEM, user: prompt };
  return { system: `${CLASSIFIER_SYSTEM}\n${PREVIOUS_REPLY_NOTE}`, user: `Previous assistant reply (end):\n${previousReply}\n\nPrincipal's prompt:\n${prompt}` };
}

/**
 * The previous reply as either runner may see it: redacted like the prompt, then its last
 * PREVIOUS_REPLY_MAX_CHARS kept (redacting first, so a cut never leaves half a secret unredacted).
 * Null when empty, or when a secret shape survives redaction: context is optional, a leak is not.
 */
export function safePreviousReply(reply: unknown): string | null {
  if (typeof reply !== "string") return null;
  const redacted = redactForEngine(reply.replace(/\s+/g, " ").trim(), Number.POSITIVE_INFINITY);
  const tail = (redacted.length > PREVIOUS_REPLY_MAX_CHARS ? redacted.slice(-PREVIOUS_REPLY_MAX_CHARS) : redacted).toWellFormed();
  if (!tail) return null;
  if (SECRET_VALUE_SHAPES.some(re => { re.lastIndex = 0; return re.test(tail); })) return null;
  return tail;
}

const GREETINGS = new Set(["hi", "hello", "hey", "yo", "thanks", "thank you", "ok", "okay", "yes", "no", "do it", "go", "proceed", "continue", "y", "si"]);
const DIRECTIVE = /^\/route\s+(inline|haiku|sol|opus|astra|fable|advisor)(?:\s+([\s\S]*))?$/i;
/** Text the harness or a hook authored, never the principal. A typed prompt that merely starts with `[` or `<` still routes (Astra audit, 2026-09-19). */
const SYSTEM_TEXT = /^(?:<(?:task-notification|system-reminder|local-command-[a-z]+|command-(?:name|message|args)|user-prompt-submit-hook|bash-(?:input|stdout|stderr)|agent-message|teammate-message|cross-session-message)\b|\[SYSTEM NOTIFICATION|\[Request interrupted)/i;
/** Plain-text hand-backs the harness writes into the prompt slot (cross-session messages, skill bodies, hook feedback). Anchored at the start and case-sensitive, so a typed prompt that quotes them later still routes (Router ISA F4, 2026-10-10). */
const HANDBACK_TEXT = /^(?:Another Claude session sent a message|Base directory for this skill:|Stop hook feedback:)/;
export type SkipReason = "opt-out" | "headless" | "slash" | "ack" | "short" | "injected" | "not-public";

/**
 * The principal's own words: paste wrappers dropped wherever they sit, image placeholders removed.
 * A real prompt is often a paste followed by `[Image #1] [Image: source: …]`, so anchoring on the
 * whole string left it starting with `<` and it was skipped as injected (2026-09-19).
 */
export function unwrapPasted(value: string): string {
  return value
    .replace(/<\/?pasted_content\b[^>]*>/gi, " ")
    .replace(/\[Image(?: #\d+|: [^\]]*)\]/g, " ")
    .trim();
}
export function skipReason(value: unknown, env: NodeJS.ProcessEnv = process.env): SkipReason | null {
  if (env.LIFEOS_GLANCE_DISABLED === "1" || env.LIFEOS_JEV_DISABLED === "1" || env.LIFEOS_JEV_ADVISOR === "0" || env.LIFEOS_ROUTER_DISABLED === "1") return "opt-out"; // LIFEOS_JEV_* are legacy fallbacks (Jev retired 2026-10-10)
  if (env.LIFEOS_NOTIFICATION_CHANNEL === "headless") return "headless";
  if (typeof value !== "string") return "short";
  const p = unwrapPasted(value);
  if (!p) return "short";
  if (p.startsWith("/")) return "slash";
  if (SYSTEM_TEXT.test(p) || HANDBACK_TEXT.test(p)) return "injected";
  // Secrets before the short and ack checks: a depth word rescues a short prompt, and
  // "ultrathink <key>" must never be rescued into either runner (router review, 2026-09-25).
  if (SECRET_VALUE_SHAPES.some(re => { re.lastIndex = 0; return re.test(p); })) return "not-public";
  if (GREETINGS.has(p.toLowerCase().replace(/[.!]+$/, ""))) return "ack";
  if (p.split(/\s+/).length < 5) return "short";
  return null;
}

const CLASSIFIER_MAX_CHARS = 12_000;
export const ENGINE_MAX_CHARS = 2_000;
/**
 * Keep both ends of a long prompt: the ask usually sits at the end, the context at the start.
 * Always well-formed: a cut through an emoji leaves a lone surrogate, and an engine can refuse the whole
 * request as invalid Unicode (Jev did on some real prompts, 2026-09-26; Jev retired 2026-10-10).
 */
export function headTail(text: string, max: number): string {
  if (text.length <= max) return text.toWellFormed();
  const head = Math.floor(max * 0.3);
  return (text.slice(0, head) + " … " + text.slice(text.length - (max - head - 3))).toWellFormed();
}
/**
 * The state the dispatch-advisor sends the engine: the redacted prompt with its whitespace runs folded to one space, then
 * head-and-tail cut to ENGINE_MAX_CHARS, plus the already-safe previous reply when there is one (Assay ISA ISC-65). Every
 * question reads only these two fields; layout whitespace carries nothing they ask about. The offline refit
 * (LaneTrain.ts --reask) builds its state here too, so the heads are fitted on exactly what the live router sends.
 */
export function engineState(text: string, previousReply: string | null): { previous_reply?: string; prompt: string } {
  const prompt = headTail(redactForEngine(text, Number.POSITIVE_INFINITY).replace(/\s+/g, " ").trim(), ENGINE_MAX_CHARS);
  return previousReply ? { previous_reply: previousReply, prompt } : { prompt };
}

/** The live engine as a bare id ("@cf/cloudflare/clef-omni" is "clef-omni"): what a learned head's engine_model must equal. */
export function liveEngineId(): string { return CROSS_VENDOR.assayEngine.split("/").pop() || CROSS_VENDOR.assayEngine; }
/** The engine a learned head was fitted on, as the model file stamps it; "unstamped" for a file from before stamping. */
export function headEngine(model: unknown): string { const e = (model as { engine_model?: unknown } | null)?.engine_model; return typeof e === "string" && e ? e : "unstamped"; }
/**
 * Whether a learned head may act (Assay ISA ISC-63): its training answers came from the engine answering now. Its weights
 * are fitted to one engine's answer scale, so another engine's answers would be read on the wrong scale. A model loaded
 * from disk must carry a matching engine_model; a model handed in through the test seam with no stamp is taken as given,
 * and one that names an engine is held to it.
 */
export function headFits(model: unknown, injected: boolean, live: string = liveEngineId()): boolean {
  if (!model) return false;
  const stamp = (model as { engine_model?: unknown }).engine_model;
  if (stamp === undefined && injected) return true;
  return stamp === live;
}

const LEVEL: Record<Exclude<Lane, "inline">, EffortLevel> = { haiku: "low", sol: "high", sonnet: "high", opus: "high", astra: "max", fable: "max" };
function validConfidence(v: unknown): number | null { return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null; }
/** "advisor" is Opus, the principal's advisor (R60, 2026-10-03); it used to normalize to astra. */
function validLane(v: unknown): Lane | null { return v === "advisor" ? "opus" : (typeof v === "string" && Object.hasOwn(LANE_RULES, v) ? v as Lane : null); }
/** An effort the classifier returned, clamped into the routed range (low → medium, max → xhigh); anything else is no pick, never a guess. */
export function validEffort(v: unknown): Effort | null { return clampEffort(v); }

/**
 * The concrete runner for a pick. Opus, Sonnet, Haiku and Fable are Claude agents: the runner is the base
 * agent, and the effort travels as the Agent tool's `effort` parameter (Claude Code 2.1.292), which overrides
 * the agent file's frontmatter effort. The six per-effort variant files were retired 2026-10-15. The codex
 * lanes take effort per call on Worker.ts; with no effort the flag is left off and Worker.ts uses its own
 * default. Inline and no pick have no runner.
 */
export function runnerFor(lane: Lane | null, effort: Effort | null): string | null {
  if (lane === null || lane === "inline") return null;
  // The OpenAI-eye lane runs on Sol, read-only (2026-10-12).
  if (lane === "astra") return effort ? `Worker.ts sol --mode audit --effort ${effort}` : "Worker.ts sol --mode audit";
  if (lane === "opus") return "Opus";
  if (lane === "sonnet") return "Sonnet";
  if (lane === "fable") return "Fable";
  if (lane === "haiku") return "Haiku";
  return effort ? `Worker.ts ${lane} --effort ${effort}` : `Worker.ts ${lane}`;
}

type Finish = { lane: Lane | null; effort?: Effort | null; source: Source; glance?: GlancePick | null; classifierPick?: Lane | null; engineResponse?: EngineResponse | null; started: number; skip?: SkipReason; thinking?: ThinkingSkill[]; directive?: string | null; effortProbs?: Record<Effort, number> | null; dictated?: boolean; engineFailure?: string | null };
function finish({ lane, effort = null, source, glance = null, classifierPick = null, engineResponse = null, started, skip, thinking = [], directive = null, effortProbs = null, dictated = false, engineFailure = null }: Finish): RouteDecision {
  // Sonnet and Sol at medium effort sit on the medium rung (Sonnet at medium effort, Sol); a Haiku pick is the low rung (HAI-12, 2026-10-07).
  const level = lane && lane !== "inline" ? (effort === "medium" && (lane === "sonnet" || lane === "sol") ? "medium" : LEVEL[lane]) : null;
  const carrier = lane === "astra" ? "sol" : lane; // the OpenAI-eye lane is carried by Sol (2026-10-12)
  if (lane && lane !== "inline") invariant(WORK_LADDER[level!]?.some(x => x.toLowerCase().startsWith(carrier!)), `router lane ${lane} must match WORK_LADDER.${level}`);
  // No pick carries no effort: an effort alone would bind a turn nothing was routed for. A pick with no effort
  // runs on the base agent or Worker.ts default, both high.
  const picked = lane === null ? null : effort;
  // A max-shaped pick suggests thinking skills; only the principal's own depth words bind (2026-09-29).
  const maxShaped = picked === "xhigh" || lane === "astra" || lane === "fable";
  const binding = directive !== null && maxShaped;
  invariant(!binding || picked === "xhigh" || level === "max", "binding is the principal's depth directive on an xhigh or max-rung pick");
  return { lane, level, effort: picked, agent: runnerFor(lane, picked), delegate: lane !== null && lane !== "inline", source, jev: glance, classifierPick, latencyMs: Math.max(0, Math.round(performance.now() - started)), engineResponse, turn: "", binding, thinking: maxShaped ? (thinking.length ? thinking : [...DEFAULT_THINKING]) : [], directive, effortProbs, dictated, jevError: engineFailure, ...(skip ? { skipReason: skip } : {}) };
}

/**
 * The Opus/Sonnet split applied to the learned pick (2026-09-28). The learned heads were trained before
 * Sonnet was a lane, so their Opus class still holds execution work; an Opus pick whose approach is
 * decided, with no taste or expert-hard judgment in it, is execution and goes to Sonnet. Retire this
 * once the heads are relabeled with a sonnet class.
 */
export function applyExecutionSplit(lane: Lane, answers: Record<string, unknown> | undefined): Lane {
  if (lane !== "opus") return lane;
  const p = (id: string) => { const a = answers?.[id] as NoulAnswer | undefined; return a?.type === "noul" ? a.noul : null; };
  const decided = p("approach_decided"), taste = p("taste_or_design"), hard = p("expert_hard");
  return decided !== null && decided >= 0.5 && (taste ?? 1) < 0.5 && (hard ?? 1) < 0.5 ? "sonnet" : lane;
}

/**
 * On the Claude front door Opus is the default and the advisor and execution goes to Sonnet; Sol serves scheduled jobs,
 * the Codex door and the principal's own `/route sol` (R58, 2026-10-03). A directive never passes through here.
 */
export function applyClaudeExecution(lane: Lane, frontDoor: FrontDoor): Lane {
  return frontDoor === "claude" && lane === "sol" ? "sonnet" : lane;
}

/**
 * The mirror of applyClaudeExecution: a Sonnet agent is a Claude agent that a Codex session cannot dispatch, so a
 * sonnet pick there (the head's terra class, or the Opus/Sonnet split) is the same rung on Sol (HAI-12, 2026-10-07).
 */
export function applyCodexExecution(lane: Lane, frontDoor: FrontDoor): Lane {
  return frontDoor !== "claude" && lane === "sonnet" ? "sol" : lane;
}

/** The blast-radius floor applied to the learned pick: a haiku pick (the head's luna) on work that touches deploys, secrets, auth, migrations or irreplaceable data goes to sol (R53), or to sonnet on the Claude front door (R59). */
export const BLAST_P = 0.5;
export function applyBlastFloor(lane: Lane, answers: Record<string, unknown> | undefined, frontDoor: FrontDoor = "codex"): Lane {
  const a = answers?.blast as NoulAnswer | undefined;
  return lane === "haiku" && a?.type === "noul" && yesAt(a, BLAST_P) === true ? (frontDoor === "claude" ? "sonnet" : "sol") : lane;
}

/** The classifier wait, inside the hook's own timeout. Past it, a directive still binds (default skills) and anything else is unavailable. */
/** Opus through the claude CLI takes several seconds to answer, and a tighter budget timed most calls out. The hook allows 15 s. */
export const CLASSIFIER_BUDGET_MS = 6_000;
/** The classifier child is given the same budget as its wait, so the hook never exits leaving a claude child running on (router review, 2026-09-25). */
function classifierBudgetMs(env: NodeJS.ProcessEnv): number { return Number(env.LIFEOS_ROUTER_CLASSIFIER_BUDGET_MS) || CLASSIFIER_BUDGET_MS; }
function withBudget<T>(p: Promise<T>, fallback: T, env: NodeJS.ProcessEnv): Promise<T> {
  const ms = classifierBudgetMs(env);
  return Promise.race([p, new Promise<T>(res => setTimeout(() => res(fallback), ms).unref?.())]);
}

export type RouteDeps = {
  env?: NodeJS.ProcessEnv;
  askFn?: typeof ask;
  decideFn?: typeof decide;
  /** The classifier call: the user prompt, then the system prompt it must run under. */
  classifierFn?: (userPrompt: string, systemPrompt: string) => Promise<InferenceResult>;
  hasEngineKey?: boolean;
  logPath?: string;
  questions?: Questions;
  /** The end of the assistant's previous reply, so a follow-up is judged in its context. Redacted and capped here. */
  previousReply?: string;
  /** Test seam: a thinking model to use instead of thinking-model.json (null means none). */
  thinkingModel?: ThinkingModel | null;
  /** Test seam: a lane model to use instead of lane-model.json (null means none). */
  laneModel?: LaneModel | null;
  /** The turn id to use, so a caller asking Glance in parallel (the skill pick) joins the same turn. */
  turn?: string;
  /** Test seam: the holdout switch to use instead of USER/CONFIG/router-holdout.json. */
  holdout?: HoldoutConfig;
  /** Test seam: the Fable budget to use instead of the live pool readings (FableBudget.ts). */
  fableBudget?: FableBudget;
};

/**
 * Fable is spent gently and follows the pool (Router ISA F9, R135, R136). A Fable pick from the learned heads or the
 * classifier stays Fable only while the budget is open; the principal's own `/route fable` stays Fable unless the pool has
 * no Fable room at all. A moved pick goes to Sol audit when the engine read the work as a second look, else to Opus at
 * xhigh, the max-rung workhorse. Muse is never chosen here: it is a public-data side lane the DA names by hand (R140).
 */
export function applyFableBudget(d: RouteDecision, budget: FableBudget): RouteDecision {
  if (d.lane !== "fable") return d;
  const principal = d.source === "directive";
  const keep = principal ? budget.status !== "out" : budget.status === "open";
  if (keep) return { ...d, fable: { status: budget.status, room: budget.room, to: "fable" } };
  const look = d.engineResponse?.answers?.second_look as NoulAnswer | undefined;
  const to: Lane = !principal && look?.type === "noul" && yesAt(look, 0.5) === true ? "astra" : "opus";
  return { ...d, lane: to, level: to === "astra" ? "max" : "high", effort: "xhigh", agent: runnerFor(to, "xhigh"), delegate: true, fable: { status: budget.status, room: budget.room, to } };
}

type ClassifierVerdict = { lane: Lane | null; effort: Effort | null; thinking: ThinkingSkill[] };
const NO_VERDICT: ClassifierVerdict = { lane: null, effort: null, thinking: [] };

function stub(env: NodeJS.ProcessEnv): { engine?: EngineResponse | null; astra?: Lane | "advisor" | null; effort?: string | null; thinking?: string[]; mode?: Decision["mode"]; act?: boolean } | null {
  const path = env.LIFEOS_ROUTER_STUB;
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function decisionLogPath(env: NodeJS.ProcessEnv = process.env): string { return env.LIFEOS_ROUTER_DECISIONS_LOG || lifeosPath("MEMORY", "OBSERVABILITY", "router-decisions.jsonl"); }
export function appendDecision(decision: RouteDecision, session: string, frontDoor: FrontDoor, path = decisionLogPath()): void {
  invariant(session.length > 0 && session.length <= 200, "router decision session must be bounded");
  invariant(["claude", "codex"].includes(frontDoor), "router decision front door must be known");
  mkdirSync(dirname(path), { recursive: true });
  // R50: turn joins the row to assay.jsonl and the plugin's effort rows; binding, agent and the effort
  // distribution make compliance and effort outcomes measurable; jevError names why the engine had no answer (key kept for
  // old rows: Jev retired 2026-10-10).
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), session, frontDoor, turn: decision.turn || null, source: decision.source, lane: decision.lane, level: decision.level, effort: decision.effort, effortProbs: decision.effortProbs, binding: decision.binding, agent: decision.agent, dictated: decision.dictated, jev: decision.jev, jevError: decision.jevError, classifier: decision.classifierPick, latencyMs: decision.latencyMs, think: decision.thinkingPlan ? { skill: decision.thinkingPlan.skill, sequence: decision.thinkingPlan.sequence, mode: decision.thinkingPlan.mode, pThink: Math.round(decision.thinkingPlan.pThink * 1000) / 1000 } : null, ...(typeof decision.holdout === "boolean" ? { holdout: decision.holdout } : {}), ...(decision.staleHeads ? { staleHeads: decision.staleHeads } : {}), ...(decision.fable ? { fable: decision.fable } : {}) }) + "\n");
}

export async function route(prompt: unknown, session: string, frontDoor: FrontDoor, deps: RouteDeps = {}): Promise<RouteDecision> {
  const started = performance.now();
  const turn = deps.turn ?? randomUUID();
  const env = deps.env ?? process.env;
  const text = typeof prompt === "string" ? unwrapPasted(prompt) : "";
  const dictated = typeof prompt === "string" && /<pasted_content\b/i.test(prompt);
  const directive = DIRECTIVE.exec(text);
  let result: RouteDecision;
  const staleHeads: NonNullable<RouteDecision["staleHeads"]> = {};
  // The principal's own depth words outrank every classifier (2026-09-19). A bare directive
  // ("go deep", "ultrathink") is short, so it survives the short/ack skip; slash commands, injected
  // text, opt-out and headless still skip.
  const depth = directive ? null : matchDepthDirective(text);
  if (directive) result = finish({ lane: validLane(directive[1].toLowerCase()), source: "directive", started, dictated });
  else {
    const rawSkip = skipReason(prompt, env);
    const skip = depth && (rawSkip === "short" || rawSkip === "ack") ? null : rawSkip;
    if (skip) result = finish({ lane: null, source: "skip", started, skip, dictated });
    else {
      // Redact the whole prompt, then keep both ends: cutting the head first dropped the final ask of any
      // prompt over 12,000 characters (router review, 2026-09-25).
      const redacted = redactForEngine(text, Number.POSITIVE_INFINITY);
      const safe = headTail(redacted, CLASSIFIER_MAX_CHARS);
      let engineFailure: string | null = null;
      const previousReply = safePreviousReply(deps.previousReply);
      const canned = stub(env);
      // ISC-63: a learned head acts only on answers from the engine it was fitted on; a stale one sits out and the
      // Opus classifier answers in its place, exactly as when no model exists.
      const laneInjected = deps.laneModel !== undefined;
      const laneLoaded = laneInjected ? deps.laneModel ?? null : loadLaneModel();
      const laneModel: LaneModel | null = headFits(laneLoaded, laneInjected) ? laneLoaded : null;
      if (laneLoaded && !laneModel) staleHeads.lane = headEngine(laneLoaded);
      // The Opus classifier is the fallback, so it runs only when asked for: a prompt Glance's learned
      // model picks never pays its wait or its tokens (2026-09-24).
      let classifierCall: Promise<ClassifierVerdict> | null = null;
      const classify = (): Promise<ClassifierVerdict> => classifierCall ??= (async (): Promise<ClassifierVerdict> => {
        if (canned) return { lane: validLane(canned.astra ?? null), effort: validEffort(canned.effort), thinking: validThinking(canned.thinking) };
        const run = deps.classifierFn ?? ((user: string, system: string) => inference({ systemPrompt: system, userPrompt: user, level: "high", effort: "low", vendor: "anthropic", allowVendorFallback: false, maxAttempts: 1, expectJson: true, timeout: classifierBudgetMs(env) }));
        try {
          const prompts = classifierPrompts(safe, previousReply);
          const r = await run(prompts.user, prompts.system);
          if (!(r.success && r.vendor === "anthropic" && /opus/i.test(r.executedModel ?? ""))) return NO_VERDICT;
          const parsed = r.parsed as { route?: unknown; effort?: unknown; thinking?: unknown } | undefined;
          return { lane: validLane(parsed?.route), effort: validEffort(parsed?.effort), thinking: validThinking(parsed?.thinking) };
        } catch { return NO_VERDICT; }
      })();
      type Glanced = { response: EngineResponse | null; pick: GlancePick | null; act: boolean; learned: Prediction | null };
      const glancePromise = (async (): Promise<Glanced> => {
        if (canned) {
          const response = canned.engine ?? null; const a = response?.answers.lane;
          if (a?.type === "choice") return { response, pick: { pick: validLane(a.choice), confidence: validConfidence(a.confidence), mode: canned.mode ?? "shadow" }, act: canned.act === true, learned: null };
          const learned = response ? predictLane(response.answers, { prompt: text, hasContext: !!previousReply }, laneModel) : null;
          return { response, pick: learned ? { pick: learned.lane, confidence: Math.round(learned.p * 100) / 100, mode: canned.mode ?? "shadow" } : null, act: false, learned };
        }
        if (!(deps.hasEngineKey ?? resolveApiKey() !== null)) { engineFailure = "no-key"; return { response: null, pick: null, act: false, learned: null }; }
        try {
          const state = engineState(text, previousReply);
          const response = await (deps.askFn ?? ask)(state, deps.questions ?? LANE_QUESTIONS, { caller: "dispatch-advisor", session, turn, timeoutMs: 3000, env });
          const answer = response.answers.lane;
          if (answer?.type === "choice") {
            const d = (deps.decideFn ?? decide)("dispatch-advisor", "lane", answer);
            return { response, pick: { pick: validLane(answer.choice), confidence: validConfidence(answer.confidence), mode: d.mode }, act: d.act, learned: null };
          }
          const cfg = safeCallerConfig("dispatch-advisor");
          const learned = predictLane(response.answers, { prompt: text, hasContext: !!previousReply }, laneModel);
          if (learned) return { response, pick: { pick: learned.lane, confidence: Math.round(learned.p * 100) / 100, mode: cfg?.mode ?? "unregistered" }, act: false, learned };
          // No learned model: the hand composer is displayed, never trusted to decide (it trails the classifier).
          const c = composeLane(response.answers);
          const confidence = c ? Math.round(Math.min(...NOULS.map(id => { const p = (response.answers[id] as NoulAnswer).noul; return Math.max(p, 1 - p); })) * 100) / 100 : null;
          return { response, pick: { pick: validLane(c?.lane ?? null), confidence, mode: cfg?.mode ?? "unregistered" }, act: false, learned: null };
        } catch (err) { engineFailure = err instanceof EngineError ? err.kind : "error"; return { response: null, pick: null, act: false, learned: null }; }
      })();
      const j = await glancePromise;
      // A per-prompt caller runs on a short budget (the retired DispatchAdvisor hook had one), so a directive never waits past
      // CLASSIFIER_BUDGET_MS for the classifier: the binding verdict is deterministic, only its skill list is enrichment.
      // Depth words mean Opus at xhigh (lane-rules Guardrails, 2026-09-24); Astra when either picker called
      // the work an exhaustive sweep. Any picked effort is overridden: he said deep.
      if (depth) { const a = await withBudget(classify(), NO_VERDICT, env); const astra = a.lane === "astra" || j.learned?.lane === "astra"; result = finish({ lane: astra ? "astra" : "opus", effort: "xhigh", source: "directive", glance: j.pick, classifierPick: a.lane, engineResponse: j.response, started, thinking: a.thinking, directive: depth, effortProbs: j.learned?.effortProbs ?? null, dictated, engineFailure }); }
      // Glance's learned model decides lane and effort: it beat the Opus classifier on lane accuracy over
      // real prompts, session-held-out (LaneTrain.ts). The classifier runs only when Glance has no pick.
      // The blast-radius floor holds on the learned pick too (R53), and so does the Opus/Sonnet execution split.
      else if (j.learned) result = finish({ lane: applyCodexExecution(applyClaudeExecution(applyExecutionSplit(applyBlastFloor(j.learned.lane, j.response?.answers, frontDoor), j.response?.answers), frontDoor), frontDoor), effort: j.learned.effort, source: "jev", glance: j.pick, engineResponse: j.response, started, effortProbs: j.learned.effortProbs, dictated });
      // A legacy enforcing lane choice picks a lane, never an effort. It and the classifier fallback below take both
      // execution rules, so a sonnet verdict on the Codex door becomes sol there, as the learned pick does.
      else if (j.act && j.pick?.pick) result = finish({ lane: applyCodexExecution(applyClaudeExecution(j.pick.pick, frontDoor), frontDoor), source: "jev", glance: j.pick, engineResponse: j.response, started, dictated });
      else { const a = await withBudget(classify(), NO_VERDICT, env); result = finish({ lane: a.lane ? applyCodexExecution(applyClaudeExecution(a.lane, frontDoor), frontDoor) : a.lane, effort: a.effort, source: a.lane ? "opus" : "unavailable", glance: j.pick, classifierPick: a.lane, engineResponse: j.response, started, thinking: a.thinking, dictated, engineFailure }); }
    }
  }
  result = { ...result, turn };
  if (result.lane === "fable") result = applyFableBudget(result, deps.fableBudget ?? readFableBudget(env));
  // The thinking leg: the learned plan rides the same engine answers
  // as the lane pick. On a max-shaped pick it names the skills (C7): learned plan, then classifier, then the default pair.
  const thinkingInjected = deps.thinkingModel !== undefined;
  const thinkingLoaded = result.engineResponse ? (thinkingInjected ? deps.thinkingModel ?? null : loadThinkingModel()) : null;
  const thinkingModel: ThinkingModel | null = headFits(thinkingLoaded, thinkingInjected) ? thinkingLoaded : null;
  if (thinkingLoaded && !thinkingModel) staleHeads.thinking = headEngine(thinkingLoaded);
  if (staleHeads.lane || staleHeads.thinking) result = { ...result, staleHeads: { ...staleHeads } };
  const plan = result.engineResponse && thinkingModel ? predictThinking(result.engineResponse.answers, { prompt: text, hasContext: !!safePreviousReply(deps.previousReply) }, thinkingModel) : null;
  if (plan) {
    result = { ...result, thinkingPlan: plan };
    if (result.thinking.length && plan.skill !== "none") result = { ...result, thinking: plan.skills };
  }
  // The router holdout (ISC-26): decided after the route, because binding and dictated turns are never held out.
  // The full decision is still computed and logged for a held-out turn; only the caller withholds it.
  const arm = holdoutArm(result, deps.holdout ?? loadHoldout(env));
  if (arm !== null) result = { ...result, holdout: arm };
  if (result.source !== "skip" || ["ack", "short", "slash"].includes(result.skipReason ?? "")) {
    try { appendDecision(result, session || "unknown", frontDoor, deps.logPath ?? decisionLogPath(env)); } catch { /* observability is fail-open */ }
  }
  return result;
}

/** The thinking plan as drawn on the route line: nothing for none, else the skill or sequence and its mode. */
export function thinkingText(d: Pick<RouteDecision, "thinkingPlan">): string {
  const p = d.thinkingPlan;
  if (!p || p.skill === "none" || !p.skills.length) return "";
  return ` · ${p.skills.join(" → ")} (${p.mode ?? "light"})`;
}

/** The one spelling of the route line prefix: every surface and test reads it from here, so a rename is one edit. */
export const ROUTE_LINE_PREFIX = "🧭 ROUTER:";

/**
 * The engine the Assay call used: the response's model (the last path segment, so "@cf/cloudflare/clef-omni" draws
 * "clef-omni"). A decision with no response (no key, budget, timeout, skip) names the engine that was configured for the call.
 */
export function engineLabel(d: Pick<RouteDecision, "engineResponse">): string {
  const model = d.engineResponse?.model || CROSS_VENDOR.assayEngine;
  return model?.split("/").pop() || "unavailable";
}

export function formatRouterLine(d: RouteDecision): string {
  // An agent is named for the model it runs, so its name is drawn the way the roster spells it: Astra, Sol, Haiku.
  // A Fable pick the budget moved says so where the lane is drawn (R137).
  const moved = d.fable && d.fable.to !== "fable" ? ` (Fable ${d.fable.status} → ${laneName(d.fable.to)})` : "";
  const lane = (d.lane ? laneName(d.lane) : "unavailable") + moved; const level = d.level?.toUpperCase() ?? "NONE";
  // An inline verdict has no rung, so it draws no level token; an unavailable one keeps NONE (Router ISA F4, R85).
  const levelText = d.lane === "inline" ? "" : ` · ${level}`;
  const engine = engineLabel(d);
  const j = d.jev ? `${d.jev.pick ? laneName(d.jev.pick) : "none"} ${(d.jev.confidence ?? 0).toFixed(2)}, ${d.jev.mode}` : `none 0.00, ${d.jevError ? `${engine} ${d.jevError}` : "unavailable"}`;
  // Who decided: a model name is spelled as the roster spells it; `directive` and `skip` are not names.
  const source = d.source === "opus" ? "Opus" : d.source === "jev" ? "Glance" : d.source;
  // Effort sits after the level; a decision with no effort pick draws the line exactly as before effort existed.
  const effort = (d.effort ? ` · ${d.effort}` : "") + thinkingText(d);
  // When Glance decided, its own pick is the lane shown, so the parenthetical carries only its probability.
  const who = d.source === "jev" && d.jev?.pick === d.lane ? `${source} (p ${(d.jev?.confidence ?? 0).toFixed(2)})` : `${source} (${engine} ${j})`;
  const head = `${ROUTE_LINE_PREFIX} ${lane}${levelText}${effort} · ${d.delegate ? "delegate" : "inline"} · ${who} · ${(d.latencyMs / 1000).toFixed(2)}s`;
  if (!d.binding) return `${head} — advisory; a lane the principal names wins.${d.thinking.length ? ` Skills that may fit: ${d.thinking.join(" + ")}.` : ""} · engine ${engine}`;
  // A depth directive is reported, never prescribed (2026-10-16 native-unblock ISC-16): the harness's own thinking and
  // effort carry depth, and which skills or agents to use stays the model's call. `binding` remains the record field.
  return `${head} — depth asked (he said "${d.directive}"); native thinking and effort carry it.${d.thinking.length ? ` Skills that may fit: ${d.thinking.join(" + ")}.` : ""} · engine ${engine}`;
}
