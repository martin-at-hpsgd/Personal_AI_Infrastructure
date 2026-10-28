#!/usr/bin/env bun
// SocialCard — does a live page show a proper link card on X and LinkedIn?
//
//   bun LIFEOS/TOOLS/SocialCard.ts <url|host> [...]     check pages, exit 1 if any card is broken
//   bun LIFEOS/TOOLS/SocialCard.ts --config <cloudflare.config.ts>   check every domain it declares
//   add --json for one JSON line per page; --no-deep checks the roots only
//
// Fetches each page as Twitterbot and as LinkedInBot (the bytes those crawlers get), requires the
// tags each one needs to draw a large image card, then fetches the image each crawler would use
// (X: twitter:image, else og:image; LinkedIn: og:image) and checks it is a real image of at least
// 1200x600. An image whose size cannot be read fails. A non-HTML response (an API host) is skipped.
// A bare host also checks a sample of its deep pages from the sitemap: the newest few plus a random
// few. Roots alone hid broken cards on every blog post for months (2026-10-08: the root passed on
// every deploy while thousands of posts had 512px images X would not draw).
// A skipped target is an unverified one: unless it is declared (--allow-skip <host|url>, or `socialCardSkip: ["host"]` in the
// --config file) the run exits 4, never 0. A sitemap that exists but could not be fetched fails the host; only a 404/410 means
// "no sitemap". Exit codes: 0 every target checked and ok · 1 a card is broken or a sitemap fetch failed · 3 nothing checked
// · 4 a target was skipped without being declared.
// The deploy tooling runs this after every real deploy, because a site can go live with og:image but
// no twitter:card, so X shows no card and nothing else in the deploy path checks.

import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { destinationRefusal } from "./lib/GlanceQuestion.ts";
import { safeFetch, SafeFetchRefusal, type AllowNonPublic } from "./lib/SafeFetch.ts";

// Every request this tool makes goes to a URL a remote page chose (sitemap children, image tags, redirects), so each
// one is checked before it is sent: http(s) only, a public destination by name AND by every address the name resolves
// to, and redirects followed by hand so every hop is checked the same way.
export type Resolver = (host: string) => Promise<string[]>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
export const MAX_REDIRECT_HOPS = 5;

/** Why `url` may not be fetched, or null: the literal policy, then every resolved address. */
export async function publicUrlRefusal(url: string, resolve: Resolver = systemResolver): Promise<string | null> {
  const literal = destinationRefusal(url);
  if (literal) return literal;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return null; // an IP literal already passed the literal policy
  let addrs: string[];
  try { addrs = await resolve(host); } catch (e) { return `${host} does not resolve (${(e as Error).message})`; }
  if (!addrs.length) return `${host} resolves to no address`;
  for (const a of addrs) {
    const r = destinationRefusal(a.includes(":") ? `http://[${a}]/` : `http://${a}/`);
    if (r) return `${host} resolves to ${a}: ${r}`;
  }
  return null;
}

export interface GuardedFetchDeps {
  /** Replaces the network entirely (tests): each hop is checked, then handed to it. Absent: the real, pinned path. */
  fetchImpl?: FetchLike;
  resolve?: Resolver;
  /** Test seam: non-public classes the pinned path may reach. Production passes nothing (public only). */
  allow?: AllowNonPublic;
  /** Test seam: extra trust roots for the pinned path. */
  tls?: { ca?: string | string[] };
}

/**
 * GET with every hop checked, redirects followed by hand. On the real network each hop goes through
 * safeFetch: the name is resolved once, every answer must be public, and the connection is pinned to
 * the checked address, so a rebinding name cannot answer the check with one address and the connect
 * with another. The literal policy (reserved local names, IP
 * literals) still runs first on every hop. Returns the final response and the URL it came from.
 */
export async function guardedFetch(url: string, init: RequestInit, deps: GuardedFetchDeps = {}): Promise<{ res: Response; url: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let res: Response;
    if (deps.fetchImpl) {
      const refusal = await publicUrlRefusal(current, deps.resolve);
      if (refusal) throw new Error(`refused destination ${current}: ${refusal}`);
      res = await deps.fetchImpl(current, { ...init, redirect: "manual" });
    } else {
      const literal = destinationRefusal(current);
      if (literal) throw new Error(`refused destination ${current}: ${literal}`);
      try {
        res = await safeFetch(current, { ...init, redirect: "manual" }, { resolve: deps.resolve, allow: deps.allow, tls: deps.tls });
      } catch (e) {
        if (e instanceof SafeFetchRefusal) throw new Error(`refused destination ${current}: ${e.reason}`);
        throw e;
      }
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return { res, url: current };
    current = new URL(location, current).toString();
  }
  throw new Error(`more than ${MAX_REDIRECT_HOPS} redirects from ${url}`);
}

