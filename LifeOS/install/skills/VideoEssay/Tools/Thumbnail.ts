#!/usr/bin/env bun
/**
 * Thumbnail.ts — the DA house-style thumbnail: accent-colour border, big stacked title left,
 * the DA avatar bleeding off the right, dark authored ground. Rendered as a HyperFrames snapshot through the
 * shared seam (Compose.ts renderThumbnail).
 *
 *   bun Thumbnail.ts --run <slug|dir> [--bg <image>] [--verify]
 *
 * Title lines come from Script.json `thumbnail: { white: [...], accent: [...] }`. A background plate (an explainer's post
 * header image) comes from --bg or Script.json `thumbnail.background` (absolute, or relative to the run dir)
 * (falls back to the script title split one word per line). --verify samples the
 * four edges for the accent colour (Config.json colors.accent) and checks the size; a 320-px proof is written
 * beside the master for reading at YouTube size.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { loadLifeosConfig } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { HEIGHT, WIDTH, argValue, ensureDir, hasFlag, loadPalette, loadScript, publicDir, resolveRunDir, runPaths } from "./Lib.ts";
import { avatarPath, ensureAvatarCut } from "./Setup.ts";
import { renderThumbnail, THUMB_BORDER, type ThumbnailProps } from "./Compose.ts";
import { copyFileSync } from "node:fs";

export type { ThumbnailProps };
export const BORDER_PX = THUMB_BORDER;

/** The background plate path, from --bg or Script.json `thumbnail.background`, resolved against the run dir; undefined when neither names one. */
export function backgroundPath(runDir: string, script: { thumbnail?: { background?: string } }, flag?: string): string | undefined {
  const p = flag ?? script.thumbnail?.background;
  if (!p) return undefined;
  if (p.startsWith("~/")) return join(process.env.HOME ?? "", p.slice(2));
  return p.startsWith("/") ? p : join(runDir, p);
}

export function titleLines(script: { title: string; thumbnail?: { white?: string[]; accent?: string[] } }): { white: string[]; accent: string[] } {
  if (script.thumbnail?.white?.length || script.thumbnail?.accent?.length) return { white: script.thumbnail.white ?? [], accent: script.thumbnail.accent ?? [] };
  const words = script.title.toUpperCase().replace(/[^A-Z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 3);
  return { white: words.slice(0, -1), accent: words.slice(-1) };
}

async function sh(cmd: string[], cwd?: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed (${code}): ${err.slice(-400)}`);
  return out;
}

function hexDist(a: string, b: string): number {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0));
}

export async function verifyThumbnail(png: string, accent: string = loadPalette().accent): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  if (!existsSync(png)) return { ok: false, problems: ["thumbnail.png missing"] };
  const size = (await sh(["magick", "identify", "-format", "%w %h", png])).trim();
  if (size !== `${WIDTH} ${HEIGHT}`) problems.push(`size ${size} ≠ ${WIDTH} ${HEIGHT}`);
  const inset = Math.floor(BORDER_PX / 2);
  const samples: [number, number][] = [[inset, HEIGHT / 2], [WIDTH - 1 - inset, HEIGHT / 2], [WIDTH / 2, inset], [WIDTH / 2, HEIGHT - 1 - inset], [BORDER_PX - 2, BORDER_PX - 2]];
  for (const [x, y] of samples) {
    const hex = (await sh(["magick", png, "-format", `%[hex:p{${x},${y}}]`, "info:"])).trim().slice(0, 6);
    if (hexDist(`#${hex}`, accent) > 24) problems.push(`edge pixel (${x},${y}) is #${hex}, not the accent ${accent}`);
  }
  const inner = (await sh(["magick", png, "-format", `%[hex:p{${BORDER_PX + 40},${HEIGHT / 2}}]`, "info:"])).trim().slice(0, 6);
  if (hexDist(`#${inner}`, accent) <= 24) problems.push("border wider than the style allows (accent found 40px inside)");
  return { ok: problems.length === 0, problems };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runArg = argValue(argv, "--run");
  if (!runArg) { console.error("usage: Thumbnail.ts --run <slug|dir> [--verify]"); process.exit(2); }
  const dir = resolveRunDir(runArg);
  const paths = runPaths(dir);
  if (hasFlag(argv, "--verify")) {
    const r = await verifyThumbnail(paths.thumbnail);
    for (const p of r.problems) console.log(`✗ ${p}`);
    console.log(r.ok ? "✓ thumbnail verified" : "✗ thumbnail failed");
    process.exit(r.ok ? 0 : 1);
  }
  const script = loadScript(dir) as ReturnType<typeof loadScript> & { thumbnail?: { white?: string[]; accent?: string[]; background?: string } };
  // Its own project dir: the essay project owns runs/<slug>/index.html.
  const stage = ensureDir(join(publicDir(), "runs", script.slug, "thumbnail"));
  const avatar = avatarPath();
  invariant(existsSync(avatar), `avatar missing at ${avatar}`);
  copyFileSync(await ensureAvatarCut(), join(stage, "avatar-cut.png"));
  const bg = backgroundPath(dir, script, argValue(argv, "--bg"));
  invariant(!bg || existsSync(bg), `background image missing at ${bg}`);
  // The seam renders only what is local to the project: the plate is converted to a JPEG beside the avatar.
  // Blurred past legibility: the plate is colour and shape only. At 0x5 its labels and arrows still read, so the
  // layout judges saw the title and the avatar colliding with them (Proof, 2026-10-25).
  if (bg) await sh(["magick", bg, "-resize", "1920x1080^", "-blur", "0x18", "-quality", "90", join(stage, "background.jpg")]);
  const da = loadLifeosConfig().da;
  const palette = loadPalette();
  const props: ThumbnailProps = { ...titleLines(script), accentColor: palette.accent, ground: palette.darkInk.ground, ink: palette.darkInk.ink, daLabel: (da.displayName ?? da.name).toUpperCase(), ...(bg ? { background: "background.jpg" } : {}) };
  ensureDir(paths.out);
  await renderThumbnail(stage, props, paths.thumbnail);
  const proof = paths.thumbnail.replace(/\.png$/, "-320.png");
  await sh(["magick", paths.thumbnail, "-resize", "320x180", proof]);
  // The upload JPEG is written here, never by hand: q85 with full 4:4:4 chroma, since 4:2:0 softens the accent title's
  // edges. YouTube refuses a thumbnail over 2 MB.
  const jpg = paths.thumbnail.replace(/\.png$/, ".jpg");
  await sh(["magick", paths.thumbnail, "-sampling-factor", "1x1", "-quality", "85", jpg]);
  invariant(statSync(jpg).size <= 2 * 1024 * 1024, `${jpg} is over the 2 MB YouTube thumbnail limit`);
  const r = await verifyThumbnail(paths.thumbnail);
  for (const p of r.problems) console.log(`✗ ${p}`);
  console.log(`${r.ok ? "✓" : "✗"} ${paths.thumbnail} (proof: ${proof})`);
  process.exit(r.ok ? 0 : 1);
}
