/**
 * route-label.ts — the one vocabulary for "which model, from which provider, doing what" on
 * every routing surface: the DISPATCH line, the band above the prompt, the statusline 🔀
 * row, and the 🔀 ROUTED block in the answer (FUNCTIONHOOKS ISA ISC-54/56). The LifeOS
 * Advisor agent and its 🧠 rows were retired 2026-09-10: an advisor is a meta-system, not a
 * pickable agent; every dispatch now draws the same way.
 *
 * PURE CORE: no imports. The LifeOSHooks plugin carries a byte-identical copy under
 * skills/LifeOSHooks/hooks/lib/ (scripts/SyncCores.ts moves it; tests/parity.test.ts holds
 * it equal), and RouteTrail.ts / HookBridge.ts import this source directly.
 */

export type Vendor = "OpenAI" | "Anthropic" | "Google" | "xAI" | "Meta" | "Perplexity" | "Replicate" | "Suno" | "Cloudflare" | "Fish Audio" | "unknown";

/** The provider behind a model id. Codenames only; never a pinned id. */
export function vendorOf(model: string | null | undefined): Vendor {
  const m = (model ?? "").toLowerCase();
  if (!m) return "unknown";
  if (m.startsWith("claude")) return "Anthropic";
  if (m.startsWith("gpt") || m.startsWith("whisper") || /^o\d/.test(m)) return "OpenAI";
  if (m.startsWith("gemini")) return "Google";
  if (m.startsWith("grok")) return "xAI";
  if (m.startsWith("muse-")) return "Meta"; // Muse Code models (Muse.ts lane, 2026-10-12)
  if (m.startsWith("sonar")) return "Perplexity";
  if (/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(m)) return "Replicate"; // owner/model is a Replicate slug
  if (m.startsWith("chirp-")) return "Suno";
  if (m.startsWith("@cf/")) return "Cloudflare"; // Workers AI ids, e.g. Assay's clef-omni engine
  if (/^drama-\d/.test(m)) return "Fish Audio"; // Fish Audio voice models, {{DA_NAME}}'s performed closer (CROSS_VENDOR.fishVoice, 2026-10-14)
  return "unknown";
}

/** Three-or-four-letter tag for the compact surfaces (band, 🔀 row). */
export function vendorTag(vendor: Vendor): string {
  switch (vendor) {
    case "OpenAI": return "oai";
    case "Anthropic": return "ant";
    case "Google": return "goog";
    case "xAI": return "xai";
    case "Meta": return "meta";
    case "Cloudflare": return "cf";
    case "Fish Audio": return "fish";
    case "Perplexity": return "pplx";
    case "Replicate": return "rep";
    case "Suno": return "suno";
    default: return "?";
  }
}

/** The provider's dot. Emoji carry their own colour, so it survives the dim transcript log rows. */
export function vendorGlyph(vendor: Vendor): string {
  switch (vendor) {
    case "OpenAI": return "🟢";
    case "Anthropic": return "🟠";
    case "Google": return "🔵";
    case "xAI": return "⚪";
    case "Meta": return "🔷";
    case "Cloudflare": return "🟡";
    default: return "◌";
  }
}

/** The provider's colour where a surface takes real colour (the band above the prompt). */
export function vendorColor(vendor: Vendor): string {
  switch (vendor) {
    case "OpenAI": return "#10A37F";
    case "Anthropic": return "#D97757";
    case "Google": return "#4285F4";
    case "xAI": return "#9CA3AF";
    case "Meta": return "#0866FF";
    case "Cloudflare": return "#F6821F";
    default: return "#6B7280";
  }
}

/** A four-cell meter for a work-ladder level or a reasoning effort: `▰▱▱▱` low … `▰▰▰▰` max or xhigh (Router R70); empty for an unknown level. */
export function levelMeter(level: string | null | undefined): string {
  const l = (level ?? "").toLowerCase();
  const n = ["low", "medium", "high", "max"].indexOf(l === "xhigh" ? "max" : l) + 1;
  return n ? "▰".repeat(n) + "▱".repeat(4 - n) : "";
}

/** Five dots for a probability: 0.81 → `●●●●○`. */
export function confidenceDots(p: number): string {
  const n = Math.max(0, Math.min(5, Math.round(p * 5)));
  return "●".repeat(n) + "○".repeat(5 - n);
}

/**
 * The short lane name: a codex lane by its id's codename suffix (`gpt-6-astra` → `astra`,
 * `gpt-<version>-sol` → `sol`), a Claude id by its tier (`claude-sonnet-N` → `sonnet`),
 * anything else as given.
 */
