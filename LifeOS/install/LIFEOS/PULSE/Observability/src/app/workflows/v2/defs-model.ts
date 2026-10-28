/**
 * Workflows V2 definitions — the pure derivations behind the Canvas and
 * Scheduled tabs: dependency-depth layout, connection styling that does not
 * rely on colour, accessible names, edge field labels, the six-state health,
 * plain-words schedule text in the principal's timezone, and list filtering.
 *
 * No DOM and no Bun: the page imports it, and bun test exercises it directly.
 * Server contract: GET /api/workflows/graphs (LIFEOS/PULSE/modules/workflows.ts).
 */

import { parseDeploy, type DeployDrift } from "./editor-model";

export type ConnectionClass = "checked" | "runtime" | "mismatch";

export interface DefTrigger {
  type: "manual" | "schedule" | "once" | "interval" | "event" | "after";
  cron?: string;
  timezone?: string;
  at?: string;
  minutes?: number;
  name?: string;
  workflow?: string;
  status?: string;
  /** Next fire time from `workflow next`, when the trigger has one. */
  next?: string | null;
}

export interface DefStep {
  kind: string;
  executor: string;
  needs: string[];
  side_effects: string[];
  uses?: string;
  lane?: string;
  workflow?: string;
  description?: string;
  prompt?: string;
  question?: string;
  input?: unknown;
  output?: unknown;
}

export interface DefConnection {
  from: string;
  to: string;
  ref: string;
  at: string;
  class: ConnectionClass;
  reason?: string;
}

export interface DefLink {
  upstream: string;
  downstream: string;
  status: string;
  class: ConnectionClass;
  reason?: string;
}

/** A declared hand-off (`feeds:`): `downstream` picks up work this workflow leaves in `via` (ISC-273). */
export interface DefHandoff {
  upstream: string;
  downstream: string;
  via: string;
  class: string;
}

export interface Definition {
  name: string;
  path: string;
  description: string | null;
  runs_on: string;
  /** The workflow-level input schema; null when it takes none. Drives the Run form (ISC-93). */
  input: unknown;
  /** False when the workflow is paused. */
  enabled: boolean;
  valid: boolean;
  errors: string[];
  warnings: string[];
  triggers: DefTrigger[];
  steps: Record<string, DefStep>;
  connections: DefConnection[];
  links: DefLink[];
  handoffs: DefHandoff[];
  next: string | null;
  /** sha256 of the file on disk; the editor's base for an edit. */
  hash?: string | null;
  /** Cloud workflows: whether the file is what the last deploy shipped (ISC-174). */
  deploy?: DeployDrift | null;
}

