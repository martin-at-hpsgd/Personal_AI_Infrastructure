#!/usr/bin/env bun

/**
 * X media upload — v2 chunked upload under OAuth 2.0 user context.
 *
 * Replaces the OAuth 1.0a v1.1 path (`twitter-api-v2`), whose portal keys can be
 * revoked without notice. The v2 endpoint needs the `media.write` scope on the
 * grant; without it POST /2/media/upload returns 403 while /2/tweets keeps
 * working, which reads as "media is broken" instead of "the grant is short a
 * scope".
 *
 * Token policy: tokens come from x-client.ts getValidTokens(), which is the only
 * code allowed to refresh a grant. Never call the token endpoint from here — a
 * second refresh chain trips X's reuse detection and revokes the whole grant.
 *
 * Usage:
 *   bun run media.ts upload <file> [--category tweet_video] [--json]
 *   bun run media.ts status <media_id>
 *
 * Importable:
 *   import { uploadMedia } from "./media";
 *   const mediaId = await uploadMedia("/path/clip.mp4");
 */

import { statSync, existsSync, openSync, readSync, closeSync } from "fs";
import { extname, resolve } from "path";
import { homedir } from "node:os";
import { getValidTokens } from "./x-client";

const UPLOAD_URL = "https://api.x.com/2/media/upload";
// X rejects APPEND segments over 5MB; 4MB keeps headroom for the form envelope.
const CHUNK_BYTES = 4 * 1024 * 1024;
const PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;

type Category = "tweet_video" | "tweet_image" | "tweet_gif" | "amplify_video" | "subtitles";

const MIME: Record<string, { type: string; category: Category }> = {
  ".mp4": { type: "video/mp4", category: "tweet_video" },
  ".mov": { type: "video/quicktime", category: "tweet_video" },
  ".m4v": { type: "video/mp4", category: "tweet_video" },
  ".webm": { type: "video/webm", category: "tweet_video" },
  ".jpg": { type: "image/jpeg", category: "tweet_image" },
  ".jpeg": { type: "image/jpeg", category: "tweet_image" },
  ".png": { type: "image/png", category: "tweet_image" },
  ".webp": { type: "image/webp", category: "tweet_image" },
  ".gif": { type: "image/gif", category: "tweet_gif" },
};

/**
 * v2 media endpoints are SUB-PATHS with typed bodies — not one endpoint taking a
 * `command` parameter (that is the retired v1.1 shape, and the docs' chunked
 * quickstart still describes it). Sending `command=INIT` to /2/media/upload gets
 * a 400 "Missing media field in JSON": the parameter is ignored and the call is
 * read as a simple upload.
 */
