// Streamed drawing for the rich-format mod: turns each batch of finished lines the
// engine hands `classic.MessageDisplay` into the text it shows, with ANSI colour.
// This is the first and only copy of the answer on screen, so nothing repaints and
// nothing prints twice (2026-10-09: a `ui.render` hook on a finished answer did).
// Pure logic: no engine imports. The engine still runs its markdown renderer over
// what this returns; ANSI codes and spacing pass through it (probed 2026-10-09).

import { bannerParts, isCloserLine, type BandState, type BannerPart } from './banner'
import { CHART_KINDS, drawChart, parseChart, type PartRole, type Row } from './charts'
import { verifyMark } from './chips'
import { isUnifiedDiff } from './diff'
import { enrichCloser, enrichLine, type Section } from './enrich'
import { drawFlowPainted, parseFlowChain } from './flow'
import { glyphify } from './glyph-core'
import { drawTable, isDelimiterRow, isTableLine, MAX_TABLE_LINES, parseTable } from './table'
import { calloutFor, styleFor, type Callout, type LabelStyle } from './style'
import { MAX_CARDS_PER_FLUSH, parseWorkflowFence, WORKFLOW_KIND } from './workflow'

const ESC = '\x1b['
const RESET_FG = `${ESC}39m`
const RESET_WEIGHT = `${ESC}22m`

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/
const DRAWN_KINDS = new Set<string>(['flow', 'diff', WORKFLOW_KIND, ...CHART_KINDS])

/** A line drawn to the terminal width: a list item that may wrap, a rule, or a table row. */
const WIDTH_LINE = /^\s*(?:[-*+]\s|\d{1,3}[.)]\s|\||(?:-{3,}|\*{3,}|_{3,})\s*$)/

/** A list item at any indent. */
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/

/** A fence opened 4 or more spaces deep (inside a list item): passed through, never drawn. */
const DEEP_FENCE = /^ {4,}(`{3,}|~{3,})/

const indentOf = (line: string): number => line.length - line.trimStart().length

/** `line` with up to `n` leading spaces removed. */
const dedented = (line: string, n = 0): string => line.slice(Math.min(n, line.length - line.trimStart().length))

/** A fence longer than this is handed back as written, never drawn. */
export const MAX_FENCE_LINES = 40

/** Cells the engine's reply gutter takes left of the text. */
export const GUTTER = 2

function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `${ESC}38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
}

const LABEL_FG: Readonly<Record<LabelStyle['color'], string>> = {
  blue: rgb('#3B82F6'),
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
}
const BAR_FG: Readonly<Record<Callout['bar'], string>> = { cyan: `${ESC}36m`, amber: rgb('#FFB000') }
const MARK_FG = { green: `${ESC}32m`, red: `${ESC}31m` } as const

const PART_SGR: Readonly<Record<PartRole, [string, string]>> = {
  label: [`${ESC}1m`, RESET_WEIGHT],
  bar: [`${ESC}36m`, RESET_FG],
  value: ['', ''],
  mark: [`${ESC}36m`, RESET_FG],
  rail: [`${ESC}2m`, RESET_WEIGHT],
  dim: [`${ESC}2m`, RESET_WEIGHT],
  text: ['', ''],
}

const BANNER_SGR: Readonly<Record<BannerPart['role'], [string, string]>> = {
  rule: [`${ESC}2m`, RESET_WEIGHT],
  name: [`${ESC}1m${rgb('#3B82F6')}`, `${RESET_WEIGHT}${RESET_FG}`],
  state: [`${ESC}36m`, RESET_FG],
}

/** A line holding only this opens a final answer; the LifeOS rule is drawn in its place. */
export const RULE_MARKER = '◆'

const isMarker = (line: string): boolean => line.trim() === RULE_MARKER

/**
 * An empty-looking line after the closer, so the engine's turn timer (`✻ Worked for …`) does not sit
 * flush under it. It holds an SGR code because the engine trims a trailing blank line.
 */
export const CLOSER_SPACER = RESET_FG

/** What the renderer carries from one flush of a message to the next. */
export type StreamState = {
  /** An open fence: drawn kinds are held until it closes, other kinds pass through. */
  fence: { marker: string; kind: string; drawn: boolean; lines: string[]; dedent?: number } | null
  /** True after a `✅ VERIFY:` label, until the next label or the closer. */
  inVerify: boolean
  /**
   * The VERIFY run's lines, held from the label until the run ends, so its marks are coloured only when
   * every bullet is a flat ✓ or ✗ one (any other line hands the whole run back unmarked); null when not holding.
   */
  verifyRun?: string[] | null
  /** The answer section the next plain line sits in, from the last label; `none` before any label and after the closer. */
  section?: Section
  /** Table lines held until the table ends, so it is drawn once and whole. */
  table?: string[] | null
  /** True after a list item, until a non-blank line at column 0 that is not one; blank lines keep it. */
  inList?: boolean
  /** True while the rest of an over-long table streams past: its rows pass through as written. */
  rawTable?: boolean
  /** True once the rule is drawn for this message, so the closer does not draw a second. */
  ruled: boolean
}

