export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const rgb = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`;
export const C = {
  slate300: rgb(203, 213, 225), slate400: rgb(148, 163, 184),
  slate500: rgb(100, 116, 139), slate600: rgb(71, 85, 105), slate700: rgb(51, 65, 85),
  blue: rgb(59, 130, 246), city: rgb(37, 99, 235), region: rgb(125, 211, 252), fixAge: rgb(251, 191, 36),
  time: rgb(96, 165, 250), weather: rgb(135, 206, 235), session: rgb(125, 207, 255), tide: rgb(115, 218, 202),
  tideFrom: rgb(78, 150, 140), tideTo: rgb(180, 240, 230),
  usage: rgb(194, 139, 62), rose: rgb(251, 113, 133),
} as const;
export function usageColor(pct: number): string {
  return pct >= 80 ? rgb(190, 140, 195) : pct >= 60 ? rgb(160, 145, 200) : pct >= 40 ? rgb(130, 150, 200) : rgb(125, 165, 190);
}
export function separator(width: number, density: number, char = "─"): string {
  return density <= 1 ? "" : `${C.slate600}${char.repeat(width)}${RESET}\n`;
}

/** Full legacy palette (bash lines 1882–1965), named as in the bash with SCREAMING_SNAKE → camel keys. */
export const P = {
  slate300: rgb(203, 213, 225), slate400: rgb(148, 163, 184), slate500: rgb(100, 116, 139), slate600: rgb(71, 85, 105),
  emerald: rgb(74, 222, 128), rose: rgb(251, 113, 133),
  rating10: rgb(74, 222, 128), rating8: rgb(163, 230, 53), rating7: rgb(250, 204, 21), rating6: rgb(251, 191, 36),
  rating5: rgb(251, 146, 60), rating4: rgb(248, 113, 113), ratingLow: rgb(239, 68, 68),
  wieldAccent: rgb(103, 232, 249), wieldWorkflows: rgb(94, 234, 212), wieldHooks: rgb(6, 182, 212),
  gitPrimary: rgb(56, 189, 248), gitValue: rgb(186, 230, 253), gitDir: rgb(147, 197, 253), gitClean: rgb(125, 211, 252),
  gitStash: rgb(165, 180, 252), gitAgeFresh: rgb(125, 211, 252), gitAgeRecent: rgb(96, 165, 250),
  gitAgeStale: rgb(59, 130, 246), gitAgeOld: rgb(99, 102, 241),
  learnPrimary: rgb(167, 139, 250), learnSecondary: rgb(196, 181, 253), learnWork: rgb(192, 132, 252),
  learnSignals: rgb(139, 92, 246), learnResearch: rgb(129, 140, 248), learnSessions: rgb(99, 102, 241),
  signalPeriod: rgb(148, 163, 184),
  ctxPrimary: rgb(129, 140, 248), ctxSecondary: rgb(165, 180, 252), ctxBucketEmpty: rgb(75, 82, 95),
  usagePrimary: rgb(194, 139, 62), usageLabel: rgb(168, 113, 50), usageReset: rgb(148, 163, 184),
  usageExtra: rgb(140, 90, 60), usageExtraActive: rgb(251, 146, 60), usageStale: rgb(120, 113, 108),
  quotePrimary: rgb(252, 211, 77), quoteAuthor: rgb(180, 140, 60),
  lifeosP: rgb(37, 99, 235), lifeosA: rgb(59, 130, 246), lifeosI: rgb(147, 197, 253),
  lifeosLabel: rgb(100, 116, 139), lifeosCity: rgb(37, 99, 235), lifeosState: rgb(125, 211, 252),
  lifeosTime: rgb(96, 165, 250), lifeosWeather: rgb(135, 206, 235), lifeosSession: rgb(120, 135, 160),
  usageLvl1: rgb(125, 165, 190), usageLvl2: rgb(130, 150, 200), usageLvl3: rgb(160, 145, 200), usageLvl4: rgb(190, 140, 195),
} as const;
/** The LifeOS staircase mark as four cells, the same columns and colours the LifeOSHooks band draws (motion-view.ts markCells). */
export const LIFEOS_LOGO = `${rgb(148, 197, 253)}▂${rgb(74, 127, 224)}▃${rgb(148, 197, 253)}▅${rgb(27, 71, 255)}█${RESET}`;

/** get_bucket_color: green → yellow → orange → red, bash integer arithmetic (truncates toward zero). */
export function bucketColor(pos: number, max: number): string {
  const t = Math.trunc;
  const pct = t((pos * 100) / max);
  let r: number, g: number, b: number;
  if (pct <= 33) { r = 74 + t((176 * pct) / 33); g = 222 + t((-18 * pct) / 33); b = 128 + t((-107 * pct) / 33); }
  else if (pct <= 66) { const d = pct - 33; r = 250 + t(d / 33); g = 204 + t((-58 * d) / 33); b = 21 + t((39 * d) / 33); }
  else { const d = pct - 66; r = 251 + t((-12 * d) / 34); g = 146 + t((-78 * d) / 34); b = 60 + t((8 * d) / 34); }
  return rgb(r, g, b);
}

export const bg = (r: number, g: number, b: number): string => `\x1b[48;2;${r};${g};${b}m`;
/** Row highlight tints: dark enough that every foreground on the row stays readable. */
export const BAND = { session: bg(22, 36, 62), state: bg(20, 44, 40), work: bg(48, 32, 22), inputs: bg(22, 34, 52), cosmos: bg(34, 26, 58) } as const;

/**
 * One row on a full-width tinted band, its text centered on it. Every reset inside the text re-opens the tint, so
 * coloured segments keep the band behind them; the band is `width` cells and the frame centers it like any full row.
 */
export function band(text: string, width: number, tint: string): string {
  const free = Math.max(0, width - Bun.stringWidth(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")));
  const left = Math.trunc(free / 2);
  return `${tint}${" ".repeat(left)}${text.replaceAll(RESET, RESET + tint)}${" ".repeat(free - left)}${RESET}`;
}
