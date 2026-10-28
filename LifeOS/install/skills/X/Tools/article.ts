#!/usr/bin/env bun

/**
 * X Articles — long-form publishing via the v2 Articles endpoints.
 *
 *   POST /2/articles/draft          → { data: { id, title } }
 *   POST /2/articles/{id}/publish   → { data: { post_id } }
 *
 * Auth: the same configured OAuth 2.0 store every other tool here reads
 * (`tweet.write` for the article, `media.write` for images). No OAuth 1.0a
 * path — the Articles endpoints are user-context only.
 *
 * The body is X's `content_state`: a DraftJS raw state in snake_case. Blocks
 * carry the text plus `inline_style_ranges` / `entity_ranges` pointing into a
 * shared `entities` array. Images, embedded posts, code and dividers are
 * `atomic` blocks whose single-space text is covered by one entity range.
 *
 * Usage:
 *   bun run article.ts draft --file post.md [--title "..."] [--cover img.png] [--json]
 *   bun run article.ts publish <article_id> --file post.md [--json]
 *   bun run article.ts create --file post.md [--cover img.png] --publish
 *   bun run article.ts render --file post.md          # print content_state, no API
 *
 * Publishing is public and never happens without an explicit --publish.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, renameSync } from "fs";
import { createHash } from "node:crypto";
import { resolve, dirname, isAbsolute, join } from "path";
import { homedir } from "node:os";
import { getValidTokens, oauth2Fetch, API_BASE } from "./x-client";
import { discardSent, formatBlocked, gatedTransmit, sendGate, type GateDeps } from "../../../LIFEOS/TOOLS/lib/SendGate.ts";
import { uploadMedia } from "./media";

// --- content_state types (X's snake_case DraftJS) ---

export type BlockType =
  | "unstyled"
  | "header-one"
  | "header-two"
  | "header-three"
  | "unordered-list-item"
  | "ordered-list-item"
  | "blockquote"
  | "atomic";

export type InlineStyle = "bold" | "italic" | "strikethrough";
export type EntityType = "post" | "link" | "image" | "emoji" | "markdown" | "divider" | "latex";

export interface StyleRange {
  offset: number;
  length: number;
  style: InlineStyle;
}

export interface EntityRange {
  offset: number;
  length: number;
  key: number;
}

export interface Block {
  text: string;
  type: BlockType;
  inline_style_ranges?: StyleRange[];
  entity_ranges?: EntityRange[];
}

export interface Entity {
  key: string;
  value: {
    type: EntityType;
    mutability: "immutable" | "mutable" | "segmented";
    data: Record<string, unknown>;
  };
}

export interface ContentState {
  blocks: Block[];
  entities: Entity[];
}

/** Local image path (as written in the markdown) → uploaded media id. */
export type MediaMap = Record<string, string>;

/**
 * Rewrites root-relative links to absolute ones. A post lifted out of a site
 * carries `/blog/x` links that are dead the moment they leave that origin, and
 * X renders them as dead links rather than failing.
 */
export function absolutizeLinks(markdown: string, baseUrl: string): string {
  const origin = baseUrl.replace(/\/+$/, "");
  // Only the URL slot of `](...)`, and only when it starts with a single slash
  // — protocol-relative `//host` URLs are already absolute.
  return markdown.replace(/\]\((\/(?!\/)[^)\s]*)\)/g, (_m, path) => `](${origin}${path})`);
}

// --- inline parsing ---

interface Inline {
  text: string;
  inline_style_ranges: StyleRange[];
  entity_ranges: EntityRange[];
}

