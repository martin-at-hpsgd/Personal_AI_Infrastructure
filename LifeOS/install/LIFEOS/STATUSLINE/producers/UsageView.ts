import { homedir } from "node:os";
import { invariant } from "../../TOOLS/Invariant";
import { privateExtension } from "../Private";
import { overageLine } from "../../TOOLS/UsageOverage";
import { mtime, readJson } from "../Cache";
import { number, object, string, type JsonObject, type State } from "../State";
import { intPart } from "../UsageMeter";
import { parseIsoEpoch, resetTimeStr, splitReset } from "../Time";

/** P5: show last-known-good usage until six hours old, then hide (bash USAGE_HARD_EXPIRY). */
export const USAGE_HARD_EXPIRY = 21600;
/** The staleness badge starts past ten minutes of data age. */
export const USAGE_STALE_AFTER = 600;

export type PayLabel = "POOL" | "API" | "DIRECT";
export interface Payment { label: PayLabel; rows: string }

/** The payment kind from the environment alone: an API key or any base URL bills an API, else the direct login. */
export function genericKind(env: Record<string, string | undefined>): PayLabel {
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim() !== "") return "API";
  return env.ANTHROPIC_BASE_URL?.trim() ? "API" : "DIRECT";
}

/** The payment kind; the private extension, when this install has one, recognizes its own base URL. */
export function paymentKind(env: Record<string, string | undefined>): PayLabel {
  const ext = privateExtension();
  return ext ? ext.paymentKind(env) : genericKind(env);
}

/** The full label for the extension's own kind; empty without an extension, which never yields that kind. */
export function paymentTitle(): string {
  const ext = privateExtension();
  return ext ? ext.PAYMENT_TITLE : "";
}

const memo = new WeakMap<State, { pay?: Payment; usage?: UsageView }>();
function slot(state: State): { pay?: Payment; usage?: UsageView } {
  let s = memo.get(state);
  if (!s) { s = {}; memo.set(state, s); }
  return s;
}

const percentArg = (value: unknown): number | null => {
  const n = value === undefined || value === "" ? NaN : Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};
const epochMs = (value: unknown): number | null => {
  if (value === undefined || value === "" || value === null) return null;
  const text = String(value);
  const n = /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text);
  return Number.isFinite(n) ? n : null;
};

/** Native window presence and values from stdin rate_limits. */
export interface Native {
  has: boolean; fivePresent: boolean; weekPresent: boolean;
  five: string; fiveReset: string; week: string; weekReset: string;
  opus: string; sonnet: string;
  extraEnabled: boolean; extraLimit: string; extraUsed: string;
}
const num = (v: unknown): string => (typeof v === "number" ? String(v) : typeof v === "string" ? v : "");
export function nativeWindows(input: JsonObject): Native {
  const limits = input.rate_limits;
  const r = object(limits), five = object(r.five_hour), week = object(r.seven_day), extra = object(r.extra_usage);
  const pick = (w: JsonObject): unknown => w.used_percentage ?? w.utilization;
  const window = (w: JsonObject): string => (pick(w) == null ? "0" : num(pick(w)) || "0");
  const model = (key: string): string => { const w = r[key]; return w ? (pick(object(w)) == null ? "0" : num(pick(object(w))) || "0") : "null"; };
  const reset = (w: JsonObject): string => (w.resets_at == null ? "" : String(w.resets_at));
  return {
    has: limits != null && limits !== false,
    fivePresent: pick(five) != null, weekPresent: pick(week) != null,
    five: window(five), fiveReset: reset(five), week: window(week), weekReset: reset(week),
    opus: model("seven_day_opus"), sonnet: model("seven_day_sonnet"),
    extraEnabled: extra.is_enabled === true, extraLimit: num(extra.monthly_limit) || "0", extraUsed: num(extra.used_credits) || "0",
  };
}

/**
 * The payment label and, when the private extension draws them, the account chip rows.
 * Computed in-process from local files; no network.
 */
