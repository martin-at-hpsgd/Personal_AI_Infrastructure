import { P, RESET } from "../Ansi";
import { codexView, CODEX_USAGE_TTL } from "../producers/CodexView";
import { payment } from "../producers/UsageView";
import type { State } from "../State";
import { resetTimeStr, splitReset } from "../Time";
import { intPart, leftPct, meterWidth, renderUsageMeter } from "../UsageMeter";

/** The OpenAI plan windows under the Anthropic bars; the account chips carry this row when they draw. */
export function renderCodex(state: State): string {
  if (state.geometry.phone) return "";
  const pay = payment(state), c = codexView(state);
  if (pay.rows || c.state !== "fresh" || !c.windows[0]?.label) return "";
  const density = state.geometry.density, w = meterWidth(state.geometry.content);
  let suffix = "";
  const stale = c.age > CODEX_USAGE_TTL * 2;
  if (stale) {
    const min = Math.trunc(c.age / 60);
    suffix = ` ${P.usageStale}(${min >= 60 ? `${Math.trunc(min / 60)}h` : `${min}m`})${RESET}`;
  }
  const winColor = stale ? P.usageStale : P.usageReset;
  const meter = (pctText: string, resetText: string): string => {
    let pct = intPart(pctText), rst = "";
    const reset = Number(resetText);
    if (Number.isFinite(reset) && reset > 0) {
      if (reset <= state.now) pct = 0;
      else {
        const str = resetTimeStr(reset, state.timezone, state.now);
        if (str.includes("@")) { const { day, time } = splitReset(str); rst = day === "TODAY" ? time : `${day}@${time}`; }
      }
    }
    return renderUsageMeter(pct, rst, c.limitReached && pct >= 100 ? "!" : "", w);
  };
  const cell = (i: number): string => {
    const win = c.windows[i];
    return density === 1
      ? `${winColor}${win.label}${RESET} ${P.slate300}${leftPct(win.pct)}%${RESET}`
      : `${winColor}${win.label}${RESET} ${meter(win.pct, win.reset)}`;
  };
  let line = cell(0);
  if (c.windows[1]?.label) line += ` ${cell(1)}`;
  if (c.limitReached) line += ` ${P.rose}⛔LOCKED${RESET}`;
  if (c.plan) line += ` ${stale ? P.usageStale : P.usagePrimary}${c.plan}${RESET}`;
  return `${P.slate600}CO:${RESET} ${line}${suffix}\n`;
}
