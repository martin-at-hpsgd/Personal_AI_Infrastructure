/**
 * Vera Output — the public-output record of a person (the receipts skill writes it).
 *
 * Layout, beside the claim ledger:
 *   $VERA_DATA_DIR/people/<slug>/output.jsonl   one row per published item, keyed by canonical URL
 *   $VERA_DATA_DIR/people/<slug>/channels.json  each channel, its collector, how far back it reached
 *
 * Counts are projections computed at read time, never stored. A channel whose full history
 * was not reached is reported as partial before the earliest date it reached; that span is
 * a gap, never zero output.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { invariant } from "../TOOLS/Invariant";
import { personDir } from "./Store";

export const OUTPUT_KINDS = [
  "post", "newsletter", "social", "video", "podcast", "course", "class", "talk", "repo", "release", "book", "paper", "other",
] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

/** Where an item's date came from, strongest first. */
export const DATE_SOURCES = ["platform", "feed", "sitemap", "page", "wayback", "stated"] as const;
export type DateSource = (typeof DATE_SOURCES)[number];

export interface OutputRow {
  id: string;
  person: string;
  kind: OutputKind;
  platform: string;
  url: string;
  title: string;
  /** YYYY-MM-DD */
  published: string;
  date_source: DateSource;
  /** How exact `published` is; absent means day. A month or year date is stored as its first day. */
  precision?: "day" | "month" | "year";
  /** How big the work is: words for text, minutes for audio and video. Absent means not measured. */
  size?: { words?: number; minutes?: number };
  channel: string;
  recorded: string;
}

/** Code activity, which item counts cannot see: yearly GitHub contributions and Deeds over top repos. */
export interface Activity {
  github?: {
    login: string;
    fetched: string;
    years: Record<string, { commits: number; private: number; prs: number; issues: number; reviews: number; newRepos: number }>;
  };
  deeds?: {
    since: string;
    fetched: string;
    /** The names counted as this person among Deeds' per-author rows. */
    authors?: string[];
    repos: { repo: string; ok: boolean; commits?: number; error?: string; private?: boolean; unjudged?: number }[];
    /** Repos left out on purpose, each with the reason (a release mirror of a repo that is counted). */
    skipped?: { repo: string; reason: string }[];
    years: Record<string, { cap: number; fix: number; tend: number; unjudged?: number }>;
  };
}

