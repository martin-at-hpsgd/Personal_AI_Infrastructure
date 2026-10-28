/**
 * Source loading: turn a post.json, a transcript.json, or a markdown file into
 * one normalized SourceDoc the prompts and the lints read.
 *
 * Optional VideoEssay and Video source producers are NOT in the public release payload; these input formats work without them.
 *  - post.json   — VideoEssay Source/post.json: {title,url,slug,links:[{label,url,p}],paragraphs:[{id,text,heading?}]}
 *  - transcript  — Video Transcript.ts --format json ([{start,end,text}]) or {segments|paragraphs:[{start,end,text,speaker?}], speakers?, links?}
 *  - markdown    — a post body; paragraphs and list items become p1…pn, a heading belongs to the block after it
 */

import { readFileSync } from "fs";
import type { SourceKind, Speaker, Span, Unit } from "./schema";

export interface SourceBlock { id: string; text: string; heading?: string; start?: number; end?: number; speaker?: string }
export interface SourceLink { label: string; url: string; p?: string }
export interface SourceDoc {
  kind: SourceKind;
  path: string;
  title?: string;
  url?: string;
  blocks: SourceBlock[];
  links: SourceLink[];
  speakers: Speaker[];
  duration?: number;
}

export class SourceError extends Error {
  constructor(message: string) { super(message); this.name = "SourceError"; }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function loadSource(path: string): SourceDoc {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (e) { throw new SourceError(`cannot read source ${path}: ${(e as Error).message}`); }
  if (/\.(md|markdown|txt)$/i.test(path)) return parseMarkdown(path, raw);
  let json: unknown;
  try { json = JSON.parse(raw); } catch (e) { throw new SourceError(`source ${path} is neither markdown nor valid JSON: ${(e as Error).message}`); }
  if (isObj(json) && Array.isArray(json.paragraphs) && json.paragraphs.every(p => isObj(p) && str(p.id) && typeof p.text === "string")) return parsePost(path, json);
  return parseTranscript(path, json);
}

export function parsePost(path: string, j: Record<string, unknown>): SourceDoc {
  const paragraphs = j.paragraphs as Record<string, unknown>[];
  if (paragraphs.length === 0) throw new SourceError(`post ${path} has no paragraphs`);
  const seen = new Set<string>();
  const blocks: SourceBlock[] = paragraphs.map(p => {
    const id = p.id as string;
    if (seen.has(id)) throw new SourceError(`post ${path}: duplicate paragraph id ${id}`);
    seen.add(id);
    return { id, text: String(p.text), ...(str(p.heading) ? { heading: p.heading as string } : {}) };
  });
  const links: SourceLink[] = Array.isArray(j.links)
    ? j.links.filter(isObj).filter(l => str(l.url)).map(l => ({ label: str(l.label) ?? "", url: l.url as string, ...(str(l.p) ? { p: l.p as string } : {}) }))
    : [];
  return { kind: "post", path, title: str(j.title), url: str(j.url), blocks, links, speakers: [] };
}

export function parseTranscript(path: string, j: unknown): SourceDoc {
  const segs = Array.isArray(j) ? j : isObj(j) ? (Array.isArray(j.segments) ? j.segments : Array.isArray(j.paragraphs) ? j.paragraphs : null) : null;
  if (!segs || segs.length === 0) throw new SourceError(`source ${path}: expected a post.json (paragraphs with ids) or a transcript (segments with start/end/text)`);
  const blocks: SourceBlock[] = [];
  const speakerNames = new Map<string, string>();
  segs.forEach((s, i) => {
    if (!isObj(s)) throw new SourceError(`transcript ${path}: segment ${i} is not an object`);
    const start = num(s.start), end = num(s.end), text = typeof s.text === "string" ? s.text : undefined;
    if (start === undefined || end === undefined || text === undefined || !(start < end)) throw new SourceError(`transcript ${path}: segment ${i} needs start<end seconds and text`);
    const speaker = str(s.speaker);
    if (speaker) speakerNames.set(slug(speaker), speaker);
    blocks.push({ id: `t${i + 1}`, text, start, end, ...(speaker ? { speaker: slug(speaker) } : {}) });
  });
  const declared = isObj(j) && Array.isArray(j.speakers) ? j.speakers.filter(isObj) : [];
  const speakers: Speaker[] = declared.length
    ? declared.map(s => ({ id: str(s.id) ?? slug(String(s.name ?? "")), name: str(s.name) ?? String(s.id), ...(str(s.role) ? { role: s.role as string } : {}) }))
    : [...speakerNames].map(([id, name]) => ({ id, name }));
  const title = isObj(j) ? str(j.title) : undefined;
  const url = isObj(j) ? str(j.url) : undefined;
  // Resolved references (Video Enhance resolves every named post, book, site or video before directing): the only URLs an insert may use.
  const links: SourceLink[] = isObj(j) && Array.isArray(j.links)
    ? j.links.filter(isObj).filter(l => str(l.url)).map(l => ({ label: str(l.label) ?? "", url: l.url as string }))
    : [];
  return { kind: "transcript", path, title, url, blocks, links, speakers, duration: Math.max(...blocks.map(b => b.end!)) };
}

export function parseMarkdown(path: string, raw: string): SourceDoc {
  let body = raw;
  let title: string | undefined, url: string | undefined;
  const fm = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = body.slice(fm[0].length);
    title = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1];
    url = fm[1].match(/^(?:url|canonical):\s*["']?(\S+?)["']?\s*$/m)?.[1];
  }
  const blocks: SourceBlock[] = [];
  const links: SourceLink[] = [];
  let heading: string | undefined;
  let para: string[] = [];
  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    const id = `p${blocks.length + 1}`;
    for (const m of t.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) links.push({ label: m[1], url: m[2], p: id });
    blocks.push({ id, text: t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1"), ...(heading ? { heading } : {}) });
    heading = undefined;
  };
  const flush = () => { push(para.join(" ")); para = []; };
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      push(code.join("\n"));
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      if (h[1].length === 1 && !title && blocks.length === 0) title = h[2].trim();
      else heading = h[2].trim();
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) { flush(); push(line.replace(/^\s*([-*+]|\d+\.)\s+/, "")); continue; }
    if (!line.trim()) { flush(); continue; }
    para.push(line.trim());
  }
  flush();
  if (blocks.length === 0) throw new SourceError(`markdown ${path} has no body text`);
  return { kind: "post", path, title, url, blocks, links, speakers: [] };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "speaker";
}

