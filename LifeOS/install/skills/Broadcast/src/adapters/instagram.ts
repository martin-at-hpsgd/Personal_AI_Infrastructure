/**
 * Broadcast - Instagram Adapter
 *
 * Uses the "Instagram API with Instagram Login" content-publishing flow
 * (host graph.instagram.com, no Facebook Page required). Publishing to your
 * OWN professional (Creator/Business) account runs under Standard Access —
 * no App Review.
 *
 * Flow (two-step, plus a status poll for video):
 *   1. POST /{ig-user-id}/media       -> creates a media container (creation_id)
 *   2. (video/Reels) poll GET /{container}?fields=status_code until FINISHED
 *   3. POST /{ig-user-id}/media_publish creation_id={container}
 *
 * KEY DEVIATION from the other adapters: Instagram will not take a binary
 * upload for photos. Media must be at a PUBLIC URL that Meta fetches. We stage
 * to R2 (utils/r2-stage), pass the URL, then delete it after publish.
 *
 * API docs: https://developers.facebook.com/docs/instagram-platform/content-publishing/
 */

import { unlinkSync } from 'fs';
import { BaseAdapter } from './base';
import { ensureJpeg } from '../utils/media';
import { stageMedia, type StagedMedia } from '../utils/r2-stage';
import type { Platform, PostResult, InstagramCredentials, MediaAttachment } from '../types';

const GRAPH = 'https://graph.instagram.com/v21.0';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

interface StagedItem {
  url: string;
  isVideo: boolean;
  cleanup: () => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class InstagramAdapter extends BaseAdapter {
  readonly name: Platform = 'instagram';
  readonly maxLength = 2200;

  isConfigured(): boolean {
    const c = this.credentials.instagram;
    return !!(c?.accessToken && c?.igUserId);
  }

  private creds(): InstagramCredentials {
    return this.credentials.instagram as InstagramCredentials;
  }

  async verifyCredentials(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const c = this.creds();
      const res = await fetch(
        `${GRAPH}/${c.igUserId}?fields=user_id,username&access_token=${c.accessToken}`
      );
      return res.ok;
    } catch (error) {
      console.error('Instagram credential verification failed:', error);
      return false;
    }
  }

  async post(content: string, media?: MediaAttachment[]): Promise<PostResult> {
    if (!this.isConfigured()) {
      return this.failure('Instagram credentials not configured (run Tools/InstagramAuth.ts)');
    }
    if (!media?.length) {
      return this.failure('Instagram requires at least one image or video (no text-only posts)');
    }
    if (media.length > 10) {
      return this.failure('Instagram carousel supports at most 10 items');
    }

    const caption = this.truncate(content);

    try {
      if (media.length === 1) {
        return await this.postSingle(caption, media[0]);
      }
      return await this.postCarousel(caption, media);
    } catch (error: any) {
      return this.failure(error?.message || 'Unknown error posting to Instagram');
    }
  }

  /** Stage one attachment to a public URL, JPEG-converting images first. */
  private async stageItem(att: MediaAttachment): Promise<StagedItem> {
    const isVideo = att.type === 'video';
    let sourcePath = att.filePath;
    let tmpJpeg: string | null = null;

    if (!isVideo) {
      const jpeg = await ensureJpeg(att.filePath);
      if (jpeg !== att.filePath) {
        tmpJpeg = jpeg;
      }
      sourcePath = jpeg;
    }

    const staged: StagedMedia = await stageMedia(sourcePath);

    return {
      url: staged.url,
      isVideo,
      cleanup: async () => {
        await staged.cleanup();
        if (tmpJpeg) {
          try {
            unlinkSync(tmpJpeg);
          } catch {
            /* temp file already gone */
          }
        }
      },
    };
  }

  private async createContainer(params: Record<string, string>): Promise<string> {
    const c = this.creds();
    const body = new URLSearchParams({ ...params, access_token: c.accessToken });
    const res = await fetch(`${GRAPH}/${c.igUserId}/media`, { method: 'POST', body });
    const data = (await res.json()) as { id?: string; error?: unknown };
    if (!res.ok || !data.id) {
      throw new Error(`Instagram container create failed: ${JSON.stringify(data.error ?? data)}`);
    }
    return data.id;
  }

