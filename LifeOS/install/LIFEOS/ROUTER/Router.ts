#!/usr/bin/env bun
/**
 * @version 1.0.0
 * Router.ts — the one door onto LifeOS model-and-agent routing.
 *
 * The Router is the system that answers "who runs this, on which model, at what
 * reasoning effort, and how do I ask for it by name." The data lives in ONE
 * registry, `LIFEOS/TOOLS/models.ts` (Claude tiers, cross-vendor lanes, spoken
 * levels); the roster is `agents/*.md`, each agent named for the model it runs.
 * This CLI reads both and never writes: it is the view, not a second registry.
 *
 *   bun LIFEOS/ROUTER/Router.ts lanes            every agent → vendor lane / tier, effort, sandbox
 *   bun LIFEOS/ROUTER/Router.ts resolve <phrase> a spoken level ("max intelligence") → agent → lane
 *   bun LIFEOS/ROUTER/Router.ts status           parity: exit 1 when an agent has no lane or an alias dangles
 *   bun LIFEOS/ROUTER/Router.ts models [--files] every model in use: vendor, id, upgrade path, consuming files (ModelMap.ts)
 *   bun LIFEOS/ROUTER/Router.ts holdout [on|off] [--rate R]  read or set the router holdout switch (Holdout.ts); writes USER/CONFIG/router-holdout.json
 *   bun LIFEOS/ROUTER/Router.ts deadlines [--days N]  each `dw`/time-suffix turn's last reply against its due time (Shape.ts, deadlines.jsonl)
 *   bun LIFEOS/ROUTER/Router.ts checker-log <trigger> found|clean [--run <id>]  log one separate checker's result (CheckerYield.ts); audit reports the yield
 *   bun LIFEOS/ROUTER/Router.ts --json ...       machine output
 *
 * Lane resolution mirrors hooks/AgentInvocation.hook.ts and HookBridge codex-lanes:
 * an explicit `lane:` frontmatter key wins, else the type with a lower-cased first
 * letter, looked up in CROSS_VENDOR; a Claude-side agent carries a tier alias in
 * `model:`. Doc: LIFEOS/DOCUMENTATION/Router/RouterSystem.md · ISA: LIFEOS/ROUTER/ISA.md (maintainer-side state of record, not in the release)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CROSS_VENDOR, EFFORT_MODEL, INTELLIGENCE_AGENT, WORK_LADDER, agentForIntelligence } from "../TOOLS/models";
import { lifeosPath } from "../TOOLS/Paths";
import { SIDE_LANES, renderRules } from "../../hooks/lib/lane-rules";

export type AgentRoute = {
  agent: string;
  /** Frontmatter pin, including a codex agent's Claude wrapper. */
  modelPin: string | null;
  /** "codex" when the work runs in a `codex exec` child on a CROSS_VENDOR lane; "claude" when the agent itself is the worker
   *  (a tier alias in `model:`, or no `model:` at all — it inherits the session carrier, the documented default) */
  runtime: "codex" | "claude" | "unresolved";
  /** CROSS_VENDOR key, Claude tier alias, or "inherit" (session carrier) */
  lane: string | null;
  /** the id the lane resolves to today (never typed into prose; read here) */
  model: string | null;
  vendor: "openai" | "anthropic" | "google" | "xai" | "meta" | "unknown";
  effort: string | null;
  sandbox: string | null;
  readOnly: boolean;
};

const CLAUDE_TIERS = new Set(["opus", "sonnet", "haiku", "fable"]);

function vendorOf(model: string | null): AgentRoute["vendor"] {
  if (!model) return "unknown";
  if (/^gpt-/.test(model)) return "openai";
  if (/^claude-/.test(model) || CLAUDE_TIERS.has(model)) return "anthropic";
  if (/^gemini/.test(model)) return "google";
  if (/^grok/.test(model)) return "xai";
  if (/^muse-/.test(model)) return "meta";
  return "unknown";
}

