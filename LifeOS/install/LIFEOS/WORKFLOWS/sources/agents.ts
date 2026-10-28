import { existsSync, readFileSync } from "node:fs";
import { card, cronTrigger, emptyEvidence, record, scriptName, step } from "./shared.ts";
import type { WorkflowRecord } from "../types.ts";

/** The launchd record an agent job is scheduled by; Inventory drops it from the list once absorbed. */
export const launchdHomeOf = (jobId: string): string => `launchd:com.lifeos.job.${jobId}`;

export function collectAgents(config: string, runsPath: string, launchd: Map<string, WorkflowRecord>, shown: (path: string) => string, error: (source: string, message: string) => void): WorkflowRecord[] {
  if (!existsSync(config)) return [];
  let jobs: any[], runs: Record<string, any> = {};
  try { jobs = JSON.parse(readFileSync(config, "utf8")).jobs ?? []; } catch (e) { error(shown(config), String(e)); return []; }
  if (existsSync(runsPath)) try { runs = JSON.parse(readFileSync(runsPath, "utf8")); } catch (e) { error(shown(runsPath), String(e)); }
  return jobs.flatMap(j => {
    if (!j?.id) return [];
    const home = launchdHomeOf(j.id), l = launchd.get(home), run = runs[j.id];
    const steps = [];
    if (j.preScript) steps.push(step(`${j.gate || /gate/i.test(scriptName(j.preScript)) ? "wake gate: " : ""}${scriptName(j.preScript)}`, "code", "pre"));
    if (j.command) steps.push(step(scriptName(j.command), "code", "main"));
    if (j.prompt) steps.push(step(`model turn (${j.vendor ?? "default"}/${j.lane ?? "default"})`, "model", "model"));
    const status = run?.lastStatus === "ok" ? "ok" : run?.lastStatus ? "error" : "unknown";
    return [record("agent-job", j.id, j.title ?? j.id, j.lane ?? "agent", cronTrigger(String(j.schedule ?? "")), shown(config), {
      enabled: j.enabled !== false, installed: l?.installed ?? "absent",
      // The launchd plist that schedules the job is the same work, not a second
      // workflow: it is absorbed into this record and carried as a fact.
      ...(l && l.installed !== "absent" ? { alsoInstalledAs: `${l.name} · ${l.evidence.source ?? l.definedIn}` } : {}),
      evidence: { ...emptyEvidence(), kind: "run-log", lastRunAt: run?.lastRunAt ?? null, lastStatus: status, runs: run?.runs ?? null, source: shown(runsPath) },
      card: card({ purpose: j.purpose ?? j.title, steps, output: j.deliver?.kind ? "text" : null, destination: j.deliver?.kind === "imessage" ? "iMessage via Relay" : null }) } )];
  });
}
