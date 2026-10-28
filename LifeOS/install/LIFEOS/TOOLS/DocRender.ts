#!/usr/bin/env bun
/**
 * DocRender.ts — render any Markdown document to a themed HTML page.
 *
 * Uses the SAME theme as the ISA renderer: it inlines
 * `LIFEOS/TOOLS/ISARender/template.css` (LifeOS Technical, Tokyo Night Storm
 * derivative), so a prose document and an ISA page share one theme source and
 * can never drift apart. This is the standard renderer for any ad-hoc HTML
 * document (an analysis, a report, a write-up) — ISAs keep using ISARender.ts,
 * which adds the ISA-specific hero/phase/ISC scaffolding.
 *
 * Usage:
 *   bun DocRender.ts <markdown-path> [--title "…"] [--label "…"] [--output <path>] [--stdout]
 *
 * --title   overrides the H1 (default: the document's first `# ` heading)
 * --label   the brand-bar context word (default: "Document" — e.g. "Analysis", "Report")
 * --output  output HTML path (default: sibling .html next to the input)
 * --stdout  write HTML to stdout instead of a file
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { lifeosPath } from "./Paths";
import { invariant } from "./Invariant";

const HOME = process.env.HOME || homedir();
const TOOLS_DIR = lifeosPath("TOOLS");
const TEMPLATE_CSS = join(TOOLS_DIR, "ISARender/template.css");
const BRAND_LOGO_OVERRIDE = process.env.LIFEOS_BRAND_LOGO_PATH ?? "";
const BRAND_LOGO_DEFAULT = lifeosPath("ASSETS", "lifeos-logo.png");

interface Args {
  input: string;
  title: string | null;
  label: string;
  output: string | null;
  stdout: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { input: "", title: null, label: "Document", output: null, stdout: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stdout") args.stdout = true;
    else if (a === "--title" && argv[i + 1]) args.title = argv[++i];
    else if (a === "--label" && argv[i + 1]) args.label = argv[++i];
    else if (a === "--output" && argv[i + 1]) args.output = argv[++i];
    else if (!a.startsWith("--") && !args.input) args.input = a;
  }
  return args;
}

function loadBrandLogoB64(): string {
  for (const p of [BRAND_LOGO_OVERRIDE, BRAND_LOGO_DEFAULT].filter(Boolean)) {
    if (existsSync(p)) { try { return readFileSync(p).toString("base64"); } catch {} }
  }
  return "";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Render a markdown string → HTML body via the `marked` CLI (stdin; no repo dependency needed). */
function renderMarkdown(md: string): string {
  return execFileSync("bunx", ["marked"], { input: md, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
}

/** Drop the first top-level `# ` heading — it becomes the page H1, so rendering it again duplicates it. */
function stripLeadingH1(md: string): string {
  return md.replace(/^#\s+.+?\r?\n/m, "");
}

function buildPage(opts: { title: string; label: string; body: string; css: string; logoB64: string; footerLeft: string }): string {
  const { title, label, body, css, logoB64, footerLeft } = opts;
  const renderedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const logoImg = logoB64
    ? `<img class="brand-logo" alt="LifeOS" src="data:image/png;base64,${logoB64}">`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
${css}
</style>
</head>
<body>
<div id="root">

  <header class="brand-bar">
    <div class="brand-left">
      ${logoImg}
      <div class="brand-wordmark">LifeOS</div>
      <span class="brand-divider">·</span>
      <div class="brand-context">${escapeHtml(label)}</div>
    </div>
  </header>

  <h1>${escapeHtml(title)}</h1>

  <section class="section">
${body}
  </section>

  <footer class="footer">
    <div class="left">${escapeHtml(footerLeft)}</div>
    <div class="right">Rendered · ${escapeHtml(renderedAt)}</div>
  </footer>

</div>
</body>
</html>
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('Usage: bun DocRender.ts <markdown-path> [--title "…"] [--label "…"] [--output <path>] [--stdout]');
    process.exit(1);
  }
  const inPath = resolve(args.input);
  invariant(existsSync(inPath), `input markdown not found: ${inPath}`);
  invariant(existsSync(TEMPLATE_CSS), `theme CSS missing: ${TEMPLATE_CSS} (ISA renderer theme source)`);

  // YAML frontmatter is file metadata, not content; left in, marked renders `---\nkey: v\n---` as a setext H2.
  const src = readFileSync(inPath, "utf-8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  // Title: explicit flag, else first H1, else the file's basename.
  const h1 = src.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  const title = args.title ?? h1 ?? basename(inPath).replace(/\.md$/i, "");

  const body = renderMarkdown(stripLeadingH1(src));
  invariant(body.trim().length > 0, "marked produced empty HTML body");
  const css = readFileSync(TEMPLATE_CSS, "utf-8");
  const footerLeft = inPath.startsWith(HOME) ? "~" + inPath.slice(HOME.length) : inPath;

  const html = buildPage({ title, label: args.label, body, css, logoB64: loadBrandLogoB64(), footerLeft });

  if (args.stdout) { process.stdout.write(html); return; }

  const outPath = args.output ? resolve(args.output) : join(dirname(inPath), basename(inPath).replace(/\.md$/i, "") + ".html");
  const tmp = outPath + ".tmp";
  writeFileSync(tmp, html, "utf-8");
  renameSync(tmp, outPath);
  console.log(JSON.stringify({ status: "rendered", path: outPath, bytes: html.length, title }, null, 2));
}

main();
