#!/usr/bin/env bun
/**
 * StandingFacts — keeps the standing-facts card honest and fed.
 *
 * @version 1.0.4
 *
 * Two failures from improvement pass #4 (2026-08-20) live here:
 *
 *   `check`      — the card is prose injected on every turn, so a line that
 *                  goes stale is worse than no line at all. "Main loop is
 *                  pinned to fable" was true when the card was written and
 *                  false soon after, when the carrier changed.
 *                  This compares the card's model claims against settings.json.
 *
 *   `candidates` — the card is hand-curated with no feeder, so capability
 *                  incidents landed soon after it shipped for facts it did
 *                  not carry. Two feeds: `capability-incidents.jsonl` (its
 *                  `should`/`actual` pair IS the missing fact) and the FAILURES
 *                  corrections whose slug has the wrong-path shape
 *                  ("used-browser-automation-instead-of-existing-discord-
 *                  webhook-capability"). The second feed matters more than the
 *                  first: the observability log turned out to be almost entirely
 *                  `zero-capability-inline` underspend rows, while every
 *                  card-shaped miss lived in the FAILURES corpus.
 *
 * Read-only. Proposes; never edits the card.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { getClaudeDir } from "./Paths"; // public issue #1665 @rogdex24, #1584 @ramazanpolat — aliased resolve sites missed by the 09-03 sweep

const CLAUDE_ROOT = getClaudeDir();
const CARD = pathResolve(CLAUDE_ROOT, "LIFEOS/USER/CONFIG/STANDING_FACTS.md");
const SETTINGS = pathResolve(CLAUDE_ROOT, "settings.json");
const INCIDENTS = pathResolve(CLAUDE_ROOT, "LIFEOS/MEMORY/OBSERVABILITY/capability-incidents.jsonl");

export interface StaleFinding { line: string; why: string }

/** Card fact lines (between the markers), trimmed, bullets only. */
export function readFacts(cardPath = CARD): string[] {
  if (!existsSync(cardPath)) return [];
  const raw = readFileSync(cardPath, "utf8");
  const m = raw.match(/<!-- FACTS BEGIN -->\n([\s\S]*?)<!-- FACTS END -->/);
  if (!m) return [];
  return m[1].split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
}

/** Read the current carrier; advisorModel references are legacy facts. */
export function readModelConfig(settingsPath = SETTINGS): { model?: string } {
  try {
    const j = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    return {
      model: typeof j.model === "string" ? j.model : undefined,
    };
  } catch { return {}; }
}

const MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

/** Words that open an up-motion clause. An alias after one of these names the
 *  ADVISOR, not the carrier, and must not be read as satisfying a carrier claim. */
const ADVISOR_CLAUSE = /\b(up-motion|advisorModel|advisor)\b/i;

/**
 * The carrier clause of a fact line: the `;`-delimited segment that makes the
 * carrier claim, with any trailing advisor clause cut off. Returns "" when the
 * line makes no carrier claim.
 *
 * Scoping to the clause is the whole point (2026-08-20). Scanning the WHOLE line
 * false-passed the live card: `carrier … (opus); up-motion …
 * (fable)` on a fable carrier found "fable" somewhere in the line and called it
 * agreement, so the one gate built for this staleness class reported ✅ while the
 * every-turn card told every session the carrier was opus.
 */
export function carrierClause(line: string): string {
  const carrierClaim = /\b(carrier|main loop|session (?:model|loop)|pinned to)\b/i;
  if (!carrierClaim.test(line)) return "";
  const seg = line.split(";").find((s) => carrierClaim.test(s)) ?? line;
  const adv = seg.search(ADVISOR_CLAUSE);
  return adv === -1 ? seg : seg.slice(0, adv);
}

/**
 * A card line that asserts what the main loop/carrier runs must name the
 * configured carrier. Deliberately narrow: this checks the one claim class that
 * has already gone stale, rather than trying to fact-check prose in general.
 */
