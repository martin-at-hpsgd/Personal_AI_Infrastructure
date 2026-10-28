/**
 * Broadcast - LinkedIn Adapter
 *
 * Uses LinkedIn's REST API for posting with media support.
 * Requires OAuth 2.0 access token with w_member_social scope.
 *
 * Content modes (mutually exclusive, LinkedIn allows one content object per post):
 *   1. media (image/video) — when --media is passed. The link, if any, stays plain text.
 *   2. article (link-preview card) — auto-detected when the text contains a URL and no
 *      media is attached. Fetches the URL's OpenGraph metadata, uploads the og:image as
 *      the card thumbnail, and posts it as an `article` so LinkedIn renders the preview
 *      card the web app shows. The raw URL is stripped from the commentary (the card
 *      carries the link).
 *   3. text-only — no media, no URL.
 *
 * API Reference:
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
 */

import { readFileSync, statSync } from 'fs';
import { BaseAdapter } from './base';
import { formatForLinkedIn, truncateCodePoints, escapeLittleText, assertLittleText } from '../format/linkedin-formatter';
import { formatBlocked, gatedTransmit, type GateDeps } from '../../../../LIFEOS/TOOLS/lib/SendGate.ts';
import type { Platform, PostResult, LinkedInCredentials, MediaAttachment } from '../types';

// LinkedIn API version (YYYYMM format)
// Versions sunset after ~1 year. Check: https://learn.microsoft.com/en-us/linkedin/marketing/versioning
/**
 * Pull a meta tag's content by og:/twitter: property or name.
 *
 * The capture backreferences the OPENING quote. A naive [^"']* class stops at an
 * apostrophe inside a double-quoted value, so
 * content="I'm Not Sure About This" extracted as just "I" and
 * would ship a LinkedIn link card titled "I". Titles with
 * apostrophes are common, so this would silently degrade a large share of link cards.
 */
export function pickMetaContent(html: string, prop: string): string | undefined {
  const a = html.match(
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*\\bcontent=(["'])(.*?)\\1`, 'i')
  );
  if (a?.[2]) return a[2];
  const b = html.match(
    new RegExp(`<meta[^>]+\\bcontent=(["'])(.*?)\\1[^>]*(?:property|name)=["']${prop}["']`, 'i')
  );
  return b?.[2];
}

const LINKEDIN_VERSION = '202601';

// LinkedIn article field caps (per Posts API docs)
const ARTICLE_TITLE_MAX = 400;
const ARTICLE_DESC_MAX = 4086;

interface UploadInstruction {
  uploadUrl: string;
  firstByte: number;
  lastByte: number;
}

interface OgMetadata {
  title?: string;
  description?: string;
  imageUrl?: string;
}

/** Every http(s) URL in the text, in order of appearance, trailing punctuation trimmed. */
export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>()"']+/g);
  return (matches || []).map(u => u.replace(/[.,;:!?)]+$/, ''));
}

/**
 * The commentary LinkedIn receives before styling, and the share URL promoted to a link card (if any). With attached media
 * the link stays plain text; otherwise the last URL becomes the card and is stripped from the commentary. One pure function,
 * so the send gate proofs the same bytes post() transmits (stripping a long URL can bring trailing text inside the cap).
 */
export function splitShareUrl(content: string, hasMedia: boolean): { shareUrl: string | null; commentaryRaw: string } {
  if (hasMedia) return { shareUrl: null, commentaryRaw: content };
  const urls = extractUrls(content);
  if (!urls.length) return { shareUrl: null, commentaryRaw: content };
  const shareUrl = urls[urls.length - 1]; // the share link is conventionally last
  const commentaryRaw = content
    .split(shareUrl).join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { shareUrl, commentaryRaw };
}

export class LinkedInAdapter extends BaseAdapter {
  readonly name: Platform = 'linkedin';
  readonly maxLength = 3000;

  private userUrn: string | null = null;

  isConfigured(): boolean {
    const creds = this.credentials.linkedin;
    return !!(creds?.accessToken);
  }

