// The answer's workflow card (WORKFLOW BOARD ISA F7). A closed `workflow` fence holding one line,
// `wf_<id> <plain summary>`, draws as that run's brief card: the lines `HookBridge.ts workflow-card`
// prints, which are board-view's brief rows for the run plus an `as of HH:mm` line. The stored text stays the
// one plain line, so text, iMessage and voice channels read the summary.
// Pure TypeScript, no engine imports. Fail-open: anything doubtful leaves the fence as written.

/** The fence info string that asks for a card. */
export const WORKFLOW_KIND = 'workflow'

/** A run id as the Workflow tool reports it. */
export const RUN_ID = /^wf_[A-Za-z0-9_-]{1,120}$/

/** The bridge child is killed after this long, and the card is given up on. */
export const CARD_TIMEOUT_MS = 3000

/** Most cards one flush asks the bridge for; a later fence in the same flush shows as written. */
export const MAX_CARDS_PER_FLUSH = 3

/** Most lines one card may draw; a longer answer from the bridge is refused whole. The brief card is at most 7 (F9). */
export const MAX_CARD_LINES = 12

export type WorkflowFence = { runId: string; summary: string }

/** The run id and summary of a workflow fence's body, or null unless it is exactly one line led by a `wf_` id. */
export function parseWorkflowFence(body: readonly string[]): WorkflowFence | null {
  const lines = body.filter(l => l.trim() !== '')
  if (lines.length !== 1) return null
  const text = lines[0]!.trim()
  const space = text.search(/\s/)
  const runId = space < 0 ? text : text.slice(0, space)
  if (!RUN_ID.test(runId)) return null
  return { runId, summary: space < 0 ? '' : text.slice(space).trim() }
}

/** The bridge command for one card, as an argv array: the mod folder sits at `<root>/skills/<Mod>`. */
export function workflowCardArgv(modRoot: string, sessionId: string, runId: string, columns: number): string[] {
  const parts = modRoot.replace(/\/+$/, '').split('/')
  const root = parts.slice(0, -2).join('/')
  return ['bun', `${root}/LIFEOS/TOOLS/HookBridge.ts`, 'workflow-card', sessionId, runId, String(Math.floor(columns))]
}

// Colour runs (SGR) pass; every other escape sequence and control character is dropped.
const ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]?/g
const SGR = /^\x1b\[[0-9;:]*m$/
const CONTROL = /[\u0000-\u0008\u000a-\u001a\u001c-\u001f\u007f-\u009f]/g

function safeLine(line: string): string {
  // Escapes first: an OSC sequence ends on BEL, which the control pass would otherwise strip out from under it.
  return line.replace(ESCAPE, seq => (SGR.test(seq) ? seq : '')).replace(CONTROL, '')
}

/** The card's lines from the bridge's last output line, or null when it is not `{lines: string[]}` with at least one line. */
export function parseCardLines(stdout: string): string[] | null {
  if (typeof stdout !== 'string') return null
  try {
    const j = JSON.parse(stdout.trim().split('\n').pop() ?? '') as unknown
    if (typeof j !== 'object' || j === null || Array.isArray(j)) return null
    const lines = (j as Record<string, unknown>).lines
    if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_CARD_LINES) return null
    if (!lines.every(l => typeof l === 'string')) return null
    return (lines as string[]).map(safeLine)
  } catch {
    return null
  }
}

/** What a card fetch needs from the engine, as closures the hook builds at its own call site. */
export type CardCalls = {
  root: string
  sessionId: () => Promise<string>
  run: (argv: string[], init: { timeoutMs: number }) => Promise<{ exitCode: number; stdout: string }>
}

type Timers = { setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?: (h: unknown) => void }

/** `p`, or null once `ms` pass first. With no timer in the host, the child's own kill bounds the wait. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  const g = globalThis as unknown as Timers
  if (typeof g.setTimeout !== 'function') return p
  return new Promise<T | null>(resolve => {
    let done = false
    const handle = g.setTimeout!(() => {
      if (done) return
      done = true
      resolve(null)
    }, ms)
    p.then(
      v => {
        if (done) return
        done = true
        g.clearTimeout?.(handle)
        resolve(v)
      },
      () => {
        if (done) return
        done = true
        g.clearTimeout?.(handle)
        resolve(null)
      },
    )
  })
}

/**
 * One run's card from the bridge, or null on any failure: no session id, the child failing, rejecting
 * (the engine rejects a child still running at its timeout), not settling within `timeoutMs`, or
 * printing anything but a non-empty `{lines}`. One argv array, no shell.
 */
