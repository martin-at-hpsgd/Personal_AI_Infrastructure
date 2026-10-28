#!/usr/bin/env bun
/**
 * UsStats.ts — query and analyze the US long-run indicator dataset at the configured almanac endpoint.
 *
 * Data source: `data_url` in <configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/USStats/Config.md
 * (or env USSTATS_DATA_URL); see UsStatsConfig.ts. Public-domain government and
 * published survey data; every series carries its publisher in `source`).
 * Read-only: this tool never writes to any remote.
 *
 * Commands:
 *   list [--category <c>]         all series: key, name, category, unit, coverage
 *   search <query>                match series by key, name, category, or source
 *   get <key>                     one series: provenance, coverage, values
 *   trend <key> [--from Y] [--to Y]   direction-aware change, CAGR, verdict
 *   movers [--window N]           biggest direction-aware improvements/declines
 *   correlate <a> <b>             Pearson r over overlapping annual years
 *   summary                       dataset metadata and category counts
 *   sync-check                    site freshness vs upstream source-of-record datasets
 *
 * Flags: --json (machine output) · --fresh (bypass cache) · --limit N (movers/list)
 *
 * Partial years: a series' `partialYear` value is a year-to-date figure, not an
 * annual one. All math (trend, movers, correlate) excludes it; `get` annotates it.
 */

import { join } from "node:path";
import { cacheDir } from "../../../LIFEOS/TOOLS/lib/CacheDir.ts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dataUrl, configValue } from "./UsStatsConfig.ts";

const CACHE_DIR = cacheDir("usstats-skill"); // owner-only cache root, never a fixed name in the shared /tmp (round 22)
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h; ETag revalidation after that

interface Series {
  name: string;
  category: string;
  unit: string;
  coverage: { first: number; last: number; points: number };
  goodDirection: "up" | "down" | "neutral" | null;
  partialYear?: number | null;
  partialThrough?: string | null;
  source: string;
  sourceUrl: string;
  historicalSourceUrls?: string[];
  note?: string;
  data: Record<string, number>;
}

interface Dataset {
  _meta: {
    site: string;
    page: string;
    license: string;
    schema: string;
    siblings?: Record<string, string>;
    seriesCount: number;
    dataPoints: number;
    generated?: string;
  };
  generated?: string;
  series: Record<string, Series>;
}

// ---------- fetch & cache ----------