export interface Channel {
  id: string;
  collector: string;
  /** Collector target: a site URL, a handle, a channel id. */
  target: string;
  kind: OutputKind;
  platform: string;
  /** Earliest published date the collector reached, YYYY-MM-DD. */
  earliest?: string;
  /** True only when the collector reached the start of the channel's history. */
  complete: boolean;
  last_collected?: string;
  note?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|source$|s$|t$)/.test(k)) u.searchParams.delete(k);
    const host = u.hostname.replace(/^www\./, "").replace(/^mobile\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "") || "/";
    const q = u.searchParams.toString();
    return `${host}${path}${q ? `?${q}` : ""}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export function outputId(url: string): string {
  return `vo_${createHash("sha256").update(canonicalUrl(url)).digest("hex").slice(0, 12)}`;
}

export function validateOutput(row: Partial<OutputRow>): string[] {
  const errs: string[] = [];
  for (const f of ["id", "person", "kind", "platform", "url", "published", "date_source", "channel", "recorded"] as const) {
    if (row[f] === undefined || row[f] === "") errs.push(`missing ${f}`);
  }
  if (row.kind && !OUTPUT_KINDS.includes(row.kind)) errs.push(`unknown kind ${row.kind}`);
  if (row.date_source && !DATE_SOURCES.includes(row.date_source)) errs.push(`unknown date_source ${row.date_source}`);
  if (row.published && !DATE_RE.test(row.published)) errs.push(`published must be YYYY-MM-DD, got ${row.published}`);
  if (row.url && !/^https?:\/\//.test(row.url)) errs.push(`url must be http(s)`);
  if (row.id && row.url && row.id !== outputId(row.url)) errs.push(`id does not match url`);
  if (row.precision && !["day", "month", "year"].includes(row.precision)) errs.push(`unknown precision ${row.precision}`);
  for (const [k, v] of Object.entries(row.size ?? {})) if (typeof v !== "number" || !Number.isFinite(v) || v < 0) errs.push(`size.${k} must be a non-negative number`);
  return errs;
}

export function outputPath(slug: string): string {
  return join(personDir(slug), "output.jsonl");
}
export function channelsPath(slug: string): string {
  return join(personDir(slug), "channels.json");
}

export function readOutput(slug: string): OutputRow[] {
  const p = outputPath(slug);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as OutputRow);
}

/** Appends rows whose canonical URL is not already in the record. Returns how many were added. */
export function addOutput(slug: string, rows: OutputRow[]): number {
  const existing = new Set(readOutput(slug).map((r) => r.id));
  const fresh: OutputRow[] = [];
  for (const r of rows) {
    invariant(r.person === slug, `output row person ${r.person} != ${slug}`);
    const errs = validateOutput(r);
    invariant(errs.length === 0, `invalid output row ${r.url}: ${errs.join("; ")}`);
    if (existing.has(r.id)) continue;
    existing.add(r.id);
    fresh.push(r);
  }
  if (fresh.length === 0) return 0;
  mkdirSync(personDir(slug), { recursive: true });
  appendFileSync(outputPath(slug), fresh.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return fresh.length;
}

/**
 * Replaces a Wayback first-capture date with a date the source itself states, for items
 * already in the record. The item stays; only its date gets more exact. Returns how many changed.
 */
export function refineDates(slug: string, rows: OutputRow[]): number {
  const better = new Map(rows.filter((r) => r.date_source !== "wayback" && r.date_source !== "stated").map((r) => [r.id, r]));
  const current = readOutput(slug);
  let changed = 0;
  for (const r of current) {
    const b = better.get(r.id);
    if (r.date_source !== "wayback" || !b) continue;
    invariant(validateOutput({ ...r, published: b.published, date_source: b.date_source }).length === 0, `refined date invalid for ${r.url}`);
    r.published = b.published;
    r.date_source = b.date_source;
    if (b.precision) r.precision = b.precision; else delete r.precision;
    changed++;
  }
  if (changed) writeFileSync(outputPath(slug), current.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return changed;
}

const COLLECTOR_HOSTS: Record<string, RegExp> = {
  youtube: /(^|\.)youtube\.com$/, github: /(^|\.)github\.com$/, x: /(^|\.)(x|twitter)\.com$/, substack: /\.substack\.com$|^[^/]+$/,
};

/**
 * Rows whose host cannot have come from their channel: a platform host (YouTube, GitHub, X)
 * filed under another collector, or a platform collector holding a foreign host. Empty means clean.
 */
export function auditOutput(slug: string): OutputRow[] {
  const channels = new Map(readChannels(slug).map((c) => [c.id, c]));
  return readOutput(slug).filter((r) => {
    const c = channels.get(r.channel);
    if (!c) return true;
    if (c.collector === "manual") return false;
    let host = "";
    try { host = new URL(r.url).hostname.replace(/^www\./, ""); } catch { return true; }
    for (const [col, re] of Object.entries(COLLECTOR_HOSTS)) {
      if (col === "substack") continue;
      if (re.test(host) && c.collector !== col) return true;
      if (c.collector === col && !re.test(host)) return true;
    }
    if (c.collector === "sitemap" || c.collector === "feed" || c.collector === "wayback") {
      const t = (() => { try { return new URL(c.target.startsWith("http") ? c.target : `https://${c.target}`).hostname.replace(/^www\./, ""); } catch { return ""; } })();
      // A site's own sitemap lists its own host; hosted feeds (podcasts) may point anywhere.
      if (c.collector !== "feed" && t && host !== t && !host.endsWith(`.${t}`) && !t.endsWith(`.${host}`)) return true;
    }
    return false;
  });
}

