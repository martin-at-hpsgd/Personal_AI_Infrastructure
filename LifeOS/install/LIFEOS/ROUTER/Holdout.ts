/**
 * @version 1.0.0
 * Holdout.ts — the router holdout: a randomized slice of human turns that runs vanilla, so "does the router
 * help?" has a causal answer (execution-evidence ISA ISC-25..27).
 *
 * The switch is `USER/CONFIG/router-holdout.json` ({ mode: "off"|"on", rate }). Absent, off, malformed or a
 * rate of 0 all mean off, and off changes nothing: no field is added to any row and no line changes. Only the
 * principal turns it on (`bun LIFEOS/ROUTER/Router.ts holdout on --rate 0.1`).
 *
 * While on, a turn is in the experiment when the router actually advised it: not a skip, not the principal's
 * own lane or depth directive, not binding, not dictated. Within the experiment a stable hash of the turn id
 * (the harness prompt_id) decides the arm, so the same id always lands in the same arm. A held-out turn gets
 * no route line and no effort change; its router-decisions row still lands, with `holdout: true`, so the
 * evidence index sees both arms. Routed turns in the experiment carry `holdout: false`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { lifeosPath } from "../TOOLS/Paths";

export type HoldoutMode = "off" | "on";
export type HoldoutConfig = { mode: HoldoutMode; rate: number };
export const HOLDOUT_OFF: HoldoutConfig = { mode: "off", rate: 0 };
/** The rate the CLI writes when none is given. */
export const DEFAULT_HOLDOUT_RATE = 0.1;
/** A holdout above half would make the router the minority arm; the CLI refuses it. */
export const MAX_HOLDOUT_RATE = 0.5;

/** LIFEOS_ROUTER_HOLDOUT_FILE redirects the switch so a test never reads or writes the live one. */
export function holdoutPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LIFEOS_ROUTER_HOLDOUT_FILE || lifeosPath("USER", "CONFIG", "router-holdout.json");
}

/** The switch as configured. Anything but a well-formed `on` with a rate in (0, MAX] reads as off: a broken file never holds turns out. */
export function loadHoldout(env: NodeJS.ProcessEnv = process.env): HoldoutConfig {
  // Under bun test only an explicit switch file is read, so turning the live switch on can never make a routing test flaky.
  if (!env.LIFEOS_ROUTER_HOLDOUT_FILE && process.env.NODE_ENV === "test") return HOLDOUT_OFF;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(holdoutPath(env), "utf8")); } catch { return HOLDOUT_OFF; }
  if (!raw || typeof raw !== "object") return HOLDOUT_OFF;
  const { mode, rate } = raw as { mode?: unknown; rate?: unknown };
  if (mode !== "on" || typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > MAX_HOLDOUT_RATE) return HOLDOUT_OFF;
  return { mode: "on", rate };
}

export function holdoutActive(cfg: HoldoutConfig): boolean { return cfg.mode === "on" && cfg.rate > 0; }

/** A uniform number in [0, 1) from the turn id: the first 32 bits of its SHA-256. Same id, same number. */
export function holdoutBucket(turnId: string): number {
  return createHash("sha256").update(turnId).digest().readUInt32BE(0) / 2 ** 32;
}

export type HoldoutCandidate = { turn: string; source: string; binding: boolean; dictated: boolean };

/** Whether the router advised this turn, which is what the experiment varies. The principal's explicit calls are never held out. */
export function holdoutEligible(d: HoldoutCandidate): boolean {
  return d.source !== "skip" && d.source !== "directive" && !d.binding && !d.dictated && d.turn.length > 0;
}

/**
 * The turn's arm: true held out, false routed, null not in the experiment (switch off or turn ineligible).
 * Null is what keeps an off switch byte-identical to before: callers add no field for it.
 */
export function holdoutArm(d: HoldoutCandidate, cfg: HoldoutConfig): boolean | null {
  if (!holdoutActive(cfg) || !holdoutEligible(d)) return null;
  return holdoutBucket(d.turn) < cfg.rate;
}

/** Write the switch. Only the CLI calls this, on the principal's word. */
export function setHoldout(cfg: HoldoutConfig, path = holdoutPath()): void {
  invariant(cfg.mode === "on" || cfg.mode === "off", "holdout mode must be on or off");
  invariant(Number.isFinite(cfg.rate) && cfg.rate >= 0 && cfg.rate <= MAX_HOLDOUT_RATE, `holdout rate must be in [0, ${MAX_HOLDOUT_RATE}]`);
  invariant(cfg.mode === "off" || cfg.rate > 0, "an on switch needs a rate above 0");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ mode: cfg.mode, rate: cfg.rate, set: new Date().toISOString() }) + "\n");
  renameSync(tmp, path);
}
