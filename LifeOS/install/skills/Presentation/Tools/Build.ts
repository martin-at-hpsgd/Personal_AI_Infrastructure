#!/usr/bin/env bun
/**
 * Build.ts — turn a lecture SCRIPT.md into a reveal.js deck whose speaker notes are the talk.
 *
 * Usage:
 *   bun Build.ts --script <SCRIPT.md> [--deck <deck-dir>] [--template <dir>]   validate + render
 *   bun Build.ts --script <SCRIPT.md> --check                                  validate only
 *   bun Build.ts --script <SCRIPT.md> --text                                   print the read-through text
 *   bun Build.ts --deck <deck-dir> --serve [--port 7350]                       serve on 127.0.0.1
 *   bun Build.ts --self-test                                                   run the format tests
 *
 * Exit codes: 0 ok · 1 script fails the format contract · 2 usage or file error.
 * Format contract: Presentation/ScriptFormat.md.
 */
import { existsSync, mkdirSync, cpSync, renameSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname, join, relative, isAbsolute, sep } from "path";

export type Slide = {
  n: string; name: string; f: Record<string, string>;
  bullets: string[]; L: string[]; R: string[]; read: string[];
};
export type Problem = { slide: string; level: "error" | "warn"; msg: string };

export const LIMITS = { minLines: 1, maxLines: 5, warnWords: 15, maxWords: 20 };
const FIELD = /^(TYPE|TITLE|SUB|IMG|VIDEO|CITE|BYLINE|CONTACT):\s*(.*)$/;
const TYPES = ["title", "statement", "section", "bullets", "two-col", "art", "video", "quote", "close"];
const ABBREV = /\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|etc|e\.g|i\.e|U\.S|a\.m|p\.m)\./gi;