/** Sets sizes on rows already in the record (keyed by row id). Returns how many changed. */
export function setSizes(slug: string, sizes: Map<string, { words?: number; minutes?: number }>): number {
  if (sizes.size === 0) return 0;
  const current = readOutput(slug);
  let changed = 0;
  for (const r of current) {
    const s = sizes.get(r.id);
    if (!s) continue;
    const next = { ...(r.size ?? {}), ...s };
    invariant(validateOutput({ ...r, size: next }).length === 0, `invalid size for ${r.url}`);
    if (JSON.stringify(next) === JSON.stringify(r.size ?? {})) continue;
    r.size = next;
    changed++;
  }
  if (changed) writeFileSync(outputPath(slug), current.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return changed;
}

export function activityPath(slug: string): string {
  return join(personDir(slug), "activity.json");
}
export function readActivity(slug: string): Activity {
  const p = activityPath(slug);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Activity) : {};
}
export function writeActivity(slug: string, a: Activity): void {
  for (const [y, v] of Object.entries(a.github?.years ?? {})) {
    invariant(/^\d{4}$/.test(y), `activity year ${y} is not YYYY`);
    invariant(Object.values(v).every((n) => Number.isInteger(n) && n >= 0), `activity ${y} has a non-count value`);
  }
  for (const r of a.deeds?.repos ?? []) invariant(/^[\w.-]+\/[\w.-]+$/.test(r.repo), `deeds repo ${r.repo} is not owner/name`);
  mkdirSync(personDir(slug), { recursive: true });
  writeFileSync(activityPath(slug), JSON.stringify(a, null, 2) + "\n");
}

/** Total GitHub contributions in a year: public commits, PRs, issues, reviews, and the private count GitHub shows. */
export function contributions(v: { commits: number; private: number; prs: number; issues: number; reviews: number }): number {
  return v.commits + v.private + v.prs + v.issues + v.reviews;
}

export function readChannels(slug: string): Channel[] {
  const p = channelsPath(slug);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf8")) as Channel[];
}

export function writeChannels(slug: string, channels: Channel[]): void {
  const ids = new Set<string>();
  for (const c of channels) {
    invariant(!ids.has(c.id), `duplicate channel id ${c.id}`);
    ids.add(c.id);
    invariant(OUTPUT_KINDS.includes(c.kind), `channel ${c.id} has unknown kind ${c.kind}`);
    invariant(!c.earliest || DATE_RE.test(c.earliest), `channel ${c.id} earliest must be YYYY-MM-DD`);
  }
  mkdirSync(personDir(slug), { recursive: true });
  writeFileSync(channelsPath(slug), JSON.stringify(channels, null, 2) + "\n");
}

export function makeRow(
  slug: string,
  channel: Pick<Channel, "id" | "kind" | "platform">,
  item: { url: string; title: string; published: string; date_source: DateSource; kind?: OutputKind; precision?: "day" | "month" | "year"; size?: { words?: number; minutes?: number } },
  recorded = new Date().toISOString().slice(0, 10),
): OutputRow {
  return {
    id: outputId(item.url),
    person: slug,
    kind: item.kind ?? channel.kind,
    platform: channel.platform,
    url: item.url,
    title: item.title.replace(/\s+/g, " ").trim().slice(0, 300),
    published: item.published.slice(0, 10),
    date_source: item.date_source,
    ...(item.precision && item.precision !== "day" ? { precision: item.precision } : {}),
    ...(item.size && Object.keys(item.size).length ? { size: item.size } : {}),
    channel: channel.id,
    recorded,
  };
}

// ── projections ──────────────────────────────────────────────────────────────

function lastSegment(url: string): string {
  try { return new URL(url).pathname.replace(/\/+$/, "").split("/").pop()!.toLowerCase().replace(/\.(html?|php)$/, ""); } catch { return ""; }
}
const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
const dayGap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/**
 * One row per distinct work. A post cross-published on two sites (a blog mirrored into a
 * newsletter platform, a repost on a company blog) counts once, at its earliest date. Two rows
 * are the same work when they sit in different channels and share a URL slug of 12+ characters,
 * or share a normalized title within 7 days. Repos and social posts are never merged.
 */
