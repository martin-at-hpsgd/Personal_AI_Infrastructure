#!/usr/bin/env bun
/**
 * ReadIt.ts — read a piece of content aloud in the DA's Fish Audio voice.
 *
 *   bun ReadIt.ts read  (--file <path> | --text "<text>" | stdin) [--title "<t>"] [--voice <profile>]
 *   bun ReadIt.ts stop | pause | resume | status
 *   bun ReadIt.ts play --dir <runDir>            (internal: the detached player)
 *
 * `read` strips markdown residue, applies the principal's pronunciation overrides, splits the text into
 * chunks at paragraph then sentence boundaries, synthesizes the FIRST chunk, starts a detached player,
 * and returns. The player synthesizes the remaining chunks while earlier ones play, so the read starts
 * within seconds no matter how long the piece is. `stop`/`pause`/`resume`/`status` act on the state file.
 *
 * Voice: LIFEOS_CONFIG.toml [da.voices.reader] when it has a fish_reference_id, else [da.voices.main];
 * `--voice <name>` picks any profile with a fish_reference_id, or `principal` for the principal's clone.
 * Speech goes through FishTTS.ts (Drama 3; tags like [sigh] and <emphasis> pass through).
 * Key: FISH_API_KEY from the env file. Playback: macOS `afplay`. A headless channel (no
 * terminal identity, or LIFEOS_NOTIFICATION_CHANNEL=headless) never plays: the tool prints a skipped line
 * and exits 0. Audio and state live under ~/Library/Caches/LifeOS/ReadIt ($XDG_CACHE_HOME/lifeos-readit elsewhere).
 * Pure pieces (stripMarkdown, chunkText, applyPronunciations, state I/O) are exported for tests.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { cacheDir } from "../../../LIFEOS/TOOLS/lib/CacheDir.ts";
import { join } from "node:path";
import { getEnvPath } from "../../../LIFEOS/TOOLS/Paths.ts";
import { loadLifeosConfig, type LifeosVoiceSettings } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { getNotificationChannel } from "../../../hooks/lib/notification-channel.ts";
import { fishSpeak, resolveFishVoice } from "../../../LIFEOS/TOOLS/FishTTS.ts";
import { PAIRED_TAGS } from "../../../LIFEOS/TOOLS/VoiceTags.ts";

/** Per-request character cap. Fish takes at most 2,500 characters per request; this stays under it and keeps the first chunk fast. */
export const CHUNK_CAP = 2400;