export function payment(state: State): Payment {
  const s = slot(state);
  if (s.pay) return s.pay;
  const env = state.env;
  const ext = privateExtension();
  if (!ext) {
    s.pay = { label: genericKind(env), rows: "" };
    return s.pay;
  }
  const native = nativeWindows(state.input);
  let live: { five: number | null; week: number | null; fable: number | null } = { five: null, week: null, fable: null };
  const anyLive = native.fivePresent || native.weekPresent || native.fiveReset !== "";
  if (native.fivePresent) live.five = percentArg(native.five);
  if (native.weekPresent) live.week = percentArg(native.week);
  const usagePath = state.cache.path("usage.json");
  const cachedAt = mtime(usagePath);
  if (anyLive && cachedAt > 0 && state.now - cachedAt < USAGE_HARD_EXPIRY) {
    const limits = object(state.cache.json("usage.json")).limits;
    const row = Array.isArray(limits) ? limits.map(object).find(l => string(object(object(l.scope).model).display_name) === "Fable") : undefined;
    if (row) {
      const at = parseIsoEpoch(string(row.resets_at));
      if (at <= state.nowMs / 1000) live.fable = 0;
      else if (row.percent != null) live.fable = percentArg(row.percent);
    }
  }
  s.pay = ext.paymentSection({
    env, home: env.HOME || homedir(),
    codex: env.LIFEOS_CODEX_USAGE_CACHE ? readJson(env.LIFEOS_CODEX_USAGE_CACHE) : state.cache.json("codex-usage.json"),
    muse: env.LIFEOS_MUSE_USAGE_CACHE ? readJson(env.LIFEOS_MUSE_USAGE_CACHE) : state.cache.json("muse-usage.json"),
    sessionId: state.sessionId || undefined,
    live,
    fiveResetAt: native.fiveReset ? epochMs(native.fiveReset) : null,
    now: state.nowMs,
    cols: state.geometry.content,
  });
  return s.pay;
}

export interface Scoped { present: boolean; name: string; pct: string; reset: string; active: boolean }
export interface UsageView {
  state: "fresh" | "api" | "pool" | "absent";
  source: "native" | "oauth" | "pool" | "api";
  noData: boolean;
  sessionCost: string;
  fiveInt: number; sevenInt: number;
  fiveReset: string; sevenReset: string;
  fiveActive: boolean; sevenActive: boolean;
  opus: string; sonnet: string; opusReset: string; sonnetReset: string;
  extraEnabled: boolean; extraLimit: string; extraUsed: string;
  dataAge: number;
  scoped: Scoped;
  spendUsed: string; spendLimit: string; limitReached: boolean; userDisabled: boolean; poolKnown: boolean;
}

function enrichment(cache: JsonObject): Pick<UsageView, "scoped" | "fiveActive" | "sevenActive" | "spendUsed" | "spendLimit" | "limitReached" | "userDisabled" | "poolKnown"> {
  const limits = (Array.isArray(cache.limits) ? cache.limits : []).map(object);
  const sc = limits.find(l => object(l.scope).model != null);
  const active = (kind: string): boolean => { const l = limits.find(x => x.kind === kind); return l?.is_active === true; };
  const spend = object(cache.spend), extra = object(cache.extra_usage);
  const model = object(object(sc?.scope).model);
  return {
    scoped: { present: sc != null, name: string(model.display_name).replace(/[a-z]/g, c => c.toUpperCase()), pct: num(sc?.percent) || "0", reset: string(sc?.resets_at), active: sc?.is_active === true },
    fiveActive: active("session"), sevenActive: active("weekly_all"),
    spendUsed: num(object(spend.used).amount_minor) || "0", spendLimit: num(object(spend.limit).amount_minor) || "0",
    limitReached: extra.spend_limit_reached === true, userDisabled: extra.user_disabled === true,
    poolKnown: cache.extra_usage != null || cache.spend != null,
  };
}

/**
 * Which usage source wins, enrichment from the OAuth cache, expiry and presence flags, as one typed view. Reads only;
 * the fetch that keeps usage.json fresh is the infra lane's.
 */