/** Resolve one agent file's route. Pure over the file text plus the registry. */
export function routeOf(type: string, text: string, registry: Record<string, string> = CROSS_VENDOR): AgentRoute {
  const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const laneKey = fm.match(/^lane:\s*(\S+)/m)?.[1] ?? type.charAt(0).toLowerCase() + type.slice(1);
  const effort = text.match(/--reasoning-effort\s+(\w+)/)?.[1] ?? null;
  const sandbox = text.match(/--sandbox\s+([\w-]+)/)?.[1] ?? null;
  const readOnly = /^\s*-\s*Edit\s*$/m.test(fm) && /^\s*-\s*Write\s*$/m.test(fm);
  const modelLine = fm.match(/^model:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/m)?.[1]?.trim() ?? null;
  if (registry[laneKey]) {
    return { agent: type, modelPin: modelLine, runtime: "codex", lane: laneKey, model: registry[laneKey], vendor: vendorOf(registry[laneKey]), effort, sandbox, readOnly };
  }
  const fmEffort = fm.match(/^effort:\s*"?(\w+)"?/m)?.[1] ?? null;
  if (modelLine && CLAUDE_TIERS.has(modelLine)) {
    return { agent: type, modelPin: modelLine, runtime: "claude", lane: modelLine, model: modelLine, vendor: "anthropic", effort: fmEffort, sandbox: null, readOnly };
  }
  if (!modelLine || modelLine === "inherit") {
    // No pin: the dispatch inherits the session carrier (OPERATIONAL_PREFERENCES § Model selection — naming a model is what rots).
    return { agent: type, modelPin: modelLine, runtime: "claude", lane: "inherit", model: "session carrier", vendor: "anthropic", effort: fmEffort, sandbox: null, readOnly };
  }
  // A model: that is neither a tier alias nor inherit is a pinned id or a typo — the drift the registry exists to prevent.
  return { agent: type, modelPin: modelLine, runtime: "unresolved", lane: null, model: null, vendor: "unknown", effort, sandbox, readOnly };
}

/** Every agent in the roster dir, routed. */
export function roster(agentsDir: string, registry: Record<string, string> = CROSS_VENDOR): AgentRoute[] {
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((f) => routeOf(f.slice(0, -3), readFileSync(join(agentsDir, f), "utf8"), registry));
}

export type Resolution = { phrase: string; agent: string | null; route: AgentRoute | null };

/** A spoken level → agent → its route. */
export function resolve(phrase: string, routes: AgentRoute[], aliases: Record<string, string> = INTELLIGENCE_AGENT): Resolution {
  const agent = agentForIntelligenceIn(phrase, aliases);
  return { phrase, agent, route: agent ? routes.find((r) => r.agent === agent) ?? null : null };
}

function agentForIntelligenceIn(phrase: string, aliases: Record<string, string>): string | null {
  if (aliases === INTELLIGENCE_AGENT) return agentForIntelligence(phrase);
  const key = phrase.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  return aliases[key] ?? null;
}

export type Status = { ok: boolean; unresolved: string[]; dangling: string[]; ladder: string[]; sideLanes: string[]; cheapTiers: string[]; badEffort: string[]; agents: number; lanes: number };

export function sideLaneViolations(routes: AgentRoute[], sides: Record<string, { agent: string; rule: string }> = SIDE_LANES): string[] {
  return Object.entries(sides).filter(([, side]) => !routes.some((r) => r.agent === side.agent && r.runtime !== "unresolved")).map(([name, side]) => `${name} → ${side.agent}: no such agent or no lane`);
}

/**
 * The cheap tier. Since 2026-10-07 Haiku carries the low rung only, as the in-process Haiku agent at
 * effort high. It stays out of everything else: never a codex wrapper (R21: a Haiku wrapper once spent
 * 20 turns on a leg and applied nothing), never a medium, high or max rung agent, and never an
 * EFFORT_MODEL level, where Sonnet is the floor for the Inference fallback.
 */