export interface GraphsResponse {
  generatedAt: string;
  dir: string;
  definitions: Definition[];
  errors: Array<{ source: string; message: string }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const CLASSES: readonly ConnectionClass[] = ["checked", "runtime", "mismatch"];
const asClass = (v: unknown): ConnectionClass | null => ((CLASSES as readonly unknown[]).includes(v) ? (v as ConnectionClass) : null);

/** Shape-checks the graphs response; malformed definitions are counted, never guessed at. */
export function parseGraphs(raw: unknown): { ok: true; value: GraphsResponse; dropped: number } | { ok: false; reason: string } {
  if (!isObj(raw) || !Array.isArray(raw.definitions)) return { ok: false, reason: "the graphs response has no definitions array" };
  let dropped = 0;
  const definitions: Definition[] = [];
  for (const d of raw.definitions) {
    if (!isObj(d) || typeof d.name !== "string" || typeof d.path !== "string" || !isObj(d.steps)) { dropped++; continue; }
    const steps: Record<string, DefStep> = {};
    for (const [id, s] of Object.entries(d.steps)) {
      if (!isObj(s) || typeof s.kind !== "string") continue;
      steps[id] = {
        kind: s.kind,
        executor: typeof s.executor === "string" ? s.executor : "unknown",
        needs: strs(s.needs),
        side_effects: strs(s.side_effects),
        ...(typeof s.uses === "string" ? { uses: s.uses } : {}),
        ...(typeof s.lane === "string" ? { lane: s.lane } : {}),
        ...(typeof s.workflow === "string" ? { workflow: s.workflow } : {}),
        ...(typeof s.description === "string" ? { description: s.description } : {}),
        ...(typeof s.prompt === "string" ? { prompt: s.prompt } : {}),
        ...(typeof s.question === "string" ? { question: s.question } : {}),
        ...("input" in s ? { input: s.input } : {}),
        ...("output" in s ? { output: s.output } : {}),
      };
    }
    const connections: DefConnection[] = [];
    for (const c of Array.isArray(d.connections) ? d.connections : []) {
      const cls = isObj(c) ? asClass(c.class) : null;
      if (isObj(c) && cls && typeof c.from === "string" && typeof c.to === "string" && typeof c.ref === "string" && typeof c.at === "string") {
        connections.push({ from: c.from, to: c.to, ref: c.ref, at: c.at, class: cls, ...(typeof c.reason === "string" ? { reason: c.reason } : {}) });
      }
    }
    const links: DefLink[] = [];
    for (const l of Array.isArray(d.links) ? d.links : []) {
      const cls = isObj(l) ? asClass(l.class) : null;
      if (isObj(l) && cls && typeof l.upstream === "string" && typeof l.downstream === "string") {
        links.push({ upstream: l.upstream, downstream: l.downstream, status: typeof l.status === "string" ? l.status : "succeeded", class: cls, ...(typeof l.reason === "string" ? { reason: l.reason } : {}) });
      }
    }
    definitions.push({
      name: d.name,
      path: d.path,
      description: typeof d.description === "string" ? d.description : null,
      runs_on: typeof d.runs_on === "string" ? d.runs_on : "local",
      input: d.input ?? null,
      enabled: d.enabled !== false,
      valid: d.valid === true,
      errors: strs(d.errors),
      warnings: strs(d.warnings),
      triggers: (Array.isArray(d.triggers) ? d.triggers : []).filter((t): t is DefTrigger => isObj(t) && typeof t.type === "string"),
      steps,
      connections,
      links,
      handoffs: (Array.isArray(d.handoffs) ? d.handoffs : []).filter((h): h is DefHandoff => isObj(h) && typeof h.upstream === "string" && typeof h.downstream === "string" && typeof h.via === "string").map((h) => ({ upstream: h.upstream, downstream: h.downstream, via: h.via, class: typeof h.class === "string" ? h.class : "declared" })),
      next: typeof d.next === "string" ? d.next : null,
      hash: typeof d.hash === "string" ? d.hash : null,
      deploy: parseDeploy(d.deploy),
    });
  }
  return {
    ok: true,
    dropped,
    value: {
      generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : "",
      dir: typeof raw.dir === "string" ? raw.dir : "",
      definitions,
      errors: Array.isArray(raw.errors) ? raw.errors.filter((e): e is { source: string; message: string } => isObj(e) && typeof e.source === "string" && typeof e.message === "string") : [],
    },
  };
}

/* ── Layout (ISC-95) ───────────────────────────────────────────────────── */

export const NODE_W = 188;
export const NODE_H = 64;
export const COL_GAP = 84;
export const ROW_GAP = 22;
export const LANE_GAP = 56;
export const PAD = 24;

export interface Box { id: string; x: number; y: number; w: number; h: number; depth: number }

/**
 * Dependency depth per step: a step with no `needs` is depth 0, otherwise one
 * more than its deepest need. A need naming an unknown step is ignored; a
 * cycle (which validation refuses) is broken rather than looping forever.
 */
export function stepDepths(steps: Record<string, DefStep>): Map<string, number> {
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const needs = (steps[id]?.needs ?? []).filter((n) => n in steps);
    const d = needs.length === 0 ? 0 : 1 + Math.max(...needs.map(visit));
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of Object.keys(steps)) visit(id);
  return depth;
}

/**
 * One lane per definition: a trigger column, then one column per dependency
 * depth, then the output column. Rows stack within a column in definition
 * order, so no two boxes can overlap.
 */
export interface Lane { name: string; y: number; height: number; width: number; trigger: Box; output: Box; steps: Box[] }

export function layoutDefinition(def: Definition, top: number): Lane {
  const depths = stepDepths(def.steps);
  const columns = new Map<number, string[]>();
  for (const id of Object.keys(def.steps)) {
    const d = depths.get(id) ?? 0;
    const col = columns.get(d);
    if (col) col.push(id);
    else columns.set(d, [id]);
  }
  const maxDepth = columns.size === 0 ? -1 : Math.max(...columns.keys());
  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
  const height = tallest * NODE_H + (tallest - 1) * ROW_GAP;
  const colX = (c: number) => PAD + c * (NODE_W + COL_GAP);
  const midY = top + (height - NODE_H) / 2;
  const steps: Box[] = [];
  for (const [d, ids] of columns) {
    const colH = ids.length * NODE_H + (ids.length - 1) * ROW_GAP;
    const y0 = top + (height - colH) / 2;
    ids.forEach((id, i) => steps.push({ id, x: colX(d + 1), y: y0 + i * (NODE_H + ROW_GAP), w: NODE_W, h: NODE_H, depth: d + 1 }));
  }
  const trigger: Box = { id: "trigger", x: colX(0), y: midY, w: NODE_W, h: NODE_H, depth: 0 };
  const output: Box = { id: "output", x: colX(maxDepth + 2), y: midY, w: NODE_W, h: NODE_H, depth: maxDepth + 2 };
  return { name: def.name, y: top, height, width: output.x + NODE_W + PAD, trigger, output, steps };
}

