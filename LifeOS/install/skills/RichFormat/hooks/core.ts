// Renderer core: the segmenter, the fail-open render decision, the tree builder
// and the prompt section. Pure logic: the only engine import is type-only, so
// `bun test` exercises all of it without the engine.
//
// Fail open everywhere: any doubt leaves a line inside a markdown segment, and
// any doubt about a whole message hands it back to the engine (`next(e)`).
import type { Elements, PromptComposeResult, PromptComposeSection, RenderElement } from 'claude-code'

import {
  bandStateArgv,
  bannerParts,
  freezeKey,
  hasCloser,
  parseBandState,
  type BandState,
  type BannerPart,
  type BannerSource,
} from './banner'
import { CHART_KINDS, drawChart, parseChart, type Chart, type PartRole } from './charts'
import { verifyMark, type VerifyMark } from './chips'
import { isUnifiedDiff } from './diff'
import { drawFlow, parseFlow } from './flow'
import { calloutFor, styleFor, type Callout, type LabelStyle } from './style'

export type Segment =
  | { kind: 'markdown'; source: string }
  | { kind: 'flow'; source: string; chains: string[][] }
  | { kind: 'label'; source: string; style: LabelStyle; label: string; rest: string }
  | { kind: 'callout'; source: string; bar: Callout['bar']; body: string }
  | { kind: 'diff'; source: string; body: string }
  | { kind: 'chip'; source: string; items: ChipItem[] }
  | { kind: 'chart'; source: string; chart: Chart }

/** One VERIFY bullet drawn as a chip: its mark, the mark's colour and the text after the mark. */
export type ChipItem = { glyph: VerifyMark['glyph']; color: VerifyMark['color']; text: string }

/** The engine's `Markdown` element draws at most this many characters. */
export const SEGMENT_CAP = 10000

/** Terminal colour for each callout bar; `amber` is no named terminal colour. */
export const BAR_COLOR: Readonly<Record<Callout['bar'], string>> = { cyan: 'cyan', amber: '#FFB000' }

/** Terminal style for each chart part: a colour, dim, or bold; absent draws plain. */
export const CHART_STYLE: Readonly<Record<PartRole, { color?: string; dimColor?: boolean; bold?: boolean }>> = {
  label: { bold: true },
  bar: { color: 'cyan' },
  value: {},
  mark: { color: 'cyan' },
  rail: { dimColor: true },
  dim: { dimColor: true },
  text: {},
}

/** Cells the reply gutter (bullet and indent) takes left of a reply's text. */
const GUTTER = 2

/**
 * The engine's own reply bullet and its colour (engine 2.1.292, read from a live pane's ANSI).
 * A block the mod draws carries the same gutter, so it lines up with the engine's blocks.
 */
export const REPLY_BULLET = '⏺'
export const REPLY_BULLET_COLOR = '#FFFFFF'

/**
 * The answers the engine may hand the render hook: at most 16 lines and 1500 characters. Any
 * hook that sees a finished answer makes the engine repaint the live turn as the answer settles,
 * and on the main screen a turn taller than the terminal then prints twice (2026-10-07: 51 of 60
 * rows doubled with this mod alone). Used as the hook's matcher, so a longer answer never reaches
 * the hook and stays the engine's own drawing.
 */
export const SHORT_ANSWER = /^(?=[\s\S]{0,1500}$)(?:[^\n]*\n){0,15}[^\n]*$/

/** Cells assumed when the surface has not measured its width yet. */
export const DEFAULT_COLUMNS = 80

/** The rule is drawn only when it can show the whole name: its width below this draws no banner. */
export const BANNER_MIN_WIDTH = 24

/** The `◆ LifeOS` name is bold in this colour; the state is cyan and the rule dim. */
export const BANNER_NAME_COLOR = '#3B82F6'
export const BANNER_STATE_COLOR = 'cyan'

/** Longest the bridge may run for one state read. */
export const BRIDGE_TIMEOUT_MS = 3000

