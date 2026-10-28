/**
 * @version 1.0.0
 * Render.ts — compose `$CODEX_HOME/AGENTS.md` from the live install.
 *
 * Claude Code gets the constitution through `--append-system-prompt-file` and
 * the routing table through CLAUDE.md with its `@`-imports. Codex's
 * append-shaped surface is the global AGENTS.md, and it has no import syntax,
 * so this renders two layers into one file:
 *
 *   1. the system prompt, frontmatter stripped;
 *   2. the LifeOS context router (`contextRouter`): CLAUDE.md, USER data,
 *      projects and skills are not preloaded; the session loads each live
 *      source through `SystemContext.ts` when the task needs it.
 *
 * `inlineImports` and `routedImport` remain for callers that want CLAUDE.md
 * with its `@`-imports expanded; the AGENTS.md render does not use them.
 *
 * `model_instructions_file` is NOT the right key for this: it replaces Codex's
 * built-in instructions (config reference: "Replacement for built-in
 * instructions instead of AGENTS.md"); AGENTS.md sits on top of them, which is
 * the append the Claude side does.
 *
 * Install-generic: paths are computed from the install root; the rendered
 * output is per-install and lives outside the repo.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RenderOpts { installRoot: string; codexHome: string; daName: string }

export function stripFrontmatter(md: string): string {
  return md.startsWith("---\n") ? md.replace(/^---\n[\s\S]*?\n---\n/, "") : md;
}

/** Replace each `@relative/path` line in CLAUDE.md with that file's contents. */
export function inlineImports(claudeMd: string, installRoot: string, selective = false): { text: string; imported: string[]; missing: string[] } {
  const imported: string[] = [];
  const missing: string[] = [];
  const text = claudeMd.split("\n").map((line) => {
    const m = /^@(\S+)\s*$/.exec(line);
    if (!m) return line;
    const rel = m[1];
    const abs = join(installRoot, rel);
    if (!existsSync(abs)) { missing.push(rel); return `<!-- @import ${rel}: MISSING at render time -->`; }
    imported.push(rel);
    const body = stripFrontmatter(readFileSync(abs, "utf8")).trimEnd();
    if (selective && DEFERRED_IMPORTS.has(rel)) {
      return routedImport(rel, abs, body);
    }
    return `<!-- @import ${rel} — begin -->\n${body}\n<!-- @import ${rel} — end -->`;
  }).join("\n");
  return { text, imported, missing };
}

// Only contextual inventories are deferred. Identity and operating rules are
// deliberately not eligible: new imports retain the full-text default.
export const DEFERRED_IMPORTS = new Set([
  "LIFEOS/DOCUMENTATION/ARCHITECTURE_SUMMARY.md",
  "LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md",
  "LIFEOS/USER/PROJECTS.md",
]);

/** The only startup context besides the shared system prompt. */
export function contextRouter(o: RenderOpts): string {
  return `# LifeOS Context Router

LifeOS lives at \`${o.installRoot}\`; this session starts with the shared system prompt and this router only. Nothing in \`CLAUDE.md\`, \`USER/\`, memory, projects, or skill bodies is preloaded.

Before work, use \`bun LIFEOS/TOOLS/SystemContext.ts\` to load the live source that applies: \`constitution\` and \`operations\` for consequential work; \`projects\` for a named project; \`telos\` for priorities or personal advice; \`architecture\` for LifeOS changes; and \`skill:<Name>\` before using a skill. When the skill is unknown, run \`SystemContext.ts search "<terms>" skills\`, then read that one full SKILL.md and its required dependencies. A source is not loaded until this command returns it.

Codex hooks call the live LifeOS bridge through \`${o.codexHome}/hooks.json\`; a deny or block is authoritative. Use shell reads for Read/Grep/Glob and \`apply_patch\` for edits. The system prompt supplies the response format; echo only hook-fed memory or system lines.
`;
}

export function routedImport(rel: string, abs: string, body: string): string {
  let route: string;
  if (rel.endsWith("PROJECTS.md")) {
    const names = body.split("\n").filter(line => /^\| \*\*/.test(line))
      .map(line => line.split("|")[1].replace(/\*\*/g, "").trim());
    route = `Before any project-specific work, read this registry to resolve the name or alias, current checkout, ISA, and sanctioned commands. Never infer a path or deployment command from memory. Available projects: ${names.join("; ")}.`;
  } else if (rel.endsWith("PRINCIPAL_TELOS.md")) {
    const missions = body.match(/## Missions\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "";
    route = `${missions}\n\nRead this source before prioritization, strategic advice, goal/alignment work, or deciding what to initiate. Follow its depth-file references when needed.`;
  } else {
    route = "Read this source before explaining or changing LifeOS architecture, components, versions, or integration behavior.";
  }
  return `<!-- @import ${rel} — deferred -->\n## Context source: ${rel}\n\n${route}\n\nSource: \`${abs}\`. This source is available on demand, not already loaded. Read it whenever relevant or relevance is uncertain; after compaction, reload any source needed for the active task.\n<!-- @import ${rel} — end -->`;
}

export function renderAgentsMd(o: RenderOpts): { text: string; imported: string[]; missing: string[] } {
  const sysPrompt = stripFrontmatter(readFileSync(join(o.installRoot, "LIFEOS", "LIFEOS_SYSTEM_PROMPT.md"), "utf8")).trimEnd();
  const text = [
    sysPrompt,
    "",
    contextRouter(o).trimEnd(),
    "",
    `<!-- ── end LIFEOS-MANAGED · rendered ${new Date().toISOString()} · system-prompt + router ── -->`,
    "",
  ].join("\n");
  return { text, imported: [], missing: [] };
}

/** Byte-stable comparison: the render stamp line is ignored so an unchanged render is a no-op write. */
export function sameRender(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/<!-- ── end LIFEOS-MANAGED · rendered [^\n]*-->/g, "<!-- end -->");
  return norm(a) === norm(b);
}
