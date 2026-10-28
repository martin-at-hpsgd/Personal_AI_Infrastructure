#!/usr/bin/env bun
/**
 * Keynote.ts — turn a lecture's READ.md into a Keynote deck whose presenter notes are the talk.
 *
 * READ.md is the talk file, in Markdown: every heading and every line of one to three dashes starts a
 * section (a talking point), a heading is its first slide's title verbatim, `>` lines are visual directions,
 * and every other line is one spoken sentence. An Opus-tier model
 * designs the slides for each section and decides how the section's sentences split across
 * them. Every slide is one of two types:
 *   full  — one image fills the slide; the title and subtitle sit top-left as real text.
 *   split — title and subtitle top-left, bullets on the left, the image on the right.
 * A slide uses an existing image when one shows what is said; otherwise it carries an art
 * brief and an art type (essay illustration or technical diagram), and the builder draws a
 * marked placeholder until KeynoteArt.ts makes that art.
 * When a section's text changes, its closest earlier design is offered to the designer for reuse,
 * so small edits keep their titles and images.
 * Designs are stored in a JSON file keyed by a hash of each section's text, so an edited
 * section is redesigned on the next build and untouched sections keep their design. The deck
 * is rebuilt from READ.md + the design file every time; notes always come from READ.md.
 *
 * Usage:
 *   bun Keynote.ts --read <READ.md> [--out <deck.key>] [--design <KEYNOTE.json>]
 *                  [--style <style.json>] [--theme "Basic White"] [--images <dir>] [--concurrency 4]
 *                  [--title "<talk title>"] [--subtitle "<subtitle>"]
 *                  [--section N[,N…]] [--direction "<note for the redesign>"]
 *                  [--redesign-all] [--design-only] [--export <png-dir>]
 *   bun Keynote.ts --read <READ.md> --verify <deck.key>     notes read back == READ.md
 *   bun Keynote.ts --read <READ.md> --status                which sections need a design or art
 *   bun Keynote.ts --read <READ.md> --list                  every slide: number, section, type, art type, title, image
 *   bun Keynote.ts --read <READ.md> --move N --to M         move talking point N to position M in the talk file
 *   bun Keynote.ts --read <READ.md> --set <slide> <field> <value>   exact edit, no model (title|sub|source|bullets|image|art|kind|art-type)
 *   bun Keynote.ts --read <READ.md> --redo-art <slide>[,…]  clear a slide's image so KeynoteArt.ts draws it again
 *   bun Keynote.ts --self-test
 *
 * Exit codes: 0 ok · 1 verification or design failure · 2 usage, file or Keynote error.
 */
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, mkdirSync, mkdtempSync } from "fs";
import { basename, dirname, extname, join, resolve } from "path";
import { homedir, tmpdir } from "os";
import { deflateSync } from "zlib";

/** Decks in Keynote's iCloud Documents folder, where it autosaves untitled documents. Empty when iCloud is off. */
const CLOUD_DIR = join(homedir(), "Library", "Mobile Documents", "com~apple~Keynote", "Documents");
export function cloudDecks(dir = CLOUD_DIR): Set<string> {
  try { return new Set(readdirSync(dir).filter(n => n.endsWith(".key"))); } catch { return new Set(); }
}

/** A picture on two slides reads as a duplicate slide, back to back included (2026-10-04: the speaker called a
 *  book cover held across two consecutive slides a duplicate). Only a slide marked reprise may show one again. */
export function duplicateIssues(slides: { title: string; image?: string | null; reprise?: boolean }[]): Issue[] {
  const seen = new Map<string, number>(), out: Issue[] = [];
  slides.forEach((s, i) => {
    if (!s.image) return;
    const first = seen.get(s.image);
    if (first !== undefined && s.reprise) return;
    if (first === undefined) { seen.set(s.image, i); return; }
    const gif = /\.gif$/i.test(s.image);
    out.push({ slide: i + 1, title: s.title, level: "fix", text: `shows the same ${gif ? "clip" : "picture"} as slide ${first + 1} (${s.image}), so it reads as a duplicate slide; give it its own picture or moment` });
  });
  return out;
}
import { LAYOUT_GEOMETRY, LAYOUT_JS, MEDIA_RADIUS, imageSize, startOnMotion, mediaShownWidth, roundCorners, inkCover, isScene, layoutIssues, lookalikeIssues, exportCoverageIssues, lectureMode, pixelIssues, prepareImage, selfTest as layoutSelfTest, type Issue, type SlideLayout } from "./Layout.ts";
import { applyRealThings, defaultRealThingsPath, loadRealThings, stageRealImages, thingsIn, type RealThing } from "./RealThings.ts";

export const KINDS = ["full", "split"] as const;
export type Kind = typeof KINDS[number];
export const ART_TYPES = ["essay", "diagram", "media"] as const;
export type ArtType = typeof ART_TYPES[number];
export type SlideDesign = {
  kind: Kind; title: string; sub?: string; bullets?: string[];
  /** Where a real-thing picture comes from (film and year, site, publisher); shown small at the bottom left. */
  source?: string;
  image?: string | null; art?: string | null; artType?: ArtType; count: number;
  /** A deliberate callback to an earlier slide's picture ("show that slide again"); exempt from the duplicate check. */
  reprise?: boolean;
};
export type SectionDesign = { model: string; designedAt: string; slides: SlideDesign[]; direction?: string };
export type DesignFile = {
  version: 2; theme?: string; style?: string; images?: string; out?: string; title?: string; subtitle?: string;
  designs: Record<string, SectionDesign>;
  /** The sentences each design was made for, so an edited section can find its earlier design. */
  lines?: Record<string, string[]>;
};
/**
 * `visuals` are the section's `>` lines: directions for what to show, never spoken and never in the notes.
 * `title` is the speaker's own heading for the section, used verbatim on its first slide; `level` is that heading's depth.
 * `outline` is the chain of enclosing headings (talk › part › …), context for the designer that stays out of the hash.
 */
export type Section = { index: number; hash: string; lines: string[]; visuals?: string[]; title?: string; level?: number; outline?: Heading[] };
export type Heading = { level: number; text: string };

/** A deck style: a built-in theme, a ground colour, type tokens, footer, and the art direction handed to the designer. */
export type TextToken = { font?: string; size?: number; color?: string };
export type Style = {
  theme?: string; ground?: string; placeholder?: string; artStyle?: string;
  title?: TextToken; sub?: TextToken; bullets?: TextToken; caption?: TextToken;
  footer?: TextToken & { text?: string; logo?: string };
  /** Most essay slides per deck that may carry an animated GIF; MAX_ANIMATED_ESSAYS when absent. */
  animatedEssayMax?: number;
};

const MAX_LINES_PER_SLIDE = 5;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".tiff", ".heic"]);

// ── READ.md ─────────────────────────────────────────────────────────────────

export const hashLines = (lines: string[]) => createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const TITLE_PREFIX = "Title on this slide: ";

/**
 * Lines that are never spoken: `> direction` (graphics, animation, art, video, GIF), a line wholly in parentheses
 * (how the speaker writes stage notes), and a Markdown heading (the speaker's title for that part of the talk).
 * They become directions for the designer. Every other non-blank line is presenter notes.
 */
export function directionOf(line: string): string | null {
  if (line.startsWith(">")) return line.replace(/^>\s*/, "");
  const paren = line.match(/^\((.*)\)$/);
  if (paren) return paren[1].trim();
  const head = line.match(HEADING);
  if (head) return TITLE_PREFIX + head[2];
  return null;
}

/**
 * The talk's structure is the file's Markdown structure. A section (one talking point) starts at every heading
 * and at every line of one to three dashes (the speaker types "-" as often as "---"). A heading-only section, such
 * as a part heading with its first point directly under it, carries no speech and survives only as `outline` context.
 */
export function parseRead(md: string): Section[] {
  const chunks: { all: string[]; heading?: Heading; outline: Heading[] }[] = [];
  const stack: Heading[] = [];
  let cur: (typeof chunks)[number] = { all: [], outline: [] };
  chunks.push(cur);
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const l = raw.trim();
    // A heading with no text yet (a placeholder in a draft) breaks the section like a dash line and is never spoken.
    if (/^-{1,3}$/.test(l) || /^#{1,6}$/.test(l)) { cur = { all: [], outline: [...stack] }; chunks.push(cur); continue; }
    const head = l.match(HEADING);
    if (head) {
      const h = { level: head[1].length, text: head[2] };
      while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
      cur = { all: [l], heading: h, outline: [...stack] };
      chunks.push(cur);
      stack.push(h);
      continue;
    }
    if (l) cur.all.push(l);
  }
  return chunks
    .filter(c => c.all.some(l => directionOf(l) === null))
    .map((c, i) => {
      const lines = c.all.filter(l => directionOf(l) === null), visuals = c.all.map(directionOf).filter((v): v is string => !!v);
      // Visual directions join the hash only when present, so a section without them keeps its design key.
      const hash = hashLines(visuals.length ? [...lines, ...visuals.map(v => "> " + v)] : lines);
      const sec: Section = { index: i + 1, hash, lines };
      if (visuals.length) sec.visuals = visuals;
      if (c.heading) { sec.title = c.heading.text; sec.level = c.heading.level; }
      if (c.outline.length) sec.outline = c.outline;
      return sec;
    });
}

