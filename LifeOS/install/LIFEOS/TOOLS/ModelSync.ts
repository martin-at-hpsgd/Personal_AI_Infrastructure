#!/usr/bin/env bun
/**
 * @version 1.1.6
 * ModelSync — the Claude lineup and price table adjust themselves.
 *
 * Both facts live on public markdown pages that need no key:
 *   lineup  → https://platform.claude.com/docs/en/about-claude/models/overview.md
 *   pricing → https://platform.claude.com/docs/en/about-claude/pricing.md
 *
 * --sync   fetch both; bump CURRENT in models.ts when a tier has a NEWER id
 *          (never downgrades); rewrite model-pricing.json; record a snapshot.
 * --daily  --sync, then UpdateModels --cross-vendor --sync (same-class vendor
 *          proposal), then UpdateModels --check (consumer drift, reported, never fatal),
 *          then Calibrate.ts --recheck --page (re-run every judge
 *          calibration whose chain changed; page only on a drop below floor),
 *          lanes bump themselves after a live probe; cross-class stays a
 *          proposal), then re-run CarrierProbe when its fact is >25d old
 *          (the launchd job `com.lifeos.modelsync` runs this).
 * --check  offline gate for /ic: snapshot + pricing fresh (≤14d), registry not
 *          behind the snapshot, the settings.json carrier not behind CURRENT, and every
 *          ANTHROPIC_DEFAULT_<TIER>_MODEL alias pin in settings.json env equal to CURRENT.
 * --id <tier>  print CURRENT[tier] (for shell callers that need a literal id).
 *
 * Fail-closed: fewer than four tier ids, or any unparsable price, writes nothing.
 * Every fetch is bounded by AbortSignal.timeout. External page text is data —
 * only table cells that parse as a Claude id or a dollar figure are used.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { CURRENT, parseClaudeId, cmpClaudeVersion, canonicalId, type ClaudeTier } from "./models";
import { invariant } from "./Invariant";
import { getClaudeDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import type { RegistryExport } from "./ModelEstate";
import { emitSafe, laneMoves, modelSyncEvent } from "./ModelEstateVigil";
import type { VigilEvent } from "./lib/VigilOptional";
export { parseClaudeId, cmpClaudeVersion, canonicalId };

const HOME = process.env.HOME ?? homedir();
const CLAUDE_DIR = getClaudeDir();
const TOOLS = join(CLAUDE_DIR, "LIFEOS", "TOOLS");
export const REGISTRY_PATH = join(TOOLS, "models.ts");
export const PRICING_PATH = join(TOOLS, "model-pricing.json");
export const SNAPSHOT_PATH = join(CLAUDE_DIR, "LIFEOS", "MEMORY", "STATE", "model-sync.json");
const CARRIER_STATE = join(CLAUDE_DIR, "LIFEOS", "MEMORY", "STATE", "carrier-probe.json");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");

export const LINEUP_URL = "https://platform.claude.com/docs/en/about-claude/models/overview.md";
export const PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_AGE_DAYS = 14;
const PROBE_RENEW_DAYS = 25;

const TIERS: ClaudeTier[] = ["fable", "opus", "sonnet", "haiku"];

// ── page parsers (pure; fixtures drive the tests) ───────────────────────────

const cells = (line: string): string[] => line.split("|").slice(1, -1).map((c) => c.trim());

/** The "Claude API ID" row of the overview → tier → id. */
export function parseLineup(md: string): Partial<Record<ClaudeTier, string>> {
  const out: Partial<Record<ClaudeTier, string>> = {};
  const row = md.split("\n").find((l) => /^\|\s*Claude API ID\s*\|/i.test(l));
  if (!row) return out;
  for (const cell of cells(row)) {
    const id = cell.replace(/`/g, "").trim();
    const p = parseClaudeId(id);
    if (p?.tier && !out[p.tier]) out[p.tier] = id;
  }
  return out;
}

export type PriceRow = {
  displayName: string;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
};

const dollars = (cell: string): number | null => {
  const m = cell.match(/\$\s*([\d.]+)/);
  return m ? Number(m[1]) : null;
};

/** "Claude Fable 5.1 ([limited availability](…))" → { family: "fable", version: [5,1] }. */
export function parseDisplayName(name: string): { family: string; version: [number, number] } | null {
  const bare = name.replace(/\s*\(.*$/, "").replace(/\*+$/, "").trim();
  const m = bare.match(/^Claude\s+([A-Za-z]+)\s+(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  return { family: m[1].toLowerCase(), version: [Number(m[2]), Number(m[3] ?? 0)] };
}

/**
 * The main pricing table (header: Model | Base input | 5m cache writes |
 * 1h cache writes | Cache hits | Output). Keyed by canonical undated id.
 * Columns are located by header text, never by position.
 */
export function parsePricing(md: string): Record<string, PriceRow> {
  const lines = md.split("\n");
  const hi = lines.findIndex((l) => /^\|\s*Model\s*\|/.test(l) && /cache/i.test(l) && /output/i.test(l));
  if (hi < 0) return {};
  const header = cells(lines[hi]).map((h) => h.toLowerCase());
  const col = (re: RegExp): number => header.findIndex((h) => re.test(h));
  const ci = {
    input: col(/base input/),
    w5: col(/5m cache/),
    w1h: col(/1h cache/),
    read: col(/cache hits|cache read/),
    output: col(/output/),
  };
  if (Object.values(ci).some((i) => i < 0)) return {};
  const out: Record<string, PriceRow> = {};
  for (let i = hi + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    const c = cells(line);
    const name = parseDisplayName(c[0] ?? "");
    if (!name) continue;
    const vals = [c[ci.input], c[ci.w5], c[ci.w1h], c[ci.read], c[ci.output]].map((v) => dollars(v ?? ""));
    if (vals.some((v) => v === null || !(v > 0))) continue;
    const [input, cacheWrite5m, cacheWrite1h, cacheRead, output] = vals as number[];
    const id = canonicalId(name.family, name.version);
    // A model priced by prompt length (Claude Haiku 5.5) has one row per band. The standard band
    // ("for prompts up to N tokens") is the row we price by; a later "over N tokens" row never replaces it.
    if (out[id] && /\bover\b/i.test(c[0])) continue;
    out[id] = { displayName: c[0].replace(/\s*\(.*$/, "").trim(), input, cacheWrite5m, cacheWrite1h, cacheRead, output };
  }
  return out;
}

// ── io ──────────────────────────────────────────────────────────────────────

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "text/markdown, text/plain" } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return await r.text();
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

type Snapshot = { ts: string; lineup: Record<ClaudeTier, string>; bumped: Partial<Record<ClaudeTier, string>>; priced: number };

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

const ageDays = (iso: string, now: number = Date.now()): number => (now - Date.parse(iso)) / 86_400_000;

/** Age in days of a stored timestamp, or null when it is not a usable one. A missing, non-string,
 *  unparseable or future-dated (>1 day ahead) stamp yields null: Date.parse gives NaN and every
 *  `age > MAX` comparison on NaN is false, so a corrupt stamp used to read as fresh. */
export function validAgeDays(iso: unknown, now: number = Date.now()): number | null {
  if (typeof iso !== "string" || iso.trim() === "") return null;
  if (!Number.isFinite(Date.parse(iso))) return null;
  const age = ageDays(iso, now);
  return age < -1 ? null : age;
}

/** Rewrite one CURRENT.<tier> line. Mirrors UpdateModels.applyToRegistrySource; kept
 *  local so ModelSync stays importable without UpdateModels' scan machinery. */
export function bumpRegistrySource(src: string, tier: ClaudeTier, newId: string): string {
  const re = new RegExp(`(\\b${tier}:\\s*")[^"]+(")`);
  invariant(re.test(src), `CURRENT.${tier} line not found in registry source`);
  return src.replace(re, `$1${newId}$2`);
}

/** Alias pins: a settings.json env key ANTHROPIC_DEFAULT_<TIER>_MODEL makes every harness build resolve
 *  that alias to one id. Without it the alias follows whichever Claude Code build a session started on:
 *  once, most Sonnet dispatches ran the previous Sonnet in sessions still on 2.1.282/2.1.283,
 *  after 2.1.284 had moved `sonnet` to 5.5. A pin is only safe while it tracks CURRENT, so --sync moves
 *  it and --check fails on any drift. */
export const aliasPinKey = (t: ClaudeTier): string => `ANTHROPIC_DEFAULT_${t.toUpperCase()}_MODEL`;

export function aliasPinDrift(env: Record<string, string> | undefined, current: Record<ClaudeTier, string>): string[] {
  return TIERS.flatMap((t) => {
    const pinned = env?.[aliasPinKey(t)];
    return pinned !== undefined && pinned !== current[t] ? [`${aliasPinKey(t)}=${pinned} but CURRENT.${t}=${current[t]}`] : [];
  });
}

/** Rewrites existing pins to `current`; never adds a pin (which tiers are pinned is the principal's call). */
export function applyAliasPins(env: Record<string, string>, current: Record<ClaudeTier, string>): string[] {
  const moved: string[] = [];
  for (const t of TIERS) {
    const k = aliasPinKey(t);
    if (env[k] !== undefined && env[k] !== current[t]) { moved.push(`${k}: ${env[k]} → ${current[t]}`); env[k] = current[t]; }
  }
  invariant(aliasPinDrift(env, current).length === 0, "alias pins still drift after apply");
  return moved;
}

// ── commands ────────────────────────────────────────────────────────────────

export async function sync(): Promise<number> {
  const [lineupMd, pricingMd] = await Promise.all([fetchText(LINEUP_URL), fetchText(PRICING_URL)]);
  const lineup = parseLineup(lineupMd);
  const pricing = parsePricing(pricingMd);

  const missing = TIERS.filter((t) => !lineup[t]);
  if (missing.length) { console.error(`ModelSync: lineup page missing tier(s) ${missing.join(", ")} — page shape changed; nothing written`); return 1; }
  if (Object.keys(pricing).length < 4) { console.error(`ModelSync: pricing page yielded ${Object.keys(pricing).length} rows — page shape changed; nothing written`); return 1; }
  for (const t of TIERS) {
    const id = lineup[t]!;
    const p = parseClaudeId(id);
    invariant(p?.tier === t, `lineup id ${id} does not parse to tier ${t}`);
    invariant(pricing[canonicalId(t, p.version)], `no price row for lineup id ${id}`);
  }

  // registry: forward-only
  let src = readFileSync(REGISTRY_PATH, "utf8");
  const bumped: Partial<Record<ClaudeTier, string>> = {};
  for (const t of TIERS) {
    const fetched = lineup[t]!;
    const have = CURRENT[t];
    const d = cmpClaudeVersion(fetched, have);
    if (d > 0) { src = bumpRegistrySource(src, t, fetched); bumped[t] = fetched; }
    else if (d < 0) console.error(`ModelSync: registry ${t}=${have} is AHEAD of the docs page (${fetched}); leaving it`);
  }
  if (Object.keys(bumped).length) {
    atomicWrite(REGISTRY_PATH, src);
    // The registry export (models.json) follows every registry write: products and Atlas read it (Model Estate ISA ISC-6).
    { const r = Bun.spawnSync(["bun", join(import.meta.dir, "ModelEstate.ts"), "export"], { stdout: "pipe", stderr: "pipe" }); if (r.exitCode !== 0) console.error(`models.json regenerate FAILED: ${r.stderr.toString().trim()}`); }
  }

  // alias pins follow the registry, so a bump never leaves an alias on the old model
  const settings = readJson<{ env?: Record<string, string> }>(SETTINGS_PATH);
  if (settings?.env) {
    const moved = applyAliasPins(settings.env, { ...CURRENT, ...bumped } as Record<ClaudeTier, string>);
    if (moved.length) { atomicWrite(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n"); for (const m of moved) console.log(`  pin ${m}`); }
  }

  // pricing: current rows win; historical rows survive so old transcripts still price
  const prev = readJson<{ models: Record<string, PriceRow> }>(PRICING_PATH)?.models ?? {};
  const models = { ...prev, ...pricing };
  atomicWrite(PRICING_PATH, JSON.stringify({ fetched: new Date().toISOString(), source: PRICING_URL, models }, null, 2) + "\n");

  const snap: Snapshot = { ts: new Date().toISOString(), lineup: lineup as Record<ClaudeTier, string>, bumped, priced: Object.keys(models).length };
  atomicWrite(SNAPSHOT_PATH, JSON.stringify(snap, null, 2) + "\n");

  for (const t of TIERS) console.log(`  ${t}: ${bumped[t] ? `${CURRENT[t]} → ${bumped[t]}  (bumped)` : `${CURRENT[t]}  (current)`}`);
  console.log(`✅ ModelSync: lineup verified, ${Object.keys(pricing).length} price rows refreshed (${Object.keys(models).length} kept)`);
  return 0;
}

export interface CheckPaths { snapshot: string; pricing: string; settings: string; now?: number }
const DEFAULT_CHECK_PATHS: CheckPaths = { snapshot: SNAPSHOT_PATH, pricing: PRICING_PATH, settings: SETTINGS_PATH };

export function check(paths: CheckPaths = DEFAULT_CHECK_PATHS): number {
  const problems: string[] = [];
  const now = paths.now ?? Date.now();
  const snap = readJson<Snapshot>(paths.snapshot);
  const pricing = readJson<{ fetched: string; models: Record<string, PriceRow> }>(paths.pricing);
  if (!snap) problems.push(`never synced — run \`bun LIFEOS/TOOLS/ModelSync.ts --sync\``);
  else {
    const age = validAgeDays(snap.ts, now);
    if (age === null) problems.push(`lineup snapshot has an invalid timestamp (${JSON.stringify(snap.ts)}) — run --sync`);
    else if (age > MAX_AGE_DAYS) problems.push(`lineup snapshot ${Math.floor(age)}d old (>${MAX_AGE_DAYS}d) — is com.lifeos.modelsync loaded?`);
    if (!snap.lineup || typeof snap.lineup !== "object") problems.push(`lineup snapshot has no lineup — run --sync`);
  }
  if (!pricing) problems.push(`model-pricing.json missing — run --sync`);
  else {
    const age = validAgeDays(pricing.fetched, now);
    if (age === null) problems.push(`model-pricing.json has an invalid fetched timestamp (${JSON.stringify(pricing.fetched)}) — run --sync`);
    else if (age > MAX_AGE_DAYS) problems.push(`model-pricing.json ${Math.floor(age)}d old (>${MAX_AGE_DAYS}d)`);
    if (!pricing.models || typeof pricing.models !== "object") problems.push(`model-pricing.json has no models — run --sync`);
  }
  if (snap?.lineup && typeof snap.lineup === "object") {
    for (const t of TIERS) {
      const want = snap.lineup[t];
      if (want && parseClaudeId(want) && cmpClaudeVersion(CURRENT[t], want) < 0) problems.push(`registry ${t}=${CURRENT[t]} behind docs lineup ${want} — run --sync`);
    }
  }
  if (pricing?.models && typeof pricing.models === "object") {
    for (const t of TIERS) {
      const p = parseClaudeId(CURRENT[t]);
      if (p && !pricing.models[canonicalId(t, p.version)]) problems.push(`no price row for CURRENT.${t}=${CURRENT[t]}`);
    }
  }
  // the carrier: /model writes a pinned id; the only static pin the sync cannot rewrite
  // Missing, unreadable or invalid settings cannot show the carrier or the alias pins hold, so the
  // check fails: absence of evidence is not a pass.
  const settings = readJson<{ model?: string; env?: Record<string, string> }>(paths.settings);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) problems.push(`settings.json missing, unreadable or invalid (${paths.settings}) — carrier and alias pins cannot be verified`);
  const carrier = settings?.model ? parseClaudeId(settings.model) : null;
  if (carrier?.tier && cmpClaudeVersion(settings!.model!, CURRENT[carrier.tier]) < 0) {
    problems.push(`carrier: settings.json model is behind CURRENT.${carrier.tier}=${CURRENT[carrier.tier]} — run \`/model ${carrier.tier}\` (or the [1m] form) to move the session`);
  }
  for (const d of aliasPinDrift(settings?.env, CURRENT)) problems.push(`alias pin: ${d} — run --sync`);
  if (problems.length) { for (const p of problems) console.error(`ModelSync: ${p}`); return 1; }
  console.log(`ModelSync: HOLDS (synced ${snap!.ts}, ${Object.keys(pricing!.models).length} price rows; carrier ${settings?.model ?? "?"} at CURRENT)`);
  return 0;
}

/** The judge recalibration leg (ISC-48, 20260908-universal-eval-reeval): every
 *  calibration record whose judge chain no longer matches models.ts is re-run
 *  over the stored labels; only a drop from earned to provisional pages. */
export const CALIBRATE_TS = join(TOOLS, "..", "..", "skills", "Assay", "Tools", "Calibrate.ts");
export function recalibrateCommand(): string[] { return ["bun", CALIBRATE_TS, "--recheck", "--page"]; }

export interface DailyDeps {
  sync: () => Promise<number>;
  crossVendor: () => { error?: Error; status: number | null };
  /** After the bumps: every consumer still reads the registry (UpdateModels --check). Reports drift, never fails the daily. */
  consumerCheck: () => { error?: Error; status: number | null };
  /** Runs after the model registries settle, whether or not anything bumped: a fresh record is a no-op. */
  recalibrate: () => { error?: Error; status: number | null };
  probeStale: () => boolean;
  probe: () => void;
  /** The registry export as it is on disk now (moves are read from it before and after). Optional so tests stay offline. */
  readExport?: () => RegistryExport | null;
  /** Where the run's one Vigil line goes (Model Estate ISC-48). Optional so tests write nothing. */
  emitEvent?: (e: VigilEvent) => void;
}

const realDeps: DailyDeps = {
  sync,
  crossVendor: () => spawnSync("bun", [join(TOOLS, "UpdateModels.ts"), "--cross-vendor", "--sync"], { stdio: "inherit", timeout: 300_000 }),
  consumerCheck: () => spawnSync("bun", [join(TOOLS, "UpdateModels.ts"), "--check"], { stdio: "inherit", timeout: 120_000 }),
  recalibrate: () => { const [cmd, ...a] = recalibrateCommand(); return spawnSync(cmd!, a, { stdio: "inherit", timeout: 900_000 }); },
  probeStale: () => { const probe = readJson<{ ts: string; verdict: string }>(CARRIER_STATE); const age = probe ? validAgeDays(probe.ts) : null; return !probe || probe.verdict !== "HOLDS" || age === null || age > PROBE_RENEW_DAYS; },
  probe: () => execFileSync("bun", [join(TOOLS, "CarrierProbe.ts")], { stdio: "inherit", timeout: 300_000 }),
  readExport: () => readJson<RegistryExport>(join(TOOLS, "models.json")),
  emitEvent: (e) => { emitSafe(e); },
};

export async function daily(deps: DailyDeps = realDeps): Promise<number> {
  const before = deps.readExport?.() ?? null;
  const problems: string[] = [];
  const rc = await deps.sync();
  if (rc) problems.push(`Claude tier sync exited ${rc}.`);
  // Cross-vendor lanes (Google/OpenAI/xAI) follow the same standing rule
  // as the Claude tiers: always the latest of the same class. Exit 1 there means
  // a cross-class proposal is waiting, not a failure — never fails the daily.
  const cv = deps.crossVendor();
  if (cv.error) { console.error(`ModelSync: cross-vendor sync did not run: ${cv.error.message}`); problems.push("Cross-vendor sync did not run."); }
  else if (cv.status === 2) { console.error("ModelSync: cross-vendor rosters unavailable (keys/API) — nothing written"); problems.push("Cross-vendor rosters unavailable."); }
  else if (cv.status === 1) problems.push("A cross-class model is waiting on your call (UpdateModels --cross-vendor).");
  // Only 0, 1 and 2 mean the check ran. Anything else (a crash, a timeout's null) means it did not.
  else if (cv.status !== 0) { console.error(`ModelSync: cross-vendor check did not finish (exit ${cv.status ?? "timeout"})`); problems.push("Cross-vendor check crashed, so no vendor lane was checked."); }
  // A bump is only half the upgrade: a model id typed outside the registry stays on the old
  // model. Report it every day (a stale id can sit in a consumer after the bump).
  const cc = deps.consumerCheck();
  if (cc.error) console.error(`ModelSync: consumer drift check did not run: ${cc.error.message}`);
  else if (cc.status) { console.error("ModelSync: CONSUMER DRIFT — model ids hardcoded outside models.ts (see UpdateModels --check above); run the Upgrade Models intent"); problems.push("Model ids are hardcoded outside the registry."); }
  // Judges ride these registries: the Claude tiers and the OpenAI lanes are the
  // judge chain. Re-run stale calibrations now, after both syncs, every day —
  // the recheck reads the chain hash, so nothing bumped means nothing re-run.
  const rcal = deps.recalibrate();
  if (rcal.error) console.error(`ModelSync: calibration recheck did not run: ${rcal.error.message}`);
  else if (rcal.status) console.error(`ModelSync: calibration recheck exited ${rcal.status} (a record could not be re-run; see Calibrate.ts --recheck)`);
  const after = deps.readExport?.() ?? null;
  if (deps.emitEvent && after) deps.emitEvent(modelSyncEvent(laneMoves(before, after), problems, new Date().toISOString().slice(0, 10)));
  if (deps.probeStale()) {
    console.log("ModelSync: carrier-probe fact stale — re-probing");
    try { deps.probe(); }
    catch (e) { console.error(`ModelSync: CarrierProbe failed: ${(e as Error).message}`); return rc || 1; }
  }
  return rc;
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "--sync") process.exit(await sync());
  else if (cmd === "--daily") process.exit(await daily());
  else if (cmd === "--check") process.exit(check());
  else if (cmd === "--id" && arg && (TIERS as string[]).includes(arg)) { console.log(CURRENT[arg as ClaudeTier]); process.exit(0); }
  else { console.error("Usage: ModelSync.ts --sync | --daily | --check | --id <fable|opus|sonnet|haiku>"); process.exit(2); }
}
