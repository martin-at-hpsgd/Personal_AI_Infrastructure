import { moneyRows } from "../../TOOLS/StatusLineMoney";
import { P, RESET, separator } from "../Ansi";
import { overageView } from "../producers/Overage";
import { derive, usageView } from "../producers/UsageView";
import { number, object, type State } from "../State";
import { creditsFmt, usageShown } from "./Usage";

/** "$0.0004" under a cent, "$12.40" under 100, "$1,234" at or above (bash _fmt_usd). */
export function fmtUsd(raw: string): string {
  const v = Number(raw) || 0;
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${Math.trunc(v + 0.5).toLocaleString("en-US")}`;
}

function fallbackLine(state: State): string {
  const ov = overageView(state), v = usageView(state);
  let line = "";
  if (ov.armed) line = `${P.usageExtraActive}⚡OVERAGE ON${RESET} ${P.usageExtraActive}${fmtUsd(ov.spent)}${RESET}${P.usageLabel}/${fmtUsd(ov.ceiling)}${RESET} ${P.usageLabel}left${RESET} ${P.slate300}${fmtUsd(ov.remaining)}${RESET}`;
  else if ((Number(ov.spent) || 0) > 0) line = `${P.usageExtra}OVERAGE${RESET} ${P.slate300}${fmtUsd(ov.spent)}${RESET}${P.usageLabel}/${fmtUsd(ov.ceiling)}${RESET} ${P.usageLabel}MTD${RESET}`;
  if (v.state === "fresh") {
    const credits = creditsFmt(derive(state, v), v.extraEnabled, v.limitReached, v.userDisabled);
    if (credits) line += `${line ? ` ${P.slate600}│${RESET} ` : ""}${credits}`;
  }
  return line ? `${P.slate600}$:${RESET} ${line}\n` : "";
}

/** The money row (every dollar figure), then the rule that closes the usage block. */
export function renderMoney(state: State): string {
  if (state.geometry.phone) return "";
  const v = usageView(state);
  const fresh = v.state === "fresh" ? derive(state, v) : null;
  // moneyRows returns no rows when nothing costs extra (alert-only, 2026-10-17); the fallback line is for a throw.
  let rows: string | null = null;
  try {
    rows = moneyRows(state.env, {
      cols: state.geometry.content, sessionId: state.sessionId,
      sessionCostUsd: number(object(state.input.cost).total_cost_usd),
      billing: fresh?.billing ?? "", capped: fresh?.capped ?? "", nowMs: state.nowMs,
    }).join("\n");
  } catch { rows = null; }
  const body = rows === null ? fallbackLine(state) : rows ? `${rows}\n` : "";
  const shown = usageShown(state) || body !== "";
  return body + (shown ? separator(state.geometry.content, state.geometry.density) : "");
}
