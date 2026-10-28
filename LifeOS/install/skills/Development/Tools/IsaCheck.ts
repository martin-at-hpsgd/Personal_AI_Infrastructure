#!/usr/bin/env bun
/**
 * IsaCheck — the deterministic half of Build's granularity bar, and Test's
 * pre-flight scan for probes that would write to production.
 *
 *   bun IsaCheck.ts bar <isa> [--json]           compound criteria, compound probes, criteria with no row
 *   bun IsaCheck.ts write-probes <isa> [--json]  probes that would write to a non-local target
 *   bun IsaCheck.ts acceptance <isa> [--since YYYY-MM-DD] [--json]
 *                                                the newest recorded acceptance verdict is pass or waived
 *   bun IsaCheck.ts conform <isa> [--json]       does the ISA meet the current template, and what is missing
 *   bun IsaCheck.ts stamp <isa> --verdict <word> --before <n> --after <m> [--json]
 *                                                Checkup's stamp: writes frontmatter `checkup:`, and
 *                                                `isa_format: <template>` only when conform is clean
 *
 * The bar catches what can be caught without a model: a criterion whose wording
 * joins two assertions, a probe that ANDs two checks, a criterion with no Test
 * Strategy row. Whether each criterion is truly one binary statement is still a
 * judgment; Build sends the residue to an independent reviewer.
 *
 * Every subcommand is read-only except `stamp`, the one writer of an ISA's
 * `checkup:` and `isa_format:` frontmatter keys (20261012-isa-version-checkup-analysis).
 *
 * Exit codes: 0 clean, 1 findings, 2 bad input. `conform`: 0 latest, 1 not.
 * `stamp`: 0 when the checkup was written.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BARE_WORD_TOOL, coverageOf, parseTestStrategy, UNFAILABLE_BUN_E, type Probe } from "../../../LIFEOS/TOOLS/lib/IsaTestStrategy";
import { claimText, isaBody, parseIsaClaimsText, stripBulletPrefix } from "../../../LIFEOS/TOOLS/lib/IsaClaims";
import { CHECKUP_RE, conform, ISA_TEMPLATE_VERSION, type ConformResult } from "../../../LIFEOS/TOOLS/lib/IsaTemplate";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant";
import { gateReport } from "../../../LIFEOS/TOOLS/ISAGate";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** ISAGate's hard verdict on two versions of one ISA, compared in a scratch dir (gateReport reads a path). */
export function gateUnchanged(before: string, after: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "isa-stamp-"));
  try {
    const verdict = (text: string) => {
      const p = join(dir, "ISA.md");
      writeFileSync(p, text);
      const r = gateReport(p);
      return JSON.stringify({ blocks: r.blocks, hard: r.hard.map((v) => v.code).sort() });
    };
    return verdict(before) === verdict(after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
import { writeFrontmatterField } from "../../../hooks/lib/isa-utils";

export interface Criterion {
  id: string;
  text: string;
}

/**
 * Every criterion the shared parser reads (the one Bunker uses): any bullet (`-`, `*`, `+`, `1.`),
 * any checkbox state, split ids (`ISC-2.1`) and named ids (`H-AVAIL`). A parent whose split children sit
 * under it is a container, not a criterion, so only the children are checked. Dropped criteria (`[-]`,
 * tombstones) are skipped.
 */
export function criteriaOf(isaText: string): Criterion[] {
  const lines = isaBody(isaText).split(/\r?\n/);
  const out: Criterion[] = [];
  for (const c of parseIsaClaimsText(isaText).claims) {
    const line = lines[c.line - 1] ?? "";
    if (/^\s*(?:[-*+]|\d+[.)])\s+\[-\]/.test(line) || /\[DROPPED\b/i.test(line)) continue;
    const parsed = c.source === "table"
      ? line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => claimText(cell.trim())).find(Boolean)
      : claimText(stripBulletPrefix(line));
    out.push({ id: c.id, text: (parsed?.body ?? stripBulletPrefix(line)).trim() });
  }
  return out;
}

/**
 * Wording that joins two assertions. Code spans are removed first: `a && b`
 * inside backticks is an identifier or command, not the criterion's grammar.
 * Enumerations inside parentheses ("(ISC / fog / oos)") are one set, not two criteria.
 */
const JOINERS: { re: RegExp; why: string }[] = [
  { re: /\s(and|as well as|plus)\s/i, why: "joins two things with 'and'" },
  { re: /;\s*\S/, why: "two clauses split by a semicolon" },
  { re: /,\s*(then|also)\s/i, why: "chains a second step" },
];

export function compoundReason(text: string): string | null {
  const prose = text.replace(/`[^`]*`/g, "X").replace(/\([^)]*\)/g, "X").replace(/^Anti:\s*/i, "");
  for (const j of JOINERS) if (j.re.test(prose)) return j.why;
  return null;
}

// A check command: something that exits non-zero when the criterion is false.
const CHECK_CMD = /^\s*!?\s*(rg|grep|test|\[|curl|bun\s+test|diff|cmp|git\s+diff)\b/;

/** A probe that ANDs or ORs two independent checks is two criteria wearing one row. */
export function compoundProbe(p: Probe): boolean {
  const cmd = p.tool.replace(/^`|`$/g, "");
  const parts = cmd.split(/\s(?:&&|\|\|)\s/);
  return parts.filter((s) => CHECK_CMD.test(s)).length >= 2;
}

export interface BarFinding {
  isc: string;
  kind: "compound-criterion" | "compound-probe" | "no-row" | "vacuous-probe";
  why: string;
}

export function bar(isaPath: string): BarFinding[] {
  const text = readFileSync(isaPath, "utf8");
  const findings: BarFinding[] = [];
  for (const c of criteriaOf(text)) {
    const why = compoundReason(c.text);
    if (why) findings.push({ isc: c.id, kind: "compound-criterion", why });
  }
  for (const p of parseTestStrategy(isaPath)) {
    if (compoundProbe(p)) findings.push({ isc: p.isc, kind: "compound-probe", why: "one row runs two checks" });
    // A one-word tool cell runs as `bash -c <word>` and checks nothing; Bunker refuses to count it as a pass.
    if ((BARE_WORD_TOOL(p.tool, p.type) && !/^(true|false)$/.test(p.tool.trim())) || UNFAILABLE_BUN_E(p.tool)) findings.push({ isc: p.isc, kind: "vacuous-probe", why: `tool cell "${p.tool.trim()}" checks nothing; put the real command there` });
  }
  for (const id of coverageOf(isaPath).unprobed) findings.push({ isc: id, kind: "no-row", why: "no Test Strategy row" });
  return findings;
}

// ── write-probes ─────────────────────────────────────────────────────────────

const WRITE_SHAPES: RegExp[] = [
  /(?:-X|--request)\s*['"]?(POST|PUT|PATCH|DELETE)\b/i,
  // A data flag counts only on an HTTP client's own segment: `tr -d` and `test -d` are not writes.
  /\b(?:curl|wget|http|https|xh)\b[^|;&]*\s(?:-d|--data(?:-raw|-binary|-urlencode)?|-F|--form)\s/,
  /\bfetch\([^)]*method\s*:\s*['"](POST|PUT|PATCH|DELETE)/i,
];
const SQL_WRITE = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|DATABASE)|TRUNCATE|ALTER\s+TABLE)\b/i;
// SQL is a write only when something runs it. Without a SQL runner, quoted SQL is a search pattern
// (`rg -q 'DELETE FROM users' src/db.ts`): one app's ISA had 14 such greps flagged on 2026-10-10.
const SQL_RUNNER = /\b(sqlite3|psql|mysql|d1\s+(?:query|execute)|--sql\b|--command\b|--execute\b|\.exec\(|\.prepare\()/i;
const unquoted = (cmd: string) => cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " ");
const sqlWrite = (cmd: string) => SQL_WRITE.test(SQL_RUNNER.test(cmd) ? cmd : unquoted(cmd));

// A target is local by its HOST, never by a word elsewhere in the URL: a `/preview/` path or a
// `?host=localhost` query on a production host must not make a write look safe.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.local|.*\.test|.*\bstaging\b.*|.*\bpreview\b.*)$/i;
// With no URL in the command, only loopback tokens and dotted host names carrying staging/preview count.
const LOCAL_NO_URL = /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\.local\b|\.test\b|[\w-]*\b(?:staging|preview)\b[\w-]*\.[a-z]{2,})/i;

function urlIsLocal(u: string): boolean {
  try { return LOCAL_HOST.test(new URL(u).hostname); } catch { return false; }
}

/**
 * A probe writes to production when it has a write shape and a target that
 * isn't local: an http(s) URL that isn't localhost/staging, or a remote
 * database flag. Probes with a write shape and no visible target are flagged
 * too, since the target can't be proven local.
 */
export function writesToProduction(p: Probe): boolean {
  if (p.type === "manual" || p.tool.startsWith("suite:") || p.tool.startsWith("glance:")) return false;
  const cmd = p.tool;
  if (!WRITE_SHAPES.some((re) => re.test(cmd)) && !sqlWrite(cmd)) return false;
  const urls = cmd.match(/https?:\/\/[^\s'"`)]+/g) ?? [];
  if (/--remote\b/.test(cmd)) return true;
  if (!urls.length) return !LOCAL_NO_URL.test(cmd);
  return urls.some((u) => !urlIsLocal(u));
}

