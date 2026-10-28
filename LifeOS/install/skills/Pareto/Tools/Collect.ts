#!/usr/bin/env bun
/**
 * Collect.ts - Wide collection for a Pareto run: YouTube, GitHub, web.
 *
 * Usage:
 *   bun ~/.claude/skills/Pareto/Tools/Collect.ts "<topic>" [options]
 *
 * Every source reports ok/failed with a count; a failed source never fails the run.
 * Output is one JSON document (see Collect.help.md for the schema).
 *
 * @author LifeOS System
 * @version 1.0.0
 */

import { parseEnv } from "../../../LIFEOS/TOOLS/Env.ts";
import { getEnvPath } from "../../../LIFEOS/TOOLS/Paths.ts";

export type SourceName = "youtube" | "github" | "web" | "extra";

export interface Item {
  id: string;
  source: SourceName;
  url: string;
  title: string;
  author: string | null;
  description: string;
  /** Views (youtube), stars (github); null where the source exposes no reach. */
  reach: number | null;
  reach_unit: "views" | "stars" | null;
  /** The author's typical reach (channel subscribers, owner followers); null when unknown. */
  author_baseline: number | null;
  published_at: string | null;
}

export interface SourceReport {
  name: SourceName;
  status: "ok" | "failed" | "skipped";
  count: number;
  error?: string;
}

export interface Collection {
  topic: string;
  collected_at: string;
  sources: SourceReport[];
  items: Item[];
}

type Env = Record<string, string | undefined>;
type Collector = (topic: string, env: Env, perSource: number) => Promise<Item[]>;

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ── YouTube: relevance + view-count searches across three windows, then stats + channel baselines.
export const youtube: Collector = async (topic, env, perSource) => {
  const key = env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YOUTUBE_API_KEY not set");
  const base = "https://www.googleapis.com/youtube/v3";
  const per = Math.min(50, Math.max(5, Math.ceil(perSource / 4)));
  const windows: Array<{ order: string; after?: string; before?: string }> = [
    { order: "relevance" },
    { order: "viewCount", after: iso(90 * DAY) },
    { order: "viewCount", after: iso(730 * DAY) },
    { order: "viewCount", before: iso(730 * DAY) },
  ];
  const ids = new Set<string>();
  for (const w of windows) {
    const p = new URLSearchParams({ part: "id", type: "video", maxResults: String(per), order: w.order, q: topic, key });
    if (w.after) p.set("publishedAfter", w.after);
    if (w.before) p.set("publishedBefore", w.before);
    const j = await getJson(`${base}/search?${p}`);
    for (const it of j.items ?? []) if (it.id?.videoId) ids.add(it.id.videoId);
  }
  const videoIds = [...ids];
  const videos: any[] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const p = new URLSearchParams({ part: "snippet,statistics", id: videoIds.slice(i, i + 50).join(","), key });
    videos.push(...((await getJson(`${base}/videos?${p}`)).items ?? []));
  }
  const channelIds = [...new Set(videos.map((v) => v.snippet?.channelId).filter(Boolean))];
  const subs = new Map<string, number>();
  for (let i = 0; i < channelIds.length; i += 50) {
    const p = new URLSearchParams({ part: "statistics", id: channelIds.slice(i, i + 50).join(","), key });
    for (const c of (await getJson(`${base}/channels?${p}`)).items ?? []) {
      const n = Number(c.statistics?.subscriberCount);
      if (!c.statistics?.hiddenSubscriberCount && Number.isFinite(n)) subs.set(c.id, n);
    }
  }
  return videos.map((v) => ({
    id: `youtube:${v.id}`,
    source: "youtube" as const,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    title: v.snippet?.title ?? "",
    author: v.snippet?.channelTitle ?? null,
    description: (v.snippet?.description ?? "").slice(0, 1000),
    reach: v.statistics?.viewCount != null ? Number(v.statistics.viewCount) : null,
    reach_unit: "views" as const,
    author_baseline: subs.get(v.snippet?.channelId) ?? null,
    published_at: v.snippet?.publishedAt ?? null,
  }));
};

// ── GitHub: all-time stars + recently created, through the authenticated gh CLI (argument array, no shell).
export const github: Collector = async (topic, _env, perSource) => {
  const per = Math.min(100, Math.max(10, Math.ceil(perSource / 2)));
  const queries = [topic, `${topic} created:>${iso(180 * DAY).slice(0, 10)}`];
  const seen = new Map<string, Item>();
  for (const q of queries) {
    const proc = Bun.spawn(["gh", "api", "-X", "GET", "search/repositories", "-f", `q=${q}`, "-f", "sort=stars", "-f", `per_page=${per}`], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`gh exit ${code}: ${err.slice(0, 200)}`);
    for (const r of JSON.parse(out).items ?? []) {
      seen.set(r.full_name, {
        id: `github:${r.full_name}`,
        source: "github",
        url: r.html_url,
        title: r.full_name,
        author: r.owner?.login ?? null,
        description: r.description ?? "",
        reach: r.stargazers_count ?? null,
        reach_unit: "stars",
        author_baseline: null,
        published_at: r.created_at ?? null,
      });
    }
  }
  return [...seen.values()];
};