export const FLOW_SECTION_ID = 'rich-format:flow'

/**
 * Prompt traits of a session whose replies this mod draws; any other trait leaves the prompt alone.
 * `lean` is the engine's per-model prompt variant (2.1.289 sets it from the model, not the run),
 * so an interactive terminal session on a lean-prompt model carries it; refusing it kept the flow
 * rule out of every live session.
 */
const DRAWN_TRAITS: ReadonlySet<string> = new Set(['skills', 'send-user-message', 'lean'])

export const FLOW_EXAMPLE = 'request ->|auth| gateway -> cache:::green'

export const DIFF_EXAMPLE = ['@@ -4,3 +4,3 @@', ' const key = id', '-const page = cache[key]', '+const page = cache[key + build]', ' return page'].join('\n')

/** One example per chart kind; the prompt shows them and the tests parse them. */
export const CHART_EXAMPLES: Readonly<Record<(typeof CHART_KINDS)[number], string>> = {
  bar: ['Opus: 412', 'Astra: 218', 'Sonnet: 86'].join('\n'),
  spark: 'deploys/day: 1 3 2 5 3 7 9 6 4 5',
  tree: ['LifeOS', '  Algorithm', '    ISA', '  Pulse'].join('\n'),
  timeline: ['03-02: bug filed', '03-09: fix merged', '03-12: release cut'].join('\n'),
}

export const FLOW_SECTION_TEXT = [
  '# Flow diagrams, charts, diffs and VERIFY marks',
  '',
  'This terminal draws flow diagrams. When an answer explains a sequence with moving parts (a pipeline, a request path, a hand-off between systems) that a picture shows faster than prose, write it as a fenced code block whose info string is `flow`: one chain per line, nodes joined by `->`. The terminal draws each chain as a row of boxed nodes joined by arrows; the stored text stays the plain chain.',
  '',
  '- Keep node labels to a few words and a chain to about six nodes.',
  '- At most one flow block per answer, on its own between paragraphs, never inside a list, a table or another fence.',
  '- Every line in the block must be a chain; a block with any other line is shown as plain code.',
  '- Label an arrow with `->|label|`, the label in pipes right after the arrow: `a ->|ok| b`.',
  '- Colour a node with a suffix: `b:::green`. Colours: green, red, amber, yellow, cyan, blue, purple, grey. A node that starts with ✅, ❌ or ⚠️ is coloured by that mark alone.',
  '- Colour and labels mean something (pass, fail, a condition); leave most nodes plain.',
  '- The words still carry the explanation; the diagram only shows its shape.',
  '',
  'Example:',
  '',
  '```flow',
  FLOW_EXAMPLE,
  '```',
  '',
  'This terminal also draws a diff. To show a change you made, put its hunk in a fenced code block whose info string is `diff`; the terminal draws it with line numbers and add and remove colours.',
  '',
  '- Paste the hunk from real `git diff` output; never compose a hunk or its line numbers by hand.',
  '- One hunk of at most fifteen lines, `@@` header included, in the CHANGE section. A change that needs more is described in words.',
  '- If the block is not a valid unified diff it is shown as plain code, so never edit the pasted lines.',
  '',
  'Example:',
  '',
  '```diff',
  DIFF_EXAMPLE,
  '```',
  '',
  'This terminal also draws charts. When numbers, a hierarchy or a run of dated events would read faster as a picture than as a table or a list, use one of these fenced blocks. Each stays readable as plain lines wherever it is not drawn.',
  '',
  '- `bar`: one `label: value` line per bar, values zero or more, an optional unit after the number (`412`, `37%`, `1,200 ms`). Drawn as a horizontal bar chart; use it to compare a handful of quantities.',
  '- `spark`: one series per line, numbers separated by spaces, with an optional `label:` in front. Drawn as a one-line trend with its min, max and last value; use it for change over time.',
  '- `tree`: an indented outline, two spaces per level, one node per line. Drawn with `├─` and `└─` branches; use it for a hierarchy such as a folder, a system or a breakdown.',
  '- `timeline`: one `when: what` line per event, in order. Drawn on a vertical rail; use it for dated events.',
  '- At most two chart blocks per answer, each at most twelve lines, on their own between paragraphs, never inside a list, a table or another fence. Every line must parse, or the block is shown as plain code.',
  '- Chart only numbers you got from a tool or the conversation; never invent values to fill a chart.',
  '',
  'Examples:',
  '',
  ...(Object.entries(CHART_EXAMPLES) as [string, string][]).flatMap(([kind, body]) => ['```' + kind, body, '```', '']),
  'This terminal draws the LifeOS bar over each final answer, so the answer stands apart from the work above it. Open every final answer (the reply that ends with the 🗣️ closer) with a first line holding only `◆`, then a blank line; the terminal draws the bar there, with the session ISA and its progress. Never open an interim note between tool calls with it.',
  '',
  'In the VERIFY section the terminal also draws marks. Begin each bullet with ✓ for a check that passed, or ✗ for a check that failed or did not run (for example `- ✓ Tests pass: 12 of 12.`). Mark every bullet in the section or none, and keep each bullet to one line with no nested bullets; a section with an unmarked or nested bullet is shown as an ordinary list.',
].join('\n')

