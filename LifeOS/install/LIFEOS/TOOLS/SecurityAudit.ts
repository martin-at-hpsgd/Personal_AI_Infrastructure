#!/usr/bin/env bun
/**
 * SecurityAudit — the one front door for a full security audit.
 *
 *   bun SecurityAudit.ts run [--json]          run every finder in the manifest, write one report, emit Vigil events
 *   bun SecurityAudit.ts run --dry-run --json  print the finders a run would plan; runs and writes nothing
 *
 * The manifest (USER/SECURITY/AUDIT/finders.json) names one finder per Achilles source. A finder either runs
 * here (`mode: run`), runs on its own clock (`continuous`), runs by hand (`manual`), or is not built yet
 * (`unbuilt`); every mode but `run` is reported as skipped with its reason, so coverage is never overstated.
 *
 * The report (USER/SECURITY/AUDITS/<date>-<time>-<run>.md, private) opens on one exposure line, then open
 * findings per estate and life risk with the finder coverage behind each count, the finders, the unanswerable
 * security questions, overdue risk reviews, and the change since the last run. A JSON sidecar keeps the summary
 * the next run compares against.
 *
 * Reads the Achilles registry, the estate register and TELOS; never writes any of them (ISA ISC-40). Vigil events
 * carry counts and ids only, never a target or evidence (ISC-42).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry, type AchillesEntry } from "./Achilles";
import { readTelosRisks } from "./TelosRisks";
import { invariant } from "./Invariant";
import { getClaudeDir } from "./Paths";
import { emitVigilEvent, type VigilEvent } from "./lib/VigilOptional";

const CLAUDE = getClaudeDir();
const SECURITY = join(CLAUDE, "LIFEOS/USER/SECURITY");
export const MANIFEST = process.env.SECURITY_AUDIT_MANIFEST || join(SECURITY, "AUDIT/finders.json");
export const AUDITS_DIR = process.env.SECURITY_AUDITS_DIR || join(SECURITY, "AUDITS");
const MODES = ["run", "continuous", "manual", "unbuilt"] as const;
/** A finder may read, write the Achilles registry, or open a ticket or send a note to the principal. Never anything that changes a target. */
export const ALLOWED_EFFECTS = new Set(["read", "write", "ticket", "notify-principal"]);

export interface Finder { id: string; source: string; mode: (typeof MODES)[number]; run?: string[]; reason?: string; side_effects: string[]; timeout_s?: number }
export interface Manifest { finders: Finder[] }
export interface FinderResult { id: string; mode: Finder["mode"]; status: "ran" | "failed" | "skipped"; detail: string; ms: number }
export type Exec = (argv: string[], timeoutMs: number) => { code: number; out: string; err: string };
export interface EstateRow { id: string; title: string; status: string; telos_ref?: string; review_by?: string; detect_refs?: string[] }
export interface AuditSummary { run_id: string; at: string; open_critical: number; open_high: number; open_technical: number; coverage_pct: number; by_risk: Record<string, number>; ran: number; total: number }
export interface AuditInputs { entries: AchillesEntry[]; estate: EstateRow[]; life: Array<{ id: string; title: string }>; unanswerable: string[];
  /** Set when the standing-question check did not produce readable output: the unanswerable count is then unknown, never zero. */
  unanswerable_unavailable?: string;
  previous: AuditSummary | null }

export function loadManifest(path = MANIFEST): Manifest {
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  invariant(Array.isArray(m.finders) && m.finders.length > 0, `manifest at ${path} has no finders`);
  const ids = new Set<string>();
  for (const f of m.finders) {
    invariant(!!f.id && !ids.has(f.id), `manifest: finder id ${f.id} missing or repeated`);
    ids.add(f.id);
    invariant((MODES as readonly string[]).includes(f.mode), `manifest: ${f.id} mode must be one of ${MODES.join("|")}`);
    invariant(f.mode === "run" ? Array.isArray(f.run) && f.run.length > 0 : !!f.reason?.trim(), `manifest: ${f.id} needs ${f.mode === "run" ? "a run argv" : "a reason"}`);
    invariant(Array.isArray(f.side_effects) && f.side_effects.every((s) => ALLOWED_EFFECTS.has(s)), `manifest: ${f.id} side effects must be read, write or ticket — a finder never touches a target`);
  }
  return m;
}

export const planRun = (m: Manifest): string[] => m.finders.map((f) => f.id);

