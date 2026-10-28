// Remote links: when the principal is away from home, a text to the principal's own line is read on a phone or a laptop where
// localhost, 127.0.0.1, [::1] and this Mac's own hostname (its short name and its tailnet name) all point nowhere. Every such URL is then rewritten to this
// Mac's Tailscale address with the same port and path, so the link opens from any device on the tailnet. At home
// the link goes out as written (2026-10-09). Location comes from here(); an unknown or stale fix counts as
// away, because the tailnet link also opens at home.
// Lookup failure or no Tailscale means the text goes out as written; this step never stops a send.
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { here, readConfig } from "../../LOCATION/Here.ts";

// The host must end where it appears to: `http://box.example.com` and `http://localhostess` are left alone.
const LOCAL_URL_TAIL = String.raw`(?:(:\d{2,5})(?!\d)|(?![\w-]|\.[\w-]))`;
const ANY_URL = /\bhttps?:\/\//i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const localUrlRe = (names: string[], flags: string) =>
  new RegExp(String.raw`\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]${names.map(n => "|" + escapeRe(n)).join("")})` + LOCAL_URL_TAIL, flags);
const TAILNET_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
const CLI = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
const TTL_MS = 10 * 60_000;

let cached: { ip: string | undefined; at: number } | undefined;
let cachedNames: { names: string[]; at: number } | undefined;

const shortName = (h: string) => h.trim().split(".")[0]!.toLowerCase();

/** This Mac's own names that point nowhere from another device: the OS short hostname and the tailnet host name. Cached for ten minutes. */
export function localHostnames(now = Date.now(), run: (cmd: string) => string = cmd => spawnSync(cmd, ["status", "--self=true", "--peers=false", "--json"], { encoding: "utf8", timeout: 3000 }).stdout ?? ""): string[] {
  if (cachedNames && now - cachedNames.at < TTL_MS) return cachedNames.names;
  const names = new Set<string>();
  const add = (h: unknown) => { if (typeof h === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(shortName(h))) names.add(shortName(h)); };
  try { add(hostname()); } catch { /* no OS hostname */ }
  for (const cmd of CLI) {
    try {
      const self = JSON.parse(run(cmd))?.Self;
      if (self) { add(self.HostName); add(self.DNSName); break; }
    } catch { /* try the next location */ }
  }
  names.delete("localhost");
  cachedNames = { names: [...names], at: now };
  return cachedNames.names;
}

/** This Mac's tailnet IPv4 address, or undefined when Tailscale is absent or down. Cached for ten minutes. */
export function tailnetIp(now = Date.now(), run: (cmd: string) => string = cmd => spawnSync(cmd, ["ip", "-4"], { encoding: "utf8", timeout: 3000 }).stdout ?? ""): string | undefined {
  if (cached && now - cached.at < TTL_MS) return cached.ip;
  let ip: string | undefined;
  for (const cmd of CLI) {
    try {
      const line = run(cmd).split("\n").map(s => s.trim()).find(s => TAILNET_V4.test(s));
      if (line) { ip = line; break; }
    } catch { /* try the next location */ }
  }
  cached = { ip, at: now };
  return ip;
}

/** True unless a fresh location fix says he is at home. Never throws. */
export function awayFromHome(): boolean {
  try { return here(readConfig().home ?? { lat: 0, lon: 0 }).at_home !== true; } catch { return true; }
}

/** Away from home, rewrites every local-only URL in `body` to the tailnet address, keeping scheme, port and path. */
export function remoteLinks(body: string, ip?: string | null, away: () => boolean = awayFromHome, names: () => string[] = localHostnames): string {
  if (!body || !ANY_URL.test(body)) return body;
  try {
    const re = localUrlRe(names(), "gi");
    if (!re.test(body)) return body;
    re.lastIndex = 0;
    if (!away()) return body;
    const addr = ip === undefined ? tailnetIp() : ip;
    if (!addr || !TAILNET_V4.test(addr)) return body;
    return body.replace(re, (_m, port: string | undefined) => `http://${addr}${port ?? ""}`);
  } catch { return body; }
}

/** Test hook: forget the cached address and names. */
export function resetTailnetCache(): void { cached = undefined; cachedNames = undefined; }
