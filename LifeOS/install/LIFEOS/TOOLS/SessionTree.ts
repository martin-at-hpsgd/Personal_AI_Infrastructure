#!/usr/bin/env bun
/**
 * @version 2.0.1
 * SessionTree.ts — the stray-process reaper for a Claude session: which processes the session
 * started, which of them outlived their purpose, and which of those it kills.
 *
 *   bun LIFEOS/TOOLS/SessionTree.ts show [--session <id>] [--json]
 *   bun LIFEOS/TOOLS/SessionTree.ts reap [--session <id>] [--apply]
 *   bun LIFEOS/TOOLS/SessionTree.ts snapshot            # bridge: JSON on stdin, JSON line out, writes the state file
 *
 * WHY: Claude Code never reaps a background subagent's Bash after the turn, sets no time limit on
 * background commands in terminal sessions, and lets commands survive the session's process. Agent
 * and workflow display is native (/tasks, /workflows, the agent panel); nothing here draws agents
 * (2026-10-11: no LifeOS rules for behaviour Claude Code handles natively).
 *
 * SOURCES
 *   Agents     the plugin's `$.agent.list()` (id, status, stopMs), passed on stdin to `snapshot`. The feed's
 *              own status, never inferred here. Without the plugin there are no agents, so no agent-stopped.
 *   Processes  the process table. A process belongs to the session when it descends from the
 *              session's claude pid OR carries `CLAUDE_CODE_SESSION_ID=<id>` in its environment.
 *              The env tag survives re-parenting to launchd, which ancestry does not.
 *              GOTCHA (probed 2026-09-29): macOS hides the environment of platform binaries
 *              (`/bin/zsh`, `sleep`) from `ps -E`; bun, node and codex expose it. Ancestry covers
 *              the first class while the parent lives; the tag covers the second after it dies.
 *              GOTCHA: GUI apps launched from a session (a terminal, a dashboard, a device controller) carry the tag too,
 *              so a dead session's processes are reaped only when they match WORK_SHAPES.
 *   Agent      the plugin records which subagent ran each Bash command (never rewriting it: the
 *              command reaches every guard unchanged) and passes that record in; a Bash-tool
 *              wrapper whose command matches a record belongs to that agent.
 *              GOTCHA: macOS `ps` prints an embedded newline as the literal `\012`, so a
 *              multi-line command stays on one row; the key is the text before the first
 *              newline (or `\012`), which both sides share.
 *
 * STRAGGLERS (AUTO_REAP_KINDS are killed by the plugin; a hand-run `reap --apply` kills orphaned only)
 *   orphaned       a work-shaped session process launchd adopted (ppid 1), ≥30 min old     (reaped)
 *   agent-stopped  a work-shaped process started by an agent that stopped ≥5 min ago      (reaped)
 *   hung-hook      a hook process of this session running ≥10 min                          (flagged)
 *   over-deadline  a work-shaped process this live session's own shell started, no agent owner, ≥30 min (flagged)
 *                  (2026-10-09: a `bun test ./` hung 8h under a live shell and matched no kind)
 *   dead-session   a work-shaped process launchd adopted after its session died, ≥10 min
 *                  (reaped machine-wide by OrphanReaper on its launchd clock, never by a session)
 * Never selected: anything whose environment carries LIFEOS_DETACH_OK, anything of another live
 * session, and anything that is not work-shaped (WORK_SHAPES).
 * STARTED BY THE SESSION, not merely tagged with it (Fable F4, closed 2026-09-29): a terminal launched
 * from a session hands the tag to everything typed in it. Two proofs separate a leak from that:
 *   terminal identity  a process the session's Bash tool started carries the claude process's own
 *                      KITTY_PID / KITTY_WINDOW_ID / HERDR_PANE_ID / …; one typed in another terminal
 *                      carries that terminal's. The identity is read from the live claude process and
 *                      kept in the state file, so it is still there after the session dies.
 *   start time         a process that started after its session's last transcript write was not
 *                      started by that session. No transcript on disk means unknown, and unknown is
 *                      never selected.
 * WHY the gates (Fable audit F1, 2026-09-29): the session tag reaches everything launched from a
 * session — `open -a kitty`, the dashboard app, the Docker VM, LifeOS's own detached hook jobs —
 * so "tagged and adopted" proves launched-from, not leaked. The first version killed any of those
 * at 60 s and did kill an interceptor-daemon. A long-lived process a session starts on purpose
 * declares itself with LIFEOS_DETACH_OK=<reason> (ManageDevServer, Tome, Bunker's code sweep).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { CString, dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { invariant, InvariantViolation } from "./Invariant";
import { getClaudeDir, lifeosPath } from "./Paths";
import { parseEtime, reap as reapPids, type ProcRow } from "./OrphanReaper";

export const STATE_DIR = lifeosPath("MEMORY", "STATE", "session-tree");
export const REAP_LOG = lifeosPath("MEMORY", "OBSERVABILITY", "session-tree-reaps.jsonl");
/** The agent budget (AgentBudget BUDGET_MIN): a leaked work process older than any agent may run is a straggler. */
export const ORPHAN_MIN_S = 30 * 60;
/** An agent may hand a process to its caller; five minutes is the caller's window to take it over or stop it. */
export const AGENT_STOP_GRACE_MS = 5 * 60_000;
export const HUNG_HOOK_S = 600;
export const DEAD_SESSION_MIN_S = 600;

// ── Types ───────────────────────────────────────────────────────────────────

export type StragglerKind = "orphaned" | "agent-stopped" | "hung-hook" | "dead-session" | "over-deadline";

/** One agent as the plugin's feed lists it. Other fields the plugin sends are ignored. */
export interface AgentIn {
  id: string;
  /** The feed's own word: running | completed | failed | killed | … */
  status: string;
  /** When the plugin saw it leave `running` (ms). */
  stopMs?: number;
}

/** The terminal a process was started in, by the env vars terminals and multiplexers set for their children. */
export type TermId = Record<string, string>;
export const TERM_VARS = ["KITTY_PID", "KITTY_WINDOW_ID", "HERDR_PANE_ID", "TMUX_PANE", "TERM_SESSION_ID", "ITERM_SESSION_ID", "WINDOWID"] as const;

export interface Proc extends ProcRow {
  session?: string;
  claudePid?: number;
  detachOk: boolean;
  /** Present only when the environment is readable and carries at least one TERM_VARS entry. */
  term?: TermId;
}

