/**
 * services adapter — answers "are the background services alive?" from launchd
 * (macOS) for com.lifeos.* jobs. Per-service instances under one question.
 */

import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";

const VERSION = "services/1.0.0";

export const services: Adapter = {
  name: "services",
  version: VERSION,

  async answers(questions: Question[]): Promise<AnswerInput[]> {
    const p = Bun.spawnSync(["launchctl", "list"], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`launchctl list exit ${p.exitCode}`);
    // Format: PID\tStatus\tLabel — PID "-" means not running; Status is last exit code.
    const rows = p.stdout.toString().split("\n")
      .map((l) => l.split("\t"))
      .filter((c) => c.length === 3 && c[2].startsWith("com.lifeos."));
    const computed_from = {
      touched: [`launchctl list (${rows.length} com.lifeos.* jobs)`],
      untouched: ["whether a running service is doing useful work (liveness ≠ correctness)"],
    };
    const out: AnswerInput[] = [];
    for (const q of questions) {
      for (const [pid, status, label] of rows) {
        const healthy = pid !== "-" || status === "0"; // running now, or last run exited clean
        out.push({
          question_id: q.id,
          instance_key: label,
          verdict: healthy ? "pass" : "fail",
          value: healthy ? "ok" : `exit ${status}`,
          evidence: pid !== "-" ? `running (pid ${pid})` : `not running, last exit ${status}`,
          computed_from, closer_version: VERSION,
        });
      }
      if (rows.length === 0) {
        out.push({
          question_id: q.id, verdict: "unknown",
          evidence: "no com.lifeos.* jobs visible to launchctl",
          computed_from, closer_version: VERSION,
        });
      }
    }
    return out;
  },
};
