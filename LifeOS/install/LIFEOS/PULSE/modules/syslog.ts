/**
 * Pulse Syslog Module
 *
 * UDP syslog listener for UniFi debug logs. Bound to an unprivileged port (5514)
 * and writing structured JSONL to MEMORY/OBSERVABILITY/unifi-syslog.jsonl.
 *
 * Parses RFC3164 and CEF frames. Extracts severity, timestamp, host, tag, msg.
 * Registered in PULSE.toml under [modules.syslog].
 *
 * Request routes:
 *   GET /api/syslog/status           → ingest state + ring buffer metrics
 *   GET /api/syslog/tail?n=50        → last N raw lines
 */

import { createSocket, type Socket } from "dgram"
import { appendFileSync, mkdirSync, existsSync, statSync, readFileSync } from "fs"
import { dirname, join } from "path"
import { homedir } from "node:os";
import { isInstructionShaped } from "../../TOOLS/InjectionShapes"

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir()
const MODULE_NAME = "syslog"
const DEFAULT_PORT = 5514
const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB rotation threshold

// ── Ingest narrowing (2026-08-19) ─────────────────────────────────────
//
// This is the only listener in LifeOS that accepts writes from an unauthenticated
// source. Anything that can reach the port can append arbitrary text to a file
// the dashboard renders and that later reads may carry into context, so it is an
// injection surface as well as the flood risk it was already tracked as.
//
// UDP has no handshake and a source address is trivially spoofed, so none of
// this is authentication. It is narrowing: shrink who is listened to, bound what
// one sender can write, strip the tricks that make text lie about its own shape,
// and mark what still reads like an instruction so nothing downstream mistakes a
// router's log line for a directive.

/** Longest datagram kept. A real syslog line is a few hundred bytes. */
const MAX_MSG_BYTES = 4096

/** Per-sender ceiling. A busy router bursts; nothing legitimate sustains this. */
const MAX_MSGS_PER_SENDER_PER_SEC = 200

/** Distinct senders tracked for rate limiting before the table is reset. */
const MAX_TRACKED_SENDERS = 512

/**
 * Accept only private-range and loopback senders unless an explicit allowlist
 * is configured. A LAN router is the entire intended use, so refusing public
 * source addresses costs nothing and closes the case where the host sits on an
 * untrusted network.
 */
const PRIVATE_V4 = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^127\./,
  /^169\.254\./,
]

const isPrivateSender = (addr: string): boolean => {
  const a = addr.replace(/^::ffff:/, "")
  if (a === "::1") return true
  return PRIVATE_V4.some((r) => r.test(a))
}