/** True when `proc` names a terminal the session's claude did not run in: a var both carry with different values, or one only the process carries. */
export function otherTerminal(proc: TermId | undefined, sessionTerm: TermId | null | undefined): boolean {
  if (!proc || !sessionTerm) return false;
  for (const k of TERM_VARS) {
    const v = proc[k];
    if (v !== undefined && v !== sessionTerm[k]) return true;
  }
  return false;
}

export interface ProcNode { pid: number; label: string; ageS: number; descendants: number[]; agentId?: string; straggler?: StragglerKind }
export interface Straggler { kind: StragglerKind; pid?: number; pids?: number[]; agentId?: string; label: string; ageS: number; session?: string }

export interface Tree {
  session: string;
  ts: number;
  /** The session's claude process's terminal identity, kept in the state file for after it dies. */
  term?: TermId;
  /** Every work root and long-running hook of this session, each with the agent that started it when known. */
  procs: ProcNode[];
  stragglers: Straggler[];
}

// ── Process table ───────────────────────────────────────────────────────────

const WRAPPER = /^\/bin\/(?:zsh|bash|sh) -c source \S*shell-snapshots\//;
const EVAL_BODY = /eval '((?:[^']|'"'"'|'\\'')*)(?:'|$)/;
const HOOK = /\.hook\.ts\b/;

/**
 * Processes that do work, as opposed to apps a session happened to launch. Only these are ever
 * reaped as dead-session orphans: a terminal, a browser or a menu-bar app launched from a session carries its tag.
 */
export const WORK_SHAPES: readonly RegExp[] = [
  /^(?:\S*\/)?(?:bun|bunx|node|deno|tsx)\s/,
  /(?:^|\/)codex\s/,
  /(?:^|\/)(?:workerd|wrangler|vite|vitepress|esbuild|next|astro)\b/,
  /(?:^|\/)ffmpeg\s/,
  /--headless\b/,
];

export function isWorkShape(command: string): boolean {
  if (command.includes(".app/") || command.includes("/Library/Application Support/")) return false;
  return WORK_SHAPES.some((re) => re.test(command));
}

/** Every key envTags reads. The native reader skips the environment of a process that names none of them; keep the two in step. */
export const ENV_TAG_KEYS: readonly string[] = [...TERM_VARS, "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "LIFEOS_DETACH_OK"];

/** Tags from the environment portion of a `ps -E` line (everything after the plain command). */
export function envTags(envText: string): Pick<Proc, "session" | "claudePid" | "detachOk" | "term"> {
  const term: TermId = {};
  for (const k of TERM_VARS) { const v = new RegExp(`(?:^|\\s)${k}=(\\S+)`).exec(envText)?.[1]; if (v) term[k] = v; }
  const session = /(?:^|\s)CLAUDE_CODE_SESSION_ID=([0-9a-f-]{36})(?=\s|$)/.exec(envText)?.[1];
  const cp = /(?:^|\s)CLAUDE_PID=(\d+)(?=\s|$)/.exec(envText)?.[1];
  return { session, claudePid: cp ? Number(cp) : undefined, detachOk: /(?:^|\s)LIFEOS_DETACH_OK=/.test(envText), ...(Object.keys(term).length ? { term } : {}) };
}

/**
 * Join `ps -ww -Axo pid=,ppid=,tty=,etime=,command=` with `ps -ww -E -Axo pid=,command=`.
 * The env text is what follows the plain command on the -E line, so a command line that merely
 * mentions a tag is never read as carrying it.
 */
export function parseTables(plain: string, withEnv: string): Proc[] {
  const envByPid = new Map<number, string>();
  for (const line of withEnv.split("\n")) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m) envByPid.set(Number(m[1]), m[2]!);
  }
  const out: Proc[] = [];
  for (const line of plain.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[5]!.trim();
    const e = envByPid.get(pid) ?? "";
    const envText = e.startsWith(command) ? e.slice(command.length) : "";
    out.push({ pid, ppid: Number(m[2]), tty: m[3]!, ageS: parseEtime(m[4]!), command, ...envTags(envText) });
  }
  return out;
}

/**
 * The process table. On macOS it is read from the kernel directly (readProcsNative); anywhere that read is
 * unavailable it falls back to the two `ps` tables. Both give the same rows for the same machine state.
 * WHY (2026-10-09): the two `ps` spawns cost ~400 ms CPU per call (setuid `ps` gathers task info for every
 * process, and the `tty` column does a devname lookup per row), the largest single cost in the statusline.
 */
export function readProcs(): Proc[] {
  if (process.platform === "darwin") {
    try {
      const native = readProcsNative();
      if (native) return native;
    } catch (err) {
      // An impossible state stays loud; any other native failure falls back to ps (Astra review, 2026-10-09).
      if (err instanceof InvariantViolation) throw err;
      process.stderr.write(`SessionTree: native process read failed, using ps: ${String(err)}\n`);
    }
  }
  return readProcsPs();
}

