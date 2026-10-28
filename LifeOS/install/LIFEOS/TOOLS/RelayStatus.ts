/**
 * RelayStatus — one read of Relay's health, shared by the texting skill's Status tool and the Pulse /relay card.
 *
 * Pure part: `computeRelayStatus()` turns the launchd row, the parsed bridge and guard logs, the
 * auth file and the bridge config into one report. I/O part: `readRelayStatus()` gathers those inputs
 * from `LIFEOS/USER/RELAY/state`. The report carries NO sender numbers, NO own-channel values and
 * NO hashes: senders are a count and a lock state, never digits.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { lifeosPath } from "./Paths.ts";
import { recordRows } from "../STATVS/lib/cloudRead.ts";

export const RELAY_LABEL = "com.lifeos.relay";
/** The placeholder number the guard suite writes; never counted as a real sender. */
const FIXTURE_SENDER = "+10000000000";
const DAY_MS = 86_400_000;

export type LogLine = Record<string, unknown>;
export interface AuthEntry { unlockedUntil?: string; challengePending?: unknown; confirmPending?: unknown }
export interface RelayInputs {
  service: { loaded: boolean; pid?: number };
  bridge: LogLine[];
  guard: LogLine[];
  auth: Record<string, AuthEntry>;
  config: { allowFrom?: unknown; countersignSha256?: unknown; countersignSalt?: unknown; approve?: { enabled?: unknown } } | null;
  modes: Array<{ f: string; mode: string }>;
  /** Relay F26: bun processes running the bridge; exactly one is healthy. Absent when not counted. */
  bridges?: number;
  /** Relay F21: the last day of `relay` rows from STATVS (text_in and outcome are the ones read here). */
  record?: Array<{ ts: string; data: Record<string, unknown> }>;
  /** Why the record half is partial or missing (the cloud unreachable, the read failed); absent when it read whole. */
  recordNote?: string;
  now?: number;
}
export interface RelayStatus {
  service: "up" | "down";
  pid?: number;
  started?: string;
  startedAgo: string;
  lastInboundAt?: string;
  lastReplyAt?: string;
  lastInbound: string;
  lastReply: string;
  unansweredInbound: number;
  senders: number;
  lockState: string[];
  configOk: boolean;
  countersignSalted: boolean;
  tapEnabled: boolean;
  deniesLast24h: number;
  deniesByKind: Record<string, number>;
  looseModes: string[];
  /** Relay F26: bridge processes running (undefined when not counted). */
  bridges?: number;
  /** Relay F26: the bridge's last self-check since its last start. "stale" means none for over two hours, so the bridge is hung. */
  selfCheck: "ok" | "failed" | "pending" | "stale";
  selfCheckAgo: string;
  selfCheckProblems: string[];
  /** Relay F26: what the outside watch fails on: down, unconfigured, other than one bridge, or a stale self-check. */
  healthy: boolean;
  /** Why the counts from the record are partial (STATVS migration ISA ISC-179); absent when the record read whole. */
  recordNote?: string;
}

/** The self-check runs 2 minutes after start, then hourly; two hours without one means the bridge stopped checking. */
export const SELF_CHECK_STALE_MS = 2 * 60 * 60_000;
const SELF_CHECK_FIRST_MS = 10 * 60_000;

