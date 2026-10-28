// Line enrichment: pure logic, no engine imports.
// enrichLine(line, ctx) -> display lines for one source line outside a code fence
// enrichCloser(line)    -> the `🗣️ Name: text` closer with Name bold in the accent
//
// The engine runs its markdown renderer over what comes back, so every changed line
// starts with an SGR escape (never `#`, `-`, `>`, a digit-dot or a space) and indented
// lines open with RESET_FG before their spaces. Inline markdown in item text is left
// as written. Fail open: any doubt returns [line].
import { displayWidth } from './flow'
import { BOLD, paintBold, paintFg, RESET_FG, RESET_WEIGHT } from './palette'

export type Section = 'none' | 'change' | 'verify' | 'open'
export type EnrichContext = { width: number; section: Section }

const MARGIN = 2 // cells left free at the right edge, as in charts.ts
const NO_BREAK = '\u0001' // stands in for a space inside a backtick span or a link while wrapping

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** A thematic break, spaced or not: `---`, `* * *`, `- - -`, `___`. */
const RULE = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const HEADING = /^(#{1,6})[ \t]+(\S.*)$/
const MINI_HEADER = /^\*\*(\S(?:[^*]*\S)?)\*\*[ \t]*$/
const QUOTE = /^>[ \t]?(.*)$/
const BULLET = /^( *)[-*+] +(\S.*)$/
const NUMBERED = /^( *)(\d{1,3}[.)]) +(\S.*)$/
const CLOSER = /^(\u{1F5E3}️?[ \t]+)([^:\n*]{1,40}?)(:.*)$/u
const SPAN = /`[^`]*`|\[[^\]]*\]\([^)]*\)/g

/** Cells the text takes once drawn: `**`, `__` and backticks vanish; a link shows its text and url. */
function visibleWidth(text: string): number {
  const shown = text
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)')
    .replace(/\*\*|__|`/g, '')
  return displayWidth(shown)
}

/** Cut one over-long word into pieces no wider than `avail` cells. */
function hardBreak(word: string, avail: number): string[] {
  const pieces: string[] = []
  let cur = ''
  for (const { segment } of segmenter.segment(word)) {
    if (cur !== '' && visibleWidth(cur + segment) > avail) {
      pieces.push(cur)
      cur = segment
    } else {
      cur += segment
    }
  }
  if (cur !== '') pieces.push(cur)
  return pieces
}

/** Greedy word wrap on visible width; code spans and links stay in one piece. */
function wrap(text: string, avail: number): string[] {
  const guarded = text.replace(SPAN, m => m.replace(/ /g, NO_BREAK))
  const words = guarded
    .split(/ +/)
    .filter(w => w !== '')
    .map(w => w.split(NO_BREAK).join(' '))
  const lines: string[] = []
  let cur = ''
  for (const word of words) {
    if (cur !== '' && visibleWidth(`${cur} ${word}`) <= avail) {
      cur += ` ${word}`
      continue
    }
    if (cur !== '') lines.push(cur)
    if (visibleWidth(word) <= avail) {
      cur = word
    } else {
      const pieces = hardBreak(word, avail)
      cur = pieces.pop() ?? ''
      lines.push(...pieces)
    }
  }
  if (cur !== '') lines.push(cur)
  return lines
}

/**
 * One list item: `lead` is the already-painted marker (starts with an SGR escape),
 * `indent` the spaces before it, `markerCells` the marker plus its trailing space.
 */
function item(lead: string, indent: string, markerCells: number, text: string, width: number): string[] | null {
  const hang = indent.length + markerCells
  const avail = width - MARGIN - hang
  if (avail < 1) return null
  const rows = wrap(text, avail)
  if (rows.length === 0) return null
  // an indented first line opens with RESET_FG so markdown never sees leading spaces
  const first = `${indent === '' ? '' : RESET_FG + indent}${lead} ${rows[0]}`
  return [first, ...rows.slice(1).map(r => RESET_FG + ' '.repeat(hang) + r)]
}

/** The display lines for one source line outside any code fence; [line] unchanged when nothing applies. */
export function enrichLine(line: string, ctx: EnrichContext): string[] {
  if (typeof line !== 'string' || line === '' || line.includes('\x1b') || line.includes(NO_BREAK)) return [line]
  if (!ctx || !Number.isFinite(ctx.width) || ctx.width - MARGIN < 1) return [line]
  const width = Math.floor(ctx.width)
  if (line.trimStart().startsWith('|')) return [line]
  const src = line.replace(/\s+$/, '')

  if (RULE.test(src)) return [paintFg('frame', '─'.repeat(width - MARGIN))]

  const h = HEADING.exec(src)
  if (h) {
    const text = h[2]!.replace(/\s+#+$/, '')
    if (text === '') return [line]
    return [paintBold(h[1]!.length <= 2 ? 'accent' : 'accentSoft', text)]
  }

  const mini = MINI_HEADER.exec(src)
  if (mini) return [paintBold('accentSoft', mini[1]!)]

  if (src.startsWith('🎯')) return [BOLD + src + RESET_WEIGHT]

  const q = QUOTE.exec(src)
  if (q) return [paintFg('frame', '▎') + (q[1] === '' ? '' : ' ' + q[1])]

  const b = BULLET.exec(src)
  if (b) {
    // One space of indent is still a top-level item in markdown.
    const indent = b[1]!.length === 1 ? '' : b[1]!
    const text = b[2]!
    if (ctx.section === 'verify' && (text.startsWith('✓') || text.startsWith('✗'))) return [line]
    const nested = indent.length >= 2
    const lead = nested ? paintFg('frame', '◦') : paintFg('accent', '•')
    return item(lead, indent, 2, text, width) ?? [line]
  }

  const n = NUMBERED.exec(src)
  if (n) {
    const indent = n[1]!
    const mark = n[2]!
    const lead = paintFg(ctx.section === 'open' ? 'open' : 'accent', mark)
    return item(lead, indent, mark.length + 1, n[3]!, width) ?? [line]
  }

  return [line]
}

// The closer may carry Fish Drama 3 performance tags for the voice (`[sigh]`, `<emphasis>…</emphasis>`).
// They are performed, never read, so the drawn line hides them. Kept in step with LIFEOS/TOOLS/VoiceTags.ts;
// the plugin stays self-contained, so the two patterns are duplicated on purpose.
const VOICE_PAIRED = /<\/?(?:emphasis|stress|soft|whisper|fast|slow|forceful)>/g
const VOICE_BRACKET = /\[[A-Za-z][A-Za-z ,'\-]{0,60}\](?!\()/g

/** The spoken words of a closer: voice tags removed and the spacing they leave tidied. */
export function hideVoiceTags(text: string): string {
  return text.replace(VOICE_PAIRED, '').replace(VOICE_BRACKET, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?;:])/g, '$1').replace(/^: +/, ': ')
}

/** The closer `🗣️ Name: text` with Name bold in the accent and voice tags hidden; any other line unchanged. */
export function enrichCloser(line: string): string {
  if (typeof line !== 'string' || line.includes('\x1b')) return line
  const m = CLOSER.exec(line)
  if (!m) return line
  return m[1]! + paintBold('accent', m[2]!) + hideVoiceTags(m[3]!)
}
