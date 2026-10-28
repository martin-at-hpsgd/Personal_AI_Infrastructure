#!/usr/bin/env bun

/**
 * Disclose — who to tell about a weakness, from the disclose.io project.
 *
 * Lookup resolves any asset (domain, IP, URL, email, ASN, npm:pkg, gh:owner/repo,
 * org name) to its security contact, VDP and safe-harbor status through
 * lookup.disclose.io. Directory searches diodb, the open list of disclosure and
 * bounty programs, from a local cache. Both are third-party lookups: nothing is
 * sent to the asset itself, so no ScopeGate call is needed.
 *
 * CLI:
 *   bun Disclose.ts lookup [asset ...] [--full] [-c N]   (assets on stdin when none are given)
 *   bun Disclose.ts directory <query> [--json]
 *   bun Disclose.ts refresh
 *
 * Exit: 0 ok · 1 a lookup or refresh failed · 2 usage.
 * Env: DIO_API overrides the lookup endpoint (tests).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "./Invariant.ts";

const LOOKUP_API = process.env.DIO_API ?? "https://lookup.disclose.io/api/lookup";
const DIODB_URL = "https://raw.githubusercontent.com/disclose/diodb/master/program-list.json";
export const CACHE = join(import.meta.dir, "..", "MEMORY", "STATE", "disclose", "diodb.json");
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface Program {
  program_name: string;
  policy_url?: string;
  contact_email?: string;
  contact_url?: string;
  securitytxt_url?: string;
  offers_bounty?: string;
  safe_harbor?: string;
  disclosure_timeline_days?: number | string;
  policy_url_status?: string;
}

// ---------- lookup ----------

export function parseAssets(args: string[], stdin: string): string[] {
  const src = args.length ? args : stdin.split(/\r?\n/);
  return [...new Set(src.map((s) => s.trim()).filter((s) => s && !s.startsWith("#")))];
}

export function compact(r: Record<string, any>): Record<string, unknown> {
  return {
    input: r.input,
    assetType: r.assetType,
    status: r.status,
    organization: r.attribution?.organization ?? null,
    contacts: (r.contacts ?? []).map((c: Record<string, unknown>) => ({ type: c.type, value: c.value, confidence: c.confidence, source: c.source, label: c.label })),
  };
}

async function lookupOne(input: string): Promise<Record<string, any>> {
  const res = await fetch(LOOKUP_API, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "lifeos-disclose/1" },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`lookup ${input}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, any>;
}

async function cmdLookup(args: string[]): Promise<number> {
  const full = args.includes("--full");
  const ci = args.indexOf("-c");
  const conc = ci >= 0 ? Math.max(1, Math.min(8, Number(args[ci + 1]) || 4)) : 4;
  const rest = args.filter((a, i) => a !== "--full" && a !== "-c" && !(ci >= 0 && i === ci + 1));
  const assets = parseAssets(rest, rest.length ? "" : await Bun.stdin.text());
  if (!assets.length) { console.error("usage: Disclose.ts lookup <asset ...> (or assets on stdin)"); return 2; }
  let failed = 0, next = 0;
  await Promise.all(Array.from({ length: Math.min(conc, assets.length) }, async () => {
    while (next < assets.length) {
      const a = assets[next++]!;
      try {
        const r = await lookupOne(a);
        console.log(JSON.stringify(full ? r : compact(r)));
      } catch (e) {
        failed++;
        console.error(`Disclose: ${(e as Error).message}`);
      }
    }
  }));
  return failed ? 1 : 0;
}

// ---------- directory ----------

export function isStale(mtimeMs: number | null, now = Date.now()): boolean {
  return mtimeMs === null || now - mtimeMs > CACHE_MAX_AGE_MS;
}

export async function refresh(path = CACHE): Promise<number> {
  const res = await fetch(DIODB_URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`diodb refresh: HTTP ${res.status}`);
  const list = (await res.json()) as Program[];
  invariant(Array.isArray(list) && list.length > 500, `diodb refresh: implausible program list (${Array.isArray(list) ? list.length : typeof list})`);
  invariant(list.every((p) => typeof p.program_name === "string"), "diodb refresh: an entry has no program_name");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(list));
  renameSync(`${path}.tmp`, path);
  return list.length;
}

const host = (u?: string) => {
  if (!u) return "";
  if (u.includes("@") && !u.includes("/")) return u.split("@")[1]!.toLowerCase();
  try { return new URL(u).hostname.toLowerCase(); } catch { return ""; }
};

export function search(list: Program[], query: string): Program[] {
  const q = query.toLowerCase().trim();
  return list.filter((p) =>
    p.program_name.toLowerCase().includes(q) ||
    [p.policy_url, p.securitytxt_url, p.contact_email, p.contact_url].some((u) => host(u).includes(q)));
}

async function cmdDirectory(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const query = args.filter((a) => a !== "--json").join(" ");
  if (!query) { console.error("usage: Disclose.ts directory <query> [--json]"); return 2; }
  if (isStale(existsSync(CACHE) ? statSync(CACHE).mtimeMs : null)) await refresh();
  const hits = search(JSON.parse(readFileSync(CACHE, "utf8")) as Program[], query);
  const rows = hits.map((p) => ({
    program_name: p.program_name, policy_url: p.policy_url || null, offers_bounty: p.offers_bounty || null,
    safe_harbor: p.safe_harbor || null, contact: p.contact_email || p.contact_url || p.securitytxt_url || null,
    disclosure_timeline_days: p.disclosure_timeline_days || null,
  }));
  if (json) console.log(JSON.stringify(rows, null, 2));
  else for (const r of rows) console.log(JSON.stringify(r));
  if (!rows.length) console.error(`Disclose: no program matches "${query}"`);
  return 0;
}

// ---------- main ----------

if (import.meta.main) {
  const [cmd, ...args] = Bun.argv.slice(2);
  let code = 2;
  try {
    if (cmd === "lookup") code = await cmdLookup(args);
    else if (cmd === "directory") code = await cmdDirectory(args);
    else if (cmd === "refresh") { console.log(JSON.stringify({ programs: await refresh(), cache: CACHE })); code = 0; }
    else console.error("usage: Disclose.ts lookup <asset ...> | directory <query> | refresh");
  } catch (e) {
    console.error(`Disclose: ${(e as Error).message}`);
    code = 1;
  }
  process.exit(code);
}
