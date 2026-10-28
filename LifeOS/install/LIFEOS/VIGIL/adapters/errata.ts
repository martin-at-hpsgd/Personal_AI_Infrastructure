/** Errata new-entry adapter over the monthly ledger and the tenant ledger: each event carries the entry's kind, system, severity and id, never its words (complaints, praise and wants are the principal's own text, and the ledger is where they live). Single entries go to the Pulse feed; Errata's daily roll-up (ERRATA/Report.ts) is what reaches the digest. @version 0.5.0 */
import { lifeosPath } from "../../TOOLS/Paths";
import { existsSync, readFileSync } from "node:fs"; import { homedir } from "node:os"; import { basename, join } from "node:path"; import type { VigilEvent } from "../../STATVS/lib/refuse"; import { readJson, statePath } from "../../STATVS/lib/collectState"; import { clip, event, need, requireSource, withCursor } from "./common";
/** `about` holds the title, summary, kind and severity of each line new to the cursor, computed in live(); absent on cursors written before 0.3.0. */
/** `months` names the ledger files read; an id from a month the previous read did not cover is history, never news. */
export type Snapshot = { ids: string[]; months?: string[]; about?: Record<string, { title: string; summary: string; kind?: string; severity?: VigilEvent["severity"] }> };
/** Every Errata kind (ERRATA/Schema.ts KINDS) has its own entry, so nothing falls through to a default. A single entry is Pulse news, never a digest line: praise is info and every other kind is low. */
export const SEVERITY_BY_KIND: Record<string, VigilEvent["severity"]> = { correction: "low", bug: "low", complaint: "low", incident: "low", "feature-request": "low", feature: "low", question: "low", praise: "info" };
/** Rows the evidence projector inferred (ERRATA/Schema.ts `detected`) are its own output, never a human's words. */
const SKIPPED_SOURCES: ReadonlySet<string> = new Set(["detected"]);
/** App-sourced rows (ERRATA/Store.ts TENANT_SOURCES) carry tenant data: their events name the line and never quote it. */
const TENANT_SOURCES: ReadonlySet<string> = new Set(["customer", "user"]);
type Line = { op?: string; id?: string; kind?: string; system?: string; source?: string; target?: string; channel?: string; frustration?: number | null; rating?: number | null; complaint?: string; enrichment?: { summary?: string; title?: string; how_upset?: number } | null; links?: { failure_dir?: string } };
const GIST_MAX = 160;
/** The raw health and money values Vigil refuses on a health or money event (STATVS/lib/refuse.ts validateEvent): withheld from a gist so no Errata event carries one. */
const RAW_VALUE = /\$\s*\d[\d,]*(?:\.\d+)?|\b\d+(?:[.,]\d+)?\s*(?:bpm|ms|kg|lbs?|usd|eur|gbp)\b/gi;
const withholdValues = (text: string): string => text.replace(RAW_VALUE, "[value]");
/** A kind or system name as the ledger writes it (ERRATA/Schema.ts KINDS, SYSTEMS); anything else is not echoed into an event. */
const TOKEN = /^[a-z][a-z0-9_-]{0,39}$/i;
const token = (v: string | undefined, fallback: string): string => (v && TOKEN.test(v) ? v : fallback);
/**
 * A correction the enrichment judged at the top of the upset scale (how_upset 3) keeps its digest line; every other single entry
 * stays on Pulse at its kind's severity. The capture-time frustration signal is not used: it reads 3 on a third more corrections
 * than the enrichment does, and the digest is what this adapter must not flood.
 */
export function severityOf(line: Pick<Line, "kind" | "frustration" | "enrichment">): VigilEvent["severity"] {
  const kind = line.kind ?? "complaint";
  if (kind === "correction" && line.enrichment?.how_upset === 3) return "medium";
  return SEVERITY_BY_KIND[kind] ?? "low";
}
/**
 * The complaint's own words, never the scaffolding a channel wrapped around them: a texting-channel capture carries its conversation
 * as JSON records, and the last inbound principal record is the complaint. No event carries it since 0.5.0; it stays
 * exported only for the contract test that still holds it.
 */
