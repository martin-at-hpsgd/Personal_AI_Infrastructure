import { principalTimezone } from "../lib/Timezone";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { invariant } from "../Invariant";
import { safeFetch, type SafeFetchOptions } from "../lib/SafeFetch";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  Ctx,
  DayFile,
  SourceName,
  SyncState,
  TokenStore,
} from "./types";
import { getClaudeDir, lifeosPath } from "../Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { parseEnv as parseEnvFromFile } from "../Env"; // public issue #2100, @bowlax: unified parser

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const ENV_PATH = join(getClaudeDir(), ".env");
const STATE_DIR = lifeosPath("MEMORY", "STATE");
const DATA_DIR = lifeosPath("USER", "HEALTH", "DATA");
const OBS_DIR = lifeosPath("MEMORY", "OBSERVABILITY");
const TOKENS_PATH = join(STATE_DIR, "healthsync-tokens.json");
const STATE_PATH = join(STATE_DIR, "healthsync-state.json");

// Everything this module writes is private (tokens, health records, state,
// logs): directories are created 0700 and files 0600 AT CREATION, never
// chmod'd after the write.
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The IANA zone that defines a "day" for health data.
 *
 * Sleep and activity days are wall-clock local, so a hardcoded zone silently
 * misfiled every record for anyone outside Pacific time — and shifted the
 * boundary for the principal too while traveling. Resolution order is explicit
 * override, then principalTimezone() (location fix, config, machine zone).
 * public issue #1762, @jacobo-ortiz
 *
 * The host zone no longer comes before the location: launchd runs the hourly
 * pull with the Mac's system zone, which stays at home while the principal
 * travels, so "today" lagged by the zone gap and the statusline showed
 * yesterday's readiness all morning while the principal was away from home.
 */
export function resolveTimeZone(): string {
  const override = process.env.LIFEOS_HEALTH_TZ?.trim();
  if (override && isValidTimeZone(override)) return override;
  return principalTimezone();
}

export function dayKey(epochMs: number, timeZone: string = resolveTimeZone()): string {
  if (!Number.isFinite(epochMs)) {
    throw new Error("epochMs must be finite");
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const key = `${year}-${month}-${day}`;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new Error(`failed to build day key for ${timeZone}`);
  }

  return key;
}

export function isoNow(d: Date, timeZone: string = resolveTimeZone()): string {
  // Convert the local wall-clock parts, then compare them with UTC to derive the
  // correct DST-aware offset for that instant.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const getPart = (type: string): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) {
      throw new Error(`missing ${type} while formatting ${timeZone} timestamp`);
    }
    return value;
  };

  const year = getPart("year");
  const month = getPart("month");
  const day = getPart("day");
  const hour = getPart("hour") === "24" ? "00" : getPart("hour");
  const minute = getPart("minute");
  const second = getPart("second");
  const asUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const offsetMinutes = Math.round((asUtc - d.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offsetHour = String(Math.floor(abs / 60)).padStart(2, "0");
  const offsetMinute = String(abs % 60).padStart(2, "0");

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`;
}

// Historical names, kept so existing call sites read unchanged. They are no
// longer LA-specific — both resolve the zone at call time. public issue #1762
export const dayKeyLA = dayKey;
export const isoNowLA = isoNow;

// Re-export the unified parseEnv from Env.ts (public issue #2100, @bowlax).
// Removed duplicate parser; the consolidated version in Env.ts handles CRLF + export prefix.
export const parseEnv = parseEnvFromFile;

export async function readEnvFile(path: string): Promise<Record<string, string>> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return {};
    }
    return parseEnv(await file.text());
  } catch {
    return {};
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return fallback;
    }
    return (await file.json()) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(path: string, obj: unknown): Promise<void> {
  ensureParent(path);
  // Atomic: write-temp + rename so a crash mid-write never corrupts tokens/state.
  // The temp file is created 0600 (exclusive, so a pre-planted file or symlink
  // at the temp path is never followed) and the rename keeps that inode, so
  // the final file is never readable by anyone else, even for an instant.
  invariant(path.length > 0, "writeJson: empty path");
  const tmp = `${path}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
    flag: "wx",
  });
  renameSync(tmp, path);
}

/** Kept for existing callers; writeJson is now always private. */
export async function writeJson0600(path: string, obj: unknown): Promise<void> {
  await writeJson(path, obj);
}

export async function loadState(ctx: Ctx): Promise<SyncState> {
  return readJsonSafe<SyncState>(ctx.statePath, {});
}

