import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { allServices, type Svc } from "../../TOOLS/Services.ts";
import { card, emptyEvidence, everySeconds, record, scriptName, step, cronTrigger } from "./shared.ts";
import type { WorkflowRecord, Trigger } from "../types.ts";

export function collectLaunchd(dir: string, listText: string, shown: (path: string) => string, error: (source: string, message: string) => void, registry: Svc[] = allServices(), declined = new Set<string>()): { records: WorkflowRecord[]; optIn: Set<string> } {
  const plists = new Map<string, any>();
  if (existsSync(dir)) for (const file of readdirSync(dir).filter(f => /^com\.lifeos\..*\.plist$/.test(f))) {
    const path = join(dir, file);
    try {
      const p = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", path], { stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(p.stderr.toString().slice(0, 200));
      const data = JSON.parse(p.stdout.toString());
      plists.set(data.Label ?? file.slice(0, -6), { data, path });
    } catch (e) { error(shown(path), String(e)); }
  }
  const loaded = new Map<string, { pid: string; status: number }>();
  for (const line of listText.split("\n")) {
    const m = /^\s*(\S+)\s+(-?\d+)\s+(com\.lifeos\.\S+)/.exec(line);
    if (m) loaded.set(m[3], { pid: m[1], status: Number(m[2]) });
  }
  const rows = new Map(registry.filter(s => s.label.startsWith("com.lifeos.")).map(s => [s.label, s]));
  const records: WorkflowRecord[] = [];
  for (const label of new Set([...rows.keys(), ...plists.keys()])) {
    const svc = rows.get(label), plist = plists.get(label), data = plist?.data ?? {}, state = loaded.get(label);
    let trigger: Trigger = { kind: "on-demand", expr: null, display: "on demand", periodMinutes: null };
    if (typeof data.StartInterval === "number") trigger = { kind: "schedule", expr: `${data.StartInterval}s`, display: everySeconds(data.StartInterval), periodMinutes: data.StartInterval / 60 };
    else if (data.StartCalendarInterval) {
      const c = Array.isArray(data.StartCalendarInterval) ? data.StartCalendarInterval[0] : data.StartCalendarInterval;
      trigger = cronTrigger(`${c.Minute ?? 0} ${c.Hour ?? "*"} * * ${c.Weekday ?? "*"}`);
    } else if (data.KeepAlive) trigger = { kind: "daemon", expr: null, display: "always on", periodMinutes: null };
    const installed = plist ? state ? "loaded" : "on-disk" : "absent";
    const args = data.ProgramArguments ?? (data.Program ? [data.Program] : []);
    records.push(record("launchd", label, svc?.title ?? label.replace(/^com\.lifeos\./, ""), svc?.category ?? "unregistered", trigger,
      shown(plist?.path ?? dir), { declared: !!svc, installed, enabled: !declined.has(label) || installed !== "absent", evidence: {
        ...emptyEvidence(), kind: "launchd-exit", lastStatus: !state ? "unknown" : state.pid === "-" && state.status !== 0 ? "error" : "ok", source: plist ? shown(plist.path) : null },
        card: card({ purpose: svc?.purpose, steps: args.length ? [step(scriptName(args))] : [], destination: data.StandardOutPath ? shown(data.StandardOutPath) : null }) }));
    // ISC-89: a com.lifeos.wf.<name> plist carries the hash of the definition it was compiled from in this key
    // (engine/schedule.ts does not exist yet, so the key is defined here: LifeOSDefinitionHash).
    if (typeof data.LifeOSDefinitionHash === "string") records[records.length - 1].compiledFrom = data.LifeOSDefinitionHash;
  }
  return { records, optIn: new Set(registry.filter(s => s.optIn).map(s => `launchd:${s.label}`)) };
}
