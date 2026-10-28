/**
 * Eight Sleep source module.
 *
 * FRAGILE-API: reverse-engineered, NO official public API. Auth + endpoints
 * from the maintained lukas-clarke/eight_sleep Home Assistant integration
 * (pyEight constants), verified 2026-06-11. The app OAuth client pair that
 * integration uses is read from EIGHTSLEEP_CLIENT_ID / EIGHTSLEEP_CLIENT_SECRET;
 * it is never committed here. The vendor can rotate it or the endpoints at any
 * time; on breakage, re-research the HA integration first.
 *
 * UNOFFICIAL INTEGRATION: this talks to the vendor's private app API on the
 * user's own account, reusing the vendor mobile app's OAuth client. Every
 * request sends its own honest user agent (LifeOS and the version), never the
 * app's. The vendor does not offer or endorse this, it may
 * break without notice, and it may be outside the vendor's terms of service.
 * Use it only on your own device and account. The write calls (turnOn, turnOff,
 * setLevel, primePod) change the bed's heating and cooling and start priming.
 */
import { readFileSync } from "node:fs";
import { lifeosPath } from "../Paths";
import type { Ctx, SourceResult } from "./types";
import {
  authCooldownUntil,
  dayKeyLA,
  isoNowLA,
  loadState,
  loadTokens,
  resolveTimeZone,
  saveState,
  saveTokens,
  timedFetch,
  writeDayFile,
} from "./store";

const AUTH_URL = "https://auth-api.8slp.net/v1/tokens";
const CLIENT_API = "https://client-api.8slp.net/v1";
const APP_API = "https://app-api.8slp.net/v1";
// The mobile app OAuth client pair lives in the env (EIGHTSLEEP_CLIENT_ID /
// EIGHTSLEEP_CLIENT_SECRET), never in source: a vendor rotation is a config edit,
// and no client credential is committed to a repo that ships publicly.
// The client names itself honestly: "LifeOS/<version>" from LIFEOS/VERSION, never the vendor app's HTTP-library
// agent (principal decision P2-eightsleep, 2026-10-21). An unreadable VERSION falls back to plain "LifeOS".
function lifeosUserAgent(): string {
  let version = "";
  try { version = readFileSync(lifeosPath("VERSION"), "utf8").trim(); } catch { /* fallback below */ }
  return /^\d+\.\d+\.\d+$/.test(version) ? `LifeOS/${version}` : "LifeOS";
}
export const USER_AGENT = lifeosUserAgent();
const FETCH_TIMEOUT_MS = 15_000;
const WINDOW_DAYS = 7;
const REFRESH_SKEW_S = 120;

type Json = Record<string, unknown>;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function rec(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function fahrenheitLooking(value: number): boolean {
  return value > 45;
}

/** Pure: extract the metrics we track from one trends day object (raw preserved). */
export function summarizeEightSleepDay(day: Json): Record<string, unknown> {
  const score =
    num(day.score) ??
    num(rec(day.sleepQualityScore)?.total) ??
    null;
  const durationS = num(day.sleepDuration) ?? num(day.presenceDuration);
  let bedTemp = num(day.tempBedC);
  if (bedTemp === null) {
    const sessions = Array.isArray(day.sessions) ? (day.sessions as unknown[]) : [];
    for (const session of sessions) {
      const s = rec(session);
      if (s !== null) {
        bedTemp = num(s.tempBedC) ?? num(rec(s.bedTemperature)?.average);
        if (bedTemp !== null) break;
      }
    }
  }
  if (bedTemp !== null && fahrenheitLooking(bedTemp)) {
    bedTemp = Math.round(((bedTemp - 32) * 5 / 9) * 10) / 10;
  }

  return {
    eightsleep_score: score,
    sleep_duration_h: durationS === null ? null : Math.round((durationS / 3600) * 100) / 100,
    bed_temp_c: bedTemp,
    raw: day,
  };
}

function unconfigured(message: string, startedAt: number): SourceResult {
  return {
    source: "eightsleep",
    status: "unconfigured",
    records: 0,
    lastError: message,
    lastSuccess: null,
    ms: Date.now() - startedAt,
  };
}

function failed(message: string, startedAt: number): SourceResult {
  return {
    source: "eightsleep",
    status: "failed",
    records: 0,
    lastError: message,
    lastSuccess: null,
    ms: Date.now() - startedAt,
  };
}

export type AuthOutcome =
  | { ok: true; token: string; userId: string; attempted: boolean }
  | { ok: false; error: string; attempted: boolean };

export async function authenticate(ctx: Ctx, opts: { force?: boolean } = {}): Promise<AuthOutcome> {
  const email = str(ctx.env.EIGHTSLEEP_EMAIL);
  const password = str(ctx.env.EIGHTSLEEP_PASSWORD);
  if (email === null || password === null) {
    return { ok: false, error: "EIGHTSLEEP_EMAIL / EIGHTSLEEP_PASSWORD not set in ~/.claude/.env", attempted: false };
  }
  const clientId = str(ctx.env.EIGHTSLEEP_CLIENT_ID);
  const clientSecret = str(ctx.env.EIGHTSLEEP_CLIENT_SECRET);
  if (clientId === null || clientSecret === null) {
    return {
      ok: false,
      error: "EIGHTSLEEP_CLIENT_ID / EIGHTSLEEP_CLIENT_SECRET not set in ~/.claude/.env (the Eight Sleep app OAuth client pair; see the eight_sleep Home Assistant integration)",
      attempted: false,
    };
  }

  const tokens = await loadTokens(ctx);
  const cached = tokens.eightsleep;
  if (opts.force !== true && cached !== undefined && cached.expires_at > Math.floor(Date.now() / 1000) + REFRESH_SKEW_S) {
    return { ok: true, token: cached.access_token, userId: cached.userId, attempted: false };
  }

  const cooldownUntil = authCooldownUntil(await loadState(ctx), "eightsleep", ctx.now.getTime());
  if (cooldownUntil !== null) {
    return {
      ok: false,
      error: `auth-cooldown until ${cooldownUntil} after repeated login failures — check EIGHTSLEEP_* creds (SSO/2FA accounts cannot use password login)`,
      attempted: false,
    };
  }

  let response: Response;
  try {
    response = await timedFetch(
      AUTH_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "password",
          username: email,
          password,
        }),
      },
      FETCH_TIMEOUT_MS,
    );
  } catch (error) {
    return { ok: false, error: `Eight Sleep auth request failed: ${error instanceof Error ? error.message : String(error)}`, attempted: true };
  }

  if (!response.ok) {
    return { ok: false, error: `Eight Sleep auth HTTP ${response.status} (credential or rotated-client issue)`, attempted: true };
  }

  let json: Json;
  try {
    json = (await response.json()) as Json;
  } catch {
    return { ok: false, error: "Eight Sleep auth returned non-JSON", attempted: true };
  }

  const accessToken = str(json.access_token);
  const userId = str(json.userId) ?? str(json.main_id) ?? str(rec(json.user)?.userId);
  const expiresIn = num(json.expires_in) ?? num(json.expiry_duration) ?? 3600;
  if (accessToken === null || userId === null) {
    return { ok: false, error: "Eight Sleep auth response missing access_token/userId (API may have changed shape)", attempted: true };
  }

  tokens.eightsleep = {
    access_token: accessToken,
    userId,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
  };
  await saveTokens(ctx, tokens);
  return { ok: true, token: accessToken, userId, attempted: true };
}


