#!/usr/bin/env bun
/**
 * RunningScan — one look at everything running on this machine that has run for a while, who owns it,
 * and what looks wrong (running-work watch ISA, M3: ISC-17..17e). Read-only: it never kills, signals or
 * changes a process (A4). Pulse serves it at /api/vigil/running and shows it on /running.
 *
 *   bun LIFEOS/TOOLS/RunningScan.ts           human summary
 *   bun LIFEOS/TOOLS/RunningScan.ts --json    the full scan
 *
 * A TREE is a work-shaped process (SessionTree's WORK_SHAPES) at least 30 minutes old whose parent is not one,
 * with every descendant counted in. Its OWNER is the first match walking up from it: a launchd service (by
 * label), a session's claude (live), a session tag whose claude is gone (dead), a terminal, or nobody.
 * FINDINGS are what deserves a look: a scheduled launchd job still inside one run after three of its intervals
 * (launchd starts no new run meanwhile, so the job has stopped doing its work), an idle tree that is not a daemon
 * (an hour or more, under 0.01% of its wall time in CPU), an unowned tree, a dead session's tree, plus Vigil's own
 * verdicts (session stragglers, blind readers, overdue workflow runs). 2026-10-10, first live run: a short-interval
 * preview stage job had been stuck inside one run far past its interval, its `bunx cf` install hung. A KeepAlive daemon or an
 * app waiting for events is idle by design, so idle never counts against one.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isWorkShape, readProcs, type Proc } from "./SessionTree";

export const LONG_S = 30 * 60;
export const IDLE_MIN_S = 3600;
/** CPU seconds per wall second under which a tree that old is idle: 0.01%. A hung install sits far below it. */
export const IDLE_RATIO = 1e-4;

/** A launchd job: scheduled (StartInterval or calendar) with its interval in seconds, or a daemon/app (null). */
export interface Service { label: string; intervalS: number | null }
export type Owner = { kind: "service"; label: string; intervalS: number | null; main: boolean } | { kind: "session"; session: string | null } | { kind: "dead-session"; session: string } | { kind: "terminal"; tty: string } | { kind: "none" };
export type FindingKind = "overrun" | "idle" | "unowned" | "dead-session" | "straggler" | "blind-reader" | "workflow-overdue";
export interface Tree { pid: number; pids: number[]; command: string; ageS: number; cpuS: number; owner: Owner; idle: boolean }
export interface Finding { kind: FindingKind; title: string; detail: string; ageS: number | null; pid: number | null; owner: string; look: string }
export interface Verdicts { stragglers: { kind: string; label: string; ageS: number; session: string; pid: number | null }[]; blindReaders: { name: string; since: string; error: string | null }[]; overdueRuns: { run_id: string; workflow: string; started_at: string }[] }
export interface Scan { generated_at: string; procs: number; trees: Tree[]; findings: Finding[]; verdicts_at: string | null; scan_ms: number }