export function laneShort(model: string): string {
  const m = model.toLowerCase().replace(/-20\d{2}(?:-?\d{2}){2}$/, "");
  if (m.startsWith("gpt-")) return m.split("-").pop() || m;
  for (const tier of ["fable", "opus", "sonnet", "haiku"]) if (m.includes(tier)) return tier;
  return model;
}

const CODENAME_LANES = new Set(["astra", "sol"]);
const CLAUDE_TIER_LANES = new Set(["fable", "opus", "sonnet", "haiku"]);

/**
 * The display form of a lane: `laneShort`'s result, capitalized when it names a codex
 * codename or a Claude tier (`gpt-6-astra` → `Astra`, `claude-sonnet-N` → `Sonnet`); any
 * other id (a raw vendor model id, an unrecognized string) is returned exactly as
 * `laneShort` gives it. `laneShort` itself stays lowercase — callers key comparisons and
 * registry lookups off it; this is the one to draw.
 */
export function laneName(model: string): string {
  const short = laneShort(model);
  const key = short.toLowerCase();
  if (CODENAME_LANES.has(key) || CLAUDE_TIER_LANES.has(key)) return key.charAt(0).toUpperCase() + key.slice(1);
  return short;
}

/** `oai:Astra`, `ant:Sonnet`, `goog:gemini-N`, `xai:grok-N`. Display only. */
export function laneLabel(model: string): string {
  return `${vendorTag(vendorOf(model))}:${laneName(model)}`;
}

/** The type name as-is: every agent draws under the name on its file (the LifeOS Advisor's display alias retired 2026-09-10). */
export function displayName(type: string): string {
  return type;
}

/** Every dispatch draws 🤖 (the advisor's 🧠 retired with the agent, 2026-09-10). */
export function agentGlyph(_type: string): string {
  return "🤖";
}

/**
 * `🟢 Astra` — the provider dot and the lane it resolved to. The dot names the provider, so the word
 * is not repeated.
 */
export function laneCell(model: string): string {
  return `${vendorGlyph(vendorOf(model))} ${laneName(model)}`;
}

/**
 * The head every routing line opens with: who was dispatched, and onto what.
 *
 * Agents are named for the model they run, so `Astra ➜ 🟢 Astra` would print the
 * same name twice and say nothing with the arrow. The arrow draws only when it carries
 * information — a generic type (`general-purpose ➜ 🟠 Opus`) or a name that does not
 * match its lane. A name that IS its lane draws as the lane alone. RouteTrail's 🔀
 * row follows the same rule (`segment()`); this is the same rule for the other three surfaces.
 */
export function agentLane(type: string, model: string): string {
  const name = displayName(type);
  const cell = laneCell(model);
  return name.toLowerCase() === laneName(model).toLowerCase() ? cell : `${name} ➜ ${cell}`;
}

/**
 * `Astra`, or `general-purpose⇢oai:Sol` — a running delegate's name joined to the lane it was
 * routed onto, and only when the lane says something the name does not. The one naming rule the
 * band roster and herdr's agents row both use, so a delegate reads the same in both places and
 * an OpenAI lane is visible wherever the worker is named.
 */
export function agentLaneTag(type: string, lane?: string | null): string {
  const shown = displayName(type);
  const tail = (lane ?? "").split(":").pop() ?? "";
  return lane && tail.toLowerCase() !== shown.toLowerCase() ? `${shown}⇢${lane}` : shown;
}

/** One line of task text for a routing surface: newlines folded, trimmed to `max` with an ellipsis. */
export function clip(text: string | null | undefined, max = 72): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return one.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}

/** Terminal columns a string occupies: emoji and other wide code points count 2, the rest 1. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0xfe0f || c === 0x200d) continue; // variation selector, ZWJ
    w += c >= 0x1f000 || (c >= 0x2600 && c <= 0x27bf) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ? 2 : 1;
  }
  return w;
}

/** The label block occupies twelve terminal columns before the separator. */
function paddedLabel(label: string): string {
  return `${label}${" ".repeat(Math.max(1, 12 - displayWidth(label)))}▸`;
}

/** Clip a line to `cols` terminal columns with a trailing ellipsis (statusline rows never pass the frame). */
export function fitWidth(s: string, cols: number): string {
  if (cols <= 0 || displayWidth(s) <= cols) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > cols - 1) break;
    out += ch; w += cw;
  }
  return out.trimEnd() + "…";
}

/**
 * A statusline detail row for any dispatch: which agent, on which lane at which level, the
 * mark, how long, what it was asked, what it said.
 * The lane field carries the model id; level is resolved by the caller from the registry.
 */
