/**
 * Route — the deterministic routing table for the ComputerUse skill.
 *
 * One rule, readable and auditable:
 *   - Any intent tagged `verify` or `evidence` routes to `interceptor`. Always.
 *     No handle state, failure count, or backend availability changes this.
 *   - An `act` intent with a handle (DOM node, AX element, CLI, API) routes to
 *     `interceptor`.
 *   - An `act` intent with no handle routes to `astra`.
 *   - After two Interceptor failures on the same step, that step escalates to
 *     `astra` — but only when the Interceptor health preflight passed. A failed
 *     preflight means "tool broken", not "no handle", and the run is refused.
 *   - Which vision leg takes a handle-less (or escalated) step is `visionPick`,
 *     set from the bake-off scoreboard (Tools/BakeOff.ts). `claude` is chosen
 *     only when the pick says so AND the Claude leg reports installed; every
 *     other case is `astra`. The pick never touches evidence or handle routing.
 *
 * Pure logic. No machine access. Tests: ../Tests/Route.test.ts
 *
 * @version 1.0.0
 */

export type Backend = "interceptor" | "astra" | "claude";
export type Intent = "act" | "verify" | "evidence";

export interface RouteInput {
  intent: Intent;
  /** A DOM node, AX element, CLI command, or API the deterministic path can address. */
  hasHandle: boolean;
  /** Interceptor failures already recorded on THIS step. */
  interceptorFailures?: number;
  /** Result of the Interceptor health preflight for this run. */
  interceptorHealthy?: boolean;
  /** Whether the Claude vision leg (Tools/ClaudeLeg.ts) is installed. */
  claudeInstalled?: boolean;
  /** The scoreboard's vision pick for this task's class. Default astra. */
  visionPick?: "astra" | "claude";
}

export type RouteDecision =
  | { backend: Backend; reason: RouteReason; escalated: boolean }
  | { backend: null; refused: RefusalReason };

export type RouteReason =
  | "evidence-path"
  | "has-handle"
  | "no-handle"
  | "escalated-after-2-failures";

export type RefusalReason = "interceptor-preflight-failed";

/** How many Interceptor failures on one step hand that step to Astra. */
export const ESCALATION_THRESHOLD = 2;

/**
 * Criteria for the Claude leg. The table never selects `claude` while
 * `claudeInstalled` is false, nor unless the scoreboard picked it.
 */
export const CLAUDE_SLOT_CRITERIA =
  "Handle-less GUI work where the bake-off scoreboard shows Claude winning that task class; " +
  "same deny list, caps, and read-back contract as astra. Not selected while not installed.";

export function route(input: RouteInput): RouteDecision {
  const failures = input.interceptorFailures ?? 0;
  const healthy = input.interceptorHealthy ?? true;
  const vision: Backend = input.visionPick === "claude" && input.claudeInstalled === true ? "claude" : "astra";

  // Constitutional №2: evidence never leaves Interceptor. Checked first so no
  // later branch can override it.
  if (input.intent === "verify" || input.intent === "evidence") {
    return { backend: "interceptor", reason: "evidence-path", escalated: false };
  }

  if (!healthy) {
    // A broken Interceptor is not a missing handle. Refuse rather than route the
    // whole run to the full-desktop backend.
    return { backend: null, refused: "interceptor-preflight-failed" };
  }

  if (input.hasHandle) {
    if (failures >= ESCALATION_THRESHOLD) {
      return { backend: vision, reason: "escalated-after-2-failures", escalated: true };
    }
    return { backend: "interceptor", reason: "has-handle", escalated: false };
  }

  return { backend: vision, reason: "no-handle", escalated: false };
}

/** Structured result for the claude slot when its tools are absent. */
export function claudeBackendStatus(installed: boolean):
  | { status: "installed" }
  | { status: "not_installed"; criteria: string } {
  return installed
    ? { status: "installed" }
    : { status: "not_installed", criteria: CLAUDE_SLOT_CRITERIA };
}
