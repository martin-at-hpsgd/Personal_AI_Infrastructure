/**
 * Relay F26: the bridge texts itself, so a broken line is found by a check and not by {{PRINCIPAL_NAME}}.
 *
 * From 10-10 to 10-20 four separate causes broke texting (a capped account, the guard self-check, a dropped SMS,
 * orphan bridges) and each was found by {{PRINCIPAL_NAME}}'s own text failing. The check runs one real turn through askDA from
 * inside the bridge, so it sees the bridge's own PATH, account, guard and code version, and counts bridge processes.
 */
import { randomUUID } from "node:crypto";
import { FAILURE_TEXT } from "./session.ts";
import { countBridges } from "../../TOOLS/RelayStatus.ts";

export { countBridges };

/** Synthetic; never a real line. The same id Probe.ts uses, so the guard and stores already treat it as a probe. */
export const HEALTH_SENDER = "+10000000000";
export const HEALTH_PROMPT = "This is Relay's scheduled self-check, not a request from anyone. Reply with exactly: OK";
const FAILURES: readonly string[] = [FAILURE_TEXT.guard, FAILURE_TEXT.spawn, FAILURE_TEXT.error];

export interface HealthTurn { text: string; timedOut?: boolean; parseError?: boolean; failure?: string; error?: string }
export interface HealthEvent { severity: "high" | "info"; title: string; summary: string }

/** What is wrong with one check, or nothing (ISC-367, ISC-368). */
export function problems(turn: HealthTurn, bridges: number): string[] {
  const out: string[] = [];
  const text = turn.text.trim();
  if (turn.failure || turn.timedOut || turn.parseError || !text || FAILURES.includes(text) || text.startsWith("⏱️ That ran past"))
    out.push(`the test text failed (${turn.failure ?? (turn.timedOut ? "timeout" : turn.parseError ? "parse error" : text ? "failure text" : "empty reply")}${turn.error ? `: ${turn.error.slice(0, 160)}` : ""})`);
  if (bridges !== 1) out.push(`${bridges} bridge processes are running, not 1`);
  return out;
}

/** Event only on a change of state, so a break lasting hours texts once and its end texts once (ISC-369). */
export function transition(wasFailing: boolean, found: string[]): HealthEvent | null {
  if (found.length > 0 && !wasFailing) return { severity: "high", title: "Texting is broken", summary: `My hourly self-check found: ${found.join("; ")}. Texts to me may fail until this is fixed.` };
  if (found.length === 0 && wasFailing) return { severity: "info", title: "Texting is working again", summary: "My hourly self-check passed after a failure." };
  return null;
}

export async function writeHealthEvent(e: HealthEvent): Promise<void> {
  const { writeEvent } = await import("../../STATVS/index.ts");
  const ts = new Date().toISOString();
  // transition() already sends one event per change of state, so each event gets its own key.
  const r = writeEvent({
    id: randomUUID(), source: "relay-health", ts, kind: "infra", severity: e.severity,
    title: e.title, summary: e.summary, ref: null, url: null, privacy_class: "personal",
    dedup_key: `relay-health:${e.severity}:${ts}`,
  }) as { ok: boolean; refused?: string };
  if (!r.ok) throw new Error(`relay-health event refused: ${r.refused}`);
}

export interface HealthDeps {
  ask: () => Promise<HealthTurn>;
  bridges: () => number;
  emit: (e: HealthEvent) => Promise<void>;
  log: (event: string, data?: Record<string, unknown>) => void;
}

/** Runs checks forever: the first `firstMs` after start (a restart is when things break), then every `everyMs`. */
export function startHealthCheck(d: HealthDeps, firstMs = 2 * 60_000, everyMs = 60 * 60_000): { runOnce: () => Promise<string[]> } {
  let failing = false, running = false;
  const runOnce = async (): Promise<string[]> => {
    if (running) return [];
    running = true;
    try {
      let turn: HealthTurn;
      try { turn = await d.ask(); } catch (error) { turn = { text: "", failure: "exception", error: String(error) }; }
      const found = problems(turn, d.bridges());
      d.log(found.length ? "health_failed" : "health_ok", found.length ? { problems: found } : {});
      const event = transition(failing, found);
      failing = found.length > 0;
      if (event) await d.emit(event).catch((error) => d.log("health_event_failed", { error: String(error).slice(0, 200) }));
      return found;
    } finally { running = false; }
  };
  setTimeout(() => { void runOnce(); setInterval(() => { void runOnce(); }, everyMs).unref(); }, firstMs).unref();
  return { runOnce };
}
