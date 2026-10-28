// The LifeOS banner: closer detection, the drawn rule, band-state parsing and the frozen state source.
// Pure TypeScript, no engine imports. Fail-open: anything doubtful yields null or the bare rule.

/** The session's ISA as the rule shows it. Both fields are already sanitized. */
export type BandState = { slug: string; progress: string }

/** One run of the rule. `name` is `◆ LifeOS`, `rule` the dashes and spaces, `state` the slug and progress. */
export type BannerPart = { role: 'rule' | 'name' | 'state'; text: string }

// ---------------------------------------------------------------- closer

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
// 🗣 (U+1F5E3), optionally followed by variation selector 16, then a name and a colon.
const CLOSER = /^🗣️?[ \t]*[^\s:][^:]*:/u

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/** Index of the closer line when the text is a final answer, else -1. */
function closerIndex(text: string): number {
  if (typeof text !== 'string') return -1
  const lines = splitLines(text)
  let fence: { ch: string; len: number } | null = null
  let last = -1
  let lastInFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const m = FENCE_OPEN.exec(line)
    if (fence) {
      // A closing fence uses the same character, is at least as long, and carries nothing else.
      if (m && (m[1] as string)[0] === fence.ch && (m[1] as string).length >= fence.len && line.trim() === m[1]) fence = null
      if (line.trim() !== '') {
        last = i
        lastInFence = true
      }
      continue
    }
    if (m) {
      fence = { ch: (m[1] as string)[0] as string, len: (m[1] as string).length }
      last = i
      lastInFence = true
      continue
    }
    if (line.trim() !== '') {
      last = i
      lastInFence = false
    }
  }
  if (last < 0 || lastInFence) return -1
  return CLOSER.test(lines[last] as string) ? last : -1
}

/** True when this one line is a `🗣️ Name:` closer. */
export function isCloserLine(line: string): boolean {
  return typeof line === 'string' && CLOSER.test(line)
}

/** True when the last non-blank line, outside any code fence, is a `🗣️ Name:` closer. */
export function hasCloser(text: string): boolean {
  return closerIndex(text) >= 0
}

/** The block text before the closer line, or null when there is no closer. The growing closer never changes it. */
export function freezeKey(text: string): string | null {
  const i = closerIndex(text)
  if (i < 0) return null
  const lines = splitLines(text)
  return lines.slice(0, i).join('\n') + '\n'
}

// ---------------------------------------------------------------- width

const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u

function charWidth(ch: string): number {
  if (ZERO_WIDTH.test(ch)) return 0
  const cp = ch.codePointAt(0) as number
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return 2
  return 1
}

/** Display cells of a string: wide East Asian characters take two, combining marks none. */
export function textWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

// ---------------------------------------------------------------- sanitizing

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g
const UNSAFE = /[\p{C}\p{Zl}\p{Zp}\p{Extended_Pictographic}]/gu
const DATE_PREFIX = /^\d{8}-\d{6}_/

/** Strip ANSI sequences, control, format and pictographic characters; collapse whitespace; drop leading marks. */
export function sanitizeText(s: string): string {
  if (typeof s !== 'string') return ''
  return s
    .replace(ANSI, '')
    .replace(UNSAFE, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[\p{M}]+/u, '')
}

function readableSlug(slug: string): string {
  const rest = slug.replace(DATE_PREFIX, '')
  return rest === '' ? slug : rest
}

// ---------------------------------------------------------------- the rule

const LEFT = '━━ '
const NAME = '◆ LifeOS'
const MIN_FILL = 2
const MAX_PROGRESS_CELLS = 12