/**
 * Shared authenticated request. One login path for every consumer (HealthSync
 * pull, the home skill CLI): the cached token, the refresh skew, and the lockout
 * cooldown all live in authenticate(). A 401 forces exactly one re-login and
 * one retry, mirroring the integration's api_request; a second 401 surfaces.
 */
export class EightSleepRequestError extends Error {
  constructor(message: string, readonly status: number | null, readonly authAttempted: boolean) {
    super(message);
  }
}

export type SideName = "left" | "right";

export type EightSleepSides = {
  deviceId: string;
  /** The logged-in user's own side; "solo" when one account owns the whole bed. */
  mine: SideName | "solo" | null;
  users: Record<SideName, string | null>;
  device: Json;
};

async function rawRequest(token: string, method: string, url: string, body?: unknown): Promise<Response> {
  return timedFetch(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    FETCH_TIMEOUT_MS,
  );
}

/**
 * Lockout bookkeeping for callers outside HealthSync (the CLI): a real login
 * attempt updates the same consecutiveAuthFailures counter the cooldown reads,
 * so the CLI can never hammer the auth endpoint either.
 */
async function recordAuthOutcome(ctx: Ctx, failed: boolean): Promise<void> {
  const state = await loadState(ctx);
  const prev = state.eightsleep ?? { lastSuccess: null, lastError: null, lastHash: null };
  state.eightsleep = {
    ...prev,
    consecutiveAuthFailures: failed ? (prev.consecutiveAuthFailures ?? 0) + 1 : 0,
    lastAuthAttempt: new Date().toISOString(),
  };
  await saveState(ctx, state);
}

