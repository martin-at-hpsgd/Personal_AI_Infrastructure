#!/usr/bin/env bun
/**
 * GoogleAdsAuth — mint the Google Ads OAuth refresh token for YouTubePromote.ts.
 *
 * Reuses the Google Desktop OAuth client (USER/CONFIG/CREDENTIALS/google/
 * client_secret.json), runs the loopback consent flow for the `adwords` scope,
 * and appends GOOGLE_ADS_REFRESH_TOKEN to the canonical env file (backup first).
 *
 * The consent request carries a fresh random single-use `state`; the callback
 * is accepted only when it echoes that state, so a page in the browser cannot
 * push an attacker's authorization code through the loopback listener
 * (login CSRF).
 *
 * This is independent of the developer token: the grant can be minted now and
 * the developer token added whenever Google approves it. Values are never printed.
 *
 * Run:  bun LIFEOS/TOOLS/GoogleAdsAuth.ts
 * Then: bun LIFEOS/TOOLS/Secrets.ts seal
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getClaudeDir, lifeosPath } from "./Paths";

const PORT = 8973;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = "https://www.googleapis.com/auth/adwords";

/** A fresh, unguessable, single-use OAuth `state` value. */
export function newOAuthState(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Single-use state check for the callback. True exactly once per issued state: the
 * `consumed` set remembers spent values, so a replayed callback is refused.
 */
export function acceptCallbackState(expected: string, received: string | null, consumed: Set<string>): boolean {
  if (!expected || !received || consumed.has(expected)) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  consumed.add(expected);
  return true;
}

/** The one place the authorization code and client secret may be sent. */
export const GOOGLE_OAUTH_EXCHANGE_URL = "https://oauth2.googleapis.com/token";

/**
 * The token endpoint to use, given the credential file's `token_uri`. That file is
 * data, so a planted or edited value would receive the code and client secret; the
 * endpoint is pinned and anything other than Google's exact HTTPS URL is refused
 *. An absent value means the pinned endpoint.
 */
export function tokenEndpointFor(configured: unknown): string {
  if (configured === undefined || configured === null) return GOOGLE_OAUTH_EXCHANGE_URL;
  if (typeof configured !== "string") throw new Error("client_secret.json token_uri is not a string");
  let u: URL;
  try { u = new URL(configured); } catch { throw new Error("client_secret.json token_uri is not a URL"); }
  const pinned = new URL(GOOGLE_OAUTH_EXCHANGE_URL);
  if (u.protocol !== pinned.protocol || u.host !== pinned.host || u.pathname !== pinned.pathname || u.search || u.hash || u.username || u.password) {
    throw new Error(`client_secret.json token_uri is not ${GOOGLE_OAUTH_EXCHANGE_URL}; refusing to send the client secret there`);
  }
  return GOOGLE_OAUTH_EXCHANGE_URL;
}

export function buildAuthUrl(clientId: string, state: string): string {
  return (
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString()
  );
}

function main(): void {
  const CLIENT_PATH = lifeosPath("USER", "CONFIG", "CREDENTIALS", "google", "client_secret.json");
  const TARGET = join(getClaudeDir(), ".env");

  const client = JSON.parse(readFileSync(CLIENT_PATH, "utf-8")).installed;
  if (!client?.client_id || !client?.client_secret) {
    console.error("[ads-auth] client_secret.json missing installed.client_id/secret");
    process.exit(1);
  }

  let tokenEndpoint: string;
  try {
    tokenEndpoint = tokenEndpointFor(client.token_uri);
  } catch (e) {
    console.error(`[ads-auth] ${(e as Error).message}`);
    process.exit(1);
  }

  const state = newOAuthState();
  const consumed = new Set<string>();
  const authUrl = buildAuthUrl(client.client_id, state);

  console.log("[ads-auth] AUTH_URL_BEGIN");
  console.log(authUrl);
  console.log("[ads-auth] AUTH_URL_END");
  console.log(`[ads-auth] waiting for consent redirect on ${REDIRECT} ...`);

  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
      // Refuse before looking at the code: a callback that does not echo our state is not ours.
      // The listener keeps waiting, so a forged hit cannot cancel the real consent.
      if (!acceptCallbackState(state, url.searchParams.get("state"), consumed)) {
        console.error("[ads-auth] callback rejected: state missing, wrong or already used");
        return new Response("Invalid state.", { status: 400 });
      }
      const code = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      if (err || !code) {
        console.error(`[ads-auth] consent failed: ${err ?? "no code"}`);
        setTimeout(() => process.exit(1), 100);
        return new Response(`Consent failed: ${err ?? "no code"}`, { status: 400 });
      }
      try {
        const resp = await fetch(tokenEndpoint, {
          method: "POST",
          // A redirect would carry the code and secret to wherever it points.
          redirect: "error",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: client.client_id,
            client_secret: client.client_secret,
            redirect_uri: REDIRECT,
            grant_type: "authorization_code",
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const tok = (await resp.json()) as Record<string, string>;
        if (!resp.ok || !tok.refresh_token) {
          console.error(`[ads-auth] token exchange failed (${resp.status})`);
          setTimeout(() => process.exit(1), 100);
          return new Response("Token exchange failed - see terminal.", { status: 500 });
        }
        console.log(`[ads-auth] SCOPES GRANTED: ${tok.scope}`);
        copyFileSync(TARGET, `${TARGET}.bak-adsauth`);
        appendFileSync(
          TARGET,
          `\n# Google Ads leg for YouTubePromote (minted ${new Date().toISOString()})\nGOOGLE_ADS_REFRESH_TOKEN=${tok.refresh_token}\n`,
        );
        console.log("[ads-auth] refresh token appended (backup written alongside)");
        console.log("[ads-auth] still needed: GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CUSTOMER_ID,");
        console.log("[ads-auth]               GOOGLE_ADS_LOGIN_CUSTOMER_ID");
        console.log("[ads-auth] then: bun LIFEOS/TOOLS/Secrets.ts seal");
        console.log("[ads-auth] SUCCESS");
        setTimeout(() => {
          server.stop();
          process.exit(0);
        }, 200);
        return new Response(
          `<html><body style="font-family:monospace;background:#0c0f14;color:#3ddc84;padding:40px"><h2>Google Ads &#10003;</h2><p>Refresh token minted. You can close this tab.</p></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        );
      } catch (e) {
        console.error(`[ads-auth] error: ${e}`);
        setTimeout(() => process.exit(1), 100);
        return new Response("Error - see terminal.", { status: 500 });
      }
    },
  });
}

if (import.meta.main) main();
