#!/usr/bin/env bun
/**
 * Wastewater — California wastewater pathogen surveillance from public open data.
 *
 *   bun Wastewater.ts covid  [--pathogen covid|flu|rsv] [--statewide] [--json] [--dry-run]
 *   bun Wastewater.ts panel  [--statewide] [--json] [--dry-run]
 *   bun Wastewater.ts config [--json]
 *   bun Wastewater.ts --help
 *
 * covid  CDC NWSS site Wastewater Viral Activity Levels (WVAL) for California sites,
 *        with CDC's own per-site category (Very Low .. Very High). Weekly, Fridays.
 * panel  CDPH sample-level concentrations from the CHHS Open Data Portal, one row per
 *        pathogen target, grouped by unit so copies/g and copies/L never average together.
 * config The region this run resolves to and where it was read from. No network.
 *
 * Region: Config.md in this skill's USER customization folder (see Setup.md), or the
 * file named by WASTEWATER_CONFIG. With neither, every command runs statewide.
 * Read-only: nothing is written anywhere. No account or key is needed.
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import { claudeDirFor } from "../../../LIFEOS/TOOLS/Paths.ts";

export const CDC_WVAL_URL = "https://data.cdc.gov/resource/atcp-73re.json";
export const CDPH_RESOURCE_ID = "2742b824-3736-4292-90a9-7fad98e94c06";
export const CDPH_SQL_URL = "https://data.chhs.ca.gov/api/3/action/datastore_search_sql";
export const CDPH_DATASET_URL = "https://data.chhs.ca.gov/dataset/wastewater-surveillance-data-california";
const DAY = 86_400_000;

/** CDPH `pcr_target` values and the names a person would say. */
export const TARGETS: Record<string, string> = {
  "sars-cov-2": "SARS-CoV-2",
  omicron: "SARS-CoV-2 Omicron",
  fluav: "Influenza A",
  "fluav h1": "Influenza A H1",
  "fluav h3": "Influenza A H3",
  "fluav h5": "Influenza A H5",
  flubv: "Influenza B",
  rsv: "RSV",
  "hmpxv clade ii": "Mpox clade II",
  hmpxv: "Mpox",
  "nov gii": "Norovirus GII",
  nvo: "Norovirus",
  caur: "Candida auris",
};
const CDC_PATHOGEN: Record<string, string> = { covid: "SARS-CoV-2", flu: "Influenza A", rsv: "RSV" };
export const WVAL_CATEGORIES = ["Very Low", "Low", "Moderate", "High", "Very High"];

// ---------- config ----------

export type County = { name: string; fips: string };
export type Region = { name: string; counties: County[]; rpho?: string; source: string };

/** The skill folder's own name, so the config path follows the folder through a rename. */
export const skillName = (): string => basename(resolve(import.meta.dir, ".."));

export function configPath(env = process.env): string {
  if (env.WASTEWATER_CONFIG) return env.WASTEWATER_CONFIG;
  const root = claudeDirFor(env, homedir());
  return join(root, "LIFEOS", "USER", "CUSTOMIZATIONS", "SKILLS", skillName(), "Config.md");
}

/**
 * Reads `- region: <name>`, the optional `- rpho region: <name>`, and `- counties: <Name> <5-digit FIPS>; <Name> <FIPS>; ...` lines.
 * Throws on a counties line that holds no valid FIPS code, so a typo never silently means statewide.
 */
export function parseConfig(text: string, source: string): Region {
  const field = (k: string) => text.match(new RegExp(`^\\s*[-*]\\s*${k}\\s*:\\s*(.+)$`, "im"))?.[1].trim();
  const counties: County[] = [];
  const raw = field("counties");
  if (raw) {
    for (const part of raw.split(";").map((s) => s.trim()).filter(Boolean)) {
      const m = part.match(/^(.*?)\s*\(?\b(06\d{3})\b\)?$/);
      if (!m) throw new Error(`${source}: county "${part}" needs a 5-digit California FIPS code (06xxx), e.g. "Sacramento 06067"`);
      counties.push({ name: m[1].trim() || m[2], fips: m[2] });
    }
  }
  return { name: field("region") ?? (counties.length ? "Configured counties" : "California statewide"), counties, rpho: field("rpho region"), source };
}

export function loadRegion(env = process.env): Region {
  const p = configPath(env);
  if (!existsSync(p)) {
    if (env.WASTEWATER_CONFIG) throw new Error(`WASTEWATER_CONFIG points at ${p}, which does not exist`);
    // Name the exact path looked for, so a Config.md saved in the wrong folder is obvious.
    return { name: "California statewide", counties: [], source: `none: no file at ${p}` };
  }
  return parseConfig(readFileSync(p, "utf8"), p);
}