/** The source as the model reads it: one line per block, ids first, headings and speakers marked. */
export function renderSourceForPrompt(doc: SourceDoc): string {
  const out: string[] = [];
  if (doc.title) out.push(`# ${doc.title}`);
  if (doc.url) out.push(`Source URL: ${doc.url}`);
  if (doc.speakers.length) out.push(`Speakers: ${doc.speakers.map(s => `${s.id} = ${s.name}${s.role ? ` (${s.role})` : ""}`).join("; ")}`);
  out.push("");
  for (const b of doc.blocks) {
    if (b.heading) out.push(`## ${b.heading}`);
    const time = b.start !== undefined && b.end !== undefined ? ` ${fmtTime(b.start)}–${fmtTime(b.end)}` : "";
    const who = b.speaker ? ` ${b.speaker}:` : "";
    out.push(`[${b.id}${time}]${who} ${b.text}`);
  }
  if (doc.links.length) {
    out.push("", "Links in the source:");
    for (const l of doc.links) out.push(`- ${l.label || "(link)"} — ${l.url}${l.p ? ` (in ${l.p})` : ""}`);
  }
  return out.join("\n");
}

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
}

/** Every URL the source itself names — the only URLs a capture insert may point at without a flag. */
export function knownUrls(doc: SourceDoc): Set<string> {
  const norm = (u: string) => u.replace(/\/+$/, "").replace(/^http:/, "https:");
  return new Set([doc.url, ...doc.links.map(l => l.url)].filter((u): u is string => !!u).map(norm));
}
export function urlIsKnown(doc: SourceDoc, url: string): boolean {
  return knownUrls(doc).has(url.replace(/\/+$/, "").replace(/^http:/, "https:"));
}

/** Normalize for verbatim checks: case, quotes, dashes, whitespace, trailing punctuation. */
export function normText(s: string): string {
  return s.toLowerCase()
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/[^\p{L}\p{N}'%$\- ]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function sourceText(doc: SourceDoc): string {
  return normText(doc.blocks.map(b => `${b.heading ?? ""} ${b.text}`).join(" "));
}

// ─────────────────────────────────────────────────────────────── timeline

export interface TimelineWord { w: string; s: number; e: number; p?: string }
export interface Timeline { total: number; beats: { id: string; start: number; end: number; words?: TimelineWord[] }[] }

export function loadTimeline(path: string): Timeline {
  let j: unknown;
  try { j = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new SourceError(`cannot read timeline ${path}: ${(e as Error).message}`); }
  if (!isObj(j) || !Array.isArray(j.beats) || num(j.total) === undefined) throw new SourceError(`timeline ${path} must be {total, beats:[{id,start,end,words?}]}`);
  for (const b of j.beats) if (!isObj(b) || num(b.start) === undefined || num(b.end) === undefined) throw new SourceError(`timeline ${path}: beat without start/end`);
  return j as unknown as Timeline;
}

/**
 * Seconds each post unit occupies in a voice timeline, from the aligned words'
 * paragraph ids. A unit whose paragraphs carry no aligned words gets no span.
 */
export function unitSpansFromTimeline(units: Unit[], tl: Timeline): Map<string, Span> {
  const byP = new Map<string, Span>();
  for (const b of tl.beats) for (const w of b.words ?? []) {
    if (!w.p) continue;
    const cur = byP.get(w.p);
    byP.set(w.p, cur ? { start: Math.min(cur.start, w.s), end: Math.max(cur.end, w.e) } : { start: w.s, end: w.e });
  }
  const out = new Map<string, Span>();
  for (const u of units) {
    if (!("paragraphs" in u.anchor)) { out.set(u.id, (u.anchor as { span: Span }).span); continue; }
    const spans = u.anchor.paragraphs.map(p => byP.get(p)).filter((s): s is Span => !!s);
    if (spans.length) out.set(u.id, { start: Math.min(...spans.map(s => s.start)), end: Math.max(...spans.map(s => s.end)) });
  }
  return out;
}