export function distinctWorks(rows: OutputRow[]): OutputRow[] {
  const sorted = [...rows].sort((a, b) => a.published.localeCompare(b.published));
  const kept: OutputRow[] = [];
  const bySlug = new Map<string, OutputRow>();
  const byTitle = new Map<string, OutputRow[]>();
  for (const r of sorted) {
    if (r.kind === "repo" || r.kind === "social") { kept.push(r); continue; }
    const slug = lastSegment(r.url);
    const title = normTitle(r.title);
    const slugHit = slug.length >= 12 ? bySlug.get(slug) : undefined;
    // Audio and video of one work are often published far apart (a podcast feed mirroring a channel), so that pair merges at any gap.
    const av = (k: OutputRow) => k.kind === "video" || k.kind === "podcast";
    const titleHit = title.length >= 12 ? byTitle.get(title)?.find((k) => dayGap(k.published, r.published) <= 7 || (av(k) && av(r) && k.kind !== r.kind)) : undefined;
    const hit = [slugHit, titleHit].find((k) => k && k.channel !== r.channel);
    if (hit) {
      // The merged copy may carry what the kept one lacks (a post's words, its episode's minutes): keep the larger of each.
      if (r.size) {
        const i = kept.indexOf(hit);
        const s = { ...(hit.size ?? {}) };
        if ((r.size.words ?? 0) > (s.words ?? 0)) s.words = r.size.words;
        if ((r.size.minutes ?? 0) > (s.minutes ?? 0)) s.minutes = r.size.minutes;
        const merged = { ...hit, size: s };
        kept[i] = merged;
        if (bySlug.get(lastSegment(hit.url)) === hit) bySlug.set(lastSegment(hit.url), merged);
        const t = normTitle(hit.title);
        if (byTitle.has(t)) byTitle.set(t, byTitle.get(t)!.map((k) => (k === hit ? merged : k)));
      }
      continue;
    }
    kept.push(r);
    if (slug.length >= 12 && !bySlug.has(slug)) bySlug.set(slug, r);
    if (title.length >= 12) byTitle.set(title, [...(byTitle.get(title) ?? []), r]);
  }
  return kept;
}

export interface TimelineBucket { period: string; total: number; words: number; minutes: number; byKind: Partial<Record<OutputKind, number>> }

export function timeline(rows: OutputRow[], by: "month" | "year" = "year"): TimelineBucket[] {
  const len = by === "year" ? 4 : 7;
  const map = new Map<string, TimelineBucket>();
  for (const r of rows) {
    const period = r.published.slice(0, len);
    const b = map.get(period) ?? { period, total: 0, words: 0, minutes: 0, byKind: {} };
    b.total++;
    b.words += r.size?.words ?? 0;
    b.minutes += r.size?.minutes ?? 0;
    b.byKind[r.kind] = (b.byKind[r.kind] ?? 0) + 1;
    map.set(period, b);
  }
  return [...map.values()].sort((a, b) => a.period.localeCompare(b.period));
}

function monthsBetween(a: string, b: string): number {
  const [ay, am] = [Number(a.slice(0, 4)), Number(a.slice(5, 7))];
  const [by, bm] = [Number(b.slice(0, 4)), Number(b.slice(5, 7))];
  return Math.max(1, (by - ay) * 12 + (bm - am) + 1);
}

export interface RateWindow { from: string; to: string; months: number; items: number; perMonth: number; wordsPerMonth: number; minutesPerMonth: number }
export interface KindCompare { kind: OutputKind | "all"; before: RateWindow; after: RateWindow; ratio: number | null; partialBefore: boolean }

/**
 * Monthly rate per kind before and after a pivot date. The "before" window starts at the
 * earliest item of that kind (or `since`); a kind whose channels are partial before the
 * pivot is flagged, because missing history there would understate the before-rate.
 */