async function call(
  method: "GET" | "POST",
  path: string,
  body?: FormData | object,
  query?: Record<string, string>,
): Promise<any> {
  const tokens = await getValidTokens();
  const url = new URL(UPLOAD_URL + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      // FormData derives its own boundary — setting Content-Type breaks it.
      ...(body && !isForm ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(
        `X media upload 403 — the OAuth2 grant is missing the "media.write" scope ` +
          `(text posting works without it, which is why this looks like a media bug). ` +
          `Re-authorize once: bun ~/.claude/skills/X/Tools/bookmarks.ts authorize\n${text}`,
      );
    }
    throw new Error(`X media upload error (${res.status}) on ${method} ${path || "/"}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function readChunk(fd: number, index: number, size: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(size));
  readSync(fd, buf, 0, size, index * CHUNK_BYTES);
  return buf;
}

/** Uploads a file and returns its media_id, processed and ready to attach. */
export async function uploadMedia(
  filePath: string,
  category?: Category,
  log: (msg: string) => void = () => {},
): Promise<string> {
  const file = resolve(filePath.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? homedir()));  // USERPROFILE covers Windows, where HOME is unset
  if (!existsSync(file)) throw new Error(`media file not found: ${file}`);
  const bytes = statSync(file).size;
  if (bytes === 0) throw new Error(`media file is empty: ${file}`);

  const ext = extname(file).toLowerCase();
  const known = MIME[ext];
  if (!known) throw new Error(`unsupported media extension "${ext}" (${Object.keys(MIME).join(", ")})`);
  const mediaCategory = category ?? known.category;

  // Images under the chunk ceiling go up in one shot — no init/append/finalize. GIFs process asynchronously like
  // video, so they always take the chunked path, whose finalize reports processing_info to wait on.
  if (bytes <= CHUNK_BYTES && mediaCategory !== "tweet_video" && mediaCategory !== "amplify_video" && mediaCategory !== "tweet_gif") {
    const form = new FormData();
    form.set("media", new Blob([new Uint8Array(await Bun.file(file).arrayBuffer())]), "upload");
    form.set("media_category", mediaCategory);
    const res = await call("POST", "", form);
    const id: string | undefined = res?.data?.id;
    if (!id) throw new Error(`simple upload returned no media id: ${JSON.stringify(res)}`);
    log(`uploaded ${id} (${(bytes / 1024).toFixed(0)}KB ${mediaCategory})`);
    // A simple upload that still reports processing is waited on too, so the returned id is always ready to attach.
    await awaitProcessed(id, res?.data?.processing_info ?? res?.processing_info, log);
    return id;
  }

  // INITIALIZE
  const initRes = await call("POST", "/initialize", {
    media_type: known.type,
    total_bytes: bytes,
    media_category: mediaCategory,
  });
  const mediaId: string | undefined = initRes?.data?.id;
  if (!mediaId) throw new Error(`initialize returned no media id: ${JSON.stringify(initRes)}`);
  log(`initialize ${mediaId} (${(bytes / 1024 / 1024).toFixed(2)}MB ${mediaCategory})`);

  // APPEND
  const segments = Math.ceil(bytes / CHUNK_BYTES);
  const fd = openSync(file, "r");
  try {
    for (let i = 0; i < segments; i++) {
      const size = Math.min(CHUNK_BYTES, bytes - i * CHUNK_BYTES);
      const form = new FormData();
      form.set("segment_index", String(i));
      form.set("media", new Blob([readChunk(fd, i, size)]), "chunk");
      await call("POST", `/${mediaId}/append`, form);
      log(`append ${i + 1}/${segments}`);
    }
  } finally {
    closeSync(fd);
  }

  // FINALIZE
  const finRes = await call("POST", `/${mediaId}/finalize`);

  await awaitProcessed(mediaId, finRes?.data?.processing_info ?? finRes?.processing_info, log);
  log(`ready ${mediaId}`);
  return mediaId;
}

/**
 * Video and GIF uploads process asynchronously. Attaching an unprocessed
 * media_id publishes a tweet with no video, so wait for `succeeded`.
 * No processing_info means there is nothing to wait for.
 */
async function awaitProcessed(mediaId: string, initial: any, log: (msg: string) => void): Promise<void> {
  let info = initial;
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  while (info && info.state !== "succeeded") {
    if (info.state === "failed") {
      throw new Error(`X rejected the media during processing: ${JSON.stringify(info.error ?? info)}`);
    }
    if (Date.now() > deadline) throw new Error(`media ${mediaId} still ${info.state} after 10 minutes`);
    const wait = Math.max(1, Number(info.check_after_secs ?? 2));
    log(`processing ${info.state} (${info.progress_percent ?? 0}%) — checking again in ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    const statusRes = await mediaStatus(mediaId);
    info = statusRes?.data?.processing_info ?? statusRes?.processing_info;
    if (!info) break; // no processing_info once processing completes
  }
}

/**
 * The one place the v2 API still speaks the old dialect: status is a GET on the
 * base path taking `media_id` + `command=STATUS` (it rejects `media_ids`, and it
 * has no sub-path form).
 */
export async function mediaStatus(mediaId: string): Promise<any> {
  return call("GET", "", undefined, { media_id: mediaId, command: "STATUS" });
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const [cmd, arg] = rest;
  const catIdx = rest.indexOf("--category");
  const category = catIdx >= 0 ? (rest[catIdx + 1] as Category) : undefined;

  if (cmd === "upload" && arg) {
    const mediaId = await uploadMedia(arg, category, (m) => !json && console.log(`  ${m}`));
    console.log(json ? JSON.stringify({ media_id: mediaId }) : `media_id: ${mediaId}`);
    return;
  }
  if (cmd === "status" && arg) {
    console.log(JSON.stringify(await mediaStatus(arg), null, 2));
    return;
  }
  console.log("Usage: bun run media.ts upload <file> [--category tweet_video] [--json]");
  console.log("       bun run media.ts status <media_id>");
  process.exit(rest.length ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