export function usageView(state: State): UsageView {
  const s = slot(state);
  if (s.usage) return s.usage;
  const pay = payment(state);
  const native = nativeWindows(state.input);
  const raw = state.cache.json("usage.json");
  const cache = object(raw);
  const haveFile = mtime(state.cache.path("usage.json")) > 0;
  const fetched = cache.fetched_at;
  const dataAge = !haveFile ? 999999 : typeof fetched === "number" && Number.isInteger(fetched) ? state.now - fetched : state.now - mtime(state.cache.path("usage.json"));
  const base: UsageView = {
    state: "absent", source: "oauth", noData: false, sessionCost: String(number(object(state.input.cost).total_cost_usd)),
    fiveInt: 0, sevenInt: 0, fiveReset: "", sevenReset: "", fiveActive: false, sevenActive: false,
    opus: "null", sonnet: "null", opusReset: "", sonnetReset: "",
    extraEnabled: false, extraLimit: "0", extraUsed: "0", dataAge: 0,
    scoped: { present: false, name: "", pct: "0", reset: "", active: false },
    spendUsed: "0", spendLimit: "0", limitReached: false, userDisabled: false, poolKnown: false,
  };
  const within = haveFile && dataAge < USAGE_HARD_EXPIRY;
  let view: UsageView;
  if (pay.label === "POOL") view = { ...base, state: "pool", source: "pool" };
  else if (pay.label === "API") view = { ...base, state: "api", source: "api" };
  else if (native.has && (native.fivePresent || native.weekPresent)) {
    view = { ...base, state: "fresh", source: "native", fiveInt: intPart(native.five), sevenInt: intPart(native.week), fiveReset: native.fiveReset, sevenReset: native.weekReset,
      opus: native.opus, sonnet: native.sonnet, extraEnabled: native.extraEnabled, extraLimit: native.extraLimit, extraUsed: native.extraUsed };
    if (within) {
      const extra = object(cache.extra_usage);
      if (!native.extraEnabled && extra.is_enabled === true) { view.extraEnabled = true; view.extraLimit = num(extra.monthly_limit) || "0"; view.extraUsed = num(extra.used_credits) || "0"; }
      Object.assign(view, enrichment(cache));
    }
  } else if (within && cache.five_hour) {
    const five = object(cache.five_hour), week = object(cache.seven_day), extra = object(cache.extra_usage);
    const model = (k: string): string => (cache[k] ? (num(object(cache[k]).utilization) || "0") : "null");
    view = { ...base, state: "fresh", source: "oauth", fiveInt: intPart(num(five.utilization) || "0"), sevenInt: intPart(num(week.utilization) || "0"),
      fiveReset: string(five.resets_at), sevenReset: string(week.resets_at),
      opus: model("seven_day_opus"), opusReset: string(object(cache.seven_day_opus).resets_at),
      sonnet: model("seven_day_sonnet"), sonnetReset: string(object(cache.seven_day_sonnet).resets_at),
      extraEnabled: extra.is_enabled === true, extraLimit: num(extra.monthly_limit) || "0", extraUsed: num(extra.used_credits) || "0", dataAge, ...enrichment(cache) };
  } else view = { ...base, state: "absent", source: "oauth", noData: true };
  // Native windows without a reset take the OAuth cache's.
  if (haveFile && (!view.fiveReset || !view.sevenReset)) {
    if (!view.fiveReset) view.fiveReset = string(object(cache.five_hour).resets_at);
    if (!view.sevenReset) view.sevenReset = string(object(cache.seven_day).resets_at);
  }
  s.usage = view;
  return view;
}

export interface Derived {
  fiveInt: number; sevenInt: number; fiveActive: boolean; sevenActive: boolean;
  fiveDay: string; fiveTime: string; sevenDay: string; sevenTime: string;
  opus: string; sonnet: string;
  scopedInt: string; scopedActive: boolean; scopedDay: string; scopedTime: string;
  crUsed: number; crLimit: number; crPool: boolean; crAvail: boolean; crPct: number;
  capped: "" | "5H" | "WK" | "FB" | "OP" | "SO";
  billing: "SUB" | "CREDITS" | "LOCKED" | "CAPPED";
  est5h: string; burn: string;
}

const isCapped = (v: unknown): boolean => { const t = String(v ?? "").split(".")[0]; return /^[0-9]+$/.test(t) && Number(t) >= 100; };

