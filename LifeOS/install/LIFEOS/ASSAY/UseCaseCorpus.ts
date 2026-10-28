#!/usr/bin/env bun
/**
 * UseCaseCorpus.ts — the labelled corpus for the use-case engine bake-off (Clef bake-off ISA, F1).
 *
 * Every case is a real artifact we made (a published post, a header or thumbnail, an art draft,
 * a video render) labelled accept or reject by the principal's own recorded verdict. No label
 * ever comes from a model's judgment of quality. Four label sources, and only these four:
 *
 *   errata        Errata rows with source "principal" that name a live file (rule below)
 *   calibrate     Calibrate like/dislike labels (the frozen bytes he rated)
 *   artdirection  ArtDirection verdicts: >= 7 accept, <= 4 reject, 5-6 dropped
 *   published     posts with status published in the last 12 months, and their post-specific
 *                 thumbnails: publication counts as approval (principal, 2026-10-10)
 *
 * Errata rule (deterministic, every clause required):
 *   1. The row is the principal's own words: source "principal", and the complaint is not a
 *      delivered Tex transcript or an agent hand-back.
 *   2. The label comes from the row: kind "praise" or rating >= 7 is accept; kind correction,
 *      complaint or bug (rating null or <= 4) is reject; anything else is dropped.
 *   3. The file was delivered to him: named in the complaint or the attachments, or in
 *      context.doing by a step that put it in front of him: a non-empty `SendUserFile:`, `open`,
 *      `qlmanage -p`, `share`, `--image`. `Read:` is the model reading a file and never counts.
 *      A path that appears as the output of a capture command anywhere in the row is a capture
 *      and is dropped. When a row shows several files, a file is kept only when his words single
 *      it out by name; one complaint never stamps a verdict on every file in the row.
 *   4. The complaint names the kind of thing being judged: an image or video word for media, a
 *      prose word (with no image word) for text. "It's been hours" judges the process, not the file.
 *   5. Text cases are writing (blog, draft, newsletter, essay, social, story paths), never code,
 *      config, ISAs, docs or skill files.
 *   6. The file still exists and was last modified at or before the verdict, so the bytes on
 *      disk are the bytes he judged. A file edited after the verdict is dropped.
 *
 * Anti (ISC-19): no image or video case is a screenshot, screen recording, browser capture,
 * dashboard or UI page. Two filters, both applied by build and enforced by validate:
 * `isCaptureLike` reads the path, and the content-review ledger (usecase-content-review.jsonl,
 * keyed by sha256) records what the pixels show. Media with no review, or reviewed as a capture,
 * never enters the corpus.
 *
 * Usage:
 *   bun LIFEOS/ASSAY/UseCaseCorpus.ts build [--verbose]   rebuild the corpus file from the four sources
 *   bun LIFEOS/ASSAY/UseCaseCorpus.ts validate             fields, sources, files, hashes, capture filter
 *   bun LIFEOS/ASSAY/UseCaseCorpus.ts stats [--strict]     accept/reject per type; --strict exits 1 below ISC-18
 *
 * Exit codes: 0 ok · 1 validation failed, or --strict and a type is short · 2 usage error
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { lifeosUserDir } from "../TOOLS/LifeosConfig";

// ── Types ───────────────────────────────────────────────────────────────────

export type CaseType = "text" | "image" | "video";
export type CaseLabel = "accept" | "reject";
export type LabelSource = "errata" | "calibrate" | "artdirection" | "published";

export type CorpusCase = {
  id: string;
  type: CaseType;
  artifact: string;
  sha256: string;
  label: CaseLabel;
  source: LabelSource;
  source_ref: string;
  verdict_text: string;
  public: boolean;
  ts: string;
};

/** A labelled file before hashing and de-duplication. */
export type Candidate = Omit<CorpusCase, "id" | "sha256">;
export type Dropped = { source: LabelSource; ref: string; path: string; reason: string };

export const CASE_TYPES: readonly CaseType[] = ["text", "image", "video"];
export const LABELS: readonly CaseLabel[] = ["accept", "reject"];
export const LABEL_SOURCES: readonly LabelSource[] = ["errata", "calibrate", "artdirection", "published"];
/** ISC-18: text and image each need this many accept and reject cases. */
export const MIN_PER_CLASS = 10;
/** Image accepts are capped at this multiple of image rejects (brief: "about 2:1"). */
export const IMAGE_ACCEPT_RATIO_CAP = 2;
export const PUBLISHED_POST_LIMIT = 40;
const PUBLISHED_WINDOW_DAYS = 365;
const MIN_POST_WORDS = 150;

export const CORPUS_PATH = join(lifeosUserDir(), "ASSAY", "usecase-corpus.jsonl");
const ID_PREFIX: Record<CaseType, string> = { text: "txt", image: "img", video: "vid" };
const SOURCE_PRIORITY: Record<LabelSource, number> = { artdirection: 0, calibrate: 1, errata: 2, published: 3 };

