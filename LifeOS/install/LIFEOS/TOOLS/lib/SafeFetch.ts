/**
 * SafeFetch — the one fetch for a URL that someone else chose (ISA 20261015-security-p1-batch1, C4).
 *
 *   safeFetch(input, init?, opts?)   fetch, with the destination checked and the connection pinned
 *   createSafeFetch(opts)            the same thing in fetch's own shape, for code that injects a fetcher
 *   checkDestination(url, opts?)     the check alone: the one address a request to `url` may use, or a refusal
 *   addressClass(ip)                 public | loopback | private | link-local | reserved
 *
 * How it works. Each hop resolves the host ONCE. Every address it answers with must be allowed
 * (public, or a class the caller named in `allow`), else the hop is refused before anything is sent.
 * The request then goes through a single-use local tunnel that connects to the validated address and
 * nowhere else, so the name is never resolved a second time (no DNS-rebinding window). Because the
 * runtime's own fetch still speaks to the original URL through that tunnel, the Host header, TLS SNI
 * and certificate verification all use the original hostname.
 *
 * Why a tunnel. In Bun 1.3.6 the two obvious pins fail: `node:https` with a `lookup` rewrites the URL
 * to the IP and verifies the certificate against the IP, and `fetch` to an IP URL sends no SNI, so
 * any SNI-routed host (most CDNs) serves the wrong certificate. An explicit `proxy` keeps fetch's TLS
 * intact and is never bypassed by NO_PROXY; the tunnel refuses any CONNECT or request for a host
 * other than the one validated, accepts exactly one connection, and the call fails closed if the
 * transport never went through it.
 *
 * Redirects are never followed by the runtime. `redirect: "follow"` (the default) re-runs the whole
 * check on every hop, up to `maxRedirects` (0 refuses any redirect); "error" refuses; "manual" hands
 * the 3xx back so the caller decides, and its next call is checked again.
 *
 * No persistent state is written here, so there are no invariants to assert.
 * @version 1.0.0
 */

import net from "node:net"
import { lookup } from "node:dns/promises"

// ── Address classes ──────────────────────────────────────────────────────────

export type AddressClass = "public" | "loopback" | "private" | "link-local" | "reserved"

/** The classes a caller may opt into. `reserved` (unspecified, multicast, documentation …) never is. */
export interface AllowNonPublic {
  loopback?: boolean
  private?: boolean
  linkLocal?: boolean
}

function v4Octets(ip: string): number[] | null {
  if (net.isIPv4(ip) === false) return null
  return ip.split(".").map(Number)
}

function classifyV4(o: number[]): AddressClass {
  const [a, b, c] = o as [number, number, number, number]
  if (a === 127) return "loopback"
  if (a === 10) return "private"
  if (a === 172 && b >= 16 && b <= 31) return "private"
  if (a === 192 && b === 168) return "private"
  if (a === 100 && b >= 64 && b <= 127) return "private" // CGNAT shared space
  if (a === 169 && b === 254) return "link-local" // includes cloud metadata 169.254.169.254
  if (a === 0) return "reserved" // "this network"; 0.0.0.0 reaches the local host on many systems
  if (a >= 224) return "reserved" // multicast, 240/4, broadcast
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "reserved" // IETF protocol, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return "reserved" // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return "reserved" // benchmarking
  if (a === 198 && b === 51 && c === 100) return "reserved" // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return "reserved" // TEST-NET-3
  return "public"
}

/** Eight 16-bit groups of an IPv6 address, or null. Handles `::`, a zone id and a dotted v4 tail. */
function v6Groups(raw: string): number[] | null {
  let ip = raw.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase()
  if (!net.isIPv6(ip)) return null
  const tail = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (tail) {
    const o = v4Octets(tail[1]!)
    if (!o) return null
    ip = ip.slice(0, -tail[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16)
  }
  const halves = ip.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < 0) return null
  const groups = [...head, ...Array(fill).fill("0"), ...rest].map((g) => parseInt(g, 16))
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null
  return groups
}

