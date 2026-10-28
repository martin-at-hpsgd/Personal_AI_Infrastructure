#!/usr/bin/env bun
/**
 * LinkedInAuth.ts — keep the Broadcast LinkedIn token alive without humans.
 *
 * LinkedIn facts this tool is built on (official docs):
 * - Standard apps (w_member_social / "Share on LinkedIn") NEVER get refresh_tokens —
 *   those are Marketing Developer Platform partners only.
 * - Access tokens live 60 days, hard, no long-lived option.
 * - Silent re-auth IS documented: re-running the authorization_code flow while
 *   (a) the member is logged into linkedin.com in the browser AND
 *   (b) the current token has NOT yet expired
 *   bypasses the consent screen — immediate 302 to redirect_uri with a fresh code.
 * - POST https://www.linkedin.com/oauth/v2/introspectToken (client_id, client_secret,
 *   token as form fields) returns { active, expires_at, scope } for real expiry.
 * - Scope changes invalidate everything and force full re-consent. Keep scope stable.
 *
 * Commands:
 *   status            Report token expiry (introspection if client creds, else stored metadata)
 *   login             Full interactive flow (one-time, or after a token fully lapses)
 *   renew             Silent re-auth: localhost listener + background browser hit, no clicks
 *   ensure [--days N] Renew if fewer than N days remain (default 14); notify on failure
 *
 * Env (in ~/.claude/.env): LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET
 * The app must have http://localhost:8917/callback registered as an authorized redirect URL.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { PULSE_BASE } from "../../../LIFEOS/PULSE/endpoint";
import { getDAName } from "../../../hooks/lib/identity";
import { getEnvPath } from "../../../LIFEOS/TOOLS/Paths";

const CREDS_PATH = join(homedir(), ".broadcast", "credentials.json");
// Same resolution as src/config.ts: LIFEOS_CONFIG_DIR, else the install's env file (honours CLAUDE_CONFIG_DIR).
const ENV_PATH = process.env.LIFEOS_CONFIG_DIR ? join(process.env.LIFEOS_CONFIG_DIR, ".env") : getEnvPath();
const PORT = 8917;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = "openid profile w_member_social"; // NEVER change casually — scope change kills all tokens
const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const INTROSPECT_URL = "https://www.linkedin.com/oauth/v2/introspectToken";

interface LinkedInCreds {
  accessToken: string;
  issuedAt?: string;
  expiresAt?: string;
  scope?: string;
}

async function loadEnv(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const text = await Bun.file(ENV_PATH).text();
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return out;
}

async function loadCreds(): Promise<Record<string, unknown>> {
  try {
    return await Bun.file(CREDS_PATH).json();
  } catch {
    return {};
  }
}

async function saveToken(accessToken: string, expiresInSec: number, scope: string) {
  const all = await loadCreds();
  const now = new Date();
  all.linkedin = {
    ...(all.linkedin as object ?? {}),
    accessToken,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresInSec * 1000).toISOString(),
    scope,
  } satisfies LinkedInCreds;
  await Bun.write(CREDS_PATH, JSON.stringify(all, null, 2));
  // Mirror into the env file (LINKEDIN_ACCESS_TOKEN) for outside tools that read the token from there; Broadcast
  // itself reads only credentials.json. A sealed env file (Secrets.ts) goes stale until it is re-sealed.
  try {
    let env = await Bun.file(ENV_PATH).text();
    if (/^LINKEDIN_ACCESS_TOKEN=/m.test(env)) {
      env = env.replace(/^LINKEDIN_ACCESS_TOKEN=.*$/m, () => `LINKEDIN_ACCESS_TOKEN=${accessToken}`);
    } else {
      env += `\nLINKEDIN_ACCESS_TOKEN=${accessToken}\n`;
    }
    await Bun.write(ENV_PATH, env);
  } catch {}
}

async function notify(message: string) {
  try {
    await fetch(`${PULSE_BASE}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
  } catch {}
}

async function introspect(env: Record<string, string>, token: string) {
  const res = await fetch(INTROSPECT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.LINKEDIN_CLIENT_ID,
      client_secret: env.LINKEDIN_CLIENT_SECRET,
      token,
    }),
  });
  if (!res.ok) throw new Error(`introspectToken HTTP ${res.status}`);
  return (await res.json()) as { active: boolean; expires_at?: number; scope?: string };
}

function daysLeft(expiresAtIso: string): number {
  return (new Date(expiresAtIso).getTime() - Date.now()) / 86400000;
}

async function getExpiry(env: Record<string, string>): Promise<{ expiresAt: string | null; source: string }> {
  const li = (await loadCreds()).linkedin as LinkedInCreds | undefined;
  if (!li?.accessToken) return { expiresAt: null, source: "no token stored" };
  // Introspection is authoritative when client creds exist
  if (env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET) {
    try {
      const info = await introspect(env, li.accessToken);
      if (!info.active) return { expiresAt: new Date(0).toISOString(), source: "introspection (inactive)" };
      if (info.expires_at) return { expiresAt: new Date(info.expires_at * 1000).toISOString(), source: "introspection" };
    } catch (e) {
      console.error(`introspection failed (${e}), falling back to stored metadata`);
    }
  }
  if (li.expiresAt) return { expiresAt: li.expiresAt, source: "stored metadata" };
  return { expiresAt: null, source: "legacy token — no expiry metadata (assume unknown, renew soon)" };
}

/** Start listener, fire browser at consent URL, capture code, exchange. */
async function runAuthFlow(env: Record<string, string>, opts: { background: boolean }): Promise<void> {
  if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET) {
    throw new Error(
      "LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET missing from ~/.claude/.env.\n" +
      "Get them from linkedin.com/developers → your app → Auth tab, and register\n" +
      `${REDIRECT_URI} as an authorized redirect URL.`
    );
  }
  const state = crypto.randomUUID();
  const url =
    `${AUTH_URL}?response_type=code&client_id=${encodeURIComponent(env.LINKEDIN_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}&scope=${encodeURIComponent(SCOPE)}`;

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.stop(true);
      reject(new Error("Timed out after 120s waiting for the OAuth redirect."));
    }, 120_000);
    const server = Bun.serve({
      port: PORT,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname !== "/callback") return new Response("not found", { status: 404 });
        if (u.searchParams.get("state") !== state) return new Response("state mismatch", { status: 400 });
        const err = u.searchParams.get("error");
        if (err) {
          clearTimeout(timeout);
          setTimeout(() => server.stop(true), 100);
          reject(new Error(`LinkedIn returned error: ${err} — ${u.searchParams.get("error_description")}`));
          return new Response(`Auth failed: ${err}. You can close this tab.`);
        }
        const c = u.searchParams.get("code");
        if (!c) return new Response("missing code", { status: 400 });
        clearTimeout(timeout);
        setTimeout(() => server.stop(true), 100);
        resolve(c);
        return new Response(`LinkedIn token renewed. You can close this tab. — ${getDAName()}`);
      },
    });
    // -g = don't steal focus. Uses default browser (where the LinkedIn session lives).
    const args = opts.background ? ["-g", url] : [url];
    spawn("open", args, { stdio: "ignore" }); // execFile-style arg array — no shell interpolation
    console.log(opts.background ? "Silent renew: browser hit fired in background..." : `Opened consent URL in browser...`);
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.LINKEDIN_CLIENT_ID,
      client_secret: env.LINKEDIN_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status} ${await res.text()}`);
  const tok = (await res.json()) as { access_token: string; expires_in: number; scope?: string };
  await saveToken(tok.access_token, tok.expires_in, tok.scope ?? SCOPE);
  const days = Math.round(tok.expires_in / 86400);
  console.log(`✅ New LinkedIn token stored (${days} days). credentials.json + .env updated.`);
}

const cmd = process.argv[2];
const env = await loadEnv();

switch (cmd) {
  case "status": {
    const { expiresAt, source } = await getExpiry(env);
    if (!expiresAt) {
      console.log(`LinkedIn token: UNKNOWN expiry (${source})`);
      process.exit(1);
    }
    const d = daysLeft(expiresAt);
    console.log(`LinkedIn token: ${d < 0 ? "EXPIRED" : `${d.toFixed(1)} days left`} (expires ${expiresAt}, via ${source})`);
    process.exit(d < 10 ? 1 : 0);
  }
  case "login":
    await runAuthFlow(env, { background: false });
    break;
  case "renew":
    await runAuthFlow(env, { background: true });
    break;
  case "ensure": {
    const threshold = Number(process.argv[process.argv.indexOf("--days") + 1]) || 14;
    const { expiresAt, source } = await getExpiry(env);
    const d = expiresAt ? daysLeft(expiresAt) : -1;
    if (expiresAt && d > threshold) {
      console.log(`Token healthy: ${d.toFixed(1)} days left (via ${source}). Nothing to do.`);
      break;
    }
    console.log(`Token ${d < 0 ? "expired/unknown" : `${d.toFixed(1)} days left`} — attempting silent renew...`);
    try {
      await runAuthFlow(env, { background: true });
      await notify("LinkedIn token silently renewed for another 60 days.");
    } catch (e) {
      // Silent renew only works while the OLD token is still valid + browser session alive.
      await notify("LinkedIn token renewal needs you: the silent path failed. Run the LinkedIn auth login command.");
      console.error(`Silent renew failed: ${e}\nFix: bun ~/.claude/skills/Broadcast/Tools/LinkedInAuth.ts login`);
      process.exit(1);
    }
    break;
  }
  default:
    console.log("Usage: LinkedInAuth.ts status | login | renew | ensure [--days N]");
    process.exit(cmd ? 1 : 0);
}
