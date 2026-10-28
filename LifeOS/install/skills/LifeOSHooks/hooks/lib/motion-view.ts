/**
 * motion-view.ts — the pixels and cells the plugin animates around the prompt (FUNCTIONHOOKS F12).
 *
 * Pure and plugin-local (not a synced core): no `$`, no clock, no I/O. The LifeOS mark is drawn from the
 * favicon's own geometry (a 4×5 staircase of eleven tiles, `lifeos-favicon.svg`), so no image file ships and
 * every frame is computed. `Image` takes RGBA bytes as base64; `Raster` takes base64 u32 triplets
 * `[codePoint, foreground, background]`, row-major, little-endian (claude-code.d.ts `RasterProps`).
 */

/** The favicon's three colours. */
export const MARK = { light: 0x94c5fd, deep: 0x00339a, summit: 0x1b47ff } as const;

/** A Raster colour meaning "the terminal's default" (bit 24 alone). */
export const DEFAULT_COLOR = 0x01000000;

/** At most 10 frames a second while a turn works (ISC-153). */
export const MOTION_MS = 100;
/** Idle breathing, at most 2 frames a second (ISC-187). */
export const BREATH_MS = 500;
/** Idle breathing stops this long after the last turn (ISC-188). */
export const BREATH_FOR_MS = 120_000;
/** A shimmer never runs longer than this many frames (ISC-165). */
export const SHIMMER_FRAMES = 12;
/** A stopped agent's cell stays this long (ISC-169). */
export const AGENT_LINGER_MS = 30_000;

/** The summit's colour per spinner mode (ISC-150); requesting and tool-input keep the brand summit. */
export const MODE_SUMMIT: Record<string, number> = {
  thinking: 0xbb9af7,
  "tool-use": 0xe0af68,
  responding: 0x9ece6a,
  requesting: MARK.summit,
  "tool-input": MARK.summit,
};

type Tile = { col: number; row: number; color: number };

/** The eleven tiles, in climbing order: bottom row left to right, then up the right side to the summit. */
export const TILES: readonly Tile[] = [
  { col: 0, row: 0, color: MARK.light }, { col: 1, row: 0, color: MARK.light }, { col: 2, row: 0, color: MARK.light }, { col: 3, row: 0, color: MARK.light },
  { col: 1, row: 1, color: MARK.deep }, { col: 2, row: 1, color: MARK.deep }, { col: 3, row: 1, color: MARK.light },
  { col: 2, row: 2, color: MARK.light }, { col: 3, row: 2, color: MARK.light },
  { col: 3, row: 3, color: MARK.deep },
  { col: 3, row: 4, color: MARK.summit },
];

/** viewBox 128: columns start at 4 + 31·c (27 wide), rows (from the bottom) at 104 − 25·r (21 tall). */
function tileAt(x: number, y: number): number {
  for (let i = 0; i < TILES.length; i++) {
    const t = TILES[i]!;
    const x0 = 4 + 31 * t.col, y0 = 104 - 25 * t.row;
    if (x >= x0 && x < x0 + 27 && y >= y0 && y < y0 + 21) return i;
  }
  return -1;
}

export interface MarkOptions {
  /** How many tiles, in climbing order, draw at full strength; the rest are faint. Default all. */
  lit?: number;
  /** The summit tile's colour. Default the brand summit. */
  summit?: number;
  /** The summit's strength, 0..1 (breathing). Default 1. */
  glow?: number;
}

