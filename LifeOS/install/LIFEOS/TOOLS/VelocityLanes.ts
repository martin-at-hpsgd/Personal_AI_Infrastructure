/**
 * VelocityLanes — pure helpers behind the Velocity "Models" view, every vendor.
 *
 * Two evidence classes, kept apart on purpose:
 *   - LANE PINS: which model each lane was configured to run, from git history
 *     (settings.json carrier/advisor; models.ts CROSS_VENDOR lanes). Inference.
 *   - DISPATCHES: which agent actually ran, on which resolved model, from the
 *     subagent event log written by hooks/AgentInvocation.hook.ts. Evidence.
 *
 * Neither attributes commits. Commit attribution stays carrier-only in the
 * collector, because no commit carries a non-Anthropic trailer (survey 2026-09-06).
 * No vendor list lives here: vendor and label are derived from the model id.
 */

export type Vendor = "Anthropic" | "OpenAI" | "Google" | "xAI" | "Perplexity" | "Z.ai" | "Other";
export interface LanePin { lane: string; vendor: Vendor; at: number; raw: string; label: string }
export interface Dispatch { day: string; agent: string; model: string; vendor: Vendor; label: string; n: number; secs: number }
export interface ModelAlias { match: string; label: string; from?: Record<string, string> }

/** models.ts keys that are tier or alias tables (effort tiers, Claude alias → id), not vendor lanes. The carrier lane covers Anthropic. */
const TIER_KEYS = new Set(["max", "high", "medium", "low", "xhigh", "opus", "sonnet", "haiku", "fable"]);
const CLAUDE_ALIASES = /^(opus|sonnet|haiku|fable|inherited|default)$/i;

export function vendorOf(model: string, agent?: string): Vendor {
  const m = model.toLowerCase();
  if (/^(gpt|o\d|codex|chatgpt)/.test(m)) return "OpenAI";
  if (/gemini/.test(m)) return "Google";
  if (/grok/.test(m)) return "xAI";
  if (/^z-ai\/|glm/.test(m)) return "Z.ai";
  if (/sonar|perplexity/.test(m) || /perplexity/i.test(agent ?? "")) return "Perplexity";
  if (/claude|opus|sonnet|haiku|fable/.test(m) || CLAUDE_ALIASES.test(m)) return "Anthropic";
  return "Other";
}

