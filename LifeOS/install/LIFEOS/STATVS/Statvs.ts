#!/usr/bin/env bun
/**
 * Statvs.ts — the STATVS command line.
 *
 *   bun LIFEOS/STATVS/Statvs.ts append --writer W --stream S [--class C] [--app A] [--kind K]
 *                                      [--severity S] [--title T] [--session ID] [--ref R] [--data JSON | stdin]
 *   bun LIFEOS/STATVS/Statvs.ts verify [--classes] [--json]
 *   bun LIFEOS/STATVS/Statvs.ts seal [--today YYYY-MM-DD]
 *   bun LIFEOS/STATVS/Statvs.ts redact <id> --reason "<why>"
 *   bun LIFEOS/STATVS/Statvs.ts prune --stream S --days N [--dry-run] [--json]
 *   bun LIFEOS/STATVS/Statvs.ts tail [--stream S] [--n 20]
 *   bun LIFEOS/STATVS/Statvs.ts counters
 *   bun LIFEOS/STATVS/Statvs.ts views [--json]
 *   bun LIFEOS/STATVS/Statvs.ts rebuild <view> [--out DIR] [--json]
 *   bun LIFEOS/STATVS/Statvs.ts compare <view> [--json] [--record] | [--days N [--since ISO]]
 *   bun LIFEOS/STATVS/Statvs.ts drill [--json] [--no-record]
 *   bun LIFEOS/STATVS/Statvs.ts backup [--json]                 (then copies the ciphertext offsite to R2, ISC-108)
 *   bun LIFEOS/STATVS/Statvs.ts seal-copies [--max N] [--json]  (sealed copies of ship:false rows, so they reach the cloud as ciphertext; ISC-177)
 *   bun LIFEOS/STATVS/Statvs.ts restore-drill [--offsite] [--json] (--offsite restores from the R2 copy alone)
 *   bun LIFEOS/STATVS/Statvs.ts event --source S --kind K --severity S --title T --summary S
 *                                     [--ref R] [--url U] [--privacy public|personal] [--dedup KEY] [--meta JSON]
 *   bun LIFEOS/STATVS/Statvs.ts forward | pull | cloud ...   (lib/cloud.ts, Lane B)
 *   bun LIFEOS/STATVS/Statvs.ts collect ...                  (lib/collect.ts, Lane C)
 *
 * Agent jobs (AGENTJOB_ID set) get no write door (migration design §2.1, P1, ISC-190): every
 * COMMANDS entry declares access "read" or "write" (or decides per call), and every call that is
 * not "read", an undeclared or unknown subcommand included, exits 2 under them. Their one way in stays Vigil.ts emit --text-file,
 * which holds their words as drafts.
 *
 * forward, pull, cloud and collect are dispatched by dynamic import, so this file never depends on
 * modules other lanes own. The contract: the module exports
 *   cli(command: string, args: ParsedArgs): Promise<number> | number
 * and a module that is absent or has no `cli` prints "not built yet" and exits 2.
 *
 * redact on a severity row of a stream that forwards (today only `event`) also reaches the other
 * copies (design §2.3, P5, ISC-195): it scrubs the matching line of Vigil's legacy outbox and digest in
 * place while lib/legacyOutbox.ts exists, and asks lib/cloud.ts deleteCloudCopy (Lane B) to delete the
 * cloud copy. Both are dynamic imports; when either module is absent the command says so and exits 1.
 *
 * prune needs an explicit --stream and --days, refuses every `forever` stream (all of them today, ISC-107) and
 * refuses unless that day's restore drill passed (lib/record.ts prune, ISC-196).
 *
 * Later lanes add commands by adding an entry to COMMANDS.
 * @version 1.3.0
 */