/** The mark as `size × size` RGBA pixels. */
export function markRgba(size = 32, o: MarkOptions = {}): Uint8Array {
  const lit = o.lit ?? TILES.length;
  const glow = o.glow ?? 1;
  const px = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      const i = tileAt(((pxi + 0.5) * 128) / size, ((py + 0.5) * 128) / size);
      if (i < 0) continue;
      const t = TILES[i]!;
      const isSummit = i === TILES.length - 1;
      const color = isSummit ? (o.summit ?? MARK.summit) : t.color;
      const alpha = i < lit ? (isSummit ? 0.35 + 0.65 * glow : 1) : 0.22;
      const k = (py * size + pxi) * 4;
      px[k] = (color >> 16) & 0xff;
      px[k + 1] = (color >> 8) & 0xff;
      px[k + 2] = color & 0xff;
      px[k + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

/** Standard padded base64 (the engine's `toBase64` is not guaranteed under bun test). */
export function b64(bytes: Uint8Array): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]! + (b === undefined ? "=" : A[(n >> 6) & 63]!) + (c === undefined ? "=" : A[n & 63]!);
  }
  return out;
}

export const MARK_PX = 32;

/** An `Image` source for a mark frame. */
export function markSource(o: MarkOptions = {}): { rgba: string; width: number; height: number } {
  return { rgba: b64(markRgba(MARK_PX, o)), width: MARK_PX, height: MARK_PX };
}

/** Climb frames per cycle: one per tile lit, then a hold on the full mark (ISC-151/152). */
export const CLIMB_FRAMES = TILES.length + 1;

/** Frame `i` of the climb as options: tiles light one step at a time up to the summit, then hold. */
export function climbOptions(i: number, mode: string): MarkOptions {
  const k = ((i % CLIMB_FRAMES) + CLIMB_FRAMES) % CLIMB_FRAMES;
  return { lit: Math.min(TILES.length, k + 1), summit: MODE_SUMMIT[mode] ?? MARK.summit };
}

/** Frame `i` of the climb as pixels. */
export function climbFrame(i: number, mode: string): { rgba: string; width: number; height: number } {
  return markSource(climbOptions(i, mode));
}

export const BREATH_FRAMES = 8;

/** Frame `i` of the idle breath as options: the summit fades between 35% and full. */
export function breathOptions(i: number): MarkOptions {
  const k = ((i % BREATH_FRAMES) + BREATH_FRAMES) % BREATH_FRAMES;
  return { glow: 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / BREATH_FRAMES) };
}

/** Frame `i` of the idle breath as pixels. */
export function breathFrame(i: number): { rgba: string; width: number; height: number } {
  return markSource(breathOptions(i));
}

// ── Raster cells ─────────────────────────────────────────────────────────────────────────────────

export type Cell = [codePoint: number, fg: number, bg: number];

/** How many cells the text-cell mark takes: one per staircase column. */
export const MARK_CELLS = 4;
/** An unlit column of the text-cell mark. */
const MARK_DIM = 0x3b4261;
/** The favicon's deep blue is near-black as a glyph on a dark terminal; cells use a mid blue for it. */
const CELL_DEEP = 0x4a7fe0;
/** Lower eighth blocks ▁..█, index 1..8. */
const EIGHTHS = [0x20, 0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, 0x2588];

/** `a` blended toward `b` by `f` (0..1). */
function mix(a: number, b: number, f: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 0xff) * (1 - f) + ((b >> s) & 0xff) * f);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * The mark as four Raster cells, for a terminal that draws an Image's alt (herdr, tmux): each staircase
 * column becomes a lower block as tall as its tiles (▂▃▅█), lit columns in their top tile's colour, the
 * rest dim, so the same climb and breath show where pixels cannot (live probe, 2026-10-14). The heights never
 * change: a climb that resized the columns read as dots jittering (principal, 2026-10-14), so only colour moves.
 */
export function markCells(o: MarkOptions = {}): Cell[] {
  const lit = o.lit ?? TILES.length;
  const glow = o.glow ?? 1;
  const out: Cell[] = [];
  for (let col = 0; col < MARK_CELLS; col++) {
    let height = 0, litHeight = 0, color = MARK_DIM;
    TILES.forEach((tile, i) => {
      if (tile.col !== col) return;
      height = Math.max(height, tile.row + 1);
      if (i >= lit) return;
      litHeight = Math.max(litHeight, tile.row + 1);
      const summit = i === TILES.length - 1;
      color = summit ? mix(MARK_DIM, o.summit ?? MARK.summit, 0.35 + 0.65 * glow) : tile.color === MARK.deep ? CELL_DEEP : tile.color;
    });
    out.push([EIGHTHS[Math.max(1, Math.round((height * 8) / 5))]!, litHeight > 0 ? color : MARK_DIM, DEFAULT_COLOR]);
  }
  return out;
}