export function readProcsPs(): Proc[] {
  const opts = { encoding: "utf8" as const, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
  const plain = execFileSync("ps", ["-ww", "-Axo", "pid=,ppid=,tty=,etime=,command="], opts);
  const env = execFileSync("ps", ["-ww", "-E", "-Axo", "pid=,command="], opts);
  return parseTables(plain, env);
}

// ── Native process table (macOS) ────────────────────────────────────────────
// A port of what `ps -ww -Axo pid=,ppid=,tty=,etime=,command=` and `ps -ww -E -Axo pid=,command=` print
// (adv_cmds ps: getproclline, get_etime, longtname, pscomp), fed to the same parseTables, so every quirk of
// the text path survives. Source: github.com/apple-oss-distributions/adv_cmds ps/print.c and ps/ps.c.
// ONE DEVIATION, by privilege: `ps` is setuid root, so it can read the arguments of processes whose
// effective uid is another user's (system daemons; a `sudo` child). Those read as `(comm)` here, which is
// what `ps` itself prints when the read fails. Such a process never carries a readable session tag, so
// session membership is unchanged. A process with the caller's real uid but another effective uid (a
// setuid tool the session ran) is read through `ps` for that pid alone, so it matches exactly.

/** struct kinfo_proc offsets from <sys/sysctl.h>; identical on arm64 and x86_64 (checked with offsetof, 2026-10-09). */
const KP = { size: 648, startSec: 0, stat: 36, pid: 40, comm: 243, commLen: 17, ruid: 392, euid: 420, ppid: 560, tdev: 572 } as const;
const CTL_KERN = 1, KERN_ARGMAX = 8, KERN_PROC = 14, KERN_PROC_ALL = 0, KERN_PROCARGS2 = 49;
const SZOMB = 5, NODEV = -1, S_IFCHR = 0o020000, LC_ALL_MASK = 0x3f, CODESET = 0;
/** ps: strvis(…, VIS_TAB | VIS_NL | VIS_NOSLASH). */
const PS_VIS_FLAGS = 0x0008 | 0x0010 | 0x0040;

/** The libc calls the reader makes. locale_t travels as i64: LC_GLOBAL_LOCALE is (locale_t)-1, which a pointer-typed double cannot carry. */
type Libc = {
  sysctl: (mib: Pointer, n: number, old: Pointer | null, oldlen: Pointer, nw: null, nwlen: bigint) => number;
  strnvis: (dst: Pointer, dlen: bigint, src: Pointer, flags: number) => number;
  devname: (dev: number, mode: number) => Pointer | null;
  getuid: () => number;
  newlocale: (mask: number, name: Pointer, base: bigint) => bigint;
  uselocale: (loc: bigint) => bigint;
  freelocale: (loc: bigint) => number;
  nl_langinfo_l: (item: number, loc: bigint) => Pointer | null;
};
let libcCache: Libc | null | undefined;

/** libSystem through bun:ffi, opened once per process; null where it cannot be opened (the caller falls back to `ps`). */
function loadLibc(): Libc | null {
  if (libcCache !== undefined) return libcCache;
  try {
    const P = FFIType.ptr;
    libcCache = dlopen("/usr/lib/libSystem.B.dylib", {
      sysctl: { args: [P, FFIType.u32, P, P, P, FFIType.u64], returns: FFIType.i32 },
      strnvis: { args: [P, FFIType.u64, P, FFIType.i32], returns: FFIType.i32 },
      devname: { args: [FFIType.i32, FFIType.u16], returns: P },
      getuid: { args: [], returns: FFIType.u32 },
      newlocale: { args: [FFIType.i32, P, FFIType.i64], returns: FFIType.i64 },
      uselocale: { args: [FFIType.i64], returns: FFIType.i64 },
      freelocale: { args: [FFIType.i64], returns: FFIType.i32 },
      nl_langinfo_l: { args: [FFIType.i32, FFIType.i64], returns: P },
    }).symbols as unknown as Libc;
  } catch {
    libcCache = null;
  }
  return libcCache;
}

/** ps get_etime: the ELAPSED text for `e` seconds, which parseEtime reads back to `e`. */
export function fmtEtime(e: number): string {
  const p2 = (n: number) => (n < 0 ? String(n) : String(n).padStart(2, "0"));
  const d = Math.trunc(e / 86400), h = Math.trunc(e / 3600) % 24, m = Math.trunc(e / 60) % 60, s = e % 60;
  if (e > 100 * 86400) return `${d}-${p2(h)}:${p2(m)}:${p2(s)}`;
  if (e > 86400) return `${p2(d)}-${p2(h)}:${p2(m)}:${p2(s)}`;
  if (e > 3600) return `${p2(Math.trunc(e / 3600))}:${p2(m)}:${p2(s)}`;
  return `${p2(Math.trunc(e / 60))}:${p2(s)}`;
}

/** ps pscomp with no sort flag: controlling terminal, then pid, as C `int` subtraction. */
export function psOrder(a: { tdev: number; pid: number }, b: { tdev: number; pid: number }): number {
  return ((a.tdev - b.tdev) | 0) || ((a.pid - b.pid) | 0);
}

/**
 * ps getproclline over a KERN_PROCARGS2 buffer, NULs turned to spaces in place exactly as ps does. Returns the
 * byte end (the terminating NUL) of the plain command and of the command with its environment, each null where
 * ps prints `(comm)`; both strings start at `start`. `onPlain` runs while the plain string is still NUL-terminated.
 */
export function procArgs(buf: Uint8Array, size: number, withEnv: boolean, onPlain?: (start: number, end: number) => void): { start: number; plainEnd: number | null; envEnd: number | null } {
  const none = { start: 0, plainEnd: null, envEnd: null };
  if (size < 4) return none;
  const view = buf.subarray(0, size);
  const nargs = new DataView(buf.buffer, buf.byteOffset, size).getInt32(0, true);
  // ps walks byte by byte; jumping NUL to NUL (indexOf) visits the same NULs in the same order.
  let cp = view.indexOf(0, 4); // the end of the saved exec_path
  if (cp === -1) return none;
  while (cp < size && buf[cp] === 0) cp++;
  if (cp === size) return none;
  const sp = cp;
  let np = -1;
  for (let c = 0; c < nargs && cp < size;) {
    const z = view.indexOf(0, cp);
    if (z === -1) { cp = size; break; }
    c++;
    if (np !== -1) buf[np] = 32;
    np = z;
    cp = z + 1;
  }
  const plainEnd = np === -1 || np === sp ? null : np;
  if (plainEnd !== null) onPlain?.(sp, plainEnd);
  if (!withEnv) return { start: sp, plainEnd, envEnd: plainEnd };
  while (cp < size) {
    const z = view.indexOf(0, cp);
    if (z === -1) break;
    if (np !== -1) { if (np + 1 === z) break; buf[np] = 32; }
    np = z;
    cp = z + 1;
  }
  return { start: sp, plainEnd, envEnd: np === -1 || np === sp ? null : np };
}

/** True when bytes [start, end) name a key envTags reads. Without one, the environment yields no tags at all. */
export function namesTagKey(buf: Uint8Array, start: number, end: number): boolean {
  const region = Buffer.from(buf.buffer, buf.byteOffset + start, Math.max(0, end - start));
  return ENV_TAG_KEYS.some((k) => region.indexOf(`${k}=`) !== -1);
}

interface KRow { pid: number; ppid: number; tdev: number; startSec: number; zombie: boolean; /** p_comm bytes, NUL excluded. */ comm: Uint8Array; ruid: number; euid: number }

/** Every process the kernel lists (KERN_PROC_ALL), or null when the read or the layout check fails. */
function kinfoAll(libc: Libc): KRow[] | null {
  const mib = new Int32Array([CTL_KERN, KERN_PROC, KERN_PROC_ALL]);
  const len = new BigUint64Array(1);
  // The table grows between the size query and the read; ps retries the same way.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (libc.sysctl(ptr(mib), 3, null, ptr(len), null, 0n) !== 0) return null;
    const buf = new Uint8Array(Number(len[0]) + 128 * KP.size);
    len[0] = BigInt(buf.length);
    if (libc.sysctl(ptr(mib), 3, ptr(buf), ptr(len), null, 0n) !== 0) continue;
    const bytes = Number(len[0]);
    if (bytes % KP.size !== 0) return null;
    const dv = new DataView(buf.buffer);
    const rows: KRow[] = [];
    for (let o = 0; o < bytes; o += KP.size) {
      const commBytes = buf.subarray(o + KP.comm, o + KP.comm + KP.commLen);
      const z = commBytes.indexOf(0);
      rows.push({
        pid: dv.getInt32(o + KP.pid, true), ppid: dv.getInt32(o + KP.ppid, true), tdev: dv.getInt32(o + KP.tdev, true),
        startSec: Number(dv.getBigInt64(o + KP.startSec, true)), zombie: buf[o + KP.stat] === SZOMB,
        comm: z < 0 ? commBytes : commBytes.subarray(0, z), ruid: dv.getUint32(o + KP.ruid, true), euid: dv.getUint32(o + KP.euid, true),
      });
    }
    // Layout check against this process's own row, field by field, else the offsets are wrong for this kernel
    // and the ps path is used. pid and ppid alone left stat, start time, uids and comm unchecked, and a wrong
    // stat or start time changes which processes look reapable (Astra review, 2026-10-09).
    const self = rows.find((r) => r.pid === process.pid);
    if (!self || self.ppid !== process.ppid || self.zombie) return null;
    if (self.ruid !== process.getuid!() || self.euid !== process.geteuid!()) return null;
    const startedSec = Date.now() / 1000 - process.uptime();
    if (Math.abs(self.startSec - startedSec) > 120) return null;
    const comm = new TextDecoder().decode(self.comm);
    const exe = process.execPath.split("/").pop() ?? "";
    if (!comm || !exe.startsWith(comm.slice(0, 15))) return null;
    // ps -A never lists pid 0 (kernel_task); a pid-0 row reaching a reaper would mean kill(0), the whole group.
    return rows.filter((r) => r.pid !== 0);
  }
  return null;
}