const CHEAP_TIER = "haiku";
/** The rung that exists for near-mechanical work: the Haiku agent (effort high) only. */
const CHEAP_RUNG = "low";

/**
 * The work ladder held to its policy (2026-09-21):
 *   · every rung names at least one agent, and every named agent exists and resolves to a lane;
 *   · low is the cheap rung for near-mechanical work — the in-process Haiku agent at effort high only (2026-10-07);
 *   · medium, high and max may be either vendor, because the lane at a rung is picked by the kind of
 *     work needs (hooks/lib/lane-rules.ts ROUTING_RULES): Opus for judgment, Sonnet for execution,
 *     Sol for spec-complete work. An Anthropic rung agent there must pin a real tier other than haiku;
 *     medium holds the Sonnet family (Sonnet at medium effort) and Sol.
 */
export function ladderViolations(routes: AgentRoute[], ladder: Record<string, readonly string[]> = WORK_LADDER): string[] {
  const out: string[] = [];
  for (const [level, agents] of Object.entries(ladder)) {
    if (agents.length === 0) out.push(`${level}: no agent`);
    for (const agent of agents) {
      const r = routes.find((x) => x.agent === agent);
      if (!r || r.runtime === "unresolved") { out.push(`${level} → ${agent}: no such agent or no lane`); continue; }
      const openaiCodex = r.runtime === "codex" && r.vendor === "openai";
      if (level === CHEAP_RUNG) {
        if (r.runtime !== "claude" || r.lane !== CHEAP_TIER || r.effort !== "high") out.push(`${level} → ${agent}: the low rung must be the in-process Haiku agent at effort high (is ${r.runtime}/${r.vendor}, lane ${r.lane ?? "none"}, effort ${r.effort ?? "none"})`);
        continue;
      }
      if (openaiCodex) continue;
      // The Anthropic side of a rung: a real tier pin, and never a banned tier.
      if (r.runtime !== "claude" || r.vendor !== "anthropic" || r.lane === "inherit") out.push(`${level} → ${agent}: must be an OpenAI codex lane or an Anthropic tier agent (is ${r.runtime}/${r.vendor}, lane ${r.lane ?? "none"})`);
      else if (r.lane === CHEAP_TIER) out.push(`${level} → ${agent}: haiku carries only the low rung — Sonnet is the floor above it`);
    }
  }
  return out;
}

/** Effort the rule forbids (RouterSystem § effort: never below medium, never max): settings files and Claude agents. */
const BANNED_EFFORT = new Set(["low", "minimal", "max"]);

export function effortViolations(routes: AgentRoute[], settings: { path: string; json: any }[] = []): string[] {
  const out: string[] = [];
  for (const s of settings) {
    const top = s.json?.effortLevel;
    if (typeof top === "string" && BANNED_EFFORT.has(top)) out.push(`${s.path}: effortLevel "${top}"`);
    for (const [model, cfg] of Object.entries(s.json?.modelSettings ?? {})) {
      const lvl = (cfg as any)?.effortLevel;
      if (typeof lvl === "string" && BANNED_EFFORT.has(lvl)) out.push(`${s.path}: modelSettings.${model}.effortLevel "${lvl}"`);
    }
  }
  for (const r of routes) if (r.runtime === "claude" && r.effort && BANNED_EFFORT.has(r.effort)) out.push(`agents/${r.agent}.md: effort: ${r.effort}`);
  return out;
}

