// rich-format: draws flow and chart fences, diffs, coloured labels, callout bars, VERIFY
// marks and the LifeOS rule above the closer, in the terminal. It hooks two events:
// `prompt.compose` (the section that teaches the drawable fences, terminal sessions only)
// and `classic.MessageDisplay`, which hands over each batch of finished lines while an
// answer streams and shows what the hook returns instead. That drawing is the answer's
// first and only copy, so nothing repaints. Never hook `ui.render` on AssistantMessage:
// the engine asks it only once an answer settles, and the repaint printed every answer
// twice under the statusline (2026-10-09; tests/hooked-events.check.ts holds this).
// A closed `workflow` fence draws as the run's live card from `HookBridge.ts workflow-card`
// (WORKFLOW BOARD ISA F7), fetched only for the flush that closes it.
import type { Register } from 'claude-code'

import { composeSections, fetchBandState, FLOW_SECTION_ID, isDrawnSession } from './core'
import { GUTTER, needsBand, needsWidth, newStreamState, renderLines, splitDelta, workflowRunIds, type StreamState } from './stream'
import { fetchWorkflowCards, withWorkflowFence } from './workflow'

const DEFAULT_COLUMNS = 80
const WIDTH_TTL_MS = 5000
const MAX_OPEN_MESSAGES = 32

export const register: Register = (on, options) => {
  // The load fills the manifest default (true) in, so only a stored boolean `true` draws.
  const enabled = options.enabled === true

  const states = new Map<string, StreamState>()
  let width = { columns: DEFAULT_COLUMNS, at: 0 }

  // Set by each compose; starts false so a run that never proved itself interactive stays plain.
  let drawn = false

  on('prompt.compose', async ($, e, next) => {
    drawn = isDrawnSession(e)
    return withWorkflowFence(composeSections(e, await next(e), enabled), FLOW_SECTION_ID)
  })

  on('classic.MessageDisplay', async ($, e, next) => {
    const below = await next(e)
    if (!enabled || !drawn) return below
    try {
      let state = states.get(e.message_id)
      if (!state) {
        state = newStreamState()
        states.set(e.message_id, state)
        while (states.size > MAX_OPEN_MESSAGES) states.delete(states.keys().next().value!)
      }
      const lines = splitDelta(e.delta)

      if (needsWidth(state, lines) && Date.now() - width.at > WIDTH_TTL_MS) {
        try {
          const r = await $.process.run(['/bin/stty', '-f', '/dev/tty', 'size'], { timeoutMs: 1000 })
          const cols = Number(r.stdout.trim().split(/\s+/)[1])
          if (r.exitCode === 0 && cols >= 20) width = { columns: cols, at: Date.now() }
        } catch {}
      }

      const band = needsBand(state, lines)
        ? await fetchBandState({
            root: $.plugin.root,
            sessionId: () => $.session.id(),
            run: (argv, init) => $.process.run(argv, init),
          })
        : null

      // Read before renderLines moves the state on: the workflow fences this flush closes.
      const runIds = workflowRunIds(state, lines)
      const cards =
        runIds.length > 0
          ? await fetchWorkflowCards(
              {
                root: $.plugin.root,
                sessionId: () => $.session.id(),
                run: (argv, init) => $.process.run(argv, init),
              },
              runIds,
              Math.max(width.columns - GUTTER, 20),
            )
          : undefined

      const out = renderLines(state, lines, e.final, { columns: width.columns, band, cards })
      if (e.final) states.delete(e.message_id)
      const tail = out.length > 0 && e.delta.endsWith('\n') ? '\n' : ''
      return { ...below, displayContent: out.join('\n') + tail }
    } catch {
      states.delete(e.message_id)
      return below
    }
  })
}
