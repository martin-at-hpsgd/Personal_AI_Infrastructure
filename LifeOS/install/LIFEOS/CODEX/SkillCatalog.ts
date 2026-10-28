/** Compact catalog text is presentation metadata; full routing remains authoritative. */
import { invariant } from "../TOOLS/Invariant.ts";

export const SUMMARY_MAX_CHARS = 170;
export const CATALOG_SUMMARY_MAX_CHARS = 72;

/** Preserve a compact routing cue in Codex's eager catalog; load the source for detail. */
export function catalogSummary(summary: string): string {
  if (summary.length <= CATALOG_SUMMARY_MAX_CHARS) return summary;
  const cut = summary.lastIndexOf(" ", CATALOG_SUMMARY_MAX_CHARS - 1);
  return `${summary.slice(0, cut > 24 ? cut : CATALOG_SUMMARY_MAX_CHARS - 1)}…`;
}

export function skillMetadata(md: string): { description: string; summary?: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md);
  if (!fm) return { description: "" };
  // Older skill frontmatter treats a single-line description as literal prose,
  // including `: `, which YAML otherwise interprets as a mapping separator.
  // Normalize only that legacy shape in memory; source bytes stay untouched.
  const normalized = fm[1].replace(/^description:[ \t]+([^\r\n]+)$/m, (line, value: string) => {
    if (/^["'|>{\[]/.test(value) || !value.includes(": ")) return line;
    return `description: ${JSON.stringify(value)}`;
  });
  const data = Bun.YAML.parse(normalized) as Record<string, unknown> | null;
  const metadata = data?.metadata as Record<string, unknown> | undefined;
  const summary = metadata?.["short-description"];
  return {
    description: typeof data?.description === "string" ? data.description : "",
    summary: typeof summary === "string" ? summary : undefined,
  };
}

/** Only the generated view uses the compact description. Source bytes are never rewritten. */
export function renderSkillView(md: string): string {
  const { description, summary } = skillMetadata(md);
  if (summary === undefined) return md;
  invariant(summary.trim() === summary && summary.length > 0 && !/[\r\n]/.test(summary), "skill summary must be nonempty, single-line, and trimmed");
  invariant([...summary].length <= SUMMARY_MAX_CHARS, `skill summary exceeds ${SUMMARY_MAX_CHARS} characters`);
  invariant(description.length > 0, "compact skill view requires the original description");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md)!;
  const field = /^description:[^\r\n]*(?:\r?\n(?:[ \t]+[^\r\n]*|(?=\r?\n)))*/m;
  invariant(field.test(fm[1]), "skill description must be a top-level YAML field");
  const projected = fm[0].replace(field, () => `description: ${JSON.stringify(catalogSummary(summary))}`);
  return projected + `\n## Full skill description\n\n${description}\n` + md.slice(fm[0].length);
}
