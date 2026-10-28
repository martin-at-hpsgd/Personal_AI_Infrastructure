#!/usr/bin/env bun
/**
 * @version 1.0.13
 * TRIGGER: PostToolUse (catchall, matcher "*") — fires on EVERY tool call.
 * PostToolObserver.hook.ts — the ONE sync catchall PostToolUse hook.
 *
 * Consolidation (2026-09-21): one process runs the three catchall observers,
 * followed by the applicable per-tool members:
 *
 *   (LoopDetector retired 2026-10-25, ISA 20261025-hook-minimization: a repeat the model can already see in its own context)
 *   1. AlgorithmNudge.run()  — Algorithm live nudge layer (run-scoped nudges +
 *                              always-on late-ISA; renamed from ISANudge 2026-07-11)
 *   2. SystemChangeSurface.run()
 *   Members: ISASync, CheckpointPerISC, AtlasEventCapture, KnowledgeWriteGuard
 *   (ISAStaleWriteGuard retired 2026-10-24: Claude Code refuses a write to a file changed since it was read)
 *   (SkillInvocationLog retired 2026-09-30: EventLogger writes the one run line)
 *   WorkflowPulseNudge (2026-10-11): after a Workflow launch, hands the DA the Monitor call for its one-line-a-minute pulse (maintainer-side; not in the public release)
 *   OutputRecord (2026-09-30, assay-everywhere S4): writes the output line for a file handed to the principal (maintainer-side; not in the public release)
 *   (Write/Edit/MultiEdit/Bash/Artifact/ArtifactData/ArtifactComments), after the tool succeeded, from the bytes that landed.
 *
 * Both emit additionalContext; outputs are joined with a newline into one
 * hookSpecificOutput. EventLogger stays separately registered (async — pure
 * observability, no context channel needed). Each sub-hook file remains the
 * owner of its logic and runnable standalone.
 *
 * Failure mode: per-sub-hook try/catch; never blocks the session; exit 0.
 *
 */

import { run as algorithmNudge } from "./AlgorithmNudge.hook";
import { recordDoctrine, run as systemChangeSurface } from "./SystemChangeSurface.hook";
import { HookTimer } from "./lib/hook-timing";
import { hookDrawn } from "./lib/function-hooks";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const MEMBERS_BY_TOOL = {
  Read: ["ISASync"],
  Write: ["ISASync", "CheckpointPerISC", "AtlasEventCapture", "KnowledgeWriteGuard", "OutputRecord"], // maintainer-side; not in the public release
  Edit: ["ISASync", "CheckpointPerISC", "AtlasEventCapture", "KnowledgeWriteGuard", "OutputRecord"], // maintainer-side; not in the public release
  MultiEdit: ["ISASync", "CheckpointPerISC", "AtlasEventCapture", "KnowledgeWriteGuard", "OutputRecord"], // maintainer-side; not in the public release
  Bash: ["AtlasEventCapture", "OutputRecord"], // maintainer-side; not in the public release
  Artifact: ["OutputRecord"], // maintainer-side; not in the public release
  ArtifactData: ["OutputRecord"], // maintainer-side; not in the public release
  ArtifactComments: ["OutputRecord"], // maintainer-side; not in the public release
  NotebookEdit: ["OutputRecord"], // maintainer-side; not in the public release
  Workflow: ["WorkflowPulseNudge"], // maintainer-side; not in the public release
} as const;

export type MemberName = (typeof MEMBERS_BY_TOOL)[keyof typeof MEMBERS_BY_TOOL][number];
export type MemberRun = (input: any) => unknown | Promise<unknown>;
export type MemberLoader = (name: MemberName) => Promise<MemberRun | null>;

/** Private members are release-zoned out of some installs, so absence is normal. */
export const loadMember: MemberLoader = async (name) => {
  const path = join(import.meta.dir, `${name}.hook.ts`);
  if (!existsSync(path)) return null;
  const mod = await import(path);
  return typeof mod.run === "function" ? mod.run as MemberRun : null;
};

type Timer = Pick<HookTimer, "timed">;

/** Run applicable members in registration order and return their model-visible text. */
export async function runMembers(
  input: Record<string, unknown>,
  timer: Timer,
  loader: MemberLoader = loadMember,
): Promise<string[]> {
  const names = MEMBERS_BY_TOOL[input.tool_name as keyof typeof MEMBERS_BY_TOOL] ?? [];
  const parts: string[] = [];
  for (const name of names) {
    try {
      const result = await timer.timed(name, async () => {
        const member = await loader(name);
        return member ? await member(input) : null;
      });
      // These are the only standalone shims that print run()'s returned context.
      if ((name === "ISASync" || name === "KnowledgeWriteGuard" || name === "OutputRecord" || name === "WorkflowPulseNudge") && typeof result === "string" && result) { // maintainer-side; not in the public release
        parts.push(result);
      }
    } catch {
      // Each member fails open; continue with the rest.
    }
  }
  return parts;
}

export function mergedOutput(input: Record<string, unknown>, parts: string[]): object | null {
  if (parts.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: (input.hook_event_name as string) || "PostToolUse",
      additionalContext: parts.join("\n"),
    },
  };
}

/** The ⚙️ line follows the 🧠 contract: computed by the hook, echoed verbatim.
 *  Stating that beside the line is what keeps it from being paraphrased. */
const SURFACE_PREAMBLE =
  "<lifeos-system-delta>\nSystem-surface changes this turn (computed deterministically by " +
  "SystemChangeSurface.hook.ts). Render this line VERBATIM as the ⚙️ SYSTEM line of the " +
  "output format, exactly once, immediately above the 🧠 MEMORY line. Do not recompute or " +
  "rephrase it:\n";

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), 2000);
    process.stdin.on("data", (c) => { data += c.toString(); });
    process.stdin.on("end", () => { clearTimeout(timer); resolve(data); });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(data); });
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);
  let input: Record<string, unknown>;
  try { input = JSON.parse(raw); } catch { process.exit(0); }

  const parts: string[] = [];
  const timer = new HookTimer("PostToolUse", input as never); // per-module timing → hook-timing.jsonl (/ic hook-latency)
  const m2 = await timer.timed("AlgorithmNudge", () => algorithmNudge(input as never)); if (m2) parts.push(m2);
  // When the LifeOSHooks plugin stamped this session it keeps the ⚙️ ledger in
  // memory and draws the line itself; the echo block is the fallback path only.
  recordDoctrine(input as never); // the statusline's doctrine mark, fed whether or not the plugin draws ⚙️
  const m3 = hookDrawn(input.session_id as string) ? null : await timer.timed("SystemChangeSurface", () => systemChangeSurface(input as never)); if (m3) parts.push(SURFACE_PREAMBLE + m3 + "\n</lifeos-system-delta>");
  parts.push(...await runMembers(input, timer));
  timer.flush();

  const output = mergedOutput(input, parts);
  if (output) console.log(JSON.stringify(output));
  process.exit(0);
}

if (import.meta.main) main().catch(() => process.exit(0));
