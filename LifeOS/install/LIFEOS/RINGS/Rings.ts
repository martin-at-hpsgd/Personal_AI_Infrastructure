#!/usr/bin/env bun
/**
 * Rings.ts — the Security Rings CLI (Security Rings ISA). Prints names and counts, never a handle.
 *
 *   bun LIFEOS/RINGS/Rings.ts validate [--json]          every ring file present, every section, no person in two rings
 *   bun LIFEOS/RINGS/Rings.ts list [--json]              each ring's name, members, pending names and skills
 *   bun LIFEOS/RINGS/Rings.ts resolve <handle> [--json]  the ring a phone or email belongs to (3 when unknown)
 *   bun LIFEOS/RINGS/Rings.ts conversation <handle>...   the ring of a conversation with these members
 *   bun LIFEOS/RINGS/Rings.ts relay [--apply] [--json]   compare Relay's lists with the rings; --apply rewrites chatFrom
 *
 * `relay --apply` writes only Relay's chatFrom (Ring 1). Ring 0 is checked against Relay's allowFrom
 * and the root-owned pin and never written: the pin is changed only by the principal (Relay ISC-261).
 */
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { loadRecords } from "../PEOPLE/query";
import type { PersonRecord } from "../PEOPLE/types";
import { append } from "../STATVS/index.ts";
import { invariant } from "../TOOLS/Invariant";
import {
  conversationRing, handlesOf, loadRings, loadValidRings, normalizeHandle, ringHandles, ringOfHandle, ringsDir, unknownIds,
  type Ring, type RingPolicy,
} from "./policy";

const args = process.argv.slice(2);
const json = args.includes("--json");
const rest = args.filter(a => !a.startsWith("--"));
const cmd = rest[0];
const out = (human: string, data: unknown) => console.log(json ? JSON.stringify(data, null, 2) : human);

/** Who a handle belongs to, as a name a person can read: never the handle itself. */
function ownerOf(handle: string, records: PersonRecord[], rings: RingPolicy[]): string {
  const n = normalizeHandle(handle);
  const rec = records.find(r => handlesOf(r).includes(n));
  const member = rec && rings.flatMap(p => p.members).find(m => m.people.includes(rec.id));
  const kind = n.includes("@") ? "email" : "phone";
  return `${member?.name ?? rec?.name ?? "unknown"} (${kind})`;
}

function tally(names: string[]): string {
  const c = new Map<string, number>();
  for (const n of names) c.set(n, (c.get(n) ?? 0) + 1);
  return [...c].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(", ") || "none";
}

async function relay(apply: boolean) {
  const { CONFIG, pinnedAllowFrom } = await import("../RELAY/bridge/session.ts");
  const rings = loadValidRings();
  const records = loadRecords();
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  const current = new Set<string>((cfg.chatFrom ?? []).map(normalizeHandle));
  const wanted = new Set(ringHandles(1, rings, records));
  const added = [...wanted].filter(h => !current.has(h));
  const removed = [...current].filter(h => !wanted.has(h));
  const ring0 = new Set(ringHandles(0, rings, records).filter(h => h.startsWith("+")));
  const allowFrom = (cfg.allowFrom ?? []).map(normalizeHandle) as string[];
  const pin = pinnedAllowFrom() as { state: string; allowFrom?: string[] };
  const ring0Covers = allowFrom.every(h => ring0.has(h));
  const pinAgrees = pin.state !== "pinned" || (pin.allowFrom ?? []).every(h => allowFrom.includes(normalizeHandle(h)));
  const report = {
    chatFrom: { current: current.size, fromRing1: wanted.size, add: tally(added.map(h => ownerOf(h, records, rings))), remove: tally(removed.map(h => ownerOf(h, records, rings))) },
    allowFrom: { count: allowFrom.length, everyHandleInRing0: ring0Covers, pin: pin.state, pinMatchesConfig: pinAgrees },
    pendingRing1: rings.find(p => p.ring === 1)!.pending.map(p => p.name),
    applied: false,
  };
  if (apply && (added.length || removed.length)) {
    const mode = statSync(CONFIG).mode & 0o777;
    cfg.chatFrom = [...wanted];
    invariant(cfg.chatFrom.every((h: string) => ringOfHandle(h, rings, records) === 1), "every chatFrom handle is Ring 1");
    writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
    chmodSync(CONFIG, mode);
    report.applied = true;
    append({ writer: "tool:Rings", stream: "relay", class: "personal", data: { event: "rings_relay_sync", added: added.length, removed: removed.length, chatFrom: wanted.size } });
  }
  out([
    `chatFrom: ${current.size} now, ${wanted.size} from Ring 1`,
    `  add: ${report.chatFrom.add}`,
    `  remove: ${report.chatFrom.remove}`,
    `allowFrom: ${allowFrom.length} number(s), ${ring0Covers ? "all" : "NOT all"} in Ring 0; pin ${pin.state}${pinAgrees ? "" : ", DIFFERS from config"}`,
    `Ring 1 pending (not matched, resolve nothing): ${report.pendingRing1.join(", ") || "none"}`,
    report.applied ? "chatFrom rewritten; restart the bridge between turns to load it." : added.length || removed.length ? "Nothing written. Run with --apply to rewrite chatFrom." : "Relay already matches the rings.",
  ].join("\n"), report);
  if (!ring0Covers || !pinAgrees) process.exitCode = 1;
}

switch (cmd) {
  case "validate": {
    const { rings, errors } = loadRings();
    const unknown = errors.length ? [] : unknownIds(rings, loadRecords());
    const problems = [...errors, ...unknown.map(u => `ring-${u.ring}: ${u.name} names a People id that matches no record`)];
    out(problems.length ? problems.join("\n") : `ok: 4 rings in ${ringsDir()}`, { ok: !problems.length, problems });
    if (problems.length) process.exitCode = 1;
    break;
  }
  case "list": {
    const rings = loadValidRings();
    out(rings.map(p => `Ring ${p.ring} · ${p.name}: ${p.members.map(m => m.name).join(", ") || "no members"}` +
      (p.pending.length ? ` · pending: ${p.pending.map(m => m.name).join(", ")}` : "") +
      ` · skills: ${p.skills.join(", ") || "none"}`).join("\n"),
      rings.map(p => ({ ring: p.ring, name: p.name, members: p.members.map(m => m.name), pending: p.pending.map(m => m.name), skills: p.skills, data: p.data, actions: p.actions })));
    break;
  }
  case "resolve": {
    invariant(!!rest[1], "resolve needs a handle");
    let ring: Ring = 3;
    try { ring = ringOfHandle(rest[1], loadValidRings(), loadRecords()); } catch (e) { console.error(String(e)); }
    out(`Ring ${ring}`, { ring });
    break;
  }
  case "conversation": {
    const handles = rest.slice(1);
    const ring = conversationRing(handles, () => ({ rings: loadValidRings(), records: loadRecords() }));
    out(`Ring ${ring}`, { ring, members: handles.length });
    break;
  }
  case "relay":
    await relay(args.includes("--apply"));
    break;
  default:
    console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(2, 12).map(l => l.replace(/^ \* ?/, "")).join("\n"));
    if (cmd) process.exitCode = 2;
}
