#!/usr/bin/env bun
/**
 * Visualize.ts — deterministic renderer for the Visualize skill.
 *
 * Takes a typed system-model JSON (written by the model after reading the
 * target) plus the target root, validates that every claim cites a real file
 * (and, for `file:line`, a line that exists), then emits:
 *   1. a concise ASCII-art explanation on stdout
 *   2. one self-contained HTML page (full SVG diagram + explanation) written to
 *      <target dir>/Visualize-<slug>-<YYYY-MM-DD-HHmmss>.html
 *
 * The model's job ends at the JSON. Layout, ASCII, SVG, typography and colour
 * are all decided here, so every run reads the same way.
 *
 * Usage:
 *   bun Visualize.ts --model model.json --root <target dir> [--out-dir <dir>] [--width 100] [--no-html]
 *   bun Visualize.ts --check --model model.json --root <target dir>   # validate only
 *   bun Visualize.ts --schema                                         # print the model shape
 *
 * Exit: 0 rendered · 1 model refused (errors printed) · 2 usage error
 */

import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";

// ---------- model ----------

export const KINDS = ["client", "ui", "service", "worker", "job", "queue", "store", "external", "library", "config"] as const;
export type Kind = (typeof KINDS)[number];

export interface Tier { id: string; label: string; note?: string }
export interface Component {
  id: string; name: string; tier: string; kind: Kind; role: string;
  tech?: string; files?: string[]; holds?: string; breaksIf?: string;
}
export interface Edge { from: string; to: string; label: string; evidence: string; async?: boolean }
export interface Step { from: string; to: string; action: string }
export interface Flow { id: string; name: string; trigger: string; steps: Step[]; outcome: string }
export interface Boundary { name: string; between: string; guard: string; evidence: string }
export interface Risk { title: string; detail: string; severity: "high" | "medium" | "low"; evidence: string }
export interface ReadItem { path: string; why: string }
export interface Model {
  name: string;
  oneLiner: string;
  summary: string[];
  tiers: Tier[];
  components: Component[];
  edges: Edge[];
  flows: Flow[];
  boundaries?: Boundary[];
  risks?: Risk[];
  readingOrder?: ReadItem[];
  glossary?: { term: string; meaning: string }[];
  unknowns?: string[];
  sources: string[];
}

export const EXAMPLE: Model = {
  name: "Example Service",
  oneLiner: "A web API that accepts orders, stores them, and emails a receipt.",
  summary: [
    "Browsers call a single HTTP worker, which validates the order and writes it to the database.",
    "A queue decouples the slow part: a background job picks the order up and sends the receipt email.",
  ],
  tiers: [
    { id: "clients", label: "Clients" },
    { id: "app", label: "App" },
    { id: "data", label: "Data" },
    { id: "ext", label: "External" },
  ],
  components: [
    { id: "browser", name: "Browser", tier: "clients", kind: "client", role: "Places orders", files: ["web/index.html"] },
    { id: "api", name: "Orders API", tier: "app", kind: "service", role: "Validates and stores orders", tech: "Hono on Workers", files: ["src/api.ts"], breaksIf: "No orders can be placed" },
    { id: "db", name: "Orders DB", tier: "data", kind: "store", role: "Source of truth for orders", tech: "D1", holds: "orders, customers", files: ["migrations/0001.sql"] },
    { id: "mailer", name: "Receipt job", tier: "app", kind: "job", role: "Sends receipts", files: ["src/mailer.ts"] },
    { id: "email", name: "Email provider", tier: "ext", kind: "external", role: "Delivers mail" },
  ],
  edges: [
    { from: "browser", to: "api", label: "POST /orders", evidence: "src/api.ts:12" },
    { from: "api", to: "db", label: "INSERT order", evidence: "src/api.ts:30" },
    { from: "mailer", to: "db", label: "read new orders", evidence: "src/mailer.ts:8", async: true },
    { from: "mailer", to: "email", label: "send receipt", evidence: "src/mailer.ts:20" },
  ],
  flows: [
    {
      id: "order", name: "Placing an order", trigger: "User clicks Buy",
      steps: [
        { from: "browser", to: "api", action: "POSTs the cart" },
        { from: "api", to: "db", action: "stores the order" },
      ],
      outcome: "Order saved; receipt follows within a minute",
    },
  ],
  boundaries: [{ name: "Public edge", between: "Browser → Orders API", guard: "Session cookie checked on every request", evidence: "src/auth.ts:5" }],
  risks: [{ title: "No retry on email failure", detail: "A provider outage drops receipts silently.", severity: "medium", evidence: "src/mailer.ts:20" }],
  readingOrder: [{ path: "src/api.ts", why: "Every order passes through here" }],
  unknowns: ["Whether the mailer runs on a cron or a queue consumer in production"],
  sources: ["src/api.ts", "src/mailer.ts"],
};

// ---------- validation ----------

export const SECRET_SHAPES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/, "API secret key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, "JWT"],
  [/(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9/+_-]{16,}/i, "credential assignment"],
];

function resolveIn(root: string, p: string): string {
  return isAbsolute(p) ? p : join(root, p);
}

/** Checks `path` or `path:line` resolves to a real, non-empty file or directory under root. */
function checkRef(root: string, ref: string, where: string, errors: string[]): void {
  const m = ref.match(/^(.*?)(?::(\d+)(?:-\d+)?)?$/);
  const path = m?.[1] ?? ref;
  const line = m?.[2] ? Number(m[2]) : undefined;
  if (!path.trim()) { errors.push(`${where}: empty path`); return; }
  const full = resolveIn(root, path);
  if (!existsSync(full)) { errors.push(`${where}: "${path}" does not exist under the target root`); return; }
  const st = statSync(full);
  if (st.isFile()) {
    if (st.size === 0) { errors.push(`${where}: "${path}" is empty`); return; }
    if (line !== undefined) {
      const lines = readFileSync(full, "utf8").split("\n").length;
      if (line < 1 || line > lines) errors.push(`${where}: "${path}" has ${lines} lines, cited line ${line}`);
    }
  } else if (line !== undefined) {
    errors.push(`${where}: "${path}" is a directory but cites a line`);
  }
}

export interface Validation { errors: string[]; warnings: string[] }

export function validate(model: Model, root: string): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const req = (v: unknown, where: string) => {
    if (typeof v !== "string" || !v.trim()) errors.push(`${where}: required text is missing`);
  };

  req(model.name, "name");
  req(model.oneLiner, "oneLiner");
  if (typeof model.oneLiner === "string" && model.oneLiner.length > 200) warnings.push("oneLiner is over 200 characters; it should read in one breath");
  if (!Array.isArray(model.summary) || model.summary.length === 0) errors.push("summary: at least one sentence is required");
  else if (model.summary.length > 6) warnings.push("summary has more than 6 sentences; the short version should stay short");
  for (const key of ["tiers", "components", "edges", "flows", "sources"] as const) {
    if (!Array.isArray(model[key])) errors.push(`${key}: must be an array`);
  }
  if (errors.length) return { errors, warnings };

  const tierIds = new Set<string>();
  for (const t of model.tiers) {
    req(t.id, "tier.id"); req(t.label, `tier ${t.id}.label`);
    if (tierIds.has(t.id)) errors.push(`tier "${t.id}" is declared twice`);
    tierIds.add(t.id);
  }

  const ids = new Set<string>();
  for (const c of model.components) {
    const w = `component "${c.id}"`;
    req(c.id, "component.id"); req(c.name, `${w}.name`); req(c.role, `${w}.role`);
    if (ids.has(c.id)) errors.push(`${w} is declared twice`);
    ids.add(c.id);
    if (!tierIds.has(c.tier)) errors.push(`${w}: tier "${c.tier}" is not declared in tiers`);
    if (!KINDS.includes(c.kind)) errors.push(`${w}: kind "${c.kind}" is not one of ${KINDS.join(", ")}`);
    if (c.kind !== "external" && (!c.files || c.files.length === 0)) {
      errors.push(`${w}: every non-external component must cite at least one file it lives in`);
    }
    for (const f of c.files ?? []) checkRef(root, f, `${w}.files`, errors);
  }
  if (model.components.length > 30) warnings.push(`${model.components.length} components; above ~30 the diagram stops being a map — consider grouping`);

  const edgeKeys = new Set<string>();
  const touched = new Set<string>();
  model.edges.forEach((e, i) => {
    const w = `edge ${i + 1} (${e.from} → ${e.to})`;
    if (!ids.has(e.from)) errors.push(`${w}: unknown component "${e.from}"`);
    if (!ids.has(e.to)) errors.push(`${w}: unknown component "${e.to}"`);
    if (e.from === e.to) errors.push(`${w}: an edge cannot point at its own source`);
    req(e.label, `${w}.label`);
    if (typeof e.evidence !== "string" || !e.evidence.trim()) errors.push(`${w}: evidence (the file or file:line that makes this connection) is required`);
    else checkRef(root, e.evidence, `${w}.evidence`, errors);
    edgeKeys.add(`${e.from}→${e.to}`);
    touched.add(e.from); touched.add(e.to);
  });
  for (const c of model.components) if (!touched.has(c.id)) warnings.push(`component "${c.id}" has no connections`);

  const flowIds = new Set<string>();
  for (const f of model.flows) {
    const w = `flow "${f.id}"`;
    req(f.id, "flow.id"); req(f.name, `${w}.name`); req(f.trigger, `${w}.trigger`); req(f.outcome, `${w}.outcome`);
    if (flowIds.has(f.id)) errors.push(`${w} is declared twice`);
    flowIds.add(f.id);
    if (!Array.isArray(f.steps) || f.steps.length === 0) { errors.push(`${w}: needs at least one step`); continue; }
    f.steps.forEach((s, i) => {
      const sw = `${w} step ${i + 1}`;
      if (!ids.has(s.from)) errors.push(`${sw}: unknown component "${s.from}"`);
      if (!ids.has(s.to)) errors.push(`${sw}: unknown component "${s.to}"`);
      req(s.action, `${sw}.action`);
      if (ids.has(s.from) && ids.has(s.to) && !edgeKeys.has(`${s.from}→${s.to}`)) {
        errors.push(`${sw}: hop ${s.from} → ${s.to} has no matching edge; add the edge or fix the step`);
      }
    });
  }
  if (model.flows.length === 0) warnings.push("no flows; the page cannot show how anything moves");

  (model.boundaries ?? []).forEach((b, i) => {
    const w = `boundary ${i + 1}`;
    req(b.name, `${w}.name`); req(b.between, `${w}.between`); req(b.guard, `${w}.guard`);
    if (typeof b.evidence !== "string" || !b.evidence.trim()) errors.push(`${w}: evidence (the auth check, network call or config that establishes it) is required`);
    else checkRef(root, b.evidence, `${w}.evidence`, errors);
  });
  (model.risks ?? []).forEach((r, i) => {
    const w = `risk ${i + 1}`;
    req(r.title, `${w}.title`); req(r.detail, `${w}.detail`);
    if (!["high", "medium", "low"].includes(r.severity)) errors.push(`${w}: severity must be high, medium or low`);
    if (typeof r.evidence !== "string" || !r.evidence.trim()) errors.push(`${w}: evidence (the file or file:line that grounds it) is required`);
    else checkRef(root, r.evidence, `${w}.evidence`, errors);
  });
  (model.readingOrder ?? []).forEach((r, i) => { checkRef(root, r.path, `readingOrder ${i + 1}`, errors); req(r.why, `readingOrder ${i + 1}.why`); });
  if (model.sources.length === 0) errors.push("sources: list the files you read to build this model");
  model.sources.forEach((s, i) => checkRef(root, s, `sources ${i + 1}`, errors));

  const blob = JSON.stringify(model);
  for (const [re, what] of SECRET_SHAPES) if (re.test(blob)) errors.push(`model text contains a ${what}; the page lands in the project tree, so remove it`);

  return { errors, warnings };
}

