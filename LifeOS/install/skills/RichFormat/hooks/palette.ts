// The mod's colour language, shared by every streamed drawing. Pure, no engine imports.
// One accent (the DA blue) carries structure; dim greys carry scaffolding (borders,
// rails, bullets); green, red and amber appear only when they mean pass, fail or caution.

export const ESC = '\x1b['
export const RESET_FG = `${ESC}39m`
/** Ends bold and dim together (SGR 22). */
export const RESET_WEIGHT = `${ESC}22m`
export const RESET_ITALIC = `${ESC}23m`
export const BOLD = `${ESC}1m`
export const DIM = `${ESC}2m`
export const ITALIC = `${ESC}3m`

export function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `${ESC}38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
}

/** Foreground colours by meaning. Use these names, never a raw hex, in drawing code. */
export const FG = {
  /** The DA colour: headings, the CHANGE label, the closer's name, top-level bullets. */
  accent: rgb('#3B82F6'),
  /** A lighter accent for second-level structure: table headers, H3, bold mini-headers. */
  accentSoft: rgb('#93C5FD'),
  /** Scaffolding that should recede: table borders, rules, nested bullets. */
  frame: rgb('#5B6472'),
  /** Inline code inside drawn blocks (table cells), where the engine's own code style does not reach. */
  code: rgb('#C4B5FD'),
  pass: `${ESC}32m`,
  fail: `${ESC}31m`,
  caution: rgb('#FFB000'),
  info: `${ESC}36m`,
  open: `${ESC}33m`,
} as const

export type FgName = keyof typeof FG

/** `text` in colour `fg`, foreground reset after it. */
export const paintFg = (fg: FgName, text: string): string => FG[fg] + text + RESET_FG

/** `text` bold in colour `fg`, both reset after it. */
export const paintBold = (fg: FgName, text: string): string => BOLD + FG[fg] + text + RESET_WEIGHT + RESET_FG
