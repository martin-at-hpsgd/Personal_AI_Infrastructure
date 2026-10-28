#!/usr/bin/env bun
/**
 * UpdateSubstrateMetrics.ts
 *
 * Fetches current data from all sources (FRED, EIA, Treasury) and updates
 * the US-Common-Metrics dataset files.
 *
 * Usage:
 *   bun run UpdateSubstrateMetrics.ts [--dry-run]
 *
 * Environment:
 *   FRED_API_KEY        - Required for most metrics
 *   EIA_API_KEY         - Required for gas prices
 *   USMETRICS_DATA_DIR  - Optional. Directory holding the US-Common-Metrics
 *                         dataset. Defaults to DATA/US-Common-Metrics in
 *                         this install's USER tree ($LIFEOS_USER_DIR, else
 *                         <config root>/LIFEOS/USER; ~/.claude by default)
 *
 * Output files (inside the data directory):
 *   - US-Common-Metrics.md      (updated values)
 *   - us-metrics-current.csv    (current snapshot)
 *   - us-metrics-historical.csv (appended)
 */

import { parseArgs } from "util";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { configValue, CONFIG_PATH } from "./UsStatsConfig.ts";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";

// ============================================================================
// CONFIGURATION
// ============================================================================

// Where the US-Common-Metrics dataset lives. Override with USMETRICS_DATA_DIR;
// otherwise fall back to this install's USER tree (a relocated LIFEOS_USER_DIR,
// else the config root getClaudeDir() resolves, CLAUDE_CONFIG_DIR included), so
// an isolated install never reads or writes the default install's dataset.
const DATA_DIR = process.env.USMETRICS_DATA_DIR
  || join(process.env.LIFEOS_USER_DIR || join(getClaudeDir(), "LIFEOS", "USER"), "DATA", "US-Common-Metrics");
const FRED_API_KEY = process.env.FRED_API_KEY;
const EIA_API_KEY = process.env.EIA_API_KEY;

// All metrics with their configuration
export interface MetricConfig {
  name: string;
  category: string;
  fredId?: string;
  source: string;
  format: "number" | "percent" | "currency" | "billions" | "trillions" | "thousands" | "millions" | "index";
  decimals?: number;
  special?: "eia-gas" | "eia-oil" | "treasury-debt" | "yoy-calc";
  baseId?: string; // For calculated metrics (YoY change)
  /** FRED reports the series in a smaller unit than `format` displays; the raw value is divided by this to display it (millions to trillions: 1e6). */
  scale?: number;
}