export function newStreamState(): StreamState {
  return { fence: null, inVerify: false, ruled: false, section: 'none', table: null }
}

/** What a flush may need from outside: the terminal width, the ISA state for the closer, and the workflow cards. */
export type StreamContext = {
  columns: number
  band: BandState | null
  /** Card lines by run id, fetched before the flush for each workflow fence it closes; a missing run shows as written. */
  cards?: ReadonlyMap<string, readonly string[]>
}

/** True when this flush holds a rule marker or a closer outside a fence, so the caller fetches the ISA state. */
export function needsBand(state: StreamState, lines: readonly string[]): boolean {
  let fence = state.fence ? state.fence.marker : null
  for (const line of lines) {
    const m = FENCE_OPEN.exec(line)
    if (fence) {
      if (m && closes(fence, line)) fence = null
      continue
    }
    if (m) {
      fence = m[1]!
      continue
    }
    if (isMarker(line) || (isCloserLine(line) && !state.ruled)) return true
  }
  return false
}

/** True when `width` would draw anything at all: the caller then reads the terminal size. */
export function needsWidth(state: StreamState, lines: readonly string[]): boolean {
  return state.fence?.drawn === true || lines.some(l => FENCE_OPEN.test(l) || WIDTH_LINE.test(l)) || needsBand(state, lines)
}

/**
 * The run ids of the workflow fences this flush closes, a fence already open in `state` included, in order
 * and at most MAX_CARDS_PER_FLUSH. Empty for any flush that closes no workflow fence, so the caller runs the
 * bridge only when one closes. Reads `state`, never changes it.
 */
export function workflowRunIds(state: StreamState, lines: readonly string[]): string[] {
  const ids: string[] = []
  // `body` is null for a fence that can never draw a card: any kind but `workflow`, or a body past MAX_FENCE_LINES.
  // Such a fence is walked for its closing line only; its lines are never copied.
  let fence: { marker: string; body: string[] | null } | null = null
  const held = state.fence
  if (held) fence = { marker: held.marker, body: held.kind === WORKFLOW_KIND && held.lines.length - 1 <= MAX_FENCE_LINES ? held.lines.slice(1) : null }
  for (const line of lines) {
    if (fence) {
      if (closes(fence.marker, line)) {
        const parsed = fence.body ? parseWorkflowFence(fence.body) : null
        if (parsed && !ids.includes(parsed.runId) && ids.length < MAX_CARDS_PER_FLUSH) ids.push(parsed.runId)
        fence = null
      } else if (fence.body) {
        if (fence.body.length >= MAX_FENCE_LINES) fence.body = null
        else fence.body.push(line)
      }
      continue
    }
    const m = FENCE_OPEN.exec(line)
    if (m) fence = { marker: m[1]!, body: (m[2] ?? '').toLowerCase() === WORKFLOW_KIND ? [] : null }
  }
  return ids
}

