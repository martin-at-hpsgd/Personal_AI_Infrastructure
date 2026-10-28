#!/usr/bin/env bun

/**
 * @version 1.6.0
 * remove-bg - Background Removal CLI
 *
 * Remove backgrounds from images using local rembg.
 * Part of the Art skill for LifeOS system.
 * (Images was retired and folded into Art — ported from public PR #1707
 * (commit 1), @anikinsasha.)
 *
 * Usage:
 *   remove-bg input.png                            # Overwrites original
 *   remove-bg input.png output.png                 # Saves to output (always; an existing output is replaced)
 *   remove-bg --batch file1.png file2.png file3.png # Batch: each file cut in place
 *
 * Two paths always mean input and output. Batch needs the explicit --batch flag, so an
 * existing output path can never turn an input/output call into a double in-place cut
 * (the old form batch-cut both files whenever the second path already existed).
 */

import { resolve, extname } from "node:path";
import { existsSync } from "node:fs";
import { unlink, stat, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

function resolveRembgBin(): string {
  if (process.env.REMBG_BIN) return process.env.REMBG_BIN;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  if (!home) throw new Error("HOME not set; cannot resolve rembg binary");
  return resolve(home, ".local/bin/rembg");
}

function showHelp(): void {
  const bin = resolveRembgBin();
  console.log(`
remove-bg - Background Removal CLI

Remove backgrounds from images using local rembg (no API).

USAGE:
  remove-bg <input> [output]           Single file (two paths are always input and output)
  remove-bg --batch <file1> <file2> ...
                                       Batch process (overwrites originals)

ARGUMENTS:
  input     Path to image file (PNG, JPG, JPEG, WebP)
  output    Optional output path (defaults to overwriting input)

EXAMPLES:
  remove-bg header.png
  remove-bg header.jpg header-transparent.png
  remove-bg --batch diagram1.png diagram2.png diagram3.png

NOTES:
  - rembg always produces PNG output (alpha channel required)
  - If input is .jpg/.jpeg/.webp and you overwrite, the file is renamed to .png
  - Requires rembg at ${bin} (override via REMBG_BIN env var)
    Install: pipx install rembg  (or: uv tool install rembg)
`);
  process.exit(0);
}

function runRembg(bin: string, input: string, output: string): Promise<void> {
  return new Promise((resolveFn, rejectFn) => {
    const proc = spawn(bin, ["i", input, output], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", (err) => rejectFn(new Error(`Failed to launch rembg: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolveFn();
      else rejectFn(new Error(`rembg exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function removeBackground(inputPath: string, outputPath?: string): Promise<void> {
  const bin = resolveRembgBin();
  if (!existsSync(bin)) {
    console.error(`❌ rembg not found at ${bin}`);
    console.error("   Install: pipx install rembg  (or: uv tool install rembg)");
    console.error("   Override path: export REMBG_BIN=/path/to/rembg");
    process.exit(1);
  }

  if (!existsSync(inputPath)) {
    console.error(`❌ File not found: ${inputPath}`);
    process.exit(1);
  }

  const inputExt = extname(inputPath).toLowerCase();
  let target = outputPath ?? inputPath;
  let renameAfter: { from: string; to: string } | null = null;
  if (!outputPath && inputExt !== ".png") {
    target = inputPath.replace(/\.[^.]+$/, ".png");
    renameAfter = { from: inputPath, to: target };
  }

  console.log(`🔲 Removing background: ${inputPath}`);
  const start = Date.now();
  // Always cut to a temp file first, then move into place. Passing the same
  // path as both input and output makes rembg TRUNCATE its own input to 0 bytes
  // before it reads it — the 2026-06-08 in-place-zeroing bug that silently
  // destroyed the source and failed with "cannot identify image file". A temp
  // file makes every path safe: in-place .png, explicit same-path output, and
  // jpg/webp→png all route through a distinct file rembg can actually read.
  const tmp = `${target}.rembg-tmp-${process.pid}.png`;
  try {
    await runRembg(bin, inputPath, tmp);
  } catch (error) {
    try { await unlink(tmp); } catch {}
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // Move temp → target (overwrites safely; same dir means an atomic rename).
  try {
    await rename(tmp, target);
  } catch {
    try { await unlink(tmp); } catch {}
    console.error(`❌ Failed to move result into place: ${target}`);
    process.exit(1);
  }

  // If we converted jpg/webp → png at a NEW path, remove the original source.
  if (renameAfter && renameAfter.from !== renameAfter.to) {
    try { await unlink(renameAfter.from); } catch {}
  }

  const elapsed = Date.now() - start;
  let dims = "";
  try {
    const s = await stat(target);
    dims = ` (${(s.size / 1024).toFixed(0)}KB)`;
  } catch {}
  console.log(`✅ Saved: ${target}${dims} in ${elapsed}ms`);
}

export type RemoveBgCommand =
  | { mode: "help" }
  | { mode: "single"; input: string; output?: string }
  | { mode: "batch"; files: string[] }
  | { mode: "error"; message: string };

/**
 * Reads the CLI arguments. One path cuts in place; two paths are always input and output, whether
 * or not the output exists; batch needs --batch. Three or more paths without --batch are refused
 * rather than guessed at.
 */
export function parseRemoveBgArgs(args: string[]): RemoveBgCommand {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { mode: "help" };
  const batch = args.includes("--batch");
  const paths = args.filter((a) => a !== "--batch");
  const unknown = paths.find((a) => a.startsWith("--"));
  if (unknown) return { mode: "error", message: `Unknown flag: ${unknown}` };
  if (batch) {
    if (paths.length === 0) return { mode: "error", message: "--batch needs at least one file" };
    return { mode: "batch", files: paths };
  }
  if (paths.length === 1) return { mode: "single", input: paths[0] };
  if (paths.length === 2) return { mode: "single", input: paths[0], output: paths[1] };
  return { mode: "error", message: `${paths.length} paths given: pass --batch to cut each file in place, or exactly two paths for input and output` };
}

async function main(): Promise<void> {
  const cmd = parseRemoveBgArgs(process.argv.slice(2));

  if (cmd.mode === "help") showHelp();
  if (cmd.mode === "error") {
    console.error(`❌ ${cmd.message}`);
    process.exit(2);
  }
  if (cmd.mode === "single") {
    await removeBackground(cmd.input, cmd.output);
    return;
  }
  if (cmd.mode !== "batch") return;

  console.log(`🔲 Batch processing ${cmd.files.length} files...\n`);
  let success = 0;
  let failed = 0;

  for (const file of cmd.files) {
    try {
      await removeBackground(file);
      success++;
    } catch {
      failed++;
    }
  }

  console.log(`\n📊 Complete: ${success} succeeded, ${failed} failed`);
}

if (import.meta.main) main();
