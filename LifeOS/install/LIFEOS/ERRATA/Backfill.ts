#!/usr/bin/env bun
/**
 * @version 1.0.0
 * Backfill.ts — one-time, repeatable import of the older signal stores into
 * the Errata ledger: ratings.jsonl (retired 2026-09-20), the FAILURES sentiment.json summaries, and
 * Upgrades records with source "correction". Every row carries a dedupe_key,
 * so a second run adds zero lines (ISC-11).
 *
 * Never reads a FAILURES CONTEXT.md or a ratings.jsonl transcript field (retired 2026-09-20) beyond
 * the short response_preview already stored there — a full transcript never
 * enters the ledger (ISA constraint: "never copy a transcript into the ledger
 * or attachments").
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { invariant } from "../TOOLS/Invariant";
import { lifeosPath } from "../TOOLS/Paths";
import { listUpgrades as listUpgradesReal, type UpgradeRecord } from "../TOOLS/Upgrades";
import { ErrataStore } from "./Store";
import type { Kind, NewErratum } from "./Schema";

export interface BackfillOptions {
  ratingsPath?: string;
  failuresDir?: string;
  /** Injected for tests; defaults to the real Upgrades.ts store. */
  listUpgrades?: (filter?: { status?: string; source?: string }) => UpgradeRecord[];
}

export interface BackfillResult {
  ratings: number;
  failures: number;
  upgrades: number;
  /** Rows that already existed (dedupe_key hit) — the idempotence proof. */
  skipped: number;
}

interface RatingRow {
  timestamp?: string;
  rating?: number;
  session_id?: string;
  comment?: string;
  sentiment_summary?: string;
  response_preview?: string;
}

function ratingKind(rating: number): Kind {
  if (rating <= 3) return "complaint";
  if (rating >= 8) return "praise";
  return "question";
}

/**
 * Every row that qualifies (rating<=3 or a non-empty comment). A synchronous
 * line split keeps this a single pass with no external process; the file is
 * ~1.6MB, well inside a single read, and only the fields the ledger needs
 * leave this function — never the surrounding transcript.
 */
function readRatingRows(path: string): RatingRow[] {
  if (!existsSync(path)) return [];
  const rows: RatingRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as RatingRow;
      const hasComment = typeof row.comment === "string" && row.comment.trim().length > 0;
      if ((typeof row.rating === "number" && row.rating <= 3) || hasComment) rows.push(row);
    } catch {
      /* skip an unparseable row rather than fail the whole backfill */
    }
  }
  return rows;
}

/** Relative "YYYY-MM/<dir>" paths under `root` that hold a sentiment.json. Non-directory
 * entries at either level (README.md, ROOT_CAUSE_ANALYSIS.md) are skipped. */
function findFailureDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const monthEnt of readdirSync(root, { withFileTypes: true })) {
    if (!monthEnt.isDirectory()) continue;
    const monthPath = join(root, monthEnt.name);
    for (const dirEnt of readdirSync(monthPath, { withFileTypes: true })) {
      if (!dirEnt.isDirectory()) continue;
      if (existsSync(join(monthPath, dirEnt.name, "sentiment.json"))) out.push(join(monthEnt.name, dirEnt.name));
    }
  }
  return out;
}

export function backfill(store: ErrataStore, opts: BackfillOptions = {}): BackfillResult {
  const ratingsPath = opts.ratingsPath ?? lifeosPath("MEMORY", "LEARNING", "SIGNALS", "ratings.jsonl"); // legacy backfill input; retired 2026-09-20
  const failuresDir = opts.failuresDir ?? lifeosPath("MEMORY", "LEARNING", "FAILURES");
  const listUpgrades = opts.listUpgrades ?? listUpgradesReal;
  const reporter = { id: "principal", role: "principal" as const };

  const result: BackfillResult = { ratings: 0, failures: 0, upgrades: 0, skipped: 0 };
  // Captures before the 1.5.0 turn-anchoring fix may carry another session's response body (ISC-19).
  const ANCHOR_FIX = "2026-08-17";
  const legacyTags = (ts: string | undefined | null) => (ts && ts.slice(0, 10) < ANCHOR_FIX ? ["pre-turn-anchoring"] : []);

  // (a) ratings.jsonl — retired 2026-09-20; import historical rows only
  for (const row of readRatingRows(ratingsPath)) {
    if (typeof row.rating !== "number" || !row.timestamp) continue;
    const dedupe_key = `ratings:${row.timestamp}:${row.session_id ?? "unknown"}`;
    invariant(!!dedupe_key, "backfill ratings row missing dedupe_key");
    const complaint = (row.comment && row.comment.trim()) || row.sentiment_summary || "(no signal text)";
    const input: NewErratum = {
      system: "lifeos",
      source: "backfill",
      channel: "backfill",
      ts: row.timestamp,
      kind: ratingKind(row.rating),
      rating: row.rating,
      complaint,
      context: { session_id: row.session_id ?? null, response_preview: row.response_preview ?? null },
      reporter,
      tags: legacyTags(row.timestamp),
      dedupe_key,
    };
    if (store.append(input)) result.ratings++;
    else result.skipped++;
  }

  // (b) FAILURES sentiment.json
  for (const dir of findFailureDirs(failuresDir)) {
    let sj: Record<string, unknown>;
    try {
      sj = JSON.parse(readFileSync(join(failuresDir, dir, "sentiment.json"), "utf8"));
    } catch {
      continue;
    }
    const dedupe_key = `failures:${dir}`;
    invariant(!!dedupe_key, "backfill failures row missing dedupe_key");
    const kind: Kind = sj.capture_source === "correction" ? "correction" : "complaint";
    const rating = typeof sj.rating === "number" ? sj.rating : null;
    const input: NewErratum = {
      system: "lifeos",
      source: "backfill",
      channel: "backfill",
      ts: typeof sj.captured_at === "string" && !Number.isNaN(Date.parse(sj.captured_at)) ? sj.captured_at : undefined,
      kind,
      rating,
      complaint: typeof sj.summary === "string" && sj.summary ? sj.summary : "(no summary)",
      context: { session_id: typeof sj.session_id === "string" ? sj.session_id : null },
      reporter,
      links: { failure_dir: dir },
      tags: legacyTags(typeof sj.captured_at === "string" ? sj.captured_at : dir),
      dedupe_key,
    };
    if (store.append(input)) result.failures++;
    else result.skipped++;
  }

  // (c) Upgrades records with source: correction
  for (const u of listUpgrades({ source: "correction" })) {
    const dedupe_key = `upgrade:${u.id}`;
    invariant(!!dedupe_key, "backfill upgrade row missing dedupe_key");
    const input: NewErratum = {
      system: "lifeos",
      source: "backfill",
      channel: "backfill",
      ts: u.created,
      kind: "correction",
      rating: null,
      complaint: u.claim || "(no claim)",
      context: {},
      reporter,
      links: { upgrade_id: u.id },
      tags: legacyTags(u.created),
      dedupe_key,
    };
    if (store.append(input)) result.upgrades++;
    else result.skipped++;
  }

  return result;
}

if (import.meta.main) {
  const store = new ErrataStore();
  const result = backfill(store);
  console.log(JSON.stringify(result));
  process.exit(0);
}
