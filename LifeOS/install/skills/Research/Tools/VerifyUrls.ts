#!/usr/bin/env bun
// VerifyUrls — the Research skill's one URL verifier (UrlVerificationProtocol.md).
//
//   bun skills/Research/Tools/VerifyUrls.ts <pairs.txt>        one "url|key phrase" per line
//   bun skills/Research/Tools/VerifyUrls.ts --answer <file.md>  a delivered answer: every URL in it,
//                                                              plus a check for the retired nine-field template
//
// Verdicts: SUPPORTED (the key phrase is in the page's visible text at the final URL, never in a script, style or comment), UNSUPPORTED (the page loads but the
// phrase is absent, or no phrase was given: read the page itself before keeping the URL), DEAD (non-2xx,
// a "not found" or login page, or a redirect to the site's homepage: remove the URL).
// Exit 0 only when every paired URL is SUPPORTED. In --answer mode there are no phrases, so a live URL
// (UNSUPPORTED, "read the page") is listed for reading but does not fail the run; only DEAD URLs and a
// retired template line do.
// A status code alone never keeps a URL: a soft 404 or a login wall also answers 200.
// Every fetch goes through SafeFetch: a cited URL is text someone else chose, so a loopback, private, link-local
// or metadata destination is refused before anything is sent, on the first request and on every redirect hop.
// A refused URL is DEAD and is never fetched another way.

import { safeFetch, SafeFetchRefusal, type SafeFetchOptions } from "../../../LIFEOS/TOOLS/lib/SafeFetch.ts";

export type Verdict = "SUPPORTED" | "UNSUPPORTED" | "DEAD";

export interface Fetched {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  body: string;
  /** Why SafeFetch would not send the request (a non-public destination, a bad scheme, an unresolvable host). */
  refused?: string;
}

// Phrases that mark a not-found page. They are tested only where a soft 404 announces itself (the title,
// the top headings, or the whole text of a near-empty page with neither), never against article prose: a valid
// troubleshooting page that discusses "404 error" must not be judged dead.
const DEAD_PHRASES = [
  /page (?:was )?not found/i,
  /404 (?:error|not found)/i,
  /this page (?:does not|doesn't) exist/i,
];
// A title or top heading is split into segments at its separators ("404 - Page not found | Site"). A segment
// is a not-found announcement only when the whole segment is one, so "How to Fix a 404 Error" stays live.
const SEGMENT_SPLIT = /\s*[|–—·•:]\s*|\s+-\s+/;
const NOT_FOUND_SEGMENT =
  /^(?:(?:error\s*)?404(?:\s*error)?(?:\s*-?\s*(?:page\s+)?not found)?|(?:oops[!,.]?\s*)?(?:(?:this\s+)?(?:page|file|document)\s+(?:was\s+)?)?not found|this page (?:does not|doesn't) exist)$/i;
// A bare 404 segment ("404", "Error 404") with no "not found" words is a weak announcement: real 404 titles
// ("404 | Example") and article titles ("404 - Causes and fixes") both carry it, so the body decides (below).
const BARE_404_SEGMENT = /^(?:error\s*)?404(?:\s*error)?$/i;
// A login wall's title segment starts with the sign-in verb and is short ("Sign in to continue", "Login").
// The verb alone, or with "to continue", is always a wall; a longer one ("Sign in with OAuth", "Log in to Example")
// is a weak announcement, since documentation titles read the same way.
const LOGIN_SEGMENT = /^(?:sign ?in|log ?in)\b/i;
const LOGIN_WALL_SEGMENT = /^(?:sign ?in|log ?in)(?:\s+(?:here|now|to continue))?$/i;
const LOGIN_SEGMENT_MAX_WORDS = 5;
// A weak announcement is overridden only by an article: at least this many words of content text and no
// password field. A soft 404 or a login page carries site chrome, a form and a line or two, never an article.
const ARTICLE_WORDS = 150;
const PASSWORD_FIELD = /<input\b[^>]*\btype\s*=\s*["']?password\b/i;
// Content text is whatever the page shows outside its chrome, in any wrapper: paragraphs, divs, lists, tables
// and code blocks all count, since documentation is often built from no <p> at all. Chrome is the head and
// title, navigation, page header and footer, sidebars, forms and controls, headings (they carry the
// announcement itself) and link text (menus and footers are mostly links).
const CHROME_ELEMENTS = /<(head|title|nav|header|footer|aside|form|button|select|noscript|svg|template|a|h[1-6])\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// A page whose visible text is shorter than this is a stub: its whole text is checked for the phrases.
const STUB_TEXT_CHARS = 200;

function segments(s: string): string[] {
  return textOf(s)
    .split(SEGMENT_SPLIT)
    .map((x) => x.replace(/[.!?]+$/, "").trim())
    .filter(Boolean);
}

interface Announcement { segment: string; weak: boolean }

function notFoundAnnouncement(s: string): Announcement | undefined {
  // A strong segment anywhere wins: "404 - Page not found" announces itself in its second segment.
  const found = segments(s).filter((seg) => NOT_FOUND_SEGMENT.test(seg)).map((segment) => ({ segment, weak: BARE_404_SEGMENT.test(segment) }));
  return found.find((a) => !a.weak) ?? found[0];
}

function loginAnnouncement(s: string): Announcement | undefined {
  const found = segments(s).filter((seg) => LOGIN_SEGMENT.test(seg) && seg.split(/\s+/).length <= LOGIN_SEGMENT_MAX_WORDS).map((segment) => ({ segment, weak: !LOGIN_WALL_SEGMENT.test(segment) }));
  return found.find((a) => !a.weak) ?? found[0];
}

/** Whether the page is an article: ARTICLE_WORDS or more of content text outside the chrome, and no password field. */
function isArticle(body: string): boolean {
  if (PASSWORD_FIELD.test(body)) return false;
  let content = body.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  for (let prev = ""; prev !== content; ) {
    prev = content;
    content = content.replace(CHROME_ELEMENTS, " ");
  }
  return textOf(content).split(/\s+/).filter(Boolean).length >= ARTICLE_WORDS;
}

function textOf(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const squash = (t: string): string => t.replace(/\s+/g, " ").trim().toLowerCase();

/** The text a reader sees: scripts, styles, templates, noscript blocks, comments and tags are gone, common entities decoded. */
function visibleText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
  return squash(text);
}

function deadReason(body: string): string | undefined {
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  let article: boolean | undefined;
  const decisive = (a: Announcement | undefined) => a !== undefined && (!a.weak || !(article ??= isArticle(body)));
  if (decisive(notFoundAnnouncement(title)) || decisive(loginAnnouncement(title))) return `title "${textOf(title)}"`;
  const headings = [...body.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)].map((m) => textOf(m[1]));
  for (const h of headings) {
    const a = notFoundAnnouncement(h);
    if (decisive(a)) return `heading "${h}" (${a!.segment})`;
  }
  // A bare stub (no title, no top heading, little text) is how a server's default error body looks
  // ("404 page not found"). A titled or headed page announced itself above, so its prose is never tested.
  const text = textOf(body);
  if (!textOf(title) && headings.length === 0 && text.length < STUB_TEXT_CHARS) {
    const m = DEAD_PHRASES.find((p) => p.test(text));
    if (m) return `stub page (${m.source})`;
  }
  return undefined;
}

// The retired per-mode response template (Constitutional rule: one format, no modes).
const RETIRED_TEMPLATE = /^\s*(?:📋 SUMMARY:|🔍 ANALYSIS:|⚡ ACTIONS:|✅ RESULTS:|📊 STATUS:|📁 CAPTURE:|➡️ NEXT:|📖 STORY EXPLANATION:|🎯 COMPLETED:)/u;

function isHomepage(u: string): boolean {
  try {
    const p = new URL(u).pathname;
    return p === "/" || p === "";
  } catch {
    return false;
  }
}

export function judge(f: Fetched, phrase?: string): { verdict: Verdict; reason: string } {
  if (f.refused) return { verdict: "DEAD", reason: `not fetched: ${f.refused}` };
  if (f.status < 200 || f.status >= 300) return { verdict: "DEAD", reason: `status ${f.status}` };
  if (!isHomepage(f.requestedUrl) && isHomepage(f.finalUrl))
    return { verdict: "DEAD", reason: `redirected to homepage ${f.finalUrl}` };
  const dead = deadReason(f.body);
  if (dead) return { verdict: "DEAD", reason: `not-found or login page: ${dead}` };
  if (!phrase) return { verdict: "UNSUPPORTED", reason: "no key phrase given; read the page" };
  if (visibleText(f.body).includes(squash(phrase))) return { verdict: "SUPPORTED", reason: "phrase found" };
  return { verdict: "UNSUPPORTED", reason: `phrase "${phrase}" absent; read the page` };
}

/** Whether a verdict fails the run: DEAD always; UNSUPPORTED only when a key phrase was given to check. */
export function failsRun(verdict: Verdict, phrase?: string): boolean {
  return verdict === "DEAD" || (verdict === "UNSUPPORTED" && Boolean(phrase));
}

export function retiredTemplateLines(text: string): number[] {
  return text.split("\n").flatMap((line, i) => (RETIRED_TEMPLATE.test(line) ? [i + 1] : []));
}

export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>()\[\]"'`]+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?*_]+$/, "")))];
}

export function parsePairs(text: string): { url: string; phrase?: string }[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("|");
      return i === -1 ? { url: l } : { url: l.slice(0, i).trim(), phrase: l.slice(i + 1).trim() || undefined };
    });
}

