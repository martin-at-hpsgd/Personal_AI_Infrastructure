/**
 * Broadcast - Bluesky Adapter
 *
 * Uses @atproto/api official SDK with app password authentication.
 * Supports image and video uploads via blob upload.
 */

import { AtpAgent, RichText, BlobRef, AppBskyEmbedImages, AppBskyEmbedVideo } from '@atproto/api';
import { readFileSync } from 'fs';
import { BaseAdapter } from './base';
import type { Platform, PostResult, Credentials, BlueskyCredentials, MediaAttachment } from '../types';

export class BlueskyAdapter extends BaseAdapter {
  readonly name: Platform = 'bluesky';
  readonly maxLength = 300;

  private agent: AtpAgent | null = null;
  private session: { did: string; handle: string } | null = null;

  isConfigured(): boolean {
    const creds = this.credentials.bluesky;
    return !!(creds?.identifier && creds?.password);
  }

  private async getAgent(): Promise<AtpAgent> {
    if (this.agent && this.session) {
      return this.agent;
    }

    const creds = this.credentials.bluesky as BlueskyCredentials;

    this.agent = new AtpAgent({
      service: 'https://bsky.social',
    });

    const response = await this.agent.login({
      identifier: creds.identifier,
      password: creds.password,
    });

    this.session = {
      did: response.data.did,
      handle: response.data.handle,
    };

    return this.agent;
  }

  async verifyCredentials(): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      await this.getAgent();
      return !!this.session;
    } catch (error) {
      console.error('Bluesky credential verification failed:', error);
      return false;
    }
  }

  /**
   * Upload a media file as a blob
   * Returns a BlobRef for embedding in posts
   */
  private async uploadBlob(attachment: MediaAttachment): Promise<BlobRef> {
    const agent = await this.getAgent();
    const fileBuffer = readFileSync(attachment.filePath);

    const response = await agent.uploadBlob(fileBuffer, {
      encoding: attachment.mimeType,
    });

    return response.data.blob;
  }

  async post(content: string, media?: MediaAttachment[]): Promise<PostResult> {
    if (!this.isConfigured()) {
      return this.failure('Bluesky credentials not configured');
    }

    const text = this.truncate(content);

    try {
      const agent = await this.getAgent();

      // Use RichText to properly handle links and mentions
      const rt = new RichText({ text });
      await rt.detectFacets(agent);

      // Build embed object if media is present
      let embed: AppBskyEmbedImages.Main | AppBskyEmbedVideo.Main | undefined;

      if (media?.length) {
        const firstMedia = media[0];

        if (firstMedia.type === 'video') {
          // Video embed
          const blob = await this.uploadBlob(firstMedia);
          embed = {
            $type: 'app.bsky.embed.video',
            video: blob,
            aspectRatio: firstMedia.aspectRatio,
          } as AppBskyEmbedVideo.Main;
        } else {
          // Image embed (can have multiple)
          const images = await Promise.all(
            media.slice(0, 4).map(async (m) => ({
              alt: m.alt || '',
              image: await this.uploadBlob(m),
              aspectRatio: m.aspectRatio,
            }))
          );
          embed = {
            $type: 'app.bsky.embed.images',
            images,
          } as AppBskyEmbedImages.Main;
        }
      }

      const postParams: Parameters<typeof agent.post>[0] = {
        text: rt.text,
        facets: rt.facets,
        createdAt: new Date().toISOString(),
      };

      // Add embed if we have media
      if (embed) {
        (postParams as any).embed = embed;
      }

      const result = await agent.post(postParams);

      // Parse the post URI to get the post ID
      // Format: at://did:plc:xxx/app.bsky.feed.post/xxx
      const uri = result.uri;
      const parts = uri.split('/');
      const postId = parts[parts.length - 1];
      const handle = this.session?.handle || 'unknown';

      return this.success(
        postId,
        `https://bsky.app/profile/${handle}/post/${postId}`,
        text
      );
    } catch (error: any) {
      const message = error?.message || 'Unknown error posting to Bluesky';
      return this.failure(message);
    }
  }

  /**
   * Get authenticated user info
   */
  async getMe(): Promise<{ did: string; handle: string } | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      await this.getAgent();
      return this.session;
    } catch {
      return null;
    }
  }
}