export function checkCard(
  facts: string[],
  cfg: { model?: string; advisorModel?: string }
): StaleFinding[] {
  const out: StaleFinding[] = [];
  for (const line of facts) {
    const clause = carrierClause(line);
    if (!clause) continue;
    const named = MODEL_ALIASES.filter((a) => new RegExp(`\\b${a}\\b`, "i").test(clause));
    if (named.length === 0) continue;
    if (cfg.model && !named.includes(cfg.model as typeof MODEL_ALIASES[number])) {
      out.push({ line, why: `names ${named.join("/")} as the carrier; settings.json "model" is "${cfg.model}"` });
      continue;
    }
    if (cfg.advisorModel && named.length === 1 && named[0] !== cfg.model) {
      out.push({ line, why: `names only ${named[0]}; carrier is "${cfg.model}" with advisorModel "${cfg.advisorModel}"` });
    }
  }
  return out;
}

export type CardVerdict =
  | { status: "agree"; checked: number; note: string }
  | { status: "stale"; findings: StaleFinding[] }
  | { status: "cannot_verify"; why: string };

/**
 * The strict verdict the `check` command reports. "Agree" is only claimed after the
 * settings file was read and parsed, the card has a real facts section, and every
 * model-naming carrier claim was actually compared. Anything that stops a comparison
 * (missing or malformed file, no markers, a claim with nothing to compare against) is
 * cannot_verify, never agreement. readModelConfig stays lenient for its other callers.
 */
export function verifyCard(cardPath = CARD, settingsPath = SETTINGS): CardVerdict {
  if (!existsSync(settingsPath)) return { status: "cannot_verify", why: `settings file not found: ${settingsPath}` };
  let cfg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
    cfg = parsed as Record<string, unknown>;
  } catch (e) {
    return { status: "cannot_verify", why: `settings file is unreadable or malformed (${e instanceof Error ? e.message : e})` };
  }
  if ("model" in cfg && (typeof cfg.model !== "string" || cfg.model.trim() === "")) return { status: "cannot_verify", why: 'settings.json "model" is present but not a non-empty string' };

  if (!existsSync(cardPath)) return { status: "cannot_verify", why: `standing-facts card not found: ${cardPath}` };
  const raw = readFileSync(cardPath, "utf8");
  if (!/<!-- FACTS BEGIN -->\n[\s\S]*?<!-- FACTS END -->/.test(raw)) return { status: "cannot_verify", why: "standing-facts card has no FACTS BEGIN/END section" };
  const facts = readFacts(cardPath);
  if (facts.length === 0) return { status: "cannot_verify", why: "standing-facts card has a FACTS section with no fact lines" };

  const model = typeof cfg.model === "string" ? cfg.model : undefined;
  const claims = facts.filter((l) => {
    const clause = carrierClause(l);
    return clause !== "" && MODEL_ALIASES.some((a) => new RegExp(`\\b${a}\\b`, "i").test(clause));
  });
  if (claims.length > 0 && !model) return { status: "cannot_verify", why: `the card names a carrier model on ${claims.length} line(s) but settings.json pins no "model" to compare against` };

  const findings = checkCard(facts, { model, advisorModel: typeof cfg.advisorModel === "string" ? cfg.advisorModel : undefined });
  if (findings.length > 0) return { status: "stale", findings };
  return {
    status: "agree",
    checked: claims.length,
    note: claims.length === 0 ? `${facts.length} fact line(s) read; none names a carrier model, so there was nothing to compare` : `${claims.length} carrier claim(s) compared with settings.json model "${model}"`,
  };
}

export interface Candidate { ts: string; cls: string; should: string; actual: string }

