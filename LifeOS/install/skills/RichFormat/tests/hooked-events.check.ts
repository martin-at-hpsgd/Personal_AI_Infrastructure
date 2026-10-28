// ISC-20: the mod hooks exactly prompt.compose and classic.MessageDisplay, and never ui.render:
// a ui.render hook on a finished answer printed every answer twice (2026-10-09). Exit 0 on equality, 1 otherwise.
// Run from the mod folder: `bun ./tests/hooked-events.check.ts`.

const EXPECTED = ['classic.MessageDisplay', 'prompt.compose']
const TIMEOUT_MS = 60_000

const dir = new URL('..', import.meta.url).pathname
const proc = Bun.spawn(['claude', 'plugin', 'validate', '--json', dir], {
  stdout: 'pipe',
  stderr: 'pipe',
  timeout: TIMEOUT_MS,
})
const [stdout, stderr, code] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
])

function fail(message: string): never {
  console.error(`hooked-events: ${message}`)
  if (stdout) console.error(`stdout:\n${stdout}`)
  if (stderr) console.error(`stderr:\n${stderr}`)
  process.exit(1)
}

if (code !== 0) fail(`validate exited ${code}`)

let report: unknown
try {
  report = JSON.parse(stdout)
} catch {
  fail('validate --json printed no JSON')
}

type Content = { notes?: unknown }
type Report = { success?: unknown; contents?: unknown }

/** The events one module note names: `<module> hooks: a, b{matcher}, ...`, matchers dropped. */
function eventsOf(note: string): string[] | null {
  const m = /^\S+ hooks: (.+)$/.exec(note)
  if (!m) return null
  const names: string[] = []
  let depth = 0
  let current = ""
  for (const ch of m[1]!) {
    if (ch === "{") depth += 1
    else if (ch === "}") depth -= 1
    else if (ch === "," && depth === 0) {
      names.push(current.trim())
      current = ""
      continue
    }
    if (depth === 0 && ch !== "}") current += ch
  }
  names.push(current.trim())
  return names.filter(n => n !== "")
}

const r = report as Report
if (r.success !== true) fail("validate reported success other than true")
if (!Array.isArray(r.contents)) fail("validate reported no contents list")
const hooked: string[] = []
let modules = 0
for (const c of r.contents as Content[]) {
  if (!Array.isArray(c.notes)) continue
  for (const note of c.notes) {
    if (typeof note !== "string") continue
    const events = eventsOf(note)
    if (!events) continue
    modules += 1
    hooked.push(...events.filter(e => e !== "nothing"))
  }
}
if (modules === 0) fail("no module hooks note in the report")

const got = [...new Set(hooked)].sort()
const expected = [...EXPECTED].sort()
if (JSON.stringify(got) !== JSON.stringify(expected)) {
  fail(`hooked ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`)
}
console.log(`hooked-events: ${JSON.stringify(got)} across ${modules} module(s)`)