// ---------- context ----------

export interface Context {
  root: string;
  generatedAt: Date;
  commit?: string;
  dirty?: number;
  trackedFiles?: number;
  previous: string[]; // earlier Visualize pages for the same slug, newest first
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "system";
}

export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function humanTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function outputPath(outDir: string, name: string, d: Date): string {
  return join(outDir, `Visualize-${slugify(name)}-${stamp(d)}.html`);
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export function gatherContext(root: string, outDir: string, name: string, now = new Date()): Context {
  const commit = git(root, ["rev-parse", "--short", "HEAD"]);
  const status = commit ? git(root, ["status", "--porcelain", "--", "."]) : undefined;
  const tracked = commit ? git(root, ["ls-files", "--", "."]) : undefined;
  const prefix = `Visualize-${slugify(name)}-`;
  const previous = existsSync(outDir)
    ? readdirSync(outDir).filter((f) => f.startsWith(prefix) && f.endsWith(".html")).sort().reverse()
    : [];
  return {
    root, generatedAt: now, commit,
    dirty: status === undefined ? undefined : status.split("\n").filter(Boolean).length,
    trackedFiles: tracked === undefined ? undefined : tracked.split("\n").filter(Boolean).length,
    previous,
  };
}

// ---------- ASCII ----------

const len = (s: string) => [...s].length;
const clip = (s: string, n: number) => (len(s) <= n ? s : [...s].slice(0, Math.max(1, n - 1)).join("") + "…");
const padR = (s: string, n: number) => s + " ".repeat(Math.max(0, n - len(s)));
const center = (s: string, n: number) => {
  const left = Math.floor((n - len(s)) / 2);
  return padR(" ".repeat(Math.max(0, left)) + s, n);
};

export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (len(line) + 1 + len(word) <= width) line += " " + word;
    else { out.push(line); line = word; }
    while (len(line) > width) { out.push([...line].slice(0, width).join("")); line = [...line].slice(width).join(""); }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

const BOX: Record<string, { tl: string; tr: string; bl: string; br: string; h: string; v: string }> = {
  plain: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  store: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  client: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  external: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "┄", v: "┆" },
};
const boxStyle = (k: Kind) => (k === "store" ? BOX.store : k === "client" || k === "ui" ? BOX.client : k === "external" ? BOX.external : BOX.plain);

function box(c: Component, maxW = 26): string[] {
  const sub = clip(c.tech || c.kind, maxW - 4);
  const name = clip(c.name, maxW - 4);
  const w = Math.max(12, Math.min(maxW, Math.max(len(name), len(sub)) + 4));
  const b = boxStyle(c.kind);
  return [
    b.tl + b.h.repeat(w - 2) + b.tr,
    b.v + " " + padR(name, w - 4) + " " + b.v,
    b.v + " " + padR(sub, w - 4) + " " + b.v,
    b.bl + b.h.repeat(w - 2) + b.br,
  ];
}

function rule(title: string, width: number): string {
  const head = `── ${title} `;
  return head + "─".repeat(Math.max(3, width - len(head)));
}

export function renderAscii(model: Model, ctx: Context, htmlPath: string | undefined, width = 100): string {
  const W = Math.max(60, width);
  const out: string[] = [];
  const comp = new Map(model.components.map((c) => [c.id, c]));
  const tierIndex = new Map(model.tiers.map((t, i) => [t.id, i]));

  // Title plate
  const title = ` ${model.name.toUpperCase()} `;
  out.push("╭" + "─".repeat(W - 2) + "╮");
  out.push("│" + center(clip(title, W - 4), W - 2) + "│");
  for (const l of wrap(model.oneLiner, W - 6)) out.push("│" + center(l, W - 2) + "│");
  out.push("╰" + "─".repeat(W - 2) + "╯");
  const meta = [
    ctx.commit ? `commit ${ctx.commit}${ctx.dirty ? ` (+${ctx.dirty} uncommitted)` : ""}` : "not a git repo",
    `${model.components.length} parts · ${model.edges.length} links · ${model.flows.length} flows`,
    ctx.trackedFiles ? `read ${model.sources.length} of ${ctx.trackedFiles} files` : `read ${model.sources.length} files`,
  ].join("  ·  ");
  out.push(center(clip(meta, W), W).trimEnd());
  out.push("");

  for (const s of model.summary) for (const [i, l] of wrap(s, W - 4).entries()) out.push((i === 0 ? "  • " : "    ") + l);
  out.push("");

  // Tiered map
  out.push(rule("MAP", W));
  const labW = Math.min(12, Math.max(...model.tiers.map((t) => len(t.label)))) + 2;
  for (const t of model.tiers) {
    const members = model.components.filter((c) => c.tier === t.id);
    if (!members.length) continue;
    const boxes = members.map((c) => box(c));
    let row: string[][] = [];
    let used = labW;
    const rows: string[][][] = [];
    for (const b of boxes) {
      const bw = len(b[0]) + 2;
      if (row.length && used + bw > W) { rows.push(row); row = []; used = labW; }
      row.push(b); used += bw;
    }
    if (row.length) rows.push(row);
    rows.forEach((r, ri) => {
      for (let line = 0; line < 4; line++) {
        const label = ri === 0 && line === 1 ? padR(clip(t.label.toUpperCase(), labW - 2), labW) : " ".repeat(labW);
        out.push((label + r.map((b) => b[line]).join("  ")).trimEnd());
      }
    });
    const outgoing = model.edges.filter((e) => comp.get(e.from)?.tier === t.id);
    for (const e of outgoing) {
      const dt = (tierIndex.get(comp.get(e.to)!.tier) ?? 0) - (tierIndex.get(t.id) ?? 0);
      const dir = dt > 0 ? "↓" : dt < 0 ? "↑" : "→";
      const arrow = e.async ? "┄▶" : "─▶";
      out.push(clip(`${" ".repeat(labW)}${dir} ${comp.get(e.from)!.name} ${arrow} ${comp.get(e.to)!.name}  · ${e.label}`, W));
    }
    out.push("");
  }

  // Primary flow: a horizontal chain of boxes with numbered hops, wrapped to width,
  // then one short line per hop.
  const flow = model.flows[0];
  if (flow) {
    out.push(rule(`FLOW · ${flow.name}`, W));
    out.push(`  ${clip(`when: ${flow.trigger}`, W - 2)}`);
    const chain = [flow.steps[0].from, ...flow.steps.map((s) => s.to)].map((id) => comp.get(id)!);
    const cells = chain.map((c) => clip(c.name, 22));
    const rows: number[][] = [[]];
    let used = 2;
    cells.forEach((name, i) => {
      const w = len(name) + 4 + (i < cells.length - 1 ? 5 : 0);
      if (rows.at(-1)!.length && used + w > W) { rows.push([]); used = 5; }
      rows.at(-1)!.push(i); used += w;
    });
    rows.forEach((r, ri) => {
      const lead = ri === 0 ? "  " : "  ↳  ";
      const top: string[] = [], midL: string[] = [], bot: string[] = [];
      r.forEach((i) => {
        const n = cells[i]!, bw = len(n) + 2;
        const hop = i < cells.length - 1 ? `─${i + 1}─▶` : "";
        top.push("┌" + "─".repeat(bw) + "┐" + " ".repeat(len(hop)));
        midL.push("│ " + n + " │" + hop);
        bot.push("└" + "─".repeat(bw) + "┘" + " ".repeat(len(hop)));
      });
      out.push(" ".repeat(len(lead)) + top.join("").trimEnd());
      out.push(lead + midL.join(""));
      out.push(" ".repeat(len(lead)) + bot.join("").trimEnd());
    });
    flow.steps.forEach((s, i) => {
      for (const [j, l] of wrap(s.action, W - 7).entries()) out.push((j === 0 ? `  ${String(i + 1).padStart(2)}. ` : "      ") + l);
    });
    for (const l of wrap(`⇒ ${flow.outcome}`, W - 4)) out.push("  " + l);
    const others = model.flows.slice(1);
    if (others.length) {
      out.push("");
      for (const f of others) out.push(clip(`  also: ${f.name} — ${f.trigger} (${f.steps.length} hop${f.steps.length > 1 ? "s" : ""})`, W));
    }
    out.push("");
  }


  // Risks, boundaries, reading order
  const order = { high: 0, medium: 1, low: 2 } as const;
  const risks = [...(model.risks ?? [])].sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 4);
  if (risks.length) {
    out.push(rule("WATCH", W));
    const mark = { high: "▲ HIGH", medium: "■ MED ", low: "· LOW " } as const;
    for (const r of risks) {
      out.push(clip(`  ${mark[r.severity]}  ${r.title}`, W));
      const d = wrap(r.detail, W - 12);
      d.slice(0, 2).forEach((l, i) => out.push(`          ${i === 1 && d.length > 2 ? clip(l + " …", W - 10) : l}`));
    }
    if ((model.risks?.length ?? 0) > risks.length) out.push(`  +${model.risks!.length - risks.length} more in the HTML`);
    out.push("");
  }
  if (model.readingOrder?.length) {
    out.push(rule("START READING", W));
    model.readingOrder.slice(0, 3).forEach((r, i) => out.push(clip(`  ${i + 1}. ${r.path} — ${r.why}`, W)));
    out.push("");
  }
  if (model.unknowns?.length) out.push(clip(`  ? ${model.unknowns.length} open question${model.unknowns.length > 1 ? "s" : ""} this map could not answer (listed in the HTML)`, W));
  if (htmlPath) out.push(clip(`  HTML → ${htmlPath}`, Math.max(W, len(htmlPath) + 10)));
  if (ctx.previous.length) out.push(clip(`  earlier maps here: ${ctx.previous.length} (latest ${ctx.previous[0]})`, W));
  return out.join("\n");
}

