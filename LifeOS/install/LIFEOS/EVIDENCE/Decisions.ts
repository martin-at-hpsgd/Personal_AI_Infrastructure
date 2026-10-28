/**
 * @version 1.0.0
 * Decisions.ts — pairs each main-session turn with the router's pick and with what actually happened.
 *
 * Join, in order:
 *   turn_id     router row `turn` equals the harness promptId (true from commit df403d197 on)
 *   session_ts  older rows carry random turn UUIDs: the latest router row in the same session whose ts
 *               is at or before the prompt (plus JOIN_SLACK_MS for clock skew between the hook and the
 *               transcript writer) and after the previous turn's prompt, never a row already used
 *   none        no router row fits
 *
 * What happened comes from the turn's own spans: the first chat span's requested model and per-turn
 * effort, the Skill and Agent tool calls, and Worker.ts legs launched from Bash. Subagent turns carry
 * no router pick and get no decision row.
 */
import type { Database } from "bun:sqlite";
import { invariant } from "../TOOLS/Invariant";
import { THINKING_SKILLS } from "../ROUTER/Depth";

/** Allowance for the router row landing just after the transcript's prompt timestamp. Measured on the
 *  exact (turn_id) joins of 2026-10-09: router ts minus prompt ts was p50 +0.6 s, max +2.2 s. */
export const JOIN_SLACK_MS = 5_000;

/** Bump when the join or match rules change, so the next build recomputes every decision row. */
export const DECISIONS_VERSION = "3";

const THINKING: ReadonlySet<string> = new Set(THINKING_SKILLS);

/** holdout: the router holdout arm (1 held out, 0 routed), null when the turn was not in the experiment (version 3). */
interface RouterRow { offset: number; ts: string; session: string | null; turn: string | null; lane: string | null; agent: string | null; effort: string | null; level: string | null; binding: number | null; think_skill: string | null; holdout: number | null }
interface TurnRow { span_id: string; trace_id: string; prompt_id: string; start_time: string; origin: string }

/** Model family of a Claude model id: claude-opus-<ver> -> opus, a dated claude-haiku-<ver>-<date> id -> haiku. Null for anything else. */
export function modelFamily(model: string | null): string | null {
  return model ? /^claude-([a-z]+)-/.exec(model.toLowerCase())?.[1] ?? null : null;
}

/**
 * Lane compliance counts by model (version 2): the pick matches when the turn dispatched that lane, or ran
 * inline (no Agent call, no Worker leg) on that lane's model family, so "opus" is met by an inline turn on
 * claude-opus-*. "inline" still means no dispatch at all. Agent compliance stays a pure delegation measure.
 */
export function laneMatches(pickLane: string | null, agents: string[], workers: string[], actModel: string | null = null): number | null {
  if (!pickLane) return null;
  const lane = pickLane.toLowerCase();
  const inline = agents.length === 0 && workers.length === 0;
  if (lane === "inline") return inline ? 1 : 0;
  if (agents.some((a) => a.toLowerCase().startsWith(lane)) || workers.includes(lane)) return 1;
  return inline && modelFamily(actModel) === lane ? 1 : 0;
}

export function agentMatches(pickAgent: string | null, agents: string[], workers: string[]): number | null {
  if (!pickAgent) return null;
  const worker = /^Worker\.ts\s+([a-z]+)/.exec(pickAgent)?.[1];
  if (worker) return workers.includes(worker) ? 1 : 0;
  return agents.includes(pickAgent) ? 1 : 0;
}

export function thinkMatches(pickThink: string | null, think: string[]): number | null {
  if (!pickThink) return null;
  if (pickThink === "none") return think.length === 0 ? 1 : 0;
  return think.includes(pickThink) ? 1 : 0;
}

