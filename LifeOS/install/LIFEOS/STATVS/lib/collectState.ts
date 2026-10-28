/**
 * Collection state: adapter cursors, their `<name>.read.json` outcome files and the Slack inbox
 * (migration design §3 Lane C item 2).
 *
 * Stage p1: the root is exactly Vigil's `State.ts` rule, so the live tick and anything that moves
 * onto this module share one set of cursors:
 *   VIGIL_STATE_DIR, else under `bun test` a per-process temp dir (the same name State.ts uses),
 *   else ~/.local/state/lifeos/vigil.
 * The live tick's cursors are therefore untouched, and a suite that sets nothing never writes the
 * live `cursors/` (S1). At the switch (p2) the root becomes `<statvsStateDir()>/collect`.
 *
 * This module imports nothing from LIFEOS/VIGIL (S9): the rule is restated here, and
 * `tests/collect.test.ts` checks it resolves to the same path as State.ts in every case.
 *
 * @version 1.1.0
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invariant } from "../../TOOLS/Invariant";

/** The live collection state root, with no test arm: the folder the workflow and the tick use (p1: Vigil's state dir). Contract
 * probes (ISC-46) read through it, so under bun test they still check the real inbox, and they follow the root when p2 moves it. */
export const liveCollectStateDir = (): string => process.env.VIGIL_STATE_DIR || join(homedir(), ".local/state/lifeos/vigil");

/** The collection state root (p1: Vigil's state dir; under bun test with no VIGIL_STATE_DIR, a per-process temp dir). */
export const collectStateDir = (): string =>
  process.env.VIGIL_STATE_DIR || (process.env.NODE_ENV === "test" ? join(tmpdir(), `lifeos-vigil-state-test-${process.pid}`) : liveCollectStateDir());

const inRoot = (parts: string[]): void => invariant(parts.every((p) => typeof p === "string" && !p.split(/[\\/]/).includes("..")), "a collect state path never climbs out of its root");

/** A path under the collection state root: `statePath("cursors", "x.json")`, `statePath("inbox", …)`. */
export const statePath = (...parts: string[]): string => {
  inRoot(parts);
  return join(collectStateDir(), ...parts);
};

/** A path under the live root (liveCollectStateDir), for read-only contract probes. */
export const liveStatePath = (...parts: string[]): string => {
  inRoot(parts);
  return join(liveCollectStateDir(), ...parts);
};

/** Parse a JSON file, or the fallback when it is missing or malformed. */
export function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

/** Write a JSON file (pretty, newline-terminated), creating its folder. */
export function writeJson(path: string, value: unknown): void {
  const body = JSON.stringify(value, null, 2) + "\n";
  invariant(body.length > 2, "state JSON is nonempty");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** Append one JSONL line, creating its folder. */
export function appendJson(path: string, value: unknown): void {
  const body = JSON.stringify(value);
  invariant(typeof body === "string" && !body.includes("\n"), "JSONL record is one line");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, body + "\n");
}
