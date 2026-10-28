#!/usr/bin/env bun

/**
 * X Bookmarks — Fetch, manage, and authorize bookmark access.
 *
 * Usage:
 *   bun run bookmarks.ts authorize              — Run PKCE flow, store tokens
 *   bun run bookmarks.ts fetch [count]          — Fetch bookmarks (default 20, human output)
 *   bun run bookmarks.ts fetch [count] --json   — Fetch bookmarks, emit full JSON to stdout
 *   bun run bookmarks.ts fetch --json [count]   — Same, flag order flexible
 *   bun run bookmarks.ts test                   — Authorize if needed, then fetch 5
 *   bun run bookmarks.ts status                 — Config, store and grant check; exit 0 when ready
 */

import { randomBytes, createHash } from "crypto";
import {
  credentials,
  validateOAuth2,
  loadTokens,
  saveTokens,
  getValidTokens,
  assertTokenStoreConfigured,
  tokenStoreRefreshesItself,
  tokenStoreSummary,
  credentialPresence,
  type TokenData,
} from "./x-client";

const CALLBACK_PORT = 9876;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
// media.write is required by POST /2/media/upload — without it that endpoint 403s
// while /2/tweets still works, which reads as "media upload is broken" rather than
// "the grant is short a scope". Any re-auth must carry it.
const SCOPES = ["bookmark.read", "bookmark.write", "tweet.read", "tweet.write", "users.read", "media.write", "offline.access"];

function basicAuth(): string {
  return Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
}

// --- PKCE Authorization ---

async function authorize(): Promise<TokenData> {
  validateOAuth2();
  // Fail before opening a browser when there is nowhere to put the grant.
  assertTokenStoreConfigured();
  const codeVerifier = randomBytes(32).toString("base64url").replace(/[^A-Za-z0-9\-._~]/g, "").slice(0, 128);
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL("https://twitter.com/i/oauth2/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", credentials.clientId!);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  console.log("\nStarting OAuth 2.0 PKCE flow...");
  console.log(`\nOpen this URL:\n\n${authUrl.toString()}\n`);
  Bun.spawn(["open", authUrl.toString()]);

  const code = await new Promise<string>((resolve, reject) => {
    // The consent click is a human's and can take a while; a short wait expires
    // mid-task. Override with X_AUTHORIZE_TIMEOUT_S when needed.
    const waitSeconds = Number(process.env.X_AUTHORIZE_TIMEOUT_S ?? 600);
    const timeout = setTimeout(() => { server.stop(); reject(new Error(`Authorization timed out (${waitSeconds}s)`)); }, waitSeconds * 1000);
    const server = Bun.serve({
      port: CALLBACK_PORT,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
        const error = url.searchParams.get("error");
        if (error) { clearTimeout(timeout); server.stop(); reject(new Error(`Auth error: ${error}`)); return new Response(`Error: ${error}`, { headers: { "Content-Type": "text/html" } }); }
        if (url.searchParams.get("state") !== state) { clearTimeout(timeout); server.stop(); reject(new Error("State mismatch")); return new Response("State mismatch", { headers: { "Content-Type": "text/html" } }); }
        const c = url.searchParams.get("code");
        if (!c) { clearTimeout(timeout); server.stop(); reject(new Error("No code")); return new Response("No code", { headers: { "Content-Type": "text/html" } }); }
        clearTimeout(timeout);
        setTimeout(() => server.stop(), 500);
        resolve(c);
        return new Response("<h1>Authorized! Close this tab.</h1>", { headers: { "Content-Type": "text/html" } });
      },
    });
    console.log(`Listening on http://localhost:${CALLBACK_PORT}/callback`);
  });

  console.log("Exchanging code for tokens...");
  const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basicAuth()}` },
    body: new URLSearchParams({ code, grant_type: "authorization_code", client_id: credentials.clientId!, redirect_uri: REDIRECT_URI, code_verifier: codeVerifier }),
  });

  if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status}): ${await tokenRes.text()}`);
  const data = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number };

  const tokens: TokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  const meRes = await fetch("https://api.twitter.com/2/users/me", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (meRes.ok) {
    const me = (await meRes.json()) as { data: { id: string; username: string } };
    tokens.user_id = me.data.id;
    console.log(`Authenticated as @${me.data.username} (ID: ${me.data.id})`);
  }

  await saveTokens(tokens);
  return tokens;
}

