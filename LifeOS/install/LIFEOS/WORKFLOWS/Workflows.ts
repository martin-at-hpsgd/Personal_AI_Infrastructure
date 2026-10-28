#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { buildInventory, defaultSources, findingKey, readSeries, recordSnapshot } from "./Inventory.ts";
import { invariant } from "../TOOLS/Invariant.ts";

const [command = "summary", ...args] = Bun.argv.slice(2);
const json = args.includes("--json");
const inventory = buildInventory();
const output = (value: unknown, lines: string[]): void => console.log(json ? JSON.stringify(value, null, 2) : lines.join("\n"));
switch (command) {
  case "summary": {
    // ISC-91: reading the summary also files today as one entry of the dated series, so the series grows without a separate job.
    const series = inventory.summary.snapshot ? recordSnapshot(inventory.summary.snapshot) : readSeries();
    output({ ...inventory.summary, series }, [
      `${inventory.summary.total} workflows · ${inventory.summary.scheduled} scheduled · ${inventory.summary.onDemand} on demand`,
      ...Object.entries(inventory.summary.byRuntime).map(([k, v]) => `${k}: ${v}`),
      ...Object.entries(inventory.summary.workflowStats ?? {}).map(([k, v]) => `${k}: ${v.runs} runs in 30d, ${Math.round(v.failureRate * 100)}% failed, median ${v.medianDurationMs ?? "-"} ms`),
      `${series.length} daily snapshot(s) kept`,
      `${inventory.summary.attention} findings need attention`,
    ]); break;
  }
  case "snapshot": {
    const series = inventory.summary.snapshot ? recordSnapshot(inventory.summary.snapshot) : readSeries();
    output(series, series.map(x => `${x.date}  checked ${x.checkedConnectionShare === null ? "n/a" : Math.round(x.checkedConnectionShare * 100) + "%"}  ${JSON.stringify(x.executorMix)}`)); break;
  }
  case "list": {
    const index = args.indexOf("--runtime");
    const records = inventory.records.filter(r => index < 0 || r.runtime === args[index + 1]);
    output(records, records.map(r => `${r.id}  ${r.title}  ${r.trigger.display}  ${r.installed}`)); break;
  }
  case "attention": output(inventory.findings, inventory.findings.map(f => `${f.acknowledged ? "✓" : "!"} ${f.sentence} (${f.ids.join(", ")})`)); break;
  case "show": {
    const r = inventory.records.find(x => x.id === args[0]);
    if (!r) { console.error(`Workflow not found: ${args[0] ?? ""}`); process.exitCode = 1; break; }
    output(r, [r.title, r.id, `Trigger: ${r.trigger.display}`, `Installed: ${r.installed}`, `Purpose: ${r.card.purpose ?? "undeclared"}`,
      `Input: ${r.card.input ?? "undeclared"}`, `Steps: ${r.card.steps.map(s => `${s.label} (${s.executor})`).join(", ") || "undeclared"}`,
      `SOP: ${r.card.sop ?? "undeclared"}`, `Output: ${r.card.output ?? "undeclared"}`, `Destination: ${r.card.destination ?? "undeclared"}`]); break;
  }
  case "json": console.log(JSON.stringify(inventory, null, 2)); break;
  case "acknowledge": {
    const path = defaultSources().baseline;
    invariant(path.endsWith("/LIFEOS/USER/CONFIG/workflows-baseline.json"), "Invalid workflow baseline destination");
    const acknowledged = inventory.findings.filter(f => f.kind === "missing" || f.kind === "orphan").map(findingKey).sort();
    writeFileSync(path, JSON.stringify({ acknowledged, at: new Date().toISOString() }, null, 2) + "\n");
    console.log(`Acknowledged ${acknowledged.length} missing or orphan findings.`); break;
  }
  default: console.error("Usage: Workflows.ts summary|snapshot|list|attention|show <id>|json|acknowledge [--json]"); process.exitCode = 1;
}