export function parse(md: string): Slide[] {
  const slides: Slide[] = [];
  for (const chunk of md.split(/^## /m).slice(1)) {
    const lines = chunk.split("\n");
    const m = lines[0].trim().match(/^(\d+)\s*[—-]\s*(.+)$/);
    if (!m) throw new Error(`bad slide header: "## ${lines[0].trim()}" (want "## <n> — <name>")`);
    const s: Slide = { n: m[1], name: m[2], f: {}, bullets: [], L: [], R: [], read: [] };
    let inRead = false;
    for (const raw of lines.slice(1)) {
      const line = raw.replace(/\r$/, "");
      if (/^(FULL|NOTE):/.test(line) || line.trim() === "---") { inRead = false; if (line.trim() !== "---") break; continue; }
      if (line.startsWith("READ:")) { inRead = true; continue; }
      const kv = line.match(FIELD);
      if (kv) { inRead = false; s.f[kv[1]] = kv[2].trim(); continue; }
      const b = line.match(/^(BULLET|L|R):\s*(.*)$/);
      if (b) { inRead = false; (b[1] === "BULLET" ? s.bullets : b[1] === "L" ? s.L : s.R).push(b[2].trim()); continue; }
      if (inRead && line.trim()) s.read.push(line.trim());
    }
    slides.push(s);
  }
  return slides;
}

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

export function validate(slides: Slide[]): Problem[] {
  const out: Problem[] = [];
  const err = (slide: string, msg: string) => out.push({ slide, level: "error", msg });
  if (!slides.length) err("-", "no slides found (each slide starts with '## <n> — <name>')");
  const seen = new Set<string>();
  for (const s of slides) {
    if (seen.has(s.n)) err(s.n, "duplicate slide number"); seen.add(s.n);
    const t = s.f.TYPE;
    if (!TYPES.includes(t)) err(s.n, `TYPE '${t ?? ""}' is not one of ${TYPES.join("|")}`);
    if (t === "art" && !s.f.IMG) err(s.n, "art slide has no IMG");
    if (t === "video" && !s.f.VIDEO) err(s.n, "video slide has no VIDEO");
    if (s.read.length < LIMITS.minLines || s.read.length > LIMITS.maxLines)
      err(s.n, `READ has ${s.read.length} sentences; the contract is ${LIMITS.minLines}–${LIMITS.maxLines}`);
    for (const r of s.read) {
      const masked = r.replace(ABBREV, "$1");
      if (/[.!?]["')\]]?\s+["(]?[A-Z0-9]/.test(masked)) err(s.n, `two sentences on one line: "${r}"`);
      const w = words(r);
      if (w > LIMITS.maxWords) err(s.n, `${w}-word sentence (max ${LIMITS.maxWords}): "${r}"`);
      else if (w > LIMITS.warnWords) out.push({ slide: s.n, level: "warn", msg: `${w} words, consider splitting: "${r}"` });
    }
  }
  return out;
}

const SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lecture</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.2.1/dist/reveal.css">
<style>
:root{--ground:#FFFFFF;--ink:#0F172A;--accent:#2563EB;--muted:#475569}
.reveal{background:var(--ground);color:var(--ink);font-family:Georgia,serif}
.reveal h1,.reveal h2,.reveal h3{color:var(--ink);font-weight:600;line-height:1.15;text-transform:none}
.reveal .sub,.reveal .subtitle,.reveal .followup,.reveal .byline,.reveal .contact,.reveal cite{color:var(--muted);font-family:system-ui,sans-serif;font-size:.55em}
.reveal .section-number{color:var(--accent);font-family:system-ui,sans-serif}
.reveal .split,.reveal .cols{display:flex;gap:40px;align-items:center;text-align:left}
.reveal .split>*,.reveal .cols>*{flex:1}
.reveal .art img,.reveal .art video,.reveal .art svg{max-width:100%;max-height:480px}
.reveal .art img,.reveal .art video{border-radius:12px}
.reveal .source{position:absolute;left:0;bottom:-40px;margin:0;color:var(--muted);font-family:system-ui,sans-serif;font-size:.4em;font-style:normal;text-align:left}
.reveal ul{font-family:system-ui,sans-serif;font-size:.7em}
.reveal hr.rule{border:0;border-top:3px solid var(--accent);width:80px;margin:0 auto 24px}
</style></head>
<body><div class="reveal"><div class="slides">
<!-- SLIDES:START -->
<!-- SLIDES:END -->
</div></div>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5.2.1/dist/reveal.js"></script>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5.2.1/plugin/notes/notes.js"></script>
<script>Reveal.initialize({width:1280,height:720,hash:true,slideNumber:'c/t',transition:'fade',plugins:[RevealNotes]});</script>
</body></html>
`;

function art(src: string, alt: string, scriptDir: string): string {
  if (src.startsWith("inline:")) {
    const p = resolve(scriptDir, src.slice(7));
    if (!existsSync(p)) throw new Error(`inline art not found: ${p}`);
    return readFileSync(p, "utf8");
  }
  return `<img src="${src}" alt="${alt}">`;
}

export function render(s: Slide, scriptDir = "."): string {
  const notes = `      <aside class="notes">\n${s.read.map(r => `        <p style="margin:0 0 1em">${r}</p>`).join("\n")}\n      </aside>`;
  const band = `      <h3>${s.f.TITLE ?? ""}</h3>\n      <p class="sub">${s.f.SUB ?? ""}</p>`;
  const list = (xs: string[], pad = "        ") => `${pad}<ul>\n${xs.map(x => `${pad}  <li>${x}</li>`).join("\n")}\n${pad}</ul>`;
  const wrap = (cls: string, inner: string) => `    <section class="${cls}">\n${inner}\n${notes}\n    </section>`;
  switch (s.f.TYPE) {
    case "title":
      return wrap("slide-title", `      <div class="panel">\n        <h1>${s.f.TITLE ?? ""}</h1>\n        <p class="subtitle">${s.f.SUB ?? ""}</p>\n        <p class="byline">${s.f.BYLINE ?? ""}</p>\n      </div>`);
    case "statement":
      return wrap("slide-statement", `      <div class="v">\n        <hr class="rule">\n        <h2>${s.f.TITLE ?? ""}</h2>\n        <p class="followup">${s.f.SUB ?? ""}</p>\n      </div>`);
    case "section":
      return wrap("slide-section", `      <div class="v">\n        <p class="section-number">${s.f.SUB ?? ""}</p>\n        <h2>${s.f.TITLE ?? ""}</h2>\n      </div>`);
    case "bullets":
      return wrap("slide-bullets slide-banded", `${band}\n      <div class="v">\n${list(s.bullets)}\n      </div>`);
    case "two-col": {
      const [lh, ...lb] = s.L; const [rh, ...rb] = s.R;
      return wrap("slide-two slide-banded", `${band}\n      <div class="v"><div class="cols">\n        <div class="col"><h4>${lh ?? ""}</h4>\n${list(lb, "          ")}</div>\n        <div class="col"><h4>${rh ?? ""}</h4>\n${list(rb, "          ")}</div>\n      </div></div>`);
    }
    case "art":
    case "video": {
      const media = s.f.TYPE === "video"
        ? `<video src="${s.f.VIDEO}" data-autoplay muted loop playsinline></video>`
        : art(s.f.IMG, s.name, scriptDir);
      const text = s.bullets.length ? `        <div class="text">\n${list(s.bullets, "          ")}\n        </div>\n` : "";
      const source = s.f.CITE ? `\n      <cite class="source">${s.f.CITE}</cite>` : "";
      return wrap("slide-art slide-banded", `${band}\n      <div class="v"><div class="split">\n${text}        <div class="art">${media}</div>\n      </div></div>${source}`);
    }
    case "quote":
      return wrap("slide-quote slide-banded", `${band}\n      <div class="v">\n        <blockquote><p>${s.bullets[0] ?? s.f.SUB ?? ""}</p><cite>${s.f.CITE ?? ""}</cite></blockquote>\n      </div>`);
    case "close":
      return wrap("slide-close", `      <div class="v">\n        <hr class="rule">\n        <h2>${s.f.TITLE ?? ""}</h2>\n        <p class="contact">${s.f.CONTACT ?? ""}</p>\n      </div>`);
  }
  throw new Error(`unknown TYPE on slide ${s.n}`);
}

function writeDeck(slides: Slide[], deckDir: string, template: string | undefined, scriptDir: string) {
  const deckPath = join(deckDir, "deck.html");
  if (!existsSync(deckPath)) {
    mkdirSync(deckDir, { recursive: true });
    if (template) {
      for (const item of ["deck.html", "theme.css", "fonts", "vendor", "images"]) {
        const src = join(template, item);
        if (existsSync(src)) cpSync(src, join(deckDir, item), { recursive: true });
      }
    } else writeFileSync(deckPath, SHELL);
  }
  const html = readFileSync(deckPath, "utf8");
  if (!/<!-- SLIDES:START -->[\s\S]*<!-- SLIDES:END -->/.test(html))
    throw new Error(`${deckPath} has no <!-- SLIDES:START --> / <!-- SLIDES:END --> markers`);
  const body = slides.map(s => `    <!-- ${s.n} · ${s.f.TYPE} — ${s.name} -->\n${render(s, scriptDir)}`).join("\n\n");
  const next = html.replace(/<!-- SLIDES:START -->[\s\S]*<!-- SLIDES:END -->/, () => `<!-- SLIDES:START -->\n\n${body}\n\n<!-- SLIDES:END -->`);
  const tmp = `${deckPath}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, deckPath);
}

function report(slides: Slide[], problems: Problem[]) {
  const total = slides.reduce((a, s) => a + words(s.read.join(" ")), 0);
  for (const p of problems) console.log(`${p.level === "error" ? "❌" : "⚠️ "} slide ${p.slide}: ${p.msg}`);
  console.log(`${slides.length} slides · ${total} read-aloud words · ~${Math.round(total / 140)} min at 140 wpm`);
}

/** True when file is root or inside it; a sibling such as root + "-private" is outside. */
export function within(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

function selfTest(): number {
  const ok = `## 1 — Open\nTYPE: statement\nTITLE: Hello.\nREAD:\nHi, I'm the speaker.\n\nThis is the talk.\n\n## 2 — Close\nTYPE: close\nTITLE: Thanks.\nREAD:\nThanks for listening.\n`;
  const cases: [string, string, boolean][] = [
    ["valid script passes", ok, true],
    ["six sentences fail", ok.replace("This is the talk.", "A.\n\nB.\n\nC.\n\nD.\n\nE."), false],
    ["two sentences on one line fail", ok.replace("This is the talk.", "This is the talk. It is short."), false],
    ["a 21-word sentence fails", ok.replace("This is the talk.", Array(21).fill("word").join(" ") + "."), false],
    ["a slide with no READ fails", ok.replace("READ:\nThanks for listening.\n", ""), false],
    ["an abbreviation is not a sentence break", ok.replace("This is the talk.", "Dr. Sutton wrote it in 2019."), true],
    ["an unknown TYPE fails", ok.replace("TYPE: close", "TYPE: banner"), false],
  ];
  let fail = 0;
  for (const [name, md, want] of cases) {
    const got = validate(parse(md)).every(p => p.level !== "error");
    if (got !== want) fail++;
    console.log(`${got === want ? "✓" : "✗"} ${name}`);
  }
  const html = render(parse(ok)[0]);
  const paras = (html.match(/<p style="margin:0 0 1em">/g) ?? []).length;
  console.log(`${paras === 2 ? "✓" : "✗"} each sentence renders as its own spaced paragraph`);
  if (paras !== 2) fail++;
  const shot = render(parse(`## 1 — The Quiet Engine\nTYPE: art\nTITLE: WREN\nIMG: images/quiet-engine.gif\nCITE: The Quiet Engine (2031), dir. Mara Ellison\nREAD:\nShe talks.\n`)[0]);
  const credited = /<cite class="source">The Quiet Engine \(2031\)/.test(shot) && !/<p class="sub">The Quiet Engine/.test(shot);
  console.log(`${credited ? "✓" : "✗"} an art slide shows its CITE as the bottom-left source line`);
  if (!credited) fail++;
  const clip = render(parse(`## 2 — Clip\nTYPE: video\nTITLE: In motion\nVIDEO: images/clip.mp4\nREAD:\nIt moves.\n`)[0]);
  const autoplays = /<video [^>]*\sdata-autoplay\s[^>]*muted[^>]*loop/.test(clip);
  console.log(`${autoplays ? "✓" : "✗"} a video slide carries data-autoplay, muted and loop, as DeckCheck requires`);
  if (!autoplays) fail++;
  const rounded = /\.art img,\.reveal \.art video\{border-radius:12px\}/.test(SHELL);
  console.log(`${rounded ? "✓" : "✗"} pictures and clips render with 12 px rounded corners`);
  if (!rounded) fail++;
  const contained = within("/talk/deck", "/talk/deck/images/a.png") && !within("/talk/deck", "/talk/deck-private/secret.txt") && !within("/talk/deck", "/talk/other.txt");
  console.log(`${contained ? "✓" : "✗"} the server refuses paths outside the deck, sibling directories included`);
  if (!contained) fail++;
  console.log(fail ? `${fail} failed` : "all passed");
  return fail ? 1 : 0;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const has = (n: string) => args.includes(`--${n}`);
  if (has("self-test")) process.exit(selfTest());
  if (has("serve")) {
    const root = resolve(flag("deck") ?? ".");
    const port = Number(flag("port") ?? 7350);
    Bun.serve({ port, hostname: "127.0.0.1", fetch(req) {
      const p = decodeURIComponent(new URL(req.url).pathname);
      const file = resolve(root, "." + (p === "/" ? "/deck.html" : p));
      if (!within(root, file)) return new Response("forbidden", { status: 403 });
      return existsSync(file) ? new Response(Bun.file(file)) : new Response("not found", { status: 404 });
    } });
    console.log(`serving ${root} at http://127.0.0.1:${port}/  (F fullscreen · S speaker view)`);
  } else {
    const scriptPath = flag("script");
    if (!scriptPath || !existsSync(scriptPath)) { console.error("usage: bun Build.ts --script <SCRIPT.md> [--deck <dir>] [--template <dir>] [--check|--text]"); process.exit(2); }
    const slides = parse(await Bun.file(scriptPath).text());
    if (has("text")) { console.log(slides.map(s => s.read.join("\n\n")).join("\n\n---\n\n")); process.exit(0); }
    const problems = validate(slides);
    report(slides, problems);
    if (problems.some(p => p.level === "error")) process.exit(1);
    if (!has("check")) {
      const scriptDir = dirname(resolve(scriptPath));
      const deckDir = resolve(flag("deck") ?? join(scriptDir, "deck"));
      try { writeDeck(slides, deckDir, flag("template"), scriptDir); }
      catch (e) { console.error(`❌ ${(e as Error).message}`); process.exit(2); }
      console.log(`deck → ${join(deckDir, "deck.html")}`);
    }
  }
}
