/**
 * lane-rules.ts — the routing rules, read from the one place they are written: Algorithm § Routing.
 *
 * Since 2026-10-25 (the principal: "as few places as possible ... in one place") the rules are authored only in
 * the Algorithm, `LIFEOS/ALGORITHM/AlgorithmReference.md` § Routing. This module parses them once at load and
 * hands the same constants to every importer; nothing here restates a rule. The rules
 * pick three things per task: the model (ladder), whether it leaves the session (handoff), and effort. How to dispatch (briefs, stalls, Worker.ts) lives in
 * Delegation/DelegationSystem.md § Dispatch practice (that section is current), not here; this file only says which lane. The learned Glance heads (lane-model.json) do not read
 * these rules; they are trained on labels made under them, and FrontDoor applies the blast floor and the Opus/Sonnet execution split to their pick in code.
 *
 * A leaf module on purpose: the PreToolUse guards read it without pulling Assay, its engine or Inference
 * into a hot path. It reads two small files with no model or network call. The dated directives behind each rule
 * live in the Algorithm changelog and the Router ISA Decisions, never here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ALGORITHM_DIR = join(import.meta.dir, "..", "..", "LIFEOS", "ALGORITHM");

/** Algorithm § Routing, as written: groups in bold, numbered rules under each. Throws when the section is missing, because routing without its rules is an impossible state. */
function readRoutingGroups(): { group: string; rules: string[] }[] {
  const version = "AlgorithmReference.md";
  const doc = readFileSync(join(ALGORITHM_DIR, version), "utf8");
  const section = doc.match(/\n## Routing\n([\s\S]*?)(?=\n## |$)/)?.[1];
  if (!section) throw new Error(`lane-rules: ${version} has no § Routing`);
  const groups: { group: string; rules: string[] }[] = [];
  for (const line of section.split("\n")) {
    const g = line.match(/^\*\*(.+)\*\*$/);
    if (g) { groups.push({ group: g[1], rules: [] }); continue; }
    const r = line.match(/^\d+\. (.+)$/);
    if (r && groups.length) groups[groups.length - 1].rules.push(r[1].trim());
  }
  const numbered = groups.filter((g) => g.rules.length);
  if (!numbered.length) throw new Error(`lane-rules: ${version} § Routing carries no numbered rules`);
  return numbered;
}

const PARSED = readRoutingGroups();
const SIDE_GROUP = "Side lanes";
const ALL_RULES = PARSED.flatMap((g) => g.rules);
/** The one rule that starts with `prefix`; a missing rule is an impossible state, so it throws. */
function rule(prefix: string): string {
  const hit = ALL_RULES.find((r) => r.startsWith(prefix));
  if (!hit) throw new Error(`lane-rules: Algorithm § Routing has no rule starting "${prefix}"`);
  return hit;
}
const afterLabel = (prefix: string) => rule(prefix).slice(prefix.length).trim();

/**
 * `astra` is the id of the OpenAI-eye lane (exhaustive coverage, cross-vendor and security checks). The id stays because
 * the learned heads and the label files carry it; since 2026-10-12 the lane runs on Sol in read-only audit mode, so it is
 * drawn as "Sol audit" and dispatched as `Worker.ts sol --mode audit` (the principal: "use Sol instead"). The Astra agent
 * itself is off automatic routing and runs only when named.
 */
export type Lane = "inline" | "haiku" | "sol" | "sonnet" | "opus" | "astra" | "fable";

/** The ceiling every rule is held to, rendered label included. */
export const MAX_RULE_WORDS = 16;

/**
 * One rule per lane, without its label: what each model is good at, never a fence around it. The carrier
 * picks and mixes lanes by its own judgment.
 * Max work is Opus at xhigh; on the Claude front door Opus is the default and the advisor and `sonnet` takes execution once the approach is set; `sol` serves scheduled jobs and the Codex door.
 */
export const LANE_RULES: Record<Lane, string> = {
  opus: afterLabel("Opus:"),
  sonnet: afterLabel("Sonnet:"),
  fable: afterLabel("Fable:"),
  astra: afterLabel("Sol audit:"),
  sol: afterLabel("Sol:"),
  haiku: afterLabel("Haiku:"),
  inline: afterLabel("Inline:"),
};

/** The outcome every routing choice serves, and the rule that frames the rest (the principal, 2026-09-29). */
export const GOAL_RULE = rule("First goal:");
export const COST_RULE = rule("Second:");
export const GUIDANCE_RULE = rule("These are BLE preferences");

const RULE_LABEL: Record<Lane, string> = { haiku: "Haiku", sol: "Sol", sonnet: "Sonnet", opus: "Opus", fable: "Fable", astra: "Sol audit", inline: "Inline" };
const laneRule = (l: Lane) => `${RULE_LABEL[l]}: ${LANE_RULES[l]}`;

export const RESIDUAL_AXIS = rule("The rung usually follows");
export const BLAST_FLOOR = rule("Deploys, secrets, auth");
/** The Opus/Sonnet/Sol boundary, stated as a test a labeler or a classifier can apply (2026-09-24; Sonnet added 2026-09-28; Sol off the interactive Claude path 2026-10-03). */
export const OPUS_OR_SOL = rule("Open judgment usually suits");
/** Handoff is its own decision: which model is one question, whether the work leaves the session is another. */
export const HANDOFF_RULE = rule("Handoffs work best");
/** The routed efforts: medium, high, xhigh, with high the default for most work (the principal, 2026-09-29). */
export const EFFORTS = ["medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_EFFORT: Effort = "high";
/** The classes the learned effort head was trained on; it still names low, which routes as medium. */
export const HEAD_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type HeadEffort = (typeof HEAD_EFFORTS)[number];
/** P(low)+P(medium) the learned head needs before a task routes at medium instead of high. */
export const MEDIUM_P = 0.95;
export const EFFORT_AXIS = rule("Effort usually follows");
export const EFFORT_LEVELS = rule("Never low, never max");

/** Any effort word, clamped into the routed range: low routes as medium, max as xhigh, anything else is no pick. */
export function clampEffort(v: unknown): Effort | null {
  if (v === "low") return "medium";
  if (v === "max") return "xhigh";
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v) ? v as Effort : null;
}

/** The learned head's distribution folded into the routed range (low joins medium), and the pick it makes: xhigh when the head says so, medium only when it is MEDIUM_P sure, high otherwise. */
export function routedEffort(probs: Partial<Record<HeadEffort, number>>): { effort: Effort; probs: Record<Effort, number> } {
  const p = (e: HeadEffort) => probs[e] ?? 0;
  const folded: Record<Effort, number> = { medium: Math.round((p("low") + p("medium")) * 1000) / 1000, high: p("high"), xhigh: p("xhigh") };
  const top = HEAD_EFFORTS.reduce((a, e) => (p(e) > p(a) ? e : a), HEAD_EFFORTS[0]);
  const effort: Effort = top === "xhigh" ? "xhigh" : p("low") + p("medium") >= MEDIUM_P ? "medium" : DEFAULT_EFFORT;
  return { effort, probs: folded };
}
/** Kept under its old name so importers stay put: the three max-capable models. */
export const CRAFT_AXIS = [laneRule("opus"), laneRule("fable"), laneRule("astra")].join(" ");

export const SIDE_LANES: Record<string, { agent: string; rule: string }> = {
  grok: { agent: "Grok", rule: afterLabel("Grok:") },
  muse: { agent: "Muse", rule: afterLabel("Muse:") },
};

/** Every routing rule, grouped as Algorithm § Routing writes them; side lanes ride in SIDE_LANES. */
export const ROUTING_RULES: readonly { group: string; rules: readonly string[] }[] = PARSED.filter((g) => g.group !== SIDE_GROUP);

/** The rules as Algorithm § Routing numbers them, bold group names between. */
export function renderRules(): string {
  let n = 0;
  return ROUTING_RULES.map(g => `**${g.group}**\n\n${g.rules.map(r => `${++n}. ${r}`).join("\n")}`).join("\n\n");
}

/** The one instruction every classifier and every refusal message renders from; the lane rules ride beside it. */
export const LANE_INSTRUCTIONS = `Pick the lowest lane that can finish the work. ${RESIDUAL_AXIS} ${OPUS_OR_SOL} ${HANDOFF_RULE} ${BLAST_FLOOR} Opus is the default whenever judgment is still open; Sonnet carries execution once it is settled; Haiku takes near-mechanical work; Sol serves scheduled jobs and the Codex door.`;

/** How a lane is named to the principal. Opus and Sonnet carry their mode, because the refusal is
 *  offering a build seat; the OpenAI-eye lane is Sol in audit mode (R18; Sol since 2026-10-12). */
const LANE_LABEL: Partial<Record<Lane, string>> = { astra: "Sol audit mode", opus: "Opus build mode", sonnet: "Sonnet build mode" };

/** One rule per worker lane, for a refusal message. The rules are short enough to show whole. */
export function laneMenu(lanes: readonly Lane[] = ["haiku", "sol", "sonnet", "opus", "fable", "astra"]): string {
  return lanes
    .map(l => `${LANE_LABEL[l] ?? RULE_LABEL[l]}: ${LANE_RULES[l]}`)
    .join(" · ");
}
