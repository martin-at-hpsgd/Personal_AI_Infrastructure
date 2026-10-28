// Table drawing: pure logic, no engine imports.
// isTableLine(line)        -> a line that may belong to a GFM table
// isDelimiterRow(line)     -> the `|---|:-:|--:|` row under a table header
// parseTable(lines)        -> header, column alignment and body rows | null
// drawTable(table, width)  -> a rounded, framed table as ANSI rows | null
//
// The drawn rows go back through the engine's markdown renderer as paragraph text,
// so every row starts with a box glyph and the inline markdown inside a cell (bold,
// italic, code, links) is drawn here with its markers removed.
// Fail open: any doubt returns null and the caller shows the table as written.
import { displayWidth } from './flow'
import { BOLD, FG, ITALIC, RESET_FG, RESET_ITALIC, RESET_WEIGHT } from './palette'

export type Align = 'left' | 'center' | 'right' | 'auto'
export type Table = {
  readonly header: readonly string[]
  readonly align: readonly Align[]
  /** Body rows, each exactly as many cells as the header. */
  readonly rows: readonly (readonly string[])[]
}

/** Longest block parseTable accepts; anything longer stays as written. */
export const MAX_TABLE_LINES = 60

const MARGIN = 2 // cells left free at the right edge, as in charts.ts
const MIN_COLUMN = 3 // a column is never shrunk below this many cells of content

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const clean = (s: string): string =>
  s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim()

// ── parsing ──────────────────────────────────────────────────────────────

/** A row's cells: outer pipes dropped, split on unescaped `|`, `\|` kept as a literal pipe. */
function splitCells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|'
      i += 1
    } else if (ch === '|') {
      cells.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur)
  return cells.map(clean)
}

/** A line whose content, after at most three leading spaces, starts with `|`. */
export function isTableLine(line: string): boolean {
  return typeof line === 'string' && /^ {0,3}\|/.test(line)
}

const DELIMITER_CELL = /^:?-+:?$/

/** A GFM delimiter row: at least one pipe, and every cell is dashes with optional edge colons. */
export function isDelimiterRow(line: string): boolean {
  if (typeof line !== 'string' || !line.includes('|') || !/^ {0,3}\S/.test(line)) return false
  const cells = splitCells(line)
  return cells.length > 0 && cells.every(c => DELIMITER_CELL.test(c))
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return 'auto'
}

/** A row line: at most three leading spaces and at least one pipe. */
const isRowLine = (line: string): boolean => /^ {0,3}\S/.test(line) && line.includes('|')

/**
 * A header line, a delimiter row and zero or more body rows to a table, or null
 * when the delimiter is missing or its cell count differs from the header's, a body
 * row has more cells than the header, a line is blank, or there are over 60 lines.
 * A body row with fewer cells is padded with empty ones.
 */
export function parseTable(lines: readonly string[]): Table | null {
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > MAX_TABLE_LINES) return null
  if (lines.some(l => typeof l !== 'string' || !isRowLine(l))) return null
  const [head, delimiter, ...body] = lines as readonly string[]
  if (!isDelimiterRow(delimiter!)) return null
  const header = splitCells(head!)
  const marks = splitCells(delimiter!)
  if (marks.length !== header.length) return null
  const rows: string[][] = []
  for (const line of body) {
    const cells = splitCells(line)
    if (cells.length > header.length) return null
    while (cells.length < header.length) cells.push('')
    rows.push(cells)
  }
  return { header, align: marks.map(alignOf), rows }
}

// ── inline markdown ──────────────────────────────────────────────────────

type Tone = 'pass' | 'fail' | 'caution'
type Style = { readonly bold: boolean; readonly italic: boolean; readonly code: boolean; readonly tone: Tone | null }
type Piece = { readonly text: string; readonly style: Style }
type Word = readonly Piece[]
type Line = Piece[]

const PLAIN: Style = { bold: false, italic: false, code: false, tone: null }
const sameStyle = (a: Style, b: Style): boolean =>
  a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.tone === b.tone

const STATUS = /^([✓✗⚠])️?/u
const TONE: Readonly<Record<string, Tone>> = { '✓': 'pass', '✗': 'fail', '⚠': 'caution' }

