/**
 * Pulse Telos Freshness Module
 *
 * Read-only consumer of the TelosFreshness library at
 * `~/.claude/LIFEOS/TOOLS/TelosFreshness.ts`. Exposes:
 *
 *   GET /api/telos/freshness         → full freshness JSON (all sections)
 *   GET /api/telos/freshness/stale   → stale sections only, sorted
 *   GET /api/telos/freshness/summary → tiny payload for statusline / DA panel
 *   GET /api/telos/risks             → the `## Risks (RN)` register (TelosRisks.ts), prevent/detect/respond states
 *
 * The DA panel and statusline call /summary every refresh; the Interview
 * skill calls /freshness once at the top of /interview to drive its
 * conversation. No writes here — bumps go through the Interview intent,
 * which calls bumpTelosTimestamp() in the lib.
 */

import { readTelosFreshness, readContextFreshness, type TelosFreshness, type ContextFreshness } from "../../TOOLS/TelosFreshness";
import { writeFreshnessCache } from "../../TOOLS/FreshnessCache";
import { openFindings, readTelosRisks } from "../../TOOLS/TelosRisks";

function refreshFileCache(): void {
  try {
    writeFreshnessCache();
  } catch {
    // best-effort — file cache desync is recoverable
  }
}

const MODULE_NAME = "telos";

interface ModuleState {
  running: boolean;
  startedAt: Date | null;
  lastReadAt: Date | null;
  cachedTelos: TelosFreshness | null;
  cachedContext: ContextFreshness | null;
  cacheExpiresAt: number;
}

const state: ModuleState = {
  running: false,
  startedAt: null,
  lastReadAt: null,
  cachedTelos: null,
  cachedContext: null,
  cacheExpiresAt: 0,
};

// Cache freshness reads for 60s — files are small and cheap to re-read, but
// the statusline polls frequently and there's no value in scanning per request.
// Cache invalidates on POST /api/freshness/invalidate (calls invalidate()).
const CACHE_TTL_MS = 60_000;

function ensureCache(): void {
  const now = Date.now();
  if (state.cachedTelos && state.cachedContext && now < state.cacheExpiresAt) return;
  state.cachedTelos = readTelosFreshness();
  state.cachedContext = readContextFreshness();
  state.cacheExpiresAt = now + CACHE_TTL_MS;
  state.lastReadAt = new Date();
}

function freshness(): TelosFreshness {
  ensureCache();
  return state.cachedTelos!;
}

function contextFreshness(): ContextFreshness {
  ensureCache();
  return state.cachedContext!;
}

export async function start(): Promise<void> {
  console.log(`[${MODULE_NAME}] Starting...`);
  state.running = true;
  state.startedAt = new Date();
  // Prime the cache so /summary is hot on first request.
  ensureCache();
  // Warm the statusline render-path cache file at startup.
  refreshFileCache();
  console.log(`[${MODULE_NAME}] Started — telos: ${state.cachedTelos?.totalSections ?? 0} sections (${state.cachedTelos?.staleSections.length ?? 0} stale), context: ${state.cachedContext?.total ?? 0} files (${state.cachedContext?.stale_count ?? 0} stale)`);
}

export async function stop(): Promise<void> {
  console.log(`[${MODULE_NAME}] Stopping...`);
  state.running = false;
  state.cachedTelos = null;
  state.cachedContext = null;
  console.log(`[${MODULE_NAME}] Stopped`);
}

/**
 * Invalidate the freshness cache so the next request re-reads everything.
 * Reachable as `POST /api/freshness/invalidate` (public issue #2201, @bak3r;
 * the documented `/reload` route never existed).
 */
export function invalidate(): void {
  state.cachedTelos = null;
  state.cachedContext = null;
  state.cacheExpiresAt = 0;
  // Also rewrite the on-disk render-path cache so the statusline reflects
  // the same view the next /api/freshness/summary caller will see.
  refreshFileCache();
}