const EXT_TYPE: Record<string, CaseType> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image", ".avif": "image",
  ".mp4": "video", ".mov": "video", ".webm": "video",
  ".md": "text", ".mdx": "text", ".html": "text", ".htm": "text", ".txt": "text",
};

export function typeOfPath(p: string): CaseType | null {
  return EXT_TYPE[extname(p).toLowerCase()] ?? null;
}

// ── Anti filter: screenshots and captures (ISC-19) ──────────────────────────

/** Substrings that mark a capture anywhere in the path. */
const CAPTURE_SUBSTRINGS = /screen ?shots?|screen[-_ ]?recording|screencast|capture|interceptor|localhost|dashboard|viewport|browser/;
/** Whole tokens (path split on non-alphanumerics) that mark a capture, QA shot or UI page. */
const CAPTURE_TOKENS = /^(pulse|page|pages|ui|live\d*|qa|verify|verification|before|after|sheet|contact|shot|shots|grab|devtools)$/;

/** True when an image or video path looks like a screenshot, screen/browser capture, dashboard, UI page or QA sheet. */
export function isCaptureLike(p: string): boolean {
  const lower = p.toLowerCase();
  if (CAPTURE_SUBSTRINGS.test(lower)) return true;
  return lower.split(/[^a-z0-9]+/).some((t) => t !== "" && CAPTURE_TOKENS.test(t));
}

// ── Content review: what the pixels show (ISC-19, the manual half) ──────────

/**
 * A path filter cannot see a render built from app captures, so every image and video case also
 * needs a content review keyed by its sha256: someone looked at the pixels (a contact sheet, or
 * sampled frames for video) and recorded whether it is art we produced or a capture. Media with no
 * review never enters the corpus, and media reviewed as a capture is dropped. A changed file has a
 * new sha256 and needs a new review. The ledger is USER data (it names the principal's files), one
 * JSON object per line: { "sha256", "verdict": "art"|"capture", "note", "reviewed_at" }.
 */
export type ContentReview = { verdict: "art" | "capture"; note: string };
export type ReviewLedger = ReadonlyMap<string, ContentReview>;

export const CONTENT_REVIEW_PATH = join(lifeosUserDir(), "ASSAY", "usecase-content-review.jsonl");

/** Read the content-review ledger; a missing ledger is empty (every media case then drops), a malformed line throws. */
export function readContentReview(path: string = CONTENT_REVIEW_PATH): ReviewLedger {
  const out = new Map<string, ContentReview>();
  if (!existsSync(path)) return out;
  readFileSync(path, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let r: { sha256?: unknown; verdict?: unknown; note?: unknown };
    try { r = JSON.parse(line); } catch { throw new Error(`UseCaseCorpus: content review line ${i + 1} is not JSON`); }
    if (typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) throw new Error(`UseCaseCorpus: content review line ${i + 1}: sha256 is not 64 hex characters`);
    if (r.verdict !== "art" && r.verdict !== "capture") throw new Error(`UseCaseCorpus: content review line ${i + 1}: verdict must be art or capture`);
    out.set(r.sha256, { verdict: r.verdict, note: typeof r.note === "string" ? r.note : "" });
  });
  return out;
}

/** Why a media case may not enter the corpus under the content review, or null when it was reviewed as art. */
export function contentReviewBlock(type: CaseType, sha: string, review: ReviewLedger): string | null {
  if (type === "text") return null;
  const r = review.get(sha);
  if (!r) return `${type} not content-reviewed (ISC-19: someone must look at the pixels first)`;
  if (r.verdict === "capture") return `content review found a capture: ${r.note}`;
  return null;
}

// ── ArtDirection threshold ──────────────────────────────────────────────────

/** ArtDirection 0-10 verdict to a label: >= 7 accept, <= 4 reject, otherwise no label. */
export function artDirectionLabel(verdict: number): CaseLabel | null {
  if (typeof verdict !== "number" || !Number.isFinite(verdict)) return null;
  if (verdict >= 7) return "accept";
  if (verdict <= 4) return "reject";
  return null;
}

// ── Errata rule ─────────────────────────────────────────────────────────────

export type ErrataRow = {
  id: string;
  ts: string;
  source?: string;
  kind?: string;
  rating?: number | null;
  complaint?: string;
  attachments?: unknown;
  context?: { doing?: string; cwd?: string } | null;
};

export type FsDeps = {
  home: string;
  exists: (p: string) => boolean;
  mtimeMs: (p: string) => number;
};

const realFs = (): FsDeps => ({ home: homedir(), exists: (p) => existsSync(p), mtimeMs: (p) => statSync(p).mtimeMs });