export function runFinders(m: Manifest, exec: Exec): FinderResult[] {
  return m.finders.map((f) => {
    if (f.mode !== "run") return { id: f.id, mode: f.mode, status: "skipped", detail: `${f.mode}: ${f.reason}`, ms: 0 };
    const t0 = Date.now();
    let r: { code: number; out: string; err: string };
    try { r = exec(f.run!, (f.timeout_s ?? 600) * 1000); } catch (err) { r = { code: 1, out: "", err: String(err) }; }
    const ms = Date.now() - t0;
    return r.code === 0
      ? { id: f.id, mode: f.mode, status: "ran", detail: "exit 0", ms }
      : { id: f.id, mode: f.mode, status: "failed", detail: `exit ${r.code}: ${(r.err || r.out).trim().split("\n").pop()?.slice(0, 160) ?? ""}`, ms };
  });
}

const isOpen = (e: AchillesEntry) => e.status === "open" || e.status === "in_progress";
const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export function reportPath(dir: string, now: Date, runId: string): string {
  return join(dir, `${stamp(now)}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}-${runId.slice(0, 8)}.md`);
}

/** Pure: the report and its summary from finder results and the stores as read. */
export function buildReport(i: AuditInputs & { results: FinderResult[]; now: Date; durationMin: number; runId: string }): { markdown: string; summary: AuditSummary } {
  const open = i.entries.filter((e) => isOpen(e) && e.category === "technical");
  const ran = new Set(i.results.filter((r) => r.status === "ran").map((r) => r.id));
  const manifestIds = new Set(i.results.map((r) => r.id));
  const life = new Map(i.life.map((l) => [l.id, l.title]));
  const estate = new Map(i.estate.map((r) => [r.id, r]));
  const coverage = (refs: string[] = []) => { const mine = refs.filter((x) => manifestIds.has(x)); return mine.length ? `${mine.filter((x) => ran.has(x)).length} of ${mine.length} finders ran` : "0 of 0 finders ran (none named)"; };

  const byEstate = new Map<string, AchillesEntry[]>();
  for (const e of open) byEstate.set(e.risk_ref ?? "", [...(byEstate.get(e.risk_ref ?? "") ?? []), e]);
  const by_risk: Record<string, number> = {};
  const rows: string[] = [];
  for (const [rid, es] of [...byEstate].sort((a, b) => b[1].length - a[1].length)) {
    const row = estate.get(rid);
    const lr = row?.telos_ref ?? "";
    if (rid) by_risk[lr || rid] = (by_risk[lr || rid] ?? 0) + es.length;
    const ch = es.filter((e) => e.severity === "critical" || e.severity === "high").length;
    const linked = `${es.filter((e) => e.risk_basis === "finder").length} by finder · ${es.filter((e) => e.risk_basis === "map").length} by map`;
    rows.push(rid
      ? `| ${rid} ${row?.title ?? "(not in the estate register)"} | ${lr ? `${lr} ${life.get(lr) ?? ""}`.trim() : "—"} | ${es.length} | ${ch} | ${linked} | ${coverage(row?.detect_refs)} |`
      : `| Unlinked | — | ${es.length} | ${ch} | — | — |`);
  }

  const ranN = ran.size, total = i.results.length;
  const summary: AuditSummary = {
    run_id: i.runId, at: i.now.toISOString(),
    open_critical: open.filter((e) => e.severity === "critical").length,
    open_high: open.filter((e) => e.severity === "high").length,
    open_technical: open.length,
    coverage_pct: total ? Math.round((100 * ranN) / total) : 0,
    by_risk, ran: ranN, total,
  };
  const p = i.previous;
  const direction = !p ? "first audit" : `${summary.open_technical > p.open_technical ? "up" : summary.open_technical < p.open_technical ? "down" : "flat"} since last audit`;
  const notRan = i.results.filter((r) => r.status !== "ran");
  const overdue = i.estate.filter((r) => r.status !== "closed" && r.review_by && Date.parse(r.review_by) < i.now.getTime());
  const lifeIds = [...new Set([...Object.keys(by_risk), ...Object.keys(p?.by_risk ?? {})])].sort();

  const markdown = [
    "---", `run_id: ${i.runId}`, `at: ${summary.at}`, `duration_min: ${i.durationMin}`, "---",
    `# Security audit — ${stamp(i.now)} ${pad(i.now.getUTCHours())}:${pad(i.now.getUTCMinutes())} UTC`, "",
    `Exposure: ${summary.open_critical} critical, ${summary.open_high} high technical findings open · coverage ${summary.coverage_pct}% · ${direction}`, "",
    `${summary.open_technical} open technical findings. Coverage is finders that ran this time over every finder in the manifest (${ranN} of ${total}).`, "",
    "## Open findings by risk", "",
    "| Estate risk | Life risk | Open | Critical/high | Linked | Coverage |", "|---|---|---|---|---|---|", ...rows, "",
    "## Finders", "", "| Finder | Mode | Status | Detail |", "|---|---|---|---|",
    ...i.results.map((r) => `| ${r.id} | ${r.mode} | ${r.status} | ${r.detail.replace(/\|/g, "\\|")} |`), "",
    "## Unanswerable questions", "", ...(i.unanswerable_unavailable
      ? [`Unavailable: the standing-question check did not produce readable output (${i.unanswerable_unavailable}). The unanswerable count is unknown, not zero.`]
      : i.unanswerable.length ? i.unanswerable.map((q) => `- ${q}`) : ["None: every security and ownership question has an answer."]), "",
    "## Overdue reviews", "", ...(overdue.length ? overdue.map((r) => `- ${r.id} ${r.title} (review by ${r.review_by})`) : ["None."]), "",
    "## Since last audit", "",
    ...(!p ? ["First audit: nothing to compare against."] : lifeIds.map((k) => { const a = p.by_risk[k] ?? 0, b = by_risk[k] ?? 0; return `- ${k}: ${a} → ${b}${b > a ? " (up)" : b < a ? " (down)" : ""}`; })),
    ...(notRan.length ? ["", `The comparison is incomplete: ${notRan.map((r) => `${r.id} ${r.status}`).join(", ")}. A finder that did not run can make a count fall without anything being fixed.`] : []),
    "",
  ].join("\n");
  return { markdown, summary };
}

