// Pure logic for the herdr web bridge: agent views, request checks, herdr argv.
// No I/O here, so every rule the bridge enforces is testable without a server.

export type Status = "blocked" | "working" | "done" | "idle" | "unknown";

export interface AgentView {
  paneId: string;
  workspaceId: string;
  title: string;
  agent: string;
  status: Status;
  label: string;
  open: string;
  focused: boolean;
}

const RANK: Record<Status, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
const WORD: Record<Status, string> = { blocked: "Needs you", working: "Working", done: "Done", idle: "Idle", unknown: "Unknown" };
const STATUSES = new Set<string>(Object.keys(RANK));

/** herdr pane ids look like `w15D:p1` or `w15D:pA`; anything else never reaches argv. */
export const PANE_ID = /^[A-Za-z0-9]{1,16}:p[A-Za-z0-9]{1,8}$/;

/** Maps `herdr agent list` output to the page's view, needs-you first. */
export function agentViews(raw: unknown): AgentView[] {
  const agents = (raw as { result?: { agents?: unknown[] } })?.result?.agents;
  if (!Array.isArray(agents)) return [];
  const views: AgentView[] = [];
  for (const a of agents as Record<string, any>[]) {
    if (typeof a?.pane_id !== "string" || !PANE_ID.test(a.pane_id)) continue;
    const status: Status = STATUSES.has(a.agent_status) ? a.agent_status : "unknown";
    views.push({
      paneId: a.pane_id,
      workspaceId: String(a.workspace_id ?? ""),
      title: String(a.terminal_title_stripped || a.terminal_title || a.pane_id),
      agent: String(a.display_agent || a.agent || "agent"),
      status,
      label: String(a.state_labels?.[status] || WORD[status]),
      open: String(a.tokens?.open ?? ""),
      focused: a.focused === true,
    });
  }
  return views.sort((x, y) => RANK[x.status] - RANK[y.status] || x.title.localeCompare(y.title));
}

/** A target is usable only when herdr itself lists it right now. */
export function knownTarget(id: string | null, views: AgentView[]): string | null {
  if (!id || !PANE_ID.test(id)) return null;
  return views.some(v => v.paneId === id) ? id : null;
}

/** Tailscale serve sets this header from the caller's node identity. */
export function identityOk(headers: Headers, principalLogin: string): boolean {
  const login = headers.get("tailscale-user-login");
  return !!principalLogin && !!login && login.toLowerCase() === principalLogin.toLowerCase();
}

/**
 * Every device on the tailnet shares the principal's login, a server included, so the
 * login alone admits too much. Tailscale serve overwrites X-Forwarded-For with the
 * caller's tailnet IP (a forged value was observed replaced), so it names the device.
 * A request with no X-Forwarded-For never passed serve: the listener is loopback-only,
 * so it came from a local process, which is already trusted.
 */
export function deviceOk(headers: Headers, allowedIps: Set<string>): boolean {
  const xff = headers.get("x-forwarded-for");
  if (xff === null) return true;
  const ip = xff.trim().toLowerCase();
  return !ip.includes(",") && allowedIps.has(ip);
}

/** Host must be one of the bridge's own names; blocks DNS rebinding. */
export function hostOk(headers: Headers, allowedHosts: Set<string>): boolean {
  const host = headers.get("host")?.toLowerCase();
  return !!host && allowedHosts.has(host);
}

/**
 * A WebSocket upgrade must come from the bridge's own page. Browsers cannot
 * forge Origin, and Tailscale attaches the principal's identity to any request
 * from their devices, so this is what stops another site opening a stream.
 */
export function originOk(headers: Headers, allowedHosts: Set<string>): boolean {
  const origin = headers.get("origin");
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.username || u.password || u.pathname !== "/") return false;
    return allowedHosts.has(u.host.toLowerCase());
  } catch {
    return false;
  }
}

export function clampDims(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const n = (v: unknown, lo: number, hi: number, d: number) => {
    const x = Math.floor(Number(v));
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  return { cols: n(cols, 20, 300, 80), rows: n(rows, 5, 120, 24) };
}

export type Mode = "observe" | "control";

export function sessionArgs(bin: string, target: string, mode: Mode, dims: { cols: number; rows: number }): string[] {
  if (!PANE_ID.test(target)) throw new Error(`refusing target ${JSON.stringify(target)}`);
  const args = [bin, "terminal", "session", mode, target];
  if (mode === "control") args.push("--takeover");
  args.push("--cols", String(dims.cols), "--rows", String(dims.rows));
  return args;
}

/** Named keys the phone key bar sends; nothing else is accepted as a key. */
export const KEYS: Record<string, string> = {
  esc: "\x1b",
  "ctrl-c": "\x03",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  enter: "\r",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
};

/** Turns one browser message into the herdr control commands to write, in order. */
export function controlCommands(raw: string): object[] {
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return [];
  }
  if (m?.t === "input" && typeof m.text === "string" && m.text.length <= 65536) {
    return [{ type: "terminal.input", text: m.text }];
  }
  if (m?.t === "key" && typeof m.key === "string" && Object.prototype.hasOwnProperty.call(KEYS, m.key)) {
    return [{ type: "terminal.input", text: KEYS[m.key] }];
  }
  if (m?.t === "resize") {
    const d = clampDims(m.cols, m.rows);
    return [{ type: "terminal.resize", cols: d.cols, rows: d.rows }];
  }
  return [];
}

export const RELEASE = { type: "terminal.release" };
export const CONTROL_IDLE_MS = 10 * 60 * 1000;
