/** Vigil routing policy loader. @version 0.9.0
 * Instance policy may omit new keys; DEFAULT_POLICY supplies safe defaults without mutating USER policy.
 * 0.8.0: the policy file resolves through LIFEOS/TOOLS/Paths (honours CLAUDE_CONFIG_DIR); the issue-filing and DM-mirror keys
 * have generic names; adapter-only tuning is read with instanceSetting(); a malformed file warns once on stderr.
 * 0.9.0 (STATVS split, Lane D p1): `let_be` is a route value; `read_classes` names the record classes the tick reads; `advocate_mode`
 * (shadow by default) gates the advocate. No `advocate-*` source is ever text-trusted (load strips one and warns), and every
 * `advocate-*` source has a severity ceiling of medium unless the instance policy sets its own (Q-7, P1, Vigil ISC-447).
 */
import { readFileSync } from "node:fs";
import { lifeosPath } from "../TOOLS/Paths";
import { invariant } from "../TOOLS/Invariant";
import type { VigilEvent } from "./Schema";
export type Action = "text" | "digest" | "pulse";
/** A severity route: one of the actions, or `let_be` (recorded, nothing shown). */
export type RouteValue = Action | "let_be";
export const ROUTE_VALUES: readonly RouteValue[] = ["text", "digest", "pulse", "let_be"];
/** Record classes the tick may read. Customer rows never reach Vigil through this setting. */
export const DEFAULT_READ_CLASSES: readonly string[] = ["public", "system", "personal"];
/** Vigil ISC-447: the advocate's own result sources. Never text-trusted; capped at medium unless the instance policy says otherwise. */
export const isAdvocateSource = (source: string): boolean => typeof source === "string" && source.startsWith("advocate-");
export const ADVOCATE_SOURCES = ["advocate-research", "advocate-prepare", "advocate-background"] as const;
export const ADVOCATE_SEVERITY_CEILING = "medium" as const;
/** `shadow` records the advocate's verdict beside the floor's outcome; `enforce` lets it act. Only {{PRINCIPAL_NAME}} promotes it (Q-7). */
export const ADVOCATE_MODES = ["shadow", "enforce"] as const; export type AdvocateMode = typeof ADVOCATE_MODES[number];
/** F12: `shadow` only records what Vigil would do with job texts; `enforce` makes Vigil the one that sends them. */
export const DECIDER_MODES = ["shadow", "enforce"] as const; export type DeciderMode = typeof DECIDER_MODES[number];
export type VigilPolicy = {
  text_ceiling_exempt: string[]; routes: Record<VigilEvent["severity"], RouteValue>; text_ceiling_per_24h: number; digest_hour_local: number;
  source_severity_ceiling: Record<string, VigilEvent["severity"]>; source_events_per_hour: number; text_trusted_sources: string[]; source_cadence_minutes: Record<string, number>;
  /** Events flagged `meta.workrepo` at or above this severity are filed as an issue in the install's work repo, at most `issue_ceiling_per_24h` a day. */
  issue_min_severity: VigilEvent["severity"]; issue_ceiling_per_24h: number;
  /** Optional direct-message mirror: the member id to DM, the env key holding the bot token, and which channels (`text`, `workrepo`) are mirrored. Empty id means off. */
  dm_mirror_user_id: string; dm_mirror_token_env?: string; dm_mirror_on: Array<"text" | "workrepo">;
  /** Job ids whose scheduled texts are news (class `news`), whatever their wording. */
  news_job_ids: string[];
  editor_enabled: boolean; editor_text_ceiling_per_24h: number; editor_max_age_minutes: number; editor_exclude_sources: string[];
  decider_mode: DeciderMode; watch_text_cap_per_24h: number; source_text_cap_per_24h: Record<string, number>;
  /** Record classes the tick reads from STATVS (Reader.ts); values outside DEFAULT_READ_CLASSES are ignored. */
  read_classes: string[];
  advocate_mode: AdvocateMode;
};
export const DEFAULT_POLICY: VigilPolicy = {
  routes: { critical: "text", high: "text", medium: "digest", low: "pulse", info: "pulse" }, text_ceiling_per_24h: 6,
  // Substrings of an event's ref or title whose texts skip the 24h ceiling (never quiet hours or the 72h story hold).
  // For "a watcher is dead" alerts: with the watcher down, every other alarm is silent, so it must not queue behind routine
  // texts; otherwise a monitor that stops for hours has its one alert held by a ceiling already spent on routine flaps.
  text_ceiling_exempt: [],
  digest_hour_local: 8, source_severity_ceiling: Object.fromEntries(ADVOCATE_SOURCES.map((s) => [s, ADVOCATE_SEVERITY_CEILING])), source_events_per_hour: 30, text_trusted_sources: ["socrates", "achilles", "services", "errata"],
  issue_min_severity: "medium", issue_ceiling_per_24h: 5, dm_mirror_user_id: "", dm_mirror_on: ["text", "workrepo"], news_job_ids: [],
  // F12: under decider_mode enforce the one daily budget (interruptions_per_day over every origin's ledger rows, Tick.ts readTextLedger) replaces
  // text_ceiling_per_24h and editor_text_ceiling_per_24h; both bind again only as fallbacks when that ledger is unreadable. Under shadow they still govern Vigil's own texts, unchanged.
  // The editor (Editor.ts) is off unless the instance policy turns it on, so a bare checkout never calls a model.
  editor_enabled: false, editor_text_ceiling_per_24h: 3, editor_max_age_minutes: 180,
  // End-of-task summaries are the principal's own session reports: never news, never a text.
  editor_exclude_sources: ["tasks"],
  // Job texts stay the jobs' own until the principal has labelled the shadow pairs and flips this.
  decider_mode: "shadow",
  // Watch sources (watch-*) share this many texts a day, so many polling watches cannot spend the budget a real ops alert needs. Critical events are exempt.
  watch_text_cap_per_24h: 3,
  // Per-source daily text caps: a source named here may text at most this many times in any 24 hours.
  // Critical events are exempt, as from every other cap. Empty by default: the instance policy names the sources it limits.
  source_text_cap_per_24h: {},
  // Expected emitter intervals power source-quiet detection for the engine's own sources; the instance policy adds its own sources and may override these.
  source_cadence_minutes: { socrates: 60, services: 5, achilles: 60, errata: 1440, vigil: 5 },
  read_classes: [...DEFAULT_READ_CLASSES],
  // The advocate runs in shadow until {{PRINCIPAL_NAME}} promotes it after its Assay agreement rate (Q-7).
  advocate_mode: "shadow",
};
/** The instance policy file: VIGIL_POLICY when set, else `<LIFEOS>/USER/VIGIL/policy.json` under the install's config root. */
export const policyPath = (): string => process.env.VIGIL_POLICY || lifeosPath("USER", "VIGIL", "policy.json");
let warned = false;
function warnOnce(path: string, error: unknown): void {
  if (warned) return; warned = true;
  console.error(`Vigil: policy file ${path} is malformed (${error instanceof Error ? error.message : String(error)}); using the default policy until it is fixed.`);
}
const LEGACY_KEYS: ReadonlyArray<readonly [string, keyof VigilPolicy]> = [["slack_dm_user_id", "dm_mirror_user_id"], ["slack_token_env", "dm_mirror_token_env"], ["slack_dm_on", "dm_mirror_on"], ["workrepo_min_severity", "issue_min_severity"], ["workrepo_ceiling_per_24h", "issue_ceiling_per_24h"]];
export function loadPolicy(): VigilPolicy {
  const path = policyPath();
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return DEFAULT_POLICY; } // no file: the defaults, by design
  try {
    const saved = JSON.parse(text);
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("top level is not an object");
    // Earlier names of renamed keys still load, so a policy written before the rename keeps its settings.
    for (const [old, now] of LEGACY_KEYS) if (saved[now] === undefined && saved[old] !== undefined) saved[now] = saved[old];
    if (saved.dm_mirror_token_env !== undefined && (typeof saved.dm_mirror_token_env !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(saved.dm_mirror_token_env))) throw new Error("invalid dm_mirror_token_env");
    // An unknown mode falls back to shadow, the mode that changes no texts, without dropping the rest of the instance policy.
    if (saved.routes !== undefined && (!saved.routes || typeof saved.routes !== "object" || Object.values(saved.routes).some((a) => !(ROUTE_VALUES as readonly unknown[]).includes(a)))) throw new Error("routes values must be text, digest, pulse or let_be");
    if (saved.decider_mode !== undefined && !(DECIDER_MODES as readonly unknown[]).includes(saved.decider_mode)) saved.decider_mode = "shadow";
    // Like decider_mode: an unknown advocate mode is shadow, the mode that acts on nothing.
    if (saved.advocate_mode !== undefined && !(ADVOCATE_MODES as readonly unknown[]).includes(saved.advocate_mode)) saved.advocate_mode = "shadow";
    if (saved.read_classes !== undefined && !(Array.isArray(saved.read_classes) && saved.read_classes.every((c: unknown) => typeof c === "string"))) throw new Error("read_classes must be an array of class names");
    const merged: VigilPolicy = { ...DEFAULT_POLICY, ...saved, routes: { ...DEFAULT_POLICY.routes, ...saved.routes }, source_severity_ceiling: { ...DEFAULT_POLICY.source_severity_ceiling, ...saved.source_severity_ceiling }, source_cadence_minutes: { ...DEFAULT_POLICY.source_cadence_minutes, ...saved.source_cadence_minutes }, source_text_cap_per_24h: { ...DEFAULT_POLICY.source_text_cap_per_24h, ...saved.source_text_cap_per_24h } };
    return guardAdvocate(merged, path);
  } catch (error) { warnOnce(path, error); return DEFAULT_POLICY; }
}
/**
 * Vigil ISC-447 (P1): an advocate run may have read injected content, so its result can never text {{PRINCIPAL_NAME}} on its own.
 * Any `advocate-*` source in text_trusted_sources is dropped with one warning, and every `advocate-*` source the policy
 * names anywhere gets the medium ceiling unless the policy sets one for it.
 */
