/**
 * Achilles Pulse module — read-only surface over the vulnerability management
 * registry, read through Achilles' loadRegistry().
 *
 * Achilles is the single source of truth for known weaknesses across every
 * category (technical, financial, reputational, legal, physical, operational)
 * and every finder (synapse, pentest, atlas, the workflows scanner, threatmodel,
 * manual). This module only reads; mutations go through the CLI
 * (bun LIFEOS/TOOLS/Achilles.ts) so every write passes its invariants.
 *
 * Routes:
 *   GET /api/achilles        → { generated_at, stats, open_critical, entries }
 *   GET /api/achilles/banner → { alert: bool, open_critical, open_high, items[] }
 *   GET /api/achilles/report → { path, markdown, exposure_line } of the newest security audit report
 */
import { loadRegistry } from "../../TOOLS/Achilles";
import { latestAudit, latestReport } from "../../TOOLS/SecurityAudit";

const MODULE_NAME = "achilles";

const CACHE_TTL_MS = 15_000;
const state: { running: boolean; cache: { payload: Payload; expiresAt: number } | null } = { running: false, cache: null };

interface Entry {
  id: string; title: string; category: string; severity: string; source: string;
  status: string; cves: string[]; affected: string[]; first_seen: string;
  closed_at?: string; work_issue?: number; ul_issue?: number; risk_ref?: string; evidence: string[]; links: string[];
  affected_match?: boolean;
}
interface Payload {
  generated_at: string; stats: Record<string, unknown>; open_critical: Entry[]; entries: Entry[];
  /** The newest security audit (SecurityAudit.ts): when it ran and how much of the estate its finders reached. */
  last_audit: string | null;
  /** The report's own opening line ("Exposure: …"), so Pulse shows exactly what the report says. */
  exposure_line: string | null; coverage: { pct: number; ran: number; total: number } | null; open_by_life_risk: Record<string, number>;
}

function compose(): Payload {
  const entries = loadRegistry().entries as Entry[];
  const audit = latestAudit();
  const report = latestReport();
  const isOpen = (e: Entry) => e.status === "open" || e.status === "in_progress";
  const open = entries.filter(isOpen);
  // Worst first, then oldest first — the banner leads with the top item.
  const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const openCrit = open
    .filter((e) => e.severity === "critical" || e.severity === "high")
    .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || (a.first_seen || "").localeCompare(b.first_seen || ""));
  return {
    generated_at: new Date().toISOString(),
    stats: {
      total: entries.length,
      open: open.length,
      open_critical: open.filter((e) => e.severity === "critical").length,
      open_high: open.filter((e) => e.severity === "high").length,
      informational: entries.filter((e) => e.status === "informational").length,
      remediated: entries.filter((e) => e.status === "remediated").length,
      by_category: entries.reduce<Record<string, number>>((m, e) => ((m[e.category] = (m[e.category] ?? 0) + 1), m), {}),
      // The flowing-system numbers (2026-09-15): who closes what, and how long it sits.
      by_fix_class: open.reduce<Record<string, number>>((m, e) => ((m[(e as { fix_class?: string }).fix_class ?? "unclassified"] = (m[(e as { fix_class?: string }).fix_class ?? "unclassified"] ?? 0) + 1), m), {}),
      over_24h: open.filter((e) => Date.now() - Date.parse(e.first_seen || "") > 86_400_000).length,
    },
    open_critical: openCrit,
    last_audit: audit?.at ?? null,
    exposure_line: report?.exposure_line ?? null,
    coverage: audit ? { pct: audit.coverage_pct, ran: audit.ran, total: audit.total } : null,
    open_by_life_risk: audit?.by_risk ?? {},
    entries: entries.slice().sort((a, b) => (b.first_seen || "").localeCompare(a.first_seen || "")),
  };
}

export function start(): void {
  state.running = true;
  console.log(`[${MODULE_NAME}] Started — serving /api/achilles`);
}

export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/achilles")) return null;
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const now = Date.now();
  if (!state.cache || state.cache.expiresAt <= now) {
    try {
      state.cache = { payload: compose(), expiresAt: now + CACHE_TTL_MS };
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }
  if (pathname === "/api/achilles/report") {
    const r = latestReport();
    return r ? Response.json(r) : Response.json({ error: "no audit report yet" }, { status: 404 });
  }
  const p = state.cache.payload;
  if (pathname === "/api/achilles/banner") {
    return Response.json({
      alert: p.open_critical.length > 0,
      open_critical: p.stats.open_critical,
      open_high: p.stats.open_high,
      items: p.open_critical.map((e) => ({ id: e.id, title: e.title, severity: e.severity, work_issue: e.work_issue ?? e.ul_issue ?? null })),
    });
  }
  return Response.json(p);
}

export function health(): { running: boolean } {
  return { running: state.running };
}