export function layoutAll(defs: Definition[]): { lanes: Lane[]; width: number; height: number } {
  const lanes: Lane[] = [];
  let y = PAD + 28;
  for (const d of defs) {
    const lane = layoutDefinition(d, y);
    lanes.push(lane);
    y += lane.height + LANE_GAP + 28;
  }
  const width = Math.max(640, ...lanes.map((l) => l.width));
  return { lanes, width, height: y - 28 };
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/* ── Edges (ISC-96, ISC-97, ISC-98) ────────────────────────────────────── */

export interface EdgeStyle { dash: string | null; cross: boolean; label: string; color: string }

/** Class → stroke. Every class differs in shape as well as colour. */
export function edgeStyle(cls: ConnectionClass): EdgeStyle {
  switch (cls) {
    case "checked": return { dash: null, cross: false, label: "checked", color: "var(--ok)" };
    case "runtime": return { dash: "6 5", cross: false, label: "runtime-checked", color: "var(--warn)" };
    case "mismatch": return { dash: "2 4", cross: true, label: "type mismatch", color: "var(--err)" };
  }
}

const WORST: Record<ConnectionClass, number> = { mismatch: 0, runtime: 1, checked: 2 };

export interface StepEdge { from: string; to: string; fields: string[]; cls: ConnectionClass; reasons: string[] }

/** The source node of a connection: a step id, "trigger" for the workflow input. */
const endpoint = (from: string): string => (from === "input" ? "trigger" : from.startsWith("steps.") ? from.slice(6) : from);

/** The field a mapping carries: `shout.text` → `text`; a whole-object mapping names the referenced field or "all". */
export function fieldOf(c: DefConnection): string {
  const dot = c.at.indexOf(".");
  if (dot >= 0) return c.at.slice(dot + 1);
  const m = /\.output\.(.+)$/.exec(c.ref);
  return m ? m[1] : "all";
}

/**
 * One edge per (source, target) pair: the fields it carries from the mapping,
 * its class the worst of its connections. A `needs` with no mapping still
 * draws an ordering edge (class checked, no fields), so the graph shows it.
 */
export function stepEdges(def: Definition): StepEdge[] {
  const byPair = new Map<string, StepEdge>();
  for (const c of def.connections) {
    const from = endpoint(c.from);
    const to = c.to;
    const key = `${from}→${to}`;
    const e = byPair.get(key) ?? { from, to, fields: [], cls: "checked" as ConnectionClass, reasons: [] };
    const f = fieldOf(c);
    if (!e.fields.includes(f)) e.fields.push(f);
    if (WORST[c.class] < WORST[e.cls]) e.cls = c.class;
    if (c.reason && !e.reasons.includes(c.reason)) e.reasons.push(c.reason);
    byPair.set(key, e);
  }
  for (const [id, s] of Object.entries(def.steps)) {
    for (const n of s.needs) {
      const key = `${n}→${id}`;
      if (!byPair.has(key)) byPair.set(key, { from: n, to: id, fields: [], cls: "checked", reasons: [] });
    }
    if (s.needs.length === 0 && !byPair.has(`trigger→${id}`)) byPair.set(`trigger→${id}`, { from: "trigger", to: id, fields: [], cls: "checked", reasons: [] });
  }
  return [...byPair.values()];
}

export const edgeFieldLabel = (e: StepEdge): string => (e.fields.length === 0 ? "order only" : e.fields.join(", "));

export function nodeName(kind: string, name: string, executor?: string): string {
  return executor ? `${kind} step ${name}, done by ${executor}` : `${kind} ${name}`;
}

export function edgeName(fromName: string, toName: string, cls: ConnectionClass, fields: string[]): string {
  return `connection from ${fromName} to ${toName}, ${edgeStyle(cls).label}${fields.length ? `, carries ${fields.join(", ")}` : ""}`;
}

/** Cross-workflow edges: `after:` links, sub-workflow steps and declared hand-offs, between definitions on the canvas. */
export interface WorkflowEdge { from: string; to: string; kind: "after" | "sub-workflow" | "handoff"; cls: ConnectionClass; label: string; reason?: string }

export function workflowEdges(defs: Definition[]): WorkflowEdge[] {
  const names = new Set(defs.map((d) => d.name));
  const out: WorkflowEdge[] = [];
  const seen = new Set<string>();
  for (const d of defs) {
    for (const l of d.links) {
      const key = `after:${l.upstream}→${l.downstream}`;
      if (seen.has(key) || !names.has(l.upstream) || !names.has(l.downstream)) continue;
      seen.add(key);
      out.push({ from: l.upstream, to: l.downstream, kind: "after", cls: l.class, label: `after ${l.status}`, ...(l.reason ? { reason: l.reason } : {}) });
    }
    for (const t of d.triggers) {
      if (t.type !== "after" || !t.workflow) continue;
      const key = `after:${t.workflow}→${d.name}`;
      if (seen.has(key) || !names.has(t.workflow)) continue;
      seen.add(key);
      out.push({ from: t.workflow, to: d.name, kind: "after", cls: "runtime", label: `after ${t.status ?? "succeeded"}` });
    }
    for (const [id, s] of Object.entries(d.steps)) {
      if (s.kind !== "workflow" || !s.workflow || !names.has(s.workflow)) continue;
      const key = `sub:${d.name}→${s.workflow}#${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from: d.name, to: s.workflow, kind: "sub-workflow", cls: "checked", label: `step ${id} runs it` });
    }
    for (const h of d.handoffs ?? []) {
      const key = `handoff:${h.upstream}→${h.downstream}#${h.via}`;
      if (seen.has(key) || !names.has(h.upstream) || !names.has(h.downstream)) continue;
      seen.add(key);
      out.push({ from: h.upstream, to: h.downstream, kind: "handoff", cls: "runtime", label: `via ${h.via}` });
    }
  }
  return out;
}

/* ── Health (ISC-100) ──────────────────────────────────────────────────── */

// The canonical derivation lives in LIFEOS/WORKFLOWS/health.ts; the page imports it rather than keeping a copy.
export { DEF_HEALTH_META, RECENT_MS, deriveHealth, type DefHealth, type HealthInput } from "../../../../../../WORKFLOWS/health";
import { DEF_HEALTH_META, type DefHealth } from "../../../../../../WORKFLOWS/health";
import { principalTz } from "../principal-tz";
import { fmtClock, fmtDateParts } from "@/lib/time";

/* ── Time and schedule text (ISC-107) ─────────────────────────────────── */


/** 24-hour HH:mm in the principal's timezone; "—" for a missing or bad time. */
export function hhmmTz(iso: string | null | undefined): string {
  if (!iso) return "—";
  return Number.isFinite(Date.parse(iso)) ? fmtClock(iso) : "—";
}

export function dayTz(iso: string | null | undefined): string {
  if (!iso) return "—";
  return Number.isFinite(Date.parse(iso)) ? fmtDateParts(iso, { weekday: "short", day: "numeric", month: "short" }) : "—";
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function daysText(dow: string): string | null {
  if (dow === "*") return "Daily";
  if (dow === "1-5") return "Weekdays";
  if (dow === "0,6" || dow === "6,0") return "Weekends";
  const parts = dow.split(",");
  const names: string[] = [];
  for (const p of parts) {
    const range = /^(\d)-(\d)$/.exec(p);
    if (range) { names.push(`${DOW[Number(range[1]) % 7]}–${DOW[Number(range[2]) % 7]}`); continue; }
    if (!/^\d$/.test(p)) return null;
    names.push(DOW[Number(p) % 7]);
  }
  return names.join(", ");
}

const two = (n: number) => String(n).padStart(2, "0");

/**
 * A 5-field cron in plain words: `0 9 * * 1-5` → `09:00 · Weekdays`,
 * `*\/15 * * * *` → `every 15 min`. A zone other than the principal's is named.
 * Shapes this cannot phrase fall back to "custom schedule (<cron>)" rather than
 * a wrong sentence.
 */
export function cronText(cron: string, timezone?: string): string {
  const f = cron.trim().split(/\s+/);
  const zone = timezone && timezone !== principalTz() ? ` (${timezone})` : "";
  if (f.length !== 5) return `custom schedule (${cron})${zone}`;
  const [min, hour, dom, mon, dow] = f;
  const every = /^\*\/(\d+)$/;
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const m = every.exec(min);
    if (m) return `every ${Number(m[1])} min`;
    if (min === "*") return "every minute";
    if (/^\d+$/.test(min)) return `hourly at :${two(Number(min))}`;
  }
  if (min === "0" && every.test(hour) && dom === "*" && mon === "*" && dow === "*") return `every ${Number(every.exec(hour)![1])} h`;
  if (/^\d+$/.test(min) && /^\d+(,\d+)*$/.test(hour) && mon === "*") {
    const times = hour.split(",").map((h) => `${two(Number(h))}:${two(Number(min))}`).join(", ");
    if (dom === "*") {
      const days = daysText(dow);
      if (days) return `${times} · ${days}${zone}`;
    } else if (/^\d+$/.test(dom) && dow === "*") return `${times} · day ${Number(dom)} of the month${zone}`;
  }
  return `custom schedule (${cron})${zone}`;
}

export function triggerText(t: DefTrigger): string {
  switch (t.type) {
    case "manual": return "on demand";
    case "schedule": return t.cron ? cronText(t.cron, t.timezone) : "schedule";
    case "interval": return typeof t.minutes === "number" ? (t.minutes % 60 === 0 && t.minutes >= 60 ? `every ${t.minutes / 60} h` : `every ${t.minutes} min`) : "interval";
    case "once": return t.at ? `once · ${dayTz(t.at)} ${hhmmTz(t.at)}` : "once";
    case "event": return `on event ${t.name ?? "?"}`;
    case "after": return `after ${t.workflow ?? "?"} ${t.status ?? "succeeded"}`;
  }
}

/** "in 2 h 05 min" / "in 4 min" / "due now"; null when there is no next time. */
export function countdown(next: string | null, now: number): string | null {
  if (!next) return null;
  const t = Date.parse(next);
  if (!Number.isFinite(t)) return null;
  const s = Math.floor((t - now) / 1000);
  if (s <= 0) return "due now";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `in ${d} d ${h} h`;
  if (h > 0) return `in ${h} h ${two(m)} min`;
  if (m > 0) return `in ${m} min ${two(sec)} s`;
  return `in ${sec} s`;
}

export const isScheduled = (d: Definition): boolean => d.triggers.some((t) => t.type === "schedule" || t.type === "interval" || t.type === "once");

/* ── List search, filter, sort (ISC-103) ──────────────────────────────── */

export type HealthFilter = "all" | "attention" | "running" | "quiet";
export const HEALTH_FILTERS: readonly HealthFilter[] = ["all", "attention", "running", "quiet"];

export function defMatches(d: Definition, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    d.name,
    d.description ?? "",
    ...d.triggers.map(triggerText),
    ...Object.entries(d.steps).flatMap(([id, s]) => [id, s.description ?? "", s.prompt ?? "", s.question ?? ""]),
  ].join("\n").toLowerCase();
  return hay.includes(needle);
}