const MEDIA_WORDS = /\b(image|images|art|artwork|picture|pictures|photo|photos|illustration|thumbnail|thumb|header|diagram|cartoons?|video|videos|film|animation|animations|render|renders|frames?|slides?|fonts?|layout|box|boxes|colou?rs?|design|looks?|ugly|horrible|amateur|beautiful|gorgeous|perfect|prose|narration)\b/i;
const IMAGE_WORDS = /\b(image|images|art|artwork|picture|pictures|photo|photos|illustration|thumbnail|thumb|header image|diagram|cartoons?)\b/i;
const PROSE_WORDS = /\b(prose|writing|wording|words|sentences?|paragraphs?|ai-?isms?|tone|voice|copy|title|headline|subtitle|phrasing|grammar|typos?|links?|terms?|reads?|sounds?)\b/i;
const NON_WRITING_BASENAMES = new Set(["isa.md", "readme.md", "skill.md", "claude.md", "agents.md", "config.md", "changelog.md"]);
const WRITING_SEGMENTS = new Set(["blog", "drafts", "draft", "newsletter", "newsletters", "essay", "essays", "social", "socialpost", "posts", "stories"]);
const PATH_RE = /(?<![\w:/.~-])(?:~\/|\/)[^\s"'`<>|;,()]+?\.(?:png|jpe?g|webp|gif|avif|mp4|mov|webm|mdx?|html?|txt)\b/gi;
const DISPLAY_PREFIX = /(?:\bopen\b[^;&|\n]*|\bqlmanage\s+-p[^;&|\n]*|\bshare\s[^;&|\n]*|--image\s+["']?)$/;
const CAPTURE_COMMAND = /interceptor|VerifyViewport|Capture\.sh|PulseCapture|screencapture|--pixel|\bshot\b|screenshot/i;

/** The principal's own words in a complaint, or null when the row carries none (Tex transcript, agent hand-back). */
export function principalWords(complaint: string | undefined): string | null {
  if (!complaint) return null;
  if (complaint.trimStart().startsWith("## Delivered conversation context")) return null;
  if (/<agent-message\b|\[Subagent hand-back\]/.test(complaint)) return null;
  const words = complaint.replace(/<\/?pasted_content[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return words === "" ? null : words;
}

/** Label from an Errata row: praise or rating >= 7 accept; correction/complaint/bug reject; else none. */
export function errataLabel(row: Pick<ErrataRow, "kind" | "rating">): CaseLabel | null {
  const rating = typeof row.rating === "number" && Number.isFinite(row.rating) ? row.rating : null;
  if (row.kind === "praise" || (rating !== null && rating >= 7)) return "accept";
  if (rating !== null && rating > 4) return null;
  if (row.kind === "correction" || row.kind === "complaint" || row.kind === "bug") return "reject";
  return null;
}

/** Writing the principal judges: blog, draft, newsletter, essay, social or story files, never code, config or docs. */
export function isWritingPath(p: string): boolean {
  if (/\/\.claude\/|\/\.config\/LIFEOS\//.test(p)) return false;
  if (NON_WRITING_BASENAMES.has(basename(p).toLowerCase())) return false;
  return p.split(sep).slice(0, -1).some((seg) => WRITING_SEGMENTS.has(seg.toLowerCase()));
}

function expandHome(p: string, home: string): string {
  return p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

/**
 * Paths a row shows the principal, split into shown paths and paths that a capture command produced.
 * Shown means delivered to him: named in his own words or the attachments, sent with a non-empty
 * `SendUserFile:`, or put on his screen by `open`, `qlmanage -p`, `share` or `--image`. A `Read:` is
 * the model reading a file, never a delivery, so it shows him nothing.
 */
export function namedPaths(row: ErrataRow, home: string): { shown: Set<string>; captured: Set<string> } {
  const shown = new Set<string>();
  const captured = new Set<string>();
  const words = principalWords(row.complaint) ?? "";
  const direct = `${words}\n${JSON.stringify(row.attachments ?? [])}`;
  for (const m of direct.matchAll(PATH_RE)) shown.add(expandHome(m[0], home));
  for (const seg of (row.context?.doing ?? "").split(" · ")) {
    if (/^\s*Read:/.test(seg)) continue;
    const isSend = /^\s*SendUserFile:/.test(seg);
    // The command words decide a capture, never a filename that happens to contain "shot".
    const isCapture = !isSend && CAPTURE_COMMAND.test(seg.replace(PATH_RE, " "));
    for (const m of seg.matchAll(PATH_RE)) {
      const p = expandHome(m[0], home);
      if (isCapture) { captured.add(p); continue; }
      if (isSend || DISPLAY_PREFIX.test(seg.slice(0, m.index ?? 0))) shown.add(p);
    }
  }
  return { shown, captured };
}

/** True when the principal's words single out this file: its basename, or its stem when the stem is distinctive. */
export function singlesOut(words: string, p: string): boolean {
  const lower = words.toLowerCase();
  const base = basename(p).toLowerCase();
  const stem = base.slice(0, base.length - extname(base).length);
  return lower.includes(base) || (stem.length >= 4 && new RegExp(`(?<![\\w-])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(lower));
}

/** Apply the Errata rule to principal rows. Returns labelled candidates plus every drop with its reason. */
export function errataCandidates(rows: ErrataRow[], fs: FsDeps = realFs()): { candidates: Candidate[]; dropped: Dropped[] } {
  const candidates: Candidate[] = [];
  const dropped: Dropped[] = [];
  const ordered = [...rows].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  for (const row of ordered) {
    if (row.source !== "principal") continue;
    const words = principalWords(row.complaint);
    const { shown, captured } = namedPaths(row, fs.home);
    if (shown.size === 0) continue;
    const drop = (path: string, reason: string) => dropped.push({ source: "errata", ref: row.id, path, reason });
    if (words === null) { for (const p of shown) drop(p, "not the principal's own words (transcript or hand-back)"); continue; }
    const label = errataLabel(row);
    if (label === null) { for (const p of shown) drop(p, `kind ${row.kind ?? "none"} / rating ${row.rating ?? "none"} is not a verdict`); continue; }
    const verdictMs = Date.parse(row.ts);
    const several = shown.size > 1;
    for (const p of shown) {
      const type = typeOfPath(p);
      if (type === null) { drop(p, "not a text, image or video file"); continue; }
      if (several && !singlesOut(words, p)) { drop(p, "row shows several files and the complaint does not single this one out"); continue; }
      if (captured.has(p)) { drop(p, "produced by a capture command"); continue; }
      if (type !== "text" && isCaptureLike(p)) { drop(p, "screenshot or capture path"); continue; }
      if (type === "text" && !isWritingPath(p)) { drop(p, "text that is not writing (code, config, ISA, docs or skill)"); continue; }
      const aboutIt = type === "text" ? PROSE_WORDS.test(words) && !IMAGE_WORDS.test(words) : MEDIA_WORDS.test(words);
      if (!aboutIt) { drop(p, `complaint does not judge the ${type}`); continue; }
      if (!fs.exists(p)) { drop(p, "file no longer exists"); continue; }
      if (!Number.isFinite(verdictMs) || fs.mtimeMs(p) > verdictMs) { drop(p, "file modified after the verdict"); continue; }
      candidates.push({ type, artifact: resolve(p), label, source: "errata", source_ref: row.id, verdict_text: words, public: false, ts: new Date(verdictMs).toISOString() });
    }
  }
  return { candidates, dropped };
}

// ── Source readers ──────────────────────────────────────────────────────────

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* a torn line in a ledger is skipped, never guessed at */ }
  }
  return out;
}

export function sha256File(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function readErrataRows(dir: string): ErrataRow[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^errata-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => readJsonl<ErrataRow>(join(dir, f)))
    .filter((r) => typeof r?.id === "string" && typeof r?.ts === "string");
}

type CalibrateLabel = { id: string; artifact: string; source_path?: string; kind?: string; sha256?: string; verdict?: string; note?: string; labeled_at?: string; label_source?: { kind?: string } };

/**
 * The public-text fence. A rated artifact is public (it may go to an outside engine) only when the frozen copy IS the
 * published source: source_path lies under the website's published directory AND its current bytes equal the frozen
 * artifact's bytes. A frozen draft that differs from what was published is private text, whatever its source_path says.
 */
export function isPublicSource(publicDir: string | null, sourcePath: string | undefined, frozenArtifact: string, hash: (p: string) => string = sha256File): boolean {
  if (!publicDir || !sourcePath) return false;
  const source = resolve(sourcePath);
  if (!source.startsWith(publicDir) || !existsSync(source)) return false;
  try {
    return hash(source) === hash(frozenArtifact);
  } catch {
    return false;
  }
}

function calibrateCandidates(targetsDir: string, websiteDir: string | null): { candidates: Candidate[]; dropped: Dropped[] } {
  const candidates: Candidate[] = [];
  const dropped: Dropped[] = [];
  if (!existsSync(targetsDir)) return { candidates, dropped };
  const publicDir = websiteDir ? join(websiteDir, "cms", "public") + sep : null;
  for (const target of readdirSync(targetsDir).sort()) {
    for (const l of readJsonl<CalibrateLabel>(join(targetsDir, target, "labels.jsonl"))) {
      const drop = (reason: string) => dropped.push({ source: "calibrate", ref: l.id, path: l.artifact, reason });
      if (l.label_source?.kind !== "principal") { drop("label not from the principal"); continue; }
      const label: CaseLabel | null = l.verdict === "like" ? "accept" : l.verdict === "dislike" ? "reject" : null;
      if (label === null) { drop(`verdict ${l.verdict} is not like or dislike`); continue; }
      const type = typeOfPath(l.artifact);
      if (type === null) { drop("not a text, image or video file"); continue; }
      if (type !== "text" && isCaptureLike(l.artifact)) { drop("screenshot or capture path"); continue; }
      if (!existsSync(l.artifact)) { drop("frozen artifact no longer exists"); continue; }
      if (l.sha256 && sha256File(l.artifact) !== l.sha256) { drop("frozen artifact bytes differ from the rated bytes"); continue; }
      const isPublic = isPublicSource(publicDir, l.source_path, l.artifact);
      const ts = Date.parse(l.labeled_at ?? "");
      if (!Number.isFinite(ts)) { drop("label has no timestamp"); continue; }
      candidates.push({ type, artifact: resolve(l.artifact), label, source: "calibrate", source_ref: l.id, verdict_text: l.note ?? "", public: isPublic, ts: new Date(ts).toISOString() });
    }
  }
  return { candidates, dropped };
}

type ArtDirectionRow = { artifact: string; sha256?: string; verdict: number; note?: string; date?: string };

function artDirectionCandidates(labelsPath: string): { candidates: Candidate[]; dropped: Dropped[] } {
  const candidates: Candidate[] = [];
  const dropped: Dropped[] = [];
  for (const r of readJsonl<ArtDirectionRow>(labelsPath)) {
    const ref = r.date ?? "";
    const drop = (reason: string) => dropped.push({ source: "artdirection", ref, path: r.artifact, reason });
    const label = artDirectionLabel(r.verdict);
    if (label === null) { drop(`verdict ${r.verdict} is between the cuts`); continue; }
    const type = typeOfPath(r.artifact);
    if (type === null) { drop("not a text, image or video file"); continue; }
    if (type !== "text" && isCaptureLike(r.artifact)) { drop("screenshot or capture path"); continue; }
    if (!existsSync(r.artifact)) { drop("file no longer exists"); continue; }
    if (r.sha256 && sha256File(r.artifact) !== r.sha256) { drop("file bytes differ from the judged bytes"); continue; }
    const ts = Date.parse(ref);
    if (!Number.isFinite(ts)) { drop("verdict has no date"); continue; }
    candidates.push({ type, artifact: resolve(r.artifact), label, source: "artdirection", source_ref: ref, verdict_text: r.note ?? "", public: false, ts: new Date(ts).toISOString() });
  }
  return { candidates, dropped };
}

/** Frontmatter fields of a markdown post (flat `key: value` lines only). */
export function frontmatter(md: string): { fields: Record<string, string>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fields: {}, body: md };
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { fields, body: m[2]! };
}

/** Publication time of a post: the scheduled time when set, else created_at (both site-local, read as written). */
export function publishedAt(fields: Record<string, string>): number {
  return Date.parse(fields.override_scheduled_at || fields.created_at || "");
}

function publishedCandidates(websiteDir: string, now: number): { text: Candidate[]; images: Candidate[]; dropped: Dropped[] } {
  const blogDir = join(websiteDir, "cms", "blog");
  const dropped: Dropped[] = [];
  if (!existsSync(blogDir)) return { text: [], images: [], dropped };
  const windowStart = now - PUBLISHED_WINDOW_DAYS * 86_400_000;
  const posts: { path: string; slug: string; at: number; thumbnail: string }[] = [];
  for (const f of readdirSync(blogDir)) {
    if (!f.endsWith(".md")) continue;
    const path = join(blogDir, f);
    const { fields, body } = frontmatter(readFileSync(path, "utf8"));
    if (fields.status !== "published") continue;
    const at = publishedAt(fields);
    if (!Number.isFinite(at) || at > now || at < windowStart) continue;
    const slug = fields.slug || f.replace(/\.md$/, "");
    if (body.split(/\s+/).filter(Boolean).length < MIN_POST_WORDS) { dropped.push({ source: "published", ref: `blog/${slug}`, path, reason: `under ${MIN_POST_WORDS} words` }); continue; }
    posts.push({ path, slug, at, thumbnail: fields.thumbnail ?? "" });
  }
  posts.sort((a, b) => b.at - a.at || a.slug.localeCompare(b.slug));
  const chosen = posts.slice(0, PUBLISHED_POST_LIMIT);
  const text: Candidate[] = chosen.map((p) => ({ type: "text", artifact: p.path, label: "accept", source: "published", source_ref: `blog/${p.slug}`, verdict_text: "", public: true, ts: new Date(p.at).toISOString() }));
  const images: Candidate[] = [];
  for (const p of posts) {
    if (!p.thumbnail) continue;
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(p.thumbnail).pathname); } catch { pathname = p.thumbnail.startsWith("/") ? p.thumbnail : ""; }
    if (!pathname.startsWith("/images/")) continue;
    const local = join(websiteDir, "cms", "public", pathname);
    const ref = `blog/${p.slug}`;
    if (!basename(local).includes(p.slug)) { dropped.push({ source: "published", ref, path: local, reason: "thumbnail is not post-specific art (logo or shared image)" }); continue; }
    if (typeOfPath(local) !== "image") continue;
    if (isCaptureLike(local)) { dropped.push({ source: "published", ref, path: local, reason: "screenshot or capture path" }); continue; }
    if (!existsSync(local)) { dropped.push({ source: "published", ref, path: local, reason: "thumbnail file missing" }); continue; }
    images.push({ type: "image", artifact: local, label: "accept", source: "published", source_ref: ref, verdict_text: "", public: true, ts: new Date(p.at).toISOString() });
  }
  return { text, images, dropped };
}

// release-allow: private-skill-names (a USER-data config path read only when the file exists; absent on an install without the blogging skill, so it returns null)
/** The blog repo: $BLOG_REPO, else the BLOG_REPO row of the blogging skill's Config.md; null when neither names one. */
export function websiteDir(home = homedir()): string | null {
  const fromEnv = process.env.BLOG_REPO;
  if (fromEnv) return expandHome(fromEnv, home);
  const config = join(lifeosUserDir(), "CUSTOMIZATIONS", "SKILLS", "_BLOGGING", "Config.md");
  if (!existsSync(config)) return null;
  const m = readFileSync(config, "utf8").match(/\|\s*`BLOG_REPO`\s*\|\s*`([^`]+)`/);
  return m ? expandHome(m[1]!, home) : null;
}

// ── Assembly ────────────────────────────────────────────────────────────────

export function caseId(type: CaseType, sha: string): string {
  return `${ID_PREFIX[type]}-${sha.slice(0, 8)}`;
}

/**
 * Merge candidates into cases: hash every file, collapse byte-identical files (same label merges,
 * conflicting labels drop both), prefer explicit verdicts over publication, then cap image accepts.
 */
export function assemble(candidates: Candidate[], review: ReviewLedger, hash: (p: string) => string = sha256File): { cases: CorpusCase[]; dropped: Dropped[] } {
  const dropped: Dropped[] = [];
  const bySha = new Map<string, (Candidate & { sha256: string })[]>();
  for (const c of candidates) {
    const sha = hash(c.artifact);
    // Before the image cap, so an unreviewed or captured file never takes an accepted file's place.
    const block = contentReviewBlock(c.type, sha, review);
    if (block) { dropped.push({ source: c.source, ref: c.source_ref, path: c.artifact, reason: block }); continue; }
    bySha.set(sha, [...(bySha.get(sha) ?? []), { ...c, sha256: sha }]);
  }
  const merged: CorpusCase[] = [];
  for (const [sha, group] of bySha) {
    const explicit = group.filter((g) => g.source !== "published");
    const voters = explicit.length > 0 ? explicit : group;
    if (new Set(voters.map((g) => g.label)).size > 1) {
      for (const g of voters) dropped.push({ source: g.source, ref: g.source_ref, path: g.artifact, reason: "conflicting verdicts on the same bytes" });
      continue;
    }
    voters.sort((a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source] || a.ts.localeCompare(b.ts));
    const head = voters[0]!;
    const same = voters.filter((v) => v.source === head.source);
    const isPublic = group.some((g) => g.public);
    merged.push({
      id: caseId(head.type, sha),
      type: head.type,
      artifact: head.artifact,
      sha256: sha,
      label: head.label,
      source: head.source,
      source_ref: [...new Set(same.map((v) => v.source_ref))].join(","),
      verdict_text: [...new Set(same.map((v) => v.verdict_text).filter(Boolean))].join(" | "),
      public: isPublic,
      ts: same[same.length - 1]!.ts,
    });
  }
  return capImageAccepts(merged, dropped);
}

/** Keep image accepts within IMAGE_ACCEPT_RATIO_CAP x image rejects: explicit verdicts first, newest first. */
export function capImageAccepts(cases: CorpusCase[], dropped: Dropped[] = []): { cases: CorpusCase[]; dropped: Dropped[] } {
  const rejects = cases.filter((c) => c.type === "image" && c.label === "reject").length;
  const cap = rejects * IMAGE_ACCEPT_RATIO_CAP;
  const accepts = cases
    .filter((c) => c.type === "image" && c.label === "accept")
    .sort((a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source] || b.ts.localeCompare(a.ts) || a.id.localeCompare(b.id));
  const cut = new Set(accepts.slice(cap).map((c) => c.id));
  for (const c of accepts.slice(cap)) dropped.push({ source: c.source, ref: c.source_ref, path: c.artifact, reason: `image accept over the ${IMAGE_ACCEPT_RATIO_CAP}:1 cap` });
  const kept = cases.filter((c) => !cut.has(c.id));
  kept.sort((a, b) => CASE_TYPES.indexOf(a.type) - CASE_TYPES.indexOf(b.type) || a.label.localeCompare(b.label) || a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  return { cases: kept, dropped };
}

/** An image or video is public when a byte-identical file of the same name is in the site's images dir. */
export function markPublishedMedia(cases: CorpusCase[], imagesDir: string, hash: (p: string) => string = sha256File): void {
  for (const c of cases) {
    if (c.public || c.type === "text") continue;
    const onSite = join(imagesDir, basename(c.artifact));
    if (existsSync(onSite) && hash(onSite) === c.sha256) c.public = true;
  }
}

export type BuildPaths = { errataDir: string; calibrateTargets: string; artDirectionLabels: string; contentReview: string; website: string | null; now: number };

export function defaultBuildPaths(): BuildPaths {
  const user = lifeosUserDir();
  return {
    contentReview: CONTENT_REVIEW_PATH,
    errataDir: join(user, "ERRATA"),
    calibrateTargets: join(user, "CUSTOMIZATIONS", "SKILLS", "Calibrate", "Targets"),
    artDirectionLabels: join(user, "CUSTOMIZATIONS", "SKILLS", "ArtDirection", "labels.jsonl"),
    website: websiteDir(),
    now: Date.now(),
  };
}

export function buildCorpus(paths: BuildPaths = defaultBuildPaths()): { cases: CorpusCase[]; dropped: Dropped[] } {
  const errata = errataCandidates(readErrataRows(paths.errataDir));
  const calibrate = calibrateCandidates(paths.calibrateTargets, paths.website);
  const art = artDirectionCandidates(paths.artDirectionLabels);
  const published = paths.website ? publishedCandidates(paths.website, paths.now) : { text: [], images: [], dropped: [] as Dropped[] };
  const { cases, dropped } = assemble([...errata.candidates, ...calibrate.candidates, ...art.candidates, ...published.text, ...published.images], readContentReview(paths.contentReview));
  if (paths.website) markPublishedMedia(cases, join(paths.website, "cms", "public", "images"));
  return { cases, dropped: [...errata.dropped, ...calibrate.dropped, ...art.dropped, ...published.dropped, ...dropped] };
}

// ── Read, validate, write ───────────────────────────────────────────────────

const FIELDS: (keyof CorpusCase)[] = ["id", "type", "artifact", "sha256", "label", "source", "source_ref", "verdict_text", "public", "ts"];

/** Structural errors in one case (no file access). */
export function shapeErrors(c: unknown): string[] {
  if (typeof c !== "object" || c === null || Array.isArray(c)) return ["not an object"];
  const r = c as Record<string, unknown>;
  const errs: string[] = [];
  for (const f of FIELDS) if (!(f in r)) errs.push(`missing field ${f}`);
  if (errs.length) return errs;
  for (const f of ["id", "artifact", "sha256", "source_ref", "verdict_text", "ts"] as const) if (typeof r[f] !== "string") errs.push(`${f} is not a string`);
  if (typeof r.public !== "boolean") errs.push("public is not a boolean");
  if (!CASE_TYPES.includes(r.type as CaseType)) errs.push(`type ${String(r.type)} not in ${CASE_TYPES.join("|")}`);
  if (!LABELS.includes(r.label as CaseLabel)) errs.push(`label ${String(r.label)} not in accept|reject`);
  if (!LABEL_SOURCES.includes(r.source as LabelSource)) errs.push(`source ${String(r.source)} not in ${LABEL_SOURCES.join("|")}`);
  if (errs.length) return errs;
  const k = r as CorpusCase;
  if (!/^[0-9a-f]{64}$/.test(k.sha256)) errs.push("sha256 is not 64 hex characters");
  if (k.id !== caseId(k.type, k.sha256)) errs.push(`id ${k.id} does not match ${caseId(k.type, k.sha256)}`);
  if (!isAbsolute(k.artifact)) errs.push("artifact is not an absolute path");
  if (typeOfPath(k.artifact) !== k.type) errs.push(`artifact extension does not match type ${k.type}`);
  if (k.source_ref.trim() === "") errs.push("source_ref is empty");
  if (!Number.isFinite(Date.parse(k.ts))) errs.push("ts is not a date");
  if (k.source === "published" && (k.label !== "accept" || !k.public)) errs.push("a published case must be accept and public");
  if (k.type !== "text" && isCaptureLike(k.artifact)) errs.push("image or video path looks like a screenshot or capture (ISC-19)");
  return errs;
}

export type ValidateDeps = { exists: (p: string) => boolean; hash: (p: string) => string; review: ReviewLedger };

const realValidateDeps = (): ValidateDeps => ({ exists: existsSync, hash: sha256File, review: readContentReview() });

/** Every error in a corpus: shape, duplicates, and (with deps) missing files, hash mismatches and media the content review has not passed. */
export function validateCases(cases: unknown[], deps: ValidateDeps | null = realValidateDeps()): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  const shas = new Set<string>();
  cases.forEach((c, i) => {
    const at = `case ${i + 1}`;
    const shape = shapeErrors(c);
    for (const e of shape) errs.push(`${at}: ${e}`);
    if (shape.length) return;
    const k = c as CorpusCase;
    if (ids.has(k.id)) errs.push(`${at}: duplicate id ${k.id}`);
    if (shas.has(k.sha256)) errs.push(`${at}: duplicate sha256 ${k.sha256.slice(0, 12)}`);
    ids.add(k.id);
    shas.add(k.sha256);
    if (!deps) return;
    if (!deps.exists(k.artifact)) errs.push(`${at}: artifact missing ${k.artifact}`);
    else if (deps.hash(k.artifact) !== k.sha256) errs.push(`${at}: sha256 mismatch ${k.artifact}`);
    const block = contentReviewBlock(k.type, k.sha256, deps.review);
    if (block) errs.push(`${at}: ${block}`);
  });
  return errs;
}

/** Read the corpus; throws on a malformed line or a case with the wrong shape (files are not checked here). */
export function readCorpus(path: string = CORPUS_PATH): CorpusCase[] {
  if (!existsSync(path)) throw new Error(`UseCaseCorpus: no corpus at ${path}; run \`bun LIFEOS/ASSAY/UseCaseCorpus.ts build\``);
  const out: CorpusCase[] = [];
  readFileSync(path, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error(`UseCaseCorpus: line ${i + 1} is not JSON`); }
    const errs = shapeErrors(parsed);
    if (errs.length) throw new Error(`UseCaseCorpus: line ${i + 1}: ${errs.join("; ")}`);
    out.push(parsed as CorpusCase);
  });
  return out;
}

/** Write the corpus atomically after asserting every case is valid against the files on disk. */
export function writeCorpus(cases: CorpusCase[], path: string = CORPUS_PATH, deps: ValidateDeps = realValidateDeps()): void {
  const errs = validateCases(cases, deps);
  invariant(errs.length === 0, `UseCaseCorpus: refusing to write an invalid corpus: ${errs.slice(0, 5).join("; ")}`);
  invariant(cases.every((c) => LABEL_SOURCES.includes(c.source)), "UseCaseCorpus: a label source outside the four principal kinds");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, cases.map((c) => JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f, c[f]])))).join("\n") + (cases.length ? "\n" : ""));
  renameSync(tmp, path);
}

export type Stats = Record<CaseType, Record<CaseLabel, number>>;

export function stats(cases: CorpusCase[]): Stats {
  const s = Object.fromEntries(CASE_TYPES.map((t) => [t, { accept: 0, reject: 0 }])) as Stats;
  for (const c of cases) s[c.type][c.label] += 1;
  return s;
}

/** ISC-18 shortfall per class for text and image ("text reject: 10 short"), empty when met. */
export function shortfalls(s: Stats): string[] {
  const out: string[] = [];
  for (const t of ["text", "image"] as const) for (const l of LABELS) if (s[t][l] < MIN_PER_CLASS) out.push(`${t} ${l}: ${MIN_PER_CLASS - s[t][l]} short`);
  return out;
}

/**
 * Types whose accuracy cannot be reported: one label is absent, so a constant answer scores 100%
 * (or 0%) and the number says nothing about the engine. The bake-off reports no accuracy for these.
 */
export function unmeasurableTypes(s: Stats): CaseType[] {
  return CASE_TYPES.filter((t) => s[t].accept === 0 || s[t].reject === 0);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function printStats(cases: CorpusCase[]): string[] {
  const s = stats(cases);
  console.log(`corpus: ${cases.length} cases`);
  for (const t of CASE_TYPES) console.log(`  ${t.padEnd(6)} accept ${String(s[t].accept).padStart(3)}  reject ${String(s[t].reject).padStart(3)}`);
  const bySource = new Map<string, number>();
  for (const c of cases) bySource.set(`${c.source}/${c.type}/${c.label}`, (bySource.get(`${c.source}/${c.type}/${c.label}`) ?? 0) + 1);
  console.log("by source:");
  for (const [k, n] of [...bySource].sort()) console.log(`  ${k.padEnd(30)} ${n}`);
  const short = shortfalls(s);
  console.log(`ISC-18 (text and image >= ${MIN_PER_CLASS} per class): ${short.length ? `short — ${short.join(", ")}` : "met"}`);
  const blind = unmeasurableTypes(s);
  if (blind.length) console.log(`accuracy not reportable (one label absent, a constant answer would score 100%): ${blind.join(", ")}`);
  return short;
}

if (import.meta.main) {
  const [cmd, ...flags] = process.argv.slice(2);
  if (cmd === "build") {
    const { cases, dropped } = buildCorpus();
    writeCorpus(cases);
    console.log(`wrote ${cases.length} cases to ${CORPUS_PATH}`);
    const reasons = new Map<string, number>();
    for (const d of dropped) reasons.set(`${d.source}: ${d.reason}`, (reasons.get(`${d.source}: ${d.reason}`) ?? 0) + 1);
    console.log(`dropped ${dropped.length}:`);
    for (const [r, n] of [...reasons].sort()) console.log(`  ${String(n).padStart(4)}  ${r}`);
    if (flags.includes("--verbose")) for (const d of dropped) console.log(`  - [${d.source} ${d.ref}] ${d.reason}: ${d.path}`);
    printStats(cases);
  } else if (cmd === "validate") {
    let cases: CorpusCase[];
    try { cases = readCorpus(); } catch (e) { console.error((e as Error).message); process.exit(1); }
    const errs = validateCases(cases);
    if (errs.length) { for (const e of errs) console.error(e); console.error(`validate: ${errs.length} error(s) in ${cases.length} cases`); process.exit(1); }
    console.log(`validate: ok — ${cases.length} cases, every field present, sources in ${LABEL_SOURCES.join("|")}, files and sha256 match, no capture-like media path, every media case content-reviewed as art`);
  } else if (cmd === "stats") {
    const short = printStats(readCorpus());
    if (flags.includes("--strict") && short.length) process.exit(1);
  } else {
    console.error("usage: bun LIFEOS/ASSAY/UseCaseCorpus.ts build [--verbose] | validate | stats [--strict]");
    process.exit(2);
  }
}
