/**
 * Broadcast - Post Command
 *
 * Handles posting content with optional media to multiple platforms
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { getLifeosDir } from '../../../../LIFEOS/TOOLS/Paths';
import { loadCredentials } from '../config';
import { TwitterAdapter } from '../adapters/twitter';
import { BlueskyAdapter } from '../adapters/bluesky';
import { LinkedInAdapter, splitShareUrl } from '../adapters/linkedin';
import { formatForLinkedIn, linkedInStylingProblem, truncateCodePoints, escapeLittleText } from '../format/linkedin-formatter';
import { InstagramAdapter } from '../adapters/instagram';
import { loadMediaFiles, validateMediaArrayForPlatform, formatMediaInfo } from '../utils/media';
import { videoPiiGate } from '../../../../LIFEOS/TOOLS/VideoPiiGate';
import type { Platform, PostResult, BroadcastResult, PostOptions, MediaAttachment, Credentials } from '../types';
import type { BaseAdapter } from '../adapters/base';
import { formatBlocked, gatedTransmit, type GateDeps } from '../../../../LIFEOS/TOOLS/lib/SendGate.ts';
import { PLATFORM_LIMITS } from '../types';
import { assertValidTweetText, getTweetWeightedLength } from '../../../X/Tools/TwitterText';

// Log directory — runtime state lives in LIFEOS/MEMORY/STATE, not inside the skill dir. getLifeosDir honours
// CLAUDE_CONFIG_DIR and LIFEOS_DIR, so an install outside ~/.claude logs into its own tree.
const LOGS_DIR = process.env.LIFEOS_BROADCAST_LOG_DIR ?? join(getLifeosDir(), 'MEMORY', 'STATE');

// Available adapters
const ADAPTERS = {
  twitter: TwitterAdapter,
  bluesky: BlueskyAdapter,
  linkedin: LinkedInAdapter,
  instagram: InstagramAdapter,
} as const;

type AvailablePlatform = keyof typeof ADAPTERS;

/** Test seams for executePost: injected adapters (no network), credentials, and the SendGate dirs/emitter. */
export interface PostDeps {
  adapters?: Partial<Record<AvailablePlatform, (credentials: Credentials) => BaseAdapter>>;
  credentials?: Credentials;
  gate?: GateDeps;
}

/**
 * The text a platform's adapter puts on the wire for `content`, so the send gate proofs the bytes the platform receives.
 * Mirrors each adapter's own shaping: LinkedIn is markdown styling, little-text escape, code-point truncation; Bluesky and
 * Instagram truncate with an ellipsis; X validates and passes the text through. LinkedIn promotes the share URL to a link
 * card when no media is attached and strips it from the commentary before shaping, so the gate strips it the same way
 * (splitShareUrl) and the cap applies to the same text. A URL-only post sends the card title, which is fetched at send
 * time; the gate then proofs the URL itself.
 */
export function platformText(platform: AvailablePlatform, content: string, hasMedia = false): string {
  switch (platform) {
    case 'linkedin': {
      const { shareUrl, commentaryRaw } = splitShareUrl(content, hasMedia);
      return truncateCodePoints(escapeLittleText(formatForLinkedIn(commentaryRaw || shareUrl || '')), PLATFORM_LIMITS.linkedin);
    }
    case 'twitter': return assertValidTweetText(content);
    default: {
      const max = PLATFORM_LIMITS[platform];
      return content.length <= max ? content : content.slice(0, max - 3) + '...';
    }
  }
}

/**
 * Log a post result to the daily log file
 */
function logPost(result: PostResult, content: string, media?: MediaAttachment[]): void {
  try {
    if (!existsSync(LOGS_DIR)) {
      mkdirSync(LOGS_DIR, { recursive: true });
    }

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const logFile = join(LOGS_DIR, `Broadcast-${dateStr}.jsonl`);

    const logEntry = {
      timestamp: now.toISOString(),
      platform: result.platform,
      status: result.success ? 'success' : 'failure',
      url: result.postUrl || null,
      error: result.error || null,
      content: content,
      media: media?.map(m => ({
        type: m.type,
        file: basename(m.filePath),
        size: m.size,
      })) || null,
    };

    appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
  } catch (err) {
    // Silent fail - logging shouldn't break posting
    console.error('Failed to log post:', err);
  }
}

/**
 * Load content from file or use provided text
 */
function loadContent(options: PostOptions): string {
  if (options.file) {
    if (!existsSync(options.file)) {
      throw new Error(`File not found: ${options.file}`);
    }
    return readFileSync(options.file, 'utf-8').trim();
  }

  if (options.content) {
    return options.content;
  }

  throw new Error('No content provided. Use --content or --file');
}

/**
 * Format platform-specific preview
 */
