import { randomBytes } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Guards shared by the dashboard's two write routes (upload, file/save). Both
// write personal TELOS files from a request the browser sends to a local dev
// server, so a request has to prove it came from the dashboard's own page and
// a client-supplied name has to stay inside the TELOS directory.

const lexists = (p: string): boolean => { try { fs.lstatSync(p); return true } catch { return false } }
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

type HeaderSource = { get(name: string): string | null }

/**
 * Why this request may not write, or null when it may. A page on any other
 * origin can POST a multipart form or a text/plain JSON body to localhost
 * without a CORS preflight, and the browser always labels that request with
 * its Origin. So: an Origin that is not this server's own is refused; a
 * Sec-Fetch-Site of cross-site or same-site (another port on localhost is
 * same-site) is refused; and the Host has to be a loopback name, which stops
 * a DNS-rebinding page that arrives under its own hostname. A request with
 * neither header is a command-line client, not a browser, and passes.
 * TELOS_DASHBOARD_ALLOWED_HOSTS (comma separated host:port) extends the host list.
 */
export function crossOriginRefusal(headers: HeaderSource, env: NodeJS.ProcessEnv = process.env): string | null {
  const host = (headers.get('host') ?? '').toLowerCase()
  const hostname = host.replace(/:\d+$/, '')
  const extra = (env.TELOS_DASHBOARD_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  if (!host || (!LOOPBACK.has(hostname) && !extra.includes(host))) return `host "${host}" is not a loopback address`

  const site = headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return `request is ${site}, not same-origin`

  const origin = headers.get('origin')
  if (origin !== null) {
    let parsed: URL
    try { parsed = new URL(origin) } catch { return `origin "${origin}" is not a URL` }
    if (parsed.host.toLowerCase() !== host) return `origin ${parsed.host} does not match ${host}`
  }
  return null
}

/**
 * Resolve `name` under `baseDir`, or throw. `name` is a client-supplied path
 * (a file name, or `data/x.csv`): it must be relative, and both the target and
 * its deepest existing ancestor have to dereference to somewhere inside the
 * real baseDir. The lexical test alone is bypassable through a symlinked
 * component, and TELOS_DIR itself sits behind one on a normal install.
 */
export function confinedPath(baseDir: string, name: string): string {
  if (typeof name !== 'string' || name === '' || name.includes('\0') || path.isAbsolute(name)) {
    throw new Error('Invalid filename')
  }
  const realBase = fs.realpathSync(baseDir)
  const target = path.resolve(realBase, name)
  if (target === realBase || !target.startsWith(realBase + path.sep)) throw new Error('Invalid filename')
  let probe = target
  // lstat, not exists: a dangling symlink "does not exist" to exists but is still a link a write would follow.
  while (!lexists(probe)) {
    const up = path.dirname(probe)
    if (up === probe) break
    probe = up
  }
  let realProbe: string
  try { realProbe = fs.realpathSync(probe) } catch { throw new Error("Invalid filename") }
  if (realProbe !== realBase && !realProbe.startsWith(realBase + path.sep)) throw new Error('Invalid filename')
  return target
}

// The header UpdateTelos writes when it creates the changelog on a fresh install.
const UPDATES_HEADER = '# TELOS Updates\n\nChangelog of TELOS file updates, newest first.\n'

/**
 * Append a dashboard change record to the TELOS changelog in baseDir the way
 * UpdateTelos keeps it: `updates.md` (or an existing `Updates.md`, so a
 * case-sensitive filesystem never forks the log), created with the same header
 * when absent, and written under the shared TELOS lock so a concurrent
 * UpdateTelos read-modify-write cannot drop the line. A busy lock is retried
 * for up to `waitMs`. A changelog that resolves outside the real baseDir (a
 * symlink out of the directory) is skipped, never followed. Returns whether
 * the line landed; a log failure never fails the write it describes, so the
 * caller reports it instead.
 */
export function appendUpdateLog(baseDir: string, message: string, waitMs = 2000): boolean {
  try {
    const name = !lexists(path.join(baseDir, 'updates.md')) && lexists(path.join(baseDir, 'Updates.md')) ? 'Updates.md' : 'updates.md'
    let target = confinedPath(baseDir, name)
    if (lexists(target)) target = fs.realpathSync(target)
    const deadline = Date.now() + waitMs
    for (;;) {
      const locked = withTelosLock(target, () => {
        if (!lexists(target)) fs.writeFileSync(target, UPDATES_HEADER, { encoding: 'utf-8', flag: 'wx' })
        fs.appendFileSync(target, message)
      })
      if (locked.ran) return true
      if (Date.now() >= deadline) return false
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  } catch {
    return false
  }
}

// The save route overwrites personal TELOS files, so it keeps the same three
// promises the Update intent's tool does (skills/Telos/SKILL.md § Ideal State):
// a backup before the write, no change to a machine-owned AUTOMATED region,
// and the shared per-file TELOS lock held across the read and the write.

const REGION_RE = /^<!--\s*AUTOMATED:BEGIN\s+([A-Za-z0-9_-]+)\s*-->\s*$[\s\S]*?^<!--\s*AUTOMATED:END\s+\1\s*-->\s*$/gm

/**
 * Names of the AUTOMATED regions whose bytes differ between `before` and
 * `after`; a region added or removed counts as changed. Those regions are
 * rewritten only by UpdateTelos `--region`, never by a hand edit.
 */
export function changedAutomatedRegions(before: string, after: string): string[] {
  const regions = (text: string) => {
    const out = new Map<string, string>()
    for (const m of text.matchAll(REGION_RE)) out.set(m[1], (out.get(m[1]) ?? '') + m[0])
    return out
  }
  const a = regions(before)
  const b = regions(after)
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort()
}

/**
 * Run `fn` holding the shared TELOS lock for `realTarget`: the `.<name>.lock`
 * file beside it that LIFEOS/TOOLS/TelosLock.ts defines, taken with an
 * exclusive create and released only while it still carries our token. When
 * another writer holds it, `fn` does not run and the lock path is returned so
 * the caller can refuse; a lock left by a dead writer is cleared by the next
 * TelosLock writer, or by hand.
 */
export function withTelosLock<T>(realTarget: string, fn: () => T): { ran: true; value: T } | { ran: false; lockPath: string } {
  const lockPath = path.join(path.dirname(realTarget), `.${path.basename(realTarget)}.lock`)
  const token = randomBytes(16).toString('hex')
  let fd: number
  try {
    fd = fs.openSync(lockPath, 'wx', 0o644)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return { ran: false, lockPath }
    throw e
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), acquired: Date.now(), token }))
  } finally {
    fs.closeSync(fd)
  }
  try {
    return { ran: true, value: fn() }
  } finally {
    try {
      if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).token === token) fs.unlinkSync(lockPath)
    } catch { /* already gone or replaced: not ours to remove */ }
  }
}

