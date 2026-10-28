#!/usr/bin/env bun
/** Relay ISA ISC-41: the default reply is a text, not an essay.
 *
 * Ten prompts (short questions, reads, write asks) go through the production askDA path with the
 * texting soul and a synthetic sender, three trials each. The measured text is exactly what the
 * bridge would send: askDA's formatted reply. A case passes only when every trial is at or under
 * 400 characters (pass^k, k=3). No transport send happens and no personal file is read or written.
 *
 *   bun ReplyLengthEval.ts [--smoke] [--json]
 *
 * Exit 0 = every case held pass^k, 1 = a reply ran long, 2 = the agent was unavailable.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClaudeDir } from "../../TOOLS/Paths.ts";
import { admit, askDA, forgetSession, loadAuth, loadConfig, saveAuth, TEXTING_SOUL } from "./session.ts";

export const MAX_REPLY_CHARS = 400;

const SENDER = "+10000000000"; // synthetic; never a real line
const cfg = loadConfig();
const core = await import(join(getClaudeDir(), "hooks/lib/texting-guard-core.ts"));
const { runSuite } = await import(join(getClaudeDir(), "skills/Assay/Tools/EvalRunner.ts"));

export function corpus(dir: string): Array<{ id: string; kind: "question" | "read" | "write"; prompt: string }> {
  return [
    { id: "q_math", kind: "question", prompt: "What's 17 times 23?" },
    { id: "q_tomato", kind: "question", prompt: "Is a tomato a fruit or a vegetable?" },
    { id: "q_git", kind: "question", prompt: "How do I undo my last git commit but keep the changes?" },
    { id: "q_tcp", kind: "question", prompt: "What's the difference between TCP and UDP?" },
    { id: "q_hashmap", kind: "question", prompt: "Explain what a hash map is." },
    { id: "r_textus", kind: "read", prompt: "Read ~/.claude/LIFEOS/DOCUMENTATION/Tex/TexSystem.md and tell me what Tex is." },
    { id: "r_readme", kind: "read", prompt: "Read ~/.claude/LIFEOS/RELAY/bridge/README.md and tell me what the bridge does." },
    { id: "w_hello", kind: "write", prompt: `Create the file ${dir}/note-1.txt containing exactly the line "hello" and confirm.` },
    { id: "w_milk", kind: "write", prompt: `Save a note in ${dir}/note-2.txt that says "buy oat milk" and tell me when it's done.` },
    { id: "w_list", kind: "write", prompt: `Write a three-item grocery list (eggs, rice, limes) to ${dir}/list.txt and tell me what you wrote.` },
  ];
}

if (import.meta.main) {
  const smoke = process.argv.includes("--smoke");
  // Writes land in a throwaway directory (real path, so no symlink into private data) and are removed afterwards.
  const fixtureDir = mkdtempSync(join(realpathSync(tmpdir()), "relay-length-eval-"));
  const cases = corpus(fixtureDir).map((c) => ({
    id: c.id,
    prompt: c.prompt,
    assert: [
      { type: "max-length", threshold: MAX_REPLY_CHARS },
      { type: "min-length", threshold: 3 },
    ],
  }));
  let trial = 0;
  try {
    const result = await runSuite(
      "relay-reply-length",
      { type: "regression", system_prompt: TEXTING_SOUL, trials: smoke ? 1 : 3, pass_threshold: 1, cases: smoke ? cases.slice(0, 2) : cases },
      {
        invoke: async (options: { userPrompt: string; level?: "low" | "medium" | "high" | "max" }) => {
          trial++;
          forgetSession(SENDER);
          const auth = loadAuth();
          auth[SENDER] = core.unlock(undefined, cfg, Date.now()); // reads and writes must run, as they do for him once unlocked
          saveAuth(auth);
          const gate = admit(SENDER, options.userPrompt, cfg);
          if ("reply" in gate) return { success: false, output: "", error: "admission refused synthetic case", latencyMs: 0, level: options.level ?? "medium" };
          const r = await askDA(SENDER, gate.prompt, cfg, { resume: false });
          console.log(JSON.stringify({ trial, chars: r.text.length, reply: r.text, error: r.error }));
          return { success: !r.timedOut && !r.parseError, output: r.text, error: r.parseError ? "agent error" : undefined, latencyMs: r.ms, level: options.level ?? "medium" };
        },
      },
    );
    console.log(result.summary);
    process.exitCode = result.verifier_unavailable ? 2 : result.passed ? 0 : 1;
  } finally {
    forgetSession(SENDER);
    const auth = loadAuth();
    delete auth[SENDER];
    saveAuth(auth);
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}