const ASCII_PUNCT = /[!-/:-@[-`{-~]/
const WORD_CHAR = /[\p{L}\p{N}]/u
const SPACE = /\s/
const LINK = /^\[([^\]]*)\]\(([^()\s]*)(?:\s+"[^"]*")?\)/

function runLength(src: string, at: number, ch: string): number {
  let n = 0
  while (src[at + n] === ch) n += 1
  return n
}

/** Index of the next run of exactly `n` backticks at or after `from`, or -1. */
function findTicks(src: string, from: number, n: number): number {
  let j = from
  while (j < src.length) {
    if (src[j] !== '`') {
      j += 1
      continue
    }
    const r = runLength(src, j, '`')
    if (r === n) return j
    j += r
  }
  return -1
}

type Emphasis = { inner: string; end: number; bold: boolean }

/**
 * The emphasis opened by the `*` or `_` run at `at`, or null when it never closes.
 * `_` only opens and closes at a word edge, so snake_case stays literal.
 */
function emphasis(src: string, at: number, d: '*' | '_'): Emphasis | null {
  const run = runLength(src, at, d)
  for (const len of run >= 2 ? [2, 1] : [1]) {
    const start = at + len
    const next = src[start]
    if (next === undefined || SPACE.test(next)) continue
    if (d === '_' && at > 0 && WORD_CHAR.test(src[at - 1]!)) continue
    let j = start
    while (j < src.length) {
      const ch = src[j]!
      if (ch === '\\') {
        j += 2
        continue
      }
      if (ch === '`') {
        const n = runLength(src, j, '`')
        const close = findTicks(src, j + n, n)
        j = close < 0 ? j + n : close + n
        continue
      }
      if (ch !== d) {
        j += 1
        continue
      }
      const r = runLength(src, j, d)
      // A closing run of three or more gives its last `len` delimiters to this span.
      const closer = len === 2 ? (r >= 2 ? j + r - 2 : -1) : r === 1 || r >= 3 ? j + r - 1 : -1
      const after = src[j + r]
      const fits =
        closer > start &&
        !SPACE.test(src[closer - 1]!) &&
        !(d === '_' && after !== undefined && WORD_CHAR.test(after))
      if (fits) return { inner: src.slice(start, closer), end: closer + len, bold: len === 2 }
      j += r
    }
  }
  return null
}

/** Inline markdown to styled pieces with every marker removed. */
function parseInline(src: string, style: Style, out: Piece[]): void {
  let lit = ''
  const emit = () => {
    if (lit !== '') out.push({ text: lit, style })
    lit = ''
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (ch === '\\' && i + 1 < src.length && ASCII_PUNCT.test(src[i + 1]!)) {
      lit += src[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      const n = runLength(src, i, '`')
      const close = findTicks(src, i + n, n)
      if (close < 0) {
        lit += src.slice(i, i + n)
        i += n
        continue
      }
      emit()
      let code = src.slice(i + n, close)
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1)
      out.push({ text: code, style: { ...style, code: true } })
      i = close + n
      continue
    }
    const image = ch === '!' && src[i + 1] === '['
    if (ch === '[' || image) {
      const m = LINK.exec(src.slice(image ? i + 1 : i))
      if (m) {
        emit()
        parseInline(m[1]!, style, out)
        i += m[0].length + (image ? 1 : 0)
        continue
      }
    }
    if (ch === '*' || ch === '_') {
      const span = emphasis(src, i, ch)
      if (span) {
        emit()
        parseInline(span.inner, span.bold ? { ...style, bold: true } : { ...style, italic: true }, out)
        i = span.end
        continue
      }
      const n = runLength(src, i, ch)
      lit += src.slice(i, i + n)
      i += n
      continue
    }
    lit += ch
    i += 1
  }
  emit()
}

/** A cell's words; a body cell opening with ✓, ✗ or ⚠ gets that glyph toned. */
function cellWords(raw: string, body: boolean): Word[] {
  const text = clean(raw)
  const pieces: Piece[] = []
  const status = body ? STATUS.exec(text) : null
  if (status) {
    pieces.push({ text: status[0], style: { ...PLAIN, tone: TONE[status[1]!]! } })
    parseInline(text.slice(status[0].length), PLAIN, pieces)
  } else {
    parseInline(text, PLAIN, pieces)
  }
  const words: Piece[][] = []
  let cur: Piece[] = []
  for (const p of pieces) {
    for (const part of p.text.split(/(\s+)/)) {
      if (part === '') continue
      if (SPACE.test(part[0]!)) {
        if (cur.length > 0) words.push(cur)
        cur = []
      } else {
        cur.push({ text: part, style: p.style })
      }
    }
  }
  if (cur.length > 0) words.push(cur)
  return words
}

