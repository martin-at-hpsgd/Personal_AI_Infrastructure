#!/usr/bin/env bun
/**
 * @version 2.0.0
 *
 * ContactsDb — DEPRECATED. A thin, read-only shim over `LIFEOS/PEOPLE`.
 *
 * The contacts pipeline moved into the People subsystem on 2026-09-11. People is
 * the one people system: one record per human, field-level provenance, a typed
 * interaction ledger, customer state, and a security boundary that keeps personal
 * records off the network. Doctrine: `LIFEOS/DOCUMENTATION/People/PeopleSystem.md`.
 *
 * This file survives for one release so existing callers keep answering. It holds
 * NO write to `contacts.jsonl` and no pipeline logic of its own (ISC-41): exactly
 * one code path in LifeOS writes the store, and it lives in `LIFEOS/PEOPLE/store.ts`.
 *
 *   search <query> [--json]   → LIFEOS/PEOPLE/query.ts   (use: people who <q>)
 *   get <name|email> [--json] → LIFEOS/PEOPLE/query.ts   (use: people who <q>)
 *   list [filters]            → LIFEOS/PEOPLE/query.ts   (use: people list)
 *   stats                     → LIFEOS/PEOPLE/query.ts   (use: people stats)
 *
 *   sync-gmail [--window-days N]    → delegates to LIFEOS/PEOPLE/ledger.ts
 *   merge [--curated <file.md>]     → delegates to LIFEOS/PEOPLE/merge.ts
 *   sync-addressbook <audit.json>   → gone; People reads Contacts itself
 *   bulk-set-summaries <file.jsonl> → gone; no replacement yet
 *   evidence <email>                → gone; no replacement yet
 *
 * Ships publicly: zero personal data; every path resolves through the People store
 * module, which resolves through lifeosUserDir().
 */

import { readGmailCache, syncGmail } from "../PEOPLE/ledger";
import { runMerge } from "../PEOPLE/merge";
import { contactsPath } from "../PEOPLE/store";
import { findPeople, loadRecords, rollupOf } from "../PEOPLE/query";
import { effectiveClass, type PersonRecord } from "../PEOPLE/types";

const PEOPLE = "bun LIFEOS/PEOPLE/People.ts";

/** One stderr line, every run. The shim answers; it never pretends to be current. */
function deprecated(replacement: string): void {
  console.error(`ContactsDb is deprecated — ${replacement}`);
}

/** Exit 2 with the pointer, for a command People has no equivalent for. */
function gone(what: string, why: string): never {
  console.error(`ContactsDb ${what} is gone: ${why}`);
  process.exit(2);
}

// ── rendering (the pre-People output shape, kept so callers keep parsing) ─────

function fmt(r: PersonRecord, long = false): string {
  const roll = rollupOf(r);
  const parts = [
    `${r.name}${r.nickname ? ` "${r.nickname}"` : ""}${r.org ? ` — ${r.org}` : ""}`,
    r.relationship ? `  [${r.relationship}]` : "",
    r.emails.length ? `  ${r.emails.join(", ")}` : "",
    roll.total || roll.automated
      ? `  ✉ ${roll.total} interaction(s)${roll.automated ? ` + ${roll.automated} automated` : ""}` +
        `${roll.first || roll.last ? ` (${(roll.first ?? "").slice(0, 10)} → ${(roll.last ?? "").slice(0, 10)})` : ""}`
      : "",
    `  [${effectiveClass(r)}]`,
  ].filter(Boolean);
  if (long && r.phones?.length) parts.push(`  ☎ ${r.phones.join(", ")}`);
  if (long && r.summary) parts.push(`\n${r.summary}`);
  return parts.join("\n");
}

// ── queries ───────────────────────────────────────────────────────────────────

/**
 * Free text across the whole record, the way this command always worked — wider
 * than `people who`, which stages email → name → fragment. Kept wide on purpose:
 * callers search for an org, a summary phrase or a tag through here.
 */