// ---------- SVG layout ----------

const PALETTE = ["#6cc4ff", "#b59cff", "#ffb86b", "#5fe0b0", "#ff8fa3", "#f2dc6b", "#9fb3c8", "#7fd4e8"];

interface Placed { c: Component; x: number; y: number; w: number; h: number; color: string }
interface Pt { x: number; y: number }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const VW = 1240;
const GUTTER = 0;
const SIDE = 28;
const NODE_H = 62;
const ROW_GAP = 64;
const BAND_PAD = 58;

function nodeWidth(c: Component): number {
  const name = clip(c.name, 26);
  const sub = clip(c.tech || c.kind, 30);
  return Math.round(Math.max(150, Math.min(270, Math.max(len(name) * 9.3, len(sub) * 7.5) + 40)));
}

function bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

interface Layout {
  width: number; height: number;
  bands: { tier: Tier; y: number; h: number; color: string }[];
  nodes: Map<string, Placed>;
  edges: { e: Edge; d: string; label: Pt; badge: Pt; i: number }[];
}

export function layout(model: Model): Layout {
  const tierColor = new Map(model.tiers.map((t, i) => [t.id, PALETTE[i % PALETTE.length]]));
  const avail = VW - GUTTER - SIDE * 2;

  // Order within tiers: barycentre sweeps against neighbours in other tiers.
  const order = new Map<string, string[]>(model.tiers.map((t) => [t.id, model.components.filter((c) => c.tier === t.id).map((c) => c.id)]));
  const neighbours = new Map<string, string[]>();
  for (const e of model.edges) {
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
  }
  const frac = () => {
    const f = new Map<string, number>();
    for (const ids of order.values()) ids.forEach((id, i) => f.set(id, (i + 0.5) / ids.length));
    return f;
  };
  const tiersSeq = model.tiers.map((t) => t.id);
  for (let pass = 0; pass < 6; pass++) {
    const seq = pass % 2 === 0 ? tiersSeq : [...tiersSeq].reverse();
    for (const tid of seq) {
      const f = frac();
      const ids = order.get(tid)!;
      // Same-tier neighbours count too, so parts that talk to each other sit side by side.
      const score = new Map(ids.map((id) => {
        const ns = neighbours.get(id) ?? [];
        return [id, ns.length ? (ns.reduce((a, n) => a + (f.get(n) ?? 0.5), 0) + f.get(id)!) / (ns.length + 1) : f.get(id)!];
      }));
      ids.sort((a, b) => score.get(a)! - score.get(b)!);
    }
  }

  const byId = new Map(model.components.map((c) => [c.id, c]));
  const nodes = new Map<string, Placed>();
  const bands: Layout["bands"] = [];
  let y = 0;
  for (const t of model.tiers) {
    const ids = order.get(t.id)!;
    if (!ids.length) continue;
    // Pack rows greedily, then balance counts across the row count.
    const widths = ids.map((id) => nodeWidth(byId.get(id)!));
    let rowsNeeded = 1, acc = 0;
    // A row needs ~130px between boxes so connection labels have somewhere to sit.
    widths.forEach((w) => { if (acc && acc + w + 130 > avail) { rowsNeeded++; acc = 0; } acc += w + 130; });
    const perRow = Math.ceil(ids.length / rowsNeeded);
    const rows: string[][] = [];
    for (let i = 0; i < ids.length; i += perRow) rows.push(ids.slice(i, i + perRow));
    const h = BAND_PAD * 2 + rows.length * NODE_H + (rows.length - 1) * ROW_GAP;
    bands.push({ tier: t, y, h, color: tierColor.get(t.id)! });
    rows.forEach((r, ri) => {
      const ws = r.map((id) => nodeWidth(byId.get(id)!));
      const sum = ws.reduce((a, b) => a + b, 0);
      const gap = Math.min(170, (avail - sum) / (r.length + 1));
      let x = GUTTER + SIDE + (avail - sum - gap * (r.length - 1)) / 2;
      r.forEach((id, i) => {
        nodes.set(id, { c: byId.get(id)!, x, y: y + BAND_PAD + ri * (NODE_H + ROW_GAP), w: ws[i], h: NODE_H, color: tierColor.get(t.id)! });
        x += ws[i] + gap;
      });
    });
    y += h;
  }

  // Ports: spread multiple edges across a node side, ordered by the other end's x.
  type Side = "top" | "bottom" | "left" | "right";
  const rowOf = (n: Placed) => [...nodes.values()].filter((m) => Math.abs(m.y - n.y) < 1).sort((p, q) => p.x - q.x);
  const plan = model.edges.map((e) => {
    const a = nodes.get(e.from)!, b = nodes.get(e.to)!;
    let sa: Side, sb: Side, arc = 0;
    if (b.y > a.y + 1) { sa = "bottom"; sb = "top"; }
    else if (b.y < a.y - 1) { sa = "top"; sb = "bottom"; }
    else {
      const row = rowOf(a);
      const adjacent = Math.abs(row.indexOf(a) - row.indexOf(b)) === 1;
      if (adjacent) { sa = b.x > a.x ? "right" : "left"; sb = b.x > a.x ? "left" : "right"; }
      // Non-adjacent parts on one row: arc over the row going right, under it going left,
      // so a two-way pair splits and nothing passes through the boxes between them.
      else if (b.x > a.x) { sa = "top"; sb = "top"; arc = -1; }
      else { sa = "bottom"; sb = "bottom"; arc = 1; }
    }
    return { e, a, b, sa, sb, arc };
  });
  const portSlots = new Map<string, { key: string; other: number }[]>();
  plan.forEach((p, i) => {
    const push = (node: Placed, side: Side, other: Placed, end: string) => {
      const k = `${node.c.id}:${side}`;
      portSlots.set(k, [...(portSlots.get(k) ?? []), { key: `${i}:${end}`, other: side === "left" || side === "right" ? other.y : other.x + other.w / 2 }]);
    };
    push(p.a, p.sa, p.b, "a"); push(p.b, p.sb, p.a, "b");
  });
  const portPos = new Map<string, Pt>();
  for (const [k, slots] of portSlots) {
    // Split on the LAST colon: component IDs may themselves contain ':' (validate() accepts them).
    const cut = k.lastIndexOf(":");
    const id = k.slice(0, cut), side = k.slice(cut + 1) as Side;
    const n = nodes.get(id)!;
    slots.sort((s, t) => s.other - t.other);
    slots.forEach((s, i) => {
      const f = (i + 1) / (slots.length + 1);
      const pt: Pt =
        side === "top" ? { x: n.x + n.w * (0.2 + 0.6 * f), y: n.y } :
        side === "bottom" ? { x: n.x + n.w * (0.2 + 0.6 * f), y: n.y + n.h } :
        side === "left" ? { x: n.x, y: n.y + n.h * (0.25 + 0.5 * f) } :
        { x: n.x + n.w, y: n.y + n.h * (0.25 + 0.5 * f) };
      portPos.set(s.key, pt);
    });
  }

  const placedBoxes: { x: number; y: number; w: number; h: number }[] = [...nodes.values()].map((n) => ({ x: n.x - 4, y: n.y - 4, w: n.w + 8, h: n.h + 8 }));
  const overlap = (r: { x: number; y: number; w: number; h: number }) =>
    placedBoxes.reduce((a, o) => a + Math.max(0, Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x)) * Math.max(0, Math.min(r.y + r.h, o.y + o.h) - Math.max(r.y, o.y)), 0);

  // Rows of boxes, for threading long connections through the gaps between them.
  const rowYs = [...new Set([...nodes.values()].map((n) => n.y))].sort((a, b) => a - b);
  const channelUse = new Map<string, number>();
  const waypoint = (rowY: number, idealX: number): Pt => {
    const pad = 34;
    const blocks = [...nodes.values()].filter((n) => n.y === rowY).map((n) => [n.x - pad, n.x + n.w + pad] as const);
    const inside = (x: number) => blocks.some(([l, r]) => x > l && x < r);
    let x = idealX;
    if (inside(x)) {
      const cands = blocks.flatMap(([l, r]) => [l, r]).filter((c) => !inside(c) && c > GUTTER + 12 && c < VW - 12);
      x = cands.sort((a, b) => Math.abs(a - idealX) - Math.abs(b - idealX))[0] ?? idealX;
    }
    const key = `${rowY}:${Math.round(x / 10)}`;
    const used = channelUse.get(key) ?? 0;
    channelUse.set(key, used + 1);
    return { x: x + (used % 2 ? 1 : -1) * Math.ceil(used / 2) * 12, y: rowY + NODE_H / 2 };
  };

  const edges: Layout["edges"] = plan.map((p, i) => {
    const s = portPos.get(`${i}:a`)!, t = portPos.get(`${i}:b`)!;
    const vertical = p.sa === "top" || p.sa === "bottom";
    const segs: [Pt, Pt, Pt, Pt][] = [];
    if (p.arc) {
      const lift = Math.min(40, 18 + Math.abs(t.x - s.x) * 0.04) * 1.6;
      segs.push([s, { x: s.x, y: s.y + p.arc * lift }, { x: t.x, y: t.y + p.arc * lift }, t]);
    } else if (vertical) {
      // Waypoints in every row of boxes the connection has to cross, then smooth S-curves between them.
      const lo = Math.min(s.y, t.y), hi = Math.max(s.y, t.y);
      const crossed = rowYs.filter((ry) => ry > lo && ry + NODE_H < hi);
      if (s.y > t.y) crossed.reverse();
      const pts = [s, ...crossed.flatMap((ry) => { const w = waypoint(ry, s.x + (t.x - s.x) * ((ry + NODE_H / 2 - s.y) / (t.y - s.y))); const up = s.y < t.y ? -1 : 1; return [{ x: w.x, y: ry + NODE_H / 2 + up * (NODE_H / 2 + 14) }, { x: w.x, y: ry + NODE_H / 2 - up * (NODE_H / 2 + 14) }]; }), t];
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k]!, b = pts[k + 1]!, h = (b.y - a.y) / 2;
        segs.push([a, { x: a.x, y: a.y + (k === 0 ? Math.sign(h) * Math.max(Math.abs(h), 30) : h) }, { x: b.x, y: b.y - (k === pts.length - 2 ? Math.sign(h) * Math.max(Math.abs(h), 30) : h) }, b]);
      }
    } else {
      const dir = p.sa === "right" ? 1 : -1, dx = Math.max(30, Math.abs(t.x - s.x) * 0.45);
      segs.push([s, { x: s.x + dir * dx, y: s.y }, { x: t.x - dir * dx, y: t.y }, t]);
    }
    const f = (v: Pt) => `${v.x.toFixed(1)},${v.y.toFixed(1)}`;
    const d = `M${f(s)} ` + segs.map(([, c1, c2, b]) => `C${f(c1)} ${f(c2)} ${f(b)}`).join(" ");
    const at = (u: number): Pt => {
      const k = Math.min(segs.length - 1, Math.floor(u * segs.length));
      const [a, c1, c2, b] = segs[k]!;
      return bezier(a, c1, c2, b, u * segs.length - k);
    };

    // Label: first spot along the line that covers nothing; otherwise the least-covering one.
    const lw = Math.min(28, len(p.e.label)) * 7.6 + 18;
    const tries: [number, number, number][] = [];
    for (const u of [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78]) tries.push([u, 0, 0]);
    for (const off of [26, -26, 46, -46, 66, -66]) tries.push(vertical && !p.arc ? [0.5, off * 1.8, 0] : [0.5, 0, off]);
    let best = { pt: at(0.5), cost: Infinity };
    for (const [u, ox, oy] of tries) {
      const base = at(u), pt = { x: base.x + ox, y: base.y + oy };
      const cost = overlap({ x: pt.x - lw / 2, y: pt.y - 10, w: lw, h: 20 });
      if (cost < best.cost) best = { pt, cost };
      if (cost === 0) break;
    }
    placedBoxes.push({ x: best.pt.x - lw / 2, y: best.pt.y - 10, w: lw, h: 20 });
    return { e: p.e, d, label: best.pt, badge: at(0.12), i };
  });

  return { width: VW, height: y, bands, nodes, edges };
}