// ── Design validation ───────────────────────────────────────────────────────

const words = (t = "") => t.split(/\s+/).filter(Boolean).length;

/** A media slide whose subtitle is a credit line ("The Quiet Engine (2031), written and directed by …") rather than a meaning. */
export function creditSub(s: SlideDesign): boolean {
  return s.artType === "media" && !!s.sub && (/\(\d{4}\)|\b(directed by|dir\.|courtesy of|screenshot)\b/i.test(s.sub) || (!!s.source && s.sub.trim() === s.source.trim()));
}

/** Errors that make a design unusable. The notes contract: counts cover the section's lines exactly, in order. */
export function validateDesign(d: { slides?: unknown }, lineCount: number, images: string[]): string[] {
  const errs: string[] = [];
  const slides = Array.isArray(d?.slides) ? d.slides as SlideDesign[] : null;
  if (!slides?.length) return ["no slides"];
  let covered = 0;
  slides.forEach((s, i) => {
    const at = `slide ${i + 1}`;
    if (!KINDS.includes(s.kind)) errs.push(`${at}: kind '${s.kind}' is not one of ${KINDS.join("|")}`);
    if (!Number.isInteger(s.count) || s.count < 1) errs.push(`${at}: count must be a positive integer`);
    else if (s.count > MAX_LINES_PER_SLIDE) errs.push(`${at}: covers ${s.count} sentences (max ${MAX_LINES_PER_SLIDE})`);
    if (typeof s.title !== "string" || !s.title.trim()) errs.push(`${at}: empty title`);
    else if (words(s.title) > 12) errs.push(`${at}: title is ${words(s.title)} words (max 12)`);
    if (s.sub && words(s.sub) > 16) errs.push(`${at}: sub is ${words(s.sub)} words (max 16)`);
    if (s.kind === "split") {
      if (!s.bullets?.length || s.bullets.length > 4) errs.push(`${at}: a split slide needs 1–4 bullets`);
      else for (const b of s.bullets) if (words(b) > 8) errs.push(`${at}: bullet is ${words(b)} words (max 8): "${b}"`);
    }
    if (s.kind === "full" && s.bullets?.length) errs.push(`${at}: a full slide has no bullets`);
    if (s.image && !images.includes(s.image)) errs.push(`${at}: image '${s.image}' is not one of the available files`);
    if (!s.image && !s.art?.trim()) errs.push(`${at}: needs an existing image or an art brief`);
    // A credit line ("The Quiet Engine (2031), written and directed by …") is the source, shown at the bottom left, never the subtitle.
    if (creditSub(s))
      errs.push(`${at}: the subtitle "${s.sub}" is a credit; put it in "source" and make the subtitle say what the slide means`);
    if (s.artType !== undefined && !ART_TYPES.includes(s.artType)) errs.push(`${at}: artType '${s.artType}' is not one of ${ART_TYPES.join("|")}`);
    covered += Number.isInteger(s.count) ? s.count : 0;
  });
  if (covered !== lineCount) errs.push(`slides cover ${covered} sentences; the section has ${lineCount}`);
  return errs;
}

/**
 * Animated essay art stays rare so it lands: by default at most this many essay slides per deck carry a GIF.
 * A deck's style file overrides it with `animatedEssayMax` (the install's taste lives in its USER Presentation
 * PREFERENCES.md and style file). Animated technical diagrams are not counted; every diagram slide may move.
 */
export const MAX_ANIMATED_ESSAYS = 3;

/** Titles of the live slides whose essay art is an animated GIF. */
export function animatedEssays(sections: Section[], file: DesignFile): string[] {
  return sections.flatMap(sec => (file.designs[sec.hash]?.slides ?? [])
    .filter(x => (x.artType ?? "essay") === "essay" && /\.gif$/i.test(x.image ?? ""))
    .map(x => x.title));
}

export function animatedEssayError(sections: Section[], file: DesignFile, max: number = MAX_ANIMATED_ESSAYS): string | null {
  if (!Number.isInteger(max) || max < 0) throw new Error(`style file key animatedEssayMax must be a whole number of 0 or more, got ${max}`);
  const a = animatedEssays(sections, file);
  return a.length > max ? `${a.length} essay slides are animated (max ${max} per deck): ${a.join(" | ")}` : null;
}

/** Which sections need a (re)design: no design for their hash, or explicitly forced. */
export function needsDesign(sections: Section[], file: DesignFile, forced: Set<number>, all = false): Section[] {
  return sections.filter(s => all || forced.has(s.index) || !file.designs[s.hash]);
}

/**
 * The talk file rewritten from sections: sentences one per line with a blank line between, sections split by ---.
 * A section's own heading is written back as a heading, and an enclosing heading wherever the outline changes.
 */
export function writeRead(sections: { lines: string[]; visuals?: string[]; title?: string; level?: number; outline?: Heading[] }[]): string {
  let prev: Heading[] = [];
  return sections.map(s => {
    const outline = s.outline ?? [], level = s.level ?? 2;
    let same = 0;
    while (same < outline.length && same < prev.length && outline[same].level === prev[same].level && outline[same].text === prev[same].text) same++;
    const enclosing = outline.slice(same).map(h => "#".repeat(h.level) + " " + h.text);
    prev = s.title ? [...outline, { level, text: s.title }] : outline;
    const own = s.title ? ["#".repeat(level) + " " + s.title] : [];
    const titleAt = s.title ? (s.visuals ?? []).indexOf(TITLE_PREFIX + s.title) : -1;
    const visuals = (s.visuals ?? []).filter((_, i) => i !== titleAt);
    return [...enclosing, ...own, ...visuals.map(v => "> " + v), ...s.lines].join("\n\n");
  }).join("\n\n---\n\n") + "\n";
}

/** Move talking point `from` (1-based) so it ends up at position `to`. Every section keeps its text, so every design hash survives. */
export function moveSection(md: string, from: number, to: number): string {
  const secs = parseRead(md);
  if (from < 1 || from > secs.length || to < 1 || to > secs.length) throw new Error(`--move needs positions 1–${secs.length}`);
  const [moved] = secs.splice(from - 1, 1);
  secs.splice(to - 1, 0, moved);
  return writeRead(secs);
}

/** The orphaned design (no current section has its hash) whose sentences overlap this section's most, if the overlap is real. */
export function closestOrphan(sec: Section, sections: Section[], file: DesignFile): { hash: string; score: number } | null {
  const live = new Set(sections.map(s => s.hash));
  const mine = new Set(sec.lines);
  let best: { hash: string; score: number } | null = null;
  for (const [hash, lines] of Object.entries(file.lines ?? {})) {
    if (live.has(hash) || !file.designs[hash]) continue;
    const theirs = new Set(lines);
    const inter = [...mine].filter(l => theirs.has(l)).length;
    const score = inter / new Set([...mine, ...theirs]).size;
    if (score >= 0.34 && (!best || score > best.score)) best = { hash, score };
  }
  return best;
}

/** Deck slide number → its section hash and its index inside that section's design. */
export function locate(sections: Section[], file: DesignFile, slide: number): { hash: string; idx: number; section: number } {
  let n = 0;
  for (const sec of sections) {
    const d = file.designs[sec.hash];
    if (!d) throw new Error(`section ${sec.index} has no design yet; run a build first`);
    for (let i = 0; i < d.slides.length; i++) if (++n === slide) return { hash: sec.hash, idx: i, section: sec.index };
  }
  throw new Error(`there is no slide ${slide}; the deck has ${n}`);
}

/** One exact field edit on one slide. Returns the edited copy of the design file. */
export function setField(file: DesignFile, at: { hash: string; idx: number }, field: string, value: string): DesignFile {
  const out = JSON.parse(JSON.stringify(file)) as DesignFile;
  const s = out.designs[at.hash].slides[at.idx];
  switch (field) {
    case "title": s.title = value; break;
    case "sub": s.sub = value || undefined; break;
    case "source": s.source = value || undefined; break;
    case "bullets": s.bullets = value.split("|").map(b => b.trim()).filter(Boolean); break;
    case "image": s.image = value || null; break;
    case "art": s.art = value || null; s.image = null; break;
    case "kind": s.kind = value as Kind; if (s.kind === "full") s.bullets = undefined; break; // a full slide carries no bullets
    case "art-type": s.artType = value as ArtType; break;
    case "reprise": s.reprise = /^(yes|true|1)$/i.test(value) || undefined; break;
    default: throw new Error(`--set field must be title|sub|source|bullets|image|art|kind|art-type|reprise, not '${field}'`);
  }
  return out;
}

/** Slides with their notes, in deck order. Notes come only from READ.md. */
export function assemble(sections: Section[], file: DesignFile) {
  const out: (SlideDesign & { notes: string[]; section: number })[] = [];
  for (const sec of sections) {
    const d = file.designs[sec.hash];
    if (!d) throw new Error(`section ${sec.index} has no design`);
    let at = 0;
    for (const s of d.slides) { out.push({ ...s, notes: sec.lines.slice(at, at + s.count), section: sec.index }); at += s.count; }
  }
  return out;
}

// ── Opus design pass ────────────────────────────────────────────────────────

