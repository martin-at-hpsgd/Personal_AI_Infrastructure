import { P, RESET } from "../Ansi";
import { derive, payment, paymentTitle, usageView, USAGE_STALE_AFTER, type Derived } from "../producers/UsageView";
import type { State } from "../State";
import { leftPct, meterWidth, renderUsageMeter } from "../UsageMeter";

const PRIMARY = P.usagePrimary, LABEL = P.usageLabel, RESET_C = P.usageReset, EXTRA = P.usageExtra, EXTRA_ACTIVE = P.usageExtraActive, STALE = P.usageStale;

/** "$1,234": cents to whole dollars with thousands commas (bash _fmt_dollars). */
export function fmtDollars(cents: number): string {
  return `$${Math.trunc(cents / 100).toLocaleString("en-US")}`;
}

const pctColor = (p: number): string => (p > 80 ? P.usageLvl4 : p > 60 ? P.usageLvl3 : p > 40 ? P.usageLvl2 : P.usageLvl1);

/** The credits-pool readout shared with the money row's fallback; empty when no pool exists. */
export function creditsFmt(d: Derived, enabled: boolean, limitReached: boolean, userDisabled: boolean): string {
  if (!d.crPool) return "";
  let out = `${EXTRA}CREDITS ${fmtDollars(d.crUsed)}/${fmtDollars(d.crLimit)}${RESET} ${pctColor(d.crPct)}${d.crPct}%${RESET}`;
  if (!enabled) out += ` ${EXTRA}OFF${RESET}`;
  else if (limitReached) out += ` ${P.rose}CAP${RESET}`;
  else if (userDisabled) out += ` ${EXTRA}PAUSED${RESET}`;
  return out;
}

/** The bar's reset text: a bare time for today, DAY@TIME otherwise, the day alone, or nothing (bash _bar_rst). */
export function barReset(day: string, time: string): string {
  if (day === "TODAY" && time) return time;
  if (time) return `${day}@${time}`;
  return day !== "—" ? day : "";
}

/** Whether the usage block drew a line; the separator after the money row reads it. */
export function usageShown(state: State): boolean {
  return !state.geometry.phone && usageView(state).state !== "absent";
}

export function renderUsage(state: State): string {
  if (state.geometry.phone) return "";
  const v = usageView(state), pay = payment(state);
  const density = state.geometry.density, w = meterWidth(state.geometry.content);
  let out = "";
  if (pay.label === "DIRECT" && pay.rows) out += `${pay.rows}\n`;
  if (v.state === "api") {
    out += `📊 ${PRIMARY}API${RESET} ${LABEL}SESSION${RESET} ${P.slate300}$${(Number(v.sessionCost) || 0).toFixed(2)}${RESET}\n`;
  } else if (v.state === "pool") {
    out += pay.rows ? `${pay.rows}\n` : `💳 ${PRIMARY}${paymentTitle()}${RESET}\n`;
  } else if (v.state === "fresh") {
    const d = derive(state, v);
    let stale = false, staleSuffix = "";
    if (v.source !== "native" && v.dataAge > USAGE_STALE_AFTER) {
      stale = true;
      const min = Math.trunc(v.dataAge / 60);
      staleSuffix = ` ${STALE}(${min >= 60 ? `${Math.trunc(min / 60)}h` : `${min}m`})${RESET}`;
    }
    const resetColor = stale ? STALE : RESET_C;
    const tag = d.billing === "CREDITS" ? "+CR" : d.billing === "LOCKED" ? "!" : "";
    let tag5 = "", tag7 = "", tagSc = "";
    if (d.capped === "5H") tag5 = d.est5h ? "" : tag;
    else if (d.capped === "WK") tag7 = tag;
    else if (d.capped === "FB") tagSc = tag;
    let bar5 = "", bar7 = "";
    if (density !== 1) {
      bar5 = renderUsageMeter(d.fiveInt, barReset(d.fiveDay, d.fiveTime), tag5, w, d.est5h);
      bar7 = renderUsageMeter(d.sevenInt, barReset(d.sevenDay, d.sevenTime), tag7, w);
    }
    const color5 = !stale && d.fiveActive ? PRIMARY : resetColor;
    const color7 = !stale && d.sevenActive ? PRIMARY : resetColor;
    let scoped = "";
    if (d.scopedInt !== "") {
      const name = v.scoped.name === "FABLE" ? "FB" : v.scoped.name;
      const rst = d.scopedDay ? barReset(d.scopedDay, d.scopedTime) : "";
      const scopedColor = !stale && d.scopedActive ? PRIMARY : resetColor;
      scoped = density === 1
        ? ` ${scopedColor}${name}${RESET} ${PRIMARY}${leftPct(d.scopedInt)}%${RESET}`
        : ` ${scopedColor}${name}${RESET} ${renderUsageMeter(d.scopedInt, rst, tagSc, w)}`;
    }
    const billing = v.noData ? `${PRIMARY}API${RESET}`
      : d.billing === "CREDITS" ? `${EXTRA_ACTIVE}⚡CREDITS←${d.capped}${d.burn}${RESET}`
      : d.billing === "LOCKED" ? `${P.rose}⛔LOCKED←${d.capped}${RESET}`
      : d.billing === "CAPPED" ? `${PRIMARY}CAPPED←${d.capped}${RESET}`
      : `${PRIMARY}SUB${RESET}`;
    const prefix = `${P.slate600}CC:${RESET} `;
    const loud = d.billing === "CREDITS" || d.billing === "LOCKED" || d.billing === "CAPPED";
    if (pay.rows) {
      if (loud) out += prefix + billing;
    } else if (density === 1) {
      out += `${prefix}${color5}5H${RESET} ${PRIMARY}${d.est5h || `${leftPct(d.fiveInt)}%`}${RESET} ${color7}WK${RESET} ${PRIMARY}${leftPct(d.sevenInt)}%${RESET}${scoped} ${billing}`;
    } else {
      out += `${prefix}${color5}5H${RESET} ${bar5} ${color7}WK${RESET} ${bar7}${scoped} ${billing}`;
    }
    if (!pay.rows || loud) out += `${staleSuffix}\n`;
  }
  return out;
}