const piecesWidth = (pieces: readonly Piece[]): number => pieces.reduce((w, p) => w + displayWidth(p.text), 0)

/** Cells a cell takes on one line: its words joined by single spaces. */
const oneLineWidth = (words: readonly Word[]): number =>
  words.reduce((w, word) => w + piecesWidth(word), 0) + Math.max(words.length - 1, 0)

const visibleText = (words: readonly Word[]): string => words.map(w => w.map(p => p.text).join('')).join(' ')

/** Append text to a line, joining the last piece when the style matches. */
function append(line: Line, text: string, style: Style): void {
  const last = line[line.length - 1]
  if (last && sameStyle(last.style, style)) line[line.length - 1] = { text: last.text + text, style }
  else line.push({ text, style })
}

/** A word too long for `w` cells, cut into lines that each fit. */
function breakWord(word: Word, w: number): Line[] {
  const chunks: Line[] = []
  let cur: Line = []
  let used = 0
  for (const p of word) {
    for (const { segment } of segmenter.segment(p.text)) {
      const cw = displayWidth(segment)
      if (used > 0 && used + cw > w) {
        chunks.push(cur)
        cur = []
        used = 0
      }
      append(cur, segment, p.style)
      used += cw
    }
  }
  if (cur.length > 0) chunks.push(cur)
  return chunks
}

/** Greedy word wrap into lines of at most `w` cells; a space keeps the style around it when both sides share it. */
function wrapCell(words: readonly Word[], w: number): Line[] {
  const lines: Line[] = []
  let cur: Line = []
  let used = 0
  for (const word of words) {
    const ww = piecesWidth(word)
    if (used > 0 && used + 1 + ww <= w) {
      const left = cur[cur.length - 1]!.style
      append(cur, ' ', sameStyle(left, word[0]!.style) ? left : PLAIN)
      for (const p of word) append(cur, p.text, p.style)
      used += 1 + ww
      continue
    }
    if (used > 0) {
      lines.push(cur)
      cur = []
      used = 0
    }
    if (ww <= w) {
      for (const p of word) append(cur, p.text, p.style)
      used = ww
      continue
    }
    const chunks = breakWord(word, w)
    lines.push(...chunks.slice(0, -1))
    cur = chunks[chunks.length - 1] ?? []
    used = piecesWidth(cur)
  }
  if (cur.length > 0 || lines.length === 0) lines.push(cur)
  return lines
}

// ── drawing ──────────────────────────────────────────────────────────────

/** One piece with its own SGR opened and closed, so nothing leaks past it. */
function paint(p: Piece, header: boolean): string {
  if (p.text.trim() === '' && !header) return p.text
  let open = ''
  let close = ''
  if (p.style.bold || header) {
    open += BOLD
    close = RESET_WEIGHT + close
  }
  if (p.style.italic) {
    open += ITALIC
    close = RESET_ITALIC + close
  }
  const fg = p.style.tone ? FG[p.style.tone] : p.style.code ? FG.code : header ? FG.accentSoft : null
  if (fg) {
    open += fg
    close = RESET_FG + close
  }
  return open + escapeMarkdown(p.text) + close
}

/**
 * The engine runs its markdown renderer over the drawn rows, so a character it would consume
 * (`\*lit\*` lost both asterisks live and the row fell two cells short) is
 * backslash-escaped. Widths are measured on the unescaped text, which is what shows.
 */
