#!/usr/bin/env bun
/**
 * MarkdownPreCheck — the Cloudflare `Accept: text/markdown` pre-check and the
 * tier label for FourTierScrape, as code so both have fixture tests.
 *
 *   bun skills/BrightData/Tools/MarkdownPreCheck.ts check <url> [--json]
 *   bun skills/BrightData/Tools/MarkdownPreCheck.ts label <url> <precheck|1|2|3|4> [--why "<reason>"]
 *   bun skills/BrightData/Tools/MarkdownPreCheck.ts robots <url>
 *
 * Exit codes: 0 markdown detected (check), label printed, or robots.txt allows
 * the URL (robots); 1 HTML or error body, so the tier chain runs (check);
 * 2 usage error; 3 robots.txt disallows the URL, so the retrieval ends.
 */

export type MarkdownSignal = "content-type" | "x-markdown-tokens" | "body-shape";

export interface PreCheckResult {
  markdown: boolean;
  /** Every signal that fired, in the order the intent lists them. */
  signals: MarkdownSignal[];
  /** Parsed `x-markdown-tokens` value when the header is present and numeric. */
  tokens: number | null;
}

export type TierSource = "precheck" | 1 | 2 | 3 | 4;

function lowerHeaders(headers: Headers | Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [k, v] of entries) out.set(k.toLowerCase(), String(v));
  return out;
}

/**
 * The three signals from FourTierScrape.md § Pre-check. Any one is enough.
 * Signal 3 exists because Cloudflare's CDN sometimes reports text/html for a
 * markdown body.
 */
export function detectMarkdown(input: {
  headers: Headers | Record<string, string>;
  body: string;
  /** HTTP status when known. Anything outside 2xx is an error body, never markdown. */
  status?: number;
}): PreCheckResult {
  if (input.status !== undefined && (input.status < 200 || input.status > 299)) {
    return { markdown: false, signals: [], tokens: null };
  }
  const h = lowerHeaders(input.headers);
  const signals: MarkdownSignal[] = [];

  if ((h.get("content-type") ?? "").toLowerCase().includes("text/markdown")) {
    signals.push("content-type");
  }

  let tokens: number | null = null;
  if (h.has("x-markdown-tokens")) {
    signals.push("x-markdown-tokens");
    const n = Number.parseInt(h.get("x-markdown-tokens") ?? "", 10);
    tokens = Number.isFinite(n) ? n : null;
  }

  const head = input.body.replace(/^﻿/, "").trimStart();
  const looksHtml = /^<(!doctype|html)\b/i.test(head);
  if (!looksHtml && (head.startsWith("---") || head.startsWith("# "))) {
    signals.push("body-shape");
  }

  return { markdown: signals.length > 0, signals, tokens };
}

/**
 * The first line of the delivered output (FourTierScrape.md § Output format).
 * Tier 3 and Tier 4 must say why escalation was needed.
 */
export function tierLabel(url: string, source: TierSource, why?: string): string {
  if (!url.trim()) throw new Error("tierLabel: url is required");
  if (source !== "precheck" && ![1, 2, 3, 4].includes(source)) {
    throw new Error(`tierLabel: unknown tier ${String(source)}`);
  }
  if (source === "precheck") {
    return `Successfully retrieved content from ${url} using the Cloudflare markdown pre-check (no tier needed)`;
  }
  const base = `Successfully retrieved content from ${url} using Tier ${source}`;
  if (source === 3 || source === 4) {
    const reason = (why ?? "").trim();
    if (!reason) throw new Error(`tierLabel: Tier ${source} needs a one-line reason for escalating`);
    if (/\n/.test(reason)) throw new Error("tierLabel: the escalation reason must be one line");
    return `${base} (escalated: ${reason})`;
  }
  return base;
}

/** The user agent the curl tiers declare (FourTierScrape.md Tier 1). */
export const ROBOTS_AGENT = "LifeOS-BrightData";

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

function robotsRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

