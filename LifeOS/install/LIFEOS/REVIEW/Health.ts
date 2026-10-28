/**
 * Health — are the measuring instruments alive? Checked before any number is trusted, because a dead
 * job makes every downstream number wrong without anyone noticing (errata-triage, 2026-10-05..07).
 *
 * @version 1.1.0
 */
export type InstrumentState = "ok" | "failing" | "stale" | "never";
export interface Instrument { id: string; kind: "agent-job" | "workflow" | "data" | "glance"; state: InstrumentState; last: string | null; detail: string }
export interface Job { id: string; kind: "agent-job" | "workflow"; maxHours: number }

/** The jobs that feed the Review. A job missing from its ledger reads "never", which is not an alarm. */
export const LEARNING_JOBS: Job[] = [
  // Errata daily (enrich, label, triage, its own state) and weekly (audit proposals) moved from agent jobs to workflows (current-ideal-delta F5).
  { id: "errata-daily", kind: "workflow", maxHours: 36 },
  { id: "errata-weekly", kind: "workflow", maxHours: 8 * 24 },
  { id: "prioritize", kind: "agent-job", maxHours: 6 },
  { id: "errata-misses-daily", kind: "workflow", maxHours: 36 },
  { id: "errata-impact-weekly", kind: "workflow", maxHours: 8 * 24 },
  { id: "ideal-reconcile", kind: "workflow", maxHours: 36 },
  { id: "ideal-recommend", kind: "workflow", maxHours: 36 },
  { id: "review-daily", kind: "workflow", maxHours: 36 },
  { id: "review-weekly", kind: "workflow", maxHours: 8 * 24 },
  { id: "review-monthly", kind: "workflow", maxHours: 32 * 24 },
];

export interface LastRun { ts: string; ok: boolean; detail?: string }

export function jobHealth(jobs: Job[], last: (job: Job) => LastRun | null, now: Date): Instrument[] {
  return jobs.map((job) => {
    const run = last(job);
    if (!run) return { id: job.id, kind: job.kind, state: "never", last: null, detail: "no run recorded" };
    const ageH = (now.getTime() - Date.parse(run.ts)) / 3_600_000;
    if (!run.ok) return { id: job.id, kind: job.kind, state: "failing", last: run.ts, detail: `last run failed${run.detail ? `: ${failureLine(run.detail)}` : ""}` };
    if (ageH > job.maxHours) return { id: job.id, kind: job.kind, state: "stale", last: run.ts, detail: `last success ${Math.round(ageH)}h ago (expected within ${job.maxHours}h)` };
    return { id: job.id, kind: job.kind, state: "ok", last: run.ts, detail: `ok ${Math.round(ageH)}h ago` };
  });
}

/** The line worth reading from a job's error tail: a named failed stage, else an error line, else the first line. Progress counters are noise. */
export function failureLine(detail: string): string {
  const lines = detail.split("\n").map((l) => l.trim()).filter((l) => l && !/^\S.*: \d+\/\d+ \(\d+ errors/.test(l));
  const pick = lines.find((l) => /failed stages/.test(l)) ?? lines.find((l) => /error|fail|timed out|exception/i.test(l) && !/\(0 errors/.test(l)) ?? lines[0] ?? detail;
  return pick.replace(/\s+/g, " ").slice(0, 200);
}

export function exchangesHealth(lastTs: string | null, now: Date, maxHours = 36): Instrument {
  if (!lastTs) return { id: "errata-exchanges", kind: "data", state: "never", last: null, detail: "no exchanges" };
  const ageH = (now.getTime() - Date.parse(lastTs)) / 3_600_000;
  return { id: "errata-exchanges", kind: "data", state: ageH > maxHours ? "stale" : "ok", last: lastTs, detail: `newest exchange ${Math.round(ageH)}h old` };
}

/**
 * Parses `Assay.ts status` text: `<caller>: mode=<mode> · rows(24h)=N · error_rate=X% · … · budget_skips=N`.
 * Callers under `minRows` are not judged. An error_rate of n/a (nothing was judged) fails only an enforcing caller with skips.
 * error_rate already excludes budget skips. A shadow caller's budget cap is its sample size, so skips never fail it;
 * an enforcing caller that skipped calls for budget did not make judgments it was meant to, so it reads failing.
 * A line without budget_skips (older output) counts as zero skips.
 */
export function glanceHealth(statusText: string, now: Date, opts: { maxErrorPct?: number; minRows?: number } = {}): Instrument[] {
  const maxErr = opts.maxErrorPct ?? 20, minRows = opts.minRows ?? 20;
  const out: Instrument[] = [];
  for (const m of statusText.matchAll(/^([\w.-]+): mode=(\S+) · rows\(24h\)=(\d+) · error_rate=([\d.]+%|n\/a)(?:.*? · budget_skips=(\d+))?/gm)) {
    const [, id, mode, rows, rate, skipText] = m;
    if (Number(rows) < minRows) continue;
    const skips = skipText === undefined ? 0 : Number(skipText);
    const judgedRate = rate !== "n/a";
    const outOfBudget = mode === "enforce" && skips > 0;
    if (!judgedRate && !outOfBudget) continue;
    const errFailing = judgedRate && parseFloat(rate) >= maxErr;
    const detail = (judgedRate ? `error rate ${rate} over ${rows} rows in 24h` : `no calls judged in ${rows} rows in 24h`) + (outOfBudget ? `; ran out of budget, ${skips} calls skipped in 24h` : "");
    out.push({ id: `glance:${id}`, kind: "glance", state: errFailing || outOfBudget ? "failing" : "ok", last: now.toISOString(), detail });
  }
  return out;
}

/** Instruments whose state differs from the last run's; only these reach Vigil. "never" is not news. */
export function healthChanges(prev: Record<string, InstrumentState>, current: Instrument[]): Instrument[] {
  return current.filter((i) => i.state !== "never" && (prev[i.id] ?? "ok") !== i.state);
}
