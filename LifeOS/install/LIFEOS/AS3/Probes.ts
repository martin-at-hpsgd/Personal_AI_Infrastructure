#!/usr/bin/env bun
/**
 * Probes.ts — the outcome probes behind the AS3 claims.
 *
 * WHY: several AS3 asserts passed by finding words in a skill file or a service label. A skill that
 * says "verify sources" and a skill that verifies sources return the same result, so the checklist
 * could go green while nothing in the principal's life changed. Outcome probes therefore
 * inspect real artifacts instead of accepting labels or documentation as evidence.
 *
 * CONTRACT: every probe here tests the OUTCOME the claim promises, over real artifacts. A probe
 * that cannot find the artifact exits 1 with the reason — an unbuilt capability reads red, never
 * green. Text checks survive only as `prerequisite` rows in the ISA, which earn no outcome credit.
 *
 * Usage: bun LIFEOS/AS3/Probes.ts <sources|health|week-proposals|interruptions|confirmation> [--json]
 * Exit 0 = the outcome held. Exit 1 = it did not, or the evidence to judge it does not exist.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDAName } from "../../hooks/lib/identity";
import { lifeosPath } from "../TOOLS/Paths";

export interface ProbeResult { ok: boolean; reason: string; observed?: Record<string, unknown> }

const DAY_MS = 86_400_000;
const URL_RE = /https?:\/\/[^\s)"'\]]+/;

/** Files under `dir` (recursively, one level of subdirectories) modified within `days`; `days = 0` means any age. */
function recentFiles(dir: string, days: number, limit = 40): string[] {
  if (!existsSync(dir)) return [];
  const cutoff = days > 0 ? Date.now() - days * DAY_MS : 0;
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e.startsWith("_") || e.startsWith(".")) continue;
      const p = join(d, e);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth > 0) walk(p, depth - 1); continue; }
      if (e.endsWith(".md") && st.mtimeMs >= cutoff) out.push(p);
      if (out.length >= limit) return;
    }
  };
  walk(dir, 1);
  return out;
}

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

/**
 * ISC-17 — every returned answer carries checked sources and a stated confidence.
 * Outcome checked here: each recently retained answer declares its provenance (a source URL, or
 * `source_kind: internal`) and a confidence that parses as one (0–1, a percentage, or a
 * low/medium/high level). An answer with no declared source is the failure this probe catches.
 * LIMIT: whether a cited source was actually checked, or supports the answer, is a judgment this
 * deterministic probe cannot make; a PASS means declared provenance, never verified support.
 */
export const ANSWER_AUTHORS = new Set([getDAName().toLowerCase(), "da", "lifeos", "assistant"]);

/** A confidence that states one: 0–1, a 0–100 percentage, or a low/medium/high level. Any other non-empty text is not a confidence. */
function statedConfidence(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (/^(very-)?(low|medium|high)(-(low|medium|high))?$/.test(v)) return true;
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(v);
  if (pct) return Number(pct[1]) <= 100;
  return /^\d+(\.\d+)?$/.test(v) && Number(v) >= 0 && Number(v) <= 1;
}

export function sources(root = lifeosPath("MEMORY", "KNOWLEDGE"), sample = 25): ProbeResult {
  // The claim is about ANSWERS returned to the principal, not captured inputs. A bookmark carries a
  // source_url because something was saved; that says nothing about an answer we produced.
  const files = recentFiles(root, 0, 4000);
  if (files.length === 0) return { ok: false, reason: `no knowledge notes under ${root}: nothing to judge` };
  const answers = files
    .map(f => ({ f, fm: frontmatter(readFileSync(f, "utf8")) }))
    .filter(x => ANSWER_AUTHORS.has((x.fm.authored_by ?? "").toLowerCase()) || ["research", "analysis", "answer"].includes((x.fm.type ?? "").toLowerCase()))
    .sort((p, q) => statSync(q.f).mtimeMs - statSync(p.f).mtimeMs)
    .slice(0, sample);
  if (answers.length === 0) {
    return { ok: false, reason: `${files.length} notes, none of them an answer we produced (authored_by ${[...ANSWER_AUTHORS].join("/")} or type research/analysis/answer). Delivered answers are not retained anywhere, so the promise cannot be checked: the missing observation is an answer record carrying its sources and its confidence` };
  }
  // A source is an external URL OR an honest internal provenance: an answer synthesized from
  // The principal's own notes have no URL to cite, and inventing one would be the failure this claim is
  // about. Both forms still require a stated confidence. (Sol, 2026-09-20: the URL-only rule made
  // honest internal syntheses unpassable; LIFEOS/TOOLS/AnswerArtifact.ts enforces the same rule
  // at the write.)
  const bad = answers.filter(x => {
    const text = readFileSync(x.f, "utf8");
    const sourced = URL_RE.test(text) || x.fm.source_kind === "internal";
    return !sourced || !statedConfidence(x.fm.confidence);
  });
  return bad.length === 0
    ? { ok: true, reason: `${answers.length} retained answers, each declaring a source (URL or stated internal provenance) and a confidence; whether those sources support the answer is not checked here`, observed: { checked: answers.length } }
    : { ok: false, reason: `${bad.length}/${answers.length} retained answers declare no source and no internal provenance, or no parseable confidence`, observed: { first: bad[0].f } };
}