/** `io` lets tests point the cache, the endpoint and the network elsewhere; production uses the defaults. */
export async function loadDataset(fresh: boolean, io: { dir?: string; fetch?: typeof fetch; url?: string } = {}): Promise<Dataset> {
  const dir = io.dir ?? CACHE_DIR, CACHE_FILE = join(dir, "stats.json"), CACHE_META = join(dir, "cache-meta.json"), get = io.fetch ?? fetch;
  const DATA_URL = io.url ?? dataUrl();
  mkdirSync(dir, { recursive: true });
  let cached: Dataset | null = null;
  let meta: { fetchedAt?: number; etag?: string; url?: string } = {};
  try {
    cached = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    meta = JSON.parse(readFileSync(CACHE_META, "utf8"));
  } catch {
    cached = null;
  }
  // The cache belongs to the endpoint that filled it: after data_url or USSTATS_DATA_URL changes,
  // the old endpoint's dataset is never served, not even as the offline fallback.
  if (meta.url !== DATA_URL) {
    cached = null;
    meta = {};
  }

  const age = meta.fetchedAt ? Date.now() - meta.fetchedAt : Infinity;
  if (!fresh && cached && age < CACHE_TTL_MS) return cached;

  const headers: Record<string, string> = {};
  if (!fresh && cached && meta.etag) headers["If-None-Match"] = meta.etag;

  let res: Response;
  try {
    res = await get(DATA_URL, { headers, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    // --fresh asks about the live site: a cached copy would answer a different question.
    if (cached && !fresh) {
      console.error(`⚠️  ${DATA_URL} unreachable; serving cache from ${new Date(meta.fetchedAt!).toISOString()}`);
      return cached;
    }
    throw new Error(fresh ? `Cannot reach ${DATA_URL} and --fresh never serves the cache: ${e}` : `Cannot reach ${DATA_URL} and no cache exists: ${e}`);
  }

  if (res.status === 304 && cached) {
    writeFileSync(CACHE_META, JSON.stringify({ fetchedAt: Date.now(), etag: meta.etag, url: DATA_URL }));
    return cached;
  }
  if (!res.ok) {
    if (cached && !fresh) {
      console.error(`⚠️  HTTP ${res.status} from data endpoint; serving cache`);
      return cached;
    }
    throw new Error(`HTTP ${res.status} from ${DATA_URL}${fresh ? "; --fresh never serves the cache" : ""}`);
  }

  const body = await res.text();
  const data: Dataset = JSON.parse(body);
  if (!data.series || typeof data.series !== "object") throw new Error("Unexpected payload: no `series` object");
  writeFileSync(CACHE_FILE, body);
  writeFileSync(CACHE_META, JSON.stringify({ fetchedAt: Date.now(), etag: res.headers.get("etag") ?? undefined, url: DATA_URL }));
  return data;
}

// ---------- math (exported for tests) ----------

/** Annual (non-partial) year→value pairs, ascending by year. */
export function annualPoints(s: Pick<Series, "data" | "partialYear">): Array<[number, number]> {
  return Object.entries(s.data)
    .map(([y, v]) => [Number(y), v] as [number, number])
    .filter(([y, v]) => Number.isFinite(v) && y !== s.partialYear)
    .sort((a, b) => a[0] - b[0]);
}

export interface Trend {
  startYear: number;
  endYear: number;
  startValue: number;
  endValue: number;
  change: number;
  pctChange: number | null;
  cagr: number | null;
  verdict: "improving" | "worsening" | "flat" | "neutral";
}

export function computeTrend(
  s: Pick<Series, "data" | "partialYear" | "goodDirection">,
  from?: number,
  to?: number
): Trend | null {
  const pts = annualPoints(s).filter(([y]) => (from === undefined || y >= from) && (to === undefined || y <= to));
  if (pts.length < 2) return null;
  const [startYear, startValue] = pts[0];
  const [endYear, endValue] = pts[pts.length - 1];
  const change = endValue - startValue;
  const pctChange = startValue !== 0 ? change / Math.abs(startValue) : null;
  const years = endYear - startYear;
  const cagr = startValue > 0 && endValue > 0 && years > 0 ? Math.pow(endValue / startValue, 1 / years) - 1 : null;
  let verdict: Trend["verdict"];
  if (s.goodDirection !== "up" && s.goodDirection !== "down") verdict = "neutral";
  else if (change === 0) verdict = "flat";
  else {
    const improved = s.goodDirection === "up" ? change > 0 : change < 0;
    verdict = improved ? "improving" : "worsening";
  }
  return { startYear, endYear, startValue, endValue, change, pctChange, cagr, verdict };
}

/** Direction-aware improvement score over a trailing window: +pct = improving. */
export function moverScore(
  s: Pick<Series, "data" | "partialYear" | "goodDirection">,
  windowYears: number
): { score: number; trend: Trend } | null {
  if (s.goodDirection !== "up" && s.goodDirection !== "down") return null;
  const pts = annualPoints(s);
  if (pts.length < 2) return null;
  const endYear = pts[pts.length - 1][0];
  const t = computeTrend(s, endYear - windowYears, endYear);
  if (!t || t.pctChange === null || t.endYear - t.startYear < Math.min(2, windowYears)) return null;
  const score = s.goodDirection === "up" ? t.pctChange : -t.pctChange;
  return { score, trend: t };
}

export function pearson(
  a: Pick<Series, "data" | "partialYear">,
  b: Pick<Series, "data" | "partialYear">
): { r: number; n: number; firstYear: number; lastYear: number } | null {
  const mapA = new Map(annualPoints(a));
  const pairs: Array<[number, number]> = [];
  const years: number[] = [];
  for (const [y, vb] of annualPoints(b)) {
    const va = mapA.get(y);
    if (va !== undefined) {
      pairs.push([va, vb]);
      years.push(y);
    }
  }
  const n = pairs.length;
  if (n < 3) return null;
  const meanA = pairs.reduce((s, p) => s + p[0], 0) / n;
  const meanB = pairs.reduce((s, p) => s + p[1], 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (const [va, vb] of pairs) {
    cov += (va - meanA) * (vb - meanB);
    varA += (va - meanA) ** 2;
    varB += (vb - meanB) ** 2;
  }
  if (varA === 0 || varB === 0) return null;
  return { r: cov / Math.sqrt(varA * varB), n, firstYear: years[0], lastYear: years[years.length - 1] };
}

// ---------- formatting ----------

const fmtNum = (v: number) =>
  Math.abs(v) >= 1e6 ? v.toLocaleString("en-US") : Number.isInteger(v) ? String(v) : v.toFixed(2);
const fmtPct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

function partialNote(s: Series): string {
  return s.partialYear ? ` (${s.partialYear} is YTD through ${s.partialThrough ?? "?"}; excluded from math)` : "";
}

// ---------- sync-check ----------

function treeToRawIndexUrl(treeUrl: string): string | null {
  // https://github.com/<owner>/<repo>/tree/<branch>/<path> → raw index.json
  const m = treeUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/);
  if (!m) return null;
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}/index.json`;
}

export type SyncVerdict = "fresh" | "STALE" | "site older than upstream index (regenerate pending?)" | "unknown" | "unreachable";

/**
 * One upstream index against the site's series. Only shared series whose upstream coverage ends in a year count as
 * compared; with none compared the verdict is "unknown", never "fresh". Pure.
 */
export function upstreamVerdict(
  site: Record<string, Pick<Series, "coverage">>,
  idx: { generated?: string; series?: Record<string, { coverage?: string }> },
  siteGenerated: string | null,
): { sharedSeries: number; comparedSeries: number; staleSeries: string[]; verdict: SyncVerdict } {
  const upstream = idx.series ?? {};
  const shared = Object.keys(upstream).filter((k) => k in site);
  const stale: string[] = [];
  let compared = 0;
  for (const k of shared) {
    const covEnd = upstream[k].coverage?.match(/(\d{4})\s*$/)?.[1];
    if (!covEnd) continue;
    compared++;
    const siteLast = site[k].coverage?.last ?? 0;
    if (Number(covEnd) > siteLast) stale.push(`${k} (site ${siteLast} < upstream ${covEnd})`);
  }
  const verdict: SyncVerdict = stale.length
    ? "STALE"
    : compared === 0
      ? "unknown"
      : siteGenerated && idx.generated && siteGenerated < idx.generated
        ? "site older than upstream index (regenerate pending?)"
        : "fresh";
  return { sharedSeries: shared.length, comparedSeries: compared, staleSeries: stale, verdict };
}

/** Returns true only when every upstream index was reached and compared fresh; anything else is a failed check. */
async function syncCheck(data: Dataset, asJson: boolean): Promise<boolean> {
  const urls = new Set<string>();
  for (const s of Object.values(data.series)) {
    for (const u of s.historicalSourceUrls ?? []) {
      const raw = treeToRawIndexUrl(u);
      if (raw) urls.add(raw);
    }
  }
  if (urls.size === 0) {
    console.log("No historicalSourceUrls in the payload — nothing to sync-check against.");
    return false;
  }
  const siteGenerated = data._meta?.generated ?? data.generated ?? null;
  const results: any[] = [];
  for (const url of urls) {
    const entry: any = { indexUrl: url };
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const idx = (await res.json()) as { generated?: string; series?: Record<string, { coverage?: string; name?: string }> };
      entry.upstreamGenerated = idx.generated ?? null;
      Object.assign(entry, upstreamVerdict(data.series, idx, siteGenerated));
    } catch (e) {
      entry.error = String(e);
      entry.verdict = "unreachable";
    }
    results.push(entry);
  }
  const ok = results.every((r) => r.verdict === "fresh");
  if (asJson) {
    console.log(JSON.stringify({ siteGenerated, ok, upstream: results }, null, 2));
    return ok;
  }
  console.log(`Site data generated: ${siteGenerated ?? "unknown"}\n`);
  for (const r of results) {
    console.log(`Upstream: ${r.indexUrl}`);
    if (r.error) {
      console.log(`  ✗ ${r.error}\n`);
      continue;
    }
    console.log(`  generated: ${r.upstreamGenerated ?? "unknown"} · shared series: ${r.sharedSeries} · compared: ${r.comparedSeries}`);
    if (r.staleSeries.length) for (const s of r.staleSeries) console.log(`  stale: ${s}`);
    console.log(`  verdict: ${r.verdict}\n`);
  }
  return ok;
}

// ---------- CLI ----------

function parseFlags(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseFlags(argv);
  const asJson = flags.json === true;
  const fresh = flags.fresh === true;

  if (!cmd || cmd === "help" || flags.help === true) {
    console.log(
      `usstats — query the ${configValue("site_name", "configured")} almanac\n\n` +
        `  list [--category <c>] [--limit N]\n  search <query>\n  get <key>\n` +
        `  trend <key> [--from Y] [--to Y]\n  movers [--window N] [--limit N]\n` +
        `  correlate <a> <b>\n  summary\n  sync-check\n\nFlags: --json · --fresh`
    );
    return;
  }

  const data = await loadDataset(fresh);
  const series = data.series;
  const keys = Object.keys(series).sort();

  const resolve = (k: string): string => {
    if (series[k]) return k;
    const ci = keys.find((x) => x.toLowerCase() === k.toLowerCase());
    if (ci) return ci;
    const partial = keys.filter(
      (x) => x.toLowerCase().includes(k.toLowerCase()) || series[x].name.toLowerCase().includes(k.toLowerCase())
    );
    if (partial.length === 1) return partial[0];
    throw new Error(
      partial.length > 1
        ? `Ambiguous key "${k}": ${partial.join(", ")}`
        : `Unknown series "${k}". Try: usstats search ${k}`
    );
  };

  switch (cmd) {
    case "summary": {
      const cats = new Map<string, number>();
      for (const s of Object.values(series)) cats.set(s.category, (cats.get(s.category) ?? 0) + 1);
      const out = {
        site: data._meta.site,
        generated: data._meta.generated ?? data.generated ?? null,
        seriesCount: data._meta.seriesCount,
        dataPoints: data._meta.dataPoints,
        license: data._meta.license,
        categories: Object.fromEntries([...cats.entries()].sort((a, b) => b[1] - a[1])),
      };
      if (asJson) console.log(JSON.stringify(out, null, 2));
      else {
        console.log(`${out.site} · ${out.seriesCount} series · ${out.dataPoints} data points · generated ${out.generated}`);
        for (const [c, n] of Object.entries(out.categories)) console.log(`  ${c}: ${n}`);
      }
      break;
    }

    case "list": {
      const cat = typeof flags.category === "string" ? flags.category.toLowerCase() : null;
      const limit = flags.limit ? Number(flags.limit) : Infinity;
      const rows = keys
        .filter((k) => !cat || series[k].category.toLowerCase().includes(cat))
        .slice(0, limit)
        .map((k) => ({
          key: k,
          name: series[k].name,
          category: series[k].category,
          unit: series[k].unit,
          coverage: `${series[k].coverage.first}–${series[k].coverage.last}`,
          goodDirection: series[k].goodDirection,
        }));
      if (asJson) console.log(JSON.stringify(rows, null, 2));
      else for (const r of rows) console.log(`${r.key.padEnd(24)} ${r.name} [${r.category}] ${r.coverage} (good: ${r.goodDirection ?? "n/a"})`);
      break;
    }

    case "search": {
      const q = rest.join(" ").toLowerCase();
      if (!q) throw new Error("search needs a query");
      const hits = keys.filter((k) => {
        const s = series[k];
        return [k, s.name, s.category, s.unit, s.source].some((f) => f.toLowerCase().includes(q));
      });
      if (asJson) console.log(JSON.stringify(hits.map((k) => ({ key: k, name: series[k].name, category: series[k].category })), null, 2));
      else if (!hits.length) console.log(`No series matching "${q}"`);
      else for (const k of hits) console.log(`${k.padEnd(24)} ${series[k].name} [${series[k].category}]`);
      break;
    }

    case "get": {
      const k = resolve(rest[0] ?? "");
      const s = series[k];
      if (asJson) {
        console.log(JSON.stringify({ key: k, ...s }, null, 2));
        break;
      }
      console.log(`${s.name} (${k})`);
      console.log(`  category: ${s.category} · unit: ${s.unit} · good direction: ${s.goodDirection ?? "n/a"}`);
      console.log(`  coverage: ${s.coverage.first}–${s.coverage.last} (${s.coverage.points} points)${partialNote(s)}`);
      console.log(`  source: ${s.source} — ${s.sourceUrl}`);
      if (s.note) console.log(`  note: ${s.note}`);
      const pts = Object.entries(s.data).sort((a, b) => Number(a[0]) - Number(b[0]));
      for (const [y, v] of pts) console.log(`  ${y}: ${fmtNum(v)}${Number(y) === s.partialYear ? "  ← YTD" : ""}`);
      break;
    }

    case "trend": {
      const k = resolve(rest[0] ?? "");
      const s = series[k];
      const t = computeTrend(s, flags.from ? Number(flags.from) : undefined, flags.to ? Number(flags.to) : undefined);
      if (!t) throw new Error(`Not enough annual data for a trend on "${k}"`);
      const out = { key: k, name: s.name, unit: s.unit, goodDirection: s.goodDirection, ...t, note: s.note ?? null };
      if (asJson) console.log(JSON.stringify(out, null, 2));
      else {
        console.log(`${s.name} (${k}) — ${t.startYear}→${t.endYear}${partialNote(s)}`);
        console.log(`  ${fmtNum(t.startValue)} → ${fmtNum(t.endValue)} ${s.unit}`);
        console.log(`  change: ${fmtNum(t.change)} (${fmtPct(t.pctChange)}) · CAGR: ${fmtPct(t.cagr)}`);
        console.log(`  verdict: ${t.verdict.toUpperCase()} (good direction: ${s.goodDirection ?? "n/a"})`);
        if (s.note) console.log(`  note: ${s.note}`);
      }
      break;
    }

    case "movers": {
      const windowYears = flags.window ? Number(flags.window) : 10;
      const limit = flags.limit ? Number(flags.limit) : 10;
      const scored = keys
        .map((k) => ({ key: k, s: series[k], m: moverScore(series[k], windowYears) }))
        .filter((x): x is { key: string; s: Series; m: NonNullable<ReturnType<typeof moverScore>> } => x.m !== null)
        .sort((a, b) => b.m.score - a.m.score);
      const shape = (x: (typeof scored)[number]) => ({
        key: x.key,
        name: x.s.name,
        window: `${x.m.trend.startYear}–${x.m.trend.endYear}`,
        from: x.m.trend.startValue,
        to: x.m.trend.endValue,
        unit: x.s.unit,
        directionAwarePct: x.m.score,
      });
      const improving = scored.filter((x) => x.m.score > 0).slice(0, limit).map(shape);
      const worsening = scored.filter((x) => x.m.score < 0).slice(-limit).reverse().map(shape);
      if (asJson) console.log(JSON.stringify({ windowYears, improving, worsening }, null, 2));
      else {
        console.log(`Direction-aware movers, trailing ~${windowYears}y (partial years excluded)\n\nIMPROVING`);
        for (const r of improving) console.log(`  ${fmtPct(r.directionAwarePct).padStart(8)}  ${r.name} (${r.key}) ${r.window}: ${fmtNum(r.from)} → ${fmtNum(r.to)}`);
        console.log(`\nWORSENING`);
        for (const r of worsening) console.log(`  ${fmtPct(r.directionAwarePct).padStart(8)}  ${r.name} (${r.key}) ${r.window}: ${fmtNum(r.from)} → ${fmtNum(r.to)}`);
      }
      break;
    }

    case "correlate": {
      const a = resolve(rest[0] ?? "");
      const b = resolve(rest[1] ?? "");
      const p = pearson(series[a], series[b]);
      if (!p) throw new Error(`Fewer than 3 overlapping annual years between "${a}" and "${b}"`);
      const out = { a, b, aName: series[a].name, bName: series[b].name, ...p };
      if (asJson) console.log(JSON.stringify(out, null, 2));
      else {
        console.log(`${series[a].name} × ${series[b].name}`);
        console.log(`  r = ${p.r.toFixed(3)} over ${p.n} overlapping years (${p.firstYear}–${p.lastYear})`);
        console.log(`  ⚠️ correlation, not causation; check each series' note for methodology breaks`);
      }
      break;
    }

    case "sync-check":
      // Exit 1 unless every upstream was reached and compared fresh: STALE, unreachable and unknown all fail.
      if (!(await syncCheck(data, asJson))) process.exitCode = 1;
      break;

    default:
      throw new Error(`Unknown command "${cmd}" — run with no args for usage`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`Error: ${e.message ?? e}`);
    process.exit(1);
  });
}