type Line = { source: string; body: string }

/** Split text into lines, each keeping its own terminator, so joining them gives the text back. */
function splitLines(text: string): Line[] {
  const out: Line[] = []
  for (const m of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const source = m[0]
    out.push({ source, body: source.replace(/\r?\n$/, '').replace(/\r$/, '') })
  }
  return out
}

const isBlank = (body: string): boolean => body.trim() === ''

type Fence = { char: '`' | '~'; length: number; info: string; indent: number }

/** A fence opener at any indent; a backtick fence's info string holds no backtick. */
function fenceOpener(body: string): Fence | null {
  const m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(body)
  if (!m) return null
  const indent = m[1]!
  const run = m[2]!
  const info = m[3]!
  const char = run[0] as '`' | '~'
  if (char === '`' && info.includes('`')) return null
  return { char, length: run.length, info: info.trim(), indent: indent.length }
}

function closesFence(body: string, fence: Fence): boolean {
  const m = /^\s*(`{3,}|~{3,})\s*$/.exec(body)
  if (!m) return false
  const run = m[1]!
  return run[0] === fence.char && run.length >= fence.length
}

/** Index of the line closing the fence opened at `open`, or -1 when it never closes. */
function findClose(lines: Line[], open: number, fence: Fence): number {
  for (let j = open + 1; j < lines.length; j++) {
    if (closesFence(lines[j]!.body, fence)) return j
  }
  return -1
}

/** A line that would turn the line above it into a table header or a setext heading. */
const UNDERLINE = /^\s*\|?\s*[:\-=|\s]*[-=][:\-=|\s]*$/

/** A line that starts a block of its own, so it never continues a callout paragraph. */
const BLOCK_START = /^\s*(?:[-*+]\s|\d{1,9}[.)](?:\s|$)|#|>|\||`{3,}|~{3,})/

/** True when the line at `i` is a standalone paragraph start: column 0, after a blank line or the start. */
function standsAlone(lines: Line[], i: number, prevBlank: boolean): boolean {
  if (!prevBlank) return false
  const after = lines[i + 1]
  return after === undefined || !UNDERLINE.test(after.body) || isBlank(after.body)
}

/**
 * Split an answer into segments: closed `flow` fences whose every line is a
 * chain, closed `diff` fences holding a valid unified diff, standalone CHANGE /
 * VERIFY / OPEN label lines, the bullets of a fully marked VERIFY run, standalone
 * 💡 / ⚠️ paragraphs, and markdown for everything else. Every other fence, list item,
 * table row and lazy continuation stays markdown. The segments' sources
 * concatenate to the input exactly.
 */
export function segment(text: string): Segment[] {
  const lines = splitLines(text)
  const out: Segment[] = []
  let markdown = ''
  const flush = () => {
    if (markdown !== '') out.push({ kind: 'markdown', source: markdown })
    markdown = ''
  }
  const take = (from: number, to: number): string =>
    lines
      .slice(from, to + 1)
      .map(l => l.source)
      .join('')

  let prevBlank = true
  let i = 0
  // The chip run found under the last VERIFY label, drawn when the loop reaches its first bullet.
  let chips: ChipRun | null = null
  while (i < lines.length) {
    const line = lines[i]!
    if (chips && i === chips.first) {
      flush()
      out.push({ kind: 'chip', source: take(chips.first, chips.last), items: chips.items })
      prevBlank = false
      i = chips.last + 1
      chips = null
      continue
    }
    const fence = fenceOpener(line.body)
    if (fence) {
      const close = findClose(lines, i, fence)
      if (close < 0) {
        // Unclosed: everything after the opener is code (and, while streaming, not yet a block).
        markdown += take(i, lines.length - 1)
        break
      }
      const plain = fence.char === '`' && fence.indent === 0
      const chains = plain && fence.info === 'flow' ? flowChains(lines, i, close) : null
      const diff = plain && fence.info === 'diff' ? diffBody(lines, i, close) : null
      const chart = plain && isChartKind(fence.info) ? chartOf(fence.info, lines, i, close) : null
      if (chains) {
        flush()
        out.push({ kind: 'flow', source: take(i, close), chains })
      } else if (diff !== null) {
        flush()
        out.push({ kind: 'diff', source: take(i, close), body: diff })
      } else if (chart) {
        flush()
        out.push({ kind: 'chart', source: take(i, close), chart })
      } else {
        markdown += take(i, close)
      }
      prevBlank = false
      i = close + 1
      continue
    }

    const style = styleFor(line.body)
    if (style && standsAlone(lines, i, prevBlank)) {
      const colon = line.body.indexOf(':')
      chips = line.body.startsWith(VERIFY_LABEL) ? chipRun(lines, i + 1) : null
      flush()
      out.push({
        kind: 'label',
        source: line.source,
        style,
        label: line.body.slice(0, colon + 1),
        rest: line.body.slice(colon + 1).trim(),
      })
      prevBlank = false
      i += 1
      continue
    }

    const callout = calloutFor(line.body)
    if (callout && standsAlone(lines, i, prevBlank)) {
      let end = i
      while (end + 1 < lines.length) {
        const nextBody = lines[end + 1]!.body
        if (isBlank(nextBody) || BLOCK_START.test(nextBody) || styleFor(nextBody) || calloutFor(nextBody)) break
        if (lines[end + 2] !== undefined && UNDERLINE.test(lines[end + 2]!.body)) break
        end += 1
      }
      flush()
      out.push({
        kind: 'callout',
        source: take(i, end),
        bar: callout.bar,
        body: lines
          .slice(i, end + 1)
          .map(l => l.body)
          .join('\n'),
      })
      prevBlank = false
      i = end + 1
      continue
    }

    markdown += line.source
    prevBlank = isBlank(line.body)
    i += 1
  }
  flush()
  return out
}

const VERIFY_LABEL = '✅ VERIFY:'

/** A line that opens the next answer section: a label, the spoken section or the closer. */
const SECTION_START = /^(?:🔧|✅|❓|🎙️|🗣️)/u

type ChipRun = { first: number; last: number; items: ChipItem[] }

/**
 * The chips of the VERIFY run that starts at line `from` (the line after the
 * label): every non-blank line up to the next section label or the closer must
 * be a top-level bullet carrying ✓ or ✗. Prose, an unmarked or nested bullet,
 * a fence or a continuation line anywhere in the run leaves the whole run to
 * the markdown renderer, so a list is never split between two renderers.
 */
function chipRun(lines: Line[], from: number): ChipRun | null {
  const items: ChipItem[] = []
  let first = -1
  let last = -1
  for (let j = from; j < lines.length; j++) {
    const body = lines[j]!.body
    if (SECTION_START.test(body)) break
    if (isBlank(body)) continue
    const mark = verifyMark(body)
    if (!mark) return null
    const text = body.slice(2).replace(/^[✓✗]\s*/u, '').trim()
    if (text === '') return null
    items.push({ glyph: mark.glyph, color: mark.color, text })
    if (first < 0) first = j
    last = j
  }
  return first < 0 ? null : { first, last, items }
}

const isChartKind = (info: string): boolean => (CHART_KINDS as readonly string[]).includes(info)

/** The chart in a closed chart fence (fence lines excluded), or null when any line does not parse. */
function chartOf(kind: string, lines: Line[], open: number, close: number): Chart | null {
  return parseChart(
    kind,
    lines.slice(open + 1, close).map(l => l.body),
  )
}

/** The body of a closed diff fence (fence lines excluded) when it is a valid unified diff, else null. */
function diffBody(lines: Line[], open: number, close: number): string | null {
  const body = lines
    .slice(open + 1, close)
    .map(l => l.body)
    .join('\n')
  return isUnifiedDiff(body) ? body : null
}

/** The chains of a closed flow fence, or null when any non-blank line is not a chain or there are none. */
function flowChains(lines: Line[], open: number, close: number): string[][] | null {
  const chains: string[][] = []
  for (let j = open + 1; j < close; j++) {
    const body = lines[j]!.body
    if (isBlank(body)) continue
    const nodes = parseFlow(body)
    if (!nodes) return null
    chains.push(nodes)
  }
  return chains.length > 0 ? chains : null
}

/** Control characters the `Markdown` element refuses: everything but tab and newline. */
const REFUSED_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/

type RenderLike = {
  surface: string
  props: { text: string }
  viewport?: { columns: number }
}

export type RenderOptions<E, R> = {
  /** The `userConfig` kill switch: false hands every message to the engine. */
  enabled: boolean
  /**
   * Builds the mod's tree; anything it throws hands the message to the engine.
   * `banner` holds the rule's parts for a final answer and is null for any other.
   */
  draw: (segments: Segment[], e: E, banner: BannerPart[] | null) => R
  /** The frozen state source for the rule. Absent, no banner is ever drawn. */
  banner?: Pick<BannerSource, 'prime' | 'forMessage'>
}

/**
 * The `ui.render` decision for one `AssistantMessage` block. The mod draws only
 * on the terminal, only when the block holds a flow, label or callout segment or
 * is a final answer (its last line is the `🗣️` closer), and only when every
 * segment fits the `Markdown` element; in every other case, and whenever
 * segmenting or drawing throws, the answer is `next(e)`'s value.
 */
export async function renderAssistant<E extends RenderLike, R>(
  e: E,
  next: (e: E) => R | Promise<R>,
  opts: RenderOptions<E, R>,
): Promise<R> {
  let drawn: { tree: R } | null = null
  try {
    drawn = await decide(e, opts)
  } catch {
    drawn = null
  }
  return drawn ? drawn.tree : next(e)
}

async function decide<E extends RenderLike, R>(e: E, opts: RenderOptions<E, R>): Promise<{ tree: R } | null> {
  if (opts.enabled !== true || e.surface !== 'terminal') return null
  // Warm the state read on every enabled terminal render, so the answer that ends a turn finds it ready.
  try {
    opts.banner?.prime()
  } catch {
    /* no state this time */
  }
  const text = e.props.text
  if (typeof text !== 'string' || REFUSED_CONTROL.test(text)) return null
  const segments = segment(text)
  if (segments.some(s => s.source.length > SEGMENT_CAP)) return null
  const width = (e.viewport?.columns ?? DEFAULT_COLUMNS) - GUTTER
  const final = opts.banner !== undefined && width >= BANNER_MIN_WIDTH && hasCloser(text)
  if (!final && !segments.some(s => s.kind !== 'markdown')) return null
  let banner: BannerPart[] | null = null
  if (final) {
    let state: BandState | null = null
    try {
      const key = freezeKey(text)
      state = key === null ? null : await opts.banner!.forMessage(key)
    } catch {
      state = null
    }
    banner = bannerParts(width, state)
  }
  return { tree: opts.draw(segments, e, banner) }
}

/**
 * What the state read needs from the engine, as plain closures the render hook
 * builds at its own call site. The hooks loader refuses a module that stores or
 * passes `$` itself, so the engine handle never leaves the hook.
 */
export type BridgeCalls = {
  root: string
  sessionId: () => Promise<string>
  run: (argv: string[], init: { timeoutMs: number }) => Promise<{ exitCode: number; stdout: string }>
}

/**
 * The session's ISA state from the bridge, or null on any failure (no session id,
 * the child failing, timing out, printing nothing usable). One argv array, no shell,
 * killed at `BRIDGE_TIMEOUT_MS`.
 */
export async function fetchBandState(calls: BridgeCalls): Promise<BandState | null> {
  try {
    const id = await calls.sessionId()
    const run = await calls.run([...bandStateArgv(calls.root, id)], { timeoutMs: BRIDGE_TIMEOUT_MS })
    if (run.exitCode !== 0) return null
    const line = run.stdout.trim().split('\n').pop() ?? ''
    return parseBandState(line)
  } catch {
    return null
  }
}

type DrawElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Markdown' | 'Code'>

/** Trim blank lines off both ends of a markdown segment, saying whether any were there. */
function trimBlankLines(source: string): { text: string; before: boolean; after: boolean } {
  const lines = source.split('\n')
  let start = 0
  while (start < lines.length && isBlank(lines[start]!)) start++
  let end = lines.length - 1
  while (end >= start && isBlank(lines[end]!)) end--
  const text = lines.slice(start, end + 1).join('\n')
  // A source ending in "\n" splits into a final empty string that is no blank line of its own.
  const trailingEmpty = source.endsWith('\n') ? 1 : 0
  return { text, before: start > 0, after: lines.length - 1 - end - trailingEmpty > 0 }
}

/**
 * A block's tree inside the reply gutter the engine draws around its own blocks:
 * the white `⏺` on the reply's first block, two blank cells on the rest.
 */
export function drawBlock(
  segments: Segment[],
  el: DrawElements,
  columns: number,
  banner: BannerPart[] | null,
  bullet: boolean,
): RenderElement {
  const { Box, Text } = el
  return Box({
    flexDirection: 'row',
    children: [
      Box({
        width: GUTTER,
        flexShrink: 0,
        // The rule has a blank row above it; the bullet sits on the rule's row, not on that blank.
        marginTop: banner && banner.length > 0 ? 1 : 0,
        children: bullet ? [Text({ color: REPLY_BULLET_COLOR, children: REPLY_BULLET })] : [],
      }),
      Box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, children: [drawSegments(segments, el, columns, banner)] }),
    ],
  })
}