/** A Fish voice: the reference id and the profile's pace (Fish prosody speed). */
export interface VoiceSettings { reference_id: string; speed?: number }
export interface ReadState {
  title: string;
  runDir: string;
  chunks: number;
  current: number;
  status: "starting" | "playing" | "paused" | "done" | "stopped" | "error";
  playerPid?: number;
  afplayPid?: number;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

// ---------- text preparation (pure) ----------

/** Backstop only: the model is expected to author a spoken script. This removes what a voice must never read. */
export function stripMarkdown(input: string): string {
  let t = input.replace(/\r\n?/g, "\n");
  t = t.replace(/```[\s\S]*?```/g, "\n");                       // fenced code blocks, content included
  t = t.replace(new RegExp(`<(?!/?(?:${PAIRED_TAGS.join("|")})>)[^>\\n]+>`, "g"), ""); // html tags; Drama 3 paired tags stay
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, "");                     // images
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");                  // links → text
  t = t.replace(/https?:\/\/\S+/g, "");                           // bare urls
  t = t.replace(/^[ \t]*#{1,6}[ \t]*/gm, "");                      // headers
  t = t.replace(/^[ \t]*>[ \t]?/gm, "");                           // blockquotes
  t = t.replace(/^[ \t]*[-*+][ \t]+/gm, "");                       // bullets
  t = t.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");                     // numbered lists
  t = t.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, ""); // table separators
  t = t.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_m, row: string) =>   // table rows → comma sentence
    row.split("|").map((c) => c.trim()).filter(Boolean).join(", ") + ".");
  t = t.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, "");                   // horizontal rules
  t = t.replace(/`([^`\n]*)`/g, "$1");                             // inline code → text
  t = t.replace(/\*\*|__/g, "");                                   // bold markers
  t = t.replace(/(^|[^\w])\*(?=\S)|(?<=\S)\*(?=[^\w]|$)/g, "$1");  // italic asterisks
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
  return t.trim();
}

// Pronunciation is the one LifeOS pass (LIFEOS/TOOLS/Pronounce.ts); fishSpeak runs it on every chunk, so ReadIt never
// runs its own. The names stay exported for importers.
export { applyPronunciations } from "../../../LIFEOS/TOOLS/Pronounce.ts";
export { principalPronunciations as loadPronunciations } from "../../../LIFEOS/TOOLS/Pronounce.ts";

export function splitSentences(paragraph: string): string[] {
  return paragraph.split(/(?<=[.!?…]["')\]]?)\s+(?=\S)/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Chunk caps ramp so the read starts fast: the first chunk is short (synthesizes in ~3 s), the next is
 * mid-sized, and everything after runs at CHUNK_CAP. Each later chunk synthesizes while the previous plays.
 */
export const CHUNK_RAMP = [450, 1200];
export function capFor(index: number, cap = CHUNK_CAP): number { return Math.min(CHUNK_RAMP[index] ?? cap, cap); }

/** Paragraph-first, sentence-second packing under the ramped cap. A single sentence over the cap is split at its last space. */
export function chunkText(text: string, cap = CHUNK_CAP): string[] {
  invariant(cap > 50, "chunk cap must be a usable size");
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  const units: { text: string; newPara: boolean }[] = [];
  for (const p of paragraphs) splitSentences(p).forEach((s, i) => units.push({ text: s, newPara: i === 0 }));

  const chunks: string[] = [];
  let cur = "";
  const flush = () => { if (cur) { chunks.push(cur); cur = ""; } };
  for (const u of units) {
    const limit = capFor(chunks.length, cap);
    const sep = cur ? (u.newPara ? "\n\n" : " ") : "";
    if (cur.length + sep.length + u.text.length <= limit) { cur += sep + u.text; continue; }
    flush();
    let rest = u.text;
    while (rest.length > capFor(chunks.length, cap)) {           // a single sentence over the cap: split at a space
      const lim = capFor(chunks.length, cap);
      const cut = rest.lastIndexOf(" ", lim);
      const at = cut > 0 ? cut : lim;
      chunks.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    cur = rest;
  }
  flush();
  invariant(chunks.every((c, i) => c.length <= capFor(i, cap)), "a chunk exceeded its cap");
  return chunks;
}

// ---------- voice ----------

export function toVoiceSettings(v: LifeosVoiceSettings | undefined, name: string): VoiceSettings {
  invariant(v?.fishReferenceId, `no fish_reference_id for [da.voices.${name}] in LIFEOS_CONFIG.toml`);
  return { reference_id: v.fishReferenceId, speed: v.fishSpeed };
}

/** `principal` → the principal's clone; [da.voices.<name>] when asked; else reader when it has a Fish voice; else main. */
export function pickVoice(name?: string, voices: Record<string, LifeosVoiceSettings | undefined> = loadLifeosConfig().da.voices): VoiceSettings {
  if (name === "principal") return { reference_id: resolveFishVoice("principal").referenceId };
  if (name) {
    invariant(voices[name], `no [da.voices.${name}] profile in LIFEOS_CONFIG.toml`);
    return toVoiceSettings(voices[name], name);
  }
  return voices.reader?.fishReferenceId ? toVoiceSettings(voices.reader, "reader") : toVoiceSettings(voices.main, "main");
}

function envValue(key: string): string {
  const text = readFileSync(getEnvPath(), "utf8");
  const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  const v = m?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  invariant(v, `missing ${key} in the env file`);
  return v;
}

export async function synthesize(text: string, voice: VoiceSettings, outPath: string, deps: { fetch?: typeof fetch; apiKey?: string } = {}): Promise<void> {
  const apiKey = deps.apiKey ?? process.env.FISH_API_KEY ?? envValue("FISH_API_KEY");
  const audio = await fishSpeak(text, { voice: { referenceId: voice.reference_id }, speed: voice.speed, apiKey, fetch: deps.fetch });
  invariant(audio.length > 1000, "Fish returned an empty audio body");
  writeFileSync(outPath, audio);
}

// ---------- state ----------

export function cacheRoot(): string {
  // Elsewhere: the owner-only XDG cache root, never the shared /tmp (the audio is what the DA just said; round-22 audit).
  const root = platform() === "darwin" ? join(homedir(), "Library", "Caches", "LifeOS", "ReadIt") : cacheDir("lifeos-readit");
  mkdirSync(root, { recursive: true });
  return root;
}
export function statePath(root = cacheRoot()): string { return join(root, "state.json"); }

export function readState(root = cacheRoot()): ReadState | null {
  const p = statePath(root);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as ReadState; } catch { return null; }
}

export function writeState(s: ReadState, root = cacheRoot()): void {
  invariant(s.title.length > 0, "state needs a title");
  invariant(s.chunks > 0 && s.current >= 0 && s.current <= s.chunks, "state chunk position out of range");
  invariant(existsSync(s.runDir), "state runDir must exist");
  s.updatedAt = new Date().toISOString();
  writeFileSync(statePath(root), JSON.stringify(s, null, 2) + "\n");
}

function chunkPath(runDir: string, i: number): string { return join(runDir, `${String(i).padStart(3, "0")}.mp3`); }

function isHeadless(): boolean { return getNotificationChannel() === "headless"; }

function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killQuietly(pid?: number, sig: NodeJS.Signals = "SIGTERM"): void {
  if (!pid) return;
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

async function probeDuration(path: string): Promise<number> {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error("ffprobe not found: install ffmpeg (brew install ffmpeg) so ReadIt can measure the first chunk");
  }
  const out = await new Response(p.stdout).text();
  await p.exited;
  const d = Number(out.trim());
  return Number.isFinite(d) ? d : 0;
}

// ---------- commands ----------

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readInput(args: string[]): Promise<string> {
  const file = argValue(args, "--file");
  if (file) { invariant(existsSync(file), `no such file: ${file}`); return readFileSync(file, "utf8"); }
  const text = argValue(args, "--text");
  if (text) return text;
  const stdin = await new Response(Bun.stdin.stream()).text();
  invariant(stdin.trim().length > 0, "nothing to read: pass --file, --text, or stdin");
  return stdin;
}

function stopCurrent(root: string): ReadState | null {
  const s = readState(root);
  if (!s) return null;
  if (s.status === "starting" || s.status === "playing" || s.status === "paused") {
    killQuietly(s.afplayPid, "SIGCONT");
    killQuietly(s.playerPid);
    killQuietly(s.afplayPid);
    s.status = "stopped";
    writeState(s, root);
  }
  return s;
}

async function cmdRead(args: string[]): Promise<void> {
  if (isHeadless()) { console.log("skipped: headless channel, nothing played"); return; }
  invariant(platform() === "darwin", "playback needs macOS afplay; other platforms are not wired yet");
  const raw = await readInput(args);
  const title = argValue(args, "--title") ?? raw.trim().split("\n")[0].replace(/^#+\s*/, "").slice(0, 80) ?? "untitled";
  const spoken = stripMarkdown(raw);
  invariant(spoken.length > 0, "nothing left to read after stripping markdown");
  const chunks = chunkText(spoken);
  const voice = pickVoice(argValue(args, "--voice"));

  const root = cacheRoot();
  stopCurrent(root);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "read";
  const runDir = join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "chunks.json"), JSON.stringify({ title, voice, chunks }, null, 2));
  writeFileSync(join(runDir, "spoken.txt"), spoken);

  // Claim the state before the first synthesis, so a stop (or a newer read) that lands while it runs is seen below.
  const state: ReadState = { title, runDir, chunks: chunks.length, current: 0, status: "starting", startedAt: new Date().toISOString(), updatedAt: "" };
  writeState(state, root);
  let first: number;
  try {
    await synthesize(chunks[0], voice, chunkPath(runDir, 0));
    first = await probeDuration(chunkPath(runDir, 0));
    invariant(first > 0, "first chunk has no playable duration");
  } catch (e) {
    const s = readState(root);
    if (s && s.runDir === runDir && s.status === "starting") { s.status = "error"; s.error = String(e); writeState(s, root); }
    throw e;
  }
  const claimed = readState(root);
  if (!claimed || claimed.runDir !== runDir || claimed.status !== "starting") { console.log(`stopped before playback: ${title}`); return; }

  // State first: the player reads it as soon as it starts and exits when it does not match its runDir.
  state.status = "playing";
  writeState(state, root);
  const child = spawn(process.execPath, [import.meta.path, "play", "--dir", runDir], { detached: true, stdio: "ignore", env: process.env });
  invariant(child.pid, "player did not start");
  child.unref();
  const started = readState(root);
  if (started && started.runDir === runDir) writeState({ ...started, playerPid: child.pid }, root);   // never over a newer read

  const words = spoken.split(/\s+/).length;
  const firstWords = chunks[0].split(/\s+/).length;
  const estMin = (words / firstWords) * first / 60;               // measured pace of chunk 0, scaled to the whole
  console.log(`reading: ${title}`);
  console.log(`chunks: ${chunks.length} · words: ${words} · about ${estMin < 1 ? "under a" : Math.round(estMin)} min · first chunk ${first.toFixed(1)}s`);
  console.log(`audio: ${runDir}`);
}

async function cmdPlay(args: string[]): Promise<void> {
  const runDir = argValue(args, "--dir");
  invariant(runDir && existsSync(runDir), "play needs --dir <runDir>");
  const root = cacheRoot();
  const { chunks, voice } = JSON.parse(readFileSync(join(runDir, "chunks.json"), "utf8")) as { chunks: string[]; voice: VoiceSettings };
  let current: ReturnType<typeof spawn> | null = null;
  const onSignal = () => { if (current?.pid) killQuietly(current.pid, "SIGKILL"); process.exit(0); };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const inflight = new Map<number, Promise<void>>();
  const ensure = (i: number): Promise<void> => {
    if (i >= chunks.length || existsSync(chunkPath(runDir, i))) return Promise.resolve();
    let p = inflight.get(i);
    if (!p) {
      p = synthesize(chunks[i], voice, chunkPath(runDir, i)).finally(() => inflight.delete(i));
      inflight.set(i, p);
    }
    return p;
  };

  let ahead: Promise<void> = ensure(1).catch(() => {});
  for (let i = 0; i < chunks.length; i++) {
    const s = readState(root);
    if (!s || s.runDir !== runDir || s.status === "stopped") return;
    try { await ensure(i); } catch (e) {
      const f = readState(root);                                    // a newer read may own the state by now
      if (f && f.runDir === runDir && f.status !== "stopped") { f.status = "error"; f.error = String(e); writeState(f, root); }
      return;
    }
    ahead = ensure(i + 1).catch(() => {});
    // A pause or stop that landed while this chunk was synthesizing holds the next chunk back.
    for (;;) {
      const w = readState(root);
      if (!w || w.runDir !== runDir || w.status === "stopped") return;
      if (w.status !== "paused") break;
      await Bun.sleep(200);
    }
    current = spawn("afplay", [chunkPath(runDir, i)], { stdio: "ignore" });
    const st = readState(root);
    if (!st || st.runDir !== runDir || st.status === "stopped") {   // replaced or stopped between the wait and the spawn
      killQuietly(current.pid, "SIGKILL");
      return;
    }
    st.current = i; st.afplayPid = current.pid; writeState(st, root);
    if (st.status === "paused") killQuietly(current.pid, "SIGSTOP");   // paused between the wait and the spawn
    await new Promise<void>((resolve) => current!.on("exit", () => resolve()));
    current = null;
  }
  await ahead;
  const done = readState(root);
  if (done && done.runDir === runDir && done.status !== "stopped") { done.status = "done"; done.current = chunks.length; done.afplayPid = undefined; writeState(done, root); }
}

function cmdStop(): void {
  const s = stopCurrent(cacheRoot());
  console.log(s ? `stopped: ${s.title} (chunk ${s.current + 1}/${s.chunks})` : "nothing playing");
}

function cmdPause(): void {
  const s = readState(cacheRoot());
  if (!s || s.status !== "playing") { console.log("nothing playing"); return; }
  killQuietly(s.afplayPid, "SIGSTOP");
  s.status = "paused"; writeState(s);
  console.log(`paused: ${s.title} (chunk ${s.current + 1}/${s.chunks})`);
}

function cmdResume(): void {
  const s = readState(cacheRoot());
  if (!s || s.status !== "paused") { console.log("nothing paused"); return; }
  killQuietly(s.afplayPid, "SIGCONT");
  s.status = "playing"; writeState(s);
  console.log(`resumed: ${s.title} (chunk ${s.current + 1}/${s.chunks})`);
}

function cmdStatus(): void {
  const s = readState(cacheRoot());
  if (!s) { console.log("no reads yet"); return; }
  const live = s.status === "playing" && !alive(s.playerPid) ? "playing (player gone)" : s.status;
  const elapsed = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000);
  console.log(`${live}: ${s.title} · chunk ${Math.min(s.current + 1, s.chunks)}/${s.chunks} · ${elapsed}s since start`);
  console.log(`audio: ${s.runDir}`);
  if (s.error) console.log(`error: ${s.error}`);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "read": await cmdRead(rest); break;
      case "play": await cmdPlay(rest); break;
      case "stop": cmdStop(); break;
      case "pause": cmdPause(); break;
      case "resume": cmdResume(); break;
      case "status": cmdStatus(); break;
      default:
        console.log("usage: ReadIt.ts read (--file <path> | --text <t> | stdin) [--title <t>] [--voice <profile>] | stop | pause | resume | status");
        process.exit(cmd ? 2 : 0);
    }
  } catch (e) {
    console.error(`readit: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