export function compareAt(rows: OutputRow[], channels: Channel[], pivot: string, now = new Date().toISOString().slice(0, 10), since?: string): KindCompare[] {
  invariant(DATE_RE.test(pivot), `pivot must be YYYY-MM-DD`);
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  const out: KindCompare[] = [];
  const one = (kind: OutputKind | "all", list: OutputRow[]): KindCompare => {
    const dates = list.map((r) => r.published).sort();
    const start = since ?? dates[0] ?? pivot;
    const inBefore = list.filter((r) => r.published >= start && r.published < pivot);
    const inAfter = list.filter((r) => r.published >= pivot && r.published <= now);
    const bm = start < pivot ? monthsBetween(start, pivot) - 1 || 1 : 0;
    const am = monthsBetween(pivot, now);
    const sum = (rs: OutputRow[], k: "words" | "minutes") => rs.reduce((a, r) => a + (r.size?.[k] ?? 0), 0);
    const rate = (n: number, m: number) => (m ? +(n / m).toFixed(2) : 0);
    const before = { from: start, to: pivot, months: bm, items: inBefore.length, perMonth: rate(inBefore.length, bm), wordsPerMonth: Math.round(rate(sum(inBefore, "words"), bm)), minutesPerMonth: Math.round(rate(sum(inBefore, "minutes"), bm)) };
    const after = { from: pivot, to: now, months: am, items: inAfter.length, perMonth: rate(inAfter.length, am), wordsPerMonth: Math.round(rate(sum(inAfter, "words"), am)), minutesPerMonth: Math.round(rate(sum(inAfter, "minutes"), am)) };
    // Only a partial channel whose collected history starts inside the before-window understates
    // it. A channel with no rows (an X post count) or a research listing is a gap on both sides.
    const firstByChannel = new Map<string, string>();
    for (const r of list) if (!firstByChannel.has(r.channel) || r.published < firstByChannel.get(r.channel)!) firstByChannel.set(r.channel, r.published);
    const partialBefore = channels.some((c) => c.collector !== "manual" && !c.complete && firstByChannel.has(c.id) && firstByChannel.get(c.id)! > start && firstByChannel.get(c.id)! < pivot);
    return { kind, before, after, ratio: before.perMonth ? +(after.perMonth / before.perMonth).toFixed(2) : null, partialBefore };
  };
  out.push(one("all", rows));
  for (const k of kinds) out.push(one(k as OutputKind, rows.filter((r) => r.kind === k)));
  return out;
}

/** Code activity per month before and after a pivot, from yearly GitHub contribution totals. */
export function compareCode(a: Activity, pivot: string, now = new Date().toISOString().slice(0, 10), since?: string): { before: number; after: number; ratio: number | null; beforeYears: string; afterYears: string } | undefined {
  const years = a.github?.years;
  if (!years || !Object.keys(years).length) return undefined;
  // Yearly totals, so the windows are whole years: before = years ending before the pivot year,
  // after = the pivot year onward, with the current year prorated by months elapsed.
  const py = Number(pivot.slice(0, 4)), ny = Number(now.slice(0, 4)), nm = Number(now.slice(5, 7));
  const sy = since ? Number(since.slice(0, 4)) : Math.min(...Object.keys(years).map(Number));
  let b = 0, bm = 0, f = 0, fm = 0;
  for (const [y, v] of Object.entries(years)) {
    const yr = Number(y), n = contributions(v);
    if (yr < sy || yr > ny) continue;
    if (yr < py) { b += n; bm += 12; } else { f += n; fm += yr === ny ? nm : 12; }
  }
  const before = bm ? +(b / bm).toFixed(1) : 0, after = fm ? +(f / fm).toFixed(1) : 0;
  return { before, after, ratio: before ? +(after / before).toFixed(1) : null, beforeYears: `${sy}–${py - 1}`, afterYears: `${py}–${ny}` };
}

/** What the record can see for this person, and what it cannot. A verdict may only rest on the first list. */
export function coverage(slug: string): { covers: string[]; blind: string[] } {
  const rows = readOutput(slug), ch = readChannels(slug), a = readActivity(slug);
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  const covers: string[] = [...kinds];
  if (a.github) covers.push("GitHub contributions (public commits, PRs, issues, reviews, private count)");
  if (a.deeds) covers.push(`Deeds caps on the ${a.deeds.repos.filter((r) => r.ok).length} owned public repos with the most of their commits since ${a.deeds.since} (their own commits only)`);
  const sized = rows.filter((r) => r.size?.words || r.size?.minutes).length;
  if (sized) covers.push(`volume on ${sized} of ${rows.length} rows (words, minutes)`);
  const blind = ["private products and sites", "paid or login-walled work"];
  if (ch.some((c) => c.collector === "x")) blind.unshift("X posts (counted in total only, not dated)");
  if (!a.github) blind.unshift("code activity");
  // GitHub reports private work only when the account opts in, so all zeros means hidden, not none.
  else if (Object.values(a.github.years).every((v) => v.private === 0)) blind.unshift("private GitHub contributions (the account does not show them)");
  for (const c of ch) if (c.collector !== "manual" && c.collector !== "x" && !rows.some((r) => r.channel === c.id)) blind.push(`${c.platform} ${c.target} (nothing collected)`);
  return { covers, blind };
}