// Ordered by specificity, not precedence — the earliest match in the string
// wins, so `**bold**` never loses its inner `*` to the italic pattern.
const INLINE_PATTERNS: Array<{ re: RegExp; kind: "link" | "url" | InlineStyle }> = [
  { re: /\[([^\]]+)\]\(([^)\s]+)\)/, kind: "link" },
  // Lazy, but the closing marker may not butt against a third one — that
  // pushes `**a *b***` out to the LAST `**` so the nested italic survives,
  // while `**a** and **b**` still closes on the first.
  { re: /\*\*([\s\S]+?)\*\*(?!\*)/, kind: "bold" },
  { re: /__([\s\S]+?)__(?!_)/, kind: "bold" },
  { re: /~~([\s\S]+?)~~(?!~)/, kind: "strikethrough" },
  { re: /(?<![*\w])\*([^*\n]+)\*(?!\*)/, kind: "italic" },
  { re: /(?<![_\w])_([^_\n]+)_(?![_\w])/, kind: "italic" },
  { re: /https?:\/\/[^\s<>()\[\]]+/, kind: "url" },
];

function addEntity(
  entities: Entity[],
  type: EntityType,
  mutability: Entity["value"]["mutability"],
  data: Record<string, unknown>,
): number {
  const key = entities.length;
  entities.push({ key: String(key), value: { type, mutability, data } });
  return key;
}

function absorb(inner: Inline, at: number, styles: StyleRange[], ranges: EntityRange[]): void {
  for (const s of inner.inline_style_ranges) styles.push({ ...s, offset: s.offset + at });
  for (const r of inner.entity_ranges) ranges.push({ ...r, offset: r.offset + at });
}

/**
 * Converts one line of markdown to plain text plus the ranges that decorate it.
 * Offsets are computed against the STRIPPED text, never the source — the
 * markers are gone by the time X reads the offsets.
 */
export function parseInline(src: string, entities: Entity[]): Inline {
  let text = "";
  const inline_style_ranges: StyleRange[] = [];
  const entity_ranges: EntityRange[] = [];
  let rest = src;

  while (rest.length > 0) {
    let best: { m: RegExpExecArray; kind: (typeof INLINE_PATTERNS)[number]["kind"] } | null = null;
    for (const p of INLINE_PATTERNS) {
      const m = p.re.exec(rest);
      if (m && (best === null || m.index < best.m.index)) best = { m, kind: p.kind };
    }
    if (!best) {
      text += rest;
      break;
    }

    text += rest.slice(0, best.m.index);
    const at = text.length;

    if (best.kind === "link") {
      const inner = parseInline(best.m[1], entities);
      text += inner.text;
      absorb(inner, at, inline_style_ranges, entity_ranges);
      entity_ranges.push({
        offset: at,
        length: inner.text.length,
        key: addEntity(entities, "link", "mutable", { url: best.m[2] }),
      });
    } else if (best.kind === "url") {
      text += best.m[0];
      entity_ranges.push({
        offset: at,
        length: best.m[0].length,
        key: addEntity(entities, "link", "mutable", { url: best.m[0] }),
      });
    } else {
      const inner = parseInline(best.m[1], entities);
      text += inner.text;
      absorb(inner, at, inline_style_ranges, entity_ranges);
      inline_style_ranges.push({ offset: at, length: inner.text.length, style: best.kind });
    }

    rest = rest.slice(best.m.index + best.m[0].length);
  }

  return { text, inline_style_ranges, entity_ranges };
}

// --- block parsing ---

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const POST_LINE = /^https?:\/\/(?:x|twitter)\.com\/[^/\s]+\/status\/(\d+)(?:\?\S*)?$/;
const RULE_LINE = /^(?:-{3,}|_{3,}|\*{3,})$/;

function textBlock(raw: string, type: BlockType, entities: Entity[]): Block {
  const inline = parseInline(raw, entities);
  const block: Block = { text: inline.text, type };
  if (inline.inline_style_ranges.length) block.inline_style_ranges = inline.inline_style_ranges;
  if (inline.entity_ranges.length) block.entity_ranges = inline.entity_ranges;
  return block;
}