const statewide = (r: Region): Region => ({ ...r, name: "California statewide", counties: [], rpho: "California" });

// ---------- CDC WVAL (covid) ----------

export type WvalRow = { counties_served?: string; site?: string; site_wval?: string; site_wval_category?: string; week_end?: string; population_served?: string; date_updated?: string };

const sq = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function wvalUrl(pathogen: string, region: Region, now = new Date()): string {
  const since = new Date(now.getTime() - 70 * DAY).toISOString().slice(0, 10);
  const parts = [`state_territory='California'`, `pathogen_target=${sq(pathogen)}`, `week_end >= ${sq(since)}`];
  if (region.counties.length) parts.push(`(${region.counties.map((c) => `counties_served like ${sq(`%${c.name}%`)}`).join(" OR ")})`);
  const q = new URLSearchParams({ $where: parts.join(" AND "), $order: "week_end DESC", $limit: "5000" });
  return `${CDC_WVAL_URL}?${q}`;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export type WvalSummary = {
  week: string | null;
  sites: number;
  medianWval: number | null;
  categories: Record<string, number>;
  mostCommon: string | null;
  highOrAbove: number;
  trend: { week: string; medianWval: number | null; sites: number }[];
  weekChange: number | null;
  direction: "rising" | "falling" | "stable" | "unknown";
  updated: string | null;
};

/** Groups site rows by reporting week; the latest week is the headline, earlier weeks the trend. */
export function summarizeWval(rows: WvalRow[]): WvalSummary {
  const byWeek = new Map<string, WvalRow[]>();
  for (const r of rows) {
    if (!r.week_end) continue;
    const wk = r.week_end.slice(0, 10);
    byWeek.set(wk, [...(byWeek.get(wk) ?? []), r]);
  }
  const weeks = [...byWeek.keys()].sort().reverse(); // ISO dates sort correctly as strings
  const vals = (rs: WvalRow[]) => rs.map((r) => Number(r.site_wval)).filter((v) => Number.isFinite(v));
  const trend = weeks.slice(0, 6).map((w) => ({ week: w, medianWval: median(vals(byWeek.get(w)!)), sites: byWeek.get(w)!.length }));
  const latest = weeks[0] ? byWeek.get(weeks[0])! : [];
  const categories: Record<string, number> = {};
  for (const r of latest) {
    const c = r.site_wval_category?.trim() || "No data";
    categories[c] = (categories[c] ?? 0) + 1;
  }
  const ranked = Object.entries(categories).filter(([c]) => WVAL_CATEGORIES.includes(c)).sort((a, b) => b[1] - a[1] || WVAL_CATEGORIES.indexOf(b[0]) - WVAL_CATEGORIES.indexOf(a[0]));
  const now = trend[0]?.medianWval ?? null;
  const prev = trend[1]?.medianWval ?? null;
  const weekChange = now !== null && prev !== null ? now - prev : null;
  const direction = weekChange === null ? "unknown" : Math.abs(weekChange) < 0.1 * Math.max(prev ?? 0, 1) ? "stable" : weekChange > 0 ? "rising" : "falling";
  return {
    week: weeks[0] ?? null,
    sites: latest.length,
    medianWval: now,
    categories,
    mostCommon: ranked[0]?.[0] ?? null,
    highOrAbove: (categories["High"] ?? 0) + (categories["Very High"] ?? 0),
    trend,
    weekChange,
    direction,
    updated: latest.map((r) => r.date_updated ?? "").sort().pop() || null,
  };
}

// ---------- CDPH panel ----------

export type WeekRow = { pcr_target: string; pcr_target_units: string; wk: string; avg_conc: number | string | null; n: number | string; latest: string };

export function panelSql(region: Region, now = new Date()): string {
  const since = new Date(now.getTime() - 365 * DAY).toISOString().slice(0, 10);
  const where = [
    `"sample_collect_date" >= ${sq(since)}`,
    `"pcr_target_avg_conc" IS NOT NULL`,
    // The portal refuses most SQL functions (coalesce included), so null checks stay explicit.
    `("qc_ignore" IS NULL OR "qc_ignore" <> 'yes')`,
    `("analysis_ignore" IS NULL OR "analysis_ignore" <> 'yes')`,
  ];
  if (region.counties.length) where.push(`(${region.counties.map((c) => `"county_names" LIKE ${sq(`%${c.fips}%`)}`).join(" OR ")})`);
  return (
    `SELECT "pcr_target", "pcr_target_units", date_trunc('week', "sample_collect_date") AS wk, ` +
    `avg("pcr_target_avg_conc"::float) AS avg_conc, count(*) AS n, max("sample_collect_date") AS latest ` +
    `FROM "${CDPH_RESOURCE_ID}" WHERE ${where.join(" AND ")} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`
  );
}

export const panelUrl = (region: Region, now = new Date()) => `${CDPH_SQL_URL}?sql=${encodeURIComponent(panelSql(region, now))}`;

export type PanelRow = {
  target: string;
  name: string;
  units: string;
  latestSample: string;
  level: number;
  priorLevel: number | null;
  changePct: number | null;
  direction: "rising" | "falling" | "stable" | "unknown";
  yearMin: number;
  yearMax: number;
  position: "low" | "middle" | "top";
  samples: number;
  /** Latest sample is more than 21 days behind the newest target in the panel. */
  stale: boolean;
};

/**
 * One row per pathogen target, using the unit with the most samples in the past year.
 * Level = mean of the two latest weekly means; prior = the two weeks before that.
 * Both windows are calendar-bound to the target's newest week (level within 14 days of it, prior
 * within 28), so a gap in reporting never lets a months-old week stand in for a recent one.
 * Position = where the level sits in the 12-month range of weekly means, in thirds.
 */
export function summarizePanel(rows: WeekRow[]): PanelRow[] {
  const groups = new Map<string, WeekRow[]>();
  for (const r of rows) {
    const k = `${r.pcr_target}\t${r.pcr_target_units ?? ""}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const best = new Map<string, WeekRow[]>();
  for (const [k, rs] of groups) {
    const target = k.split("\t")[0];
    const count = (xs: WeekRow[]) => xs.reduce((a, r) => a + Number(r.n), 0);
    if (!best.has(target) || count(rs) > count(best.get(target)!)) best.set(target, rs);
  }
  const out: PanelRow[] = [];
  for (const [target, rs] of best) {
    const weeks = rs.map((r) => ({ wk: String(r.wk).slice(0, 10), v: Number(r.avg_conc), n: Number(r.n), latest: String(r.latest).slice(0, 10) })).filter((w) => Number.isFinite(w.v)).sort((a, b) => (a.wk < b.wk ? 1 : -1));
    if (!weeks.length) continue;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const anchor = Date.parse(weeks[0].wk);
    const within = (days: number) => (w: { wk: string }) => anchor - Date.parse(w.wk) < days * DAY;
    const recent = weeks.slice(0, 2).filter(within(14));
    const before = weeks.slice(recent.length, recent.length + 2).filter(within(28));
    const level = mean(recent.map((w) => w.v));
    const prior = before.length ? mean(before.map((w) => w.v)) : null;
    const changePct = prior ? ((level - prior) / prior) * 100 : null;
    const all = weeks.map((w) => w.v);
    const yearMin = Math.min(...all);
    const yearMax = Math.max(...all);
    const frac = yearMax > yearMin ? (level - yearMin) / (yearMax - yearMin) : 0;
    out.push({
      target,
      name: TARGETS[target] ?? target,
      units: rs[0].pcr_target_units ?? "",
      latestSample: weeks.map((w) => w.latest).sort().pop()!,
      level,
      priorLevel: prior,
      changePct,
      direction: changePct === null ? "unknown" : Math.abs(changePct) < 10 ? "stable" : changePct > 0 ? "rising" : "falling",
      yearMin,
      yearMax,
      position: frac < 1 / 3 ? "low" : frac < 2 / 3 ? "middle" : "top",
      samples: recent.reduce((a, w) => a + w.n, 0),
      stale: false,
    });
  }
  const newest = out.map((r) => r.latestSample).sort().pop();
  for (const r of out) r.stale = !!newest && Date.parse(newest) - Date.parse(r.latestSample) > 21 * DAY;
  const order = Object.keys(TARGETS);
  return out.sort((a, b) => (order.indexOf(a.target) + 1 || 99) - (order.indexOf(b.target) + 1 || 99));
}

// ---------- CLI ----------

const HELP = `Wastewater — California wastewater pathogen surveillance (public data, read-only)

Usage:
  bun Wastewater.ts covid  [--pathogen covid|flu|rsv] [--statewide] [--json] [--dry-run]
  bun Wastewater.ts panel  [--statewide] [--json] [--dry-run]
  bun Wastewater.ts config [--json]
  bun Wastewater.ts --help

Commands:
  covid   CDC NWSS site viral activity levels (WVAL) and CDC's category per site,
          for the sites in your region (or all California sites with --statewide).
  panel   CDPH concentrations for every pathogen target in the past year: latest sample,
          two-week level, trend, 12-month position, sample count.
  config  The region this run resolves to and the file it came from. No network.

Flags:
  --statewide  Ignore the configured counties.
  --json       Machine-readable output on stdout.
  --dry-run    Print the request URL and exit without calling the network.

Region: ${"`- region:`"} and ${"`- counties:`"} lines in Config.md (see Setup.md), or WASTEWATER_CONFIG=<file>.
Exit codes: 0 ok, 1 network or data error, 2 bad arguments or config.`;

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    const msg = body.match(/"message":\s*"([^"]+)"/)?.[1];
    throw new Error(`${new URL(url).host} answered HTTP ${r.status}${msg ? `: ${msg}` : ""}`);
  }
  return r.json();
}

const fmt = (v: number) => (v >= 1e6 ? v.toExponential(2) : v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1));

async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const cmd = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--pathogen");
  if (flags.has("--help") || !cmd) {
    console.log(HELP);
    return cmd || flags.has("--help") ? 0 : 2;
  }
  const json = flags.has("--json");
  let region: Region;
  try {
    region = loadRegion();
  } catch (e) {
    console.error(`config error: ${(e as Error).message}`);
    return 2;
  }
  if (flags.has("--statewide")) region = statewide(region);

  if (cmd === "config") {
    if (json) console.log(JSON.stringify(region, null, 2));
    else {
      console.log(`Region:  ${region.name}`);
      console.log(`Source:  ${region.source}`);
      console.log(`Clinical region (RPHO): ${region.rpho ?? "not set"}`);
      console.log(`Counties: ${region.counties.length ? region.counties.map((c) => `${c.name} (${c.fips})`).join(", ") : "none, so every command runs statewide"}`);
    }
    return 0;
  }

  if (cmd === "covid") {
    const key = argv[argv.indexOf("--pathogen") + 1];
    const pathogen = flags.has("--pathogen") ? CDC_PATHOGEN[key] : CDC_PATHOGEN.covid;
    if (!pathogen) {
      console.error(`--pathogen must be one of: ${Object.keys(CDC_PATHOGEN).join(", ")}`);
      return 2;
    }
    const url = wvalUrl(pathogen, region);
    if (flags.has("--dry-run")) return console.log(url), 0;
    const s = summarizeWval(await getJson(url));
    // An empty pull is a data error in every mode, so a scheduled --json caller never stores it as a baseline.
    if (!s.week) {
      (json ? console.error : console.log)(`No ${pathogen} WVAL rows for ${region.name} in the past 10 weeks. Check the county names in Config.md against CDC's counties_served.`);
      return 1;
    }
    if (json) return console.log(JSON.stringify({ source: "CDC NWSS WVAL (data.cdc.gov atcp-73re)", pathogen, region: region.name, ...s }, null, 2)), 0;
    console.log(`${pathogen} wastewater viral activity — ${region.name}`);
    console.log(`Source: CDC NWSS WVAL, week ending ${s.week} (processed ${s.updated ?? "unknown"})`);
    console.log(`Sites reporting: ${s.sites} · median site WVAL ${s.medianWval?.toFixed(2) ?? "n/a"} · most common CDC level: ${s.mostCommon ?? "n/a"} · ${s.highOrAbove} site(s) High or Very High`);
    console.log(`Levels: ${Object.entries(s.categories).map(([c, n]) => `${c} ${n}`).join(", ")}`);
    console.log(`Week over week: ${s.direction}${s.weekChange !== null ? ` (${s.weekChange >= 0 ? "+" : ""}${s.weekChange.toFixed(2)} WVAL)` : ""}`);
    console.log(`Recent weeks (median WVAL): ${s.trend.map((t) => `${t.week} ${t.medianWval?.toFixed(2) ?? "n/a"}`).join(" · ")}`);
    return 0;
  }

  if (cmd === "panel") {
    const url = panelUrl(region);
    if (flags.has("--dry-run")) return console.log(url), 0;
    const res = await getJson(url);
    if (!res.success) throw new Error(`CHHS query failed: ${JSON.stringify(res.error).slice(0, 300)}`);
    const rows = summarizePanel(res.result.records);
    if (json) return console.log(JSON.stringify({ source: CDPH_DATASET_URL, region: region.name, counties: region.counties, rows }, null, 2)), 0;
    console.log(`California wastewater panel — ${region.name}`);
    console.log(`Source: CDPH via CHHS Open Data (${CDPH_DATASET_URL}), fetched ${new Date().toISOString().slice(0, 10)}`);
    console.log("Pathogen | Latest sample | 2-week level | 12-month position | Trend vs prior 2 weeks | Samples");
    for (const r of rows) {
      const trend = r.changePct === null ? "unknown" : `${r.direction} ${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(0)}%`;
      console.log(`${r.name} | ${r.latestSample}${r.stale ? " (stale)" : ""} | ${fmt(r.level)} ${r.units} | ${r.position} third (${fmt(r.yearMin)}–${fmt(r.yearMax)}) | ${trend} | ${r.samples}`);
    }
    return 0;
  }

  console.error(`unknown command "${cmd}"\n`);
  console.log(HELP);
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