function embeddedV4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]
}

/** Which class an IP literal is in. Anything that is not a valid IP is `reserved`, so it is never allowed. */
export function addressClass(ip: string): AddressClass {
  const o = v4Octets(ip)
  if (o) return classifyV4(o)
  const g = v6Groups(ip)
  if (!g) return "reserved"
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0)
  if (zeroUpTo(7) && g[7] === 0) return "reserved" // ::
  if (zeroUpTo(7) && g[7] === 1) return "loopback" // ::1
  // v4 carried inside v6 is judged as the v4 it carries: mapped, compatible, NAT64, 6to4
  if (zeroUpTo(5) && g[5] === 0xffff) return classifyV4(embeddedV4(g[6]!, g[7]!))
  if (zeroUpTo(6)) return classifyV4(embeddedV4(g[6]!, g[7]!))
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return classifyV4(embeddedV4(g[6]!, g[7]!))
  if (g[0] === 0x2002) return classifyV4(embeddedV4(g[1]!, g[2]!))
  const first = g[0]!
  if ((first & 0xfe00) === 0xfc00) return "private" // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return "link-local" // fe80::/10
  if ((first & 0xffc0) === 0xfec0) return "private" // fec0::/10 site local (deprecated)
  if ((first & 0xff00) === 0xff00) return "reserved" // multicast
  if (first === 0x2001 && g[1] === 0x0db8) return "reserved" // documentation
  if (first === 0x2001 && g[1]! < 0x0200) return "reserved" // 2001::/23 IETF protocol (Teredo, ORCHID, benchmarking)
  if ((first & 0xe000) !== 0x2000) return "reserved" // only 2000::/3 is global unicast
  return "public"
}

function allowed(cls: AddressClass, allow: AllowNonPublic | undefined): boolean {
  if (cls === "public") return true
  if (cls === "loopback") return allow?.loopback === true
  if (cls === "private") return allow?.private === true
  if (cls === "link-local") return allow?.linkLocal === true
  return false
}

// ── Destination check ────────────────────────────────────────────────────────

export type Resolver = (host: string) => Promise<string[]>

const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

export interface SafeFetchOptions {
  /** Resolves a hostname to every address it answers with. Called once per hop. Default: system DNS. */
  resolve?: Resolver
  /** Non-public classes this caller may reach. Default: none (public addresses only). */
  allow?: AllowNonPublic
  /** Redirect hops followed when `redirect` is "follow". Default 5; 0 refuses any redirect. */
  maxRedirects?: number
  /** Refuse plain http, on the first request and on every hop. Default false. */
  httpsOnly?: boolean
  /** Deadline for the whole call, every hop included. Default 30 s. */
  timeoutMs?: number
  /** Extra trust roots (a private CA, a test certificate). Hostname verification is unchanged. */
  tls?: { ca?: string | string[] }
  /** Test seam: the fetch that speaks through the tunnel. Default: the runtime's fetch. */
  transport?: typeof fetch
}

/** A request that safeFetch would not send. Every refusal happens before any byte leaves for the destination. */
export class SafeFetchRefusal extends Error {
  constructor(readonly url: string, readonly reason: string) {
    super("safeFetch refused " + url + ": " + reason)
    this.name = "SafeFetchRefusal"
  }
}

export const DEFAULT_MAX_REDIRECTS = 5
export const DEFAULT_TIMEOUT_MS = 30_000

function hostOf(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, "")
}

function portOf(u: URL): number {
  return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80
}

/**
 * The one address a request to `url` may connect to, or a SafeFetchRefusal. The host is resolved
 * exactly once; every address it answers with must be allowed, and the first one is the pin.
 */
