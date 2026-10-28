/**
 * Broadcast - Type Definitions
 */

// Supported platforms
export type Platform = 'twitter' | 'linkedin' | 'bluesky' | 'instagram';

// Media types
export type MediaType = 'image' | 'video' | 'gif';

// Media attachment for uploads
export interface MediaAttachment {
  filePath: string;
  type: MediaType;
  mimeType: string;
  size: number;
  alt?: string;
  aspectRatio?: { width: number; height: number };
}

// Platform media limits
export interface MediaLimits {
  maxImages: number;
  maxVideos: number;
  maxImageSize: number;  // bytes
  maxVideoSize: number;  // bytes
}

export const PLATFORM_MEDIA_LIMITS: Record<Platform, MediaLimits> = {
  twitter: {
    maxImages: 4,
    maxVideos: 1,
    maxImageSize: 5 * 1024 * 1024,      // 5MB
    maxVideoSize: 512 * 1024 * 1024,    // 512MB
  },
  linkedin: {
    maxImages: 20,                    // multiImage post API (2–20 images)
    maxVideos: 1,
    maxImageSize: 8 * 1024 * 1024,      // 8MB
    maxVideoSize: 500 * 1024 * 1024,    // 500MB
  },
  bluesky: {
    maxImages: 4,
    maxVideos: 1,
    maxImageSize: 1 * 1024 * 1024,      // 1MB
    maxVideoSize: 50 * 1024 * 1024,     // 50MB (simple upload limit)
  },
  instagram: {
    maxImages: 10,                       // carousel up to 10 items
    maxVideos: 10,                       // video carousel; single video = Reel
    maxImageSize: 8 * 1024 * 1024,      // 8MB (JPEG only)
    maxVideoSize: 300 * 1024 * 1024,    // 300MB (Reels)
  },
};

// Platform character limits
export const PLATFORM_LIMITS: Record<Platform, number> = {
  twitter: 280,
  linkedin: 3000,
  bluesky: 300,
  instagram: 2200,
};

// Content to be posted
export interface PostContent {
  text: string;
  title?: string;
  url?: string;
  media?: string[];
}

// Result from posting to a platform
export interface PostResult {
  platform: Platform;
  success: boolean;
  postId?: string;
  postUrl?: string;
  error?: string;
  adaptedContent?: string;
}

// Broadcast result for all platforms
export interface BroadcastResult {
  results: PostResult[];
  successCount: number;
  failureCount: number;
}

// Twitter credentials
export interface TwitterCredentials {
  apiKey: string;
  apiKeySecret: string;
  accessToken: string;
  accessTokenSecret: string;
  bearerToken?: string;
}

// LinkedIn credentials
export interface LinkedInCredentials {
  accessToken: string;
  expiresAt?: number;
}

// Bluesky credentials
export interface BlueskyCredentials {
  identifier: string; // handle or DID
  password: string;   // app password
}

// Instagram credentials (Instagram Login / graph.instagram.com)
export interface InstagramCredentials {
  accessToken: string;   // long-lived Instagram user token (60 days)
  igUserId: string;      // Instagram-scoped user id
  expiresAt?: number;    // epoch ms; refresh before this
}

// All platform credentials
export interface Credentials {
  twitter?: TwitterCredentials;
  linkedin?: LinkedInCredentials;
  bluesky?: BlueskyCredentials;
  instagram?: InstagramCredentials;
}

// Platform adapter interface
export interface PlatformAdapter {
  name: Platform;
  maxLength: number;

  isConfigured(): boolean;
  post(content: string): Promise<PostResult>;
  verifyCredentials(): Promise<boolean>;
}

// CLI options
export interface PostOptions {
  content?: string;
  file?: string;
  media?: string[];
  platforms: Platform[];
  dryRun: boolean;
  /** Video PII gate: findings acknowledged by the principal (pass through). */
  piiReviewed?: boolean;
  /** Video PII gate: skip the scan entirely (loud; for when Gemini is down). */
  skipPii?: boolean;
  /** LinkedIn styling gate: post plain text on purpose (a reply-style one-liner). */
  linkedinPlain?: boolean;
}
