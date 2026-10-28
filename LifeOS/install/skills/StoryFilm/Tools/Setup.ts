#!/usr/bin/env bun
/**
 * Setup.ts — one-time: the painter's dependency, the HyperFrames seam (pinned CLI, its Chrome, GSAP), the serif,
 * and the command-line tools the pipeline shells out to.
 *
 *   bun Setup.ts [--check]
 *
 * The film renders through LIFEOS/TOOLS/HyperFrames; provisioning the seam is the only step that reaches the
 * network, and only when its cached copy is missing. The serif comes from the skill config (`fonts.serif`,
 * `fonts.serifItalic`, paths to licensed faces, `#<index>` for one face of a collection); with none configured the
 * default serif is used, Source Serif 4 from the pinned `@fontsource/source-serif-4` dependency (SerifFont.ts).
 * `--check` provisions nothing and fails on anything missing.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstalled, HYPERFRAMES_VERSION, stageGsap } from "../../../LIFEOS/TOOLS/HyperFrames/HyperFrames.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { hasFlag, loadSkillConfig, provingRun, sh } from "./Lib.ts";
import { DEFAULT_SERIF_DIR, serifFaces } from "./SerifFont.ts";

export async function setup(opts: { check?: boolean } = {}): Promise<string[]> {
  const notes: string[] = [];
  const tools = import.meta.dir;
  const deps = existsSync(join(tools, "node_modules", "@google", "genai")) && existsSync(DEFAULT_SERIF_DIR);
  if (!deps) { invariant(!opts.check, "dependencies missing: the painter client or the default serif (run Setup.ts without --check)"); await sh(["bun", "install"], { cwd: tools }); notes.push("installed dependencies"); } else notes.push("deps ok");
  const work = mkdtempSync(join(tmpdir(), "storyfilm-setup-"));
  try {
    const faces = serifFaces(loadSkillConfig(), work);
    notes.push(`serif: ${faces.map((f) => f.style).join(" + ")}${loadSkillConfig().fonts?.serif ? " (configured)" : " (default: Source Serif 4)"}`);
    if (!opts.check) {
      const inst = await ensureInstalled();
      await stageGsap(work);
      notes.push(`hyperframes ${inst.version} + gsap ok`);
    } else notes.push(`hyperframes ${HYPERFRAMES_VERSION} (provisioned on first render)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  for (const bin of ["ffmpeg", "ffprobe", "whisper", "tesseract"]) {
    const r = await sh(["which", bin], { allowFail: true });
    // whisper and tesseract only feed Verify's speech and caption checks: setup notes them, --check refuses without them.
    notes.push(r.code === 0 ? `${bin} ok` : `${bin} MISSING`);
    invariant(r.code === 0 || (!opts.check && (bin === "whisper" || bin === "tesseract")), `${bin} is required`);
  }
  return notes;
}

if (import.meta.main && hasFlag(process.argv.slice(2), "--proving-run")) {
  try { console.log(provingRun()); process.exit(0); } catch (e) { console.error((e as Error).message); process.exit(1); }
}
if (import.meta.main) {
  const notes = await setup({ check: hasFlag(process.argv.slice(2), "--check") });
  for (const n of notes) console.log(`${n.endsWith(" MISSING") ? "✗" : "✓"} ${n}`);
}
