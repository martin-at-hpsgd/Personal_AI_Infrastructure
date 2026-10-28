// The provisional marker on the Bunker page (ISC-20, ISC-44.2 of
// 20260908-universal-eval-reeval). A judged eval row whose judge has no earned
// calibration record is provisional; the monitor computes the mark (age in
// days since the suite's oldest run, the reason, and whether it is past the
// limit) and the page only renders it. Pure so the colour decision is asserted.

export interface ProvisionalMark {
  age_days: number | null;
  reason: string;
  /** Past PROVISIONAL_RED_DAYS (Calibration.ts); decided by the runner, never here. */
  red: boolean;
}

export type ProvisionalDim = "warn" | "err";

/** Amber while young; red once any provisional row is past the limit. */
export function provisionalDim(marks: (ProvisionalMark | null | undefined)[]): ProvisionalDim | null {
  const live = marks.filter((m): m is ProvisionalMark => !!m);
  if (live.length === 0) return null;
  return live.some((m) => m.red) ? "err" : "warn";
}

/** "2 provisional judges · 41d" — count plus the oldest age. */
export function provisionalSummary(marks: (ProvisionalMark | null | undefined)[]): string {
  const live = marks.filter((m): m is ProvisionalMark => !!m);
  if (live.length === 0) return "";
  const ages = live.map((m) => m.age_days).filter((a): a is number => a !== null);
  const oldest = ages.length ? Math.max(...ages) : null;
  return `${live.length} provisional judge${live.length === 1 ? "" : "s"}${oldest !== null ? ` · ${oldest}d` : ""}`;
}

export function provisionalPill(m: ProvisionalMark): string {
  return `PROVISIONAL${m.age_days !== null ? ` ${m.age_days}D` : ""}`;
}