export function gist(line: Line): { text: string; from: "enrichment" | "failure" | "complaint" | "none" } {
  const enriched = line.enrichment?.summary ?? line.enrichment?.title;
  if (enriched) return { text: clip(withholdValues(enriched), GIST_MAX), from: "enrichment" };
  const slug = line.links?.failure_dir ? basename(line.links.failure_dir).replace(/^\d{4}-\d{2}-\d{2}-\d{6}_/, "").replaceAll("-", " ").trim() : "";
  if (slug) return { text: clip(withholdValues(slug), GIST_MAX), from: "failure" };
  const lines = String(line.complaint ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const inbound = lines.flatMap((l) => { if (!l.startsWith("{")) return []; try { const r = JSON.parse(l); return r?.direction === "inbound" && r?.source === "principal" && typeof r.text === "string" ? [r.text as string] : []; } catch { return []; } }).at(-1);
  const plain = inbound ?? lines.find((l) => !l.startsWith("#") && !l.startsWith("{") && !/^(These JSON records|No explicit reply target)/.test(l));
  return plain ? { text: clip(withholdValues(plain), GIST_MAX), from: "complaint" } : { text: "", from: "none" };
}
/** An event's words for one entry: its kind, system, severity and id, and nothing read from the entry's text, enrichment or failure record. */
export function describe(line: Line): { title: string; summary: string; kind: string; severity: VigilEvent["severity"] } {
  const kind = token(line.kind, "complaint"), system = token(line.system, "an unknown system"), severity = severityOf({ ...line, kind });
  const from = TENANT_SOURCES.has(line.source ?? "") ? " from an app user" : "";
  return {
    title: clip(`Errata ${kind} on ${system}${from}: ${line.id}`, 140),
    summary: `One new ${kind} entry on ${system}${from}, severity ${severity}. Its words stay in the ledger. Look: bun LIFEOS/ERRATA/Errata.ts show ${line.id}`,
    kind, severity,
  };
}
export function diff(prev: Snapshot | undefined, next: Snapshot): VigilEvent[] {
  if (!prev?.ids) return [];
  const old = new Set(prev.ids), covered = new Set(prev.months ?? [new Date().toISOString().slice(0, 7)]), month = (id: string) => { const m = id.match(/^ERR-(\d{4})(\d{2})/); return m ? `${m[1]}-${m[2]}` : ""; };
  return next.ids.filter((id) => !old.has(id) && (!month(id) || covered.has(month(id)))).map((id) => { const d = next.about?.[id] ?? { title: `Errata entry ${id}`, summary: `Errata recorded ${id}; its line was not read. Look: bun LIFEOS/ERRATA/Errata.ts show ${id}` }; return event("errata", id, "new", d.severity ?? SEVERITY_BY_KIND[d.kind ?? "complaint"] ?? "low", d.title, d.summary, "customer"); });
}
/** The ledger and tenant dirs, resolved on every read with the same environment and defaults as ERRATA/Store.ts, so a test or a second install points the adapter where the store writes. */
export function ledgerDirs(): { ledger: string; tenants: string } {
  const state = process.env.ERRATA_STATE_DIR ?? join(homedir(), ".local/state/lifeos/errata");
  return { ledger: process.env.ERRATA_DIR ?? lifeosPath("USER", "ERRATA"), tenants: process.env.ERRATA_TENANT_DIR ?? join(state, "tenants") };
}
/** `seen` is the previous cursor's ids: every line outside it gets its title, however far back in the month it sits. With no cursor, the newest 200 lines are described. */
export async function live(seen?: ReadonlySet<string>): Promise<Snapshot> {
  const { ledger, tenants } = ledgerDirs();
  requireSource(ledger, `errata ledger directory ${ledger}`);
  const now = new Date(), month = (d: Date) => `errata-${d.toISOString().slice(0, 7)}.jsonl`, last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  /** The previous month is read too, so a line written just before the month turns is never missed. A tenant dir that does not exist yet holds no lines. */
  const files = [ledger, ...(existsSync(tenants) ? [tenants] : [])].flatMap((dir) => [month(last), month(now)].map((f) => join(dir, f)));
  const rows = files.filter((p) => existsSync(p)).flatMap((p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line));
  need(rows.every((r) => typeof r.id === "string"), "errata line id");
  /**
   * A patch line is never a new entry: it folds onto the earlier entry with its id, in ledger order, the way ERRATA/Store.ts all() does.
   * Enrichment arrives as a patch, and severityOf reads it, so dropping patches would describe a correction at how_upset 3 as low.
   * (The patch field is read through a cast: a change to this file's type lines changes shapeOf and re-baselines the cursor.)
   */
  const kept: Line[] = [], byId = new Map<string, Line>();
  for (const r of rows) {
    if (r.op === "patch") { const target = byId.get(r.id!), patch = (r as { patch?: unknown }).patch; if (target && patch && typeof patch === "object") Object.assign(target, patch); continue; }
    if (SKIPPED_SOURCES.has(r.source ?? "")) continue;
    const entry = { ...r }; byId.set(r.id!, entry); kept.push(entry);
  }
  const described = seen ? kept.filter((r) => !seen.has(r.id!)) : kept.slice(-200);
  return { ids: kept.map((r) => r.id!), months: [month(last), month(now)].map((f) => f.slice(7, 14)), about: Object.fromEntries(described.map((r) => [r.id!, describe(r)])) };
}
export const read = () => { const prev = readJson<Snapshot | undefined>(statePath("cursors", "errata.json"), undefined); return withCursor("errata", () => live(prev?.ids ? new Set(prev.ids) : undefined), diff); };
