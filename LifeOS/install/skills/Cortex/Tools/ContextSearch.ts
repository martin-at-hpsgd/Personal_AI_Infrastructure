#!/usr/bin/env bun
/** Glance caller: cortex-recall. See LIFEOS/DOCUMENTATION/Assay/AssaySystem.md. */
/// <reference types="bun-types" />
declare const Bun: any;
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { rank, keepWhere, type Ranked } from "../../../LIFEOS/ASSAY/Chain";
import { safeCallerConfig } from "../../../LIFEOS/ASSAY/Assay";
import { inference } from "../../../LIFEOS/TOOLS/Inference";
import { textRequest } from "../../../LIFEOS/TOOLS/DeliveredContext";
import { classifyTranscript, isCompaction } from "../../../LIFEOS/RELAY/bridge/transcriptClass.ts";

const HOME = homedir();
const LIFEOS_DIR = join(HOME, ".claude");
const STATE_DIR = join(LIFEOS_DIR, "LIFEOS", "MEMORY", "STATE");
const WORK_DIR = join(LIFEOS_DIR, "LIFEOS", "MEMORY", "WORK");
// Claude Code writes one transcript dir per working directory under
// ~/.claude/projects/ (lowercase on disk — the old "Projects" spelling only
// worked on case-insensitive macOS), named by the cwd with "/" and "." mapped
// to "-". Search ALL of them: pinning to the ~/.claude slug alone made every
// session run inside a code repo unrecallable (public issues #1494 + #1498,
// @christauff / @simeonzickert).
const PROJECTS_ROOT = join(LIFEOS_DIR, "projects");
const WORK_JSON = join(STATE_DIR, "work.json");
const NAMES_JSON = join(STATE_DIR, "session-names.json");

// A hand-listed stopword set is a crude stand-in for IDF, which would subsume
// it: a term's weight should fall out of how rare it is in the corpus rather
// than from a list someone maintains. Kept as-is deliberately — the ranking win
// measured in public issue #1755 came from normalization and damping, and
// adding real IDF on top is a separate change with its own evidence to gather.
const STOPWORDS = new Set([
  "the", "a", "an", "on", "in", "of", "to", "that", "it",
  "is", "was", "we", "you", "i", "and", "or", "for", "with",
]);

/**
 * Per-source score weights, applied after each source is normalized to [0,1].
 *
 * Raw scores from different sources are not comparable: `tokenOverlap` over a
 * session name tops out in the single digits while a ripgrep count over a
 * megabyte of transcript runs to the hundreds, so summing them at merge let one
 * verbose transcript outrank an exactly-matching session. Normalizing first
 * makes the sum meaningful, and the weights then say what a match in each
 * source is worth: curated session metadata is the strongest evidence, ISA
 * bodies are strong, and a hit anywhere in a conversation log is the weakest.
 *
 * Fixes public issue #1755 (@xmasyx), whose own recall benchmark moved from 0%
 * to 83% with this plus the length damping below.
 */
const SOURCE_WEIGHTS: Record<Source, number> = {
  "work.json": 1.0,
  "session-names.json": 1.0,
  "work-dir": 1.0,
  "isa-body": 0.7,
  "project-isa": 0.7,
  jsonl: 0.4,
};

/** Scale a source's scores into [0,1] by its own max, then weight them. */
function normalize(results: Result[], weight: number): Result[] {
  let max = 0;
  for (const r of results) if (r.score > max) max = r.score;
  if (max <= 0) return results;
  for (const r of results) r.score = (r.score / max) * weight;
  return results;
}

type Source = "work.json" | "session-names.json" | "work-dir" | "isa-body" | "project-isa" | "jsonl";

/** All Claude Code transcript dirs (one per cwd ever worked in). */
function projectDirs(): string[] {
  if (!existsSync(PROJECTS_ROOT)) return [];
  return readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(PROJECTS_ROOT, e.name));
}

/** uuid → transcript path, across every project dir. */
function jsonlIndex(): Map<string, string> {
  const idx = new Map<string, string>();
  for (const dir of projectDirs()) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (f.endsWith(".jsonl")) idx.set(f.slice(0, -".jsonl".length), join(dir, f));
    }
  }
  return idx;
}

/**
 * Real cwd of each project dir, recovered from the `cwd` field of a transcript
 * line (the dir name's slug encoding is lossy, so decode from data instead).
 * Used to find `<project>/ISA.md` — the ISA home for anything with persistent
 * identity, which lives exactly where MEMORY/WORK-rooted search never looked.
 */