/** "gpt-6-astra" → "GPT-6 Astra", "gemini-3.8-flash" → "Gemini 3.8 Flash", a Claude fable id → "Fable 5.1". Aliases win. */
export function prettyModel(raw: string, atMs: number, aliases: ModelAlias[] = []): string {
  for (const a of aliases) {
    if (!new RegExp(a.match, "i").test(raw)) continue;
    let l = a.label;
    for (const [from, lab] of Object.entries(a.from ?? {}).sort()) if (atMs >= Date.parse(from + "T00:00:00")) l = lab;
    return l;
  }
  let s = raw.replace(/\[1m\]$/, "").replace(/-latest$/, "").replace(/-\d{8}$/, "").replace(/^z-ai\//, "");
  if (/^claude-/.test(s)) { s = s.replace(/^claude-/, ""); const m = s.match(/^([a-z]+)-(\d+)(?:-(\d+))?$/); if (m) return `${cap(m[1])} ${m[2]}${m[3] ? "." + m[3] : ""}`; }
  const parts = s.split("-").map((p) => (/^(gpt|glm)$/i.test(p) ? p.toUpperCase() : /^\d/.test(p) ? p : cap(p)));
  // "GPT-6 Astra": the family keeps its hyphen to the version, everything else is space-joined.
  return parts.reduce((acc, p, i) => acc + (i === 0 ? "" : /^(GPT|GLM)$/.test(parts[i - 1]) && /^\d/.test(p) ? "-" : " ") + p, "");
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The model a commit's Co-Authored-By trailers name, or null when none names one.
 * Accepts the Claude harness form ("Claude Opus 4.6", "Claude Opus 4.6 (1M context)"),
 * a raw id ("gpt-6-astra"), or a pretty label; a bare "Claude", a human, or a tool
 * name ("opencode") is not a model. Returns { label, vendor } in the Velocity label style.
 */
export function trailerModel(values: string[], atMs = 0, aliases: ModelAlias[] = []): { label: string; vendor: Vendor } | null {
  for (const v of values) {
    const name = v.replace(/<[^>]*>/g, "").replace(/\(1M context\)/i, "").trim();
    if (!name) continue;
    const claude = name.match(/^Claude\s+(.+)$/i);
    if (claude) { const rest = claude[1].trim(); if (/^(opus|sonnet|haiku|fable)\b/i.test(rest)) return { label: rest.replace(/\s+/g, " "), vendor: "Anthropic" }; continue; }
    if (/^[a-z][a-z0-9]*(?:[-./][a-z0-9]+)+$/i.test(name) && vendorOf(name) !== "Other") return { label: prettyModel(name, atMs, aliases), vendor: vendorOf(name) };
  }
  return null;
}

/**
 * Lane pins from `git log --reverse --format=%x01%aI -p` output.
 * `settings.json` yields carrier (`"model"`) and legacy advisor (`"advisorModel"`) from old diffs;
 * `models.ts` yields one lane per CROSS_VENDOR key. Tier keys are skipped,
 * consecutive identical labels within a lane collapse.
 */
export function parseLanePins(gitLog: string, source: "settings" | "models", aliases: ModelAlias[] = []): LanePin[] {
  const out: LanePin[] = [];
  const last = new Map<string, string>();
  let at = 0;
  for (const line of gitLog.split("\n")) {
    if (line.startsWith("\x01")) { at = Date.parse(line.slice(1)); continue; }
    let lane: string | null = null, raw: string | null = null;
    if (source === "settings") {
      const m = line.match(/^\+\s*"(model|advisorModel)":\s*"([^"]+)"/);
      if (m) { lane = m[1] === "model" ? "carrier" : "advisor"; raw = m[2]; }
    } else {
      const m = line.match(/^\+\s*([A-Za-z_]\w*):\s*"([^"]+)"/);
      if (m && !TIER_KEYS.has(m[1])) { lane = m[1]; raw = m[2]; }
    }
    if (!lane || !raw) continue;
    const label = prettyModel(raw, at, aliases);
    if (last.get(lane) === label) continue;
    last.set(lane, label);
    out.push({ lane, vendor: vendorOf(raw), at, raw, label });
  }
  return out;
}

/** Per-day dispatch counts and total run seconds per (agent, model), from the subagent event log (JSONL). Days before `since` are dropped. */
export function parseDispatches(jsonl: string, since: string, aliases: ModelAlias[] = []): Dispatch[] {
  const starts = new Map<string, { day: string; agent: string; model: string; at: number }>();
  const acc = new Map<string, Dispatch>();
  const bump = (day: string, agent: string, model: string, at: number, secs: number) => {
    const key = `${day}${agent}${model}`;
    const d = acc.get(key) ?? { day, agent, model, vendor: vendorOf(model, agent), label: prettyModel(model, at, aliases), n: 0, secs: 0 };
    d.n += secs === 0 ? 1 : 0; d.secs += secs; acc.set(key, d);
  };
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    const ts = String(e.timestamp ?? ""); const day = ts.slice(0, 10);
    if (!day || day < since) continue;
    if (e.event === "subagent_start") {
      const agent = String(e.subagent_type ?? "unknown"), model = String(e.subagent_model ?? "unknown");
      starts.set(String(e.subagent_id), { day, agent, model, at: Date.parse(ts) });
      bump(day, agent, model, Date.parse(ts), 0);
    } else if (e.event === "subagent_stop") {
      const s = starts.get(String(e.subagent_id)); if (!s) continue;
      const secs = Number(e.duration_seconds ?? 0); if (secs > 0) bump(s.day, s.agent, s.model, s.at, secs);
    }
  }
  return [...acc.values()].sort((a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent));
}