export function rebuildDecisions(db: Database): number {
  const turns = db.query("SELECT span_id, trace_id, prompt_id, start_time, origin FROM spans WHERE parent_span_id IS NULL AND is_sidechain = 0 ORDER BY trace_id, start_time, span_id").all() as TurnRow[];
  const router = db.query("SELECT offset, ts, session, turn, lane, agent, effort, level, binding, think_skill, holdout FROM router_rows ORDER BY ts, offset").all() as RouterRow[];
  const promptIds = new Set(turns.map((t) => t.prompt_id));
  const byTurn = new Map<string, RouterRow>();
  const bySession = new Map<string, RouterRow[]>();
  for (const r of router) {
    if (r.turn && promptIds.has(r.turn)) { if (!byTurn.has(r.turn)) byTurn.set(r.turn, r); continue; }
    if (!r.session) continue;
    const list = bySession.get(r.session) ?? [];
    list.push(r);
    bySession.set(r.session, list);
  }

  const chatQ = db.query(`SELECT "gen_ai.request.model" AS model, "lifeos.request.effort" AS effort, "gen_ai.usage.input_tokens" AS i, "gen_ai.usage.output_tokens" AS o, "lifeos.cost_usd" AS c FROM chat_spans WHERE parent_span_id = ? ORDER BY start_time, span_id`);
  const toolQ = db.query(`SELECT "gen_ai.tool.name" AS name, skill, subagent_type, worker_lane FROM tool_calls WHERE parent_span_id = ? ORDER BY start_time, span_id`);
  const insert = db.query(`INSERT INTO decisions (span_id, session_id, prompt_id, origin, join_method, router_offset, router_ts, pick_lane, pick_agent, pick_effort, pick_level, pick_think, pick_binding, act_model, act_effort, act_agents, act_skills, act_think, act_input_tokens, act_output_tokens, act_cost_usd, lane_match, agent_match, effort_match, think_match, holdout) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let written = 0;
  db.transaction(() => {
    db.exec("DELETE FROM decisions");
    const used = new Set<number>();
    let prevSession = "";
    let prevStart = "";
    for (const t of turns) {
      if (t.trace_id !== prevSession) { prevSession = t.trace_id; prevStart = ""; }
      let pick: RouterRow | null = null;
      let method: "turn_id" | "session_ts" | "none" = "none";
      const exact = byTurn.get(t.prompt_id);
      if (exact && (!exact.session || exact.session === t.trace_id)) { pick = exact; method = "turn_id"; }
      else {
        const limit = new Date(Date.parse(t.start_time) + JOIN_SLACK_MS).toISOString();
        const candidates = bySession.get(t.trace_id) ?? [];
        for (let i = candidates.length - 1; i >= 0; i--) {
          const r = candidates[i];
          if (r.ts > limit || used.has(r.offset)) continue;
          if (prevStart && r.ts <= prevStart) break;
          pick = r; method = "session_ts"; break;
        }
      }
      if (pick) used.add(pick.offset);
      prevStart = t.start_time;

      const chats = chatQ.all(t.span_id) as Array<{ model: string | null; effort: string | null; i: number | null; o: number | null; c: number | null }>;
      const tools = toolQ.all(t.span_id) as Array<{ name: string; skill: string | null; subagent_type: string | null; worker_lane: string | null }>;
      const agents = tools.filter((x) => x.subagent_type).map((x) => x.subagent_type as string);
      const workers = tools.filter((x) => x.worker_lane).map((x) => x.worker_lane as string);
      const skills = [...new Set(tools.filter((x) => x.skill).map((x) => x.skill as string))];
      const think = skills.filter((s) => THINKING.has(s));
      const actModel = chats.find((c) => c.model)?.model ?? null;
      const actEffort = chats.find((c) => c.effort)?.effort ?? null;
      const sum = (k: "i" | "o" | "c") => chats.some((c) => c[k] !== null) ? chats.reduce((a, c) => a + (c[k] ?? 0), 0) : null;
      invariant(method === "none" ? pick === null : pick !== null, `join method ${method} disagrees with pick for ${t.span_id}`);
      insert.run(
        t.span_id, t.trace_id, t.prompt_id, t.origin, method, pick?.offset ?? null, pick?.ts ?? null,
        pick?.lane ?? null, pick?.agent ?? null, pick?.effort ?? null, pick?.level ?? null, pick?.think_skill ?? null, pick?.binding ?? null,
        actModel, actEffort, JSON.stringify([...agents, ...workers.map((w) => `worker:${w}`)]), JSON.stringify(skills), JSON.stringify(think),
        sum("i"), sum("o"), sum("c"),
        laneMatches(pick?.lane ?? null, agents, workers, actModel), agentMatches(pick?.agent ?? null, agents, workers),
        pick?.effort ? (actEffort === pick.effort ? 1 : 0) : null, thinkMatches(pick?.think_skill ?? null, think),
        pick?.holdout ?? null,
      );
      written++;
    }
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('decisions_version', ?)").run(DECISIONS_VERSION);
  })();
  return written;
}
