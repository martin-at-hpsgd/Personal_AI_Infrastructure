#!/usr/bin/env bun
/**
 * Broadcast - Multi-Platform Social Media Posting CLI
 *
 * Usage:
 *   broadcast post --content "Hello world" --platforms twitter
 *   broadcast post --file ./post.md --platforms twitter,linkedin
 *   broadcast post --dry-run --content "Test" --platforms all
 *   broadcast status
 *   broadcast auth twitter
 */

import { Command } from 'commander';
import { executePost } from './commands/post';
import { executeArticle } from './commands/article';
import { loadCredentials, isPlatformConfigured, saveCredentials } from './config';
import { TwitterAdapter } from './adapters/twitter';
import { BlueskyAdapter } from './adapters/bluesky';
import { LinkedInAdapter } from './adapters/linkedin';
import { InstagramAdapter } from './adapters/instagram';
import type { Platform } from './types';
import { houseStyleOn } from './skill-config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// One version source for the CLI: SKILL.md frontmatter `version`, the field BumpSkillVersions moves (package.json drifted behind it at 8.635.0).
const SKILL_VERSION = /^version:\s*(\S+)/m.exec(readFileSync(join(import.meta.dir, '..', 'SKILL.md'), 'utf8'))?.[1] ?? 'unknown';

const ALL_PLATFORMS: Platform[] = ['twitter', 'linkedin', 'bluesky', 'instagram'];
const AVAILABLE_PLATFORMS: Platform[] = ['twitter', 'bluesky', 'linkedin', 'instagram'];

const program = new Command();

program
  .name('broadcast')
  .description('Multi-platform social media posting CLI')
  .version(SKILL_VERSION);

// Edit command (LinkedIn only: replaces an existing post's commentary in place)
program
  .command('edit')
  .description('Edit the text of an existing LinkedIn post (card/media untouched)')
  .requiredOption('-u, --urn <urn>', 'Post URN, e.g. urn:li:share:123 or urn:li:ugcPost:123')
  .option('-c, --content <text>', 'New content (markdown styling supported)')
  .option('-f, --file <path>', 'Load new content from file')
  .option('-d, --dry-run', 'Preview without editing', false)
  .option('--linkedin-plain', 'Skip the LinkedIn styling gate (plain text on purpose; the gate runs only with house_style = true)', false)
  .action(async (options) => {
    const { readFileSync } = await import('fs');
    const { loadCredentials } = await import('./config');
    const { LinkedInAdapter, gatedEditCommentary } = await import('./adapters/linkedin');
    const { formatPreview } = await import('./commands/post');
    const { linkedInStylingProblem } = await import('./format/linkedin-formatter');

    const content: string | undefined = options.file ? readFileSync(options.file, 'utf-8') : options.content;
    if (!content?.trim()) {
      console.error('❌ Provide --content or --file');
      process.exit(1);
    }
    const problem = options.linkedinPlain || !houseStyleOn() ? null : linkedInStylingProblem(content);
    if (problem) {
      console.error(`❌ ${problem}`);
      process.exit(1);
    }

    console.log(formatPreview('linkedin', content, undefined, { linkedinShareCard: false }));
    if (options.dryRun) {
      console.log('\n🔍 Dry run — post not edited.');
      return;
    }

    const adapter = new LinkedInAdapter(loadCredentials());
    const result = await gatedEditCommentary(adapter, options.urn, content);
    if (result.blockedMessage) console.error(result.blockedMessage);
    for (const fl of result.flags ?? []) console.error(`unearned flag, not blocking: ${fl}`);
    if (!result.success) {
      console.error(`❌ ${result.error}`);
      process.exit(1);
    }
    console.log(`✅ Edited: ${result.postUrl}`);
  });

