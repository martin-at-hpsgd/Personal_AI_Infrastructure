#!/usr/bin/env bun
/**
 * Checkup — gathers every signal about one app into one bundle, so a Checkup run
 * reads evidence instead of re-deriving it: the ISA against the current standard,
 * the code against the ISA, what production probes recorded, and what went wrong
 * recently (Vigil events, Errata complaints, Achilles findings). Read-only.
 *
 *   bun Checkup.ts <repo> [--isa <path>] [--since 14d] [--name <alias>]... [--json]
 *
 * Each source runs as its own child process with an argument array and a timeout.
 * A source that fails or is not installed is listed under `unavailable` with its
 * reason; it is never reported as clean.
 *
 * Exit codes: 0 gathered (findings or not), 2 bad input.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";

const ROOT = getClaudeDir();
const TOOLS = dirname(new URL(import.meta.url).pathname);

export interface RunResult { code: number; stdout: string; stderr: string }
export type Runner = (cmd: string[], cwd?: string) => RunResult;

export const spawnRunner: Runner = (cmd, cwd) => {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { code: p.exitCode ?? 124, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

/** `14d`, `36h`, `2w` → milliseconds. */
export function parseSince(s: string): number {
  const m = s.match(/^(\d+)([hdw])$/);
  if (!m) throw new Error(`--since takes <n>h, <n>d or <n>w, got '${s}'`);
  return Number(m[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "h" | "d" | "w"];
}

/** Frontmatter scalars the gatherer uses: slug, project, phase, progress, updated. */
export function frontmatter(isaText: string): Record<string, string> {
  const m = isaText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv && kv[2]) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

/** True when the text names the app as a whole word, or names its repo path. */
export function mentions(text: string, names: string[], repo: string): boolean {
  if (text.includes(repo)) return true;
  return names.some((n) => n.length >= 3 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
}

/** `N hard · M advisory` from ISAGate's last line. */
export function gateSummary(out: string): { hard: number; advisory: number } | null {
  const m = out.match(/(\d+)\s+hard\s+·\s+(\d+)\s+advisory/);
  return m ? { hard: Number(m[1]), advisory: Number(m[2]) } : null;
}

function json(r: RunResult): unknown {
  try { return JSON.parse(r.stdout); } catch { return undefined; }
}

export interface Bundle {
  repo: string;
  isa: string;
  names: string[];
  window: { since: string; from: string };
  isaMeta: Record<string, string>;
  standard: { bar?: unknown; writeProbes?: unknown; gate?: { hard: number; advisory: number; findings: string[] } };
  code: { head?: string; dirtyFiles?: number; commitsSince?: string[]; commitsSinceIsaEdit?: number; sync?: unknown };
  production: { monitor?: { app: string; status?: string; failing?: string[]; [k: string]: unknown } };
  signals: { vigil?: unknown[]; errata?: unknown[]; achilles?: string[] };
  unavailable: { source: string; reason: string }[];
}

export function gather(opts: { repo: string; isa: string; since: string; names: string[]; monitorState?: string }, run: Runner = spawnRunner, now = Date.now()): Bundle {
  const { repo, isa } = opts;
  const from = new Date(now - parseSince(opts.since)).toISOString();
  const meta = frontmatter(readFileSync(isa, "utf8"));
  const names = [...new Set([...opts.names, meta.slug, meta.project, basename(repo)].filter(Boolean).map((n) => n.toLowerCase()))];
  const b: Bundle = { repo, isa, names, window: { since: opts.since, from }, isaMeta: meta, standard: {}, code: {}, production: {}, signals: {}, unavailable: [] };
  const miss = (source: string, r: RunResult | string) =>
    b.unavailable.push({ source, reason: typeof r === "string" ? r : `exit ${r.code}: ${(r.stderr || r.stdout).trim().split("\n").slice(-1)[0] ?? ""}`.slice(0, 200) });

  // The ISA against the current standard. IsaCheck and Inventory exit 1 on findings, a result, not a failure.
  const bar = run(["bun", join(TOOLS, "IsaCheck.ts"), "bar", isa, "--json"]);
  bar.code <= 1 && json(bar) !== undefined ? (b.standard.bar = json(bar)) : miss("IsaCheck bar", bar);
  const wp = run(["bun", join(TOOLS, "IsaCheck.ts"), "write-probes", isa, "--json"]);
  wp.code <= 1 && json(wp) !== undefined ? (b.standard.writeProbes = json(wp)) : miss("IsaCheck write-probes", wp);
  const gate = run(["bun", join(ROOT, "LIFEOS/TOOLS/ISAGate.ts"), isa]);
  const gs = gateSummary(gate.stdout + gate.stderr);
  gs ? (b.standard.gate = { ...gs, findings: (gate.stdout + gate.stderr).split("\n").filter((l) => /HARD|ADVISORY/.test(l)).map((l) => l.trim()) }) : miss("ISAGate", gate);

  // The code against the ISA.
  const head = run(["git", "-C", repo, "rev-parse", "--short", "HEAD"]);
  if (head.code === 0) {
    b.code.head = head.stdout.trim();
    b.code.dirtyFiles = run(["git", "-C", repo, "status", "--porcelain"]).stdout.split("\n").filter(Boolean).length;
    b.code.commitsSince = run(["git", "-C", repo, "log", `--since=${from}`, "--format=%h %as %s"]).stdout.split("\n").filter(Boolean);
    const isaRel = isa.startsWith(repo + "/") ? isa.slice(repo.length + 1) : null;
    const lastIsa = isaRel ? run(["git", "-C", repo, "log", "-1", "--format=%H", "--", isaRel]).stdout.trim() : "";
    if (lastIsa) b.code.commitsSinceIsaEdit = Number(run(["git", "-C", repo, "rev-list", "--count", `${lastIsa}..HEAD`]).stdout.trim()) || 0;
  } else miss("git", head);
  const sync = run(["bun", join(TOOLS, "Inventory.ts"), "sync", repo, isa, "--json"]);
  sync.code <= 1 && json(sync) !== undefined ? (b.code.sync = json(sync)) : miss("Inventory sync", sync);

  // What the live monitor last saw: Bunker runs every adopted app's rows against production on a schedule.
  const state = opts.monitorState ?? join(ROOT, "LIFEOS/USER/PULSE/Bunker/monitor-state.json");
  try {
    const all = JSON.parse(readFileSync(state, "utf8")) as Record<string, Record<string, unknown>>;
    const app = Object.keys(all).find((k) => names.includes(k.toLowerCase()));
    app
      ? (b.production.monitor = { app, ...all[app] })
      : miss("Bunker monitor", `no monitored app named ${names.join(" or ")} (not adopted, or adopted under another name: pass --name)`);
  } catch (e) {
    miss("Bunker monitor", (e as Error).message.slice(0, 200));
  }

  // What went wrong recently.
  // Match on what a record says about itself, never on conversation context attached to it.
  const vigilText = (e: any) => [e.title, e.summary, e.ref, e.url, JSON.stringify(e.meta ?? {})].join(" ");
  // Some captures carry a "## Delivered conversation context" block inside the complaint and the request.
  const own = (t: unknown) => String(t ?? "").split("## Delivered conversation context")[0];
  const errataText = (e: any) => [own(e.complaint), own(e.context?.requested), e.context?.isa, e.context?.cwd].join(" ");
  const vigil = run(["bun", join(ROOT, "LIFEOS/VIGIL/Vigil.ts"), "list", "--limit", "2000", "--json"]);
  const ve = json(vigil);
  Array.isArray(ve)
    // An app that publishes news to Vigil (one app: 52 of 70 events, 2026-10-10) is reporting content, not its health.
    ? (b.signals.vigil = ve.filter((e: any) => String(e.ts) >= from && e.kind !== "news" && (names.includes(String(e.source).toLowerCase()) || mentions(vigilText(e), names, repo))))
    : miss("Vigil", vigil);
  const errata = run(["bun", join(ROOT, "LIFEOS/ERRATA/Errata.ts"), "list", "--since", from.slice(0, 10), "--json"]);
  const ee = json(errata);
  Array.isArray(ee) ? (b.signals.errata = ee.filter((e) => mentions(errataText(e), names, repo))) : miss("Errata", errata);
  const ach = run(["bun", join(ROOT, "LIFEOS/TOOLS/Achilles.ts"), "list"]);
  ach.code === 0
    ? (b.signals.achilles = ach.stdout.split("\n").filter((l) => /^ACH-/.test(l) && !/\b(remediated|false_positive|closed)\b/.test(l) && mentions(l, names, repo)))
    : miss("Achilles", ach);
  return b;
}

function count(x: unknown): number | string {
  return Array.isArray(x) ? x.length : x === undefined ? "n/a" : "present";
}

export function summary(b: Bundle): string {
  const sync = b.code.sync as { unreferenced?: unknown[]; missingProbeTargets?: unknown[] } | undefined;
  const lines = [
    `Checkup evidence — ${b.repo} (ISA ${b.isa})`,
    `names matched: ${b.names.join(", ")} · window: ${b.window.since} (from ${b.window.from.slice(0, 10)})`,
    `ISA: phase ${b.isaMeta.phase ?? "?"} · progress ${b.isaMeta.progress ?? "?"} · updated ${b.isaMeta.updated ?? "?"}`,
    `standard: bar findings ${count(b.standard.bar)} · production-write rows ${count(b.standard.writeProbes)} · ISAGate ${b.standard.gate ? `${b.standard.gate.hard} hard, ${b.standard.gate.advisory} advisory` : "n/a"}`,
    `code: HEAD ${b.code.head ?? "n/a"} · ${b.code.dirtyFiles ?? "n/a"} dirty · ${count(b.code.commitsSince)} commits in window · ${b.code.commitsSinceIsaEdit ?? "n/a"} commits since the ISA last changed`,
    `sync: ${count(sync?.unreferenced)} surfaces no criterion names · ${count(sync?.missingProbeTargets)} rows pointing at missing files`,
    `production: ${b.production.monitor ? `Bunker monitor ${b.production.monitor.status ?? "?"} · ${count(b.production.monitor.failing)} failing ISCs` : "n/a"}`,
    `signals: Vigil ${count(b.signals.vigil)} · Errata ${count(b.signals.errata)} · open Achilles ${count(b.signals.achilles)}`,
  ];
  if (b.unavailable.length) lines.push("unavailable (not clean):", ...b.unavailable.map((u) => `  - ${u.source}: ${u.reason}`));
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const names: string[] = [];
  args.forEach((a, i) => a === "--name" && args[i + 1] && names.push(args[i + 1]));
  const flagValues = new Set(["--isa", "--since", "--name"].flatMap((f) => args.flatMap((a, i) => (a === f ? [args[i + 1]] : []))));
  const repoArg = args.find((a) => !a.startsWith("--") && !flagValues.has(a));
  if (!repoArg || args.includes("--help")) {
    console.error("usage: bun Checkup.ts <repo> [--isa <path>] [--since 14d] [--name <alias>]... [--json]");
    process.exit(2);
  }
  const repo = resolve(repoArg);
  const isa = resolve(val("--isa") ?? join(repo, "ISA.md"));
  if (!existsSync(isa)) { console.error(`no ISA at ${isa}`); process.exit(2); }
  try {
    const b = gather({ repo, isa, since: val("--since") ?? "14d", names });
    console.log(args.includes("--json") ? JSON.stringify(b, null, 2) : summary(b));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
