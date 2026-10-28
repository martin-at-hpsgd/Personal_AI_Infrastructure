// Chart drawing: pure logic, no engine imports.
// parseChart(kind, lines) -> a bar, spark, tree or timeline chart | null
// drawChart(chart, width) -> rows of styled parts; [] when the chart cannot fit
//
// Fail open: any line that does not parse makes the whole block null, so the
// segmenter leaves it to the engine as plain code.
import { displayWidth, truncate } from './flow'

export const CHART_KINDS = ['bar', 'spark', 'tree', 'timeline'] as const
export type ChartKind = (typeof CHART_KINDS)[number]

export type BarRow = { label: string; value: number; text: string }
export type Series = { label: string | null; values: number[]; tokens: string[] }
export type TreeNode = { level: number; label: string }
export type TimelineEvent = { when: string; what: string }

export type Chart =
  | { kind: 'bar'; rows: BarRow[] }
  | { kind: 'spark'; series: Series[] }
  | { kind: 'tree'; nodes: TreeNode[] }
  | { kind: 'timeline'; events: TimelineEvent[] }

/** How a part is coloured: the renderer maps each role to a terminal style. */
export type PartRole = 'label' | 'bar' | 'value' | 'mark' | 'rail' | 'dim' | 'text'
export type Part = { text: string; role: PartRole }
export type Row = Part[]

/** Longest block a chart may be; anything longer stays plain code. */
export const MAX_CHART_LINES = 40

const MARGIN = 2 // cells left free at the right edge, as in flow.ts
const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const FULL = '█'
const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

const isKind = (k: string): k is ChartKind => (CHART_KINDS as readonly string[]).includes(k)

const clean = (s: string): string =>
  s
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** An optional leading `- ` or `* ` list marker, which models write out of habit. */
const unbullet = (s: string): string => s.replace(/^[-*]\s+/, '')

const toNumber = (token: string): number => Number(token.replace(/,/g, ''))

// ── parsing ──────────────────────────────────────────────────────────────

/** `label: 412`, `label: 37%`, `label: $1,200`, `label: 80 ms`; the label runs to the last `: `. */
function parseBar(lines: string[]): Chart | null {
  const rows: BarRow[] = []
  for (const line of lines) {
    const m = /^(.*\S)\s*:\s+(\S.*?)\s*$/.exec(unbullet(line.trim()))
    if (!m) return null
    const label = clean(m[1]!)
    const text = m[2]!
    const v = /^[$€£]?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*[A-Za-z%µ/]{0,6}$/.exec(text)
    if (!v || label === '') return null
    const value = toNumber(v[1]! + (v[2] ?? ''))
    if (!Number.isFinite(value)) return null
    rows.push({ label, value, text })
  }
  return { kind: 'bar', rows }
}

/** One series per line: numbers split by spaces or commas, with an optional `label:` in front. */
function parseSpark(lines: string[]): Chart | null {
  const series: Series[] = []
  for (const raw of lines) {
    const line = unbullet(raw.trim())
    const m = /^(.*\S)\s*:\s+(.*)$/.exec(line)
    const label = m ? clean(m[1]!) : null
    const tokens = (m ? m[2]! : line).split(/[\s,]+/).filter(t => t !== '')
    if (tokens.length < 2 || !tokens.every(t => /^-?\d+(?:\.\d+)?$/.test(t))) return null
    series.push({ label, values: tokens.map(Number), tokens })
  }
  return { kind: 'spark', series }
}

/** An indented outline: a consistent space indent per level, never a jump of more than one level. */
function parseTree(lines: string[]): Chart | null {
  if (lines.some(l => /^\s*\t/.test(l))) return null
  const raw = lines.map(l => ({ indent: /^ */.exec(l)![0].length, label: clean(unbullet(l.trim())) }))
  if (raw.length < 2 || raw.some(r => r.label === '')) return null
  const indents = raw.map(r => r.indent).filter(n => n > 0)
  const unit = indents.length > 0 ? Math.min(...indents) : 1
  const nodes: TreeNode[] = []
  let prev = -1
  for (const r of raw) {
    if (r.indent % unit !== 0) return null
    const level = r.indent / unit
    if (level > prev + 1) return null
    nodes.push({ level, label: r.label })
    prev = level
  }
  return { kind: 'tree', nodes }
}

/** `when: what`, split at the first `: `, so a time like `10:30` stays in the when. */
function parseTimeline(lines: string[]): Chart | null {
  const events: TimelineEvent[] = []
  for (const raw of lines) {
    const line = unbullet(raw.trim())
    const at = line.search(/:\s/)
    if (at < 0) return null
    const when = clean(line.slice(0, at))
    const what = clean(line.slice(at + 1))
    if (when === '' || what === '') return null
    events.push({ when, what })
  }
  return { kind: 'timeline', events }
}

/** A chart from a fence's info string and body lines, or null when any line does not parse. */
export function parseChart(kind: string, lines: string[]): Chart | null {
  if (typeof kind !== 'string' || !isKind(kind) || !Array.isArray(lines)) return null
  const body = lines.filter(l => typeof l === 'string' && l.trim() !== '')
  if (body.length === 0 || body.length > MAX_CHART_LINES) return null
  switch (kind) {
    case 'bar':
      return parseBar(body)
    case 'spark':
      return parseSpark(body)
    case 'tree':
      return parseTree(body)
    case 'timeline':
      return parseTimeline(body)
  }
}

// ── drawing ──────────────────────────────────────────────────────────────

