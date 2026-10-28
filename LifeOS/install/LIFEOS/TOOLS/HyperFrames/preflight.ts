/**
 * Static preflight: the rules HyperFrames' own lint does not enforce, checked over every
 * authored file in a project before anything launches a browser.
 *
 * Two families:
 *  - offline: no remote URL anywhere, and every font-family backed by an @font-face. A
 *    family without a face makes the HyperFrames compiler call Google Fonts with a `text=`
 *    parameter holding every character on the page (measured in 0.8.71's deterministicFonts).
 *  - seek-safety: the gotchas that render a composition wrong under frame seeking.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

export type Severity = "error" | "warning";
export interface Finding { source: "preflight" | "lint" | "check" | "probe" | "validate"; severity: Severity; code: string; message: string; file?: string; line?: number }

const SKIP_DIRS = new Set(["vendor", "node_modules", "renders", "snapshots", ".git", ".hf-segments"]);
const AUTHORED_EXT = new Set([".html", ".htm", ".css", ".js", ".mjs"]);
const GENERIC_FAMILIES = new Set(["sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong", "-apple-system", "blinkmacsystemfont", "inherit", "initial", "unset", "revert", "revert-layer"]);

/** Every authored file under the project, skipping vendored and generated directories. */
export function authoredFiles(projectDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name) && !name.startsWith(".")) walk(full); continue; }
      if (AUTHORED_EXT.has(extname(name).toLowerCase())) out.push(full);
    }
  };
  walk(projectDir);
  return out.sort();
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Blank out comments (keeping offsets) so a rule never fires on prose that mentions a banned call. */
function stripComments(text: string, kind: "html" | "css" | "js"): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  let t = text;
  if (kind === "html") t = t.replace(/<!--[\s\S]*?-->/g, blank);
  t = t.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (kind !== "css") t = t.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, pre: string) => pre + blank(m.slice(pre.length)));
  return t;
}

/** Scripts inside an HTML file, as [offset, body] so line numbers stay right. */
function scriptBodies(html: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push([m.index + m[0].indexOf(">") + 1, m[1] ?? ""]);
  return out;
}

function styleBodies(html: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push([m.index + m[0].indexOf(">") + 1, m[1] ?? ""]);
  // Inline style attributes count as CSS too.
  const attr = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
  for (let m = attr.exec(html); m; m = attr.exec(html)) out.push([m.index, m[2] ?? m[3] ?? ""]);
  return out;
}

const REMOTE = /^\s*(https?:)?\/\//i;