/** Roster/registry parity, ladder policy, the Haiku fences and the effort range; every violation makes `ok` false. */
export function status(routes: AgentRoute[], aliases: Record<string, string> = INTELLIGENCE_AGENT, registry: Record<string, string> = CROSS_VENDOR, ladderTable: Record<string, readonly string[]> = WORK_LADDER, effortTable: Readonly<Record<string, string>> = EFFORT_MODEL, settings: { path: string; json: any }[] = []): Status {
  const unresolved = routes.filter((r) => r.runtime === "unresolved").map((r) => r.agent);
  const dangling = Object.entries(aliases)
    .filter(([, agent]) => { const r = routes.find((x) => x.agent === agent); return !r || r.runtime === "unresolved"; })
    .map(([phrase, agent]) => `${phrase} → ${agent}`);
  const ladder = ladderViolations(routes, ladderTable);
  const sideLanes = sideLaneViolations(routes);
  // R21: Haiku runs only as an in-process cheap-rung agent: never a codex wrapper, never an EFFORT_MODEL level.
  const cheapTiers = [
    ...routes.filter((r) => r.runtime === "codex" && r.modelPin === CHEAP_TIER).map((r) => `agents/${r.agent}.md: model: ${r.modelPin} on a codex wrapper`),
    ...Object.entries(effortTable).filter(([, tier]) => tier === CHEAP_TIER).map(([level, tier]) => `EFFORT_MODEL.${level}: ${tier}`),
  ];
  const badEffort = effortViolations(routes, settings);
  return { ok: unresolved.length === 0 && dangling.length === 0 && ladder.length === 0 && sideLanes.length === 0 && cheapTiers.length === 0 && badEffort.length === 0, unresolved, dangling, ladder, sideLanes, cheapTiers, badEffort, agents: routes.length, lanes: Object.keys(registry).length };
}