export const METRICS: Record<string, MetricConfig> = {
  // Economic Output & Growth
  "GDPC1": { name: "Real GDP", category: "Economic Output", fredId: "GDPC1", source: "BEA/FRED", format: "billions", decimals: 2 },
  "GDP": { name: "Nominal GDP", category: "Economic Output", fredId: "GDP", source: "BEA/FRED", format: "billions", decimals: 2 },
  "A191RL1Q225SBEA": { name: "GDP Growth Rate (QoQ)", category: "Economic Output", fredId: "A191RL1Q225SBEA", source: "BEA/FRED", format: "percent", decimals: 1 },
  "A191RO1Q156NBEA": { name: "GDP Growth Rate (YoY)", category: "Economic Output", fredId: "A191RO1Q156NBEA", source: "BEA/FRED", format: "percent", decimals: 1 },
  "INDPRO": { name: "Industrial Production", category: "Economic Output", fredId: "INDPRO", source: "Fed/FRED", format: "index", decimals: 2 },
  "TCU": { name: "Capacity Utilization", category: "Economic Output", fredId: "TCU", source: "Fed/FRED", format: "percent", decimals: 1 },
  "DGORDER": { name: "Durable Goods Orders", category: "Economic Output", fredId: "DGORDER", source: "Census/FRED", format: "millions", decimals: 0 },
  "RSAFS": { name: "Retail Sales", category: "Economic Output", fredId: "RSAFS", source: "Census/FRED", format: "billions", decimals: 1, scale: 1e3 }, // FRED: millions of dollars

  // Inflation & Prices
  "CPIAUCSL": { name: "CPI-U All Items", category: "Inflation", fredId: "CPIAUCSL", source: "BLS/FRED", format: "index", decimals: 3 },
  "CPILFESL": { name: "Core CPI", category: "Inflation", fredId: "CPILFESL", source: "BLS/FRED", format: "index", decimals: 3 },
  "PCEPI": { name: "PCE Price Index", category: "Inflation", fredId: "PCEPI", source: "BEA/FRED", format: "index", decimals: 3 },
  "PCEPILFE": { name: "Core PCE", category: "Inflation", fredId: "PCEPILFE", source: "BEA/FRED", format: "index", decimals: 3 },
  "PPIACO": { name: "Producer Price Index", category: "Inflation", fredId: "PPIACO", source: "BLS/FRED", format: "index", decimals: 2 },
  "DCOILWTICO": { name: "WTI Crude Oil", category: "Inflation", fredId: "DCOILWTICO", source: "EIA/FRED", format: "currency", decimals: 2 },
  "GAS_PRICE": { name: "Gas Price (Regular)", category: "Inflation", source: "EIA", format: "currency", decimals: 3, special: "eia-gas" },

  // Employment & Labor
  "UNRATE": { name: "Unemployment Rate (U-3)", category: "Employment", fredId: "UNRATE", source: "BLS/FRED", format: "percent", decimals: 1 },
  "U6RATE": { name: "Underemployment Rate (U-6)", category: "Employment", fredId: "U6RATE", source: "BLS/FRED", format: "percent", decimals: 1 },
  "PAYEMS": { name: "Nonfarm Payrolls", category: "Employment", fredId: "PAYEMS", source: "BLS/FRED", format: "thousands", decimals: 0 },
  "ICSA": { name: "Initial Jobless Claims", category: "Employment", fredId: "ICSA", source: "DOL/FRED", format: "thousands", decimals: 0, scale: 1e3 }, // FRED: a plain count of claims
  "CCSA": { name: "Continuing Claims", category: "Employment", fredId: "CCSA", source: "DOL/FRED", format: "thousands", decimals: 0, scale: 1e3 },
  "JTSJOL": { name: "Job Openings (JOLTS)", category: "Employment", fredId: "JTSJOL", source: "BLS/FRED", format: "thousands", decimals: 0 },
  "JTSQUR": { name: "Quit Rate", category: "Employment", fredId: "JTSQUR", source: "BLS/FRED", format: "percent", decimals: 1 },
  "JTSHIR": { name: "Hire Rate", category: "Employment", fredId: "JTSHIR", source: "BLS/FRED", format: "percent", decimals: 1 },
  "CIVPART": { name: "Labor Force Participation", category: "Employment", fredId: "CIVPART", source: "BLS/FRED", format: "percent", decimals: 1 },
  "EMRATIO": { name: "Employment-Population Ratio", category: "Employment", fredId: "EMRATIO", source: "BLS/FRED", format: "percent", decimals: 1 },
  "CES0500000003": { name: "Average Hourly Earnings", category: "Employment", fredId: "CES0500000003", source: "BLS/FRED", format: "currency", decimals: 2 },
  "AWHAETP": { name: "Average Weekly Hours", category: "Employment", fredId: "AWHAETP", source: "BLS/FRED", format: "number", decimals: 1 },

  // Housing
  "MSPUS": { name: "Median Home Sales Price", category: "Housing", fredId: "MSPUS", source: "Census/FRED", format: "currency", decimals: 0 },
  "CSUSHPINSA": { name: "Case-Shiller Index", category: "Housing", fredId: "CSUSHPINSA", source: "S&P/FRED", format: "index", decimals: 2 },
  "EXHOSLUSM495S": { name: "Existing Home Sales", category: "Housing", fredId: "EXHOSLUSM495S", source: "NAR/FRED", format: "thousands", decimals: 0 },
  "HSN1F": { name: "New Home Sales", category: "Housing", fredId: "HSN1F", source: "Census/FRED", format: "thousands", decimals: 0 },
  "HOUST": { name: "Housing Starts", category: "Housing", fredId: "HOUST", source: "Census/FRED", format: "thousands", decimals: 0 },
  "PERMIT": { name: "Building Permits", category: "Housing", fredId: "PERMIT", source: "Census/FRED", format: "thousands", decimals: 0 },
  "MORTGAGE30US": { name: "30-Year Mortgage Rate", category: "Housing", fredId: "MORTGAGE30US", source: "Freddie Mac/FRED", format: "percent", decimals: 2 },
  "MORTGAGE15US": { name: "15-Year Mortgage Rate", category: "Housing", fredId: "MORTGAGE15US", source: "Freddie Mac/FRED", format: "percent", decimals: 2 },

  // Consumer & Personal Finance
  "UMCSENT": { name: "Consumer Sentiment", category: "Consumer", fredId: "UMCSENT", source: "UMich/FRED", format: "index", decimals: 1 },
  "PI": { name: "Personal Income", category: "Consumer", fredId: "PI", source: "BEA/FRED", format: "billions", decimals: 1 },
  "DSPI": { name: "Disposable Personal Income", category: "Consumer", fredId: "DSPI", source: "BEA/FRED", format: "billions", decimals: 1 },
  "PSAVERT": { name: "Personal Saving Rate", category: "Consumer", fredId: "PSAVERT", source: "BEA/FRED", format: "percent", decimals: 1 },
  "TOTALSL": { name: "Consumer Credit Outstanding", category: "Consumer", fredId: "TOTALSL", source: "Fed/FRED", format: "billions", decimals: 1, scale: 1e3 }, // FRED: millions of dollars
  "DRCCLACBS": { name: "Credit Card Delinquency", category: "Consumer", fredId: "DRCCLACBS", source: "Fed/FRED", format: "percent", decimals: 2 },
  "TDSP": { name: "Debt Service Ratio", category: "Consumer", fredId: "TDSP", source: "Fed/FRED", format: "percent", decimals: 2 },
  "TOTALSA": { name: "Auto Sales", category: "Consumer", fredId: "TOTALSA", source: "BEA/FRED", format: "millions", decimals: 2 },

  // Financial Markets
  "FEDFUNDS": { name: "Fed Funds Rate", category: "Financial", fredId: "FEDFUNDS", source: "Fed/FRED", format: "percent", decimals: 2 },
  "DFEDTARU": { name: "Fed Funds Target (Upper)", category: "Financial", fredId: "DFEDTARU", source: "Fed/FRED", format: "percent", decimals: 2 },
  "DGS10": { name: "10-Year Treasury", category: "Financial", fredId: "DGS10", source: "Treasury/FRED", format: "percent", decimals: 2 },
  "DGS2": { name: "2-Year Treasury", category: "Financial", fredId: "DGS2", source: "Treasury/FRED", format: "percent", decimals: 2 },
  "T10Y2Y": { name: "10Y-2Y Spread", category: "Financial", fredId: "T10Y2Y", source: "FRED", format: "percent", decimals: 2 },
  "DGS30": { name: "30-Year Treasury", category: "Financial", fredId: "DGS30", source: "Treasury/FRED", format: "percent", decimals: 2 },
  "DTB3": { name: "3-Month T-Bill", category: "Financial", fredId: "DTB3", source: "Treasury/FRED", format: "percent", decimals: 2 },
  "STLFSI4": { name: "Financial Stress Index", category: "Financial", fredId: "STLFSI4", source: "StL Fed/FRED", format: "index", decimals: 3 },
  "SP500": { name: "S&P 500", category: "Financial", fredId: "SP500", source: "S&P/FRED", format: "number", decimals: 2 },
  "VIXCLS": { name: "VIX", category: "Financial", fredId: "VIXCLS", source: "CBOE/FRED", format: "index", decimals: 2 },

  // Trade & International
  "BOPGSTB": { name: "Trade Balance", category: "Trade", fredId: "BOPGSTB", source: "Census/BEA/FRED", format: "billions", decimals: 1, scale: 1e3 }, // FRED: millions of dollars
  "BOPGEXP": { name: "Exports", category: "Trade", fredId: "BOPGEXP", source: "Census/FRED", format: "billions", decimals: 1, scale: 1e3 },
  "BOPGIMP": { name: "Imports", category: "Trade", fredId: "BOPGIMP", source: "Census/FRED", format: "billions", decimals: 1, scale: 1e3 },
  "DTWEXBGS": { name: "USD Index", category: "Trade", fredId: "DTWEXBGS", source: "Fed/FRED", format: "index", decimals: 2 },
  "DEXUSEU": { name: "USD/EUR", category: "Trade", fredId: "DEXUSEU", source: "Fed/FRED", format: "number", decimals: 4 },

  // Government & Fiscal
  "GFDEBTN": { name: "Federal Debt Total", category: "Fiscal", fredId: "GFDEBTN", source: "Treasury/FRED", format: "trillions", decimals: 3, scale: 1e6 }, // FRED: millions of dollars
  "GFDEGDQ188S": { name: "Debt-to-GDP Ratio", category: "Fiscal", fredId: "GFDEGDQ188S", source: "FRED", format: "percent", decimals: 1 },
  "FGRECPT": { name: "Federal Receipts", category: "Fiscal", fredId: "FGRECPT", source: "Treasury/FRED", format: "billions", decimals: 1 },
  "FGEXPND": { name: "Federal Expenditures", category: "Fiscal", fredId: "FGEXPND", source: "Treasury/FRED", format: "billions", decimals: 1 },
  "TREASURY_DEBT": { name: "Total Public Debt", category: "Fiscal", source: "Treasury", format: "trillions", decimals: 3, special: "treasury-debt" },

  // Demographics
  "POPTHM": { name: "US Population", category: "Demographics", fredId: "POPTHM", source: "Census/FRED", format: "millions", decimals: 1, scale: 1e3 }, // FRED: thousands of persons
  "SIPOVGINIUSA": { name: "GINI Index", category: "Demographics", fredId: "SIPOVGINIUSA", source: "Census/FRED", format: "number", decimals: 3 },
  "MEHOINUSA672N": { name: "Median Household Income", category: "Demographics", fredId: "MEHOINUSA672N", source: "Census/FRED", format: "currency", decimals: 0 },
};