export function passesHealth(h: DefHealth, f: HealthFilter): boolean {
  switch (f) {
    case "all": return true;
    case "attention": return h === "attention" || h === "failing";
    case "running": return h === "running";
    case "quiet": return h === "quiet" || h === "disabled";
  }
}

/** Search + health filter, sorted worst-first then by name. */
export function filterDefinitions(defs: Definition[], health: Map<string, DefHealth>, q: string, f: HealthFilter): Definition[] {
  return defs
    .filter((d) => defMatches(d, q) && passesHealth(health.get(d.name) ?? "quiet", f))
    .sort((a, b) => DEF_HEALTH_META[health.get(a.name) ?? "quiet"].order - DEF_HEALTH_META[health.get(b.name) ?? "quiet"].order || a.name.localeCompare(b.name));
}

/* ── Activity search and filter (ISC-104) ─────────────────────────────── */

export type RunStatus = "succeeded" | "failed" | "stopped" | "timed_out" | "abandoned";
export const RUN_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "stopped", "timed_out", "abandoned"];

export interface RunRow { recordId: string; status: string; trigger: string | null; detail: string | null; events: string[] }

/** Maps the activity feed's status vocabulary onto the ledger's. */
export function runStatusOf(status: string): RunStatus | null {
  switch (status) {
    case "ok": case "succeeded": return "succeeded";
    case "error": case "failed": return "failed";
    case "stopped": case "skipped": return "stopped";
    case "timed_out": return "timed_out";
    case "incomplete": case "abandoned": return "abandoned";
    default: return null;
  }
}

export function filterRuns<T extends RunRow>(rows: T[], q: string, statuses: ReadonlySet<RunStatus>, trigger: string | null): T[] {
  const needle = q.trim().toLowerCase();
  return rows.filter((r) => {
    if (statuses.size > 0) {
      const s = runStatusOf(r.status);
      if (!s || !statuses.has(s)) return false;
    }
    if (trigger && r.trigger !== trigger) return false;
    if (!needle) return true;
    return [r.recordId, r.detail ?? "", ...r.events].join("\n").toLowerCase().includes(needle);
  });
}