function discoveredProjectCwds(): string[] {
  const cwds = new Set<string>();
  for (const dir of projectDirs()) {
    let newest: { path: string; mtime: number } | null = null;
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const p = join(dir, f);
        const mt = statSync(p).mtimeMs;
        if (!newest || mt > newest.mtime) newest = { path: p, mtime: mt };
      }
    } catch { continue; }
    if (!newest) continue;
    try {
      const head = readFileSync(newest.path, "utf8").slice(0, 16_384);
      const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) cwds.add(JSON.parse(`"${m[1]}"`));
    } catch { /* unreadable transcript — skip */ }
  }
  return [...cwds];
}

interface Result {
  source: Source[];
  slug: string;
  sessionUuid?: string;
  name?: string;
  task?: string;
  phase?: string;
  progress?: string;
  effort?: string;
  score: number;
  recencyDays: number | null;
  snippet?: string;
  path?: string;
  relevance?: number | null;
}

interface Args {
  query: string;
  limit: number;
  since: Date | null;
  pretty: boolean;
  json: boolean;
  help: boolean;
  judge: boolean;
  answer: boolean;
  judgeTop: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    query: "",
    limit: 10,
    since: null,
    pretty: false,
    json: false,
    help: false,
    judge: false,
    answer: false,
    judgeTop: 20,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--pretty") args.pretty = true;
    else if (a === "--json") args.json = true;
    else if (a === "--judge") args.judge = true;
    else if (a === "--answer") { args.answer = true; args.judge = true; }
    else if (a === "--judge-top") { const n = parseInt(argv[++i] ?? "", 10); if (!Number.isNaN(n)) args.judgeTop = n; }
    else if (a.startsWith("--judge-top=")) { const n = parseInt(a.slice("--judge-top=".length), 10); if (!Number.isNaN(n)) args.judgeTop = n; }
    else if (a === "--limit") {
      const n = parseInt(argv[++i] ?? "", 10);
      if (!Number.isNaN(n)) args.limit = n;
    } else if (a === "--since") {
      const d = new Date(argv[++i] ?? "");
      if (!Number.isNaN(d.getTime())) args.since = d;
    } else if (a.startsWith("--limit=")) {
      const n = parseInt(a.slice("--limit=".length), 10);
      if (!Number.isNaN(n)) args.limit = n;
    } else if (a.startsWith("--since=")) {
      const d = new Date(a.slice("--since=".length));
      if (!Number.isNaN(d.getTime())) args.since = d;
    } else if (!a.startsWith("--")) {
      positional.push(a);
    }
  }
  args.query = positional.join(" ").trim();
  return args;
}

function printHelp() {
  console.log(`ContextSearch — find prior LifeOS work by topic, tokens, or date.

Usage:
  bun run ContextSearch.ts <query> [flags]

Flags:
  --limit N        Max results (default 10, 0 = all)
  --since DATE     Only results updated on/after DATE (YYYY-MM-DD)
  --pretty         Force pretty terminal output (default if TTY)
  --json           Force single-line JSON (default if piped)
  --judge          Re-rank top candidates with Glance
  --judge-top N    Candidates to judge (default 20)
  --answer         Judge, then have the low API lane answer from the top 3
  --help, -h       Show this help

Examples:
  bun run ContextSearch.ts "extended markdown"
  bun run ContextSearch.ts pulse effort tag --limit 5
  bun run ContextSearch.ts "yesterday markdown"
  bun run ContextSearch.ts "isa render" --since 2026-05-01 --json`);
}

