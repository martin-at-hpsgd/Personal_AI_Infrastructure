#!/usr/bin/env bun

/**
 * Headshot.ts - AI Headshot Generation CLI
 *
 * Generate professional headshots using Nano Banana Pro
 * (Gemini 3 Pro) with reference image support for facial structure matching.
 *
 * Usage:
 *   bun ~/.claude/skills/Headshot/Tools/Headshot.ts --prompt "..." --reference <path> [OPTIONS]
 *   bun ~/.claude/skills/Headshot/Tools/Headshot.ts check                       # is the skill set up?
 *   bun ~/.claude/skills/Headshot/Tools/Headshot.ts config                      # config as JSON (references, look, plates)
 *   bun ~/.claude/skills/Headshot/Tools/Headshot.ts references [--sentiment <s>]  # approved reference photos
 *
 * Config: LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Headshot/Config.md is REQUIRED for check, config and
 * references. It names the reference-photo directory, the photo-to-sentiment table, the default
 * look and optional scene plates. There are no built-in photos or looks to fall back to: a missing
 * or empty config exits 1 and points at Setup.md.
 *
 * @author LifeOS
 * @version 1.0.0
 */

import { GoogleGenAI } from "@google/genai";
import { CROSS_VENDOR } from "../../../LIFEOS/TOOLS/models";
import { getClaudeDir, getEnvPath } from "../../../LIFEOS/TOOLS/Paths.ts";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

// ============================================================================
// Environment Loading
// ============================================================================

/**
 * Load environment variables from the config root's .env (getEnvPath():
 * $CLAUDE_CONFIG_DIR/.env when set, else ~/.claude/.env), the same root
 * configPath() reads Config.md from.
 * Ensures API keys are available regardless of how the CLI is invoked
 */
async function loadEnv(): Promise<void> {
  const envPath = getEnvPath();
  try {
    const envContent = await readFile(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Remove surrounding quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Only set if not already defined (allow overrides from shell)
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Silently continue if .env doesn't exist - rely on shell env vars
  }
}

// ============================================================================
// Config (Config.md)
// ============================================================================

const SETUP_HINT = "See skills/Headshot/Setup.md to set it up.";

interface Reference { file: string; path: string; sentiment: string; notes: string; exists: boolean }
interface HeadshotConfig {
  configPath: string;
  referenceDir: string;
  references: Reference[];
  look: { attire?: string; backdrop?: string; mood?: string };
  plates: Array<{ name: string; path: string; description: string; exists: boolean }>;
}

function configPath(): string {
  const root = getClaudeDir();
  return resolve(root, "LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Headshot/Config.md");
}

function expandHome(v: string): string {
  const home = process.env.HOME ?? homedir();
  return v.replace(/^~(?=\/|$)/, home).replace(/\$HOME\b|\$\{HOME\}/g, home);
}

function section(md: string, name: string): string {
  return md.split(new RegExp(`^## ${name}\\s*$`, "m"))[1]?.split(/^## /m)[0] ?? "";
}

function tableRows(sec: string): string[][] {
  return sec
    .split("\n")
    .filter((l) => l.trim().startsWith("|") && !/^\|\s*-/.test(l.trim()))
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/^`|`$/g, "")))
    .slice(1); // drop the header row
}

