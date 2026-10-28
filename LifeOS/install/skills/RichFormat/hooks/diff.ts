// Diff recognition: pure logic, no engine imports.
// isUnifiedDiff(body) -> true only for a body the engine's unified-diff parser accepts.
// The engine reads `format: 'diff'` with jsdiff's parsePatch, then refuses a body with no
// hunk or with any hunk number outside [0, 1e9]. This file mirrors that grammar, always a
// little stricter, never looser:
//   - before the first hunk, only known git/unified header lines may precede it;
//   - between hunks, only the lines parsePatch itself breaks on may appear
//     (`diff `, `Index: `, `====`, `--- `, `+++ `), plus, after a `diff `/`Index:`/`====`
//     line, git metadata lines up to the next `---`/`+++`/`@@` line;
//   - each hunk holds exactly b old lines (space or `-`) and d new lines (space or `+`);
//     a `\` line counts toward neither;
//   - the four header numbers, after parsePatch's "empty side starts one higher" quirk,
//     are at most 1e9.
// Anything else is rejected so the caller leaves the fence to the markdown renderer.

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
// lines parsePatch ends a hunk run on and starts a new file section with
const SECTION_BREAK =
  /^(Index:\s|diff\s|---\s|\+\+\+\s|===================================================================)/
// lines that end parsePatch's metadata skip
const METADATA_END = /^(---|\+\+\+|@@)\s/
const FILE_HEADER_LINE = /^(---|\+\+\+)\s+/
// metadata lines this mod tolerates while that skip is running
const METADATA_LINE =
  /^(diff |Index: |=====|index |old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files )/
const MAX_NUMBER = 1e9

function inRange(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_NUMBER
}

export function isUnifiedDiff(body: string): boolean {
  if (typeof body !== 'string' || body === '') return false

  const lines = body.split('\n')
  // a final newline leaves one empty trailing element; nothing else may be empty
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return false

  const n = lines.length
  let i = 0
  let hunks = 0

  while (i < n) {
    // metadata skip, as parsePatch's parseIndex
    while (i < n && !METADATA_END.test(lines[i]!)) {
      if (!METADATA_LINE.test(lines[i]!)) return false
      i++
    }
    // up to two `---` / `+++` file header lines
    for (let k = 0; k < 2; k++) {
      if (i < n && FILE_HEADER_LINE.test(lines[i]!)) i++
    }
    // hunks, until the next file section
    while (i < n) {
      const line = lines[i]!
      if (SECTION_BREAK.test(line)) break
      const m = HUNK_HEADER.exec(line)
      if (!m) return false

      const oldCount = m[2] === undefined ? 1 : Number(m[2])
      const newCount = m[4] === undefined ? 1 : Number(m[4])
      const oldStart = Number(m[1]) + (oldCount === 0 ? 1 : 0)
      const newStart = Number(m[3]) + (newCount === 0 ? 1 : 0)
      if (!inRange(oldStart) || !inRange(newStart) || !inRange(oldCount) || !inRange(newCount)) return false

      let oldLeft = oldCount
      let newLeft = newCount
      i++
      while (i < n && (oldLeft > 0 || newLeft > 0)) {
        const c = lines[i]![0]
        if (c === ' ') {
          if (oldLeft === 0 || newLeft === 0) return false
          oldLeft--
          newLeft--
        } else if (c === '-') {
          if (oldLeft === 0) return false
          oldLeft--
        } else if (c === '+') {
          if (newLeft === 0) return false
          newLeft--
        } else if (c === '\\') {
          // no-newline marker: counts toward neither side
        } else {
          return false
        }
        i++
      }
      if (oldLeft !== 0 || newLeft !== 0) return false
      // a no-newline marker may close the hunk
      while (i < n && lines[i]![0] === '\\') i++
      hunks++
    }
  }
  return hunks > 0
}
