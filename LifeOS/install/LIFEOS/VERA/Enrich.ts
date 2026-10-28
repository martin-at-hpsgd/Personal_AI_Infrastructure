#!/usr/bin/env bun
/**
 * Vera Enrich — the corpus extraction engine. Turns a person's actual body of
 * work into claim ledger rows, at scale, resumably.
 *
 *   bun LIFEOS/VERA/Enrich.ts --person <slug> --dir <corpus-dir> --base-url <url-prefix> [--limit N] [--level medium]
 *   bun LIFEOS/VERA/Enrich.ts --person <slug> --file <one-doc> --base-url <url-prefix> [--level medium]
 *   bun LIFEOS/VERA/Enrich.ts --status <slug>
 *
 * Per document: one model extraction pass (Inference.ts, subscription-billed)
 * produces candidate rows in the Vera schema; rows are validated and ingested
 * through the same store invariants as every other path. A checkpoint file
 * records each processed document by content hash, so re-runs skip finished
 * docs and a changed doc re-extracts. Deterministic ids (person+statement)
 * make double-ingest a no-op.
 *
 * Extraction discipline (same bar as agent enrichment):
 * - rows must be specific and citable; source = the document's own URL/slug
 * - happened = the document's date (or a date the document itself states)
 * - predictions with checkable outcomes become verifiable rows; the engine
 *   marks them pending — resolution is a separate judgment pass
 * - nothing personal; every row survives being shown to the subject
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { inference, type InferenceLevel } from "../TOOLS/Inference";
import { type ClaimRow, validateRow } from "./Schema";
import { VERA_DATA_DIR, addClaim, readLedger } from "./Store";

const CHECKPOINT_DIR = join(VERA_DATA_DIR, "enrich-state");

interface Checkpoint {
  person: string;
  /** docPath → { hash, rows, at } */
  docs: Record<string, { hash: string; rows: number; at: string }>;
}

function checkpointPath(person: string): string {
  return join(CHECKPOINT_DIR, `${person}.json`);
}

function loadCheckpoint(person: string): Checkpoint {
  const p = checkpointPath(person);
  if (!existsSync(p)) return { person, docs: {} };
  return JSON.parse(readFileSync(p, "utf8")) as Checkpoint;
}

