#!/usr/bin/env bun
// ported from public PR #1798, @rathko
/**
 * CollectSignals — deterministic, read-only signal collector for skill-gap discovery.
 *
 * Emits a normalized corpus (JSON to stdout) so the LLM step only clusters and judges;
 * it never gathers. Run at a fixed point in time over unchanged stores, it is deterministic
 * (output ordering is fully tie-broken). Writes nothing.
 *
 * Paths are DISCOVERED, never hardcoded to a person's home. Resolution order per store:
 *   1. explicit CLI flag  2. env var  3. the first conventional default that exists under --root
 * An explicit flag pointing at a nonexistent path is reported (never silently replaced by a
 * default). Anything missing or malformed is reported in `warnings`/`missing`, never fatal.
 *
 * Usage:
 *   bun CollectSignals.ts [--root <dir>] [--days <n>] [--max-rating <n>]
 *                         [--ratings <dir>] [--work <dir>] [--skills <dir>] [--loops <dir>]
 *                         [--skill-gaps <file>]
 *   env: SKILLSCAN_MEMORY_ROOT, SKILLSCAN_RATINGS_FILE, SKILLSCAN_WORK_DIR,
 *        SKILLSCAN_SKILLS_DIR, SKILLSCAN_LOOPS_DIR, SKILLSCAN_SKILL_GAPS_FILE
 *
 * Contract (stdout JSON):
 *   {
 *     window:       { days, since },
 *     sessions:     { slug, mtime }[],                              // recent work-session dirs (. and _ prefixed skipped as system dirs)
 *     frustrations: { date, rating, kind, note }[],                 // low ratings + unrated complaint-class rows, sorted
 *     skillGaps:    { date, calls }[],                              // skill-less substantive sessions (AlgorithmNudge skill-gap row)
 *     registries:   { kind: "skill"|"loop"|"intent", name, description }[],  // for dedup; bodies read by the LLM step
 *     warnings:     string[],                                       // malformed rows, unreadable/oversized files (non-fatal)
 *     missing:      string[],                                       // stores that don't exist in this install
 *     sources:      Record<string,string>                          // resolved paths actually used
 *   }
 * Exit 0 even when stores are missing (a fresh install is a valid, empty corpus);
 * non-zero only on an unexpected internal error.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const MAX_RATINGS_BYTES = 10_000_000; // guard each monthly ledger file
const MAX_NOTE_CHARS = 500;
/** Errata kinds that are frustration whether or not a rating was captured. */
const COMPLAINT_KINDS = new Set(["complaint", "correction", "bug", "incident"]);

type Session = { slug: string; mtime: string };
/** A frustration signal from the Errata ledger. Rated rows count when rating <= --max-rating;
 *  unrated rows (rating null) count when their kind is complaint-class, because most explicit
 *  complaints and corrections are captured without a number. */
type Frustration = { date: string; rating: number | null; kind: string; note: string };
/** One end-of-turn detection from the skill-gap nudge row: a substantive session that
 *  invoked no skill and matched no skill's USE WHEN. Counts only — the hook writes no
 *  prompt text, so recurrence is established without carrying user content. */
type SkillGap = { date: string; calls: number };
type RegistryEntry = { kind: "skill" | "loop" | "intent"; name: string; description: string };
type Corpus = {
  window: { days: number; since: string };
  sessions: Session[];
  frustrations: Frustration[];
  skillGaps: SkillGap[];
  registries: RegistryEntry[];
  warnings: string[];
  missing: string[];
  sources: Record<string, string>;
};

/** Value for `flag`, or undefined. A following token that is itself a flag (starts with "-") is NOT a value. */
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return undefined;
  const v = process.argv[i + 1];
  return v.startsWith("-") ? undefined : v;
}