// The tool must send the crawler's own token (sites sniff it to pick the card markup), but it says what it is: a
// self-check by the site owner, not the crawler, so a log reader or a bot-reputation system can tell the two apart.
const SELF_CHECK = "LifeOS-SocialCard self-check emulating";
export const UAS = {
  x: `Twitterbot/1.0 (${SELF_CHECK} Twitterbot)`,
  linkedin: `LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient; ${SELF_CHECK} LinkedInBot)`,
} as const;

// Missing any REQUIRED tag means no image card: X draws nothing without twitter:card, LinkedIn
// nothing without og:title and og:image. WARN tags improve the card but a page works without them
// (plenty of sites ship cards with no og:url), so they never fail a deploy.
const REQUIRED: Record<keyof typeof UAS, string[]> = {
  x: ["twitter:card", "og:title", "og:image"],
  linkedin: ["og:title", "og:image"],
};
const WARN = ["og:description", "og:url", "og:type"];

type Result = { url: string; ok: boolean; skipped?: string; problems: string[]; warnings: string[]; image?: string };

// A page nobody can share needs no card: a login wall, an Access gate, a redirect to another host,
// a noindex page, or a root that does not answer 2xx (an API or a site with no homepage).
function privateReason(requested: string, finalUrl: string, html: string): string | null {
  const from = new URL(requested), to = new URL(finalUrl);
  if (to.host !== from.host) return `redirects to ${to.host}`;
  if (/login|signin|sign-in|auth/i.test(to.pathname)) return `redirects to ${to.pathname}`;
  if (/<meta\b[^>]*name\s*=\s*["']robots["'][^>]*noindex/i.test(html)) return "noindex page";
  return null;
}

function metaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    if (key && content !== undefined && !tags.has(key)) tags.set(key, content);
  }
  return tags;
}

export function imageSize(buf: Uint8Array): { w: number; h: number } | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // PNG: IHDR width/height at bytes 16 and 20.
  if (buf.length > 24 && dv.getUint32(0) === 0x89504e47) return { w: dv.getUint32(16), h: dv.getUint32(20) };
  // JPEG: walk segments to the first SOFn marker.
  if (buf.length > 4 && dv.getUint16(0) === 0xffd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      const len = dv.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: dv.getUint16(i + 7), h: dv.getUint16(i + 5) };
      i += 2 + len;
    }
  }
  // WebP: VP8X carries the canvas size, VP8 (lossy) and VP8L (lossless) their frame size.
  if (buf.length > 30 && new TextDecoder().decode(buf.slice(0, 4)) === "RIFF") {
    const kind = new TextDecoder().decode(buf.slice(12, 16));
    if (kind === "VP8X") return { w: 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)), h: 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) };
    if (kind === "VP8 ") return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
    if (kind === "VP8L") {
      const b = dv.getUint32(21, true);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  // GIF: logical screen size.
  if (buf.length > 10 && new TextDecoder().decode(buf.slice(0, 3)) === "GIF") return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
  return null;
}

