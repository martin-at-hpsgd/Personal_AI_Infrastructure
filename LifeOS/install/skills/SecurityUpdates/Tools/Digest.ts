#!/usr/bin/env bun
/**
 * Digest — run state and shape checks for the SecurityUpdates Update intent.
 *
 *   bun Digest.ts filter  [--state <path>] < candidates.json   → JSON {first_run, since, items}
 *   bun Digest.ts record  [--state <path>] < shown.json        → writes the state file
 *   bun Digest.ts check   <digest.md> [--state <path>]         → validates digest shape and state schema
 *
 * Candidates and shown items are a JSON array of {title, source, url?, date?}.
 * Each item is keyed by its canonical URL, or by a normalized-title hash when it
 * has no URL, so an undated item is still recognized on the next run.
 * Exit codes: 0 ok, 1 check failed, 2 usage or input error.
 *
 * @version 1.0.0
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";

export const MAX_ITEMS = 32;
export const FIRST_RUN_DAYS = 7;
export const PRUNE_DAYS = 90;
const DAY_MS = 86_400_000;

export interface Item {
  title: string;
  source: string;
  url?: string;
  date?: string;
}

export interface SeenEntry {
  first_seen: string;
  title: string;
  source: string;
}

export interface State {
  last_check_timestamp: string;
  seen: Record<string, SeenEntry>;
}

export function defaultStatePath(): string {
  const root = getClaudeDir();
  return join(root, "LIFEOS", "MEMORY", "STATE", "SecurityUpdates-last-check.json");
}

/** Canonical URL: lowercase host, no scheme, no www, no fragment, no tracking params, no trailing slash. */
export function canonicalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !/^(utm_|fbclid$|gclid$|mc_|ref$|source$)/i.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? "?" + new URLSearchParams(params).toString() : "";
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  return `${host}${path}${query}`;
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function itemKey(item: Item): string {
  const canon = item.url ? canonicalUrl(item.url) : null;
  const basis = canon ? `u:${canon}` : `t:${normalizeTitle(item.title)}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function isItem(x: unknown): x is Item {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.title === "string" && o.title.trim() !== "" &&
    typeof o.source === "string" && o.source.trim() !== "" &&
    (o.url === undefined || typeof o.url === "string") &&
    (o.date === undefined || o.date === null || typeof o.date === "string")
  );
}

export function parseItems(text: string): Item[] {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("input must be a JSON array of items");
  data.forEach((x, i) => {
    if (!isItem(x)) throw new Error(`item ${i} needs a non-empty title and source`);
  });
  return data as Item[];
}

/** Returns a list of schema problems; empty means the state is valid. */
export function validateState(s: unknown): string[] {
  const errs: string[] = [];
  if (!s || typeof s !== "object") return ["state is not an object"];
  const o = s as Record<string, unknown>;
  if (typeof o.last_check_timestamp !== "string" || Number.isNaN(Date.parse(o.last_check_timestamp))) {
    errs.push("last_check_timestamp is not an ISO timestamp");
  }
  if (!o.seen || typeof o.seen !== "object" || Array.isArray(o.seen)) {
    errs.push("seen is not an object");
    return errs;
  }
  for (const [k, v] of Object.entries(o.seen as Record<string, unknown>)) {
    const e = v as Record<string, unknown>;
    if (!/^[0-9a-f]{16}$/.test(k)) errs.push(`seen key ${k} is not a 16-hex item key`);
    if (!e || typeof e.first_seen !== "string" || Number.isNaN(Date.parse(e.first_seen))) {
      errs.push(`seen[${k}].first_seen is not an ISO timestamp`);
    }
    if (!e || typeof e.title !== "string" || typeof e.source !== "string") {
      errs.push(`seen[${k}] needs title and source strings`);
    }
  }
  return errs;
}

export function loadState(path: string): State | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  // A state file from before per-item keys has no `seen`: treat it as empty history.
  if (parsed && typeof parsed === "object" && !("seen" in parsed)) {
    return { last_check_timestamp: parsed.last_check_timestamp ?? new Date(0).toISOString(), seen: {} };
  }
  const errs = validateState(parsed);
  if (errs.length) throw new Error(`state file ${path} is malformed: ${errs.join("; ")}`);
  return parsed as State;
}

/** Drops items already shown, items dated outside the window, and exact repeats within the batch. */
export function filterNew(items: Item[], state: State | null, now = new Date()) {
  const firstRun = state === null;
  const windowDays = firstRun ? FIRST_RUN_DAYS : PRUNE_DAYS;
  const cutoff = now.getTime() - windowDays * DAY_MS;
  const seen = state?.seen ?? {};
  const batch = new Set<string>();
  const out: Item[] = [];
  for (const item of items) {
    const key = itemKey(item);
    if (seen[key] || batch.has(key)) continue;
    const t = item.date ? Date.parse(item.date) : NaN;
    if (!Number.isNaN(t) && t < cutoff) continue;
    batch.add(key);
    out.push(item);
  }
  return {
    first_run: firstRun,
    since: firstRun ? `Last ${FIRST_RUN_DAYS} days (first run)` : state!.last_check_timestamp,
    items: out,
  };
}

/** Adds the shown items to the state and prunes keys older than PRUNE_DAYS. */
export function recordShown(items: Item[], state: State | null, now = new Date()): State {
  invariant(items.length <= MAX_ITEMS, `recorded ${items.length} items, above the ${MAX_ITEMS}-item cap`);
  const nowIso = now.toISOString();
  const cutoff = now.getTime() - PRUNE_DAYS * DAY_MS;
  const seen: Record<string, SeenEntry> = {};
  for (const [k, v] of Object.entries(state?.seen ?? {})) {
    if (Date.parse(v.first_seen) >= cutoff) seen[k] = v;
  }
  for (const item of items) {
    const key = itemKey(item);
    if (!seen[key]) seen[key] = { first_seen: nowIso, title: item.title, source: item.source };
  }
  const next: State = { last_check_timestamp: nowIso, seen };
  const errs = validateState(next);
  invariant(errs.length === 0, `state about to be written is invalid: ${errs.join("; ")}`);
  return next;
}

export function writeState(path: string, state: State): void {
  invariant(validateState(state).length === 0, "refusing to write an invalid state file");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Checks a rendered digest against the Update intent's Output format. Empty list means it passes. */
export function checkDigest(md: string): string[] {
  const errs: string[] = [];
  if (!/^# Security Updates\s*$/m.test(md)) errs.push("missing '# Security Updates' heading");
  for (const label of ["**Generated:**", "**Sources Checked:**", "**Period:**"]) {
    if (!md.includes(label)) errs.push(`missing ${label} line`);
  }
  const sections = [
    ["## 🔴 Security News", "News"],
    ["## 🔬 Security Research", "Research"],
    ["## 💡 Security Ideas", "Ideas"],
  ] as const;
  const counts: Record<string, number> = {};
  for (const [heading, name] of sections) {
    const start = md.indexOf(heading);
    if (start < 0) {
      errs.push(`missing section '${heading}'`);
      continue;
    }
    const rest = md.slice(start + heading.length);
    const end = rest.search(/^## /m);
    const body = end < 0 ? rest : rest.slice(0, end);
    counts[name] = (body.match(/^\d+\.\s+\*\*.+?\*\*/gm) ?? []).length;
  }
  if (!md.includes("## 📊 Summary")) errs.push("missing '## 📊 Summary' section");
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > MAX_ITEMS) errs.push(`${total} items, above the ${MAX_ITEMS}-item cap`);
  const totalLine = md.match(/\*\*Total:\*\*\s*(\d+)\/32/);
  if (!totalLine) errs.push("missing '**Total:** X/32' line");
  else if (Number(totalLine[1]) !== total) errs.push(`Total line says ${totalLine[1]} but sections hold ${total}`);
  for (const name of ["News", "Research", "Ideas"]) {
    const row = md.match(new RegExp(`^\\|\\s*${name}\\s*\\|\\s*(\\d+)\\s*\\|`, "m"));
    if (!row) errs.push(`summary table has no ${name} row`);
    else if (counts[name] !== undefined && Number(row[1]) !== counts[name]) {
      errs.push(`summary says ${name} ${row[1]} but the section holds ${counts[name]}`);
    }
  }
  return errs;
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const statePath = argValue(rest, "--state") ?? defaultStatePath();
  try {
    if (cmd === "filter") {
      const items = parseItems(await Bun.stdin.text());
      console.log(JSON.stringify(filterNew(items, loadState(statePath)), null, 2));
      return 0;
    }
    if (cmd === "record") {
      const items = parseItems(await Bun.stdin.text());
      if (items.length > MAX_ITEMS) {
        console.error(`refusing to record ${items.length} items, above the ${MAX_ITEMS}-item cap`);
        return 2;
      }
      const next = recordShown(items, loadState(statePath));
      writeState(statePath, next);
      console.log(JSON.stringify({ ok: true, state: statePath, recorded: items.length, seen: Object.keys(next.seen).length }));
      return 0;
    }
    if (cmd === "check") {
      const file = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--state");
      if (!file) {
        console.error("usage: Digest.ts check <digest.md> [--state <path>]");
        return 2;
      }
      const errs = checkDigest(readFileSync(file, "utf8"));
      if (existsSync(statePath)) errs.push(...validateState(JSON.parse(readFileSync(statePath, "utf8"))).map((e) => `state: ${e}`));
      console.log(JSON.stringify({ ok: errs.length === 0, errors: errs }, null, 2));
      return errs.length ? 1 : 0;
    }
    console.error("usage: Digest.ts filter|record|check  (see header comment)");
    return 2;
  } catch (e) {
    if (e instanceof Error && e.name === "InvariantViolation") throw e;
    console.error(String(e instanceof Error ? e.message : e));
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