/** Cells packed as `RasterProps.cells`. */
export function packCells(cells: readonly Cell[]): string {
  const words = new Uint32Array(cells.length * 3);
  cells.forEach((c, i) => { words[i * 3] = c[0]; words[i * 3 + 1] = c[1]; words[i * 3 + 2] = c[2]; });
  const bytes = new Uint8Array(words.length * 4);
  // Explicitly little-endian, whatever the host.
  words.forEach((w, i) => { bytes[i * 4] = w & 0xff; bytes[i * 4 + 1] = (w >>> 8) & 0xff; bytes[i * 4 + 2] = (w >>> 16) & 0xff; bytes[i * 4 + 3] = (w >>> 24) & 0xff; });
  return b64(bytes);
}

const LEFT = [0x40, 0x04, 0x02, 0x01];
const RIGHT = [0x80, 0x20, 0x10, 0x08];

/** A bar of height 0..4 (bottom-up) in one braille half-cell. */
function halfBits(h: number, side: readonly number[]): number {
  let bits = 0;
  for (let k = 0; k < Math.min(4, h); k++) bits |= side[k]!;
  return bits;
}

/** The heights (0..4) a braille cell's left and right columns draw: the inverse of the packing. */
export function brailleHeights(cp: number): [number, number] {
  const bits = cp - 0x2800;
  const h = (side: readonly number[]) => { let n = 0; while (n < 4 && (bits & side[n]!)) n++; return n; };
  return [h(LEFT), h(RIGHT)];
}

/** Two samples per cell as bottom-up braille bars, right-aligned in exactly `columns` cells (ISC-157/158). */
export function brailleSpark(values: readonly number[], columns: number, color: number): Cell[] {
  const take = values.slice(-columns * 2);
  const max = Math.max(0, ...take);
  const level = (v: number | undefined) => (v === undefined || !(v > 0) || max <= 0 ? 0 : Math.max(1, Math.ceil((v / max) * 4)));
  const padded: Array<number | undefined> = [...Array(columns * 2 - take.length).fill(undefined), ...take];
  const cells: Cell[] = [];
  for (let c = 0; c < columns; c++) {
    const bits = halfBits(level(padded[c * 2]), LEFT) | halfBits(level(padded[c * 2 + 1]), RIGHT);
    cells.push([0x2800 + bits, color, DEFAULT_COLOR]);
  }
  return cells;
}

/** The three sparkline colours: context, token burn, criteria closed (ISC-159). */
export const SPARK_COLORS = { ctx: 0x7dcfff, burn: 0xff9e64, crit: 0x9ece6a } as const;

function lerp(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 0xff) + (((b >> s) & 0xff) - ((a >> s) & 0xff)) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

const TRACK = 0x3b4261;
const BAR = 0x2501; // ━

/**
 * The ISA progress bar: `round(fraction × columns)` cells from the deep blue to the summit blue, the rest a dim
 * track (ISC-161/162). `shimmerAt`, a frame of the shimmer, brightens a three-cell window sweeping left to right.
 */
export function gradientBar(columns: number, fraction: number, shimmerAt: number | null = null): Cell[] {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(f * columns);
  const head = shimmerAt === null || filled === 0 ? -99 : Math.round((shimmerAt / (SHIMMER_FRAMES - 1)) * (filled - 1));
  const cells: Cell[] = [];
  for (let i = 0; i < columns; i++) {
    if (i >= filled) { cells.push([BAR, TRACK, DEFAULT_COLOR]); continue; }
    const base = filled === 1 ? MARK.summit : lerp(MARK.deep, MARK.summit, i / (filled - 1));
    const d = Math.abs(i - head);
    cells.push([BAR, d <= 1 ? lerp(base, MARK.light, d === 0 ? 0.85 : 0.45) : base, DEFAULT_COLOR]);
  }
  return cells;
}

