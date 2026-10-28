/**
 * Broadcast - Configuration Loading
 *
 * Loads credentials from:
 * 1. the LifeOS env file (`$LIFEOS_CONFIG_DIR/.env`, else `~/.claude/.env`): the X OAuth 1.0a
 *    fallback keys. X posting itself runs on the X skill's OAuth 2.0 token store.
 * 2. ~/.broadcast/credentials.json (LinkedIn, Bluesky, Instagram)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Credentials, TwitterCredentials, BlueskyCredentials, LinkedInCredentials, InstagramCredentials } from './types';
import { hasOAuth2Store } from '../../X/Tools/x-client';
import { getEnvPath } from '../../../LIFEOS/TOOLS/Paths';

const CLAUDE_ENV_PATH = process.env.LIFEOS_CONFIG_DIR ? join(process.env.LIFEOS_CONFIG_DIR, '.env') : getEnvPath();
const BROADCAST_CREDS_PATH = join(homedir(), '.broadcast', 'credentials.json');

/**
 * Parse .env file content into key-value pairs
 */
function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) {
      const [, key, value] = match;
      result[key] = value.trim();
    }
  }
  return result;
}

/**
 * Load the X OAuth 1.0a fallback keys from the LifeOS env file
 */
function loadTwitterCredentials(): TwitterCredentials | undefined {
  if (!existsSync(CLAUDE_ENV_PATH)) {
    return undefined;
  }

  try {
    const content = readFileSync(CLAUDE_ENV_PATH, 'utf-8');
    const env = parseEnv(content);

    const apiKey = env.TWITTER_API_KEY;
    const apiKeySecret = env.TWITTER_API_KEY_SECRET;
    const accessToken = env.X_ACCESS_TOKEN;
    const accessTokenSecret = env.X_ACCESS_TOKEN_SECRET;
    const bearerToken = env.X_BEARER_TOKEN;

    if (!apiKey || !apiKeySecret || !accessToken || !accessTokenSecret) {
      return undefined;
    }

    return {
      apiKey,
      apiKeySecret,
      accessToken,
      accessTokenSecret,
      bearerToken,
    };
  } catch {
    return undefined;
  }
}

/**
 * Load other platform credentials from ~/.broadcast/credentials.json
 */
function loadBroadcastCredentials(): Partial<Credentials> {
  if (!existsSync(BROADCAST_CREDS_PATH)) {
    return {};
  }

  try {
    const content = readFileSync(BROADCAST_CREDS_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Save credentials to ~/.broadcast/credentials.json
 */
export function saveCredentials(creds: Partial<Credentials>): void {
  const { mkdirSync, writeFileSync } = require('fs');
  const dir = join(homedir(), '.broadcast');

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Load existing and merge
  const existing = loadBroadcastCredentials();
  const merged = { ...existing, ...creds };

  writeFileSync(BROADCAST_CREDS_PATH, JSON.stringify(merged, null, 2));
}

/**
 * Load all credentials from all sources
 */
export function loadCredentials(): Credentials {
  const twitter = loadTwitterCredentials();
  const broadcast = loadBroadcastCredentials();

  return {
    twitter,
    linkedin: broadcast.linkedin as LinkedInCredentials | undefined,
    bluesky: broadcast.bluesky as BlueskyCredentials | undefined,
    instagram: broadcast.instagram as InstagramCredentials | undefined,
  };
}

/**
 * X posting runs on the X skill's OAuth 2.0 token store. Where that store lives
 * (a local file, or a Cloudflare KV namespace another process refreshes) is the
 * X skill's own Config.md (skills/X/Setup.md); Broadcast only asks whether one is
 * configured. OAuth 1.0a env keys are a text-only fallback: X can revoke them
 * without notice, so their presence alone never makes media posting "configured".
 *
 * A Config.md that exists but is broken makes the X client throw. That is reported
 * once on stderr with the X client's own message, and X counts as not configured.
 */
let xStoreWarned = false;
export function hasXOAuth2Store(): boolean {
  try {
    return hasOAuth2Store();
  } catch (error) {
    if (!xStoreWarned) {
      xStoreWarned = true;
      console.error(`⚠️  X token store config is broken: ${(error as Error).message}`);
    }
    return false;
  }
}

/** True when the OAuth 1.0a text-only fallback keys are all present. */
export function hasXOAuth1Keys(creds: Credentials): boolean {
  const t = creds.twitter;
  return !!(t?.apiKey && t?.apiKeySecret && t?.accessToken && t?.accessTokenSecret);
}

export function isPlatformConfigured(platform: string, creds: Credentials): boolean {
  switch (platform) {
    case 'twitter':
      return hasXOAuth2Store() || hasXOAuth1Keys(creds);
    case 'linkedin':
      return !!creds.linkedin?.accessToken;
    case 'bluesky':
      return !!creds.bluesky?.identifier && !!creds.bluesky?.password;
    case 'instagram':
      return !!creds.instagram?.accessToken && !!creds.instagram?.igUserId;
    default:
      return false;
  }
}