export async function checkDestination(url: string | URL, opts: SafeFetchOptions = {}): Promise<{ url: URL; address: string; port: number }> {
  let u: URL
  try { u = new URL(String(url)) } catch { throw new SafeFetchRefusal(String(url), "not a valid URL") }
  const shown = u.toString()
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new SafeFetchRefusal(shown, "scheme " + u.protocol + " is not http(s)")
  if (opts.httpsOnly && u.protocol !== "https:") throw new SafeFetchRefusal(shown, "https only")
  if (u.username || u.password) throw new SafeFetchRefusal(shown, "the URL carries credentials")
  const host = hostOf(u)
  if (!host) throw new SafeFetchRefusal(shown, "the URL names no host")

  let addresses: string[]
  if (net.isIP(host)) {
    addresses = [host]
  } else {
    const resolve = opts.resolve ?? systemResolver
    try { addresses = await resolve(host) } catch (e) { throw new SafeFetchRefusal(shown, host + " does not resolve (" + (e as Error).message + ")") }
    if (!Array.isArray(addresses) || addresses.length === 0) throw new SafeFetchRefusal(shown, host + " resolves to no address")
  }
  for (const a of addresses) {
    if (typeof a !== "string" || !net.isIP(a.replace(/%.*$/, ""))) throw new SafeFetchRefusal(shown, host + " answered with something that is not an address")
    const cls = addressClass(a)
    if (!allowed(cls, opts.allow)) throw new SafeFetchRefusal(shown, host + " resolves to " + a + ", a " + cls + " address")
  }
  return { url: u, address: addresses[0]!.replace(/%.*$/, ""), port: portOf(u) }
}

// ── The pinned tunnel ────────────────────────────────────────────────────────

const MAX_HEAD_BYTES = 16 * 1024

interface Tunnel {
  proxyUrl: string
  used: () => boolean
  close: () => void
}

/** True when a CONNECT authority or absolute-form target names exactly the validated host and port. */
function targetMatches(requestLine: string, want: URL): boolean {
  const parts = requestLine.split(" ")
  if (parts.length !== 3 || !/^HTTP\/1\.[01]$/.test(parts[2]!)) return false
  const [method, target] = parts as [string, string, string]
  let host: string
  let port: number
  if (method === "CONNECT") {
    const m = target.match(/^\[?([^\]]+?)\]?:(\d{1,5})$/)
    if (!m) return false
    host = m[1]!.toLowerCase()
    port = Number(m[2])
  } else {
    let t: URL
    try { t = new URL(target) } catch { return false }
    if (t.protocol !== want.protocol) return false
    host = hostOf(t).toLowerCase()
    port = portOf(t)
  }
  return host === hostOf(want).toLowerCase() && port === portOf(want)
}

/**
 * A listener on 127.0.0.1 that accepts one connection, checks that it asks for `want`'s host and
 * port, and joins it to `address:port`. Any other target gets a 403 and nothing is dialled.
 */
function openTunnel(want: URL, address: string, port: number, timeoutMs: number): Promise<Tunnel> {
  let used = false
  const sockets: net.Socket[] = []
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      server.close() // single use: no second connection is accepted
      used = true
      sockets.push(client)
      client.setTimeout(timeoutMs, () => client.destroy())
      client.on("error", () => client.destroy())
      let head = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk])
        const end = head.indexOf("\r\n\r\n")
        if (end === -1) {
          if (head.length > MAX_HEAD_BYTES) client.destroy()
          return
        }
        client.off("data", onData)
        client.pause()
        const requestLine = head.subarray(0, head.indexOf("\r\n")).toString("latin1")
        if (!targetMatches(requestLine, want)) {
          client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
          return
        }
        const isConnect = requestLine.startsWith("CONNECT ")
        const upstream = net.connect({ host: address, port })
        sockets.push(upstream)
        upstream.setTimeout(timeoutMs, () => upstream.destroy())
        upstream.on("error", () => { upstream.destroy(); client.destroy() })
        client.on("close", () => upstream.destroy())
        upstream.on("close", () => client.destroy())
        upstream.once("connect", () => {
          if (isConnect) {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
            const rest = head.subarray(end + 4)
            if (rest.length) upstream.write(rest)
          } else {
            upstream.write(head)
          }
          client.pipe(upstream)
          upstream.pipe(client)
          client.resume()
        })
      }
      client.on("data", onData)
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const p = (server.address() as net.AddressInfo).port
      resolve({
        proxyUrl: "http://127.0.0.1:" + p,
        used: () => used,
        close: () => { try { server.close() } catch {} },
      })
    })
  })
}

