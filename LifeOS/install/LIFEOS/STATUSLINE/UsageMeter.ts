import { invariant } from "../TOOLS/Invariant";
import { RESET } from "./Ansi";

/** Meter width follows the frame: (content - 3 labels@3 - 3 gaps - billing token@6) / 3, floored at 6, capped at 14. */
export function meterWidth(content: number): number {
  return Math.min(14, Math.max(6, Math.trunc((content - 9 - 3 - 6) / 3)));
}

/** Integer part of a numeric string the way `${v%%.*}` plus a digits-only guard reads it; anything else is 0. */
export function intPart(value: unknown): number {
  const head = String(value ?? "").split(".")[0];
  return /^[0-9]+$/.test(head) ? Number(head) : 0;
}

/** Percent left from percent used, clamped to 0..100 (bash _left_pct). */
export function leftPct(used: unknown): number { return 100 - Math.min(100, intPart(used)); }

const fgFill = "\x1b[38;2;226;232;240m";
const bgRest = "\x1b[48;2;22;30;48m";
const fgRest = "\x1b[38;2;120;140;170m";

function fillBackground(pos: number): string {
  if (pos > 80) return "\x1b[48;2;118;66;138m";
  if (pos > 60) return "\x1b[48;2;86;70;140m";
  if (pos > 40) return "\x1b[48;2;58;78;140m";
  return "\x1b[48;2;52;96;128m";
}

/**
 * One VU-style gauge with "PCT% RESET" printed inside. The meter reads percent left; each filled cell
 * wears the colour of its position along the bar. `shownOverride` replaces the percent text ("~117%").
 * The inner text is ASCII, so cells are characters.
 */
export function renderUsageMeter(used: unknown, reset: string, tag: string, width: number, shownOverride = ""): string {
  invariant(Number.isInteger(width) && width >= 6 && width <= 14, "meter width must be 6..14");
  const disp = Math.min(100, intPart(used));
  const left = 100 - disp;
  const shown = shownOverride || `${left}%`;
  let text = ` ${shown}${tag}`;
  if (reset) text += ` ${reset}`;
  if (tag && text.length > width) { text = ` ${shown}`; if (reset) text += ` ${reset}`; }
  if (reset && text.length > width) {
    text = ` ${shown}${tag}`;
    if (text.length > width) text = ` ${shown}`;
  }
  text = text.padEnd(width, " ").slice(0, width);
  const filled = Math.min(width, Math.trunc((left * width + 50) / 100));
  let out = "", current = "";
  for (let i = 1; i <= width; i++) {
    const on = i <= filled;
    const style = on ? fillBackground(Math.trunc((i * 100) / width)) + fgFill : bgRest + fgRest;
    if (style !== current) { out += style; current = style; }
    out += text[i - 1];
  }
  return out + RESET;
}