import { append, backup, fetchOffsite, keychainIdentity, offsite, offsiteStore, checkpointRel, compareDef, compareStreak, counters, drill, getView, loadViews, rebuildDef, redact, restoreDrill, scan, seal, verify, writeEvent } from "./index";
import type { EventInput, PrivacyClass, StatvsInput } from "./index";
import { KINDS, PRIVACY_CLASSES as EVENT_PRIVACY, SEVERITIES } from "./lib/refuse";
import { prune, rowById } from "./lib/record";
import { streamDef } from "./streams";
import type { StatvsRow } from "./lib/types";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { invariant } from "../TOOLS/Invariant";

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

export type Command = (args: ParsedArgs) => Promise<number> | number;

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Whether a subcommand reads or writes. Every entry in COMMANDS declares one, and a function
 * decides per call when only some flags write (compare --record, drill without --no-record).
 * Anything that writes the record, its state, the views, the backups or the cloud copy is
 * "write". The agent-job gate (P1, ISC-190) refuses every call that is not "read", including a
 * subcommand with no declaration and a name that is not in COMMANDS at all.
 */
export type Access = "read" | "write";
export type AccessDecl = Access | ((args: ParsedArgs) => Access);

type LaneModule = { cli?: (command: string, args: ParsedArgs) => Promise<number> | number };

/** Run a subcommand that lives in another lane's module, or say it is not built yet. */
async function dispatch(load: () => Promise<LaneModule>, file: string, command: string, args: ParsedArgs): Promise<number> {
  let mod: LaneModule;
  try {
    mod = await load();
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (!/Cannot find module|ENOENT|not found/i.test(msg)) throw e;
    console.error(`${command}: not built yet (${file} is absent)`);
    return 2;
  }
  if (typeof mod.cli !== "function") {
    console.error(`${command}: not built yet (${file} exports no cli)`);
    return 2;
  }
  return await mod.cli(command, args);
}
const isMissingModule = (e: unknown) => /Cannot find module|ENOENT|not found/i.test((e as Error)?.message ?? String(e));

type LegacyCopy = { ok: boolean; scrubbed: number; event_id: string | null; reason?: string };

/**
 * Scrub the legacy copies of a redacted event row in place (P5): its line in Vigil's outbox and any
 * digest line, matched by event id (or, on a rerun after the record row lost its data, by source,
 * title and ts). The line keeps its envelope (titles survive redaction, as in the record) and loses
 * summary, url and meta. It is overwritten at its own byte offset and padded with spaces to its old
 * length, so an append landing at the same moment is never lost to a rewrite.
 */
async function scrubLegacyCopies(row: StatvsRow): Promise<LegacyCopy> {
  let mod: { outboxPath?: () => string; digestPath?: () => string };
  try { mod = await import("./lib/legacyOutbox.ts"); } catch (e) {
    if (!isMissingModule(e)) throw e;
    return { ok: true, scrubbed: 0, event_id: null, reason: "legacy outbox retired" };
  }
  const data = (row.data && typeof row.data === "object" ? row.data : {}) as { event_id?: unknown };
  let eventId = typeof data.event_id === "string" ? data.event_id : null;
  const rowMs = Date.parse(row.ts);
  const matches = (e: Record<string, unknown>): boolean => eventId !== null
    ? e.id === eventId
    : e.source === row.writer && e.title === row.title && typeof e.ts === "string" && Date.parse(e.ts) === rowMs;
  const needle = eventId !== null ? `"id":${JSON.stringify(eventId)}` : `"title":${JSON.stringify(row.title ?? "")}`;
  let scrubbed = 0;
  for (const path of [mod.outboxPath?.(), mod.digestPath?.()]) {
    if (!path || !existsSync(path)) continue;
    const buf = readFileSync(path);
    let at = 0;
    while (at < buf.length) {
      let nl = buf.indexOf(10, at);
      if (nl < 0) nl = buf.length;
      const text = buf.subarray(at, nl).toString("utf8");
      const start = at;
      at = nl + 1;
      if (!text.includes(needle)) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(text) as Record<string, unknown>; } catch { continue; }
      if (!e || typeof e !== "object" || e.redacted === true || !matches(e)) continue;
      if (eventId === null && typeof e.id === "string") eventId = e.id;
      const keep = { id: e.id, ts: e.ts, source: e.source, kind: e.kind, severity: e.severity, title: e.title, ref: e.ref ?? null, privacy_class: e.privacy_class, dedup_key: e.dedup_key };
      const len = Buffer.byteLength(text, "utf8");
      let out = JSON.stringify({ ...keep, summary: "[redacted]", url: null, redacted: true });
      if (Buffer.byteLength(out, "utf8") > len) out = JSON.stringify({ ...keep, summary: "", url: null });
      const bytes = Buffer.from(out, "utf8");
      invariant(bytes.length <= len && !out.includes("\n"), "a scrubbed legacy line fits in the line it replaces");
      const padded = Buffer.concat([bytes, Buffer.alloc(len - bytes.length, 0x20)]);
      const fd = openSync(path, "r+");
      try { writeSync(fd, padded, 0, padded.length, start); } finally { closeSync(fd); }
      scrubbed++;
    }
  }
  return { ok: true, scrubbed, event_id: eventId };
}