/** One Vigil event per finder plus one summary. Counts and ids only (ISC-42); a new critical/high or a coverage drop is high (ISC-61). */
export function auditEvents(s: AuditSummary, results: FinderResult[], previous: AuditSummary | null, now: Date): VigilEvent[] {
  const base = { source: "security-audit", ts: now.toISOString(), kind: "security" as const, ref: s.run_id, url: null, privacy_class: "personal" as const };
  const finders: VigilEvent[] = results.map((r) => ({
    ...base, id: randomUUID(), severity: r.status === "failed" ? "medium" : "info",
    title: `Audit finder ${r.id}: ${r.status}`, summary: `${r.id} ${r.status} (${r.mode})`,
    dedup_key: `security-audit:${s.run_id}:${r.id}`, meta: { kind: "finder", finder: r.id, status: r.status, mode: r.mode },
  }));
  const worse = !!previous && (s.open_critical + s.open_high > previous.open_critical + previous.open_high || s.coverage_pct < previous.coverage_pct);
  const summary: VigilEvent = {
    ...base, id: randomUUID(), severity: worse ? "high" : "low",
    title: `Security audit: ${s.open_critical} critical, ${s.open_high} high technical findings open, coverage ${s.coverage_pct}%`,
    summary: `${s.open_technical} open technical findings; ${s.ran} of ${s.total} finders ran`,
    dedup_key: `security-audit:${s.run_id}:summary`,
    meta: { kind: "summary", open_critical: s.open_critical, open_high: s.open_high, open_technical: s.open_technical, coverage_pct: s.coverage_pct, ran: s.ran, total: s.total },
  };
  return [...finders, summary];
}

/** The stores, read only. The unanswerable list comes from the Socrates CLI unless a test supplies one. */
export function readInputs(o: { registryPath?: string; registerPath?: string; telosPath?: string; unanswerable?: () => string[] } = {}): AuditInputs {
  // The registry is read through Achilles, never by path (ISA ISC-1).
  const reg = loadRegistry(o.registryPath);
  const est = JSON.parse(readFileSync(o.registerPath ?? join(SECURITY, "THREATMODEL/risk-register.json"), "utf8")) as { risks: EstateRow[] };
  let life: AuditInputs["life"] = [];
  try {
    life = (readTelosRisks(o.telosPath).risks ?? []).map((r) => ({ id: r.id, title: r.title }));
  } catch { life = []; }
  let unanswerable: string[] = [];
  let unanswerable_unavailable: string | undefined;
  try {
    unanswerable = (o.unanswerable ?? socratesUnanswerable)();
  } catch (e) {
    unanswerable_unavailable = e instanceof Error ? e.message.slice(0, 160) : "unreadable";
  }
  return { entries: reg.entries, estate: est.risks, life, unanswerable, ...(unanswerable_unavailable ? { unanswerable_unavailable } : {}), previous: null };
}