// ── Agents ───────────────────────────────────────────────────────────────────────────────────────

export type Vendor = "anthropic" | "openai" | "google" | "xai" | "meta";

export const VENDOR_COLOR: Record<Vendor, number> = {
  anthropic: 0xff9e64,
  openai: 0x73daca,
  google: 0x7aa2f7,
  xai: 0xa9b1d6,
  meta: 0xbb9af7,
};

/** The vendor an agent type runs on; anything unnamed is Claude Code's own (Anthropic). */
export function agentVendor(type: string): Vendor {
  if (/^(Sol|Astra|CodexResearcher)/i.test(type)) return "openai";
  if (/^(Argon|Gemini)/i.test(type)) return "google";
  if (/^Grok/i.test(type)) return "xai";
  if (/^Muse/i.test(type)) return "meta";
  return "anthropic";
}

export type AgentCellState = "running" | "ok" | "fail";

/** One cell per agent, a space between: a vendor dot pulsing while it runs, then ✓ or ✗ (ISC-166..168). */
export function agentCells(agents: ReadonlyArray<{ vendor: Vendor; state: AgentCellState }>, phase: number): Cell[] {
  const cells: Cell[] = [];
  const pulse = 0.5 - 0.5 * Math.cos((2 * Math.PI * (phase % 10)) / 10);
  agents.forEach((a, i) => {
    if (i > 0) cells.push([0x20, DEFAULT_COLOR, DEFAULT_COLOR]);
    if (a.state === "ok") cells.push([0x2713, 0x9ece6a, DEFAULT_COLOR]);
    else if (a.state === "fail") cells.push([0x2717, 0xf7768e, DEFAULT_COLOR]);
    else cells.push([0x25cf, lerp(VENDOR_COLOR[a.vendor], TRACK, 0.55 * pulse), DEFAULT_COLOR]);
  });
  return cells;
}

/** What an agent status reads as on its cell. */
export function cellState(status: string): AgentCellState {
  if (status === "completed") return "ok";
  if (status === "failed" || status === "killed") return "fail";
  return "running";
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

function span(min: number): string {
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

/** The deadline countdown (ISC-174..176); `hhmm` is the due time already formatted in the principal's zone. */
export function dueText(dueMs: number, nowMs: number, hhmm: string): string | null {
  if (nowMs <= dueMs) return `⏱ Due ${hhmm} · ${span(Math.max(1, Math.ceil((dueMs - nowMs) / 60_000)))} left`;
  const late = Math.floor((nowMs - dueMs) / 60_000);
  return late <= 30 ? `⏱ Due ${hhmm} · late ${span(Math.max(1, late))}` : null;
}

/** The TurnDuration suffix on a turn that closed criteria (ISC-171); null when none closed. */
export function turnSuffix(delta: number, closed: number, total: number): string | null {
  return delta > 0 ? ` · ▲ +${delta} ${delta === 1 ? "criterion" : "criteria"} · ISA ${closed}/${total}` : null;
}

/** Parse a `done/total` progress string. */
export function progressOf(progress: string | undefined): { closed: number; total: number } | null {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(progress ?? "");
  return m ? { closed: Number(m[1]), total: Number(m[2]) } : null;
}

/** A deploy-verification run whose success earns the chime (ISC-181): `bun …VerifyDeploy…` or a CfEnv deploy, never a command that only names one (`rg VerifyDeploy`). */
export const VERIFY_CMD = /(?:^|[;&|(]\s*|\s)bun\s+(?:run\s+)?\S*(?:VerifyDeploy|verify-deploy)\S*|(?:^|[;&|(]\s*|\s)bun\s+\S*CfEnv\.ts\b[^\n]*\bdeploy\b/;