/**
 * ISC-20 — current health state is fresh within 24 hours FROM DEVICE DATA.
 * The file's own generation time is not device freshness: a daily job rewriting a stale payload
 * keeps `generated_at` current forever (Astra analysis § 11 move 1). The measurement day and a
 * source that actually returned records are what this checks.
 */
export function health(path = lifeosPath("USER", "HEALTH", "current.json")): ProbeResult {
  if (!existsSync(path)) return { ok: false, reason: `no health state at ${path}` };
  let j: any;
  try { j = JSON.parse(readFileSync(path, "utf8")); } catch { return { ok: false, reason: "health state is not valid JSON" }; }
  const day = typeof j.day === "string" ? Date.parse(`${j.day}T23:59:59Z`) : NaN;
  if (!Number.isFinite(day)) return { ok: false, reason: "health state carries no measurement day" };
  // A measurement day cannot be in the future: a bad or forged date would otherwise read as
  // negative age and pass. 14h is the widest local-date lead over UTC (UTC+14).
  if (Date.parse(`${j.day}T00:00:00Z`) > Date.now() + 14 * 3_600_000) return { ok: false, reason: `the measured day ${j.day} is in the future: not device data`, observed: { day: j.day } };
  // Age runs from the end of the measured day, the newest moment a daily summary covers. Compare
  // the exact age: rounding first let a 24.4h-old day read as 24h and pass.
  const ageExact = (Date.now() - day) / 3_600_000;
  const ageH = Math.round(ageExact);
  const live = Object.values(j.sources ?? {}).filter((s: any) => s?.status === "ok" && (s?.records ?? 0) > 0);
  if (ageExact > 24) return { ok: false, reason: `the measured day is ${ageH}h old (device data, not file mtime)`, observed: { day: j.day, ageH } };
  if (live.length === 0) return { ok: false, reason: "no health source returned records: the payload may be a stale copy", observed: { sources: Object.keys(j.sources ?? {}) } };
  return { ok: true, reason: `measured day ${j.day} is ${Math.max(0, ageH)}h old with ${live.length} source(s) returning records` };
}

/**
 * ISC-19 — the upcoming week is read on a schedule and produces SPECIFIC PROPOSED CHANGES.
 * Outcome: a proposal artifact from the last 7 days holding at least one concrete proposed change.
 * A registered service label proves scheduling, never proposals, so the label check moved to a
 * prerequisite row.
 */
export function weekProposals(dir = lifeosPath("MEMORY", "STATE", "week-proposals")): ProbeResult {
  const files = recentFiles(dir, 7, 10);
  if (!existsSync(dir)) return { ok: false, reason: `no proposal artifacts at ${dir}: no scheduled run proposes changes to the week yet` };
  if (files.length === 0) return { ok: false, reason: `${dir} holds no proposal from the last 7 days` };
  // A bullet alone is not a proposal: "- No changes proposed" is a bullet. A proposed change names an
  // action on an event, the same verb set LIFEOS/TOOLS/WeekProposals.ts keeps when it writes the artifact.
  const PROPOSAL_RE = /^\s*[-*]\s+(?!no\b|none\b|nothing\b).*\b(move|shift|reschedule|shorten|extend|cancel|decline|combine|protect|block)\b/im;
  const withProposal = files.filter(f => PROPOSAL_RE.test(readFileSync(f, "utf8")));
  return withProposal.length > 0
    ? { ok: true, reason: `${withProposal.length} scheduled artifact(s) carrying at least one proposed change` }
    : { ok: false, reason: `${files.length} artifact(s) present, none carrying a proposed change` };
}