/** One pid's command (and command with environment) through `ps`, for the processes only setuid `ps` may read. Null when it has exited. */
function psOne(pid: number): { plain: string; env: string } | null {
  const run = (args: string[]) => {
    const r = spawnSync("ps", [...args, "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return /^\s*\d+\s(.*)$/.exec((r.stdout ?? "").replace(/\n$/, ""))?.[1] ?? null;
  };
  const plain = run(["-ww", "-o", "pid=,command="]);
  const env = plain === null ? null : run(["-ww", "-E", "-o", "pid=,command="]);
  return plain === null || env === null ? null : { plain, env };
}

/** True when the locale's printable ASCII bytes are always whole characters (UTF-8 and ASCII codesets). */
function segmentsAreSafe(libc: Libc, loc: bigint): boolean {
  const p = libc.nl_langinfo_l(CODESET, loc);
  const codeset = p ? new CString(p).toString() : "";
  return codeset === "UTF-8" || codeset === "US-ASCII";
}

/**
 * What ps prints for buf[start, end), buf[end] being a NUL: strvis(VIS_TAB | VIS_NL | VIS_NOSLASH) in the
 * thread's locale, decoded as UTF-8 the way the `ps` text path decodes its output.
 */
function visEncoder(libc: Libc, buf: Uint8Array, segmented: boolean): (start: number, end: number) => string {
  const vis = new Uint8Array(buf.length * 4 + 1);
  const dec = new TextDecoder();
  const strvis = (start: number, end: number): string => {
    const n = libc.strnvis(ptr(vis), BigInt((end - start) * 4 + 1), ptr(buf, start), PS_VIS_FLAGS);
    invariant(n >= 0, "strnvis output fits its 4n+1 buffer");
    return dec.decode(vis.subarray(0, n));
  };
  return (start, end) => {
    // strvis passes printable ASCII through unchanged in every locale (VIS_NOSLASH keeps `\`, no VIS_SP keeps
    // space), and nearly every argument and environment string is printable ASCII: those skip the C call.
    const raw = Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString("latin1");
    if (!/[^\x20-\x7e]/.test(raw)) return raw;
    if (!segmented) return strvis(start, end);
    // strvis encodes one character at a time, so where printable ASCII bytes are whole characters only the
    // runs between them need the C call: a 50 KB heredoc command with a few hundred newlines costs a few
    // hundred short calls instead of one long multibyte scan (~10 ms a scan, 2026-10-09).
    let out = "";
    let last = 0;
    for (const m of raw.matchAll(/[^\x20-\x7e]+/g)) {
      const s = start + m.index, e = s + m[0].length;
      const held = buf[e]!;
      buf[e] = 0;
      out += raw.slice(last, m.index) + strvis(s, e);
      buf[e] = held;
      last = m.index + m[0].length;
    }
    return out + raw.slice(last);
  };
}

/** What ps prints for `bytes`, in the environment's locale, encoded whole or run by run; null without libc. For the parity tests. */
export function psVis(bytes: Uint8Array, mode: "whole" | "segmented"): string | null {
  const libc = process.platform === "darwin" ? loadLibc() : null;
  if (!libc) return null;
  const buf = new Uint8Array(bytes.length + 1);
  buf.set(bytes);
  const loc = libc.newlocale(LC_ALL_MASK, ptr(new Uint8Array([0])), 0n) || libc.newlocale(LC_ALL_MASK, ptr(new TextEncoder().encode("C\0")), 0n);
  if (!loc) return null;
  const prev = libc.uselocale(loc);
  try {
    return visEncoder(libc, buf, mode === "segmented" && segmentsAreSafe(libc, loc))(0, bytes.length);
  } finally {
    libc.uselocale(prev);
    libc.freelocale(loc);
  }
}

/** The process table read from the kernel: the same rows readProcsPs parses, or null to fall back to it. */
export function readProcsNative(): Proc[] | null {
  const libc = loadLibc();
  if (!libc) return null;
  const rows = kinfoAll(libc);
  if (!rows) return null;
  rows.sort(psOrder);

  const am = new Int32Array([CTL_KERN, KERN_ARGMAX]);
  const argmaxOut = new Int32Array(1);
  const argmaxLen = new BigUint64Array([4n]);
  if (libc.sysctl(ptr(am), 2, ptr(argmaxOut), ptr(argmaxLen), null, 0n) !== 0 || argmaxOut[0]! <= 0) return null;
  const argmax = argmaxOut[0]!;
  const args = new Uint8Array(argmax);
  const pmib = new Int32Array([CTL_KERN, KERN_PROCARGS2, 0]);
  const plen = new BigUint64Array(1);
  const me = libc.getuid();
  const nowSec = Math.floor(Date.now() / 1000);
  const ttyByDev = new Map<number, string>();
  const tty = (dev: number): string => {
    if (dev === NODEV) return "??";
    let name = ttyByDev.get(dev);
    if (name === undefined) {
      // devname(3) scans /dev on every call (~0.6 ms each, the cost of ps's tty column). A pseudo-terminal
      // slave (major 16) is /dev/ttysNNN: confirm that node is this device and use its name; else ask devname.
      const cand = ((dev >>> 24) & 0xff) === 16 ? `ttys${String(dev & 0xffffff).padStart(3, "0")}` : null;
      let st: ReturnType<typeof statSync> | undefined;
      try { st = cand ? statSync(`/dev/${cand}`) : undefined; } catch { st = undefined; }
      if (cand && st?.isCharacterDevice() && st.rdev === dev) name = cand;
      else { const p = libc.devname(dev, S_IFCHR); name = p ? new CString(p).toString() : "??"; }
      ttyByDev.set(dev, name);
    }
    return name;
  };
  let visText: (start: number, end: number) => string = () => "";
  /** ps's fallback text `(p_comm)`, which also passes through strvis. */
  const commText = (comm: Uint8Array): string => {
    args[0] = 0x28; args.set(comm, 1); args[comm.length + 1] = 0x29; args[comm.length + 2] = 0;
    return visText(0, comm.length + 2);
  };

  // ps runs setlocale(LC_ALL, ""), and strvis keeps or escapes multibyte text by that locale. The same
  // locale is set on this thread only, and restored after. If the environment names no valid locale, ps
  // stays in "C", and so does this.
  const loc = libc.newlocale(LC_ALL_MASK, ptr(new Uint8Array([0])), 0n) || libc.newlocale(LC_ALL_MASK, ptr(new TextEncoder().encode("C\0")), 0n);
  if (!loc) return null;
  const plainLines: string[] = [];
  const envLines: string[] = [];
  const prev = libc.uselocale(loc);
  try {
    visText = visEncoder(libc, args, segmentsAreSafe(libc, loc));
    for (const r of rows) {
      let plain = "";
      let env = "";
      if (r.zombie) {
        plain = env = "<defunct>";
      } else {
        pmib[2] = r.pid;
        plen[0] = BigInt(argmax);
        if (libc.sysctl(ptr(pmib), 3, ptr(args), ptr(plen), null, 0n) === 0) {
          // ps -E adds the environment only for the caller's own processes (by real uid), or for root.
          let plainText: string | null = null;
          const res = procArgs(args, Number(plen[0]), me === 0 || r.ruid === me, (s, e) => { plainText = visText(s, e); });
          // Most environments name no tag key; their -E line then reads as the plain one, which yields the same
          // (empty) tags in parseTables and skips encoding and parsing kilobytes per process. Read from `args`
          // before commText reuses that buffer.
          const tagged = res.envEnd !== null && res.envEnd !== res.plainEnd && namesTagKey(args, res.plainEnd ?? res.start, res.envEnd);
          const envText = tagged ? visText(res.start, res.envEnd!) : null;
          plain = plainText ?? commText(r.comm);
          env = res.envEnd === null ? commText(r.comm) : (envText ?? plain);
        } else if (r.ruid === me && r.euid !== me) {
          const viaPs = psOne(r.pid);
          if (!viaPs) continue; // exited between the two reads: absent, as from a later `ps`
          plain = viaPs.plain;
          env = viaPs.env;
        } else {
          plain = env = commText(r.comm);
        }
      }
      plainLines.push(`${r.pid} ${r.ppid} ${tty(r.tdev)} ${fmtEtime(nowSec - r.startSec)} ${plain}`);
      envLines.push(`${r.pid} ${env}`);
    }
  } finally {
    libc.uselocale(prev);
    libc.freelocale(loc);
  }
  return parseTables(plainLines.join("\n"), envLines.join("\n"));
}

/** The command a Bash-tool wrapper runs. */
export function wrapperBody(command: string): { body: string } | null {
  if (!WRAPPER.test(command)) return null;
  const raw = EVAL_BODY.exec(command)?.[1]?.replace(/'"'"'|'\\''/g, "'") ?? "";
  return { body: raw.trim() };
}

/** The attribution key for a command: its first line, whitespace folded, capped. `ps` shows no more than that. */
export function commandKey(command: string): string {
  return (command.split(/\n|\\012/)[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** A short human label for a process: the wrapped command, else argv0's basename and first args. */
export function procLabel(command: string): string {
  const w = wrapperBody(command);
  let text = w ? w.body : command;
  // Leading env assignments and `cd <dir> &&` say nothing about the work; the label starts at the command.
  text = text.replace(/^(?:(?:[A-Z_][A-Z0-9_]*=\S*\s+)|(?:cd\s+\S+\s*&&\s*))+/, "");
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "shell";
  parts[0] = parts[0]!.split("/").pop()!;
  // Absolute paths shrink to their last segment; relative ones (./LIFEOS/PEOPLE) say where and stay.
  const shown = parts.slice(0, 4).map((p) => (/^(?:\/|~\/)/.test(p) ? p.split("/").pop()! : p));
  return shown.join(" ");
}

// ── Build ───────────────────────────────────────────────────────────────────

export interface BuildInput {
  session: string;
  claudePid: number | null;
  agents: AgentIn[];
  procs: Proc[];
  now: number;
  /** Pids to leave out: the scan itself and its ancestry. */
  exclude?: ReadonlySet<number>;
  /** What is known about a session that is not this one: its terminal identity and last transcript write. Injected in tests. */
  sessionInfo?: (session: string) => SessionInfo;
  /** Bash commands run inside subagent loops (from the plugin), for attribution. */
  commands?: ReadonlyArray<{ agentId: string; command: string }>;
}

export interface SessionInfo { term: TermId | null; lastWriteMs: number | null }
/** Slack between a transcript's last write and a process the session started right after it. */
export const START_SLACK_MS = 120_000;

export function buildTree(input: BuildInput): Tree {
  const { session, claudePid, agents: fed, procs, now } = input;
  const exclude = input.exclude ?? new Set<number>();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map<number, Proc[]>();
  for (const p of procs) { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid)!.push(p); }
  const livePids = new Set(procs.map((p) => p.pid));

  const descendantsOf = (pid: number): Proc[] => {
    const out: Proc[] = [];
    const stack = [...(children.get(pid) ?? [])];
    while (stack.length) { const c = stack.pop()!; if (exclude.has(c.pid)) continue; out.push(c); stack.push(...(children.get(c.pid) ?? [])); }
    return out;
  };

  // Work roots of this session: Bash-tool wrappers under the claude pid, and tagged processes
  // whose parent is gone (re-parented to launchd). Hooks under the claude pid are kept apart.
  const roots: Proc[] = [];
  const hooks: Proc[] = [];
  if (claudePid) for (const c of children.get(claudePid) ?? []) {
    if (exclude.has(c.pid)) continue;
    if (WRAPPER.test(c.command)) roots.push(c);
    else if (HOOK.test(c.command)) hooks.push(c);
  }
  const claimed = new Set<number>();
  for (const r of roots) { claimed.add(r.pid); for (const d of descendantsOf(r.pid)) claimed.add(d.pid); }
  // A pid some live process names as its claude is a live session's own claude: never reaped with another session's tree.
  const liveClaudePids = new Set<number>();
  for (const x of procs) if (x.claudePid && livePids.has(x.claudePid)) liveClaudePids.add(x.claudePid);
  /** Whether `x`, found under one of this session's roots, is another session's: tagged to it, its live claude, or that claude's work. */
  const otherSession = (x: Proc): boolean =>
    (!!x.session && x.session !== session) || (x.pid !== claudePid && liveClaudePids.has(x.pid))
    || (!!x.claudePid && x.claudePid !== claudePid && livePids.has(x.claudePid));
  // A tagged process outside those trees is work only once its parent is gone (launchd adopted it,
  // directly or through a bare shell). One under a live parent belongs to that parent: the scan's
  // own pipeline, or an app launched from the session that runs its own children (a device controller and its node plugins).
  for (const p of procs) {
    if (p.session !== session || claimed.has(p.pid) || exclude.has(p.pid) || p.pid === claudePid) continue;
    const top = adoptedRoot(p, byPid);
    if (!top || claimed.has(top.pid) || exclude.has(top.pid)) continue;
    // The adopted root is often a bare shell shared with other work: another session's shell is that session's to judge,
    // since the root always enters the kill list (the dead-session pass refuses a protected root the same way).
    if (top.pid !== p.pid && otherSession(top)) continue;
    roots.push(top); claimed.add(top.pid);
    for (const d of descendantsOf(top.pid)) claimed.add(d.pid);
  }

  const sessionTerm = (claudePid ? byPid.get(claudePid)?.term : undefined) ?? null;
  const agentById = new Map(fed.map((a) => [a.id, a]));
  const ranBy = new Map<string, string>();
  for (const c of input.commands ?? []) {
    const key = commandKey(c.command);
    const held = ranBy.get(key);
    if (held && agentById.get(held)?.status === "running" && agentById.get(c.agentId)?.status !== "running") continue;
    ranBy.set(key, c.agentId);
  }
  const stragglers: Straggler[] = [];
  const procNodes: ProcNode[] = [];
  for (const r of roots) {
    const desc = descendantsOf(r.pid);
    // Another session's process under this root, and everything under it, is that session's to judge: out of the kill list.
    const theirs = new Set<number>();
    for (const d of desc) {
      if (theirs.has(d.pid) || !otherSession(d)) continue;
      theirs.add(d.pid);
      for (const under of descendantsOf(d.pid)) theirs.add(under.pid);
    }
    const own = desc.filter((d) => !theirs.has(d.pid));
    const chain = [r, ...desc];
    const w = wrapperBody(r.command);
    const agentId = w ? ranBy.get(commandKey(w.body)) : undefined;
    const detachOk = chain.some((p) => p.detachOk);
    // The label names the work, not the wrapper: the wrapped command, or the one child a bare wrapper holds.
    const node: ProcNode = { pid: r.pid, label: procLabel(r.command), ageS: r.ageS, descendants: desc.map((d) => d.pid), agentId };
    const owner = agentId ? agentById.get(agentId) : undefined;
    const workShaped = [r, ...own].some((p) => isWorkShape(wrapperBody(p.command)?.body ?? p.command));
    const startedMs = now - r.ageS * 1000;
    // Typed in a terminal the session did not run in: tagged with it, never started by it.
    const foreign = chain.some((p) => otherTerminal(p.term, sessionTerm));
    if (!detachOk && workShaped && !foreign) {
      if (r.ppid === 1 && r.ageS >= ORPHAN_MIN_S) node.straggler = "orphaned";
      else if (!agentId && r.ppid === claudePid && r.ageS >= ORPHAN_MIN_S) node.straggler = "over-deadline";
      else if (owner && owner.status !== "running" && owner.stopMs !== undefined && now - owner.stopMs >= AGENT_STOP_GRACE_MS && startedMs <= owner.stopMs) node.straggler = "agent-stopped";
    }
    if (node.straggler) stragglers.push({ kind: node.straggler, pid: r.pid, pids: [r.pid, ...own.map((d) => d.pid)], agentId, label: node.label, ageS: r.ageS, session });
    procNodes.push(node);
  }
  for (const h of hooks) {
    if (h.ageS < HUNG_HOOK_S) continue;
    const desc = descendantsOf(h.pid);
    const label = procLabel(h.command);
    stragglers.push({ kind: "hung-hook", pid: h.pid, pids: [h.pid, ...desc.map((d) => d.pid)], label, ageS: h.ageS, session });
    procNodes.push({ pid: h.pid, label, ageS: h.ageS, descendants: desc.map((d) => d.pid), straggler: "hung-hook" });
  }

  // Dead sessions, machine-wide: work-shaped processes launchd adopted after their claude pid died.
  /**
   * Whether `x` may not be reaped as part of dead session `owner`'s tree: it opted out (LIFEOS_DETACH_OK),
   * it belongs to a live session (this one, or one whose claude is running), or it is tagged to another
   * session and so is that session's to judge. Untagged shells and wrappers carry no ownership.
   */
  const protectedFrom = (x: Proc, owner: string): boolean =>
    x.detachOk || x.session === session || liveClaudePids.has(x.pid)
    || (!!x.claudePid && livePids.has(x.claudePid))
    || (!!x.session && x.session !== owner);
  const deadRoots = new Set<string>();
  for (const p of procs) {
    if (!p.session || p.session === session || p.detachOk || !p.claudePid || livePids.has(p.claudePid)) continue;
    if (p.tty !== "??" || p.ageS < DEAD_SESSION_MIN_S || !isWorkShape(p.command)) continue;
    const top = adoptedRoot(p, byPid);
    if (!top || deadRoots.has(`${top.pid}:${p.session}`)) continue;
    // The adopted root is often a bare shell shared with other work: it must itself be reapable for this session.
    if (top.pid !== p.pid && protectedFrom(top, p.session)) continue;
    const info = (input.sessionInfo ?? sessionInfoFromDisk)(p.session);
    // Started by that session: before its last transcript write, and in its own terminal. Unknown is never selected.
    if (info.lastWriteMs === null || now - top.ageS * 1000 > info.lastWriteMs + START_SLACK_MS) continue;
    if (otherTerminal(p.term, info.term)) continue;
    // Every descendant is checked, not only the candidate: a protected one and everything under it stays out of the kill list.
    const kept = new Set<number>();
    for (const d of descendantsOf(top.pid)) {
      if (kept.has(d.pid) || !protectedFrom(d, p.session)) continue;
      kept.add(d.pid);
      for (const under of descendantsOf(d.pid)) kept.add(under.pid);
    }
    const desc = descendantsOf(top.pid).filter((d) => !kept.has(d.pid));
    if (kept.has(p.pid)) continue; // the candidate itself sits under a protected process
    deadRoots.add(`${top.pid}:${p.session}`);
    stragglers.push({ kind: "dead-session", pid: top.pid, pids: [top.pid, ...desc.map((d) => d.pid)], label: procLabel(p.command), ageS: top.ageS, session: p.session });
  }

  return { session, ts: now, ...(sessionTerm ? { term: sessionTerm } : {}), procs: procNodes, stragglers };
}

const BARE_SHELL = /^(?:\/bin\/)?(?:zsh|bash|sh)(?:\s|$)|^\(?(?:zsh|bash|sh)\)?$/;

/**
 * The root launchd adopted for `p`: `p` itself when its ppid is 1, or the topmost bare shell
 * above it when that shell has ppid 1. Null when a live non-shell parent holds it.
 */
export function adoptedRoot(p: Proc, byPid: Map<number, Proc>): Proc | null {
  let cur = p;
  for (let hops = 0; hops < 32; hops++) {
    if (cur.ppid === 1) return cur;
    const parent = byPid.get(cur.ppid);
    if (!parent) return cur; // parent exited between the two ps reads
    if (!BARE_SHELL.test(parent.command) && !WRAPPER.test(parent.command)) return null;
    cur = parent;
  }
  return null;
}

/** An age in seconds as `42s`, `7m` or `1h06`. */
export function fmtAge(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

// ── State file, reaping, CLI ────────────────────────────────────────────────

/** A session's terminal identity (from its last state file) and last transcript write (main loop and subagents). */
export function sessionInfoFromDisk(session: string, projects = join(getClaudeDir(), "projects")): SessionInfo {
  const id = session.replace(/[^A-Za-z0-9_-]/g, "");
  let term: TermId | null = null;
  try {
    const t = JSON.parse(readFileSync(statePath(id), "utf-8")) as { term?: unknown };
    if (t.term && typeof t.term === "object") term = Object.fromEntries(Object.entries(t.term as Record<string, unknown>).filter(([k, v]) => (TERM_VARS as readonly string[]).includes(k) && typeof v === "string")) as TermId;
  } catch { /* no state file: a session from before the tree, or a headless one */ }
  let lastWriteMs: number | null = null;
  const seen = (path: string) => { try { const m = statSync(path).mtimeMs; if (lastWriteMs === null || m > lastWriteMs) lastWriteMs = m; } catch { /* absent */ } };
  if (id && existsSync(projects)) for (const project of readdirSync(projects)) {
    seen(join(projects, project, `${id}.jsonl`));
    const sub = join(projects, project, id, "subagents");
    if (existsSync(sub)) for (const f of readdirSync(sub)) if (f.endsWith(".jsonl")) seen(join(sub, f));
  }
  return { term, lastWriteMs };
}

export function statePath(session: string): string {
  return join(STATE_DIR, `${session.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
}

/** The state file: what Vigil's running adapter reads (`session`, `stragglers`) and what sessionInfoFromDisk reads back (`term`). */
export function writeState(t: Tree, path = statePath(t.session)): void {
  invariant(/^[A-Za-z0-9_-]+$/.test(t.session), "session id must be a plain id");
  invariant(Number.isFinite(t.ts) && t.ts > 0, "tree timestamp must be set");
  invariant(Array.isArray(t.stragglers), "stragglers must be a list: Vigil reads a missing one as a blind read");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ session: t.session, ts: t.ts, ...(t.term ? { term: t.term } : {}), stragglers: t.stragglers }) + "\n");
  renameSync(tmp, path);
}

/** Pids this session may kill: its own process stragglers, never another session's, never an agent. */
// What the plugin kills. hung-hook stays flagged only (Fable F5: what the harness does with a
// signal-killed PermissionRequest hook while its dialog is open is unverified).
export const AUTO_REAP_KINDS: readonly StragglerKind[] = ["orphaned", "agent-stopped"];
export function reapTargets(t: Tree, kinds: readonly StragglerKind[] = AUTO_REAP_KINDS): ProcRow[] {
  const out: ProcRow[] = [];
  for (const s of t.stragglers) {
    if (!kinds.includes(s.kind) || !s.pids) continue;
    if (s.kind !== "dead-session") invariant(s.session === t.session, "a session reaps only its own processes");
    for (const pid of s.pids) out.push({ pid, ppid: 0, tty: "??", ageS: s.ageS, command: `${s.kind}: ${s.label}` });
  }
  return out;
}

export async function reapTree(t: Tree, kinds?: readonly StragglerKind[], graceMs?: number): Promise<{ killed: number[]; survived: number[] }> {
  const targets = reapTargets(t, kinds);
  if (targets.length === 0) return { killed: [], survived: [] };
  return reapPids({ roots: targets, descendants: [] }, (row) => {
    try { mkdirSync(dirname(REAP_LOG), { recursive: true }); appendFileSync(REAP_LOG, JSON.stringify({ ...row, session: t.session }) + "\n"); } catch { /* the log never blocks a reap */ }
  }, graceMs);
}

/** This process and its ancestors up to (not including) the claude pid: the scan is never work. */
export function selfChain(procs: Proc[], selfPid = process.pid): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set<number>();
  let cur = byPid.get(selfPid);
  while (cur && !out.has(cur.pid)) {
    out.add(cur.pid);
    if (/(?:^|\/)claude(?:\s|$)/.test(cur.command)) { out.delete(cur.pid); break; }
    cur = byPid.get(cur.ppid);
  }
  return out;
}

function claudePidFor(session: string, procs: Proc[]): number | null {
  const envPid = Number(process.env.CLAUDE_PID);
  if (process.env.CLAUDE_CODE_SESSION_ID === session && envPid > 0) return envPid;
  const tagged = procs.find((p) => p.session === session && p.claudePid && procs.some((q) => q.pid === p.claudePid && /(?:^|\/)claude(?:\s|$)/.test(q.command)));
  return tagged?.claudePid ?? null;
}

/** Machine-wide: work processes launchd adopted after their session died. OrphanReaper reaps these on its clock. */
export function deadSessionStragglers(procs: Proc[], now = Date.now(), selfPid = process.pid): Straggler[] {
  const t = buildTree({ session: "", claudePid: null, agents: [], procs, now, exclude: selfChain(procs, selfPid) });
  return t.stragglers.filter((x) => x.kind === "dead-session");
}

export function scan(session: string, agents: AgentIn[] = [], now = Date.now(), commands?: BuildInput["commands"]): Tree {
  const procs = readProcs();
  const exclude = selfChain(procs);
  return buildTree({ session, claudePid: claudePidFor(session, procs), agents, procs, now, exclude, commands });
}

/** Seams for tests; production passes none. */
export interface SnapshotDeps {
  scan?: typeof scan;
  reap?: (t: Tree) => Promise<{ killed: number[]; survived: number[] }>;
  stateFile?: string;
}

/** What the bridge's `session-tree` verb returns. */
export interface SnapshotReply {
  stragglers: Straggler[];
  reaped: { killed: number[]; survived: number[] };
}

/**
 * The bridge's `session-tree` verb and `snapshot`: scan, reap this session's process stragglers, write the state file.
 * `now` is a test clock (epoch ms).
 */
export async function snapshot(input: { session_id?: string; agents?: AgentIn[]; commands?: BuildInput["commands"]; apply?: boolean; now?: number }, deps: SnapshotDeps = {}): Promise<SnapshotReply> {
  const sid = input.session_id ?? "";
  invariant(/^[A-Za-z0-9_-]+$/.test(sid), "session-tree snapshot needs a plain session id");
  const agents = Array.isArray(input.agents) ? input.agents : [];
  const commands = Array.isArray(input.commands) ? input.commands.filter((c) => c && typeof c.agentId === "string" && typeof c.command === "string") : [];
  const doScan = deps.scan ?? scan;
  const doReap = deps.reap ?? ((t: Tree) => reapTree(t));
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const tree = doScan(sid, agents, now, commands);
  const reaped = input.apply ? await doReap(tree) : { killed: [], survived: [] };
  const final = reaped.killed.length > 0 ? doScan(sid, agents, Date.now(), commands) : tree;
  writeState(final, deps.stateFile);
  return { stragglers: final.stragglers, reaped };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// The CLI is a function, not top-level await: a module with top-level await cannot be require()d by in-process callers.
async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const session = flag(args, "--session") ?? process.env.CLAUDE_CODE_SESSION_ID ?? "";
  if (cmd === "snapshot") {
    // Same contract as the bridge verb: {session_id, agents?, commands?, apply?} on stdin → one JSON line out.
    const input = JSON.parse(await Bun.stdin.text() || "{}") as Parameters<typeof snapshot>[0];
    if (!input.session_id && session) input.session_id = session;
    if (!/^[A-Za-z0-9_-]+$/.test(input.session_id ?? "")) { console.log(JSON.stringify({ error: "session_id required" })); process.exit(1); }
    console.log(JSON.stringify(await snapshot(input)));
  } else if (cmd === "show" || cmd === "reap") {
    if (!session) { console.error("no session: pass --session <id> or run inside a Claude session"); process.exit(2); }
    // By hand there is no agent feed, so agent-stopped cannot be judged: a hand-run reap selects orphaned only.
    const tree = scan(session);
    if (cmd === "reap") {
      const kinds: StragglerKind[] = ["orphaned"];
      const targets = reapTargets(tree, kinds);
      if (!args.includes("--apply")) {
        if (targets.length === 0) console.log("SessionTree: nothing to reap.");
        for (const t of targets) console.log(`would kill ${t.pid}  ${t.command}`);
      } else {
        const r = await reapTree(tree, kinds);
        console.log(`SessionTree: killed ${r.killed.length}${r.survived.length ? `, ${r.survived.length} survived (${r.survived.join(",")})` : ""}.`);
        if (r.survived.length) process.exit(1);
      }
    } else if (args.includes("--json")) {
      console.log(JSON.stringify(tree, null, 2));
    } else {
      if (tree.stragglers.length === 0) console.log("SessionTree: no stragglers.");
      for (const s of tree.stragglers) console.log(`⚠ ${s.kind}  ${s.pid ?? "-"}  ${s.label}  ${fmtAge(s.ageS)}`);
      for (const p of tree.procs) console.log(`⚙ ${p.pid}  ${p.label}  ${fmtAge(p.ageS)}${p.agentId ? `  agent ${p.agentId}` : ""}`);
    }
  } else {
    console.error("usage: SessionTree.ts show [--session <id>] [--json]\n       SessionTree.ts reap [--session <id>] [--apply]\n       SessionTree.ts snapshot   (JSON on stdin)");
    process.exit(2);
  }
}

if (import.meta.main) void main();
