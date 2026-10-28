#!/usr/bin/env bun

/**
 * Post to X — single tweets, threads, media, quotes, replies.
 *
 * Auth: OAuth 2.0 user context from the configured token store (x-client.ts;
 * `tweet.write`, media needs `media.write`) with OAuth 1.0a as a text-only
 * fallback when no store is configured. OAuth1 keys are portal-managed and can
 * be revoked without notice, so they are not the primary path.
 *
 * Usage:
 *   bun run post.ts "Your tweet"
 *   bun run post.ts "Tweet 1" "Tweet 2" "Tweet 3"        # thread
 *   bun run post.ts "Watch this" --media clip.mp4         # video/image post
 *   bun run post.ts "My take" --quote 1234567890          # quote tweet
 *   bun run post.ts "Reply text" --reply-to 1234567890    # reply
 *   echo '["Tweet 1", "Tweet 2"]' | bun run post.ts       # thread from stdin
 *   echo '[{"text":"Hook","media":["clip.mp4"]},{"text":"Article: …"}]' | bun run post.ts
 *   bun run post.ts --dry-run "Test tweet"                # validate only
 *
 * The JSON-spec form is what composed posts use (media on tweet 1, a link or
 * handoff on tweet 2).
 */

import { oauth1Fetch, oauth2Fetch, loadTokens, API_BASE } from "./x-client";
import { uploadMedia } from "./media";
import { isVideoFile, videoPiiGate } from "../../../LIFEOS/TOOLS/VideoPiiGate";
import { existsSync, statSync, readFileSync } from "fs";
import { createHash } from "node:crypto";
import { resolve } from "path";
import { formatBlocked, gatedTransmit, type GateDeps } from "../../../LIFEOS/TOOLS/lib/SendGate.ts";
import { homedir } from "node:os";

const HOME_DIR = process.env.HOME ?? process.env.USERPROFILE ?? homedir();  // USERPROFILE covers Windows, where HOME is unset
import { assertValidTweetText, getTweetWeightedLength, MAX_LONG_POST_LENGTH } from "./TwitterText";

interface TweetSpec {
  text: string;
  media?: string[];
}

async function resolveHandle(): Promise<string> {
  try {
    const me = await oauth2Fetch(`${API_BASE}/users/me`);
    return me?.data?.username ?? "i";
  } catch {
    return "i"; // x.com/i/status/<id> still resolves
  }
}

type TransmitOpts = {
  replyToId?: string; quoteId?: string; long?: boolean;
  transmit?: (body: any) => Promise<{ id: string; text: string }>;
  /** Test seam: replaces the media upload (receives the file path it would upload). */
  uploadFn?: (file: string) => Promise<string>;
  /** Test seam: runs after the gate and before the upload (a tamper after the proof). */
  afterGate?: () => void;
};

/**
 * Posts one tweet through the send gate. The video PII gate is the entry point's job, run once before the first
 * tweet so a refusal never half-posts a thread: main() below and Broadcast's post and article commands each call
 * videoPiiGate first. A new importer that attaches video does the same before calling this.
 */
export async function postTweet(
  spec: TweetSpec,
  opts: TransmitOpts & { gate?: GateDeps } = {},
): Promise<{ id: string; text: string }> {
  assertValidTweetText(spec.text, opts.long ? MAX_LONG_POST_LENGTH : undefined);
  // ISC-11: the proof of the exact text and each media file sits here, before any byte reaches X (media upload included),
  // so it holds for every caller of this function.
  const mediaFiles = (spec.media ?? []).map((m) => resolve(m.replace(/^~/, HOME_DIR)));
  const sent = await gatedTransmit(
    { channel: "x", destination: "publish", body: spec.text, recipientClass: "x", attachments: mediaFiles },
    (g) => {
      opts.afterGate?.();
      // Upload from the proofed copies the gate holds, never from the caller's paths: a file edited after the proof is
      // not what reaches X. Each copy is re-hashed against the gate's sha as the last check before the upload.
      const proofed = g.items.filter((i) => i.role === "attachment");
      if (proofed.length !== mediaFiles.length) throw new Error("gate returned a different media set than was asked; nothing sent");
      for (const p of proofed) if (createHash("sha256").update(readFileSync(p.file)).digest("hex") !== p.sha256) throw new Error("proofed media copy changed; nothing sent");
      return transmitTweet(spec, proofed.map((p) => p.file), opts);
    },
    opts.gate,
    { skill: "X" },
  );
  if (!sent.ok) throw new Error(formatBlocked(sent, "x"));
  for (const fl of sent.gate.flags) console.error(`unearned flag, not blocking: ${fl.check}: ${String(fl.message).replace(/\s+/g, " ").slice(0, 160)}`);
  return sent.result;
}

