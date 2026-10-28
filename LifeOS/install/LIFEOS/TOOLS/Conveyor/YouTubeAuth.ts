#!/usr/bin/env bun
/**
 * YouTubeAuth — mint the Conveyor YouTube OAuth refresh token (P0).
 *
 * Reuses the Google Desktop OAuth client (USER/CONFIG/CREDENTIALS/google/
 * client_secret.json), runs the loopback consent flow for the YouTube scopes,
 * verifies the token against channels.list(mine=true), and appends
 * YOUTUBE_OAUTH_REFRESH_TOKEN to ~/.claude/.env (backup written first).
 *
 * Hardening (LOSIntegrity t2a): the token endpoint is pinned to Google (the
 * client JSON's token_uri is only checked against the allowlist, never used as
 * a destination), the callback carries a single-use random `state` that is
 * verified before the code is exchanged, and the token is persisted only when
 * channels.list succeeds and the expected scopes were granted.
 *
 * Scopes: youtube.upload (uploads) + youtube (metadata, playlists).
 * Token values are never printed. Run: bun YouTubeAuth.ts
 */

import { copyFileSync, appendFileSync, readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { getClaudeDir, lifeosPath } from '../Paths'; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { invariant } from '../Invariant';

export const PINNED_OAUTH_EXCHANGE_URI = 'https://oauth2.googleapis.com/token';
/** Token URIs a Google Desktop client JSON legitimately carries. */
export const ALLOWED_TOKEN_URIS = new Set([
  'https://oauth2.googleapis.com/token',
  'https://accounts.google.com/o/oauth2/token',
]);
export const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
];

/** Return the pinned token endpoint, or throw when the client JSON names another origin. */
export function resolveTokenUri(configured: unknown): string {
  if (configured !== undefined && configured !== null && configured !== '') {
    if (typeof configured !== 'string' || !ALLOWED_TOKEN_URIS.has(configured)) {
      throw new Error('client_secret.json token_uri is not a Google token endpoint; refusing to send credentials');
    }
  }
  return PINNED_OAUTH_EXCHANGE_URI;
}

/** Fresh single-use anti-CSRF state. */
export function generateState(): string {
  return randomBytes(32).toString('hex');
}

/** Constant-time check that the callback state equals the one we issued. */
export function stateMatches(received: string | null | undefined, expected: string): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type ChannelCheck = { ok: true; id: string; title: string } | { ok: false; reason: string };

/** Credentials are persisted only when this returns ok. */
export function verifyChannel(chOk: boolean, ch: any, grantedScope: string | undefined): ChannelCheck {
  if (!chOk) return { ok: false, reason: `channels.list failed: ${JSON.stringify(ch?.error?.message ?? '')}` };
  const channel = ch?.items?.[0];
  const id = channel?.id;
  if (typeof id !== 'string' || !id) return { ok: false, reason: 'channels.list returned no channel' };
  const granted = new Set((grantedScope ?? '').split(/\s+/).filter(Boolean));
  const missing = REQUIRED_SCOPES.filter((s) => !granted.has(s));
  if (missing.length) return { ok: false, reason: `missing granted scopes: ${missing.join(', ')}` };
  return { ok: true, id, title: String(channel?.snippet?.title ?? 'UNKNOWN') };
}