/** Strict integer flag, clamped to [min,max]; warns (never silently accepts garbage or out-of-range). */
function intArg(flag: string, dflt: number, min: number, max: number, warnings: string[]): number {
  const v = arg(flag);
  if (v === undefined) return dflt;
  if (!/^-?\d+$/.test(v)) { warnings.push(`${flag}: not an integer (${v}); using ${dflt}`); return dflt; }
  let n = Number.parseInt(v, 10);
  if (n < min) { warnings.push(`${flag}: ${n} below ${min}; clamped`); n = min; }
  else if (n > max) { warnings.push(`${flag}: ${n} above ${max}; clamped`); n = max; }
  return n;
}

/**
 * Resolve a store path: explicit flag > env var > first existing default under root.
 * An explicit path that does not exist is a warning + null (never silently falls through to a default).
 * `defaults` is an ordered candidate list; an empty list means the store has no conventional
 * default (opt-in only, e.g. loops). Installs differ in whether the memory tree is at
 * `MEMORY/` or nested under `LIFEOS/MEMORY/`, so both are tried in order.
 */
function resolveStore(
  explicit: string | undefined,
  envVar: string,
  defaults: string[],
  root: string,
  label: string,
  warnings: string[],
): string | null {
  if (explicit !== undefined) {
    if (existsSync(explicit)) return explicit;
    warnings.push(`${label}: --${label} path ${explicit} does not exist`);
    return null;
  }
  const env = process.env[envVar];
  if (env && existsSync(env)) return env;
  for (const rel of defaults) {
    const d = join(root, rel);
    if (existsSync(d)) return d;
  }
  return null;
}

function parseFrustrations(dir: string | null, maxRating: number, since: Date, warnings: string[], missing: string[]): Frustration[] {
  if (!dir) { missing.push("ratings"); return []; }
  const out: Frustration[] = [];
  let bad = 0;
  let files: string[];
  try { files = readdirSync(dir).filter((name) => /^errata-\d{4}-\d{2}\.jsonl$/.test(name) && name.slice(7, 14) >= since.toISOString().slice(0, 7)).sort(); }
  catch (e) { warnings.push(`ratings unreadable: ${(e as Error).message}`); return []; }
  for (const name of files) {
    const file = join(dir, name);
    let raw: string;
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > MAX_RATINGS_BYTES) { warnings.push(`ratings: skipped ${name} (not a regular file or too large)`); continue; }
      raw = readFileSync(file, "utf8");
    } catch (e) { warnings.push(`ratings unreadable: ${name}: ${(e as Error).message}`); continue; }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let j: unknown;
      try { j = JSON.parse(t); } catch { bad++; continue; }
      const r = j as Record<string, unknown>;
      if (r.op === "patch" || r.system !== "lifeos") continue;
      const kind = typeof r.kind === "string" ? r.kind : "";
      const rating = typeof r.rating === "number" && Number.isFinite(r.rating) ? r.rating : null;
      if (rating === null ? !COMPLAINT_KINDS.has(kind) : rating > maxRating) continue;
      const ts = typeof r.ts === "string" ? r.ts : "";
      if (!ts) { bad++; continue; }
      const ms = new Date(ts).getTime();
      if (Number.isNaN(ms)) { bad++; continue; } // unparseable timestamp = malformed, not "out of window"
      if (ms < since.getTime()) continue;
      const note = (typeof r.complaint === "string" ? r.complaint : "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, MAX_NOTE_CHARS);
      out.push({ date: new Date(ms).toISOString().slice(0, 10), rating, kind, note });
    }
  }
  if (bad > 0) warnings.push(`ratings: skipped ${bad} malformed/incomplete line(s)`);
  // Rated rows first, lowest rating first; unrated complaint-class rows after them.
  const rank = (f: Frustration) => f.rating ?? Number.POSITIVE_INFINITY;
  return out.sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1)
    || a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.note.localeCompare(b.note));
}

/**
 * Skill-gap detections inside the window. Each row is `{ts, session_id, calls}` written by
 * AlgorithmNudge's skill-gap row. Malformed rows are counted, never fatal — same contract as
 * every other store here. Sorted fully tie-broken so two runs over an unchanged file are
 * byte-identical.
 */
