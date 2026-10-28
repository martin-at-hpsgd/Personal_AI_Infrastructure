#!/usr/bin/env bun
/**
 * Check.ts - Verify a Pareto report against the data it was built from.
 *
 * Usage:
 *   bun ~/.claude/skills/Pareto/Tools/Check.ts <report.md> <ranked.json> [--collection collection.json]
 *
 * Fails (exit 1) when: a required section is missing; a URL in the report never appeared in the
 * collected data; the past or current section carries no dated, linked source; the frontier section
 * has fewer than two links; or every frontier link is a top-reach item (a popularity summary).
 *
 * @author LifeOS System
 * @version 1.0.0
 */

import type { RankResult } from "./Rank.ts";
import type { Collection } from "./Collect.ts";

export const SECTIONS = { past: "Past meta", current: "Current mainstream meta", frontier: "Where the forward thinkers are heading" } as const;
// Apostrophes are legal in URL paths ("...isn't-industry-standard"); stopping at them made such links unpassable.
const URL_RE = /https?:\/\/[^\s)\]>"|]+/g;
/** Top third of reach within its source counts as mainstream. */
const TOP_REACH = 0.66;

export function section(report: string, heading: string): string | null {
  const lines = report.split("\n");
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.toLowerCase().includes(heading.toLowerCase()));
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

const norm = (u: string) => u.replace(/[.,;:]+$/, "").replace(/\/+$/, "");

export function check(report: string, ranked: RankResult, collection?: Collection): string[] {
  const failures: string[] = [];
  const known = new Map<string, number | null>();
  for (const it of collection?.items ?? []) known.set(norm(it.url), null);
  // Only measured reach counts toward "top-reach"; the 0.5 default for unmeasured items means unknown, not low.
  for (const it of ranked.items) known.set(norm(it.url), it.reach != null ? it.factors.reach : null);

  for (const url of report.match(URL_RE) ?? []) {
    if (!known.has(norm(url))) failures.push(`URL not in collected data: ${url}`);
  }
  for (const [key, heading] of Object.entries(SECTIONS)) {
    const body = section(report, heading);
    if (body == null) { failures.push(`missing section: ## ${heading}`); continue; }
    const links = body.match(URL_RE) ?? [];
    if (key !== "frontier") {
      if (!links.length) failures.push(`${heading}: no linked source`);
      if (!/\b(19|20)\d{2}\b/.test(body)) failures.push(`${heading}: no dated citation`);
    } else {
      if (links.length < 2) failures.push(`${heading}: fewer than two linked sources`);
      const reaches = links.map((u) => known.get(norm(u))).filter((r): r is number => typeof r === "number");
      if (reaches.length >= 2 && reaches.every((r) => r >= TOP_REACH)) failures.push(`${heading}: every source is a top-reach item — this is the mainstream, not the frontier`);
    }
  }
  return failures;
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.length < 2 || args.includes("--help") || args.includes("-h")) {
    console.log(await Bun.file(new URL("./Check.help.md", import.meta.url)).text());
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }
  const ci = args.indexOf("--collection");
  const collection = ci !== -1 ? (JSON.parse(await Bun.file(args[ci + 1]).text()) as Collection) : undefined;
  const [reportPath, rankedPath] = args.filter((a, i) => !a.startsWith("--") && (ci === -1 || i !== ci + 1));
  const failures = check(await Bun.file(reportPath).text(), JSON.parse(await Bun.file(rankedPath).text()), collection);
  if (failures.length) {
    for (const f of failures) console.error(`\x1b[31m✗ ${f}\x1b[0m`);
    process.exit(1);
  }
  console.error("\x1b[32m✓ report checks pass\x1b[0m");
}

if (import.meta.main) await main();
