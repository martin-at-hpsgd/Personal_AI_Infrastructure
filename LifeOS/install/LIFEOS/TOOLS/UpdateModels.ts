#!/usr/bin/env bun
/**
 * @version 1.6.3
 * ============================================================================
 * UpdateModels — drift check + safe registry bump for model IDs
 * ============================================================================
 *
 * The companion to models.ts. Two modes, propose-not-auto by design:
 *
 *   bun UpdateModels.ts --check
 *     Offline. Scans the live tree for pinned Claude IDs that don't match the
 *     registry (models.ts CURRENT), Claude ids from older generations in the
 *     version-first shape (claude-3-5-sonnet-*, claude-4-5-haiku, claude-2.x,
 *     claude-instant), hardcoded non-Claude vendor IDs that bypass CROSS_VENDOR,
 *     and OpenAI/Google/xAI ids older than the registry's lanes (an older
 *     generation, or a superseded version of a lane's own family) in code,
 *     config and instructions. Excludes SCAN_EXCLUDES (history, vendored
 *     upstream, tests and parse fixtures, price tables). A line carrying the
 *     marker `model-id-example` is an id-shape example a parser must accept,
 *     never a selection, and is skipped by every scan.
 *     Exit 0 = no drift, 1 = drift, 2 = scan error.
 *
 *   bun UpdateModels.ts --cross-vendor [--sync]
 *     Network. Probes each vendor's LIVE model roster (Google, OpenAI,
 *     xAI) with keys from ~/.claude/.env and reports per CROSS_VENDOR
 *     pin: CURRENT / NEWER (candidates) / MISSING / roster-unavailable.
 *     With --sync, a NEWER candidate in the SAME CLASS (same family, stability
 *     not lower: GA->GA, preview->GA, preview->preview) is live-probed with our
 *     key and, on success, written to CROSS_VENDOR — the principal's standing
 *     rule (2026-09-03): always the latest model of the same class. Cross-class
 *     (flash->pro) or GA->preview stays a proposal. Probe failure = no write.
 *     ModelSync --daily runs --sync every day; Upgrade runs it too.
 *
 *   bun UpdateModels.ts --apply <tier> <new-id>
 *     Rewrites ONLY models.ts CURRENT[tier] to <new-id>. Touches nothing else —
 *     consumers either use aliases (auto-track) or import the registry. After
 *     applying, re-run --check to confirm the tree is clean.
 *
 * ON A NEW RELEASE `ModelSync.ts --sync` (daily launchd job; also triggered by
 * ModelDriftGuard when a session already serves a newer id) bumps the registry
 * forward from Anthropic's public models page. --apply remains for a manual
 * override. This tool's job is the consumer sweep: pins that are stale, pinned-
 * but-current (landmines), or AHEAD of the registry (run --sync).
 * ============================================================================
 */

import { readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync, existsSync, mkdtempSync, rmSync } from "fs";
import { join, dirname } from "path";
import { homedir, tmpdir } from "os";
import { invariant } from "./Invariant";
import { CURRENT, EFFORT_MODEL, CLAUDE_ID_PATTERN, CROSS_VENDOR, cmpClaudeVersion, parseClaudeId, type ClaudeTier } from "./models";

const CLAUDE_DIR = join(import.meta.dir, "..", "..");
const REGISTRY_PATH = join(import.meta.dir, "models.ts");

/**
 * Paths excluded from drift scanning. The scan targets LIVE single-pin drift —
 * a dated ID where an alias or the registry should be. It deliberately ignores:
 *   - vendored / third-party code (we don't own its model refs)
 *   - frozen records (historical doctrine, eval run artifacts, ISA evidence)
 *   - test fixtures (intentionally use old/new IDs)
 *   - recognition/price maps (cost-aggregator, Evals graders) — these list many
 *     historical IDs on purpose; a missing entry falls through, it isn't drift
 *   - the registry + its own docs (they cite old IDs to explain themselves)
 */
export const SCAN_EXCLUDES = [
  "node_modules",
  "LIFEOS_RELEASES",
  "profile-data",
  "plugins/",            // third-party marketplace plugins
  "Plugins/",            // ditto, capitalized marketplace root
  "/tests/",             // test dirs (plural) — fixtures pin arbitrary IDs
  "LIFEOS/TOOLS/UpdateModels.ts", // this file's own regex/example IDs
  "/settings.json",         // the carrier: /model writes a pinned id by harness design; ModelSync --check + ModelDriftGuard own it
  "LIFEOS/ALGORITHM/v",     // historical doctrine snapshots keep their period IDs
  "ALGORITHM/changelog.md", // the changelog records what WAS current at each version
  "/State/",                // skill runtime state (cached scan results), not source
  "MEMORY/WORK",         // ISA bodies may quote IDs as evidence
  "ISA.md",              // every ISA (project ISAs too) quotes ids as evidence of what ran, never as a selection
  "history.jsonl",
  "cache/",
  // Harness runtime data, not source: transcripts, telemetry, edit snapshots,
  // plan files and backup copies (public issue #2270, @mj-deving).
  // Anchored to the config root so tracked source such as a `src/app/projects/`
  // route is still scanned.
  join(CLAUDE_DIR, "projects") + "/",
  join(CLAUDE_DIR, "telemetry") + "/",
  join(CLAUDE_DIR, "file-history") + "/",
  join(CLAUDE_DIR, "plans") + "/",
  ".bak",
  "/test/",              // test fixtures intentionally use old/new IDs
  ".test.",              // ditto for co-located tests (.test.ts/.test.mjs — e.g. Inference.verification.test.ts,
                         // whose mock modelUsage envelopes pin arbitrary IDs by design)
  "Evals/",              // evals PIN a model on purpose — reproducible apples-to-apples comparison; aliasing would break the eval
  "Assay/",              // the eval skill's own dir, pinned for the same reason
  "cost-aggregator",     // historical price table keyed by past model IDs
  "model-pricing.json",  // generated price table — every row is a past or present id on purpose
  "TOOLS/models.json",   // generated registry export (ModelEstate.ts) — a copy of models.ts by design
  "LIFEOS/TOOLS/models.ts", // the registry cites superseded IDs in comments
  "DOCUMENTATION/",      // docs reference old IDs as examples
  // Policy exclusions (principal 2026-10-11 old-model cleanup): vendored upstream content, dated
  // history, and fixtures whose purpose is parsing or comparing old ids.
  "skills/Fabric/Patterns/", // vendored upstream Fabric patterns; we do not own their model refs
  "MEMORY/",             // dated history: sessions, decisions, observability logs
  "CHANGELOG",           // changelogs record what was current at each version
  "changelog",
  "/fixtures/",          // parse and comparison fixtures pin old ids on purpose
  "/Fixtures/",
  "vendor-pricing.json", // price table keyed by past and present vendor ids, like model-pricing.json
];

