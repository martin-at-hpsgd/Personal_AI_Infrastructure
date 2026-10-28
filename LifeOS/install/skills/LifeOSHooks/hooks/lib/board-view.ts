/**
 * board-view.ts — how the band, the workflow card and SessionTree's rows look: styled runs, never elements.
 * It is the shared row library for those surfaces.
 *
 * Pure and plugin-local (not a synced core): every function returns rows of `Seg`, and
 * LifeOSHooks.ts turns them into `Text` runs. The same rows render to ANSI for a preview
 * in a plain terminal (`toAnsi`), so a look can be checked before the module reloads.
 */

export interface Seg { text: string; color?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean }
export type Row = Seg[];

/**
 * Tokyo Night Storm, a public terminal palette and this mod's built-in colours. Vendors keep a hue of their
 * own from the same palette: orange for Anthropic, teal for OpenAI.
 */
export const C = {
  accent: "#7aa2f7",
  accentDeep: "#7aa2f7",
  label: "#7dcfff",
  text: "#c0caf5",
  muted: "#a9b1d6",
  faint: "#565f89",
  track: "#3b4261",
  ok: "#9ece6a",
  warn: "#e0af68",
  bad: "#f7768e",
  deep: "#db4b4b",
  anthropic: "#ff9e64",
  openai: "#73daca",
  violet: "#bb9af7",
  sky: "#b4f9f8",
} as const;

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** Green under 60, amber under 85, red from 85: how close a window is to its cap. */
export function levelColor(pct: number): string {
  return pct >= 85 ? C.bad : pct >= 60 ? C.warn : C.ok;
}

/** A smooth bar `width` cells wide: solid and eighth blocks in `color`, the rest a dark track. */
export function meter(pct: number, width: number, color: string): Row {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const cells = (p / 100) * width;
  let full = Math.floor(cells);
  let rem = Math.round((cells - full) * 8);
  if (rem === 8) { full++; rem = 0; }
  // Anything above zero shows at least a sliver, so 1% never reads as empty.
  if (p > 0 && full === 0 && rem === 0) rem = 1;
  const fill = "█".repeat(full) + (rem > 0 ? EIGHTHS[rem] : "");
  const used = full + (rem > 0 ? 1 : 0);
  return [{ text: fill, color }, { text: "━".repeat(Math.max(0, width - used)), color: C.track }];
}

export function rowText(r: Row): string {
  return r.map((g) => g.text).join("");
}

/** Display width of a string in cells: emoji and wide glyphs count two, the variation selector none. */
export function cellWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f || cp === 0x200d) continue;
    w += cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf && cp !== 0x2713 && cp !== 0x2717) || (cp >= 0x1100 && cp <= 0x115f) ? 2 : 1;
  }
  return w;
}

export function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - cellWidth(s)));
}

/** A section heading: a small bold label in its colour, then a hairline to the edge. */
export function heading(label: string, color: string, width: number, note?: string): Row {
  const head: Row = [{ text: "▍", color }, { text: label.toUpperCase(), color, bold: true }];
  if (note) head.push({ text: `  ${note}`, color: C.muted });
  const used = cellWidth(rowText(head)) + 1;
  head.push({ text: " " + "─".repeat(Math.max(0, width - used)), color: C.track });
  return head;
}

/** Model label → its vendor colour on the Models tab. */
export function modelColor(label: string): string {
  const l = label.toLowerCase();
  if (["astra", "sol"].includes(l) || l.startsWith("gpt")) return C.openai;
  if (l.startsWith("gemini")) return C.accent;
  if (l.startsWith("grok")) return C.muted;
  return C.anthropic;
}

/** The ISA chip in the band head: `🧗 CLIMBING  example-slug  ███━━━━ 3/16`. */
export function isaChip(icon: string, label: string, slug: string, progress: string): Row {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(progress.trim());
  const row: Row = [
    { text: `${icon} ` },
    { text: label.toUpperCase(), color: C.label, bold: true },
    { text: " · ", color: C.faint },
    { text: slug, color: C.text },
    { text: " " },
  ];
  if (m && Number(m[2]) > 0) {
    const pct = (Number(m[1]) / Number(m[2])) * 100;
    row.push(...meter(pct, 10, pct >= 100 ? C.ok : C.accent), { text: " " });
    row.push({ text: progress.trim(), color: pct >= 100 ? C.ok : C.accent, bold: true });
  } else if (progress.trim()) {
    row.push({ text: progress.trim(), color: C.accent, bold: true });
  }
  return row;
}

// ── ANSI preview ───────────────────────────────────────────────────────────