function shapeSvg(n: Placed): string {
  const { x, y, w, h, color } = n;
  const k = n.c.kind;
  const fill = `fill="${color}" fill-opacity="0.13" stroke="${color}"`;
  if (k === "store") {
    const e = 8;
    return `<path d="M${x},${y + e} A${w / 2},${e} 0 0 1 ${x + w},${y + e} V${y + h - e} A${w / 2},${e} 0 0 1 ${x},${y + h - e} Z" ${fill} stroke-width="1.6"/>` +
      `<ellipse cx="${x + w / 2}" cy="${y + e}" rx="${w / 2}" ry="${e}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="1.6"/>`;
  }
  if (k === "external") return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${color}" fill-opacity="0.05" stroke="${color}" stroke-width="1.6" stroke-dasharray="6 5"/>`;
  if (k === "client" || k === "ui") return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" ${fill} stroke-width="2.2"/>`;
  if (k === "queue") {
    const bars = [0, 1, 2].map((i) => `<line x1="${x + w - 14 - i * 7}" y1="${y + 12}" x2="${x + w - 14 - i * 7}" y2="${y + h - 12}" stroke="${color}" stroke-opacity="0.55" stroke-width="2"/>`).join("");
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" ${fill} stroke-width="1.6"/>${bars}`;
  }
  if (k === "job") {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ${fill} stroke-width="1.6"/>` +
      `<circle cx="${x + w - 14}" cy="${y + 14}" r="6" fill="none" stroke="${color}" stroke-width="1.4"/><path d="M${x + w - 14},${y + 10.5} V${y + 14} H${x + w - 11}" fill="none" stroke="${color}" stroke-width="1.4"/>`;
  }
  if (k === "library" || k === "config") return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ${fill} stroke-width="1.6"/><path d="M${x + w - 14},${y} V${y + 10} H${x + w}" fill="none" stroke="${color}" stroke-width="1.2"/>`;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ${fill} stroke-width="1.6"/>`;
}

// Presentation lives on the elements as attributes, so any renderer (browser, DOM-render
// screenshot, print, a viewer with CSS off) draws the same diagram. CSS only drives state.
const C = { edge: "#5d6f88", hot: "#c8f56a", hotInk: "#15200a", pill: "#11171f", pillLine: "#334358", text: "#e9eef5", dim: "#a7b4c6", faint: "#6f7f95" };
const UI = "Avenir Next, Segoe UI, system-ui, sans-serif";
const MONO = "SF Mono, JetBrains Mono, Menlo, Consolas, monospace";

export function renderSvg(model: Model, L: Layout): string {
  const parts: string[] = [];
  parts.push(`<svg class="map" viewBox="0 0 ${L.width} ${L.height}" role="img" aria-label="${esc(model.name)} architecture diagram" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<defs>
    <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${C.edge}"/></marker>
    <marker id="ah-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${C.hot}"/></marker>
  </defs>`);
  L.bands.forEach((b, i) => {
    parts.push(`<g class="band"><rect x="0" y="${b.y}" width="${L.width}" height="${b.h}" fill="#ffffff" fill-opacity="${i % 2 ? 0.042 : 0.018}"/>` +
      `<rect x="0" y="${b.y}" width="4" height="${b.h}" fill="${b.color}" fill-opacity="0.7"/>` +
      `<text x="24" y="${b.y + 28}" fill="${b.color}" font-family="${UI}" font-size="14" font-weight="700" letter-spacing="2.8">${esc(b.tier.label.toUpperCase())}</text>` +
      (b.tier.note ? `<text x="${24 + len(b.tier.label) * 11.5 + 14}" y="${b.y + 28}" fill="${C.faint}" font-family="${UI}" font-size="12">${esc(clip(b.tier.note, 48))}</text>` : "") + `</g>`);
  });
  parts.push(`<g class="edges">`);
  for (const e of L.edges) {
    parts.push(`<path class="e" data-i="${e.i}" data-from="${esc(e.e.from)}" data-to="${esc(e.e.to)}" d="${e.d}" fill="none" stroke="${C.edge}" stroke-width="1.6"${e.e.async ? ` stroke-dasharray="6 5"` : ""} marker-end="url(#ah)"/>`);
  }
  parts.push(`</g><g class="labels">`);
  for (const e of L.edges) {
    const t = clip(e.e.label, 28);
    const w = len(t) * 7.6 + 18;
    parts.push(`<g class="el" data-i="${e.i}"><rect x="${(e.label.x - w / 2).toFixed(1)}" y="${(e.label.y - 10).toFixed(1)}" width="${w.toFixed(1)}" height="20" rx="11" fill="${C.pill}" stroke="${C.pillLine}" stroke-width="1"/>` +
      `<text x="${e.label.x.toFixed(1)}" y="${(e.label.y + 4).toFixed(1)}" text-anchor="middle" fill="${C.dim}" font-family="${MONO}" font-size="12.5" font-weight="500">${esc(t)}</text></g>`);
  }
  parts.push(`</g><g class="nodes">`);
  for (const n of L.nodes.values()) {
    const name = clip(n.c.name, 26), sub = clip(n.c.tech || n.c.kind, 30);
    parts.push(`<g class="n" data-id="${esc(n.c.id)}" tabindex="0"><title>${esc(n.c.name)} — ${esc(n.c.role)}</title>${shapeSvg(n)}` +
      `<text x="${n.x + n.w / 2}" y="${n.y + n.h / 2 - 3}" text-anchor="middle" fill="${C.text}" font-family="${UI}" font-size="16" font-weight="600">${esc(name)}</text>` +
      `<text x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + 15}" text-anchor="middle" fill="${C.dim}" font-family="${MONO}" font-size="12">${esc(sub)}</text></g>`);
  }
  parts.push(`</g><g class="badges">`);
  model.flows.forEach((f, fi) => {
    f.steps.forEach((s, si) => {
      const edge = L.edges.find((e) => e.e.from === s.from && e.e.to === s.to)!;
      parts.push(`<g class="fb" data-f="${fi}" data-s="${si}" opacity="0"><circle cx="${edge.badge.x.toFixed(1)}" cy="${edge.badge.y.toFixed(1)}" r="11" fill="${C.hot}" stroke="#11171f" stroke-width="3"/>` +
        `<text x="${edge.badge.x.toFixed(1)}" y="${(edge.badge.y + 4).toFixed(1)}" text-anchor="middle" fill="${C.hotInk}" font-family="${UI}" font-size="12" font-weight="700">${si + 1}</text></g>`);
    });
  });
  parts.push(`</g></svg>`);
  return parts.join("\n");
}


