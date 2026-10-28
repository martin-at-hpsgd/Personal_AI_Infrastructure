#!/usr/bin/env bun
/**
 * RouteCheck.ts — the run's written route, read, drawn, checked and judged (Router ISA F16, R165–R167).
 *
 * A run writes its route in the ISA: one `Lane: <Agent> · <effort>` or `Lane: inline` line per feature block
 * (ISAFormat.md § Feature blocks). This tool reads it three ways, and none of them blocks anything:
 *
 *   route <isa>                 the one-line route the plugin draws: `🧭 ROUTE ▸ F1 Sonnet·high · F2 inline`
 *   check <isa> --session <id>  what ran against what was written, from subagent-events.jsonl, no model call
 *   fit <isa> [--session <id>]  one Assay judgment-layer question per routed feature (caller `route-fit`, shadow)
 *
 * A dispatch belongs to a feature when its description names `F<n>` as a word (`build:F3 api`, `F3 tests`). A checker
 * (`verify:<Agent>:F<n> …`, Development's launch contract) looks at the feature without building it, so it is left out,
 * except for a feature routed to Sol audit, whose work is the check.
 * Every subcommand exits 0: the route is a plan the DA follows by intent (Algorithm § Routing), so a miss is
 * shown, never enforced. `fit` degrades to no flag when the engine is unreachable, disabled or refuses.
 */
import { existsSync, readFileSync } from "node:fs";
import { lifeosPath } from "../TOOLS/Paths";
import { LANE_RULES } from "../../hooks/lib/lane-rules";

/** The agent words a Lane line may name, by their lower-case spelling. */
export const LANE_AGENTS: Record<string, string> = {
  inline: "inline", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable", sol: "Sol", "sol audit": "Sol audit",
  astra: "Astra", grok: "Grok", muse: "Muse", argon: "Argon",
};

/** The Lane word for a key, own keys only: `constructor` or `__proto__` in a Lane line is an unknown agent, never a prototype member. */
const laneAgent = (key: string): string | undefined => (Object.hasOwn(LANE_AGENTS, key) ? LANE_AGENTS[key] : undefined);

export interface RoutedFeature { feature: string; name: string; agent: string; effort: string | null; known: boolean; why: string; criteria: string }