/** Ask Lane B's cloud module to delete the cloud copies of these ids (a row id and its event id). */
async function deleteCloudCopies(ids: string[]): Promise<{ ok: boolean; result?: unknown; reason?: string }> {
  let mod: { deleteCloudCopy?: (ids: string[]) => unknown };
  try { mod = await import("./lib/cloud.ts"); } catch (e) {
    if (!isMissingModule(e)) throw e;
    return { ok: false, reason: "lib/cloud.ts is not built yet; the cloud copy is not deleted" };
  }
  if (typeof mod.deleteCloudCopy !== "function") return { ok: false, reason: "lib/cloud.ts exports no deleteCloudCopy; the cloud copy is not deleted" };
  try {
    const result = await mod.deleteCloudCopy(ids);
    const ok = result && typeof result === "object" && "ok" in result ? (result as { ok: unknown }).ok === true : true;
    return { ok, result };
  } catch (e) {
    return { ok: false, reason: `cloud delete failed: ${(e as Error)?.message ?? String(e)}` };
  }
}

const cloudModule = () => import("./lib/cloud.ts") as Promise<LaneModule>;
const collectModule = () => import("./lib/collect.ts") as Promise<LaneModule>;

export interface CommandDef { usage: string; access?: AccessDecl; run: Command }