function closes(marker: string, line: string): boolean {
  const t = line.trim()
  return t.length >= marker.length && t[0] === marker[0] && /^(`+|~+)$/.test(t)
}

function paint(row: Row): string {
  return row.map(p => (PART_SGR[p.role][0] + p.text + PART_SGR[p.role][1])).join('')
}

/** A held fence's lines drawn, or null when its body does not parse (then it is handed back as written). */
export function drawFence(
  kind: string,
  body: readonly string[],
  columns: number,
  cards?: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const width = Math.max(columns - GUTTER, 10)
  if (body.length === 0 || body.length > MAX_FENCE_LINES) return null
  if (kind === 'diff') return drawDiff(body)
  if (kind === WORKFLOW_KIND) {
    // The card the caller fetched for this run; no card (unknown run, bridge failure) shows the fence as written.
    const parsed = parseWorkflowFence(body)
    const card = parsed ? cards?.get(parsed.runId) : undefined
    return card && card.length > 0 ? [...card] : null
  }
  if (kind === 'flow') {
    const lines = body.filter(l => l.trim() !== '')
    if (lines.length === 0 || lines.some(l => parseFlowChain(l) === null)) return null
    const rows = drawFlowPainted(lines, width)
    return rows.length === 0 ? null : rows
  }
  const chart = parseChart(kind, [...body])
  if (!chart) return null
  const rows = drawChart(chart, width)
  return rows.length === 0 ? null : rows.map(paint)
}

/** One unified-diff hunk drawn with old and new line numbers, removals red, additions green. */
export function drawDiff(body: readonly string[]): string[] | null {
  if (!isUnifiedDiff(body.join('\n'))) return null
  const out: string[] = []
  let oldNo = 0
  let newNo = 0
  let width = 1
  for (const l of body) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l)
    if (h) width = Math.max(width, String(Number(h[1]) + Number(h[2] ?? 1)).length, String(Number(h[3]) + Number(h[4] ?? 1)).length)
  }
  const num = (n: number | null): string => (n === null ? '' : String(n)).padStart(width)
  for (const l of body) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l)
    if (h) {
      oldNo = Number(h[1])
      newNo = Number(h[2])
      out.push(`${ESC}36m${l}${RESET_FG}`)
      continue
    }
    const sign = l[0]
    const text = l.slice(1)
    if (sign === '-') out.push(`${ESC}31m${num(oldNo++)} ${num(null)} -${text}${RESET_FG}`)
    else if (sign === '+') out.push(`${ESC}32m${num(null)} ${num(newNo++)} +${text}${RESET_FG}`)
    else if (sign === '\\') out.push(`${ESC}2m${l}${RESET_WEIGHT}`)
    else out.push(`${ESC}2m${num(oldNo++)} ${num(newNo++)}${RESET_WEIGHT}  ${text}`)
  }
  return out
}

/** The LifeOS rule as one ANSI line, `columns` minus the gutter wide. */
export function drawRule(columns: number, band: BandState | null): string {
  return bannerParts(columns - GUTTER, band)
    .map(p => BANNER_SGR[p.role][0] + p.text + BANNER_SGR[p.role][1])
    .join('')
}

const SECTION_OF: Readonly<Record<LabelStyle['color'], Section>> = { blue: 'change', green: 'verify', yellow: 'open' }

/** One line outside any fence, styled; a long list item comes back wrapped onto several lines. */
function styleLine(state: StreamState, line: string, columns: number): string[] {
  const label = styleFor(line)
  if (label) {
    state.inVerify = line.startsWith('✅ VERIFY:')
    state.section = SECTION_OF[label.color]
    return [`${ESC}1m${LABEL_FG[label.color]}${line}${RESET_WEIGHT}${RESET_FG}`]
  }
  const callout = calloutFor(line)
  if (callout) return [`${BAR_FG[callout.bar]}▌${RESET_FG} ${line}`]
  if (state.inVerify) {
    const mark = verifyMark(line)
    if (mark) {
      // The bullet dash goes: the coloured mark is the bullet (`✓ Tests pass.`).
      const at = line.indexOf(mark.glyph)
      return [MARK_FG[mark.color] + mark.glyph + RESET_FG + line.slice(at + mark.glyph.length)]
    }
  }
  return enrichLine(line, { width: Math.max(columns - GUTTER, 10), section: state.section ?? 'none' })
}

/** The held table drawn with a blank line each side, or its lines as written when it does not parse or fit. */
function releaseTable(state: StreamState, columns: number): string[] {
  const held = state.table ?? []
  state.table = null
  const table = held.length >= 2 ? parseTable(held) : null
  const drawn = table ? drawTable(table, Math.max(columns - GUTTER, 10)) : null
  return drawn ? block(symbols(drawn)) : held
}

/**
 * The drawn copy's emoji markers as coloured Nerd Font symbols (🎯 💡 ⚠️ 🔧 ✅ ❓ 🤖 🗣️ …), width unchanged
 * (glyph-core.ts, ISA 20261015-statusline-glyphs F5). Only lines this mod draws pass through it: a plain code fence
 * and a table left as raw markdown keep their text, since the engine still reads them. The stored reply never changes.
 */
const symbols = (lines: string[]): string[] => lines.map(glyphify)

/**
 * The held VERIFY run drawn: its ✓ and ✗ marks coloured when `marked`, else every line drawn as if it sat
 * outside VERIFY, so a list is never half chips and half bullets.
 */
function releaseVerify(state: StreamState, marked: boolean, ctx: StreamContext): string[] {
  const held = state.verifyRun ?? []
  state.verifyRun = null
  state.inVerify = marked
  // Until the next label, a ✓ bullet is an ordinary bullet: the `verify` section would leave it undrawn.
  if (!marked) state.section = 'none'
  return renderLines(state, held, false, ctx)
}

/** Hand back a drawn block with a blank line each side, so markdown never folds it into a list item. */
function block(rows: string[]): string[] {
  return ['', ...rows, '']
}

/**
 * One flush: the lines the engine shows in place of `lines`. A held fence shows nothing
 * until it closes; on the message's final flush anything still held is handed back as written.
 */
export function renderLines(state: StreamState, lines: readonly string[], final: boolean, ctx: StreamContext): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (state.verifyRun) {
      // The run ends at the next label, the rule marker or the closer; a blank line or a flat marked bullet keeps it.
      const ends = styleFor(line) !== null || isMarker(line) || isCloserLine(line)
      if (!ends && (line.trim() === '' || verifyMark(line))) {
        state.verifyRun.push(line)
        continue
      }
      out.push(...releaseVerify(state, ends, ctx))
    }
    const f = state.fence
    if (f) {
      if (closes(f.marker, line)) {
        state.fence = null
        if (!f.drawn) {
          out.push(dedented(line, f.dedent))
          continue
        }
        const drawn = drawFence(f.kind, f.lines.slice(1), ctx.columns, ctx.cards)
        out.push(...(drawn ? block(symbols(drawn)) : [...f.lines, line]))
        continue
      }
      if (f.drawn) f.lines.push(line)
      else out.push(dedented(line, f.dedent))
      continue
    }
    if (state.table) {
      // A lone `|` line becomes a table only when a delimiter row follows it.
      const held = state.table.length === 1 && !isDelimiterRow(line)
      if (!held && isTableLine(line)) {
        state.table.push(line)
        // Past the drawable size it never draws, so stop holding it.
        if (state.table.length > MAX_TABLE_LINES) {
          out.push(...state.table)
          state.table = null
          state.rawTable = true
        }
        continue
      }
      out.push(...releaseTable(state, ctx.columns))
    }
    if (state.rawTable) {
      if (isTableLine(line)) {
        out.push(line)
        continue
      }
      state.rawTable = false
    }
    if (isTableLine(line)) {
      state.table = [line]
      continue
    }
    const deep = DEEP_FENCE.exec(line)
    if (deep) {
      // The list item above it is drawn text now, so the engine would not see the fence as code
      // at this depth: it is moved to column 0, where the engine draws a real code block.
      const dedent = indentOf(line)
      state.fence = { marker: deep[1]!, kind: '', drawn: false, lines: [line], dedent }
      out.push(line.slice(dedent))
      continue
    }
    const m = FENCE_OPEN.exec(line)
    if (m) {
      const kind = (m[2] ?? '').toLowerCase()
      const drawn = DRAWN_KINDS.has(kind)
      state.fence = { marker: m[1]!, kind, drawn, lines: [line] }
      if (!drawn) out.push(line)
      continue
    }
    if (isMarker(line) && !state.ruled) {
      state.ruled = true
      out.push(drawRule(ctx.columns, ctx.band))
      continue
    }
    if (isCloserLine(line)) {
      state.inVerify = false
      state.section = 'none'
      // The fallback when the answer opened without the marker: the rule above the closer.
      if (!state.ruled) out.push(...block([drawRule(ctx.columns, ctx.band)]))
      state.ruled = true
      out.push(glyphify(enrichCloser(line)), CLOSER_SPACER)
      continue
    }
    if (line.trim() !== '') {
      const indent = indentOf(line)
      if (LIST_ITEM.test(line)) {
        if (indent >= 4 && !state.inList) {
          // Four spaces deep with no list above it: an indented code block, left as written.
          out.push(line)
          continue
        }
        state.inList = true
      } else if (indent >= 4 && !state.inList) {
        out.push(line)
        continue
      } else if (indent >= 2 && state.inList) {
        // A list item's own paragraph: the item above is drawn text now, so keep the
        // indent from reading as code by opening the line with an SGR code.
        out.push(RESET_FG + line)
        continue
      } else if (indent === 0) {
        state.inList = false
      }
    }
    out.push(...symbols(styleLine(state, line, ctx.columns)))
    if (state.inVerify && line.startsWith('✅ VERIFY:')) state.verifyRun = []
  }
  if (final && state.verifyRun) out.push(...releaseVerify(state, true, ctx))
  if (final && state.table) out.push(...releaseTable(state, ctx.columns))
  if (final && state.fence?.drawn) {
    out.push(...state.fence.lines)
    state.fence = null
  }
  return out
}

/** Split a flush's delta into lines; a delta ending in a newline carries no trailing partial line. */
export function splitDelta(delta: string): string[] {
  if (delta === '') return []
  const lines = delta.split('\n')
  if (delta.endsWith('\n')) lines.pop()
  return lines
}