const SYSTEM = `You design Keynote slides for one section of a talk that the speaker reads aloud word for word.
The section's sentences become the presenter notes exactly as written. You never rewrite, add or drop a spoken word; you only decide what the audience sees while those sentences are read.

Every slide is one of two types:
- full: one image fills the whole slide and carries the idea. The title and subtitle sit over its top-left corner as text.
- split: title and subtitle at the top, 1 to 4 short bullets on the left, an image on the right.
Use full when one picture can carry the point. Use split when the point is a short list or a comparison that is easier to read as words.
A split slide's picture sits in a column about as tall as it is wide, so it suits a square or 3:2 picture. A wide panorama, a busy diagram, a website screenshot or a film clip goes on a full slide, where it is large enough to read. A book cover or another tall picture works on a full slide, where it stands beside the title.

What a great slide is here:
- The title is a short headline for the idea, at most 8 words when possible (hard limit 12). The subtitle is one plain line that says what the slide means, at most 14 words.
- Bullets are at most 6 words each when possible (hard limit 8).
- Words on the slide echo or sharpen what is being said, never a new claim the speaker does not make.
- Plain words in the speaker's own register. No marketing phrasing, no em-dashes, no "not X, it's Y", no rule-of-three cadence, no hype adjectives.
- A new slide roughly every 15 to 30 seconds of speech. Split the section into several slides when it has distinct beats; each slide covers 1 to 5 consecutive sentences, in order.
- Numbered sequences and repeated title patterns stay consistent with the other slides in the talk.

Images: set "image" to one of the listed filenames only when it directly shows what is being said. Otherwise set "image" to null and write "art": a brief for art to be made later. The art style is fixed by the deck, so describe content, not style. For a full slide, the art must leave the top-left area empty for the title.

Every slide also gets "artType":
- "essay": an editorial illustration, one visual metaphor that makes the line land. Most slides are essay art. Its brief names the subject and composition in one or two sentences and asks for no text.
- "diagram": a technical diagram, for slides whose sentences explain how something works: a structure with named parts, a flow or pipeline, a loop, a layered system, or a before-and-after of a process. Its brief names each component with a 1–3 word label, how they connect (arrows, layers, loops), and one or two short insight callouts. Use a diagram only where the explanation is the point, a few times per talk, never two in a row.
- "media": the real thing, never a drawing of it, for anything real the speaker names: a book (its actual cover), a website or app (a screenshot of it), a product, a film, show or character (footage), a person, a place, a document, a post. The speaker's own book, product, site or company counts. Use it whenever a sentence names something real the audience could look up, and whenever the section's visual directions ask for footage or a picture of something. Give each named thing its own slide so every one is seen. Its brief says what to get and starts with its form: "footage:", "cover:", "screenshot:", "photo:" or "logo:", for example "footage: The Quiet Engine (2031), the engineer talking to her assistant WREN in the workshop" or "cover: Field Notes on Systems, second edition".
A media slide names where the picture comes from in "source", for example "The Quiet Engine (2031), dir. Mara Ellison", "Field Notes on Systems, Example Press" or "Screenshot: example.com". It is shown small at the bottom left. The source never goes in the title or subtitle; the subtitle still says what the slide means.
Essay and diagram art are made for abstract ideas only. A generated picture standing in for a real, nameable thing is wrong even when it looks good.

Visual directions: lines the speaker wrote about what to show (graphics, animations, art, videos, GIFs), given below when the section has them. They are never spoken. Follow them.

Titles: the talk file is Markdown and its headings are the talk's structure. When the section has the speaker's own heading, the first slide's title is that heading exactly, and you write its subtitle and the titles and subtitles of the section's later slides. Without a heading, you write every title and subtitle. The enclosing headings (talk, part) tell you where the section sits; keep titles consistent with them.

Return only JSON, no prose:
{"slides":[{"kind":"full","title":"...","sub":"...","source":null,"bullets":null,"image":null,"art":"...","artType":"essay","count":3}]}
The counts must add up to exactly the number of sentences in the section.`;

type Meta = { title?: string; subtitle?: string; artStyle?: string; otherTitles?: string };

function userPrompt(sec: Section, all: Section[], images: string[], previous?: SectionDesign, direction?: string, meta: Meta = {}, carried?: { design: SectionDesign; lines: string[] }, real: RealThing[] = []): string {
  const talk = all.map(s => `[${s.index}] ${s.lines.join(" ")}`).join("\n");
  const parts = [
    ...(meta.title ? [`The talk is titled "${meta.title}"${meta.subtitle ? `, subtitle "${meta.subtitle}"` : ""}. The opening slide uses these as its title and subtitle.`] : []),
    ...(meta.artStyle ? [`The deck's art style, for your information (do not repeat it in briefs): ${meta.artStyle}`] : []),
    `The whole talk, one section per line, for context:\n${talk}`,
    ...(meta.otherTitles ? [`Slide titles already designed for other sections, for consistency:\n${meta.otherTitles}`] : []),
    `Design section ${sec.index} of ${all.length}. Its ${sec.lines.length} sentences, in order:\n${sec.lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`,
    `Available image files: ${images.length ? images.join(", ") : "none"}`,
    ...(real.length ? [`Real things this section names, with their real picture already in the image files. The slide whose sentences name one shows that file with artType "media":\n${real.map(t => `- ${t.name}${t.what ? ` (${t.what})` : ""}: ${basename(t.image)}`).join("\n")}`] : []),
    ...(sec.outline?.length ? [`Where this section sits in the talk's outline: ${sec.outline.map(h => h.text).join(" › ")}`] : []),
    ...(sec.title ? [`The speaker titled this section "${sec.title}". The first slide's title is exactly that.`] : []),
    ...(sec.visuals?.length ? [`The speaker's visual directions for this section (not spoken; follow them):\n${sec.visuals.map(v => "- " + v).join("\n")}`] : []),
  ];
  if (previous) parts.push(`The speaker asked for a new design for this section. The previous one was:\n${JSON.stringify(previous.slides)}\nGive a genuinely different take; keep only what was clearly right.`);
  if (carried) parts.push(`This section was edited since it was last designed. Its sentences were:\n${carried.lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}\nand its design was:\n${JSON.stringify(carried.design.slides)}\nKeep whatever still fits the new sentences: titles, slide types, image files, art briefs and art types. Change only what the edit requires, and re-split the counts to the new sentences.`);
  if (direction) parts.push(`Direction from the speaker for this section: ${direction}`);
  return parts.join("\n\n");
}

async function designSection(sec: Section, all: Section[], images: string[], previous?: SectionDesign, direction?: string, meta: Meta = {}, carried?: { design: SectionDesign; lines: string[] }, things: RealThing[] = []): Promise<SectionDesign> {
  const real = thingsIn(sec.lines, things);
  const { inference } = await import("../../../LIFEOS/TOOLS/Inference.ts");
  let feedback = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await inference({
      systemPrompt: SYSTEM, userPrompt: userPrompt(sec, all, images, previous, direction, meta, carried, real) + feedback,
      level: "high", expectJson: true, vendor: "anthropic", allowVendorFallback: false, timeout: 240000,
    });
    if (!r.success) throw new Error(`section ${sec.index}: inference failed: ${r.error}`);
    const parsed = (r.parsed ?? {}) as { slides?: SlideDesign[] };
    const slides = (parsed.slides ?? []).map(s => ({
      kind: s.kind, title: String(s.title ?? "").trim(), sub: s.sub ? String(s.sub).trim() : undefined,
      source: s.source ? String(s.source).trim() : undefined,
      bullets: Array.isArray(s.bullets) && s.bullets.length ? s.bullets.map(String) : undefined,
      image: s.image || null, art: s.image ? null : (s.art ? String(s.art).trim() : null),
      artType: (ART_TYPES as readonly string[]).includes(String(s.artType)) ? s.artType : "essay", count: Number(s.count),
    })) as SlideDesign[];
    if (slides.every(x => Number.isInteger(x.count))) applyRealThings(slides, sec.lines, real);
    if (sec.title && slides[0]) slides[0].title = sec.title;
    const errs = validateDesign({ slides }, sec.lines.length, images);
    if (!errs.length) return { model: r.executedModel ?? "unknown", designedAt: new Date().toISOString(), slides, ...(direction ? { direction } : {}) };
    feedback = `\n\nYour previous answer was rejected: ${errs.join("; ")}. Fix these and return the JSON again.`;
  }
  throw new Error(`section ${sec.index}: no valid design after 2 attempts`);
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => { while (queue.length) await fn(queue.shift()!); }));
}

// ── Keynote (JXA) ───────────────────────────────────────────────────────────

// Geometry on the 1920×1080 canvas. Text boxes made by script are left-aligned and grow downward.
export const GEOMETRY = { ...LAYOUT_GEOMETRY, footerY: 1022, footerX: 1500, pageX: 1860, logoX: 1458 };

