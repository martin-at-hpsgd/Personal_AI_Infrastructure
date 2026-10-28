#!/usr/bin/env bun
// Herdr web bridge: drive herdr agent panes from a phone browser.
// Listens on loopback only; reached through `tailscale serve --http`, which adds
// the caller's Tailscale identity and tailnet IP. Every request must carry the
// principal's login from an allowed device. The only child process is the herdr
// binary, run with an argument array.

import { join } from "node:path";
import { homedir } from "node:os";
import type { ServerWebSocket, Subprocess } from "bun";
import { getClaudeDir } from "../../TOOLS/Paths";
import {
  agentViews, knownTarget, identityOk, deviceOk, hostOk, originOk, clampDims, sessionArgs,
  controlCommands, RELEASE, CONTROL_IDLE_MS, type AgentView, type Mode,
} from "./lib";

const CLAUDE_DIR = getClaudeDir();
const CONFIG_PATH = join(CLAUDE_DIR, "LIFEOS/USER/CONFIG/herdr-bridge.json");
const HERE = import.meta.dir;

export interface Config {
  principalLogin: string;
  port: number;
  servePort: number;
  publicHosts: string[];
  allowedDeviceIps: string[];
  maxStreams?: number;
}

async function loadConfig(): Promise<Config> {
  const f = Bun.file(CONFIG_PATH);
  const c = (await f.exists()) ? await f.json() : {};
  return {
    principalLogin: String(c.principalLogin ?? ""),
    port: Number(c.port ?? 31338),
    servePort: Number(c.servePort ?? 8443),
    publicHosts: Array.isArray(c.publicHosts) ? c.publicHosts.map(String) : [],
    allowedDeviceIps: Array.isArray(c.allowedDevices) ? c.allowedDevices.flatMap((d: any) => d?.ips ?? []).map(String) : [],
    maxStreams: Number(c.maxStreams ?? 8),
  };
}

const HERDR = process.env.HERDR_BIN_PATH || Bun.which("herdr") || join(homedir(), ".local/bin/herdr");

// Every child the bridge starts, so shutdown can reach all of them.
const streams = new Set<Subprocess>();
const oneShots = new Set<Subprocess>();

// Every one-shot command has a deadline, so a hung CLI can never hang a request.
async function run(argv: string[], ms = 5000): Promise<string> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
  oneShots.add(p);
  const t = setTimeout(() => p.kill(), ms);
  try {
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  } finally {
    clearTimeout(t);
    oneShots.delete(p);
  }
}

/** Throws when herdr cannot be reached, so an outage never reads as "no agents". */
async function fetchAgents(): Promise<AgentView[]> {
  const parsed = JSON.parse(await run([HERDR, "agent", "list"]));
  if (!Array.isArray(parsed?.result?.agents)) throw new Error(parsed?.error?.message ?? "herdr returned no agent list");
  return agentViews(parsed);
}

// Concurrent and back-to-back callers share one `herdr agent list` for 1.5 s.
let listing: { at: number; p: Promise<AgentView[]> } | null = null;
function listAgents(): Promise<AgentView[]> {
  if (listing && Date.now() - listing.at < 1500) return listing.p;
  const p = fetchAgents();
  listing = { at: Date.now(), p };
  p.catch(() => { if (listing?.p === p) listing = null; });
  return p;
}

// The bridge's own names: loopback for local checks, plus the tailnet names that
// `manage.ts install` records. The Tailscale CLI hangs under launchd, so it is never called here.
function allowedHosts(cfg: Config): Set<string> {
  return new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, ...cfg.publicHosts.map(h => h.toLowerCase())]);
}

const VENDOR: Record<string, [string, string]> = {
  "/vendor/xterm.js": [join(HERE, "node_modules/@xterm/xterm/lib/xterm.js"), "text/javascript"],
  "/vendor/xterm.css": [join(HERE, "node_modules/@xterm/xterm/css/xterm.css"), "text/css"],
  "/vendor/addon-fit.js": [join(HERE, "node_modules/@xterm/addon-fit/lib/addon-fit.js"), "text/javascript"],
  "/fonts/concourse-t3.woff": [join(HERE, "../Observability/public/fonts/concourse_t3_regular-webfont.woff"), "font/woff"],
  "/fonts/advocate-c41.woff": [join(HERE, "../Observability/public/fonts/advocate_c41_tab_regular-webfont.woff"), "font/woff"],
};

export const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const deny = (status: number, msg: string) => new Response(msg, { status, headers: SECURITY_HEADERS });

interface Sock {
  target: string;
  mode: Mode;
  cols: number;
  rows: number;
  proc?: Subprocess<"pipe" | "ignore", "pipe", "ignore">;
  idle?: ReturnType<typeof setTimeout>;
}

function stop(ws: ServerWebSocket<Sock>) {
  const d = ws.data;
  if (d.idle) clearTimeout(d.idle);
  const p = d.proc;
  if (!p) return;
  d.proc = undefined;
  if (d.mode === "control" && p.stdin && typeof p.stdin !== "number") {
    try { p.stdin.write(JSON.stringify(RELEASE) + "\n"); p.stdin.flush(); p.stdin.end(); } catch { /* already gone */ }
  }
  setTimeout(() => { p.kill(); streams.delete(p); }, 300);
}