export function formatPreview(
  platform: Platform,
  content: string,
  media?: MediaAttachment[],
  // false for a commentary edit: editCommentary sends the whole text and never promotes a URL to a card.
  opts: { linkedinShareCard?: boolean } = {},
): string {
  const limit = PLATFORM_LIMITS[platform];
  const isTwitter = platform === 'twitter';
  let displayContent: string;
  let charCount: number;
  let cardLine = '';
  if (platform === 'linkedin') {
    // LinkedIn previews the adapter's own pipeline: the share URL leaves the commentary when it becomes a link card,
    // markdown becomes Unicode styling (bold hook, • bullets), reserved characters are escaped, and the cap is applied to
    // that escaped wire text by code point. The count is the wire text's; the text shown drops the escaping backslashes,
    // which readers never see, so the operator approves exactly the words that land.
    const { shareUrl, commentaryRaw } = opts.linkedinShareCard === false
      ? { shareUrl: null, commentaryRaw: content }
      : splitShareUrl(content, !!media?.length);
    const wire = truncateCodePoints(escapeLittleText(formatForLinkedIn(commentaryRaw)), limit);
    displayContent = commentaryRaw ? unescapeLittleText(wire) : '(no commentary: LinkedIn shows the link card title, fetched from the page at send time)';
    charCount = Array.from(wire).length;
    if (shareUrl) cardLine = `\n│ 🔗 Link card: ${shareUrl} (title, description and image are fetched from the page at send time)`;
  } else {
    // Bluesky and Instagram truncate by UTF-16 unit via BaseAdapter.truncate; X is validated, never truncated.
    displayContent = isTwitter
      ? assertValidTweetText(content)
      : content.length > limit ? content.slice(0, limit - 3) + '...' : content;
    charCount = isTwitter ? getTweetWeightedLength(content) : Array.from(displayContent).length;
  }
  const countLabel = isTwitter ? 'weighted chars' : 'chars';
  const previewContent = isTwitter ? displayContent : displayContent.split('\n').join('\n│ ');

  let mediaLine = '';
  if (media?.length) {
    mediaLine = `\n│ 📎 Media: ${formatMediaInfo(media)}`;
  }

  return `
┌─ ${platform.toUpperCase()} (${charCount}/${limit} ${countLabel})
│ ${previewContent}${cardLine}${mediaLine}
└─`;
}

