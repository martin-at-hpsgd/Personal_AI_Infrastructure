import { RESET } from "../Ansi";
import { icon } from "../Glyphs";
import { readText } from "../Cache";
import { modelLabels, type ModelLabels } from "../producers/ModelLabels";
import { emptyMix, readMix, type Mix } from "../producers/ModelMix";
import type { State } from "../State";
import { cellWidth, fit } from "../Width";
import { shrinkToFit } from "../../TOOLS/StatusLineAbbrev";
import { LANE_ROSTER, liveLanes, type UseLane } from "../../TOOLS/lib/ModelUse";
import { CROSS_VENDOR } from "../../TOOLS/models";

type ClaudeRung = "low" | "medium" | "high" | "max";
type Rung = ClaudeRung | UseLane;

const MODELS_LABEL = "\x1b[38;2;148;163;184m";
const esc = (r: number, g: number, b: number, dim = false): string => `\x1b[${dim ? "2;" : ""}38;2;${r};${g};${b}m`;
/** USED is the plain hue, dim the muted tint (bash _ar_rung_c). */
const CLAUDE_COLORS: Record<ClaudeRung, [string, string]> = {
  low: [esc(60, 190, 110), esc(86, 164, 110, true)],
  medium: [esc(70, 140, 225), esc(90, 130, 185, true)],
  high: [esc(215, 80, 80), esc(180, 95, 95, true)],
  max: [esc(155, 95, 225), esc(150, 110, 195, true)],
};
const RUNG_COLORS = { ...CLAUDE_COLORS, ...Object.fromEntries(LANE_ROSTER.map((r) => [r.lane, [esc(...r.rgb), esc(...r.dim, true)]])) } as Record<Rung, [string, string]>;
/** Draw slots of the Claude rungs among the roster lanes (lib/ModelUse.ts LANE_ROSTER). */
const CLAUDE_SLOTS: Record<ClaudeRung, number> = { low: 40, medium: 50, high: 80, max: 100 };

/** Rung scores as the daily ladder-rank workflow writes them to MEMORY/STATE/ladder-rank.json. */
type RankScores = Record<string, { index: number }>;

/**
 * Sort key per rung, dumbest to smartest left to right: any rung the daily ladder-rank workflow could not score first,
 * by slot, then by the Artificial Analysis index it wrote (lowest first), then any roster lane marked `drawLast` as the
 * smartest. No file, or an unreadable one, leaves the fixed slot order.
 */
const DRAW_LAST: ReadonlySet<string> = new Set(LANE_ROSTER.filter((r) => "drawLast" in r && r.drawLast).map((r) => r.lane));
export function rankKey(rung: string, slot: number, scores: RankScores): number {
  if (DRAW_LAST.has(rung)) return Number.MAX_SAFE_INTEGER;
  const s = scores[rung];
  return s ? s.index : -1000 + slot;
}

function rankScores(root: string): RankScores {
  try { return (JSON.parse(readText(`${root}/MEMORY/STATE/ladder-rank.json`) ?? "{}") as { scores?: RankScores }).scores ?? {}; }
  catch { return {}; }
}

/** Carrier rung from the harness model name; an unknown carrier has no rung. */
export function carrierRung(model: string): "low" | "medium" | "max" | "high" | "" {
  if (/[Hh]aiku/.test(model)) return "low";
  if (/[Ss]onnet/.test(model)) return "medium";
  if (/[Ff]able/.test(model)) return "max";
  if (/[Oo]pus/.test(model)) return "high";
  return "";
}

export interface LadderModel {
  labels: ModelLabels;
  /** Mix after duplicate-rung share folding; the context bar reads the same numbers. */
  mix: Mix;
  draw: { low: boolean; med: boolean };
  used: Record<Rung, boolean>;
}

const memo = new WeakMap<State, LadderModel>();

/** Labels, folded mix and used-flags, computed once per render. */
export function ladderModel(state: State): LadderModel {
  const hit = memo.get(state);
  if (hit) return hit;
  const labels = modelLabels(state);
  const mix = readMix(state);
  const lowLabel = "HAIKU";
  const used = Object.fromEntries(Object.keys(RUNG_COLORS).map((r) => [r, false])) as Record<Rung, boolean>;
  const carrier = carrierRung(state.model);
  if (carrier) used[carrier] = true;
  // One label per model: a level whose label repeats a higher level's is not drawn and its share moves up.
  const draw = { low: true, med: true };
  if (lowLabel === labels.high || lowLabel === labels.med || lowLabel === labels.max) {
    draw.low = false;
    if (lowLabel === labels.med) mix.medium += mix.low;
    else if (lowLabel === labels.high) mix.high += mix.low;
    else mix.max += mix.low;
    mix.low = 0;
  }
  if (labels.med === labels.high || labels.med === labels.max) {
    draw.med = false;
    if (labels.med === labels.high) mix.high += mix.medium; else mix.max += mix.medium;
    mix.medium = 0;
  }
  if (mix.low > 0) used.low = true;
  if (mix.medium > 0) used.medium = true;
  if (mix.high > 0) used.high = true;
  if (mix.max > 0) used.max = true;
  if (labels.sol) { if (mix.astra > 0) used.astra = true; }
  else if (mix.astra > 0 || mix.astra_used === 1) used.astra = true;
  for (const { lane } of LANE_ROSTER) if (lane !== "astra" && mix[lane] > 0) used[lane] = true;
  const model = { labels, mix, draw, used };
  memo.set(state, model);
  return model;
}