/**
 * The mod's tree for a segmented answer: a column holding the engine's own
 * `Markdown` for every markdown segment, boxed rows for each flow, a coloured
 * bold label, and a tinted bar beside each callout; a final answer gets the
 * LifeOS rule as its first row. A blank line in the source
 * between two drawn blocks becomes one row of space.
 */
export function drawSegments(
  segments: Segment[],
  el: DrawElements,
  columns: number,
  banner: BannerPart[] | null = null,
): RenderElement {
  const { Box, Text, Markdown, Code } = el
  const children: RenderElement[] = []
  if (banner && banner.length > 0) {
    children.push(
      Box({
        flexDirection: 'row',
        // One blank row above and below so the rule stands apart from the answer (principal, 2026-10-04).
        marginTop: 1,
        marginBottom: 1,
        children: banner.map(part =>
          part.role === 'name'
            ? Text({ color: BANNER_NAME_COLOR, bold: true, children: part.text })
            : part.role === 'state'
              ? Text({ color: BANNER_STATE_COLOR, children: part.text })
              : Text({ dimColor: true, children: part.text }),
        ),
      }),
    )
  }
  let gap = false
  const push = (node: RenderElement) => {
    children.push(children.length > 0 && gap ? Box({ marginTop: 1, children: [node] }) : node)
    gap = false
  }

  for (const s of segments) {
    switch (s.kind) {
      case 'markdown': {
        const { text, before, after } = trimBlankLines(s.source)
        if (before) gap = true
        if (text !== '') push(Markdown({ text }))
        if (after) gap = true
        break
      }
      case 'flow': {
        const rows = drawFlow(s.chains, Math.max(columns - GUTTER, 10))
        push(Box({ flexDirection: 'column', children: rows.map(row => Text({ wrap: 'truncate-end', children: row })) }))
        break
      }
      case 'label': {
        const label = Text({ color: s.style.color, bold: s.style.bold, children: s.label })
        push(s.rest === '' ? label : Box({ flexDirection: 'row', gap: 1, children: [label, Markdown({ text: s.rest })] }))
        break
      }
      case 'chart': {
        const rows = drawChart(s.chart, Math.max(columns - GUTTER, 10))
        if (rows.length === 0) {
          // Too narrow to draw: the fence as the engine would show it.
          push(Markdown({ text: s.source.replace(/\n$/, '') }))
          break
        }
        push(
          Box({
            flexDirection: 'column',
            children: rows.map(row =>
              Box({
                flexDirection: 'row',
                children: row.map(part => Text({ ...CHART_STYLE[part.role], wrap: 'truncate-end', children: part.text })),
              }),
            ),
          }),
        )
        break
      }
      case 'diff': {
        push(Code({ source: s.body, format: 'diff', wrap: 'wrap' }))
        break
      }
      case 'chip': {
        push(
          Box({
            flexDirection: 'column',
            children: s.items.map(item =>
              Box({
                flexDirection: 'row',
                gap: 1,
                children: [
                  Text({ color: item.color, bold: true, children: item.glyph }),
                  Box({ flexGrow: 1, flexShrink: 1, children: [Markdown({ text: item.text })] }),
                ],
              }),
            ),
          }),
        )
        break
      }
      case 'callout': {
        push(
          Box({
            flexDirection: 'row',
            children: [
              Text({ color: BAR_COLOR[s.bar], children: '▌ ' }),
              Box({ flexGrow: 1, flexShrink: 1, children: [Markdown({ text: s.body })] }),
            ],
          }),
        )
        break
      }
    }
  }
  return Box({ flexDirection: 'column', children })
}