/** Escape text interpolated into the HTML confirmation page. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function main(): Promise<void> {
  const CLIENT_PATH = lifeosPath('USER', 'CONFIG', 'CREDENTIALS', 'google', 'client_secret.json');
  const ENV_PATH = join(getClaudeDir(), '.env');
  const PORT = 8971;
  const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
  const SCOPES = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.force-ssl', // comments (commentThreads.insert) — added 2026-09-07
  ].join(' ');

  const client = JSON.parse(readFileSync(CLIENT_PATH, 'utf-8')).installed;
  if (!client?.client_id || !client?.client_secret) {
    console.error('[yt-auth] client_secret.json missing installed.client_id/secret');
    process.exit(1);
  }
  let tokenUri: string;
  try {
    tokenUri = resolveTokenUri(client.token_uri);
  } catch (e) {
    console.error(`[yt-auth] ${(e as Error).message}`);
    process.exit(1);
  }

  const state = generateState();
  let consumed = false; // state is single-use

  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    }).toString();

  console.log('[yt-auth] AUTH_URL_BEGIN');
  console.log(authUrl);
  console.log('[yt-auth] AUTH_URL_END');
  console.log(`[yt-auth] waiting for consent redirect on ${REDIRECT} …`);

  const server = Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/callback') return new Response('not found', { status: 404 });
      if (consumed || !stateMatches(url.searchParams.get('state'), state)) {
        console.error('[yt-auth] callback rejected: state missing, mismatched or already used');
        return new Response('Invalid state.', { status: 400 });
      }
      consumed = true;
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      if (err || !code) {
        console.error(`[yt-auth] consent failed: ${err ?? 'no code'}`);
        setTimeout(() => process.exit(1), 100);
        return new Response('Consent failed.', { status: 400 });
      }
      try {
        const tokenResp = await fetch(tokenUri, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: client.client_id,
            client_secret: client.client_secret,
            redirect_uri: REDIRECT,
            grant_type: 'authorization_code',
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        });
        const tok = (await tokenResp.json()) as Record<string, string>;
        if (!tokenResp.ok || !tok.refresh_token) {
          console.error(`[yt-auth] token exchange failed (${tokenResp.status}): ${JSON.stringify({ ...tok, access_token: '…', refresh_token: '…' })}`);
          setTimeout(() => process.exit(1), 100);
          return new Response('Token exchange failed — see terminal.', { status: 500 });
        }

        // Verify: whose channel is this, and do we hold the upload scope?
        const chResp = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
          headers: { Authorization: `Bearer ${tok.access_token}` },
          signal: AbortSignal.timeout(30000),
        });
        const ch = (await chResp.json()) as any;
        const check = verifyChannel(chResp.ok, ch, tok.scope);
        if (!check.ok) {
          console.error(`[yt-auth] verification failed, token NOT saved: ${check.reason}`);
          setTimeout(() => process.exit(1), 100);
          return new Response('Verification failed — token not saved. See terminal.', { status: 500 });
        }
        const { id, title } = check;
        console.log(`[yt-auth] CHANNEL: ${title} (${id})`);
        console.log(`[yt-auth] SCOPES GRANTED: ${tok.scope}`);

        invariant(id && tok.refresh_token, 'YouTubeAuth: persisting a token requires a verified channel and refresh token');
        copyFileSync(ENV_PATH, `${ENV_PATH}.bak-ytauth`);
        appendFileSync(
          ENV_PATH,
          `\n# Conveyor YouTube leg (minted ${new Date().toISOString()}, gws Desktop client, channel ${id})\nYOUTUBE_OAUTH_REFRESH_TOKEN=${tok.refresh_token}\n`,
        );
        console.log(`[yt-auth] refresh token appended to ${ENV_PATH} (backup at .env.bak-ytauth)`);
        console.log('[yt-auth] SUCCESS');
        setTimeout(() => { server.stop(); process.exit(0); }, 200);
        return new Response(
          `<html><body style="font-family:monospace;background:#0c0f14;color:#3ddc84;padding:40px"><h2>Conveyor ✓</h2><p>YouTube credential minted for: <b>${esc(title)}</b></p><p>You can close this tab.</p></body></html>`,
          { headers: { 'Content-Type': 'text/html' } },
        );
      } catch (e) {
        console.error(`[yt-auth] error: ${e}`);
        setTimeout(() => process.exit(1), 100);
        return new Response('Error — see terminal.', { status: 500 });
      }
    },
  });
}

if (import.meta.main) await main();
