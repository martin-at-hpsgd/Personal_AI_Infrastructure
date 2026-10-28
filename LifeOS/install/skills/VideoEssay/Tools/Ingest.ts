#!/usr/bin/env bun
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { loadLifeosConfig } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { REQUEST_CHAR_LIMIT, type Alignment, alignmentToWords, applyPronunciations, chunkHash, concatWithGaps, daVoice, fishSynthesizer, loadPronunciations, principalVoice, probeDuration, toWav, voiceModel, type Synthesizer, type VoiceSettings } from "./Narrate.ts";
import { PARAGRAPH_SPANS_FILE, PITCH_SAMPLE_RATE, TAKE_SCORE_RULE, argValue, ensureDir, loadSkillConfig, normalizeLabel, skipParagraphPatterns, validCaptureUrl, paragraphPitch, readJson, resolveRunDir, runPaths, scoreTake, sha256, spansFromWords, writeJson, type ParagraphPitch, type ParagraphSpan, type ParagraphSpansRecord, type Post, type RunMeta, type SynthesizedNarrator, type TakeScore, type Word } from "./Lib.ts";
import { daNarratorConfig } from "./Setup.ts";

/**
 * Inline formatting joins its neighbours ("im<em>prove</em>d"); every other tag (a paragraph, a
 * component, a card) is a boundary, so stripping it leaves a space and never glues two sentences.
 */
const INLINE_TAGS = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "code", "del", "dfn", "em", "i", "ins", "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr"]);

/**
 * Attribution is page furniture, never narration: a caption anywhere, and a citation that closes its
 * block (the source line under a pull quote, which a quote component may render as a card link).
 * A citation with prose after it is inline (a book title mid-sentence) and stays.
 */
const ATTRIBUTION = /<(figcaption|caption)\b[^>]*>[\s\S]*?<\/\1>|<cite\b[^>]*>[\s\S]*?<\/cite>(?=(?:\s|<\/[^>]+>)*$)/gi;
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;
const HTML_LINK = /<a\b[^>]*?\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
/**
 * Set-off blocks: an `<aside>` (a margin note), an HTML `<blockquote>`, any quote-shaped component (`<BlockQuote>`,
 * `<PullQuote>`, any tag whose name contains "quote", paired or self-closing), and a markdown `>` run. Each is lifted
 * out of the body whole (blank lines inside it included) and classified (classifyBlock): someone else's words stay
 * out of band, the author's own words set off in a block go back into the main text. The paired pattern refuses a
 * nested opening of the same tag, so repeated passes lift quotes innermost first. The inline `<q>` is prose and stays.
 */
const OUT_OF_BAND_PAIRED = /<(aside|callout|notes|footnotes|table|pre|[\w-]*quote[\w-]*)\b[^>]*>(?:(?!<\1\b)[\s\S])*?<\/\1\s*>/gi;
/**
 * Figures read by the eye, never aloud (a table narrated as pipe-and-dash cell text is noise): a fenced code block (a terminal line, source) and a markdown table. Both are lifted before any quote
 * pattern runs, so a `>` or a tag inside them is never taken for a quote.
 */
const FENCED_CODE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
const MARKDOWN_TABLE = /(?:^[ \t]*\|[^\n]*\|[ \t]*(?:\n|$)){2,}/gm;
const TABLE_RULE = /^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*:?-{0,}:?[ \t]*$/m;
const OUT_OF_BAND_SELF_CLOSING = /<[\w-]*quote[\w-]*\b[^>]*\/>/gi;
/**
 * A component that points at another page by a `url` attribute (a link card, an embedded post): `<LinkCard url="…" />`,
 * `<Embed url="…" />`, any capitalized tag. It has no prose, so its link would vanish with the tag, and a card can be a post's one link to its
 * subject, which the description must list. Its URL is a link of the
 * post, labelled with the URL itself (host and path), filed like an aside's links to the nearest prose.
 */
const COMPONENT_URL = /<[A-Z][\w-]*\b[^>]*?\burl=["'](https?:\/\/[^"']+)["'][^>]*>/g;
/** A URL as a readable label: host (no www) and path, no query, fragment or trailing slash. */
export function urlLabel(url: string): string {
  const u = new URL(url);
  return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
}
const MARKDOWN_QUOTE_RUN = /(?:^[ \t]*>.*(?:\n|$))+/gm;
const ASIDE_MARK = /\u0000A(\d+)\u0000/g;
/** Marks a paragraph that came from a narrated block, so it is recorded as `kind: "blockquote"`. */
const QUOTE_MARK = "\u0000Q";
/**
 * A source line right after a lifted block ("— Author, Book"), absorbed into it so it is never narrated as prose.
 * The dash must lead into a word: `---` is a horizontal rule, not an attribution.
 */
const TRAILING_ATTRIBUTION = /\u0000A(\d+)\u0000[ \t]*\n?(?:[ \t]*\n)?([ \t]*(?:[—–]|--(?!-))[ \t]*[^\s\-—–][^\n]{0,100}?)[ \t]*(?=\n|$)/g;
const DASH_LINE = /^\s*(?:[—–]|--(?!-))\s*[^\s\-—–]/;
const CALLOUT = /^\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;
const SOURCE_ATTRIBUTE = /^<[\w-]+\b[^>]*\b(?:author|cite|source|by|attribution)\s*=/i;
const DIALOGUE_LINE = /^[A-Z][\w .'-]{0,30}:\s/;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };
/** One pass, so an escaped entity (`&amp;lt;`) decodes once and never twice. Unknown names stay as written. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? m;
    const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  });
}

function readable(text: string): string {
  return decodeEntities(text.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<\/?([A-Za-z][\w-]*)\b[^>]*>/g, (_, name: string) => (INLINE_TAGS.has(name.toLowerCase()) ? "" : " ")).replace(/<[^>]*>/g, "")).replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

/** Words only, lower case, one space apart: the form duplicate and override matching compare. */
const wordsOf = (text: string): string => text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9]+/g, " ").trim();
/** Visible text with every link reduced to its label. */
const plainText = (text: string): string => readable(text.replace(HTML_LINK, (_, _target: string, label: string) => label).replace(MARKDOWN_LINK, (_, label: string) => label));