async function check(input: string): Promise<Result> {
  const url = /^https?:\/\//.test(input) ? input : `https://${input}/`;
  const problems: string[] = [];
  const warnings: string[] = [];
  let image: string | undefined;
  const images = new Map<string, string[]>();
  for (const [who, ua] of Object.entries(UAS) as [keyof typeof UAS, string][]) {
    let res: Response, finalUrl: string;
    try {
      ({ res, url: finalUrl } = await guardedFetch(`${url}${url.includes("?") ? "&" : "?"}socialcard=${Date.now()}`, { headers: { "user-agent": ua }, signal: AbortSignal.timeout(20_000) }));
    } catch (e) {
      // A page that cannot be reached right after a deploy is a failure, never a pass.
      return { url, ok: false, problems: [`unreachable (${(e as Error).message})`], warnings: [] };
    }
    // A 4xx root is an API or a site with no homepage; a 5xx is a broken deploy.
    if (res.status >= 500) return { url, ok: false, problems: [`returned ${res.status}`], warnings: [] };
    if (!res.ok) return { url, ok: true, skipped: `returned ${res.status}`, problems: [], warnings: [] };
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) return { url, ok: true, skipped: "not an HTML page", problems: [], warnings: [] };
    const html = await res.text();
    const priv = privateReason(url, finalUrl, html);
    if (priv) return { url, ok: true, skipped: `not shared (${priv})`, problems: [], warnings: [] };
    const tags = metaTags(html);
    for (const t of REQUIRED[who]) if (!tags.get(t)?.trim()) problems.push(`${who}: missing ${t}`);
    if (who === "linkedin") for (const t of WARN) if (!tags.get(t)?.trim()) warnings.push(`missing ${t}`);
    const card = tags.get("twitter:card");
    if (who === "x" && card && card !== "summary_large_image") problems.push(`x: twitter:card is "${card}", not summary_large_image`);
    // X draws twitter:image when the page has one, og:image otherwise; LinkedIn reads og:image.
    const src = who === "x" ? (tags.get("twitter:image")?.trim() || tags.get("og:image")?.trim()) : tags.get("og:image")?.trim();
    if (src) images.set(src, [...(images.get(src) ?? []), who]);
    image ??= src;
  }
  for (const [src, whos] of images) {
    const label = `${whos.join("+")} image`;
    if (!/^https:\/\//.test(src)) { problems.push(`${label} is not an absolute https URL: ${src}`); continue; }
    try {
      const { res: r } = await guardedFetch(src, { headers: { "user-agent": UAS.x }, signal: AbortSignal.timeout(20_000) });
      const type = r.headers.get("content-type") ?? "";
      const buf = new Uint8Array(await r.arrayBuffer());
      if (!r.ok) problems.push(`${label} returned ${r.status}`);
      else if (!type.startsWith("image/")) problems.push(`${label} is ${type || "untyped"}, not an image`);
      else if (buf.length > 5_000_000) problems.push(`${label} is ${(buf.length / 1e6).toFixed(1)} MB; LinkedIn's limit is 5 MB`);
      else {
        const size = imageSize(buf);
        // An unreadable size fails: passing what cannot be measured is how broken cards hide.
        if (!size) problems.push(`${label} size could not be read (${type}); cannot confirm it is at least 1200x600`);
        else if (size.w < 1200 || size.h < 600) problems.push(`${label} is ${size.w}x${size.h}; a large card needs at least 1200x600`);
      }
    } catch (e) {
      problems.push(`${label} fetch failed (${(e as Error).message})`);
    }
  }
  return { url, ok: problems.length === 0, problems, warnings, image };
}

// Every public host a config serves: `domains: [...]`, plus route patterns (`pattern: "host/*"` →
// the host; `pattern: "host/path*"` → that page). Route-only configs used to yield nothing, so the
// deploy logged "no domains" and checked no card (2026-10-09: 27 of 60 deploys).
export function domainsFromConfig(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const block = text.match(/\bdomains\s*:\s*\[([^\]]*)\]/)?.[1] ?? "";
  const out = [...block.matchAll(/["']([a-z0-9.-]+\.[a-z]{2,})["']/gi)].map((m) => m[1]!.toLowerCase());
  for (const m of text.matchAll(/\bpattern\s*:\s*["']([a-z0-9.-]+\.[a-z]{2,})(\/[^"'*]*)?\*?["']/gi)) {
    const host = m[1]!.toLowerCase(), page = (m[2] ?? "/").replace(/\/+$/, "");
    out.push(page ? `https://${host}${page}` : host);
  }
  return [...new Set(out)];
}

/** A fetched text file: its body, "absent" (404/410: the host publishes none), or "failed" (timeout, network error, 5xx, 403...: it may exist, so nothing can be concluded). */
export type Fetched = { kind: "ok"; body: string } | { kind: "absent" } | { kind: "failed"; reason: string };
export type TextGetter = (url: string) => Promise<Fetched>;

export const fetchText: TextGetter = async (url) => {
  try {
    const { res: r } = await guardedFetch(url, { headers: { "user-agent": UAS.x }, signal: AbortSignal.timeout(20_000) });
    if (r.ok) return { kind: "ok", body: await r.text() };
    if (r.status === 404 || r.status === 410) return { kind: "absent" };
    return { kind: "failed", reason: `returned ${r.status}` };
  } catch (e) {
    return { kind: "failed", reason: (e as Error).message };
  }
};

type Entry = { loc: string; lastmod: string };
function entries(xml: string, tag: "url" | "sitemap"): Entry[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => ({
    loc: (m[1]!.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i)?.[1] ?? "").replace(/&amp;/g, "&"),
    lastmod: m[1]!.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i)?.[1] ?? "",
  })).filter((e) => e.loc);
}