// --- Fetch Bookmarks ---

/** One bookmark as callers read it. A long post's full text lives in `note_tweet`; `text` is then only its preview. */
export function toBookmark(tweet: any, users: Map<string, any>) {
  const author = users.get(tweet.author_id);
  const urls = [...(tweet.note_tweet?.entities?.urls ?? []), ...(tweet.entities?.urls ?? [])].map((u: any) => u.expanded_url).filter(Boolean);
  return {
    id: tweet.id,
    text: tweet.note_tweet?.text ?? tweet.text,
    author: author ? `@${author.username}` : tweet.author_id,
    author_name: author?.name,
    created_at: tweet.created_at,
    url: `https://x.com/${author?.username || "i"}/status/${tweet.id}`,
    metrics: tweet.public_metrics,
    urls: [...new Set(urls)],
  };
}

export type BookmarkDeps = { fetchFn?: typeof fetch; tokens?: { access_token: string; user_id?: string } };

/** Fetches up to `maxResults` bookmarks, newest first, paging 100 at a time (the API's per-request cap). */
export async function fetchBookmarks(maxResults = 20, deps: BookmarkDeps = {}): Promise<{ bookmarks: any[]; meta: any }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const tokens = deps.tokens ?? (await getValidTokens());

  if (!tokens.user_id) {
    const meRes = await fetchFn("https://api.twitter.com/2/users/me", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!meRes.ok) throw new Error(`Failed to get user ID (${meRes.status}): ${await meRes.text()}`);
    // In-memory only — writing back here could clobber a refresh token another
    // process rotated after our read.
    tokens.user_id = ((await meRes.json()) as { data: { id: string } }).data.id;
  }

  console.error(`Fetching up to ${maxResults} bookmarks...`);
  const bookmarks: any[] = [];
  let nextToken: string | undefined;
  do {
    const url = new URL(`https://api.twitter.com/2/users/${tokens.user_id}/bookmarks`);
    url.searchParams.set("max_results", String(Math.min(maxResults - bookmarks.length, 100)));
    url.searchParams.set("tweet.fields", "created_at,author_id,text,entities,public_metrics,note_tweet");
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "username,name");
    if (nextToken) url.searchParams.set("pagination_token", nextToken);

    const res = await fetchFn(url.toString(), { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!res.ok) throw new Error(`Bookmarks fetch failed (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as { data?: any[]; includes?: { users?: any[] }; meta?: { next_token?: string } };
    const users = new Map((data.includes?.users || []).map((u: any) => [u.id, u]));
    for (const tweet of data.data || []) bookmarks.push(toBookmark(tweet, users));
    nextToken = data.data?.length ? data.meta?.next_token : undefined;
  } while (nextToken && bookmarks.length < maxResults);

  const page = bookmarks.slice(0, maxResults);
  return { bookmarks: page, meta: { result_count: page.length, ...(nextToken ? { next_token: nextToken } : {}) } };
}

// --- Main ---

const command = process.argv[2] || "test";

// The CLI runs only when executed; importing the module for fetchBookmarks runs nothing.
if (import.meta.main) try {
  switch (command) {
    case "authorize": {
      await authorize();
      console.log("\nAuthorization complete.");
      break;
    }
    case "fetch": {
      // Parse fetch args: support `fetch 50 --json`, `fetch --json 50`, `fetch --json`
      const fetchArgs = process.argv.slice(3);
      const jsonFlag = fetchArgs.includes("--json");
      const countArg = fetchArgs.find((a) => !a.startsWith("-") && /^\d+$/.test(a));
      const count = countArg ? parseInt(countArg, 10) : 20;

      const { bookmarks, meta } = await fetchBookmarks(count);

      if (jsonFlag) {
        // Clean JSON to stdout — no human lines mixed in
        process.stdout.write(JSON.stringify(bookmarks, null, 2) + "\n");
      } else {
        console.log(`\nFetched ${bookmarks.length} bookmarks\n`);
        for (const b of bookmarks) {
          console.log(`  ${b.author}: ${b.text.slice(0, 80)}...`);
          console.log(`  ${b.url}`);
          if (b.urls.length) console.log(`  Links: ${b.urls.join(", ")}`);
          console.log();
        }
        if (meta?.result_count !== undefined) console.log(`Total: ${meta.result_count}`);
      }
      break;
    }
    case "test": {
      const existing = await loadTokens();
      // A self-refreshing (local) store renews an expired token in getValidTokens();
      // an externally refreshed store with an expired token needs a fresh grant.
      if (!existing || (!tokenStoreRefreshesItself() && Date.now() > existing.expires_at)) {
        console.log("No valid tokens, starting authorization...");
        await authorize();
      } else {
        console.log(`Found valid tokens (expires ${new Date(existing.expires_at).toISOString()})`);
      }
      const { bookmarks } = await fetchBookmarks(5);
      console.log(`\nTest OK — fetched ${bookmarks.length} bookmarks\n`);
      for (const b of bookmarks) {
        console.log(`  ${b.author}: ${b.text.slice(0, 100)}...`);
        console.log(`  ${b.url}\n`);
      }
      break;
    }
    case "status": {
      // Names and states only; never prints a token or key value.
      const summary = tokenStoreSummary();
      const creds = credentialPresence();
      console.log(`config:      ${summary.configPath} (${summary.kind ? "found" : "MISSING — see skills/X/Setup.md"})`);
      console.log(`token store: ${summary.kind ?? "none"}${summary.where ? ` (${summary.where})` : ""}`);
      for (const [k, present] of Object.entries(creds)) console.log(`env ${k}: ${present ? "set" : "missing"}`);
      let ready = Boolean(summary.kind) && creds.TWITTER_CLIENT_ID && creds.TWITTER_CLIENT_SECRET && creds.X_BEARER_TOKEN;
      if (summary.kind) {
        const grant = await loadTokens();
        if (!grant) {
          console.log("grant:       none — run: bun ~/.claude/skills/X/Tools/bookmarks.ts authorize");
          ready = false;
        } else {
          const expired = Date.now() > grant.expires_at;
          const renews = tokenStoreRefreshesItself();
          console.log(`grant:       present, access token ${expired ? "expired" : "valid"} until ${new Date(grant.expires_at).toISOString()}${renews ? " (renewed locally on next use)" : ""}`);
          if (expired && !renews) ready = false;
        }
      }
      console.log(ready ? "READY" : "NOT READY");
      process.exit(ready ? 0 : 1);
    }
    case "--help":
    case "help":
      console.log([
        "Usage: bun run bookmarks.ts <command> [options]",
        "",
        "Commands:",
        "  authorize              Run PKCE flow, store tokens",
        "  fetch [count] [--json] Fetch bookmarks (default count: 20)",
        "                         --json  Print full bookmark objects as JSON to stdout",
        "                                 (flag may appear before or after count)",
        "  test                   Authorize if needed, then fetch 5 bookmarks",
        "  status                 Check config, env keys and grant; exit 0 when ready",
        "  help, --help           Show this message",
      ].join("\n"));
      break;
    default:
      console.log("Usage: bun run bookmarks.ts [authorize|fetch|test|status|help] [count] [--json]");
  }
} catch (err: any) {
  console.error(`\n${err.message}`);
  if (err.message.includes("No stored")) console.log("   Run: bun run bookmarks.ts authorize");
  process.exit(1);
}