function tokenize(text: string): string[] {
  // Unicode-aware split: ASCII-only classes truncated accented words
  // ("accessibilità" → "accessibilit") for every diacritic language
  // (public issue #1755, @xmasyx).
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function parseDateFilter(query: string): { since: Date | null; until: Date | null; query: string } {
  const q = query.toLowerCase();
  const now = new Date();
  const day = (offset: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - offset);
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const endOfDay = (d: Date) => {
    const e = new Date(d);
    e.setHours(23, 59, 59, 999);
    return e;
  };

  const removed = (phrase: string) =>
    query.replace(new RegExp(phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "ig"), " ").replace(/\s+/g, " ").trim();

  if (/\bday before yesterday\b/i.test(q)) {
    const d = day(2);
    return { since: d, until: endOfDay(d), query: removed("day before yesterday") };
  }
  if (/\byesterday\b/i.test(q)) {
    const d = day(1);
    return { since: d, until: endOfDay(d), query: removed("yesterday") };
  }
  if (/\btoday\b/i.test(q)) {
    const d = day(0);
    return { since: d, until: endOfDay(d), query: removed("today") };
  }
  if (/\blast week\b/i.test(q)) return { since: day(7), until: null, query: removed("last week") };
  if (/\bthis week\b/i.test(q)) return { since: day(7), until: null, query: removed("this week") };
  if (/\blast month\b/i.test(q)) return { since: day(30), until: null, query: removed("last month") };

  const nDays = q.match(/\b(\d+)\s+days?\s+ago\b/);
  if (nDays) {
    const d = day(parseInt(nDays[1]!, 10));
    return { since: d, until: endOfDay(d), query: removed(nDays[0]!) };
  }

  const isoDate = q.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoDate) {
    const d = new Date(isoDate[0]!);
    if (!Number.isNaN(d.getTime())) {
      d.setHours(0, 0, 0, 0);
      return { since: d, until: endOfDay(d), query: removed(isoDate[0]!) };
    }
  }

  return { since: null, until: null, query };
}

function recencyMultiplier(d: Date | null): { multiplier: number; days: number | null } {
  if (!d) return { multiplier: 1, days: null };
  const days = Math.max(0, (Date.now() - d.getTime()) / 86_400_000);
  return { multiplier: 1 + 1 / (1 + days), days };
}

function tokenOverlap(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) return 0;
  const haystack = new Set(tokenize(text));
  let hits = 0;
  for (const t of queryTokens) if (haystack.has(t)) hits++;
  return hits;
}

function dateFromSlug(slug: string): Date | null {
  const m = slug.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function passSinceFilter(d: Date | null, since: Date | null, until: Date | null = null): boolean {
  if (!since && !until) return true;
  if (!d) return false;
  if (since && d.getTime() < since.getTime()) return false;
  if (until && d.getTime() > until.getTime()) return false;
  return true;
}

function searchWorkJson(tokens: string[], since: Date | null, until: Date | null = null): Result[] {
  if (!existsSync(WORK_JSON)) return [];
  const data = JSON.parse(readFileSync(WORK_JSON, "utf8"));
  const sessions = data.sessions ?? {};
  const out: Result[] = [];
  for (const [slug, entry] of Object.entries<any>(sessions)) {
    const updated = entry.updatedAt ? new Date(entry.updatedAt) : dateFromSlug(slug);
    if (!passSinceFilter(updated, since, until)) continue;
    const blob = [slug, entry.task, entry.sessionName].filter(Boolean).join(" ");
    const overlap = tokenOverlap(tokens, blob);
    if (overlap === 0 && tokens.length > 0) continue;
    const { multiplier, days } = recencyMultiplier(updated);
    out.push({
      source: ["work.json"],
      slug,
      sessionUuid: entry.sessionUUID,
      task: entry.task,
      name: entry.sessionName,
      phase: entry.phase,
      progress: entry.progress,
      effort: entry.effort,
      score: overlap * multiplier,
      recencyDays: days,
      // work.json stores ISA paths relative to ~/.claude/LIFEOS ("MEMORY/WORK/…", "PI/ISA.md"),
      // not to ~/.claude; joining onto the root pointed every such result at a missing file.
      path: entry.isa ? (entry.isa.startsWith("/") ? entry.isa : join(LIFEOS_DIR, "LIFEOS", entry.isa)) : undefined,
    });
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ad = a.recencyDays ?? Number.POSITIVE_INFINITY;
    const bd = b.recencyDays ?? Number.POSITIVE_INFINITY;
    return ad - bd;
  });
  return out.slice(0, 50);
}