// ============================================================================
// DATA FETCHING
// ============================================================================

export interface FetchResult {
  id: string;
  name: string;
  value: number;
  formattedValue: string;
  period: string;
  updated: string;
  source: string;
}

async function fetchFredSeries(seriesId: string): Promise<{ value: number; date: string } | null> {
  if (!FRED_API_KEY) {
    console.error("FRED_API_KEY not set");
    return null;
  }

  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`;

  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    const obs = data.observations?.[0];
    if (!obs || obs.value === ".") return null;

    return { value: parseFloat(obs.value), date: obs.date };
  } catch (e) {
    console.error(`Error fetching FRED ${seriesId}:`, e);
    return null;
  }
}

async function fetchEIAGasPrice(): Promise<{ value: number; date: string } | null> {
  if (!EIA_API_KEY) {
    console.error("EIA_API_KEY not set - skipping gas prices");
    return null;
  }

  const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${EIA_API_KEY}&frequency=weekly&data[0]=value&facets[product][]=EPMR&facets[duoarea][]=NUS&sort[0][column]=period&sort[0][direction]=desc&length=1`;

  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    const item = data.response?.data?.[0];
    if (!item) return null;

    return { value: parseFloat(item.value), date: item.period };
  } catch (e) {
    console.error("Error fetching EIA gas price:", e);
    return null;
  }
}