  /** Poll a video/Reels container until FINISHED. */
  private async waitForContainer(containerId: string): Promise<void> {
    const c = this.creds();
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await fetch(
        `${GRAPH}/${containerId}?fields=status_code&access_token=${c.accessToken}`
      );
      const data = (await res.json()) as { status_code?: string };
      const status = data.status_code;
      if (status === 'FINISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') {
        throw new Error(`Instagram container status: ${status}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('Instagram container processing timed out');
  }

  private async publishContainer(caption: string, creationId: string): Promise<PostResult> {
    const c = this.creds();
    const body = new URLSearchParams({ creation_id: creationId, access_token: c.accessToken });
    const res = await fetch(`${GRAPH}/${c.igUserId}/media_publish`, { method: 'POST', body });
    const data = (await res.json()) as { id?: string; error?: unknown };
    if (!res.ok || !data.id) {
      throw new Error(`Instagram publish failed: ${JSON.stringify(data.error ?? data)}`);
    }

    // Resolve the human-facing permalink (not derivable from the media id).
    let postUrl = 'https://www.instagram.com/';
    try {
      const p = await fetch(`${GRAPH}/${data.id}?fields=permalink&access_token=${c.accessToken}`);
      const pd = (await p.json()) as { permalink?: string };
      if (pd.permalink) postUrl = pd.permalink;
    } catch {
      /* permalink is a nicety, not required for success */
    }

    return this.success(data.id, postUrl, caption);
  }

  private async postSingle(caption: string, att: MediaAttachment): Promise<PostResult> {
    const item = await this.stageItem(att);
    try {
      const params: Record<string, string> = { caption };
      if (item.isVideo) {
        params.media_type = 'REELS';
        params.video_url = item.url;
      } else {
        params.image_url = item.url;
      }

      const containerId = await this.createContainer(params);
      // Images need this too: Meta fetches the media from the staged URL
      // asynchronously, and publishing before status FINISHED fails with
      // code 9007 "Media ID is not available".
      await this.waitForContainer(containerId);
      return await this.publishContainer(caption, containerId);
    } finally {
      await item.cleanup();
    }
  }

  private async postCarousel(caption: string, media: MediaAttachment[]): Promise<PostResult> {
    // Stage every item before settling: if one staging rejects after others uploaded, the uploaded ones are public
    // objects and must be cleaned up before the error propagates.
    const staged = await Promise.allSettled(media.map((m) => this.stageItem(m)));
    const items = staged.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    const failed = staged.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failed) {
      await Promise.allSettled(items.map((item) => item.cleanup()));
      throw failed.reason;
    }
    try {
      // 1. Create a child container per item.
      const childIds: string[] = [];
      for (const item of items) {
        const params: Record<string, string> = { is_carousel_item: 'true' };
        if (item.isVideo) {
          params.media_type = 'REELS';
          params.video_url = item.url;
        } else {
          params.image_url = item.url;
        }
        childIds.push(await this.createContainer(params));
      }

      // 2. Wait on every child to finish processing — images too: Meta fetches
      // media from the staged URL asynchronously, and referencing an unready
      // child fails with code 9007, single-image posts included.
      for (let i = 0; i < items.length; i++) {
        await this.waitForContainer(childIds[i]);
      }

      // 3. Create the parent carousel container, then publish it.
      const parentId = await this.createContainer({
        media_type: 'CAROUSEL',
        children: childIds.join(','),
        caption,
      });
      await this.waitForContainer(parentId);
      return await this.publishContainer(caption, parentId);
    } finally {
      await Promise.all(items.map((item) => item.cleanup()));
    }
  }

  /** Query the current publishing quota (Meta docs disagree 50 vs 100 — read it live). */
  async getPublishingLimit(): Promise<{ used: number; total: number } | null> {
    if (!this.isConfigured()) return null;
    try {
      const c = this.creds();
      const res = await fetch(
        `${GRAPH}/${c.igUserId}/content_publishing_limit?fields=quota_usage,config&access_token=${c.accessToken}`
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }>;
      };
      const row = data.data?.[0];
      if (!row) return null;
      return { used: row.quota_usage ?? 0, total: row.config?.quota_total ?? 0 };
    } catch {
      return null;
    }
  }

  /** Authenticated account info (for the status command). */
  async getMe(): Promise<{ id: string; username: string } | null> {
    if (!this.isConfigured()) return null;
    try {
      const c = this.creds();
      const res = await fetch(
        `${GRAPH}/${c.igUserId}?fields=user_id,username&access_token=${c.accessToken}`
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { user_id?: string; username?: string };
      return { id: data.user_id || c.igUserId, username: data.username || 'unknown' };
    } catch {
      return null;
    }
  }
}