/** Reader view of escapeLittleText output: LinkedIn renders `\#` as `#`, so the preview drops the escaping backslash. */
function unescapeLittleText(text: string): string {
  return text.replace(/\\([\\|{}@[\]()<>#*_~])/g, (_m, c: string) => c);
}

/**
 * Execute post command
 */
export async function executePost(options: PostOptions, deps: PostDeps = {}): Promise<BroadcastResult> {
  const content = loadContent(options);
  const credentials = deps.credentials ?? loadCredentials();
  const makeAdapter = (platform: AvailablePlatform): BaseAdapter => {
    const inject = deps.adapters?.[platform];
    return inject ? inject(credentials) : new ADAPTERS[platform](credentials);
  };

  // Load media files if provided
  let media: MediaAttachment[] | undefined;
  if (options.media?.length) {
    try {
      media = await loadMediaFiles(options.media);
      console.log(`📎 Loaded ${media.length} media file(s): ${formatMediaInfo(media)}`);
    } catch (error: any) {
      console.error(`❌ Error loading media: ${error.message}`);
      return { results: [], successCount: 0, failureCount: 1 };
    }
    // Video PII gate — every video is scanned before any platform sees it (dry-run included).
    const gate = await videoPiiGate(media.map(m => m.filePath), { reviewed: options.piiReviewed, skip: options.skipPii });
    if (!gate.ok) return { results: [], successCount: 0, failureCount: 1 };
  }

  const platforms = options.platforms.filter(p => p in ADAPTERS) as AvailablePlatform[];

  if (platforms.length === 0) {
    console.error('No supported platforms specified');
    return { results: [], successCount: 0, failureCount: 0 };
  }

  // LinkedIn styling gate — refuse the whole run so nothing half-posts.
  if (platforms.includes('linkedin') && !options.linkedinPlain) {
    const problem = linkedInStylingProblem(content);
    if (problem) {
      console.error(`❌ ${problem}`);
      return { results: [], successCount: 0, failureCount: 1 };
    }
  }

  // Validate media for each platform. A platform whose media fails is reported as failed and skipped; the others still
  // post (Intents/Post.md: when a platform fails, the other platforms still post).
  const results: PostResult[] = [];
  let postable = platforms;
  if (media?.length) {
    postable = [];
    for (const platform of platforms) {
      try {
        validateMediaArrayForPlatform(media, platform);
        postable.push(platform);
      } catch (error: any) {
        console.error(`❌ Media validation failed for ${platform}: ${error.message}`);
        results.push({ platform, success: false, error: `Media validation failed: ${error.message}` });
      }
    }
    if (postable.length === 0) return { results, successCount: 0, failureCount: results.length };
  }

  // Dry run - just show previews
  if (options.dryRun) {
    console.log('\n🔍 DRY RUN - Preview only, not posting\n');

    for (const platform of postable) {
      const adapter = makeAdapter(platform);

      // An unconfigured platform still gets its preview, so the formatting can be checked before any
      // credentials exist; the note says a live post would skip it.
      if (!adapter.isConfigured()) {
        console.log(`⚠️  ${platform.toUpperCase()}: Not configured (preview only; a live post skips it)`);
      }

      console.log(formatPreview(platform, content, media));
    }

    console.log('\n✅ Dry run complete. Use without --dry-run to post.\n');
    return { results: [], successCount: 0, failureCount: results.length };
  }

  // Actual posting
  console.log('\n📤 Broadcasting to', postable.join(', '), '...\n');

  for (const platform of postable) {
    const adapter = makeAdapter(platform);

    if (!adapter.isConfigured()) {
      results.push({
        platform,
        success: false,
        error: 'Not configured',
      });
      console.log(`❌ ${platform.toUpperCase()}: Not configured`);
      continue;
    }

    // Send gate: the exact text this platform receives, plus each media file, is proofed at the publish boundary inside
    // this tool, immediately before the adapter's network calls. A fail closes the platform; nothing is transmitted.
    // A LinkedIn video is the exception: it is held to LinkedIn's own spec (validateMediaForPlatform) and the PII scan
    // above, not to the proof's frame/audio checks. Its text is still proofed.
    const proofed = (media ?? []).filter(m => !(platform === 'linkedin' && m.type === 'video'));
    let sentText: string;
    try {
      sentText = platformText(platform, content, !!media?.length);
    } catch (error: any) {
      const failed: PostResult = { platform, success: false, error: error?.message || 'Invalid post text' };
      results.push(failed);
      console.log(`❌ ${platform.toUpperCase()}: ${failed.error}`);
      continue;
    }

    console.log(`📝 Posting to ${platform}...`);
    // A failed post is thrown out of the transmit so the gate writes no output line for a post that never landed.
    let adapterFailure: PostResult | null = null;
    let sent: Awaited<ReturnType<typeof gatedTransmit<PostResult>>>;
    try {
      sent = await gatedTransmit<PostResult>(
        { channel: platform, destination: 'publish', body: sentText, recipientClass: platform, attachments: proofed.map(m => resolve(m.filePath)) },
        async (g) => {
          // Transmit the proofed copies: byte-for-byte what the gate checked, not a second read of the original paths
          // (a file swapped after validation would otherwise upload unproofed). Attachment items follow `proofed` in order.
          const copies = g.items.filter(i => i.role === 'attachment');
          const sendMedia = media?.map(m => {
            const at = proofed.indexOf(m);
            return at >= 0 && copies[at] ? { ...m, filePath: copies[at].file } : m;
          });
          const r = await adapter.post(content, sendMedia);
          if (!r.success) { adapterFailure = r; throw new Error('post failed'); }
          return r;
        },
        deps.gate,
        { skill: 'Broadcast' },
      );
    } catch (error: any) {
      if (!adapterFailure) throw error; // a transport throw is not a gate result
      sent = { ok: false, reason: 'post failed', findings: [], sha256: null, proofCommand: null, file: null };
    }
    if (adapterFailure) {
      results.push(adapterFailure);
      logPost(adapterFailure, content, media);
      console.log(`❌ ${platform.toUpperCase()}: ${(adapterFailure as PostResult).error}`);
      continue;
    }
    if (!sent.ok) {
      const blocked: PostResult = { platform, success: false, error: `Send blocked: ${sent.reason}` };
      results.push(blocked);
      console.error(formatBlocked(sent, platform));
      console.log(`❌ ${platform.toUpperCase()}: ${blocked.error}`);
      continue;
    }
    for (const fl of sent.gate.flags) console.error(`unearned flag, not blocking: ${fl.check}: ${String(fl.message).replace(/\s+/g, ' ').slice(0, 160)}`);
    const result = sent.result;
    results.push(result);

    // Log the result
    logPost(result, content, media);

    if (result.success) {
      console.log(`✅ ${platform.toUpperCase()}: ${result.postUrl}`);
    } else {
      console.log(`❌ ${platform.toUpperCase()}: ${result.error}`);
    }
  }

  const successCount = results.filter(r => r.success).length;
  const failureCount = results.filter(r => !r.success).length;

  console.log(`\n📊 Results: ${successCount} succeeded, ${failureCount} failed\n`);

  return { results, successCount, failureCount };
}