function atomicBlock(
  entities: Entity[],
  type: EntityType,
  mutability: Entity["value"]["mutability"],
  data: Record<string, unknown>,
): Block {
  const key = addEntity(entities, type, mutability, data);
  // DraftJS convention: an atomic block holds one placeholder character that
  // the entity range covers entirely. X rejects a zero-length atomic block.
  return { text: " ", type: "atomic", entity_ranges: [{ offset: 0, length: 1, key }] };
}

/** Every local image path referenced by an image-only line, in document order. */
export function collectImagePaths(markdown: string): string[] {
  const found: string[] = [];
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const m = IMAGE_LINE.exec(line.trim());
    if (m && !/^https?:\/\//.test(m[2]) && !found.includes(m[2])) found.push(m[2]);
  }
  return found;
}

/** Pulls a leading `# Title` off the body; returns both halves. */
export function extractTitle(markdown: string): { title: string | null; body: string } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const m = /^#\s+(.+)$/.exec(lines[i] ?? "");
  if (!m) return { title: null, body: markdown };
  return { title: m[1].trim(), body: lines.slice(i + 1).join("\n") };
}

/**
 * Markdown → content_state. Pure and synchronous: image uploads happen before
 * this runs and arrive as `mediaMap`, which keeps the whole converter testable
 * without touching the API.
 */
export function toContentState(markdown: string, mediaMap: MediaMap = {}): ContentState {
  const entities: Entity[] = [];
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push(textBlock(paragraph.join(" "), "unstyled", entities));
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("```")) {
      flush();
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i]), i++;
      const fenced = `\`\`\`${lang}\n${code.join("\n")}\n\`\`\``;
      blocks.push(atomicBlock(entities, "markdown", "immutable", { markdown: fenced }));
      continue;
    }

    if (line === "") {
      flush();
      continue;
    }

    if (RULE_LINE.test(line)) {
      flush();
      blocks.push(atomicBlock(entities, "divider", "immutable", {}));
      continue;
    }

    const image = IMAGE_LINE.exec(line);
    if (image) {
      flush();
      const mediaId = mediaMap[image[2]];
      if (!mediaId) {
        throw new Error(
          `no uploaded media for image "${image[2]}" — upload it before converting (remote image URLs are not supported)`,
        );
      }
      const data: Record<string, unknown> = {
        media_items: [{ media_id: mediaId, media_category: "tweet_image" }],
      };
      if (image[1]) data.caption = image[1];
      blocks.push(atomicBlock(entities, "image", "immutable", data));
      continue;
    }

    const post = POST_LINE.exec(line);
    if (post) {
      flush();
      blocks.push(atomicBlock(entities, "post", "immutable", { post_id: post[1] }));
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const type = (["header-one", "header-two", "header-three"] as const)[heading[1].length - 1];
      blocks.push(textBlock(heading[2], type, entities));
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      blocks.push(textBlock(quote[1], "blockquote", entities));
      continue;
    }

    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      flush();
      blocks.push(textBlock(bullet[1], "unordered-list-item", entities));
      continue;
    }

    const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (numbered) {
      flush();
      blocks.push(textBlock(numbered[1], "ordered-list-item", entities));
      continue;
    }

    paragraph.push(line);
  }
  flush();

  return { blocks, entities };
}

// --- API ---

const ARTICLES_BASE = "https://api.x.com/2/articles";

