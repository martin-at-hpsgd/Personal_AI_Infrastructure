#!/usr/bin/env bun

/**
 * X Read — Read a tweet by ID or URL via API v2.
 *
 * Usage:
 *   bun run read.ts 1234567890
 *   bun run read.ts https://x.com/user/status/1234567890
 */

import { bearerFetch, API_BASE } from "./x-client";

function extractTweetId(input: string): string {
  const urlMatch = input.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  if (/^\d+$/.test(input)) return input;
  if (/(?:twitter\.com|x\.com)\/i\/article\//.test(input)) {
    throw new Error(`Cannot parse tweet ID from: ${input} (an x.com/i/article/ link is an article ID; pass the status URL of the post that carries it)`);
  }
  throw new Error(`Cannot parse tweet ID from: ${input}`);
}

async function readTweet(tweetId: string) {
  const url = new URL(`${API_BASE}/tweets/${tweetId}`);
  // article + note_tweet are REQUIRED: an X "article" link (x.com/i/article/...) carries no body
  // in tweet.text — the full prose lives in tweet.article.plain_text. note_tweet holds the full
  // text of long (>280 char) tweets. Without these fields a read returns only the bare link,
  // which is the failure that sends readers bouncing to WebFetch/Interceptor (both blocked by X).
  url.searchParams.set("tweet.fields", "created_at,author_id,text,entities,public_metrics,conversation_id,in_reply_to_user_id,article,note_tweet");
  url.searchParams.set("expansions", "author_id,referenced_tweets.id");
  url.searchParams.set("user.fields", "username,name,verified");

  const data = await bearerFetch(url.toString());
  if (!data.data) throw new Error(`Tweet not found: ${tweetId}`);

  const tweet = data.data;
  const users = new Map<string, any>((data.includes?.users || []).map((u: any) => [u.id, u]));
  const author = users.get(tweet.author_id);

  console.log(`\n${author ? `@${author.username}` : tweet.author_id}: ${tweet.text}`);
  console.log(`\nURL: https://x.com/${author?.username || "i"}/status/${tweet.id}`);
  console.log(`Posted: ${tweet.created_at}`);
  if (tweet.public_metrics) {
    const m = tweet.public_metrics;
    console.log(`Likes: ${m.like_count} | RT: ${m.retweet_count} | Replies: ${m.reply_count} | Views: ${m.impression_count || "N/A"}`);
  }
  if (tweet.entities?.urls?.length) {
    console.log(`\nLinks:`);
    for (const u of tweet.entities.urls) {
      if (u.expanded_url) console.log(`  ${u.expanded_url}`);
    }
  }

  // Long-form tweet (>280 chars): the full text is in note_tweet, not text.
  if (tweet.note_tweet?.text && tweet.note_tweet.text !== tweet.text) {
    console.log(`\n=== FULL TEXT (note_tweet) ===\n${tweet.note_tweet.text}`);
  }

  // X Article: the prose lives in article.plain_text — this is the body of any
  // x.com/i/article/... link. Printing it is the whole point of reading the post.
  if (tweet.article) {
    if (tweet.article.title) console.log(`\n=== ARTICLE: ${tweet.article.title} ===`);
    if (tweet.article.plain_text) {
      console.log(`\n${tweet.article.plain_text}`);
    } else {
      console.log(`\n(article has no plain_text — likely an embedded card, not native X article)`);
    }
  }

  // Check for thread (same conversation_id, same author)
  if (tweet.conversation_id && tweet.conversation_id !== tweet.id) {
    console.log(`\nPart of thread: conversation ${tweet.conversation_id}`);
  }

  return { tweet, author };
}

// --- Main ---

const input = process.argv[2];

if (!input || input === "--help") {
  console.log("Usage: bun run read.ts <tweet_id_or_url>");
  console.log("Examples:");
  console.log("  bun run read.ts 1234567890");
  console.log("  bun run read.ts https://x.com/user/status/1234567890");
  process.exit(0);
}

try {
  const tweetId = extractTweetId(input);
  await readTweet(tweetId);
} catch (err: any) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