/** Every feature block's Lane line, in ISA order. Features without one are not routed and are left out. */
export function parseRoute(isa: string): RoutedFeature[] {
  const out: RoutedFeature[] = [];
  for (const b of isa.split(/\n(?=### F\d+ · )/).slice(1)) {
    const head = b.match(/^### (F\d+) · (.+)/);
    if (!head) continue;
    const body = b.split(/\n## /)[0]!;
    const lane = body.match(/^Lane:\s*(.+)$/m);
    if (!lane) continue;
    const [rawAgent, rawEffort] = lane[1]!.split(/\s*·\s*/);
    const key = rawAgent!.trim().toLowerCase();
    out.push({
      feature: head[1]!, name: head[2]!.trim(),
      agent: laneAgent(key) ?? rawAgent!.trim(), known: laneAgent(key) !== undefined,
      effort: rawEffort?.trim().toLowerCase() || null,
      why: body.match(/^Why:\s*(.+)$/m)?.[1]?.trim() ?? "",
      criteria: body.split("\n").filter((l) => /^- \[[ x]\] /.test(l)).join("\n").slice(0, 1500),
    });
  }
  return out;
}

/** The drawn route line; empty when nothing is routed. */
export function routeLine(route: RoutedFeature[]): string {
  if (!route.length) return "";
  const parts = route.map((r) => `${r.feature} ${r.agent}${r.effort ? `·${r.effort}` : ""}${r.known ? "" : " (unknown agent)"}`);
  return `🧭 ROUTE ▸ ${parts.join(" · ")}`;
}

export interface DispatchRow { session_id?: string; event?: string; subagent_type?: string; subagent_model?: string; subagent_level?: string; effort?: string; description?: string }

/** The agent a logged dispatch actually ran on, in Lane words. */
export function ranOn(row: DispatchRow): string {
  const type = row.subagent_type ?? "";
  if (["Opus", "Sonnet", "Haiku", "Fable", "Sol", "Astra", "Grok", "Muse", "Argon"].includes(type)) return type;
  const level = (row.subagent_level ?? "").toLowerCase();
  const byLevel = laneAgent(level);
  if (byLevel && byLevel !== "inline") return byLevel;
  // A model id names its family as a dash-separated word (claude-sonnet-5-5, gpt-6.1-sol); "console" is not Sol.
  const m = (row.subagent_model ?? "").toLowerCase().match(/(?:^|[-_])(opus|sonnet|haiku|fable|sol)(?=$|[-_])/);
  return m ? laneAgent(m[1]!)! : type || "unknown";
}

/** Whether the written agent and the agent that ran are the same lane (Sol audit runs as Sol). */
function sameLane(written: string, ran: string): boolean {
  return written === ran || (written === "Sol audit" && ran === "Sol");
}

export interface CheckResult { feature: string; written: string; ran: string[]; fit: boolean; note: string }

/** Each routed feature against the session's dispatches that name it. */
export function checkRoute(route: RoutedFeature[], rows: DispatchRow[]): CheckResult[] {
  return route.map((r) => {
    const names = new RegExp(`(^|[^A-Za-z0-9])${r.feature}([^0-9]|$)`);
    const builds = rows.filter((d) => d.event === "subagent_start" && (r.agent === "Sol audit" || !/^verify:/.test(d.description ?? "")) && names.test(d.description ?? ""));
    const ran = [...new Set(builds.map(ranOn))];
    if (r.agent === "inline") {
      return ran.length
        ? { feature: r.feature, written: "inline", ran, fit: false, note: `written inline, but ${ran.join(", ")} ran it` }
        : { feature: r.feature, written: "inline", ran, fit: true, note: "inline" };
    }
    if (!ran.length) return { feature: r.feature, written: r.agent, ran, fit: false, note: `written ${r.agent}, but no dispatch named ${r.feature}` };
    const fit = ran.some((a) => sameLane(r.agent, a));
    return { feature: r.feature, written: r.agent, ran, fit, note: fit ? r.agent : `written ${r.agent}, ran on ${ran.join(", ")}` };
  });
}

export function checkLines(results: CheckResult[]): string[] {
  if (!results.length) return [];
  const fits = results.filter((r) => r.fit).length;
  return [`🧭 Route check ▸ ${fits} of ${results.length} fit`, ...results.filter((r) => !r.fit).map((r) => `⚠️ ${r.feature}: ${r.note}`)];
}

export function eventsPath(env: Record<string, string | undefined> = process.env): string {
  return env.LIFEOS_ROUTE_EVENTS || lifeosPath("MEMORY", "OBSERVABILITY", "subagent-events.jsonl");
}

/** One session's dispatch rows. The log is append-only, so a live session sits in its tail: a long file is read from its last 4 MB. */
export function sessionRows(session: string, path = eventsPath()): DispatchRow[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const tail = text.length > 4_000_000 ? text.slice(-4_000_000) : text;
  const rows: DispatchRow[] = [];
  for (const line of tail.split("\n")) {
    if (!line.includes(session)) continue;
    try { const r = JSON.parse(line) as DispatchRow; if (r.session_id === session) rows.push(r); } catch { /* a torn line */ }
  }
  return rows;
}

// ── fit: the background judgment question ──────────────────────────────────

export const FIT_CALLER = "route-fit";
export const FIT_TIMEOUT_MS = 3000;
/**
 * When a misfit is drawn: the engine's probability for the misfit answer is at least FIT_FLAG_P and beats "fits" by
 * FIT_FLAG_MARGIN. Its own `confidence` field is a sharpness score that stays low even on clear calls (live probe
 * 2026-10-26: a rename routed to Opus xhigh came back too_strong at p 0.63, confidence 0.20), so it is not the bar.
 */
export const FIT_FLAG_P = 0.45;
export const FIT_FLAG_MARGIN = 0.15;
/**
 * A step down needs a clear case. On a close call the smarter model wins (Algorithm § Routing rule 2; the principal,
 * 2026-10-26: "If we have a choice, if it's on a line between a lower and a smarter model, you should choose the
 * smarter one"), so "too strong" is drawn only at p ≥ 0.7 and 0.3 over "fits"; "too weak" keeps the lower bar.
 */
export const FIT_DOWN_P = 0.7;
export const FIT_DOWN_MARGIN = 0.3;
/** No rung sits below Haiku, so "too strong" on it is engine noise, never a hint (live probe 2026-10-26: a rename on Haiku drew it at p 0.72). */
const CHEAPEST = new Set(["Haiku"]);

export const FIT_QUESTION = {
  fit: {
    type: "choice" as const,
    instructions: "A software run wrote down which AI agent will build one feature. Given the routing preferences and the feature, does the chosen agent fit the work? Judge how much deciding is left, not the size of the job: open judgment suits a stronger model, settled execution suits a cheaper one.",
    criteria: {
      fits: "The chosen agent suits how much deciding is left in this feature.",
      too_strong: "A cheaper agent would do this as well: the approach is settled or the work is near-mechanical.",
      too_weak: "The feature still needs open judgment, design, or care with production, secrets or data, and the chosen agent is below that.",
    },
  },
};

export interface FitFlag { feature: string; verdict: "too_strong" | "too_weak"; confidence: number }
export type Ask = (state: object, questions: typeof FIT_QUESTION, opts: { caller: string; session?: string; timeoutMs: number }) => Promise<{ answers: Record<string, { type: string; choice?: string; probabilities?: Record<string, number> }> }>;

/** The judged misfits. Every engine failure becomes no flag: this question only ever adds a hint. */
export async function fitFlags(route: RoutedFeature[], ask: Ask, session?: string): Promise<{ flags: FitFlag[]; skipped: string[] }> {
  const flags: FitFlag[] = [], skipped: string[] = [];
  const rules = Object.entries(LANE_RULES).map(([lane, rule]) => `${lane}: ${rule}`).join("\n");
  await Promise.all(route.filter((r) => r.agent !== "inline" && r.known).map(async (r) => {
    try {
      const res = await ask({ routing_preferences: rules, feature: `${r.feature} · ${r.name}`, why: r.why, criteria: r.criteria, chosen_agent: r.agent, effort: r.effort ?? "default" }, FIT_QUESTION, { caller: FIT_CALLER, session, timeoutMs: FIT_TIMEOUT_MS });
      const a = res.answers.fit;
      const p = a?.probabilities ?? {};
      if (a?.type === "choice" && (a.choice === "too_weak" || (a.choice === "too_strong" && !CHEAPEST.has(r.agent)))) {
        const pm = p[a.choice] ?? 0;
        const [bar, margin] = a.choice === "too_strong" ? [FIT_DOWN_P, FIT_DOWN_MARGIN] : [FIT_FLAG_P, FIT_FLAG_MARGIN];
        if (pm >= bar && pm - (p.fits ?? 0) >= margin) flags.push({ feature: r.feature, verdict: a.choice, confidence: pm });
      }
    } catch (e) {
      skipped.push(`${r.feature}: ${e instanceof Error ? e.message.slice(0, 80) : "engine error"}`);
    }
  }));
  flags.sort((a, b) => a.feature.localeCompare(b.feature, undefined, { numeric: true }));
  return { flags, skipped };
}

export function fitLines(flags: FitFlag[]): string[] {
  return flags.map((f) => `⚠️ Route fit ${f.feature}: ${f.verdict === "too_strong" ? "clearly near-mechanical, a cheaper agent would do it as well" : "this likely needs a stronger agent"} (${Math.round(f.confidence * 100)}%)`);
}

// ── CLI ───────────────────────────────────────────────────────────────────

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[], ask?: Ask): Promise<number> {
  const [cmd, isaPath] = argv;
  const json = argv.includes("--json");
  if (!cmd || !isaPath || !["route", "check", "fit"].includes(cmd)) {
    console.error("usage: RouteCheck.ts route|check|fit <isa> [--session <id>] [--json]");
    return 0;
  }
  if (!existsSync(isaPath)) { console.error(`RouteCheck: no file at ${isaPath}`); return 0; }
  const route = parseRoute(readFileSync(isaPath, "utf8"));
  const session = arg(argv, "--session");
  if (cmd === "route") {
    if (json) console.log(JSON.stringify(route.map(({ why, criteria, ...r }) => r)));
    else if (route.length) console.log(routeLine(route));
    return 0;
  }
  if (cmd === "check") {
    if (!session) { console.error("RouteCheck check: --session <id> is required"); return 0; }
    const results = checkRoute(route, sessionRows(session));
    if (json) console.log(JSON.stringify(results));
    else for (const l of checkLines(results)) console.log(l);
    return 0;
  }
  const engine = ask ?? ((await import("../ASSAY/Assay")).ask as unknown as Ask);
  const { flags, skipped } = await fitFlags(route, engine, session);
  if (json) console.log(JSON.stringify({ flags, skipped }));
  else for (const l of fitLines(flags)) console.log(l);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
