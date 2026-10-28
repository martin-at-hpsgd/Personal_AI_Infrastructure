// modules/talk.ts — Talk: a live voice conversation beside a working Claude Code session.
//
// Talk is off and its voice side is gone (the page and agent it ran on were a third-party
// conversational agent; it is rebuilt on Fish later, so GET /talk answers 410). What remains is the
// session plumbing: what the principal settles out loud arrives here as POST /talk/handoff and
// streams to the session's bridge (GET /talk/inbox, SSE), which submits it into the session. The
// session's progress arrives as POST /talk/progress and streams to a page (GET /talk/events, SSE).
// Loopback only: every route refuses a tunnel-origin request.
//
// Doc: LIFEOS/DOCUMENTATION/VoiceMode/VoiceMode.md § Talk · Tool: LIFEOS/TOOLS/Talk.ts

import { readFileSync } from "node:fs"
import { TALK_OFF_MESSAGE, talkEnabled } from "../../TOOLS/Talk"

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_TEXT = 4000
const KEEP = 50

type Item = { id: number; text: string; at: string; delivered?: boolean }
type Channel = { items: Item[]; next: number; subs: Set<(event: string, data: string) => void> }

const inbox = new Map<string, Channel>()
const progress = new Map<string, Channel>()

function channel(map: Map<string, Channel>, session: string): Channel {
  let c = map.get(session)
  if (!c) { c = { items: [], next: 1, subs: new Set() }; map.set(session, c) }
  return c
}

function push(map: Map<string, Channel>, session: string, event: string, text: string): Item {
  const c = channel(map, session)
  const item: Item = { id: c.next++, text, at: new Date().toISOString() }
  c.items.push(item)
  if (c.items.length > KEEP) c.items.shift()
  item.delivered = c.subs.size > 0
  for (const send of c.subs) send(event, JSON.stringify(item))
  return item
}

/** End a session's talk: the bridge exits and the page is told. */
export function endTalk(session: string): void {
  for (const map of [inbox, progress]) for (const send of map.get(session)?.subs ?? []) send("end", "{}")
}

function sse(map: Map<string, Channel>, session: string, replayFrom: number | null): Response {
  const c = channel(map, session)
  let send: ((event: string, data: string) => void) | null = null
  let ping: ReturnType<typeof setInterval> | null = null
  const stream = new ReadableStream({
    start(ctrl) {
      const enc = new TextEncoder()
      send = (event, data) => { try { ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`)) } catch {} }
      // The page replays progress after `since`; the bridge gets every hand-off no bridge has taken
      // yet, so one made before the bridge connected still reaches the session, exactly once.
      if (map === inbox) for (const it of c.items) { if (!it.delivered) { it.delivered = true; send("handoff", JSON.stringify(it)) } }
      else if (replayFrom !== null) for (const it of c.items) if (it.id > replayFrom) send("progress", JSON.stringify(it))
      c.subs.add(send)
      ping = setInterval(() => { try { ctrl.enqueue(enc.encode(": ping\n\n")) } catch {} }, 15_000)
    },
    cancel() {
      if (send) c.subs.delete(send)
      if (ping) clearInterval(ping)
    },
  })
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } })
}

/** Context for the voice agent, built only from ISA lines (ISC-55): L3, open criteria, fog. */
export function isaContext(isaText: string): string {
  const lines = isaText.split("\n")
  const section = (h: RegExp) => {
    const i = lines.findIndex((l) => h.test(l))
    if (i < 0) return [] as string[]
    const out: string[] = []
    for (let j = i + 1; j < lines.length && !/^#{2,3} /.test(lines[j]); j++) if (lines[j].trim()) out.push(lines[j].trim())
    return out
  }
  const l3 = section(/^### L3/).join(" ")
  const open = lines.filter((l) => /^- \[ \] ISC-/.test(l)).map((l) => l.replace(/^- \[ \] /, "")).slice(0, 15)
  const fog = lines.filter((l) => /^- fog: /.test(l)).map((l) => l.replace(/^- fog: /, "")).slice(0, 5)
  return [
    l3 && `The session's ideal state: ${l3}`,
    open.length ? `Open criteria (${open.length} shown):\n${open.join("\n")}` : "",
    fog.length ? `Still unclear:\n${fog.join("\n")}` : "",
  ].filter(Boolean).join("\n\n")
}

// Same rule as gptlive.ts: a tunnel may forward a loopback Host, so a proxy header or a
// non-loopback Host also marks the request as tunnel-origin.
const PROXY_HEADERS = ["cf-connecting-ip", "cf-connecting-ipv6", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"]
const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)(:\d+)?$/
export function isTunnelOrigin(req: Request): boolean {
  const host = (req.headers.get("host") ?? "").trim().toLowerCase()
  return host.endsWith(".internal") || PROXY_HEADERS.some((h) => req.headers.has(h)) || !LOOPBACK_HOST.test(host)
}

export async function handleTalkRequest(req: Request, pathname: string): Promise<Response | null> {
  if (pathname !== "/talk" && !pathname.startsWith("/talk/")) return null
  if (isTunnelOrigin(req)) return new Response("not found", { status: 404 })
  if (!talkEnabled()) return new Response(TALK_OFF_MESSAGE, { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8" } })
  const url = new URL(req.url)
  const session = url.searchParams.get("session") ?? ""

  // The talk page was the third-party agent's client; with it gone there is no page to serve until Talk is rebuilt on Fish.
  if (pathname === "/talk" && req.method === "GET") return new Response(TALK_OFF_MESSAGE, { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8" } })

  // Everything below is per session.
  if (!SAFE_ID.test(session) && !(req.method === "POST")) return Response.json({ error: "session required" }, { status: 400 })

  if (pathname === "/talk/context" && req.method === "GET") {
    try {
      const { sessionIsaPath } = await import("../../../hooks/VoiceMode.hook.ts")
      const path = sessionIsaPath(session)
      const text = path ? readFileSync(path, "utf8") : ""
      return Response.json({ isa: path, context: text ? isaContext(text) : "" })
    } catch (err) {
      return Response.json({ isa: null, context: "", error: String(err) })
    }
  }

  if (pathname === "/talk/inbox" && req.method === "GET") return sse(inbox, session, null)
  if (pathname === "/talk/events" && req.method === "GET") return sse(progress, session, Number(url.searchParams.get("since") ?? 0))

  if (req.method === "POST" && ["/talk/handoff", "/talk/progress", "/talk/end"].includes(pathname)) {
    let body: Record<string, unknown>
    try { body = (await req.json()) as Record<string, unknown> } catch { return Response.json({ error: "invalid json" }, { status: 400 }) }
    const s = String(body.session ?? "")
    if (!SAFE_ID.test(s)) return Response.json({ error: "session required" }, { status: 400 })
    if (pathname === "/talk/end") { endTalk(s); return Response.json({ ok: true }) }
    if (pathname === "/talk/handoff") {
      const verbatim = String(body.verbatim ?? "").slice(0, MAX_TEXT).trim()
      const summary = String(body.summary ?? "").slice(0, MAX_TEXT).trim()
      if (!verbatim) return Response.json({ error: "verbatim required" }, { status: 400 })
      const item = push(inbox, s, "handoff", JSON.stringify({ verbatim, summary }))
      return Response.json({ ok: true, id: item.id, listeners: channel(inbox, s).subs.size })
    }
    const text = String(body.text ?? "").slice(0, MAX_TEXT).trim()
    if (!text) return Response.json({ error: "text required" }, { status: 400 })
    const item = push(progress, s, "progress", text)
    return Response.json({ ok: true, id: item.id })
  }

  return null
}