  /**
   * Get headers for legacy v2 API
   */
  private getHeaders(): Record<string, string> {
    const creds = this.credentials.linkedin as LinkedInCredentials;
    return {
      'Authorization': `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Get headers for REST API (requires versioning headers)
   */
  private getRestHeaders(): Record<string, string> {
    const creds = this.credentials.linkedin as LinkedInCredentials;
    return {
      'Authorization': `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': LINKEDIN_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    };
  }

  /**
   * Replace the commentary of an existing post (PARTIAL_UPDATE). The content object
   * (card, image, video) is untouched. Same markdown → Unicode → escape → gate
   * pipeline as `post()`, so what dry-run shows is what lands.
   */
  /** The exact commentary an edit transmits for this content: what the send gate proofs. */
  commentaryText(content: string): string {
    const text = truncateCodePoints(escapeLittleText(formatForLinkedIn(content)), this.maxLength);
    assertLittleText(text);
    return text;
  }

  async editCommentary(postUrn: string, content: string): Promise<PostResult> {
    if (!this.isConfigured()) {
      return this.failure('LinkedIn credentials not configured');
    }
    if (!/^urn:li:(share|ugcPost):\d+$/.test(postUrn)) {
      return this.failure(`Not a post URN: ${postUrn}`);
    }

    const text = this.commentaryText(content);

    const response = await fetch(`https://api.linkedin.com/rest/posts/${encodeURIComponent(postUrn)}`, {
      method: 'POST',
      headers: { ...this.getRestHeaders(), 'X-RestLi-Method': 'PARTIAL_UPDATE' },
      body: JSON.stringify({ patch: { $set: { commentary: text } } }),
    });

    if (response.status !== 204) {
      const errorText = await response.text();
      return this.failure(`LinkedIn edit failed (${response.status}): ${errorText}`);
    }

    return this.success(postUrn, `https://www.linkedin.com/feed/update/${postUrn}`, text);
  }

  async verifyCredentials(): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      const response = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as { sub: string };
      this.userUrn = `urn:li:person:${data.sub}`;
      return true;
    } catch (error) {
      console.error('LinkedIn credential verification failed:', error);
      return false;
    }
  }

  /**
   * Upload raw image bytes to LinkedIn. Returns the image URN (urn:li:image:xxx).
   * Shared by the media-attachment path and the article-thumbnail path.
   */
  private async uploadImageBytes(bytes: Uint8Array, mimeType: string): Promise<string> {
    if (!this.userUrn) {
      throw new Error('User URN not available');
    }

    // 1. Initialize upload
    const initResponse = await fetch(
      'https://api.linkedin.com/rest/images?action=initializeUpload',
      {
        method: 'POST',
        headers: this.getRestHeaders(),
        body: JSON.stringify({
          initializeUploadRequest: {
            owner: this.userUrn,
          },
        }),
      }
    );

    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      throw new Error(`Failed to initialize image upload: ${errorText}`);
    }

    const initData = await initResponse.json() as {
      value: {
        uploadUrl: string;
        image: string;
      };
    };

    // 2. Upload the binary image. Pass the underlying ArrayBuffer slice — a valid
    // BodyInit that sidesteps the Buffer/Uint8Array<ArrayBufferLike> type friction.
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const uploadResponse = await fetch(initData.value.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
      },
      body,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Failed to upload image: ${errorText}`);
    }

    return initData.value.image;
  }

  /**
   * Upload an image file to LinkedIn. Returns the image URN (urn:li:image:xxx).
   */
  private async uploadImage(attachment: MediaAttachment): Promise<string> {
    const fileBuffer = readFileSync(attachment.filePath);
    return this.uploadImageBytes(fileBuffer, attachment.mimeType);
  }

  /**
   * Decode the handful of HTML entities that show up in OG meta content.
   */
  private decodeEntities(s: string): string {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#8217;/g, '’')
      .replace(/&#8216;/g, '‘');
  }

  /**
   * Fetch OpenGraph metadata (title, description, image) from a URL.
   * Returns whatever it could parse; never throws.
   */
  private async fetchOgMetadata(url: string): Promise<OgMetadata> {
    try {
      const res = await fetch(url, {
        headers: {
          // An honest, identifiable UA: this is our own tool fetching a page for its preview metadata.
          'User-Agent': 'Mozilla/5.0 (compatible; LifeOS-Broadcast/1.0)',
        },
        redirect: 'follow',
      });
      if (!res.ok) return {};
      const html = await res.text();

      const pick = (prop: string): string | undefined => pickMetaContent(html, prop);

      const rawTitle = pick('og:title') || pick('twitter:title') || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
      const rawDesc = pick('og:description') || pick('twitter:description') || pick('description');
      const imageUrl = pick('og:image') || pick('twitter:image') || pick('twitter:image:src');

      return {
        title: rawTitle ? this.decodeEntities(rawTitle.trim()) : undefined,
        description: rawDesc ? this.decodeEntities(rawDesc.trim()) : undefined,
        imageUrl: imageUrl ? this.decodeEntities(imageUrl.trim()) : undefined,
      };
    } catch {
      return {};
    }
  }

  /**
   * Download image bytes from a URL. Returns null on any failure.
   */
  private async downloadImageBytes(imageUrl: string): Promise<{ buffer: Uint8Array; mimeType: string } | null> {
    try {
      const res = await fetch(imageUrl, { redirect: 'follow' });
      if (!res.ok) return null;
      const mimeType = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
      if (!mimeType.startsWith('image/')) return null;
      const ab = await res.arrayBuffer();
      return { buffer: new Uint8Array(ab), mimeType };
    } catch {
      return null;
    }
  }

  /**
   * Build the LinkedIn `article` content object for a link-preview card.
   * Uploads the og:image as the card thumbnail when available.
   */
  private async buildArticleContent(url: string): Promise<{ article: Record<string, unknown> }> {
    const og = await this.fetchOgMetadata(url);

    let thumbnailUrn: string | undefined;
    if (og.imageUrl) {
      const img = await this.downloadImageBytes(og.imageUrl);
      if (img) {
        try {
          thumbnailUrn = await this.uploadImageBytes(img.buffer, img.mimeType);
        } catch (e) {
          // Thumbnail is best-effort; the card still renders without it.
          console.error('LinkedIn article thumbnail upload failed (card will render without image):', e);
        }
      }
    }

    const article: Record<string, unknown> = {
      source: url,
      title: (og.title || url).slice(0, ARTICLE_TITLE_MAX),
    };
    if (og.description) article.description = og.description.slice(0, ARTICLE_DESC_MAX);
    if (thumbnailUrn) article.thumbnail = thumbnailUrn;

    return { article };
  }

  /**
   * Upload a video to LinkedIn (chunked upload)
   * Returns the video URN (urn:li:video:xxx)
   */
  private async uploadVideo(attachment: MediaAttachment): Promise<string> {
    if (!this.userUrn) {
      throw new Error('User URN not available');
    }

    const stats = statSync(attachment.filePath);
    const fileSize = stats.size;

    // 1. Initialize upload with file size
    const initResponse = await fetch(
      'https://api.linkedin.com/rest/videos?action=initializeUpload',
      {
        method: 'POST',
        headers: this.getRestHeaders(),
        body: JSON.stringify({
          initializeUploadRequest: {
            owner: this.userUrn,
            fileSizeBytes: fileSize,
            uploadCaptions: false,
            uploadThumbnail: false,
          },
        }),
      }
    );

    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      throw new Error(`Failed to initialize video upload: ${errorText}`);
    }

    const initData = await initResponse.json() as {
      value: {
        video: string;
        uploadInstructions: UploadInstruction[];
        uploadToken: string;
      };
    };

    // 2. Upload video chunks
    const fileBuffer = readFileSync(attachment.filePath);
    const uploadedPartIds: string[] = [];

    for (const instruction of initData.value.uploadInstructions) {
      const chunk = fileBuffer.subarray(instruction.firstByte, instruction.lastByte + 1);

      const uploadResponse = await fetch(instruction.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: chunk,
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        throw new Error(`Failed to upload video chunk: ${errorText}`);
      }

      // Get ETag from response headers
      const etag = uploadResponse.headers.get('etag');
      if (etag) {
        uploadedPartIds.push(etag.replace(/"/g, ''));
      }
    }

    // 3. Finalize upload
    const finalizeResponse = await fetch(
      'https://api.linkedin.com/rest/videos?action=finalizeUpload',
      {
        method: 'POST',
        headers: this.getRestHeaders(),
        body: JSON.stringify({
          finalizeUploadRequest: {
            video: initData.value.video,
            uploadToken: initData.value.uploadToken || '',
            uploadedPartIds,
          },
        }),
      }
    );

    if (!finalizeResponse.ok) {
      const errorText = await finalizeResponse.text();
      throw new Error(`Failed to finalize video upload: ${errorText}`);
    }

    return initData.value.video;
  }

  async post(content: string, media?: MediaAttachment[]): Promise<PostResult> {
    if (!this.isConfigured()) {
      return this.failure('LinkedIn credentials not configured');
    }

    try {
      // First, get user URN if we don't have it
      if (!this.userUrn) {
        const verified = await this.verifyCredentials();
        if (!verified || !this.userUrn) {
          return this.failure('Failed to get LinkedIn user info');
        }
      }

      // Decide the content object. Media wins; otherwise a URL becomes a link card.
      let mediaContent:
        | { media: { id: string; altText?: string } }
        | { multiImage: { images: { id: string; altText?: string }[] } }
        | undefined;
      let articleContent: { article: Record<string, unknown> } | undefined;
      const split = splitShareUrl(content, !!media?.length);
      const shareUrl = split.shareUrl;

      if (media?.length) {
        const images = media.filter((m) => m.type !== 'video');
        if (images.length >= 2 && images.length === media.length) {
          // 2–20 images → LinkedIn multiImage content (a swipeable gallery).
          // https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api
          const ids: { id: string; altText?: string }[] = [];
          for (const attachment of images.slice(0, 20)) {
            ids.push({ id: await this.uploadImage(attachment), altText: attachment.alt || '' });
          }
          mediaContent = { multiImage: { images: ids } };
        } else {
          const attachment = media[0]; // one video, or a single image
          if (attachment.type === 'video') {
            const videoUrn = await this.uploadVideo(attachment);
            mediaContent = { media: { id: videoUrn } };
          } else {
            const imageUrn = await this.uploadImage(attachment);
            mediaContent = { media: { id: imageUrn, altText: attachment.alt || '' } };
          }
        }
      } else {
        // No attached media — if the text carries a URL, render it as a preview card.
        if (shareUrl) articleContent = await this.buildArticleContent(shareUrl);
      }

      // Commentary: strip the raw share URL when it's been promoted to a card, so the
      // post doesn't show both a bare link and the card (matches the web app).
      let commentaryRaw = split.commentaryRaw;
      // LinkedIn requires non-empty commentary; fall back to the card title if we stripped
      // everything (URL-only post).
      if (!commentaryRaw && articleContent) {
        commentaryRaw = String((articleContent.article as any).title || shareUrl || '');
      }

      // Markdown styling first, then escape LinkedIn's reserved little-text chars —
      // the API silently drops everything after an unescaped reserved char.
      const text = truncateCodePoints(escapeLittleText(formatForLinkedIn(commentaryRaw)), this.maxLength);
      // Wire-form gate: an unescaped reserved char here means LinkedIn swallows the post
      // from that point on while still returning 201. Fail loud instead.
      assertLittleText(text);

      // Create post using the REST posts API
      const postData: Record<string, unknown> = {
        author: this.userUrn,
        commentary: text,
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      };

      if (mediaContent) {
        postData.content = mediaContent;
      } else if (articleContent) {
        postData.content = articleContent;
      }

      const response = await fetch('https://api.linkedin.com/rest/posts', {
        method: 'POST',
        headers: this.getRestHeaders(),
        body: JSON.stringify(postData),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return this.failure(`LinkedIn API error: ${response.status} - ${errorText}`);
      }

      // Get post ID from response header
      const postId = response.headers.get('x-restli-id') || '';

      // Construct post URL
      const postUrl = `https://www.linkedin.com/feed/update/${postId}`;

      return this.success(postId, postUrl, text);
    } catch (error: any) {
      const message = error?.message || 'Unknown error posting to LinkedIn';
      return this.failure(message);
    }
  }

  /**
   * Get authenticated user info
   */
  async getMe(): Promise<{ id: string; name: string } | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const response = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as { sub: string; name: string };
      return {
        id: data.sub,
        name: data.name,
      };
    } catch {
      return null;
    }
  }
}