function saveCheckpoint(cp: Checkpoint): void {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  writeFileSync(checkpointPath(cp.person), JSON.stringify(cp, null, 2));
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function deterministicId(person: string, statement: string): string {
  return `vc_${createHash("sha256").update(`${person} ${statement}`).digest("hex").slice(0, 12)}`;
}

const AXES = [
  "predictions", "calibration", "reasoning", "domain-accuracy",
  "technical-depth", "originality", "clarity", "rigor",
  "integrity", "consistency", "updates-when-wrong", "stays-in-lane",
  "connectedness", "cited-by", "access", "track-record",
];

const SYSTEM_PROMPT = `You extract evidence rows for a person-credibility ledger from ONE document the person authored (or that documents their actions). Output STRICT JSON: {"rows":[...]} and nothing else.

Each row: {"statement","axes":[...],"kind":"verifiable|judged|biographical","confidence":0..1,"value"?:0..1,"happened"?:"YYYY-MM-DD"}

Rules:
- Only rows this document actually supports. 0 rows is a fine answer for thin documents; never pad.
- statement: one specific, checkable or citable claim about the AUTHOR (what they predicted, argued, built, demonstrated, got right/wrong), under 400 chars, standing alone without the document.
- kind=verifiable: predictions or actions with outcomes that could later be checked. Do NOT resolve them.
- kind=judged: an assessment of demonstrated craft (clarity, rigor, originality, reasoning, technical depth) — the statement must name what in the document demonstrates it. Set "value" = assessed quality 0..1 and confidence = how strongly the document supports the assessment.
- kind=biographical: concrete facts about roles/work/output.
- axes: 1-3 tags from exactly this set: ${AXES.join(", ")}
- happened: only if the document states a specific event date different from its own publication date.
- NOTHING about personal life, family, health, relationships. Every row must survive being shown to the person.
- Typical yield: 0-4 rows. Only extract what is genuinely load-bearing.`;

interface Extracted {
  statement: string;
  axes: string[];
  kind: ClaimRow["kind"];
  confidence: number;
  value?: number;
  happened?: string;
}

function docDate(text: string, fallback: string): string {
  const m = text.match(/^created_at:\s*['"]?(\d{4}-\d{2}-\d{2})/m) ?? text.match(/^date:\s*['"]?(\d{4}-\d{2}-\d{2})/m);
  return m?.[1] ?? fallback;
}

function docSlug(text: string, path: string): string {
  const m = text.match(/^slug:\s*['"]?([a-z0-9-]+)/m);
  return m?.[1] ?? basename(path).replace(/\.(md|txt)$/, "");
}

async function processDoc(person: string, path: string, level: InferenceLevel, baseUrl: string): Promise<number> {
  const raw = readFileSync(path, "utf8");
  const body = raw.length > 24000 ? raw.slice(0, 24000) : raw;
  const date = docDate(raw, "2020-01-01");
  const slug = docSlug(raw, path);
  const res = await inference({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Author: ${person}\nDocument date: ${date}\nDocument:\n\n${body}`,
    level,
    expectJson: true,
    timeout: 180_000,
  });
  if (!res.success) throw new Error(`inference failed on ${slug}: ${res.error}`);
  const parsed = (res.parsed ?? JSON.parse(res.output)) as { rows?: Extracted[] };
  const candidates = Array.isArray(parsed.rows) ? parsed.rows : [];
  const existing = new Set(readLedger(person).map((r) => r.id));
  let added = 0;
  for (const c of candidates) {
    if (!c.statement || !Array.isArray(c.axes)) continue;
    const axes = c.axes.filter((a) => AXES.includes(a));
    if (axes.length === 0) continue;
    const row: ClaimRow = {
      id: deterministicId(person, c.statement),
      person,
      statement: c.statement.slice(0, 480),
      source: `${baseUrl}${slug}`,
      source_kind: "blog",
      happened: /^\d{4}-\d{2}-\d{2}/.test(c.happened ?? "") ? c.happened! : date,
      recorded: new Date().toISOString().slice(0, 10),
      axes,
      kind: c.kind === "verifiable" || c.kind === "biographical" ? c.kind : "judged",
      confidence: typeof c.confidence === "number" ? Math.min(1, Math.max(0, c.confidence)) : 0.5,
      sensitivity: "public",
      derivation: "corpus-enrich",
    };
    if (typeof c.value === "number") row.value = Math.min(1, Math.max(0, c.value));
    if (row.kind === "verifiable") row.resolution = "pending";
    if (existing.has(row.id)) continue;
    if (validateRow(row).length > 0) continue;
    addClaim(row);
    existing.add(row.id);
    added++;
  }
  return added;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const statusOf = arg("status");
  if (statusOf) {
    const cp = loadCheckpoint(statusOf);
    const docs = Object.values(cp.docs);
    console.log(`${statusOf}: ${docs.length} docs processed, ${docs.reduce((s, d) => s + d.rows, 0)} rows extracted`);
    return;
  }
  const person = arg("person");
  const baseUrl = arg("base-url");
  if (!person || !baseUrl) {
    console.error("usage: Enrich.ts --person <slug> --base-url <url-prefix> (--dir <dir> [--limit N] | --file <doc>) | --status <slug>");
    process.exit(1);
  }
  const level = (arg("level") ?? "medium") as InferenceLevel;
  const single = arg("file");
  const dir = arg("dir");
  const limit = Number(arg("limit") ?? "25");

  const files: string[] = single
    ? [single]
    : readdirSync(dir!).filter((f) => f.endsWith(".md")).sort().map((f) => join(dir!, f));

  const cp = loadCheckpoint(person);
  let processed = 0, totalAdded = 0, skipped = 0, failed = 0;
  for (const f of files) {
    if (processed >= limit) break;
    const hash = sha(readFileSync(f, "utf8"));
    if (cp.docs[f]?.hash === hash) { skipped++; continue; }
    try {
      const added = await processDoc(person, f, level, baseUrl);
      cp.docs[f] = { hash, rows: added, at: new Date().toISOString() };
      saveCheckpoint(cp);
      totalAdded += added;
      processed++;
      console.log(`${basename(f)}: +${added}`);
    } catch (err) {
      failed++;
      console.error(`${basename(f)}: FAILED ${String(err).slice(0, 140)}`);
      if (failed >= 3) { console.error("3 failures — stopping run"); break; }
    }
  }
  console.log(`enrich: ${processed} docs processed (+${totalAdded} rows), ${skipped} already done, ${failed} failed`);
}

await main();
