/**
 * Cortex leg of the daily rollup — everything Conduit senses lands in Cortex
 * (principal directive, 2026-08-27). Each daily record persists as one typed Knowledge
 * note in KNOWLEDGE/Research, slug `conduit-day-<date>`, carrying the
 * deterministic record plus the hourly content-type read's narrative when one
 * exists. The note carries `source_conduit_date:` back to the record; the
 * record's JSON carries the forward `cortexRef` — the same bidirectional-link
 * contract the Synapse amber ledger uses.
 *
 * Deterministic — no model call. Idempotent: rewriting a day's note is safe.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_ROOT, insightPathFor } from "./paths.ts";
import { renderMarkdown } from "./rollup.ts";
import type { DailyRecord } from "./types.ts";
import { assertAnswerArtifact } from "../../TOOLS/AnswerArtifact.ts";

const RESEARCH_DIR = join(CLAUDE_ROOT, "LIFEOS", "MEMORY", "KNOWLEDGE", "Research");

export interface CortexRef {
  type: "knowledge_note";
  category: "research";
  slug: string;
}

/** Deterministic ref for a day — derivable without touching the filesystem. */
export function cortexRefFor(date: string): CortexRef {
  return { type: "knowledge_note", category: "research", slug: `conduit-day-${date}` };
}

function readInsight(date: string): { narrative: string; contentTypes: Array<{ label: string; share: number }> } | null {
  try {
    const p = insightPathFor(date);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (typeof j?.narrative !== "string") return null;
    return { narrative: j.narrative, contentTypes: Array.isArray(j.contentTypes) ? j.contentTypes : [] };
  } catch {
    return null;
  }
}

export function writeAtomic(path: string, content: string): void {
  assertAnswerArtifact(content);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Write/refresh the day's Cortex note. Returns the ref. */
export function writeCortexDayNote(r: DailyRecord): CortexRef {
  const ref = cortexRefFor(r.date);
  mkdirSync(RESEARCH_DIR, { recursive: true });
  const insight = readInsight(r.date);
  const types = insight?.contentTypes
    ?.map((t) => `- ${t.label} (${Math.round((t.share ?? 0) * 100)}%)`)
    .join("\n");
  const lines = [
    "---",
    `id: ${ref.slug}`,
    "type: research",
    `title: "Observed day — ${r.date}"`,
    "tags: [conduit, observed-day, attention]",
    `created: ${r.date}`,
    `updated: ${r.date}`,
    "convention: kb-v3",
    "status: inbox",
    "source_kind: internal",
    "confidence: 1.0",
    `source_conduit_date: "${r.date}"`,
    "authored_by: conduit",
    "trust: internal-sensor",
    "related: []",
    "---",
    "",
    ...(insight?.narrative ? [`> ${insight.narrative}`, ""] : []),
    renderMarkdown(r).trimEnd(),
    "",
    ...(types ? ["## Content types (hourly read)", "", types, ""] : []),
  ];
  writeAtomic(join(RESEARCH_DIR, `${ref.slug}.md`), lines.join("\n") + "\n");
  return ref;
}