export type BlockKind = "aside" | "callout" | "notes" | "table" | "code" | "blockquote" | "quote-component" | "markdown-quote";
/** Kinds that are figures on the page (a table, code): never narrated, and an override asking for it is refused. */
export const UNSPEAKABLE_KINDS: ReadonlySet<BlockKind> = new Set(["table", "code"]);
/** Kinds that are quotations and so may carry a source line right after them. */
const QUOTE_KINDS: ReadonlySet<BlockKind> = new Set(["blockquote", "quote-component", "markdown-quote"]);
export type NarrationDecision = "narrate" | "skip";
/** One set-off block's narration decision, as recorded in Source/narration.json. */
export interface BlockDecision { id: string; kind: BlockKind; decision: NarrationDecision; reason: string; text: string }
/** Source/narration-overrides.json: a block id (`b3`) or the start of its text, mapped to the decision that wins over the rule. */
export type NarrationOverrides = Record<string, NarrationDecision>;
export const NARRATION_FILE = "narration.json";
export const NARRATION_OVERRIDES_FILE = "narration-overrides.json";

function blockKind(raw: string): BlockKind {
  const t = raw.trimStart();
  if (/^<aside\b/i.test(t)) return "aside";
  if (/^<callout\b/i.test(t)) return "callout";
  if (/^<(?:foot)?notes\b/i.test(t)) return "notes";
  if (/^(?:`{3}|~{3}|<pre\b)/i.test(t)) return "code";
  if (/^(?:\||<table\b)/i.test(t)) return "table";
  // Lower case is the HTML element; a capitalized <BlockQuote> is a site's own component.
  if (/^<blockquote\b/.test(t)) return "blockquote";
  return t.startsWith("<") ? "quote-component" : "markdown-quote";
}

/** A block's body: the `>` markers or the wrapping tag removed. A self-closing component has none. */
function blockInner(raw: string, kind: BlockKind): string {
  if (kind === "markdown-quote") return raw.replace(/^[ \t]*>[ \t]?/gm, "");
  if (kind === "code" && !raw.trimStart().startsWith("<")) return raw.trim().replace(/^[^\n]*\n/, "").replace(/\n[^\n]*$/, "");
  if (kind === "table" && !raw.trimStart().startsWith("<")) return raw.trim();
  const t = raw.trim();
  if (!/<\/[\w-]+\s*>$/.test(t)) return "";
  return t.replace(/^<[^>]*>/, "").replace(/<\/[\w-]+\s*>$/, "");
}

/**
 * Is a set-off block someone else's words (out of band, never narrated) or the author's own content set off in a
 * block (narrated)? Out of band: an aside; a block carrying attribution (a `<cite>`, a source attribute on a quote
 * component, a dash source line inside it or right after it, or a trailing "(Source, Year)" link); a callout
 * (`[!NOTE]` …); a pull quote repeating text already in the body. Everything else is the author's: imagined
 * dialogue, an inner voice, a hypothetical line, an example. `body` is the post's main text in `wordsOf` form.
 */
export function classifyBlock(raw: string, trailing: string | undefined, body: string): { kind: BlockKind; decision: NarrationDecision; reason: string } {
  const kind = blockKind(raw);
  const skip = (reason: string) => ({ kind, decision: "skip" as const, reason });
  if (kind === "aside") return skip("aside: a margin note");
  if (kind === "callout") return skip("callout: a set-off note, not the essay's voice");
  if (kind === "notes") return skip("notes: the post's footnotes, read on the page");
  if (kind === "table") return skip("table: a figure read on the page, never aloud");
  if (kind === "code") return skip("code: a terminal line or source shown on the page");
  const inner = blockInner(raw, kind);
  if (!/[A-Za-z0-9]/.test(plainText(inner))) return skip("self-closing or empty quote component: no body text in the post");
  if (trailing) return skip(`attributed: source line after the block ("${plainText(trailing).slice(0, 40)}")`);
  if (/<cite\b/i.test(raw)) return skip("attributed: <cite>");
  if (kind === "quote-component" && SOURCE_ATTRIBUTE.test(raw.trim())) return skip("attributed: the component names a source");
  if (CALLOUT.test(plainText(inner))) return skip("callout: a set-off note, not the essay's voice");
  const lines = inner.split(/\n|<\/p\s*>|<br\s*\/?>/i).map(plainText).filter(Boolean);
  if (lines.slice(1).some((l) => DASH_LINE.test(l))) return skip("attributed: a dash source line inside the block");
  const md = inner.replace(HTML_LINK, (_, target: string, label: string) => `[${readable(label)}](${target})`).replace(/(?:<[^>]+>|\s)+$/, "");
  const plain = plainText(inner);
  if (/\]\([^)\s]+\)[)\s.]*$/.test(md) && /\([^()]*\b(?:1[5-9]|20)\d{2}\b[^()]*\)[\s.]*$/.test(plain)) return skip("attributed: a trailing (Source, Year) link");
  const words = wordsOf(plain);
  if (words.split(" ").length >= 6 && body.includes(` ${words} `)) return skip("pull quote: repeats text already in the body");
  return { kind, decision: "narrate", reason: DIALOGUE_LINE.test(plain) ? "unattributed dialogue: the author's own content" : "unattributed block: the author's own content" };
}

/** The override that names this block, by id or by the start of its text; undefined when none does. */
function overrideFor(overrides: NarrationOverrides, id: string, text: string): string | undefined {
  if (overrides[id]) return id;
  const words = wordsOf(text);
  return Object.keys(overrides).find((k) => !/^b\d+$/.test(k) && wordsOf(k) && words.startsWith(wordsOf(k)));
}

/** A markdown list item line: a bullet (`-`, `+`, `*`) or a number (`1.`, `1)`) followed by text. `---` and `*emphasis*` are not. */
const LIST_ITEM = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+\S/;

/**
 * One paragraph per list item, as the page renders one `<li>` per item: a block holding list lines splits at each
 * item line, continuation lines stay with their item, and lines before the first item stay a paragraph of their own.
 * A block from a narrated quote keeps its mark on every piece.
 */
function splitListItems(block: string): string[] {
  const lines = block.split("\n"), bare = (l: string) => l.split(QUOTE_MARK).join("");
  if (!lines.some((l) => LIST_ITEM.test(bare(l)))) return [block];
  const items: string[] = [];
  for (const line of lines) {
    if (!items.length || LIST_ITEM.test(bare(line))) items.push(line);
    else items[items.length - 1] += `\n${line}`;
  }
  return block.includes(QUOTE_MARK) ? items.map((i) => (i.includes(QUOTE_MARK) ? i : QUOTE_MARK + i)) : items;
}

/**
 * `skipParagraphs`: paragraphs whose visible text matches any of these are page metadata (a site's footer label, a
 * disclosure line) and are never read aloud (Config.json `skipParagraphs`; none by default).
 */
export function parseMarkdown(markdown: string, opts: { blogBaseUrl?: string; url?: string; fallbackSlug?: string; overrides?: NarrationOverrides; skipParagraphs?: readonly RegExp[] } = {}): Post & { author?: string; narration: BlockDecision[] } {
  const fm = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  const field = (key: string) => fm?.[1].match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, "m"))?.[1].replace(/^["']|["']$/g, "");
  const slug = field("slug") ?? opts.fallbackSlug ?? "post";
  const url = opts.url ?? (opts.blogBaseUrl ? new URL(slug, opts.blogBaseUrl.endsWith("/") ? opts.blogBaseUrl : opts.blogBaseUrl + "/").href : "");
  const body = markdown.slice(fm?.[0].length ?? 0).replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*!\[[^\]]*\]\([^\n]*\)\s*$/gm, "");
  const post: Post & { author?: string; narration: BlockDecision[] } = { title: field("title") ?? readable(body.match(/^#\s+(.+)$/m)?.[1] ?? slug), slug, url, author: field("author"), links: [], paragraphs: [], narration: [] };
  let heading: string | undefined;
  const references = new Map<string, string>();
  const asides: string[] = [];
  // A lifted block keeps any quote lifted from inside it, so a nested quote's links stay with the outer one.
  const lift = (m: string) => ` \u0000A${asides.push(m.replace(ASIDE_MARK, (_, n: string) => asides[Number(n)])) - 1}\u0000 `;
  let content = body.replace(/^\s*\[([^\]]+)\]:\s*(\S+).*$/gm, (_, label, target) => { references.set(label.toLowerCase(), target); return ""; });
  content = content.replace(FENCED_CODE, (m) => `${lift(m)}\n`).replace(MARKDOWN_TABLE, (m) => (TABLE_RULE.test(m) ? `${lift(m)}\n` : m));
  for (let before = ""; before !== content;) { before = content; content = content.replace(OUT_OF_BAND_PAIRED, lift); }
  content = content.replace(OUT_OF_BAND_SELF_CLOSING, lift)
    // A run of bare `>` lines is the tail of a multi-line HTML tag, never a quote; a quote run has text in it.
    .replace(MARKDOWN_QUOTE_RUN, (m) => (/^[ \t]*>[ \t]*\S/m.test(m) ? `${lift(m)}\n` : m));
  const trailing = new Map<number, string>();
  content = content.replace(TRAILING_ATTRIBUTION, (m, n: string, line: string) => {
    if (!QUOTE_KINDS.has(blockKind(asides[Number(n)]))) return m;
    trailing.set(Number(n), line);
    return `\u0000A${n}\u0000\n`;
  });
  // Classify each top-level block against the main text alone, before any block rejoins it.
  const mainText = ` ${wordsOf(plainText(content.replace(ASIDE_MARK, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ")))} `;
  const overrides = opts.overrides ?? {};
  const used = new Set<string>(), narrated = new Set<number>();
  [...content.matchAll(ASIDE_MARK)].forEach((m, i) => {
    const n = Number(m[1]), id = `b${i + 1}`, raw = asides[n];
    const rule = classifyBlock(raw, trailing.get(n), mainText);
    const text = plainText(blockInner(raw, rule.kind) || raw);
    const key = overrideFor(overrides, id, text);
    const decision = key ? overrides[key] : rule.decision;
    if (decision === "narrate" && UNSPEAKABLE_KINDS.has(rule.kind)) throw new Error(`narration override "${key}" asks to narrate ${id}, a ${rule.kind}: tables and code are read on the page, never aloud`);
    if (key) used.add(key);
    if (decision === "narrate") narrated.add(n);
    post.narration.push({ id, kind: rule.kind, decision, reason: key ? `override "${key}": ${decision} (rule: ${rule.decision}, ${rule.reason})` : rule.reason, text: text.slice(0, 80) });
  });
  const unused = Object.keys(overrides).filter((k) => !used.has(k));
  if (unused.length) throw new Error(`narration overrides match no block: ${unused.map((k) => JSON.stringify(k)).join(", ")}`);
  // A narrated block rejoins the main text in place: each of its paragraphs is a paragraph of the post, marked as a block quote.
  content = content.replace(ASIDE_MARK, (m, n: string) => {
    if (!narrated.has(Number(n))) return m;
    const raw = asides[Number(n)];
    return `\n\n${blockInner(raw, blockKind(raw)).replace(/<\/p\s*>/gi, "\n\n").split(/\n\s*\n/).filter((x) => /\S/.test(x)).map((x) => QUOTE_MARK + x.trim()).join("\n\n")}\n\n`;
  });
  /** A block's links: html anchors, inline markdown links, and reference links, in order of appearance. */
  const asideLinks = (html: string): [string, string][] => {
    const md = html.replace(HTML_LINK, (_, target: string, label: string) => `[${readable(label)}](${target})`);
    return [...md.matchAll(MARKDOWN_LINK)].map(([, label, target]) => [label, target] as [string, string]).concat([...md.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)].map(([, label, ref]) => [label, references.get((ref || label).toLowerCase()) ?? ""] as [string, string]));
  };
  const fileLink = (label: string, target: string, p: string, into: Post["links"]): string => {
    const clean = readable(label);
    try { into.push({ label: clean, url: new URL(target, url || undefined).href, p }); } catch { /* Relative links need a source URL. */ }
    return clean;
  };
  /** Links from out-of-band blocks that came before any prose paragraph: they go to the first paragraph that follows. */
  let orphanLinks: [string, string][] = [];
  for (const rawBlock of content.split(/\n\s*\n|\n(?=#{1,6}\s)|(?<=\n#{1,6}[^\n]*)\n/).flatMap(splitListItems)) {
    const blockAsides: [string, string][] = [];
    const quoted = rawBlock.includes(QUOTE_MARK);
    const block = rawBlock.split(QUOTE_MARK).join("").replace(ASIDE_MARK, (_, n: string) => { blockAsides.push(...asideLinks(asides[Number(n)] + (trailing.has(Number(n)) ? `\n${trailing.get(Number(n))}` : ""))); return " "; });
    for (const [, target] of block.matchAll(COMPONENT_URL)) blockAsides.push([urlLabel(target), target]);
    if (blockAsides.length) {
      // Filed to the nearest prose: this block's own paragraph if it has one, else the paragraph before it, else the next one.
      const previous = post.paragraphs.at(-1)?.id;
      if (!/[A-Za-z0-9]/.test(readable(block)) && previous) { for (const [label, target] of blockAsides) fileLink(label, target, previous, post.links); }
      else orphanLinks.push(...blockAsides);
    }
    if (/^\s*#{1,6}\s/.test(block)) { if (!/^\s*#\s/.test(block)) heading = readable(block.replace(/^\s*#{1,6}\s+/, "")); continue; }
    const id = `p${post.paragraphs.length + 1}`;
    const links: Post["links"] = [];
    const addLink = (label: string, target: string) => fileLink(label, target, id, links);
    // Raw HTML anchors become markdown links so they are recorded like any other link.
    const attributions: string[] = [];
    const prose = block.replace(HTML_LINK, (_, target: string, label: string) => `[${readable(label)}](${target})`).replace(ATTRIBUTION, (m) => { attributions.push(m); return " "; });
    // A linked image `[![alt](src)](href)` leaves an empty-label link once the image goes; drop that too.
    const text = readable(prose.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[\s*\]\([^)]*\)/g, "").replace(MARKDOWN_LINK, (_, label, target) => addLink(label, target)).replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (_, label, ref) => addLink(label, references.get((ref || label).toLowerCase()) ?? "")).replace(/^\s*(?:[-+*]\s+|\d+[.)]\s+)/gm, ""));
    if (!/[A-Za-z0-9]/.test(text)) continue;
    // A configured metadata line (Config.json skipParagraphs) is page furniture, never read aloud.
    if (opts.skipParagraphs?.some((re) => re.test(text))) continue;
    // A block that is nothing but one link is a card or an embed pointing elsewhere, not prose.
    if (links.length === 1 && text === links[0].label) continue;
    // The attribution's links stay on record (a cited post is an insert candidate); its words are never spoken.
    for (const a of attributions) for (const [, label, target] of a.matchAll(MARKDOWN_LINK)) addLink(label, target);
    for (const [label, target] of orphanLinks) addLink(label, target);
    orphanLinks = [];
    post.paragraphs.push({ id, text: text.replace(/^[\p{Extended_Pictographic}️‍\s]+/u, ""), ...(heading ? { heading } : {}), ...(quoted ? { kind: "blockquote" as const } : {}) });
    post.links.push(...links);
    heading = undefined;
  }
  return post;
}

// ---------- a post page (URL ingest) ----------

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Page chrome: paragraphs inside these never count toward the post body. */
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside", "form", "dialog"]);
/** Opening one of these inside an open `<p>` closes the paragraph, as the HTML parser does. */
const CLOSES_P = /^(p|div|section|article|main|blockquote|ul|ol|table|h[1-6]|pre|figure|hr|aside|nav|header|footer|form)$/;
/** The post body holds at least this share of the page's paragraph text. */
export const BODY_TEXT_SHARE = 2 / 3;

/**
 * The inner HTML of a page's post body, found by paragraph-text density rather than a site's class names: every
 * `<p>` outside page chrome counts its visible text toward each element that contains it, and the body is the
 * deepest element holding at least BODY_TEXT_SHARE of the page's paragraph text. Deepest, so the pick is the post
 * container and not the page wrapper around it; a share, so a body split into sibling sections still resolves to
 * their common parent. Undefined when the page has no paragraph text at all.
 */
export function postBodyHtml(html: string): string | undefined {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  interface Open { name: string; innerStart: number; text: number; chrome: boolean }
  const stack: Open[] = [];
  const closed: { innerStart: number; innerEnd: number; depth: number; text: number }[] = [];
  let total = 0;
  const closeFrom = (index: number, at: number) => {
    while (stack.length > index) {
      const el = stack.pop()!;
      if (el.name !== "p") { closed.push({ innerStart: el.innerStart, innerEnd: at, depth: stack.length, text: el.text }); continue; }
      if (el.chrome) continue;
      const length = readable(clean.slice(el.innerStart, at)).length;
      total += length;
      for (const ancestor of stack) ancestor.text += length;
    }
  };
  for (const m of clean.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g)) {
    const name = m[2].toLowerCase(), at = m.index!;
    if (m[1]) { let i = stack.length - 1; while (i >= 0 && stack[i].name !== name) i--; if (i >= 0) closeFrom(i, at); continue; }
    if (stack.at(-1)?.name === "p" && CLOSES_P.test(name)) closeFrom(stack.length - 1, at);
    if (VOID_TAGS.has(name) || m[3]) continue;
    stack.push({ name, innerStart: at + m[0].length, text: 0, chrome: CHROME_TAGS.has(name) || Boolean(stack.at(-1)?.chrome) });
  }
  closeFrom(0, clean.length);
  if (total === 0) return undefined;
  const body = closed.filter((e) => e.text >= total * BODY_TEXT_SHARE).sort((a, b) => b.depth - a.depth)[0];
  return body && clean.slice(body.innerStart, body.innerEnd);
}

/**
 * Elements a reader never reads as the post: anything the page hides from assistive tech (`aria-hidden="true"`, e.g.
 * a code block's line-number gutter) and a component still in its placeholder state (a class token `loading`,
 * `skeleton` or `placeholder`, e.g. a link card whose server HTML shows a placeholder line until the client fills it).
 * Left in, both reach the take as paragraphs and get spoken (a card's loading line, a lone gutter number).
 */
const UNREAD_ELEMENT = /\baria-hidden\s*=\s*["']true["']|\bclass\s*=\s*["'][^"']*\b(?:loading|skeleton|placeholder)\b/i;

/** Remove every element whose opening tag matches `unread`, with its whole subtree, balancing same-name tags. */
export function dropUnreadElements(html: string, unread: RegExp = UNREAD_ELEMENT): string {
  let out = "", from = 0;
  const tags = /<(\/?)([a-zA-Z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    const name = m[2].toLowerCase();
    if (m[1] || VOID_TAGS.has(name) || m[4] || !unread.test(m[3])) continue;
    let depth = 1, end = html.length;
    const inner = new RegExp(`<(/?)${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*?(/?)>`, "gi");
    inner.lastIndex = m.index + m[0].length;
    for (let n = inner.exec(html); n; n = inner.exec(html)) {
      if (n[2]) continue;
      depth += n[1] ? -1 : 1;
      if (depth === 0) { end = n.index + n[0].length; break; }
    }
    out += html.slice(from, m.index);
    from = end;
    tags.lastIndex = end;
  }
  return out + html.slice(from);
}

/** A `<meta>` value by property or name. */
function metaContent(html: string, key: string): string | undefined {
  const tag = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).find((t) => new RegExp(`\\b(?:property|name)=["']${key}["']`, "i").test(t));
  return tag?.match(/\bcontent=(["'])([\s\S]*?)\1/i)?.[2];
}

/**
 * A fetched post page as the markdown `parseMarkdown` reads: frontmatter from the page's metadata (title, author,
 * slug from the URL), then the body with headings as `#` lines, anchors as markdown links, and block ends as blank
 * lines. Asides, blockquotes and quote components pass through as HTML, so the main-text rules are the markdown
 * path's own. Throws when the page has no post body.
 */
export function htmlPostToMarkdown(html: string, pageUrl: string): string {
  const body = postBodyHtml(html) ?? html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ?? html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (!body) throw new Error(`no post body found at ${pageUrl}: the page has no paragraph text, <article> or <main>`);
  const line = (s: string | undefined) => (s === undefined ? undefined : readable(s).replace(/\n/g, " ") || undefined);
  const title = line(metaContent(html, "og:title")) ?? line(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]) ?? line(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const author = line(metaContent(html, "author")) ?? line(metaContent(html, "article:author"));
  const slug = new URL(pageUrl).pathname.split("/").filter(Boolean).pop();
  const front = ["---", title && `title: ${title}`, author && `author: ${author}`, slug && `slug: ${slug}`, "---"].filter(Boolean).join("\n");
  const markdown = dropUnreadElements(body).replace(/<(nav|form|button)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, text: string) => `\n\n${"#".repeat(Number(level))} ${readable(text)}\n\n`)
    .replace(HTML_LINK, (_, target: string, label: string) => `[${readable(label)}](${target})`)
    // A paragraph ends at its closing tag, or at the next opening one when the page leaves it unclosed.
    .replace(/<\/(?:p|div|li)>/gi, "\n\n").replace(/<p\b/gi, "\n\n<p");
  return `${front}\n${markdown}`;
}

/** Paragraphs inside one take are separated by a blank line, which the model reads as a paragraph pause. */
export const PARAGRAPH_BREAK = "\n\n";
/** Seconds of silence between two takes when a post is too long for one request. */
const TAKE_GAP_SECONDS = 0.5;
/**
 * Clone narration files: the take (`take.<12-hex hash of the full text and profile>.<k>of<n>.<kind>`) and the retired
 * per-paragraph layout (`<paragraph id>.<hash>.<kind>`), which a re-ingest clears. Anything else in Narration/ is never touched.
 */
const CHUNK_FILE = /^(take\.[0-9a-f]{12}\.\d+of\d+|p\d+\.[0-9a-f]{12})\.(?:mp3|wav|align\.json|request\.json)$/;
/** Intermediates of the multi-take stitch; a single take leaves none behind. */
const STITCH_FILES = ["concat.txt", "narration.raw.wav"];

/** A synthesized take that cannot be used (empty audio, or an alignment that misses the words sent). Best-of-N rejects it and moves on. */
export class TakeRejected extends Error {}

/** One request's worth of consecutive paragraphs. */
export interface TakeChunk { texts: string[]; text: string }

/** End an unpunctuated paragraph for speech without changing the post's page text. */
function spokenParagraph(text: string): string {
  const trimmed = text.trimEnd();
  return /[.!?…:;]["'”’»›)\]}]*$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function spokenPost(post: Post): string { return post.paragraphs.map((p) => spokenParagraph(p.text)).join(PARAGRAPH_BREAK); }

/**
 * Pack the post's paragraphs, in reading order, into the fewest requests of at most `limit` characters, splitting
 * only at paragraph boundaries. Greedy packing is optimal for an ordered sequence: each chunk ends as late as any
 * valid split could end it.
 */
export function takeChunks(post: Post, limit: number): TakeChunk[] {
  invariant(Number.isInteger(limit) && limit > 0, "request character limit must be a positive integer");
  const chunks: TakeChunk[] = [];
  for (const p of post.paragraphs) {
    const spoken = spokenParagraph(p.text);
    invariant(spoken.length <= limit, `${p.id} is ${spoken.length} characters, over the ${limit}-character request limit; split the paragraph in the post`);
    const last = chunks.at(-1);
    if (last && last.text.length + PARAGRAPH_BREAK.length + spoken.length <= limit) { last.texts.push(spoken); last.text += PARAGRAPH_BREAK + spoken; }
    else chunks.push({ texts: [spoken], text: spoken });
  }
  return chunks;
}

/**
 * Synthesize the whole post in one synthesized voice (the author's clone, or the DA's one voice, [da.voices.main]) as ONE continuous take: one request whenever the post
 * fits the per-request limit, so level, pitch and pace come from a single performance. Paragraph breaks
 * ride in the text. A post over the limit splits at paragraph boundaries into the fewest, largest chunks.
 * The take is cached by the hash of the full text plus the profile (seed included), so any edit or profile change
 * re-synthesizes the whole take; a take interrupted part-way resumes from its synthesized chunks. A chunk that comes
 * back empty or misaligned throws TakeRejected and is never cached. Other takes in `dir` are left alone (pruneTakes).
 */
export async function cloneTake(post: Post, dir: string, voice: VoiceSettings, synth: Synthesizer = fishSynthesizer, limit = REQUEST_CHAR_LIMIT): Promise<string[]> {
  invariant(post.paragraphs.length > 0 && voice.voice_id, "clone needs paragraphs and a configured voice");
  ensureDir(dir);
  const hash = chunkHash(spokenPost(post), voice);
  const chunks = takeChunks(post, limit);
  const bases = chunks.map((_, k) => join(dir, `take.${hash}.${k + 1}of${chunks.length}`));
  const cached = bases.map((b) => existsSync(`${b}.mp3`) && existsSync(`${b}.align.json`));
  for (const [i, chunk] of chunks.entries()) {
    if (cached[i]) continue;
    const base = bases[i];
    const result = await synth({ text: chunk.text, voice });
    const spoken = alignmentToWords(result.alignment).length, sent = chunk.text.split(/\s+/).filter(Boolean).length;
    if (result.audio.length === 0 || spoken !== sent) throw new TakeRejected(`synthesis returned ${result.audio.length ? `an alignment of ${spoken} words for ${sent} sent` : "empty audio"}`);
    writeFileSync(`${base}.mp3`, result.audio);
    writeJson(`${base}.align.json`, result.alignment);
  }
  return bases.map((b) => `${b}.mp3`);
}

/** Delete every take file in `dir` except the chunks of `keep` (their mp3 paths): losing takes, stale takes, retired per-paragraph chunks. */
export function pruneTakes(dir: string, keep: string[]): void {
  const live = new Set(keep.map((mp3) => basename(mp3).replace(/\.mp3$/, "")));
  for (const f of readdirSync(dir)) { const m = f.match(CHUNK_FILE); if (m && !live.has(m[1])) rmSync(join(dir, f)); }
}

/**
 * The clone take's paragraph spans on the stitched source.wav timeline. Each chunk's alignment covers exactly the
 * words sent (cloneTake refuses anything else), chunks hold whole paragraphs in reading order, and chunk k starts at
 * `offsets[k]`; so the n-th aligned word belongs to the paragraph holding the n-th word of the post.
 */
export function cloneParagraphSpans(post: Post, chunkWords: Word[][], offsets: number[]): ParagraphSpan[] {
  invariant(chunkWords.length === offsets.length, "one offset per chunk");
  const owners = post.paragraphs.flatMap((p) => p.text.split(/\s+/).filter(Boolean).map(() => p.id));
  const words = chunkWords.flatMap((ws, k) => ws.map((w) => ({ ...w, s: w.s + offsets[k], e: w.e + offsets[k] })));
  invariant(words.length === owners.length, `the take aligns ${words.length} words for the post's ${owners.length}`);
  return spansFromWords(words.map((w, n) => ({ ...w, p: owners[n] })));
}

/** Silence kept after a chunk's last aligned character: the voice's natural release, and nothing the model adds after it. */
export const TAKE_TAIL_SECONDS = 0.4;

/**
 * Where a chunk ends: its last aligned character plus TAKE_TAIL_SECONDS, never past the audio. A synthesized chunk can
 * append a short burst of sound after the last word, which the verify transcript hears as spurious words, so
 * everything after the release is cut.
 */
export function takeEnd(alignment: Alignment, duration: number): number {
  const last = alignment.character_end_times_seconds.at(-1);
  invariant(last !== undefined && Number.isFinite(last) && last > 0 && duration > 0, "a chunk needs an alignment and a duration to be trimmed");
  return Math.min(duration, last + TAKE_TAIL_SECONDS);
}

/** Cut a chunk wav at `end` seconds in place; a wav already at or inside that length is left as it is. */
async function trimWav(wav: string, end: number): Promise<void> {
  if ((await probeDuration(wav)) <= end + 0.005) return;
  const cut = wav.replace(/\.wav$/, ".cut.wav");
  const p = Bun.spawn(["ffmpeg", "-y", "-v", "error", "-i", wav, "-t", end.toFixed(3), "-c:a", "pcm_s16le", cut], { stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  invariant(code === 0 && existsSync(cut), `trimming ${wav} failed: ${err.slice(-300)}`);
  renameSync(cut, wav);
}

/** A take's chunks as trimmed wavs, where each starts on the stitched timeline, and the post's paragraph spans on it. */
export interface PreparedTake { wavs: string[]; offsets: number[]; spans: ParagraphSpan[] }

export async function prepareTake(post: Post, mp3s: string[]): Promise<PreparedTake> {
  const wavs: string[] = [];
  for (const mp3 of mp3s) {
    const wav = mp3.replace(/\.mp3$/, ".wav");
    if (!existsSync(wav)) await toWav(mp3, wav);
    await trimWav(wav, takeEnd(readJson<Alignment>(mp3.replace(/\.mp3$/, ".align.json")), await probeDuration(wav)));
    wavs.push(wav);
  }
  // Chunk k starts after every earlier chunk plus the gap concatWithGaps lays after each one.
  const offsets: number[] = [];
  for (let k = 0; k < wavs.length; k++) offsets.push(k === 0 ? 0 : offsets[k - 1] + (await probeDuration(wavs[k - 1])) + TAKE_GAP_SECONDS);
  const chunkWords = mp3s.map((mp3) => alignmentToWords(readJson<Alignment>(mp3.replace(/\.mp3$/, ".align.json"))));
  return { wavs, offsets, spans: cloneParagraphSpans(post, chunkWords, offsets) };
}

async function decodeMono(path: string): Promise<Float32Array> {
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", String(PITCH_SAMPLE_RATE), "-f", "f32le", "-"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  invariant(code === 0 && out.byteLength > 0, `decoding ${path} for pitch failed: ${err.slice(-300)}`);
  return new Float32Array(out);
}

/** Per-paragraph pitch of one take, measured on its trimmed chunks laid out on the stitched timeline. */
export async function measureTakePitch(post: Post, mp3s: string[]): Promise<ParagraphPitch[]> {
  const { wavs, offsets, spans } = await prepareTake(post, mp3s);
  const pcm = await Promise.all(wavs.map(decodeMono));
  const at = offsets.map((o) => Math.round(o * PITCH_SAMPLE_RATE));
  const x = new Float32Array(Math.max(...pcm.map((p, k) => at[k] + p.length)));
  pcm.forEach((p, k) => x.set(p, at[k]));
  return paragraphPitch(x, spans);
}

export const TAKES_FILE = "takes.json";
/**
 * A take whose median within-paragraph pitch spread (interquartile range) falls under this many semitones has gone
 * flat. Set well below a lively read's spread (a few semitones) and above a monotone one (near zero).
 */
export const MONOTONE_FLOOR_ST = 1.0;
export interface TakeCandidate { seed: number; take?: string; status: "chosen" | "lost" | "rejected"; reason?: string; score?: TakeScore; paragraphs?: ParagraphPitch[] }
/** Narration/takes.json: which seed won, every candidate's scores, and the key that lets a re-run skip the purchase. */
export interface TakesRecord { key: string; takes: number; rule: string; monotoneFloorSt: number; chosen?: { seed: number; files: string[] }; candidates: TakeCandidate[] }

export type TakeMeasure = (post: Post, mp3s: string[]) => Promise<ParagraphPitch[]>;

/** Take i reads on the profile's seed plus i, so take 0 is the configured seed and a single take is the old single read. */
export const takeSeed = (base: number, i: number): number => (base + i) % 2 ** 32;

/** What a pick depends on: the text, the voice as sent (base seed included), the take count and the request limit. */
export function takesKey(post: Post, voice: VoiceSettings, takes: number, limit: number): string {
  return sha256(JSON.stringify({ text: spokenPost(post), voice, model: voiceModel(voice), takes, limit })).slice(0, 16);
}

/**
 * Best of N: read the post `takes` times on consecutive seeds, measure each take's per-paragraph median pitch, and
 * keep the steadiest (TAKE_SCORE_RULE). A take that comes back misaligned, has nothing measurable, or has gone
 * monotone is rejected. Losing takes are deleted and Narration/takes.json records every candidate. A re-run with the
 * same text, profile and count returns the recorded pick without buying anything; a run interrupted part-way reuses
 * the takes it already bought (cloneTake's cache). Throws when no take survives.
 */
export async function bestTake(post: Post, dir: string, voice: VoiceSettings, takes: number, opts: { synth?: Synthesizer; measure?: TakeMeasure; limit?: number; log?: (s: string) => void } = {}): Promise<string[]> {
  invariant(Number.isInteger(takes) && takes >= 1, `take count must be a positive integer, got ${takes}`);
  invariant(voice.seed !== undefined && Number.isInteger(voice.seed), "best-of-N needs a base seed in the voice profile");
  const { synth = fishSynthesizer, measure = measureTakePitch, limit = REQUEST_CHAR_LIMIT, log = (s: string) => console.log(s) } = opts;
  ensureDir(dir);
  const key = takesKey(post, voice, takes, limit), recordPath = join(dir, TAKES_FILE);
  if (existsSync(recordPath)) {
    const previous = readJson<TakesRecord>(recordPath);
    const files = previous.chosen?.files.map((f) => join(dir, f));
    if (previous.key === key && files?.length && files.every((f) => existsSync(f) && existsSync(f.replace(/\.mp3$/, ".align.json")))) {
      log(`take: recorded pick (seed ${previous.chosen!.seed} of ${takes}), nothing bought`);
      return files;
    }
  }
  const candidates: (TakeCandidate & { mp3s?: string[] })[] = [];
  for (let i = 0; i < takes; i++) {
    const seed = takeSeed(voice.seed, i);
    let mp3s: string[];
    try { mp3s = await cloneTake(post, dir, { ...voice, seed }, synth, limit); }
    catch (e) {
      if (!(e instanceof TakeRejected)) throw e;
      candidates.push({ seed, status: "rejected", reason: e.message });
      log(`take ${i + 1}/${takes} seed ${seed}: rejected, ${e.message}`);
      continue;
    }
    const take = basename(mp3s[0]).replace(/\.\d+of\d+\.mp3$/, "");
    const paragraphs = await measure(post, mp3s);
    const score = scoreTake(paragraphs);
    const reason = !score ? "no paragraph long and voiced enough to measure pitch"
      : score.withinSt < MONOTONE_FLOOR_ST ? `monotone: median within-paragraph spread ${score.withinSt.toFixed(2)} st is under the ${MONOTONE_FLOOR_ST} st floor` : undefined;
    candidates.push({ seed, take, status: reason ? "rejected" : "lost", ...(reason ? { reason } : {}), ...(score ? { score } : {}), paragraphs, mp3s });
    log(`take ${i + 1}/${takes} seed ${seed}: ${score ? `drift ${score.driftSt.toFixed(2)} st (${score.driftHz.toFixed(1)} Hz), range ${score.rangeSt.toFixed(2)} st (${score.rangeHz.toFixed(1)} Hz), within ${score.withinSt.toFixed(2)} st, score ${score.score.toFixed(2)}` : "unmeasured"}${reason ? `; rejected, ${reason}` : ""}`);
  }
  // Array.prototype.sort is stable, so equal scores keep seed order and the earlier seed wins.
  const winner = candidates.filter((c) => c.status === "lost").sort((a, b) => a.score!.score - b.score!.score)[0];
  if (winner) winner.status = "chosen";
  const record: TakesRecord = { key, takes, rule: TAKE_SCORE_RULE, monotoneFloorSt: MONOTONE_FLOOR_ST, ...(winner ? { chosen: { seed: winner.seed, files: winner.mp3s!.map((f) => basename(f)) } } : {}), candidates: candidates.map(({ mp3s: _mp3s, ...c }) => c) };
  invariant(!winner || winner.mp3s!.every((f) => existsSync(f)), "the chosen take's chunks must exist before losers are pruned");
  pruneTakes(dir, winner?.mp3s ?? []);
  writeJson(recordPath, record);
  if (!winner) throw new Error(`no usable take out of ${takes}: ${candidates.map((c) => `seed ${c.seed}: ${c.reason}`).join("; ")}`);
  log(`take: seed ${winner.seed} chosen of ${takes} (score ${winner.score!.score.toFixed(2)})`);
  return winner.mp3s!;
}

export async function copyRecording(input: string, narration: string, duration = probeDuration): Promise<string> {
  const bytes = readFileSync(input);
  const measured = await duration(input);
  const ext = extname(input).toLowerCase();
  invariant(bytes.length > 0 && /^\.[a-z0-9]+$/.test(ext) && measured > 0, "invalid recording");
  ensureDir(narration);
  const target = join(narration, `source${ext}`);
  invariant(resolve(input) !== resolve(target), "recording must be outside its destination");
  copyFileSync(input, target);
  invariant(sha256(readFileSync(target)) === sha256(bytes), "recording copy changed bytes");
  writeJson(join(narration, "provenance.json"), { sha256: sha256(bytes), originalPath: resolve(input), duration: measured, narrator: "recorded", file: basename(target) });
  return target;
}

/** Source/narration-overrides.json when present: an object of block id or text prefix → "narrate" | "skip". */
export function loadNarrationOverrides(path: string): NarrationOverrides {
  if (!existsSync(path)) return {};
  const raw = readJson<unknown>(path);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must be an object of block id or text prefix → "narrate" | "skip"`);
  const bad = Object.entries(raw).filter(([, v]) => v !== "narrate" && v !== "skip");
  if (bad.length) throw new Error(`${path}: ${bad.map(([k]) => JSON.stringify(k)).join(", ")} must map to "narrate" or "skip"`);
  return raw as NarrationOverrides;
}

/** Ingest.ts's command line: the run, the post, and exactly one narration source. `--clone` is `--narrator clone`. */
export interface IngestArgs { run: string; post: string; audio?: string; narrator?: SynthesizedNarrator; label?: string; captureUrl?: string }
export const INGEST_USAGE = "usage: Ingest.ts --run <slug> --post <md|https-url> (--audio <file> | --narrator clone|da | --clone) [--label <NAME>] [--capture-url <url>]";

/**
 * Parse and validate the command line. Exactly one narration source: a recording (`--audio`), or a synthesized
 * read (`--narrator clone|da`, with `--clone` kept as the short form of `--narrator clone`). A flag missing its
 * value, an unknown narrator, or two sources at once throws with the usage line.
 */
export function parseIngestArgs(argv: string[]): IngestArgs {
  const valueOf = (flag: string): string | undefined => {
    if (!argv.includes(flag)) return undefined;
    const v = argValue(argv, flag);
    if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value; ${INGEST_USAGE}`);
    return v;
  };
  const run = valueOf("--run"), post = valueOf("--post"), audio = valueOf("--audio"), named = valueOf("--narrator"), label = valueOf("--label"), captureUrl = valueOf("--capture-url");
  if (!run || !post) throw new Error(INGEST_USAGE);
  if (named !== undefined && named !== "clone" && named !== "da") throw new Error(`--narrator must be clone or da (a recording is --audio <file>), got ${JSON.stringify(named)}; ${INGEST_USAGE}`);
  const sources = [audio !== undefined, named !== undefined, argv.includes("--clone")].filter(Boolean).length;
  if (sources !== 1) throw new Error(`choose exactly one of --audio, --narrator and --clone; ${INGEST_USAGE}`);
  return { run, post, ...(audio ? { audio } : { narrator: (named ?? "clone") as SynthesizedNarrator }), ...(label !== undefined ? { label: normalizeLabel(label) } : {}), ...(captureUrl !== undefined ? { captureUrl: validCaptureUrl(captureUrl) } : {}) };
}

/**
 * The post as it is spoken: each paragraph's text with the pronunciation respellings applied (Narrate.ts
 * applyPronunciations: the user's PRONUNCIATIONS.json plus the run's pronunciations.json). Only synthesis sees
 * this copy; post.json, alignment and the speech check keep the post's own words. A respelling may change a
 * paragraph's word count ("API" → "A P I"), so the take's paragraph spans are counted on this copy, never on the post.
 */
export function speakablePost(post: Post, pronunciations: Record<string, string>): Post {
  return { ...post, paragraphs: post.paragraphs.map((p) => ({ ...p, text: applyPronunciations(p.text, pronunciations) })) };
}

/** What a synthesized read needs: the voice as sent, and how many candidate takes to buy. */
export interface NarrationVoice { voice: VoiceSettings; takes: number }

/**
 * The voice for a synthesized narrator. `clone`: [principal.voice] with the clone's voice id from env. `da`: the
 * DA's voice (Narrate.ts daVoice, [da.voices.main] on Fish at its fish_speed) with the seed and take
 * count from Config.json narrators.da, since that profile carries none.
 */
export function narrationVoice(narrator: SynthesizedNarrator, deps: { da?: () => VoiceSettings; daNarrator?: () => { seed: number; takes: number } } = {}): NarrationVoice {
  if (narrator === "clone") {
    const profile = loadLifeosConfig().principal.voice;
    invariant(profile, "no principal voice profile: add [principal.voice] to LIFEOS_CONFIG.toml");
    return { voice: principalVoice(profile), takes: profile.takes };
  }
  const voice = (deps.da ?? daVoice)();
  const { seed, takes } = (deps.daNarrator ?? daNarratorConfig)();
  return { voice: { ...voice, seed }, takes };
}

/** Everything ingest reaches outside the run dir, injectable for tests. */
export interface IngestDeps {
  synth?: Synthesizer;
  measure?: TakeMeasure;
  voice?: (narrator: SynthesizedNarrator) => NarrationVoice;
  pronunciations?: (runDir: string) => Record<string, string>;
  /** Injecting blogBaseUrl means Config.json is not read; skipParagraphs then defaults to none. */
  blogBaseUrl?: string;
  skipParagraphs?: readonly RegExp[];
  log?: (s: string) => void;
}

export async function ingest(run: string, input: string, opts: { audio?: string; narrator?: SynthesizedNarrator; label?: string; captureUrl?: string }, deps: IngestDeps = {}): Promise<void> {
  invariant(Boolean(opts.audio) !== Boolean(opts.narrator), "choose exactly one of --audio and --narrator (clone or da)");
  const log = deps.log ?? ((s: string) => console.log(s));
  const paths = runPaths(resolveRunDir(run));
  let text: string;
  const remote = /^https:\/\//.test(input);
  if (remote) {
    const response = await fetch(input, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`post fetch failed (${response.status}) for ${input}`);
    text = htmlPostToMarkdown(await response.text(), response.url || input);
  } else text = readFileSync(input, "utf8");
  const overrides = loadNarrationOverrides(join(paths.source, NARRATION_OVERRIDES_FILE));
  const cfg = deps.blogBaseUrl === undefined ? loadSkillConfig() : undefined;
  const skipParagraphs = deps.skipParagraphs ?? (cfg ? skipParagraphPatterns(cfg) : []);
  const parsed = parseMarkdown(text, { blogBaseUrl: deps.blogBaseUrl ?? cfg?.blogBaseUrl, url: remote ? input : undefined, fallbackSlug: basename(input, extname(input)), overrides, skipParagraphs });
  invariant(parsed.paragraphs.length && /^https:\/\//.test(parsed.url), "post needs paragraphs and an https URL (configure blogBaseUrl for local markdown)");
  const { author, narration, ...post } = parsed;
  const meta: RunMeta = { slug: basename(paths.dir), title: post.title, mode: "voice", narrator: opts.narrator ?? "recorded", source: { url: post.url, title: post.title, author: author ?? "" }, ...(opts.label ? { label: normalizeLabel(opts.label) } : {}), ...(opts.captureUrl ? { captureUrl: validCaptureUrl(opts.captureUrl) } : {}), createdAt: new Date().toISOString() };
  invariant(/^[a-z0-9-]+$/.test(meta.slug), "run slug must be kebab-case");
  writeJson(join(paths.source, "post.json"), post);
  writeJson(join(paths.source, NARRATION_FILE), { blocks: narration });
  writeJson(paths.meta, meta);
  ensureDir(paths.narration);
  const narrated = narration.filter((b) => b.decision === "narrate").length;
  log(`set-off blocks: ${narrated} narrated, ${narration.length - narrated} out of band (${NARRATION_FILE})`);
  // A recording gets its paragraph spans from the transcript at Clean; spans from an earlier clone take never apply.
  if (opts.audio) { rmSync(join(paths.narration, PARAGRAPH_SPANS_FILE), { force: true }); await copyRecording(opts.audio, paths.narration); }
  else {
    const narrator = opts.narrator!;
    const profile = (deps.voice ?? narrationVoice)(narrator);
    const spoken = speakablePost(post, (deps.pronunciations ?? loadPronunciations)(paths.dir));
    const respelled = spoken.paragraphs.filter((p, i) => p.text !== post.paragraphs[i].text).map((p) => p.id);
    if (respelled.length) log(`pronunciations: spoken text respelled in ${respelled.join(", ")} (post words unchanged)`);
    const voice = profile.voice, takes = profile.takes;
    const chunks = await bestTake(spoken, paths.narration, voice, takes, { ...(deps.synth ? { synth: deps.synth } : {}), ...(deps.measure ? { measure: deps.measure } : {}), log });
    const { wavs, spans } = await prepareTake(spoken, chunks);
    const source = join(paths.narration, "source.wav");
    if (wavs.length === 1) {
      copyFileSync(wavs[0], source);
      for (const f of STITCH_FILES) rmSync(join(paths.narration, f), { force: true });
    } else await concatWithGaps(wavs, TAKE_GAP_SECONDS, source, paths.narration);
    writeJson(join(paths.narration, PARAGRAPH_SPANS_FILE), { sha256: sha256(readFileSync(source)), spans } satisfies ParagraphSpansRecord);
    log(`${narrator} take: ${wavs.length} request${wavs.length === 1 ? "" : "s"} (${voiceModel(voice)})`);
    log(`${narrator} duration: ${(await probeDuration(source)).toFixed(3)}s`);
  }
  log(`✓ ingested ${post.paragraphs.length} paragraphs (${meta.narrator})`);
}

if (import.meta.main) {
  let args: IngestArgs;
  try { args = parseIngestArgs(process.argv.slice(2)); }
  catch (e) { console.error((e as Error).message); process.exit(2); }
  const perRun = { ...(args.label ? { label: args.label } : {}), ...(args.captureUrl ? { captureUrl: args.captureUrl } : {}) };
  await ingest(args.run, args.post, args.audio ? { audio: args.audio, ...perRun } : { narrator: args.narrator, ...perRun });
}