// ── Web: Perplexity Search API across framing variants that pull past, present, and frontier writing.
export const web: Collector = async (topic, env, perSource) => {
  const key = env.PERPLEXITY_API_KEY;
  if (!key) throw new Error("PERPLEXITY_API_KEY not set");
  const per = Math.min(20, Math.max(5, Math.ceil(perSource / 4)));
  const variants = [topic, `the future of ${topic}`, `${topic} what changed`, `${topic} contrarian view`];
  const out = new Map<string, Item>();
  for (const query of variants) {
    const j = await getJson("https://api.perplexity.ai/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: per }),
    });
    for (const r of j.results ?? []) {
      if (!r.url || out.has(r.url)) continue;
      out.set(r.url, {
        id: `web:${r.url}`, source: "web", url: r.url, title: r.title ?? "", author: null,
        description: (r.snippet ?? "").slice(0, 1000), reach: null, reach_unit: null, author_baseline: null,
        // last_updated is when the page was last crawled; a 2025 arXiv paper came back as 2026. Null beats a wrong era.
        published_at: r.date ?? null,
      });
    }
  }
  return [...out.values()];
};

/** Extra items (e.g. Research skill output): a JSON array of {url, title, description?, author?, published_at?}. */
export function extraItems(raw: unknown): Item[] {
  if (!Array.isArray(raw)) throw new Error("--extra file must be a JSON array");
  return raw.filter((r: any) => typeof r?.url === "string").map((r: any) => ({
    id: `extra:${r.url}`, source: "extra" as const, url: r.url, title: r.title ?? r.url, author: r.author ?? null,
    description: r.description ?? "", reach: null, reach_unit: null, author_baseline: null, published_at: r.published_at ?? null,
  }));
}

export const COLLECTORS: Record<Exclude<SourceName, "extra">, Collector> = { youtube, github, web };

export async function collect(topic: string, opts: { sources: string[]; perSource: number; env: Env; collectors?: Partial<Record<string, Collector>>; extra?: Item[] }): Promise<Collection> {
  const table = { ...COLLECTORS, ...(opts.collectors ?? {}) };
  const results = await Promise.allSettled(opts.sources.map((s) => {
    const fn = table[s];
    return fn ? fn(topic, opts.env, opts.perSource) : Promise.reject(new Error(`unknown source ${s}`));
  }));
  const sources: SourceReport[] = [];
  const items: Item[] = [];
  results.forEach((r, i) => {
    const name = opts.sources[i] as SourceName;
    if (r.status === "fulfilled") { sources.push({ name, status: "ok", count: r.value.length }); items.push(...r.value); }
    else sources.push({ name, status: "failed", count: 0, error: String(r.reason?.message ?? r.reason) });
  });
  if (opts.extra?.length) { sources.push({ name: "extra", status: "ok", count: opts.extra.length }); items.push(...opts.extra); }
  const seen = new Set<string>();
  return { topic, collected_at: new Date().toISOString(), sources, items: items.filter((it) => (seen.has(it.url) ? false : (seen.add(it.url), true))) };
}

async function main() {
  const args = Bun.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(await Bun.file(new URL("./Collect.help.md", import.meta.url)).text());
    process.exit(args.length ? 0 : 1);
  }
  let topic = "", out = "", extraPath = "", perSource = 100;
  let sources = Object.keys(COLLECTORS);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--sources") sources = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--per-source") perSource = Number(args[++i]);
    else if (a === "--out") out = args[++i];
    else if (a === "--extra") extraPath = args[++i];
    else if (!a.startsWith("--")) topic = topic ? `${topic} ${a}` : a;
  }
  if (!topic) { console.error("\x1b[31mtopic required\x1b[0m"); process.exit(2); }
  sources = sources.filter((s) => s !== "extra"); // --sources extra = only the --extra file
  let fileEnv: Env = {};
  try { fileEnv = parseEnv(await Bun.file(getEnvPath()).text()); } catch { /* fall through to process.env */ }
  const env: Env = { ...process.env, ...fileEnv };
  const extra = extraPath ? extraItems(JSON.parse(await Bun.file(extraPath).text())) : undefined;
  const result = await collect(topic, { sources, perSource, env, extra });
  for (const s of result.sources) {
    const color = s.status === "ok" ? "\x1b[32m" : "\x1b[33m";
    console.error(`${color}${s.name.padEnd(8)} ${s.status.padEnd(7)} ${String(s.count).padStart(4)}\x1b[0m${s.error ? `  ${s.error}` : ""}`);
  }
  const json = JSON.stringify(result, null, 2);
  if (out) { await Bun.write(out, json); console.error(`\x1b[36m${result.items.length} items → ${out}\x1b[0m`); }
  else console.log(json);
  if (result.sources.every((s) => s.status !== "ok")) process.exit(1);
}

if (import.meta.main) await main();