export type GatedEditResult = PostResult & { blockedMessage?: string; flags?: string[] };

/**
 * Edit an existing post's commentary through the send gate: the exact text LinkedIn receives is proofed at the publish
 * boundary immediately before the network call. A block or a failed edit transmits nothing and writes no output line.
 */
type AdapterShape = LinkedInAdapter;
type EditableAdapter = Pick<AdapterShape, 'editCommentary' | 'commentaryText'>;

export async function gatedEditCommentary(
  adapter: EditableAdapter,
  postUrn: string,
  content: string,
  gate?: GateDeps,
): Promise<GatedEditResult> {
  let text: string;
  try {
    text = adapter.commentaryText(content);
  } catch (e: any) {
    return { platform: 'linkedin', success: false, error: e?.message || 'Invalid post text' };
  }
  let failure: PostResult | null = null;
  let sent: Awaited<ReturnType<typeof gatedTransmit<PostResult>>>;
  try {
    sent = await gatedTransmit<PostResult>(
      { channel: 'linkedin', destination: 'publish', body: text, recipientClass: 'linkedin' },
      async () => {
        const r = await adapter.editCommentary(postUrn, content);
        if (!r.success) { failure = r; throw new Error('edit failed'); }
        return r;
      },
      gate,
      { skill: 'Broadcast' },
    );
  } catch (e) {
    if (!failure) throw e; // a transport throw is not a gate result
    return failure;
  }
  if (!sent.ok) return { platform: 'linkedin', success: false, error: `Send blocked: ${sent.reason}`, blockedMessage: formatBlocked(sent, 'linkedin') };
  return { ...sent.result, flags: sent.gate.flags.map((fl) => `${fl.check}: ${String(fl.message).replace(/\s+/g, ' ').slice(0, 160)}`) };
}