function searchSessionNames(tokens: string[], since: Date | null, until: Date | null = null): Result[] {
  if (!existsSync(NAMES_JSON)) return [];
  const data = JSON.parse(readFileSync(NAMES_JSON, "utf8"));
  const out: Result[] = [];
  const fileMtime = (() => {
    try {
      return new Date(statSync(NAMES_JSON).mtime);
    } catch {
      return null;
    }
  })();
  const idx = jsonlIndex();
  for (const [uuid, name] of Object.entries<string>(data)) {
    const overlap = tokenOverlap(tokens, name);
    if (overlap === 0 && tokens.length > 0) continue;
    let dt: Date | null = null;
    const jsonlPath = idx.get(uuid);
    if (jsonlPath) {
      try {
        dt = new Date(statSync(jsonlPath).mtime);
      } catch {}
    }
    if (!dt) dt = fileMtime;
    if (!passSinceFilter(dt, since, until)) continue;
    const { multiplier, days } = recencyMultiplier(dt);
    out.push({
      source: ["session-names.json"],
      slug: uuid,
      sessionUuid: uuid,
      name,
      score: overlap * multiplier,
      recencyDays: days,
      path: jsonlPath,
    });
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ad = a.recencyDays ?? Number.POSITIVE_INFINITY;
    const bd = b.recencyDays ?? Number.POSITIVE_INFINITY;
    return ad - bd;
  });
  return out.slice(0, 50);
}

function searchWorkDirs(tokens: string[], since: Date | null, until: Date | null = null): Result[] {
  if (!existsSync(WORK_DIR)) return [];
  const dirs = readdirSync(WORK_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const out: Result[] = [];
  for (const dir of dirs) {
    const dt = dateFromSlug(dir);
    if (!passSinceFilter(dt, since, until)) continue;
    const slugCore = dir.replace(/^\d{4}-?\d{2}-?\d{2}[-_]?(\d+_)?/, "");
    const overlap = tokenOverlap(tokens, slugCore);
    if (overlap === 0 && tokens.length > 0) continue;
    const { multiplier, days } = recencyMultiplier(dt);
    const isaPath = join(WORK_DIR, dir, "ISA.md");
    out.push({
      source: ["work-dir"],
      slug: dir,
      score: overlap * multiplier,
      recencyDays: days,
      path: existsSync(isaPath) ? isaPath : undefined,
    });
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ad = a.recencyDays ?? Number.POSITIVE_INFINITY;
    const bd = b.recencyDays ?? Number.POSITIVE_INFINITY;
    return ad - bd;
  });
  return out.slice(0, 50);
}

/**
 * Resolve a runnable ripgrep. On machines without a real `rg` binary, Claude
 * Code's shell integration aliases rg to its embedded ripgrep via a shell
 * FUNCTION — invisible to Bun.spawn, so every rg-backed source (ISA bodies,
 * conversation logs) dies with "Executable not found in $PATH". Fall back to
 * running the Claude Code executable with argv0="rg", the same trick the shell
 * function uses. (Public PR #1486, credit @anikinsasha.)
 */
function rgCommand(): { exe: string; argv0?: string } {
  const onPath = typeof Bun.which === "function" ? Bun.which("rg") : null;
  if (onPath) return { exe: onPath };
  const cc = process.env.CLAUDE_CODE_EXECPATH || join(HOME, ".local", "bin", "claude");
  if (existsSync(cc)) return { exe: cc, argv0: "rg" };
  return { exe: "rg" };
}

