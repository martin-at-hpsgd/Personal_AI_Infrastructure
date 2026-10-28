#!/usr/bin/env bun
/**
 * Vera CLI - the claim ledger and its projections.
 *
 *   bun LIFEOS/VERA/Vera.ts init
 *   bun LIFEOS/VERA/Vera.ts add <slug> --statement "..." --source "..." --kind judged \
 *        --axes technical-depth,rigor --happened 2026-01-15 --confidence 0.7 [--sensitivity public] [--stated-p 0.8]
 *   bun LIFEOS/VERA/Vera.ts resolve <slug> <claim-id> true|false
 *   bun LIFEOS/VERA/Vera.ts score <slug> [--json]
 *   bun LIFEOS/VERA/Vera.ts ask <slug> --intent <branch|leaf> [--explain] [--json]
 *   bun LIFEOS/VERA/Vera.ts profile <slug>
 *   bun LIFEOS/VERA/Vera.ts import-kb [--limit N]
 *   bun LIFEOS/VERA/Vera.ts export-pulse
 *   bun LIFEOS/VERA/Vera.ts list
 *   bun LIFEOS/VERA/Vera.ts stale [--json]      people whose analysis is missing or older than their ledger (exit 1 when any)
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { stripPrivateContent } from "../TOOLS/CaptureEnvelope";
import { type ClaimRow, newClaimId, validateRow } from "./Schema";
import {
  VERA_DATA_DIR, addClaim, analysisCoversPrivacy, analysisStatus, ensureAxesFile, hasClaim, listPeople, loadAxes, personDir, readLedger, resolveClaim,
  staleAnalyses, titleFor,
} from "./Store";
import { branchComposites, composite, explainLeaf, scoreTree, scoreable } from "./Scoring";
import { writeProfile } from "./Profile";

const KB_PEOPLE_DIR =
  process.env.VERA_KB_PEOPLE_DIR ?? join(homedir(), ".claude/LIFEOS/MEMORY/KNOWLEDGE/People");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function deterministicId(person: string, statement: string): string {
  return `vc_${createHash("sha256").update(`${person} ${statement}`).digest("hex").slice(0, 12)}`;
}

/** After a ledger write: name each person whose analysis no longer matches their ledger, and the command that refreshes it. */
function reportReassess(slugs: Iterable<string>): void {
  for (const slug of new Set(slugs)) {
    const s = analysisStatus(slug);
    if (s === "stale" || s === "missing") console.log(`  reassess ${slug}: analysis ${s} — run bun LIFEOS/VERA/Assess.ts --person ${slug}`);
  }
}

