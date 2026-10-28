/**
 * bunker adapter — answers "is every registered app green?" from the cloud
 * site-health worker's /status (the Bunker observability plane). Reads the
 * same authenticated endpoint the Pulse bunker module reads.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";
import { workflowsConfigPath } from "../../TOOLS/WorkflowsConfig";

const VERSION = "bunker/1.1.0";

function fleetConfig(): { subdomain: string; token: string; siteHealthWorker: string } | null {
  try {
    const y = readFileSync(workflowsConfigPath(), "utf8");
    const subdomain = y.match(/^subdomain:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
    const token = y.match(/^auth_token:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
    const siteHealthWorker = y.match(/^site_health_worker:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || "site-health";
    if (!subdomain || !token) return null;
    return { subdomain, token, siteHealthWorker };
  } catch {
    return null;
  }
}

export const bunker: Adapter = {
  name: "bunker",
  version: VERSION,

  async answers(questions: Question[]): Promise<AnswerInput[]> {
    // ref "pulse-display" is the watcher-watch: does the Pulse Bunker tab show
    // every app the registry discovers, on a fresh snapshot? Answered by the
    // engine's own verb (`bunker verify-pulse --json`), never re-derived here.
    // ref "heartbeats" is the layer above: does the CLOUD still hear the local
    // watchers? Reads the site-health worker's verdict on heartbeat:* rows.
    const displayQs = questions.filter((q) => q.answerer?.ref === "pulse-display");
    const hbQs = questions.filter((q) => q.answerer?.ref === "heartbeats");
    const cloudQs = questions.filter((q) => !q.answerer?.ref);
    const out: AnswerInput[] = [];
    if (displayQs.length) out.push(...(await pulseDisplayAnswers(displayQs)));
    if (hbQs.length) out.push(...(await heartbeatAnswers(hbQs)));
    if (cloudQs.length) out.push(...(await cloudAnswers(cloudQs)));
    return out;
  },
};

async function heartbeatAnswers(questions: Question[]): Promise<AnswerInput[]> {
  const cfg = fleetConfig();
  if (!cfg) {
    return questions.map((q) => ({
      question_id: q.id, verdict: "unknown" as const,
      evidence: "workflows config missing (~/.config/workflows/config.yaml)",
      computed_from: { touched: [], untouched: ["site-health:/status heartbeat rows"] }, closer_version: VERSION,
    }));
  }
  const r = await fetch(`https://${cfg.siteHealthWorker}.${cfg.subdomain}.workers.dev/status`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`site-health /status HTTP ${r.status}`);
  const data = (await r.json()) as { apps?: Array<{ name: string; type?: string; state: string; checks?: Array<{ label: string }> }> };
  const beats = (data.apps ?? []).filter((a) => a.type === "heartbeat");
  const red = beats.filter((a) => a.state !== "green");
  const computed_from = {
    touched: [`site-health:/status (${beats.length} heartbeat rows)`],
    untouched: ["watchers that have never heartbeated (invisible to the cloud until their first run)"],
  };
  // No rows at all is not a pass: the switch is unarmed.
  const verdict = beats.length === 0 ? ("fail" as const) : red.length === 0 ? ("pass" as const) : ("fail" as const);
  return questions.map((q) => ({
    question_id: q.id, verdict,
    value: beats.length === 0 ? "0 heartbeats registered" : `${beats.length - red.length}/${beats.length} green`,
    evidence: beats.length === 0
      ? "the cloud has no heartbeat rows — no watcher has reported in yet"
      : red.length ? `quiet: ${red.map((a) => `${a.name} (${a.checks?.[0]?.label ?? "?"})`).join(", ")}` : `all heartbeats fresh: ${beats.map((a) => a.name.replace(/^heartbeat:/, "")).join(", ")}`,
    computed_from, closer_version: VERSION,
  }));
}

async function pulseDisplayAnswers(questions: Question[]): Promise<AnswerInput[]> {
  const bin = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "LIFEOS/PULSE/Bunker/bin/bunker.ts");
  if (!existsSync(bin)) {
    return questions.map((q) => ({
      question_id: q.id, verdict: "unknown" as const,
      evidence: "Bunker CLI not present on this install (private component)",
      computed_from: { touched: [], untouched: ["bunker verify-pulse"] }, closer_version: VERSION,
    }));
  }
  const proc = Bun.spawn(["bun", bin, "verify-pulse", "--json"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  let v: { ok: boolean; reason: string; registry: number; shown: number; missing: string[]; stale: boolean } | null = null;
  try { v = JSON.parse(stdout.trim().split("\n").pop() ?? ""); } catch { v = null; }
  if (!v) {
    return questions.map((q) => ({
      question_id: q.id, verdict: "unknown" as const,
      evidence: `bunker verify-pulse exit ${code} with no JSON verdict`,
      computed_from: { touched: ["bunker verify-pulse"], untouched: [] }, closer_version: VERSION,
    }));
  }
  const verdict = v.ok ? ("pass" as const) : ("fail" as const);
  return questions.map((q) => ({
    question_id: q.id, verdict,
    value: `${v.shown}/${v.registry} shown${v.stale ? " · stale" : ""}`,
    evidence: v.reason,
    computed_from: { touched: ["bunker registry (discoverApps)", "Pulse /api/bunker"], untouched: ["the cloud site-health plane (its own standing question covers it)"] },
    closer_version: VERSION,
  }));
}

async function cloudAnswers(questions: Question[]): Promise<AnswerInput[]> {
  {
    const cfg = fleetConfig();
    if (!cfg) {
      return questions.map((q) => ({
        question_id: q.id, verdict: "unknown" as const,
        evidence: "workflows config missing (~/.config/workflows/config.yaml)",
        computed_from: { touched: [], untouched: ["site-health:/status"] }, closer_version: VERSION,
      }));
    }
    const r = await fetch(`https://${cfg.siteHealthWorker}.${cfg.subdomain}.workers.dev/status`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`site-health /status HTTP ${r.status}`);
    const data = (await r.json()) as { apps?: Array<{ name: string; state: string }>; total?: number; red?: number; degraded?: number };
    const red = (data.apps ?? []).filter((a) => a.state === "red");
    const degraded = (data.apps ?? []).filter((a) => a.state === "degraded");
    const computed_from = {
      touched: [`site-health:/status (${data.total ?? data.apps?.length ?? 0} apps)`],
      untouched: ["apps never registered in Bunker (the atlas unregistered question covers those)"],
    };
    return questions.map((q) => ({
      question_id: q.id,
      verdict: red.length === 0 ? ("pass" as const) : ("fail" as const),
      value: `${red.length} red / ${degraded.length} degraded`,
      evidence: red.length ? `red: ${red.map((a) => a.name).join(", ")}` : "no registered app is red",
      computed_from, closer_version: VERSION,
    }));
  }
}
