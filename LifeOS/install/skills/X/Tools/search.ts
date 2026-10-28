#!/usr/bin/env bun

/**
 * X Search — Search tweets via API v2 (recent search).
 *
 * Usage:
 *   bun run search.ts "AI agents"
 *   bun run search.ts "from:<username>" --count 50
 *   bun run search.ts "#cybersecurity" --count 10
 */

import { bearerFetch, API_BASE } from "./x-client";

async function searchTweets(query: string, maxResults = 10): Promise<any[]> {
  const url = new URL(`${API_BASE}/tweets/search/recent`);
  url.searchParams.set("query", query);
  url.searchParams.set("max_results", String(Math.min(Math.max(maxResults, 10), 100)));
  url.searchParams.set("tweet.fields", "created_at,author_id,text,entities,public_metrics");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username,name,verified");

  const data = await bearerFetch(url.toString());
  const users = new Map((data.includes?.users || []).map((u: any) => [u.id, u]));

  return (data.data || []).map((tweet: any) => {
    const author = users.get(tweet.author_id);
    return {
      id: tweet.id,
      text: tweet.text,
      author: author ? `@${author.username}` : tweet.author_id,
      author_name: author?.name,
      created_at: tweet.created_at,
      url: `https://x.com/${author?.username || "i"}/status/${tweet.id}`,
      metrics: tweet.public_metrics,
      urls: tweet.entities?.urls?.map((u: any) => u.expanded_url).filter(Boolean) || [],
    };
  });
}

// --- Main ---

/** Splits argv into the query words and the --count value; the flag and its value never leak into the query. */
export function parseSearchArgs(args: string[]): { query: string; count: number } {
  const countIdx = args.indexOf("--count");
  const count = countIdx >= 0 ? parseInt(args[countIdx + 1] || "10") : 10;
  const query = args.filter((_, i) => countIdx < 0 || (i !== countIdx && i !== countIdx + 1)).join(" ");
  return { query, count };
}

if (import.meta.main) {
  const { query, count } = parseSearchArgs(process.argv.slice(2));

  if (!query) {
    console.log("Usage: bun run search.ts \"query\" [--count N]");
    console.log("Examples:");
    console.log("  bun run search.ts \"AI agents\"");
    console.log("  bun run search.ts \"from:<username>\" --count 50");
    console.log("  bun run search.ts \"#cybersecurity\" --count 10");
    process.exit(0);
  }

  try {
    const tweets = await searchTweets(query, count);
    console.log(`\nFound ${tweets.length} tweets for: ${query}\n`);
    for (const t of tweets) {
      console.log(`  ${t.author}: ${t.text.slice(0, 100)}${t.text.length > 100 ? "..." : ""}`);
      console.log(`  ${t.url}`);
      if (t.metrics) console.log(`  Likes: ${t.metrics.like_count} | RT: ${t.metrics.retweet_count} | Replies: ${t.metrics.reply_count}`);
      console.log();
    }
  } catch (err: any) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
}