const JXA_BUILD = String.raw`
${LAYOUT_JS}
function run(argv) {
  const spec = JSON.parse($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null).js);
  const st = spec.style || {}, G = spec.geometry;
  const K = Application("Keynote");
  const doc = K.Document({ documentTheme: K.themes.byName(spec.theme), width: 1920, height: 1080 }).make();
  // Save to the local output path before any edit. An untitled document that stays open through a long build is
  // autosaved by Keynote into iCloud under a name of its own, before the autoplay patch, so every GIF in that copy
  // waits for a click (2026-10-04: an untitled "<talk name> 22–24" copy appeared there within seconds of each build).
  doc.save({ in: Path(spec.out) });
  let step = "layouts";
  const paint = (ref, tok) => { if (!tok) return; if (tok.font) ref.font = tok.font; if (tok.size) ref.size = tok.size; if (tok.color) ref.color = tok.color; };
  // A pushed text item is not reliably the last element (hidden placeholders reorder), so find it by its text.
  const addText = (slide, text, tok, x, y, w) => {
    slide.textItems.push(K.TextItem({ objectText: text }));
    const items = slide.textItems();
    for (let i = items.length - 1; i >= 0; i--) if (items[i].objectText() === text) {
      const t = slide.textItems[i]; paint(t.objectText, tok); t.width = w; t.position = { x: x, y: y }; return t;
    }
    throw new Error("text item not found after insert: " + text.slice(0, 40));
  };
  // Keynote turns an inserted animated GIF into a looping movie object, so it lands in slide.movies, not slide.images.
  const addImage = (slide, file) => {
    slide.images.push(K.Image({ file: Path(file) }));
    return /\.gif$/i.test(file) ? slide.movies[slide.movies.length - 1] : slide.images[slide.images.length - 1];
  };
  const rect = (o, role) => { const p = o.position(); return { role: role, x: p.x, y: p.y, w: o.width(), h: o.height() }; };
  try {
    const names = doc.slideLayouts().map(l => l.name());
    const blank = names.includes("Blank") ? "Blank" : names[names.length - 1];
    if (st.ground) { // slide fill is read-only in the dictionary; a full-bleed image on the master sits behind everything
      step = "ground";
      const m = doc.slideLayouts.byName(blank);
      m.images.push(K.Image({ file: Path(st.ground) }));
      const g = m.images[m.images.length - 1];
      g.width = 1920; g.height = 1080; g.position = { x: 0, y: 0 }; g.locked = true;
    }
    const layouts = [];
    spec.slides.forEach((s, i) => {
      const n = i + 1; let slide; step = "slide " + n + " layout";
      if (i === 0) { slide = doc.slides[0]; slide.baseLayout = doc.slideLayouts.byName(blank); }
      else { doc.slides.push(K.Slide({ baseLayout: doc.slideLayouts.byName(blank) })); slide = doc.slides[doc.slides.length - 1]; }
      // Items stack in creation order, so the picture goes in first and the text lands on top of it.
      // Placement comes from LAYOUT_JS (Layout.ts) once the text has been measured.
      step = "slide " + n + " image";
      const im = addImage(slide, s.image || spec.placeholder);
      const iw = s.px ? s.px[0] : im.width(), ih = s.px ? s.px[1] : im.height();
      const mode = s.image ? lectureMode(s.kind, s.artType, iw, ih, s.scene) : (s.kind === "split" ? "split" : "bleed");
      step = "slide " + n + " text";
      const feat = mode === "feature" ? lectureLayout(mode, iw, ih, 0, 0, G) : null;
      const tx = feat ? feat.textX : G.margin, tw = feat ? feat.textW : G.titleW;
      const scaled = (tok, k) => tok && tok.size ? Object.assign({}, tok, { size: Math.round(tok.size * k) }) : tok;
      // Beside a standing picture the type grows to fill its column: as large as the longest word allows, then
      // stepped down until the title block takes at most featureFill of the column height.
      let k = 1;
      if (feat) {
        const longest = Math.max.apply(null, s.title.split(/\s+/).map(w => w.length));
        const base = (st.title && st.title.size) || 72;
        k = Math.max(1, Math.min(G.featureTitleScale, tw / (longest * G.glyphW * base)));
      }
      const t = addText(slide, s.title, feat ? scaled(st.title, k) : st.title, tx, G.titleY, tw);
      const sub = s.sub ? addText(slide, s.sub, feat ? scaled(st.sub, Math.min(G.featureSubScale, k)) : st.sub, tx + 4, G.titleY + t.height() + 2, tw) : null;
      if (feat) {
        const room = G.featureFill * (G.bodyBottom - G.featureTop);
        while (k > 1 && t.height() + (sub ? sub.height() : 0) > room) {
          k = Math.max(1, k - 0.1);
          paint(t.objectText, scaled(st.title, k));
          if (sub) paint(sub.objectText, scaled(st.sub, Math.min(G.featureSubScale, k)));
        }
      }
      if (feat) { // beside a standing picture, the title block is centred on it
        const blockH = t.height() + (sub ? 2 + sub.height() : 0), y0 = Math.max(G.titleY, Math.round(feat.textCenterY - blockH / 2));
        t.position = { x: tx, y: y0 };
        if (sub) sub.position = { x: tx + 4, y: y0 + t.height() + 2 };
      }
      const headerBottom = sub ? sub.position().y + sub.height() : t.position().y + t.height();
      const bl = s.kind === "split" && s.bullets.length ? addText(slide, s.bullets.map(b => "\u2022  " + b).join("\n"), st.bullets, G.bulletsX, G.bodyTop, G.bulletsW) : null;
      const L = feat || lectureLayout(mode, iw, ih, headerBottom, bl ? bl.height() : 0, G);
      step = "slide " + n + " place";
      im.width = L.image.w; im.height = L.image.h; im.position = { x: L.image.x, y: L.image.y };
      if (bl) bl.position = { x: G.bulletsX, y: L.bulletsY };
      if (!s.image) {
        const full = mode === "bleed";
        addText(slide, (s.artType === "diagram" ? "DIAGRAM NEEDED \u00B7 " : s.artType === "media" ? "MEDIA NEEDED \u00B7 " : "ART NEEDED \u00B7 ") + s.art, st.caption,
          full ? G.margin : L.image.x, full ? 940 : L.image.y + L.image.h - 140, full ? 1300 : L.image.w);
      }
      const items = [rect(t, "title")];
      if (sub) items.push(rect(sub, "sub"));
      if (bl) items.push(rect(bl, "bullets"));
      items.push(Object.assign({ role: "image" }, L.image));
      layouts.push({ n: n, title: s.title, mode: mode, hasImage: !!s.image, px: s.px || undefined, items: items });
      if (s.source) { step = "slide " + n + " source"; addText(slide, s.source, st.source, G.margin, G.footerY, G.logoX - G.margin - 60); }
      if (st.footer && st.footer.text) {
        step = "slide " + n + " footer";
        addText(slide, st.footer.text, st.footer, G.footerX, G.footerY, 300);
        addText(slide, String(n), st.footer, G.pageX, G.footerY, 50);
        if (st.footer.logo) { const lg = addImage(slide, st.footer.logo); lg.height = 28; lg.position = { x: G.logoX, y: G.footerY }; }
      }
      step = "slide " + n + " notes";
      slide.presenterNotes = s.notes.join("\n\n");
    });
    step = "save";
    // A plain save: the document already lives at spec.out. A second save-in to its own path is a Save As over
    // itself, and the export that follows then fails with "the file has been changed by another application".
    doc.save();
    step = "export";
    if (spec.exportDir) doc.export({ to: Path(spec.exportDir), as: "slide images" }); // PNG is the default; passing imageFormat throws "Can't convert types"
    const count = doc.slides().length;
    doc.close({ saving: "no" });
    return JSON.stringify({ ok: true, slides: count, layouts: layouts });
  } catch (e) {
    doc.close({ saving: "no" });
    return JSON.stringify({ ok: false, error: step + ": " + String(e) });
  }
}`;

const JXA_READ_NOTES = String.raw`
function run(argv) {
  const K = Application("Keynote");
  const doc = K.open(Path(argv[0]));
  const notes = doc.slides().map(s => s.presenterNotes());
  doc.close({ saving: "no" });
  return JSON.stringify(notes);
}`;

async function osa(script: string, args: string[]): Promise<string> {
  const file = join(tmpdir(), `keynote-${process.pid}-${Date.now()}.js`);
  writeFileSync(file, script);
  try {
    const p = Bun.spawn(["osascript", "-l", "JavaScript", file, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`osascript exited ${code}: ${err.trim()}`);
    return out.trim();
  } finally { rmSync(file, { force: true }); }
}

/**
 * A running Keynote that ignores a trivial AppleEvent will time out the build after two minutes (2026-10-02:
 * after two hours of builds it sat at 0% CPU with ~8.5 GB resident and no windows). Ask it first.
 */
export async function keynoteResponsive(seconds = 20): Promise<boolean> {
  if (Bun.spawnSync(["pgrep", "-x", "Keynote"]).exitCode !== 0) return true; // not running: the build launches it
  const p = Bun.spawn(["osascript", "-l", "JavaScript", "-e", 'Application("Keynote").documents.length'], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), seconds * 1000);
  const code = await p.exited; clearTimeout(timer);
  return code === 0;
}

export async function readNotes(keyFile: string): Promise<string[]> {
  return JSON.parse(await osa(JXA_READ_NOTES, [resolve(keyFile)]));
}

