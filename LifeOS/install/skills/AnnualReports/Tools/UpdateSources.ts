#!/usr/bin/env bun
/**
 * UpdateSources.ts - Update sources from upstream GitHub repo
 *
 * Usage:
 *   bun run UpdateSources.ts                  # Fetch and update from GitHub
 *   bun run UpdateSources.ts --dry-run       # Show changes without saving
 *   bun run UpdateSources.ts --diff          # Show diff with upstream
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const SOURCES_PATH = join(import.meta.dir, '..', 'Data', 'sources.json');
const UPSTREAM_URL = 'https://raw.githubusercontent.com/jacobdjwilson/awesome-annual-security-reports/main/README.md';

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

async function fetchUpstreamReadme(): Promise<string> {
  console.log('📥 Fetching upstream README...');
  const response = await fetch(UPSTREAM_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

export function parseMarkdownReports(markdown: string): Map<string, Report[]> {
  const reports = new Map<string, Report[]>();
  const lines = markdown.split('\n');

  let currentCategory = '';
  let currentSection = '';

  // Current upstream format (one line per report):
  //   - [Vendor](report-page-url) - [Report Name](archived-pdf-path-in-upstream-repo) (year) - description
  // The catalog keeps the first link: the vendor's own page for the report, which is what FetchReport reads.
  // The second link is a path inside the upstream repo's PDF archive, not a fetchable URL.
  const entryRe = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s*-\s*\[([^\]]+)\]\(([^)]+)\)/;

  for (const raw of lines) {
    const line = raw.trim();

    // Track main sections (only Analysis / Survey are captured; anything else,
    // including the "## Contents" TOC and "## Resources", resets tracking so
    // stray "- [..](..)" links there are never mistaken for report entries).
    if (line.startsWith('## Analysis Reports')) {
      currentSection = 'analysis';
      currentCategory = '';
      continue;
    }
    if (line.startsWith('## Survey Reports')) {
      currentSection = 'survey';
      currentCategory = '';
      continue;
    }
    if (line.startsWith('## ')) {
      currentSection = '';
      currentCategory = '';
      continue;
    }

    // Track categories (### headers) within a tracked section
    if (line.startsWith('### ')) {
      currentCategory = line.replace('### ', '').toLowerCase().replace(/\s+/g, '_');
      if (currentSection) {
        const key = `${currentSection}_${currentCategory}`;
        if (!reports.has(key)) reports.set(key, []);
      }
      continue;
    }

    // Parse report entries only when inside a tracked section + category
    if (!currentSection || !currentCategory) continue;
    const m = line.match(entryRe);
    if (m) {
      const vendor = m[1].trim();
      const reportPageUrl = m[2].trim();
      const reportName = m[3].trim();
      const key = `${currentSection}_${currentCategory}`;
      const existing = reports.get(key) || [];
      existing.push({ vendor, name: reportName, url: reportPageUrl });
      reports.set(key, existing);
    }
  }

  return reports;
}

function loadCurrentSources(): Sources {
  if (!existsSync(SOURCES_PATH)) {
    return {
      metadata: {
        source: UPSTREAM_URL.replace('/README.md', ''),
        lastUpdated: new Date().toISOString().split('T')[0],
        totalReports: 0
      },
      categories: {
        analysis: {},
        survey: {}
      }
    };
  }
  return JSON.parse(readFileSync(SOURCES_PATH, 'utf-8'));
}

function countReports(sources: Sources): number {
  let count = 0;
  for (const reports of Object.values(sources.categories.analysis)) {
    count += reports.length;
  }
  for (const reports of Object.values(sources.categories.survey)) {
    count += reports.length;
  }
  return count;
}

function compareReports(current: Sources, parsed: Map<string, Report[]>): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;

  // Build current URL set
  const currentUrls = new Set<string>();
  for (const reports of Object.values(current.categories.analysis)) {
    for (const report of reports) {
      currentUrls.add(report.url);
    }
  }
  for (const reports of Object.values(current.categories.survey)) {
    for (const report of reports) {
      currentUrls.add(report.url);
    }
  }

  // Build parsed URL set
  const parsedUrls = new Set<string>();
  for (const reports of parsed.values()) {
    for (const report of reports) {
      parsedUrls.add(report.url);
      if (!currentUrls.has(report.url)) {
        added++;
      }
    }
  }

  // Count removed
  for (const url of currentUrls) {
    if (!parsedUrls.has(url)) {
      removed++;
    }
  }

  return { added, removed };
}

/** Refuses to replace the catalog with an empty parse (an upstream format change), leaving the existing file untouched. */
export function assertParsedSomething(parsedTotal: number): void {
  if (parsedTotal <= 0) {
    throw new Error('Parsed 0 reports from upstream (its README format probably changed); sources.json was NOT modified.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const showDiff = args.includes('--diff');

  try {
    const markdown = await fetchUpstreamReadme();
    console.log(`✅ Fetched ${markdown.length} bytes\n`);

    const parsed = parseMarkdownReports(markdown);
    const current = loadCurrentSources();

    console.log('📊 Parsing results:');
    let parsedTotal = 0;
    for (const [key, reports] of parsed) {
      console.log(`  ${key}: ${reports.length} reports`);
      parsedTotal += reports.length;
    }
    console.log(`  Total parsed: ${parsedTotal}\n`);

    const comparison = compareReports(current, parsed);
    console.log('📈 Changes detected:');
    console.log(`  New reports: ${comparison.added}`);
    console.log(`  Removed reports: ${comparison.removed}\n`);

    if (dryRun) {
      console.log('🔍 Dry run - no changes saved');
      return;
    }

    if (showDiff) {
      console.log('📝 Detailed diff:');
      // Show what would change
      for (const [key, reports] of parsed) {
        const [section, category] = key.split('_', 2);
        const currentCategory = section === 'analysis'
          ? current.categories.analysis[category]
          : current.categories.survey[category];

        if (!currentCategory) {
          console.log(`  + NEW CATEGORY: ${key}`);
        }
      }
      return;
    }

    // An upstream format change parses to nothing; writing that would erase the working catalog.
    assertParsedSomething(parsedTotal);

    // Rebuild sources.json from the parsed upstream data.
    const updated: Sources = {
      metadata: {
        source: UPSTREAM_URL.replace('/README.md', ''),
        lastUpdated: new Date().toISOString().split('T')[0],
        totalReports: parsedTotal,
      },
      categories: { analysis: {}, survey: {} },
    };
    for (const [key, reports] of parsed) {
      if (reports.length === 0) continue;
      if (key.startsWith('analysis_')) {
        updated.categories.analysis[key.slice('analysis_'.length)] = reports;
      } else if (key.startsWith('survey_')) {
        updated.categories.survey[key.slice('survey_'.length)] = reports;
      }
    }

    mkdirSync(dirname(SOURCES_PATH), { recursive: true });
    writeFileSync(SOURCES_PATH, JSON.stringify(updated, null, 2));
    console.log('✅ Updated sources.json');
    console.log(`   Total reports: ${updated.metadata.totalReports}`);
    console.log(`   Last updated: ${updated.metadata.lastUpdated}`);

    console.log('\n💡 For full upstream sync, manually review changes at:');
    console.log(`   ${UPSTREAM_URL.replace('/README.md', '')}`);

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

if (import.meta.main) main();