/**
 * Copy `realTarget` into `<baseDir>/Backups/` as `<name>.dashboard-<stamp><ext>`
 * before it is overwritten, and keep the newest `keep` of that file's dashboard
 * backups. The prefix is distinct from UpdateTelos's (`<name>-`, `TELOS.region-`),
 * so neither tool prunes the other's backups. Throws when the backup cannot be
 * taken; the caller then writes nothing. Returns the backup's file name.
 */
export function backupBeforeSave(baseDir: string, realTarget: string, now: Date = new Date(), keep = 3): string {
  const dir = confinedPath(baseDir, 'Backups')
  fs.mkdirSync(dir, { recursive: true })
  const ext = path.extname(realTarget)
  const prefix = `${path.basename(realTarget, ext)}.dashboard-`
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  let name = `${prefix}${stamp}${ext}`
  for (let n = 2; lexists(path.join(dir, name)); n++) name = `${prefix}${stamp}-${n}${ext}`
  fs.copyFileSync(realTarget, path.join(dir, name), fs.constants.COPYFILE_EXCL)
  const stale = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(ext)).sort().slice(0, -keep)
  if (stale.includes(name)) throw new Error(`prune would remove the backup just taken: ${name}`)
  for (const f of stale) fs.rmSync(path.join(dir, f))
  return name
}
