/**
 * The Mac's side of the cloud clock (WORKFLOWS ISA F27, ISC-318, ISC-319). The `wf-clock` Worker owns time for every
 * local workflow; each dispatcher pass sends it the definitions' time triggers when they change, leases the runs it
 * has queued, hands each to the local queue through `submit`, and reports what happened. The Mac keeps no clock of
 * its own while the cloud answers. After FALLBACK_AFTER_MS without an answer the dispatcher runs its own clock again
 * from the last answer, so an internet outage never stops Mac-only work; the ledger's occurrence keys stop the cloud
 * and the fallback from starting one occurrence twice.
 *
 * Config: the Worker URL in LIFEOS/USER/CONFIG/workflows-clock.json (`{"url": "https://..."}`); the bearer token in
 * the login Keychain under service `lifeos-workflows-clock`, never in a file or the environment.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { invariant } from "../../TOOLS/Invariant.ts";
import { getClaudeDir } from "../../TOOLS/Paths.ts";
import { principalTimezone } from "../../TOOLS/lib/Timezone.ts";
import { isTimeTrigger, type TimeTrigger } from "./clock.ts";
import type { DefinitionV2 } from "./format.ts";
import { writeFileAtomic } from "./ledger.ts";

export const KEYCHAIN_SERVICE = "lifeos-workflows-clock";
export const FALLBACK_AFTER_MS = 10 * 60_000;
/** A cloud whose cron has not ticked for this long is not an answer, however quickly it replies (a clock that answers but never fires). */
export const TICK_STALE_MS = 3 * 60_000;
const RESYNC_MS = 3_600_000;
const LEASE_MAX = 50;
const TIMEOUT_MS = 15_000;

export function clockConfigPath(): string {
  return join(getClaudeDir(), "LIFEOS", "USER", "CONFIG", "workflows-clock.json");
}

export interface SyncBody {
  zone: string;
  /** `since`: the Mac's last evaluation, so a workflow new to the cloud starts where the Mac stopped. */
  workflows: Array<{ name: string; alert?: string; triggers: TimeTrigger[]; since?: string }>;
  /** Workflows whose definition did not load this pass; the cloud keeps them as they were. */
  keep?: string[];
}

export interface LeasedRun {
  id: string;
  workflow: string;
  occurrence_key: string;
  due_at: string;
  attempts: number;
}

export type Outcome = "submitted" | "duplicate" | "skipped" | "refused";

export interface ClockClient {
  worker: string;
  sync(body: SyncBody): Promise<void>;
  lease(max: number): Promise<{ runs: LeasedRun[]; last_tick: string | null }>;
  complete(id: string, outcome: Outcome, detail?: string): Promise<void>;
}

export function httpClockClient(url: string, token: string, fetcher: typeof fetch = fetch, worker: string = hostname()): ClockClient {
  invariant(/^https:\/\//.test(url), "the clock URL is https");
  const call = async (path: string, body: unknown): Promise<unknown> => {
    const res = await fetcher(`${url.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`clock ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  return {
    worker,
    async sync(body) { await call("/sync", body); },
    async lease(max) { return (await call("/lease", { worker, max })) as { runs: LeasedRun[]; last_tick: string | null }; },
    async complete(id, outcome, detail) { await call("/complete", { id, outcome, ...(detail ? { detail } : {}) }); },
  };
}

function keychainToken(): string | null {
  const r = Bun.spawnSync(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
  const token = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  return token || null;
}

/**
 * The configured client, or null when this Mac has no cloud clock (the dispatcher then keeps its own). A broken config
 * is logged and read as no cloud clock: a typo here must never stop every clock on the Mac.
 */
export function configuredClock(path: string = clockConfigPath(), token: () => string | null = keychainToken): ClockClient | null {
  if (!existsSync(path)) return null;
  try {
    const { url } = JSON.parse(readFileSync(path, "utf8")) as { url?: string };
    const secret = url ? token() : null;
    return url && secret ? httpClockClient(url, secret) : null;
  } catch (e) {
    console.error(`dispatcher: ${path} is unusable (${e instanceof Error ? e.message : String(e)}); keeping the Mac clock`);
    return null;
  }
}

/**
 * What the cloud schedules: every enabled local workflow with a live time trigger, nothing else. `since` gives each the
 * Mac's last evaluation so the cutover leaves no gap; `keep` names definitions that failed to load this pass.
 */
export function syncPayload(defs: Iterable<DefinitionV2>, zone: string, since: (name: string) => string | undefined = () => undefined, keep: string[] = []): SyncBody {
  const workflows: SyncBody["workflows"] = [];
  for (const def of defs) {
    if (def.runs_on !== "local" || def.enabled === false) continue;
    const triggers = def.triggers.filter(isTimeTrigger);
    const last = since(def.name);
    if (triggers.length) workflows.push({ name: def.name, alert: def.alert, triggers, ...(last ? { since: last } : {}) });
  }
  workflows.sort((a, b) => a.name.localeCompare(b.name));
  return { zone, workflows, ...(keep.length ? { keep: [...keep].sort() } : {}) };
}

export interface ClockState {
  /** The last pass the cloud answered. */
  last_ok?: string;
  sync_hash?: string;
  sync_at?: string;
  /** Set while the Mac is running its own clock because the cloud has not answered. */
  fallback_since?: string;
}

const statePath = (stateDir: string) => join(stateDir, "cloud-clock.json");

export function readClockState(stateDir: string): ClockState {
  try {
    return JSON.parse(readFileSync(statePath(stateDir), "utf8")) as ClockState;
  } catch {
    return {};
  }
}

export function writeClockState(stateDir: string, state: ClockState): void {
  invariant(!state.last_ok || Number.isFinite(Date.parse(state.last_ok)), "last_ok is a timestamp");
  writeFileAtomic(statePath(stateDir), `${JSON.stringify(state)}\n`);
}

/** Sends the schedule set when it changed, or hourly so a lost sync heals. */
export async function syncIfChanged(client: ClockClient, defs: Iterable<DefinitionV2>, state: ClockState, now: Date, opts: { zone?: () => string; since?: (name: string) => string | undefined; keep?: string[] } = {}): Promise<boolean> {
  const body = syncPayload(defs, (opts.zone ?? principalTimezone)(), opts.since, opts.keep);
  // `since` moves while the Mac runs its own clock; it matters only for a workflow the cloud has not seen, so it is left out of the change check.
  const hash = createHash("sha256").update(JSON.stringify({ ...body, workflows: body.workflows.map(({ since: _s, ...w }) => w) })).digest("hex");
  if (hash === state.sync_hash && state.sync_at && now.getTime() - Date.parse(state.sync_at) < RESYNC_MS) return false;
  await client.sync(body);
  state.sync_hash = hash;
  state.sync_at = now.toISOString();
  return true;
}

export { LEASE_MAX };
