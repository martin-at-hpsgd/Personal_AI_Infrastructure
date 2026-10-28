/**
 * workflows-scanner adapter — answers internet-exposure questions from the hourly
 * infra-security scanner's findings ledger (the Bunker security plane).
 *
 * Reads GET /findings on the scanner flow worker (Bearer from
 * ~/.config/workflows/config.yaml — same auth path as the Pulse bunker module).
 * Never scans anything itself.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";
import { workflowsConfigPath } from "../../TOOLS/WorkflowsConfig";
import { PERSIST_AFTER } from "../../TOOLS/AchillesSync";

const VERSION = "workflows-scanner/1.1.0";

export interface Finding {
  key?: string; target?: string; category?: string; check?: string; severity?: string;
  first_seen?: string; resolved_at?: string | null; seen_count?: number;
}

function fleetConfig(): { subdomain: string; token: string; securityWorker: string } | null {
  try {
    const y = readFileSync(workflowsConfigPath(), "utf8");
    const subdomain = y.match(/^subdomain:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
    const token = y.match(/^auth_token:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
    const securityWorker = y.match(/^security_worker:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || "infra-security";
    if (!subdomain || !token) return null;
    return { subdomain, token, securityWorker };
  } catch {
    return null;
  }
}

/**
 * SOC-0001's verdict. A finding counts once it has persisted PERSIST_AFTER hourly scans, the same bar
 * Achilles registers on: a single bad scan (a rate-limited probe) can text a burst of false highs
 * that Achilles would correctly ignore. Unpersisted ones are named in the evidence, never hidden.
 */
export function judgeOpenCritHigh(findings: Finding[]): { verdict: "pass" | "fail"; value: number; evidence: string } {
  const openCritHigh = findings.filter((f) => !f.resolved_at && (f.severity === "critical" || f.severity === "high"));
  const persisted = openCritHigh.filter((f) => (f.seen_count ?? 0) >= PERSIST_AFTER);
  const pending = openCritHigh.length - persisted.length;
  const waiting = pending ? `; ${pending} critical/high seen fewer than ${PERSIST_AFTER} scans, not counted yet` : "";
  return {
    verdict: persisted.length === 0 ? "pass" : "fail",
    value: persisted.length,
    evidence: persisted.length
      ? persisted.slice(0, 5).map((f) => `${f.target}|${f.category}`).join(", ") + waiting
      : `0 persisted critical/high across ${findings.length} tracked findings${waiting}`,
  };
}

export const workflowsScanner: Adapter = {
  name: "workflows-scanner",
  version: VERSION,

  async answers(questions: Question[]): Promise<AnswerInput[]> {
    const cfg = fleetConfig();
    if (!cfg) {
      return questions.map((q) => ({
        question_id: q.id, verdict: "unknown" as const,
        evidence: "workflows config missing (~/.config/workflows/config.yaml)",
        computed_from: { touched: [], untouched: ["scanner:/findings"] },
        closer_version: VERSION,
      }));
    }
    const r = await fetch(`https://${cfg.securityWorker}.${cfg.subdomain}.workers.dev/findings`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`scanner /findings HTTP ${r.status}`);
    const body = (await r.json()) as { findings?: Finding[] } | Finding[];
    const findings = Array.isArray(body) ? body : (body.findings ?? []);
    const open = findings.filter((f) => !f.resolved_at);

    const computed_from = {
      touched: ["scanner:/findings (curated ∪ discovered targets, 16 categories)"],
      untouched: ["authenticated app surfaces (outsider-only scan)", "non-HTTP exposure (open ports beyond web)"],
    };

    return questions.map((q) => {
      const ref = q.answerer?.ref ?? "open-crit-high";
      if (ref === "open-crit-high") {
        return { question_id: q.id, ...judgeOpenCritHigh(findings), computed_from, closer_version: VERSION };
      }
      if (ref === "client-secrets") {
        const leaks = open.filter((f) => f.category === "client-secrets" || f.category === "sensitive-files");
        return {
          question_id: q.id,
          verdict: leaks.length === 0 ? ("pass" as const) : ("fail" as const),
          value: leaks.length,
          evidence: leaks.length ? leaks.slice(0, 5).map((f) => `${f.target}|${f.check}`).join(", ") : "no exposed-secret findings open",
          computed_from, closer_version: VERSION,
        };
      }
      return {
        question_id: q.id, verdict: "unknown" as const,
        evidence: `unrecognized ref '${ref}' for this adapter`,
        computed_from: { touched: [], untouched: ["scanner:/findings"] }, closer_version: VERSION,
      };
    });
  },
};
