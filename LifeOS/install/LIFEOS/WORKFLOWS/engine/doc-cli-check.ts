#!/usr/bin/env bun
/**
 * Drift check between `WorkflowsSystem.md § The CLI` and `workflow help --json`
 * (ISA ISC-140). The doc's command table must list exactly the commands the CLI
 * prints, with the same usage and the same runs-steps flag.
 *
 *   bun LIFEOS/WORKFLOWS/engine/doc-cli-check.ts [--doc PATH] [--json]
 *
 * Exit 0 when they match, 1 on any drift (each difference is named), 2 usage.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMANDS, type CommandSpec } from "../workflow.ts";

export const DEFAULT_DOC = resolve(import.meta.dir, "..", "..", "DOCUMENTATION", "Workflows", "WorkflowsSystem.md");

export interface DocRow {
  usage: string;
  runsSteps: boolean;
}

/** The usage text as the doc spells it: no `workflow ` prefix, no trailing `[--json]` (every command takes it). */
export const docUsage = (usage: string): string => usage.replace(/^workflow /, "").replace(/ \[--json\]$/, "").trim();

const commandName = (usage: string): string => usage.split(/\s+/)[0];

/** The rows of the first table under "## The CLI": the one whose header starts `| Command |`. */
export function parseCliTable(doc: string): DocRow[] | null {
  const lines = doc.split("\n");
  const start = lines.findIndex(l => /^## The CLI\s*$/.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const section = lines.slice(start + 1, end);
  const header = section.findIndex(l => /^\|\s*Command\s*\|/.test(l));
  if (header < 0) return null;
  const rows: DocRow[] = [];
  for (const line of section.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    // Cells split on an unescaped pipe: `\|` inside a cell is a literal pipe.
    const cells = line.replace(/^\||\|\s*$/g, "").split(/(?<!\\)\|/).map(c => c.trim());
    if (cells.length < 3) continue;
    const usage = cells[0].replace(/^`|`$/g, "").replace(/\\\|/g, "|").replace(/ \[--json\]$/, "").trim();
    rows.push({ usage, runsSteps: /^yes$/i.test(cells[2]) });
  }
  return rows;
}

export function compareDocToCatalog(doc: string, commands: CommandSpec[]): string[] {
  const rows = parseCliTable(doc);
  if (!rows) return ['The doc has no "## The CLI" section with a "| Command |" table.'];
  const drift: string[] = [];
  const byName = new Map<string, DocRow>();
  for (const row of rows) {
    const name = commandName(row.usage);
    if (byName.has(name)) drift.push(`The doc lists "${name}" more than once.`);
    byName.set(name, row);
  }
  for (const command of commands) {
    const row = byName.get(command.name);
    if (!row) {
      drift.push(`help --json lists "${command.name}", the doc table does not.`);
      continue;
    }
    if (row.usage !== docUsage(command.usage)) drift.push(`"${command.name}" usage differs. doc: \`${row.usage}\` cli: \`${docUsage(command.usage)}\``);
    if (row.runsSteps !== command.executes_steps) drift.push(`"${command.name}" runs steps: doc says ${row.runsSteps ? "yes" : "no"}, cli says ${command.executes_steps ? "yes" : "no"}.`);
  }
  const known = new Set(commands.map(c => c.name));
  for (const name of byName.keys()) if (!known.has(name)) drift.push(`The doc lists "${name}", help --json does not.`);
  return drift;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const docIndex = args.indexOf("--doc");
  const docPath = docIndex >= 0 ? args[docIndex + 1] : DEFAULT_DOC;
  const unknown = args.filter((a, i) => a !== "--json" && a !== "--doc" && !(docIndex >= 0 && i === docIndex + 1));
  if (unknown.length || (docIndex >= 0 && !docPath)) {
    console.error("usage: doc-cli-check.ts [--doc PATH] [--json]");
    process.exit(2);
  }
  if (!existsSync(docPath)) {
    console.error(`No doc at ${docPath}`);
    process.exit(1);
  }
  const drift = compareDocToCatalog(readFileSync(docPath, "utf8"), COMMANDS);
  console.log(json ? JSON.stringify({ ok: drift.length === 0, doc: docPath, commands: COMMANDS.length, drift }, null, 2) : drift.length ? drift.map(d => `drift: ${d}`).join("\n") : `ok: ${COMMANDS.length} commands match ${join("WorkflowsSystem.md", "§ The CLI")}`);
  process.exit(drift.length === 0 ? 0 : 1);
}