function truncate(s: string, cells: number): string {
  if (textWidth(s) <= cells) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = charWidth(ch)
    if (w + cw > cells - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

/**
 * The rule as parts that join to exactly `width` cells:
 * `━━ ◆ LifeOS ━━━…━━ <slug> <progress> ━━`, LifeOS at the far left, the state at the right.
 * With no state, or when the state cannot fit, the name is followed by dashes alone.
 * Below the name's own width the rule is dashes only; width 0 or less draws nothing.
 */
export function bannerParts(width: number, state: BandState | null): BannerPart[] {
  const w = Math.floor(width)
  if (!(w > 0)) return []
  const head = LEFT.length + NAME.length + 1 // `━━ ◆ LifeOS `
  if (w < head + MIN_FILL) return [{ role: 'rule', text: '━'.repeat(w) }]

  const bare = (): BannerPart[] => [
    { role: 'rule', text: LEFT },
    { role: 'name', text: NAME },
    { role: 'rule', text: ' ' + '━'.repeat(w - head + 1 - 1) },
  ]

  if (!state) return bare()
  const progress = sanitizeText(state.progress)
  if (progress === '' || textWidth(progress) > MAX_PROGRESS_CELLS) return bare()
  const slug = readableSlug(sanitizeText(state.slug))

  // Fixed cells around the state: head, the fill, one space, the state, ` ━━`.
  const tail = 3
  const progressW = textWidth(progress)
  const fixedNoSlug = head + MIN_FILL + 1 + progressW + tail
  if (fixedNoSlug > w) return bare()

  let shown = ''
  // The slug plus its separating space may take whatever the minimum layout leaves.
  const slugBudget = w - fixedNoSlug - 1
  if (slug !== '' && slugBudget >= 2) shown = truncate(slug, slugBudget)

  const stateText = shown === '' ? progress : `${shown} ${progress}`
  const fill = w - head - 1 - textWidth(stateText) - tail
  return [
    { role: 'rule', text: LEFT },
    { role: 'name', text: NAME },
    { role: 'rule', text: ' ' + '━'.repeat(fill) + ' ' },
    { role: 'state', text: stateText },
    { role: 'rule', text: ' ━━' },
  ]
}

// ---------------------------------------------------------------- band state

/** The state from one `HookBridge.ts band-state` output line, or null when there is none to show. */
export function parseBandState(line: string): BandState | null {
  if (typeof line !== 'string') return null
  try {
    const j = JSON.parse(line.trim()) as unknown
    if (typeof j !== 'object' || j === null || Array.isArray(j)) return null
    const o = j as Record<string, unknown>
    if (o.ok !== true) return null
    const isa = o.isa
    if (typeof isa !== 'object' || isa === null || Array.isArray(isa)) return null
    const { slug, progress } = isa as Record<string, unknown>
    if (typeof slug !== 'string' || typeof progress !== 'string') return null
    const s = sanitizeText(slug)
    const p = sanitizeText(progress)
    if (s === '' || p === '') return null
    return { slug: s, progress: p }
  } catch {
    return null
  }
}

/** The bridge command for one session, as an argv array: the mod folder sits at `<root>/skills/<Mod>`. */
export function bandStateArgv(modRoot: string, sessionId: string): string[] {
  const parts = modRoot.replace(/\/+$/, '').split('/')
  const root = parts.slice(0, -2).join('/')
  return ['bun', `${root}/LIFEOS/TOOLS/HookBridge.ts`, 'band-state', sessionId]
}

// ---------------------------------------------------------------- the state source

export type BannerSourceOptions = {
  /** Fetches the current state; may reject or never settle. */
  fetch: () => Promise<BandState | null>
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /** Least time between two fetch starts. */
  throttleMs?: number
  /** Longest a message waits for a running fetch. */
  giveUpMs?: number
  /** Most frozen keys held; the oldest go first. */
  maxKeys?: number
}

export type BannerSource = {
  /** Start a fetch unless one started within the throttle window. Never throws. */
  prime(): void
  /** The state frozen for this key: the first answer given for a key is the answer forever after. */
  forMessage(key: string): Promise<BandState | null>
  frozenCount(): number
}

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export function createBannerSource(opts: BannerSourceOptions): BannerSource {
  const g = globalThis as unknown as Timers
  const now = opts.now ?? (() => Date.now())
  const setT = opts.setTimeout ?? ((fn, ms) => g.setTimeout(fn, ms))
  const clearT = opts.clearTimeout ?? ((h) => g.clearTimeout(h))
  const throttleMs = opts.throttleMs ?? 5000
  const giveUpMs = opts.giveUpMs ?? 300
  const maxKeys = opts.maxKeys ?? 256

  let lastStart = Number.NEGATIVE_INFINITY
  let generation = 0
  let latest: BandState | null = null
  let inflight: Promise<void> | null = null
  const frozen = new Map<string, Promise<BandState | null>>()

  function prime(): void {
    try {
      const t = now()
      if (t - lastStart < throttleMs) return
      lastStart = t
      const mine = ++generation
      let p: Promise<BandState | null>
      try {
        p = Promise.resolve(opts.fetch())
      } catch {
        p = Promise.resolve(null)
      }
      const run: Promise<void> = p
        .then(
          (s) => s,
          () => null,
        )
        .then((s) => {
          if (mine === generation) latest = s
          if (inflight === run && mine === generation) inflight = null
        })
      inflight = run
    } catch {
      /* fail open: no state this time */
    }
  }

  function decide(): Promise<BandState | null> {
    const running = inflight
    if (!running) return Promise.resolve(latest)
    return new Promise<BandState | null>((resolve) => {
      let done = false
      let handle: unknown
      const finish = (s: BandState | null): void => {
        if (done) return
        done = true
        if (handle !== undefined) clearT(handle)
        resolve(s)
      }
      handle = setT(() => finish(null), giveUpMs)
      void running.then(() => finish(latest))
    })
  }

  function forMessage(key: string): Promise<BandState | null> {
    const held = frozen.get(key)
    if (held) return held
    let p: Promise<BandState | null>
    try {
      p = decide()
    } catch {
      p = Promise.resolve(null)
    }
    frozen.set(key, p)
    while (frozen.size > maxKeys) {
      const oldest = frozen.keys().next().value
      if (oldest === undefined) break
      frozen.delete(oldest)
    }
    return p
  }

  return { prime, forMessage, frozenCount: () => frozen.size }
}