function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A row as a truecolor ANSI string, for previewing the look in any terminal. */
export function toAnsi(r: Row): string {
  return r.map((g) => {
    const codes: string[] = [];
    if (g.bold) codes.push("1");
    if (g.dim) codes.push("2");
    if (g.italic) codes.push("3");
    const fg = g.color ? hexRgb(g.color) : null;
    if (fg) codes.push(`38;2;${fg.join(";")}`);
    const bg = g.bg ? hexRgb(g.bg) : null;
    if (bg) codes.push(`48;2;${bg.join(";")}`);
    return codes.length ? `\x1b[${codes.join(";")}m${g.text}\x1b[0m` : g.text;
  }).join("");
}

// ── Workflow map (WORKFLOW BOARD ISA F2) ───────────────────────────────────
// One section per workflow run (the removed /board work tab drew it; WorkflowCard and its tests still read it): a header, a summary row, one row per Feature lane
// with its pipeline as glyphs, and non-Feature agents grouped by role. The model is WorkflowView's; a hooks
// module cannot import outside its plugin folder, so the structural subset the map reads is declared here.

export interface WfAgent {
  key: string; label: string; role: string; round: number | null; agentType: string | null; model: string | null;
  state: string; died: string | null; startedAt: string | null; endedAt: string | null;
}
export interface WfLane {
  id: string; name: string; state: string; reason: string | null; attempts: number; queued: boolean; agentKeys: string[];
  criteria: Array<{ id: string; status: string }>;
}
export interface WfRun {
  intentName: string | null; workflowName?: string | null; tier?: number | null; linkedBy?: "args" | "brief" | null; state: string; idleMinutes: number | null; launchedAt: string | null; finishedAt: string | null; lastActivityAt: string | null;
  unlinked: boolean; devRun: string | null; wave: number | null; isaSlug: string | null;
  progress: { ticked: number; total: number } | null; criteria: { ticked: number; total: number } | null;
  running: number; queued: number; roles: Record<string, { running: number; total: number }>;
  lanes: WfLane[]; agents: WfAgent[]; nonIsa: string[];
}
export interface WfModel { runs: WfRun[] }

/** The four tones the map draws in, all from the board's palette: no new colours. */
export const WF_TONE = { running: C.accent, done: C.ok, fault: C.bad, warn: C.warn } as const;

/** A step's glyph and tone by agent state. */
const STEP: Record<string, readonly [string, string]> = {
  running: ["●", WF_TONE.running],
  done: ["✓", WF_TONE.done],
  passed: ["✓", WF_TONE.done],
  failed: ["✗", WF_TONE.fault],
  refuted: ["⊘", WF_TONE.warn],
  needs_principal: ["?", WF_TONE.fault],
  parked: ["◌", WF_TONE.warn],
};
/** Lane states drawn in the fault tone: the run file's stuck and quarantined, a lane that needs the principal, one that died or stalled. */
const FAULT_LANE = new Set(["stuck", "quarantined", "needs_principal", "failed", "stalled"]);
const isOpen = (r: { state: string }) => r.state === "running" || r.state === "stalled";