function cmdAdd(args: string[]): void {
  const slug = args[0];
  if (!slug) die("add: missing <slug>");
  const row: ClaimRow = {
    id: newClaimId(),
    person: slug,
    statement: flag(args, "statement") ?? "",
    source: flag(args, "source") ?? "",
    source_kind: (flag(args, "source-kind") as ClaimRow["source_kind"]) ?? "other",
    happened: flag(args, "happened") ?? new Date().toISOString().slice(0, 10),
    recorded: new Date().toISOString().slice(0, 10),
    axes: (flag(args, "axes") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    kind: (flag(args, "kind") as ClaimRow["kind"]) ?? "judged",
    confidence: Number(flag(args, "confidence") ?? "0.5"),
    sensitivity: (flag(args, "sensitivity") as ClaimRow["sensitivity"]) ?? "public",
  };
  const sp = flag(args, "stated-p");
  if (sp !== undefined) row.stated_p = Number(sp);
  addClaim(row);
  console.log(`added ${row.id} to ${slug}`);
  reportReassess([slug]);
}

function cmdResolve(args: string[]): void {
  const [slug, id, outcome] = args;
  if (!slug || !id || !["true", "false"].includes(outcome ?? "")) die("resolve: <slug> <claim-id> true|false");
  const row = resolveClaim(slug, id, outcome === "true" ? "resolved_true" : "resolved_false");
  console.log(`resolved ${row.id} → ${row.resolution} (${row.resolved})`);
}

function cmdScore(args: string[]): void {
  const slug = args[0];
  if (!slug) die("score: missing <slug>");
  const scores = scoreTree(readLedger(slug), loadAxes());
  const comp = composite(scores);
  if (has(args, "json")) {
    console.log(JSON.stringify({ person: slug, vera: comp, branches: branchComposites(scores), leaves: scores }, null, 2));
    return;
  }
  console.log(`VERA ${comp.score}  (evidence n≈${comp.n}, coverage ${Math.round(comp.coverage * 100)}%)`);
  let branch = "";
  for (const s of scores) {
    if (s.branch !== branch) {
      branch = s.branch;
      console.log(`\n${branch.toUpperCase()}`);
    }
    const est = s.insufficient ? "insufficient signal" : `${s.estimate} ±${s.interval} (n≈${s.n})`;
    const traj = s.trajectory === null ? "" : `  slope ${s.trajectory}/yr`;
    console.log(`  ${s.leaf.padEnd(20)} ${est}${traj}`);
  }
}

function cmdAsk(args: string[]): void {
  const slug = args[0];
  const intent = flag(args, "intent");
  if (!slug || !intent) die("ask: <slug> --intent <branch|leaf> [--explain]");
  const axes = loadAxes();
  const rows = readLedger(slug);
  const matches: { branch: string; leaf: { name: string; tags: string[]; type: "accuracy" | "judged" | "structural" } }[] = [];
  for (const b of axes.branches) {
    for (const l of b.leaves) {
      if (b.name === intent || l.name === intent) matches.push({ branch: b.name, leaf: l });
    }
  }
  if (matches.length === 0) die(`ask: intent "${intent}" matches no branch or leaf`);
  const out = matches.map((m) => {
    const scores = scoreTree(rows, { branches: [{ name: m.branch, leaves: [m.leaf] }] });
    const entry: Record<string, unknown> = { ...scores[0]! };
    if (has(args, "explain")) entry.evidence = explainLeaf(rows, m.leaf);
    return entry;
  });
  console.log(JSON.stringify({ person: slug, intent, results: out }, null, 2));
}

function cmdProfile(args: string[]): void {
  const slug = args[0];
  if (!slug) die("profile: missing <slug>");
  const p = writeProfile(slug, titleFor(slug), readLedger(slug), loadAxes());
  console.log(p);
}

/**
 * Mechanical bootstrap from Cortex People notes (kb-v3).
 * - Key Facts bullets → biographical rows (axis: track-record), honest low confidence.
 * - Idempotent: ids are content-derived, existing ids are skipped.
 * - Reads the raw note file, so it applies the Cortex privacy boundary itself: <private> spans are
 *   stripped (an unclosed opener drops the rest of the note) before any fact becomes a row.
 */
function cmdImportKb(args: string[]): void {
  const limit = Number(flag(args, "limit") ?? "0") || Infinity;
  if (!existsSync(KB_PEOPLE_DIR)) die(`no People dir at ${KB_PEOPLE_DIR}`);
  const files = readdirSync(KB_PEOPLE_DIR).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
  let people = 0, added = 0, skipped = 0;
  for (const f of files) {
    if (people >= limit) break;
    const slug = f.replace(/\.md$/, "");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) { skipped++; continue; }
    const text = stripPrivateContent(readFileSync(join(KB_PEOPLE_DIR, f), "utf8"));
    const created = text.match(/^created:\s*(\d{4}-\d{2}-\d{2})/m)?.[1] ?? new Date().toISOString().slice(0, 10);
    const factsSection = text.match(/## Key Facts\n([\s\S]*?)(?=\n## |$)/);
    const facts = (factsSection?.[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/^- /, "").trim())
      .filter((l) => l.length > 20 && !l.startsWith("#"));
    if (facts.length === 0) { people++; continue; }
    const existing = readLedger(slug);
    for (const fact of facts) {
      const statement = fact.length > 500 ? fact.slice(0, 497) + "..." : fact;
      const id = deterministicId(slug, statement);
      if (hasClaim(existing, { id, person: slug, statement })) continue;
      const row: ClaimRow = {
        id, person: slug, statement,
        source: `kb:People/${slug}`, source_kind: "kb-import",
        happened: created, recorded: new Date().toISOString().slice(0, 10),
        axes: ["track-record"], kind: "biographical",
        confidence: 0.4, sensitivity: "public", derivation: "kb-import",
      };
      if (validateRow(row).length > 0) { skipped++; continue; }
      addClaim(row);
      existing.push(row);
      added++;
    }
    people++;
  }
  // Regenerate all profiles after import
  for (const slug of listPeople()) writeProfile(slug, titleFor(slug), readLedger(slug), loadAxes());
  console.log(`import-kb: ${people} people scanned, ${added} rows added, ${skipped} skipped`);
}

/**
 * Bulk ingest of agent-produced rows: one JSON object per line, id optional
 * (deterministic id assigned from person+statement), recorded defaulted to
 * today. Every row passes the same store invariants; duplicates skip.
 */
function cmdIngest(args: string[]): void {
  const file = args[0];
  if (!file || !existsSync(file)) die("ingest: missing <file.jsonl>");
  const today = new Date().toISOString().slice(0, 10);
  let added = 0, dup = 0, refused = 0;
  const refusals: string[] = [];
  const ledgerCache = new Map<string, ClaimRow[]>();
  const touched: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let raw: Partial<ClaimRow>;
    try { raw = JSON.parse(t); } catch { refused++; refusals.push("unparseable line"); continue; }
    const row = {
      recorded: today,
      sensitivity: "public",
      ...raw,
      id: raw.id ?? deterministicId(raw.person ?? "", raw.statement ?? ""),
    } as ClaimRow;
    if (!ledgerCache.has(row.person)) ledgerCache.set(row.person, readLedger(row.person));
    if (hasClaim(ledgerCache.get(row.person)!, row)) { dup++; continue; }
    const errs = validateRow(row);
    if (errs.length > 0) { refused++; refusals.push(`${row.person}: ${errs.map((e) => `${e.field}(${e.problem})`).join(",")}`); continue; }
    addClaim(row);
    ledgerCache.get(row.person)!.push(row);
    touched.push(row.person);
    added++;
  }
  console.log(`ingest: ${added} added, ${dup} duplicate-skipped, ${refused} refused`);
  for (const r of refusals.slice(0, 10)) console.log(`  refused: ${r}`);
  reportReassess(touched);
}