const JS_RULES: Array<{ code: string; re: RegExp; message: string }> = [
  { code: "nondeterministic-clock", re: /\bDate\.now\s*\(|\bnew\s+Date\s*\(|\bperformance\.now\s*\(/g, message: "wall-clock read: a frame must depend only on its time, never on when it was captured" },
  { code: "nondeterministic-raf", re: /\brequestAnimationFrame\s*\(/g, message: "requestAnimationFrame is not seeked; drive motion from the paused GSAP timeline" },
  { code: "nondeterministic-random", re: /\bMath\.random\s*\(/g, message: "unseeded Math.random: use a seeded PRNG so every render is identical" },
  { code: "nondeterministic-timer", re: /\bsetInterval\s*\(/g, message: "setInterval is wall-clock driven; express the change on the timeline" },
  { code: "network-api", re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\s*\(|\bimport\s*\(\s*["'`]https?:/g, message: "network API in a composition: every asset must be local and loaded before frame 0" },
];

const CSS_RULES: Array<{ code: string; re: RegExp; message: string }> = [
  { code: "negative-z-index", re: /z-index\s*:\s*-\s*\d/gi, message: "z-index below 0 puts the element behind the clip's stacking context and it does not render; layer with positive z-index" },
];

/** font-family values used anywhere, and the families that have an @font-face. */
function fontFamilies(css: string): { requested: Map<string, number>; declared: Set<string> } {
  const requested = new Map<string, number>();
  const declared = new Set<string>();
  const faceRe = /@font-face\s*\{([^}]*)\}/gi;
  const faceSpans: Array<[number, number]> = [];
  for (let m = faceRe.exec(css); m; m = faceRe.exec(css)) {
    faceSpans.push([m.index, m.index + m[0].length]);
    const fam = /font-family\s*:\s*([^;]+)/i.exec(m[1] ?? "");
    if (fam) declared.add(normalizeFamily(fam[1]!));
  }
  const declRe = /font-family\s*:\s*([^;}"]+|"[^"]*"[^;}]*)/gi;
  for (let m = declRe.exec(css); m; m = declRe.exec(css)) {
    if (faceSpans.some(([a, b]) => m!.index >= a && m!.index < b)) continue;
    for (const part of m[1]!.split(",")) {
      const fam = normalizeFamily(part);
      if (!fam || GENERIC_FAMILIES.has(fam) || fam.startsWith("var(")) continue;
      if (!requested.has(fam)) requested.set(fam, m.index);
    }
  }
  // font shorthand: `font: 700 32px "House Sans", sans-serif`
  const shortRe = /(^|[;{\s])font\s*:\s*[^;}]*?\d(px|em|rem|pt|%)\s*(\/\s*[\d.]+\w*\s*)?([^;}]+)/gi;
  for (let m = shortRe.exec(css); m; m = shortRe.exec(css)) {
    for (const part of (m[4] ?? "").split(",")) {
      const fam = normalizeFamily(part);
      if (!fam || GENERIC_FAMILIES.has(fam) || fam.startsWith("var(")) continue;
      if (!requested.has(fam)) requested.set(fam, m.index);
    }
  }
  return { requested, declared };
}

function normalizeFamily(raw: string): string {
  return raw.replace(/!important/i, "").trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
}

/**
 * Generic families the pinned compiler replaces with a face of another class. HyperFrames 0.8.71 prepends Inter to
 * every font stack (and every `--*` custom property) whose first family is generic, on the render path only
 * (compileForRender → normalizeSystemFontPrimaryFamilies); snapshots skip that step, so stills keep the generic face
 * and every check passes while the MP4 is set in Inter (2026-10-24: a monospace film shipped in sans).
 */
const CLASS_CHANGING_GENERICS = new Set(["monospace", "ui-monospace", "serif", "ui-serif", "cursive", "fantasy", "math", "fangsong"]);

/** The first family of a font stack, normalized; undefined for an empty value. */
function firstFamily(value: string): string | undefined {
  const first = value.split(",")[0];
  return first === undefined ? undefined : normalizeFamily(first) || undefined;
}

/** `font-family` declarations outside @font-face, every `--*` custom property value, and the props a `font`/`font-family` references. */
function fontStacks(css: string): { decls: Array<{ value: string; index: number }>; props: Array<{ name: string; value: string; index: number }>; uses: Set<string> } {
  const faces: Array<[number, number]> = [];
  for (const m of css.matchAll(/@font-face\s*\{[^}]*\}/gi)) faces.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const inFace = (i: number) => faces.some(([a, b]) => i >= a && i < b);
  const decls: Array<{ value: string; index: number }> = [];
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) if (!inFace(m.index ?? 0)) decls.push({ value: m[1]!.trim(), index: m.index ?? 0 });
  const props: Array<{ name: string; value: string; index: number }> = [];
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) props.push({ name: m[1]!, value: m[2]!.trim(), index: m.index ?? 0 });
  const uses = new Set<string>();
  // Only a prop in FIRST family position renders: after a real face it is a fallback, and the rewrite never shows.
  const first = (families: string) => /^var\(\s*(--[\w-]+)/.exec(families.trim())?.[1];
  for (const m of css.matchAll(/(^|[;{\s])font-family\s*:\s*([^;}]+)/gi)) { const u = first(m[2]!); if (u) uses.add(u); }
  for (const m of css.matchAll(/(^|[;{\s])font\s*:\s*[^;}]*?\d[\w.%]*\s*(\/\s*[\w.%]+\s*)?(var\([^;}]+)/gi)) { const u = first(m[3]!); if (u) uses.add(u); }
  return { decls, props, uses };
}

/** Run every preflight rule over a project. Pure read; returns findings, never throws on content. */
export function preflight(projectDir: string): Finding[] {
  const findings: Finding[] = [];
  const allCss: Array<{ file: string; offset: number; text: string; full: string }> = [];
  for (const path of authoredFiles(projectDir)) {
    const file = relative(projectDir, path);
    const raw = readFileSync(path, "utf8");
    const ext = extname(path).toLowerCase();
    const push = (severity: Severity, code: string, message: string, index: number, full: string) => findings.push({ source: "preflight", severity, code, message, file, line: lineOf(full, index) });
    if (ext === ".html" || ext === ".htm") {
      const html = stripComments(raw, "html");
      const attrRe = /\s(src|href|poster|data-composition-src|data-src|srcset)\s*=\s*("([^"]*)"|'([^']*)')/gi;
      for (let m = attrRe.exec(html); m; m = attrRe.exec(html)) {
        const value = m[3] ?? m[4] ?? "";
        if (REMOTE.test(value)) push("error", "remote-url", `remote ${m[1]} "${value}": HyperFrames fetches it at compile or render time; stage the file locally (GSAP: stageGsap())`, m.index, html);
      }
      const videoRe = /<video\b[^>]*>/gi;
      for (let m = videoRe.exec(html); m; m = videoRe.exec(html)) {
        if (/data-playback-start\s*=/.test(m[0]) && !/data-media-start\s*=/.test(m[0])) push("error", "video-trim-attr", "trimmed <video> uses data-playback-start only: the audio mixer reads data-media-start, so picture and sound would disagree", m.index, html);
      }
      for (const [offset, body] of scriptBodies(html)) {
        const js = stripComments(body, "js");
        for (const rule of JS_RULES) for (const hit of js.matchAll(rule.re)) push("error", rule.code, rule.message, offset + (hit.index ?? 0), html);
      }
      for (const [offset, body] of styleBodies(html)) allCss.push({ file, offset, text: stripComments(body, "css"), full: html });
    } else if (ext === ".css") {
      allCss.push({ file, offset: 0, text: stripComments(raw, "css"), full: raw });
    } else {
      const js = stripComments(raw, "js");
      for (const rule of JS_RULES) for (const hit of js.matchAll(rule.re)) push("error", rule.code, rule.message, hit.index ?? 0, raw);
    }
  }
  const declared = new Set<string>();
  const requested: Array<{ fam: string; file: string; line: number }> = [];
  const props: Array<{ name: string; value: string; file: string; line: number }> = [];
  const propUses = new Set<string>();
  const genericPrimary = (value: string, file: string, line: number, via: string) => {
    const fam = firstFamily(value);
    // ui-rounded is not in the compiler's generic set, so it is never rewritten.
    if (!fam || !GENERIC_FAMILIES.has(fam) || ["inherit", "initial", "unset", "revert", "revert-layer", "ui-rounded"].includes(fam)) return;
    const changes = CLASS_CHANGING_GENERICS.has(fam);
    findings.push({ source: "preflight", severity: changes ? "error" : "warning", code: "font-generic-primary", message: `${via}font stack "${value}" starts with the generic "${fam}": the render compiler puts Inter first on the MP4 only, so stills show ${changes ? `a ${fam} face` : "the system face"} while the film is set in Inter; name an embedded face first (roleFaces() / embedFonts())`, file, line });
  };
  for (const block of allCss) {
    const at0 = (i: number) => lineOf(block.full, block.offset + i);
    const stacks = fontStacks(block.text);
    for (const d of stacks.decls) if (!/^var\(/.test(d.value)) genericPrimary(d.value, block.file, at0(d.index), "");
    for (const p of stacks.props) props.push({ name: p.name, value: p.value, file: block.file, line: at0(p.index) });
    for (const u of stacks.uses) propUses.add(u);
  }
  // A prop a font prop references is a font prop too (--m: var(--a)); the compiler rewrites every declaration of it.
  for (let grew = true; grew;) {
    grew = false;
    for (const p of props) { const v = /^var\(\s*(--[\w-]+)/.exec(p.value)?.[1]; if (propUses.has(p.name) && v && !propUses.has(v)) { propUses.add(v); grew = true; } }
  }
  for (const p of props) if (propUses.has(p.name) && !/^var\(/.test(p.value)) genericPrimary(p.value, p.file, p.line, `${p.name}, used in a font: `);
  for (const block of allCss) {
    const at = (i: number) => lineOf(block.full, block.offset + i);
    for (const rule of CSS_RULES) for (const hit of block.text.matchAll(rule.re)) findings.push({ source: "preflight", severity: "error", code: rule.code, message: rule.message, file: block.file, line: at(hit.index ?? 0) });
    for (const hit of block.text.matchAll(/(^|[;{\s])transition(-duration)?\s*:\s*([^;}]*)/gi)) {
      const value = (hit[3] ?? "").trim().toLowerCase();
      if (value === "" || value === "none" || /^(all\s+)?0m?s?$/.test(value)) continue;
      findings.push({ source: "preflight", severity: "error", code: "css-transition", message: "CSS transition is not seek-safe: it animates in wall time, so seeked frames land mid-transition or skip it; animate with GSAP", file: block.file, line: at(hit.index ?? 0) });
    }
    const urlRe = /url\(\s*["']?((https?:)?\/\/[^"')]+)|@import\s+["']((https?:)?\/\/[^"']+)/gi;
    for (let m = urlRe.exec(block.text); m; m = urlRe.exec(block.text)) findings.push({ source: "preflight", severity: "error", code: "remote-url", message: `remote CSS resource "${m[1] ?? m[3]}": everything must be local`, file: block.file, line: at(m.index) });
    const fams = fontFamilies(block.text);
    for (const f of fams.declared) declared.add(f);
    for (const [fam, idx] of fams.requested) requested.push({ fam, file: block.file, line: at(idx) });
  }
  const reported = new Set<string>();
  for (const r of requested) {
    if (declared.has(r.fam) || reported.has(r.fam)) continue;
    reported.add(r.fam);
    findings.push({ source: "preflight", severity: "error", code: "font-not-embedded", message: `font-family "${r.fam}" has no @font-face: the compiler would fetch it from Google Fonts, sending the page's characters; embed it with embedFonts()`, file: r.file, line: r.line });
  }
  return findings;
}