const exe = (command: string) => (command.split(/\s+/)[0] ?? "").split("/").pop() || "?";
/** The command as a person reads it: executable plus the first argument that names something, clipped. */
export const label = (command: string): string => {
  const words = command.split(/\s+/), first = exe(command), arg = words.slice(1).find((w) => w && !w.startsWith("-"));
  return (arg ? `${first} ${arg.split("/").slice(-2).join("/")}` : first).slice(0, 80);
};
export const ownerText = (o: Owner): string => o.kind === "service" ? `service ${o.label}` : o.kind === "session" ? `live session${o.session ? ` ${o.session.slice(0, 8)}` : ""}` : o.kind === "dead-session" ? `dead session ${o.session.slice(0, 8)}` : o.kind === "terminal" ? `terminal ${o.tty}` : "nobody";
export const age = (s: number): string => s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`;

/** Pure: the trees and findings from one process table, its CPU times, the launchd pid map and Vigil's verdicts. */
export function scan(input: { procs: Proc[]; cpu: Map<number, number>; services: Map<number, Service>; verdicts: Verdicts; verdictsAt?: string | null; now?: Date }): Scan {
  const started = performance.now(), now = input.now ?? new Date();
  const byPid = new Map(input.procs.map((p) => [p.pid, p]));
  const children = new Map<number, Proc[]>();
  for (const p of input.procs) { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid)!.push(p); }
  const descendants = (pid: number): Proc[] => { const out: Proc[] = [], stack = [...(children.get(pid) ?? [])]; while (stack.length) { const c = stack.pop()!; out.push(c); stack.push(...(children.get(c.pid) ?? [])); } return out; };
  const claudeLive = (pid: number | undefined) => pid !== undefined && byPid.has(pid);
  const long = (p: Proc) => p.ageS >= LONG_S && isWorkShape(p.command);

  const ownerOf = (p: Proc): Owner => {
    for (let q: Proc | undefined = p, hops = 0; q && hops < 64; q = byPid.get(q.ppid), hops++) {
      const svc = input.services.get(q.pid);
      if (svc) return { kind: "service", label: svc.label, intervalS: svc.intervalS, main: q === p };
      if (exe(q.command) === "claude" && q !== p) return { kind: "session", session: p.session ?? null };
      if (q.session) return claudeLive(q.claudePid) ? { kind: "session", session: q.session } : { kind: "dead-session", session: q.session };
      if (q.tty && q.tty !== "??") return { kind: "terminal", tty: q.tty };
      if (q.ppid <= 1) break;
    }
    return { kind: "none" };
  };

  const trees: Tree[] = [];
  for (const p of input.procs) {
    if (!long(p) || p.detachOk) continue;
    const parent = byPid.get(p.ppid);
    if (parent && long(parent)) continue; // counted inside its parent's tree
    const desc = descendants(p.pid), pids = [p.pid, ...desc.map((d) => d.pid)];
    const cpuS = pids.reduce((sum, pid) => sum + (input.cpu.get(pid) ?? 0), 0);
    trees.push({ pid: p.pid, pids, command: label(p.command), ageS: p.ageS, cpuS: Math.round(cpuS * 100) / 100, owner: ownerOf(p), idle: p.ageS >= IDLE_MIN_S && cpuS / p.ageS < IDLE_RATIO });
  }
  trees.sort((a, b) => b.ageS - a.ageS);

  const findings: Finding[] = [];
  const look = (t: Tree) => `ps -o pid,ppid,etime,time,command -p ${t.pids.slice(0, 12).join(",")}`;
  for (const t of trees) {
    const owner = ownerText(t.owner);
    const svc = t.owner.kind === "service" ? t.owner : null;
    if (svc?.intervalS && svc.main && t.ageS >= Math.max(3 * svc.intervalS, LONG_S)) findings.push({ kind: "overrun", title: `Scheduled job overran: ${svc.label} is ${age(t.ageS)} into a run it starts every ${age(svc.intervalS)}`, detail: `${svc.label} runs every ${age(svc.intervalS)}, but this run started ${age(t.ageS)} ago and has used ${t.cpuS}s of CPU. launchd starts no new run while it lasts, so the job has done nothing since.`, ageS: t.ageS, pid: t.pid, owner, look: look(t) });
    else if (t.idle && !(svc && !svc.intervalS)) findings.push({ kind: "idle", title: `Idle ${age(t.ageS)}: ${t.command}`, detail: `${t.pids.length} process${t.pids.length === 1 ? "" : "es"} owned by ${owner} have used ${t.cpuS}s of CPU in ${age(t.ageS)}, so it is probably stuck waiting on something that will not come.`, ageS: t.ageS, pid: t.pid, owner, look: look(t) });
    else if (t.owner.kind === "none") findings.push({ kind: "unowned", title: `Unowned ${age(t.ageS)}: ${t.command}`, detail: `No service, session or terminal owns this ${t.pids.length}-process tree, so nothing will ever stop it.`, ageS: t.ageS, pid: t.pid, owner, look: look(t) });
    else if (t.owner.kind === "dead-session") findings.push({ kind: "dead-session", title: `Left by a dead session: ${t.command}`, detail: `Session ${t.owner.session.slice(0, 8)} is gone and this has kept running for ${age(t.ageS)}.`, ageS: t.ageS, pid: t.pid, owner, look: look(t) });
  }
  for (const s of input.verdicts.stragglers) findings.push({ kind: "straggler", title: `${s.kind}: ${s.label}`, detail: `SessionTree flags this in session ${s.session.slice(0, 8) || "unknown"}.`, ageS: s.ageS, pid: s.pid, owner: s.session ? `session ${s.session.slice(0, 8)}` : "unknown", look: `bun LIFEOS/TOOLS/SessionTree.ts show --session ${s.session || "<id>"}` });
  for (const b of input.verdicts.blindReaders) findings.push({ kind: "blind-reader", title: `Vigil is blind to ${b.name}`, detail: `Every read has failed since ${b.since}. Last error: ${b.error ?? "unknown"}.`, ageS: Math.max(0, Math.round((now.getTime() - Date.parse(b.since)) / 1000)), pid: null, owner: "vigil", look: "Pulse /vigil recent pings" });
  for (const r of input.verdicts.overdueRuns) findings.push({ kind: "workflow-overdue", title: `Workflow run past its deadline: ${r.workflow}`, detail: `Run ${r.run_id} has no result in the run ledger.`, ageS: Math.max(0, Math.round((now.getTime() - Date.parse(r.started_at)) / 1000)), pid: null, owner: `workflow ${r.workflow}`, look: `bun LIFEOS/WORKFLOWS/workflow.ts runs --active` });
  findings.sort((a, b) => (b.ageS ?? 0) - (a.ageS ?? 0));
  return { generated_at: now.toISOString(), procs: input.procs.length, trees, findings, verdicts_at: input.verdictsAt ?? null, scan_ms: Math.round(performance.now() - started) };
}

/** ps TIME is [[dd-]hh:]mm:ss.cc. */
export function cpuSeconds(text: string): number {
  const [d, rest] = text.includes("-") ? text.split("-") as [string, string] : ["0", text];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(d) * 86400 + parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
}

function readCpu(): Map<number, number> {
  const r = spawnSync("ps", ["-axo", "pid=,time="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const out = new Map<number, number>();
  for (const line of (r.stdout ?? "").split("\n")) { const m = line.trim().match(/^(\d+)\s+(\S+)$/); if (m) out.set(Number(m[1]), cpuSeconds(m[2]!)); }
  return out;
}

/** Running launchd jobs by main pid. Only jobs whose main process is old enough to matter are asked for their schedule. */
function readServices(oldPids: Set<number>): Map<number, Service> {
  const r = spawnSync("launchctl", ["list"], { encoding: "utf8" });
  const out = new Map<number, Service>(), uid = process.getuid?.() ?? 501;
  for (const line of (r.stdout ?? "").split("\n").slice(1)) {
    const [pid, , lbl] = line.split("\t");
    if (!pid || !/^\d+$/.test(pid) || !lbl) continue;
    let intervalS: number | null = null;
    if (oldPids.has(Number(pid))) {
      const info = spawnSync("launchctl", ["print", `gui/${uid}/${lbl}`], { encoding: "utf8", timeout: 5_000 }).stdout ?? "";
      const m = info.match(/run interval = (\d+) seconds/);
      intervalS = m ? Number(m[1]) : /calendarinterval|StartCalendarInterval/i.test(info) ? 86400 : null;
    }
    out.set(Number(pid), { label: lbl, intervalS });
  }
  return out;
}

const vigilState = () => process.env.VIGIL_STATE_DIR || join(homedir(), ".local/state/lifeos/vigil");
const readJsonFile = <T>(path: string): T | null => { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : null; } catch { return null; } };

/** Vigil's verdicts as its last tick saved them: the running and readers cursors, plus Workflows' own overdue list. */
export async function readVerdicts(): Promise<{ verdicts: Verdicts; at: string | null }> {
  const running = readJsonFile<{ at: string; stragglers: Record<string, { kind: string; label: string; ageS: number; session: string; pid: number | null }> }>(join(vigilState(), "cursors", "running.json"));
  const readers = readJsonFile<{ readers: Record<string, { since: string | null; error: string | null; announced: boolean }> }>(join(vigilState(), "cursors", "readers.json"));
  let overdueRuns: Verdicts["overdueRuns"] = [];
  try { const { overdueRuns: read } = await import("../VIGIL/adapters/running"); overdueRuns = read(new Date()); } catch { /* the workflow leg degrades alone */ }
  return {
    at: running?.at ?? null,
    verdicts: {
      stragglers: Object.values(running?.stragglers ?? {}).filter((s) => s.kind !== "workflow-overdue"),
      blindReaders: Object.entries(readers?.readers ?? {}).filter(([, r]) => r.since && r.announced).map(([name, r]) => ({ name, since: r.since!, error: r.error })),
      overdueRuns: overdueRuns.map((r) => ({ run_id: r.run_id, workflow: r.workflow, started_at: r.started_at })),
    },
  };
}

export async function liveScan(): Promise<Scan> {
  const procs = readProcs(), { verdicts, at } = await readVerdicts();
  return scan({ procs, cpu: readCpu(), services: readServices(new Set(procs.filter((p) => p.ageS >= LONG_S).map((p) => p.pid))), verdicts, verdictsAt: at });
}

if (import.meta.main) {
  const s = await liveScan();
  if (process.argv.includes("--json")) console.log(JSON.stringify(s, null, 2));
  else {
    console.log(`${s.findings.length} finding${s.findings.length === 1 ? "" : "s"} · ${s.trees.length} long-running trees · ${s.procs} processes · ${s.scan_ms} ms`);
    for (const f of s.findings) console.log(`  ⚠ ${f.title}  (${f.owner})`);
  }
}
