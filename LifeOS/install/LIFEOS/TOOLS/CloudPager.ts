#!/usr/bin/env bun
/**
 * CloudPager.ts — turn the cloud site-health worker's red rows into a text on the principal's line.
 *
 * The cloud dead-man switch (the site-health worker) pages by email. A local watcher can go quiet
 * at night while the machine's scheduler is frozen, and an email alone can sit unread for hours.
 * OPERATIONAL_PREFERENCES § Urgent notifications:
 * anything he needs to know immediately is a text through Relay. So the always-on Pulse
 * process polls the worker's /status every 5 minutes and texts once per transition:
 * an app that just went red, an app that just recovered. Same-state polls stay silent.
 *
 * Named limit: this runs on the Mac. A sleeping or dead Mac still gets only the email leg.
 *
 *   bun LIFEOS/TOOLS/CloudPager.ts once [--dry-run]
 *
 * State: MEMORY/STATE/cloud-pager.json — { red: { <app name>: <since ISO> } }.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lifeosPath } from "./Paths.ts";
import { join } from "node:path";
import { heartbeatConfig } from "./Heartbeat.ts";
import { invariant } from "./Invariant.ts";
import { sendOwnText } from "./SchedulerWatch.ts";
import { inQuietHours } from "./QuietHours.ts";
import { textCard } from "./TextFormat.ts";

const STATE_PATH = lifeosPath("MEMORY", "STATE", "cloud-pager.json");

export interface StatusApp { name: string; state: string; url?: string; checks?: Array<{ label: string; ok: boolean }> }
export interface PagerState { red: Record<string, string> }
export interface Transitions { wentRed: StatusApp[]; recovered: string[]; next: PagerState }

// ── Pure (tested) ────────────────────────────────────────────────────────────

export function transitions(prev: PagerState, apps: StatusApp[], nowIso: string): Transitions {
  const next: PagerState = { red: {} };
  const wentRed: StatusApp[] = [];
  const seen = new Set<string>();
  for (const a of apps) {
    seen.add(a.name);
    if (a.state === "red") {
      next.red[a.name] = prev.red[a.name] ?? nowIso;
      if (!prev.red[a.name]) wentRed.push(a);
    }
  }
  // An app that was red and is now green — or vanished from the status entirely — recovered.
  const recovered = Object.keys(prev.red).filter((n) => !next.red[n]);
  return { wentRed, recovered, next };
}

/** Pages are capped here (F13); a card over the cap drops whole app lines, never half of one. */
export const PAGE_CAP = 380;
/**
 * The page (F13): one card per poll. A 🔴 card when anything went red (the title carries the full count, so lines dropped by the cap are
 * still counted), a ✅ card when only recoveries remain, one line per app either way.
 */
export function composePage(t: Transitions): string | null {
  const lines: string[] = [];
  for (const a of t.wentRed) {
    const why = a.checks?.find((c) => !c.ok)?.label ?? "failing";
    lines.push(`🔴 ${a.name} is down: ${why}.`);
  }
  for (const n of t.recovered) lines.push(`✅ ${n} recovered.`);
  if (lines.length === 0) return null;
  const down = t.wentRed.length, up = t.recovered.length, apps = (n: number) => `${n} app${n === 1 ? "" : "s"}`;
  const title = down && up ? `${apps(down)} down, ${up} recovered` : down ? `${apps(down)} down` : `${apps(up)} recovered`;
  return textCard({ kind: down ? "down" : "recovered", title, body: lines, cap: PAGE_CAP });
}

// ── IO ───────────────────────────────────────────────────────────────────────

export function readState(): PagerState | null {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")) as PagerState; } catch { return null; }
}

export function writeState(s: PagerState): void {
  invariant(s && typeof s.red === "object", "cloud-pager state must carry red");
  for (const [name, iso] of Object.entries(s.red)) invariant(name.length > 0 && !Number.isNaN(Date.parse(iso)), `red[${name}] must be an ISO time`);
  mkdirSync(join(STATE_PATH, ".."), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n");
}

export async function fetchStatus(): Promise<StatusApp[] | null> {
  const cfg = heartbeatConfig();
  if (!cfg) return null;
  try {
    const r = await fetch(`${cfg.url}/status`, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { apps?: StatusApp[] };
    return Array.isArray(j.apps) ? j.apps : null;
  } catch { return null; }
}

export async function once(opts: { dryRun: boolean }): Promise<{ polled: boolean; seeded?: string[]; wentRed: string[]; recovered: string[]; text: string | null; sent?: { ok: boolean; reason: string } }> {
  const apps = await fetchStatus();
  if (!apps) return { polled: false, wentRed: [], recovered: [], text: null };
  const nowIso = new Date().toISOString();
  const prev = readState();
  // First run ever: the pager reports TRANSITIONS from the moment it starts. Rows already
  // red were paged by the worker's email leg; texting them now would be a day-old alarm.
  // They are recorded as the baseline and named in the log line instead.
  if (!prev) {
    const seeded = transitions({ red: {} }, apps, nowIso).next;
    if (!opts.dryRun) writeState(seeded);
    return { polled: true, seeded: Object.keys(seeded.red), wentRed: [], recovered: [], text: null };
  }
  const t = transitions(prev, apps, nowIso);
  const text = composePage(t);
  let sent: { ok: boolean; reason: string } | undefined;
  if (text && !opts.dryRun && inQuietHours()) {
    // Quiet hours: send nothing and leave the ledger where it was, so a red that is still red
    // at the end of the window pages then, and one that recovered overnight never pages at all.
    return { polled: true, wentRed: t.wentRed.map((a) => a.name), recovered: t.recovered, text, sent: { ok: false, reason: "quiet hours" } };
  }
  if (text && !opts.dryRun) {
    sent = sendOwnText(text, "cloudpager");
    // Only advance the ledger when the page actually left; a failed send retries next poll.
    if (sent.ok) writeState(t.next);
  } else if (!text && !opts.dryRun) {
    writeState(t.next);
  }
  return { polled: true, wentRed: t.wentRed.map((a) => a.name), recovered: t.recovered, text, sent };
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd !== "once") { console.error("usage: CloudPager.ts once [--dry-run]"); process.exit(1); }
  const r = await once({ dryRun: args.includes("--dry-run") });
  console.log(JSON.stringify(r));
  process.exit(r.polled ? 0 : 3);
}
