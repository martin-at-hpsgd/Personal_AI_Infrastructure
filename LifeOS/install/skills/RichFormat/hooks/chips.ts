// VERIFY chips: pure logic, no engine imports.
// verifyMark('- ✓ tests pass') -> { glyph: '✓', color: 'green' }
// verifyMark('- ✗ it broke')   -> { glyph: '✗', color: 'red' }
// Anything else (no mark right after the bullet, or an indented/nested bullet) -> null.

export type VerifyMark = { glyph: '✓' | '✗'; color: 'green' | 'red' }

const BULLET_MARK = /^[-*•] (✓|✗)(?:\s|$)/u

export function verifyMark(line: string): VerifyMark | null {
  if (typeof line !== 'string') return null
  const m = BULLET_MARK.exec(line)
  if (!m) return null
  return m[1] === '✓' ? { glyph: '✓', color: 'green' } : { glyph: '✗', color: 'red' }
}
