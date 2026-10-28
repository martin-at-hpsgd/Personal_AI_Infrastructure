/**
 * atlas adapter — answers estate-shape questions from the Atlas redacted
 * snapshot (never the live DB — single-writer invariant).
 *
 * refs: unregistered | stale | injection-ungoverned
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";

const VERSION = "atlas/1.0.0";
const SNAPSHOT = join(homedir(), ".local/state/lifeos/atlas/snapshot.json");

export const atlas: Adapter = {
  name: "atlas",
  version: VERSION,

  async answers(questions: Question[]): Promise<AnswerInput[]> {
    if (!existsSync(SNAPSHOT)) {
      return questions.map((q) => ({
        question_id: q.id, verdict: "unknown" as const,
        evidence: "atlas snapshot missing — run `bun LIFEOS/ATLAS/Atlas.ts export`",
        computed_from: { touched: [], untouched: ["atlas:snapshot"] }, closer_version: VERSION,
      }));
    }
    const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as {
      assets?: Array<{ id?: number; kind: string; status: string; canonical_key: string; attrs?: string }>;
      edges?: Array<{ kind: string; src: number; dst: number; status: string }>;
      unregistered?: Array<{ canonical_key: string }>;
      generated_at?: string;
    };
    const age = snap.generated_at ? Date.now() - Date.parse(snap.generated_at) : Number.POSITIVE_INFINITY;
    const staleSnapshot = age > 6 * 3600_000; // reconciliation is hourly; 6h means Atlas itself is down
    const computed_from = {
      touched: [`atlas:snapshot (${snap.generated_at ?? "?"})`],
      untouched: ["provider authority APIs (Atlas is derived state, not the authority)"],
    };

    return questions.map((q) => {
      if (staleSnapshot) {
        return {
          question_id: q.id, verdict: "unknown" as const,
          evidence: `atlas snapshot is ${Math.round(age / 3600_000)}h old — treating as unobservable`,
          computed_from, closer_version: VERSION,
        };
      }
      const ref = q.answerer?.ref ?? "unregistered";
      if (ref === "unregistered") {
        const n = snap.unregistered?.length ?? 0;
        return {
          question_id: q.id, verdict: n === 0 ? ("pass" as const) : ("fail" as const), value: n,
          evidence: n ? snap.unregistered!.slice(0, 8).map((u) => u.canonical_key).join(", ") : "every serving domain has a curated security-plane target",
          computed_from, closer_version: VERSION,
        };
      }
      if (ref === "stale") {
        const stale = (snap.assets ?? []).filter((a) => a.status !== "active");
        return {
          question_id: q.id, verdict: stale.length === 0 ? ("pass" as const) : ("fail" as const), value: stale.length,
          evidence: stale.length ? stale.slice(0, 8).map((a) => a.canonical_key).join(", ") : "no stale assets",
          computed_from, closer_version: VERSION,
        };
      }
      if (ref === "injection-ungoverned") {
        const surfaces = (snap.assets ?? []).filter((a) => a.kind === "ingest" && a.status === "active");
        if (surfaces.length === 0) {
          return {
            question_id: q.id, verdict: "unknown" as const,
            evidence: "no ingestion surfaces in the snapshot — run `atlas sync injection`",
            computed_from: { touched: [`atlas:snapshot (${snap.generated_at ?? "?"})`], untouched: ["atlas:injection surfaces"] }, closer_version: VERSION,
          };
        }
        const bad = ungovernedSurfaces(snap.assets ?? [], snap.edges ?? []);
        return {
          question_id: q.id, verdict: bad.length === 0 ? ("pass" as const) : ("fail" as const), value: bad.length,
          evidence: bad.length ? `${bad.length} untrusted surface(s) with nothing guarding them: ${bad.slice(0, 8).join(", ")}` : `every untrusted surface (${surfaces.length} mapped) has at least one active control`,
          computed_from, closer_version: VERSION,
        };
      }
      return {
        question_id: q.id, verdict: "unknown" as const, evidence: `unrecognized ref '${ref}'`,
        computed_from: { touched: [], untouched: ["atlas:snapshot"] }, closer_version: VERSION,
      };
    });
  },
};

/** Untrusted ingestion surfaces with zero active GUARDED_BY edges — the ungoverned class of the injection map. */
export function ungovernedSurfaces(
  assets: Array<{ id?: number; kind: string; status: string; canonical_key: string; attrs?: string }>,
  edges: Array<{ kind: string; src: number; dst: number; status: string }>,
): string[] {
  const guarded = new Set(edges.filter((e) => e.kind === "GUARDED_BY" && e.status === "active").map((e) => e.src));
  return assets
    .filter((a) => a.kind === "ingest" && a.status === "active")
    .filter((a) => { try { return JSON.parse(a.attrs ?? "{}").trust === "untrusted"; } catch { return false; } })
    .filter((a) => a.id === undefined || !guarded.has(a.id))
    .map((a) => a.canonical_key);
}
