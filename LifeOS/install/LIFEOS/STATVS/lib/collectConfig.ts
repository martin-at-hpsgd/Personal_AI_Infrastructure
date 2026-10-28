/**
 * Collection settings (migration design §1.3, §3 Lane C item 6).
 *
 * The keys collection owns: `adapter_burst_max`, `adapters`, `slack_scan_minutes`,
 * `discord_question_hours`, `slack_dm_business_hours`, `surface_quality_min`, plus one it shares:
 * `dm_mirror_user_id`, the principal's Slack id, which the `slack` and `slackdms` readers use to tell his own
 * messages from everyone else's. Its older name `slack_dm_user_id` is honoured the way Vigil's Policy.ts
 * LEGACY_KEYS honours it. At p2 that key is COPIED into collect.json, not moved: Vigil's DM mirror still reads it
 * from policy.json.
 *
 * Stage p1: they are read from the same file the legacy tick reads, USER/VIGIL/policy.json
 * (or VIGIL_POLICY, the override Vigil's Policy.ts honours), so an edit during dual-write applies
 * to both sides (S17). At the switch (p2) they move to USER/STATVS/collect.json in the same commit
 * that removes them from policy.json (dm_mirror_user_id excepted, above).
 *
 * Read-only. A missing file gives the defaults; a malformed one gives the defaults and warns once.
 * Only the collection keys are returned: nothing here exposes Vigil's routing policy.
 * Imports nothing from LIFEOS/VIGIL (S9).
 *
 * @version 1.1.0
 */
import { readFileSync } from "node:fs";
import { lifeosPath } from "../../TOOLS/Paths";

export const COLLECT_KEYS = ["adapter_burst_max", "adapters", "slack_scan_minutes", "discord_question_hours", "slack_dm_business_hours", "surface_quality_min", "dm_mirror_user_id"] as const;
export type CollectKey = typeof COLLECT_KEYS[number];

/** Older names a settings file may still carry, read only when the current name is absent (Vigil Policy.ts LEGACY_KEYS). */
const LEGACY_KEYS: ReadonlyArray<readonly [string, CollectKey]> = [["slack_dm_user_id", "dm_mirror_user_id"]];

/** More events than this from one adapter in one read is a cursor problem, not news (Vigil's default, common.ts burstMax). */
export const DEFAULT_BURST_MAX = 25;

/** The file the settings are read from in p1. */
export const collectConfigPath = (): string => process.env.VIGIL_POLICY || lifeosPath("USER", "VIGIL", "policy.json");

let warned = false;

/** Every collection key present in the settings file, and nothing else. */
export function collectConfig(): Partial<Record<CollectKey, unknown>> {
  const path = collectConfigPath();
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return {}; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) {
    if (!warned) { warned = true; console.error(`STATVS collect: settings file ${path} is malformed (${(e as Error).message}); using defaults until it is fixed.`); }
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Partial<Record<CollectKey, unknown>> = {};
  for (const key of COLLECT_KEYS) {
    const v = (parsed as Record<string, unknown>)[key];
    if (v !== undefined && v !== null) out[key] = v;
  }
  for (const [old, now] of LEGACY_KEYS) {
    const v = (parsed as Record<string, unknown>)[old];
    if (out[now] === undefined && v !== undefined && v !== null) out[now] = v;
  }
  return out;
}

/** One collection setting, or the fallback when absent (same contract as Vigil's instanceSetting). */
export function collectSetting<T>(key: CollectKey, fallback: T, config: Partial<Record<CollectKey, unknown>> = collectConfig()): T {
  const v = config[key];
  return v === undefined || v === null ? fallback : v as T;
}

/** The burst limit: a positive integer, else the default. */
export function burstMax(config: Partial<Record<CollectKey, unknown>> = collectConfig()): number {
  const n = Number(collectSetting<unknown>("adapter_burst_max", DEFAULT_BURST_MAX, config));
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BURST_MAX;
}