async function transmitTweet(
  spec: TweetSpec,
  proofedMedia: string[],
  opts: TransmitOpts,
): Promise<{ id: string; text: string }> {
  const body: any = { text: spec.text };
  if (opts.replyToId) body.reply = { in_reply_to_tweet_id: opts.replyToId };
  if (opts.quoteId) body.quote_tweet_id = opts.quoteId;
  if (opts.transmit && !opts.uploadFn) return opts.transmit(body);

  if (proofedMedia.length) {
    const ids: string[] = [];
    for (const [i, file] of proofedMedia.entries()) {
      console.log(`  Uploading ${spec.media?.[i] ?? file} (proofed copy)...`);
      ids.push(await (opts.uploadFn ?? ((f: string) => uploadMedia(f, undefined, (m) => console.log(`    ${m}`))))(file));
    }
    body.media = { media_ids: ids.slice(0, 4) };
  }
  if (opts.transmit) return opts.transmit(body);

  // Media requires the OAuth2 grant — the OAuth1 fallback has no working media
  // path, so never silently drop attachments by falling through to it.
  if (await loadTokens()) {
    const data = await oauth2Fetch(`${API_BASE}/tweets`, "POST", body);
    return data.data;
  }
  if (body.media) throw new Error("Media posting requires the OAuth2 grant; no token store is configured or it holds no grant. See skills/X/Setup.md.");
  const data = await oauth1Fetch(`${API_BASE}/tweets`, "POST", body);
  return data.data;
}

async function postThread(
  specs: TweetSpec[],
  opts: { replyToId?: string; quoteId?: string; long?: boolean },
): Promise<Array<{ id: string; text: string; url: string }>> {
  const handle = await resolveHandle();
  const results: Array<{ id: string; text: string; url: string }> = [];
  let replyToId = opts.replyToId;

  for (let i = 0; i < specs.length; i++) {
    console.log(`\nPosting tweet ${i + 1}/${specs.length}...`);
    const result = await postTweet(specs[i], {
      replyToId,
      long: opts.long,
      quoteId: i === 0 ? opts.quoteId : undefined,
    });
    const url = `https://x.com/${handle}/status/${result.id}`;
    results.push({ id: result.id, text: result.text, url });
    console.log(`  Posted: ${url}`);
    replyToId = result.id;
    if (i < specs.length - 1) await new Promise((r) => setTimeout(r, 1000));
  }
  return results;
}

function normalize(entry: unknown): TweetSpec {
  if (typeof entry === "string") return { text: entry };
  if (entry && typeof entry === "object") {
    const o = entry as any;
    if (typeof o.text !== "string") throw new Error(`spec entry has no "text": ${JSON.stringify(entry)}`);
    const media = o.media ? (Array.isArray(o.media) ? o.media : [o.media]) : undefined;
    return { text: o.text, media };
  }
  throw new Error(`unusable spec entry: ${JSON.stringify(entry)}`);
}