export function agentRow(entry: { type: string; lane: string; level?: string | null; mark: string; durationMs?: number | null; asked?: string | null; said?: string | null }): string {
  const meter = levelMeter(entry.level);
  const level = meter ? ` · ${meter} ${entry.level!.toUpperCase()}` : "";
  const parts = [`🤖 ${agentLane(entry.type, entry.lane)}${level} · ${entry.mark}`];
  const dur = fmtDuration(entry.durationMs);
  if (dur) parts[0] += ` ${dur}`;
  const asked = clip(entry.asked, 60);
  const said = clip(entry.said, 120);
  if (asked) parts.push(`task "${asked}"`);
  if (said) parts.push(`said "${said}"`);
  return parts.join(" │ ");
}

/** `41s`, `3m12s`, `1h04m`; empty when unknown. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export interface DispatchLineOpts {
  /** Work-ladder level resolved by the caller from the registry. */
  level?: string;
  background?: boolean;
  /** The dispatch's description: what this model was asked to do. */
  task?: string;
}

/**
 * The dispatch line: padded label, agent, provider and short lane, resolved level,
 * optional background state, then the quoted task.
 */
export function dispatchLine(type: string, model: string, opts: DispatchLineOpts = {}): string {
  const parts = [agentLane(type, model)];
  const meter = levelMeter(opts.level);
  if (meter) parts.push(`${meter} ${opts.level!.toUpperCase()}`);
  const task = clip(opts.task);
  if (opts.background) parts.push("⏳ background");
  return `${paddedLabel("🤖 DISPATCH")} ${parts.join(" · ")}${task ? ` — "${task}"` : ""}`;
}

/**
 * ISC-58: the dispatch key the helper carries into its run record (`LIFEOS_DISPATCH_ID`), so
 * a run binds to ITS dispatch instead of to "the same agent inside a time window". The raw id
 * is `<session>::<description>`; quotes and newlines are dropped so it survives a shell export.
 */