export async function saveState(ctx: Ctx, s: SyncState): Promise<void> {
  await writeJson(ctx.statePath, s);
}

export async function loadTokens(ctx: Ctx): Promise<TokenStore> {
  return readJsonSafe<TokenStore>(ctx.tokensPath, {});
}

export async function saveTokens(ctx: Ctx, t: TokenStore): Promise<void> {
  await writeJson0600(ctx.tokensPath, t);
}

export async function writeDayFile(
  ctx: Ctx,
  source: SourceName,
  dayKey: string,
  metrics: Record<string, unknown>,
): Promise<void> {
  const dayFile: DayFile = {
    schema: 1,
    source,
    fetched_at: isoNowLA(ctx.now),
    metrics,
  };
  await writeJson(join(ctx.dataDir, source, `${dayKey}.json`), dayFile);
}

export async function appendJsonl(path: string, obj: unknown): Promise<void> {
  ensureParent(path);
  // appendFileSync applies its mode only when it creates the file. A log written by an earlier version may be
  // broader than 0600, so it is tightened (never loosened) before this line goes in.
  try {
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, PRIVATE_FILE_MODE);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  appendFileSync(path, `${JSON.stringify(obj)}\n`, { mode: PRIVATE_FILE_MODE });
}

export async function buildCtx(): Promise<Ctx> {
  ensureDir(STATE_DIR);
  ensureDir(DATA_DIR);
  ensureDir(OBS_DIR);

  return {
    env: await readEnvFile(ENV_PATH),
    now: new Date(),
    stateDir: STATE_DIR,
    dataDir: DATA_DIR,
    obsDir: OBS_DIR,
    tokensPath: TOKENS_PATH,
    statePath: STATE_PATH,
  };
}

const AUTH_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const AUTH_FAILURE_THRESHOLD = 3;

/**
 * Lockout protection for unofficial vendor APIs: after 3 consecutive failed
 * logins, refuse further attempts for 6h (max ~4 login attempts/day) so the
 * hourly launchd job can never hammer an auth endpoint into flagging the
 * account. Returns the ISO time the cooldown lifts, or null if clear.
 */
export function authCooldownUntil(
  state: SyncState,
  source: SourceName,
  nowMs: number,
): string | null {
  const s = state[source];
  const failures = s?.consecutiveAuthFailures ?? 0;
  const last = s?.lastAuthAttempt ?? null;
  if (failures < AUTH_FAILURE_THRESHOLD || last === null) {
    return null;
  }
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) {
    return null;
  }
  const until = lastMs + AUTH_COOLDOWN_MS;
  return nowMs >= until ? null : new Date(until).toISOString();
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Test seam for timedFetch: a resolver, extra trust roots, a non-public class to allow, or SafeFetch's own
 * transport seam. Production never sets it, so every healthsync request is public-only. Tests that run a local
 * server opt into loopback here and restore it afterwards.
 */
export const timedFetchSeam: Pick<SafeFetchOptions, "resolve" | "allow" | "tls" | "transport"> = {};

/**
 * Every healthsync request goes through SafeFetch (S122, ISA 20261015-security-p1-batch2): the host is resolved
 * once, every address must be public, the connection is pinned to the checked address, and each redirect hop is
 * checked again. `ms` is SafeFetch's deadline for the whole call, headers and body, so a body that stalls after
 * the headers is aborted at the same deadline.
 *
 * Round 2: SafeFetch awaits the host's DNS answer before it looks at its deadline (SafeFetch.ts checkDestination),
 * so a resolver that never answers held the call open past `ms`. timedFetch owns its deadline: the same signal goes
 * to SafeFetch as the caller's signal (so headers, body and every hop stop on it) and the whole call is raced
 * against it, so timedFetch settles by `ms` whatever SafeFetch is still awaiting. A call it abandons cannot send
 * afterwards: SafeFetch checks the (now aborted) signal before it opens any connection.
 */
export async function timedFetch(
  url: string,
  init: RequestInit | undefined,
  ms: number,
): Promise<Response> {
  const deadline = AbortSignal.timeout(ms);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const call = safeFetch(url, { ...(init ?? {}), signal }, { ...timedFetchSeam, timeoutMs: ms });
  if (signal.aborted) { call.catch(() => {}); throw signal.reason; }
  let onAbort = () => {};
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error(`timedFetch: ${url} did not answer within ${ms} ms`));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([call, expired]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    // The losing side settles later or never; neither may surface as an unhandled rejection.
    call.catch(() => {});
    expired.catch(() => {});
  }
}