/**
 * ISC-22 (anti) — proactive output stays under a stated interruption ceiling.
 * Needs two things that do not exist yet: a written ceiling, and a ledger of what actually
 * interrupted the principal. Counting the ledger against the ceiling is the only honest test; the word
 * "ceiling" appearing in a config file is not.
 */
export function interruptions(
  configPath = lifeosPath("USER", "CONFIG", "notifications.json"),
  ledgerPath = lifeosPath("MEMORY", "OBSERVABILITY", "interruptions.jsonl"),
): ProbeResult {
  if (!existsSync(configPath)) return { ok: false, reason: `no stated interruption ceiling: ${configPath} does not exist` };
  let ceiling: number | undefined;
  try { ceiling = JSON.parse(readFileSync(configPath, "utf8"))?.interruptions_per_day; } catch { /* handled below */ }
  if (typeof ceiling !== "number") return { ok: false, reason: `${configPath} states no numeric interruptions_per_day ceiling` };
  if (!existsSync(ledgerPath)) return { ok: false, reason: `no interruption ledger at ${ledgerPath}: what actually reached the principal is unmeasured` };
  const cutoff = Date.now() - DAY_MS;
  const today = readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).filter(l => {
    try { return Date.parse(JSON.parse(l).ts) >= cutoff; } catch { return false; }
  }).length;
  return today <= ceiling
    ? { ok: true, reason: `${today} interruptions in the last 24h, ceiling ${ceiling}` }
    : { ok: false, reason: `${today} interruptions in the last 24h exceeds the stated ceiling of ${ceiling}` };
}

/** Source text with block and line comments removed, so an identifier named only in a comment is not code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * ISC-27 (anti) — no purchase, booking, or outbound commitment executes without explicit confirmation.
 * Evidence level: STATIC. A skill file containing the sentence "explicit confirmation before the
 * charge" is a promise, so this probe reads each committing tool's source and requires an actual
 * confirmation-gate identifier (`confirmRequired` / `requireConfirmation`). It does NOT execute the
 * tools: generic execution of a purchase or call tool has side effects, so a refusal on the
 * unconfirmed path is proven by each tool's own tests, not here. A bare `--dry-run` mention is not
 * a confirmation gate and does not count, and neither is the identifier inside a comment.
 * Scope: PASS means at least one committing tool carries a gate in code. It does not prove every
 * committing path is gated (the directories also hold helpers), so the reason lists the ungated
 * files for review and ISC-27 itself stays open.
 */
export function confirmation(dirs: string[] = [
    ...(process.env.LIFEOS_COMMITTING_TOOL_DIRS?.split(":").filter(Boolean) ?? []),
]): ProbeResult {
  const paths = dirs;
  if (paths.length === 0) return { ok: false, reason: "no committing-tool directories configured in LIFEOS_COMMITTING_TOOL_DIRS" };
  const missing = paths.filter(p => !existsSync(p));
  if (missing.length) return { ok: false, reason: `committing-tool directory absent: ${missing.join(", ")}` };
  // A committing tool must declare a confirmation gate in code (static check; the refusal itself is not executed here).
  const tools = paths.flatMap(p => readdirSync(p).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts")).map(f => join(p, f)));
  const gated = tools.filter(f => /\b(?:confirmRequired|requireConfirmation)\b/.test(stripComments(readFileSync(f, "utf8"))));
  const ungated = tools.filter(f => !gated.includes(f));
  return gated.length > 0
    ? { ok: true, reason: `${gated.length} committing tool(s) declare a confirmation gate in code (static check; refusal not executed). This does not prove every committing path is gated: ${ungated.length} other file(s) carry no gate and are helpers or unreviewed paths`, observed: { gated, ungated } }
    : { ok: false, reason: "no committing tool declares a confirmation gate in code: the guarantee is prose plus the permission table, not an execution path a probe can falsify" };
}

const PROBES: Record<string, () => ProbeResult> = {
  sources, health, "week-proposals": weekProposals, interruptions, confirmation,
};

if (import.meta.main) {
  const name = process.argv[2] ?? "";
  const json = process.argv.includes("--json");
  const probe = PROBES[name];
  if (!probe) { console.error(`usage: Probes.ts <${Object.keys(PROBES).join("|")}> [--json]`); process.exit(2); }
  const r = probe();
  console.log(json ? JSON.stringify(r) : `${r.ok ? "PASS" : "FAIL"} ${name}: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