// Post command
program
  .command('post')
  .description('Post content to social media platforms')
  .option('-c, --content <text>', 'Content to post')
  .option('-f, --file <path>', 'Load content from file')
  .option('-m, --media <paths>', 'Comma-separated media file paths (images or videos)')
  .option('-p, --platforms <list>', 'Comma-separated platforms (twitter,linkedin,bluesky,instagram) or "all" (= every one of those four)', 'twitter')
  .option('-d, --dry-run', 'Preview without posting', false)
  .option('--pii-reviewed', 'Video PII gate: findings were reviewed, proceed', false)
  .option('--skip-pii', 'Video PII gate: skip the scan (loud; only when Gemini is down)', false)
  .option('--linkedin-plain', 'Skip the LinkedIn styling gate (plain text on purpose; the gate runs only with house_style = true)', false)
  .action(async (options) => {
    // Parse platforms
    let platforms: Platform[];
    if (options.platforms === 'all') {
      platforms = AVAILABLE_PLATFORMS;
    } else {
      platforms = options.platforms
        .split(',')
        .map((p: string) => {
          const name = p.trim().toLowerCase();
          return name === 'x' ? 'twitter' : name;
        }) as Platform[];
    }

    // Filter to only available platforms
    const validPlatforms = platforms.filter(p => AVAILABLE_PLATFORMS.includes(p));
    const unavailable = platforms.filter(p => !AVAILABLE_PLATFORMS.includes(p));

    if (unavailable.length > 0) {
      console.log(`⚠️  Skipping unavailable platforms: ${unavailable.join(', ')}`);
    }

    if (validPlatforms.length === 0) {
      console.error('❌ No valid platforms specified');
      process.exit(1);
    }

    // Parse media paths
    const mediaPaths = options.media
      ? options.media.split(',').map((p: string) => p.trim())
      : undefined;

    try {
      const result = await executePost({
        content: options.content,
        file: options.file,
        media: mediaPaths,
        platforms: validPlatforms,
        dryRun: options.dryRun,
        piiReviewed: options.piiReviewed,
        skipPii: options.skipPii,
        // The LinkedIn styling gate is part of the optional house style (Config.md `house_style`).
        linkedinPlain: options.linkedinPlain || !houseStyleOn(),
      });

      // A failure with zero platform results is a pre-flight stop (media load, PII gate):
      // that exits 1 even in dry-run, so scripts can see the gate fired.
      if (result.failureCount > 0 && (!options.dryRun || result.results.length === 0)) {
        process.exit(1);
      }
    } catch (error: any) {
      console.error(`❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// Article command — X long-form Article plus the intro post that links it
program
  .command('article')
  .description('Publish a markdown file as an X Article and post the intro with video + link')
  .requiredOption('-f, --file <path>', 'Markdown file holding the article body')
  .option('-t, --title <text>', 'Article title (defaults to the leading # heading)')
  .option('--cover <path>', 'Cover image for the article')
  .option('-i, --intro <text>', 'Intro post text — the article link is appended', '')
  .option('-v, --video <path>', 'Video attached to the intro post')
  .option('--canonical <url>', 'Source URL, replied to the article so X unfurls a link card')
  .option('--publish', 'Publish the article and post the intro (default: draft only)', false)
  .option('-d, --dry-run', 'Preview both legs without touching the API', false)
  .option('--pii-reviewed', 'Video PII gate: findings were reviewed, proceed', false)
  .option('--skip-pii', 'Video PII gate: skip the scan (loud; only when Gemini is down)', false)
  .action(async (options) => {
    try {
      await executeArticle({
        file: options.file,
        title: options.title,
        cover: options.cover,
        intro: options.intro,
        video: options.video,
        canonical: options.canonical,
        publish: options.publish,
        dryRun: options.dryRun,
        piiReviewed: options.piiReviewed,
        skipPii: options.skipPii,
      });
    } catch (error: any) {
      console.error(`❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Check connection status for all platforms')
  .action(async () => {
    console.log('\n📊 Broadcast Status\n');

    const credentials = loadCredentials();

    for (const platform of ALL_PLATFORMS) {
      const configured = isPlatformConfigured(platform, credentials);
      const implemented = AVAILABLE_PLATFORMS.includes(platform);

      if (!implemented) {
        console.log(`⬜ ${platform.toUpperCase().padEnd(10)} Not implemented yet`);
        continue;
      }

      if (!configured) {
        console.log(`❌ ${platform.toUpperCase().padEnd(10)} Not configured`);
        continue;
      }

      // Verify credentials for configured platforms
      if (platform === 'twitter') {
        const adapter = new TwitterAdapter(credentials);
        const me = await adapter.getMe();
        if (me) {
          console.log(`✅ ${platform.toUpperCase().padEnd(10)} @${me.username} (${me.name})`);
        } else {
          console.log(`⚠️  ${platform.toUpperCase().padEnd(10)} Configured but verification failed`);
        }
      } else if (platform === 'bluesky') {
        const adapter = new BlueskyAdapter(credentials);
        const me = await adapter.getMe();
        if (me) {
          console.log(`✅ ${platform.toUpperCase().padEnd(10)} @${me.handle}`);
        } else {
          console.log(`⚠️  ${platform.toUpperCase().padEnd(10)} Configured but verification failed`);
        }
      } else if (platform === 'linkedin') {
        const adapter = new LinkedInAdapter(credentials);
        const me = await adapter.getMe();
        if (me) {
          console.log(`✅ ${platform.toUpperCase().padEnd(10)} ${me.name}`);
        } else {
          console.log(`⚠️  ${platform.toUpperCase().padEnd(10)} Configured but verification failed`);
        }
      } else if (platform === 'instagram') {
        const adapter = new InstagramAdapter(credentials);
        const me = await adapter.getMe();
        if (me) {
          console.log(`✅ ${platform.toUpperCase().padEnd(10)} @${me.username}`);
        } else {
          console.log(`⚠️  ${platform.toUpperCase().padEnd(10)} Configured but verification failed`);
        }
      }
    }

    console.log('');
  });

// Auth command
program
  .command('auth <platform>')
  .description('Configure authentication for a platform')
  .option('-i, --identifier <handle>', 'Account identifier (for Bluesky: handle)')
  .option('-p, --password <password>', 'App password or access token')
  .action(async (platform: string, options: { identifier?: string; password?: string }) => {
    const validPlatforms = ['twitter', 'linkedin', 'bluesky', 'instagram'];

    if (!validPlatforms.includes(platform)) {
      console.error(`❌ Unknown platform: ${platform}`);
      console.log(`Valid platforms: ${validPlatforms.join(', ')}`);
      process.exit(1);
    }

    if (platform === 'twitter') {
      // X auth belongs to the X skill: its OAuth 2.0 token store, or the OAuth 1.0a env keys for text only.
      const credentials = loadCredentials();
      if (isPlatformConfigured('twitter', credentials)) {
        const adapter = new TwitterAdapter(credentials);
        const me = await adapter.getMe();
        if (me) {
          console.log(`✅ Twitter already configured as @${me.username}`);
        } else {
          console.log('⚠️  Twitter credentials found but verification failed');
          console.log('\nRe-authorize the X grant: bun ~/.claude/skills/X/Tools/bookmarks.ts authorize (skills/X/Setup.md)');
        }
      } else {
        console.log('❌ Twitter not configured');
        console.log('\nX posting runs on the X skill. Set it up with skills/X/Setup.md:');
        console.log('  the OAuth 2.0 token store (text and media), then');
        console.log('  bun ~/.claude/skills/X/Tools/bookmarks.ts authorize');
        console.log('Text-only fallback: TWITTER_API_KEY, TWITTER_API_KEY_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET in ~/.claude/.env');
      }
    } else if (platform === 'bluesky') {
      // Check if already configured
      const credentials = loadCredentials();
      if (isPlatformConfigured('bluesky', credentials) && !options.identifier) {
        const adapter = new BlueskyAdapter(credentials);
        const me = await adapter.getMe();
        if (me) {
          console.log(`✅ Bluesky already configured as @${me.handle}`);
          return;
        }
      }

      // Need identifier and password
      if (!options.identifier || !options.password) {
        console.log('❌ Bluesky requires identifier and app password');
        console.log('\nUsage:');
        console.log('  broadcast auth bluesky --identifier your.handle.bsky.social --password your-app-password');
        console.log('\nTo create an app password:');
        console.log('  1. Go to https://bsky.app/settings/app-passwords');
        console.log('  2. Click "Add App Password"');
        console.log('  3. Give it a name (e.g., "Broadcast")');
        console.log('  4. Copy the generated password');
        return;
      }

      // Verify and save credentials
      console.log('Verifying Bluesky credentials...');
      const testCreds = {
        ...credentials,
        bluesky: {
          identifier: options.identifier,
          password: options.password,
        },
      };

      const adapter = new BlueskyAdapter(testCreds);
      const me = await adapter.getMe();

      if (me) {
        saveCredentials({ bluesky: testCreds.bluesky });
        console.log(`✅ Bluesky configured as @${me.handle}`);
      } else {
        console.log('❌ Failed to verify Bluesky credentials');
        console.log('Please check your identifier and app password.');
      }
    } else if (platform === 'linkedin') {
      // Check if already configured
      const credentials = loadCredentials();
      if (isPlatformConfigured('linkedin', credentials) && !options.password) {
        const adapter = new LinkedInAdapter(credentials);
        const me = await adapter.getMe();
        if (me) {
          console.log(`✅ LinkedIn already configured as ${me.name}`);
          return;
        }
      }

      // Need access token (passed as --password for simplicity)
      if (!options.password) {
        console.log('❌ LinkedIn requires an access token');
        console.log('\nUsage:');
        console.log('  broadcast auth linkedin --password YOUR_ACCESS_TOKEN');
        console.log('\nTo get an access token:');
        console.log('  1. Create a LinkedIn App at https://www.linkedin.com/developers/');
        console.log('  2. Request the "Share on LinkedIn" product');
        console.log('  3. Generate an access token with w_member_social scope');
        console.log('  4. Or use the LinkedIn Token Generator in your app settings');
        return;
      }

      // Verify and save credentials
      console.log('Verifying LinkedIn credentials...');
      const testCreds = {
        ...credentials,
        linkedin: {
          accessToken: options.password,
        },
      };

      const adapter = new LinkedInAdapter(testCreds);
      const me = await adapter.getMe();

      if (me) {
        saveCredentials({ linkedin: testCreds.linkedin });
        console.log(`✅ LinkedIn configured as ${me.name}`);
      } else {
        console.log('❌ Failed to verify LinkedIn credentials');
        console.log('Please check your access token.');
      }
    } else if (platform === 'instagram') {
      // Instagram uses an OAuth code flow, not a simple token paste.
      const credentials = loadCredentials();
      if (isPlatformConfigured('instagram', credentials)) {
        const adapter = new InstagramAdapter(credentials);
        const me = await adapter.getMe();
        if (me) {
          console.log(`✅ Instagram already configured as @${me.username}`);
          return;
        }
        console.log('⚠️  Instagram token found but verification failed — it may have expired.');
      }
      console.log('Instagram uses a one-time OAuth flow. Run the auth helper:');
      console.log('');
      console.log('  bun ~/.claude/skills/Broadcast/Tools/InstagramAuth.ts url       # 1. get the consent URL');
      console.log('  bun ~/.claude/skills/Broadcast/Tools/InstagramAuth.ts exchange --code CODE   # 2. exchange the code');
      console.log('  bun ~/.claude/skills/Broadcast/Tools/InstagramAuth.ts refresh    # keep the 60-day token alive');
      console.log('');
      console.log('See Intents/Auth.md → Instagram for the full Meta-app setup runbook.');
    } else {
      console.log(`⚠️  ${platform} auth not implemented yet`);
      console.log('Coming soon...');
    }
  });

// Parse and run
program.parse();
