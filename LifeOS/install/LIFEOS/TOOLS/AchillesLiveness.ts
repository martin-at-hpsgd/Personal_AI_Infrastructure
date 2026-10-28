/**
 * Send-time liveness for Achilles escalation texts (Vigil ISC-79), outside the adapter tree.
 *
 * The logic is copied from LIFEOS/VIGIL/adapters/achilles.ts `stillLive` (migration design §1.3, Lane D):
 * the adapters move to STATVS, but Vigil's tick still asks this question just before it sends, so the
 * answer lives in TOOLS where Vigil (through LIFEOS/VIGIL/Liveness.ts) and AchillesRemediate can both
 * reach it. The adapter keeps its own copy until p3; the two must answer alike, and the liveness test
 * checks both.
 *
 * Unknown or unreadable intent stays live: only matched, persisted evidence may suppress a decision the
 * principal still needs to hear.
 * @version 1.0.0
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getClaudeDir } from "./Paths";
import type { RemediationState } from "./AchillesRemediate";

/** The fields of a Vigil event this check reads. */
export type LivenessEvent = { ref: string | null; meta?: Record<string, unknown> };

export const remediationPath = (): string => join(getClaudeDir(), "LIFEOS/USER/SECURITY/ACHILLES/remediation.json");

/** False only when the remediation state shows the escalation text was cancelled or every entry it carries is closed or delivered. */
export function stillLive(e: LivenessEvent, path = remediationPath()): boolean {
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