export async function fetchWorkflowCard(calls: CardCalls, runId: string, columns: number, timeoutMs = CARD_TIMEOUT_MS): Promise<string[] | null> {
  try {
    if (!RUN_ID.test(runId)) return null
    // One clock covers the session id lookup and the child: the budget starts here, before either begins.
    return await within(cardFromBridge(calls, runId, columns, timeoutMs), timeoutMs + 250)
  } catch {
    return null
  }
}

async function cardFromBridge(calls: CardCalls, runId: string, columns: number, timeoutMs: number): Promise<string[] | null> {
  const id = await calls.sessionId()
  if (typeof id !== 'string' || id === '') return null
  const run = await calls.run(workflowCardArgv(calls.root, id, runId, columns), { timeoutMs })
  if (run.exitCode !== 0) return null
  return parseCardLines(run.stdout)
}

/** The cards for these run ids, fetched side by side; a run whose fetch failed is absent from the map. */
export async function fetchWorkflowCards(calls: CardCalls, runIds: readonly string[], columns: number, timeoutMs = CARD_TIMEOUT_MS): Promise<Map<string, string[]>> {
  const ids = [...new Set(runIds)].slice(0, MAX_CARDS_PER_FLUSH)
  const got = await Promise.all(ids.map(async id => [id, await fetchWorkflowCard(calls, id, columns, timeoutMs)] as const))
  const out = new Map<string, string[]>()
  for (const [id, lines] of got) if (lines) out.set(id, lines)
  return out
}

// ---------------------------------------------------------------- the prompt

export const WORKFLOW_EXAMPLE = 'wf_8c2d41 Development Modify T4: 9 of 11 lanes done, F7 verifying, 120/147 criteria ticked'

export const WORKFLOW_FENCE_TEXT = [
  'This terminal also draws a compact workflow card. When a final answer reports on a workflow run launched in this session, put a fenced code block whose info string is `workflow` holding one line: the run id (`wf_…`, exactly as the Workflow tool result gave it), a space, then a plain summary of where the run stands. The terminal swaps the block for a short coloured card (the run, its agent counts and ISA progress, any lane that needs attention, and one count of the rest) drawn from the run\'s own data. The stored text stays the one plain line, which is what text, iMessage and voice channels read.',
  '',
  '- The card opens the answer: directly under the `◆` line, above the 🎯 line, so where the run stands is the first thing read (principal, 2026-10-11).',
  '- One line per block and one block per run you report on; never type the tree yourself.',
  '- Final answers only: an interim note between tool calls carries no card, and no answer lists lanes or agents the card already shows.',
  '- Use only a run id a tool gave you; an unknown or mistyped id shows the line as plain code.',
  '- The summary is plain words a reader understands without the drawing.',
  '',
  'Example:',
  '',
  '```' + WORKFLOW_KIND,
  WORKFLOW_EXAMPLE,
  '```',
].join('\n')

type Section = { id: string; text: string }

/**
 * Adds the workflow-fence teaching to the drawable-conventions section `sectionId`. Only a result that
 * already carries that section changes, so the section's own gating (terminal session, mod enabled)
 * decides; anything else, or a section that already teaches the fence, comes back as the same object.
 */
export function withWorkflowFence<R extends { sections: readonly Section[] }>(result: R, sectionId: string): R {
  const at = result.sections.findIndex(s => s.id === sectionId)
  if (at < 0) return result
  const section = result.sections[at]!
  if (section.text.includes(WORKFLOW_FENCE_TEXT)) return result
  const sections = result.sections.map((s, i) => (i === at ? { ...s, text: `${s.text}\n\n${WORKFLOW_FENCE_TEXT}` } : s))
  return { ...result, sections }
}