function table(routes: AgentRoute[]): string {
  const rows = routes.map((r) => [r.agent, r.runtime, r.lane ?? "—", r.vendor, r.effort ?? (r.lane === "inherit" ? "session" : "—"), r.sandbox ?? (r.runtime === "claude" ? "harness" : "—"), r.readOnly ? "read-only" : "writes"]);
  const head = ["agent", "runtime", "lane", "vendor", "effort", "sandbox", "access"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join("  ");
  return [line(head), line(w.map((n) => "─".repeat(n))), ...rows.map(line)].join("\n");
}

export function decisionSummary(path = process.env.LIFEOS_ROUTER_DECISIONS_LOG || lifeosPath("MEMORY", "OBSERVABILITY", "router-decisions.jsonl"), days?: number): string {
  const rows: any[] = [];
  if (existsSync(path)) for (const line of readFileSync(path, "utf8").split("\n")) try { const row = JSON.parse(line); if (!days || Date.parse(row.ts) >= Date.now() - days * 86_400_000) rows.push(row); } catch {}
  const count = (key: "frontDoor" | "source") => Object.entries(rows.reduce((a, r) => { const v = String(r[key] ?? "unknown"); a[v] = (a[v] ?? 0) + 1; return a; }, {} as Record<string, number>)).sort().map(([k, v]) => `${k}=${v}`).join(" ") || "none";
  // r.jev is Glance's pick under the key router-decisions.jsonl stores it as (Jev retired 2026-10-10).
  const both = rows.filter(r => r.jev?.pick && (r.classifier ?? r.astra)); const agree = both.filter(r => r.jev.pick === (r.classifier ?? r.astra)).length;
  return `router decisions: ${rows.length}\nfront doors: ${count("frontDoor")}\nsources: ${count("source")}\nGlance-vs-classifier agreement: ${agree}/${both.length}${both.length ? ` (${(agree / both.length * 100).toFixed(1)}%)` : ""}`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const cmd = args[0] ?? "lanes";
  const claudeDir = process.env.CLAUDE_DIR ?? join(process.env.HOME ?? "", ".claude");
  const routes = roster(join(claudeDir, "agents"));
  if (cmd === "lanes") {
    if (json) console.log(JSON.stringify({ routes, ladder: WORK_LADDER, sideLanes: SIDE_LANES, tiers: EFFORT_MODEL, levels: INTELLIGENCE_AGENT }, null, 2));
    else {
      console.log(table(routes));
      console.log(`\nWork ladder (WORK_LADDER): ${Object.entries(WORK_LADDER).map(([k, v]) => `${k}→${v.join("/")}`).join("  ")}`);
      console.log(`Side lanes (SIDE_LANES): ${Object.entries(SIDE_LANES).map(([k, v]) => `${k}→${v.agent}`).join("  ")}`);
      console.log(`Claude tiers (EFFORT_MODEL — wrappers and the Inference fallback, not dispatch lanes): ${Object.entries(EFFORT_MODEL).map(([k, v]) => `${k}→${v}`).join("  ")}`);
      console.log(`Spoken levels (INTELLIGENCE_AGENT): ${Object.entries(INTELLIGENCE_AGENT).map(([k, v]) => `"${k}"→${v}`).join("  ")}`);
    }
  } else if (cmd === "rules") {
    console.log(renderRules());
  } else if (cmd === "resolve") {
    const phrase = args.slice(1).join(" ");
    if (!phrase) { console.error("usage: Router.ts resolve <phrase>"); process.exit(2); }
    const r = resolve(phrase, routes);
    if (json) console.log(JSON.stringify(r, null, 2));
    else if (!r.agent) { console.log(`"${phrase}" is not a spoken level (known: ${Object.keys(INTELLIGENCE_AGENT).join(", ")})`); process.exit(1); }
    else console.log(`"${phrase}" → ${r.agent} → ${r.route?.lane ?? "NO LANE"} (${r.route?.vendor ?? "?"}${r.route?.effort ? `, ${r.route.effort} effort` : ""})`);
  } else if (cmd === "status") {
    const settingsFiles = [join(claudeDir, "settings.json"), lifeosPath("USER", "CONFIG", "settings.user.json")]
      .filter((f) => existsSync(f))
      .map((f) => { try { return { path: f.replace(process.env.HOME ?? "", "~"), json: JSON.parse(readFileSync(f, "utf8")) }; } catch { return null; } })
      .filter((x): x is { path: string; json: any } => x !== null);
    const s = status(routes, INTELLIGENCE_AGENT, CROSS_VENDOR, WORK_LADDER, EFFORT_MODEL, settingsFiles);
    if (json) console.log(JSON.stringify(s, null, 2));
    else {
      console.log(`${s.ok ? "✓" : "✗"} router: ${s.agents} agents, ${s.lanes} lanes`);
      for (const a of s.unresolved) console.log(`  ✗ ${a}: model: is neither a CROSS_VENDOR lane, a Claude tier alias, nor inherit`);
      for (const d of s.dangling) console.log(`  ✗ alias dangles: ${d}`);
      for (const l of s.ladder) console.log(`  ✗ ladder: ${l}`);
      for (const l of s.sideLanes) console.log(`  ✗ side lane: ${l}`);
      for (const h of s.cheapTiers) console.log(`  ✗ R21: ${h}`);
      for (const e of s.badEffort) console.log(`  ✗ effort (never below medium, never max): ${e}`);
    }
    process.exitCode = s.ok ? 0 : 1;
  } else if (cmd === "models") {
    const { modelMap, formatModelMap } = await import("./ModelMap");
    const entries = modelMap(claudeDir, routes);
    console.log(json ? JSON.stringify(entries, null, 2) : formatModelMap(entries, args.includes("--files")));
  } else if (cmd === "audit") {
    const { auditSessions, defaultOptions, formatAudit } = await import("./RouteAudit");
    const a = auditSessions(defaultOptions(args));
    const { readChecker, yieldByTrigger, formatYield } = await import("./CheckerYield");
    const checkers = yieldByTrigger(readChecker());
    console.log(json ? JSON.stringify({ ...a, checkerYield: checkers }, null, 2) : `${formatAudit(a, args.includes("--rows"))}\n\n${formatYield(checkers)}`);
  } else if (cmd === "fable") {
    // Router ISA F9 (R139): the pool's Fable budget now, then how much Fable the sessions ran and how long work waited on it.
    const { readFableBudget, formatFableBudget } = await import("./FableBudget");
    const { fableLegs, formatFableLegs } = await import("./FableLegs");
    const d = args.indexOf("--days"); const days = d >= 0 ? Number(args[d + 1]) || 7 : 7;
    const budget = readFableBudget();
    const legs = fableLegs(process.env.ROUTE_AUDIT_PROJECTS ?? join(claudeDir, "projects"), days);
    console.log(json ? JSON.stringify({ ...budget, ...legs }, null, 2) : `${formatFableBudget(budget)}\n\n${formatFableLegs(legs)}`);
  } else if (cmd === "checker-log") {
    const { TRIGGERS, appendChecker } = await import("./CheckerYield");
    const [trigger, result] = args.filter((x) => !x.startsWith("--")).slice(1);
    const r = args.indexOf("--run");
    if (!(TRIGGERS as readonly string[]).includes(trigger ?? "") || (result !== "found" && result !== "clean")) { console.error(`usage: Router.ts checker-log <${TRIGGERS.join("|")}> found|clean [--run <id>]`); process.exit(2); }
    appendChecker({ ts: new Date().toISOString(), trigger: trigger as (typeof TRIGGERS)[number], result, ...(r >= 0 && args[r + 1] ? { run: args[r + 1] } : {}) });
    console.log(`logged ${trigger} ${result}`);
  } else if (cmd === "glance") {
    const i = args.indexOf("--days"); const days = i >= 0 ? Number(args[i + 1]) : undefined;
    if (days !== undefined && (!Number.isFinite(days) || days < 0)) { console.error("--days must be a nonnegative number"); process.exit(2); }
    console.log(decisionSummary(undefined, days));
  } else if (cmd === "holdout") {
    // The router holdout switch (execution-evidence ISC-25): only the principal turns it on. Bare reads it.
    const { DEFAULT_HOLDOUT_RATE, MAX_HOLDOUT_RATE, holdoutPath, loadHoldout, setHoldout } = await import("./Holdout");
    const mode = args[1];
    const ri = args.indexOf("--rate");
    const rate = ri >= 0 ? Number(args[ri + 1]) : DEFAULT_HOLDOUT_RATE;
    const usage = `usage: Router.ts holdout [on|off] [--rate R]   (R in (0, ${MAX_HOLDOUT_RATE}], default ${DEFAULT_HOLDOUT_RATE})`;
    if (mode === undefined) { const c = loadHoldout(); console.log(json ? JSON.stringify({ ...c, path: holdoutPath() }) : (c.mode === "on" ? `router holdout: on at rate ${c.rate}` : "router holdout: off")); }
    else if (mode !== "on" && mode !== "off") { console.error(usage); process.exit(2); }
    else if (mode === "on" && (!Number.isFinite(rate) || rate <= 0 || rate > MAX_HOLDOUT_RATE)) { console.error(usage); process.exit(2); }
    else { setHoldout({ mode, rate: mode === "on" ? rate : 0 }); console.log(mode === "on" ? `router holdout: on at rate ${rate} (${holdoutPath()})` : `router holdout: off (${holdoutPath()})`); }
  } else if (cmd === "deadlines") {
    // F5 R107: each logged deadline joined to its transcript, on time or late (Shape.ts).
    const { deadlinesReport } = await import("./Shape");
    const i = args.indexOf("--days"); const days = i >= 0 ? Number(args[i + 1]) : undefined;
    if (days !== undefined && (!Number.isFinite(days) || days <= 0)) { console.error("--days must be a positive number"); process.exit(2); }
    const r = deadlinesReport({ days });
    console.log(json ? JSON.stringify({ ...r, text: undefined }, null, 2) : r.text);
  } else {
    console.error("usage: Router.ts lanes | rules | resolve <phrase> | status | models [--files] | audit [...] | checker-log <trigger> found|clean | glance [--days N] | deadlines [--days N] | holdout [on|off] [--rate R]");
    process.exit(2);
  }
}