export function ago(iso: string | undefined, now: number): string {
  if (!iso) return "never";
  const m = Math.round((now - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

export function computeRelayStatus(i: RelayInputs): RelayStatus {
  const now = i.now ?? Date.now();
  const last = (ev: string) => i.bridge.filter((j) => j.event === ev).slice(-1)[0]?.ts as string | undefined;
  const started = last("bridge_starting");
  const inbound = last("inbound");
  const replied = last("replied");
  const unanswered = unansweredFromRecord(i.record ?? [], now);
  const denies = i.guard.filter((j) => j.event === "deny" && now - new Date(String(j.ts)).getTime() < DAY_MS && j.sender !== FIXTURE_SENDER);
  const deniesByKind: Record<string, number> = {};
  for (const d of denies) deniesByKind[String(d.kind)] = (deniesByKind[String(d.kind)] ?? 0) + 1;
  const senders = Object.entries(i.auth).filter(([k]) => k !== FIXTURE_SENDER);
  const lockState = senders.map(([, v]) =>
    v.unlockedUntil && new Date(v.unlockedUntil).getTime() > now ? "unlocked" : v.challengePending ? "locked (hold open)" : v.confirmPending ? "unlocked (confirm open)" : "locked");
  const c = i.config;
  const sinceStart = i.bridge.filter((j) => !started || String(j.ts) >= started);
  const check = sinceStart.filter((j) => j.event === "health_ok" || j.event === "health_failed").slice(-1)[0];
  const checkAge = now - Date.parse(String(check?.ts ?? started ?? new Date(now).toISOString()));
  const selfCheck: RelayStatus["selfCheck"] = check && checkAge <= SELF_CHECK_STALE_MS ? (check.event === "health_ok" ? "ok" : "failed")
    : (check ? checkAge : now - Date.parse(started ?? new Date(now).toISOString())) > (check ? SELF_CHECK_STALE_MS : SELF_CHECK_FIRST_MS) ? "stale" : "pending";
  const configOk = !!c && Array.isArray(c.allowFrom) && c.allowFrom.length > 0 && !!c.countersignSha256;
  return {
    ...(i.recordNote ? { recordNote: i.recordNote } : {}),
    service: i.service.loaded ? "up" : "down",
    pid: i.service.pid,
    started,
    startedAgo: ago(started, now),
    lastInboundAt: inbound,
    lastReplyAt: replied,
    lastInbound: ago(inbound, now),
    lastReply: ago(replied, now),
    unansweredInbound: unanswered,
    senders: senders.length,
    lockState,
    configOk,
    countersignSalted: !!c?.countersignSalt,
    tapEnabled: !!c?.approve?.enabled,
    deniesLast24h: denies.length,
    deniesByKind,
    looseModes: i.modes.filter((m) => m.mode !== "600").map((m) => m.f),
    bridges: i.bridges,
    selfCheck,
    selfCheckAgo: ago(check?.ts as string | undefined, now),
    selfCheckProblems: check?.event === "health_failed" && Array.isArray(check.problems) ? check.problems.map(String) : [],
    healthy: i.service.loaded && configOk && (i.bridges === undefined || i.bridges === 1) && selfCheck !== "stale",
  };
}

/** Relay F21 (ISC-275): principal texts in the last day that ended badly, plus any with no outcome after an hour.
 *  The old count was every inbound minus every reply over the whole log, which only drifted upward. */
const BAD = new Set(["failed", "error", "unanswered"]);
const NO_OUTCOME_AFTER_MS = 65 * 60_000;
export function unansweredFromRecord(rows: Array<{ ts: string; data: Record<string, unknown> }>, now: number): number {
  const recent = rows.filter((r) => now - Date.parse(r.ts) < DAY_MS && r.data.role !== "contact" && r.data.role !== "other");
  const ended = new Set(rows.filter((r) => r.data.event === "outcome").map((r) => String(r.data.turn)));
  const bad = recent.filter((r) => r.data.event === "outcome" && r.data.role === "principal" && BAD.has(String(r.data.outcome))).length;
  const lost = recent.filter((r) => r.data.event === "text_in" && r.data.role === "principal" && !ended.has(String(r.data.turn)) && now - Date.parse(r.ts) > NO_OUTCOME_AFTER_MS).length;
  return bad + lost;
}

/** One line per log entry; unparseable lines are skipped, a missing file is empty. */
export function readJsonLines(path: string): LogLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as LogLine]; } catch { return []; } });
}

/** Bun processes running the bridge (Relay F25/F26); -1 when ps cannot be read. Reads args only: macOS truncates
 *  comm to 16 characters. A bridge is bun running index.ts; RelayHost's line starts elsewhere. */
export function countBridges(): number {
  try {
    const ps = execFileSync("ps", ["-axo", "args="], { encoding: "utf8" });
    return ps.split("\n").filter((l) => /^\S*\/bun\s+\S*\/RELAY\/bridge\/index\.ts\s*$/.test(l.trim())).length;
  } catch { return -1; }
}

export function relayStateDir(): string {
  return lifeosPath("USER", "RELAY", "state");
}

export function launchdRow(listing: string): { loaded: boolean; pid?: number } {
  const row = listing.split("\n").find((l) => l.endsWith(RELAY_LABEL));
  if (!row) return { loaded: false };
  const pid = Number(row.split(/\s+/)[0]);
  return { loaded: true, pid: Number.isFinite(pid) ? pid : undefined };
}

export async function readRelayStatus(state = relayStateDir(), now = Date.now()): Promise<RelayStatus> {
  const p = Bun.spawn(["launchctl", "list"], { stdout: "pipe", stderr: "pipe" });
  const service = launchdRow(await new Response(p.stdout).text());
  let auth: Record<string, AuthEntry> = {};
  try { auth = JSON.parse(readFileSync(join(state, "texting-auth.json"), "utf8")); } catch { /* absent */ }
  let config: RelayInputs["config"] = null;
  try { config = JSON.parse(readFileSync(join(state, "bridge-config.json"), "utf8")); } catch { /* absent */ }
  const modes = ["bridge-config.json", "texting-auth.json", "sessions.json", "guard.log", "bridge.log"]
    .filter((f) => existsSync(join(state, f)))
    .map((f) => ({ f, mode: (statSync(join(state, f)).mode & 0o777).toString(8) }));
  const { record, recordNote } = await readRelayRecord(now);
  return computeRelayStatus({ service, bridges: countBridges(), bridge: readJsonLines(join(state, "bridge.log")), guard: readJsonLines(join(state, "guard.log")), auth, config, modes, record, recordNote, now });
}

/** Two days of relay rows: the cloud record plus this machine's unshipped rows (STATVS migration ISA ISC-179), and why the read is partial when it is. */
export async function readRelayRecord(now = Date.now(), read = recordRows): Promise<Pick<RelayInputs, "record" | "recordNote">> {
  try {
    const r = await read({ streams: ["relay"], classes: ["personal"], fromDate: new Date(now - 2 * DAY_MS).toISOString().slice(0, 10) });
    const note = r.problems.find((p) => p.startsWith("cloud record unreachable"));
    return { record: r.rows.map((x) => ({ ts: x.ts, data: (x.data ?? {}) as Record<string, unknown> })), ...(note ? { recordNote: note } : {}) };
  } catch (e) {
    return { record: [], recordNote: `record unreadable: ${(e as Error).message.slice(0, 120)}` };
  }
}