/** Notes read back from the deck, split into sentences, must equal READ.md's sentences exactly. */
export function diffNotes(sections: Section[], notes: string[]): string[] {
  const want = sections.flatMap(s => s.lines);
  const got = notes.flatMap(n => n.replace(/\r/g, "").split("\n").map(l => l.trim()).filter(Boolean));
  const out: string[] = [];
  for (let i = 0; i < Math.max(want.length, got.length); i++)
    if (want[i] !== got[i]) { out.push(`sentence ${i + 1}: want ${JSON.stringify(want[i])} got ${JSON.stringify(got[i])}`); if (out.length >= 10) break; }
  return out;
}

// ── Style ───────────────────────────────────────────────────────────────────

const HEX = /^#?([0-9a-f]{6})$/i;
export function rgb16(hex: string): [number, number, number] {
  const m = hex.match(HEX); if (!m) throw new Error(`bad colour '${hex}' (want #rrggbb)`);
  const n = parseInt(m[1], 16); return [((n >> 16) & 255) * 257, ((n >> 8) & 255) * 257, (n & 255) * 257];
}

/** A 16×9 solid PNG; Keynote keeps an image's aspect, so a full-bleed fill must already be 16:9. */
export function solidPng(hex: string): Buffer {
  const [r, g, b] = rgb16(hex).map(v => v / 257);
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const x of buf) c = table[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16, 0); ihdr.writeUInt32BE(9, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.from([0, ...Array.from({ length: 16 }, () => [r, g, b]).flat()]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array(9).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}

const TOKENS = ["title", "sub", "bullets", "caption", "footer"] as const;

export function loadStyle(path: string | undefined): Style {
  if (!path) return {};
  if (!existsSync(path)) throw new Error(`style file not found: ${path}`);
  const st = JSON.parse(readFileSync(path, "utf8")) as Style;
  for (const c of [st.ground, st.placeholder]) if (c) rgb16(c);
  for (const k of TOKENS) if (st[k]?.color) rgb16(st[k]!.color!);
  if (st.footer?.logo && !existsSync(st.footer.logo)) throw new Error(`footer logo not found: ${st.footer.logo}`);
  return st;
}

const tokenFor = (t?: TextToken) => t ? {
  ...(t.font ? { font: t.font } : {}), ...(t.size ? { size: t.size } : {}), ...(t.color ? { color: rgb16(t.color) } : {}),
} : undefined;

// Defaults when a style file leaves a token out: readable, theme-neutral.
const DEFAULT_TOKENS: Required<Pick<Style, "title" | "sub" | "bullets" | "caption">> = {
  title: { size: 72 }, sub: { size: 36 }, bullets: { size: 48 }, caption: { size: 22 },
};

// ── Files ───────────────────────────────────────────────────────────────────

function loadDesigns(path: string): DesignFile {
  if (!existsSync(path)) return { version: 2, designs: {} };
  const f = JSON.parse(readFileSync(path, "utf8"));
  if (typeof f.designs !== "object") throw new Error(`${path} is not a design file`);
  if (f.version === 1) { // v1 used seven text-led kinds; keep the talk's settings, redesign every section
    console.log(`${basename(path)} holds v1 designs; every section will be redesigned for the full/split slide types`);
    return { version: 2, theme: f.theme, style: f.style, title: f.title, subtitle: f.subtitle, designs: {} };
  }
  if (f.version !== 2) throw new Error(`${path} has unknown version ${f.version}`);
  return f as DesignFile;
}

function saveDesigns(path: string, f: DesignFile) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * The pictures a design may name. Brand marks (logo, footer, favicon) are left out unless a registered real picture
 * has that name: `keep` lists those, because a real product-logo.png is staged into this folder and the build requires it.
 */
export function listImages(dir: string | undefined, keep: string[] = []): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter(f => IMAGE_EXT.has(extname(f).toLowerCase()) && (keep.includes(f) || !/logo|footer|favicon/i.test(f))).sort();
}

/**
 * The folder a deck's slide pictures live in: the design file's own, else the talk's `images` or `deck/images`, else
 * (when real pictures must be staged) a new `images`. KeynoteArt resolves it through here too, so art placed into the
 * folder the build already reads never repoints existing slides at a different one.
 */
export function deckImageDir(file: { images?: string }, talkDir: string, stagedCount = 0): string | undefined {
  return file.images ?? [join(talkDir, "images"), join(talkDir, "deck", "images")].find(existsSync) ?? (stagedCount ? join(talkDir, "images") : undefined);
}

// ── Self-test ───────────────────────────────────────────────────────────────