const escapeMarkdown = (text: string): string => text.replace(/[\\`*_[\]~<&]/g, ch => "\\" + ch)

type Side = 'left' | 'center' | 'right'

function cellLine(line: Line, w: number, side: Side, header: boolean): string {
  const room = Math.max(w - piecesWidth(line), 0)
  const lead = side === 'right' ? room : side === 'center' ? Math.floor(room / 2) : 0
  return ' '.repeat(lead) + line.map(p => paint(p, header)).join('') + ' '.repeat(room - lead)
}

const NUMERIC =
  /^[+\-−±~≈]?[$€£¥]?(?:\d{1,3}(?:,\d{3})+|\d+|(?=\.\d))(?:\.\d+)?\+?\s?(?:%|×|[A-Za-zµ/]{1,6})?$/u
const PLACEHOLDER = /^(?:[—–-]|n\/a)$/i

/** True when every non-placeholder body cell reads as a number and at least one does. */
function isNumericColumn(cells: readonly (readonly Word[])[]): boolean {
  let numbers = 0
  for (const words of cells) {
    const text = visibleText(words)
    if (text === '' || PLACEHOLDER.test(text)) continue
    if (!NUMERIC.test(text)) return false
    numbers += 1
  }
  return numbers > 0
}

/** Content widths within `budget`: the widest columns shrink first, none below its floor; null when the floors overflow. */
function fitWidths(natural: readonly number[], budget: number): number[] | null {
  const widths = natural.map(n => Math.max(n, 1))
  const floor = natural.map(n => Math.max(Math.min(n, MIN_COLUMN), 1))
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
  if (sum(floor) > budget) return null
  let excess = sum(widths) - budget
  while (excess > 0) {
    let at = -1
    for (let c = 0; c < widths.length; c++) {
      if (widths[c]! > floor[c]! && (at < 0 || widths[c]! > widths[at]!)) at = c
    }
    if (at < 0) return null
    widths[at] = widths[at]! - 1
    excess -= 1
  }
  return widths
}

const ALIGNS: ReadonlySet<string> = new Set<Align>(['left', 'center', 'right', 'auto'])

function isTable(t: unknown): t is Table {
  if (typeof t !== 'object' || t === null) return false
  const { header, align, rows } = t as Record<string, unknown>
  if (!Array.isArray(header) || header.length === 0 || !header.every(c => typeof c === 'string')) return false
  if (!Array.isArray(align) || align.length !== header.length || !align.every(a => ALIGNS.has(a))) return false
  return (
    Array.isArray(rows) &&
    rows.every(r => Array.isArray(r) && r.length === header.length && r.every(c => typeof c === 'string'))
  )
}

/**
 * The table drawn with rounded corners, a header rule and one space of padding,
 * every row at most `width` less a two-cell margin. Columns too wide shrink widest
 * first and wrap; when a body row wraps, a rule separates the body rows. Null when
 * the table is malformed or cannot fit with every column at three cells of content.
 */
export function drawTable(table: Table, width: number): string[] | null {
  if (!isTable(table) || typeof width !== 'number' || !Number.isFinite(width)) return null
  const n = table.header.length
  const budget = Math.floor(width) - MARGIN - (3 * n + 1)
  const head = table.header.map(c => cellWords(c, false))
  const body = table.rows.map(r => r.map(c => cellWords(c, true)))
  const natural = head.map((h, c) => Math.max(oneLineWidth(h), ...body.map(r => oneLineWidth(r[c]!))))
  const widths = fitWidths(natural, budget)
  if (!widths) return null
  const sides: Side[] = table.align.map((a, c) =>
    a !== 'auto' ? a : isNumericColumn(body.map(r => r[c]!)) ? 'right' : 'left',
  )

  const frame = (s: string) => FG.frame + s + RESET_FG
  const rule = (l: string, m: string, r: string) => frame(l + widths.map(w => '─'.repeat(w + 2)).join(m) + r)
  const bar = frame('│')
  const drawRow = (cells: readonly (readonly Word[])[], header: boolean): string[] => {
    const wrapped = cells.map((words, c) => wrapCell(words, widths[c]!))
    const height = Math.max(...wrapped.map(l => l.length))
    const out: string[] = []
    for (let k = 0; k < height; k++) {
      const parts = wrapped.map((lines, c) => ' ' + cellLine(lines[k] ?? [], widths[c]!, sides[c]!, header) + ' ')
      out.push(bar + parts.join(bar) + bar)
    }
    return out
  }

  const bodyRows = body.map(r => drawRow(r, false))
  const ruled = bodyRows.some(r => r.length > 1)
  const out = [rule('╭', '┬', '╮'), ...drawRow(head, true)]
  bodyRows.forEach((r, i) => {
    if (i === 0 || ruled) out.push(rule('├', '┼', '┤'))
    out.push(...r)
  })
  out.push(rule('╰', '┴', '╯'))
  return out
}