/**
 * Parses `Socrates.ts list`: every row opens with its SOC id and a [domain/severity] tag. Throws when
 * the output holds no row, so a crashed or empty listing reads as unavailable, not as "all answered".
 */
export function parseSocratesList(stdout: string): string[] {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.some((l) => /^SOC-\d+ \[[a-z]+\/[a-z]+\]/.test(l))) throw new Error("the Socrates listing held no question rows");
  return lines.filter((l) => /\[(security|ownership)\/[a-z]+\] unanswerable/.test(l));
}

function socratesUnanswerable(): string[] {
  const p = spawnSync(process.execPath, [join(CLAUDE, "LIFEOS/SOCRATES/Socrates.ts"), "list"], { encoding: "utf8", cwd: CLAUDE, timeout: 120_000, killSignal: "SIGKILL" });
  if (p.error) throw new Error(`the Socrates listing could not run: ${p.error.message}`);
  if (p.status !== 0) throw new Error(`the Socrates listing exited ${p.status ?? "by signal"}`);
  return parseSocratesList(p.stdout ?? "");
}

/** The newest audit summary, or null before the first audit. */
export function latestAudit(dir: string = AUDITS_DIR): AuditSummary | null {
  if (!existsSync(dir)) return null;
  const last = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().pop();
  try { return last ? (JSON.parse(readFileSync(join(dir, last), "utf8")) as AuditSummary) : null; } catch { return null; }
}

/** The newest report: its path, markdown and Exposure line, read from the report itself so every surface shows the line the report opens with. */
export function latestReport(dir: string = AUDITS_DIR): { path: string; markdown: string; exposure_line: string | null } | null {
  if (!existsSync(dir)) return null;
  const last = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().pop();
  if (!last) return null;
  try {
    const markdown = readFileSync(join(dir, last), "utf8");
    return { path: join(dir, last), markdown, exposure_line: markdown.split("\n").find((l) => l.startsWith("Exposure: ")) ?? null };
  } catch { return null; }
}

const defaultExec: Exec = (argv, timeoutMs) => {
  // A manifest `bun` is the running bun: launchd PATHs often lack it.
  const bin = argv[0] === "bun" ? process.execPath : argv[0]!;
  const p = spawnSync(bin, argv.slice(1), { cwd: CLAUDE, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LIFEOS_NOTIFICATION_CHANNEL: "headless" } });
  return { code: p.status ?? 1, out: p.stdout ?? "", err: p.stderr ?? (p.error ? String(p.error) : "") };
};

const pendingDir = (outDir: string) => join(outDir, ".pending");
interface RunMarker { run_id: string; started_at: string }