async function articlesFetch(path: string, body?: unknown): Promise<any> {
  const tokens = await getValidTokens();
  const res = await fetch(`${ARTICLES_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    json = { raw };
  }
  if (!res.ok) {
    throw new Error(`X Articles POST ${path} → ${res.status}: ${raw.slice(0, 600)}`);
  }
  // A 201 with an `errors` array is a partial failure, not a success.
  if (Array.isArray(json?.errors) && json.errors.length) {
    throw new Error(`X Articles POST ${path} returned errors: ${JSON.stringify(json.errors).slice(0, 600)}`);
  }
  return json;
}

export async function createDraft(
  title: string,
  contentState: ContentState,
  coverMediaId?: string,
): Promise<{ id: string; title: string }> {
  if (!title.trim()) throw new Error("article title is required (pass --title or start the file with `# Title`)");
  const body: Record<string, unknown> = { title, content_state: contentState };
  if (coverMediaId) body.cover_media = { media_id: coverMediaId, media_category: "tweet_image" };
  const json = await articlesFetch("/draft", body);
  const id = json?.data?.id;
  if (!id) throw new Error(`draft create returned no article id: ${JSON.stringify(json).slice(0, 400)}`);
  return { id, title: json.data.title ?? title };
}

/** What the publish gate proofs: the article's text and every image file it carries. A draft id alone has no local bytes. */
export type PublishProof = { text: string; attachments?: string[] };
export type PublishDeps = {
  gate?: GateDeps; publishFn?: (articleId: string) => Promise<any>; handle?: string;
  /** Where the draft-proof map lives. Default LIFEOS_X_ARTICLE_STATE_DIR or ~/.local/state/lifeos/x-articles (outside the repo). */
  stateDir?: string;
};

// --- the draft-proof map: what was proofed for each draft id ---
//
// X publishes the STORED draft, so a file handed to `publish` cannot change what goes live; it only changes what was
// proofed. The map closes that gap: draft creation records {draftId -> sha256 of the article text + each image's sha},
// and publish requires the entry and that the content it proofs hashes to it. A different file cannot stand in.

export type DraftProofEntry = { textSha: string; imageShas: string[]; recorded: string };
const sha256Hex = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
export const articleStateDir = (deps: Pick<PublishDeps, "stateDir"> = {}): string =>
  deps.stateDir ?? process.env.LIFEOS_X_ARTICLE_STATE_DIR ?? join(homedir(), ".local", "state", "lifeos", "x-articles");
const proofMapFile = (deps: Pick<PublishDeps, "stateDir">) => join(articleStateDir(deps), "draft-proofs.json");

function readProofMap(deps: Pick<PublishDeps, "stateDir">): Record<string, DraftProofEntry> {
  try { return JSON.parse(readFileSync(proofMapFile(deps), "utf-8")) as Record<string, DraftProofEntry>; } catch { return {}; }
}

/** The text a draft is proofed on: its title and body, exactly as the draft was built. */
export const articleProofText = (title: string, body: string): string => `${title}\n\n${body}`;

export function recordDraftProof(articleId: string, proofText: string, imageFiles: string[], deps: Pick<PublishDeps, "stateDir"> = {}): DraftProofEntry {
  if (!articleId) throw new Error("recordDraftProof needs an article id");
  const dir = articleStateDir(deps);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const entry: DraftProofEntry = { textSha: sha256Hex(proofText), imageShas: imageFiles.map((p) => sha256Hex(readFileSync(p))), recorded: new Date().toISOString() };
  const map = readProofMap(deps);
  map[articleId] = entry;
  const file = proofMapFile(deps);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return entry;
}

export async function publishDraft(articleId: string, proof: PublishProof | null, deps: PublishDeps = {}): Promise<{ postId: string; url: string }> {
  // ISC-11: publishing is the public act. The proof of the exact article text sits here, immediately before the call.
  if (!proof || !proof.text.trim()) throw new Error("SEND BLOCKED (x): publishing an article needs the article text to check; pass --file <the markdown this draft was built from>. Nothing was sent.");
  // The draft is what X publishes. Only the content proofed at draft creation may stand in for it.
  const entry = readProofMap(deps)[articleId];
  if (!entry) throw new Error(`SEND BLOCKED (x): no proofed content is recorded for draft ${articleId} (a draft made by this tool records it). Re-create the draft with this tool, then publish it. Nothing was sent.`);
  const files = proof.attachments ?? [];
  const missing = files.filter((p) => !existsSync(p));
  if (missing.length) throw new Error(`SEND BLOCKED (x): article image not found: ${missing.join(", ")}. Nothing was sent.`);
  const sameShas = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (sha256Hex(proof.text) !== entry.textSha || !sameShas(files.map((p) => sha256Hex(readFileSync(p))), entry.imageShas)) {
    throw new Error(`SEND BLOCKED (x): the article text or images given are not what was proofed when draft ${articleId} was created, so they cannot stand in for it. Pass the same --file (and --title/--base-url/--cover) the draft was built from. Nothing was sent.`);
  }
  const sent = await gatedTransmit(
    { channel: "x", destination: "publish", body: proof.text, recipientClass: "x", attachments: files },
    (g) => {
      // The gate's proofed copies must be the mapped content: the last check before the publish call.
      const body = g.items.find((i) => i.role === "body");
      const imgs = g.items.filter((i) => i.role === "attachment").map((i) => i.sha256);
      if (!body || body.sha256 !== entry.textSha || !sameShas(imgs, entry.imageShas)) throw new Error("the proofed content differs from the draft's recorded content; nothing sent");
      return (deps.publishFn ?? ((id: string) => articlesFetch(`/${id}/publish`)))(articleId);
    },
    deps.gate,
    { skill: "X" },
  );
  if (!sent.ok) throw new Error(formatBlocked(sent, "x"));
  const json = sent.result;
  const postId = json?.data?.post_id ?? json?.data?.id;
  if (!postId) throw new Error(`publish returned no post id: ${JSON.stringify(json).slice(0, 400)}`);
  return { postId, url: `https://x.com/${deps.handle ?? (await resolveHandle())}/status/${postId}` };
}

async function resolveHandle(): Promise<string> {
  try {
    const me = await oauth2Fetch(`${API_BASE}/users/me`);
    return me?.data?.username ?? "i";
  } catch {
    return "i"; // x.com/i/status/<id> still resolves
  }
}

// --- high-level build ---

export interface BuildOptions {
  /** Markdown file path, or the markdown itself when `raw` is set. */
  file?: string;
  raw?: string;
  title?: string;
  cover?: string;
  /** Origin used to absolutize root-relative links, e.g. https://example.com */
  baseUrl?: string;
  /** Public action. Without it the article stays an unpublished draft. */
  publish?: boolean;
  log?: (msg: string) => void;
  /** Test seam: the publish gate's dependencies. */
  publishDeps?: PublishDeps;
  /** Test seam: replaces the draft-create network call. */
  draftFn?: typeof createDraft;
  /** Test seam: replaces the media upload (receives the file path it would upload). */
  uploadFn?: (file: string) => Promise<string>;
  /** Test seam: runs after the pre-flight gate and before the uploads (a tamper after the proof). */
  afterGate?: () => void;
}

export interface BuildResult {
  articleId: string;
  title: string;
  blocks: number;
  entities: number;
  published: boolean;
  postId?: string;
  url?: string;
}

function resolveRelative(path: string, baseDir: string): string {
  const expanded = path.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? homedir());  // USERPROFILE covers Windows, where HOME is unset
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

/** Uploads the images, builds the content_state, drafts, and optionally publishes. */
export async function buildArticle(opts: BuildOptions): Promise<BuildResult> {
  const log = opts.log ?? (() => {});
  let markdown: string;
  let baseDir = process.cwd();

  if (opts.raw !== undefined) {
    markdown = opts.raw;
  } else {
    if (!opts.file) throw new Error("buildArticle needs either --file or raw markdown");
    const file = resolveRelative(opts.file, process.cwd());
    if (!existsSync(file)) throw new Error(`markdown file not found: ${file}`);
    markdown = readFileSync(file, "utf-8");
    baseDir = dirname(file);
  }

  if (opts.baseUrl) markdown = absolutizeLinks(markdown, opts.baseUrl);

  const extracted = extractTitle(markdown);
  const title = opts.title ?? extracted.title ?? "";
  const body = opts.title && extracted.title === null ? markdown : extracted.body;

  const mediaMap: MediaMap = {};
  const proofFiles: string[] = [];
  // The sha the pre-flight gate proofed for each image. An image's bytes must hash to it before the upload and again
  // after: a file edited after the gate or mid-upload is refused, so no byte reaches X that the gate did not read.
  const gatedShas = new Map<string, string>();
  const uploadChecked = async (file: string, label: string): Promise<string> => {
    const gated = gatedShas.get(file);
    if (!gated) throw new Error(`${label} was not proofed by the send gate; nothing uploaded`);
    if (sha256Hex(readFileSync(file)) !== gated) throw new Error(`${label} changed after the send gate proofed it; nothing uploaded`);
    const id = await (opts.uploadFn ?? ((f: string) => uploadMedia(f, "tweet_image")))(file);
    if (sha256Hex(readFileSync(file)) !== gated) throw new Error(`${label} changed while it was being uploaded; nothing recorded or published`);
    return id;
  };
  // Resolve every local image first, then gate them, then upload: no media byte reaches X before the send gate has read it.
  const imageUploads: Array<{ path: string; file: string }> = [];
  for (const path of collectImagePaths(body)) {
    const file = resolveRelative(path, baseDir);
    if (!existsSync(file)) throw new Error(`article image not found: ${file} (referenced as "${path}")`);
    proofFiles.push(file);
    imageUploads.push({ path, file });
  }
  let coverFile: string | undefined;
  if (opts.cover) {
    coverFile = resolveRelative(opts.cover, process.cwd());
    if (!existsSync(coverFile)) throw new Error(`cover image not found: ${coverFile}`);
    proofFiles.push(coverFile);
  }

  const proofAttachments = [...new Set(proofFiles)];
  const proofText = articleProofText(title, body);

  if (proofAttachments.length) {
    const pre = await sendGate(
      { channel: "x", destination: "publish", body: proofText, recipientClass: "x", attachments: proofAttachments },
      opts.publishDeps?.gate ?? {},
    );
    if (!pre.ok) throw new Error(formatBlocked(pre, "x"));
    const proofed = pre.items.filter((i) => i.role === "attachment");
    discardSent(pre); // a pre-flight only; the publish gate re-proofs the exact bytes it sends
    if (proofed.length !== proofAttachments.length) throw new Error("the send gate returned a different image set than was asked; nothing uploaded");
    proofAttachments.forEach((file, i) => gatedShas.set(file, proofed[i]!.sha256));
    opts.afterGate?.();
  }

  for (const { path, file } of imageUploads) {
    log(`uploading image ${path}`);
    mediaMap[path] = await uploadChecked(file, `image ${path}`);
  }

  const contentState = toContentState(body, mediaMap);
  if (!contentState.blocks.length) throw new Error("article body is empty after conversion");

  let coverId: string | undefined;
  if (coverFile) {
    log(`uploading cover ${opts.cover}`);
    coverId = await uploadChecked(coverFile, "cover image");
  }

  const draft = await (opts.draftFn ?? createDraft)(title, contentState, coverId);
  recordDraftProof(draft.id, proofText, proofAttachments, opts.publishDeps ?? {});
  log(`draft ${draft.id} — ${contentState.blocks.length} blocks, ${contentState.entities.length} entities`);

  const result: BuildResult = {
    articleId: draft.id,
    title: draft.title,
    blocks: contentState.blocks.length,
    entities: contentState.entities.length,
    published: false,
  };

  if (opts.publish) {
    const published = await publishDraft(draft.id, { text: proofText, attachments: proofAttachments }, opts.publishDeps);
    result.published = true;
    result.postId = published.postId;
    result.url = published.url;
    log(`published ${published.url}`);
  }

  return result;
}

// --- CLI ---

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): never {
  console.log(`X Articles

  bun run article.ts render  --file post.md [--base-url https://site.com]   # content_state only, no API
  bun run article.ts draft   --file post.md [--title "..."] [--cover img.png] [--base-url https://site.com] [--json]
  bun run article.ts publish <article_id> --file post.md [--title "..."] [--cover img.png] [--base-url https://site.com] [--json]
        # --file (and the same --title/--cover/--base-url): the draft's own content; it must hash to what was recorded at draft creation
  bun run article.ts create  --file post.md [--cover img.png] --publish

Publishing is public and requires --publish. Without it, create stops at the draft.`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const json = args.includes("--json");
  const log = json ? () => {} : (m: string) => console.log(`  ${m}`);

  if (!command || command === "--help" || command === "-h") usage();

  if (command === "render") {
    const file = flag(args, "--file");
    if (!file) usage();
    let markdown = readFileSync(resolveRelative(file, process.cwd()), "utf-8");
    const base = flag(args, "--base-url");
    if (base) markdown = absolutizeLinks(markdown, base);
    const { title, body } = extractTitle(markdown);
    const images = collectImagePaths(body);
    // Render is offline, so images get placeholder ids rather than uploads.
    const stub: MediaMap = Object.fromEntries(images.map((p, i) => [p, `PENDING_UPLOAD_${i}`]));
    console.log(JSON.stringify({ title, content_state: toContentState(body, stub) }, null, 2));
    return;
  }

  if (command === "draft" || command === "create") {
    const file = flag(args, "--file");
    if (!file) usage();
    const publish = args.includes("--publish");
    if (publish && command === "draft") {
      console.error("`draft` never publishes — use `create --publish`.");
      process.exit(1);
    }
    const result = await buildArticle({
      file,
      title: flag(args, "--title"),
      cover: flag(args, "--cover"),
      baseUrl: flag(args, "--base-url"),
      publish,
      log,
    });
    if (json) console.log(JSON.stringify(result));
    else {
      console.log(`\n${result.published ? "Published" : "Draft"}: ${result.title}`);
      console.log(`  article id: ${result.articleId}`);
      if (result.url) console.log(`  url: ${result.url}`);
      else console.log(`  not published — rerun with: create --file ... --publish`);
    }
    return;
  }

  if (command === "publish") {
    const id = args[1];
    if (!id || id.startsWith("--")) usage();
    // A draft id has no local bytes: the proof is of the markdown the draft was built from.
    const proofFile = flag(args, "--file");
    if (!proofFile) {
      console.error("SEND BLOCKED (x): publishing needs the article text to check: publish <article_id> --file <the markdown this draft was built from>. Nothing was sent.");
      process.exit(1);
    }
    const proofPath = resolveRelative(proofFile, process.cwd());
    if (!existsSync(proofPath)) {
      console.error(`SEND BLOCKED (x): the article file to check was not found: ${proofPath}. Nothing was sent.`);
      process.exit(1);
    }
    // The same preparation the draft went through (base URL, title), so the proofed text is the draft's recorded text.
    let markdown = readFileSync(proofPath, "utf-8");
    const base = flag(args, "--base-url");
    if (base) markdown = absolutizeLinks(markdown, base);
    const extracted = extractTitle(markdown);
    const title = flag(args, "--title") ?? extracted.title ?? "";
    const body = flag(args, "--title") && extracted.title === null ? markdown : extracted.body;
    // Every local image the draft carries (body images, then the cover) is proofed too.
    const proofImages = collectImagePaths(body).map((p) => resolveRelative(p, dirname(proofPath)));
    const cover = flag(args, "--cover");
    if (cover) proofImages.push(resolveRelative(cover, process.cwd()));
    const proofText = articleProofText(title, body);
    const published = await publishDraft(id, { text: proofText, attachments: [...new Set(proofImages)] });
    if (json) console.log(JSON.stringify(published));
    else console.log(`Published: ${published.url}`);
    return;
  }

  usage();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
