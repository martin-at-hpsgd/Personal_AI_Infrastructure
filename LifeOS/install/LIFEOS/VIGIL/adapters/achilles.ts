/**
 * Achilles new high-severity finding adapter: the event carries the registry entry's own description, affected items, first-seen time and work issue.
 * A critical texts on registration. A high goes to the digest (ISC-66): it reaches the phone only through the remediation loop's one
 * batched escalation text, when the loop cannot fix it or needs a decision, so one weakness is never texted twice. @version 0.4.0
 */
import { homedir } from "node:os"; import { join } from "node:path"; import type { VigilEvent } from "../../STATVS/lib/refuse"; import { clip, clock, event, jsonFile, need, withCursor } from "./common";
import { readFileSync } from "node:fs";
import { getClaudeDir } from "../../TOOLS/Paths";
import type { RemediationState } from "../../TOOLS/AchillesRemediate";
import { registryPath } from "../../TOOLS/Achilles";

/** ISC-79: cancellation follows a queued copy to the send boundary. Unknown or unreadable intent
 * stays live: only matched, persisted evidence may suppress a decision the principal still needs to hear. */
export function stillLive(e: VigilEvent, path = join(getClaudeDir(), "LIFEOS/USER/SECURITY/ACHILLES/remediation.json")): boolean {
  if (!e.ref?.startsWith("achilles-escalation:") || typeof e.meta?.key !== "string") return true;
  try {
    const st = JSON.parse(readFileSync(path, "utf8")) as RemediationState;
    const text = st.texts?.find((t) => t.key === e.meta!.key);
    if (!text) return true;
    if (text.cancelled) return false;
    if (!text.entries.length) return true;
    return !text.entries.every((entry) => {
      const r = st.escalations?.find((r) => r.id === entry.id && r.kind === entry.kind && r.at === entry.at);
      return r?.dropped === "entry_closed" || !!r?.delivered;
    });
  } catch { return true; }
}
type Entry = { id?: string; key?: string; title?: string; severity?: string; description?: string; evidence?: string[]; affected?: string[]; first_seen?: string; work_issue?: number | null; ul_issue?: number | null; source_ref?: string; category?: string; status?: string };
type Registry = { entries?: Entry[]; findings?: Entry[] } | Entry[];
/** owner/name of the work repo, resolved in live() from the install's work config; null keeps the issue number and drops the link. */
let workRepo: string | null = null;
/** The linked work-issue number; `ul_issue` is the key registries carried before 2026-10-13. */
const issueOf = (x: Entry): number | null => typeof x.work_issue === "number" ? x.work_issue : typeof x.ul_issue === "number" ? x.ul_issue : null;
const rows = (x?: Registry) => Array.isArray(x) ? x : Array.isArray(x?.entries) ? x.entries : Array.isArray(x?.findings) ? x.findings : [];
export function summarize(x: Entry, id: string): string {
  const affected = Array.isArray(x.affected) && x.affected.length ? `Affected: ${clip(x.affected.slice(0, 5).join(", "), 160)}${x.affected.length > 5 ? ` and ${x.affected.length - 5} more` : ""}.` : "";
  const where = issueOf(x) !== null ? `Work issue #${issueOf(x)}.` : x.source_ref ? `Source: ${clip(x.source_ref, 120)}.` : "";
  const evidence = Array.isArray(x.evidence) && x.evidence.length ? `Evidence: ${clip(x.evidence.slice(-2).join("; "), 240)}.` : "";
  return [x.description ? clip(x.description, 320) : evidence ? "" : `${x.severity} ${x.category ?? "security"} finding ${id}; no description recorded.`, affected, evidence, x.first_seen ? `First seen ${clock(x.first_seen)}.` : "", where, `Look: bun LIFEOS/TOOLS/Achilles.ts show ${id}`].filter(Boolean).join(" ");
}
const RANK: Record<string, number> = { info: 0, informational: 0, low: 1, medium: 2, high: 3, critical: 4 };
/** Only a live finding is news: remediated, accepted, informational and false-positive entries never announce as new (entries without a status are treated as open). */
const isOpen = (x?: Entry) => !!x && (x.status === undefined || x.status === "open");
export function diff(prev: Registry | undefined, next: Registry, repo: string | null = workRepo): VigilEvent[] {
  const before = new Map(rows(prev).map((x) => [String(x.id ?? x.key), x]));
  return rows(next).flatMap((x) => {
    const id = String(x.id ?? x.key ?? x.title ?? "finding"), sev = x.severity?.toLowerCase() ?? "", was = before.get(id), wasSev = was?.severity?.toLowerCase() ?? "";
    if (!isOpen(x) || (RANK[sev] ?? 0) < RANK.high!) return [];
    // A high raised to critical is news on its own: the high never texted (ISC-66), so the rise is the first text.
    const state = !was ? "open" : !isOpen(was) ? "reopened" : (RANK[wasSev] ?? 0) < (RANK[sev] ?? 0) ? "escalated" : "";
    if (!state) return [];
    const title = `${state === "open" ? "" : state === "reopened" ? "Reopened: " : `Escalated to ${sev}: `}${x.title ?? `Achilles finding ${id}`}`;
    const e = event("achilles", id, state, sev === "critical" ? "critical" : "medium", sev === "critical" || state === "escalated" ? title : `High: ${title}`, summarize(x, id), "security", issueOf(x) !== null && repo ? `https://github.com/${repo}/issues/${issueOf(x)}` : null, state === "open" ? undefined : `${state}:${x.first_seen ?? ""}:${sev}`);
    // ISC-47: bound the complete phone body, including Vigil's severity/title prefix. Overflow stays in
    // the registry entry; keep its show command on the phone so the full description and evidence are reachable.
    const budget = 399 - `${e.severity.toUpperCase()}: ${e.title} — `.length;
    const look = `Look: bun LIFEOS/TOOLS/Achilles.ts show ${id}`;
    const summary = sev === "critical" && e.summary.length > budget ? `${clip(e.summary, budget - look.length - 1)} ${look}` : e.summary;
    return [{ ...e, summary, meta: { ...(e.meta ?? {}), registered_severity: sev } }];
  });
}
async function resolveWorkRepo(): Promise<string | null> { try { const base = getClaudeDir(); const { loadWorkConfig } = await import(join(base, "hooks/lib/work-config.ts")); const repo = loadWorkConfig().repo; return typeof repo === "string" && repo.includes("/") ? repo : null; } catch { return null; } }
export async function live(): Promise<Registry> { workRepo = await resolveWorkRepo(); const registry = jsonFile<Registry>(registryPath()); need(Array.isArray(registry) || Array.isArray(registry.entries) || Array.isArray(registry.findings), "achilles registry entries or findings array"); need(rows(registry).every((row) => typeof row.id === "string" || typeof row.key === "string"), "achilles finding id or key"); return registry; }
export const read = () => withCursor("achilles", live, diff);