// ── safeFetch ────────────────────────────────────────────────────────────────

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"]
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"]

async function bodyBytes(body: BodyInit | null | undefined): Promise<ArrayBuffer | undefined> {
  if (body == null) return undefined
  return await new Response(body).arrayBuffer()
}

/**
 * fetch(input, init) with the destination checked and the connection pinned to the checked address,
 * on the first request and every redirect hop. Throws SafeFetchRefusal before sending anything to a
 * destination it refuses.
 */
export async function safeFetch(input: string | URL | Request, init: RequestInit = {}, opts: SafeFetchOptions = {}): Promise<Response> {
  const req = input instanceof Request ? input : null
  let url = req ? req.url : String(input)
  let method = (init.method ?? req?.method ?? "GET").toUpperCase()
  const headers = new Headers(req?.headers)
  new Headers(init.headers).forEach((v, k) => headers.set(k, v))
  let body = await bodyBytes(init.body ?? (req && req.body ? await req.arrayBuffer() : undefined))
  const mode = init.redirect ?? req?.redirect ?? "follow"
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = AbortSignal.timeout(timeoutMs)
  const callerSignal = init.signal ?? req?.signal ?? undefined
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline
  const transport = opts.transport ?? fetch

  for (let hop = 0; ; hop++) {
    signal.throwIfAborted()
    const dest = await checkDestination(url, opts)
    signal.throwIfAborted()
    const tunnel = await openTunnel(dest.url, dest.address, dest.port, timeoutMs)
    let res: Response
    try {
      res = await transport(dest.url.toString(), {
        ...init,
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "manual",
        signal,
        keepalive: false,
        proxy: tunnel.proxyUrl,
        tls: opts.tls?.ca ? { ca: opts.tls.ca } : undefined,
      } as RequestInit)
    } finally {
      tunnel.close()
    }
    if (!tunnel.used()) {
      await res.body?.cancel().catch(() => {})
      throw new SafeFetchRefusal(dest.url.toString(), "the transport did not go through the pinned connection")
    }

    const location = REDIRECTS.has(res.status) ? res.headers.get("location") : null
    if (!location || mode === "manual") return res
    await res.body?.cancel().catch(() => {})
    if (mode === "error") throw new SafeFetchRefusal(dest.url.toString(), "redirected (" + res.status + ") and redirects are refused")
    if (hop >= maxRedirects) {
      throw new SafeFetchRefusal(dest.url.toString(), maxRedirects === 0 ? "redirected (" + res.status + ") and redirects are refused" : "more than " + maxRedirects + " redirects")
    }

    let next: URL
    try { next = new URL(location, dest.url) } catch { throw new SafeFetchRefusal(dest.url.toString(), "redirect to an invalid location") }
    if (next.origin !== dest.url.origin) for (const h of CREDENTIAL_HEADERS) headers.delete(h)
    if (res.status === 303 ? method !== "HEAD" : (res.status === 301 || res.status === 302) && method === "POST") {
      method = "GET"
      body = undefined
      for (const h of BODY_HEADERS) headers.delete(h)
    }
    url = next.toString()
  }
}

/** safeFetch with fixed options, in fetch's shape, for code that takes an injected fetcher. */
export function createSafeFetch(opts: SafeFetchOptions = {}): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return (input, init) => safeFetch(input, init, opts)
}
