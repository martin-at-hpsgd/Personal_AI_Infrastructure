/**
 * secrets adapter — answers "is the sealed env current, and is the plaintext
 * still untracked?" by reading two engines that already exist:
 *   - `LIFEOS/TOOLS/Secrets.ts status` (SEALED | STALE | UNSEALED | NOSEAL)
 *   - `git ls-files .env` in the config repo (tracked ⇒ keys in git)
 * Never reads the env contents. Never prints a value from it.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";

const VERSION = "secrets/1.0.0";
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const SECRETS_TS = join(CLAUDE, "LIFEOS/TOOLS/Secrets.ts");

/** Seal-state words `Secrets.ts status` prints; only SEALED is healthy. CORRUPT (exit 5) is a failing answer, never "unknown". */
export const KNOWN_STATUS_WORDS = ["SEALED", "STALE", "UNSEALED", "NOSEAL", "CORRUPT"];

export function classifyStatus(word: string, tracked: boolean): { verdict: "pass" | "fail" | "unknown"; value?: string; evidence: string } {
  if (!KNOWN_STATUS_WORDS.includes(word)) return { verdict: "unknown", evidence: "unrecognized status output" };
  const pass = word === "SEALED" && !tracked;
  const parts = [`seal: ${word}`, tracked ? "plaintext .env IS TRACKED in git" : "plaintext untracked"];
  return { verdict: pass ? "pass" : "fail", value: word, evidence: parts.join("; ") };
}

export const secrets: Adapter = {
  name: "secrets",
  version: VERSION,

  async answers(questions: Question[]): Promise<AnswerInput[]> {
    if (!existsSync(SECRETS_TS)) throw new Error(`Secrets.ts missing at ${SECRETS_TS}`);
    const st = Bun.spawnSync(["bun", SECRETS_TS, "status"], { stdout: "pipe", stderr: "pipe", cwd: CLAUDE });
    // First token of the status line is the state word; the rest may name a timestamp, never a secret.
    const word = st.stdout.toString().trim().split(/\s+/)[0] ?? "";
    const ls = Bun.spawnSync(["git", "-C", CLAUDE, "ls-files", ".env"], { stdout: "pipe", stderr: "pipe" });
    if (ls.exitCode !== 0) throw new Error(`git ls-files exit ${ls.exitCode}`);
    const tracked = ls.stdout.toString().trim().length > 0;

    const computed_from = {
      touched: ["Secrets.ts status (exit code + state word)", "git ls-files .env (config repo index)"],
      untouched: ["env contents", "per-key rotation age", "keychain identity presence"],
    };
    return questions.map((q) => {
      const c = classifyStatus(word, tracked);
      if (c.verdict === "unknown") {
        return { question_id: q.id, verdict: "unknown" as const, evidence: `${c.evidence} (exit ${st.exitCode})`, computed_from, closer_version: VERSION };
      }
      return {
        question_id: q.id,
        verdict: c.verdict,
        value: c.value,
        evidence: c.evidence,
        computed_from, closer_version: VERSION,
      };
    });
  },
};