/** Reset strings, the crossed-window clamp, the credits pool and the billing state machine. */
export function derive(state: State, v: UsageView): Derived {
  invariant(v.state === "fresh", "billing derives only from a fresh usage view");
  const now = state.now, tz = state.timezone;
  const reset = (raw: string): { epoch: number; day: string; time: string } => {
    const epoch = raw ? parseIsoEpoch(raw) : 0;
    if (epoch > 0) return { epoch, ...splitReset(resetTimeStr(epoch, tz, now)) };
    return { epoch: 0, day: "—", time: "" };
  };
  const r5 = reset(v.fiveReset), r7 = reset(v.sevenReset);
  let fiveInt = v.fiveInt, sevenInt = v.sevenInt, fiveActive = v.fiveActive, sevenActive = v.sevenActive;
  if (v.source !== "native") {
    if (r5.epoch > 0 && r5.epoch <= now) { fiveInt = 0; fiveActive = false; }
    if (r7.epoch > 0 && r7.epoch <= now) { sevenInt = 0; sevenActive = false; }
  }
  let opus = v.opus, sonnet = v.sonnet;
  if (v.opusReset) { const e = parseIsoEpoch(v.opusReset); if (e > 0 && e <= now) opus = "0"; }
  if (v.sonnetReset) { const e = parseIsoEpoch(v.sonnetReset); if (e > 0 && e <= now) sonnet = "0"; }

  let crUsed = intPart(v.extraUsed), crLimit = intPart(v.extraLimit);
  if (!v.extraEnabled) { crUsed = intPart(v.spendUsed); crLimit = intPart(v.spendLimit); }
  const crPool = crLimit > 0;
  const crAvail = v.extraEnabled && !v.limitReached && !v.userDisabled;
  const crPct = crPool ? Math.trunc((crUsed * 100) / crLimit) : 0;

  let scopedInt = "", scopedActive = v.scoped.active, scopedDay = "", scopedTime = "";
  if (v.scoped.present && v.scoped.name) {
    scopedInt = String(intPart(v.scoped.pct));
    if (v.scoped.reset) {
      const e = parseIsoEpoch(v.scoped.reset);
      if (e > 0) {
        ({ day: scopedDay, time: scopedTime } = splitReset(resetTimeStr(e, tz, now)));
        if (e <= now) { scopedInt = "0"; scopedActive = false; }
      }
    }
  }
  let capped: Derived["capped"] = "";
  if (isCapped(fiveInt) && fiveActive) capped = "5H";
  else if (isCapped(sevenInt) && sevenActive) capped = "WK";
  else if (scopedInt !== "" && isCapped(scopedInt) && scopedActive) capped = "FB";
  else if (isCapped(fiveInt)) capped = "5H";
  else if (isCapped(sevenInt)) capped = "WK";
  else if (scopedInt !== "" && isCapped(scopedInt)) capped = "FB";
  else if (isCapped(opus)) capped = "OP";
  else if (isCapped(sonnet)) capped = "SO";
  let billing: Derived["billing"] = "SUB";
  if (capped) billing = !v.poolKnown ? "CAPPED" : crAvail ? "CREDITS" : "LOCKED";

  let est5h = "", burn = "";
  if (billing === "CREDITS" && capped === "5H") {
    const file = "overage-line.txt";
    if (state.cache.age(file) > 30) {
      try { state.cache.put(file, overageLine(readJson(state.cache.path("usage.json")), { dir: state.cache.root, nowMs: state.nowMs }) + "\n"); } catch { /* fails open to nothing */ }
    }
    const rawLine = (state.cache.text(file) ?? "").split("\n")[0];
    const bar = rawLine.indexOf("|");
    est5h = bar < 0 ? "" : rawLine.slice(0, bar);
    const rawBurn = bar < 0 ? rawLine : rawLine.slice(bar + 1);
    if (!/^~[0-9].*%$/.test(est5h) && est5h !== ">999%") est5h = "";
    if (/^[0-9]+$/.test(rawBurn)) {
      const n = Number(rawBurn);
      burn = n >= 1000 ? ` +$${Math.trunc(n / 1000)}.${Math.trunc(n / 100) % 10}K` : ` +$${n}`;
    }
  }
  return {
    fiveInt, sevenInt, fiveActive, sevenActive, fiveDay: r5.day, fiveTime: r5.time, sevenDay: r7.day, sevenTime: r7.time,
    opus, sonnet, scopedInt, scopedActive, scopedDay, scopedTime, crUsed, crLimit, crPool, crAvail, crPct, capped, billing, est5h, burn,
  };
}