function searchCmd(q: string, json: boolean): void {
  deprecated(`use \`${PEOPLE} who ${q || "<query>"}\``);
  const needle = q.toLowerCase();
  const hits = loadRecords().filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
  hits.sort((a, b) => rollupOf(b).total - rollupOf(a).total);
  if (json) {
    console.log(JSON.stringify(hits, null, 2));
    return;
  }
  for (const r of hits.slice(0, 20)) console.log(fmt(r) + "\n");
  if (hits.length > 20) console.log(`(+${hits.length - 20} more — narrow the query or use --json)`);
  if (!hits.length) console.log("no matches");
}

function getCmd(key: string, json: boolean): void {
  deprecated(`use \`${PEOPLE} who ${key || "<name or email>"}\``);
  const rec = findPeople(key)[0];
  if (!rec) {
    console.log("no match");
    process.exit(1);
  }
  console.log(json ? JSON.stringify(rec, null, 2) : fmt(rec, true));
}

function listCmd(args: string[]): void {
  deprecated(`use \`${PEOPLE} list [--class personal|business|both|unknown]\``);
  const opt = (f: string) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const org = opt("--org")?.toLowerCase();
  const tag = opt("--tag")?.toLowerCase();
  const source = opt("--source");
  const minInter = Number(opt("--min-interactions") ?? 0);
  let db = loadRecords();
  if (org) db = db.filter((r) => r.org?.toLowerCase().includes(org));
  if (tag) db = db.filter((r) => r.tags?.some((t) => t.toLowerCase() === tag));
  if (source) db = db.filter((r) => r.sources.includes(source as PersonRecord["sources"][number]));
  if (minInter) db = db.filter((r) => rollupOf(r).total >= minInter);
  db.sort((a, b) => a.name.localeCompare(b.name));
  for (const r of db) console.log(fmt(r));
  console.error(`\n${db.length} records`);
}

function statsCmd(): void {
  deprecated(`use \`${PEOPLE} stats\``);
  const db = loadRecords();
  const metas = readGmailCache();
  console.log(
    JSON.stringify(
      {
        records: db.length,
        bySource: {
          addressbook: db.filter((r) => r.sources.includes("addressbook")).length,
          email: db.filter((r) => r.sources.includes("email")).length,
          curated: db.filter((r) => r.sources.includes("curated")).length,
        },
        withInteractions: db.filter((r) => rollupOf(r).total > 0).length,
        withSummary: db.filter((r) => r.summary).length,
        gmailCache: { messages: metas.length, sent: metas.filter((m) => m.labelIds.includes("SENT")).length },
        db: contactsPath(),
      },
      null,
      2,
    ),
  );
}

// ── main ──────────────────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);
const json = args.includes("--json");

try {
  if (cmd === "search") {
    searchCmd(args.filter((a) => !a.startsWith("--")).join(" "), json);
  } else if (cmd === "get") {
    getCmd(args.filter((a) => !a.startsWith("--")).join(" "), json);
  } else if (cmd === "list") {
    listCmd(args);
  } else if (cmd === "stats") {
    statsCmd();
  } else if (cmd === "sync-gmail") {
    deprecated(`use \`${PEOPLE} tick\``);
    const wd = args.includes("--window-days") ? Number(args[args.indexOf("--window-days") + 1]) : 730;
    const r = await syncGmail(wd);
    console.log(JSON.stringify(r));
  } else if (cmd === "merge") {
    deprecated(`use \`${PEOPLE} merge\``);
    const ci = args.indexOf("--curated");
    const r = runMerge(ci >= 0 && args[ci + 1] ? { curatedPath: args[ci + 1]! } : {});
    console.log(`merged ${r.records} records`);
  } else if (cmd === "sync-addressbook") {
    gone("sync-addressbook", `People reads Contacts.app itself, so there is no audit dump to feed it — run \`${PEOPLE} sync apple\``);
  } else if (cmd === "bulk-set-summaries") {
    gone("bulk-set-summaries", `summaries are not written by People yet; the summaries already on records are preserved by every merge`);
  } else if (cmd === "evidence") {
    gone("evidence", `the interaction ledger replaced the evidence pack — run \`${PEOPLE} who <email>\` for the record and its recent interactions`);
  } else {
    console.log(`ContactsDb is deprecated. Use \`${PEOPLE} who|list|stats|merge|tick|sync apple|add\`.`);
    console.log("shimmed here: search|get|list|stats|sync-gmail|merge");
    process.exit(1);
  }
} catch (e: any) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
