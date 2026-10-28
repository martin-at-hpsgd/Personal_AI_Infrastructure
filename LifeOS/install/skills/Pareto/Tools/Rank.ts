#!/usr/bin/env bun
/**
 * Rank.ts - Score a Collect.ts collection down to the vital few.
 *
 * Usage:
 *   bun ~/.claude/skills/Pareto/Tools/Rank.ts <collection.json> [more.json ...] [--top 100] [--out ranked.json]
 *
 * Factors (each 0..1, visible per item): relevance, reach (percentile within source),
 * recency, outlier (reach vs the author's baseline; star velocity for repos).
 * Every item also carries an era (past | current) and a frontier_candidate flag.
 *
 * @author LifeOS System
 * @version 1.0.0
 */

import type { Collection, Item } from "./Collect.ts";

export interface Factors { relevance: number; reach: number; recency: number; outlier: number }
export interface Ranked extends Item {
  score: number;
  factors: Factors;
  era: "past" | "current" | "undated";
  frontier_candidate: boolean;
}
export interface RankResult { topic: string; ranked_at: string; considered: number; dropped_irrelevant: number; items: Ranked[] }

export const WEIGHTS: Factors = { relevance: 0.35, reach: 0.25, recency: 0.15, outlier: 0.25 };
export const RELEVANCE_FLOOR = 0.2;
const DAY = 86_400_000;
const STOP = new Set(["the", "and", "for", "with", "how", "what", "why", "are", "was", "from", "into", "about", "this", "that", "of", "to", "in", "on", "a", "an", "is", "vs"]);

