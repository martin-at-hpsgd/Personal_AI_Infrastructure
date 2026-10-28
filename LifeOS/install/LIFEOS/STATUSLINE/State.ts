import { readlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { claudeDirFor, defaultClaudeDir, lifeosDirFor } from "../TOOLS/Paths";
import { Cache, mtime, readJson, readText } from "./Cache";
import { geometry, type Geometry } from "./Width";

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
export function string(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
export function number(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }

/** jq's `a // b`: b unless a is null, absent or false. Zero and the empty string are kept. */
export function alt<T>(a: unknown, b: T): unknown | T { return a === null || a === undefined || a === false ? b : a; }
/** A jq value as shell text (`@sh` on a scalar): strings as-is, numbers and booleans as JSON, anything else empty. */
function scalar(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}
function numeric(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return fallback;
}

/** Cache lifetimes in seconds. The rationale for each lives in the bash table this was ported from. */
export const TTL = {
  location: 3600,
  weather: 900,
  tide: 300,
  cosmos: 300,
  git: 5,
  usage: 900,
  usageActive: 60,
  usageBusyWindow: 120,
  usageHardExpiry: 21600,
  codex: 300,
  codexActive: 60,
  codexAfterglow: 180,
  workQueue: 300,
} as const;

/** Claude Code reserves ~16.5% of context for compaction: usable context is 83.5% of the window, as a ×10 integer. */
export const COMPACTION_USABLE = 835;

/** The stdin `rate_limits` object, with the bash's three-state presence kept apart from zero. */
export interface NativeUsage {
  present: boolean;
  fivePresent: boolean;
  weekPresent: boolean;
  five: number;
  fiveReset: string;
  week: number;
  weekReset: string;
  opus: number | null;
  sonnet: number | null;
  extraEnabled: boolean;
  extraLimit: number;
  extraUsed: number;
}

export interface LocationSettings { city: string; region: string; lat: string; lon: string; countryCode: string }
export type PaymentKind = "DIRECT" | "API" | "POOL";
export interface Payment { label: PaymentKind; rows: string }

export interface State {
  input: JsonObject;
  rawInput: string;
  settings: JsonObject;
  env: Record<string, string | undefined>;
  root: string;
  claude: string;
  now: number;
  nowMs: number;
  timezone: string;
  clock: string;
  cache: Cache;
  geometry: Geometry;
  session: string;
  /** The stdin session id, or empty when absent or unusable as a cache-file name. Sections read this, never stdin directly. */
  sessionId: string;
  transcript: string;
  model: string;
  contextPct: number;
  versions: { lifeos: string; algorithm: string; harness: string };
  weatherEnabled: boolean;
  sessionLabel: string;
  tabLabel: string;
  /** The session-mode chips (⚡ULTRACODE, ⇶ Pn, ↯ FAST, 🎤 VOICE, 👻) with leading spaces, empty when none is on; filled by the Ultracode section. */
  ultracode: string;
  /** The same chips in their short form (⚡UC, Pn), for rows too narrow for the full words. */
  ultracodeShort: string;
  /** Claude Code's stdin `fast_mode` is true: fast mode is on for this session (Router ISA F10, R142). */
  fastMode: boolean;
  /** True when the install root could not be made absolute: the caller prints the bare name and exits 0. */
  failClosed: boolean;
  home: string;
  currentDir: string;
  dirName: string;
  effort: string;
  outputStyle: string;
  harnessName: string;
  harnessVersion: string;
  ccVersionJson: string;
  contextMax: number;
  totalInput: number;
  sessionCostUsd: number;
  native: NativeUsage;
  /** The LifeOSHooks plugin stamped this session with the band capability in the last seven days. */
  functionHooksArmed: boolean;
  tempUnit: "celsius" | "fahrenheit";
  daName: string;
  settingsLocation: LocationSettings;
  /** The width to persist for later re-renders: COLUMNS, null when only the cache or the default answered. */
  widthToPersist: number | null;
  /** Payment label and pool rows; filled by the Pool section before the sections draw. */
  pay: Payment;
  /** The Location system's zone replaced the configured one, so spawned tools must read local time through TZ. */
  timezoneOverride: boolean;
}

/** A literal `$HOME`, `${HOME}` or `~/` prefix is expanded, a Windows drive path is made POSIX, and anything still relative or unexpanded is refused. */
export function expandRoot(dir: string, home: string, cygpath: (path: string) => string = () => ""): string | null {
  let d = dir;
  if (d.startsWith("$HOME")) d = home + d.slice(5);
  else if (d.startsWith("${HOME}")) d = home + d.slice(7);
  else if (d.startsWith("~/")) d = `${home}/${d.slice(2)}`;
  if (!d.startsWith("/")) {
    if (!/^[A-Za-z]:[/\\]/.test(d)) return null;
    const converted = cygpath(d) || `/${d[0]!.toLowerCase()}${d.slice(d.indexOf(":") + 1).replaceAll("\\", "/")}`;
    if (!converted.startsWith("/")) return null;
    d = converted;
  }
  return d.includes("$HOME") || d.includes("${HOME}") || d.includes("~") ? null : d;
}

/** The account's home directory from the password database (the bash's two id -un candidates resolve here). */
function accountHome(): string {
  try { return userInfo().homedir; } catch { return homedir(); }
}

function systemHome(env: Record<string, string | undefined>): string {
  return env.HOME || accountHome();
}

/**
 * The first non-empty, whitespace-stripped version file across the bash candidates (188-222): the install root, the default
 * install under $HOME, then the default install under the account's own home. An em dash when none has a value.
 */
export function versionFile(rel: string, root: string, home: string, account: string = accountHome()): string {
  for (const path of [join(root, rel), join(defaultClaudeDir(home), "LIFEOS", rel), join(defaultClaudeDir(account), "LIFEOS", rel)]) {
    const value = (readText(path) ?? "").replace(/\s/g, "");
    if (value) return value;
  }
  return "—";
}

/** Settings.principal.timezone, then $TZ, the /etc/localtime link, /etc/timezone, UTC. */
export function resolveTimezone(settingsZone: string, env: Record<string, string | undefined>): string {
  if (settingsZone) return settingsZone;
  if (env.TZ) return env.TZ;
  try {
    const link = readlinkSync("/etc/localtime").replace(/.*\/zoneinfo\//, "");
    if (link) return link;
  } catch { /* not a symlink */ }
  const zone = (readText("/etc/timezone") ?? "").replace(/\s/g, "");
  return zone || "UTC";
}

function nativeUsage(input: JsonObject): NativeUsage {
  const limits = input.rate_limits;
  const rl = object(limits);
  const five = object(rl.five_hour), week = object(rl.seven_day), extra = object(rl.extra_usage);
  const used = (w: JsonObject): unknown => alt(w.used_percentage, w.utilization);
  const optional = (w: unknown): number | null => (alt(w, null) === null ? null : numeric(used(object(w)), 0));
  return {
    present: limits !== null && limits !== undefined,
    fivePresent: used(five) !== null && used(five) !== undefined,
    weekPresent: used(week) !== null && used(week) !== undefined,
    five: numeric(alt(used(five), 0)),
    fiveReset: scalar(alt(five.resets_at, "")),
    week: numeric(alt(used(week), 0)),
    weekReset: scalar(alt(week.resets_at, "")),
    opus: optional(rl.seven_day_opus),
    sonnet: optional(rl.seven_day_sonnet),
    extraEnabled: alt(extra.is_enabled, false) === true,
    extraLimit: numeric(alt(extra.monthly_limit, 0)),
    extraUsed: numeric(alt(extra.used_credits, 0)),
  };
}

/** The seven-day function-hooks stamp must exist, be under 10,080 minutes old, and name the "band" capability. */
/** A session id fit to name a file under the LifeOS root; the same test as fast/src/main.rs `safe_session`. */
const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The wake templates in fast/wake: root-relative paths, `<session>` for this session's id. The one list both halves of
 * the replay decision read (Admission.enter() here, statusline-fast in Rust), held equal to the sections' `wake:` inputs
 * by Registry.test.ts. A template that is absolute or climbs out of the root is refused here as it is in Rust.
 */
export function wakeTemplates(file: string = join(import.meta.dir, "fast", "wake")): string[] {
  const text = readText(file) ?? "";
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .filter((l) => !l.startsWith("/") && !l.split("/").some((c) => c === "." || c === ".."));
}

/** The wake files for this session: each template under the root, skipping `<session>` ones when the id cannot name a file. */
export function wakePaths(root: string, sessionId: string, templates: string[] = wakeTemplates()): string[] {
  const safe = SAFE_SESSION.test(sessionId);
  return templates.filter((t) => safe || !t.includes("<session>")).map((t) => join(root, t.replaceAll("<session>", sessionId)));
}

/** This session's docs-sync result file (hooks/MicroIntegrity.hook.ts, a `wake:` input of the ultracode chip), or "" with no usable id. */
export function docsStatePath(root: string, sessionId: string): string {
  return SAFE_SESSION.test(sessionId) ? join(root, "MEMORY", "STATE", "micro-integrity", `${sessionId}.json`) : "";
}

export function bandArmed(root: string, session: string, now: number): boolean {
  if (!session) return false;
  const path = join(root, "MEMORY", "STATE", "function-hooks", `${session}.json`);
  const at = mtime(path);
  return at > 0 && Math.ceil(Math.max(0, now - at) / 60) < 10080 && (readText(path) ?? "").includes('"band"');
}

export function buildState(rawInput: string, env: Record<string, string | undefined> = process.env, nowMs = Date.now()): State {
  let input: JsonObject = {};
  try { input = object(JSON.parse(rawInput)); } catch { /* Malformed input uses the legacy defaults. */ }
  const home = systemHome(env);
  const expanded = env.LIFEOS_DIR ? expandRoot(env.LIFEOS_DIR, home) : null;
  const failClosed = Boolean(env.LIFEOS_DIR) && expanded === null;
  const root = expanded ?? lifeosDirFor(env, home);
  const claude = claudeDirFor(env, home);
  const settings = object(readJson(join(claude, "settings.json")));
  const now = Math.floor(nowMs / 1000);
  const cache = new Cache(join(env.XDG_CACHE_HOME || join(home, ".cache"), "lifeos-statusline"), now);
  const preferences = object(settings.preferences);
  const weatherEnabled = object(preferences.statusline).weather !== false;
  const location = object(cache.json("location-cache.json"));
  let timezone = resolveTimezone(string(object(settings.principal).timezone), env);
  let timezoneOverride = false;
  if (weatherEnabled && location.source === "lifeos-location" && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(string(location.timezone))) { timezone = string(location.timezone); timezoneOverride = true; }
  let clock: string;
  try { clock = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(nowMs); }
  catch { timezone = "UTC"; clock = new Date(nowMs).toISOString().slice(11, 16); }
  // A session id that cannot name a cache file is treated as absent, so the frame degrades instead of going blank.
  const rawSession = scalar(alt(input.session_id, ""));
  const sessionId = /[\\/\0]/.test(rawSession) ? "" : rawSession;
  const session = sessionId || "nosess";
  const workspace = object(input.workspace), model = object(input.model), context = object(input.context_window), harness = object(input.harness);
  const currentDir = scalar(alt(workspace.current_dir, alt(input.cwd, "."))) || ".";
  const names = object(readJson(join(root, "MEMORY", "STATE", "session-names.json")));
  const labelsFile = readJson(join(root, "MEMORY", "STATE", "session-labels.json"));
  const haveNames = readText(join(root, "MEMORY", "STATE", "session-names.json")) !== null;
  const labels = object(labelsFile);
  const daidentity = object(settings.daidentity);
  const loc = object(settings.location);
  const columns = env.COLUMNS && /^\d+$/.test(env.COLUMNS) ? Number(env.COLUMNS) : 0;
  const cachedWidth = cache.text(`term-width-${env.KITTY_WINDOW_ID || "default"}`);
  return {
    input, rawInput, settings, env, root, claude, now, nowMs, timezone, clock, cache,
    geometry: geometry(env, cachedWidth),
    session, sessionId, transcript: scalar(alt(input.transcript_path, "")), model: scalar(alt(model.display_name, "unknown")),
    contextPct: numeric(alt(context.used_percentage, 0)),
    versions: {
      lifeos: versionFile("VERSION", root, home),
      algorithm: versionFile("ALGORITHM/LATEST", root, home),
      harness: scalar(alt(input.version, "")) || cache.text("cc-version-cache.txt")?.trim() || "unknown",
    },
    weatherEnabled, sessionLabel: sessionId && haveNames ? string(names[sessionId]) : "", tabLabel: sessionId && haveNames ? string(labels[sessionId]) : "", ultracode: "", ultracodeShort: "",
    failClosed, home, currentDir, dirName: basename(currentDir) || ".",
    effort: scalar(alt(object(input.effort).level, "")), fastMode: input.fast_mode === true, outputStyle: scalar(alt(object(input.output_style).name, "")),
    harnessName: scalar(alt(harness.name, "")) || "CC", harnessVersion: scalar(alt(harness.version, "")), ccVersionJson: scalar(alt(input.version, "")),
    contextMax: numeric(alt(context.context_window_size, 200000), 200000), totalInput: numeric(alt(context.total_input_tokens, 0)),
    sessionCostUsd: numeric(alt(object(input.cost).total_cost_usd, 0)),
    native: nativeUsage(input),
    functionHooksArmed: bandArmed(root, sessionId, now),
    tempUnit: object(preferences).temperatureUnit === "celsius" ? "celsius" : "fahrenheit",
    daName: scalar(alt(daidentity.name, alt(daidentity.displayName, alt(object(settings.env).DA, "Assistant")))) || "Assistant",
    settingsLocation: { city: scalar(alt(loc.city, "")), region: scalar(alt(loc.regionName, "")), lat: scalar(alt(loc.lat, "")), lon: scalar(alt(loc.lon, "")), countryCode: scalar(alt(loc.countryCode, "")) },
    widthToPersist: columns > 0 ? columns : null,
    pay: { label: "DIRECT", rows: "" },
    timezoneOverride,
  };
}