export function writeProbes(isaPath: string): Probe[] {
  return parseTestStrategy(isaPath).filter(writesToProduction);
}

// ── acceptance ───────────────────────────────────────────────────────────────

export interface AcceptanceLine {
  line: number;
  verdict: string;
  date: string | null;
  text: string;
}

export interface AcceptanceResult {
  ok: boolean;
  why: string;
  newest: AcceptanceLine[];
}

const ACCEPTANCE_LINE = /^\s*(?:[-*+]\s+)?`?acceptance:\s*([A-Za-z-]+)/i;
const PASSING = new Set(["pass", "passed", "waived"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Every `acceptance: <verdict> <date> …` line in the ISA, in file order. */
export function acceptanceLines(isaText: string): AcceptanceLine[] {
  const out: AcceptanceLine[] = [];
  isaText.split(/\r?\n/).forEach((text, i) => {
    const m = ACCEPTANCE_LINE.exec(text);
    if (!m) return;
    out.push({ line: i + 1, verdict: m[1].toLowerCase(), date: text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] ?? null, text: text.trim() });
  });
  return out;
}

/**
 * The recorded acceptance passes when the newest dated line says pass or waived and is dated on or
 * after `since`. ISAs record newest-first or newest-last, so "newest" is by date, never by position;
 * on the newest date a pass after a same-day fail (the usual fix round) counts. Undated lines and
 * verdicts such as pending or "not run" never pass. Read-only.
 */
export function acceptance(isaText: string, since?: string): AcceptanceResult {
  const dated = acceptanceLines(isaText).filter((l) => l.date);
  if (!dated.length) return { ok: false, why: "no dated acceptance line in the ISA", newest: [] };
  const top = dated.map((l) => l.date as string).sort().at(-1) as string;
  const newest = dated.filter((l) => l.date === top);
  if (since && top < since) return { ok: false, why: `newest acceptance is ${top}, before ${since}`, newest };
  const pass = newest.some((l) => PASSING.has(l.verdict));
  return { ok: pass, why: pass ? `${top} pass` : `${top} ${newest.map((l) => l.verdict).join(", ")}`, newest };
}

// ── stamp ────────────────────────────────────────────────────────────────────

export interface StampOptions {
  verdict: string;
  before: number;
  after: number;
  /** Local YYYY-MM-DD; defaults to today in the process's zone. */
  date?: string;
}

export type StampResult =
  | { ok: true; checkup: string; wroteFormat: boolean; removedStatusLines: number; conform: ConformResult }
  | { ok: false; error: string };

const VERDICT = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Remove `checkup:` lines under `## Status` (fenced blocks left alone). Returns the new text and how many went. */
export function removeStatusCheckup(text: string): { text: string; removed: number } {
  const lines = text.split("\n");
  const out: string[] = [];
  let inStatus = false, fence: string | null = null, removed = 0;
  for (const line of lines) {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) fence = fence === null ? f[1]! : (line.trim().startsWith(fence) ? null : fence);
    if (fence === null && /^##\s/.test(line)) inStatus = /^##\s+Status\b/i.test(line);
    if (inStatus && fence === null && /^\s*(?:[-*+]\s+)?`?checkup:/i.test(line)) { removed++; continue; }
    out.push(line);
  }
  return { text: out.join("\n"), removed };
}

/**
 * Checkup's stamp. Writes frontmatter `checkup: <date> <verdict> <before>→<after>`,
 * removes any `checkup:` line under `## Status`, runs conform on the result, and
 * writes `isa_format: <template>` only when conform is clean. Never touches
 * `isa_format` otherwise. The one writer of both keys.
 */
export function stampIsa(isaPath: string, opts: StampOptions): StampResult {
  if (!existsSync(isaPath)) return { ok: false, error: `no such file: ${isaPath}` };
  if (!VERDICT.test(opts.verdict)) return { ok: false, error: `--verdict must be one word (got "${opts.verdict}")` };
  for (const [k, v] of [["before", opts.before], ["after", opts.after]] as const) {
    if (!Number.isInteger(v) || v < 0) return { ok: false, error: `--${k} must be a whole number (got ${v})` };
  }
  const date = opts.date ?? localDay();
  if (!DAY.test(date)) return { ok: false, error: `date must be YYYY-MM-DD (got ${date})` };
  const original = readFileSync(isaPath, "utf8");
  if (!/^---\n[\s\S]*?\n---/.test(original)) return { ok: false, error: "the ISA has no frontmatter block to stamp" };

  const value = `${date} ${opts.verdict} ${opts.before}→${opts.after}`;
  const withCheckup = writeFrontmatterField(original, "checkup", value);
  const { text: stripped, removed } = removeStatusCheckup(withCheckup);
  const result = conform(stripped, isaPath);
  let next = result.latest ? writeFrontmatterField(stripped, "isa_format", ISA_TEMPLATE_VERSION) : stripped;
  // The stamp also switches ISAGate's invalid-row rule on, so it is earned only when the
  // gate's own hard verdict is the same with and without it (ISC-31).
  if (result.latest && !gateUnchanged(stripped, next)) {
    result.latest = false;
    result.missing.push({ code: "gate-parity", detail: "ISAGate would block or add a hard finding under the new stamp" });
    next = stripped;
  }

  invariant(CHECKUP_RE.test(value), `stamp built a checkup value outside the key's shape: "${value}"`);
  invariant(new RegExp(`^---\\n[\\s\\S]*?^checkup: ${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$[\\s\\S]*?\\n---`, "m").test(next), "stamp lost the checkup key it wrote");
  invariant(isaBody(next).split("\n").length === isaBody(original).split("\n").length - removed, "stamp changed the ISA body beyond the Status checkup lines it removes");
  invariant(!result.latest || conform(next, isaPath).latest, "stamp wrote isa_format on an ISA that does not meet the template");
  invariant(result.latest || (original.match(/^isa_format:.*$/m)?.[0] ?? null) === (next.match(/^isa_format:.*$/m)?.[0] ?? null), "stamp changed isa_format on an ISA that does not meet the template");

  writeFileSync(isaPath, next);
  return { ok: true, checkup: value, wroteFormat: result.latest, removedStatusLines: removed, conform: result };
}

const USAGE = "usage: IsaCheck.ts bar <isa> [--json] | write-probes <isa> [--json] | acceptance <isa> [--since YYYY-MM-DD] [--json] | conform <isa> [--json] | stamp <isa> --verdict <word> --before <n> --after <m> [--json]";

function printConform(r: ConformResult): void {
  console.log(`Latest template (${r.template}): ${r.latest ? "yes" : "no"}`);
  for (const m of r.missing) console.log(`  ${m.code.padEnd(24)} ${m.detail}`);
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  if (argv[0] === "conform" || argv[0] === "stamp") {
    const sub = argv[0];
    const flags = new Map<string, string>();
    const pos: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "--json") continue;
      if (sub === "stamp" && ["--verdict", "--before", "--after"].includes(a)) { flags.set(a, argv[++i] ?? ""); continue; }
      pos.push(a);
    }
    const isa = pos[0];
    if (!isa || pos.length !== 1 || !existsSync(isa)) { console.error(USAGE); return 2; }
    if (sub === "conform") {
      const r = conform(readFileSync(isa, "utf8"), isa);
      if (json) console.log(JSON.stringify(r, null, 2));
      else printConform(r);
      return r.latest ? 0 : 1;
    }
    const num = (k: string) => (/^\d+$/.test(flags.get(k) ?? "") ? Number(flags.get(k)) : NaN);
    if (!flags.has("--verdict") || !flags.has("--before") || !flags.has("--after")) { console.error(USAGE); return 2; }
    const r = stampIsa(isa, { verdict: flags.get("--verdict")!, before: num("--before"), after: num("--after") });
    if ("error" in r) { console.error(`stamp: ${r.error}`); return 2; }
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`checkup: ${r.checkup}${r.removedStatusLines ? ` (moved out of ## Status)` : ""}`);
      console.log(r.wroteFormat ? `isa_format: ${ISA_TEMPLATE_VERSION} (earned)` : "isa_format: unchanged (the ISA does not meet the template yet)");
      printConform(r.conform);
    }
    return 0;
  }
  const si = argv.indexOf("--since");
  const since = si >= 0 ? argv[si + 1] : undefined;
  const [sub, isa] = argv.filter((a, i) => a !== "--json" && (si < 0 || (i !== si && i !== si + 1)));
  if (!isa || !existsSync(isa) || !["bar", "write-probes", "acceptance"].includes(sub ?? "") || (si >= 0 && !DAY.test(since ?? ""))) {
    console.error(USAGE);
    return 2;
  }
  if (sub === "acceptance") {
    const r = acceptance(readFileSync(isa, "utf8"), since);
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(r.ok ? `acceptance: ${r.why}` : `acceptance: not passed (${r.why})`);
      for (const l of r.newest) console.log(`  line ${l.line}: ${l.text.slice(0, 160)}`);
    }
    return r.ok ? 0 : 1;
  }
  if (sub === "bar") {
    const f = bar(isa);
    if (json) console.log(JSON.stringify(f, null, 2));
    else {
      console.log(f.length ? `${f.length} finding(s) — the bar does not pass` : "bar: clean (deterministic half; the atomicity residue still goes to an independent reviewer)");
      for (const x of f) console.log(`  ${x.isc.padEnd(7)} ${x.kind.padEnd(19)} ${x.why}`);
    }
    return f.length ? 1 : 0;
  }
  const w = writeProbes(isa);
  if (json) console.log(JSON.stringify(w.map((p) => ({ isc: p.isc, tool: p.tool })), null, 2));
  else {
    console.log(w.length ? `${w.length} probe(s) would write to production — do not run bunker on this ISA until they point at a local or staging target` : "write-probes: none");
    for (const p of w) console.log(`  ${p.isc.padEnd(7)} ${p.tool}`);
  }
  return w.length ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