// Deep pages for a host, from its sitemap (robots.txt Sitemap lines, else /sitemap.xml; one level
// of sitemap index): the `newest` most recently modified, plus `random` others. Empty when the host
// publishes no sitemap, which a one-page site legitimately does not.
export async function deepPages(host: string, newest = 3, random = 2): Promise<string[]> {
  return (await sitemapPages(host, newest, random)).pages;
}

/** The same sample, plus every fetch that failed (as opposed to a file that is simply absent), so a caller can fail instead of passing on root-only. */
export async function sitemapPages(host: string, newest = 3, random = 2, get: TextGetter = fetchText): Promise<{ pages: string[]; failures: string[] }> {
  const failures: string[] = [];
  const robotsRes = await get(`https://${host}/robots.txt`);
  if (robotsRes.kind === "failed") failures.push(`robots.txt: ${robotsRes.reason}`);
  const robots = robotsRes.kind === "ok" ? robotsRes.body : "";
  const maps = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!).filter((u) => { try { return new URL(u).host === host; } catch { return false; } });
  if (!maps.length) maps.push(`https://${host}/sitemap.xml`);
  const pages: Entry[] = [];
  for (const map of maps.slice(0, 3)) {
    const res = await get(map);
    if (res.kind === "failed") { failures.push(`${map}: ${res.reason}`); continue; }
    if (res.kind === "absent") continue;
    const xml = res.body;
    // A sitemap index names its children; only https children on the checked host are followed, the same rule the
    // robots.txt Sitemap lines get above. An off-host child is the host steering this tool at someone else's server.
    const onHost = (loc: string) => { try { const u = new URL(loc); return u.protocol === "https:" && u.host === host; } catch { return false; } };
    const children = entries(xml, "sitemap").filter((c) => onHost(c.loc)).sort((a, b) => b.lastmod.localeCompare(a.lastmod)).slice(0, 3);
    for (const c of children) {
      const child = await get(c.loc);
      if (child.kind === "failed") failures.push(`${c.loc}: ${child.reason}`);
      else if (child.kind === "ok") pages.push(...entries(child.body, "url"));
    }
    pages.push(...entries(xml, "url"));
  }
  const seen = new Set<string>();
  const deep = pages.filter((p) => {
    try {
      const u = new URL(p.loc);
      if (u.host !== host || u.pathname === "/" || seen.has(p.loc)) return false;
      seen.add(p.loc);
      return true;
    } catch {
      return false;
    }
  });
  // The newest page of each section (first path segment), so every page type is checked: a plain
  // newest-N sample picked three top-level pages and no blog post. Capped at `newest` + 3 sections.
  const byDate = [...deep].sort((a, b) => b.lastmod.localeCompare(a.lastmod));
  const section = (loc: string) => { const segs = new URL(loc).pathname.split("/").filter(Boolean); return segs.length > 1 ? segs[0]! : ""; };
  const pick: string[] = [];
  const seenSection = new Set<string>();
  for (const p of byDate) {
    if (pick.length >= newest + 3) break;
    const s = section(p.loc);
    if (!seenSection.has(s)) { seenSection.add(s); pick.push(p.loc); }
  }
  const rest = byDate.filter((p) => !pick.includes(p.loc));
  for (let i = 0; i < random && rest.length; i++) pick.push(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]!.loc);
  return { pages: pick, failures };
}

/** `socialCardSkip: ["host", ...]` in a deploy config: targets the project declares may be skipped (an API host, a login-walled app). */
export function skipsFromConfig(path: string): string[] {
  const block = readFileSync(path, "utf8").match(/\bsocialCardSkip\s*:\s*\[([^\]]*)\]/)?.[1] ?? "";
  return [...block.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!.toLowerCase());
}

/** Whether a skipped result's URL is covered by a declared exclusion (its host, or the exact URL). */
export function skipIsDeclared(url: string, allow: readonly string[]): boolean {
  let host = "";
  try { host = new URL(url).host.toLowerCase(); } catch { /* keep empty */ }
  const u = url.toLowerCase();
  return allow.some((a) => { const x = a.toLowerCase(); return x === host || x === u || x === u.replace(/\/$/, ""); });
}

