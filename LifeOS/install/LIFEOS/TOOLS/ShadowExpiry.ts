#!/usr/bin/env bun
/**
 * ShadowExpiry — names every shadow switch that has sat past its expiry and recommends a decision.
 *
 * A shadow switch is the effort-routing mode file in shadow, or a Glance caller in shadow. Each one
 * expires DEFAULT_SHADOW_DAYS after it started (the mode file's `set`, or the caller's first Glance row),
 * unless the caller's registry entry carries `shadow_until: "YYYY-MM-DD"`. One run emits at most one
 * Vigil digest event listing all expired switches, deduped per ISO week. It recommends promote or kill;
 * it never changes a mode (ISA 20261009-execution-evidence-loop ISC-13). Origin: effort routing sat in
 * shadow nine days after one sample tripped it, and all 25 Glance callers were in shadow with no date.
 *
 *   bun LIFEOS/TOOLS/ShadowExpiry.ts check [--json] [--emit]
 *
 * Uses Assay's judgment layer (LIFEOS/DOCUMENTATION/Assay/AssaySystem.md).
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { lifeosPath } from "./Paths";
import { emitVigilEvent } from "./lib/VigilOptional";

export const DEFAULT_SHADOW_DAYS = 21;
const DAY = 86_400_000;

export type Switch = { name: string; kind: "glance-caller"; since: string | null; expires: string | null; expired: boolean; never_ran: boolean };
type Registry = Record<string, { mode?: string; shadow_until?: string }>;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The first row date per caller in a Glance ledger, streamed so a large ledger never loads whole. */
export async function firstSeenByCaller(logPath: string): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  if (!existsSync(logPath)) return seen;
  const lines = createInterface({ input: createReadStream(logPath, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    const m = /"ts":"([^"]+)","caller":"([^"]+)"/.exec(line);
    if (m && !(m[2] in seen)) seen[m[2]] = m[1];
  }
  return seen;
}

export function glanceSwitches(registry: Registry, firstSeen: Record<string, string>, now: number, days = DEFAULT_SHADOW_DAYS): Switch[] {
  return Object.entries(registry)
    .filter(([name, cfg]) => name !== "defaults" && cfg?.mode === "shadow")
    .map(([name, cfg]) => {
      const since = firstSeen[name] ?? null;
      const until = cfg.shadow_until ? Date.parse(cfg.shadow_until) : since ? Date.parse(since) + days * DAY : NaN;
      return { name, kind: "glance-caller" as const, since, expires: Number.isFinite(until) ? isoDay(until) : null, expired: since === null || (Number.isFinite(until) && now > until), never_ran: since === null };
    });
}

/** One digest event for every expired switch, or null when none has expired. */
export function expiredEvent(switches: Switch[], now: number): Record<string, unknown> | null {
  const expired = switches.filter((s) => s.expired);
  if (expired.length === 0) return null;
  const neverRan = expired.filter((s) => s.never_ran).map((s) => s.name);
  const stale = expired.filter((s) => !s.never_ran).map((s) => `${s.name} (since ${s.since?.slice(0, 10)})`);
  const week = (() => { const d = new Date(now); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return isoDay(d.getTime()); })();
  const summary = [
    stale.length ? `Past expiry, decide promote or kill: ${stale.join(", ")}.` : "",
    neverRan.length ? `Registered but never ran, candidates to delete: ${neverRan.join(", ")}.` : "",
    "Evidence per caller: bun LIFEOS/ASSAY/Assay.ts report --caller <name>. Nothing was changed.",
  ].filter(Boolean).join(" ");
  return {
    id: crypto.randomUUID(), source: "shadow-expiry", ts: new Date(now).toISOString(), kind: "infra", severity: "medium",
    title: `${expired.length} shadow switch${expired.length === 1 ? "" : "es"} past expiry need a decision`,
    summary: summary.length > 1000 ? summary.slice(0, 997) + "..." : summary,
    ref: "LIFEOS/TOOLS/ShadowExpiry.ts", url: null, privacy_class: "personal", dedup_key: `shadow-expiry-${week}`,
  };
}

/** assay.jsonl began 2026-09-20; earlier caller rows live in jev-decisions.jsonl (named for Jev, retired 2026-10-10), so both count. */
const DEFAULT_GLANCE_LOGS = () => [lifeosPath("MEMORY", "OBSERVABILITY", "assay.jsonl"), lifeosPath("MEMORY", "OBSERVABILITY", "jev-decisions.jsonl")]; // stored ledger name, Jev retired 2026-10-10

export async function check(opts: { registryPath?: string; glanceLogs?: string[]; now?: number; emit?: (e: Record<string, unknown>) => unknown } = {}) {
  const now = opts.now ?? Date.now();
  const registry = JSON.parse(readFileSync(opts.registryPath ?? lifeosPath("USER", "CONFIG", "assay-callers.json"), "utf8")) as Registry;
  const firstSeen: Record<string, string> = {};
  for (const log of opts.glanceLogs ?? DEFAULT_GLANCE_LOGS()) {
    for (const [caller, ts] of Object.entries(await firstSeenByCaller(log))) if (!firstSeen[caller] || ts < firstSeen[caller]) firstSeen[caller] = ts;
  }
  const switches = glanceSwitches(registry, firstSeen, now); // the effort-routing switch went with effort routing (2026-10-25, ISA 20261025-doctrine-dedupe)
  const event = expiredEvent(switches, now);
  const sent = event && opts.emit ? opts.emit(event) : undefined;
  return { switches: switches.length, expired: switches.filter((s) => s.expired).length, emitted: Boolean(event && opts.emit && sent !== false), event, detail: switches };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] !== "check") { console.error("usage: ShadowExpiry.ts check [--json] [--emit]"); process.exit(2); }
  const emit = args.includes("--emit") ? ((e: Record<string, unknown>) => emitVigilEvent(e as never)) : undefined;
  const r = await check({ emit });
  if (args.includes("--json")) console.log(JSON.stringify({ switches: r.switches, expired: r.expired, emitted: r.emitted, title: r.event?.title ?? null }));
  else console.log(r.event ? `${r.event.title}\n${r.event.summary}` : `${r.switches} shadow switches, none past expiry`);
}