// ---------- HTML ----------

const KIND_LABEL: Record<Kind, string> = {
  client: "Client", ui: "Interface", service: "Service", worker: "Worker", job: "Scheduled job",
  queue: "Queue", store: "Data store", external: "External", library: "Library", config: "Config",
};

const CSS = `
:root{
  --ground:#0d1117; --ground-2:#11171f; --panel:#151c26; --panel-2:#1a2330; --line:#263243; --line-2:#334358;
  --fg:#e9eef5; --dim:#a7b4c6; --faint:#6f7f95; --hot:#c8f56a; --hot-ink:#15200a; --edge:#5d6f88;
  --band-a:rgba(255,255,255,0.018); --band-b:rgba(255,255,255,0.042);
  --high:#ff7a7a; --medium:#ffc266; --low:#8fb3d9;
  --display:"Futura","Futura PT","Century Gothic","Avenir Next",system-ui,sans-serif;
  --body:"Charter","Iowan Old Style","Palatino","Georgia",serif;
  --ui:"Avenir Next","Segoe UI",system-ui,sans-serif;
  --mono:"SF Mono","JetBrains Mono","Menlo","Consolas",monospace;
  color-scheme: dark;
}
*{box-sizing:border-box}
html{background:var(--ground)}
body{margin:0;color:var(--fg);font:17px/1.6 var(--body);
  background-image:
    linear-gradient(rgba(120,150,190,0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(120,150,190,0.05) 1px, transparent 1px);
  background-size: 32px 32px; background-color: var(--ground);}
.wrap{max-width:1320px;margin:0 auto;padding:0 32px}
header.hero{text-align:center;padding:72px 0 40px}
.eyebrow{font:600 12px/1 var(--ui);letter-spacing:.32em;text-transform:uppercase;color:var(--hot)}
h1{font:700 clamp(40px,6vw,76px)/1.02 var(--display);letter-spacing:-.01em;margin:18px 0 18px}
.one{font:italic 400 clamp(19px,2.1vw,24px)/1.45 var(--body);color:var(--dim);max-width:860px;margin:0 auto}
.meta{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:28px}
.chip{font:500 12.5px/1 var(--mono);color:var(--dim);border:1px solid var(--line-2);border-radius:999px;padding:8px 13px;background:rgba(21,28,38,.7)}
.chip b{color:var(--fg);font-weight:600}
.chip.warn{border-color:#6b5320;color:var(--medium)}
section{padding:56px 0 8px}
h2{font:700 13px/1 var(--ui);letter-spacing:.28em;text-transform:uppercase;color:var(--faint);margin:0 0 22px;display:flex;align-items:center;gap:14px}
h2::after{content:"";flex:1;height:1px;background:var(--line)}
.short{display:grid;grid-template-columns:1.35fr 1fr;gap:28px;align-items:stretch}
.prose{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:30px 34px;font-size:19px;line-height:1.65}
.prose p{margin:0 0 14px}.prose p:last-child{margin:0}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.stats{align-content:center}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px 20px;display:flex;flex-direction:column;gap:10px}
.stat .v{font:700 40px/1 var(--display);color:var(--fg)}
.stat .k{font:600 11.5px/1.3 var(--ui);letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
.stat.alert .v{color:var(--high)}
.frame{background:var(--ground-2);border:1px solid var(--line);border-radius:22px;overflow:hidden}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;padding:16px 18px;border-bottom:1px solid var(--line);background:var(--panel)}
.toolbar .lbl{font:600 11px/1 var(--ui);letter-spacing:.2em;text-transform:uppercase;color:var(--faint);margin-right:6px}
button.f{font:600 13.5px/1 var(--ui);color:var(--dim);background:transparent;border:1px solid var(--line-2);border-radius:999px;padding:9px 15px;cursor:pointer}
button.f:hover{color:var(--fg);border-color:var(--faint)}
button.f[aria-pressed="true"]{background:var(--hot);color:var(--hot-ink);border-color:var(--hot)}
button.play{font:700 13.5px/1 var(--ui);background:var(--fg);color:var(--ground);border:0;border-radius:999px;padding:10px 16px;cursor:pointer;margin-left:6px}
button.play[disabled]{opacity:.35;cursor:default}
.scroller{overflow-x:auto}
svg.map{display:block;width:100%;min-width:960px;height:auto}
.legend{font-size:14px !important}
svg .e{transition:stroke .25s,opacity .25s,stroke-width .25s}
svg .el,svg .n,svg .fb{transition:opacity .25s}
svg .n{cursor:pointer}
svg .n:focus{outline:none}
svg .n:focus-visible path, svg .n:focus-visible rect{stroke-width:3}
svg.focus .e, svg.hover .e{opacity:.13}
svg.focus .el, svg.hover .el{opacity:.12}
svg.focus .n, svg.hover .n{opacity:.3}
svg .e.on{opacity:1;stroke:var(--hot);stroke-width:2.6}
svg .el.on{opacity:1}
svg .el.on rect{stroke:var(--hot)}
svg .el.on text{fill:var(--fg)}
svg .n.on{opacity:1}
svg .fb.on{opacity:1}
.legend{display:flex;flex-wrap:wrap;justify-content:center;gap:22px;padding:14px 18px;border-top:1px solid var(--line);font:500 12.5px/1 var(--ui);color:var(--dim)}
.legend span{display:inline-flex;align-items:center;gap:8px}
.legend svg{width:34px;height:20px}
.below{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line)}
.below > div{padding:24px 28px}
.below > div + div{border-left:1px solid var(--line)}
.below h3{font:700 11.5px/1 var(--ui);letter-spacing:.22em;text-transform:uppercase;color:var(--faint);margin:0 0 14px}
.steps{list-style:none;margin:0;padding:0}
.steps li{display:grid;grid-template-columns:30px 1fr;gap:12px;padding:9px 0;border-bottom:1px dashed var(--line);font-size:16px;transition:opacity .25s}
.steps li:last-child{border-bottom:0}
.steps .num{font:700 13px/26px var(--ui);text-align:center;width:26px;height:26px;border-radius:50%;background:var(--panel-2);color:var(--dim)}
.steps li.lit .num{background:var(--hot);color:var(--hot-ink)}
.steps .hop{font:600 13px var(--mono);color:var(--dim);display:block}
.muted{color:var(--faint);font-style:italic}
.outcome{margin-top:12px;font-size:16px;color:var(--dim)}
.outcome b{color:var(--hot);font:700 12px var(--ui);letter-spacing:.18em;text-transform:uppercase;margin-right:8px}
.insp .kind{font:600 11.5px var(--ui);letter-spacing:.16em;text-transform:uppercase}
.insp .name{font:700 26px/1.15 var(--display);margin:6px 0 10px}
.insp p{margin:0 0 10px}
.files{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.files code, code.path{overflow-wrap:anywhere;max-width:100%;font:500 12.5px var(--mono);color:var(--fg);background:var(--panel-2);border:1px solid var(--line);border-radius:7px;padding:3px 8px}
.tierhead{display:flex;align-items:baseline;gap:14px;margin:30px 0 14px}
.tierhead .dot{width:12px;height:12px;border-radius:3px;flex:none;transform:translateY(1px)}
.tierhead h3{font:700 22px/1 var(--display);margin:0}
.tierhead span{font:400 15px var(--body);color:var(--faint);font-style:italic}
.cards{display:grid;grid-template-columns:repeat(var(--cols,3),minmax(0,1fr));gap:14px}
.flows .flow:last-child:nth-child(even){grid-column:1/-1}
.card.ext{border-style:dashed;border-top-style:solid;background:transparent}
.card .kind{display:flex;align-items:center;gap:8px}
.card .glyph svg{width:26px;height:16px;display:block}
.links{list-style:none;margin:4px 0 12px;padding:10px 0 0;border-top:1px solid var(--line)}
.links li > *{min-width:0;overflow-wrap:anywhere}
.links li{display:grid;grid-template-columns:16px auto minmax(0,1fr);gap:8px;align-items:baseline;font-size:13px;padding:2px 0;color:var(--dim)}
.links b{font:600 13px var(--ui);color:var(--dim);white-space:nowrap}
.links li span:last-child{font:500 12.5px var(--mono);color:var(--dim)}
.dir{font:700 14px var(--ui)}.dir.out{color:var(--hot)}.dir.in{color:var(--faint)}
.card{min-width:0;overflow-wrap:anywhere;background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--c);border-radius:14px;padding:20px 22px;scroll-margin-top:24px;transition:border-color .3s, box-shadow .3s}
.card.flash{box-shadow:0 0 0 2px var(--hot)}
.card .kind{font:600 11px var(--ui);letter-spacing:.16em;text-transform:uppercase;color:var(--c)}
.card h4{font:700 20px/1.2 var(--display);margin:6px 0 4px}
.card .tech{font:500 12.5px var(--mono);color:var(--faint);margin-bottom:10px}
.card p{margin:0 0 10px;font-size:16px}
.card > p:first-of-type{font-size:17px;color:var(--fg)}
.card .brk{font-size:14px;color:var(--faint);border-left:2px solid var(--high);padding-left:10px}
.card .holds{font-size:15px;color:var(--dim)}
.flows{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px}
.flow{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:24px 26px}
.flow h3{font:700 22px/1.2 var(--display);margin:0 0 4px}
.flow.main{grid-column:1/-1;border-color:var(--line-2);background:linear-gradient(180deg,rgba(200,245,106,.05),var(--panel) 50%)}
.flow.main h3{font-size:30px}
.flow.main .steps{display:grid;grid-template-columns:1fr 1fr;column-gap:36px}
.flow .tag{font:700 11px var(--ui);letter-spacing:.2em;text-transform:uppercase;color:var(--hot);margin-bottom:8px}
@media (max-width:900px){.flow.main .steps{grid-template-columns:1fr}}
.flow .trig{color:var(--dim);font-style:italic;margin-bottom:14px}
.flow button.f{margin-top:14px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.two.solo{grid-template-columns:1fr}
.box.bounds{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:0 28px}
.box.bounds .item{border-bottom:0;padding:4px 0}
.box.bounds .t{font-size:18px}
.risks{display:flex;flex-direction:column;gap:10px}
.risk{display:grid;grid-template-columns:92px 1fr;gap:18px;align-items:start;background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--low);border-radius:14px;padding:18px 22px}
.risk.high{border-left-color:var(--high);background:linear-gradient(90deg,rgba(255,122,122,.08),var(--panel) 40%)}
.risk.medium{border-left-color:var(--medium)}
.risk .sev{justify-self:start;margin-top:3px}
.risk .t{font:700 19px/1.3 var(--ui);margin-bottom:4px}
.risk .d{font-size:16.5px;color:var(--dim)}
.risk .ev{margin-top:8px}
@media (max-width:900px){.risk{grid-template-columns:1fr}}
.box{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:24px 26px}
.box h3{font:700 11.5px/1 var(--ui);letter-spacing:.22em;text-transform:uppercase;color:var(--faint);margin:0 0 16px}
.item{padding:12px 0;border-bottom:1px solid var(--line)}
.item:last-child{border-bottom:0;padding-bottom:0}
.item:first-of-type{padding-top:0}
.item .t{font:700 17px/1.3 var(--ui);margin-bottom:4px}
.item .d{font-size:16px;color:var(--dim)}
.item .ev{margin-top:6px}
.sev{font:700 10.5px/1 var(--ui);letter-spacing:.16em;text-transform:uppercase;padding:4px 8px;border-radius:5px;margin-right:8px;vertical-align:2px}
.sev.high{background:rgba(255,122,122,.14);color:var(--high)}
.sev.medium{background:rgba(255,194,102,.14);color:var(--medium)}
.sev.low{background:rgba(143,179,217,.14);color:var(--low)}
ol.read{margin:0;padding:0;list-style:none;counter-reset:none}
ol.read li{display:grid;grid-template-columns:34px 1fr;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}
ol.read li:last-child{border-bottom:0}
ol.read .idx{font:700 22px/1 var(--display);color:var(--hot)}
.fog{background:linear-gradient(135deg,rgba(255,194,102,.08),rgba(255,194,102,.02));border:1px solid #5c4a24;border-radius:16px;padding:22px 26px}
.fog h3{font:700 11.5px/1 var(--ui);letter-spacing:.22em;text-transform:uppercase;color:var(--medium);margin:0 0 12px}
.fog ul{margin:0;padding-left:20px}
footer{padding:56px 0 64px;text-align:center;color:var(--faint);font:400 13.5px/1.7 var(--ui)}
footer details{margin-top:14px;text-align:left;max-width:900px;margin-inline:auto}
footer summary{cursor:pointer;text-align:center}
footer .srcs{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;justify-content:center}
@media (max-width:900px){
  .wrap{padding:0 16px}
  .short,.two,.below{grid-template-columns:1fr}
  .below > div + div{border-left:0;border-top:1px solid var(--line)}
  .flows{grid-template-columns:1fr}
  .cards{grid-template-columns:1fr}
  .stats{grid-template-columns:repeat(2,1fr)}
  header.hero{padding-top:48px}
}
@media (prefers-reduced-motion: reduce){
  *{transition-duration:0s !important}
}
@media print{
  body{background:#fff;color:#111}
}
`;