export const COMMANDS: Record<string, CommandDef> = {
  event: {
    access: "write",
    usage: "event --source S --kind K --severity S --title T --summary S [--ref R] [--url U] [--privacy public|personal] [--dedup KEY] [--meta JSON]",
    run: ({ flags }) => {
      const source = str(flags.source), kind = str(flags.kind), severity = str(flags.severity), title = str(flags.title), summary = str(flags.summary);
      if (!source || !title || summary === undefined || !KINDS.includes(kind as never) || !SEVERITIES.includes(severity as never)) {
        console.error("event requires --source --kind --severity --title --summary");
        return 2;
      }
      const privacy = str(flags.privacy) ?? "personal";
      if (!EVENT_PRIVACY.includes(privacy as never)) { console.error(`invalid --privacy: ${privacy}`); return 2; }
      let meta: EventInput["meta"];
      const rawMeta = str(flags.meta);
      if (rawMeta !== undefined) {
        try { meta = JSON.parse(rawMeta); } catch { console.error("--meta must be a JSON object"); return 2; }
      }
      const ref = str(flags.ref) ?? null;
      const r = writeEvent({
        source, ts: new Date().toISOString(), kind: kind as EventInput["kind"], severity: severity as EventInput["severity"],
        title, summary, ref, url: str(flags.url) ?? null, privacy_class: privacy as EventInput["privacy_class"],
        dedup_key: str(flags.dedup) ?? `${source}:${ref ?? title}:${severity}`, ...(meta !== undefined ? { meta } : {}),
      });
      if (!r.ok) { console.log(JSON.stringify(r)); return 1; }
      console.log(JSON.stringify({ ok: true, event_id: r.event_id, ...("row" in r ? { id: r.row.id } : "spooled" in r ? { spooled: true } : { legacy: true, ...(r.problem ? { problem: r.problem } : {}) }) }));
      return 0;
    },
  },
  forward: { access: "write", usage: "forward ... (lib/cloud.ts)", run: (args) => dispatch(cloudModule, "lib/cloud.ts", "forward", args) },
  pull: { access: "write", usage: "pull ... (lib/cloud.ts)", run: (args) => dispatch(cloudModule, "lib/cloud.ts", "pull", args) },
  cloud: { access: "write", usage: "cloud ... (lib/cloud.ts)", run: (args) => dispatch(cloudModule, "lib/cloud.ts", "cloud", args) },
  collect: { access: "write", usage: "collect ... (lib/collect.ts)", run: (args) => dispatch(collectModule, "lib/collect.ts", "collect", args) },
  append: {
    access: "write",
    usage: "append --writer W --stream S [--class C] [--app A] [--kind K] [--severity S] [--title T] [--session ID] [--ref R] [--data JSON]",
    run: async ({ flags }) => {
      let raw = str(flags.data);
      if (raw === undefined && !process.stdin.isTTY) raw = (await Bun.stdin.text()).trim() || undefined;
      let data: unknown = null;
      if (raw !== undefined) {
        try { data = JSON.parse(raw); } catch { data = raw; }
      }
      const input: StatvsInput = {
        writer: str(flags.writer) ?? "", stream: str(flags.stream) ?? "",
        class: str(flags.class) as PrivacyClass | undefined, app: str(flags.app), kind: str(flags.kind),
        severity: str(flags.severity) as StatvsInput["severity"], title: str(flags.title), session: str(flags.session),
        ref: str(flags.ref), ts: str(flags.ts), data,
      };
      const r = append(input);
      console.log(JSON.stringify(r.ok ? { ok: true, id: r.row.id, hlc: r.row.hlc } : r));
      return r.ok ? 0 : 1;
    },
  },
  verify: {
    access: "read",
    usage: "verify [--classes] [--json]",
    run: ({ flags }) => {
      const r = verify({ classes: flags.classes === true });
      if (flags.json) console.log(JSON.stringify(r));
      else if (r.ok) console.log("STATVS verify: ok");
      else { console.log(`STATVS verify: ${r.problems.length} problem(s)`); for (const p of r.problems) console.log(`  ${p}`); }
      return r.ok ? 0 : 1;
    },
  },
  seal: {
    access: "write",
    usage: "seal [--today YYYY-MM-DD]",
    run: ({ flags }) => {
      const r = seal({ today: str(flags.today) });
      console.log(JSON.stringify(r));
      return 0;
    },
  },
  redact: {
    access: "write",
    usage: "redact <id> --reason \"<why>\"",
    run: async ({ positional, flags }) => {
      const id = positional[0];
      const reason = str(flags.reason);
      if (!id || !reason) { console.error("usage: redact <id> --reason \"<why>\""); return 2; }
      const before = rowById(id); // read first: the scrub nulls data.event_id
      const r = redact(id, reason);
      const forwarded = !!before && typeof before.severity === "string" && streamDef(before.stream)?.forward === true;
      if (!r.ok || !forwarded) { console.log(JSON.stringify(r)); return r.ok ? 0 : 1; }
      const legacy = await scrubLegacyCopies(before!);
      const ids = [...new Set([before!.id, ...(legacy.event_id ? [legacy.event_id] : [])])];
      const cloud = await deleteCloudCopies(ids);
      console.log(JSON.stringify({ ...r, legacy, cloud }));
      if (!cloud.ok) console.error(`redact: record scrubbed; ${cloud.reason ?? "cloud copy not confirmed deleted"}`);
      return legacy.ok && cloud.ok ? 0 : 1;
    },
  },
  prune: {
    access: "write",
    usage: "prune --stream S --days N [--dry-run] [--json]",
    run: ({ flags }) => {
      const stream = str(flags.stream), days = str(flags.days);
      if (!stream || days === undefined) { console.error("prune needs an explicit --stream and --days; every registered stream is kept forever (ISC-107)"); return 2; }
      const r = prune({ stream, days: Number(days), dryRun: flags["dry-run"] === true });
      if (flags.json) console.log(JSON.stringify(r));
      else if (!r.ok && r.message) console.log(`Prune refused: ${r.message}`);
      else {
        console.log(`Prune ${stream} before ${r.cutoff}: ${r.deleted.length} segments ${flags["dry-run"] === true ? "would be deleted" : "deleted"}, ${r.kept.length} kept`);
        for (const k of r.kept) console.log(`  Kept ${k.segment}: ${k.why}`);
      }
      return r.ok ? 0 : 1;
    },
  },
  tail: {
    access: "read",
    usage: "tail [--stream S] [--n 20] [--hours 1] [--data] [--local]",
    run: async ({ flags }) => {
      const stream = str(flags.stream);
      const n = Math.max(1, Number(str(flags.n) ?? 20));
      if (flags.local === true) {
        // This Mac's segments, until they are retired (migration ISA F9).
        const { rows, problems } = scan(stream ? { streams: [stream] } : {});
        for (const r of rows.slice(-n)) console.log(JSON.stringify(r));
        for (const p of problems ?? []) console.error(`problem: ${p}`);
        return 0;
      }
      // The cloud record answers by default (ISC-170): the last n rows by time. The window starts at --hours (default 1)
      // and widens until it holds n rows or reaches a year, so a quiet stream still shows its last rows, as --local does.
      const hours = Number(str(flags.hours) ?? 1);
      if (!Number.isFinite(hours) || hours <= 0) { console.error("--hours needs a positive number"); return 2; }
      const { cloudRows } = await import("./lib/cloudRead");
      let rows: Awaited<ReturnType<typeof cloudRows>> = [];
      for (let h = hours; ; h *= 8) {
        rows = await cloudRows({ from: new Date(Date.now() - h * 3_600_000).toISOString(), ...(stream ? { stream } : {}) });
        if (rows.length >= n || h >= 24 * 365) break;
      }
      const last = rows.slice(-n);
      if (flags.data === true && last.some((r) => r.body)) {
        const full = await cloudRows({ from: last[0]!.ts, ...(stream ? { stream } : {}), withData: true });
        const want = new Set(last.map((r) => r.offset));
        for (const r of full.filter((x) => want.has(x.offset))) console.log(JSON.stringify(r));
      } else for (const r of last) console.log(JSON.stringify(r));
      return 0;
    },
  },
  "compare-cloud": {
    access: "read",
    usage: "compare-cloud [--days 2] [--json]",
    run: async ({ flags }) => {
      // Every local row in the cloud, same place and hash (migration ISA ISC-169); must pass before local removal.
      const { compareCloud } = await import("./lib/compareCloud");
      const r = await compareCloud({ days: Number(str(flags.days) ?? 2) });
      if (flags.json) console.log(JSON.stringify(r));
      else {
        console.log(`Compare ${r.days.join(", ")}: ${r.local} local rows; ${r.matched} in the cloud unchanged, ${r.withheld} withheld, ${r.sealed} kept on this machine by rule and sealed in the cloud, ${r.localOnly} kept on this machine by rule (only copy), ${r.incomplete.length} without payload, ${r.pending} not shipped yet, ${r.missing.length} missing, ${r.mismatched.length} different${r.customer ? `; ${r.customer} customer rows in the local record` : ""}`);
        for (const k of [...r.missing.slice(0, 20)]) console.log(`  missing ${k}`);
        for (const k of [...r.mismatched.slice(0, 20)]) console.log(`  different ${k}`);
      }
      return r.missing.length + r.mismatched.length === 0 ? 0 : 1;
    },
  },
  reconcile: {
    access: (args) => (args.flags.emit === true ? "write" : "read"),
    usage: "reconcile [--hours 2] [--emit] [--local] [--json]",
    run: async ({ flags }) => {
      // The record against its witnesses (ISA F15). Read-only unless --emit, which writes one Vigil event per gap per day.
      const { reconcile, reconcileCloud, reportGaps } = await import("./lib/reconcile");
      const { driftSchedules } = await import("../WORKFLOWS/engine/schedule-install.ts");
      const ropts = { hours: Number(str(flags.hours) ?? 2), drift: () => driftSchedules().drifted };
      // The cloud record answers by default; --local reads this Mac's segments until they are retired (migration ISA F9).
      const r = flags.local === true ? reconcile(ropts) : await reconcileCloud(ropts);
      const sent = flags.emit === true ? reportGaps(r) : [];
      if (flags.json) console.log(JSON.stringify({ ...r, emitted: sent.filter((e) => e.ok && !("skipped" in e)).length }));
      else {
        console.log(`Reconcile ${r.from} to ${r.to}: ${r.seen.prompts} prompts, ${r.seen.refusals} refusals seen; ${r.gaps.length === 0 ? "no gaps" : `${r.gaps.length} gaps`}`);
        for (const g of r.gaps) console.log(`  ${g.check}: ${g.count} (${g.ids.join(", ")}). Fix: ${g.fix}`);
      }
      return 0;
    },
  },
  counters: {
    access: "read",
    usage: "counters",
    run: () => {
      console.log(JSON.stringify(counters()));
      return 0;
    },
  },
  views: {
    access: "read",
    usage: "views [--json]",
    run: async ({ flags }) => {
      const reg = await loadViews();
      const list = reg.views.map((v) => ({ name: v.name, group: v.group ?? null, streams: v.streams, classes: v.classes, path: v.path, checkpoint: checkpointRel(v.name), live: typeof v.live === "function" }));
      if (flags.json) console.log(JSON.stringify(list));
      else {
        if (list.length === 0) console.log("STATVS views: none registered");
        for (const v of list) console.log(`${v.name}${v.group ? ` [${v.group}]` : ""}  ${v.streams.join(",")}  ${v.classes.join(",")}  -> ${v.path}`);
      }
      for (const p of reg.problems) console.error(`problem: ${p}`);
      return reg.problems.length > 0 ? 1 : 0;
    },
  },
  rebuild: {
    access: "write",
    usage: "rebuild <view> [--out DIR] [--json]",
    run: async ({ positional, flags }) => {
      const name = positional[0];
      if (!name) { console.error("usage: rebuild <view> [--out DIR]"); return 2; }
      const def = await getView(name);
      if (!def) { console.error(`no registered view named ${name}`); return 2; }
      const r = rebuildDef(def, { outDir: str(flags.out) });
      const out = { view: r.view, rows: r.rows, output: r.output };
      console.log(flags.json ? JSON.stringify(out) : `Rebuilt ${r.view}: ${r.rows} rows -> ${r.output}`);
      return 0;
    },
  },
  compare: {
    access: ({ flags }) => (flags.record !== undefined ? "write" : "read"),
    usage: "compare <view> [--json] [--record] | compare <view> --days N [--since ISO] [--json] [--local]",
    run: async ({ positional, flags }) => {
      const name = positional[0];
      if (!name) { console.error("usage: compare <view> [--json] [--record]"); return 2; }
      if (flags.days !== undefined) {
        const want = Number(str(flags.days));
        if (!Number.isInteger(want) || want < 1) { console.error("--days needs a whole number of days"); return 2; }
        // The streak is a question about this Mac's views: its rows in the cloud plus its unshipped ones (migration ISA ISC-179).
        const { recordRows } = await import("./lib/cloudRead");
        const read = await recordRows({ streams: ["statvs"], classes: ["system"], thisMachine: true }, { local: flags.local !== undefined });
        for (const p of read.problems) console.error(p);
        const s = compareStreak(read.rows, name, { since: str(flags.since) });
        // N days means N calendar days and at least N-1 full days between the first compare and the last.
        const ok = s.streak >= want && s.span_hours >= (want - 1) * 24;
        if (flags.json) console.log(JSON.stringify({ ...s, want, ok }));
        else console.log(`Compare ${name}: ${s.streak} of ${want} consecutive equal days over ${s.span_hours} h${s.latest ? ` (latest ${s.latest})` : " (no compare rows yet)"}${s.failed.length ? `; differed on ${s.failed.join(", ")}` : ""}`);
        return ok ? 0 : 1;
      }
      const def = await getView(name);
      if (!def) {
        const r = { view: name, equal: false, reason: "no registered view" };
        console.log(flags.json ? JSON.stringify(r) : `Compare ${name}: no registered view`);
        return 2;
      }
      const r = await compareDef(def);
      if (flags.record) {
        const a = append({ writer: "statvs-compare", stream: "statvs", class: "system", kind: "compare", title: `Compare ${r.view}: ${r.equal ? "equal" : "differs"}`, data: { view: r.view, equal: r.equal, against: r.against, rows: r.rows, differences: r.diff?.length ?? 0 } });
        if (!a.ok) console.error(`compare row not recorded: ${"refused" in a ? a.refused : a.reason}`);
      }
      if (flags.json) console.log(JSON.stringify(r));
      else {
        console.log(`Compare ${r.view} against ${r.against}: ${r.equal ? "equal" : "differs"} (${r.rows} rows)${r.reason ? ` - ${r.reason}` : ""}`);
        for (const d of r.diff ?? []) console.log(`  ${d}`);
      }
      return r.equal ? 0 : 1;
    },
  },
  drill: {
    access: ({ flags }) => (flags["no-record"] === true ? "read" : "write"),
    usage: "drill [--json] [--no-record]",
    run: async ({ flags }) => {
      const r = await drill({ record: flags["no-record"] !== true });
      if (flags.json) console.log(JSON.stringify(r));
      else {
        console.log(`STATVS drill: loss ${r.loss} (${r.views.filter((v) => !v.equal && !v.unmaterialized).length} of ${r.views.length} views differ, ${r.unmaterialized.length} not materialized yet, ${r.unclaimed} unclaimed STATE files)`);
        for (const v of r.views) console.log(`  ${v.equal ? "ok  " : v.unmaterialized ? "new " : "LOST"} ${v.name}${v.group ? ` [${v.group}]` : ""} (${v.mode}, ${v.rows} rows)${v.reason ? ` - ${v.reason}` : ""}`);
        const dirs = Object.entries(r.unclaimed_by_dir).sort((a, b) => b[1] - a[1]);
        if (dirs.length > 0) console.log("  Unclaimed by folder:");
        for (const [d, n] of dirs) console.log(`    ${String(n).padStart(6)}  ${d}`);
        console.log(`  Refused ${r.refused}, spooled ${r.spooled}, quarantined ${r.quarantined} since the last drill`);
        for (const p of r.registry_problems) console.log(`  Registry problem: ${p}`);
      }
      return 0;
    },
  },
  backup: {
    access: "write",
    usage: "backup [--json]",
    run: async ({ flags }) => {
      const r = backup();
      // Offsite is part of the backup: a local copy alone is not one (ISC-108). Tests get no store unless STATVS_OFFSITE_DIR names one.
      const store = await offsiteStore();
      const o = store ? await offsite(store, { dir: r.dir }) : null;
      if (flags.json) console.log(JSON.stringify({ ...r, offsite: o ?? "skipped: no offsite store under test" }));
      else {
        console.log(`Backed up ${r.written.length} changed of ${r.segments} segments (${r.unchanged} unchanged) -> ${r.dir}`);
        console.log(o ? `Offsite: ${o.uploaded.length} sent, ${o.unchanged} unchanged, ${o.deleted.length} deleted, manifest ${o.manifest_verified ? "verified" : "NOT VERIFIED"}` : "Offsite: skipped (no store under test)");
      }
      return o && !o.manifest_verified ? 1 : 0;
    },
  },
  "seal-copies": {
    access: "write",
    usage: "seal-copies [--max N] [--json]",
    run: async ({ flags }) => {
      // Every ship:false row gets one sealed copy that ships as ciphertext (lib/seal.ts); the ship workflow runs this first.
      const { sealPending } = await import("./lib/seal");
      const r = sealPending(str(flags.max) ? { max: Number(str(flags.max)) } : {});
      if (flags.json) console.log(JSON.stringify(r));
      else {
        console.log(`Sealed ${r.sealed} rows, ${r.already} already sealed, ${r.left} left for the next run`);
        for (const p of r.problems.slice(0, 20)) console.log(`  ${p}`);
      }
      return r.problems.length === 0 ? 0 : 1;
    },
  },
  "restore-drill": {
    access: "write",
    usage: "restore-drill [--offsite] [--json]",
    run: async ({ flags }) => {
      const fromOffsite = flags.offsite === true;
      let fetched: string | undefined;
      if (fromOffsite) {
        const store = await offsiteStore();
        const identity = keychainIdentity();
        if (!store || !identity) { console.error(!store ? "restore-drill --offsite: no offsite store (set STATVS_OFFSITE_DIR under test)" : "restore-drill --offsite: no age identity in the Keychain"); return 1; }
        fetched = mkdtempSync(joinPath(tmpdir(), "statvs-offsite-"));
        const f = await fetchOffsite(store, fetched, identity);
        if (!f.ok) {
          rmSync(fetched, { recursive: true, force: true });
          if (flags.json) console.log(JSON.stringify({ ok: false, restored: 0, offsite: true, problems: f.problems }));
          else { console.log("Restore drill (offsite): FAIL"); for (const p of f.problems) console.log(`  ${p}`); }
          return 1;
        }
      }
      let r: ReturnType<typeof restoreDrill>;
      try { r = restoreDrill(fetched ? { dir: fetched } : {}); } finally { if (fetched) rmSync(fetched, { recursive: true, force: true }); }
      if (r.ok) append({ writer: "statvs-restore", stream: "statvs", class: "system", kind: "restore-drill", title: `Restore drill${fromOffsite ? " (offsite)" : ""}: ${r.restored} segments restored`, data: { restored: r.restored, exact: r.exact, prefix: r.prefix, not_backed_up: r.not_backed_up.length, verify_ok: r.verify_ok, offsite: fromOffsite } });
      if (flags.json) console.log(JSON.stringify(r));
      else {
        console.log(`Restore drill: ${r.ok ? "pass" : "FAIL"}, ${r.restored} restored (${r.exact} exact, ${r.prefix} still growing), verify ${r.verify_ok ? "ok" : "failed"}, ${r.not_backed_up.length} not backed up yet`);
        for (const p of r.problems) console.log(`  ${p}`);
      }
      return r.ok ? 0 : 1;
    },
  },
};

