import { join } from "node:path";
import { readJson } from "../Cache";
import { number, object, type State } from "../State";

export interface OverageView {
  present: boolean;
  spent: string;
  ceiling: string;
  remaining: string;
  armed: boolean;
  expires: number;
  calls: number;
}

/** Emergency API overage summary: a plain read of overage-summary.json, absent when nothing has ever billed. */
export function overageView(state: State): OverageView {
  const path = state.env.LIFEOS_OVERAGE_SUMMARY || join(state.root, "MEMORY", "OBSERVABILITY", "overage-summary.json");
  const raw = readJson(path);
  if (raw === null) return { present: false, spent: "0", ceiling: "0", remaining: "0", armed: false, expires: 0, calls: 0 };
  const s = object(raw), armed = object(s.armed);
  const by = Array.isArray(s.byVendor) ? s.byVendor.map(object) : [];
  return {
    present: true, spent: String(number(s.spentUsd)), ceiling: String(number(s.ceilingUsd)), remaining: String(number(s.remainingUsd)),
    armed: armed.armed === true, expires: number(armed.expiresAt), calls: by.reduce((sum, v) => sum + number(v.calls), 0),
  };
}
