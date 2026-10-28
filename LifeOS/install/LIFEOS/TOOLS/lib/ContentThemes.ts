// ContentThemes.ts — the principal's editorial themes, from the USER zone, never a literal.
//
// Two runtime prompts (the lifelog idea sweep, blog discovery scoring) once carried the
// maintainer's own topic list as the universal default (Lane A cross-vendor audit, 7.52.0
// cut). Order: LIFEOS/USER/CONFIG/content-themes.json (explicit tiers) → the bullets or
// headings of LIFEOS/USER/CANONICAL_CONTENT.md → a generic instruction to judge on merit.
import { existsSync, readFileSync } from "node:fs";
import { lifeosPath } from "../Paths";

export interface ContentThemes {
  /** Tier 1: what the principal comes back to repeatedly. */
  primary: string[];
  /** Tier 2: still theirs, less frequent. */
  secondary: string[];
  /** Tier 3: adjacent interests. */
  tertiary: string[];
  /** Topics they deliberately avoid. */
  offTheme: string[];
  /** Where the themes came from, for logs. */
  source: "config" | "canonical" | "none";
}

const PLACEHOLDER = /\(interview\b|^\s*$/i;

function bullets(md: string, heading: string): string[] {
  const block = md.split(/^##\s+/m).find((b) => b.trimStart().startsWith(heading));
  if (!block) return [];
  return block.split("\n").slice(1)
    .map((l) => l.replace(/^\s*-\s*/, "").replace(/\*\*T\d+:\*\*\s*/, "").trim())
    .filter((l) => l && !PLACEHOLDER.test(l) && !l.startsWith("#"));
}

export function contentThemes(): ContentThemes {
  const cfg = lifeosPath("USER", "CONFIG", "content-themes.json");
  if (existsSync(cfg)) {
    try {
      const j = JSON.parse(readFileSync(cfg, "utf8")) as Partial<ContentThemes>;
      return { primary: j.primary ?? [], secondary: j.secondary ?? [], tertiary: j.tertiary ?? [], offTheme: j.offTheme ?? [], source: "config" };
    } catch { /* fall through */ }
  }
  const canon = lifeosPath("USER", "CANONICAL_CONTENT.md");
  if (existsSync(canon)) {
    const md = readFileSync(canon, "utf8");
    let primary = bullets(md, "Primary Themes");
    const secondary = bullets(md, "Secondary Themes");
    const offTheme = bullets(md, "Explicitly Off-Theme");
    if (!primary.length) {
      // A free-form file: its section headings are the themes.
      primary = [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim())
        .filter((h) => !/^(Primary Themes|Secondary Themes|Explicitly Off-Theme|Essential Content)$/i.test(h));
    }
    if (primary.length) return { primary, secondary, tertiary: [], offTheme, source: "canonical" };
  }
  return { primary: [], secondary: [], tertiary: [], offTheme: [], source: "none" };
}

/** One prompt paragraph describing the author's themes, or the merit-only instruction when none are configured. */
export function themesParagraph(): string {
  const t = contentThemes();
  if (!t.primary.length) {
    return "The author's themes are not configured yet (LIFEOS/USER/CANONICAL_CONTENT.md): judge each idea on originality, depth, and whether it is a claim the author made themselves.";
  }
  const parts = [`The author writes about: ${t.primary.join(", ")}.`];
  if (t.secondary.length) parts.push(`Also, less often: ${t.secondary.join(", ")}.`);
  const off = t.offTheme.length ? t.offTheme.join(", ") : "errands, logistics, meals, or product support";
  parts.push(`They do not write about ${off}.`);
  return parts.join(" ");
}

/** The tiered form the feed scorer uses. */
export function themesTiers(): string {
  const t = contentThemes();
  if (!t.primary.length) {
    return "The owner has not configured priority topics yet (LIFEOS/USER/CANONICAL_CONTENT.md): weight editorial quality and distinct voice, and treat topic fit as neutral.";
  }
  const tiers = [`HIGHEST = ${t.primary.join(", ")}`];
  if (t.secondary.length) tiers.push(`HIGH = ${t.secondary.join(", ")}`);
  if (t.tertiary.length) tiers.push(`MEDIUM = ${t.tertiary.join(", ")}`);
  const off = t.offTheme.length ? t.offTheme.join(", ") : "generic news, marketing/SEO, product changelogs, or off-topic personal diaries";
  return `The owner's PRIORITY topics, in tiers: ${tiers.join(". ")}. They do NOT want ${off}.`;
}