function oneLine(text: string): string {
  // Names, labels and reasons come from journals and agent output: control characters never reach the terminal.
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

/** A finite number from untrusted input, else 0: a count never carries text into a row. */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** Any untrusted field as one clean line. */
const clean = (v: unknown): string => oneLine(typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
/** A lane's head cell: its id (clean, never free text), attempts and name. */
const laneHead = (l: WfLane): string => `${clean(l.id)}${num(l.attempts) > 1 ? ` ×${num(l.attempts)}` : ""} ${clean(l.name)}`;

/** `45s`, `12m`, `1h05m`. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function elapsedBetween(from: string | null, to: string | number | null, nowMs: number): string {
  const a = from ? Date.parse(from) : NaN;
  if (Number.isNaN(a)) return "";
  const b = to === null ? nowMs : typeof to === "number" ? to : Date.parse(to);
  return Number.isNaN(b) ? "" : fmtElapsed(b - a);
}

/** Cut a row to `width` cells, the last cell an ellipsis when something was lost. */
export function clipRow(r: Row, width: number): Row {
  if (cellWidth(rowText(r)) <= width) return r;
  const out: Row = [];
  let used = 0;
  for (const g of r) {
    const w = cellWidth(g.text);
    if (used + w <= width - 1) { out.push(g); used += w; continue; }
    let part = "";
    for (const ch of g.text) { const cw = cellWidth(ch); if (used + cw > width - 1) break; part += ch; used += cw; }
    if (part) out.push({ ...g, text: part });
    break;
  }
  out.push({ text: "…", color: C.faint });
  return out;
}

const roleAbbr = (a: WfAgent) => (a.role === "fix" ? `f${Number.isInteger(a.round) ? a.round : ""}` : (Array.from(clean(a.role))[0] ?? "?"));

function tally(run: WfRun): string {
  const entries = Object.entries(run.roles ?? {}).map(([name, v]) => ({ name: oneLine(name).toLowerCase(), n: num(v?.running), total: num(v?.total) }));
  const anyRunning = entries.some((e) => e.n > 0);
  return entries.map((e) => ({ name: e.name, n: anyRunning ? e.n : e.total })).filter((e) => e.n > 0 && e.name)
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map((e) => `${e.n} ${e.name}`).join(" ");
}

function headerRow(run: WfRun, nowMs: number, columns: number): Row {
  const name = clean(run.workflowName) || "workflow";
  const end = isOpen(run) ? null : run.finishedAt ?? run.lastActivityAt;
  const elapsed = elapsedBetween(run.launchedAt, end, nowMs) || "--";
  // An args-linked run names its tier and no wave (F4 binds through launch args); a brief-linked run keeps its wave.
  const label = run.unlinked ? `${name} · ${elapsed}`
    : run.linkedBy === "args"
      ? [name, ...(typeof run.tier === "number" && Number.isInteger(run.tier) ? [`T${run.tier}`] : []), clean(run.isaSlug ?? run.devRun), elapsed].join(" · ")
      : `${name} · ${clean(run.isaSlug ?? run.devRun)} · w${typeof run.wave === "number" && Number.isFinite(run.wave) ? run.wave : "?"} · ${elapsed}`;
  const row: Row = [{ text: "▍ ", color: C.violet }, { text: label, color: C.text, bold: true }];
  if (run.state === "stalled") row.push({ text: `  stalled ${run.idleMinutes ?? 0}m`, color: WF_TONE.fault, bold: true });
  else if (run.state === "finished") row.push({ text: "  finished", color: WF_TONE.done });
  else if (run.state === "abandoned") row.push({ text: "  abandoned", color: WF_TONE.warn, bold: true });
  else if (run.state !== "running") row.push({ text: `  ${clean(run.state)}`, color: WF_TONE.fault, bold: true });
  const used = cellWidth(rowText(row)) + 1;
  row.push({ text: " " + "─".repeat(Math.max(0, columns - used)), color: C.track });
  return row;
}

function summaryRow(run: WfRun): Row {
  const row: Row = [{ text: "  " }, { text: `${num(run.running)}▶ ${num(run.queued)}⏸`, color: WF_TONE.running, bold: true }];
  const roles = tally(run);
  if (roles) row.push({ text: " · ", color: C.faint }, { text: roles, color: C.muted });
  const prog = run.unlinked ? null : run.progress ?? (run.criteria && run.criteria.total > 0 ? run.criteria : null);
  if (prog && prog.total > 0) {
    const pct = (prog.ticked / prog.total) * 100;
    row.push({ text: " · ", color: C.faint }, { text: `ISA ${prog.ticked}/${prog.total} `, color: C.text }, ...meter(pct, 12, pct >= 100 ? C.ok : C.accent));
  }
  return row;
}

interface Widths { head: number; columns: number }

function laneRow(run: WfRun, l: WfLane, byKey: Map<string, WfAgent>, nowMs: number, w: Widths): Row {
  const fault = FAULT_LANE.has(l.state);
  const queued = l.queued || l.state === "queued";
  const head = laneHead(l).trim();
  const shown = cellWidth(head) > w.head ? clipRow([{ text: head }], w.head)[0]!.text + "…" : head;
  const row: Row = [{ text: "  " }, { text: shown, color: fault ? WF_TONE.fault : queued ? C.faint : C.text, bold: fault }, { text: " ".repeat(Math.max(1, w.head - cellWidth(shown) + 1)) }];
  const steps = l.agentKeys.map((k) => byKey.get(k)).filter((a): a is WfAgent => !!a);
  if (queued && steps.length === 0) row.push({ text: "⏸ queued", color: C.faint });
  steps.forEach((a, i) => {
    const [glyph, color] = STEP[a.state] ?? ["·", C.muted];
    if (i > 0) row.push({ text: " ▸ ", color: C.track });
    row.push({ text: roleAbbr(a), color: C.faint }, { text: glyph, color, bold: true });
  });
  const cur = steps[steps.length - 1];
  let tickedIds: string[] = [];
  let idsAt = -1;
  if (cur) { const m = clean(cur.agentType ?? cur.model ?? "?"); row.push({ text: "  " }, { text: m, color: modelColor(m) }); }
  // The criteria column belongs to a linked run only.
  if (!run.unlinked && l.criteria.length > 0) {
    const ticked = l.criteria.filter((c) => c.status === "ticked").length;
    const reported = l.criteria.filter((c) => c.status === "reported").length;
    row.push({ text: `  ${ticked}/${l.criteria.length}`, color: ticked === l.criteria.length ? C.ok : C.text, bold: ticked === l.criteria.length });
    if (reported > 0) row.push({ text: ` +${reported}`, color: C.faint });
    tickedIds = l.criteria.filter((c) => c.status === "ticked").map((c) => clean(c.id)).filter(Boolean);
    idsAt = row.length;
  }
  const started = steps.map((a) => a.startedAt).filter((t): t is string => !!t).sort()[0] ?? null;
  const running = steps.some((a) => a.state === "running");
  const ends = steps.map((a) => a.endedAt).filter((t): t is string => !!t).sort();
  const elapsed = started ? elapsedBetween(started, running || ends.length === 0 ? null : ends[ends.length - 1]!, nowMs) : "";
  if (elapsed) row.push({ text: `  ${elapsed}`, color: C.faint });
  if (fault) row.push({ text: "  ⚠ ", color: WF_TONE.fault, bold: true }, { text: `${clean(l.state)}${l.reason ? `: ${clean(l.reason)}` : ""}`, color: WF_TONE.fault });
  // The ticked ids follow the count while every later piece of the row still fits; the first id that would not fit ends the list.
  if (idsAt >= 0 && tickedIds.length > 0) {
    let room = w.columns - cellWidth(rowText(row));
    const fit: string[] = [];
    for (const id of tickedIds) {
      const need = cellWidth(id) + 1;
      if (need > room) break;
      fit.push(id);
      room -= need;
    }
    if (fit.length > 0) row.splice(idsAt, 0, { text: " " + fit.join(" "), color: C.ok, dim: true });
  }
  return row;
}

/** Most attention lanes the answer card names (F9 ISC-158). */
export const CARD_ATTENTION_LANES = 3;

/**
 * The answer card's rows for one run (F9): the header, the summary, at most CARD_ATTENTION_LANES lanes that need
 * attention, and one row counting every other lane. Pure and total.
 */
export function workflowCardRows(run: WfRun | null | undefined, nowMs: number, columns: number): Row[] {
  try {
    if (!run || typeof run !== "object" || !Array.isArray(run.lanes) || !Array.isArray(run.agents)) return [];
    const byKey = new Map(run.agents.map((a) => [a.key, a]));
    const isQueued = (l: WfLane) => l.queued || l.state === "queued";
    const attention = run.lanes.filter((l) => FAULT_LANE.has(l.state) && !(run.state === "abandoned" && l.state === "stalled"));
    const head = Math.min(34, Math.max(12, ...attention.map((l) => cellWidth(laneHead(l)))));
    const rows: Row[] = [headerRow(run, nowMs, columns), summaryRow(run)];
    for (const l of attention.slice(0, CARD_ATTENTION_LANES)) rows.push(laneRow(run, l, byKey, nowMs, { head, columns }));
    const rest = run.lanes.filter((l) => !attention.slice(0, CARD_ATTENTION_LANES).includes(l));
    const running = rest.filter((l) => !isQueued(l) && l.state !== "done" && !FAULT_LANE.has(l.state)).length;
    const done = rest.filter((l) => l.state === "done").length;
    const queued = rest.filter(isQueued).length;
    const more = rest.filter((l) => FAULT_LANE.has(l.state)).length;
    const fold: Row = [{ text: "  " }];
    const add = (text: string, color: string) => { if (fold.length > 1) fold.push({ text: " · ", color: C.faint }); fold.push({ text, color }); };
    if (running > 0) add(`● ${running} running`, WF_TONE.running);
    if (done > 0) add(`✓ ${done} done`, WF_TONE.done);
    if (queued > 0) add(`⏸ ${queued} queued`, C.faint);
    if (more > 0) add(`⚠ ${more} more need attention`, WF_TONE.fault);
    if (fold.length > 1) rows.push(fold);
    return rows.map((r) => clipRow(r.map((g) => (/[\u0000-\u001f\u007f-\u009f]/.test(g.text) ? { ...g, text: oneLine(g.text) } : g)), columns));
  } catch { return []; }
}
