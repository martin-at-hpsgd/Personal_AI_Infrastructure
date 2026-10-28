/**
 * backups adapter — answers "is my most recent backup complete and recent?"
 * from what a user-supplied backup job leaves behind: its log
 * (the closing "Backup complete" line carries the error count) and the offsite
 * manifest it writes per run (Manifests/YYYY-MM-DD.txt, one line per object
 * uploaded to the DR bucket). Reads only; never runs a backup.
 *
 * pass: the last run finished with zero errors AND its manifest is under 48h old.
 * fail: errors on the last run, or the newest manifest is older than 48h.
 * unknown: no log or no manifest to read.
 *
 * The restore drill the question's ideal names has no source yet — it stays in
 * `untouched`, honestly, rather than being faked as a pass.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";

const VERSION = "backups/1.0.0";
const MAX_AGE_H = 48;

/** The install root, read at call time so a CLAUDE_CONFIG_DIR install never reads the default install. */
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

export const logPath = () => process.env.SOCRATES_BACKUPS_LOG ?? join(claudeDir(), "LIFEOS/MEMORY/STATE/com.lifeos.backups.log");
export const manifestsDir = () => {
  if (process.env.SOCRATES_BACKUPS_MANIFESTS) return process.env.SOCRATES_BACKUPS_MANIFESTS;
  const config = join(claudeDir(), "LIFEOS/USER/CONFIG/backups.json");
  if (existsSync(config)) {
    try {
      const configured = (JSON.parse(readFileSync(config, "utf8")) as { backups_manifest_dir?: unknown }).backups_manifest_dir;
      if (typeof configured === "string" && configured.trim()) {
        return configured.replace(/^~(?=\/|$)/, homedir());
      }
    } catch { /* Invalid user config falls through to the standard state directory. */ }
  }
  return join(homedir(), ".local/state/lifeos/backups/manifests");
};

/** The last closing banner in the log → error count, or null when none. */
export function lastRunErrors(log: string): number | null {
  const lines = log.split("\n").filter((l) => l.includes("Backup complete"));
  const last = lines[lines.length - 1];
  if (!last) return null;
  const m = last.match(/with (\d+) error/);
  return m ? Number(m[1]) : 0;
}

/** Newest YYYY-MM-DD.txt manifest name, or null. */
export function newestManifest(names: string[]): string | null {
  return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.txt$/.test(n)).sort().slice(-1)[0] ?? null;
}

export function ageHours(manifest: string, now = Date.now()): number {
  // Manifests are dated by the run's calendar day; treat as start of that day UTC.
  return (now - Date.parse(manifest.slice(0, 10) + "T00:00:00Z")) / 3_600_000;
}

export function judge(log: string | null, manifests: string[], now = Date.now()): Omit<AnswerInput, "question_id"> {
  const computed_from = {
    touched: ["com.lifeos.backups log (closing banner)", "Backups/Manifests (newest file)"],
    untouched: ["restore drill — no drill has a recorded source yet", "archive sizes against a normal range"],
  };
  if (log === null) return { verdict: "unknown", evidence: `backups log missing at ${logPath()}`, computed_from, closer_version: VERSION };
  const errors = lastRunErrors(log);
  const newest = newestManifest(manifests);
  if (errors === null || !newest) {
    return { verdict: "unknown", evidence: errors === null ? "no completed run in the log" : "no offsite manifest found", computed_from, closer_version: VERSION };
  }
  const age = Math.round(ageHours(newest, now));
  const fresh = age <= MAX_AGE_H;
  const ok = errors === 0 && fresh;
  const problems = [errors ? `last run finished with ${errors} error(s)` : "", fresh ? "" : `newest manifest ${newest} is ${age}h old (> ${MAX_AGE_H}h)`].filter(Boolean);
  return {
    verdict: ok ? "pass" : "fail",
    value: `${errors} error(s), manifest ${newest.slice(0, 10)} (${age}h)`,
    evidence: ok ? `last run clean; offsite manifest ${newest} is ${age}h old` : problems.join("; "),
    computed_from,
    closer_version: VERSION,
  };
}

export const backups: Adapter = {
  name: "backups",
  version: VERSION,
  async answers(questions: Question[]): Promise<AnswerInput[]> {
    const lp = logPath();
    const log = existsSync(lp) ? readFileSync(lp, "utf8") : null;
    const md = manifestsDir();
    const manifests = existsSync(md) ? readdirSync(md) : [];
    const verdict = judge(log, manifests);
    return questions.map((q) => ({ question_id: q.id, ...verdict }));
  },
};
