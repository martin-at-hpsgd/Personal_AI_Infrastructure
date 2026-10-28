/**
 * Broadcast - Media Utilities
 *
 * Handles media file detection, validation, and loading.
 */

import { existsSync, statSync, readFileSync } from 'fs';
import { extname, basename, join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import probe from 'probe-image-size';
import type { MediaAttachment, MediaType, Platform } from '../types';
import { PLATFORM_MEDIA_LIMITS } from '../types';

// MIME type mappings
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
};

// Media type detection by extension
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const GIF_EXTENSIONS = ['.gif'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.webm'];

/**
 * Detect media type from file extension
 */
export function detectMediaType(filePath: string): MediaType {
  const ext = extname(filePath).toLowerCase();

  if (IMAGE_EXTENSIONS.includes(ext)) {
    return 'image';
  }
  if (GIF_EXTENSIONS.includes(ext)) {
    return 'gif';
  }
  if (VIDEO_EXTENSIONS.includes(ext)) {
    return 'video';
  }

  throw new Error(`Unsupported media type: ${ext}`);
}

/**
 * Get MIME type from file extension
 */
export function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext];

  if (!mimeType) {
    throw new Error(`Unknown MIME type for extension: ${ext}`);
  }

  return mimeType;
}

/**
 * Get aspect ratio for images using probe-image-size
 */
export async function getImageAspectRatio(filePath: string): Promise<{ width: number; height: number }> {
  const fileBuffer = readFileSync(filePath);
  const result = probe.sync(fileBuffer);

  if (!result) {
    throw new Error(`Could not determine image dimensions: ${filePath}`);
  }

  return {
    width: result.width,
    height: result.height,
  };
}

/**
 * Get aspect ratio for videos using ffprobe
 */
export function getVideoAspectRatio(filePath: string): { width: number; height: number } {
  try {
    const output = execFileSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath],
      { encoding: 'utf-8' }
    ).trim();

    const [width, height] = output.split(',').map(Number);

    if (!width || !height) {
      throw new Error('Could not parse ffprobe output');
    }

    return { width, height };
  } catch (error) {
    // Fallback to default aspect ratio if ffprobe fails
    console.warn(`Could not determine video dimensions for ${filePath}, using 16:9`);
    return { width: 1920, height: 1080 };
  }
}

/**
 * Get aspect ratio for any media type
 */
export async function getAspectRatio(filePath: string, type: MediaType): Promise<{ width: number; height: number }> {
  if (type === 'video') {
    return getVideoAspectRatio(filePath);
  }
  return getImageAspectRatio(filePath);
}

/** Video duration in seconds via ffprobe, or null when it cannot be read. */
export function getVideoDurationSeconds(filePath: string): number | null {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { encoding: 'utf-8' }).trim();
    const s = Number(out);
    return Number.isFinite(s) && s > 0 ? s : null;
  } catch {
    return null;
  }
}

/**
 * LinkedIn's own video spec (Videos API docs, learn.microsoft.com/linkedin/marketing/community-management/shares/videos-api):
 * MP4, 3 s to 30 min, 75 KB to 500 MB. A LinkedIn video inside these limits is postable; the send gate does not proof
 * its frames or audio: any video LinkedIn accepts is allowed.
 */
export const LINKEDIN_VIDEO_SPEC = { minSeconds: 3, maxSeconds: 30 * 60, minBytes: 75 * 1024, maxBytes: 500 * 1024 * 1024, mime: 'video/mp4' } as const;

export function linkedInVideoProblem(attachment: MediaAttachment, durationSeconds: number | null): string | null {
  const s = LINKEDIN_VIDEO_SPEC;
  if (attachment.mimeType !== s.mime) return `LinkedIn takes MP4 video only (got ${attachment.mimeType})`;
  if (attachment.size < s.minBytes) return `Video too small for LinkedIn: ${attachment.size} bytes (min 75 KB)`;
  if (attachment.size > s.maxBytes) return `Video too large for LinkedIn: ${Math.round(attachment.size / (1024 * 1024))}MB (max 500MB)`;
  if (durationSeconds === null) return 'Video duration could not be read, so LinkedIn limits (3 s to 30 min) cannot be confirmed';
  if (durationSeconds < s.minSeconds) return `Video too short for LinkedIn: ${durationSeconds.toFixed(1)} s (min 3 s)`;
  if (durationSeconds > s.maxSeconds) return `Video too long for LinkedIn: ${Math.round(durationSeconds)} s (max 30 min)`;
  return null;
}

