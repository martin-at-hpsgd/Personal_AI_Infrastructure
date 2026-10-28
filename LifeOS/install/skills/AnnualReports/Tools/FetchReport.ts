#!/usr/bin/env bun
/**
 * FetchReport.ts - Fetch and summarize a specific report
 *
 * Usage:
 *   bun run FetchReport.ts <vendor> <report-name>    # Fetch specific report
 *   bun run FetchReport.ts --url <url>               # Fetch by direct URL
 *   bun run FetchReport.ts --list-cached             # List downloaded reports
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { parse as parseYaml } from 'yaml';
import { lifeosPath } from '../../../LIFEOS/TOOLS/Paths.ts';

const CONFIG_PATH = lifeosPath('USER', 'CUSTOMIZATIONS', 'SKILLS', 'AnnualReports', 'Config.md');

/**
 * The honest client identity for every request: it names this tool and, when the install sets
 * `contact` in Config.md (first fenced yaml block), a contact address the site can reach.
 */
export function userAgent(configPath: string = CONFIG_PATH): string {
  let contact = '';
  try {
    if (existsSync(configPath)) {
      const block = /```ya?ml\s*\n([\s\S]*?)```/.exec(readFileSync(configPath, 'utf-8'))?.[1];
      const parsed = block ? (parseYaml(block) as Record<string, unknown> | null) : null;
      if (parsed && typeof parsed.contact === 'string') contact = parsed.contact.trim();
    }
  } catch {
    // An unreadable config means no contact; the request still declares the tool.
  }
  return contact ? `LifeOS-AnnualReports/1.0 (${contact})` : 'LifeOS-AnnualReports/1.0';
}

/** A fetched page, or the reason it is unavailable. */
type PageResult = { ok: true; html: string } | { ok: false; reason: string };

const SOURCES_PATH = join(import.meta.dir, '..', 'Data', 'sources.json');
const REPORTS_DIR = join(import.meta.dir, '..', 'Reports');

interface Report {
  vendor: string;
  name: string;
  url: string;
}

interface Sources {
  metadata: {
    source: string;
    lastUpdated: string;
    totalReports: number;
  };
  categories: {
    analysis: Record<string, Report[]>;
    survey: Record<string, Report[]>;
  };
}

function loadSources(): Sources {
  if (!existsSync(SOURCES_PATH)) {
    console.error(`No source catalog at ${SOURCES_PATH}. Run: bun run ${join(import.meta.dir, "UpdateSources.ts")}  (see Setup.md).`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(SOURCES_PATH, 'utf-8'));
}

function findReport(sources: Sources, vendor: string, reportName: string): Report | null {
  const normalizedVendor = vendor.toLowerCase();
  const normalizedName = reportName.toLowerCase();

  // Search analysis reports
  for (const reports of Object.values(sources.categories.analysis)) {
    for (const report of reports) {
      if (
        report.vendor.toLowerCase().includes(normalizedVendor) &&
        report.name.toLowerCase().includes(normalizedName)
      ) {
        return report;
      }
    }
  }

  // Search survey reports
  for (const reports of Object.values(sources.categories.survey)) {
    for (const report of reports) {
      if (
        report.vendor.toLowerCase().includes(normalizedVendor) &&
        report.name.toLowerCase().includes(normalizedName)
      ) {
        return report;
      }
    }
  }

  return null;
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase();
}

async function fetchReportPage(url: string): Promise<PageResult> {
  console.log(`📥 Fetching: ${url}`);

  try {
    const response = await fetch(url, { headers: { 'User-Agent': userAgent() } });

    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status} ${response.statusText}`.trim() };
    }

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/pdf')) {
      return { ok: false, reason: 'the URL is a PDF; download it from the URL yourself' };
    }

    return { ok: true, html: await response.text() };
  } catch (error) {
    return { ok: false, reason: `fetch failed: ${error}` };
  }
}

/** Reports an unavailable page and exits non-zero; no summary file is written for it. */
function failUnavailable(url: string, reason: string): never {
  console.error(`⚠️ Unavailable: ${url} (${reason}). No summary was saved.`);
  process.exit(1);
}

function extractTextFromHtml(html: string): string {
  // Simple HTML to text conversion
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function createSummaryFile(report: Report, content: string): string {
  const vendorDir = join(REPORTS_DIR, sanitizeFilename(report.vendor));
  if (!existsSync(vendorDir)) {
    mkdirSync(vendorDir, { recursive: true });
  }

  const filename = `${sanitizeFilename(report.name)}-summary.md`;
  const filepath = join(vendorDir, filename);

  const text = extractTextFromHtml(content);
  const preview = text.slice(0, 2000);

  const summary = `# ${report.name}

**Vendor:** ${report.vendor}
**URL:** ${report.url}
**Fetched:** ${new Date().toISOString().split('T')[0]}

## Landing Page Preview

${preview}${text.length > 2000 ? '\n\n[Truncated - see full page at URL above]' : ''}

## Notes

- Full report may require registration
- Check URL for download options
- PDF versions may be available
`;

  writeFileSync(filepath, summary);
  return filepath;
}

function listCachedReports(): void {
  if (!existsSync(REPORTS_DIR)) {
    console.log('📁 No cached reports yet');
    return;
  }

  console.log('📁 Cached Reports:\n');

  const vendors = readdirSync(REPORTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const vendor of vendors) {
    const vendorDir = join(REPORTS_DIR, vendor);
    const files = readdirSync(vendorDir);

    if (files.length > 0) {
      console.log(`📂 ${vendor}/`);
      for (const file of files) {
        console.log(`   └─ ${file}`);
      }
      console.log('');
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage:');
    console.log('  bun run FetchReport.ts <vendor> <report-name>');
    console.log('  bun run FetchReport.ts --url <url>');
    console.log('  bun run FetchReport.ts --list-cached');
    console.log('');
    console.log('Examples:');
    console.log('  bun run FetchReport.ts crowdstrike "global threat"');
    console.log('  bun run FetchReport.ts verizon dbir');
    console.log('  bun run FetchReport.ts --url https://example.com/report');
    return;
  }

  if (args[0] === '--list-cached') {
    listCachedReports();
    return;
  }

  if (args[0] === '--url' && args[1]) {
    const url = args[1];
    const page = await fetchReportPage(url);
    if (!page.ok) failUnavailable(url, page.reason);

    const report: Report = {
      vendor: 'custom',
      name: basename(new URL(url).pathname) || 'report',
      url
    };

    const filepath = createSummaryFile(report, page.html);
    console.log(`✅ Summary saved: ${filepath}`);
    return;
  }

  // Find report by vendor and name
  if (args.length >= 2) {
    const vendor = args[0];
    const reportName = args.slice(1).join(' ');

    const sources = loadSources();
    const report = findReport(sources, vendor, reportName);

    if (!report) {
      console.error(`❌ Report not found: ${vendor} "${reportName}"`);
      console.error('');
      console.error('Try searching:');
      console.error(`  bun run ListSources.ts --search ${vendor}`);
      process.exit(1);
    }

    console.log(`📄 Found: ${report.vendor} - ${report.name}`);
    console.log(`   URL: ${report.url}\n`);

    const page = await fetchReportPage(report.url);
    if (!page.ok) failUnavailable(report.url, page.reason);
    const filepath = createSummaryFile(report, page.html);

    console.log(`\n✅ Summary saved: ${filepath}`);
    console.log('');
    console.log('📝 Note: Most reports require registration for full PDF.');
    console.log('   Visit the URL above to download the complete report.');
    return;
  }

  console.log('❌ Invalid arguments. Run without args for usage.');
}

if (import.meta.main) main();