async function ripgrep(pattern: string, dir: string, extra: string[] = []): Promise<string> {
  const { exe, argv0 } = rgCommand();
  const proc = Bun.spawn([exe, "--no-heading", "--line-number", "-i", ...extra, pattern, dir], {
    stdout: "pipe",
    stderr: "pipe",
    ...(argv0 ? { argv0 } : {}),
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

async function searchISABodies(tokens: string[], since: Date | null, until: Date | null = null): Promise<Result[]> {
  if (tokens.length === 0 || !existsSync(WORK_DIR)) return [];
  const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const out = await ripgrep(pattern, WORK_DIR, ["--glob", "*ISA.md", "-c"]);
  const byDir = new Map<string, { hits: number; isaPath: string }>();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const m = line.match(/^(.+?):(\d+)$/);
    if (!m) continue;
    const path = m[1]!;
    const hits = parseInt(m[2]!, 10);
    const dir = basename(path.replace(/\/ISA\.md$/, ""));
    const prev = byDir.get(dir);
    if (!prev || hits > prev.hits) byDir.set(dir, { hits, isaPath: path });
  }
  const results: Result[] = [];
  for (const [dir, info] of byDir.entries()) {
    const dt = dateFromSlug(dir);
    if (!passSinceFilter(dt, since, until)) continue;
    const { multiplier, days } = recencyMultiplier(dt);
    let snippet: string | undefined;
    try {
      const body = readFileSync(info.isaPath, "utf8");
      const re = new RegExp(`(.{0,40}(?:${pattern}).{0,80})`, "i");
      const sm = body.match(re);
      if (sm) snippet = sm[1]!.trim().replace(/\s+/g, " ").slice(0, 160);
    } catch {}
    results.push({
      source: ["isa-body"],
      slug: dir,
      // Damped: the tenth mention of a term says far less than the second, so a
      // long document should not outrank an exact match on length alone.
      score: Math.log(1 + info.hits) * multiplier,
      recencyDays: days,
      snippet,
      path: info.isaPath,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 100);
}

/**
 * `<project>/ISA.md` — the long-lived ISA of anything with persistent identity
 * (public issue #1498, @simeonzickert). Candidates come from two places: cwds
 * recovered from transcripts, and absolute `isa` paths in the work registry.
 * A project ISA that can't be found is indistinguishable from work never done.
 */
async function searchProjectIsas(tokens: string[], since: Date | null, until: Date | null = null): Promise<Result[]> {
  if (tokens.length === 0) return [];
  const candidates = new Set<string>();
  for (const cwd of discoveredProjectCwds()) {
    if (cwd === LIFEOS_DIR) continue; // task ISAs under ~/.claude are covered by the WORK_DIR sources
    const isa = join(cwd, "ISA.md");
    if (existsSync(isa)) candidates.add(isa);
  }
  if (existsSync(WORK_JSON)) {
    try {
      const data = JSON.parse(readFileSync(WORK_JSON, "utf8"));
      for (const e of Object.values<any>(data.sessions ?? {})) {
        if (typeof e?.isa === "string" && e.isa.startsWith("/") && existsSync(e.isa)) candidates.add(e.isa);
      }
    } catch {}
  }
  if (candidates.size === 0) return [];
  const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(.{0,40}(?:${pattern}).{0,80})`, "i");
  const results: Result[] = [];
  for (const isaPath of candidates) {
    let body: string;
    try { body = readFileSync(isaPath, "utf8"); } catch { continue; }
    const hits = (body.match(new RegExp(pattern, "gi")) || []).length;
    if (hits === 0) continue;
    let dt: Date | null = null;
    try { dt = new Date(statSync(isaPath).mtime); } catch {}
    if (!passSinceFilter(dt, since, until)) continue;
    const { multiplier, days } = recencyMultiplier(dt);
    const sm = body.match(re);
    const phase = body.match(/^phase:\s*(.+)$/m)?.[1]?.trim();
    const progress = body.match(/^progress:\s*(.+)$/m)?.[1]?.trim();
    results.push({
      source: ["project-isa"],
      slug: basename(isaPath.replace(/\/ISA\.md$/, "")),
      score: Math.log(1 + hits) * multiplier,
      recencyDays: days,
      snippet: sm ? sm[1]!.trim().replace(/\s+/g, " ").slice(0, 160) : undefined,
      phase,
      progress,
      path: isaPath,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 50);
}

/**
 * True unless the transcript is a compaction call (Tex F19, ISC-237): its first user message, read whole, carries
 * the compactor task header right after its <chat> view. A principal text turn carries <turn> there and stays. The one
 * classifier (LIFEOS/RELAY/bridge/transcriptClass.ts) decides; an unreadable file counts as a conversation, so the
 * filter never hides a real session.
 */
function isConversationTranscript(path: string): boolean {
  return !isCompaction(classifyTranscript(path));
}

async function searchJsonl(tokens: string[], since: Date | null, until: Date | null = null): Promise<Result[]> {
  if (tokens.length === 0 || !existsSync(PROJECTS_ROOT)) return [];
  // A guard here compared PROJECTS_ROOT with the same path rebuilt by hand, so it never
  // refused anything; removed rather than kept as a check that reads like one (public
  // discussion #2252, @mj-deving). ripgrep does not follow symlinks, so the walk stays in the tree.
  const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const out = await ripgrep(pattern, PROJECTS_ROOT, ["--glob", "*.jsonl", "-c"]);
  const byFile = new Map<string, { hits: number; path: string }>();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const m = line.match(/^(.+?):(\d+)$/);
    if (!m) continue;
    const p = m[1]!;
    const hits = parseInt(m[2]!, 10);
    byFile.set(p, { hits, path: p });
  }
  const results: Result[] = [];
  // Drop non-conversation transcripts BEFORE the top-N cut: a compaction transcript carries the
  // whole conversation in its first prompt, so it out-hits the real session and used to fill
  // the 30 slots, which pushed real sessions out before the filter could see them.
  const sorted = [...byFile.entries()]
    .sort((a, b) => b[1].hits - a[1].hits)
    .filter(([p]) => isConversationTranscript(p))
    .slice(0, 30);
  const re = new RegExp(pattern, "i");
  for (const [path, info] of sorted) {
    let snippet: string | undefined;
    let firstUserTimestamp: Date | null = null;
    let mtime: Date | null = null;
    try {
      mtime = new Date(statSync(path).mtime);
    } catch {}
    try {
      const text = readFileSync(path, "utf8");
      let nlIdx = -1;
      while (true) {
        const start = nlIdx + 1;
        nlIdx = text.indexOf("\n", start);
        const ln = nlIdx === -1 ? text.slice(start) : text.slice(start, nlIdx);
        if (ln.length > 0) {
          if (!firstUserTimestamp || !snippet) {
            try {
              if (ln.includes('"type":"user"')) {
                const j = JSON.parse(ln);
                if (j.type === "user") {
                  if (!firstUserTimestamp && j.timestamp) {
                    const t = new Date(j.timestamp);
                    if (!Number.isNaN(t.getTime())) firstUserTimestamp = t;
                  }
                  if (!snippet && re.test(ln)) {
                    const c = j?.message?.content;
                    let userText = "";
                    if (typeof c === "string") userText = c;
                    else if (Array.isArray(c)) {
                      for (const p of c) if (p?.type === "text") userText += " " + (p.text ?? "");
                    }
                    // A principal text turn opens with the thread view: the snippet is the request after it.
                    userText = textRequest(userText).trim();
                    if (userText && !userText.startsWith("<") && re.test(userText)) {
                      snippet = userText.replace(/\s+/g, " ").slice(0, 200);
                    }
                  }
                }
              }
            } catch {}
          }
          if (firstUserTimestamp && snippet) break;
        }
        if (nlIdx === -1) break;
      }
    } catch {}
    const dt = firstUserTimestamp ?? mtime;
    if (!passSinceFilter(dt, since, until)) continue;
    if (!snippet) continue;
    const { multiplier, days } = recencyMultiplier(dt);
    const uuid = basename(path).replace(/\.jsonl$/, "");
    results.push({
      source: ["jsonl"],
      slug: uuid,
      sessionUuid: uuid,
      score: Math.log(1 + info.hits) * multiplier,
      recencyDays: days,
      snippet,
      path,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 100);
}

function dedupe(all: Result[]): Result[] {
  const namesPath = NAMES_JSON;
  const sessionNames = existsSync(namesPath) ? JSON.parse(readFileSync(namesPath, "utf8")) : {};
  const workData = existsSync(WORK_JSON) ? JSON.parse(readFileSync(WORK_JSON, "utf8")) : { sessions: {} };
  const uuidToSlug = new Map<string, string>();
  for (const [slug, e] of Object.entries<any>(workData.sessions ?? {})) {
    if (e.sessionUUID) uuidToSlug.set(e.sessionUUID, slug);
  }
  const merged = new Map<string, Result>();
  for (const r of all) {
    const key = r.sessionUuid && uuidToSlug.has(r.sessionUuid)
      ? uuidToSlug.get(r.sessionUuid)!
      : r.slug;
    const existing = merged.get(key);
    if (!existing) {
      const enriched = { ...r, slug: key };
      if (r.sessionUuid && sessionNames[r.sessionUuid] && !enriched.name) {
        enriched.name = sessionNames[r.sessionUuid];
      }
      merged.set(key, enriched);
    } else {
      existing.score += r.score;
      for (const s of r.source) if (!existing.source.includes(s)) existing.source.push(s);
      if (r.snippet && !existing.snippet) existing.snippet = r.snippet;
      if (r.task && !existing.task) existing.task = r.task;
      if (r.name && !existing.name) existing.name = r.name;
      if (r.phase && !existing.phase) existing.phase = r.phase;
      if (r.progress && !existing.progress) existing.progress = r.progress;
      if (r.effort && !existing.effort) existing.effort = r.effort;
      if (r.path && !existing.path) existing.path = r.path;
      if (r.recencyDays !== null && (existing.recencyDays === null || r.recencyDays < existing.recencyDays)) {
        existing.recencyDays = r.recencyDays;
      }
    }
  }
  return [...merged.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ad = a.recencyDays ?? Number.POSITIVE_INFINITY;
    const bd = b.recencyDays ?? Number.POSITIVE_INFINITY;
    return ad - bd;
  });
}

function formatPretty(query: string, results: Result[], stats: Record<string, number>, answer?: AnswerResult): string {
  const lines: string[] = [];
  lines.push(`═══ CONTEXT: ${query || "(empty query)"} ═══════════════════════`);
  lines.push("");
  if (results.length === 0) {
    lines.push(absenceMessage(query));
    lines.push("");
    lines.push(`Searched: work.json=${stats.work}, names=${stats.names}, dirs=${stats.dirs}, isa=${stats.isa}, projectIsa=${stats.projectIsa}, jsonl=${stats.jsonl}`);
    lines.push("════════════════════════════════════════════════");
    return lines.join("\n");
  }
  lines.push(`📋 RESULTS (${results.length}, newest+best first):`);
  if (answer) lines.push(`Answer: ${answer.answer}${answer.note ? ` (${answer.note})` : ""}`);
  for (const r of results) {
    const head = `  • ${r.slug}`;
    const meta = [
      r.task ? `task: ${r.task}` : r.name ? `name: ${r.name}` : null,
      r.phase ? `phase: ${r.phase}` : null,
      r.progress ? `progress: ${r.progress}` : null,
      r.effort ? `effort: ${r.effort}` : null,
      r.recencyDays !== null ? `${r.recencyDays.toFixed(1)}d ago` : null,
      `score: ${r.score.toFixed(2)}`,
      r.relevance !== undefined ? `relevance: ${r.relevance === null ? "error" : r.relevance.toFixed(3)}` : null,
      `sources: ${r.source.join(",")}`,
    ].filter(Boolean).join(" | ");
    lines.push(head);
    lines.push(`    ${meta}`);
    if (r.snippet) lines.push(`    ↳ "${r.snippet}"`);
    if (r.path) lines.push(`    ${r.path}`);
  }
  lines.push("");
  lines.push(`Searched: work.json=${stats.work}, names=${stats.names}, dirs=${stats.dirs}, isa=${stats.isa}, jsonl=${stats.jsonl}`);
  lines.push("════════════════════════════════════════════════");
  return lines.join("\n");
}

type AnswerResult = { answer: string; used: string[]; found: boolean; note?: string };
/** What the engine sees per candidate: the metadata plus the passages that best match the question, so a result is never judged on its slug alone. */
function compactState(r: Result, tokens: string[]): object { return { name: r.name, task: r.task, slug: r.slug, excerpt: material(r, tokens, 1500) }; }
/**
 * The passages of a recalled file that best match the question, capped at 6000 chars. Taking the
 * file head missed answers that live low in an ISA (its Decisions section) or deep in a transcript.
 * Paragraphs are scored by query-token overlap and emitted in file order.
 */
function material(r: Result, tokens: string[], cap = 6000): string {
  let text = r.snippet ?? "";
  if (r.path && existsSync(r.path)) { try { text = readFileSync(r.path, "utf8").slice(0, 5_000_000); } catch {} }
  if (text.length <= cap) return text;
  const paras = text.split(/\n\s*\n/).map((body, i) => ({ i, body: body.slice(0, 1500), score: tokenOverlap(tokens, body) }));
  const picked = paras.filter((p) => p.score > 0).sort((x, y) => y.score - x.score);
  const out: typeof paras = [];
  let used = 0;
  for (const p of picked) { if (used + p.body.length > cap) continue; out.push(p); used += p.body.length; }
  if (out.length === 0) return text.slice(0, cap);
  return out.sort((x, y) => x.i - y.i).map((p) => p.body).join("\n…\n");
}

/** The low API lane answers from the top 3 judged results. Reuses the relevance judgments; no second judgment-layer call. */
async function answerFrom(query: string, results: Result[], ranked: Ranked<object>[]): Promise<AnswerResult> {
  const top = results.slice(0, 3);
  const topSlugs = new Set(top.map((r) => r.slug));
  const gate = keepWhere(ranked.filter((row) => topSlugs.has((row.item as { slug: string }).slug)), "relevant", { caller: "cortex-recall" });
  const keptSlugs = new Set(gate.items.map((row) => (row as { slug: string }).slug));
  const skipped = gate.wouldDrop.map((row) => (row as { slug: string }).slug);
  const enforce = safeCallerConfig("cortex-recall")?.mode === "enforce";
  if (enforce && keptSlugs.size === 0) return { answer: "This does not appear to be in memory.", used: [], found: false };
  const chosen = enforce ? top.filter((r) => keptSlugs.has(r.slug)) : top;
  const note = !enforce && skipped.length ? { note: `Enforce would have skipped: ${skipped.join(", ")}` } : {};
  const source = chosen.map((r) => `--- ${r.slug} ---\n${material(r, tokenize(query))}`).join("\n");
  const response = await inference({ vendor: "openai", level: "low", expectJson: true, allowVendorFallback: false, systemPrompt: "Answer only from the supplied material. Return JSON {answer:string, used:string[], found:boolean}; used lists the slugs you drew on.", userPrompt: `Question: ${query}\n\nMaterial:\n${source}` });
  if (!response.success || !response.parsed || typeof response.parsed !== "object") return { answer: "I could not answer from the recalled material.", used: [], found: false, ...note };
  const parsed = response.parsed as Partial<AnswerResult>;
  return { answer: typeof parsed.answer === "string" ? parsed.answer : "I could not answer from the recalled material.", used: Array.isArray(parsed.used) ? parsed.used.filter((x): x is string => typeof x === "string") : [], found: parsed.found === true, ...note };
}

function absenceMessage(query: string): string {
  return `No prior work found on "${query}" (searched work.json, session names, work dirs, ISA bodies, project ISAs, and conversation logs across all project dirs).`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const { since: parsedSince, until: parsedUntil, query: cleanedQuery } = parseDateFilter(args.query);
  const since = args.since ?? parsedSince;
  const until = parsedUntil;
  const tokens = tokenize(cleanedQuery);

  const [work, names, dirs, isa, projectIsa, jsonl] = await Promise.all([
    Promise.resolve(searchWorkJson(tokens, since, until)),
    Promise.resolve(searchSessionNames(tokens, since, until)),
    Promise.resolve(searchWorkDirs(tokens, since, until)),
    searchISABodies(tokens, since, until),
    searchProjectIsas(tokens, since, until),
    searchJsonl(tokens, since, until),
  ]);

  // Normalize per source before merging: dedupe() sums the scores of results
  // that resolve to the same session, and that sum only means anything once the
  // sources are on one scale (see SOURCE_WEIGHTS).
  const all = [
    ...normalize(work, SOURCE_WEIGHTS["work.json"]),
    ...normalize(names, SOURCE_WEIGHTS["session-names.json"]),
    ...normalize(dirs, SOURCE_WEIGHTS["work-dir"]),
    ...normalize(isa, SOURCE_WEIGHTS["isa-body"]),
    ...normalize(projectIsa, SOURCE_WEIGHTS["project-isa"]),
    ...normalize(jsonl, SOURCE_WEIGHTS.jsonl),
  ];
  let merged = dedupe(all);
  let ranked: Ranked<object>[] = [];
  if (args.judge) {
    const top = merged.slice(0, args.judgeTop);
    ranked = await rank(top.map((r) => compactState(r, tokens)), "relevant", `Does this prior session or ISA likely contain the answer to: ${args.query}?`, { caller: "cortex-recall" });
    const bySlug = new Map(top.map((r) => [r.slug, r]));
    const judged = ranked.map((r) => {
      const state = r.item as { slug: string };
      return { ...bySlug.get(state.slug)!, relevance: r.relevance };
    });
    merged = [...judged, ...merged.slice(top.length)];
  }
  const answer = args.answer ? await answerFrom(args.query, merged, ranked) : undefined;
  if (args.limit > 0) merged = merged.slice(0, args.limit);

  const stats = {
    work: work.length,
    names: names.length,
    dirs: dirs.length,
    isa: isa.length,
    projectIsa: projectIsa.length,
    jsonl: jsonl.length,
  };

  const wantJson = args.json || (!args.pretty && !process.stdout.isTTY);
  const absence = merged.length === 0 ? absenceMessage(args.query) : null;
  if (wantJson) {
    process.stdout.write(JSON.stringify({
      query: args.query,
      cleaned_query: cleanedQuery,
      tokens,
      since: since?.toISOString() ?? null,
      until: until?.toISOString() ?? null,
      stats,
      absence,
      results: merged,
      ...(answer ? { answer } : {}),
    }) + "\n");
  } else {
    process.stdout.write(formatPretty(args.query, merged, stats, answer) + "\n");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("ContextSearch error:", err?.message ?? err);
  process.exit(1);
});