async function fetchTreasuryDebt(): Promise<{ value: number; date: string } | null> {
  const url = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page[size]=1";

  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    const item = data.data?.[0];
    if (!item) return null;

    // Value is in dollars, convert to trillions
    const valueInTrillions = parseFloat(item.tot_pub_debt_out_amt) / 1e12;
    return { value: valueInTrillions, date: item.record_date };
  } catch (e) {
    console.error("Error fetching Treasury debt:", e);
    return null;
  }
}

export function formatValue(raw: number, config: MetricConfig): string {
  const decimals = config.decimals ?? 2;
  const value = raw / (config.scale ?? 1); // the stored value stays FRED's own unit; only the display is scaled

  switch (config.format) {
    case "percent":
      return `${value.toFixed(decimals)}%`;
    case "currency":
      return `$${value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
    case "billions":
      return `$${value.toFixed(decimals)}B`;
    case "trillions":
      return `$${value.toFixed(decimals)}T`;
    case "thousands":
      return `${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}K`;
    case "millions":
      return `${value.toFixed(decimals)}M`;
    case "index":
      return value.toFixed(decimals);
    case "number":
    default:
      return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
}

async function fetchAllMetrics(): Promise<{ results: Map<string, FetchResult>; failed: string[] }> {
  const results = new Map<string, FetchResult>();
  const errors: string[] = [];

  console.log("Fetching metrics from APIs...\n");

  for (const [id, config] of Object.entries(METRICS)) {
    let data: { value: number; date: string } | null = null;

    // Handle special fetches
    if (config.special === "eia-gas") {
      console.log(`  [EIA] ${config.name}...`);
      data = await fetchEIAGasPrice();
    } else if (config.special === "treasury-debt") {
      console.log(`  [Treasury] ${config.name}...`);
      data = await fetchTreasuryDebt();
    } else if (config.fredId) {
      console.log(`  [FRED] ${config.name} (${config.fredId})...`);
      data = await fetchFredSeries(config.fredId);
    }

    if (data) {
      results.set(id, {
        id,
        name: config.name,
        value: data.value,
        formattedValue: formatValue(data.value, config),
        period: data.date,
        updated: new Date().toISOString().split("T")[0],
        source: config.source,
      });
      console.log(`    ✓ ${formatValue(data.value, config)} (${data.date})`);
    } else {
      errors.push(id);
      console.log(`    ✗ Failed`);
    }

    // Small delay to be nice to APIs
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`\nFetched ${results.size}/${Object.keys(METRICS).length} metrics`);
  if (errors.length > 0) {
    console.log(`Failed: ${errors.join(", ")}`);
  }

  return { results, failed: errors };
}

// ============================================================================
// FILE UPDATES
// ============================================================================

function updateMarkdownFile(results: Map<string, FetchResult>, failed: string[]): string {
  const mdPath = join(DATA_DIR, "US-Common-Metrics.md");
  const today = new Date().toISOString().split("T")[0];
  return renderMarkdown(readFileSync(mdPath, "utf-8"), results, today, failed);
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rewrites the dataset markdown in place: the Last Updated line, the Quick
 * Reference Dashboard, and the Value and Updated cells of each metric row.
 *
 * Every replacement uses a function replacer. A formatted value such as
 * "$24408.01B" passed as a replacement STRING is read as the group pattern "$2",
 * which spliced old dashboard text back in on every run (a seeded file once
 * carried stacked copies of the corruption). Rows are matched
 * by metric id whatever value they hold, so a seeded file with real values is
 * refreshed, not only rows still showing "--".
 */
export function renderMarkdown(source: string, results: Map<string, FetchResult>, today: string, failed: string[] = []): string {
  let content = source.replace(/\*\*Last Updated:\*\* .*/, () => `**Last Updated:** ${today}`);

  // Update Quick Reference Dashboard
  const dashboardUpdates: Record<string, { key: string; trend: string }> = {
    "Economy": { key: "A191RL1Q225SBEA", trend: "--" },
    "Inflation": { key: "CPIAUCSL", trend: "--" },
    "Employment": { key: "UNRATE", trend: "--" },
    "Housing": { key: "MORTGAGE30US", trend: "--" },
    "Markets": { key: "FEDFUNDS", trend: "--" },
    "Consumer": { key: "UMCSENT", trend: "--" },
    "Fiscal": { key: "TREASURY_DEBT", trend: "--" },
    "Energy": { key: "GAS_PRICE", trend: "--" },
  };

  let newDashboard = "";
  for (const [cat, info] of Object.entries(dashboardUpdates)) {
    const result = results.get(info.key);
    const metricName = result?.name || METRICS[info.key]?.name || info.key;
    const value = result?.formattedValue || "--";
    const updated = result?.updated || "--";
    const trend = result ? "→" : info.trend; // a real trend needs history; "→" marks a fresh value
    newDashboard += `| ${cat} | ${metricName} | ${value} | ${updated} | ${trend} |\n`;
  }

  // The dashboard runs from its header to the "*Values updated automatically" line.
  // Matching to that exact line (when present) also sweeps out any debris an older
  // run left between them; files with other wording fall back to the first
  // "*Values updated" line.
  const header = "(\\| Category \\| Key Metric \\| Value \\| Updated \\| Trend \\|\\n\\|[^\\n]+\\n)([\\s\\S]*?)";
  const exact = new RegExp(header + "(\\n\\*Values updated automatically)");
  const loose = new RegExp(header + "(\\n\\*Values updated)");
  const dashboardRegex = exact.test(content) ? exact : loose;
  content = content.replace(dashboardRegex, (_m, head: string, _old: string, tail: string) => head + newDashboard + tail);

  content = repairMetricRows(content);

  // Update individual metric tables: | Metric | value | period | updated | source | ID |
  // The Period cell is rewritten with the observation date of the new value, so a fresh value never sits beside the
  // previous run's period. A table whose third column is something else (Frequency) keeps its cell.
  const rowFor = (id: string): RegExp | null => {
    const config = METRICS[id];
    if (!config?.fredId && !config?.special) return null;
    const idPattern = escapeRegex(config.fredId || id);
    return new RegExp(
      `(\\|[^|\\n]+\\| )([^|\\n]*?)( \\|)([^|\\n]+)(\\| )([^|\\n]*?)( \\|[^|\\n]+\\| ${idPattern} *\\|)`,
      "g"
    );
  };
  const periodColumn = (whole: string, offset: number): boolean => {
    const headerAt = whole.lastIndexOf("\n| Metric |", offset);
    return headerAt >= 0 && /^\| Metric \| Value \| Period \|/.test(whole.slice(headerAt + 1, whole.indexOf("\n", headerAt + 1)));
  };
  for (const [id, result] of results) {
    const rowRegex = rowFor(id);
    if (!rowRegex) continue;
    content = content.replace(rowRegex, (_m, a: string, _v: string, b1: string, p: string, b2: string, _u: string, c: string, offset: number, whole: string) =>
      a + result.formattedValue + b1 + (periodColumn(whole, offset) ? ` ${result.period} ` : p) + b2 + result.updated + c);
  }

  // A metric that failed this run keeps its old value but is marked, so a partial update never reads as current.
  for (const id of failed) {
    if (results.has(id)) continue;
    const rowRegex = rowFor(id);
    if (!rowRegex) continue;
    content = content.replace(rowRegex, (_m, a: string, v: string, b1: string, p: string, b2: string, u: string, c: string) => {
      const value = v.replace(/ \(stale\)$/, "");
      return a + (value.trim() === "" || value.trim() === "--" ? value : `${value} (stale)`) + b1 + p + b2 + u + c;
    });
  }

  return content;
}

/**
 * Collapses a metric row that carries more cells than its table header back to
 * the header's width: the metric name plus the trailing cells (value, period,
 * updated, source, id). The old string-replacer bug spliced stray cells into rows
 * such as "| Real GDP |  | Q3 2024 | $23770.98B | Q3 2024 | ... | GDPC1 |", and the
 * public seed dataset carried several of them (counted 2026-10-10).
 */
export function repairMetricRows(content: string): string {
  const cells = (line: string): string[] => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  let width = 0;
  return content
    .split("\n")
    .map((line) => {
      if (!line.startsWith("|")) { width = 0; return line; }
      if (/^\| Metric \| Value \|/.test(line)) { width = cells(line).length; return line; }
      if (width === 0) return line;
      const row = cells(line);
      if (row.length <= width) return line;
      return `| ${[row[0], ...row.slice(row.length - (width - 1))].join(" | ")} |`;
    })
    .join("\n");
}

function generateCurrentCSV(results: Map<string, FetchResult>): string {
  const lines = ["metric_id,metric_name,value,formatted_value,period,updated,source"];

  for (const [id, result] of results) {
    const line = [
      id,
      `"${result.name}"`,
      result.value,
      `"${result.formattedValue}"`,
      result.period,
      result.updated,
      `"${result.source}"`,
    ].join(",");
    lines.push(line);
  }

  return lines.join("\n") + "\n";
}

function generateHistoricalCSV(results: Map<string, FetchResult>): string {
  const timestamp = new Date().toISOString();
  const lines: string[] = [];

  for (const [id, result] of results) {
    lines.push(`${timestamp},${id},${result.value},${result.period}`);
  }

  return lines.join("\n") + "\n";
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
UpdateSubstrateMetrics.ts - Update the local US-Common-Metrics dataset

Usage:
  bun run UpdateSubstrateMetrics.ts [--dry-run]

Options:
  --dry-run    Fetch data but don't write files
  -h, --help   Show this help

Environment:
  FRED_API_KEY        Required for most metrics
  EIA_API_KEY         Required for gas prices
  USMETRICS_DATA_DIR  Optional. Dataset directory. Defaults to
                      ${DATA_DIR}

Output (inside the dataset directory):
    - US-Common-Metrics.md (updated)
    - us-metrics-current.csv (current snapshot)
    - us-metrics-historical.csv (appended)
`);
    process.exit(0);
  }

  // Check API keys
  if (!FRED_API_KEY) {
    console.error("Error: FRED_API_KEY environment variable not set");
    console.error("Get your free key at: https://fred.stlouisfed.org/docs/api/api_key.html");
    process.exit(1);
  }

  // Verify the dataset directory exists
  if (!existsSync(DATA_DIR)) {
    console.error(`Error: US-Common-Metrics data directory not found: ${DATA_DIR}`);
    console.error("");
    console.error("Fix it either way:");
    console.error(`  - Create it:  mkdir -p "${DATA_DIR}"`);
    console.error("  - Or point at an existing dataset:");
    console.error("      USMETRICS_DATA_DIR=/path/to/US-Common-Metrics bun run UpdateSubstrateMetrics.ts");
    console.error("");
    console.error("It must contain (or will be populated with) US-Common-Metrics.md,");
    console.error("us-metrics-current.csv, and us-metrics-historical.csv.");
    process.exit(1);
  }

  // The updater rewrites US-Common-Metrics.md in place and never invents the
  // dataset, so a directory without it is a seeding gap, reported before any fetch.
  const masterPath = join(DATA_DIR, "US-Common-Metrics.md");
  if (!existsSync(masterPath)) {
    console.error(`Error: dataset not seeded: ${masterPath} is missing`);
    console.error(`Seed the directory from ${configValue("seed_source", "a US-Common-Metrics seed dataset (set seed_source in " + CONFIG_PATH + ")")}:`);
    console.error("copy US-Common-Metrics.md, us-metrics-current.csv and us-metrics-historical.csv in,");
    console.error(`or point USMETRICS_DATA_DIR at ${configValue("seed_checkout_hint", "an existing US-Common-Metrics directory")}.`);
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log("US-Common-Metrics Update");
  console.log("=".repeat(60));
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log("");

  // Fetch all metrics
  const { results, failed } = await fetchAllMetrics();

  if (results.size === 0) {
    console.error("No metrics fetched successfully. Aborting.");
    process.exit(1);
  }

  // Generate updates
  console.log("\nGenerating file updates...");
  const updatedMd = updateMarkdownFile(results, failed);
  const currentCsv = generateCurrentCSV(results);
  const historicalCsv = generateHistoricalCSV(results);

  if (values["dry-run"]) {
    console.log("\n[DRY RUN] Would write:");
    console.log(`  - US-Common-Metrics.md (${updatedMd.length} bytes)`);
    console.log(`  - us-metrics-current.csv (${currentCsv.length} bytes)`);
    console.log(`  - us-metrics-historical.csv (append ${historicalCsv.length} bytes)`);
    console.log("\nSample CSV output:");
    console.log(currentCsv.split("\n").slice(0, 5).join("\n"));
    process.exit(0);
  }

  // Write files
  const mdPath = join(DATA_DIR, "US-Common-Metrics.md");
  const currentCsvPath = join(DATA_DIR, "us-metrics-current.csv");
  const historicalCsvPath = join(DATA_DIR, "us-metrics-historical.csv");

  console.log("\nWriting files...");

  writeFileSync(mdPath, updatedMd);
  console.log(`  ✓ ${mdPath}`);

  writeFileSync(currentCsvPath, currentCsv);
  console.log(`  ✓ ${currentCsvPath}`);

  // Append to historical (create header if new file)
  if (!existsSync(historicalCsvPath)) {
    writeFileSync(historicalCsvPath, "fetch_timestamp,metric_id,value,period\n");
  }
  appendFileSync(historicalCsvPath, historicalCsv);
  console.log(`  ✓ ${historicalCsvPath} (appended)`);

  console.log("\n" + "=".repeat(60));
  console.log(`Update complete. ${results.size} metrics updated.`);
  console.log("=".repeat(60));
}

if (import.meta.main) main();