/**
 * JSON snapshot for the Pulse board. It drops personal-sensitivity rows and any analysis written before a row
 * became personal. It does NOT redact the public-sensitivity rows it exports: their statements and sources go
 * out as written, and import-kb, ingest and Enrich all stamp public unless a row says otherwise.
 */
function cmdExportPulse(): void {
  const axes = loadAxes();
  const people = listPeople().map((slug) => {
    const rows = readLedger(slug);
    const pub = scoreable(rows);
    const leaves = scoreTree(rows, axes);
    let analysis: { analysis: string; bullets: string[] } | null = null;
    const ap = join(personDir(slug), "analysis.json");
    if (existsSync(ap)) {
      try {
        const a = JSON.parse(readFileSync(ap, "utf8"));
        // An analysis written before a row became personal may still describe it: never exported.
        if (analysisCoversPrivacy(a, rows)) analysis = { analysis: a.analysis, bullets: a.bullets };
      } catch { /* optional */ }
    }
    return {
      slug,
      title: titleFor(slug),
      claims: pub.length,
      vera: composite(leaves),
      branches: branchComposites(leaves),
      analysis,
      leaves,
      recent: pub
        .sort((a, b) => b.happened.localeCompare(a.happened))
        .slice(0, 12)
        .map((r) => ({
          id: r.id, statement: r.statement, happened: r.happened, kind: r.kind,
          resolution: r.resolution ?? null, axes: r.axes, source: r.source, confidence: r.confidence,
        })),
    };
  });
  const out = { generated: new Date().toISOString(), axes, people };
  const p = join(VERA_DATA_DIR, "pulse-snapshot.json");
  mkdirSync(VERA_DATA_DIR, { recursive: true });
  writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(`${p} (${people.length} people)`);
}

function cmdList(): void {
  for (const slug of listPeople()) {
    const rows = readLedger(slug);
    console.log(`${slug.padEnd(32)} ${rows.length} claims`);
  }
}

function cmdStale(args: string[]): void {
  const stale = staleAnalyses();
  if (has(args, "json")) console.log(JSON.stringify({ stale }, null, 2));
  else {
    for (const s of stale) console.log(`${s.slug.padEnd(32)} ${s.status}`);
    console.log(`stale: ${stale.length} people need bun LIFEOS/VERA/Assess.ts`);
  }
  if (stale.length > 0) process.exitCode = 1;
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "init": console.log(ensureAxesFile()); break;
  case "add": cmdAdd(rest); break;
  case "resolve": cmdResolve(rest); break;
  case "score": cmdScore(rest); break;
  case "ask": cmdAsk(rest); break;
  case "profile": cmdProfile(rest); break;
  case "import-kb": cmdImportKb(rest); break;
  case "ingest": cmdIngest(rest); break;
  case "export-pulse": cmdExportPulse(); break;
  case "list": cmdList(); break;
  case "stale": cmdStale(rest); break;
  default:
    die("usage: Vera.ts init|add|resolve|score|ask|profile|import-kb|ingest|export-pulse|list|stale");
}
