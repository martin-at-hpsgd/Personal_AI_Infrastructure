#!/usr/bin/env bun
/**
 * Check.ts — validates the Brand config (Surfaces.md) before a sweep.
 *
 *   bun ~/.claude/skills/Brand/Tools/Check.ts            # human-readable report, exit 0 ok / 1 problem
 *   bun ~/.claude/skills/Brand/Tools/Check.ts --json     # same facts as JSON
 *
 * Reads `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Brand/Surfaces.md`. There are no built-in surfaces:
 * a missing file, a missing required section, or an inventory row with no update mechanism or
 * gate exits 1 and points at Setup.md. The BrandUpdate and UpdateIdeasPage intents run this first.
 */
import { existsSync, readFileSync } from "node:fs";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";

const ROOT = getClaudeDir();
const SURFACES = `${ROOT}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Brand/Surfaces.md`;
const SETUP = "skills/Brand/Setup.md";
const json = process.argv.includes("--json");

function stop(msg: string): never {
  if (json) console.log(JSON.stringify({ ok: false, error: msg, file: SURFACES, guide: SETUP }));
  else console.error(`Brand config: ${msg}\nSee ${SETUP} to set it up.`);
  process.exit(1);
}

if (!existsSync(SURFACES)) stop(`missing config file ${SURFACES}`);
const md = readFileSync(SURFACES, "utf8");

function section(name: string): string | undefined {
  const parts = md.split(new RegExp(`^## ${name}\\s*$`, "m"));
  return parts[1]?.split(/^## /m)[0];
}
function rows(sec: string): string[][] {
  return sec
    .split("\n")
    .filter((l) => l.trim().startsWith("|") && !/^\|\s*-/.test(l.trim()))
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
}

const problems: string[] = [];
for (const name of ["Source-of-truth reads", "Surface inventory"]) {
  if (!section(name)) problems.push(`missing required section "## ${name}"`);
}

// Inventory: header row names the columns; every data row needs a surface, a mechanism and a gate.
const inv = rows(section("Surface inventory") ?? "");
const header = inv[0] ?? [];
const col = (n: string) => header.findIndex((h) => h.toLowerCase() === n.toLowerCase());
const iSurface = col("Surface"), iMech = col("Update mechanism"), iGate = col("Gate");
if (inv.length && (iSurface < 0 || iMech < 0 || iGate < 0)) {
  problems.push('"## Surface inventory" header must include the columns Surface, Update mechanism and Gate');
}
const data = inv.slice(1);
if (!data.length) problems.push('"## Surface inventory" has no rows');
for (const r of data) {
  if (iMech >= 0 && (!r[iMech] || r[iMech] === "—")) problems.push(`inventory row "${r[iSurface] ?? r[0]}" has no update mechanism`);
  if (iGate >= 0 && (!r[iGate] || r[iGate] === "—")) problems.push(`inventory row "${r[iSurface] ?? r[0]}" has no gate`);
}

// Source-of-truth reads: each backticked path must exist (paths relative to the config root).
const truth = rows(section("Source-of-truth reads") ?? "").slice(1);
const missingTruth: string[] = [];
for (const r of truth) {
  const p = (r[1] ?? "").match(/`([^`]+\.md)`/)?.[1];
  if (p && !existsSync(`${ROOT}/${p}`)) missingTruth.push(p);
}
for (const p of missingTruth) problems.push(`source-of-truth file not found: ${p}`);

// Variables the ideas page intent needs (only checked when the Ideas page section exists).
const vars = new Map(rows(section("Variables") ?? "").slice(1).map((r) => [r[0].replace(/`/g, ""), r[1]?.replace(/`/g, "") ?? ""]));
const ideas = section("Ideas page");
const missingVars = ideas ? ["$BLOG_FEED", "$IDEAS_SRC", "$IDEAS_URL", "$BLOG_REPO"].filter((v) => !vars.get(v)) : [];
for (const v of missingVars) problems.push(`"## Ideas page" is present but "## Variables" has no value for ${v}`);

const report = { ok: problems.length === 0, file: SURFACES, surfaces: data.length, ideasPage: !!ideas, problems };
if (json) console.log(JSON.stringify(report));
else if (problems.length) {
  console.error(`Brand config problems in ${SURFACES}:\n- ${problems.join("\n- ")}\nSee ${SETUP}.`);
} else {
  console.log(`OK: ${data.length} surfaces in ${SURFACES}${ideas ? "; ideas page configured" : "; no ideas page section"}`);
}
process.exit(problems.length ? 1 : 0);
