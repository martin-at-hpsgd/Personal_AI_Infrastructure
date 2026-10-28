// Line styles for the rich-format mod. Pure functions, no engine imports.
// Fail-open: anything that is not an exact marker line returns null.

export type LabelStyle = { color: 'blue' | 'green' | 'yellow'; bold: true }
export type Callout = { bar: 'cyan' | 'amber' }

const LABELS: ReadonlyArray<readonly [string, LabelStyle]> = [
  ['🔧 CHANGE:', { color: 'blue', bold: true }],
  ['✅ VERIFY:', { color: 'green', bold: true }],
  ['❓ OPEN:', { color: 'yellow', bold: true }],
]

// ⚠ is U+26A0; the emoji form appends variation selector 16 (U+FE0F).
const CALLOUTS: ReadonlyArray<readonly [string, Callout]> = [
  ['💡', { bar: 'cyan' }],
  ['⚠', { bar: 'amber' }],
]

export function styleFor(line: string): LabelStyle | null {
  if (typeof line !== 'string') return null
  for (const [prefix, style] of LABELS) {
    if (line.startsWith(prefix)) return { ...style }
  }
  return null
}

export function calloutFor(line: string): Callout | null {
  if (typeof line !== 'string') return null
  for (const [prefix, callout] of CALLOUTS) {
    if (line.startsWith(prefix)) return { ...callout }
  }
  return null
}