/** Step 1 of a run: a fresh run id, and no result left over from an earlier run. */
export function startRun(outDir: string, now: Date): RunMarker {
  const dir = pendingDir(outDir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker: RunMarker = { run_id: randomUUID().replace(/-/g, "").slice(0, 12), started_at: now.toISOString() };
  invariant(/^[0-9a-f]{12}$/.test(marker.run_id), "run id is 12 hex characters");
  writeFileSync(join(dir, "run.json"), JSON.stringify(marker));
  return marker;
}

function readMarker(outDir: string): RunMarker {
  const p = join(pendingDir(outDir), "run.json");
  invariant(existsSync(p), "no audit run started: run `SecurityAudit.ts start` first");
  return JSON.parse(readFileSync(p, "utf8")) as RunMarker;
}

/** One finder step: run it and record the outcome. A finder that fails is a result, never a crash of the audit. */
export function recordFinder(outDir: string, manifest: Manifest, id: string, exec: Exec = defaultExec): FinderResult {
  const marker = readMarker(outDir);
  const f = manifest.finders.find((x) => x.id === id);
  invariant(!!f, `no finder "${id}" in the manifest`);
  const [result] = runFinders({ finders: [f!] }, exec);
  invariant(!!result && result.id === id, `finder ${id} produced its result`);
  writeFileSync(join(pendingDir(outDir), `${id}.json`), JSON.stringify({ run_id: marker.run_id, ...result }));
  return result!;
}

/** Last step: read every finder's result for this run, write the report, emit to Vigil. A finder with no result failed to report. */
export async function finishRun(o: { outDir?: string; manifest?: Manifest; inputs?: () => AuditInputs; emit?: (e: VigilEvent) => void; now?: () => Date } = {}): Promise<{ report: string; summary: AuditSummary; results: FinderResult[] }> {
  const outDir = o.outDir ?? AUDITS_DIR;
  const manifest = o.manifest ?? loadManifest();
  const marker = readMarker(outDir);
  const results: FinderResult[] = manifest.finders.map((f) => {
    const p = join(pendingDir(outDir), `${f.id}.json`);
    const r = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as FinderResult & { run_id: string }) : null;
    if (!r || r.run_id !== marker.run_id) return { id: f.id, mode: f.mode, status: "failed", detail: "the finder step did not report for this run", ms: 0 };
    const { run_id: _r, ...rest } = r;
    return rest;
  });
  // The stores are read after the finders ran, so the report reflects what they just filed.
  const inp = (o.inputs ?? (() => readInputs()))();
  const previous = inp.previous ?? latestAudit(outDir);
  const now = (o.now ?? (() => new Date()))();
  const durationMin = Math.round(((now.getTime() - Date.parse(marker.started_at)) / 60_000) * 10) / 10;
  const { markdown, summary } = buildReport({ ...inp, previous, results, now, durationMin, runId: marker.run_id });
  const report = reportPath(outDir, now, marker.run_id);
  invariant(!existsSync(report), `audit report ${report} already exists; a run never overwrites an earlier report`);
  writeFileSync(report, markdown, { mode: 0o600 });
  writeFileSync(report.replace(/\.md$/, ".json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  const emit = o.emit ?? ((e: VigilEvent) => {
    try { emitVigilEvent(e); } catch (err) { console.error(`[security-audit] vigil emit failed: ${String(err).slice(0, 160)}`); }
  });
  for (const e of auditEvents(summary, results, previous, now)) emit(e);
  rmSync(pendingDir(outDir), { recursive: true, force: true });
  return { report, summary, results };
}

/** The whole audit in one call: start, every finder in manifest order, report. The workflow runs the same three as separate steps. */
export async function runAudit(o: { manifest?: Manifest; exec?: Exec; outDir?: string; inputs?: () => AuditInputs; emit?: (e: VigilEvent) => void; now?: () => Date } = {}): Promise<{ report: string; summary: AuditSummary; results: FinderResult[] }> {
  const outDir = o.outDir ?? AUDITS_DIR;
  const manifest = o.manifest ?? loadManifest();
  startRun(outDir, (o.now ?? (() => new Date()))());
  for (const f of manifest.finders) recordFinder(outDir, manifest, f.id, o.exec ?? defaultExec);
  return finishRun({ ...o, outDir, manifest });
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const json = args.includes("--json");
  const print = (o: Record<string, unknown>, text: string) => console.log(json ? JSON.stringify(o) : text);
  const usage = "security-audit: run [--dry-run] [--json] | start | finder <id> | report   (all take --json)";
  switch (cmd) {
    case "run": {
      if (args.includes("--dry-run")) { const m = loadManifest(); print({ ok: true, planned: planRun(m), run_now: m.finders.filter((f) => f.mode === "run").map((f) => f.id) }, planRun(m).join("\n")); break; }
      const res = await runAudit();
      print({ ok: true, report: res.report, ...res.summary, finders: res.results.map((r) => ({ id: r.id, status: r.status })) }, `${res.report}\nExposure: ${res.summary.open_critical} critical, ${res.summary.open_high} high technical · coverage ${res.summary.coverage_pct}%`);
      break;
    }
    case "start": { const m = startRun(AUDITS_DIR, new Date()); print({ ok: true, ...m }, `audit ${m.run_id} started`); break; }
    case "finder": {
      const id = args.find((a) => !a.startsWith("--"));
      if (!id) { console.error(usage); process.exit(2); }
      const r = recordFinder(AUDITS_DIR, loadManifest(), id!);
      print({ ok: true, id: r.id, status: r.status }, `${r.id}: ${r.status} (${r.detail})`);
      break;
    }
    case "report": {
      const res = await finishRun();
      print({ ok: true, report: res.report, ...res.summary }, `${res.report}\nExposure: ${res.summary.open_critical} critical, ${res.summary.open_high} high technical · coverage ${res.summary.coverage_pct}%`);
      break;
    }
    default: console.log(usage); process.exit(cmd ? 2 : 0);
  }
}