function selfTest(): number {
  let fail = 0;
  const t = (name: string, ok: boolean) => { if (!ok) fail++; console.log(`${ok ? "✓" : "✗"} ${name}`); };
  const md = "First line.\n\nSecond line.\n\n---\n\nThird line.\n\n---\n\nFourth.\n\nFifth.\n\nSixth.\n";
  const secs = parseRead(md);
  t("parses one section per --- block", secs.length === 3);
  t("keeps each sentence line in order", JSON.stringify(secs.map(s => s.lines.length)) === "[2,1,3]" && secs[2].lines[2] === "Sixth.");
  // The speaker's own format (2026-10-02 talk file): "-" separators, (stage notes), a # title line.
  const own = parseRead("# My Talk\n\nThanks for having me.\n\n(Intro slide)\n\n-\n\nSecond point.\n\n- not a separator, a dash bullet\n\n--\n\nThird.\n");
  t("one, two or three dashes separate talking points", own.length === 3);
  t("a (stage note) and a # title are directions, never spoken", own[0].lines.join("|") === "Thanks for having me." && own[0].visuals?.join("|") === "Title on this slide: My Talk|Intro slide");
  t("a dash followed by text is spoken, not a separator", own[1].lines.length === 2);
  {
    const tmp = mkdtempSync(join(tmpdir(), "keynote-img-"));
    try {
      mkdirSync(join(tmp, "images"));
      for (const f of ["a.png", "product-logo.png", "footer.png"]) writeFileSync(join(tmp, "images", f), "x");
      t("brand marks are not offered to a design", JSON.stringify(listImages(join(tmp, "images"))) === JSON.stringify(["a.png"]));
      t("a registered real picture named like a logo is offered", JSON.stringify(listImages(join(tmp, "images"), ["product-logo.png"])) === JSON.stringify(["a.png", "product-logo.png"]));
      t("art lands in the folder the build already reads", deckImageDir({}, tmp) === join(tmp, "images") && deckImageDir({ images: "/x/y" }, tmp) === "/x/y");
      t("no pictures folder and nothing to stage means no folder", deckImageDir({}, join(tmp, "nope")) === undefined && deckImageDir({}, join(tmp, "nope"), 1) === join(tmp, "nope", "images"));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  t("a stage note mentioning a parenthesis mid-sentence stays spoken", parseRead("I said (quietly) no.\n")[0].lines.length === 1);
  {
    // Duplicate slides (2026-10-04): the same clip on two slides, or a still repeated with slides between.
    const d = (imgs: (string | null)[]) => duplicateIssues(imgs.map((image, i) => ({ title: `s${i + 1}`, image }))).map(x => x.slide);
    t("a GIF on two slides fails, even back to back", JSON.stringify(d(["a.gif", "a.gif"])) === "[2]");
    t("a still held across two consecutive slides fails", JSON.stringify(d(["a.png", "a.png", "b.png"])) === "[2]");
    t("a still repeated after other slides fails", JSON.stringify(d(["a.png", "b.png", "a.png"])) === "[3]");
    t("slides without a picture never count as duplicates", d([null, null]).length === 0);
    t("a slide marked reprise may show an earlier picture again", duplicateIssues([{ title: "a", image: "x.gif" }, { title: "b", image: "y.png" }, { title: "c", image: "x.gif", reprise: true }]).length === 0);
    t("cloudDecks of a missing folder is empty, not an error", cloudDecks("/nonexistent-dir").size === 0);
    // The build judges assemble()'s output, so a reprise saved in the design file must survive it (2026-10-04: it was dropped once).
    const rs = parseRead("# One\n\nFirst.\n\n# Two\n\nSecond.\n\n# Three\n\nThird.\n");
    const slide = (image: string, reprise?: boolean) => ({ model: "t", designedAt: "", slides: [{ kind: "full" as Kind, title: "x", image, count: 1, reprise }] });
    const df = { version: 2 as const, designs: { [rs[0].hash]: slide("a.gif"), [rs[1].hash]: slide("b.png"), [rs[2].hash]: slide("a.gif", true) } };
    t("a reprise set in the design file reaches the duplicate gate", duplicateIssues(assemble(rs, df)).length === 0 && duplicateIssues(assemble(rs, { ...df, designs: { ...df.designs, [rs[2].hash]: slide("a.gif") } })).length === 1);
  }
  {
    // Markdown structure is the talk's structure (2026-10-03): every heading starts a talking point and titles it.
    const md2 = "# The Talk\n\nHello.\n\n## Part One\n\n### First point\n\nSpoken a.\n\n> gif: a loop of a wave\n\nSpoken b.\n\n### Second point\n\nSpoken c.\n\n-\n\nSpoken d.\n\n## Part Two\n\nSpoken e.\n";
    const m = parseRead(md2);
    t("every heading starts a talking point, no dashes needed", JSON.stringify(m.map(s => s.lines.join("|"))) === JSON.stringify(["Hello.", "Spoken a.|Spoken b.", "Spoken c.", "Spoken d.", "Spoken e."]));
    t("a heading is the section's title, verbatim", m[1].title === "First point" && m[1].level === 3 && m[4].title === "Part Two" && m[3].title === undefined);
    t("a heading-only part survives as outline context", JSON.stringify(m[1].outline?.map(h => h.text)) === JSON.stringify(["The Talk", "Part One"]) && JSON.stringify(m[3].outline?.map(h => h.text)) === JSON.stringify(["The Talk", "Part One", "Second point"]));
    t("> lines stay directions inside a heading section", m[1].visuals?.includes("gif: a loop of a wave") === true);
    t("an empty heading placeholder is never spoken", JSON.stringify(parseRead("## Point\n\nSaid.\n\n##\n\n###\n\nLater.\n").map(s => s.lines.join("|"))) === JSON.stringify(["Said.", "Later."]));
    t("a deeper heading closes at a shallower one", JSON.stringify(m[4].outline?.map(h => h.text)) === JSON.stringify(["The Talk"]));
    t("a title at the top of a dash section keeps its old design key", parseRead("# T\n\nA.\n\n-\n\nB.\n")[0].hash === hashLines(["A.", "> Title on this slide: T"]));
    t("rewriting a structured file keeps every heading and hash", JSON.stringify(parseRead(writeRead(m)).map(s => [s.hash, s.title, s.outline?.map(h => h.text).join(">")])) === JSON.stringify(m.map(s => [s.hash, s.title, s.outline?.map(h => h.text).join(">")])));
    const mv = parseRead(moveSection(md2, 3, 2));
    t("a moved talking point keeps its heading", mv[1].title === "Second point" && mv[1].lines[0] === "Spoken c." && mv[2].title === "First point");
  }
  {
    const one: DesignFile = { version: 2, designs: { h: { model: "x", designedAt: "x", slides: [{ kind: "split", title: "T", bullets: ["a", "b"], image: "w.png", count: 1 }] } } };
    const next = setField(one, { hash: "h", idx: 0 }, "kind", "full");
    t("--set kind full drops the bullets so the slide validates", next.designs.h.slides[0].kind === "full" && !next.designs.h.slides[0].bullets?.length && validateDesign(next.designs.h, 1, ["w.png"]).length === 0);
  }
  t("hash is stable and text-sensitive", secs[0].hash === hashLines(["First line.", "Second line."]) && secs[0].hash !== hashLines(["First line.", "Second line!"]));
  const ok: SlideDesign[] = [
    { kind: "full", title: "Two beats", art: "A lighthouse on the right half", count: 1 },
    { kind: "split", title: "Three", bullets: ["One thing", "Another thing"], image: "real.png", count: 2 },
  ];
  t("valid full + split design passes", validateDesign({ slides: ok }, 3, ["real.png"]).length === 0);
  t("dropped sentence fails", validateDesign({ slides: [ok[0]] }, 3, []).length > 0);
  t("extra sentence fails", validateDesign({ slides: [...ok, { ...ok[0] }] }, 3, ["real.png"]).length > 0);
  t("over 5 sentences on one slide fails", validateDesign({ slides: [{ ...ok[0], count: 6 }] }, 6, []).length > 0);
  t("unknown kind fails", validateDesign({ slides: [{ ...ok[0], kind: "statement" as Kind }] }, 1, []).length > 0);
  t("image not in the folder fails", validateDesign({ slides: [{ ...ok[0], image: "made-up.png" }] }, 1, ["real.png"]).length > 0);
  {
    const film = { kind: "full" as const, title: "WREN in The Quiet Engine", image: "real.png", artType: "media" as const, count: 1 };
    t("a film credit as a media subtitle fails", validateDesign({ slides: [{ ...film, sub: "The Quiet Engine (2031), written and directed by Mara Ellison" }] }, 1, ["real.png"]).some(e => /is a credit/.test(e)));
    t("the credit in source with a meaning subtitle passes", validateDesign({ slides: [{ ...film, sub: "An assistant that knows you", source: "The Quiet Engine (2031), dir. Mara Ellison" }] }, 1, ["real.png"]).length === 0);
    t("--set source writes the field", setField({ version: 2, designs: { h: { model: "x", designedAt: "x", slides: [film] } } }, { hash: "h", idx: 0 }, "source", "The Quiet Engine (2031)").designs.h.slides[0].source === "The Quiet Engine (2031)");
  }
  t("a slide with neither image nor art fails", validateDesign({ slides: [{ kind: "full", title: "x", count: 1 }] }, 1, []).length > 0);
  t("a split slide without bullets fails", validateDesign({ slides: [{ ...ok[1], bullets: [] }] }, 2, ["real.png"]).length > 0);
  t("a split slide with 5 bullets fails", validateDesign({ slides: [{ ...ok[1], bullets: ["a", "b", "c", "d", "e"] }] }, 2, ["real.png"]).length > 0);
  t("a full slide with bullets fails", validateDesign({ slides: [{ ...ok[0], bullets: ["a"] }] }, 1, []).length > 0);
  const file: DesignFile = { version: 2, designs: {
    [secs[0].hash]: { model: "m", designedAt: "", slides: [{ ...ok[0], count: 2 }] },
    [secs[1].hash]: { model: "m", designedAt: "", slides: [{ ...ok[0], count: 1 }] },
  } };
  {
    const one = (image: string, artType?: ArtType): SectionDesign => ({ model: "x", designedAt: "x", slides: [{ kind: "full", title: image, image, artType, count: 1 }] });
    const ss = ["a", "b", "c", "d", "e"].map((h, i) => ({ index: i + 1, hash: h, lines: ["x"] }));
    const deck = (imgs: [string, ArtType?][]): DesignFile => ({ version: 2, designs: Object.fromEntries(imgs.map(([im, at], i) => [ss[i].hash, one(im, at)])) });
    t("three animated essays pass", animatedEssayError(ss, deck([["1.gif"], ["2.gif"], ["3.gif"], ["4.png"]])) === null);
    t("a fourth animated essay is refused", animatedEssayError(ss, deck([["1.gif"], ["2.gif"], ["3.gif"], ["4.GIF"]]))?.includes("max 3") === true);
    t("media clips do not count toward the limit", animatedEssayError(ss, deck([["1.gif"], ["2.gif"], ["3.gif"], ["4.gif", "media"], ["5.gif", "media"]])) === null);
    t("animated diagrams do not count toward the limit", animatedEssayError(ss, deck([["1.gif"], ["2.gif"], ["3.gif"], ["4.gif", "diagram"], ["5.gif", "diagram"]])) === null);
    t("a style file's animatedEssayMax overrides the default", animatedEssayError(ss, deck([["1.gif"], ["2.gif"], ["3.gif"], ["4.gif"]]), 4) === null && animatedEssayError(ss, deck([["1.gif"], ["2.gif"]]), 1)?.includes("max 1") === true);
  }
  {
    const v = parseRead("> video: a clip of the thing\n\nSpoken one.\n\n> still: a photo\n\nSpoken two.\n\n---\n\nPlain.\n");
    t("visual lines are not spoken", JSON.stringify(v[0].lines) === JSON.stringify(["Spoken one.", "Spoken two."]));
    t("visual lines are kept as directions", JSON.stringify(v[0].visuals) === JSON.stringify(["video: a clip of the thing", "still: a photo"]));
    t("a section without visuals keeps its old hash", v[1].hash === hashLines(["Plain."]) && v[1].visuals === undefined);
    t("visual lines change the section hash", v[0].hash !== hashLines(["Spoken one.", "Spoken two."]));
    t("writeRead keeps visual lines", parseRead(writeRead(v))[0].visuals?.length === 2 && parseRead(writeRead(v))[0].hash === v[0].hash);
    t("a section of only visual lines is dropped", parseRead("> only a direction\n\n---\n\nSpoken.").length === 1);
  }
  t("only sections without a design are selected", JSON.stringify(needsDesign(secs, file, new Set()).map(s => s.index)) === "[3]");
  t("--section forces a designed section", JSON.stringify(needsDesign(secs, file, new Set([1])).map(s => s.index)) === "[1,3]");
  const edited = parseRead(md.replace("Third line.", "Third line, rewritten."));
  t("an edited section loses its design", needsDesign(edited, file, new Set()).some(s => s.index === 2));
  file.designs[secs[2].hash] = { model: "m", designedAt: "", slides: [{ ...ok[0], count: 1 }, { ...ok[1], count: 2 }] };
  const slides = assemble(secs, file);
  t("notes come from READ.md, split by count", slides.length === 4 && slides[3].notes.join("|") === "Fifth.|Sixth.");
  t("notes read-back matches", diffNotes(secs, slides.map(s => s.notes.join("\n\n"))).length === 0);
  t("a changed spoken word is caught", diffNotes(secs, slides.map((s, i) => i === 0 ? "First line.\n\nSecond line!" : s.notes.join("\n\n"))).length === 1);
  const moved = parseRead(moveSection(md, 3, 1));
  t("--move puts the section at its new position", moved[0].lines[0] === "Fourth." && moved[1].lines[0] === "First line." && moved.length === 3);
  t("--move keeps every section's text, so every hash survives", JSON.stringify(moved.map(x => x.hash).sort()) === JSON.stringify(secs.map(x => x.hash).sort()));
  t("a moved file parses back to the same sections", JSON.stringify(parseRead(writeRead(secs)).map(x => x.hash)) === JSON.stringify(secs.map(x => x.hash)));
  const withLines: DesignFile = { ...JSON.parse(JSON.stringify(file)), lines: { [secs[0].hash]: secs[0].lines, [secs[1].hash]: secs[1].lines, [secs[2].hash]: secs[2].lines } };
  const editedThird = parseRead(md.replace("Sixth.", "Sixth, now longer."));
  const orphan = closestOrphan(editedThird[2], editedThird, withLines);
  t("an edited section finds its earlier design", orphan?.hash === secs[2].hash);
  t("an unchanged section is not offered an orphan", needsDesign(editedThird, withLines, new Set()).map(x => x.index).join() === "3");
  t("unrelated text finds no earlier design", closestOrphan(parseRead("Totally new.\n\nNothing shared.")[0], editedThird, withLines) === null);
  const loc = locate(secs, withLines, 4);
  t("slide numbers map to section and index", loc.hash === secs[2].hash && loc.idx === 1);
  const retitled = setField(withLines, loc, "title", "New title");
  const diff = JSON.stringify(retitled.designs).length - JSON.stringify(withLines.designs).length;
  t("--set changes exactly one field of one slide", retitled.designs[secs[2].hash].slides[1].title === "New title" && retitled.designs[secs[2].hash].slides[0].title === withLines.designs[secs[2].hash].slides[0].title && diff === "New title".length - withLines.designs[secs[2].hash].slides[1].title.length);
  t("an unknown art type fails", validateDesign({ slides: [{ ...ok[0], artType: "photo" as ArtType }] }, 1, []).length > 0);
  const png = solidPng("#336699");
  t("fill PNG is a 16x9 PNG", png.subarray(1, 4).toString() === "PNG" && png.readUInt32BE(16) === 16 && png.readUInt32BE(20) === 9);
  t("colours convert to 16-bit RGB", JSON.stringify(rgb16("#ff0080")) === "[65535,0,32896]");
  t("split image column stays right of the bullets", GEOMETRY.splitX >= GEOMETRY.bulletsX + GEOMETRY.bulletsW && GEOMETRY.splitX < 1920 - GEOMETRY.margin);
  t("the layout engine's own self-test passes", layoutSelfTest() === 0);
  console.log(fail ? `${fail} failed` : "all passed");
  return fail ? 1 : 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const has = (n: string) => args.includes(`--${n}`);
  if (has("help")) { console.log(readFileSync(join(import.meta.dir, "Keynote.help.md"), "utf8")); process.exit(0); }
  if (has("self-test")) process.exit(selfTest());

  const readPath = flag("read");
  if (!readPath || !existsSync(readPath)) { console.error("usage: bun Keynote.ts --read <READ.md> [--out deck.key] … (--help for all options)"); process.exit(2); }
  const dir = dirname(resolve(readPath));
  const sections = parseRead(readFileSync(readPath, "utf8"));
  const designPath = resolve(flag("design") ?? join(dir, "KEYNOTE.json"));
  const file = loadDesigns(designPath);
  file.lines ??= {};
  for (const sec of sections) if (file.designs[sec.hash]) file.lines[sec.hash] = sec.lines;
  if (flag("images")) file.images = resolve(flag("images")!);
  if (flag("out")) file.out = resolve(flag("out")!);
  let things: RealThing[] = [];
  try { things = loadRealThings(flag("real") ? resolve(flag("real")!) : defaultRealThingsPath()); }
  catch (e) { console.error(`❌ ${(e as Error).message}`); process.exit(2); }
  const named = things.filter(t => sections.some(sec => thingsIn(sec.lines, [t]).length));
  const imageDir = deckImageDir(file, dir, named.length);
  if (imageDir) stageRealImages(named, imageDir);
  const images = listImages(imageDir, named.map(t => basename(t.image)));

  if (has("move")) {
    const from = Number(flag("move")), to = Number(flag("to"));
    if (!Number.isInteger(from) || !Number.isInteger(to)) { console.error("usage: --move N --to M (talking-point numbers from --list)"); process.exit(2); }
    const md = readFileSync(readPath, "utf8");
    const next = moveSection(md, from, to);
    writeFileSync(`${readPath}.bak`, md);
    writeFileSync(readPath, next);
    console.log(`✓ talking point ${from} moved to position ${to} (previous file kept as ${basename(readPath)}.bak); rebuild to update the deck`);
    process.exit(0);
  }

  if (has("list")) {
    let n = 0;
    for (const sec of sections) {
      const d = file.designs[sec.hash];
      if (!d) { console.log(`   —  §${sec.index}  (no design yet)  ${sec.lines[0]}`); continue; }
      for (const x of d.slides) console.log(`${String(++n).padStart(4)}  §${String(sec.index).padEnd(3)} ${x.kind.padEnd(5)} ${(x.artType ?? "essay").padEnd(7)} ${x.title}  [${x.image ?? (x.artType === "diagram" ? "DIAGRAM NEEDED" : x.artType === "media" ? "MEDIA NEEDED" : "ART NEEDED")}]`);
    }
    process.exit(0);
  }

  if (has("set")) {
    const i = args.indexOf("--set"), [slideArg, field, ...rest] = args.slice(i + 1);
    const at = locate(sections, file, Number(slideArg));
    const next = setField(file, at, field, rest.join(" "));
    const sec = sections.find(x => x.hash === at.hash)!;
    const errs = validateDesign(next.designs[at.hash], sec.lines.length, images);
    const tooMany = animatedEssayError(sections, next, loadStyle(file.style).animatedEssayMax);
    if (tooMany) errs.push(tooMany);
    if (errs.length) { console.error(`❌ ${errs.join("; ")}`); process.exit(1); }
    saveDesigns(designPath, next);
    console.log(`✓ slide ${slideArg} ${field} set; rebuild to update the deck`);
    process.exit(0);
  }

  if (has("redo-art")) {
    for (const n of (flag("redo-art") ?? "").split(",").filter(Boolean).map(Number)) {
      const at = locate(sections, file, n), x = file.designs[at.hash].slides[at.idx];
      if (!x.art) { console.error(`❌ slide ${n} has no art brief; give one with --set ${n} art "<brief>"`); process.exit(1); }
      x.image = null;
    }
    saveDesigns(designPath, file);
    console.log("✓ cleared; run KeynoteArt.ts to draw them, then rebuild");
    process.exit(0);
  }

  if (has("verify")) {
    const named = flag("verify");
    const key = named && !named.startsWith("--") ? named : file.out;
    if (!key || !existsSync(key)) { console.error("usage: --verify <deck.key> (or build once so the deck path is remembered)"); process.exit(2); }
    const diffs = diffNotes(sections, await readNotes(key));
    for (const d of diffs) console.log(`❌ ${d}`);
    console.log(diffs.length ? `notes differ from ${basename(readPath)}` : `✓ notes in ${basename(key)} match ${basename(readPath)} exactly (${sections.flatMap(s => s.lines).length} sentences)`);
    process.exit(diffs.length ? 1 : 0);
  }

  const forced = new Set((flag("section") ?? "").split(",").filter(Boolean).map(Number));
  for (const n of forced) if (!Number.isInteger(n) || n < 1 || n > sections.length) { console.error(`--section ${n} is out of range 1–${sections.length}`); process.exit(2); }
  const todo = needsDesign(sections, file, forced, has("redesign-all"));

  if (has("status")) {
    const known = sections.filter(s => file.designs[s.hash]);
    const needArt = known.flatMap(s => file.designs[s.hash].slides.filter(x => !x.image).map(x => ({ s: s.index, art: x.art })));
    console.log(`${sections.length} sections · ${known.length} designed · ${sections.length - known.length} need a design · ${needArt.length} slide(s) need art`);
    for (const s of sections.filter(s => !file.designs[s.hash])) console.log(`  design: section ${s.index}: ${s.lines[0]}`);
    for (const a of needArt) console.log(`  art: section ${a.s}: ${a.art}`);
    process.exit(0);
  }

  if (flag("style")) file.style = resolve(flag("style")!);
  if (flag("theme")) file.theme = flag("theme");
  if (flag("title")) file.title = flag("title");
  // A level-1 heading in the talk file names the talk when --title was never given.
  file.title ??= sections.find(s => s.level === 1)?.title ?? sections.flatMap(s => s.outline ?? []).find(h => h.level === 1)?.text;
  if (flag("subtitle")) file.subtitle = flag("subtitle");
  const style = loadStyle(file.style);
  const direction = flag("direction");
  saveDesigns(designPath, file);
  if (todo.length) {
    console.log(`designing ${todo.length} section(s) with the opus tier…`);
    let failed = 0;
    await pool(todo, Number(flag("concurrency") ?? 4), async sec => {
      try {
        const otherTitles = sections.filter(s => s.index !== sec.index && file.designs[s.hash])
          .map(s => `[${s.index}] ${file.designs[s.hash].slides.map(x => x.title).join(" | ")}`).join("\n");
        const orphan = forced.has(sec.index) ? null : closestOrphan(sec, sections, file);
        const carried = orphan ? { design: file.designs[orphan.hash], lines: file.lines![orphan.hash] } : undefined;
        const d = await designSection(sec, sections, images, forced.has(sec.index) ? file.designs[sec.hash] : undefined,
          forced.has(sec.index) ? direction : undefined,
          { title: file.title, subtitle: file.subtitle, artStyle: style.artStyle, otherTitles: otherTitles || undefined }, carried, things);
        file.designs[sec.hash] = d;
        file.lines![sec.hash] = sec.lines;
        saveDesigns(designPath, file);
        console.log(`  ✓ section ${sec.index} → ${d.slides.map(x => `${x.kind}/${x.artType}`).join("+")}${carried ? " (earlier design offered)" : ""} · ${d.model}`);
      } catch (e) { failed++; console.error(`  ❌ ${(e as Error).message}`); }
    });
    if (failed) { console.error(`${failed} section(s) failed to design; nothing built`); process.exit(1); }
  }
  if (has("design-only")) process.exit(0);

  const theme = flag("theme") ?? style.theme ?? file.theme ?? "Basic White";
  const tmpFill = (hex: string | undefined, name: string) => {
    if (!hex) return undefined;
    const p = join(tmpdir(), `keynote-${name}-${process.pid}.png`); writeFileSync(p, solidPng(hex)); return p;
  };
  const groundPath = tmpFill(style.ground, "ground");
  const placeholderPath = tmpFill(style.placeholder ?? "#D9D9D9", "placeholder")!;
  const tooMany = animatedEssayError(sections, file, style.animatedEssayMax);
  if (tooMany) { console.error(`❌ ${tooMany}`); process.exit(1); }
  let realChanged = 0;
  for (const sec of sections) {
    const d = file.designs[sec.hash]; if (!d) continue;
    const r = applyRealThings(d.slides, sec.lines, things);
    for (const c of r.changed) console.log(`  ✓ real picture: ${c}`);
    for (const c of r.crowded) console.log(`  ⚠ ${c} (--section ${sec.index} --direction)`);
    realChanged += r.changed.length;
  }
  if (realChanged) saveDesigns(designPath, file);
  // The deck is named after the talk unless a path was given; whichever path a build writes is remembered.
  const out = file.out ?? join(dir, `${(file.title ?? "deck").replace(/[\/:]/g, "-")}.key`);
  // Every build exports its slides: the pixel gate judges what the audience will see. A temp dir when not asked.
  const exportDir = flag("export") ? resolve(flag("export")!) : join(tmpdir(), `keynote-export-${process.pid}`);
  const exportTemp = !flag("export");
  if (exportDir) { rmSync(exportDir, { recursive: true, force: true }); mkdirSync(dirname(exportDir), { recursive: true }); }
  // Generated art is trimmed to the drawing before it is sized, unless it will bleed edge to edge.
  const cacheDir = join(dir, ".layout-cache");
  const slides = assemble(sections, file).map(s => {
    const artType = s.artType ?? "essay";
    let image = s.image && imageDir ? join(resolve(imageDir), s.image) : null, px: [number, number] | undefined;
    let scene: boolean | undefined;
    if (image) {
      // Every animation moves the moment its slide appears; a GIF that opens on a still is rotated to its motion.
      // Art is trimmed first: its opening frame is the finished drawing, and a rotated loop opens on a faint ghost.
      const gif = /\.gif$/i.test(image);
      px = imageSize(image);
      if (artType !== "media") {
        scene = isScene(inkCover(image));
        if (lectureMode(s.kind, artType, px[0], px[1], scene) !== "bleed") image = prepareImage(image, cacheDir);
        if (gif) image = startOnMotion(image, cacheDir);
        px = imageSize(image);
      } else {
        if (gif) { image = startOnMotion(image, cacheDir); px = imageSize(image); }
        image = roundCorners(image, MEDIA_RADIUS * px[0] / mediaShownWidth(s.kind, px[0], px[1]), style.ground ?? "#FFFFFF", cacheDir);
      }
    }
// Designs made before the source line carried the credit as the subtitle; it moves to the source line.
    const credit = creditSub(s);
    return { kind: s.kind, title: s.title, sub: credit ? "" : s.sub ?? "", source: s.source || (credit ? s.sub! : ""), bullets: s.bullets ?? [], art: s.art ?? "", artType, image, px, scene, notes: s.notes };
  });
  let layoutFixes = 0;
  const tmpKey = join(dirname(out), `.${basename(out, ".key")}.building.key`);
  const specPath = join(tmpdir(), `keynote-spec-${process.pid}.json`);
  const tok = (k: typeof TOKENS[number]) => tokenFor({ ...(DEFAULT_TOKENS as Record<string, TextToken>)[k], ...style[k] });
  const styleSpec = {
    ground: groundPath, title: tok("title"), sub: tok("sub"), bullets: tok("bullets"), caption: tok("caption"),
    source: tokenFor({ ...DEFAULT_TOKENS.caption, ...style.footer }),
    footer: style.footer?.text ? { ...tok("footer"), text: style.footer.text, logo: style.footer.logo } : undefined,
  };
  writeFileSync(specPath, JSON.stringify({ theme, out: tmpKey, exportDir, slides, style: styleSpec, placeholder: placeholderPath, geometry: GEOMETRY }));
  try {
    rmSync(tmpKey, { recursive: true, force: true });
    if (!(await keynoteResponsive())) throw new Error("Keynote is running but not answering (an open dialog, or wedged after a long session). Close the dialog or quit Keynote, then rebuild");
    const cloudBefore = cloudDecks();
    const r = JSON.parse(await osa(JXA_BUILD, [specPath]));
    if (!r.ok) throw new Error(r.error);
    // A deck Keynote autosaved into iCloud during the build is an unpatched duplicate the speaker may open and present.
    const leaked = [...cloudDecks()].filter(n => !cloudBefore.has(n));
    if (leaked.length) throw new Error(`Keynote saved ${leaked.length} copy of this build into iCloud (${leaked.join(", ")}): it is a duplicate whose GIFs wait for a click. Move it to the Trash; the deck to present is ${out}`);
    // Keynote gives every GIF a start-movie build that waits for a click; make each one start on slide entry.
    const { autoplay } = await import("./KeynoteAutoplay.ts");
    const movies = autoplay(tmpKey);
    rmSync(out, { recursive: true, force: true });
    renameSync(tmpKey, out);
    if (file.out !== out) { file.out = out; saveDesigns(designPath, file); }
    const missing = slides.filter(s => !s.image).length;
    console.log(`✓ ${r.slides} slides · theme ${theme} → ${out}${missing ? ` · ${missing} still need art (--status lists them)` : ""}${!exportTemp ? `\n✓ slide images → ${exportDir}` : ""}${movies.length ? `\n✓ ${movies.length} animation${movies.length === 1 ? "" : "s"} set to start on slide entry` : ""}`);
    const issues: Issue[] = (r.layouts as SlideLayout[] ?? []).flatMap(l => layoutIssues(l, GEOMETRY));
    issues.push(...exportCoverageIssues(exportDir, slides.map(x => x.title)));
    if (existsSync(exportDir)) issues.push(...pixelIssues(exportDir, style.ground ?? "#FFFFFF", slides.map(x => x.title)));
    const designed = assemble(sections, file);
    if (existsSync(exportDir)) issues.push(...lookalikeIssues(exportDir, slides.map(x => x.title), new Set(designed.flatMap((x, i) => !x.image || x.reprise ? [i + 1] : []))));
    // Judge the designed picture names: the processed files differ by shown size, so one still could pass as two.
    issues.push(...duplicateIssues(designed));
    // Autoplay is proven from Keynote's own reading of the written deck, never from rereading the patch.
    if (movies.length) {
      const { playback } = await import("./KeynotePlayback.ts");
      try {
        const p = await playback(out);
        for (const n of p.stuck) issues.push({ slide: n, title: slides[n - 1]?.title ?? "", level: "fix", text: "its animation waits for an extra click in Keynote, so it reads as a duplicate slide" });
        if (!p.stuck.length) console.log(`✓ Keynote reads all ${p.animations} animation(s) as starting by themselves`);
      } catch (e) { issues.push({ slide: 0, title: "", level: "fix", text: `autoplay is unproven: Keynote's check failed (${(e as Error).message}); run KeynotePlayback.ts on the deck` }); }
    }
    issues.sort((a, b) => a.slide - b.slide);
    writeFileSync(join(dir, "LAYOUT.json"), JSON.stringify({ builtAt: new Date().toISOString(), deck: out, issues, slides: r.layouts }, null, 2) + "\n");
    for (const x of issues) console.log(`  ${x.level === "fix" ? "❌" : "⚠"} slide ${x.slide} "${x.title}": ${x.text}`);
    const fixes = issues.filter(x => x.level === "fix").length;
    console.log(fixes ? `❌ layout: ${fixes} slide problem(s) to fix (LAYOUT.json); the deck was written` : `✓ layout: every slide balanced${issues.length ? ` · ${issues.length} warning(s)` : ""}`);
    layoutFixes = fixes;
  } catch (e) { console.error(`❌ Keynote build failed: ${(e as Error).message}`); process.exit(2); }
  finally {
    for (const p of [specPath, groundPath, placeholderPath]) if (p) rmSync(p, { force: true });
    if (exportTemp) rmSync(exportDir, { recursive: true, force: true });
  }
  if (layoutFixes) process.exit(4);
}
