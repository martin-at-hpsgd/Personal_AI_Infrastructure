import { networkInterfaces } from "node:os";

/**
 * host-guard — anti-DNS-rebinding Host-header allowlist for the loopback Pulse server.
 *
 * Loopback binding alone does NOT protect a browser-triggerable service: a malicious page
 * the user visits can DNS-rebind its own hostname to 127.0.0.1 and drive Pulse's routes as
 * same-origin. The defence is a Host-header check — a real loopback client always sends
 * `Host: 127.0.0.1[:port]` or `localhost[:port]`; a rebinding attack sends the attacker's
 * hostname. We reject anything that isn't loopback. (Pattern from T3MP3ST src/server.ts:245-253.)
 *
 * Three deliberate carve-outs:
 *  - a missing/empty Host header is ALLOWED — header-less local CLIs (the menu-bar app,
 *    `curl localhost:PORT/notify`) legitimately omit it, exactly like T3MP3ST's carve-out.
 *  - when the server is bound to all interfaces (LIFEOS_PULSE_BIND_ALL=1, an explicit opt-in
 *    for phone/fleet LAN access), the guard is disabled by the caller — LAN clients send a
 *    non-loopback Host by design.
 *  - LIFEOS_PULSE_EXTRA_HOSTS (comma-separated) lets a user allow their own trusted
 *    /etc/hosts aliases that resolve to 127.0.0.1 (e.g. `pai`), so `http://pai:PORT` works.
 *    Opt-in, empty by default, and the port check below still applies. It slightly widens
 *    the rebinding surface to those exact names, so keep it to aliases only you control.
 *
 * The 127 match is a FULL DOTTED QUAD (`^127(?:\.\d{1,3}){3}$`), never a `/^127\./` prefix —
 * a prefix would let `127.0.0.1.evil.com` through, which is the exact rebinding shape.
 */
/**
 * This machine's own Tailscale addresses (IPv4 100.64.0.0/10, IPv6 fd7a:115c:a1e0::/48),
 * read from the local interfaces. Pulse stays bound to loopback; remote reach comes from
 * `tailscale serve --bg --tcp=PORT tcp://127.0.0.1:PORT`, which forwards tailnet traffic to
 * it with the dialled Host intact (`100.x.y.z:PORT`). A literal IP Host is not a rebinding
 * shape (a rebinding page sends its own hostname), so allowing our own tailnet IPs is safe,
 * and nothing reaches them until serve is switched on. Cached briefly: interfaces rarely move.
 */
const TAILNET_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}$/;
const TAILNET_V6 = /^fd7a:115c:a1e0:/i;
let tailnetCache: { at: number; addrs: Set<string> } | null = null;

export function ownTailnetAddresses(): Set<string> {
  if (tailnetCache && Date.now() - tailnetCache.at < 30_000) return tailnetCache.addrs;
  const addrs = new Set<string>();
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const { address } of list ?? []) {
        if (TAILNET_V4.test(address)) addrs.add(address);
        else if (TAILNET_V6.test(address)) addrs.add(`[${address.toLowerCase()}]`);
      }
    }
  } catch {
    // no interface list → no tailnet hosts allowed (fail closed)
  }
  tailnetCache = { at: Date.now(), addrs };
  return addrs;
}

function extraAllowedHosts(): string[] {
  const raw = process.env.LIFEOS_PULSE_EXTRA_HOSTS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Cross-site write guard (CSRF) for state-changing methods. GHSA-g73h-9j7m-5c5w, @elhoim
 *
 * The Host check above stops DNS rebinding but NOT a plain cross-origin POST: a page on
 * any site can fire `fetch('http://127.0.0.1:PORT/api/...', {method:'POST', body:'{...}'})`.
 * A string body is text/plain — a CORS-safelisted type, so no preflight runs, the browser
 * sends the request with `Host: 127.0.0.1:PORT` (passes the loopback guard), and the side
 * effect fires even though the response stays opaque. This gate closes that class for every
 * state-changing route in one place.
 *
 * Decision order, fail-closed for browsers and invisible to local CLIs:
 *  - GET/HEAD/OPTIONS pass — reads carry no side effect by contract.
 *  - `Sec-Fetch-Site: same-origin`/`none` pass; any other value (cross-site, and same-site,
 *    which is what another local port's page sends) is rejected — only Pulse's own pages
 *    may drive Pulse's writes.
 *  - Otherwise an `Origin` header must be OUR origin: loopback host AND our port (the same
 *    isLoopbackHostHeader used for Host, so EXTRA_HOSTS aliases keep working).
 *  - No Origin and no Sec-Fetch-Site → non-browser local client (curl, MenuBar, launchd
 *    jobs, the voice tunnel) — allowed, same carve-out as the header-less Host rule.
 */
export function isForbiddenCrossSiteWrite(req: Request, port: number): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;

  const sfs = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (sfs) return sfs !== "same-origin" && sfs !== "none";

  const origin = req.headers.get("origin")?.trim();
  if (origin && origin !== "null") {
    try {
      const u = new URL(origin);
      // Pulse's own origin always carries its explicit non-default port; an Origin
      // without one (e.g. http://localhost = port 80) is some other local app's page.
      if (!u.port || parseInt(u.port, 10) !== port) return true;
      return !isLoopbackHostHeader(u.host, port);
    } catch {
      return true; // malformed Origin from a browser — reject
    }
  }
  if (origin === "null") return true; // sandboxed/opaque browser context — reject

  return false; // header-less local client
}

export function isLoopbackHostHeader(hostHeader: string | null | undefined, port: number): boolean {
  if (!hostHeader || !hostHeader.trim()) return true; // header-less local CLI — allowed
  const h = hostHeader.trim().toLowerCase();

  // Split host and optional :port. IPv6 literals are bracketed: [::1]:PORT.
  let bare: string;
  let portPart: string | null = null;
  const v6 = h.match(/^(\[[^\]]+\])(?::(\d+))?$/);
  if (v6) {
    bare = v6[1];
    portPart = v6[2] ?? null;
  } else {
    const m = h.match(/^([^:]+)(?::(\d+))?$/);
    if (!m) return false;
    bare = m[1];
    portPart = m[2] ?? null;
  }

  const isLoopback =
    bare === "localhost" ||
    /^127(?:\.\d{1,3}){3}$/.test(bare) || // full quad, NOT a 127. prefix
    bare === "[::1]" ||
    bare === "::1" ||
    extraAllowedHosts().includes(bare) || // user-trusted local aliases (opt-in)
    ownTailnetAddresses().has(bare); // this machine's own tailnet IPs (via tailscale serve)
  if (!isLoopback) return false;

  // If a port is present it must be ours (defence in depth; absent port is fine).
  if (portPart !== null && parseInt(portPart, 10) !== port) return false;
  return true;
}
