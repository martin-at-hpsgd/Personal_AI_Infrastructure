#!/usr/bin/env bun
/**
 * InstagramAuth - one-time OAuth + token refresh for the Broadcast Instagram adapter.
 *
 * Instagram publishing uses "Instagram API with Instagram Login" (host
 * graph.instagram.com, NO Facebook Page). Posting to your OWN professional
 * (Creator/Business) account runs under Standard Access — no App Review.
 *
 * ── ONE-TIME META APP SETUP (do this once) ──────────────────────────────────
 * 1. Convert your Instagram account to Creator or Business (Instagram app →
 *    Settings → Account type). Personal accounts cannot publish via API.
 * 2. Create a Meta app at https://developers.facebook.com/apps (type: Business).
 * 3. Add the product "Instagram" → "API setup with Instagram login".
 * 4. Under "Business login settings" set an OAuth redirect URI. For a local
 *    CLI, https://localhost/ is fine — you only need to read the ?code= back
 *    out of the redirected URL.
 * 5. Note your Instagram app ID and app secret (Instagram → API setup).
 * 6. Add your own IG account as an app tester/role and accept the invite.
 *
 * ── ENV (in ~/.claude/.env) ─────────────────────────────────────────────────
 *   INSTAGRAM_APP_ID=...
 *   INSTAGRAM_APP_SECRET=...
 *   INSTAGRAM_REDIRECT_URI=https://localhost/      (must match the app setting)
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   bun InstagramAuth.ts url                 # print the consent URL to open
 *   bun InstagramAuth.ts exchange --code X   # exchange the ?code= for a token
 *   bun InstagramAuth.ts refresh             # refresh the 60-day token
 *   bun InstagramAuth.ts status              # show stored token + expiry
 *
 * Scopes requested: instagram_business_basic, instagram_business_content_publish.
 * Token is written to ~/.broadcast/credentials.json under `instagram`.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getEnvPath } from '../../../LIFEOS/TOOLS/Paths.ts';
import { homedir } from 'os';

const SCOPES = 'instagram_business_basic,instagram_business_content_publish';
const CREDS_PATH = join(homedir(), '.broadcast', 'credentials.json');

function loadEnv(): Record<string, string> {
  const envPath = process.env.LIFEOS_CONFIG_DIR
    ? join(process.env.LIFEOS_CONFIG_DIR, '.env')
    : getEnvPath();
  const out: Record<string, string> = {};
  if (!existsSync(envPath)) return out;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function requireEnv(env: Record<string, string>, keys: string[]): void {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`❌ Missing in ~/.claude/.env: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function loadCreds(): Record<string, unknown> {
  if (!existsSync(CREDS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CREDS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveInstagram(instagram: { accessToken: string; igUserId: string; expiresAt: number }): void {
  const dir = join(homedir(), '.broadcast');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const merged = { ...loadCreds(), instagram };
  writeFileSync(CREDS_PATH, JSON.stringify(merged, null, 2));
}

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function cmdUrl(): Promise<void> {
  const env = loadEnv();
  requireEnv(env, ['INSTAGRAM_APP_ID', 'INSTAGRAM_REDIRECT_URI']);
  const url =
    `https://www.instagram.com/oauth/authorize?` +
    new URLSearchParams({
      client_id: env.INSTAGRAM_APP_ID,
      redirect_uri: env.INSTAGRAM_REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES,
    }).toString();
  console.log('\nOpen this URL, approve, then copy the `code` param from the redirected URL:\n');
  console.log(url);
  console.log('\nThen run:  bun InstagramAuth.ts exchange --code THE_CODE\n');
}

async function cmdExchange(): Promise<void> {
  const env = loadEnv();
  requireEnv(env, ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET', 'INSTAGRAM_REDIRECT_URI']);
  let code = getFlag('code');
  if (!code) {
    console.error('❌ Pass --code (strip any trailing #_ from the redirected URL)');
    process.exit(1);
  }
  code = code.replace(/#_$/, '');

  // 1. code -> short-lived token (+ user_id)
  const shortRes = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.INSTAGRAM_APP_ID,
      client_secret: env.INSTAGRAM_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: env.INSTAGRAM_REDIRECT_URI,
      code,
    }),
  });
  const shortData = (await shortRes.json()) as { access_token?: string; user_id?: string | number; error_message?: string };
  if (!shortRes.ok || !shortData.access_token) {
    console.error(`❌ Code exchange failed: ${JSON.stringify(shortData)}`);
    process.exit(1);
  }

  // 2. short-lived -> long-lived (60 days)
  const longRes = await fetch(
    `https://graph.instagram.com/access_token?` +
      new URLSearchParams({
        grant_type: 'ig_exchange_token',
        client_secret: env.INSTAGRAM_APP_SECRET,
        access_token: shortData.access_token,
      }).toString()
  );
  const longData = (await longRes.json()) as { access_token?: string; expires_in?: number };
  if (!longRes.ok || !longData.access_token) {
    console.error(`❌ Long-lived exchange failed: ${JSON.stringify(longData)}`);
    process.exit(1);
  }

  const expiresAt = Date.now() + (longData.expires_in ?? 60 * 24 * 3600) * 1000;
  // The code-exchange user_id cannot be trusted (observed off-by-one vs the real node).
  // Resolve the canonical IG professional-account id from /me; fall back if it fails.
  let igUserId = String(shortData.user_id);
  const meRes = await fetch(
    `https://graph.instagram.com/v21.0/me?fields=user_id&access_token=${longData.access_token}`
  );
  const meData = (await meRes.json()) as { user_id?: string | number };
  if (meRes.ok && meData.user_id) igUserId = String(meData.user_id);
  saveInstagram({ accessToken: longData.access_token, igUserId, expiresAt });
  console.log(`✅ Instagram token saved. igUserId=${igUserId}, expires ${new Date(expiresAt).toISOString()}`);
}

async function cmdRefresh(): Promise<void> {
  const creds = loadCreds().instagram as { accessToken?: string; igUserId?: string } | undefined;
  if (!creds?.accessToken || !creds.igUserId) {
    console.error('❌ No Instagram token stored yet. Run `exchange` first.');
    process.exit(1);
  }
  const res = await fetch(
    `https://graph.instagram.com/refresh_access_token?` +
      new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: creds.accessToken }).toString()
  );
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !data.access_token) {
    console.error(`❌ Refresh failed (token may be <24h old or expired): ${JSON.stringify(data)}`);
    process.exit(1);
  }
  const expiresAt = Date.now() + (data.expires_in ?? 60 * 24 * 3600) * 1000;
  saveInstagram({ accessToken: data.access_token, igUserId: creds.igUserId, expiresAt });
  console.log(`✅ Token refreshed. Expires ${new Date(expiresAt).toISOString()}`);
}

async function cmdStatus(): Promise<void> {
  const creds = loadCreds().instagram as { igUserId?: string; expiresAt?: number } | undefined;
  if (!creds?.igUserId) {
    console.log('❌ Instagram not configured. Run `url` then `exchange`.');
    return;
  }
  const exp = creds.expiresAt ? new Date(creds.expiresAt).toISOString() : 'unknown';
  const daysLeft = creds.expiresAt ? Math.round((creds.expiresAt - Date.now()) / 86400000) : '?';
  console.log(`✅ Instagram configured. igUserId=${creds.igUserId}, expires ${exp} (${daysLeft} days left)`);
}

async function cmdEnsure(): Promise<void> {
  const creds = loadCreds().instagram as { expiresAt?: number } | undefined;
  if (!creds?.expiresAt) {
    console.error('❌ No Instagram token stored yet. Run `exchange` first.');
    process.exit(1);
  }
  const daysLeft = (creds.expiresAt - Date.now()) / 86400000;
  if (daysLeft > 14) {
    console.log(`✅ Token healthy (${Math.round(daysLeft)} days left) — no refresh needed.`);
    return;
  }
  await cmdRefresh();
}

const cmd = process.argv[2];
const handlers: Record<string, () => Promise<void>> = {
  url: cmdUrl,
  exchange: cmdExchange,
  refresh: cmdRefresh,
  ensure: cmdEnsure,
  status: cmdStatus,
};

const handler = handlers[cmd];
if (!handler) {
  console.log('Usage: bun InstagramAuth.ts <url|exchange|refresh|ensure|status> [--code CODE]');
  process.exit(cmd ? 1 : 0);
}
handler().catch((e) => {
  console.error(`❌ ${e?.message || e}`);
  process.exit(1);
});
