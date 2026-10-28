#!/usr/bin/env bun
/**
 * WatchFilm.ts — a full watch-and-listen pass over a PUBLIC reference film with the top Gemini
 * model: shot list with timestamps, cut rhythm, hook, how the product is shown, type, colour,
 * sound and beat sync, structure, and the reproducible craft techniques. A contact sheet shows
 * frames; only this pass hears the music and SFX, which is where most of a launch film's pace lives.
 *
 * Usage:
 *   bun WatchFilm.ts <film.mp4> [more.mp4 ...] [--out-dir <dir>]
 *
 * Writes <film>-watch.md next to each film (or into --out-dir). Needs GOOGLE_API_KEY in the
 * canonical .env. Send public films by default; private films and unreleased cuts go only when the
 * install's vendor policy trusts Google with them (USER CUSTOMIZATIONS/SKILLS/HyperFrames/PREFERENCES.md).
 * That policy is the caller's to apply before running this: the tool cannot tell a public film from a
 * private cut, does not read PREFERENCES.md, and uploads every path it is given.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CROSS_VENDOR } from "../../../LIFEOS/TOOLS/models.ts";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";

const API = "https://generativelanguage.googleapis.com";

export const WATCH_PROMPT = `You are a senior motion designer studying a product launch film that people online praised. Watch and listen to all of it. Produce:

1. SHOT LIST: every shot or visual change with start-end timestamps (mm:ss.s), what is on screen, what moves and how (camera move, easing, transition into the next shot), on-screen text verbatim, and the sound or music hit it lands on.
2. CUT RHYTHM: shot count, average, longest and shortest shot.
3. HOOK: exactly what the first 2 seconds show and why it grabs.
4. PRODUCT: how the product is shown (full screen, cropped, rebuilt as components, 3D, abstracted), and how many distinct product moments.
5. TYPE: faces, weights, size relative to the frame, how text enters and leaves, words per card.
6. COLOR & DEPTH: palette, backgrounds, gradients, glow, grain, blur, parallax, shadows.
7. SOUND: music genre and tempo, whether cuts land on beats, SFX, voiceover or none.
8. STRUCTURE: the beat sequence with timestamps.
9. WHAT MAKES IT LOOK EXPENSIVE: the 8 most specific craft techniques, each concrete enough that a programmer writing HTML and GSAP could reproduce it.
10. WEAKNESSES: anything cheap or generic.
Be literal and specific. No praise language.`;

function apiKey(): string {
  try {
    const m = readFileSync(join(getClaudeDir(), ".env"), "utf-8").match(/^GOOGLE_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch { /* fall through */ }
  return process.env.GOOGLE_API_KEY ?? "";
}

async function upload(path: string, H: Record<string, string>): Promise<{ name: string; uri: string }> {
  const size = statSync(path).size;
  const start = await fetch(`${API}/upload/v1beta/files`, {
    method: "POST",
    headers: { ...H, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(size), "X-Goog-Upload-Header-Content-Type": "video/mp4", "Content-Type": "application/json" },
    body: JSON.stringify({ file: { display_name: basename(path) } }),
  });
  const url = start.headers.get("x-goog-upload-url");
  if (!start.ok || !url) throw new Error(`upload start HTTP ${start.status}: ${await start.text()}`);
  const up = await fetch(url, { method: "POST", headers: { ...H, "Content-Length": String(size), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: readFileSync(path) });
  const info = (await up.json()) as any;
  if (!up.ok || !info.file?.name) throw new Error(`upload HTTP ${up.status}: ${JSON.stringify(info).slice(0, 300)}`);
  const t0 = Date.now();
  while (Date.now() - t0 < 10 * 60_000) {
    const f = (await (await fetch(`${API}/v1beta/${info.file.name}`, { headers: H })).json()) as any;
    if (f.state === "ACTIVE") return { name: info.file.name, uri: info.file.uri };
    if (f.state === "FAILED") throw new Error(`Gemini could not process ${path}`);
    await Bun.sleep(4000);
  }
  throw new Error(`${path} not processed after 10 minutes`);
}

export async function watch(path: string, outDir?: string): Promise<string> {
  const key = apiKey();
  if (!key) throw new Error("GOOGLE_API_KEY is not set in the canonical .env");
  const H = { "x-goog-api-key": key };
  const f = await upload(path, H);
  try {
    const r = await fetch(`${API}/v1beta/models/${CROSS_VENDOR.gemini}:generateContent`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ file_data: { mime_type: "video/mp4", file_uri: f.uri } }, { text: WATCH_PROMPT }] }] }),
    });
    const j = (await r.json()) as any;
    const text: string | undefined = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("");
    if (!r.ok || !text) throw new Error(`generateContent HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const out = join(outDir ?? dirname(path), basename(path).replace(/\.[^.]+$/, "-watch.md"));
    writeFileSync(out, text);
    return out;
  } finally {
    await fetch(`${API}/v1beta/${f.name}`, { method: "DELETE", headers: H }).catch(() => undefined);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--out-dir");
  const outDir = i >= 0 ? args[i + 1] : undefined;
  const films = args.filter((a, k) => !a.startsWith("-") && (i < 0 || k !== i + 1));
  if (!films.length) {
    console.log("Usage: bun WatchFilm.ts <film.mp4> [more.mp4 ...] [--out-dir <dir>]");
    process.exit(2);
  }
  const results = await Promise.allSettled(films.map(f => watch(f, outDir)));
  results.forEach((r, k) => console.log(r.status === "fulfilled" ? `watched: ${r.value}` : `FAILED ${films[k]}: ${r.reason}`));
  process.exit(results.every(r => r.status === "fulfilled") ? 0 : 1);
}