/** Marker that exempts one line from every --check scan: the id on it is an example of an id
 * SHAPE a parser must accept (Raycast's `anthropic-claude-4-5-haiku`), never a model selection. */
export const EXAMPLE_MARKER = "model-id-example";

/** `ahead` = a pinned id NEWER than the registry: the registry is what's stale,
 *  and `ModelSync --sync` (not a consumer edit) is the fix. */
export type DriftHit = { id: string; tier: ClaudeTier; status: "current" | "stale" | "ahead" };

/** Tier of a Claude ID, or null if unparseable. */
export function tierOf(id: string): ClaudeTier | null {
  const m = id.match(/claude-(opus|sonnet|haiku|fable)-/);
  return m ? (m[1] as ClaudeTier) : null;
}

/** Classify a found Claude ID against the registry. Pure — drives the tests. */
export function classify(id: string): DriftHit | null {
  const tier = tierOf(id);
  if (!tier) return null;
  if (id === CURRENT[tier]) return { id, tier, status: "current" };
  let d = -1;
  try { d = cmpClaudeVersion(id, CURRENT[tier]); } catch { /* unparsable → stale */ }
  return { id, tier, status: d > 0 ? "ahead" : "stale" };
}

/**
 * Rewrite the CURRENT[tier] line in models.ts source. Pure string transform so
 * tests can exercise it without disk I/O. Returns the new source, or throws if
 * the tier line isn't found (fail loud — never silently no-op a bump).
 */
export function applyToRegistrySource(src: string, tier: ClaudeTier, newId: string): string {
  const bad = claudeIdProblem(tier, newId);
  invariant(bad === null, `refusing to write model id into TypeScript source: ${bad}`);
  const re = new RegExp(`(\\b${tier}:\\s*")[^"]+(")`);
  if (!re.test(src)) throw new Error(`CURRENT.${tier} line not found in registry source`);
  // A function replacer: a string replacement would read `$&`, `$'` and `$1` inside the id as patterns.
  return src.replace(re, (_m, a: string, b: string) => `${a}${newId}${b}`);
}

/** The whole id, anchored: tier, version digits and an optional date, nothing else. No quote, backslash, `$` or line break can match. */
const CLAUDE_FULL_ID = /^claude-(opus|sonnet|haiku|fable)-\d+(?:-\d+)?(?:-\d{8})?$/;
/** A cross-vendor id (`gemini-3.7-flash`, `z-ai/glm-5.2`, `gpt-5.6-sol`): a short run of id characters only. */
const VENDOR_FULL_ID = /^[A-Za-z0-9][A-Za-z0-9._\/:-]{0,100}$/;
const LANE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Why `id` may not be written as CURRENT[tier], or null when it may. */
export function claudeIdProblem(tier: string, id: string): string | null {
  if (typeof id !== "string" || !CLAUDE_FULL_ID.test(id)) return `'${String(id).slice(0, 60)}' is not a full Claude model id (claude-<tier>-<major>[-<minor>][-<YYYYMMDD>])`;
  if (tierOf(id) !== tier) return `'${id}' is not a ${tier} id`;
  return null;
}
/** Why `id` may not be written as a CROSS_VENDOR pin, or null when it may. */
export function vendorIdProblem(id: string): string | null {
  return typeof id === "string" && VENDOR_FULL_ID.test(id) ? null : `'${String(id).slice(0, 60)}' is not a plain model id`;
}

/**
 * Write the new registry source, then regenerate the models.json export from it. The two files must agree: when the export
 * fails, models.ts is put back to `original` and the call reports failure, so a success exit means both are updated.
 */
export function commitRegistry(path: string, original: string, next: string, runExport: () => string | null = runRegistryExport): string | null {
  writeFileSync(path, next);
  const err = runExport();
  if (err === null) return null;
  writeFileSync(path, original);
  return `models.json regenerate FAILED (${err}); models.ts restored to its previous content, nothing changed`;
}
/** The registry export (models.json) follows every registry write: products and Atlas read it (Model Estate ISA ISC-6). Null = ok, else the error. */
function runRegistryExport(): string | null {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "ModelEstate.ts"), "export"], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? null : (r.stderr.toString().trim() || `exit ${r.exitCode}`);
}

/**
 * Find Claude model IDs in arbitrary text (e.g. a changelog digest) that the
 * registry does NOT recognize — candidates for a just-released model. Pure and
 * deduped so the news skill monitor and tests can both call it. A human triages the
 * result (propose-not-auto); old IDs quoted in news may also surface, which is
 * fine for a flag.
 */
export function detectNewModelIds(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(CLAUDE_ID_PATTERN)) {
    const id = m[0];
    const hit = classify(id);
    if (hit && hit.status !== "current") seen.add(id); // a just-released id classifies "ahead"
  }
  return [...seen];
}

export const MODEL_RELEASES_PATH = join(CLAUDE_DIR, "LIFEOS", "MEMORY", "OBSERVABILITY", "model-releases.jsonl");

/**
 * Build the propose-not-auto action commands for detected IDs. Each is a full,
 * runnable two-step (apply the bump, then re-check). Pure — drives the test.
 * NOTE: deliberately NOT the memory pending-proposals queue — that queue
 * applies *text edits to markdown sections* (applyProposalEdit appends under a
 * header), which cannot rewrite the registry's TS const. A model bump is a
 * command, not a text-append, so it gets its own surface + a /notify.
 */
export function buildActionCommands(ids: string[]): string[] {
  return ids.map((id) => {
    const t = tierOf(id);
    return t
      ? `bun ~/.claude/LIFEOS/TOOLS/UpdateModels.ts --apply ${t} ${id} && bun ~/.claude/LIFEOS/TOOLS/UpdateModels.ts --check`
      : `review ${id} (unparseable tier)`;
  });
}

/**
 * Record a detected model release to a dedicated log and best-effort notify the
 * principal. Propose-not-auto: never bumps the registry. `logPath` is injectable
 * for tests. Returns the row written (for assertions).
 */
export function emitModelProposal(
  ids: string[],
  source: string,
  nowIso: string,
  logPath: string = MODEL_RELEASES_PATH,
  notify: boolean = true,
): Record<string, unknown> | null {
  if (ids.length === 0) return null;
  const row = {
    ts: nowIso,
    kind: "model-release",
    source,
    detected_ids: ids,
    registry: CURRENT,
    action: buildActionCommands(ids),
    note: "Propose-only. New Claude model ID detected; review, then run the action command to bump the registry.",
  };
  // The append→write fallback below cannot help when the DIRECTORY is missing;
  // git cannot track an empty dir, so it is absent on a fresh clone. (public PR #2030, @abseg)
  try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* best-effort; the write below reports */ }
  try {
    appendFileSync(logPath, JSON.stringify(row) + "\n");
  } catch {
    writeFileSync(logPath, JSON.stringify(row) + "\n");
  }
  // Best-effort reach the principal — never let a notify failure break the caller.
  if (notify) try {
    Bun.spawnSync(
      ["curl", "-sk", "-m", "5", "-X", "POST", "http://localhost:31337/notify",
       "-H", "Content-Type: application/json",
       "-d", JSON.stringify({ message: `New Claude model detected: ${ids.join(", ")}. Review and run UpdateModels --apply.`, voice_enabled: true })],
      { stdout: "ignore", stderr: "ignore" },
    );
  } catch { /* notify is best-effort */ }
  return row;
}