/**
 * Whether robots.txt allows `path` (path plus query) for `agent`. The group
 * naming the agent wins over `*`; the longest matching pattern wins, and Allow
 * beats Disallow on a tie. An empty Disallow allows everything; no matching
 * group allows everything.
 */
export function robotsAllows(robotsTxt: string, path: string, agent: string = ROBOTS_AGENT): boolean {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current || (field !== "allow" && field !== "disallow")) continue;
    if (value === "") continue;
    current.rules.push({ allow: field === "allow", pattern: value });
  }
  const me = agent.toLowerCase();
  const named = groups.filter((g) => g.agents.some((a) => a !== "*" && me.includes(a)));
  const chosen = named.length > 0 ? named : groups.filter((g) => g.agents.includes("*"));
  let best: RobotsRule | null = null;
  for (const rule of chosen.flatMap((g) => g.rules)) {
    if (!robotsRegex(rule.pattern).test(path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

function parseSource(raw: string): TierSource | null {
  if (raw === "precheck") return "precheck";
  const n = Number(raw);
  return n === 1 || n === 2 || n === 3 || n === 4 ? n : null;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1] === "--why"));

  if (cmd === "check") {
    const url = positional[0];
    if (!url) {
      console.error("usage: MarkdownPreCheck.ts check <url> [--json]");
      return 2;
    }
    let result: PreCheckResult;
    let body = "";
    let status = 0;
    try {
      const res = await fetch(url, { headers: { Accept: "text/markdown" }, redirect: "follow" });
      body = await res.text();
      status = res.status;
      result = detectMarkdown({ headers: res.headers, body, status });
    } catch (err) {
      console.error(`fetch failed: ${(err as Error).message}`);
      return 1;
    }
    if (rest.includes("--json")) {
      console.log(JSON.stringify({ url, status, ...result, body: result.markdown ? body : undefined }));
    } else if (status < 200 || status > 299) {
      console.error(`HTTP ${status}: error body, proceed to Tier 1`);
    } else if (result.markdown) {
      console.log(tierLabel(url, "precheck"));
      if (result.tokens !== null) console.log(`x-markdown-tokens: ${result.tokens}`);
      console.log("");
      console.log(body);
    } else {
      console.error("no markdown signal: proceed to Tier 1");
    }
    return result.markdown ? 0 : 1;
  }

  if (cmd === "label") {
    const [url, rawTier] = positional;
    const source = rawTier ? parseSource(rawTier) : null;
    if (!url || source === null) {
      console.error('usage: MarkdownPreCheck.ts label <url> <precheck|1|2|3|4> [--why "<reason>"]');
      return 2;
    }
    try {
      console.log(tierLabel(url, source, flag("--why")));
      return 0;
    } catch (err) {
      console.error((err as Error).message);
      return 2;
    }
  }

  if (cmd === "robots") {
    const url = positional[0];
    let target: URL;
    try {
      target = new URL(url ?? "");
    } catch {
      console.error("usage: MarkdownPreCheck.ts robots <url>");
      return 2;
    }
    let txt = "";
    try {
      const res = await fetch(new URL("/robots.txt", target.origin), {
        headers: { "User-Agent": ROBOTS_AGENT + "/1.0" },
        redirect: "follow",
      });
      // 4xx means no robots.txt, so everything is allowed. A 5xx means the site
      // cannot tell us, so treat it as a refusal (RFC 9309).
      if (res.status >= 500) {
        console.error("robots.txt unreachable (HTTP " + res.status + "): treated as disallow for " + url);
        return 3;
      }
      if (res.ok) txt = await res.text();
    } catch (err) {
      console.error("robots.txt fetch failed: " + (err as Error).message + ": treated as disallow for " + url);
      return 3;
    }
    if (!robotsAllows(txt, target.pathname + target.search)) {
      console.error("robots.txt disallows " + url + " for " + ROBOTS_AGENT + ": end the retrieval and report it");
      return 3;
    }
    console.log("robots.txt allows " + url);
    return 0;
  }

  console.error("usage: MarkdownPreCheck.ts <check|label|robots> ... (see MarkdownPreCheck.help.md)");
  return 2;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