function loadConfig(): HeadshotConfig {
  const path = configPath();
  if (!existsSync(path)) throw new CLIError(`Headshot config missing: ${path}. ${SETUP_HINT}`);
  const md = readFileSync(path, "utf8");

  const refSec = section(md, "Reference photos");
  const dirRaw = refSec.match(/^Directory:\s*`([^`]+)`/m)?.[1];
  if (!dirRaw) throw new CLIError(`Config.md has no 'Directory: \`<path>\`' line under '## Reference photos'. ${SETUP_HINT}`);
  const referenceDir = resolve(expandHome(dirRaw));
  const references = tableRows(refSec).map((r) => ({
    file: r[0],
    path: resolve(referenceDir, r[0]),
    sentiment: r[1] ?? "",
    notes: r[2] ?? "",
    exists: existsSync(resolve(referenceDir, r[0])),
  }));
  if (references.length === 0) throw new CLIError(`Config.md '## Reference photos' lists no photos. ${SETUP_HINT}`);

  const look: HeadshotConfig["look"] = {};
  for (const [k, v] of tableRows(section(md, "Default look"))) {
    if (k === "attire" || k === "backdrop" || k === "mood") look[k] = v;
  }
  const plates = tableRows(section(md, "Scene plates")).map((r) => ({
    name: r[0],
    path: resolve(expandHome(r[1] ?? "")),
    description: r[2] ?? "",
    exists: !!r[1] && existsSync(resolve(expandHome(r[1]))),
  }));
  return { configPath: path, referenceDir, references, look, plates };
}

function runSubcommand(cmd: string, rest: string[]): void {
  if (cmd === "config") {
    console.log(JSON.stringify(loadConfig(), null, 2));
  } else if (cmd === "references") {
    const cfg = loadConfig();
    const i = rest.indexOf("--sentiment");
    const want = i >= 0 ? rest[i + 1] : undefined;
    const list = cfg.references.filter((r) => r.exists && (!want || r.sentiment === want));
    if (list.length === 0) {
      throw new CLIError(want ? `No existing reference photo with sentiment '${want}' in ${cfg.configPath}` : `No reference photo listed in ${cfg.configPath} exists on disk under ${cfg.referenceDir}`);
    }
    console.log(JSON.stringify(list, null, 2));
  } else {
    const cfg = loadConfig();
    const missing = cfg.references.filter((r) => !r.exists).map((r) => r.file);
    const usable = cfg.references.length - missing.length;
    const problems: string[] = [];
    if (usable === 0) problems.push(`none of the ${cfg.references.length} listed photos exist under ${cfg.referenceDir}`);
    if (!process.env.GOOGLE_API_KEY) problems.push("GOOGLE_API_KEY is not set (add it to the .env file in the config root, $CLAUDE_CONFIG_DIR or ~/.claude)");
    if (problems.length) throw new CLIError(`setup incomplete: ${problems.join("; ")}. ${SETUP_HINT}`);
    console.log(`OK: ${usable} reference photo(s) in ${cfg.referenceDir}${missing.length ? ` (${missing.length} listed but missing: ${missing.join(", ")})` : ""}; GOOGLE_API_KEY set; ${cfg.plates.length} scene plate(s); config ${cfg.configPath}`);
  }
}

// ============================================================================
// Types
// ============================================================================

type GeminiSize = "1K" | "2K" | "4K";
type AspectRatio =
  | "1:1"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "9:16"
  | "16:9"
  | "21:9";

interface CLIArgs {
  prompt: string;
  references: string[];
  size: GeminiSize;
  aspectRatio: AspectRatio;
  output: string;
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULTS = {
  size: "2K" as GeminiSize,
  aspectRatio: "1:1" as AspectRatio,
  output: "/tmp/headshot.png",
};

const GEMINI_SIZES: GeminiSize[] = ["1K", "2K", "4K"];
const ASPECT_RATIOS: AspectRatio[] = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];

// ============================================================================
// Error Handling
// ============================================================================

class CLIError extends Error {
  constructor(message: string, public exitCode: number = 1) {
    super(message);
    this.name = "CLIError";
  }
}

function handleError(error: unknown): never {
  if (error instanceof CLIError) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(error.exitCode);
  }

  if (error instanceof Error) {
    console.error(`❌ Unexpected error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }

  console.error(`❌ Unknown error:`, error);
  process.exit(1);
}

// ============================================================================
// Help Text
// ============================================================================

function showHelp(): void {
  console.log(`
headshot - AI Headshot Generation CLI

Generate professional headshots using Nano Banana Pro
(Gemini 3 Pro) with reference image support for facial structure matching.

USAGE:
  headshot --prompt "<prompt>" --reference <path> [OPTIONS]
  headshot check                          verify config, reference photos and API key
  headshot config                         print the parsed config as JSON
  headshot references [--sentiment <s>]   list approved reference photos

REQUIRED:
  --prompt <text>          Description of the headshot to generate
  --reference <path>       Reference image path (can be specified multiple times)
                           Accepts: PNG, JPEG, WebP images

OPTIONS:
  --size <size>            Image resolution (default: 2K)
                           Options: 1K, 2K, 4K
  --aspect-ratio <ratio>   Image aspect ratio (default: 1:1)
                           Options: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
  --output <path>          Output file path (default: /tmp/headshot.png)
  --help, -h               Show this help message

EXAMPLES:
  # Basic headshot with single reference
  headshot --prompt "Professional headshot of the subject, software engineer" \\
    --reference ~/Pictures/headshot-references/front.png

  # High-resolution with multiple references
  headshot --prompt "The subject in casual attire, warm lighting" \\
    --reference ~/Pictures/headshot-references/front.png \\
    --reference ~/Pictures/headshot-references/smiling.png \\
    --size 4K --output ~/headshots/casual.png

  # Portrait aspect ratio
  headshot --prompt "The subject in a conference setting" \\
    --reference ~/Pictures/headshot-references/front.png \\
    --aspect-ratio 3:4 --size 2K

PROMPT TIPS:
  - Be specific about lighting (soft, dramatic, natural, studio)
  - Describe the setting (office, outdoors, neutral background)
  - Include style notes (professional, casual, editorial)
  - Reference clothing if important (suit, casual shirt, etc.)

ENVIRONMENT VARIABLES:
  GOOGLE_API_KEY    Required - Gemini API key (loaded from the .env file in the config root, $CLAUDE_CONFIG_DIR or ~/.claude)

ERROR CODES:
  0  Success
  1  General error (invalid arguments, API error, file write error)

MORE INFO:
  Documentation: ~/.claude/skills/Headshot/Tools/headshot.help.md
  Skill: ~/.claude/skills/Headshot/SKILL.md
`);
  process.exit(0);
}

