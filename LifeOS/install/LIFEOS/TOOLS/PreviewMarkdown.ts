#!/usr/bin/env bun
/**
 * @version 1.5.4
 * Preview a markdown file in the browser
 * Usage: bun PreviewMarkdown.ts <path-to-markdown>
 *
 * 1.5.4 (2026-10-13): the markdown rides into the page as inert JSON with
 * `<`, `>`, `&` and the line separators escaped, so content holding a closing script tag cannot end the
 * inline script before DOMPurify runs; the filename in <title> is HTML-escaped.
 */

import { writeFile, mkdtemp, readFile } from "fs/promises";
import { join, basename } from "path";
import { tmpdir } from "os";
import { $ } from "bun";

/** HTML-escape text for an element body or attribute value. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * JSON for a string literal inside an inline <script>. Still valid JS and JSON, but nothing in it can form
 * a tag, a comment opener or an entity, and U+2028/U+2029 (line terminators in older JS) are escaped.
 */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(LS).join("\\u2028")
    .split(PS).join("\\u2029");
}
export function renderPreviewHtml(content: string, title: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
  <style>
    body {
      max-width: 800px;
      margin: 40px auto;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.7;
      color: #1a1a1a;
      background: #fafafa;
    }
    h1 { color: #111; font-size: 2.2em; margin-bottom: 0.5em; }
    h2 { color: #333; border-bottom: 1px solid #ddd; padding-bottom: 0.3em; margin-top: 1.5em; }
    pre { background: #2d2d2d; color: #ccc; padding: 16px; overflow-x: auto; border-radius: 6px; }
    code { background: #e8e8e8; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    pre code { padding: 0; background: none; }
    blockquote { border-left: 4px solid #3b82f6; margin: 0; padding-left: 20px; color: #555; }
    strong { color: #000; }
    hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
  </style>
</head>
<body>
  <div id="content"></div>
  <script>
    // Sanitize rendered HTML before injection — markdown can carry raw <script>/onerror XSS
    document.getElementById('content').innerHTML = DOMPurify.sanitize(marked.parse(${scriptSafeJson(content)}));
  </script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const mdPath = process.argv[2];
  if (!mdPath) {
    console.error("Usage: bun PreviewMarkdown.ts <path-to-markdown>");
    process.exit(1);
  }

  const content = await readFile(mdPath, "utf-8");
  const title = basename(mdPath, ".md");

  const tempDir = await mkdtemp(join(tmpdir(), "lifeos-preview-"));
  const htmlPath = join(tempDir, "preview.html");

  await writeFile(htmlPath, renderPreviewHtml(content, title));
  await $`open ${htmlPath}`.quiet();

  console.log(JSON.stringify({
    success: true,
    url: `file://${htmlPath}`,
    path: htmlPath
  }, null, 2));
}

if (import.meta.main) await main();