export function dispatchKey(rawId: string): string {
  return rawId.replace(/['\n\r]/g, "");
}

/** The shell prefix the plugin puts before a wrapper's helper command (ISC-58). */
export function dispatchExport(rawId: string): string {
  return `export LIFEOS_DISPATCH_ID='${dispatchKey(rawId)}'; `;
}

export interface RoutedDetail {
  /** The dispatch description: what was asked. */
  asked?: string | null;
  /** The first substantive line of what came back (the run record's `summary`). */
  said?: string | null;
  durationMs?: number | null;
}

/**
 * One complete padded ROUTED line. Level is resolved by the caller from the registry;
 * known task and reply follow as bar-separated clauses.
 */
export function routedEntry(type: string, model: string, mark: string, level?: string, detail: RoutedDetail = {}): string {
  const meter = levelMeter(level);
  const cell = meter ? ` · ${meter} ${level!.toUpperCase()}` : "";
  const head = `${paddedLabel("🔀 ROUTED")} ${agentLane(type, model)}${cell} · ${mark}`;
  const dur = fmtDuration(detail.durationMs);
  const asked = clip(detail.asked, 60);
  const said = clip(detail.said, 110);
  const tail: string[] = [];
  if (asked) tail.push(`task "${asked}"`);
  if (said) tail.push(`said "${said}"`);
  return `${head}${dur ? ` ${dur}` : ""}${tail.length ? ` │ ${tail.join(" │ ")}` : ""}`;
}

// ── The router line under each prompt (FUNCTIONHOOKS ISA ISC-60) ──────────────────────────────

/** The dispatch advisor's pick for one turn, as the pick file and the bridge carry it (ISC-61). */
export interface RouterPick {
  /** The lane the advisor chose (`inline`, `sol`, `astra`, …), or null when it skipped the prompt. */
  lane: string | null;
  /** Probability of the chosen lane, 0..1. */
  p?: number | null;
  /** Why the advisor did not ask (`short`, `slash`, `greeting`, …). */
  skip?: string | null;
  /** The reasoning effort the advisor picked (`low` … `max`); the inline line's meter. */
  effort?: string | null;
  /** The advisor's overall confidence, 0..1; the inline line's dots when `p` is absent. */
  confidence?: number | null;
}

/** What the line needs from the registry; the bridge `codex-lanes` reply carries all three. */
export interface RouterLevels {
  /** Lower-cased lane → work-ladder level, from `WORK_LADDER` (`sol` → `high`). */
  lanes: Record<string, string>;
  /** Claude tier → level, from `EFFORT_MODEL` (`fable` → `max`). */
  tiers: Record<string, string>;
  /** Lower-cased lane → the model id it resolves to, for the vendor name. */
  models: Record<string, string>;
}

/** The label every router-selection line opens with. */
export const ROUTER_LABEL = "🧭 ROUTER";

/** `inline` and an unknown lane run on the carrier; a worker lane names itself. */
export function pickRunsOnCarrier(lane: string | null | undefined, levels: RouterLevels): boolean {
  const l = (lane ?? "").toLowerCase();
  return !l || l === "inline" || !levels.lanes[l];
}

/** The name cell of the line drawn when the pick stays on the carrier. */
export const INLINE_NAME = "◉ Inline · no model change needed";

/**
 * The one line drawn under every prompt the advisor picked for: level, where the work goes, and
 * how sure the advisor was. Display only; the pick never dispatches.
 *   🧭 ROUTER   ▸ ▰▰▰▱ HIGH · 🟢 Sol · ●●●●○ 0.81 advisory
 *   🧭 ROUTER   ▸ ▰▰▰▱ HIGH · 🟠 Opus · ●●●●○ 0.80 advisory
 *   🧭 ROUTER   ▸ ▰▱▱▱ LOW · ◉ Inline · no model change needed · ●●●●● 0.97
 *   🧭 ROUTER   ▸ ◉ Inline · no model change needed · skipped: short
 *
 * A pick that stays on the carrier says so and never names the carrier model: naming it made
 * every turn look like a dispatch to Anthropic. Its meter is the
 * advisor's effort pick, and it carries no "advisory" tag because nothing was routed and marks whether the turn stayed in line.
 * A dispatch lane that happens to
 * be Anthropic (`opus`) is a real routing event and draws its own name.
 */
export function routerSelectionLine(pick: RouterPick, _carrierModel: string, levels: RouterLevels): string {
  const lane = (pick.lane ?? "").toLowerCase();
  const dots = (v: unknown): string => typeof v === "number" && Number.isFinite(v) ? `${confidenceDots(v)} ${v.toFixed(2)}` : "";
  const p = dots(pick.p);
  if (pickRunsOnCarrier(lane, levels)) {
    const effort = (pick.effort ?? "").toLowerCase();
    const meter = levelMeter(effort);
    const head = meter ? `${meter} ${effort.toUpperCase()} · ` : "";
    const sure = p || dots(pick.confidence);
    const tail = sure ? ` · ${sure}` : pick.skip ? ` · skipped: ${pick.skip}` : "";
    return `${paddedLabel(ROUTER_LABEL)} ${head}${INLINE_NAME}${tail}`;
  }
  // Router R72: the effort the pick carries, when the meter knows it; the lane's ladder rank only when it doesn't
  // (the rank alone drew every Astra pick as MAX, 2026-10-04).
  const picked = (pick.effort ?? "").toLowerCase();
  const level = levelMeter(picked) ? picked : levels.lanes[lane] ?? "";
  const meter = levelMeter(level);
  const head = meter ? `${meter} ${level.toUpperCase()} · ` : "";
  const name = `${vendorGlyph(vendorOf(levels.models[lane]))} ${lane.charAt(0).toUpperCase()}${lane.slice(1)}`;
  return `${paddedLabel(ROUTER_LABEL)} ${head}${name} · ${p ? `${p} ` : ""}advisory`;
}

// ── Colour for the surfaces that take it (the band above the prompt) ──────────────────────────

export interface Segment { text: string; color?: string; bold?: boolean; dim?: boolean }

const VENDORS: Vendor[] = ["OpenAI", "Anthropic", "Google", "xAI"];
const HIGHLIGHT = /(🧭 ROUTER|🤖 DISPATCH|🔀 ROUTED|OpenAI|Anthropic|Google|xAI|✓|✗|⚡|"[^"]*"|│|➜|▸)/g;

/**
 * Splits a routing line into styled runs: the label bold cyan, each provider in its own colour,
 * ✓ green / ✗ red / ⚡ yellow, quoted task and reply text dim. Joining the runs' text gives the
 * line back unchanged, so the plain string stays the one source.
 */
export function highlight(line: string): Segment[] {
  const out: Segment[] = [];
  for (const part of line.split(HIGHLIGHT)) {
    if (!part) continue;
    if (part === ROUTER_LABEL || part === "🤖 DISPATCH" || part === "🔀 ROUTED") out.push({ text: part, color: "#22D3EE", bold: true });
    else if ((VENDORS as string[]).includes(part)) out.push({ text: part, color: vendorColor(part as Vendor), bold: true });
    else if (part === "✓") out.push({ text: part, color: "#22C55E", bold: true });
    else if (part === "✗") out.push({ text: part, color: "#EF4444", bold: true });
    else if (part === "⚡") out.push({ text: part, color: "#EAB308", bold: true });
    else if (part === "➜" || part === "▸") out.push({ text: part, color: "#22D3EE" });
    else if (part === "│" || part.startsWith('"')) out.push({ text: part, dim: true });
    else out.push({ text: part });
  }
  return out;
}