const JS = `
(function(){
  const flows = JSON.parse(document.getElementById('v-flows').textContent);
  const comps = JSON.parse(document.getElementById('v-comps').textContent);
  const svg = document.querySelector('svg.map');
  const edges = [...svg.querySelectorAll('.e')];
  const labels = [...svg.querySelectorAll('.el')];
  const nodes = [...svg.querySelectorAll('.n')];
  const badges = [...svg.querySelectorAll('.fb')];
  const chips = [...document.querySelectorAll('.toolbar button.f')];
  const playBtn = document.querySelector('button.play');
  const stepsEl = document.getElementById('v-steps');
  const inspEl = document.getElementById('v-insp');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let current = -1, timers = [], pinned = null;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function clearTimers(){ timers.forEach(clearTimeout); timers = []; }
  const HOT = '#c8f56a', EDGE = '#5d6f88';
  function dimAll(on){ const v = on ? '0.13' : '1'; edges.forEach(e => e.setAttribute('opacity', v)); labels.forEach(l => l.setAttribute('opacity', on ? '0.12' : '1')); nodes.forEach(n => n.setAttribute('opacity', on ? '0.3' : '1')); }
  function heat(i, on){ const e = edges[i], l = labels[i]; e.setAttribute('stroke', on ? HOT : EDGE); e.setAttribute('stroke-width', on ? '2.6' : '1.6'); e.setAttribute('opacity', '1'); e.setAttribute('marker-end', on ? 'url(#ah-on)' : 'url(#ah)'); l.setAttribute('opacity', '1'); l.querySelector('rect').setAttribute('stroke', on ? HOT : '#334358'); l.querySelector('text').setAttribute('fill', on ? '#e9eef5' : '#a7b4c6'); }
  function lightStep(fi, si){
    const s = flows[fi].steps[si];
    edges[s.e].classList.add('on'); labels[s.e].classList.add('on'); heat(s.e, true);
    nodes.forEach(n => { if (n.dataset.id === s.from || n.dataset.id === s.to){ n.classList.add('on'); n.setAttribute('opacity', '1'); } });
    badges.forEach(b => { if (+b.dataset.f === fi && +b.dataset.s === si){ b.classList.add('on'); b.setAttribute('opacity', '1'); } });
    const li = stepsEl.querySelectorAll('li')[si]; if (li) li.classList.add('lit');
  }
  function reset(){
    clearTimers();
    svg.classList.remove('focus');
    edges.forEach((e, i) => { e.classList.remove('on','hl'); heat(i, false); });
    labels.forEach(l => l.classList.remove('on'));
    nodes.forEach(n => n.classList.remove('on'));
    badges.forEach(b => { b.classList.remove('on'); b.setAttribute('opacity', '0'); });
    dimAll(false);
  }
  function renderSteps(fi){
    if (fi < 0){ stepsEl.innerHTML = '<p class="muted" style="margin-top:0">Pick a flow to light up its path, hop by hop.</p>' + flows.map((f,i) => '<p style="margin:8px 0"><button class="f" data-pick="' + i + '">' + esc(f.name) + '</button></p>').join(''); stepsEl.querySelectorAll('button[data-pick]').forEach(b => b.addEventListener('click', () => select(+b.dataset.pick, true))); return; }
    const f = flows[fi];
    stepsEl.innerHTML = '<p class="muted" style="margin-top:0">' + esc(f.trigger) + '</p><ol class="steps">' +
      f.steps.map((s,i) => '<li><span class="num">' + (i+1) + '</span><span><span class="hop">' + esc(comps[s.from].name) + ' → ' + esc(comps[s.to].name) + '</span>' + esc(s.action) + '</span></li>').join('') +
      '</ol><div class="outcome"><b>Result</b>' + esc(f.outcome) + '</div>';
  }
  function select(fi, animate){
    reset(); current = fi;
    chips.forEach(c => c.setAttribute('aria-pressed', String(+c.dataset.f === fi)));
    playBtn.disabled = !flows.length;
    playBtn.textContent = '▶ Play';
    renderSteps(fi);
    if (fi < 0) return;
    svg.classList.add('focus'); dimAll(true);
    const n = flows[fi].steps.length;
    if (!animate){ for (let i = 0; i < n; i++) lightStep(fi, i); return; }
    // Stepping hop by hop is the content the reader asked for, so it runs even under reduced motion;
    // that preference only stills the CSS fades.
    playBtn.textContent = 'Playing…';
    for (let i = 0; i < n; i++) timers.push(setTimeout(() => lightStep(fi, i), 150 + i * 800));
    timers.push(setTimeout(() => { playBtn.textContent = '▶ Replay'; }, 150 + n * 800));
  }
  function inspect(id){
    const c = comps[id]; if (!c) return;
    inspEl.innerHTML = '<div class="kind" style="color:' + c.color + '">' + esc(c.kindLabel) + ' · ' + esc(c.tier) + '</div>' +
      '<div class="name">' + esc(c.name) + '</div><p>' + esc(c.role) + '</p>' +
      (c.tech ? '<p class="muted" style="font-style:normal;font-family:var(--mono);font-size:13px">' + esc(c.tech) + '</p>' : '') +
      (c.breaksIf ? '<p class="card brk" style="background:none;border-top:0;border-right:0;border-bottom:0;border-radius:0;padding:0 0 0 10px">If it breaks: ' + esc(c.breaksIf) + '</p>' : '') +
      (c.files && c.files.length ? '<div class="files">' + c.files.map(f => '<code>' + esc(f) + '</code>').join('') + '</div>' : '') +
      '<p style="margin-top:14px"><button class="f" data-jump="' + esc(id) + '">Full card ↓</button></p>';
  }
  function hover(id){
    if (current >= 0) return;
    svg.classList.add('hover');
    edges.forEach((e,i) => { const hit = e.dataset.from === id || e.dataset.to === id; e.classList.toggle('on', hit); labels[i].classList.toggle('on', hit); });
    nodes.forEach(n => { const linked = n.dataset.id === id || edges.some(e => (e.dataset.from === id && e.dataset.to === n.dataset.id) || (e.dataset.to === id && e.dataset.from === n.dataset.id)); n.classList.toggle('on', linked); });
  }
  function unhover(){
    if (current >= 0) return;
    svg.classList.remove('hover');
    edges.forEach(e => e.classList.remove('on')); labels.forEach(l => l.classList.remove('on')); nodes.forEach(n => n.classList.remove('on'));
  }
  chips.forEach(c => c.addEventListener('click', () => select(+c.dataset.f, true)));
  document.querySelectorAll('button[data-trace]').forEach(b => b.addEventListener('click', () => {
    document.querySelector('.frame').scrollIntoView({behavior: reduce ? 'auto' : 'smooth', block: 'start'});
    select(+b.dataset.trace, true);
  }));
  playBtn.addEventListener('click', () => select(current >= 0 ? current : 0, true));
  nodes.forEach(n => {
    n.addEventListener('mouseenter', () => { hover(n.dataset.id); if (!pinned) inspect(n.dataset.id); });
    n.addEventListener('mouseleave', unhover);
    n.addEventListener('click', () => { pinned = n.dataset.id; inspect(pinned); });
    n.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' '){ ev.preventDefault(); pinned = n.dataset.id; inspect(pinned); } });
  });
  document.addEventListener('click', ev => {
    const b = ev.target.closest && ev.target.closest('button[data-jump]'); if (!b) return;
    const card = document.getElementById('c-' + b.dataset.jump); if (!card) return;
    card.scrollIntoView({behavior: reduce ? 'auto' : 'smooth', block: 'center'});
    card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1600);
  });
  // Past ~16 connections the full web stops being readable at a glance; open on the main flow instead.
  select(flows.length && edges.length > 16 ? 0 : -1, false);
  const first = Object.keys(comps)[0]; if (first) inspect(first);
})();
`;