/**
 * Every model, lit with its share of output tokens once this session uses it (direct calls and agents alike; the
 * model-use log feeds the lanes no transcript records), dim until then. The router's ▸ pick and agent names were
 * dropped on 2026-10-12: the ladder shows every model, used
 * or not, with each used model's share.
 */
export function renderLadder(state: State): string {
  if (state.geometry.phone) return "";
  const { labels, mix, draw, used } = ladderModel(state);
  const token = (rung: Rung, name: string): string => {
    const share = mix[rung];
    return `${RUNG_COLORS[rung][used[rung] ? 0 : 1]}${name}${RESET}${share > 0 ? `${RUNG_COLORS[rung][0]} ${share}%${RESET}` : ""}`;
  };
  // One loop over the Claude rungs and the roster lanes, in rank order (rankKey). A lane with no models.ts id left is not drawn unless
  // this session still used it, so a retired model leaves the ladder by itself.
  const live = liveLanes(Object.values(CROSS_VENDOR));
  const claude: { rung: Rung; slot: number; label: string }[] = [
    { rung: "low", slot: CLAUDE_SLOTS.low, label: draw.low ? "HAIKU" : "" },
    { rung: "medium", slot: CLAUDE_SLOTS.medium, label: draw.med ? labels.med : "" },
    { rung: "high", slot: CLAUDE_SLOTS.high, label: labels.high },
    { rung: "max", slot: CLAUDE_SLOTS.max, label: labels.max },
  ];
  const lanes = LANE_ROSTER.filter((r) => live.has(r.lane) || used[r.lane]).map((r) => ({
    rung: r.lane as Rung, slot: r.slot, label: r.lane === "astra" ? labels.astra : r.lane === "sol" ? labels.sol || r.label : r.label,
  }));
  const scores = rankScores(state.root);
  const drawn = [...claude, ...lanes].filter((l) => l.label).sort((a, b) => rankKey(a.rung, a.slot, scores) - rankKey(b.rung, b.slot, scores));
  if (!drawn.length) return "";
  // Full names when they fit; then the longest names shorten first, vowels before consonants (StatusLineAbbrev), so short
  // names like SOL stay whole; below three letters a name is unreadable, so a phone-width pane wraps instead.
  const ladder = (names: string[]): string => drawn.map(({ rung }, i) => token(rung, names[i]!)).join(" ");
  const full = drawn.map((d) => d.label);
  const room = state.geometry.content - cellWidth(ladder(full.map(() => "")));
  const tag = `${icon("models")}${MODELS_LABEL}${state.geometry.density === 3 ? "MODELS:" : "MODELS"}${RESET} `;
  // Narrower still, the models this session has not used drop out (they carry no share), then the used ones shorten.
  const lit = drawn.filter(({ rung }) => used[rung]);
  const litLadder = (names: string[]): string => lit.map(({ rung }, i) => token(rung, names[i]!)).join(" ");
  const litFull = lit.map((d) => d.label);
  const litRoom = state.geometry.content - cellWidth(litLadder(litFull.map(() => "")));
  const narrow = lit.length ? [litLadder(litFull), litLadder(shrinkToFit(litFull, litRoom, 3))] : [];
  const best = fit(state.geometry.content, tag + ladder(full), ladder(full), ladder(shrinkToFit(full, room, 3)), ...narrow);
  if (cellWidth(best) <= state.geometry.content) return best + "\n";
  // Nothing fits on one row: the shortest names flow onto as many rows as they need, breaking only between models.
  const pool = lit.length ? lit : drawn;
  const short = shrinkToFit(pool.map((d) => d.label), 0, 3);
  const rows: string[] = [];
  let row = "";
  pool.forEach(({ rung }, i) => {
    const t = token(rung, short[i]!);
    if (row && cellWidth(row + " " + t) > state.geometry.content) { rows.push(row); row = t; } else row = row ? row + " " + t : t;
  });
  return [...rows, row].join("\n") + "\n";
}
