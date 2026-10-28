#!/usr/bin/env bun
/**
 * VoiceReceiver.ts — plays the DA's voice on a machine that is not the one running LifeOS.
 *
 * One self-contained file, no imports, no keys, no LifeOS checkout. The desktop's voice server POSTs each finished
 * MP3 here over Tailscale when the principal is attached from this machine; this file only plays it.
 *
 *   bun VoiceReceiver.ts --install --allow <desktop tailnet IP>   write + load the login item, then exit
 *   bun VoiceReceiver.ts --uninstall                               unload and remove the login item
 *   bun VoiceReceiver.ts --allow <ip>                              run in the foreground
 *
 * Routes: GET /health → {ok,version}; POST /play (body = MP3 or WAV, headers X-Voice-Volume, X-Voice-Ext) → plays it after
 * any clip already playing; POST /stop → stops the current clip and drops the queue.
 * Every request from an address other than --allow is refused with 403.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

export const VERSION = "1.0.0"
export const PORT = Number(process.env.VOICE_RECEIVER_PORT || 7790)
const LABEL = "com.lifeos.voice-receiver"
const MAX_CLIP_BYTES = 20 * 1024 * 1024

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** True when this request may play audio here: only the one allowed desktop address. */
export function allowed(remote: string | undefined, allow: string): boolean {
  if (!remote) return false
  return remote.replace(/^::ffff:/, "") === allow
}

function install(allow: string): void {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(allow)) throw new Error("--install needs --allow <desktop tailnet IPv4>")
  const dir = join(homedir(), ".voice-receiver")
  mkdirSync(dir, { recursive: true })
  const self = join(dir, "VoiceReceiver.ts")
  copyFileSync(import.meta.path, self)
  const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${self}</string><string>--allow</string><string>${allow}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${join(dir, "receiver.log")}</string>
  <key>StandardOutPath</key><string>${join(dir, "receiver.log")}</string>
</dict></plist>
`)
  const uid = process.getuid?.() ?? 501
  spawn("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" }).on("exit", () => {
    const p = spawn("launchctl", ["bootstrap", `gui/${uid}`, plist], { stdio: "inherit" })
    p.on("exit", (code) => {
      console.log(code === 0 ? `voice receiver installed: ${self}, listening on :${PORT} for ${allow}` : `launchctl bootstrap exited ${code}`)
      process.exit(code ?? 1)
    })
  })
}

function uninstall(): void {
  const uid = process.getuid?.() ?? 501
  const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
  spawn("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" }).on("exit", () => {
    rmSync(plist, { force: true })
    rmSync(join(homedir(), ".voice-receiver"), { recursive: true, force: true })
    console.log("voice receiver removed")
    process.exit(0)
  })
}

export function serve(allow: string, play: (file: string, volume: number) => ChildProcess = (f, v) => spawn("afplay", ["-v", String(v), f])) {
  let current: ChildProcess | null = null
  let chain: Promise<void> = Promise.resolve()
  let gen = 0
  const dir = mkdtempSync(join(tmpdir(), "voice-receiver-"))

  return Bun.serve({
    port: PORT,
    async fetch(req, server) {
      const remote = server.requestIP(req)?.address
      if (!allowed(remote, allow)) return new Response("forbidden", { status: 403 })
      const { pathname } = new URL(req.url)
      if (req.method === "GET" && pathname === "/health") return Response.json({ ok: true, version: VERSION })
      if (req.method === "POST" && pathname === "/stop") {
        gen++
        current?.kill("SIGTERM")
        return Response.json({ stopped: true })
      }
      if (req.method === "POST" && pathname === "/play") {
        const audio = new Uint8Array(await req.arrayBuffer())
        if (audio.byteLength === 0 || audio.byteLength > MAX_CLIP_BYTES) return new Response("bad clip", { status: 400 })
        const volume = Math.min(2, Math.max(0, Number(req.headers.get("x-voice-volume") ?? 1) || 1))
        const ext = req.headers.get("x-voice-ext") === "wav" ? "wav" : "mp3"
        const file = join(dir, `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
        writeFileSync(file, audio)
        const myGen = gen
        chain = chain.then(() => new Promise<void>((resolve) => {
          if (myGen !== gen) { rmSync(file, { force: true }); return resolve() }
          current = play(file, volume)
          current.on("exit", () => { current = null; rmSync(file, { force: true }); resolve() })
          current.on("error", () => { current = null; rmSync(file, { force: true }); resolve() })
        }))
        return Response.json({ queued: true })
      }
      return new Response("not found", { status: 404 })
    },
  })
}

if (import.meta.main) {
  if (process.argv.includes("--uninstall")) uninstall()
  else {
    const allow = arg("--allow")
    if (!allow) { console.error("usage: bun VoiceReceiver.ts [--install] --allow <desktop tailnet IP>  |  --uninstall"); process.exit(2) }
    if (process.argv.includes("--install")) install(allow)
    else { serve(allow); console.log(`voice receiver ${VERSION} on :${PORT}, accepting ${allow}`) }
  }
}