// --- Main ---

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  // X Premium long post (up to 25k weighted chars). The API enforces the real
  // entitlement server-side; without Premium the request fails closed.
  const longPost = argv.includes("--long");

  const flagValue = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const replyToId = flagValue("--reply-to");
  const quoteId = flagValue("--quote");
  const mediaFlag = flagValue("--media");

  // Video PII gate (LIFEOS/TOOLS/VideoPiiGate.ts): every video attachment is scanned
  // before anything is sent. Findings stop the post until a human re-runs with
  // --pii-reviewed; --skip-pii (scanner down, never routine) passes only for bytes the principal has
  // authorized with `VideoPiiGate.ts approve-skip --reason`.
  const piiReviewed = argv.includes("--pii-reviewed");
  const skipPii = argv.includes("--skip-pii");

  const consumed = new Set<string>(["--dry-run", "--long", "--pii-reviewed", "--skip-pii"]);
  for (const f of ["--reply-to", "--quote", "--media"]) {
    const i = argv.indexOf(f);
    if (i >= 0) { consumed.add(argv[i]); consumed.add(argv[i + 1]); }
  }
  const positional = argv.filter((a) => !consumed.has(a));

  // An unknown flag is never tweet text: `post.ts --help` once posted "--help" live.
  const unknownFlag = positional.find((a) => /^-{1,2}[a-z]/i.test(a));
  if (unknownFlag) {
    console.error(`Unknown flag ${unknownFlag}; nothing posted. Run with no arguments for usage.`);
    process.exit(unknownFlag === "--help" || unknownFlag === "-h" ? 0 : 1);
  }

  let specs: TweetSpec[] = positional.map((t) => normalize(t));

  // stdin JSON: array of strings, array of {text,media}, or a single object
  if (specs.length === 0 && !(Bun.stdin as any).isTTY) {
    const stdin = await Bun.stdin.text();
    if (stdin.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdin);
      } catch {
        console.error("Invalid JSON from stdin");
        process.exit(1);
      }
      specs = (Array.isArray(parsed) ? parsed : [parsed]).map(normalize);
    }
  }

  if (specs.length === 0) {
    console.log('Usage: bun run post.ts "Your tweet"');
    console.log('       bun run post.ts "Tweet 1" "Tweet 2"                    # thread');
    console.log('       bun run post.ts "Watch" --media clip.mp4               # with media');
    console.log('       bun run post.ts "Take" --quote <id> | --reply-to <id>');
    console.log('       echo \'[{"text":"Hook","media":["clip.mp4"]}]\' | bun run post.ts');
    console.log('       bun run post.ts --dry-run "Test"                       # validate only');
    console.log('       --pii-reviewed   acknowledge video PII-gate findings · --skip-pii  bypass the scan (needs a VideoPiiGate approve-skip authorization)');
    process.exit(0);
  }

  // --media attaches to the first tweet (the JSON spec form is per-tweet)
  if (mediaFlag) {
    specs[0].media = [...(specs[0].media ?? []), ...mediaFlag.split(",").map((s) => s.trim()).filter(Boolean)];
  }

  // Validate everything before anything is sent — a half-posted thread with a
  // missing video is worse than a refusal.
  for (let i = 0; i < specs.length; i++) {
    const { text, media } = specs[i];
    const weightedLength = getTweetWeightedLength(text);
    const cap = longPost ? MAX_LONG_POST_LENGTH : 280;
    try {
      assertValidTweetText(text, longPost ? MAX_LONG_POST_LENGTH : undefined);
    } catch {
      console.error(`Tweet ${i + 1} exceeds X weighted length (${weightedLength}/${cap}); text was not modified${longPost ? "" : " (Premium long post: add --long)"}`);
      process.exit(1);
    }
    for (const m of media ?? []) {
      const p = resolve(m.replace(/^~/, HOME_DIR));
      if (!existsSync(p)) {
        console.error(`Tweet ${i + 1} media not found: ${p}`);
        process.exit(1);
      }
      if ((media ?? []).length > 4) {
        console.error(`Tweet ${i + 1} has ${media!.length} media files (max 4)`);
        process.exit(1);
      }
    }
    if (dryRun) {
      const mediaNote = media?.length
        ? ` + ${media.map((m) => `${m} (${(statSync(resolve(m.replace(/^~/, HOME_DIR))).size / 1024 / 1024).toFixed(2)}MB)`).join(", ")}`
        : "";
      const rel = i === 0 && quoteId ? ` [quotes ${quoteId}]` : i === 0 && replyToId ? ` [replies to ${replyToId}]` : "";
      console.log(`[${i + 1}/${specs.length}] ${weightedLength}/${cap} weighted chars${rel}:
${text}${mediaNote}`);
    }
  }

  // PII gate on every video attachment — runs in dry-run too (it IS validation). isVideoFile, the gate's own test,
  // also catches a video under an unlisted extension, so no attachment the gate would scan is filtered out here.
  const videoFiles = specs.flatMap((s) => s.media ?? []).map((m) => resolve(m.replace(/^~/, HOME_DIR))).filter(isVideoFile);
  if (videoFiles.length) {
    const gate = await videoPiiGate(videoFiles, { reviewed: piiReviewed, skip: skipPii });
    if (!gate.ok) process.exit(1);
  }

  if (dryRun) {
    console.log("\nDry run — all tweets valid. No posts sent.");
    return;
  }

  const results = await postThread(specs, { replyToId, quoteId, long: longPost });
  console.log(`\nPosted ${results.length === 1 ? "tweet" : `thread (${results.length} tweets)`}:`);
  for (const r of results) console.log(`  ${r.url}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