function isExcluded(path: string): boolean {
  return SCAN_EXCLUDES.some((ex) => path.includes(ex));
}

/* ============================================================================
 * CROSS-VENDOR FRESHNESS — model staleness across ALL lanes surfaces on every
 * Upgrade run without being asked (rule owned by the Upgrade skill)
 *
 * Two layers, same propose-not-auto contract as the Claude side:
 *   --check         (offline)  also sweeps the live tree for hardcoded
 *                              non-Claude vendor IDs that bypass CROSS_VENDOR
 *   --cross-vendor  (network)  probes each vendor's LIVE roster with our keys
 *                              and reports, per pin: CURRENT / NEWER / MISSING
 * Nothing here ever writes models.ts — a roster listing proves availability,
 * not approval; vendor-lane approvals are the principal's.
 * ==========================================================================*/

/** Non-Claude vendor ID candidates in tree text. Digit required after the
 * family word so prose like "Gemini3" or filenames don't match. */
export const VENDOR_ID_PATTERN =
  /\b(?:gpt-\d[A-Za-z0-9.-]*|gemini-\d[A-Za-z0-9.-]*|grok-\d[A-Za-z0-9.-]*|glm-\d[A-Za-z0-9.-]*|sonar(?:-[a-z]+)*|whisper-\d|flux-\d[A-Za-z0-9.-]*|chirp-v[0-9-]+)\b/g;

/** Media/voice/search ids (2026-09-22 lanes): always a real model selection, so
 * they skip the version-shape heuristic below. */
const MEDIA_ID = /^(?:sonar(?:-[a-z]+)*|whisper-\d|flux-\d[A-Za-z0-9.-]*|chirp-v[0-9-]+)$/;

export type Stability = "ga" | "preview" | "alias";
export type ParsedModel = { family: string; version: number[]; stability: Stability };

const STABILITY_TOKENS = new Set(["preview", "exp", "experimental", "eap", "beta"]);

/** Parse a vendor model ID into a comparable shape. Provider prefixes
 * ("x-ai/", "z-ai/") are stripped; the FIRST numeric token is the version;
 * later numeric tokens (dates) and stability words drop out of the family. */
export function parseModelId(id: string): ParsedModel {
  const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  const tokens = bare.split("-");
  const familyParts: string[] = [];
  let version: number[] = [];
  let stability: Stability = "ga";
  for (const t of tokens) {
    if (t === "latest") { stability = "alias"; continue; }
    if (STABILITY_TOKENS.has(t)) { stability = stability === "alias" ? "alias" : "preview"; continue; }
    if (/^\d+(?:\.\d+)*$/.test(t)) {
      if (version.length === 0) version = t.split(".").map(Number);
      continue; // later numeric tokens are dates — not family, not version
    }
    familyParts.push(t);
  }
  return { family: familyParts.join("-"), version, stability };
}

function cmpVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type LaneVerdict = {
  lane: string;
  pin: string;
  status: "CURRENT" | "NEWER" | "MISSING" | "ALIAS" | "NO-ROSTER";
  candidates: string[]; // newer-than-pin roster IDs, best first
};

/** A roster entry: a bare ID, or an ID with the vendor's release timestamp
 * (epoch seconds) when the API provides one (OpenRouter, OpenAI). */
export type RosterEntry = string | { id: string; created?: number };
const entryId = (e: RosterEntry): string => (typeof e === "string" ? e : e.id);
const entryCreated = (e: RosterEntry): number | undefined => (typeof e === "string" ? undefined : e.created);

/** Judge one CROSS_VENDOR pin against a live roster. Pure — drives the tests.
 * NEWER when a same-family roster entry is a strictly LATER RELEASE (by the
 * vendor's own timestamp, the only reliable cross-vendor ordering — xAI ships
 * "grok-4.20" (Mar) older than "grok-4.6" (Aug), which pure version math gets
 * backwards). Only when neither entry carries a date does it fall back to
 * version compare, plus the same-version GA-over-preview rule. */
export function laneVerdict(lane: string, pin: string, roster: RosterEntry[]): LaneVerdict {
  const p = parseModelId(pin);
  if (p.stability === "alias") {
    // An alias is the vendor's own always-latest pointer, so it never rots; a
    // gated/Trusted-Access model legitimately never appears in the public
    // /models roster, so absence is unverifiable, never MISSING.
    return { lane, pin, status: "ALIAS", candidates: [] };
  }
  const matchesPin = (id: string) => id === pin || id.endsWith("/" + pin);
  const pinEntry = roster.find((r) => matchesPin(entryId(r)));
  const pinDate = pinEntry ? entryCreated(pinEntry) : undefined;

  const newer = roster
    .map((r) => ({ id: entryId(r), created: entryCreated(r), m: parseModelId(entryId(r)) }))
    .filter(({ m }) => m.family === p.family && m.stability !== "alias")
    .filter(({ id }) => !matchesPin(id))
    .filter(({ created, m }) => {
      // Prefer the release date when both sides have one — the trustworthy signal.
      if (pinDate !== undefined && created !== undefined) return created > pinDate;
      // No dates: version math, with the same-version GA-over-preview bump.
      const v = cmpVersion(m.version, p.version);
      return v > 0 || (v === 0 && p.stability === "preview" && m.stability === "ga");
    })
    .sort((a, b) =>
      a.created !== undefined && b.created !== undefined
        ? b.created - a.created
        : cmpVersion(b.m.version, a.m.version) || (a.m.stability === "ga" ? -1 : 1),
    )
    .map(({ id }) => id);
  if (newer.length > 0) return { lane, pin, status: "NEWER", candidates: newer };
  return { lane, pin, status: pinEntry ? "CURRENT" : "MISSING", candidates: [] };
}

const STABILITY_RANK: Record<Stability, number> = { preview: 0, ga: 1, alias: 2 };

/** Same class = same family AND the candidate is at least as stable as the pin.
 * gemini-3.7-flash -> gemini-3.8-flash: yes. gemini-3-pro-image-preview ->
 * gemini-3-pro-image: yes (GA graduation). gemini-3.8-flash -> a 3.9 preview: no
 * (GA->preview). flash -> pro: no (family). Pure — drives the tests. */
