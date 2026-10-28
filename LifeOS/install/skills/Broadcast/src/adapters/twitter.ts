/**
 * Broadcast - Twitter/X Adapter
 *
 * Delegates ALL posting — text and media — to the X skill's Tools/post.ts, which
 * runs on OAuth 2.0 user context from the X skill's configured token store
 * (`tweet.write` + `media.write`; skills/X/Setup.md). With no store configured,
 * post.ts falls back to the OAuth 1.0a env keys for text only; media always needs
 * the OAuth 2.0 grant.
 *
 * One auth path for text and media means one failure mode: X can revoke OAuth 1.0a
 * keys without notice, and a split path posts text while media silently fails.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { BaseAdapter } from './base';
import { hasXOAuth1Keys, hasXOAuth2Store } from '../config';
import type { Platform, PostResult, MediaAttachment } from '../types';
import { assertValidTweetText } from '../../../X/Tools/TwitterText';
import { API_BASE, oauth1Fetch, oauth2Fetch } from '../../../X/Tools/x-client';

/** The public X skill's tools, resolved from this file so a relocated install still finds them. */
const X_TOOLS = join(import.meta.dir, '..', '..', '..', 'X', 'Tools');

export function createTwitterPostSpec(content: string, media?: MediaAttachment[]) {
  const text = assertValidTweetText(content);
  return [{ text, ...(media?.length ? { media: media.map((m) => m.filePath) } : {}) }];
}

export class TwitterAdapter extends BaseAdapter {
  readonly name: Platform = 'twitter';
  readonly maxLength = 280;

  isConfigured(): boolean {
    return hasXOAuth2Store() || hasXOAuth1Keys(this.credentials);
  }

  async verifyCredentials(): Promise<boolean> {
    return !!(await this.getMe());
  }

  async post(content: string, media?: MediaAttachment[]): Promise<PostResult> {
    if (!this.isConfigured()) {
      return this.failure('Twitter credentials not configured');
    }
    if (media?.length && !hasXOAuth2Store()) {
      return this.failure("Media posting needs the X skill's OAuth 2.0 token store; the OAuth 1.0a keys post text only. See skills/X/Setup.md.");
    }

    let spec: ReturnType<typeof createTwitterPostSpec>;
    try {
      spec = createTwitterPostSpec(content, media);
    } catch (error: any) {
      return this.failure(error?.message || 'Invalid Twitter text');
    }

    for (const file of spec[0].media ?? []) {
      if (!existsSync(file)) return this.failure(`Media file not found: ${file}`);
    }

    try {
      // Broadcast already ran the video PII gate in executePost; tell post.ts not to scan again.
      const proc = Bun.spawn(['bun', 'run', `${X_TOOLS}/post.ts`, '--pii-reviewed'], {
        stdin: new TextEncoder().encode(JSON.stringify(spec)),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return this.failure((stderr || stdout).trim() || 'Failed to post via X skill');
      }

      const urlMatch = stdout.match(/https:\/\/x\.com\/\S+/);
      const idMatch = stdout.match(/status\/(\d+)/);
      if (!idMatch) return this.failure(`Post reported success but returned no tweet id:\n${stdout.trim()}`);
      return this.success(idMatch[1], urlMatch?.[0] ?? `https://x.com/i/status/${idMatch[1]}`, content);
    } catch (error: any) {
      return this.failure(error?.message || 'Unknown error posting to Twitter');
    }
  }

  /**
   * The account behind whichever auth path posting will use: the OAuth 2.0 store
   * when one is configured, else the OAuth 1.0a fallback keys. Null when neither
   * verifies, so `status` reports X as configured but failing verification.
   */
  async getMe(): Promise<{ id: string; username: string; name: string } | null> {
    try {
      const url = `${API_BASE}/users/me`;
      // oauth1Fetch exits the process when its keys are missing, so it is reached only with all four present.
      let me: any;
      if (hasXOAuth2Store()) me = await oauth2Fetch(url);
      else if (hasXOAuth1Keys(this.credentials)) me = await oauth1Fetch(url, 'GET');
      else return null;
      const data = me?.data;
      if (typeof data?.id !== 'string' || typeof data?.username !== 'string') return null;
      return { id: data.id, username: data.username, name: typeof data.name === 'string' ? data.name : data.username };
    } catch {
      return null;
    }
  }
}