function armIdle(ws: ServerWebSocket<Sock>) {
  if (ws.data.mode !== "control") return;
  if (ws.data.idle) clearTimeout(ws.data.idle);
  ws.data.idle = setTimeout(() => {
    ws.send(JSON.stringify({ t: "closed", reason: "idle" }));
    ws.close(4000, "control idle");
  }, CONTROL_IDLE_MS);
}

async function pump(ws: ServerWebSocket<Sock>, proc: NonNullable<Sock["proc"]>) {
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type === "terminal.frame" && typeof rec.bytes === "string") {
        ws.send(Buffer.from(rec.bytes, "base64"));
      } else if (rec.type === "terminal.closed") {
        ws.send(JSON.stringify({ t: "closed", reason: String(rec.reason ?? "closed") }));
      }
    }
  }
  streams.delete(proc);
  if (ws.readyState === 1) ws.close(1000, "stream ended");
}

export async function startBridge(cfg: Config) {
  if (!cfg.principalLogin) throw new Error(`principalLogin missing in ${CONFIG_PATH}; refusing to start`);
  const page = join(HERE, "page.html");
  const devices = new Set(cfg.allowedDeviceIps.map(ip => ip.toLowerCase()));
  const maxStreams = cfg.maxStreams ?? 8;

  return Bun.serve<Sock, string>({
    hostname: "127.0.0.1",
    port: cfg.port,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true }, { headers: SECURITY_HEADERS });

      const hosts = allowedHosts(cfg);
      if (!hostOk(req.headers, hosts)) return deny(403, "forbidden host");
      if (!identityOk(req.headers, cfg.principalLogin)) return deny(403, "forbidden");
      if (!deviceOk(req.headers, devices)) return deny(403, "forbidden device");
      if (req.method !== "GET") return deny(405, "method not allowed");
      // A browser sends Origin on cross-site fetches; refuse those before any work.
      if (req.headers.has("origin") && !originOk(req.headers, hosts)) return deny(403, "forbidden origin");

      if (url.pathname === "/ws") {
        if (!originOk(req.headers, hosts)) return deny(403, "forbidden origin");
        if (streams.size >= maxStreams) return deny(503, "too many streams");
        const target = knownTarget(url.searchParams.get("target"), await listAgents().catch(() => []));
        if (!target) return deny(404, "unknown target");
        const mode: Mode = url.searchParams.get("mode") === "control" ? "control" : "observe";
        const dims = clampDims(url.searchParams.get("cols"), url.searchParams.get("rows"));
        if (server.upgrade(req, { data: { target, mode, ...dims } })) return undefined;
        return deny(400, "upgrade failed");
      }
      if (url.pathname === "/api/agents") {
        try {
          return Response.json({ agents: await listAgents() }, { headers: SECURITY_HEADERS });
        } catch (e) {
          console.error(JSON.stringify({ msg: "herdr agent list failed", herdr: HERDR, error: String(e) }));
          return Response.json({ error: "herdr unreachable" }, { status: 503, headers: SECURITY_HEADERS });
        }
      }
      if (url.pathname === "/") {
        return new Response(Bun.file(page), { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" } });
      }
      const v = VENDOR[url.pathname];
      if (v) return new Response(Bun.file(v[0]), { headers: { ...SECURITY_HEADERS, "content-type": v[1] } });
      return deny(404, "not found");
    },
    websocket: {
      open(ws) {
        const d = ws.data;
        let proc: NonNullable<Sock["proc"]>;
        try {
          proc = Bun.spawn(sessionArgs(HERDR, d.target, d.mode, d), {
            stdin: d.mode === "control" ? "pipe" : "ignore",
            stdout: "pipe",
            stderr: "ignore",
          });
        } catch (e) {
          console.error(JSON.stringify({ msg: "herdr session spawn failed", error: String(e) }));
          ws.close(1011, "spawn failed");
          return;
        }
        d.proc = proc;
        streams.add(proc);
        ws.send(JSON.stringify({ t: "open", mode: d.mode, target: d.target }));
        armIdle(ws);
        pump(ws, proc).catch(() => { if (ws.readyState === 1) ws.close(1011, "stream error"); });
      },
      message(ws, msg) {
        const d = ws.data;
        if (d.mode !== "control" || !d.proc || typeof msg !== "string") return;
        const stdin = d.proc.stdin;
        if (!stdin || typeof stdin === "number") return;
        for (const c of controlCommands(msg)) stdin.write(JSON.stringify(c) + "\n");
        stdin.flush();
        armIdle(ws);
      },
      close(ws) { stop(ws); },
    },
  });
}

export function stopAllStreams() {
  for (const p of [...streams, ...oneShots]) p.kill();
  streams.clear();
  oneShots.clear();
}

async function shutdown() {
  stopAllStreams();
  await Bun.sleep(200);
  process.exit(0);
}

if (import.meta.main) {
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  const cfg = await loadConfig();
  const server = await startBridge(cfg);
  console.log(JSON.stringify({ msg: "herdr-bridge listening", host: "127.0.0.1", port: server.port, devices: cfg.allowedDeviceIps.length }));
}