function legendSvg(kind: Kind): string {
  const c = "#9fb3c8";
  const f = `fill="${c}" fill-opacity=".13" stroke="${c}" stroke-width="1.4"`;
  const shapes: Partial<Record<Kind, string>> = {
    client: `<rect x="2" y="3" width="30" height="14" rx="7" ${f}/>`,
    service: `<rect x="2" y="3" width="30" height="14" rx="4" ${f}/>`,
    job: `<rect x="2" y="3" width="30" height="14" rx="4" ${f}/><circle cx="26" cy="8" r="3" fill="none" stroke="${c}" stroke-width="1.2"/>`,
    queue: `<rect x="2" y="3" width="30" height="14" rx="3" ${f}/><line x1="24" y1="6" x2="24" y2="14" stroke="${c}" stroke-width="1.4"/><line x1="28" y1="6" x2="28" y2="14" stroke="${c}" stroke-width="1.4"/>`,
    store: `<path d="M2,6 A15,4 0 0 1 32,6 V14 A15,4 0 0 1 2,14 Z" ${f}/><ellipse cx="17" cy="6" rx="15" ry="4" fill="${c}" fill-opacity=".22" stroke="${c}" stroke-width="1.4"/>`,
    external: `<rect x="2" y="3" width="30" height="14" rx="4" fill="none" stroke="${c}" stroke-width="1.4" stroke-dasharray="4 3"/>`,
    library: `<rect x="2" y="3" width="30" height="14" rx="2" ${f}/><path d="M26,3 V8 H32" fill="none" stroke="${c}" stroke-width="1.2"/>`,
  };
  return `<svg viewBox="0 0 34 20">${shapes[kind] ?? shapes.service}</svg>`;
}

export function renderHtml(model: Model, ctx: Context): string {
  const L = layout(model);
  const tierColor = new Map(L.bands.map((b) => [b.tier.id, b.color]));
  const tierLabel = new Map(model.tiers.map((t) => [t.id, t.label]));
  const comp = new Map(model.components.map((c) => [c.id, c]));
  const edgeIndex = new Map(L.edges.map((e) => [`${e.e.from}→${e.e.to}`, e.i]));

  const flowData = model.flows.map((f) => ({
    name: f.name, trigger: f.trigger, outcome: f.outcome,
    steps: f.steps.map((s) => ({ from: s.from, to: s.to, action: s.action, e: edgeIndex.get(`${s.from}→${s.to}`) })),
  }));
  const compData = Object.fromEntries(model.components.map((c) => [c.id, {
    name: c.name, role: c.role, tech: c.tech, files: c.files, breaksIf: c.breaksIf,
    kindLabel: KIND_LABEL[c.kind], tier: tierLabel.get(c.tier), color: tierColor.get(c.tier),
  }]));
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

  const stores = model.components.filter((c) => c.kind === "store").length;
  const externals = model.components.filter((c) => c.kind === "external").length;
  const highRisks = (model.risks ?? []).filter((r) => r.severity === "high").length;
  const stat = (v: number, k: string, alert = false) => `<div class="stat${alert && v > 0 ? " alert" : ""}"><div class="v">${v}</div><div class="k">${esc(k)}</div></div>`;

  const kindsPresent = [...new Set(model.components.map((c) => c.kind))];
  const legendKinds: Kind[] = (["client", "service", "job", "queue", "store", "external", "library"] as Kind[]).filter((k) =>
    kindsPresent.includes(k) || (k === "client" && kindsPresent.includes("ui")) || (k === "service" && kindsPresent.includes("worker")) || (k === "library" && kindsPresent.includes("config")));
  const legendName: Record<string, string> = { client: "Client / UI", service: "Service", job: "Scheduled job", queue: "Queue", store: "Data store", external: "External", library: "Library / config" };

  const metaChips = [
    `<span class="chip">generated <b>${esc(humanTime(ctx.generatedAt))}</b></span>`,
    ctx.commit ? `<span class="chip">commit <b>${esc(ctx.commit)}</b></span>` : `<span class="chip">not a git repo</span>`,
    ctx.dirty ? `<span class="chip warn">${ctx.dirty} uncommitted change${ctx.dirty > 1 ? "s" : ""} included</span>` : "",
    `<span class="chip">read <b>${model.sources.length}</b>${ctx.trackedFiles ? ` of ${ctx.trackedFiles}` : ""} files</span>`,
    `<span class="chip"><b>${esc(basename(ctx.root))}</b></span>`,
  ].join("");

  const links = (id: string) => {
    const out = model.edges.filter((e) => e.from === id).map((e) => `<li><span class="dir out">→</span><b>${esc(comp.get(e.to)!.name)}</b><span>${esc(e.label)}</span></li>`);
    const inn = model.edges.filter((e) => e.to === id).map((e) => `<li><span class="dir in">←</span><b>${esc(comp.get(e.from)!.name)}</b><span>${esc(e.label)}</span></li>`);
    return out.length || inn.length ? `<ul class="links">${[...inn, ...out].join("")}</ul>` : "";
  };
  // Columns chosen from the card count so no row is left half empty.
  const cols = (n: number) => (n <= 3 ? n : n === 4 ? 2 : n <= 6 ? 3 : 4);
  const tierSections = model.tiers.map((t) => {
    const members = model.components.filter((c) => c.tier === t.id);
    if (!members.length) return "";
    const color = tierColor.get(t.id)!;
    return `<div class="tierhead"><span class="dot" style="background:${color}"></span><h3>${esc(t.label)}</h3>${t.note ? `<span>${esc(t.note)}</span>` : ""}</div>
<div class="cards" style="--cols:${cols(members.length)}">${members.map((c) => `<article class="card${c.kind === "external" ? " ext" : ""}" id="c-${esc(c.id)}" style="--c:${color}">
<div class="kind"><span class="glyph">${legendSvg(c.kind === "ui" ? "client" : c.kind === "worker" ? "service" : c.kind === "config" ? "library" : c.kind)}</span>${esc(KIND_LABEL[c.kind])}</div><h4>${esc(c.name)}</h4>${c.tech ? `<div class="tech">${esc(c.tech)}</div>` : ""}
<p>${esc(c.role)}</p>${c.holds ? `<p class="holds"><b>Holds:</b> ${esc(c.holds)}</p>` : ""}${c.breaksIf ? `<p class="brk">If it breaks: ${esc(c.breaksIf)}</p>` : ""}
${links(c.id)}${c.files?.length ? `<div class="files">${c.files.map((f) => `<code>${esc(f)}</code>`).join("")}</div>` : ""}</article>`).join("\n")}</div>`;
  }).join("\n");

  const flowCards = model.flows.map((f, fi) => `<article class="flow${fi === 0 ? " main" : ""}">${fi === 0 ? `<div class="tag">Main path</div>` : ""}<h3>${esc(f.name)}</h3><div class="trig">${esc(f.trigger)}</div>
<ol class="steps">${f.steps.map((s, i) => `<li><span class="num">${i + 1}</span><span><span class="hop">${esc(comp.get(s.from)!.name)} → ${esc(comp.get(s.to)!.name)}</span>${esc(s.action)}</span></li>`).join("")}</ol>
<div class="outcome"><b>Result</b>${esc(f.outcome)}</div><button class="f" data-trace="${fi}">Trace on the diagram ↑</button></article>`).join("\n");

  const bounds = model.boundaries ?? [];
  const risks = [...(model.risks ?? [])].sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity]);
  const boundBox = bounds.length ? `<div class="box bounds">${bounds.map((b) => `<div class="item"><div class="t">${esc(b.name)}</div><div class="d">${esc(b.between)} — ${esc(b.guard)}</div><div class="ev"><code class="path">${esc(b.evidence)}</code></div></div>`).join("")}</div>` : "";
  const riskBox = risks.length ? `<div class="risks">${risks.map((r) => `<div class="risk ${r.severity}"><span class="sev ${r.severity}">${r.severity}</span><div><div class="t">${esc(r.title)}</div><div class="d">${esc(r.detail)}</div><div class="ev"><code class="path">${esc(r.evidence)}</code></div></div></div>`).join("")}</div>` : "";
  const readBox = model.readingOrder?.length ? `<div class="box"><h3>Where to start reading</h3><ol class="read">${model.readingOrder.map((r, i) => `<li><span class="idx">${i + 1}</span><span><code class="path">${esc(r.path)}</code><div class="d" style="margin-top:6px;color:var(--dim)">${esc(r.why)}</div></span></li>`).join("")}</ol></div>` : "";
  const glossBox = model.glossary?.length ? `<div class="box"><h3>Words used here</h3>${model.glossary.map((g) => `<div class="item"><div class="t">${esc(g.term)}</div><div class="d">${esc(g.meaning)}</div></div>`).join("")}</div>` : "";
  const pair = (a: string, b: string) => (a && b ? `<div class="two">${a}${b}</div>` : a || b ? `<div class="two solo">${a || b}</div>` : "");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(model.name)} — how it works</title>
