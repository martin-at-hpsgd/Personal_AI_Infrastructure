// Flow drawing: pure logic, no engine imports.
// parseFlow('a -> b -> c') -> ['a', 'b', 'c'] | null
// parseFlowChain(line)     -> nodes (label, colour) and edge labels | null
// drawFlow(chains, width)  -> rows of boxed nodes joined by arrows, plain text
// drawFlowPainted(chains, width) -> the same rows in ANSI colour
// displayWidth(text)       -> terminal cells the text occupies

import { FG, RESET_FG } from './palette'

const ARROW = '->'
const JOIN = '─▶' // two cells between boxes
const MARGIN = 2 // cells left free at the right edge
const ELLIPSIS = '…'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const WIDE_EMOJI = /^\p{Emoji_Presentation}/u
const REGIONAL = /^[\u{1F1E6}-\u{1F1FF}]{2}/u

function isEastAsianWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

function clusterWidth(g: string): number {
  const first = g.codePointAt(0)!
  // zero-width on their own: ZWSP, ZWNJ, ZWJ, BOM, lone variation selectors, combining marks
  if (first === 0x200b || first === 0x200c || first === 0x200d || first === 0xfeff) return 0
  if (first === 0xfe0f || first === 0xfe0e) return 0
  if (/^\p{M}/u.test(g)) return 0
  if (first < 0x20 || (first >= 0x7f && first < 0xa0)) return 0
  // an emoji written with variation selector 16 is drawn two cells wide
  if (g.includes('️')) return 2
  if (g.includes('⃣')) return 2 // keycap
  if (REGIONAL.test(g)) return 2
  if (WIDE_EMOJI.test(g)) return 2
  if (isEastAsianWide(first)) return 2
  return 1
}

export function displayWidth(text: string): number {
  let w = 0
  for (const { segment } of segmenter.segment(text)) w += clusterWidth(segment)
  return w
}

export function truncate(text: string, maxCells: number): string {
  if (displayWidth(text) <= maxCells) return text
  const budget = Math.max(maxCells - 1, 0)
  let out = ''
  let used = 0
  for (const { segment } of segmenter.segment(text)) {
    const cw = clusterWidth(segment)
    if (used + cw > budget) break
    out += segment
    used += cw
  }
  return out + ELLIPSIS
}