// ============================================================================
// Argument Parsing
// ============================================================================

function parseArgs(argv: string[]): CLIArgs {
  const args = argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    showHelp();
  }

  const parsed: Partial<CLIArgs> & { references: string[] } = {
    size: DEFAULTS.size,
    aspectRatio: DEFAULTS.aspectRatio,
    output: DEFAULTS.output,
    references: [],
  };

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];

    if (!flag.startsWith("--")) {
      throw new CLIError(`Invalid flag: ${flag}. Flags must start with --`);
    }

    const key = flag.slice(2);
    const value = args[i + 1];

    if (!value || value.startsWith("--")) {
      throw new CLIError(`Missing value for flag: ${flag}`);
    }

    switch (key) {
      case "prompt":
        parsed.prompt = value;
        i++;
        break;
      case "reference":
        parsed.references.push(value);
        i++;
        break;
      case "size":
        if (!GEMINI_SIZES.includes(value as GeminiSize)) {
          throw new CLIError(
            `Invalid size: ${value}. Must be: ${GEMINI_SIZES.join(", ")}`
          );
        }
        parsed.size = value as GeminiSize;
        i++;
        break;
      case "aspect-ratio":
        if (!ASPECT_RATIOS.includes(value as AspectRatio)) {
          throw new CLIError(
            `Invalid aspect-ratio: ${value}. Must be: ${ASPECT_RATIOS.join(", ")}`
          );
        }
        parsed.aspectRatio = value as AspectRatio;
        i++;
        break;
      case "output":
        parsed.output = value;
        i++;
        break;
      default:
        throw new CLIError(`Unknown flag: ${flag}`);
    }
  }

  // Validate required arguments
  if (!parsed.prompt) {
    throw new CLIError("Missing required argument: --prompt");
  }

  if (parsed.references.length === 0) {
    throw new CLIError(
      "Missing required argument: --reference (at least one reference image required)"
    );
  }

  return parsed as CLIArgs;
}

// ============================================================================
// Image Generation
// ============================================================================

async function generateHeadshot(args: CLIArgs): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new CLIError("Missing environment variable: GOOGLE_API_KEY (add it to the .env file in the config root, $CLAUDE_CONFIG_DIR or ~/.claude). See skills/Headshot/Setup.md.");
  }

  const ai = new GoogleGenAI({ apiKey });

  console.log(
    `🎨 Generating headshot with Nano Banana Pro at ${args.size} ${args.aspectRatio}...`
  );
  console.log(`📸 Using ${args.references.length} reference image(s)`);

  // Prepare content parts
  const parts: Array<{
    text?: string;
    inlineData?: { mimeType: string; data: string };
  }> = [];

  // Add all reference images
  for (const refPath of args.references) {
    const imageBuffer = await readFile(refPath);
    const imageBase64 = imageBuffer.toString("base64");

    // Determine MIME type from extension
    const ext = extname(refPath).toLowerCase();
    let mimeType: string;
    switch (ext) {
      case ".png":
        mimeType = "image/png";
        break;
      case ".jpg":
      case ".jpeg":
        mimeType = "image/jpeg";
        break;
      case ".webp":
        mimeType = "image/webp";
        break;
      default:
        throw new CLIError(
          `Unsupported image format: ${ext}. Supported: .png, .jpg, .jpeg, .webp`
        );
    }

    parts.push({
      inlineData: {
        mimeType,
        data: imageBase64,
      },
    });

    console.log(`   ✓ Loaded: ${refPath}`);
  }

  // Add text prompt with headshot-specific guidance
  const enhancedPrompt = `Using the reference image(s) provided above, generate a new image matching the exact facial features, skin tone, and distinctive characteristics. ${args.prompt}`;

  parts.push({ text: enhancedPrompt });

  const response = await ai.models.generateContent({
    model: CROSS_VENDOR.geminiImage,
    contents: [{ parts }],
    config: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio: args.aspectRatio,
        imageSize: args.size,
      },
    },
  });

  // Extract image data from response
  let imageData: string | undefined;

  if (response.candidates && response.candidates.length > 0) {
    const responseParts = response.candidates[0].content.parts;
    for (const part of responseParts) {
      if (part.inlineData && part.inlineData.data) {
        imageData = part.inlineData.data;
        break;
      }
    }
  }

  if (!imageData) {
    throw new CLIError("No image data returned from Gemini API");
  }

  const imageBuffer = Buffer.from(imageData, "base64");
  await mkdir(dirname(resolve(args.output)), { recursive: true });
  await writeFile(args.output, imageBuffer);
  console.log(`✅ Headshot saved to ${args.output}`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  try {
    // Load API keys from the config root's .env
    await loadEnv();

    const sub = process.argv[2];
    if (sub === "check" || sub === "config" || sub === "references") {
      runSubcommand(sub, process.argv.slice(3));
      return;
    }

    const args = parseArgs(process.argv);
    await generateHeadshot(args);
  } catch (error) {
    handleError(error);
  }
}

main();
