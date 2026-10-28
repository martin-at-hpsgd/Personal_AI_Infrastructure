#!/usr/bin/env bun
/**
 * @version 1.0.0
 * IsaCodeSyncGate.hook.ts — the finish half of code sync (ISASystem.md § Code sync).
 *
 * Every change to a project with an ISA starts and finishes with that ISA, so the code stays in sync with it. A
 * feature once reached a release with its ISA untouched: ISAFoldGate only checks sessions bound to an Algorithm run, and it advises rather than blocks.
 *
 * BLOCK iff ALL hold; otherwise PASS:
 *   1. not a stop-hook recovery pass (the harness's loop guard)
 *   2. this turn has an answered, successful Edit, Write, MultiEdit or NotebookEdit of a code file whose governing
 *      ISA (LIFEOS/TOOLS/IsaGoverning.ts) exists
 *   3. that ISA got no answered, successful Edit, Write or MultiEdit in the same turn
 *
 * Keyed to the files, never to a registered run, the change's size or the reply's wording: no closing phrase
 * clears it. It reads tool-call paths only, never shell command text, so an ISA rewritten through Bash does not
 * count; write the ISA with Edit or Write. Not in StopGates' ADVISORY_GATES: this gate blocks.
 */
import { realpathSync } from "fs";
import { governingIsa } from "../LIFEOS/TOOLS/IsaGoverning";
import { transcriptToolCalls, type ToolCall } from "./ISAFoldGate.hook";
import type { HookInput } from "./lib/hook-io";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function pathOf(c: ToolCall): string | null {
  const p = c.input?.file_path ?? c.input?.notebook_path;
  return typeof p === "string" && p ? p : null;
}

function real(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** Governed code files this turn changed, grouped by governing ISA, minus the ISAs this turn also wrote. */
export function unsyncedIsas(calls: ToolCall[], resolve: (p: string) => string | null = governingIsa): Map<string, string[]> {
  const writes = calls.filter((c) => WRITE_TOOLS.has(c.name) && c.answered && c.ok);
  const isaWritten = new Set(writes.map(pathOf).filter((p): p is string => !!p && /(^|\/)ISA\.md$/.test(p)).map(real));
  const owed = new Map<string, string[]>();
  for (const c of writes) {
    const p = pathOf(c);
    if (!p) continue;
    const isa = resolve(p);
    if (!isa || isaWritten.has(isa)) continue;
    const list = owed.get(isa) ?? [];
    if (!list.includes(p)) list.push(p);
    owed.set(isa, list);
  }
  return owed;
}

export async function run(input: HookInput): Promise<object | null> {
  if ((input as { stop_hook_active?: boolean }).stop_hook_active) return null;
  const turn = transcriptToolCalls(input.transcript_path, "turn");
  if (!turn.ok) return null;
  const owed = unsyncedIsas(turn.calls);
  if (owed.size === 0) return null;
  const lines = [...owed].map(([isa, files]) => {
    const shown = files.slice(0, 4).join(", ") + (files.length > 4 ? `, …and ${files.length - 4} more` : "");
    return `  ${isa}\n    code changed this turn: ${shown}`;
  });
  return {
    decision: "block",
    reason:
      `ISA CODE SYNC [IsaCodeSyncGate]. This turn changed code governed by an ISA, but that ISA was not written in the same turn:\n${lines.join("\n")}\n` +
      `Every change to a project with an ISA starts and finishes with the ISA (ISASystem.md § Code sync, {{PRINCIPAL_NAME}} 2026-10-24). ` +
      `Fix it now, then restate: edit the ISA with Edit or Write, adding or ticking the criteria this change serves with their evidence, so the ISA and the code agree. ` +
      `Reply wording never substitutes for the edit.`,
  };
}

if (import.meta.main) {
  const { readHookInput } = await import("./lib/hook-io");
  const input = await readHookInput();
  const out = input ? await run(input) : null;
  if (out) console.log(JSON.stringify(out));
  process.exit(0);
}