const padEnd = (s: string, cells: number): string => s + ' '.repeat(Math.max(cells - displayWidth(s), 0))
const padStart = (s: string, cells: number): string => ' '.repeat(Math.max(cells - displayWidth(s), 0)) + s

/** A label column at most `share` of the width, never narrower than four cells. */
function labelColumn(labels: string[], avail: number, share = 0.4): number {
  const widest = Math.max(0, ...labels.map(displayWidth))
  return Math.min(widest, Math.max(Math.floor(avail * share), 4))
}

function drawBar(rows: BarRow[], avail: number): Row[] {
  const labelW = labelColumn(
    rows.map(r => r.label),
    avail,
  )
  const valueW = Math.max(...rows.map(r => displayWidth(r.text)))
  const barW = avail - labelW - 1 - 1 - valueW
  if (barW < 4) return []
  const max = Math.max(...rows.map(r => r.value))
  return rows.map(r => {
    const eighths = max > 0 ? Math.round((r.value / max) * barW * 8) : 0
    let bar = FULL.repeat(Math.floor(eighths / 8)) + BLOCKS[eighths % 8]!
    if (bar === '' && r.value > 0) bar = BLOCKS[1]!
    return [
      { text: padEnd(truncate(r.label, labelW), labelW) + ' ', role: 'label' },
      { text: padEnd(bar, barW), role: 'bar' },
      { text: ' ' + padStart(r.text, valueW), role: 'value' },
    ]
  })
}

/** The glyph for one value between `min` and `max`; a flat series sits mid-height. */
function sparkGlyph(v: number, min: number, max: number): string {
  if (max === min) return SPARKS[3]!
  return SPARKS[Math.round(((v - min) / (max - min)) * (SPARKS.length - 1))]!
}

function drawSpark(series: Series[], avail: number): Row[] {
  const labels = series.map(s => s.label ?? '')
  const hasLabel = labels.some(l => l !== '')
  const labelW = hasLabel ? labelColumn(labels, avail, 0.3) : 0
  const out: Row[] = []
  for (const s of series) {
    const min = Math.min(...s.values)
    const max = Math.max(...s.values)
    const last = `last ${s.tokens[s.tokens.length - 1]}`
    const full = `min ${s.tokens[s.values.indexOf(min)]} · max ${s.tokens[s.values.indexOf(max)]} · ${last}`
    const lead = hasLabel ? labelW + 1 : 0
    // Narrow terminal: shorten the summary to the last value before giving the chart up.
    const fits = (t: string) => avail - lead - 2 - displayWidth(t) >= 4
    const summary = fits(full) ? full : last
    const room = avail - lead - 2 - displayWidth(summary)
    if (room < 2) return []
    // Too many points for the room: keep the most recent ones.
    const shown = s.values.slice(-room)
    const row: Row = []
    if (hasLabel) row.push({ text: padEnd(truncate(s.label ?? '', labelW), labelW) + ' ', role: 'label' })
    row.push({ text: shown.map(v => sparkGlyph(v, min, max)).join(''), role: 'bar' })
    row.push({ text: '  ' + summary, role: 'dim' })
    out.push(row)
  }
  return out
}

function drawTree(nodes: TreeNode[], avail: number): Row[] {
  /** True when a later node sits at `level` before the outline climbs above it. */
  const hasLaterSibling = (i: number, level: number): boolean => {
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[j]!.level < level) return false
      if (nodes[j]!.level === level) return true
    }
    return false
  }
  const out: Row[] = []
  const open: boolean[] = [] // open[k]: the branch at level k continues below
  for (let i = 0; i < nodes.length; i++) {
    const { level, label } = nodes[i]!
    const last = !hasLaterSibling(i, level)
    open[level] = !last
    let prefix = ''
    for (let k = 1; k < level; k++) prefix += open[k] ? '│  ' : '   '
    if (level > 0) prefix += last ? '└─ ' : '├─ '
    const room = avail - displayWidth(prefix)
    if (room < 3) return []
    const row: Row = []
    if (prefix !== '') row.push({ text: prefix, role: 'rail' })
    row.push({ text: truncate(label, room), role: level === 0 ? 'label' : 'text' })
    out.push(row)
  }
  return out
}

function drawTimeline(events: TimelineEvent[], avail: number): Row[] {
  const whenW = labelColumn(
    events.map(e => e.when),
    avail,
    0.35,
  )
  const room = avail - whenW - 3
  if (room < 4) return []
  const out: Row[] = []
  events.forEach((e, i) => {
    if (i > 0) out.push([{ text: ' '.repeat(whenW + 1), role: 'dim' }, { text: '│', role: 'rail' }])
    out.push([
      { text: padStart(truncate(e.when, whenW), whenW) + ' ', role: 'dim' },
      { text: '●', role: 'mark' },
      { text: ' ' + truncate(e.what, room), role: 'text' },
    ])
  })
  return out
}

/** Rows of styled parts for a chart at `width` columns (less a two-cell margin), or [] when it cannot fit. */
export function drawChart(chart: Chart, width = 80): Row[] {
  const avail = Math.floor(width) - MARGIN
  if (!(avail > 0)) return []
  switch (chart.kind) {
    case 'bar':
      return drawBar(chart.rows, avail)
    case 'spark':
      return drawSpark(chart.series, avail)
    case 'tree':
      return drawTree(chart.nodes, avail)
    case 'timeline':
      return drawTimeline(chart.events, avail)
  }
}
