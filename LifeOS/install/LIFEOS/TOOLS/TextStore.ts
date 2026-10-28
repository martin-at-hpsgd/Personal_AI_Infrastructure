/**
 * TextStore — the four primitives behind LifeOS's plain-text state files.
 *
 * Doctrine (LifeosSystemArchitecture.md founding principles + AD-1 + AD-9):
 * state is text. Append-shaped state is JSONL; small mutable state is one JSON
 * file rewritten atomically. SQLite is reserved for files owned by other
 * software (read-only) and for Atlas's audited graph-concurrency case.
 *
 *   readJsonl(path)          → T[]   torn trailing line skipped, malformed interior line throws
 *   appendJsonl(path, rows)  one write per call, newline-terminated
 *   readJson(path, fallback) → T
 *   writeJsonAtomic(path, v) tmp + rename, so a reader never sees a torn file
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const out: T[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]) as T);
    } catch (err) {
      if (i === lines.length - 1) break; // an interrupted append; the next append starts a fresh line
      throw new Error(`${path}:${i + 1} malformed JSONL: ${String(err)}`);
    }
  }
  return out;
}

export function appendJsonl(path: string, rows: unknown[]): void {
  if (rows.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  repairTornTail(path);
  appendFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// An interrupted append leaves the file without a final newline. readJsonl already ignores a torn LAST line, so a
// fragment is dropped here (truncated) instead of being glued to the next record or left before it, where it would
// become a malformed interior line and make the whole journal unreadable. A last line that parses was only missing
// its newline: keep it and add the newline.
function repairTornTail(path: string): void {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (size === 0) return;
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    if (b[0] === 0x0a) return;
  } finally {
    closeSync(fd);
  }
  const text = readFileSync(path, "utf8");
  const start = text.lastIndexOf("\n") + 1;
  try {
    JSON.parse(text.slice(start));
    appendFileSync(path, "\n");
  } catch {
    truncateSync(path, Buffer.byteLength(text.slice(0, start)));
  }
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJsonAtomic(path: string, value: unknown, pretty = 1): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, pretty));
  renameSync(tmp, path);
}