/**
 * The run's exit code. A broken card or failed sitemap fetch is 1; a skipped target that was not declared leaves the site
 * unverified (4) even when another target passed; nothing checked is 3; otherwise 0.
 */
export function finalExit(results: readonly Pick<Result, "ok" | "skipped" | "url">[], allow: readonly string[], sitemapFailures = 0): number {
  const bad = results.filter((r) => !r.ok).length + sitemapFailures;
  const checked = results.filter((r) => !r.skipped).length;
  const undeclared = results.filter((r) => r.ok && r.skipped && !skipIsDeclared(r.url, allow)).length;
  return bad ? 1 : undeclared ? 4 : checked ? 0 : 3;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const deep = !argv.includes("--no-deep");
  const allowSkip: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--allow-skip") { const v = argv[++i]; if (!v || v.startsWith("--")) { console.error("--allow-skip needs a host or URL"); process.exit(2); } allowSkip.push(v.toLowerCase()); }
    else positional.push(argv[i]!);
  }
  const rest = positional.filter((a) => a !== "--json" && a !== "--no-deep");
  const ci = rest.indexOf("--config");
  if (ci !== -1) allowSkip.push(...skipsFromConfig(rest[ci + 1] ?? ""));
  const targets = ci === -1 ? rest : [...rest.filter((_, i) => i !== ci && i !== ci + 1), ...domainsFromConfig(rest[ci + 1] ?? "")];
  if (!targets.length) {
    console.error("usage: SocialCard.ts <url|host> [...] | --config <cloudflare.config.ts> [--json] [--no-deep]");
    process.exit(2);
  }
  const results: Result[] = [];
  let sitemapFailures = 0;
  // A wildcard route has no single page to fetch: say so instead of dropping it silently.
  if (ci !== -1 && !json) {
    const text = readFileSync(rest[ci + 1] ?? "", "utf8");
    for (const m of text.matchAll(/\bpattern\s*:\s*["'](\*[^"']*)["']/g)) console.log(`– ${m[1]}  skipped: wildcard route, no single page to check`);
  }
  const report = (r: Result) => {
    results.push(r);
    if (json) console.log(JSON.stringify(r));
    else if (r.skipped) console.log(`– ${r.url}  skipped: ${r.skipped}${skipIsDeclared(r.url, allowSkip) ? " (declared)" : "  NOT VERIFIED: declare it with --allow-skip or socialCardSkip, or fix the page"}`);
    else console.log(r.ok ? `✓ ${r.url}  card ok${r.warnings.length ? `  (could add: ${r.warnings.map((w) => w.replace("missing ", "")).join(", ")})` : ""}` : `✗ ${r.url}\n${r.problems.map((p) => `    ${p}`).join("\n")}`);
  };
  for (const t of targets) {
    const root = await check(t);
    report(root);
    // A bare host stands for the whole site, so its deep pages are checked too; a root that is not
    // a shareable HTML page (an API, a login wall) has none worth checking.
    const isHost = !/^https?:\/\//.test(t) || new URL(t).pathname === "/";
    if (!deep || !isHost || root.skipped || !root.ok) continue;
    const host = new URL(root.url).host;
    const { pages, failures } = await sitemapPages(host);
    // A sitemap that exists but could not be fetched is a failure: only a 404/410 means the host has none.
    if (failures.length) {
      sitemapFailures++;
      if (json) console.log(JSON.stringify({ url: host, ok: false, problems: failures.map((f) => `sitemap fetch failed: ${f}`), warnings: [] }));
      else console.log(`✗ ${host}\n${failures.map((f) => `    sitemap fetch failed: ${f}`).join("\n")}`);
    }
    if (!pages.length) { if (!json && !failures.length) console.log(`– ${host}  deep pages: no sitemap, root only`); continue; }
    // A page the sitemap lists must answer: a 4xx there is a dead link anyone can share.
    for (const r of await Promise.all(pages.map(check))) report(r.skipped?.startsWith("returned 4") ? { ...r, ok: false, skipped: undefined, problems: [`listed in the sitemap but ${r.skipped}`] } : r);
  }
  // Exit 3: nothing was checked (every page skipped as API, login wall, 4xx root or redirect); the caller reports it as
  // "no shareable page". Exit 4: something was skipped without a declaration, so the site is not fully verified.
  process.exit(finalExit(results, allowSkip, sitemapFailures));
}
