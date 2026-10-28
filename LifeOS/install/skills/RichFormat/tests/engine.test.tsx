// The mod loaded by the engine's own host: `classic.MessageDisplay` streamed flush by
// flush, and `prompt.compose`. Run with `claude plugin test .`.
import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

const FENCE = '```'
const FLOW_SECTION_ID = 'rich-format:flow'
const FACTS = { model: 'test-model', promptModel: 'test-model', tools: [] as string[], outputStyle: null }
const BASE_SECTION = { id: 'intro', text: 'base', scope: 'shared' as const }
const strip = (s: string): string => s.replace(/\x1b\[[0-9;:]*m/g, '')

/** The test's bottom of the classic chain: no settings hook changes the display. */
function engineDisplay(on: On): void {
  on('classic.MessageDisplay', () => ({}))
}

function engineCompose(on: On): void {
  on('prompt.compose', () => ({ sections: [BASE_SECTION] }))
}

/** Compose as an interactive terminal session, the only kind this mod draws in. */
async function interactive($: { prompt: { compose: (e: unknown) => Promise<unknown> } }, on: On): Promise<void> {
  engineCompose(on)
  engineDisplay(on)
  await $.prompt.compose({ ...FACTS, surfaces: ['terminal'], traits: [] })
}

const flush = (message_id: string, index: number, delta: string, final: boolean) => ({
  turn_id: 't1',
  message_id,
  index,
  delta,
  final,
})

describe('engine', () => {
  test('a flow fence split across two flushes is held, then drawn as boxes', async ($, on) => {
    await interactive($, on)
    const first = await $.classic.MessageDisplay(flush('m1', 0, `Before\n${FENCE}flow\na -> b\n`, false))
    expect(strip(first.displayContent ?? '')).toBe('Before\n')
    const second = await $.classic.MessageDisplay(flush('m1', 1, `${FENCE}\nAfter`, true))
    const text = strip(second.displayContent ?? '')
    expect(text).toContain('│ a │')
    expect(text).not.toContain(FENCE)
    expect(text.endsWith('After')).toBe(true)
  })

  test('VERIFY marks are coloured and the closer gets the LifeOS rule', async ($, on) => {
    await interactive($, on)
    const out = await $.classic.MessageDisplay(
      flush('m2', 0, '✅ VERIFY:\n\n- ✓ Tests pass.\n\n🗣️ Ada: Done.', true),
    )
    const shown = out.displayContent ?? ''
    expect(shown).toContain('\x1b[32m✓')
    expect(strip(shown)).toContain('◆ LifeOS')
    // One invisible spacer line follows the closer, so the turn timer is not flush under it.
    // The closer's emoji is drawn as its Nerd Font glyph (hooks/glyph-core.ts), as in stream.spec.ts.
    expect(strip(shown).trimEnd().endsWith('  Ada: Done.')).toBe(true)
    expect(shown.endsWith('\n\x1b[39m')).toBe(true)
  })

  test('with the option off the display is left alone', { options: { enabled: false } }, async ($, on) => {
    await interactive($, on)
    const out = await $.classic.MessageDisplay(flush('m3', 0, '✅ VERIFY:\n', true))
    expect(out.displayContent).toBeUndefined()
  })

  test('compose in an interactive terminal session adds the flow section', async ($, on) => {
    engineCompose(on)
    const out = await $.prompt.compose({ ...FACTS, surfaces: ['terminal'], traits: [] })
    expect(out.sections.map(s => s.id)).toEqual(['intro', FLOW_SECTION_ID])
  })

  test('compose in a headless session adds nothing', async ($, on) => {
    engineCompose(on)
    const out = await $.prompt.compose({ ...FACTS, surfaces: [], traits: ['print'] })
    expect(out.sections.map(s => s.id)).toEqual(['intro'])
  })

  test('a --print run is never drawn, so text and voice channels get the plain reply', async ($, on) => {
    engineCompose(on)
    engineDisplay(on)
    await $.prompt.compose({ ...FACTS, surfaces: [], traits: ['print'] })
    const out = await $.classic.MessageDisplay(flush('m5', 0, '- **Bold** bullet\n\n✅ VERIFY:\n\n- ✓ Tests pass.', true))
    expect(out.displayContent).toBeUndefined()
  })

  test('ISC-234 a table answer draws a framed grid', async ($, on) => {
    await interactive($, on)
    const out = await $.classic.MessageDisplay(flush('m4', 0, '| Model | Score |\n|---|---:|\n| Opus | 412 |\n\nDone.', true))
    const text = strip(out.displayContent ?? '')
    expect(text).toContain('╭')
    expect(text).not.toContain('|---')
    expect(text.endsWith('Done.')).toBe(true)
  })
})