/** What one call of a subcommand does. Undeclared or unknown counts as "write". */
export function accessOf(name: string, args: ParsedArgs): Access {
  const decl = Object.hasOwn(COMMANDS, name) ? COMMANDS[name]!.access : undefined;
  if (decl === "read") return "read";
  if (typeof decl === "function") return decl(args) === "read" ? "read" : "write";
  return "write";
}

/** Subcommands that write on every call (a per-call declaration counts here too). Kept for readers of the old set. */
export const WRITE_COMMANDS: ReadonlySet<string> = new Set(Object.keys(COMMANDS).filter((n) => COMMANDS[n]!.access !== "read"));

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const cmd = name ? COMMANDS[name] : undefined;
  // P1: agent jobs get no write door. Checked before the command lookup: an unknown name and a
  // command with no access declaration count as writes.
  if (name && process.env.AGENTJOB_ID && accessOf(name, parseArgs(rest)) !== "read") {
    console.error(`${name} is not open to agent jobs (AGENTJOB_ID is set); they hand Vigil a job text with Vigil.ts emit --text-file`);
    return 2;
  }
  if (!cmd) {
    console.error("usage: bun LIFEOS/STATVS/Statvs.ts <command>\n" + Object.values(COMMANDS).map((c) => `  ${c.usage}`).join("\n"));
    return name ? 2 : 0;
  }
  return await cmd.run(parseArgs(rest));
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
