import { mtime } from "../Cache";
import type { State } from "../State";
import { USE_LANES, type UseLane } from "../../TOOLS/lib/ModelUse";

const KEYS = ["low", "medium", "high", "max", "astra_used", ...USE_LANES] as const;
export type Mix = Record<"low" | "medium" | "high" | "max" | "astra_used" | UseLane, number>;
const ALLOWED = new RegExp(`^mix_(${KEYS.join("|")})=[0-9]+$`);
const DEFAULT_TTL = 20;

export function emptyMix(): Mix {
  return Object.fromEntries(KEYS.map((k) => [k, 0])) as Mix;
}

/**
 * Per-rung and per-lane shares of the session's output tokens. The resolver is imported, not
 * spawned, and runs only when the per-session cache is older than the TTL (default 20 s). Only the numeric
 * allowlist is ever read back from the cache file.
 */
export function readMix(state: State): Mix {
  const mix = emptyMix();
  const session = state.sessionId === "" ? "" : state.session;
  if (!session) return mix;
  const name = `model-mix-${session}.txt`;
  const ttl = /^\d+$/.test(state.env.MODEL_MIX_TTL ?? "") ? Number(state.env.MODEL_MIX_TTL) : DEFAULT_TTL;
  const at = mtime(state.cache.path(name));
  if (state.now - (at > 0 ? at : state.now - 999999) > ttl) {
    try {
      const { computeMix, mixKvText } = require("../../TOOLS/ModelMix.ts") as typeof import("../../TOOLS/ModelMix");
      const lines = mixKvText(computeMix(session)).split("\n").filter(line => ALLOWED.test(line));
      if (lines.length > 0) state.cache.put(name, lines.join("\n") + "\n");
    } catch { /* a failed refresh keeps the previous cache, as the pipeline did */ }
  }
  for (const line of (state.cache.text(name) ?? "").split("\n")) {
    if (ALLOWED.test(line)) mix[line.slice(4, line.indexOf("=")) as keyof Mix] = Number(line.slice(line.indexOf("=") + 1));
  }
  return mix;
}