function parseSkillGaps(file: string | null, since: Date, warnings: string[], missing: string[]): SkillGap[] {
  if (!file) { missing.push("skill-gaps"); return []; }
  let raw: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) { warnings.push(`skill-gaps: not a regular file`); return []; }
    if (st.size > MAX_RATINGS_BYTES) { warnings.push(`skill-gaps: too large (${st.size} bytes), skipped`); return []; }
    raw = readFileSync(file, "utf8");
  } catch (e) { warnings.push(`skill-gaps unreadable: ${(e as Error).message}`); return []; }

  const out: SkillGap[] = [];
  let bad = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let j: unknown;
    try { j = JSON.parse(t); } catch { bad++; continue; }
    const r = j as Record<string, unknown>;
    const ts = typeof r.ts === "string" ? r.ts : "";
    const calls = typeof r.calls === "number" ? r.calls : NaN;
    if (!ts || !Number.isFinite(calls)) { bad++; continue; }
    const ms = new Date(ts).getTime();
    if (Number.isNaN(ms)) { bad++; continue; }
    if (ms < since.getTime()) continue;
    out.push({ date: new Date(ms).toISOString().slice(0, 10), calls });
  }
  if (bad > 0) warnings.push(`skill-gaps: skipped ${bad} malformed/incomplete line(s)`);
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.calls - b.calls);
}

function collectSessions(dir: string | null, since: Date, warnings: string[], missing: string[]): Session[] {
  if (!dir) { missing.push("work-sessions"); return []; }
  let names: string[];
  try { names = readdirSync(dir); } catch (e) { warnings.push(`work dir unreadable: ${(e as Error).message}`); return []; }
  const out: Session[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name.startsWith("_")) continue; // skip hidden / system dirs
    try {
      const st = statSync(join(dir, name));
      if (st.isDirectory() && st.mtime.getTime() >= since.getTime()) out.push({ slug: name, mtime: st.mtime.toISOString().slice(0, 10) });
    } catch { /* transient race on a dir entry — skip, don't fail the run */ }
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.slug.localeCompare(b.slug));
}

/**
 * name + description from a SKILL.md's YAML frontmatter block. Handles folded/block scalars
 * (`description: >` / `|`) by gathering the indented continuation lines. Returns null if there
 * is no frontmatter `name:`.
 */
function readMeta(skillMd: string): { name: string; description: string } | null {
  let txt: string;
  try { txt = readFileSync(skillMd, "utf8"); } catch { return null; }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt);
  const block = fm ? fm[1] : txt;
  const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim();
  if (!name) return null;

  let desc = /^description:\s*(.+)$/m.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  if (/^[>|][+-]?\d*$/.test(desc)) { // block scalar indicator — gather indented continuation
    const lines = block.split("\n");
    const di = lines.findIndex((l) => /^description:\s*[>|]/.test(l));
    const cont: string[] = [];
    for (let k = di + 1; k < lines.length; k++) {
      if (/^\s+\S/.test(lines[k])) cont.push(lines[k].trim());
      else break;
    }
    desc = cont.join(" ");
  }
  return { name, description: desc };
}