/**
 * Validate media file for a specific platform
 */
export function validateMediaForPlatform(attachment: MediaAttachment, platform: Platform): void {
  const limits = PLATFORM_MEDIA_LIMITS[platform];

  if (attachment.type === 'video' && platform === 'linkedin') {
    const problem = linkedInVideoProblem(attachment, getVideoDurationSeconds(attachment.filePath));
    if (problem) throw new Error(problem);
  } else if (attachment.type === 'video') {
    if (attachment.size > limits.maxVideoSize) {
      const maxMB = Math.round(limits.maxVideoSize / (1024 * 1024));
      const fileMB = Math.round(attachment.size / (1024 * 1024));
      throw new Error(
        `Video too large for ${platform}: ${fileMB}MB (max ${maxMB}MB)`
      );
    }
  } else {
    if (attachment.size > limits.maxImageSize) {
      const maxMB = Math.round(limits.maxImageSize / (1024 * 1024));
      const fileMB = Math.round(attachment.size / (1024 * 1024));
      throw new Error(
        `Image too large for ${platform}: ${fileMB}MB (max ${maxMB}MB)`
      );
    }
  }
}

/**
 * Load a single media file and return attachment info
 */
export async function loadMediaFile(filePath: string): Promise<MediaAttachment> {
  if (!existsSync(filePath)) {
    throw new Error(`Media file not found: ${filePath}`);
  }

  const stats = statSync(filePath);
  const type = detectMediaType(filePath);
  const mimeType = getMimeType(filePath);
  const aspectRatio = await getAspectRatio(filePath, type);

  return {
    filePath,
    type,
    mimeType,
    size: stats.size,
    aspectRatio,
  };
}

/**
 * Load multiple media files
 */
export async function loadMediaFiles(paths: string[]): Promise<MediaAttachment[]> {
  const attachments: MediaAttachment[] = [];

  for (const path of paths) {
    const attachment = await loadMediaFile(path.trim());
    attachments.push(attachment);
  }

  return attachments;
}

/**
 * Validate media array for a platform
 */
export function validateMediaArrayForPlatform(media: MediaAttachment[], platform: Platform): void {
  const limits = PLATFORM_MEDIA_LIMITS[platform];

  const images = media.filter(m => m.type === 'image' || m.type === 'gif');
  const videos = media.filter(m => m.type === 'video');

  if (images.length > limits.maxImages) {
    throw new Error(
      `Too many images for ${platform}: ${images.length} (max ${limits.maxImages})`
    );
  }

  if (videos.length > limits.maxVideos) {
    throw new Error(
      `Too many videos for ${platform}: ${videos.length} (max ${limits.maxVideos})`
    );
  }

  // Can't mix videos with images on most platforms
  if (videos.length > 0 && images.length > 0) {
    throw new Error(
      `Cannot mix videos and images in the same post on ${platform}`
    );
  }

  // Validate each file
  for (const attachment of media) {
    validateMediaForPlatform(attachment, platform);
  }
}

/**
 * Ensure an image is JPEG (Instagram accepts JPEG only).
 * Returns the original path if already JPEG, else a temp .jpg path (caller deletes).
 * Uses macOS `sips` first, then `ffmpeg` as a fallback.
 */
export async function ensureJpeg(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    return filePath;
  }

  const out = join(tmpdir(), `broadcast-${crypto.randomUUID()}.jpg`);

  try {
    // macOS native, no dependency, argv form (no shell interpolation)
    execFileSync('sips', ['-s', 'format', 'jpeg', filePath, '--out', out], { stdio: 'ignore' });
    return out;
  } catch {
    try {
      execFileSync('ffmpeg', ['-y', '-i', filePath, out], { stdio: 'ignore' });
      return out;
    } catch {
      throw new Error(`Failed to convert ${ext} to JPEG for Instagram (need sips or ffmpeg)`);
    }
  }
}

/**
 * Format media info for display
 */
export function formatMediaInfo(media: MediaAttachment[]): string {
  return media
    .map(m => {
      const sizeMB = (m.size / (1024 * 1024)).toFixed(2);
      return `${m.type} (${basename(m.filePath)}, ${sizeMB}MB)`;
    })
    .join(', ');
}
