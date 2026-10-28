#!/usr/bin/env bun

/**
 * @version 1.7.0
 * add-bg - Add Background Color CLI
 *
 * Add a solid background color to transparent PNG images.
 * Part of the Art skill for LifeOS system.
 * (Images was retired and folded into Art — ported from public PR #1707
 * (commit 1), @anikinsasha.)
 *
 * Usage:
 *   add-bg input.png "#F5F5F0" output.png
 *   add-bg input.png --brand output.png
 *
 * Config: --brand reads `brandColor` from <userDir>/CONFIG/add-bg.json
 * (userDir from LifeosConfig, normally LIFEOS/USER) → { "brandColor": "#RRGGBB" }.
 *
 * @see ~/.claude/skills/Art/SKILL.md
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lifeosUserDir } from "./LifeosConfig";

const execFileAsync = promisify(execFile);

// Per-install brand background lives in USER config, never in this file.
const BRAND_CONFIG_REL = join("CONFIG", "add-bg.json");

function brandConfigPath(): string {
  return join(lifeosUserDir(), BRAND_CONFIG_REL);
}

/** Read the install's brand color, or exit with an error naming the file and key. */
function loadBrandColor(): string {
  const path = brandConfigPath();
  if (!existsSync(path)) {
    console.error(`❌ --brand needs ${path} with a "brandColor" key, e.g. { "brandColor": "#F5F5F0" }`);
    process.exit(1);
  }
  let color: unknown;
  try {
    color = JSON.parse(readFileSync(path, "utf8"))?.brandColor;
  } catch (error) {
    console.error(`❌ Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (typeof color !== "string" || !color) {
    console.error(`❌ ${path} has no "brandColor" key (expected "#RRGGBB")`);
    process.exit(1);
  }
  return color;
}

// ============================================================================
// Help
// ============================================================================

function showHelp(): void {
  console.log(`
add-bg - Add Background Color CLI

Add a solid background color to transparent PNG images using ImageMagick.

USAGE:
  add-bg <input> <color> <output>
  add-bg <input> --brand <output>

ARGUMENTS:
  input       Path to transparent PNG image
  color       Hex color code (e.g., "#F5F5F0") OR --brand
  output      Path to save result

OPTIONS:
  --brand     Use your brand background color, read from
              <userDir>/CONFIG/add-bg.json key "brandColor"

EXAMPLES:
  # Add your brand background for a thumbnail
  add-bg header.png --brand header-thumb.png

  # Add custom background color
  add-bg header.png "#FFFFFF" header-white.png

  # Add dark background
  add-bg logo.png "#1a1a1a" logo-dark.png

REQUIREMENTS:
  ImageMagick must be installed (magick command)

CONFIG:
  ${brandConfigPath()}
  { "brandColor": "#RRGGBB" }

ERROR CODES:
  0  Success
  1  Error (file not found, invalid color, missing brand config, ImageMagick error)
`);
  process.exit(0);
}

// ============================================================================
// Validation
// ============================================================================

function validateHexColor(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
}

// ============================================================================
// Add Background
// ============================================================================

async function addBackground(
  inputPath: string,
  hexColor: string,
  outputPath: string
): Promise<void> {
  // Validate input file exists
  if (!existsSync(inputPath)) {
    console.error(`❌ File not found: ${inputPath}`);
    process.exit(1);
  }

  // Validate hex color
  if (!validateHexColor(hexColor)) {
    console.error(`❌ Invalid hex color: ${hexColor}`);
    console.error('   Must be in format #RRGGBB (e.g., "#F5F5F0")');
    process.exit(1);
  }

  console.log(`🎨 Adding background ${hexColor} to ${inputPath}`);

  // Use ImageMagick to composite the transparent image onto a colored background.
  // execFile with array args: paths are passed directly to magick, never through a shell.
  try {
    await execFileAsync("magick", [inputPath, "-background", hexColor, "-flatten", outputPath]);
    console.log(`✅ Saved: ${outputPath}`);
  } catch (error) {
    console.error(
      `❌ ImageMagick error:`,
      error instanceof Error ? error.message : String(error)
    );
    console.error("   Make sure ImageMagick is installed: brew install imagemagick");
    process.exit(1);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Check for help
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    showHelp();
  }

  // Need at least 3 args: input, color/--brand, output
  if (args.length < 3) {
    console.error("❌ Missing arguments");
    console.error("   Usage: add-bg <input> <color|--brand> <output>");
    process.exit(1);
  }

  const inputPath = args[0];
  const colorArg = args[1];
  const outputPath = args[2];

  // --brand resolves to the install's configured brand color. Any other flag in the
  // color slot (including the pre-1.7 brand flag) is refused with the flag to use.
  if (colorArg.startsWith("--") && colorArg !== "--brand") {
    console.error(`❌ Unknown flag in the color slot: ${colorArg}`);
    console.error("   Use --brand for the configured brand color, or a #RRGGBB hex color");
    process.exit(1);
  }
  const hexColor = colorArg === "--brand" ? loadBrandColor() : colorArg;

  await addBackground(inputPath, hexColor, outputPath);
}

main();
