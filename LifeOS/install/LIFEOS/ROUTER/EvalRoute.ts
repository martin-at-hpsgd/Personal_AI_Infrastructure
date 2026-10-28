/**
 * EvalRoute.ts — the router's answer to "which model does an eval use?"
 *
 * Two roles, two answers (principal directive, 2026-09-28: the router picks eval models):
 *
 *   subject — the model under test. An eval of the DA's behaviour must run on the model the DA
 *             runs on, the carrier, or its verdict describes a different model. Before this
 *             file, the subject rode Inference's helper default (inference-vendor.json →
 *             openai), so every DA-dispositions trial from 2026-09-15 ran on an OpenAI lane.
 *   judge   — the model grading the output. Judges are helper inference and ride the helper
 *             lanes named in USER/CONFIG/inference-vendor.json (the 2026-09-07 directive).
 *   helper  — a suite that pins `agent_level` is testing a helper-lane job (a blind judge, a
 *             low-tier reader, an echo), so its subject rides the same helper lanes at that level.
 *
 * The carrier is settings.json `model` when pinned (resolved through models.ts), otherwise the
 * ladder's default rung, Opus (ROUTING_RULES rule 1). A session switched with /model is not
 * visible to a headless eval; pin settings.json to make an eval follow it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CURRENT, parseClaudeId, resolveCarrierId, type ClaudeTier } from "../TOOLS/models";
import { lifeosPath } from "../TOOLS/Paths";

export type EvalVendor = "openai" | "anthropic";

export interface EvalSubject {
  vendor: "anthropic";
  model: string;
  tier: ClaudeTier;
  source: "settings" | "router-default";
}

const SETTINGS_JSON = join(import.meta.dir, "..", "..", "settings.json");

/** The router's default rung when nothing is pinned (lane-rules: Opus is the default when unsure). */
export const DEFAULT_SUBJECT_TIER: ClaudeTier = "opus";

/** The model under test for any eval of the DA or a skill the DA runs: the carrier. */
export function evalSubject(settingsModel: string | null | undefined = readSettingsModel()): EvalSubject {
  const pinned = resolveCarrierId(settingsModel);
  const tier = pinned ? parseClaudeId(pinned)?.tier : null;
  if (pinned && tier) return { vendor: "anthropic", model: pinned, tier, source: "settings" };
  return { vendor: "anthropic", model: CURRENT[DEFAULT_SUBJECT_TIER], tier: DEFAULT_SUBJECT_TIER, source: "router-default" };
}

/** True when a served Claude id belongs to the requested tier (a version bump inside a tier is fine). */
export function servedMatches(requestedTier: ClaudeTier, served: string | undefined): boolean {
  return !!served && parseClaudeId(served)?.tier === requestedTier;
}

/**
 * The vendors judges run on: LIFEOS_INFERENCE_VENDOR, then inference-vendor.json, then
 * anthropic. Calibration records hash this value, so its shape must not change.
 */
export function evalJudgeVendors(configPath = lifeosPath("USER", "CONFIG", "inference-vendor.json")): { default: EvalVendor; fallback?: EvalVendor } {
  const ok = (v: unknown): v is EvalVendor => v === "openai" || v === "anthropic";
  const d = process.env.LIFEOS_INFERENCE_VENDOR;
  try {
    const j = JSON.parse(readFileSync(configPath, "utf8"));
    return { default: ok(d) ? d : ok(j.default) ? j.default : "anthropic", fallback: ok(j.fallback) ? j.fallback : undefined };
  } catch {
    return { default: ok(d) ? d : "anthropic" };
  }
}

/** The single vendor a judge call, or a helper-lane subject, is sent to. */
export function evalJudgeVendor(): EvalVendor {
  return evalJudgeVendors().default;
}

function readSettingsModel(): string | null {
  try { return JSON.parse(readFileSync(SETTINGS_JSON, "utf8")).model ?? null; } catch { return null; }
}
