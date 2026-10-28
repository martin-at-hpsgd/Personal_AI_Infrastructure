/**
 * Broadcast - Media Staging (public URL host)
 *
 * Instagram's Content Publishing API does NOT accept a binary upload for photos.
 * It fetches the media from a PUBLIC URL ("we cURL the media"). This module
 * stages a local file to a public host, hands back the URL, and exposes a
 * cleanup() to delete it after the post is published.
 *
 * The host is behind a swappable interface so a non-R2 backend can drop in later.
 * Default backend: Cloudflare R2 via the S3-compatible API (aws4fetch signing).
 */

import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';
import { join } from 'path';
import { getEnvPath } from '../../../../LIFEOS/TOOLS/Paths.ts';
import { AwsClient } from 'aws4fetch';
import { getMimeType } from './media';

export interface StagedMedia {
  /** Publicly fetchable URL Meta can cURL */
  url: string;
  /** Delete the staged object. Always call in a finally block. */
  cleanup: () => Promise<void>;
}

export interface MediaHost {
  stage(filePath: string): Promise<StagedMedia>;
}

/** Parse ~/.claude/.env into key/value pairs (no shell, no deps). */
function loadEnv(): Record<string, string> {
  const envPath = process.env.LIFEOS_CONFIG_DIR
    ? join(process.env.LIFEOS_CONFIG_DIR, '.env')
    : getEnvPath();
  const out: Record<string, string> = {};
  if (!existsSync(envPath)) return out;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Cloudflare R2 backend using the S3-compatible endpoint. */
class R2Host implements MediaHost {
  private accountId: string;
  private bucket: string;
  private publicBase: string;
  private client: AwsClient;

  constructor(env: Record<string, string>) {
    this.accountId = env.CLOUDFLARE_ACCOUNT_ID || '';
    this.bucket = env.BROADCAST_R2_BUCKET || '';
    this.publicBase = (env.BROADCAST_R2_PUBLIC_BASE || '').replace(/\/$/, '');
    const accessKeyId = env.R2_ACCESS_KEY_ID || '';
    const secretAccessKey = env.R2_SECRET_ACCESS_KEY || '';

    const missing = [
      ['CLOUDFLARE_ACCOUNT_ID', this.accountId],
      ['BROADCAST_R2_BUCKET', this.bucket],
      ['BROADCAST_R2_PUBLIC_BASE', this.publicBase],
      ['R2_ACCESS_KEY_ID', accessKeyId],
      ['R2_SECRET_ACCESS_KEY', secretAccessKey],
    ].filter(([, v]) => !v).map(([k]) => k);

    if (missing.length) {
      throw new Error(
        `Instagram media requires R2 staging — set ${missing.join(', ')} in ~/.claude/.env`
      );
    }

    this.client = new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: 's3',
      region: 'auto',
    });
  }

  async stage(filePath: string): Promise<StagedMedia> {
    const key = `broadcast/${Date.now()}-${crypto.randomUUID()}-${basename(filePath)}`;
    const endpoint = `https://${this.accountId}.r2.cloudflarestorage.com/${this.bucket}/${key}`;
    const body = readFileSync(filePath);

    const put = await this.client.fetch(endpoint, {
      method: 'PUT',
      body,
      headers: { 'Content-Type': getMimeType(filePath) },
    });

    if (!put.ok) {
      const text = await put.text();
      throw new Error(`R2 upload failed (${put.status}): ${text}`);
    }

    const url = `${this.publicBase}/${key}`;

    return {
      url,
      cleanup: async () => {
        // Never throws: cleanup runs in a finally, and a throw there would replace the post's own result. A failed
        // delete leaves the object publicly reachable at `url`, so it is reported with the URL to remove by hand.
        // 404 counts as deleted (already gone).
        let problem: string | null = null;
        try {
          const res = await this.client.fetch(endpoint, { method: 'DELETE' });
          if (!res.ok && res.status !== 404) problem = `HTTP ${res.status}`;
        } catch (err) {
          problem = (err as Error)?.message || String(err);
        }
        if (problem) {
          console.error(`⚠️  R2 staged media NOT deleted (${problem}); it is still public at ${url}. Delete ${key} from bucket ${this.bucket}.`);
        }
      },
    };
  }
}

/** Return the configured media host. Throws a clear error if unconfigured. */
export function getMediaHost(): MediaHost {
  return new R2Host(loadEnv());
}

/** Convenience: stage one file with the default host. */
export async function stageMedia(filePath: string): Promise<StagedMedia> {
  return getMediaHost().stage(filePath);
}

/** True if the media host has the env it needs (cheap pre-check for status/dry-run). */
export function isMediaHostConfigured(): boolean {
  const env = loadEnv();
  return !!(
    env.CLOUDFLARE_ACCOUNT_ID &&
    env.BROADCAST_R2_BUCKET &&
    env.BROADCAST_R2_PUBLIC_BASE &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY
  );
}
