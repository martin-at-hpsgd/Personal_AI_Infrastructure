import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

/**
 * The one door from the public statusline, money row and status snapshot to this install's private extension,
 * LIFEOS/TOOLS/StatusLinePrivate.ts, which the release never ships. When the file is absent the callers draw their
 * generic usage, Codex and account rows. When it is present it is loaded with no catch around the load, so a broken
 * extension fails loudly instead of quietly falling back.
 *
 * LIFEOS_PRIVATE_EXTENSION_DIR points the lookup at another directory; tests point it at an empty one.
 */
export const PRIVATE_FILE = "StatusLinePrivate.ts";

/** What the extension exports. Loose types on purpose: the public side never names the extension's own types. */
export interface PrivateExtension {
  /** The full label a session drawn with kind "POOL" carries where it has room. */
  PAYMENT_TITLE: string;
  paymentKind(env: Record<string, string | undefined>): "POOL" | "API" | "DIRECT";
  paymentSection(i: {
    env: Record<string, string | undefined>; home: string; sessionId?: string;
    live: { five: number | null; week: number | null; fable: number | null }; fiveResetAt: number | null;
    codex: unknown; muse: unknown; now: number; cols: number;
  }): { label: "POOL" | "API" | "DIRECT"; rows: string };
  saveStdin(s: { label: string; transcript: string; env: Record<string, string | undefined>; cacheRoot: string; rawInput: string }): void;
  moneyAccounts(env: Record<string, string | undefined>, home: string): { pay: string; accounts: Array<{ slug?: unknown; email?: unknown; extra?: unknown }>; served: unknown; login: unknown };
  activeSlug(pay: string, accounts: unknown[], served: unknown, sessionId: string | undefined, login: unknown, now: number): string | null;
  chipData(row: unknown, now: number): { left5: unknown; leftWk: unknown; state: string };
  accountsSnapshot(lifeosDir: string, dir: string, nowMs?: number): object | null;
  transportOf(baseUrl: string | null | undefined): string;
  activeAccountSlug(lifeosDir: string, nowMs: number): string | null;
}

const load = createRequire(import.meta.url);
const loaded = new Map<string, PrivateExtension | null>();

/** The extension, or null when this install has none. */
export function privateExtension(dir: string = process.env.LIFEOS_PRIVATE_EXTENSION_DIR || resolve(import.meta.dir, "..", "TOOLS")): PrivateExtension | null {
  const file = join(dir, PRIVATE_FILE);
  if (loaded.has(file)) return loaded.get(file)!;
  const ext = existsSync(file) ? (load(file) as PrivateExtension) : null;
  loaded.set(file, ext);
  return ext;
}
