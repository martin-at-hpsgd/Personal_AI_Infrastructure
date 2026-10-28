/**
 * Bounded JSONL readers for the Pulse daemon.
 *
 * Born 2026-09-04 from the Pulse "memory leak" investigation: the Performance
 * tab polled /api/performance/failures every 30s and each call read the whole
 * 195 MB tool-activity.jsonl into one string, split it, and parsed every line
 * to keep the last 7 days. Physical footprint peaked at 2.6 GB and JSC kept
 * 4.9 GB of freed pages mapped, which RSS reported as a 6 GB process.
 *
 * Three readers, one rule: never hold a whole large file as one string per
 * request.
 *   readJsonlTail    — last N rows, byte-bounded from the end.
 *   readJsonlSince   — rows newer than a cutoff from an append-only log,
 *                      walking chunks backward from the end; the parsed window
 *                      is cached per path and extended by reading only the
 *                      appended bytes on the next call.
 *   readJsonlCached  — whole file parsed once per (size, mtime) for files a
 *                      caller genuinely needs entire (all-time totals) and
 *                      that are rewritten, not appended, so no window applies.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs"

type Row = Record<string, any>

/** Timestamp of a row in ms, or NaN. Parsed, never compared lexically: the
 * activity log stamps `-07:00` offsets while cutoffs are Z-form. */
export function rowTimeMs(r: Row, field?: string): number {
  const v = field ? r[field] : (r.timestamp ?? r.ts ?? r.lastTimestamp ?? r.firstTimestamp)
  return typeof v === "string" ? Date.parse(v) : NaN
}

function parseLines(text: string): Row[] {
  const out: Row[] = []
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* torn or corrupt line */ }
  }
  return out
}

function readRange(fd: number, start: number, end: number): string {
  const buf = Buffer.alloc(end - start)
  let off = 0
  while (off < buf.length) {
    const n = readSync(fd, buf, off, buf.length - off, start + off)
    if (n <= 0) break
    off += n
  }
  return buf.subarray(0, off).toString("utf-8")
}

/** Last `lastN` rows of a JSONL file, reading at most `lastN * bytesPerLine`
 * (min 1 MB) from the end. The first, possibly torn, line is dropped when the
 * read did not start at byte 0. */
export function readJsonlTail(path: string, lastN: number, bytesPerLine = 4096): Row[] {
  try {
    if (!existsSync(path)) return []
    const size = statSync(path).size
    const start = Math.max(0, size - Math.max(1024 * 1024, lastN * bytesPerLine))
    const fd = openSync(path, "r")
    let text: string
    try { text = readRange(fd, start, size) } finally { closeSync(fd) }
    if (start > 0) {
      const nl = text.indexOf("\n")
      text = nl === -1 ? "" : text.slice(nl + 1)
    }
    return parseLines(text).slice(-lastN)
  } catch {
    return []
  }
}

interface Window {
  size: number; mtimeMs: number; oldestMs: number; rows: Row[]; complete: boolean
  // File identity: an append keeps the inode, the stat size only grows, and the
  // head bytes never change. A rotated or rewritten log fails one of these.
  ino: number; statSize: number; headLen: number; head: string
}
const windows = new Map<string, Window>()
const CHUNK = 4 * 1024 * 1024
const HEAD = 1024

function readHead(path: string, len: number): string {
  const fd = openSync(path, "r")
  try { return readRange(fd, 0, len) } finally { closeSync(fd) }
}

/** Rows with time >= cutoffMs from an append-only, roughly chronological log.
 * Walks `CHUNK`-sized pieces backward from the end and stops once a whole
 * chunk is older than the cutoff (single stragglers do not stop the walk).
 * The parsed window is cached per path; a later call with the file grown
 * reads only the appended bytes, a call with the file shrunk, rotated or
 * rewritten (new inode, changed head bytes, or same size with a new mtime)
 * starts over. Rows older than the cutoff are dropped once they outnumber the
 * live ones, so a long-running daemon holds at most about twice the window. */