type ComposeLike = { surfaces: readonly string[]; traits: readonly string[] }

/**
 * True only for an interactive terminal session: the terminal first among the surfaces and
 * every trait on the allowlist. Any other trait (print, bare, sdk-preset, teammate, analysis,
 * or one a later engine adds) marks a run whose output this mod never draws, because in a
 * `--print` run the drawn lines become the reply text a text or voice channel sends
 * (2026-10-22: ANSI colour codes and hard wraps reached iMessage).
 */
export function isDrawnSession(e: ComposeLike): boolean {
  return e.surfaces[0] === 'terminal' && !e.traits.some(t => !DRAWN_TRAITS.has(t))
}

/**
 * Adds the flow-diagram rule as the last, session-scoped section, only for an
 * interactive terminal session (the terminal first among the surfaces, no
 * `print` or `bare` trait) and only while the mod is enabled. Any other
 * session gets `result` back unchanged, the same object.
 */
export function composeSections<R extends PromptComposeResult>(e: ComposeLike, result: R, enabled: boolean): R {
  if (enabled !== true) return result
  if (!isDrawnSession(e)) return result
  if (result.sections.some(s => s.id === FLOW_SECTION_ID)) return result
  const section: PromptComposeSection = { id: FLOW_SECTION_ID, text: FLOW_SECTION_TEXT, scope: 'session' }
  return { ...result, sections: [...result.sections, section] }
}