export function health(): { status: string; details?: Record<string, unknown> } {
  if (!state.running) return { status: "stopped" };
  const f = state.cachedTelos;
  const c = state.cachedContext;
  return {
    status: f && f.fileUpdated ? "healthy" : "degraded",
    details: {
      uptime_s: state.startedAt ? Math.floor((Date.now() - state.startedAt.getTime()) / 1000) : 0,
      telos_file_updated: f?.fileUpdated?.toISOString() ?? null,
      telos_file_age_days: f?.fileAgeDays ?? null,
      telos_sections_total: f?.totalSections ?? 0,
      telos_sections_stale: f?.staleSections.length ?? 0,
      context_files_total: c?.total ?? 0,
      context_files_stale: c?.stale_count ?? 0,
      last_read_at: state.lastReadAt?.toISOString() ?? null,
    },
  };
}

/**
 * Pulse routes /api/telos/* here. Returns null on unhandled paths so the
 * outer router can fall through to the next module.
 */
export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  // Multi-file constitutional context (telos + 6 constitutional files)
  if (pathname.startsWith("/api/freshness")) {
    if (pathname === "/api/freshness/invalidate") {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      invalidate();
      return Response.json({ ok: true, invalidated_at: new Date().toISOString() });
    }
    if (pathname === "/api/freshness/summary") {
      const c = contextFreshness();
      return Response.json({
        total: c.total,
        graded_total: c.graded_total,
        fresh_count: c.fresh_count,
        stale_count: c.stale_count,
        overall_pct: c.overall_pct,
        overall_grade: c.overall_grade,
        most_stale: c.most_stale
          ? {
              slug: c.most_stale.slug,
              name: c.most_stale.name,
              age_days: c.most_stale.effective_age_days,
              threshold_days: c.most_stale.effective_threshold_days,
              reviewed_age_days: c.most_stale.effective_reviewed_age_days,
              pct: c.most_stale.pct,
              grade: c.most_stale.grade,
              why: c.most_stale.why,
            }
          : null,
        files: c.files.map((f) => ({
          slug: f.slug,
          name: f.name,
          age_days: f.effective_age_days,
          threshold_days: f.effective_threshold_days,
          reviewed_age_days: f.effective_reviewed_age_days,
          pct: f.pct,
          grade: f.grade,
          stale: f.stale,
          why: f.why,
        })),
      });
    }
    if (pathname === "/api/freshness") {
      return Response.json(contextFreshness());
    }
    return null;
  }

  // Per-section TELOS routes (the original freshness surface)
  if (!pathname.startsWith("/api/telos")) return null;

  if (pathname === "/api/telos/freshness/summary") {
    const f = freshness();
    const top = f.staleSections[0];
    return Response.json({
      file_updated: f.fileUpdated?.toISOString() ?? null,
      file_age_days: f.fileAgeDays,
      total: f.totalSections,
      stale_count: f.staleSections.length,
      most_stale_section: top
        ? { name: top.name, slug: top.slug, age_days: top.ageDays, threshold_days: top.thresholdDays }
        : null,
    });
  }
  if (pathname === "/api/telos/freshness/stale") {
    const f = freshness();
    return Response.json({ count: f.staleSections.length, sections: f.staleSections });
  }
  if (pathname === "/api/telos/freshness") {
    return Response.json(freshness());
  }
  if (pathname === "/api/telos/health") {
    return Response.json(health());
  }
  // The `## Risks (RN)` register — the principal's top life risks with their
  // prevent/detect/respond states. Read straight from TELOS.md through the one
  // parser (LIFEOS/TOOLS/TelosRisks.ts); nothing in the section is secret, so
  // nothing is stripped. `errors` is non-empty when the section is malformed.
  if (pathname === "/api/telos/risks") {
    const parsed = readTelosRisks();
    // Each risk carries its open technical Achilles findings, rolled up through the estate register.
    const open = openFindings(parsed.risks.map((r) => r.id));
    const risks = parsed.risks.map((r) => ({ ...r, open_findings: open[r.id] ?? 0 }));
    return Response.json({ count: risks.length, section_line: parsed.sectionLine, errors: parsed.errors, risks });
  }
  return null;
}
