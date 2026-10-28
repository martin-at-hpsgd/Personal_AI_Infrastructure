#!/usr/bin/env bun

/**
 * Delete tweets by ID.
 *
 * Auth: OAuth 2.0 user context (`tweet.write`) from the configured token
 * store (x-client.ts) — the same grant post.ts uses.
 *
 * Usage:
 *   bun run delete.ts <tweet_id> [<tweet_id> ...]
 *   bun run delete.ts --dry-run <tweet_id>
 *
 * X returns {"deleted": true} for a tweet it removed, and 404s for one that is
 * already gone or was never yours — both mean "not on the timeline", so a 404
 * is reported, not thrown.
 */

import { oauth2Fetch, API_BASE } from "./x-client";

export async function deleteTweet(id: string): Promise<{ id: string; deleted: boolean; note?: string }> {
  try {
    const res = await oauth2Fetch(`${API_BASE}/tweets/${id}`, "DELETE");
    return { id, deleted: Boolean(res?.data?.deleted) };
  } catch (err: any) {
    if (/\(404\)/.test(err?.message ?? "")) return { id, deleted: false, note: "not found (already gone, or not yours)" };
    throw err;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const ids = args.filter((a) => !a.startsWith("--"));

  if (ids.length === 0) {
    console.log("Usage: bun run delete.ts <tweet_id> [<tweet_id> ...]");
    process.exit(0);
  }
  if (ids.some((id) => !/^\d+$/.test(id))) {
    console.error("Tweet ids are numeric — pass ids, not URLs");
    process.exit(1);
  }

  if (dryRun) {
    for (const id of ids) console.log(`would delete https://x.com/i/status/${id}`);
    return;
  }

  let failures = 0;
  for (const id of ids) {
    const r = await deleteTweet(id);
    console.log(`${id}: ${r.deleted ? "deleted" : `NOT deleted — ${r.note ?? "X reported deleted=false"}`}`);
    if (!r.deleted) failures++;
  }
  if (failures) process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
