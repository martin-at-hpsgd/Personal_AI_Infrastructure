#!/usr/bin/env bun
/**
 * @version 1.0.0
 * Nightly.ts — build, label and trigger in order, then one Vigil event with the counts, quiet runs included.
 * Run by the evidence-nightly workflow. A failed step still emits (severity medium) and exits 1.
 *
 *   bun LIFEOS/EVIDENCE/Nightly.ts [--emit] [--json] [--dry-run]
 */
import { join } from "path";
import { getClaudeDir } from "../TOOLS/Paths";
import { emitVigilEvent } from "../TOOLS/lib/VigilOptional";
import { build, openDb } from "./Store";
import { label } from "./Label";
import { trigger } from "./Trigger";
import { DEFAULT_SINCE } from "./Project";

export interface NightlyResult { ok: boolean; error: string | null; human_turns: number; turns_with_next: number; mean_p_bad: number | null; cut: number | null; qualifying: number; appended: number; bytes_read: number; emitted: boolean }

export async function nightly(opts: { emit?: (e: Record<string, unknown>) => unknown; dryRun?: boolean } = {}): Promise<NightlyResult> {
  const claude = getClaudeDir();
  const db = join(claude, "LIFEOS/MEMORY/EVIDENCE/evidence.sqlite");
  const r: NightlyResult = { ok: false, error: null, human_turns: 0, turns_with_next: 0, mean_p_bad: null, cut: null, qualifying: 0, appended: 0, bytes_read: 0, emitted: false };
  try {
    const b = build({ db, since: DEFAULT_SINCE, projects: join(claude, "projects"), router: join(claude, "LIFEOS/MEMORY/OBSERVABILITY/router-decisions.jsonl"), pricing: join(claude, "LIFEOS/TOOLS/model-pricing.json") });
    r.bytes_read = b.bytes_read;
    const h = openDb(db);
    try {
      const l = label(h, { goldDir: join(claude, "LIFEOS/USER/ERRATA/v4") });
      r.human_turns = l.human_turns; r.turns_with_next = l.turns_with_next; r.mean_p_bad = Math.round(l.mean_p_bad * 10000) / 10000;
      const t = trigger(h, { dryRun: opts.dryRun === true });
      r.cut = t.cut; r.qualifying = t.qualifying; r.appended = opts.dryRun ? 0 : t.appended;
    } finally { h.close(); }
    r.ok = true;
  } catch (e) {
    r.error = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
  }
  if (opts.emit) {
    const now = new Date();
    const sent = opts.emit({
      id: crypto.randomUUID(), source: "evidence-nightly", ts: now.toISOString(), kind: "ai", severity: r.ok ? "info" : "medium",
      title: r.ok ? `Evidence nightly: ${r.human_turns} human turns labeled, ${r.appended} detected misses filed` : "Evidence nightly failed",
      summary: r.ok ? `Read ${r.bytes_read} new transcript bytes. Mean P(bad) ${r.mean_p_bad}. ${r.qualifying} turns at or above the cut ${r.cut ?? "(none)"}; ${r.appended} appended to Errata as detected.` : `Error: ${r.error}`,
      ref: "LIFEOS/EVIDENCE/Nightly.ts", url: null, privacy_class: "personal", dedup_key: `evidence-nightly-${now.toISOString().slice(0, 10)}`,
      meta: { human_turns: r.human_turns, turns_with_next: r.turns_with_next, mean_p_bad: r.mean_p_bad, cut: r.cut, qualifying: r.qualifying, appended: r.appended, ok: r.ok },
    });
    r.emitted = sent !== false;
  }
  return r;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const emit = args.includes("--emit") ? ((e: Record<string, unknown>) => emitVigilEvent(e as never)) : undefined;
  const r = await nightly({ emit, dryRun: args.includes("--dry-run") });
  console.log(args.includes("--json") ? JSON.stringify(r) : r);
  process.exit(r.ok ? 0 : 1);
}