export function guardAdvocate(policy: VigilPolicy, path = policyPath()): VigilPolicy {
  const trusted = Array.isArray(policy.text_trusted_sources) ? policy.text_trusted_sources : [];
  const refused = trusted.filter(isAdvocateSource);
  if (refused.length) console.error(`Vigil: policy file ${path} lists ${refused.join(", ")} in text_trusted_sources; advocate sources are never text-trusted, so they are ignored.`);
  const named = [...trusted, ...Object.keys(policy.source_cadence_minutes ?? {}), ...Object.keys(policy.source_text_cap_per_24h ?? {})].filter(isAdvocateSource);
  const ceilings = { ...policy.source_severity_ceiling };
  for (const s of named) if (!Object.hasOwn(ceilings, s)) ceilings[s] = ADVOCATE_SEVERITY_CEILING;
  const out: VigilPolicy = { ...policy, text_trusted_sources: trusted.filter((s) => !isAdvocateSource(s)), source_severity_ceiling: ceilings };
  invariant(!out.text_trusted_sources.some(isAdvocateSource), "no advocate source is text-trusted");
  return out;
}
/** The severity ceiling a source runs under: the policy's own, else medium for any `advocate-*` source, else none. */
export function severityCeiling(policy: VigilPolicy, source: string): VigilEvent["severity"] | null {
  const own = policy.source_severity_ceiling?.[source];
  return own ?? (isAdvocateSource(source) ? ADVOCATE_SEVERITY_CEILING : null);
}
/** A key the engine does not define (one installed adapter's own tuning), read from the instance policy with that adapter's default. */
export function instanceSetting<T>(key: string, fallback: T, policy: VigilPolicy = loadPolicy()): T {
  const value = (policy as unknown as Record<string, unknown>)[key];
  return value === undefined || value === null ? fallback : value as T;
}
