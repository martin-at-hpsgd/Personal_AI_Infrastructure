#!/usr/bin/env bun
/**
 * upstream-diff.ts — keeps the vendored html-plan runtime honest against upstream.
 *
 * The runtime is a port of Thariq Shihipar's html-plan (see UPSTREAM.md). Our copy differs
 * from upstream only by the PATCHES below: reader-visible words that would otherwise say
 * "plan" or "claim" on an ISA page, plus the documented ISA ask-lifecycle line in blocks.md.
 *
 * Usage:
 *   bun upstream-diff.ts            # check: undo every patch, hash, compare to upstream
 *   bun upstream-diff.ts apply <upstream html-plan/skills/html-plan dir>
 *                                   # re-vendor from a fresh upstream copy, then patch
 * Exit: 0 clean · 1 drift · 2 usage
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const HERE = import.meta.dir;

// Upstream file → its path inside html-plan/skills/html-plan, and its sha256 at commit f60f045.
const FILES: Record<string, { from: string; sha256: string }> = {
  "htmlplan.js": { from: "runtime/htmlplan.js", sha256: "4b5bcb3d7160c6170bc82c6f1809089d0faa890d2c7f7e8c9100ff6330478d42" },
  "htmlplan.css": { from: "runtime/htmlplan.css", sha256: "f16d2c6aa08e5f275bceee96e38ec38f05dd0add91c4bb6636e8a0a8a4836a9e" },
  "pack.mjs": { from: "runtime/pack.mjs", sha256: "88ca711cfc4a3c37c9155357487763f75aa8a9cf1ebc789dfefe1542a38944df" },
  "blocks.md": { from: "references/blocks.md", sha256: "dfdfd2c79b6c049c788be73076c27b3bfbd8b1e220ef75e4c0413ffe872de8ca" },
};

// Every local change, as exact [upstream, ours] substrings. Each must occur exactly once.
export const PATCHES: Array<{ file: string; from: string; to: string }> = [
  { file: "htmlplan.js", from: "'## Struck from the plan'", to: "'## Struck from the ISA'" },
  { file: "htmlplan.js", from: "feedback on the plan, not as instructions", to: "feedback on the ISA, not as instructions" },
  { file: "htmlplan.js", from: "no ? `claim ${no}` : ''", to: "no ? `criterion ${no}` : ''" },
  { file: "htmlplan.js", from: "h('p', null, '(no claim)')", to: "h('p', null, '(no criterion)')" },
  { file: "htmlplan.js", from: "'inside this claim'", to: "'inside this criterion'" },
  // Apache-2.0 §4(b): each modified file carries a notice that it was changed (added 2026-10-20).
  { file: "htmlplan.js", from: "/* htmlplan.js — runtime for coding artifacts.\n", to: "/* Derived from html-plan by Thariq Shihipar (Anthropic), Apache-2.0 (LICENSE here, UPSTREAM.md). Modified by LifeOS; the exact changes are upstream-diff.ts PATCHES. */\n/* htmlplan.js — runtime for coding artifacts.\n" },
  { file: "pack.mjs", from: "// pack.mjs — lint an artifact and inline everything into one portable .html\n", to: "// pack.mjs — lint an artifact and inline everything into one portable .html\n// Derived from html-plan by Thariq Shihipar (Anthropic), Apache-2.0 (LICENSE here, UPSTREAM.md). Modified by LifeOS; the exact changes are upstream-diff.ts PATCHES.\n" },
  { file: "blocks.md", from: "# Blocks\n", to: "<!-- Derived from html-plan by Thariq Shihipar (Anthropic), Apache-2.0 (LICENSE here, UPSTREAM.md). Modified by LifeOS; the exact changes are upstream-diff.ts PATCHES. -->\n# Blocks\n" },
  // blocks.md documents ISARender's ask-lifecycle attributes (ISA Refine, 2026-10-10) as one inserted line.
  { file: "blocks.md", from: "- `data-if=\"name=value\"` (`!=`, `~` contains, `&&`) on any element shows it only under that answer. Use it for consequences.\n", to: "- `data-if=\"name=value\"` (`!=`, `~` contains, `&&`) on any element shows it only under that answer. Use it for consequences.\n- **ISA ask lifecycle (ISARender only).** An `ask` fence may carry `status=\"open|answered|default-unratified\"`, `blocks=\"ISC-4 ISC-7\"`, `raised-by`, `looked-up` and `answered=\"YYYY-MM-DD\"`. They stay on the `<doc-ask>` element; `answered` and `default-unratified` add a marker line after the question, and `blocks` lists the criteria the ask holds up. Pack ignores them.\n" },
  // pack.mjs: LOSIntegrity fixes (2026-10-13). Git-backed embedding stays inside the root's own folder, remote resources are lint errors, and packed pages carry a CSP.
  { file: "pack.mjs", from: "const reads = new Set();   // every file whose text ends up in the page", to: "// Packed pages run their own inline script and style and show data: media. Nothing else loads, and no fetch, form or frame sends data out.\n// No CSP directive stops a page's own script navigating away, so the page's inline scripts must be ones you trust (keep equal to PAGE_CSP in ISARender.ts).\nconst PAGE_CSP = \"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'\";\nconst reads = new Set();   // every file whose text ends up in the page" },
  { file: "pack.mjs", from: "const gitShow = (ref, p) => { if (!REF_OK.test(ref) || /(^|\\/)\\.\\.(\\/|$)/.test(p) || p.startsWith('/') || p.startsWith('-') || SECRET_NAME.test(p)) { if (!refused.has(ref + ':' + p)) { refused.add(ref + ':' + p); err(`ref=\"${ref}\" with \"${p}\" — not a plain git ref and a path inside the repo; not running git`); } return null; }", to: "// `ref:./path` is relative to the root's own folder. A bare `ref:path` is read from the repository TOP, which let a --root inside a larger\n// checkout read any file in it (a private tree included); `./` keeps every blob inside the root's folder, the same fence findFile applies.\nconst gitShow = (ref, p) => { if (!REF_OK.test(ref) || /(^|\\/)\\.\\.(\\/|$)/.test(p) || p.startsWith('/') || p.startsWith('-') || SECRET_NAME.test(p)) { if (!refused.has(ref + ':' + p)) { refused.add(ref + ':' + p); err(`ref=\"${ref}\" with \"${p}\" — not a plain git ref and a path inside the repo; not running git`); } return null; }" },
  { file: "pack.mjs", from: "const ids = {}; for (const m of html.matchAll(/\\sid=[\"']([^\"']+)[\"']/g)) { if (ids[m[1]]) err(`duplicate id=\"${m[1]}\" (lines ${ids[m[1]]} and ${lineOf(m.index)})`); ids[m[1]] = lineOf(m.index); }", to: "// A packed page must not reach the network when opened: every resource it loads is local or inline. A remote src/poster/srcset/data, a remote\n// stylesheet or script, and a CSS url()/@import to a remote host are errors (the page also carries a CSP that blocks them).\n{ const dec = (v) => String(v || '').replace(/&#x([0-9a-f]+);?/gi, (m, h) => String.fromCodePoint(parseInt(h, 16) || 0xfffd)).replace(/&#(\\d+);?/g, (m, d) => String.fromCodePoint(+d || 0xfffd)).replace(/&(colon|tab|newline|sol);?/gi, (m, n) => ({ colon: ':', tab: '\\t', newline: '\\n', sol: '/' })[n.toLowerCase()]).replace(/[\\x00-\\x20\\x7f-\\xa0\\xad\\u200b-\\u200f\\u2028-\\u202f\\ufeff]/g, '');\n  const remote = (v) => /^(?:[a-z][a-z0-9+.-]*:)?[\\\\/]{2}|^https?:/i.test(dec(v));\n  const scan = html.replace(/<script\\s+type=[\"']?text\\/(?:plain|source)[\"']?\\s*>[\\s\\S]*?<\\/script>/gi, (x) => x.replace(/[^\\n]/g, ' ')); // quoted code is text, not markup\n  const LOADERS = /<(img|source|video|audio|track|iframe|embed|object|doc-shot|image|input|script|link)\\b((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>/gi;\n  for (const m of scan.matchAll(LOADERS)) { const el = m[1].toLowerCase(), a = attrs(m[2]);\n    const urls = [a.src, a.poster, a.data, ...(a.srcset ? a.srcset.split(',').map((c) => c.trim().split(/\\s+/)[0]) : []), ...(el === 'image' || (el === 'link' && /stylesheet|preload|prefetch|modulepreload|icon|manifest|import|preconnect|dns-prefetch/i.test(a.rel || '')) ? [a.href, a['xlink:href']] : [])].filter(Boolean);\n    for (const u of urls) if (remote(u)) err(`line ${lineOf(m.index)}: <${el}> loads a remote resource (${dec(u).slice(0, 60)}) — packed pages load nothing from the network; save it locally and use a relative path or a data: URI`); }\n  for (const m of scan.matchAll(/<style\\b[^>]*>([\\s\\S]*?)<\\/style\\s*>|\\sstyle\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')/gi)) { const css = dec(m[1] ?? m[2] ?? m[3] ?? '').replace(/\\/\\*[\\s\\S]*?\\*\\//g, ''); if (/@import|url\\([\"']?(?:[a-z][a-z0-9+.-]*:)?[\\\\/]{2}|url\\([\"']?https?:/i.test(css)) err(`line ${lineOf(m.index)}: a style loads a remote resource (@import or url() to a host) — packed pages load nothing from the network`); } }\nconst ids = {}; for (const m of html.matchAll(/\\sid=[\"']([^\"']+)[\"']/g)) { if (ids[m[1]]) err(`duplicate id=\"${m[1]}\" (lines ${ids[m[1]]} and ${lineOf(m.index)})`); ids[m[1]] = lineOf(m.index); }" },
  { file: "pack.mjs", from: "`HEAD:${relative(rr,", to: "`HEAD:./${relative(rr," },
  { file: "pack.mjs", from: "`${ref}:${p}`", to: "`${ref}:./${p}`" },
  // pack.mjs: Security P1 batch 2 lane tools-4 (2026-10-15). The packed page always carries the restrictive CSP as a real <meta> first in <head> (S087);
  // stylesheets, scripts, media and code excerpts pass the shared credential inventory before anything is inlined, and media must be an allowed type with a matching signature (S088).
  { file: "pack.mjs", from: "  if (!/data-htmlplan-packed/.test(packed)) packed = packed.replace(/<html\\b/i, '<html data-htmlplan-packed');", to: "  if (!/data-htmlplan-packed/.test(packed)) packed = packed.replace(/<html\\b/i, '<html data-htmlplan-packed');\n  // The restrictive policy is always a real <meta> at the top of <head>, whatever policy text the input carries (S087). A browser enforces\n  // every policy a page declares, so an input's own policy, or a marker in a comment or prose, can only add limits, never lift this one.\n  // It goes after the leading doctype and plain <html>/<head> start tags only, so nothing on the page (a comment included) can come before it.\n  // Whitespace here is HTML whitespace (tab, LF, FF, CR, space), never JS \\s: a leading U+00A0 is text, which opens body, and a\n  // no-break space inside <html …> makes it some other tag; reading either as whitespace would put the policy in body, where it does nothing.\n  { const meta = `<meta http-equiv=\"Content-Security-Policy\" content=\"${PAGE_CSP}\">`;\n    const WS = '[\\\\t\\\\n\\\\f\\\\r ]';\n    const tag = (n) => '<' + n + '(?:' + WS + '+[\\\\w:-]+(?:' + WS + '*=' + WS + '*(?:\"[^\"<>]*\"|\\'[^\\'<>]*\\'|[^\\\\t\\\\n\\\\f\\\\r \"\\'<>=`]+))?)*' + WS + '*>';\n    const lead = packed.match(new RegExp('^\\\\ufeff?(?:' + WS + '|<!doctype[^>]*>)*(?:' + tag('html') + WS + '*)?(?:' + tag('head') + ')?', 'i'))[0];\n    if (!packed.slice(lead.length).replace(new RegExp('^' + WS + '+'), '').startsWith(meta)) packed = lead + (lead ? '\\n' : '') + meta + '\\n' + packed.slice(lead.length); }" },
  { file: "pack.mjs", from: "import { createRequire } from 'node:module';\n", to: "import { createRequire } from 'node:module';\nimport { firstSecretShape } from '../../../../hooks/lib/egress-shapes.ts';  // pack runs under bun, which loads the shared TypeScript inventory directly\n" },
  { file: "pack.mjs", from: "const SECRET_TEXT = /sk-ant-|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abeprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.|(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)[\"']?\\s*[:=]\\s*[\"'][^\"'\\s$<{]{12,}[\"']/i;\n", to: "const SECRET_TEXT = /sk-ant-|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abeprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.|(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)[\"']?\\s*[:=]\\s*[\"'][^\"'\\s$<{]{12,}[\"']/i;\n// Refusing to package is a refusal decision, so it reads the shared credential inventory every refusal reads (egress gate,\n// Proof, public push): firstSecretShape. Upstream's own list above stays as a floor, so this only adds refusals; it alone\n// let a project-scoped key through (S088). Boundary.redact is the capture redactor and over-matches on purpose (PIN,\n// passphrase and verification-code labels, any 32-character mixed run), which refused ordinary code and 1 in 15 random 1 MB blobs.\nconst holdsSecret = (text) => typeof text === 'string' && text.length > 0 && (SECRET_TEXT.test(text) || firstSecretShape(text) !== null);\n" },
  { file: "pack.mjs", from: "        if (SECRET_TEXT.test(text)) { warn(`${at}: ${nd.file} looks like it holds a secret somewhere — no excerpt from it`); continue; }", to: "        if (holdsSecret(text)) { warn(`${at}: ${nd.file} looks like it holds a secret somewhere — no excerpt from it`); continue; }" },
  { file: "pack.mjs", from: "        if (SECRET_TEXT.test(slice)) { warn(`${at}: ${key} looks like it holds a secret — no excerpt`); continue; } reads.add(nd.file);", to: "        if (holdsSecret(slice)) { warn(`${at}: ${key} looks like it holds a secret — no excerpt`); continue; } reads.add(nd.file);" },
  { file: "pack.mjs", from: "        if (SECRET_TEXT.test(text)) { err(`${at}: ${a.src} looks like it holds a secret somewhere in the file — not packaging any of it`); return whole; }", to: "        if (holdsSecret(text)) { err(`${at}: ${a.src} looks like it holds a secret somewhere in the file — not packaging any of it`); return whole; }" },
  { file: "pack.mjs", from: "        if (SECRET_TEXT.test(text)) { err(`${at}: ${a.src} looks like it holds a secret — not packaging it`); return whole; } reads.add(a.src);", to: "        if (holdsSecret(text)) { err(`${at}: ${a.src} looks like it holds a secret — not packaging it`); return whole; } reads.add(a.src);" },
  { file: "pack.mjs", from: "  packed = packed.replace(/<link\\b[^>]*href=[\"']([^\"']*htmlplan\\.css)[\"'][^>]*>/i, (m, href) => { const f = findFile(href) || resolve(here, 'htmlplan.css'); inlined++; return `<style data-htmlplan>\\n${readFileSync(f, 'utf8')}\\n</style>`; });\n  packed = packed.replace(/<link\\b[^>]*rel=[\"']stylesheet[\"'][^>]*href=[\"']([^\"':]+\\.css)[\"'][^>]*>/gi, (m, href) => { const f = findFile(href); if (!f) { warn(`stylesheet ${href} not found — left as a link`); return m; } inlined++; return `<style>/* ${basename(href)} */\\n${readFileSync(f, 'utf8')}\\n</style>`; });  // any other local stylesheet\n  packed = packed.replace(/<script\\b[^>]*src=[\"']([^\"']*htmlplan\\.js)[\"'][^>]*>\\s*<\\/script>/i, (m, src) => { const f = findFile(src) || resolve(here, 'htmlplan.js'); inlined++; return `<script data-htmlplan>\\n${readFileSync(f, 'utf8').replace(/<\\/script/gi, '<\\\\/script')}\\n</script>`; });\n  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm' };\n  packed = packed.replace(/(<(?:img|doc-shot|video|source)\\b[^>]*?\\ssrc=[\"'])([^\"']+)([\"'])/gi, (m, pre, src, post) => {\n    if (/^(data:|https?:|#)/.test(src)) return m; const f = findFile(src); if (!f) { warn(`asset ${src} not found — left as-is`); return m; }\n    const size = statSync(f).size; if (size > 6e6) { warn(`${src} is ${(size / 1e6).toFixed(1)} MB — not inlining; the packed file will need it alongside`); return m; }\n    inlined++; return `${pre}data:${MIME[extname(f).toLowerCase()] || 'application/octet-stream'};base64,${readFileSync(f).toString('base64')}${post}`;\n  });\n", to: "  // Every byte inlined below ends up in a page that may be published, so stylesheets, scripts and media pass the same credential\n  // check as a code excerpt, and media must be an allowed type whose bytes start like that type (S088).\n  const clean = (what, text) => { if (holdsSecret(text)) { err(`${what} looks like it holds a secret — not inlining it`); return false; } return true; };\n  packed = packed.replace(/<link\\b[^>]*href=[\"']([^\"']*htmlplan\\.css)[\"'][^>]*>/i, (m, href) => { const f = findFile(href) || resolve(here, 'htmlplan.css'); const t = readFileSync(f, 'utf8'); if (!clean(`stylesheet ${href}`, t)) return m; inlined++; return `<style data-htmlplan>\\n${t}\\n</style>`; });\n  packed = packed.replace(/<link\\b[^>]*rel=[\"']stylesheet[\"'][^>]*href=[\"']([^\"':]+\\.css)[\"'][^>]*>/gi, (m, href) => { const f = findFile(href); if (!f) { warn(`stylesheet ${href} not found — left as a link`); return m; } const t = readFileSync(f, 'utf8'); if (!clean(`stylesheet ${href}`, t)) return m; inlined++; return `<style>/* ${basename(href)} */\\n${t}\\n</style>`; });  // any other local stylesheet\n  packed = packed.replace(/<script\\b[^>]*src=[\"']([^\"']*htmlplan\\.js)[\"'][^>]*>\\s*<\\/script>/i, (m, src) => { const f = findFile(src) || resolve(here, 'htmlplan.js'); const t = readFileSync(f, 'utf8'); if (!clean(`script ${src}`, t)) return m; inlined++; return `<script data-htmlplan>\\n${t.replace(/<\\/script/gi, '<\\\\/script')}\\n</script>`; });\n  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm' };\n  const head = (b, n, enc = 'latin1') => b.toString(enc, 0, Math.min(b.length, n));\n  // An SVG's text as a browser reads it. A UTF-16 file has a NUL between every character, so the credential check below also runs on this\n  // decoded text: scanning the raw bytes alone would let a secret in a UTF-16 SVG through to the public page.\n  const svgText = (b) => new TextDecoder(b[0] === 0xff && b[1] === 0xfe ? 'utf-16le' : b[0] === 0xfe && b[1] === 0xff ? 'utf-16be' : 'utf-8').decode(b);\n  const SIGNATURE = { '.png': (b) => head(b, 8) === '\\x89PNG\\r\\n\\x1a\\n', '.jpg': (b) => head(b, 3) === '\\xff\\xd8\\xff', '.jpeg': (b) => head(b, 3) === '\\xff\\xd8\\xff', '.gif': (b) => /^GIF8[79]a/.test(head(b, 6)),\n    '.webp': (b) => head(b, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP', '.mp4': (b) => b.toString('latin1', 4, 8) === 'ftyp', '.webm': (b) => head(b, 4) === '\\x1a\\x45\\xdf\\xa3',\n    // SVG is XML text with no fixed leading bytes: any encoding (a UTF-16 file starts with its BOM), any prolog length, any Unicode\n    // namespace prefix. So the check is only that the decoded text holds an svg start tag (<svg, <s:svg, <é:svg) somewhere, never\n    // a prolog parse that refuses valid SVG HEAD embedded. Text with no svg element at all under an .svg name is still refused.\n    '.svg': (b) => /<(?:[^\\s<>\\/!?:\"'=]+:)?svg[\\s\\/>]/i.test(svgText(b)) };\n  packed = packed.replace(/(<(?:img|doc-shot|video|source)\\b[^>]*?\\ssrc=[\"'])([^\"']+)([\"'])/gi, (m, pre, src, post) => {\n    if (/^(data:|https?:|#)/.test(src)) return m; const f = findFile(src); if (!f) { warn(`asset ${src} not found — left as-is`); return m; }\n    const ext = extname(f).toLowerCase(); if (!MIME[ext]) { warn(`asset ${src} is not a type pack embeds (${Object.keys(MIME).join(' ')}) — left as-is`); return m; }\n    const size = statSync(f).size; if (size > 6e6) { warn(`${src} is ${(size / 1e6).toFixed(1)} MB — not inlining, and the page's CSP shows only inlined media, so it will not appear even beside the file; shrink it under 6 MB`); return m; }\n    const bytes = readFileSync(f);\n    if (!SIGNATURE[ext](bytes)) { err(`asset ${src} does not start like a ${ext.slice(1)} file — not inlining it`); return m; }\n    if (!clean(`asset ${src}`, bytes.toString('latin1')) || (ext === '.svg' && !clean(`asset ${src}`, svgText(bytes)))) return m;\n    inlined++; return `${pre}data:${MIME[ext]};base64,${bytes.toString('base64')}${post}`;\n  });\n" },
  // pack.mjs imports the TypeScript secret-shape inventory, so it runs under bun: the shebang and usage lines say so, and blocks.md
  // gives the path it has in this tree (upstream's runtime/ folder does not exist here). RC 8.621.0 Lane B, 2026-10-20.
  { file: "pack.mjs", from: "#!/usr/bin/env node\n", to: "#!/usr/bin/env bun\n" },
  { file: "pack.mjs", from: "//   node pack.mjs page.html [-o out.html]", to: "//   bun pack.mjs page.html [-o out.html]" },
  { file: "pack.mjs", from: "console.error('usage: node pack.mjs page.html", to: "console.error('usage: bun pack.mjs page.html" },
  { file: "blocks.md", from: "node runtime/pack.mjs plan.html", to: "bun LIFEOS/TOOLS/ISARender/htmlplan/pack.mjs plan.html" },
];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const count = (s: string, sub: string) => s.split(sub).length - 1;

