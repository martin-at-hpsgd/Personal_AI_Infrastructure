/**
 * ModelUse — the per-session log of model calls the harness transcript never sees.
 *
 * A direct vendor call (GrokQuery, GeminiSearch, Inference, ApiLane, a Worker run) spends tokens outside every Claude
 * transcript, so the statusline ladder could not light that model. Each of those tools appends one line here, keyed by
 * the session id Claude Code puts in every Bash call's environment. An agent's Bash shares its parent's session id, so
 * the same line lands whether the principal's session called the tool directly or an agent called it, and the lane
 * lights either way. ModelMix reads it back.
 *
 * Recording never throws into the caller: observability must not break a model call.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLifeosDir } from "../Paths";
import { invariant } from "../Invariant";

export interface ModelUse { ts: string; model: string; output: number }

const SESSION = /^[A-Za-z0-9_-]{1,128}$/;

export const modelUseDir = (): string => join(getLifeosDir(), "MEMORY", "STATE", "model-use");

/** The calling session's id, or null outside a Claude Code session (launchd jobs, a bare terminal). */
export function sessionOf(env: Record<string, string | undefined> = process.env): string | null {
  const id = env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || "";
  return SESSION.test(id) ? id : null;
}

/** Append one call to this session's log. A missing session or an unwritable log records nothing. */
export function recordModelUse(model: string, outputTokens: number, env: Record<string, string | undefined> = process.env): void {
  // Under bun test, mocked vendor calls would light the live session's ladder; only a test-supplied env records.
  if (env === process.env && env.NODE_ENV === "test") return;
  const session = sessionOf(env);
  if (!session || !model) return;
  const output = Number.isFinite(outputTokens) && outputTokens > 0 ? Math.round(outputTokens) : 0;
  try {
    invariant(typeof model === "string" && model.length <= 200 && !/[\n\r]/.test(model), "model id must be one short line");
    invariant(output >= 0, "output tokens must be non-negative");
    const dir = modelUseDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${session}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), model, output } satisfies ModelUse) + "\n");
  } catch { /* observability never breaks the call it observes */ }
}

/** Every well-formed line of a session's log; malformed lines are skipped. */
export function readModelUse(session: string): ModelUse[] {
  if (!SESSION.test(session)) return [];
  const file = join(modelUseDir(), `${session}.jsonl`);
  if (!existsSync(file)) return [];
  const out: ModelUse[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as Partial<ModelUse>;
      if (typeof e.model === "string" && e.model && typeof e.output === "number" && e.output >= 0) out.push({ ts: String(e.ts ?? ""), model: e.model, output: e.output });
    } catch { /* a torn line from a concurrent append */ }
  }
  return out;
}

/**
 * The one roster of non-Claude ladder lanes: how a model id maps to its lane, and the label, colours and draw slot the
 * statusline ladder uses (the Claude rungs sit at slots 40, 50, 80 and 100 in STATUSLINE/sections/Ladder.ts). A lane is
 * drawn only while some models.ts id still maps to it, so retiring a model's last id takes it off the ladder with no edit
 * here (Terra, retired 2026-10-08, was still drawn until this roster replaced four hand-kept copies, 2026-10-12).
 * Adding a model is one entry here. Claude ids map to no lane; ModelMix gives them their effort rung. A lane marked
 * `drawLast` is drawn rightmost, as the smartest, whatever the ladder-rank scores say.
 */
export const LANE_ROSTER = [
  { lane: "gemini", label: "ARGON", slot: 10, rgb: [215, 105, 35], dim: [165, 110, 70], matches: (m: string) => m.includes("gemini") },
  { lane: "grok", label: "GROK", slot: 20, rgb: [210, 175, 30], dim: [160, 140, 70], matches: (m: string) => m.includes("grok") },
  { lane: "muse", label: "MUSE", slot: 30, rgb: [255, 158, 100], dim: [170, 125, 100], matches: (m: string) => m.startsWith("muse-") },
  { lane: "luna", label: "LUNA", slot: 60, rgb: [185, 195, 215], dim: [140, 150, 170], matches: (m: string) => m.startsWith("gpt-") && m.includes("-luna") },
  { lane: "sol", label: "SOL", slot: 70, rgb: [50, 160, 210], dim: [70, 130, 165], matches: (m: string) => m.startsWith("gpt-") && m.includes("-sol") },
  { lane: "astra", label: "ASTRA", slot: 90, rgb: [95, 200, 215], dim: [85, 160, 175], matches: (m: string) => m.startsWith("gpt-") && m.includes("-astra") },
] as const;

export type UseLane = (typeof LANE_ROSTER)[number]["lane"];
export const USE_LANES: UseLane[] = LANE_ROSTER.map((r) => r.lane);

export function laneForUse(model: string): UseLane | null {
  const m = model.toLowerCase();
  return LANE_ROSTER.find((r) => r.matches(m))?.lane ?? null;
}

/** The lanes some registry id still maps to: the ones the ladder draws. */
export function liveLanes(ids: readonly string[]): Set<UseLane> {
  const live = new Set<UseLane>();
  for (const id of ids) { const lane = laneForUse(id); if (lane) live.add(lane); }
  return live;
}
