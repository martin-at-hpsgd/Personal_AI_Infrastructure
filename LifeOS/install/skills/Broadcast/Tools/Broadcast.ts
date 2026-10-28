#!/usr/bin/env bun
/**
 * Broadcast CLI - Multi-Platform Social Media Posting
 *
 * Usage:
 *   bun ~/.claude/skills/Broadcast/Tools/Broadcast.ts post --content "Hello" --platforms twitter
 *   bun ~/.claude/skills/Broadcast/Tools/Broadcast.ts status
 *   bun ~/.claude/skills/Broadcast/Tools/Broadcast.ts auth <platform>
 */

// Re-export the main CLI
import '../src/index';