export function terms(topic: string): string[] {
  return [...new Set(topic.toLowerCase().split(/[^a-z0-9+#.]+/).filter((t) => t.length > 1 && !STOP.has(t)))];
}

/** Share of distinct topic terms present anywhere in title or description. */
export function coverage(topic: string, item: Pick<Item, "title" | "description">): number {
  const ts = terms(topic);
  if (!ts.length) return 0;
  const text = (item.title + " " + item.description).toLowerCase();
  return ts.filter((t) => text.includes(t)).length / ts.length;
}

/** Repos named like cracked-software lures ("X-Pro-Download-2026", "Y-Activator") are malware bait, never signal. */
export const LURE = /(download|crack|activator|keygen|serial|torrent|portable|full[-_ ]?version|last[-_ ]?version|free[-_ ]?version|license[-_ ]?key|[-_]full([-_]|$))/i;
/** Repos under 10 stars are noise for a zeitgeist read; keyword matches alone ranked 1-star repos into the top 12 (2026-09-25). */
export const MIN_GITHUB_STARS = 10;
export function isLure(item: Pick<Item, "source" | "title" | "reach">): boolean {
  return item.source === "github" && (LURE.test(item.title) || (item.reach ?? 0) < MIN_GITHUB_STARS);
}

/** Below this measured reach an item cannot show early traction, whatever its ratio. */
export const MIN_FRONTIER_REACH: Partial<Record<string, number>> = { youtube: 1000, github: 50 };

export function relevance(topic: string, item: Pick<Item, "title" | "description">): number {
  const ts = terms(topic);
  if (!ts.length) return 0;
  const title = item.title.toLowerCase();
  const desc = item.description.toLowerCase();
  if (ts.length > 1 && title.includes(topic.toLowerCase().trim())) return 1;
  let hits = 0;
  for (const t of ts) hits += (title.includes(t) ? 2 : 0) + (desc.includes(t) ? 1 : 0);
  return Math.min(1, hits / (3 * ts.length));
}

/** Percentile rank (0..1) of each value among the non-null values; null stays null. */
export function percentiles(values: Array<number | null>): Array<number | null> {
  const sorted = values.filter((v): v is number => v != null).sort((a, b) => a - b);
  if (!sorted.length) return values.map(() => null);
  return values.map((v) => {
    if (v == null) return null;
    if (sorted.length === 1) return 1;
    let lo = 0;
    while (lo < sorted.length && sorted[lo] < v) lo++;
    return lo / (sorted.length - 1);
  });
}

function ageDays(published: string | null, now: number): number | null {
  if (!published) return null;
  const t = Date.parse(published);
  return Number.isFinite(t) ? Math.max(0, (now - t) / DAY) : null;
}

export function rank(col: Collection, opts: { top?: number; now?: number } = {}): RankResult {
  const now = opts.now ?? Date.now();
  const top = opts.top ?? 100;
  const scored: Ranked[] = [];
  // Percentiles are computed over on-topic items only, so a viral off-topic hit cannot skew reach or outlier.
  // Research-handoff items were picked for the topic by a model, so the keyword floor does not apply to them.
  // Multi-term topics need 60% of their terms present (both of two, two of three): "3D modeling software" once let 3D-printing shorts in on "3d" alone.
  const onTopic = col.items.filter((it) => it.source === "extra" || (!isLure(it) && relevance(col.topic, it) >= RELEVANCE_FLOOR && coverage(col.topic, it) >= 0.6));
  const bySource = new Map<string, Item[]>();
  for (const it of onTopic) bySource.set(it.source, [...(bySource.get(it.source) ?? []), it]);

  for (const items of bySource.values()) {
    const reachPct = percentiles(items.map((it) => (it.reach != null ? Math.log1p(it.reach) : null)));
    const outlierRaw = items.map((it) => {
      if (it.reach == null) return null;
      if (it.author_baseline != null) return it.reach / Math.max(it.author_baseline, 100);
      if (it.reach_unit === "stars") {
        const age = ageDays(it.published_at, now);
        return age != null ? it.reach / Math.max(age, 7) : null;
      }
      return null;
    });
    const outlierPct = percentiles(outlierRaw);
    items.forEach((it, i) => {
      const age = ageDays(it.published_at, now);
      const factors: Factors = {
        relevance: relevance(col.topic, it),
        reach: reachPct[i] ?? 0.5,
        recency: age == null ? 0.3 : Math.exp(-age / 365),
        outlier: outlierPct[i] ?? 0,
      };
      const score = (Object.keys(WEIGHTS) as Array<keyof Factors>).reduce((s, k) => s + WEIGHTS[k] * factors[k], 0);
      const era = age == null ? "undated" : age > 730 ? "past" : "current";
      // Early means recent and not already big: a viral hit also beats its channel baseline, so reach must sit outside the top third.
      // Items with no reach signal cannot show early traction; only the Research handoff (picked for being ahead) qualifies without one.
      const recent = age == null || age <= 365;
      const frontier_candidate = it.source === "extra" ? recent : age != null && age <= 365 && it.reach != null && it.reach >= (MIN_FRONTIER_REACH[it.source] ?? 0) && factors.reach < 0.66 && factors.outlier >= 0.6;
      scored.push({ ...it, score: Math.round(score * 1000) / 1000, factors, era, frontier_candidate });
    });
  }

  const relevant = scored.sort((a, b) => b.score - a.score);
  // Research picks carry no reach signal and would score low, but they were chosen as frontier material: always keep them.
  const picks = relevant.filter((r) => r.source === "extra").slice(0, top);
  const chosen = [...picks, ...relevant.filter((r) => r.source !== "extra").slice(0, top - picks.length)];
  // Keep the report's two time-bound sections fed: reserve slots for frontier candidates and past items.
  for (const want of [(r: Ranked) => r.frontier_candidate, (r: Ranked) => r.era === "past"]) {
    const reserve = Math.min(10, Math.floor(top / 10));
    const missing = relevant.filter((r) => want(r) && !chosen.includes(r)).slice(0, Math.max(0, reserve - chosen.filter(want).length));
    for (const m of missing) {
      const drop = [...chosen].reverse().findIndex((c) => !c.frontier_candidate && c.era !== "past" && c.source !== "extra");
      if (drop === -1) break;
      chosen.splice(chosen.length - 1 - drop, 1);
      chosen.push(m);
    }
  }
  chosen.sort((a, b) => b.score - a.score);
  return { topic: col.topic, ranked_at: new Date(now).toISOString(), considered: col.items.length, dropped_irrelevant: col.items.length - onTopic.length, items: chosen };
}

async function main() {
  const args = Bun.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(await Bun.file(new URL("./Rank.help.md", import.meta.url)).text());
    process.exit(args.length ? 0 : 1);
  }
  const inputs: string[] = [];
  let out = "", top = 100;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--top") top = Number(args[++i]);
    else if (args[i] === "--out") out = args[++i];
    else inputs.push(args[i]);
  }
  // Several collections (e.g. the wide sweep plus a Research handoff) merge into one; first URL wins.
  const cols = await Promise.all(inputs.map(async (p) => JSON.parse(await Bun.file(p).text()) as Collection));
  const seen = new Set<string>();
  const merged: Collection = { ...cols[0], sources: cols.flatMap((c) => c.sources), items: cols.flatMap((c) => c.items).filter((it) => (seen.has(it.url) ? false : (seen.add(it.url), true))) };
  const result = rank(merged, { top });
  const json = JSON.stringify(result, null, 2);
  const counts = { past: 0, current: 0, frontier: 0 };
  for (const r of result.items) { if (r.era === "past") counts.past++; if (r.era === "current") counts.current++; if (r.frontier_candidate) counts.frontier++; }
  console.error(`\x1b[36m${result.items.length}/${result.considered} kept (${result.dropped_irrelevant} below relevance floor) · past ${counts.past} · current ${counts.current} · frontier candidates ${counts.frontier}\x1b[0m`);
  if (out) await Bun.write(out, json); else console.log(json);
}

if (import.meta.main) await main();