function clean(label: string): string {
  return label
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type FlowColor = 'green' | 'red' | 'amber' | 'yellow' | 'cyan' | 'blue' | 'purple' | 'grey'

const COLOR_NAMES: ReadonlySet<string> = new Set(['green', 'red', 'amber', 'yellow', 'cyan', 'blue', 'purple', 'grey'])

/** Longest edge label drawn, in cells; longer ones are cut with an ellipsis. */
const EDGE_LABEL_MAX = 16

/** An arrow with an optional label in pipes right after it: `->` or `->|ok|`. The label is capture 1. */
const ARROW_SPLIT = /->(?:\s*\|([^|]*)\|)?/

export type FlowNode = { label: string; color?: FlowColor }
export type FlowChain = { nodes: FlowNode[]; edges: (string | null)[] }

/** A node's text to its label and colour: a valid `:::colour` suffix, else a leading ✅ ❌ ⚠️, else none. */
function parseNode(raw: string): FlowNode {
  const text = clean(raw)
  const m = /^(.*?):::([A-Za-z]+)$/.exec(text)
  if (m && COLOR_NAMES.has(m[2]!.toLowerCase())) {
    return { label: clean(m[1]!), color: m[2]!.toLowerCase() as FlowColor }
  }
  // An unknown colour name is not a colour: the whole text stays the label.
  if (text.startsWith('✅')) return { label: text, color: 'green' }
  if (text.startsWith('❌')) return { label: text, color: 'red' }
  if (text.startsWith('⚠')) return { label: text, color: 'amber' }
  return { label: text }
}

/**
 * One chain line `a ->|ok| b:::green -> c` to its nodes (label and optional colour) and the label
 * on each edge (null when none), or null when the line is not a chain.
 */
export function parseFlowChain(line: string): FlowChain | null {
  if (typeof line !== 'string' || !line.includes(ARROW)) return null
  const parts = line.split(ARROW_SPLIT)
  const nodes: FlowNode[] = []
  const edges: (string | null)[] = []
  for (let i = 0; i < parts.length; i += 2) {
    nodes.push(parseNode(parts[i] ?? ''))
    if (i + 1 < parts.length) {
      const label = clean(parts[i + 1] ?? '')
      edges.push(label === '' ? null : label)
    }
  }
  if (nodes.length < 2 || nodes.some(n => n.label === '')) return null
  return { nodes, edges }
}

/** One chain line `a -> b -> c` to its node labels, or null when the line is not a chain. */
export function parseFlow(line: string): string[] | null {
  const chain = parseFlowChain(line)
  return chain ? chain.nodes.map(n => n.label) : null
}

type Chain = string | string[]

function toChain(chain: Chain): FlowChain | null {
  if (Array.isArray(chain)) {
    const nodes = chain.map(n => clean(String(n)))
    if (nodes.length === 0 || nodes.some(n => n === '')) return null
    return { nodes: nodes.map(label => ({ label })), edges: nodes.slice(1).map(() => null) }
  }
  const parsed = parseFlowChain(chain)
  if (parsed) return parsed
  const one = clean(String(chain))
  return one === '' ? null : { nodes: [{ label: one }], edges: [] }
}

/** Which part of the drawing a run of text is, so the plain and painted rows come from one layout. */
type Role = 'box' | 'join' | 'edge' | 'gap'
type Seg = { text: string; role: Role; color?: FlowColor }

type BoxParts = { w: number; color?: FlowColor; top: string; mid: string; bot: string }

function box(label: string, color?: FlowColor): BoxParts {
  const lw = displayWidth(label)
  return {
    w: lw + 4,
    color,
    top: '┌' + '─'.repeat(lw + 2) + '┐',
    mid: '│ ' + label + ' │',
    bot: '└' + '─'.repeat(lw + 2) + '┘',
  }
}

type Join = { w: number; mid: Seg[]; gap: Seg }

/** The cells between two boxes: the two-cell arrow, `─label─▶` when the edge has a label. */
function join(label: string | null): Join {
  const segs: Seg[] = label === null ? [{ text: JOIN, role: 'join' }] : [{ text: '─', role: 'join' }, { text: label, role: 'edge' }, { text: JOIN, role: 'join' }]
  const w = segs.reduce((n, g) => n + displayWidth(g.text), 0)
  return { w, mid: segs, gap: { text: ' '.repeat(w), role: 'gap' } }
}

/** The one layout both drawings share: rows of segments, three rows per band. */
function layout(chains: Chain[], width: number): Seg[][] {
  const avail = Math.max(Math.floor(width) - MARGIN, 5)
  const labelBudget = Math.max(avail - 4, 1)
  const rows: Seg[][] = []

  for (const chain of chains) {
    const parsed = toChain(chain)
    if (!parsed) continue
    const boxes = parsed.nodes.map(n => box(truncate(n.label, labelBudget), n.color))

    // each entry is a box and the join drawn before it (none for the first box of a band)
    let band: { b: BoxParts; before: Join | null }[] = []
    let bandW = 0
    const flush = () => {
      if (band.length === 0) return
      const top: Seg[] = []
      const mid: Seg[] = []
      const bot: Seg[] = []
      for (const { b, before } of band) {
        if (before) {
          top.push(before.gap)
          mid.push(...before.mid)
          bot.push(before.gap)
        }
        top.push({ text: b.top, role: 'box', color: b.color })
        mid.push({ text: b.mid, role: 'box', color: b.color })
        bot.push({ text: b.bot, role: 'box', color: b.color })
      }
      rows.push(top, mid, bot)
      band = []
      bandW = 0
    }
    boxes.forEach((b, i) => {
      const edge = i > 0 ? (parsed.edges[i - 1] ?? null) : null
      const j = join(edge === null ? null : truncate(edge, EDGE_LABEL_MAX))
      if (band.length > 0 && bandW + j.w + b.w > avail) flush()
      // a join that falls on a wrap is not drawn, and neither is its label
      band.push({ b, before: band.length === 0 ? null : j })
      bandW = band.length === 1 ? b.w : bandW + j.w + b.w
    })
    flush()
  }
  return rows
}

/**
 * Draw chains as boxed nodes. Each chain is a line (`a -> b`, `a ->|ok| b`) or an array of labels.
 * A chain that does not fit `width` (less a two-cell margin) wraps into further
 * three-row bands. Lines that are not chains and arrays with an empty node are skipped.
 * Plain text: colours are only in drawFlowPainted.
 */
export function drawFlow(chains: Chain[], width = 80): string[] {
  return layout(chains, width).map(row => row.map(s => s.text).join(''))
}

const COLOR_FG: Readonly<Record<FlowColor, string>> = {
  green: FG.pass,
  red: FG.fail,
  amber: FG.caution,
  yellow: FG.open,
  cyan: FG.info,
  blue: FG.accent,
  purple: FG.code,
  grey: FG.frame,
}

/** The same rows as drawFlow, in colour: boxes in their node colour (cyan by default), joins grey, edge labels soft blue. */
export function drawFlowPainted(chains: Chain[], width = 80): string[] {
  return layout(chains, width).map(row =>
    row
      .map(s => {
        if (s.role === 'gap') return s.text
        const fg = s.role === 'box' ? COLOR_FG[s.color ?? 'cyan'] : s.role === 'edge' ? FG.accentSoft : FG.frame
        return fg + s.text + RESET_FG
      })
      .join(''),
  )
}
