import { existsSync, readFileSync } from "node:fs";
import { card, cronTrigger, emptyEvidence, record, scriptName, step } from "./shared.ts";
import type { WorkflowRecord } from "../types.ts";

export function collectPulse(configs: string[], statePath: string, shown: (path: string) => string, error: (source: string, message: string) => void): WorkflowRecord[] {
  let state: Record<string, any> = {};
  if (existsSync(statePath)) try { state = JSON.parse(readFileSync(statePath, "utf8")).jobs ?? {}; } catch (e) { error(shown(statePath), String(e)); }
  // Later configs override earlier ones by job name, as Pulse's own loader merges PULSE.user.toml over PULSE.toml (lib.ts
  // loadConfig); without it a user override that turns a job off still read as running (2026-10-22).
  const byName = new Map<string, WorkflowRecord>();
  for (const path of configs) {
    if (!existsSync(path)) continue;
    try {
      const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as any;
      for (const j of parsed.job ?? []) {
        if (!j.name) continue;
        const run = state[j.name], destination = ({ voice: "spoken via VoiceServer", ntfy: "ntfy push", email: "email", log: "Pulse log" } as Record<string, string>)[j.output];
        byName.set(j.name, record("pulse-cron", j.name, j.name.replace(/-/g, " "), "pulse", cronTrigger(String(j.schedule ?? "")), shown(path), {
          enabled: j.enabled !== false, installed: j.enabled === false ? "absent" : "deployed", evidence: { ...emptyEvidence(), kind: "state-file", source: shown(statePath), lastRunAt: run?.lastRun ? new Date(run.lastRun).toISOString() : null,
            lastStatus: run?.lastResult === "error" || run?.consecutiveFailures > 0 ? "error" : run?.lastResult === "ok" ? "ok" : "unknown" },
          card: card({ steps: [step(scriptName(j.command), j.type === "claude" ? "model" : "code")], destination }) }));
      }
    } catch (e) { error(shown(path), String(e)); }
  }
  return [...byName.values()];
}