/** The Output section of a Vera profile. Empty string when the person has no record. */
export function renderOutputSection(slug: string): string {
  const all = readOutput(slug);
  if (all.length === 0) return "";
  const rows = distinctWorks(all);
  const channels = readChannels(slug);
  const years = timeline(rows, "year");
  const kinds = [...new Set(rows.map((r) => r.kind))].sort() as OutputKind[];
  const first = [...rows].sort((a, b) => a.published.localeCompare(b.published))[0]!;
  const L: string[] = [];
  L.push(`## Output`);
  L.push("");
  L.push(`> Generated from ${all.length} URLs in output.jsonl (the receipts record): ${rows.length} distinct works once cross-posts are merged. First item: ${first.published} · ${first.title} — ${first.url}`);
  L.push("");
  L.push(`| Kind | Items | First | Latest |`);
  L.push(`|---|---|---|---|`);
  for (const k of kinds) {
    const ds = rows.filter((r) => r.kind === k).map((r) => r.published).sort();
    L.push(`| ${k} | ${ds.length} | ${ds[0]} | ${ds[ds.length - 1]} |`);
  }
  L.push("");
  L.push("```");
  const max = Math.max(...years.map((y) => y.total));
  for (const y of years) {
    const bar = "█".repeat(Math.max(1, Math.round((y.total / max) * 40)));
    const mix = kinds.filter((k) => y.byKind[k]).map((k) => `${k} ${y.byKind[k]}`).join(", ");
    const vol = [y.words ? `${Math.round(y.words / 1000)}k words` : "", y.minutes ? `${Math.round(y.minutes / 60)} h` : ""].filter(Boolean).join(", ");
    L.push(`${y.period}  ${bar} ${y.total}  (${mix})${vol ? `  · ${vol}` : ""}`);
  }
  L.push("```");
  L.push("");
  const act = readActivity(slug);
  if (act.github) {
    L.push(`### Code`);
    L.push("");
    L.push(`> GitHub contributions for ${act.github.login}, fetched ${act.github.fetched}: public commits, PRs, issues and reviews, plus the private contribution count GitHub reports.${act.deeds ? ` Deeds caps, fixes and tends on ${act.deeds.repos.filter((r) => r.ok).map((r) => (r.private ? `${r.repo} (private, named by hand)` : r.repo)).join(", ")} since ${act.deeds.since}, the owned public repos with the most of their commits. Only caps on commits authored by ${(act.deeds.authors ?? [act.github.login]).filter(Boolean).join(" or ")} count; other contributors' work in those repos is left out.${act.deeds.repos.some((r) => r.unjudged) ? ` ${act.deeds.repos.reduce((n, r) => n + (r.unjudged ?? 0), 0)} commits on days Deeds could not finish are left out, so these are a lower bound.` : ""}${act.deeds.skipped?.length ? ` Left out: ${act.deeds.skipped.map((k) => `${k.repo} (${k.reason})`).join("; ")}.` : ""}${act.deeds.repos.some((r) => r.private) ? " A private repo is visible only for this person, so across people compare public repos only." : ""}` : ""}`);
    L.push("");
    L.push(`| Year | Contributions | Public commits | Private | PRs | New repos |${act.deeds ? " Caps | Fixes |" : ""}`);
    L.push(`|---|---|---|---|---|---|${act.deeds ? "---|---|" : ""}`);
    for (const [y, v] of Object.entries(act.github.years).sort()) {
      const d = act.deeds?.years[y];
      L.push(`| ${y} | ${contributions(v)} | ${v.commits} | ${v.private} | ${v.prs} | ${v.newRepos} |${act.deeds ? ` ${d?.cap ?? "—"} | ${d?.fix ?? "—"} |` : ""}`);
    }
    L.push("");
  }
  const cov = coverage(slug);
  L.push(`> Covers: ${cov.covers.join("; ")}. Cannot see: ${cov.blind.join("; ")}.`);
  L.push("");
  if (channels.length) {
    L.push(`| Channel | Collector | Reached back to | Full history |`);
    L.push(`|---|---|---|---|`);
    for (const c of channels) L.push(`| ${c.platform} · ${c.target} | ${c.collector} | ${c.earliest ?? "—"} | ${c.complete ? "yes" : "partial"}${c.note ? ` (${c.note})` : ""} |`);
    L.push("");
    const partial = channels.filter((c) => !c.complete);
    if (partial.length) L.push(`> Partial channels: counts before each one's earliest date are a gap in the record, not zero output.`), L.push("");
  }
  return L.join("\n");
}