function collectRegistries(skillsDir: string | null, loopsDir: string | null, warnings: string[], missing: string[]): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  if (!skillsDir) { missing.push("skills"); }
  else {
    let dirs: string[] = [];
    try { dirs = readdirSync(skillsDir); } catch (e) { warnings.push(`skills dir unreadable: ${(e as Error).message}`); }
    for (const d of dirs) {
      const md = join(skillsDir, d, "SKILL.md");
      if (!existsSync(md)) continue;
      const meta = readMeta(md);
      if (!meta) { warnings.push(`skills: ${d}/SKILL.md unreadable or missing name:`); continue; }
      out.push({ kind: "skill", name: meta.name, description: meta.description });
      const wf = join(skillsDir, d, "Intents"); // intents are reusable coverage too
      if (existsSync(wf)) {
        try { for (const f of readdirSync(wf)) if (f.endsWith(".md")) out.push({ kind: "intent", name: `${meta.name}/${basename(f, ".md")}`, description: "" }); } catch { /* skip */ }
      }
    }
  }
  if (loopsDir) {
    try { for (const f of readdirSync(loopsDir)) if (f.endsWith(".md")) out.push({ kind: "loop", name: basename(f, ".md"), description: "" }); }
    catch (e) { warnings.push(`loops dir unreadable: ${(e as Error).message}`); }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

const HELP = `CollectSignals — read-only signal collector for skill-gap discovery (writes nothing).

Usage:
  bun CollectSignals.ts [--root <dir>] [--days <n>] [--max-rating <n>]
                        [--ratings <dir>] [--work <dir>] [--skills <dir>] [--loops <dir>]
                        [--skill-gaps <file>]

  --root <dir>        base for conventional store defaults (default: $HOME/.claude)
  --days <n>          lookback window, 1-3650 (default: 45)
  --max-rating <n>    highest rating still counted as frustration, 1-10 (default: 4);
                      unrated complaint, correction, bug and incident rows always count
  --ratings <dir>     Errata ledger directory containing monthly JSONL files
  --work <dir>        work-session dirs
  --skills <dir>      skills tree
  --loops <dir>       loop catalog (opt-in; no default)
  --skill-gaps <file> skill-gap detections JSONL (AlgorithmNudge skill-gap row)

Each store resolves flag > env > first existing default under --root.
Env: SKILLSCAN_MEMORY_ROOT, SKILLSCAN_RATINGS_FILE, SKILLSCAN_WORK_DIR,
     SKILLSCAN_SKILLS_DIR, SKILLSCAN_LOOPS_DIR, SKILLSCAN_SKILL_GAPS_FILE

Emits the corpus JSON on stdout: { window, sessions, frustrations, skillGaps, registries, warnings, missing, sources }.
`;

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) { process.stdout.write(HELP); return; }

  const warnings: string[] = [];
  const missing: string[] = [];

  const root = arg("--root") ?? process.env.SKILLSCAN_MEMORY_ROOT ?? join(process.env.HOME ?? ".", ".claude");
  const days = intArg("--days", 45, 1, 3650, warnings);
  const maxRating = intArg("--max-rating", 4, 1, 10, warnings);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const ratingsFile = resolveStore(arg("--ratings"), "SKILLSCAN_RATINGS_FILE",
    ["LIFEOS/USER/ERRATA", "USER/ERRATA"], root, "ratings", warnings);
  const workDir = resolveStore(arg("--work"), "SKILLSCAN_WORK_DIR",
    ["LIFEOS/MEMORY/WORK", "MEMORY/WORK"], root, "work", warnings);
  const skillGapsFile = resolveStore(arg("--skill-gaps"), "SKILLSCAN_SKILL_GAPS_FILE",
    ["LIFEOS/MEMORY/OBSERVABILITY/skill-gap-candidates.jsonl", "MEMORY/OBSERVABILITY/skill-gap-candidates.jsonl"], root, "skill-gaps", warnings);
  const skillsDir = resolveStore(arg("--skills"), "SKILLSCAN_SKILLS_DIR", ["skills"], root, "skills", warnings);
  const loopsDir = resolveStore(arg("--loops"), "SKILLSCAN_LOOPS_DIR", [], root, "loops", warnings); // opt-in; no personal default

  const corpus: Corpus = {
    window: { days, since: since.toISOString().slice(0, 10) },
    sessions: collectSessions(workDir, since, warnings, missing),
    frustrations: parseFrustrations(ratingsFile, maxRating, since, warnings, missing),
    skillGaps: parseSkillGaps(skillGapsFile, since, warnings, missing),
    registries: collectRegistries(skillsDir, loopsDir, warnings, missing),
    warnings,
    missing,
    sources: {
      root,
      ratings: ratingsFile ?? "(none)",
      skillGaps: skillGapsFile ?? "(none)",
      work: workDir ?? "(none)",
      skills: skillsDir ?? "(none)",
      loops: loopsDir ?? "(none)",
    },
  };

  process.stdout.write(JSON.stringify(corpus, null, 2) + "\n");
}

main();