export function readJsonlSince(path: string, cutoffMs: number, field?: string): Row[] {
  try {
    if (!existsSync(path)) return []
    const st = statSync(path)
    const cached = windows.get(path)
    let win: Window
    const sameFile = cached !== undefined && st.ino === cached.ino && st.size >= cached.statSize
      && !(st.size === cached.statSize && st.mtimeMs !== cached.mtimeMs)
      && readHead(path, cached.headLen) === cached.head
    if (cached && sameFile && (cached.complete || cached.oldestMs <= cutoffMs)) {
      win = cached
      if (st.size > cached.size) {
        const fd = openSync(path, "r")
        let text: string
        try { text = readRange(fd, cached.size, st.size) } finally { closeSync(fd) }
        // The cached boundary always sits on a line end (see below), so the
        // appended text starts a fresh line. A torn final line stays torn until
        // the writer finishes it; parseLines drops it and the next call re-reads
        // it because the boundary is set at the last complete newline.
        const lastNl = text.lastIndexOf("\n")
        const complete = lastNl === -1 ? "" : text.slice(0, lastNl + 1)
        win.rows.push(...parseLines(complete))
        win.size = cached.size + Buffer.byteLength(complete, "utf-8")
      }
      win.mtimeMs = st.mtimeMs
      win.statSize = st.size
    } else {
      win = walkBackward(path, st.size, cutoffMs, field)
      win.mtimeMs = st.mtimeMs
      win.ino = st.ino
      win.statSize = st.size
      win.headLen = Math.min(win.size, HEAD)
      win.head = readHead(path, win.headLen)
      windows.set(path, win)
    }
    const live = win.rows.filter((r) => rowTimeMs(r, field) >= cutoffMs)
    if (live.length * 2 < win.rows.length) {
      // Evict the stale prefix. The window now covers exactly [cutoffMs, end],
      // so a later call with a wider cutoff re-walks instead of reusing it.
      win.rows = live.slice()
      win.oldestMs = cutoffMs
      win.complete = false
    }
    return live
  } catch {
    return []
  }
}

function walkBackward(path: string, size: number, cutoffMs: number, field?: string): Window {
  const fd = openSync(path, "r")
  const pieces: Row[][] = []
  let end = size
  let oldestMs = Number.POSITIVE_INFINITY
  let complete = false
  let boundaryEnd = size
  try {
    // Trim a torn final line so the cached boundary sits on a newline.
    if (size > 0) {
      const tail = readRange(fd, Math.max(0, size - 64 * 1024), size)
      const cut = tail.lastIndexOf("\n")
      boundaryEnd = cut === -1 ? Math.max(0, size - 64 * 1024) : size - Buffer.byteLength(tail.slice(cut + 1), "utf-8")
      end = boundaryEnd
    }
    let carry = ""
    while (end > 0) {
      const start = Math.max(0, end - CHUNK)
      let text = readRange(fd, start, end) + carry
      if (start > 0) {
        const nl = text.indexOf("\n")
        carry = nl === -1 ? text : text.slice(0, nl)
        text = nl === -1 ? "" : text.slice(nl + 1)
      } else {
        carry = ""
      }
      const rows = parseLines(text)
      pieces.push(rows)
      let newest = Number.NEGATIVE_INFINITY
      for (const r of rows) {
        const t = rowTimeMs(r, field)
        if (Number.isNaN(t)) continue
        if (t < oldestMs) oldestMs = t
        if (t > newest) newest = t
      }
      end = start
      if (rows.length > 0 && newest < cutoffMs) break
    }
    complete = end === 0
  } finally {
    closeSync(fd)
  }
  pieces.reverse()
  const rows = ([] as Row[]).concat(...pieces)
  return { size: boundaryEnd, mtimeMs: 0, oldestMs, rows, complete, ino: 0, statSize: 0, headLen: 0, head: "" }
}

interface Whole { size: number; mtimeMs: number; rows: Row[] }
const wholes = new Map<string, Whole>()

/** The entire file, parsed once per (size, mtime). For files that are
 * rewritten or small and that a caller needs whole (all-time totals). The
 * parse still costs the file's size once per change, so keep it off logs
 * that grow without bound. */
export function readJsonlCached(path: string): Row[] {
  try {
    if (!existsSync(path)) return []
    const st = statSync(path)
    const c = wholes.get(path)
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.rows
    const fd = openSync(path, "r")
    let text: string
    try { text = readRange(fd, 0, st.size) } finally { closeSync(fd) }
    const rows = parseLines(text)
    wholes.set(path, { size: st.size, mtimeMs: st.mtimeMs, rows })
    return rows
  } catch {
    return []
  }
}

/** Test seam. */
export function _resetJsonlCaches(): void { windows.clear(); wholes.clear() }