export function sameClass(pin: string, candidate: string): boolean {
  const a = parseModelId(pin);
  const b = parseModelId(candidate);
  if (a.stability === "alias" || b.stability === "alias") return false;
  return a.family === b.family && STABILITY_RANK[b.stability] >= STABILITY_RANK[a.stability];
}

/** Rewrite one CROSS_VENDOR[lane] id in models.ts source. Only the quoted id
 * changes; the trailing comment (data-class ceiling, egress tier) is untouched.
 * Throws if the lane line is missing — never silently no-op a bump. Pure. */
export function applyToCrossVendorSource(src: string, lane: string, newId: string): string {
  invariant(LANE_NAME.test(lane), `lane name '${lane.slice(0, 40)}' is not a plain identifier`);
  const bad = vendorIdProblem(newId);
  invariant(bad === null, `refusing to write model id into TypeScript source: ${bad}`);
  const re = new RegExp(`(^\\s*${lane}:\\s*")[^"]+(")`, "m");
  if (!re.test(src)) throw new Error(`CROSS_VENDOR.${lane} line not found in registry source`);
  return src.replace(re, (_m, a: string, b: string) => `${a}${newId}${b}`);
}

/** Minimal ~/.claude/.env reader (canonical env home; bun only auto-loads cwd). */
function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(CLAUDE_DIR, ".env"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=("?)(.*?)\2\s*$/);
      if (m) out[m[1]] = m[3];
    }
  } catch { /* no .env — probes will report NO-KEY */ }
  return out;
}

type Vendor = "google" | "openai" | "xai";

/** Pins with no public roster to probe: a vendor with no model-listing API we can
 * compare versions against (Perplexity, Replicate slugs, Workers AI `@cf/` ids, Suno),
 * or a TypeSafe `jev-` id (Jev, retired 2026-10-10 as the judgment engine).
 * Never roster-checked or auto-bumped here; the Upgrade Models procedure researches
 * them. Exported for tests. */
export function isRosterless(pin: string): boolean {
  return pin.startsWith("jev-") /* TypeSafe, retired 2026-10-10 as our engine */ || /^sonar\b/.test(pin) || pin.startsWith("chirp-") || pin.includes("/") || vendorOf(pin) === null;
}

/** The vendor whose roster we can probe, or null when we have none for this pin.
 * A new lane on an unmapped vendor (Muse, 2026-10-12) is reported as rosterless,
 * never thrown: a throw here stopped every other lane's check for ten days. */
export function vendorOf(pin: string): Vendor | null {
  if (pin.startsWith("gemini-")) return "google";
  if (pin.startsWith("gpt-") || pin.startsWith("whisper-")) return "openai";
  if (pin.startsWith("grok-")) return "xai";
  return null;
}

/** Fetch one vendor's live model roster. Returns null on missing key/error.
 * OpenAI and xAI carry a `created` release timestamp (the reliable ordering
 * signal); Google's ListModels has none, so those entries are bare. */