/** One cited URL through SafeFetch (public destinations only, every redirect hop re-checked). `opts` is a test seam. */
export async function fetchPage(url: string, opts: SafeFetchOptions = {}): Promise<Fetched> {
  try {
    const res = await safeFetch(
      url,
      { redirect: "follow", headers: { "User-Agent": "LifeOS-Research/1.0 (citation link checker)" } },
      { timeoutMs: 20_000, ...opts },
    );
    return { requestedUrl: url, finalUrl: res.url || url, status: res.status, body: await res.text() };
  } catch (e) {
    if (e instanceof SafeFetchRefusal) return { requestedUrl: url, finalUrl: url, status: 0, body: "", refused: e.reason };
    return { requestedUrl: url, finalUrl: url, status: 0, body: String(e) };
  }
}

async function main(argv: string[]): Promise<number> {
  const answerMode = argv[0] === "--answer";
  const path = answerMode ? argv[1] : argv[0];
  if (!path) {
    console.error("usage: VerifyUrls.ts <pairs.txt> | --answer <file.md>");
    return 2;
  }
  const text = await Bun.file(path).text();
  let failed = false;
  if (answerMode) {
    const lines = retiredTemplateLines(text);
    if (lines.length) {
      failed = true;
      console.log(`RETIRED-TEMPLATE lines ${lines.join(", ")}: answer first, in the system format`);
    }
  }
  const pairs = answerMode ? extractUrls(text).map((url) => ({ url })) : parsePairs(text);
  const results = await Promise.all(pairs.map(async (p) => ({ p, f: await fetchPage(p.url) })));
  for (const { p, f } of results) {
    const { verdict, reason } = judge(f, p.phrase);
    if (failsRun(verdict, p.phrase)) failed = true;
    console.log(`${verdict} ${f.status} ${f.finalUrl} (cited: ${p.url}) ${reason}`);
  }
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