<meta name="description" content="${esc(model.oneLiner)}">
<style>${CSS}</style></head>
<body>
<div class="wrap">
<header class="hero">
  <div class="eyebrow">System map</div>
  <h1>${esc(model.name)}</h1>
  <p class="one">${esc(model.oneLiner)}</p>
  <div class="meta">${metaChips}</div>
</header>

<section>
  <h2>The diagram</h2>
  <div class="frame">
    <div class="toolbar"><span class="lbl">Trace</span>
      <button class="f" data-f="-1" aria-pressed="false">All connections</button>
      ${model.flows.map((f, i) => `<button class="f" data-f="${i}" aria-pressed="false">${esc(f.name)}</button>`).join("\n      ")}
      <button class="play" type="button">▶ Play</button>
    </div>
    <div class="scroller">${renderSvg(model, L)}</div>
    <div class="legend">${legendKinds.map((k) => `<span>${legendSvg(k)}${esc(legendName[k])}</span>`).join("")}<span><svg viewBox="0 0 34 20"><line x1="2" y1="10" x2="32" y2="10" stroke="#8a9ab0" stroke-width="1.6" stroke-dasharray="5 4"/></svg>Async / scheduled</span></div>
    <div class="below">
      <div><h3>Flow, step by step</h3><div id="v-steps"></div></div>
      <div class="insp"><h3>Component <span style="text-transform:none;letter-spacing:0;font-weight:400">— hover or click a box</span></h3><div id="v-insp"></div></div>
    </div>
  </div>
</section>

<section>
  <h2>The short version</h2>
  <div class="short">
    <div class="prose">${model.summary.map((s) => `<p>${esc(s)}</p>`).join("")}</div>
    <div class="stats">${stat(model.components.length, "Parts")}${stat(model.edges.length, "Connections")}${stat(model.flows.length, "Flows")}${stat(stores, "Data stores")}${stat(externals, "Outside services")}${stat(highRisks, "High risks", true)}</div>
  </div>
</section>



<section>
  <h2>The parts</h2>
  ${tierSections}
</section>

${model.flows.length ? `<section><h2>How things move</h2><div class="flows">${flowCards}</div></section>` : ""}

${risks.length ? `<section><h2>What can go wrong</h2>${riskBox}</section>` : ""}

${bounds.length ? `<section><h2>Trust boundaries</h2>${pair(boundBox, "")}</section>` : ""}

${readBox || glossBox ? `<section><h2>Going deeper</h2>${pair(readBox, glossBox)}</section>` : ""}

${model.unknowns?.length ? `<section><div class="fog"><h3>What this map could not confirm</h3><ul>${model.unknowns.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></div></section>` : ""}

<footer>
  Built by Visualize from ${model.sources.length} source files in <code class="path">${esc(basename(ctx.root))}</code>.<br>
  Every part names the files it lives in, and every connection and risk names the file or line it was read from.
  <details><summary>Sources read</summary><div class="srcs">${model.sources.map((s) => `<code class="path">${esc(s)}</code>`).join("")}</div></details>
</footer>
</div>
<script type="application/json" id="v-flows">${json(flowData)}</script>
<script type="application/json" id="v-comps">${json(compData)}</script>
<script type="application/json" id="v-model">${json(model)}</script>
<script>${JS}</script>
</body></html>
`;
}

// ---------- write ----------

/** External-request shapes a self-contained page must never carry. */
export function externalRefs(html: string): string[] {
  const hits = html.match(/(?:src|href)\s*=\s*["'](?:https?:)?\/\/[^"']+|url\(\s*["']?(?:https?:)?\/\/[^)]+|@import\s/gi) ?? [];
  return hits;
}

export function writeHtml(html: string, outPath: string, outDir: string): void {
  const realDir = realpathSync(outDir);
  invariant(realpathSync(dirname(outPath)) === realDir, `refusing to write outside ${realDir}: ${outPath}`);
  invariant(/^Visualize-[a-z0-9-]+-\d{4}-\d{2}-\d{2}-\d{6}\.html$/.test(basename(outPath)), `unexpected output name ${basename(outPath)}`);
  invariant(!existsSync(outPath), `refusing to overwrite an existing map: ${outPath}`);
  invariant(externalRefs(html).length === 0, `page carries external references: ${externalRefs(html).join(", ")}`);
  writeFileSync(outPath, html, { flag: "wx" });
}

// ---------- CLI ----------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`Visualize — grounded system maps (ASCII + HTML)

Usage:
  bun Visualize.ts --model <model.json> --root <target dir> [flags]
  bun Visualize.ts --schema

Flags:
  --check          validate the model against the target; write nothing
  --no-html        print the console map only
  --out-dir <dir>  write the page here instead of the target directory
  --width <n>      console width (default 100)
  --schema         print the model shape with an example

Exit: 0 rendered · 1 model refused · 2 usage error`);
    return 0;
  }
  if (process.argv.includes("--schema")) {
    console.log(JSON.stringify(EXAMPLE, null, 2));
    console.log(`\nkinds: ${KINDS.join(", ")}\nsvg shapes: client/ui = pill · store = cylinder · external = dashed · queue = slats · job = clock · library/config = folded corner`);
    return 0;
  }
  const modelPath = arg("--model");
  const rootArg = arg("--root");
  if (!modelPath || !rootArg) {
    console.error("usage: bun Visualize.ts --model <model.json> --root <target dir> [--out-dir <dir>] [--width 100] [--no-html] [--check]\n       bun Visualize.ts --schema");
    return 2;
  }
  const root = resolve(rootArg);
  if (!existsSync(root) || !statSync(root).isDirectory()) { console.error(`root is not a directory: ${root}`); return 2; }
  let model: Model;
  try { model = JSON.parse(readFileSync(modelPath, "utf8")); }
  catch (e) { console.error(`cannot read model: ${(e as Error).message}`); return 2; }

  const { errors, warnings } = validate(model, root);
  for (const w of warnings) console.error(`warn: ${w}`);
  if (errors.length) {
    console.error(`\nmodel refused — ${errors.length} problem${errors.length > 1 ? "s" : ""}:`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    return 1;
  }
  if (process.argv.includes("--check")) { console.error("model ok"); return 0; }

  const outDir = resolve(arg("--out-dir") ?? root);
  const width = Number(arg("--width") ?? 100);
  const ctx = gatherContext(root, outDir, model.name);
  let outPath: string | undefined;
  if (!process.argv.includes("--no-html")) {
    outPath = outputPath(outDir, model.name, ctx.generatedAt);
    writeHtml(renderHtml(model, ctx), outPath, outDir);
  }
  console.log(renderAscii(model, ctx, outPath, width));
  return 0;
}

if (import.meta.main) process.exit(main());