async function fetchRoster(vendor: Vendor, env: Record<string, string>): Promise<RosterEntry[] | null> {
  try {
    if (vendor === "google") {
      const key = env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY;
      if (!key) return null;
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
        headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { models?: { name: string }[] };
      return (j.models ?? []).map((m) => m.name.replace(/^models\//, ""));
    }
    if (vendor === "openai") {
      const key = env.OPENAI_API_KEY_OPTIN || env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
      if (!key) return null;
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { data?: { id: string; created?: number }[] };
      return (j.data ?? []).map((m) => ({ id: m.id, created: m.created }));
    }
    // xai — OpenAI-compatible roster; key required
    const key = env.XAI_API_KEY || process.env.XAI_API_KEY;
    if (!key) return null;
    const r = await fetch("https://api.x.ai/v1/models", {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { id: string; created?: number }[] };
    return (j.data ?? []).map((m) => ({ id: m.id, created: m.created }));
  } catch {
    return null;
  }
}

/** One minimal live call against a candidate id. A roster listing proves the
 * id exists, not that our key can run it — this is the gate before any write.
 * Image-family ids get an image request (text-only calls 400 on them).
 * OpenAI-compatible probes demand non-empty visible content at a 1024-token
 * budget (thinking models return a null-content message at 16). Exported for
 * tests. */
export async function probeModel(vendor: Vendor, id: string, env: Record<string, string>): Promise<string | null> {
  try {
    if (vendor === "google") {
      const key = env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY;
      if (!key) return "no GOOGLE_API_KEY";
      const image = /image/.test(id);
      const body = image
        ? { contents: [{ parts: [{ text: "A single red dot on white." }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }
        : { contents: [{ parts: [{ text: "Reply with the single word: ok" }] }], generationConfig: { maxOutputTokens: 1024 } }; // thinking models spend tokens before the first visible part; 16 returned an empty candidate on 3.8-flash
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`, {
        method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
      });
      if (!r.ok) return `HTTP ${r.status}`;
      const j = (await r.json()) as { candidates?: { content?: { parts?: unknown[] } }[] };
      return j.candidates?.[0]?.content?.parts?.length ? null : "empty response";
    }
    const openai = vendor === "openai";
    const key = openai
      ? env.OPENAI_API_KEY_OPTIN || env.OPENAI_API_KEY || process.env.OPENAI_API_KEY
      : env.XAI_API_KEY || process.env.XAI_API_KEY;
    if (!key) return openai ? "no OPENAI_API_KEY" : "no XAI_API_KEY";
    const r = await fetch(openai ? "https://api.openai.com/v1/chat/completions" : "https://api.x.ai/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: id, messages: [{ role: "user", content: "Reply with the single word: ok" }], max_completion_tokens: 1024 }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!r.ok) return `HTTP ${r.status}`;
    const j = (await r.json()) as { choices?: { message?: { content?: string | null } }[]; error?: { message?: string } };
    if (j.error) return j.error.message ?? "vendor error";
    const content = j.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim().length > 0 ? null : "empty response";
  } catch (e) {
    return (e as Error).message;
  }
}

/** Lanes whose model is passed to `codex exec --model` on the ChatGPT/Codex account,
 * not only called over the API. The vendor API probe above cannot speak for that
 * account: an id the API serves can still be refused by Codex. A same-class bump on
 * one of these lanes is written only after probeCodex passes too. */
export const CODEX_LANES: ReadonlySet<string> = new Set(["astra", "sol", "luna", "terra", "codexResearcher", "codexResearcherFast", "computerUse", "pentest"]);

export type CodexRunner = (argv: string[], timeoutMs: number) => { exitCode: number | null; stdout: string; stderr: string };
const defaultCodexRunner: CodexRunner = (argv, timeoutMs) => {
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

/** One minimal `codex exec --model <id>` run, read-only and ephemeral, against the
 * Codex install the workers use (~/.bun/bin/codex, else codex on PATH). Null on a
 * non-empty final answer; otherwise the reason. Unattended-safe: no prompt, a
 * 180s bound, and a missing or logged-out codex is a failure, so the lane holds. */
export function probeCodex(id: string, run: CodexRunner = defaultCodexRunner): string | null {
  const bunCodex = join(homedir(), ".bun", "bin", "codex");
  const codex = existsSync(bunCodex) ? bunCodex : "codex";
  const dir = mkdtempSync(join(tmpdir(), "codex-probe-"));
  const finalFile = join(dir, "final.txt");
  try {
    const r = run([codex, "exec", "--model", id, "-c", "model_reasoning_effort=low", "--sandbox", "read-only",
      "--skip-git-repo-check", "--ephemeral", "--cd", dir, "-o", finalFile, "Reply with the single word: ok"], 180_000);
    if (r.exitCode !== 0) return `codex exit ${r.exitCode ?? "timeout"}: ${(r.stderr || r.stdout).trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? ""}`;
    const answer = existsSync(finalFile) ? readFileSync(finalFile, "utf8").trim() : "";
    return answer.length > 0 ? null : "codex returned no final message";
  } catch (e) {
    return `codex probe could not run: ${(e as Error).message}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** --cross-vendor [--sync]: live roster probe per CROSS_VENDOR lane. Exit 0
 * fresh (or every NEWER lane synced), 1 open findings (cross-class NEWER /
 * MISSING / probe-failed sync), 2 only-roster-failures. Report mode never
 * writes; --sync writes same-class bumps that pass a live probe. */
async function crossVendorCheck(syncMode = false): Promise<number> {
  const env = readEnv();
  const originalRegistrySrc = readFileSync(REGISTRY_PATH, "utf8");
  let registrySrc = originalRegistrySrc;
  const bumped: string[] = [];
  const vendors = [...new Set(Object.values(CROSS_VENDOR).map(vendorOf).filter((v): v is Vendor => v !== null))];
  const rosters = new Map<Vendor, RosterEntry[] | null>();
  await Promise.all(vendors.map(async (v) => rosters.set(v, await fetchRoster(v, env))));

  let findings = 0;
  let failures = 0;
  console.log(`Cross-vendor lane freshness (live rosters, ${syncMode ? "same-class auto-sync" : "report only"}):`);
  for (const [lane, pin] of Object.entries(CROSS_VENDOR)) {
    const vendor = vendorOf(pin);
    if (isRosterless(pin) || vendor === null) {
      console.log(`  🔎 ${lane}: '${pin}' (no public roster — the Upgrade Models procedure researches the latest)`);
      continue;
    }
    const roster = rosters.get(vendor);
    if (roster === null || roster === undefined) {
      failures++;
      console.log(`  ⚠️  ${lane}: '${pin}' — ${vendor} roster unavailable (missing key or API error)`);
      continue;
    }
    const v = laneVerdict(lane, pin, roster);
    if (v.status === "CURRENT" || v.status === "ALIAS") {
      console.log(`  ✅ ${lane}: '${pin}' (${v.status.toLowerCase()})`);
    } else if (v.status === "NEWER") {
      const best = v.candidates[0];
      if (syncMode && sameClass(pin, best) && vendorIdProblem(best) !== null) {
        findings++;
        console.log(`  ⛔ ${lane}: '${pin}' → roster id is not a plain model id (${vendorIdProblem(best)}) — not written`);
      } else if (syncMode && sameClass(pin, best)) {
        const apiErr = await probeModel(vendor, best, env);
        // Codex lanes need the Codex account to accept the id as well (Upgrade Models intent).
        const err = apiErr ?? (CODEX_LANES.has(lane) ? (() => { const c = probeCodex(best); return c === null ? null : `codex probe: ${c}`; })() : null);
        if (err === null) {
          registrySrc = applyToCrossVendorSource(registrySrc, lane, best);
          bumped.push(`${lane}: ${pin} → ${best}`);
          console.log(`  ⬆️  ${lane}: '${pin}' → '${best}' (same class, live probe ok — bumped)`);
        } else {
          findings++;
          console.log(`  ⛔ ${lane}: '${pin}' → '${best}' same class but live probe FAILED (${err}) — not written`);
        }
      } else {
        findings++;
        const why = syncMode ? " (cross-class — your call)" : "";
        console.log(`  🆕 ${lane}: '${pin}' → newer in lane: ${v.candidates.slice(0, 3).join(", ")}${why}`);
      }
    } else {
      findings++;
      console.log(`  ❌ ${lane}: '${pin}' — ${v.status} from ${vendor} roster`);
    }
  }
  // Advisory: versioned vendor IDs hardcoded in executable code outside the
  // registry (image-gen pins, etc.). Not lanes, so not roster-probed here — but
  // they rot silently, so an Upgrade run should eyeball them for freshness.
  const codeHits = scanVendorTree();
  if (codeHits.length > 0) {
    console.log(`\n📌 ${codeHits.length} versioned vendor ID(s) hardcoded in code (outside CROSS_VENDOR) — verify freshness manually:`);
    for (const { path, hit } of codeHits) console.log(`  ${path.replace(CLAUDE_DIR + "/", "")}: '${hit.id}'`);
  }

  if (bumped.length > 0) {
    const exportErr = commitRegistry(REGISTRY_PATH, originalRegistrySrc, registrySrc);
    if (exportErr) { console.error(`\n⛔ ${exportErr}`); return 1; }
    console.log(`\n✅ models.ts updated: ${bumped.join("; ")}`);
  }
  if (findings > 0) {
    console.log(syncMode
      ? "\nRemaining 🆕/❌/⛔ need a decision: edit CROSS_VENDOR in models.ts (one line)."
      : "\nSame-class 🆕 lanes auto-apply via --cross-vendor --sync (ModelSync --daily runs it); cross-class ones are the principal's call.");
    return 1;
  }
  if (failures > 0) return 2;
  console.log("✅ All cross-vendor pins current against live rosters.");
  return 0;
}

/** A vendor ID is a real "model selection" (vs. a prose mention or an agent
 * label) when its version token is either specific — dotted or ≥2 digits
 * (gemini-3.7, glm-5.2) — or carries a product suffix after it
 * (gemini-3-pro-image-preview). Bare family+number (gemini-3, gpt-4, the
 * gemini-1/2/3 research labels) is noise and drops out. */
function isVersionedVendorId(id: string): boolean {
  const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  const tokens = bare.split("-");
  const vIdx = tokens.findIndex((t) => /^\d+(?:\.\d+)*$/.test(t));
  if (vIdx === -1) return false;
  const v = tokens[vIdx];
  if (v.includes(".") || /^\d{2,}$/.test(v)) return true;      // 3.7, 5.2, 20
  return tokens.slice(vIdx + 1).some((t) => /[A-Za-z]/.test(t)); // 3-pro-image
}

/** Offline sweep: versioned vendor IDs hardcoded in EXECUTABLE code that bypass
 * the registry — the ones that silently rot (image-gen pins in Tools, etc.).
 * Docs/workflows (.md) and labels are excluded upstream by the file glob. Pure. */
export function categorizeVendorScanLines(rgOutput: string): ScanResult[] {
  const known = new Set(
    Object.values(CROSS_VENDOR).flatMap((v) => (v.includes("/") ? [v, v.slice(v.indexOf("/") + 1)] : [v])),
  );
  const seen = new Set<string>();
  const hits: ScanResult[] = [];
  for (const line of rgOutput.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.lastIndexOf(":");
    const path = line.slice(0, idx);
    const id = line.slice(idx + 1).trim();
    if (isExcluded(path)) continue;
    if (known.has(id) || !(MEDIA_ID.test(id) || isVersionedVendorId(id))) continue;
    const dedupe = `${path}::${id}`;
    if (seen.has(dedupe)) continue; // one row per (file, id), not per occurrence
    seen.add(dedupe);
    hits.push({ path, hit: { id, tier: "fable", status: "stale" } }); // tier unused for vendor hits
  }
  return hits;
}

/** stdout of an rg run, or a thrown error when rg did not finish normally. rg exits 0
 * on matches and 1 on none; any other status (bad pattern, unreadable root, killed)
 * means the scan did not happen, and an empty stdout must not read as clean. */
export function rgStdout(proc: { exitCode: number | null; stdout: Uint8Array | string; stderr: Uint8Array | string }): string {
  const text = (b: Uint8Array | string) => (typeof b === "string" ? b : new TextDecoder().decode(b));
  if (proc.exitCode !== 0 && proc.exitCode !== 1) throw new Error(`rg scan failed (exit ${proc.exitCode}): ${text(proc.stderr).trim().slice(0, 300)}`);
  return text(proc.stdout);
}

/** Executable code only — .ts/.tsx/.mjs/.js/.py. Docs and intents carry
 * vendor names as prose, not live selections, so they never enter the sweep. */
function scanVendorTree(): ScanResult[] {
  return categorizeVendorScanLines(rgIds(VENDOR_ID_PATTERN.source, CLAUDE_DIR, ["*.ts", "*.tsx", "*.mjs", "*.js", "*.py"]));
}

export type ScanResult = { path: string; hit: DriftHit };

/**
 * Turn `rg -n -o` output (path:line:id) into the `path:id` lines the categorizers read,
 * dropping excluded paths and every occurrence on a line that carries EXAMPLE_MARKER.
 * `readLine` is injected so tests run without disk. Pure apart from it.
 */
export function dropMarkedLines(rgOutput: string, readLine: (path: string, line: number) => string | undefined): string {
  const out: string[] = [];
  for (const raw of rgOutput.split("\n")) {
    if (!raw.trim()) continue;
    const m = raw.match(/^(.+?):(\d+):(.+)$/);
    if (!m) continue;
    const [, path, lineNo, id] = m;
    if (isExcluded(path)) continue; // never read history or transcripts just to check a marker
    if ((readLine(path, Number(lineNo)) ?? "").includes(EXAMPLE_MARKER)) continue;
    out.push(`${path}:${id}`);
  }
  return out.join("\n");
}

/** File line reader with a per-run cache, for dropMarkedLines. */
function cachedLineReader(): (path: string, line: number) => string | undefined {
  const cache = new Map<string, string[]>();
  return (path, line) => {
    if (!cache.has(path)) {
      try { cache.set(path, readFileSync(path, "utf8").split("\n")); } catch { cache.set(path, []); }
    }
    return cache.get(path)![line - 1];
  };
}

/** rg over `root` for `pattern`, one `path:id` line per occurrence, marked lines dropped. Throws when rg fails. */
function rgIds(pattern: string, root: string, globs: string[] = []): string {
  const proc = Bun.spawnSync(
    ["rg", "--no-heading", "-n", "-o", pattern, root, "--glob", "!**/node_modules/**", ...globs.flatMap((g) => ["-g", g])],
    { stdout: "pipe", stderr: "pipe" },
  );
  return dropMarkedLines(rgStdout(proc), cachedLineReader());
}

/**
 * Anthropic ids in the version-first shape used before Claude 4 put the tier first
 * (claude-3-5-sonnet-20241022, claude-3.7-sonnet, claude-3-opus-latest, Raycast's
 * claude-4-5-haiku), plus Claude 2.x and Instant. CLAUDE_ID_PATTERN never matches these,
 * so before 1.6.0 a Claude 3 pin passed --check. Bare `claude-2` is left out: it is an agent
 * label far more often than a model id. Rust-regex compatible, since rg runs it.
 */
export const LEGACY_CLAUDE_PATTERN = /\bclaude-(?:\d(?:[.-]\d)?-(?:opus|sonnet|haiku)(?:-\d{8}|-latest)?|2\.\d|instant-v?1(?:\.\d)?)\b/g;

export type LegacyClaudeHit = { path: string; id: string; expected: string };

/** The registry id a legacy Claude id should become, or null when the id is not older than it. Pure. */
export function legacyClaudeReplacement(id: string, current: Record<ClaudeTier, string> = CURRENT): string | null {
  const m = id.match(/^claude-(\d)(?:[.-](\d))?-(opus|sonnet|haiku)/);
  if (!m) return /^claude-(?:2\.\d|instant)/.test(id) ? "a tier alias (opus | sonnet | haiku)" : null;
  const tier = m[3] as ClaudeTier;
  const cur = parseClaudeId(current[tier]);
  if (!cur) return current[tier];
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  const older = major < cur.version[0] || (major === cur.version[0] && minor < cur.version[1]);
  return older ? `"${tier}" (alias) or CURRENT.${tier} = ${current[tier]}` : null;
}

/** Categorize `path:id` lines from a LEGACY_CLAUDE_PATTERN scan. One row per (file, id). Pure. */
export function categorizeLegacyClaudeLines(lines: string): LegacyClaudeHit[] {
  const seen = new Set<string>();
  const hits: LegacyClaudeHit[] = [];
  for (const line of lines.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.lastIndexOf(":");
    const path = line.slice(0, idx);
    const id = line.slice(idx + 1).trim();
    if (isExcluded(path)) continue;
    const expected = legacyClaudeReplacement(id);
    if (!expected || seen.has(`${path}::${id}`)) continue;
    seen.add(`${path}::${id}`);
    hits.push({ path, id, expected });
  }
  return hits;
}

/** Roster vendors whose ids order by version: the family word and its generation number. */
const ROSTER_VENDOR_ID = /^(gpt|gemini|grok)-(\d+)/;
const stripProvider = (id: string) => (id.includes("/") ? id.slice(id.indexOf("/") + 1) : id);

export type OlderVendorVerdict = { reason: "generation" | "superseded"; registry: string };

/**
 * Is a vendor id older than what CROSS_VENDOR runs? "generation": its generation number is
 * below every lane of that vendor (gpt-5.6-sol, gpt-4o, gemini-2.5-pro, grok-3 while the
 * lanes run gpt-6, gemini-3, grok-4). "superseded": a lane runs the same family at a later
 * version, or the GA of the same version where this id is a preview (gpt-6-sol under
 * gpt-6.1-sol, gemini-3-pro-image-preview under gemini-3-pro-image). Only OpenAI, Google
 * and xAI: the rosterless vendors are the Upgrade Models intent's job.
 * Registry ids, aliases and vendors with no lane return null. Pure; registry injectable.
 */
export function olderThanRegistry(id: string, registry: Record<string, string> = CROSS_VENDOR): OlderVendorVerdict | null {
  const bare = stripProvider(id);
  const m = bare.match(ROSTER_VENDOR_ID);
  if (!m) return null;
  const lanes = [...new Set(Object.values(registry).map(stripProvider))];
  if (lanes.includes(bare)) return null;
  const p = parseModelId(bare);
  if (p.stability === "alias") return null;
  const vendorLanes = lanes.filter((l) => l.match(ROSTER_VENDOR_ID)?.[1] === m[1] && parseModelId(l).stability !== "alias");
  if (vendorLanes.length === 0) return null;
  const generations = vendorLanes.map((l) => Number(l.match(ROSTER_VENDOR_ID)![2]));
  if (Number(m[2]) < Math.min(...generations)) return { reason: "generation", registry: vendorLanes.join(", ") };
  for (const lane of vendorLanes) {
    const l = parseModelId(lane);
    if (l.family !== p.family) continue;
    const d = cmpVersion(p.version, l.version);
    if (d < 0 || (d === 0 && p.stability === "preview" && l.stability === "ga")) return { reason: "superseded", registry: lane };
  }
  return null;
}

export type OlderVendorHit = { path: string; id: string } & OlderVendorVerdict;

/** Categorize `path:id` lines from a roster-vendor scan. A bare family+number (gemini-1, gpt-4)
 * is an agent label or prose and drops out; anything with more after the number is an id, so
 * gpt-4o-mini counts where the code-sweep heuristic (isVersionedVendorId) would drop it.
 * One row per (file, id). Pure. */
export function categorizeOlderVendorLines(lines: string, registry: Record<string, string> = CROSS_VENDOR): OlderVendorHit[] {
  const seen = new Set<string>();
  const hits: OlderVendorHit[] = [];
  for (const line of lines.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.lastIndexOf(":");
    const path = line.slice(0, idx);
    const id = line.slice(idx + 1).trim();
    if (isExcluded(path) || /^(?:gpt|gemini|grok)-\d+$/.test(stripProvider(id))) continue;
    const v = olderThanRegistry(id, registry);
    if (!v || seen.has(`${path}::${id}`)) continue;
    seen.add(`${path}::${id}`);
    hits.push({ path, id, ...v });
  }
  return hits;
}

/** Live code, config and instructions: the files a pinned id can select a model from. */
export const OLDER_VENDOR_GLOBS = ["*.ts", "*.tsx", "*.mjs", "*.js", "*.py", "*.sh", "*.md", "*.json", "*.yaml", "*.yml", "*.toml"];
const ROSTER_VENDOR_PATTERN = String.raw`\b(?:gpt|gemini|grok)-\d[A-Za-z0-9.-]*\b`;

/** Offline sweep of `root` for legacy Claude ids. Exported so tests run it on a synthetic tree. */
export function scanLegacyClaude(root: string = CLAUDE_DIR): LegacyClaudeHit[] {
  return categorizeLegacyClaudeLines(rgIds(LEGACY_CLAUDE_PATTERN.source, root));
}

/** Offline sweep of `root` for vendor ids older than the registry. Exported for the same reason. */
export function scanOlderVendors(root: string = CLAUDE_DIR, registry: Record<string, string> = CROSS_VENDOR): OlderVendorHit[] {
  return categorizeOlderVendorLines(rgIds(ROSTER_VENDOR_PATTERN, root, OLDER_VENDOR_GLOBS), registry);
}

/**
 * Categorize `rg -o -N` output (path:id per line) into two action classes.
 * Pure — tests drive it without spawning rg. Cato's blind-spot lesson: a dated
 * pin that EQUALS current today is still a landmine (it silently rots on the
 * next bump), so "current-but-pinned" in live code is reported, not just stale.
 *   - stale:    dated pin ≠ registry → wrong now
 *   - landmine: dated pin = registry → right now, will rot; alias or import it
 * Excluded paths (recognition maps, tests, historical, registry) are dropped.
 */
export function categorizeScanLines(rgOutput: string): { stale: ScanResult[]; landmine: ScanResult[]; ahead: ScanResult[] } {
  const stale: ScanResult[] = [];
  const landmine: ScanResult[] = [];
  const ahead: ScanResult[] = [];
  for (const line of rgOutput.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.lastIndexOf(":");
    const path = line.slice(0, idx);
    const id = line.slice(idx + 1).trim();
    if (isExcluded(path)) continue;
    const hit = classify(id);
    if (!hit) continue;
    if (hit.status === "stale") stale.push({ path, hit });
    else if (hit.status === "ahead") ahead.push({ path, hit }); // the REGISTRY is behind
    else landmine.push({ path, hit }); // status === "current" but still pinned
  }
  return { stale, landmine, ahead };
}

function scanTree(): { stale: ScanResult[]; landmine: ScanResult[]; ahead: ScanResult[] } {
  return categorizeScanLines(rgIds(CLAUDE_ID_PATTERN.source, CLAUDE_DIR));
}

/**
 * Validate agent frontmatter against the registry (v6.15.0 four-level layer).
 * Static agent `model:` frontmatter can't import models.ts, so it's the one
 * routing surface that can rot silently on a lineup change. Two assertions:
 *   1. every agents/*.md `model:` value is a known tier alias
 *   2. any agent self-declared as a "MAX persona" pins the alias
 *      that EFFORT_MODEL.max currently resolves to — so remapping max in
 *      models.ts makes --check name the exact frontmatter lines to update,
 *      keeping the one-line-swap story honest end to end.
 * Pure-ish (injectable dir) so tests can drive it.
 */
export function checkAgentFrontmatter(agentsDir: string = join(CLAUDE_DIR, "agents")): string[] {
  const problems: string[] = [];
  const validAliases = new Set(Object.keys(CURRENT));
  const maxAlias = EFFORT_MODEL.max;
  let files: string[];
  try {
    files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return problems; // no agents dir — nothing to validate
  }
  for (const f of files) {
    const src = readFileSync(join(agentsDir, f), "utf8");
    const fm = src.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const modelLine = fm[1].match(/^model:\s*(\S+)/m);
    if (!modelLine) continue;
    const model = modelLine[1];
    if (!validAliases.has(model)) {
      problems.push(`agents/${f}: model '${model}' is not a known tier alias (${[...validAliases].join(" | ")})`);
    }
    if (/MAX persona/i.test(fm[1]) && model !== maxAlias) {
      problems.push(`agents/${f}: MAX persona pinned to '${model}' but EFFORT_MODEL.max resolves to '${maxAlias}' — update frontmatter`);
    }
  }
  return problems;
}

function check(): number {
  let scans: { claude: ReturnType<typeof scanTree>; vendorHits: ScanResult[]; legacy: LegacyClaudeHit[]; older: OlderVendorHit[] };
  try {
    // Every vendor, not only Claude (2026-09-22): a model id in code that is not a
    // registry lane has no upgrade path, so it fails the check the same way.
    // Old generations too (principal 2026-10-11, "old models as well"): Claude 3 and earlier
    // shapes, and OpenAI/Google/xAI ids older than their lanes, in code, config and instructions.
    scans = { claude: scanTree(), vendorHits: scanVendorTree(), legacy: scanLegacyClaude(), older: scanOlderVendors() };
  } catch (e) {
    console.error(`SCAN ERROR: ${(e as Error).message} — no drift verdict.`);
    return 2;
  }
  const { stale, landmine, ahead } = scans.claude;
  const { legacy, older } = scans;
  // An older id in code is reported once, as older, not again as "outside CROSS_VENDOR".
  const olderKeys = new Set(older.map((h) => `${h.path}::${h.id}`));
  const vendorHits = scans.vendorHits.filter((h) => !olderKeys.has(`${h.path}::${h.hit.id}`));
  const frontmatterProblems = checkAgentFrontmatter();
  if (legacy.length > 0) {
    console.log(`\n🦕 ${legacy.length} Claude id(s) from an older generation (version-first shape, Claude 2, Instant) — replace with the alias or a registry import:`);
    for (const h of legacy) console.log(`  ${h.path.replace(CLAUDE_DIR + "/", "")}: '${h.id}' → ${h.expected}`);
  }
  if (older.length > 0) {
    console.log(`\n🕰️  ${older.length} vendor model id(s) older than the registry — replace with a CROSS_VENDOR import (code) or the lane name (instructions):`);
    for (const h of older) console.log(`  ${h.path.replace(CLAUDE_DIR + "/", "")}: '${h.id}' (${h.reason === "generation" ? "older generation than" : "superseded by"} ${h.registry})`);
  }
  if (vendorHits.length > 0) {
    console.log(`\n📌 ${vendorHits.length} vendor model id(s) hardcoded in code outside CROSS_VENDOR — add a lane in models.ts and import it:`);
    for (const { path, hit } of vendorHits) console.log(`  ${path.replace(CLAUDE_DIR + "/", "")}: '${hit.id}'`);
  }
  if (frontmatterProblems.length > 0) {
    console.log(`\n⚠️  ${frontmatterProblems.length} agent-frontmatter problem(s) vs EFFORT_MODEL:`);
    for (const p of frontmatterProblems) console.log(`  ${p}`);
  }
  const clean = stale.length === 0 && landmine.length === 0 && ahead.length === 0;
  if (clean && (frontmatterProblems.length > 0 || vendorHits.length > 0 || legacy.length > 0 || older.length > 0)) return 1;
  if (clean) {
    console.log("✅ No model drift. All pinned Claude IDs match the registry, or consumers use aliases.");
    return 0;
  }
  console.log("Registry says:");
  for (const t of Object.keys(CURRENT) as ClaudeTier[]) console.log(`    ${t}: ${CURRENT[t]}`);
  if (ahead.length > 0) {
    console.log(`\n⏩ ${ahead.length} pinned ID(s) NEWER than the registry — the registry is behind, not the consumer. Run \`bun LIFEOS/TOOLS/ModelSync.ts --sync\`:`);
    for (const { path, hit } of ahead) console.log(`  ${path}: '${hit.id}' (${hit.tier}) > registry '${CURRENT[hit.tier]}'`);
  }
  if (stale.length > 0) {
    console.log(`\n⚠️  ${stale.length} STALE pinned ID(s) — wrong now, bump or alias:`);
    for (const { path, hit } of stale) console.log(`  ${path}: '${hit.id}' (${hit.tier}) → expected '${CURRENT[hit.tier]}'`);
  }
  if (landmine.length > 0) {
    console.log(`\n🧨 ${landmine.length} pinned-but-current ID(s) — correct today, will rot on next ${landmine[0].hit.tier} bump. Prefer alias ("${landmine[0].hit.tier}") or import the registry:`);
    for (const { path, hit } of landmine) console.log(`  ${path}: '${hit.id}' (${hit.tier})`);
  }
  return 1;
}



function apply(tier: string, newId: string): number {
  if (!["opus", "sonnet", "haiku", "fable"].includes(tier)) {
    console.error(`Invalid tier '${tier}'. Use opus | sonnet | haiku | fable.`);
    return 1;
  }
  const idProblem = claudeIdProblem(tier, newId);
  if (idProblem) {
    console.error(`Invalid model id: ${idProblem}. Nothing written.`);
    return 1;
  }
  const src = readFileSync(REGISTRY_PATH, "utf8");
  const next = applyToRegistrySource(src, tier as ClaudeTier, newId);
  const exportErr = commitRegistry(REGISTRY_PATH, src, next);
  if (exportErr) {
    console.error(exportErr);
    return 1;
  }
  console.log(`✅ Registry CURRENT.${tier} → '${newId}'.`);
  console.log("   Propose-mode: only models.ts was touched. Next: re-run --check, review any flagged consumers, commit.");
  return 0;
}

/** Exit code for a crash. Exit 1 means "open findings", so an uncaught throw (which bun
 * exits 1) read as a waiting proposal in ModelSync for ten days (2026-10-12 → 10-22). */
export const EXIT_CRASH = 3;

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--check") process.exit(check());
    else if (args[0] === "--cross-vendor") process.exit(await crossVendorCheck(args.includes("--sync")));
    else if (args[0] === "--apply" && args[1] && args[2]) process.exit(apply(args[1], args[2]));
    else {
      console.error("Usage: UpdateModels.ts --check | --cross-vendor [--sync] | --apply <opus|sonnet|haiku|fable> <new-id>");
      process.exit(2);
    }
  } catch (err) {
    console.error(`UpdateModels crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(EXIT_CRASH);
  }
}