/** Recent capability incidents whose `should` text the card does not already cover. */
export function candidates(opts: { days?: number; incidentsPath?: string; facts?: string[]; now?: Date } = {}): Candidate[] {
  const path = opts.incidentsPath ?? INCIDENTS;
  if (!existsSync(path)) return [];
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - (opts.days ?? 14) * 86400000;
  const facts = (opts.facts ?? readFacts()).join("\n").toLowerCase();

  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line); } catch { continue; }
    const ts = String(r.ts ?? "");
    const t = Date.parse(ts);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const should = String(r.should ?? "").trim();
    const actual = String(r.actual ?? "").trim();
    if (!should) continue;

    // "Covered" = the card already names the capability the miss was about.
    // Keyed on distinctive words so a near-miss still surfaces for review.
    if (isCovered(should, facts)) continue;

    const key = should.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ts, cls: String(r.class ?? ""), should: should.slice(0, 240), actual: actual.slice(0, 240) });
  }
  return out.reverse();
}

/**
 * "Covered" is a majority-overlap test, not an all-words test: the card states a
 * fact in its own words, so demanding every keyword match would re-surface facts
 * that were just added. Over-surfacing is the safe direction — a human reads this.
 */
export function isCovered(text: string, factsLower: string, threshold = 0.6): boolean {
  const distinctive = (text.toLowerCase().match(/\b[a-z_]{5,}\b/g) ?? []).filter((k) => !COMMON.has(k));
  if (distinctive.length === 0) return false;
  const hits = distinctive.filter((k) => factsLower.includes(k)).length;
  return hits / distinctive.length >= threshold;
}

const COMMON = new Set([
  "should", "would", "there", "which", "their", "about", "these", "those", "using", "invoke",
  "skill", "agent", "before", "after", "instead", "without", "actual", "result", "output",
]);

/** Wrong-path corrections — the shape that names a capability I have and did not use. */
const WRONG_PATH_SHAPE = /\b(instead of|despite|already|wrong|not\s+\w+ed)\b/i;

export interface SlugCandidate { date: string; description: string }

/** Correction slugs with the wrong-path shape that the card does not already cover. */
export function slugCandidates(opts: { days?: number; facts?: string[]; now?: Date } = {}): SlugCandidate[] {
  let entries: { date: string; description: string }[] = [];
  try {
    const { collectCorrections } = require("./CorrectionReadback") as typeof import("./CorrectionReadback");
    entries = collectCorrections({ now: opts.now, days: opts.days ?? 14, maxLines: 200 });
  } catch { return []; }
  const facts = (opts.facts ?? readFacts()).join("\n").toLowerCase();
  return entries
    .filter((e) => WRONG_PATH_SHAPE.test(e.description))
    .filter((e) => !isCovered(e.description, facts))
    .map((e) => ({ date: e.date, description: e.description }));
}

if (import.meta.main) {
  const cmd = process.argv[2] ?? "check";
  if (cmd === "check") {
    const v = verifyCard();
    if (v.status === "agree") { console.log(`✅ standing-facts card agrees with settings.json — ${v.note}`); process.exit(0); }
    if (v.status === "cannot_verify") { console.log(`⚠️  CANNOT VERIFY: ${v.why}`); process.exit(3); }
    for (const f of v.findings) console.log(`⚠️  STALE: ${f.why}\n    ${f.line}`);
    process.exit(1);
  } else if (cmd === "candidates") {
    const days = Number(process.argv[3] ?? 14);
    const slugs = slugCandidates({ days });
    const c = candidates({ days });
    if (process.argv.includes("--json")) { console.log(JSON.stringify({ wrongPath: slugs, spend: c }, null, 2)); process.exit(0); }
    if (slugs.length === 0 && c.length === 0) { console.log("No uncovered capability incidents in window."); process.exit(0); }
    if (slugs.length) {
      console.log(`${slugs.length} wrong-path correction(s) the card does not cover — the card-shaped feed:\n`);
      for (const x of slugs) console.log(`- ${x.date}: ${x.description}`);
      console.log("");
    }
    if (c.length) console.log(`(${c.length} spend-class capability incidents in window — those belong to claim 15, not the card. \`--json\` to read them.)`);
  } else {
    console.log("usage: StandingFacts.ts [check|candidates [days] [--json]]");
    process.exit(2);
  }
}