export async function apiRequest(
  ctx: Ctx,
  method: "GET" | "PUT" | "POST",
  url: string,
  body?: unknown,
): Promise<{ json: Json | null; authAttempted: boolean }> {
  let auth = await authenticate(ctx);
  if (auth.attempted) await recordAuthOutcome(ctx, !auth.ok);
  if (!auth.ok) throw new EightSleepRequestError(auth.error, null, auth.attempted);
  let attempted = auth.attempted;

  let response = await rawRequest(auth.token, method, url, body);
  if (response.status === 401) {
    auth = await authenticate(ctx, { force: true });
    if (auth.attempted) await recordAuthOutcome(ctx, !auth.ok);
    if (!auth.ok) throw new EightSleepRequestError(auth.error, 401, true);
    attempted = true;
    response = await rawRequest(auth.token, method, url, body);
  }

  if (!response.ok) {
    let detail = "";
    try { detail = (await response.text()).slice(0, 300); } catch { /* body unreadable */ }
    throw new EightSleepRequestError(
      `Eight Sleep ${method} ${url} \u2192 HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
      response.status,
      attempted,
    );
  }
  if (response.status === 204) return { json: null, authAttempted: attempted };
  try {
    return { json: (await response.json()) as Json, authAttempted: attempted };
  } catch {
    return { json: null, authAttempted: attempted };
  }
}

/** Resolve the Pod and which user ID sits on each side (one login drives both). */
export async function resolveSides(ctx: Ctx): Promise<EightSleepSides> {
  const me = (await apiRequest(ctx, "GET", `${CLIENT_API}/users/me`)).json;
  const user = rec(me?.user) ?? me ?? {};
  const currentDevice = rec(user.currentDevice);
  const deviceId = str(currentDevice?.id) ?? str(user.currentDeviceId);
  if (deviceId === null) throw new EightSleepRequestError("Eight Sleep /users/me carried no currentDevice.id", null, false);
  const side = str(currentDevice?.side);

  const deviceJson = (await apiRequest(ctx, "GET", `${CLIENT_API}/devices/${deviceId}`)).json;
  const device = rec(deviceJson?.result) ?? deviceJson ?? {};
  return {
    deviceId,
    mine: side === "left" || side === "right" || side === "solo" ? side : null,
    users: { left: str(device.leftUserId), right: str(device.rightUserId) },
    device,
  };
}

/** Per-side temperature state (app-api). */
export async function getTemperature(ctx: Ctx, userId: string): Promise<Json> {
  return (await apiRequest(ctx, "GET", `${APP_API}/users/${userId}/temperature`)).json ?? {};
}

export async function turnOn(ctx: Ctx, userId: string): Promise<void> {
  await apiRequest(ctx, "PUT", `${APP_API}/users/${userId}/temperature`, { currentState: { type: "smart" } });
}

export async function turnOff(ctx: Ctx, userId: string): Promise<void> {
  await apiRequest(ctx, "PUT", `${APP_API}/users/${userId}/temperature`, { currentState: { type: "off" } });
}

/** Level is the raw \u2212100..100 scale; the integration sends level then a zero-duration timeBased row. */
export async function setLevel(ctx: Ctx, userId: string, level: number, opts: { powerOn?: boolean } = {}): Promise<void> {
  const clamped = Math.max(-100, Math.min(100, Math.round(level)));
  const url = `${APP_API}/users/${userId}/temperature`;
  if (opts.powerOn !== false) await turnOn(ctx, userId);
  await apiRequest(ctx, "PUT", url, { currentLevel: clamped });
  await apiRequest(ctx, "PUT", url, { timeBased: { level: clamped, durationSeconds: 0 } });
}

export async function primePod(ctx: Ctx, deviceId: string, userId: string): Promise<void> {
  await apiRequest(ctx, "POST", `${APP_API}/devices/${deviceId}/priming/tasks`, {
    notifications: { users: [userId], meta: "rePriming" },
  });
}

export async function pull(ctx: Ctx): Promise<SourceResult> {
  const startedAt = Date.now();
  const auth = await authenticate(ctx);
  if (!auth.ok) {
    const base = auth.error.includes("not set")
      ? unconfigured(auth.error, startedAt)
      : failed(auth.error, startedAt);
    return { ...base, authAttempted: auth.attempted, authFailed: auth.attempted };
  }

  // The tz the API buckets sessions by must match the one the day keys are built
  // from, or the from/to window straddles a different boundary than the response.
  // public issue #1762, @jacobo-ortiz
  const tz = resolveTimeZone();
  const to = dayKeyLA(ctx.now.getTime());
  const from = dayKeyLA(ctx.now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const url =
    `${CLIENT_API}/users/${auth.userId}/trends` +
    `?tz=${encodeURIComponent(tz)}&from=${from}&to=${to}` +
    `&include-main=false&include-all-sessions=true&model-version=v2`;

  let response: Response;
  try {
    response = await timedFetch(
      url,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      },
      FETCH_TIMEOUT_MS,
    );
  } catch (error) {
    return failed(
      `Eight Sleep trends request failed: ${error instanceof Error ? error.message : String(error)}`,
      startedAt,
    );
  }

  if (!response.ok) {
    return failed(`Eight Sleep trends HTTP ${response.status}`, startedAt);
  }

  let json: Json;
  try {
    json = (await response.json()) as Json;
  } catch {
    return failed("Eight Sleep trends returned non-JSON", startedAt);
  }

  const days = Array.isArray(json.days)
    ? (json.days as unknown[])
    : Array.isArray(rec(json.result)?.days)
      ? (rec(json.result)?.days as unknown[])
      : [];

  let records = 0;
  for (const rawDay of days) {
    const day = rec(rawDay);
    if (day === null) continue;
    const dayKey = str(day.day) ?? str(day.date);
    if (dayKey === null || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) continue;
    await writeDayFile(ctx, "eightsleep", dayKey, summarizeEightSleepDay(day));
    records += 1;
  }

  return {
    source: "eightsleep",
    status: "ok",
    records,
    lastError: null,
    lastSuccess: isoNowLA(ctx.now),
    ms: Date.now() - startedAt,
    authAttempted: auth.attempted,
    authFailed: false,
  };
}
