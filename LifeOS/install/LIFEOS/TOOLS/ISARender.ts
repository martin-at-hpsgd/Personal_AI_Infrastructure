#!/usr/bin/env bun
/**
 * @version 1.4.2
 * ISARender.ts — Render an ISA.md to a branded sibling ISA.html.
 *
 * Usage:
 *   bun ISARender.ts <slug-or-path>
 *   bun ISARender.ts <slug-or-path> --no-refresh
 *   bun ISARender.ts <slug-or-path> --output <path>
 *   bun ISARender.ts <slug-or-path> --stdout
 *
 * Deterministic, zero-token, offline-first. Hand-rolled ISA-aware markdown parser.
 * Reuses McKinsey-family branding via inlined template.css. Reloads matching
 * Interceptor tabs without opening new ones; refresh failure is non-fatal.
 */

import { readFileSync, writeFileSync, existsSync, statSync, renameSync, readdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { parseIsaClaimsText, isaBody, claimText, stripBulletPrefix } from "./lib/IsaClaims";
import { ASCENT, ASCENT_BRACKETS, PHASE_TO_ASCENT, type AscentState } from "./ascent";
import { parseLadder } from "./IsaLadder";
import { lifeosPath } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

const HOME = process.env.HOME || homedir();
const TOOLS_DIR = lifeosPath("TOOLS");
const TEMPLATE_HTML = join(TOOLS_DIR, "ISARender/template.html");
const TEMPLATE_CSS = join(TOOLS_DIR, "ISARender/template.css");
// Brand logo: user override via LIFEOS_BRAND_LOGO_PATH env var (absolute path),
// else system default under LIFEOS/ASSETS/, else inert (empty src).
const BRAND_LOGO_PATH_OVERRIDE = process.env.LIFEOS_BRAND_LOGO_PATH ?? "";

const BRAND_LOGO_PATH_DEFAULT = lifeosPath("ASSETS", "lifeos-logo.png");
const WORK_DIR = lifeosPath("MEMORY", "WORK");
const WORK_JSON = lifeosPath("MEMORY", "STATE", "work.json");

// Lifecycle stages come from the one ascent table (LIFEOS/TOOLS/ascent.ts) — the same
// four brackets an ISA can declare, in the same order, under the same names the Kitty tab
// and the Pulse board use. Never define a private stage vocabulary here: a second list is
// how a mirror ends up disagreeing with the tab generated beside it.
const STAGES = ASCENT_BRACKETS;

// ASCENT_BRACKETS is a three-slot subset of the run states, so a phase that maps
// to an off-bracket state has no slot of its own: `verify` → `anchoring`,
// `native` → `traverse`, `idle` → `idle`. Letting indexOf's -1 clamp to 0 sent
// all three to "Marking", so a `phase: verify` ISA rendered Marking in the bar
// while renderHeroBadges on the same page said ANCHORING. Fold to the last
// bracket at or before the state in the table's arc order instead.
// ported from public PR #1737, @elhoim
function bracketIndex(state: AscentState): number {
  const exact = ASCENT_BRACKETS.indexOf(state);
  if (exact >= 0) return exact;
  // `idle` sits off the end of the arc (order 10) as a hidden sentinel, not as
  // work past the cairn. Folding it by order would render a finished bar for a
  // row that has not started, so it stays at the first slot.
  if (ASCENT[state].board === "hidden") return 0;
  let idx = 0;
  for (let i = 0; i < ASCENT_BRACKETS.length; i++) {
    if (ASCENT[ASCENT_BRACKETS[i]].order <= ASCENT[state].order) idx = i;
  }
  return idx;
}

const STAGE_MAP: Record<string, number> = Object.fromEntries(
  Object.entries(PHASE_TO_ASCENT).map(([phase, state]) => [phase, bracketIndex(state)]),
);

// ─────────── BRAND LOGO LOADER ───────────
function loadBrandLogoB64(): string {
  const paths = [BRAND_LOGO_PATH_OVERRIDE, BRAND_LOGO_PATH_DEFAULT].filter(Boolean);
  for (const p of paths) {
    if (existsSync(p)) {
      try { return readFileSync(p).toString("base64"); } catch {}
    }
  }
  return "";
}

// ─────────── CLI ARG PARSING ───────────

interface Args {
  input: string;
  noRefresh: boolean;
  output: string | null;
  stdout: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { input: "", noRefresh: false, output: null, stdout: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-refresh") args.noRefresh = true;
    else if (a === "--stdout") { args.stdout = true; args.noRefresh = true; }
    else if (a === "--output" && argv[i + 1]) { args.output = argv[++i]; }
    else if (!args.input) args.input = a;
  }
  return args;
}

// ─────────── PATH RESOLUTION ───────────

function resolveISAPath(input: string): string {
  if (input.endsWith(".md") && existsSync(input)) return resolve(input);
  // Slug → look up in work.json or scan WORK_DIR
  if (existsSync(WORK_JSON)) {
    try {
      const reg = JSON.parse(readFileSync(WORK_JSON, "utf-8"));
      const session = reg.sessions?.[input];
      if (session?.isaPath && existsSync(session.isaPath)) return resolve(session.isaPath);
    } catch {}
  }
  const direct = join(WORK_DIR, input, "ISA.md");
  if (existsSync(direct)) return direct;
  // Fuzzy: directory name contains slug
  if (existsSync(WORK_DIR)) {
    for (const d of readdirSync(WORK_DIR)) {
      if (d.includes(input)) {
        const p = join(WORK_DIR, d, "ISA.md");
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error(`Could not resolve ISA from: ${input}`);
}

// ─────────── FRONTMATTER PARSER ───────────

interface Frontmatter {
  [key: string]: string;
}

function parseFrontmatter(src: string): { fm: Frontmatter; body: string; warnings: string[] } {
  const warnings: string[] = [];
  if (!src.startsWith("---\n")) {
    warnings.push("missing-frontmatter");
    return { fm: {}, body: src, warnings };
  }
  const end = src.indexOf("\n---\n", 4);
  if (end === -1) {
    warnings.push("unclosed-frontmatter");
    return { fm: {}, body: src, warnings };
  }
  const yamlBlock = src.slice(4, end);
  const body = src.slice(end + 5);
  const fm: Frontmatter = {};
  for (const raw of yamlBlock.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  // Minimal frontmatter: only `phase` is required for a useful render. `task` falls back
  // to the H1 title, `slug` to the directory name. Do not warn on `effort` — it is a legacy
  // field that still appears on old ISAs and means nothing now.
  for (const req of ["phase"]) {
    if (!fm[req]) warnings.push(`missing-frontmatter:${req}`);
  }
  return { fm, body, warnings };
}

// ─────────── BODY → SECTIONS ───────────

interface Section { name: string; slug: string; lines: string[]; }

function splitSections(body: string): Section[] {
  const lines = body.split("\n");
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      if (current) sections.push(current);
      const name = h[1].trim();
      current = { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

// ─────────── INLINE MARKDOWN ───────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderInline(s: string): string {
  let out = escapeHtml(s);
  // Code spans first (protect contents)
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic (single underscore or asterisk)
  out = out.replace(/(^|[\s(])_([^_]+)_($|[\s).,;:])/g, "$1<em>$2</em>$3");
  out = out.replace(/(^|[\s(])\*([^*]+)\*($|[\s).,;:])/g, "$1<em>$2</em>$3");
  // Links: only a destination whose scheme is allowed becomes an href.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, dest: string) =>
    safeLinkHref(dest) ? `<a href="${dest}">${label}</a>` : `<span class="link-refused" title="link removed: scheme not allowed">${label}</span>`);
  return out;
}

/** Schemes a rendered ISA link may carry. Anything else (javascript:, vbscript:, data:, file:, blob:…) is refused. */
const SAFE_LINK_SCHEMES = new Set(["http", "https", "mailto"]);

/**
 * True when an (HTML-escaped) link destination is safe to put in an href. The check runs on the value a browser
 * parses: the attribute holds the escaped text, which the browser decodes exactly once, so undoing escapeHtml gives
 * that value (a `&#106;` written in the ISA reaches the attribute as `&amp;#106;` and never becomes a letter). The
 * ASCII whitespace and control characters a URL parser strips are removed before the scheme is read, so
 * `JaVa\tScRiPt:` and leading spaces cannot hide one. No scheme means relative (fragment, path, query) and stays.
 * Exported for its regression test.
 */
export function safeLinkHref(escapedDest: string): boolean {
  const attrValue = escapedDest.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  const norm = attrValue.replace(/[\u0000- \u007f]/g, "").toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(norm);
  return scheme === null || SAFE_LINK_SCHEMES.has(scheme[1]!);
}

// ─────────── ISC LINE PARSER ───────────

interface ISCRow {
  status: "pending" | "passed" | "deferred";
  id: string;
  kind: "normal" | "anti" | "antecedent" | "tombstone";
  body: string;
}

// Criterion IDs: `ISC-1` / `ISC-2.1` (spec ≤v2.14), plus the Algorithm v8 short
// forms — `C1`, `A3`, `EQ-12` (2026-07-22 claims-vocabulary fix, mirrors
// hooks/lib/isa-utils.ts). Separator is `:` or an em/en dash.
const CLAIM_ID = "(ISC-[0-9A-Za-z.-]+|[A-Z]{1,6}-[A-Z0-9][\\w-]*|[A-Z]{1,4}-?\\d+(?:\\.\\d+)*)";

function parseISCLine(line: string): ISCRow | null {
  const claim = parseIsaClaimsText("## Claims\n" + line).claims[0];
  if (!claim) return null;
  const body = claim.source === "table"
    ? line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).filter(cell => claimText(cell)?.id !== claim.id).join(" | ").trim()
    : claimText(stripBulletPrefix(line))!.body;
  const status: ISCRow["status"] = claim.checked ? "passed" : /\[DEFERRED-VERIFY\]/i.test(line) ? "deferred" : "pending";
  const kind: ISCRow["kind"] = /^\[DROPPED/i.test(body) ? "tombstone" : claim.anti ? "anti" : /^Antecedent:/.test(body) ? "antecedent" : "normal";
  return { status, id: claim.id, kind, body };
}

function parseAntiClaimLine(line: string): ISCRow | null {
  const row = parseISCLine(line);
  return row ? { ...row, kind: "anti" } : null;
}

function renderISCRow(row: ISCRow): string {
  const glyphMap: Record<string, string> = {
    pending: "○",
    passed: "●",
    deferred: "◐",
  };
  let glyph = glyphMap[row.status];
  if (row.kind === "anti") glyph = "⛔";
  else if (row.kind === "antecedent") glyph = "◆";
  else if (row.kind === "tombstone") glyph = "✕";

  const classes = ["isc", row.status];
  if (row.kind !== "normal") classes.push(row.kind);

  // Pull off the "Anti:" / "Antecedent:" prefix for display, render as labeled span
  let body = row.body;
  let prefixHtml = "";
  if (row.kind === "anti") {
    body = body.replace(/^Anti:\s*/, "");
    prefixHtml = `<span class="isc-prefix">Anti:</span>`;
  } else if (row.kind === "antecedent") {
    body = body.replace(/^Antecedent:\s*/, "");
    prefixHtml = `<span class="isc-prefix">Antecedent:</span>`;
  }
  const anchor = `<a id="${row.id}"></a>`;
  return `<li class="${classes.join(" ")}">${anchor}<span class="isc-glyph">${glyph}</span><span class="isc-id">${row.id}</span><span class="isc-body">${prefixHtml}${renderInline(body)}</span></li>`;
}

// ─────────── TABLE PARSER ───────────

interface ParsedTable { headers: string[]; rows: string[][]; }

function parseTable(lines: string[], startIdx: number): { table: ParsedTable; endIdx: number } | null {
  const headerLine = lines[startIdx];
  if (!headerLine?.trim().startsWith("|")) return null;
  const sepLine = lines[startIdx + 1];
  if (!sepLine?.trim().match(/^\|?[\s|:-]+\|?$/)) return null;
  const headers = headerLine.split("|").map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
  const rows: string[][] = [];
  let i = startIdx + 2;
  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln?.trim().startsWith("|")) break;
    const cells = ln.split("|").map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
    rows.push(cells);
  }
  return { table: { headers, rows }, endIdx: i - 1 };
}

function renderTable(t: ParsedTable): string {
  const head = t.headers.map(h => `<th>${renderInline(h)}</th>`).join("");
  const body = t.rows.map(r => `<tr>${r.map(c => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("");
  return `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ─────────── GENERIC SECTION BODY RENDERER ───────────

function renderSectionBody(section: Section): string {
  const lines = section.lines;
  const out: string[] = [];
  let i = 0;
  let inUl = false;
  let inIscList = false;
  let inOl = false;
  let inCodeBlock = false;
  let codeBuf: string[] = [];
  let fenceInfo = "";
  let paragraphBuf: string[] = [];

  const flushPara = () => {
    if (paragraphBuf.length) {
      out.push(`<p>${renderInline(paragraphBuf.join(" "))}</p>`);
      paragraphBuf = [];
    }
  };
  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };

  // Special handling: Criteria/Claims sections group ISCs by bold subheaders
  const isCriteria = section.slug === "criteria" || section.slug === "claims" || section.slug === "isc-criteria";
  // v8 anti-criteria sections carry ID bullets without checkboxes
  const isAntiSection = section.slug === "anti-claims" || section.slug === "anti-criteria";

  while (i < lines.length) {
    const line = lines[i];

    // Code fence. An exhibit fence (```calls, ```ask, …) becomes a runtime element.
    if (line.trim().startsWith("```")) {
      flushPara(); closeLists();
      if (!inCodeBlock) { inCodeBlock = true; codeBuf = []; fenceInfo = line.trim().slice(3).trim(); }
      else {
        inCodeBlock = false;
        out.push(renderExhibit(fenceInfo, codeBuf) ?? `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
      }
      i++; continue;
    }
    if (inCodeBlock) { codeBuf.push(line); i++; continue; }

    // Blank line: paragraph break
    if (!line.trim()) { flushPara(); closeLists(); i++; continue; }

    // Table (starts with | and next line is |---|)
    if (line.trim().startsWith("|") && lines[i + 1]?.trim().match(/^\|?[\s|:-]+\|?$/)) {
      flushPara(); closeLists();
      const parsed = parseTable(lines, i);
      if (parsed) { out.push(renderTable(parsed.table)); i = parsed.endIdx + 1; continue; }
    }

    // ISC line (only meaningful in Criteria/Claims, but support anywhere).
    // In an Anti-criteria section, checkbox-less ID bullets also parse.
    const isc = parseISCLine(line) ?? (isAntiSection ? parseAntiClaimLine(line) : null);
    if (isc) {
      flushPara(); closeLists();
      // One list per run of rows: open it only when no ISC list is open.
      if (!inIscList) { out.push(`<ul class="isc-list">`); inIscList = true; }
      out.push(renderISCRow(isc));
      // If next line is also an ISC or empty, leave list open
      const parseRow = (l: string) => parseISCLine(l) ?? (isAntiSection ? parseAntiClaimLine(l) : null);
      const next = lines[i + 1];
      const nextIsIsc = next && parseRow(next);
      if (!nextIsIsc) {
        // Lookahead for blank line then another ISC group header
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const peek = lines[j];
        if (peek && parseRow(peek)) {
          // continue list across blanks
        } else {
          out.push(`</ul>`);
          inIscList = false;
        }
      }
      i++; continue;
    }

    // Bold-only line (used in Criteria as group titles, e.g. **Engine — Markdown to Branded HTML**)
    const boldGroup = line.match(/^\*\*(.+?)\*\*\s*$/);
    if (boldGroup && isCriteria) {
      flushPara(); closeLists();
      out.push(`<div class="isc-group-title">${renderInline(boldGroup[1])}</div>`);
      i++; continue;
    }

    // Bullet (non-ISC)
    if (/^-\s+/.test(line.trim())) {
      flushPara();
      if (!inUl) { out.push("<ul>"); inUl = true; }
      const content = line.trim().replace(/^-\s+/, "");
      out.push(`<li>${renderInline(content)}</li>`);
      i++; continue;
    }
    // Numbered list
    if (/^\d+\.\s+/.test(line.trim())) {
      flushPara();
      if (!inOl) { out.push("<ol>"); inOl = true; }
      const content = line.trim().replace(/^\d+\.\s+/, "");
      out.push(`<li>${renderInline(content)}</li>`);
      i++; continue;
    }

    // Blockquote
    if (line.trim().startsWith("> ")) {
      flushPara(); closeLists();
      // Collect contiguous quote lines
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("> ")) {
        buf.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderInline(buf.join(" "))}</blockquote>`);
      continue;
    }

    // Feature-block heading (### F<n> · Name) — v2.16.0 feature blocks
    const featH = line.match(/^###\s+(F\d+)\s*[·.\-–—]?\s*(.*)$/);
    if (featH) {
      flushPara(); closeLists();
      out.push(`<h3 class="feature-title"><span class="feature-id">${escapeHtml(featH[1])}</span>${featH[2] ? " " + renderInline(featH[2]) : ""}</h3>`);
      i++; continue;
    }

    // Sub-heading (### or ####)
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) { flushPara(); closeLists(); out.push(`<h3>${renderInline(h3[1])}</h3>`); i++; continue; }

    // Feature "Why:" line — the feature's one-line ideal-state (v2.16.0)
    const whyLine = line.match(/^Why:\s*(.+)$/);
    if (whyLine) {
      flushPara(); closeLists();
      out.push(`<p class="feature-why"><span class="feature-why-label">Why</span>${renderInline(whyLine[1])}</p>`);
      i++; continue;
    }

    // Default: paragraph line
    closeLists();
    paragraphBuf.push(line.trim());
    i++;
  }
  flushPara(); closeLists();
  return out.join("\n");
}

// ─────────── EXHIBITS (html-plan runtime, ported; see ISARender/htmlplan/UPSTREAM.md) ───────────
// A fence whose info string starts with one of these kinds becomes the runtime element; its
// body is the element's own source text. `flowchart` and `filetree` avoid `flow` and `tree`,
// which are the terminal's chart fences.

const EXHIBIT_TAGS: Record<string, string> = {
  calls: "doc-calls", machine: "doc-machine", schema: "doc-schema", code: "doc-code",
  flowchart: "doc-flow", filetree: "doc-tree", seq: "doc-seq", draft: "doc-draft",
  mock: "doc-mock", ask: "doc-ask",
};

// Set when any section renders an exhibit; main() then inlines the runtime and lints the page.
let exhibitsUsed = 0;
let askCount = 0;
// Findings about exhibit input (dropped attributes, refused sources); main() adds them to the
// page's render warnings.
const exhibitWarnings: string[] = [];
// Folders a `src=` fence may read from: the ISA's own folder plus an optional `exhibit_root:`.
let exhibitRoots: string[] = [];

// ISA text can quote outside material, so a fence may only set the attributes the runtime
// documents (htmlplan/blocks.md). Anything else, event handlers included, is dropped.
const EXHIBIT_ATTRS = new Set([
  "id", "title", "caption", "label", "lang", "src", "lines", "hl", "start", "file", "diff", "wrap",
  "collapsed", "ref", "name", "frame", "w", "h", "url", "thumbnail", "files", "neutral", "open", "q",
  // ask lifecycle (ISAFormat § Exhibits): all optional, on an `ask` fence
  "status", "blocks", "raised-by", "looked-up", "answered",
]);

// Files a `src=` fence never embeds, by name or by content. pack.mjs has its own check; this one
// also covers the names and unquoted KEY=value lines it misses.
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.dev\.vars|\.credentials\.json|.*\.pem|.*\.key|.*\.p12|id_[a-z0-9]+|\.npmrc|\.netrc|.*secret.*|.*token.*)$/i;
const SECRET_LINE = /^\s*(export\s+)?[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*["']?[^\s"']{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/m;

function parseFenceAttrs(s: string, kind: string): Array<[string, string | null]> {
  const out: Array<[string, string | null]> = [];
  for (const m of s.matchAll(/([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/g)) {
    if (!EXHIBIT_ATTRS.has(m[1].toLowerCase())) { exhibitWarnings.push(`exhibit: dropped attribute ${m[1]} on a ${kind} fence`); continue; }
    // A repeated attribute is invalid HTML and the first value is the one the renderer reads.
    if (out.some(([k]) => k.toLowerCase() === m[1].toLowerCase())) { exhibitWarnings.push(`exhibit: repeated attribute ${m[1]} on a ${kind} fence, first value kept`); continue; }
    out.push([m[1], m[2] ?? m[3] ?? m[4] ?? null]);
  }
  return out;
}

const attrHtml = (attrs: Array<[string, string | null]>) =>
  attrs.map(([k, v]) => (v === null ? ` ${k}` : ` ${k}="${escapeHtml(v)}"`)).join("");

// ─────────── MOCK SANITIZER ───────────
// A mock is drawn HTML, never behaviour. The exhibit text can quote outside material, so the
// sanitizer is a tokenizer with allowlists, not a pattern strip: every tag it keeps is rebuilt from
// parsed parts (no raw `<` survives from the input), element and URL decisions are made on the
// DECODED form (entities, control characters and CSS escapes resolved first), and anything it
// cannot parse is escaped. A mock can load nothing from the network; the packed page also carries
// a CSP that says so.

const MOCK_ELEMENTS = new Set((
  "a abbr address article aside b bdi bdo big blockquote br button caption center cite code col colgroup data dd del details dfn div dl dt em " +
  "fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr i img input ins kbd label legend li main mark menu meter nav ol optgroup " +
  "option output p picture pre progress q rp rt ruby s samp section select small source span strike strong sub summary sup table tbody td textarea " +
  "tfoot th thead time tr tt u ul var video audio track wbr style " +
  "svg g defs path rect circle ellipse line polyline polygon text tspan lineargradient radialgradient stop clippath mask pattern symbol title desc image marker"
).split(" "));
// Dropped with everything inside them (raw-text or active content).
const MOCK_DROP_WITH_BODY = new Set(["script", "iframe", "noscript", "noembed", "noframes", "xmp", "plaintext", "object", "applet", "template", "frameset", "frame", "foreignobject"]);
// Attributes that carry a URL, and the ones that LOAD it on their own (so no remote value is ever allowed).
const MOCK_URL_ATTRS = new Set(["href", "xlink:href", "src", "srcset", "poster", "data", "background", "longdesc", "cite", "ping", "action", "formaction", "manifest", "usemap", "codebase", "icon", "dynsrc", "lowsrc"]);
const MOCK_NAV_ELEMENTS = new Set(["a", "area"]);
const NAMED_ENTITIES: Record<string, string> = {
  colon: ":", tab: "\t", newline: "\n", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", sol: "/", bsol: "\\", lpar: "(", rpar: ")",
  nbsp: " ", period: ".", comma: ",", semi: ";", num: "#", excl: "!", percnt: "%", plus: "+", equals: "=", quest: "?", commat: "@",
  lsqb: "[", rsqb: "]", lbrace: "{", rbrace: "}", lowbar: "_", hyphen: "-", dash: "-", sup1: "¹",
};

/** Resolves numeric and the named entities that can spell a URL, with or without the `;`. */
function decodeEntities(s: string): string {
  let prev = "";
  let cur = s;
  // decoded twice at most: `&amp;#106;` is `&#106;` as text to a browser, but being strict costs nothing here
  for (let i = 0; i < 3 && cur !== prev; i++) {
    prev = cur;
    cur = cur
      .replace(/&#x([0-9a-f]+);?/gi, (m, h) => { const n = parseInt(h, 16); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�"; })
      .replace(/&#(\d+);?/g, (m, d) => { const n = parseInt(d, 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�"; })
      .replace(/&([a-z][a-z0-9]*);?/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
  }
  return cur;
}

type UrlKind = "empty" | "fragment" | "relative" | "remote" | "mail" | "media" | "unsafe";
/** Classifies a URL the way a browser would read it: entities decoded, control and invisible
 *  characters removed, case folded. An unresolved `&…` before the path starts is `unsafe`. */
function classifyUrl(raw: string): UrlKind {
  const decoded = decodeEntities(raw)
    .replace(/[\x00-\x20\x7f-\xa0\xad\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/g, "")
    .toLowerCase();
  if (!decoded) return "empty";
  if (decoded[0] === "#") return "fragment";
  if (/^[\\/]{2}/.test(decoded) || /^[\\/][\\/]/.test(decoded.replace(/\\/g, "/"))) return "remote";
  const head = decoded.split(/[/?#]/)[0];
  if (head.includes("&")) return "unsafe";
  const scheme = head.match(/^([a-z][a-z0-9+.-]*):/)?.[1];
  if (!scheme) return "relative";
  if (scheme === "http" || scheme === "https") return "remote";
  if (scheme === "mailto" || scheme === "tel") return "mail";
  if (scheme === "data") return /^data:(image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|font\/[a-z0-9.+-]+)[;,]/.test(decoded) ? "media" : "unsafe";
  return "unsafe";
}

function cssUnescape(s: string): string {
  return s
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (m, h) => { const n = parseInt(h, 16); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�"; })
    .replace(/\\([\s\S])/g, "$1");
}

/** A style value (attribute or element body) that can load or run anything is rewritten to a
 *  value that cannot: url() targets other than same-document, local relative and data media are
 *  replaced, and @import, image-set, expression, behavior and binding constructs are removed. */
function sanitizeCss(css: string): string {
  const flat = cssUnescape(decodeEntities(css)).replace(/\/\*[\s\S]*?\*\//g, "");
  const dirty = /@import|image-set\s*\(|-webkit-image-set|expression\s*\(|behaviou?r\s*:|-moz-binding|javascript:|vbscript:|\\/i.test(css) ||
    /@import|image-set\s*\(|-webkit-image-set|expression\s*\(|behaviou?r\s*:|-moz-binding|javascript:|vbscript:/i.test(flat) ||
    /url\s*\(/i.test(flat);
  if (!dirty) return css.replace(/</g, "\\3c ");
  return flat
    .replace(/@import[^;{]*;?/gi, "")
    .replace(/(?:-webkit-)?image-set\s*\([^)]*\)/gi, "none")
    .replace(/expression\s*\([^)]*\)/gi, "none")
    .replace(/-moz-binding\s*:[^;}]*/gi, "")
    .replace(/behaviou?r\s*:[^;}]*/gi, "")
    .replace(/(?:java|vb)script:/gi, "")
    .replace(/url\s*\(\s*(["']?)([\s\S]*?)\1\s*\)/gi, (m, q, target) => {
      const k = classifyUrl(target);
      return k === "fragment" || k === "relative" || k === "media" ? `url(${q}${target}${q})` : "url(#)";
    })
    .replace(/</g, "\\3c ");
}

const escAttr = (v: string) => v.replace(/&(?![a-z][a-z0-9]*;|#\d+;|#x[0-9a-f]+;)/gi, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escText = (v: string) => v.replace(/</g, "&lt;");

function parseTagAttrs(region: string): Array<[string, string | null]> {
  const out: Array<[string, string | null]> = [];
  // `/` separates attributes in the HTML tokenizer (`<img/src=x/onerror=…>`), so it is a separator here too.
  for (const m of region.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    out.push([m[1], m[2] ?? m[3] ?? m[4] ?? null]);
  }
  return out;
}

function keepAttr(tag: string, name: string, value: string | null): [string, string | null] | null {
  const n = name.toLowerCase();
  if (!/^[a-z_:][a-z0-9_:.-]*$/.test(n)) return null;
  if (n.startsWith("on")) return null;
  if (n === "srcdoc" || n === "is" || n === "slot" || n === "formaction" || n === "action" || n === "ping" || n === "manifest" || n === "autofocus") return null;
  if (n === "style") return value === null ? null : [name, sanitizeCss(value)];
  if (MOCK_URL_ATTRS.has(n)) {
    if (value === null) return null;
    if (n === "srcset") {
      const parts = value.split(",").map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
      return parts.every((u) => ["fragment", "relative", "media"].includes(classifyUrl(u))) ? [name, value] : null;
    }
    const kind = classifyUrl(value);
    if (kind === "empty") return [name, value];
    const nav = MOCK_NAV_ELEMENTS.has(tag) && (n === "href" || n === "xlink:href");
    if (kind === "fragment" || kind === "relative" || kind === "media") return [name, value];
    if (nav && (kind === "remote" || kind === "mail")) return [name, value];
    return nav ? [name, "#"] : null;
  }
  return [name, value];
}

/** A mock is drawn HTML, never behaviour: only allowlisted elements survive, event handlers and
 *  every URL that is not same-document, local or inline media are removed. */
function sanitizeMock(html: string): string {
  let out = "";
  let i = 0;
  const n = html.length;
  const TAG = /<(\/?)([a-z][\w:-]*)(?=[\s\/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/iy;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(html);
    if (!m) { out += "&lt;"; i = lt + 1; continue; }
    i = lt + m[0].length;
    const closing = m[1] === "/";
    const name = m[2];
    const tag = name.toLowerCase();
    if (!closing && MOCK_DROP_WITH_BODY.has(tag)) {
      // drop through the matching close tag; an unclosed one drops the rest, as a browser would read it as that element's body
      const close = new RegExp(`</${name}\\s*>`, "i");
      const cm = html.slice(i).match(close);
      i = cm ? i + (cm.index ?? 0) + cm[0].length : n;
      continue;
    }
    if (closing && MOCK_DROP_WITH_BODY.has(tag)) continue;
    if (tag === "style") {
      if (closing) { out += "</style>"; continue; }
      const cm = html.slice(i).match(/<\/style\s*>/i);
      const body = cm ? html.slice(i, i + (cm.index ?? 0)) : html.slice(i);
      i = cm ? i + (cm.index ?? 0) + cm[0].length : n;
      out += `<style>${sanitizeCss(body)}</style>`;
      continue;
    }
    if (!MOCK_ELEMENTS.has(tag)) continue; // unknown element: its tags go, its text stays
    if (closing) { out += `</${name}>`; continue; }
    const region = m[3] ?? "";
    const selfClose = /\/\s*$/.test(region);
    let attrsOut = "";
    const seen = new Set<string>();
    for (const [an, av] of parseTagAttrs(region.replace(/\/\s*$/, ""))) {
      const k = keepAttr(tag, an, av);
      if (!k || seen.has(k[0].toLowerCase())) continue;
      seen.add(k[0].toLowerCase());
      attrsOut += k[1] === null ? ` ${k[0]}` : ` ${k[0]}="${escAttr(k[1])}"`;
    }
    out += `<${name}${attrsOut}${selfClose ? " /" : ""}>`;
  }
  return out;
}

/** Refuses a `src=` that names a secrets file, escapes the roots, or holds a secret line. */
function srcRefusal(src: string): string | null {
  if (SECRET_FILE.test(src)) return "names a secrets file";
  for (const root of exhibitRoots) {
    const full = resolve(root, src);
    if (!full.startsWith(root + "/")) return "points outside the ISA's folders";
    if (!existsSync(full)) continue;
    try {
      const real = realpathSync(full);
      if (!exhibitRoots.some((r) => real.startsWith(realpathSync(r) + "/"))) return "resolves outside the ISA's folders";
      if (SECRET_LINE.test(readFileSync(real, "utf-8"))) return "holds a line that looks like a secret";
    } catch { return "could not be read"; }
    return null;
  }
  return null; // not found: pack reports it as a lint error
}

function renderAsk(attrs: Array<[string, string | null]>, lines: string[]): string {
  askCount++;
  let id = attrs.find(([k]) => k === "id")?.[1] ?? null;
  if (!id) { id = `ask-${askCount}`; attrs = [["id", id], ...attrs]; }
  const question: string[] = [];
  const controls: string[] = [];
  const used = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const opt = line.match(/^(\(x\)|\( \)|\[x\]|\[ \])\s+(.+)$/i);
    const text = line.match(/^text:\s*(.*)$/i);
    if (opt) {
      const [valueOrLabel, label, small] = opt[2].split("|").map((x) => x.trim());
      // A label-only option gets a Unicode-aware slug; empty or repeated slugs get a number.
      let value = label === undefined
        ? valueOrLabel.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")
        : valueOrLabel;
      if (!value) value = `option-${controls.length + 1}`;
      for (let n = 2, base = value; used.has(value); n++) value = `${base}-${n}`;
      used.add(value);
      const shown = label ?? valueOrLabel;
      const type = opt[1].startsWith("(") ? "radio" : "checkbox";
      const checked = /x/i.test(opt[1]) ? " checked" : "";
      controls.push(`<label><input type="${type}" name="${escapeHtml(id)}" value="${escapeHtml(value)}"${checked}> ${escapeHtml(shown)}${small ? ` <small>${escapeHtml(small)}</small>` : ""}</label>`);
    } else if (text) {
      controls.push(`<textarea name="${escapeHtml(id)}-note" placeholder="${escapeHtml(text[1])}"></textarea>`);
    } else if (!controls.length) {
      question.push(line);
    }
  }
  // Lifecycle markers sit after the question paragraph (the first <p> stays the question).
  const attr = (n: string) => attrs.find(([k]) => k.toLowerCase() === n)?.[1]?.trim() ?? "";
  const status = attr("status").toLowerCase();
  const markers: string[] = [];
  if (status === "answered") {
    const when = attr("answered");
    if (!when) exhibitWarnings.push(`exhibit: ask ${id} is answered with no answered="YYYY-MM-DD" date`);
    markers.push(`<p class="ask-state" data-state="answered">Answered${when ? ` ${escapeHtml(when)}` : ""}</p>`);
  } else if (status === "default-unratified") {
    markers.push(`<p class="ask-state" data-state="default-unratified">Default taken without an answer, not yet ratified</p>`);
  }
  const blocks = attr("blocks").split(/\s+/).filter(Boolean);
  if (blocks.length) markers.push(`<p class="ask-blocks">Blocks ${blocks.map(escapeHtml).join(", ")}</p>`);
  return `<doc-ask${attrHtml(attrs)}><p>${renderInline(question.join(" "))}</p>${markers.join("")}${controls.join("")}</doc-ask>`;
}

const PIN_LINE = /^@pin\s+(\d+)\s+(?:(info|warn|risk|ok)\s+)?([^|\s][^|]*?)\s*(?:\|\s*(.*))?$/;

function renderExhibit(info: string, lines: string[]): string | null {
  const kind = info.match(/^([a-z]+)\b/)?.[1] ?? "";
  const tag = EXHIBIT_TAGS[kind];
  if (!tag) return null;
  const attrs = parseFenceAttrs(info.slice(kind.length), kind);
  const body = lines.join("\n");
  if (kind === "ask") { exhibitsUsed++; return renderAsk(attrs, lines); }
  if (kind === "mock") {
    if (/<\/template/i.test(body)) return null;
    exhibitsUsed++;
    return `<${tag}${attrHtml(attrs)}><template>${sanitizeMock(body)}</template></${tag}>`;
  }
  // `@pin <line> [tone] <title> | <body>` lines at the end of a code fence annotate it. A line
  // that does not parse as a pin stays in the code.
  let src = lines;
  const pins: string[] = [];
  if (kind === "code") {
    let m: RegExpMatchArray | null;
    while (src.length && (m = src[src.length - 1]!.trim().match(PIN_LINE))) {
      pins.unshift(`<doc-pin line="${m[1]}"${m[2] ? ` tone="${m[2]}"` : ""} title="${escapeHtml(m[3]!)}">${escapeHtml(m[4] ?? "")}</doc-pin>`);
      src = src.slice(0, -1);
    }
  }
  const text = src.join("\n");
  // `</script` would end the source early, and `<!--` can put the parser in a state where the
  // closing tag no longer closes. Either way the fence renders as plain code.
  if (/<\/script|<!--/i.test(text)) return null;
  const cited = attrs.find(([k]) => k === "src")?.[1];
  if (cited) {
    const why = srcRefusal(cited);
    if (why) { exhibitWarnings.push(`exhibit: refused src="${cited}": it ${why}`); return null; }
  }
  exhibitsUsed++;
  // `src=` with an empty body cites real code: pack fills it from the repo, but only when the
  // element carries no inline source of its own.
  if ((kind === "code" || kind === "schema") && cited && !text.trim()) {
    return `<${tag}${attrHtml(attrs)}>${pins.join("")}</${tag}>`;
  }
  return `<${tag}${attrHtml(attrs)}><script type="text/plain">${text}</script>${pins.join("")}</${tag}>`;
}

// ─────────── RUNTIME + LINT ───────────

const HTMLPLAN_DIR = join(TOOLS_DIR, "ISARender/htmlplan");

// The page links the runtime the way upstream pages do, so pack lints the page and not the
// runtime source, then inlines both files. inlineRuntime() does the same when lint fails.
const RUNTIME_LINK = `<link rel="stylesheet" href="htmlplan.css">`;
const RUNTIME_SRC = `<script src="htmlplan.js" defer></script>`;

function runtimeHead(): string {
  return `\n${RUNTIME_LINK}`;
}

function runtimeScript(): string {
  const bridge = readFileSync(join(HTMLPLAN_DIR, "bridge.css"), "utf-8");
  return `\n<style data-isa-bridge>\n${bridge}\n</style>\n${RUNTIME_SRC}`;
}

/** The policy a packed ISA page carries: it runs its own inline script and style, shows data:
 *  media, and can load or send nothing else. pack.mjs injects the same text; keep them equal. */
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`;

/** Adds the page policy to a page that lacks one (the unpacked fallback path). */
function withPageCsp(html: string): string {
  if (/http-equiv=["']?content-security-policy/i.test(html)) return html;
  return html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${CSP_META}`);
}

function inlineRuntime(html: string): string {
  const css = readFileSync(join(HTMLPLAN_DIR, "htmlplan.css"), "utf-8");
  const js = readFileSync(join(HTMLPLAN_DIR, "htmlplan.js"), "utf-8").replaceAll("</script", "<\\/script");
  return html
    .replace(RUNTIME_LINK, () => `<style data-htmlplan>\n${css}\n</style>`)
    .replace(RUNTIME_SRC, () => `<script data-htmlplan>\n${js}\n</script>`);
}

/** Runs the upstream pack over the page: lint, then fill `src=` code from disk. A lint error
 *  keeps the unpacked page and becomes a render warning; it never stops the render. */
function packPage(html: string): { html: string; warnings: string[] } {
  const tmp = mkdtempSync(join(tmpdir(), "isarender-pack-"));
  try {
    const inPath = join(tmp, "page.html");
    const outPath = join(tmp, "page.packed.html");
    writeFileSync(inPath, html);
    // Roots are the ISA folder and an explicit exhibit_root, never the enclosing git repo: for a
    // MEMORY ISA that repo is the private USER tree.
    const r = spawnSync("bun", [join(HTMLPLAN_DIR, "pack.mjs"), inPath, "-o", outPath, ...exhibitRoots.flatMap((x) => ["--root", x])], { encoding: "utf8", timeout: 30_000 });
    const lines = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n").map((l) => l.trim());
    const errors = lines.filter((l) => l.startsWith("✗") && !/^✗ \d+ error\(s\)/.test(l)).map((l) => `exhibit-lint: ${l.replace(/^✗\s*/, "")}`);
    if (r.status === 0 && existsSync(outPath)) return { html: readFileSync(outPath, "utf-8"), warnings: [] };
    if (!errors.length) errors.push(`exhibit-lint: pack exited ${r.status ?? "on a timeout"} without output`);
    return { html: inlineRuntime(html), warnings: errors };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─────────── PHASE BAR ───────────

function renderPhaseBar(currentPhase: string): string {
  const cur = (currentPhase || "marking").toLowerCase();
  const curIdx = STAGE_MAP[cur] ?? 0;
  return STAGES.map((p, i) => {
    const classes = ["phase-slot"];
    if (i === curIdx) classes.push("active");
    else if (i < curIdx) classes.push("passed");
    return `<div class="${classes.join(" ")}"><div class="dot"></div><div class="label">${ASCENT[p].icon} ${ASCENT[p].label}</div></div>`;
  }).join("");
}

// ─────────── HERO BADGES ───────────
// Tier badge removed 2026-07-23 — effort tiers were retired 2026-07-11.

function renderHeroBadges(fm: Frontmatter): string {
  const badges: string[] = [];
  if (fm.phase) {
    const state = PHASE_TO_ASCENT[fm.phase.toLowerCase()] ?? "marking";
    const stageClass = state === "cairn" ? "complete" : state;
    badges.push(`<span class="badge phase ${stageClass}"><span class="label">Phase</span> ${ASCENT[state].icon} ${ASCENT[state].label.toUpperCase()}</span>`);
  }
  if (fm.iteration && parseInt(fm.iteration, 10) > 1) {
    badges.push(`<span class="badge phase"><span class="label">Iteration</span> ×${escapeHtml(fm.iteration)}</span>`);
  }
  return badges.join(" ");
}

// ─────────── BRAND TAG (top-right of the brand bar) ───────────
// Formerly the effort-tier display; now a criteria summary.

function renderBrandTag(fm: Frontmatter, body: string): string {
  const m = (fm.progress || "").match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) return `${m[1]}/${m[2]} criteria closed`;
  const total = countISCs(body);
  if (total > 0) {
    let closed = 0;
    for (const line of body.split("\n")) {
      const row = parseISCLine(line);
      if (row?.status === "passed") closed++;
    }
    return `${closed}/${total} criteria closed`;
  }
  return "Ideal State Artifact";
}

// ─────────── PROGRESS RAIL ───────────
function renderProgressRail(fm: Frontmatter): string {
  if (!fm.progress) return "";
  const m = fm.progress.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return "";
  const done = parseInt(m[1], 10);
  const total = parseInt(m[2], 10);
  if (!total) return "";
  const pct = Math.round((done / total) * 100);
  return `<div class="progress-rail">
    <span class="text">PROGRESS</span>
    <div class="rail"><div class="fill" style="width:${pct}%"></div></div>
    <span class="text"><span class="num">${done}</span> / ${total} <span style="opacity:.6">·</span> ${pct}%</span>
  </div>`;
}

// ─────────── TABLE OF CONTENTS ───────────
function renderTOC(sections: Section[]): string {
  return sections.map((s, i) => {
    const num = String(i + 1).padStart(2, "0");
    return `<li><a href="#section-${s.slug}"><span class="toc-num">${num}</span>${escapeHtml(s.name)}</a></li>`;
  }).join("");
}

// ─────────── ISC COUNTS STRIP ───────────
function renderISCCounts(body: string): string {
  const counts = { pending: 0, passed: 0, deferred: 0, anti: 0, antecedent: 0 };
  const scoped = "## Claims\n" + body;
  const lines = scoped.split(/\r?\n/);
  for (const claim of parseIsaClaimsText(scoped).claims) {
    const line = lines[claim.line - 1]!;
    const row = parseISCLine(line);
    if (!row) continue;
    if (row.kind === "anti") counts.anti++;
    else if (row.kind === "antecedent") counts.antecedent++;
    else if (row.status === "passed") counts.passed++;
    else if (row.status === "deferred") counts.deferred++;
    else counts.pending++;
  }
  const items: string[] = [];
  if (counts.passed)     items.push(`<span class="isc-count passed"><span class="dot"></span><span class="n">${counts.passed}</span><span class="lbl">passed</span></span>`);
  if (counts.pending)    items.push(`<span class="isc-count pending"><span class="dot"></span><span class="n">${counts.pending}</span><span class="lbl">pending</span></span>`);
  if (counts.deferred)   items.push(`<span class="isc-count deferred"><span class="dot"></span><span class="n">${counts.deferred}</span><span class="lbl">deferred</span></span>`);
  if (counts.anti)       items.push(`<span class="isc-count anti"><span class="dot"></span><span class="n">${counts.anti}</span><span class="lbl">anti</span></span>`);
  if (counts.antecedent) items.push(`<span class="isc-count antecedent"><span class="dot"></span><span class="n">${counts.antecedent}</span><span class="lbl">antecedent</span></span>`);
  if (!items.length) return "";
  return `<div class="isc-counts">${items.join("")}</div>`;
}

// ─────────── HERO CALLOUT ───────────

// The ladder's L3 leads the page: direction is the first thing a reader checks
// (ISAFormat v2.28.0). The principal's verbatim words sit under it.
function renderHeroCallout(fm: Frontmatter, raw: string): string {
  const l3 = parseLadder(raw).l3;
  const parts: string[] = [];
  if (l3) parts.push(`<aside class="hero-callout">
    <div class="hero-callout-label">Ideal state · L3</div>
    <div class="hero-callout-text">${renderInline(l3)}</div>
  </aside>`);
  if (fm.principal_stated_goal) parts.push(`<aside class="hero-callout">
    <div class="hero-callout-label">Principal-stated goal</div>
    <div class="hero-callout-text">${escapeHtml(fm.principal_stated_goal)}</div>
  </aside>`);
  return parts.join("\n");
}

// ─────────── WARNINGS ───────────

function renderWarnings(warnings: string[]): string {
  if (!warnings.length) return "";
  const items = warnings.map(w => `<li>${escapeHtml(w)}</li>`).join("");
  return `<div style="padding:0 56px;">
    <div class="warning-callout">
      <div class="label">Render warnings</div>
      <ul>${items}</ul>
    </div>
  </div>`;
}

// ─────────── INTERCEPTOR REFRESH ───────────

async function refreshInterceptorTabs(htmlPath: string): Promise<{ refreshed: number; warning?: string }> {
  const fileUrl = `file://${htmlPath}`;
  try {
    const tabsOut = await runCmd("interceptor", ["tabs", "--json"], 5000);
    if (!tabsOut.ok) return { refreshed: 0, warning: `interceptor tabs failed: ${tabsOut.stderr.slice(0, 100)}` };
    let tabs: any[] = [];
    try {
      const parsed = JSON.parse(tabsOut.stdout);
      tabs = Array.isArray(parsed) ? parsed : (parsed.data ?? parsed.tabs ?? parsed.result ?? []);
    } catch {
      return { refreshed: 0, warning: "interceptor tabs returned non-JSON" };
    }
    const matches = tabs.filter(t => t.url && (t.url === fileUrl || t.url.endsWith(htmlPath) || t.url.includes(htmlPath)));
    if (matches.length === 0) return { refreshed: 0 };

    // Strategy: keystroke-based reload (Meta+r on macOS) is the most reliable
    // primitive — `interceptor tab switch` and `interceptor navigate` against
    // file:// URLs are flaky when the extension service worker is asleep.
    // Sending a keypress to the active tab works as long as the matching tab
    // is foregrounded (which it typically is when the principal is reading the ISA).
    const reloadKey = process.platform === "darwin" ? "Meta+r" : "Control+r";
    let refreshed = 0;
    const activeMatch = matches.find(t => t.active);
    if (activeMatch) {
      const rl = await runCmd("interceptor", ["keys", reloadKey], 1500);
      if (rl.ok) refreshed++;
    }
    for (const tab of matches) {
      if (tab === activeMatch) continue;
      const tabId = tab.id ?? tab.tabId;
      if (tabId == null) continue;
      const sw = await runCmd("interceptor", ["tab", "switch", String(tabId)], 1500);
      if (!sw.ok) continue;
      const rl = await runCmd("interceptor", ["keys", reloadKey], 1500);
      if (rl.ok) refreshed++;
    }
    return { refreshed };
  } catch (e: any) {
    return { refreshed: 0, warning: `interceptor unavailable: ${e?.message ?? "unknown"}` };
  }
}

function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; proc.kill(); resolve({ ok: false, stdout, stderr: stderr + " [timeout]" }); } }, timeoutMs);
    proc.stdout.on("data", (d) => stdout += d.toString());
    proc.stderr.on("data", (d) => stderr += d.toString());
    proc.on("close", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr }); } });
    proc.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, stdout, stderr: e.message }); } });
  });
}

// ─────────── MAIN ───────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error("Usage: bun ISARender.ts <slug-or-path> [--no-refresh] [--output <path>] [--stdout]");
    process.exit(1);
  }
  const isaPath = resolveISAPath(args.input);
  const isaDir = dirname(isaPath);
  const outPath = args.output ? resolve(args.output) : join(isaDir, "ISA.html");

  // mtime-equality skip
  if (!args.stdout && !args.output && existsSync(outPath)) {
    const isaMtime = statSync(isaPath).mtimeMs;
    const htmlMtime = statSync(outPath).mtimeMs;
    if (htmlMtime >= isaMtime) {
      // Already fresh — just refresh tab and exit
      if (!args.noRefresh) {
        const r = await refreshInterceptorTabs(outPath);
        if (r.refreshed > 0) console.log(JSON.stringify({ status: "fresh", refreshed: r.refreshed, path: outPath }));
        else console.log(JSON.stringify({ status: "fresh", refreshed: 0, path: outPath, ...(r.warning ? { warning: r.warning } : {}) }));
      } else {
        console.log(JSON.stringify({ status: "fresh", path: outPath }));
      }
      return;
    }
  }

  const src = readFileSync(isaPath, "utf-8");
  const { fm, body, warnings } = parseFrontmatter(src);
  const sections = splitSections(body);
  // `exhibit_root:` (absolute, ~/, or relative to the ISA) lets src= fences cite code elsewhere.
  const extraRoot = fm.exhibit_root ? resolve(isaDir, fm.exhibit_root.replace(/^~(?=\/)/, HOME)) : null;
  exhibitRoots = [isaDir, ...(extraRoot && existsSync(extraRoot) ? [extraRoot] : [])];

  // Render sections — section eyebrow + h2 with anchor-link + body. Criteria
  // gets a counts strip injected at the top.
  const sectionHtml = sections.map((s, i) => {
    const inner = renderSectionBody(s);
    const num = String(i + 1).padStart(2, "0");
    const eyebrow = `  <div class="section-eyebrow"><span class="num">${num}</span>${escapeHtml(s.name)}</div>`;
    const countsStrip = (s.slug === "criteria" || s.slug === "claims" || s.slug === "features") ? renderISCCounts(body) : "";
    return `${eyebrow}
  <section class="section section-${s.slug}" id="section-${s.slug}">
    <h2>${escapeHtml(s.name)} <a class="anchor-link" href="#section-${s.slug}" aria-label="link to section">#</a></h2>
${countsStrip}
${inner}
  </section>`;
  }).join("\n\n");
  // Exhibit pages wrap the sections in <main>, where the runtime adds its comment buttons.
  const sectionsOut = exhibitsUsed ? `<main class="isa-main">\n${sectionHtml}\n</main>` : sectionHtml;

  // Load template
  const tplHtml = readFileSync(TEMPLATE_HTML, "utf-8");
  const css = readFileSync(TEMPLATE_CSS, "utf-8");

  const renderedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  // Footer path is home-relative (~/…) — an absolute /Users/<name>/ literal is a
  // machine-bound, unpublishable identity leak in a rendered artifact (skill-hygiene
  // gate violation). Swap the HOME prefix for ~ so the footer stays informative.
  const footerPath = isaPath.startsWith(HOME) ? "~" + isaPath.slice(HOME.length) : isaPath;
  // Minimal-frontmatter fallbacks: title from `task:`, `title:`, or the H1.
  const h1 = body.match(/^#\s+(?:ISA\s*[—–:-]\s*)?(.+?)\s*$/m)?.[1];
  const taskDisplay = fm.task || fm.title || h1 || "(untitled ISA)";
  let html = tplHtml
    .replaceAll("{{RUNTIME_HEAD}}", () => (exhibitsUsed ? runtimeHead() : ""))
    .replaceAll("{{RUNTIME_SCRIPT}}", () => (exhibitsUsed ? runtimeScript() : ""))
    .replaceAll("{{TITLE}}", escapeHtml(taskDisplay))
    .replaceAll("{{CSS}}", css)
    .replaceAll("{{BRAND_LOGO_B64}}", loadBrandLogoB64())
    .replaceAll("{{TASK}}", renderInline(taskDisplay))
    .replaceAll("{{SLUG}}", escapeHtml(fm.slug || basename(isaDir)))
    .replaceAll("{{UPDATED}}", escapeHtml(fm.updated || "—"))
    .replaceAll("{{BRAND_TAG}}", escapeHtml(renderBrandTag(fm, body)))
    .replaceAll("{{HERO_BADGES}}", renderHeroBadges(fm))
    .replaceAll("{{HERO_CALLOUT}}", renderHeroCallout(fm, src))
    .replaceAll("{{PROGRESS_RAIL}}", renderProgressRail(fm))
    .replaceAll("{{PHASE_BAR}}", renderPhaseBar(fm.phase || "observe"))
    .replaceAll("{{TOC}}", renderTOC(sections))
    .replaceAll("{{SECTIONS}}", () => sectionsOut)
    .replaceAll("{{FOOTER_LEFT}}", escapeHtml(footerPath))
    .replaceAll("{{RENDERED_AT}}", escapeHtml(renderedAt));
  // Lint and pack before the warnings land, so lint findings show in the warnings callout.
  if (exhibitsUsed) {
    const packed = packPage(html);
    html = withPageCsp(packed.html);
    warnings.push(...packed.warnings);
  }
  warnings.push(...exhibitWarnings);
  html = html.replace("{{WARNINGS}}", () => renderWarnings(warnings));

  if (args.stdout) { process.stdout.write(html); return; }

  // Atomic write
  const tmpPath = outPath + ".tmp";
  writeFileSync(tmpPath, html, "utf-8");
  renameSync(tmpPath, outPath);

  let refreshInfo: { refreshed: number; warning?: string } = { refreshed: 0 };
  if (!args.noRefresh) refreshInfo = await refreshInterceptorTabs(outPath);

  console.log(JSON.stringify({
    status: "rendered",
    path: outPath,
    bytes: html.length,
    isc_count: countISCs(body),
    warnings,
    refreshed: refreshInfo.refreshed,
    ...(refreshInfo.warning ? { refresh_warning: refreshInfo.warning } : {}),
  }, null, 2));
}

function countISCs(body: string): number {
  return parseIsaClaimsText(body).claims.length;
}

main().catch(e => { console.error("ISARender error:", e?.stack ?? e?.message ?? e); process.exit(1); });