function check(): number {
  let bad = 0;
  for (const [name, { sha256 }] of Object.entries(FILES)) {
    let text = readFileSync(join(HERE, name), "utf8");
    let fileBad = 0;
    for (const p of PATCHES.filter((p) => p.file === name)) {
      if (count(text, p.to) !== 1) { console.error(`✗ ${name}: patch target not found once: ${p.to}`); fileBad++; continue; }
      text = text.split(p.to).join(p.from);
    }
    if (sha(text) !== sha256) { console.error(`✗ ${name}: differs from upstream beyond the named patches`); fileBad++; }
    else if (!fileBad) console.log(`✓ ${name}: upstream + ${PATCHES.filter((p) => p.file === name).length} named patches`);
    bad += fileBad;
  }
  return bad ? 1 : 0;
}

function apply(upstreamDir: string): number {
  for (const [name, { from }] of Object.entries(FILES)) copyFileSync(join(upstreamDir, from), join(HERE, name));
  for (const p of PATCHES) {
    const f = join(HERE, p.file);
    const text = readFileSync(f, "utf8");
    if (count(text, p.from) !== 1) { console.error(`✗ ${p.file}: upstream text not found once: ${p.from}`); return 1; }
    writeFileSync(f, text.split(p.from).join(p.to));
  }
  console.log(`applied ${PATCHES.length} patches; update the sha256 values if upstream moved, then run check`);
  return 0;
}

/** No network call in the runtime. Comments are stripped first: upstream documents `fetch(`
 *  as a call-row naming rule, which is text about calls, not a call. */
function network(): number {
  const code = readFileSync(join(HERE, "htmlplan.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, "$1");
  const hits = code.match(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|EventSource|importScripts|\bimport\s*\(/g) ?? [];
  if (hits.length) { console.error(`✗ htmlplan.js: ${hits.length} network call(s): ${[...new Set(hits)].join(", ")}`); return 1; }
  console.log("✓ htmlplan.js: no network call outside comments");
  return 0;
}

if (import.meta.main) {
  const [cmd, dir] = process.argv.slice(2);
  if (!cmd || cmd === "check") process.exit(check());
  if (cmd === "network") process.exit(network());
  if (cmd === "apply" && dir) process.exit(apply(dir));
  console.error("usage: bun upstream-diff.ts [check] | apply <upstream html-plan dir>");
  process.exit(2);
}