/** Exact IPs, or dotted prefixes matched by leading substring, from PULSE_SYSLOG_ALLOW (comma-separated). */
const allowlist = (): string[] =>
  (process.env.PULSE_SYSLOG_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

/** Exported for tests: the guards are unit-testable apart from the socket. */
export const senderAllowed = (addr: string): boolean => {
  const list = allowlist()
  if (list.length === 0) return isPrivateSender(addr)
  const a = addr.replace(/^::ffff:/, "")
  return list.some((entry) => (entry.endsWith(".") ? a.startsWith(entry) : a === entry))
}

/**
 * Strip what makes text misrepresent itself: NFKC-fold homoglyphs, drop
 * zero-width and bidi controls, drop C0/C1 controls, then bound the length.
 * Same treatment the messaging channel already applies, for the same reason.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g

export const sanitize = (raw: string): string =>
  raw
    .normalize("NFKC")
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_CHARS, "")
    .slice(0, MAX_MSG_BYTES)

const rate = new Map<string, { count: number; windowStart: number }>()

/** Exported for tests: clears the rate-limit window between cases. */
export const __resetRate = (): void => rate.clear()

/** True when this sender is over its per-second ceiling. */
export const rateLimited = (addr: string, now: number): boolean => {
  // A flood from many spoofed addresses would grow this table without bound,
  // so it is cleared wholesale rather than allowed to become the memory leak
  // the rate limiter was added to prevent.
  if (rate.size > MAX_TRACKED_SENDERS) rate.clear()
  const e = rate.get(addr)
  if (!e || now - e.windowStart >= 1000) {
    rate.set(addr, { count: 1, windowStart: now })
    return false
  }
  e.count++
  return e.count > MAX_MSGS_PER_SENDER_PER_SEC
}

const LOG_PATH = join(
  HOME,
  ".claude",
  "LIFEOS",
  "MEMORY",
  "OBSERVABILITY",
  "unifi-syslog.jsonl",
)

type Severity = "emerg" | "alert" | "crit" | "err" | "warn" | "notice" | "info" | "debug"

const SEVERITY_NAMES: Severity[] = [
  "emerg", "alert", "crit", "err", "warn", "notice", "info", "debug",
]

interface ParsedMessage {
  ts: string
  source: string
  severity: Severity
  facility: number
  host?: string
  tag?: string
  msg: string
  raw: string
  format: "rfc3164" | "cef" | "unknown"
}

interface ModuleState {
  running: boolean
  startedAt: Date | null
  socket: Socket | null
  port: number
  messagesReceived: number
  lastMessageAt: Date | null
  lastSender: string | null
  parseFailures: number
  /** Datagrams refused because the source address is not allowed. */
  droppedSender: number
  /** Datagrams refused because a sender exceeded its per-second ceiling. */
  droppedRate: number
  /** Lines written but flagged as reading like an instruction. */
  instructionShaped: number
}

const state: ModuleState = {
  running: false,
  startedAt: null,
  socket: null,
  port: DEFAULT_PORT,
  messagesReceived: 0,
  lastMessageAt: null,
  lastSender: null,
  parseFailures: 0,
  droppedSender: 0,
  droppedRate: 0,
  instructionShaped: 0,
}

const parseRfc3164 = (raw: string): ParsedMessage | null => {
  // <PRI>TIMESTAMP HOST TAG: MSG
  const m = raw.match(/^<(\d{1,3})>([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^:]+):\s*(.*)$/s)
  if (!m) return null
  const pri = Number(m[1])
  const facility = pri >> 3
  const severity = SEVERITY_NAMES[pri & 7] ?? "info"
  return {
    ts: new Date().toISOString(),
    source: "udp:5514",
    severity,
    facility,
    host: m[3],
    tag: m[4]?.trim(),
    msg: m[5]?.trim() ?? "",
    raw,
    format: "rfc3164",
  }
}

const parseCef = (raw: string): ParsedMessage | null => {
  // CEF:Version|Device Vendor|Device Product|Device Version|Signature ID|Name|Severity|Extension
  const idx = raw.indexOf("CEF:")
  if (idx < 0) return null
  const rest = raw.slice(idx)
  const parts = rest.split("|")
  if (parts.length < 7) return null
  const severityNum = Number(parts[6] ?? "6")
  const severity: Severity =
    severityNum >= 9 ? "crit" :
    severityNum >= 7 ? "err" :
    severityNum >= 5 ? "warn" :
    severityNum >= 3 ? "notice" : "info"
  return {
    ts: new Date().toISOString(),
    source: "udp:5514",
    severity,
    facility: 0,
    tag: `${parts[1]}/${parts[2]}`,
    msg: parts[5] ?? "",
    raw,
    format: "cef",
  }
}

const parse = (raw: string): ParsedMessage => {
  const cef = parseCef(raw)
  if (cef) return cef
  const rfc = parseRfc3164(raw)
  if (rfc) return rfc
  return {
    ts: new Date().toISOString(),
    source: "udp:5514",
    severity: "info",
    facility: 0,
    msg: raw.trim(),
    raw,
    format: "unknown",
  }
}

const rotateIfNeeded = (): void => {
  if (!existsSync(LOG_PATH)) return
  try {
    const s = statSync(LOG_PATH)
    if (s.size < MAX_FILE_SIZE) return
    const rotated = LOG_PATH + "." + new Date().toISOString().slice(0, 10)
    require("fs").renameSync(LOG_PATH, rotated)
  } catch {
    // best-effort — rotation failure should not kill ingest
  }
}

export async function start(): Promise<void> {
  console.log(`[${MODULE_NAME}] Starting...`)
  const portFromEnv = process.env.PULSE_SYSLOG_PORT
  if (portFromEnv) state.port = Number(portFromEnv)

  // Counters describe THIS run. A restarted listener reporting the previous
  // run's drop counts would read as ongoing abuse long after it stopped.
  state.messagesReceived = 0
  state.parseFailures = 0
  state.droppedSender = 0
  state.droppedRate = 0
  state.instructionShaped = 0
  rate.clear()

  mkdirSync(dirname(LOG_PATH), { recursive: true })

  const socket = createSocket("udp4")

  socket.on("error", (err) => {
    console.error(`[${MODULE_NAME}] socket error: ${err.message}`)
  })

  socket.on("message", (buf, rinfo) => {
    try {
      // Refuse first, parse second. Everything below this point writes to disk,
      // so the cheap rejections happen before any work is done on the datagram.
      if (!senderAllowed(rinfo.address)) {
        state.droppedSender++
        return
      }
      if (rateLimited(rinfo.address, Date.now())) {
        state.droppedRate++
        return
      }

      const raw = sanitize(buf.toString("utf-8"))
      if (raw.length === 0) return
      const parsed = parse(raw)

      // Instruction-shaped lines are KEPT and MARKED, not dropped. This is a
      // log: losing a line loses forensic fidelity, and the sender address is
      // already recorded, so the useful move is making the shape visible to
      // whatever reads the file rather than pretending it never arrived.
      const suspicious = isInstructionShaped(parsed.msg) || isInstructionShaped(parsed.raw)
      if (suspicious) state.instructionShaped++

      rotateIfNeeded()
      appendFileSync(
        LOG_PATH,
        JSON.stringify({
          ...parsed,
          sender: rinfo.address,
          // Every row here is third-party text from an unauthenticated source.
          // Stamping it means a reader never has to infer that from the filename.
          trust: "untrusted-source",
          ...(suspicious ? { instruction_shaped: true } : {}),
        }) + "\n",
      )
      state.messagesReceived++
      state.lastMessageAt = new Date()
      state.lastSender = rinfo.address
    } catch {
      state.parseFailures++
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.once("listening", resolve)
    socket.once("error", reject)
    socket.bind(state.port, "0.0.0.0")
  })

  state.socket = socket
  state.running = true
  state.startedAt = new Date()
  console.log(`[${MODULE_NAME}] Listening on UDP:${state.port} → ${LOG_PATH}`)
}

export async function stop(): Promise<void> {
  console.log(`[${MODULE_NAME}] Stopping...`)
  state.running = false
  if (state.socket) {
    await new Promise<void>((resolve) => state.socket!.close(() => resolve()))
    state.socket = null
  }
  console.log(`[${MODULE_NAME}] Stopped`)
}

export function health(): { status: string; details?: Record<string, unknown> } {
  return {
    status: state.running ? "healthy" : "stopped",
    details: {
      port: state.port,
      uptime: state.startedAt
        ? Math.floor((Date.now() - state.startedAt.getTime()) / 1000)
        : 0,
      messages_received: state.messagesReceived,
      parse_failures: state.parseFailures,
      // Refusals are surfaced, never silent: a listener quietly dropping
      // everything looks identical to a quiet network from the outside.
      dropped_sender_not_allowed: state.droppedSender,
      dropped_rate_limited: state.droppedRate,
      instruction_shaped_lines: state.instructionShaped,
      sender_policy: allowlist().length > 0 ? `allowlist:${allowlist().length}` : "private-ranges-only",
      last_message_at: state.lastMessageAt?.toISOString() ?? null,
      last_sender: state.lastSender,
      log_file: LOG_PATH,
      log_file_exists: existsSync(LOG_PATH),
    },
  }
}

const tailFile = (n: number): string[] => {
  if (!existsSync(LOG_PATH)) return []
  const raw = readFileSync(LOG_PATH, "utf-8")
  return raw.split("\n").filter(Boolean).slice(-n)
}

export async function handleRequest(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  if (path === "/status" || path === "") {
    return Response.json(health())
  }
  if (path.startsWith("/tail")) {
    const n = Number((body.n as string | undefined) ?? 50)
    return Response.json({ lines: tailFile(n) })
  }
  return Response.json({ error: "Not found" }, { status: 404 })
}
