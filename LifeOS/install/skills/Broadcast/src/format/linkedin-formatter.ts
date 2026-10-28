/**
 * LinkedIn text formatting.
 *
 * LinkedIn posts have no rich text: no bold, no italic, no anchor text, no headers.
 * What people see as bold/italic in the feed is Unicode Mathematical Alphanumeric
 * Symbols. LinkedIn's UI font is sans-serif, so the SANS-SERIF math blocks are the
 * ones that look native (𝗯𝗼𝗹𝗱 / 𝘪𝘵𝘢𝘭𝘪𝘤 / 𝙗𝙤𝙩𝙝); the serif blocks (𝐛𝐨𝐥𝐝) read as a
 * different typeface, so they are not used.
 *
 * Caveats that bound the styling:
 *   - Math-alphabet characters are invisible to LinkedIn search and are read letter-
 *     by-letter ("mathematical sans-serif bold b...") by screen readers. Style a hook
 *     or a header line, never body prose.
 *   - Digits exist only in the bold block (U+1D7EC..). Italic digits stay plain.
 *
 * Pipeline in the adapter: formatForLinkedIn (markdown → Unicode) → escapeLittleText
 * (reserved chars → backslash-escaped, mentions/hashtags/URLs left live) →
 * truncateCodePoints (never mid-mention) → assertLittleText (wire-form gate).
 *
 * The three "real link" shapes LinkedIn's Posts API commentary supports, per the
 * little-text-format grammar:
 *   - bare URL           → auto-linked (and, with no media, the first URL becomes the card)
 *   - @[Name](urn:li:person:ID) / @[Name](urn:li:organization:ID) → profile/company link.
 *     Fallback text must match one of the member's names (first, last, or full;
 *     case-sensitive) or the organization's full name, else it renders plain.
 *   - #Word              → hashtag link
 */

type Style = 'bold' | 'italic' | 'boldItalic';

// Mathematical Sans-Serif blocks. Each is 26 contiguous uppercase then 26 lowercase.
const SANS = {
  bold: { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec },
  italic: { upper: 0x1d608, lower: 0x1d622, digit: null },
  boldItalic: { upper: 0x1d63c, lower: 0x1d656, digit: 0x1d7ec },
} as const;

const URL_PATTERN = /^https?:\/\/\S+/i;
const MENTION_PATTERN = /^@\[[^\]\n]+\]\(urn:li:(?:person|organization):[A-Za-z0-9_-]+\)/;
const MENTION_PATTERN_GLOBAL = /@\[[^\]\n]+\]\(urn:li:(?:person|organization):[A-Za-z0-9_-]+\)/g;
const MARKDOWN_LINK_PATTERN = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/i;

const HEADER_LINE = /^\s{0,3}#{1,6}\s+(.*)$/;
const BULLET_LINE = /^\s{0,3}[-+*]\s+(.*)$/;
const ORDERED_LINE = /^\s{0,3}(\d+[.)])\s+(.*)$/;
const QUOTE_LINE = /^\s{0,3}>\s?(.*)$/;

// LinkedIn Posts API "little text format" reserved characters. Unescaped, the parser
// silently swallows content: the API returns 201 and the post is cut at the first
// unescaped "(". Grammar: learn.microsoft.com/linkedin/marketing/community-management/shares/little-text-format
const LITTLE_TEXT_RESERVED = new Set(['\\', '|', '{', '}', '@', '[', ']', '(', ')', '<', '>', '#', '*', '_', '~']);

/**
 * Markdown-ish input → LinkedIn-renderable Unicode text.
 *
 *   **bold** *italic* ***both***   → sans-serif math alphabets
 *   # Header / ## Header           → BOLD ALL-CAPS line (hashes dropped; small type, caps read as a header)
 *   - item / * item / + item       → • item
 *   1. item                        → 1. item (marker kept)
 *   > quote                        → italic line
 *   [text](https://url)            → text: https://url   (anchor text is impossible on LinkedIn)
 *   @[Name](urn:li:person:ID)      → untouched (real mention)
 *   `code`, URLs                   → untouched
 */
export function formatForLinkedIn(text: string): string {
  return text.split('\n').map(formatLine).join('\n');
}

const BOLD_SPAN = /\*\*[^*\n]+\*\*/;

/**
 * Every LinkedIn post carries the enhancement styling: at least a bold hook
 * (`**…**`) or one `# Header` line. Plain text passes through formatForLinkedIn
 * unchanged, so a cross-posted tweet would otherwise go out unstyled. Returns the
 * refusal reason, or null when the post is styled.
 */
export function linkedInStylingProblem(text: string): string | null {
  if (BOLD_SPAN.test(text)) return null;
  if (text.split('\n').some(line => HEADER_LINE.test(line))) return null;
  return 'LinkedIn post has no styling. Add a **bold hook** line (or a # Header), or pass --linkedin-plain with a reason.';
}

function formatLine(line: string): string {
  const header = HEADER_LINE.exec(line);
  if (header) {
    // Headers are uppercased: LinkedIn renders posts in small
    // type, so a bold sans line alone does not read as a section header. URLs,
    // mentions, and hashtags inside the line are protected spans and stay as written.
    return applyStyle(formatInline(header[1].trim()), 'bold', { uppercase: true });
  }

  const bullet = BULLET_LINE.exec(line);
  if (bullet) {
    return `• ${formatInline(bullet[1])}`;
  }

  const ordered = ORDERED_LINE.exec(line);
  if (ordered) {
    return `${ordered[1]} ${formatInline(ordered[2])}`;
  }

  const quote = QUOTE_LINE.exec(line);
  if (quote) {
    return applyStyle(formatInline(quote[1]), 'italic');
  }

  return formatInline(line);
}

/**
 * Escape little-text reserved characters everywhere EXCEPT inside spans LinkedIn
 * must see raw: URLs (auto-link), mentions, and letter-led hashtags.
 */
export function escapeLittleText(text: string): string {
  let output = '';
  let index = 0;

  while (index < text.length) {
    const live = readLiveSpan(text, index);
    if (live !== null) {
      output += text.slice(index, live);
      index = live;
      continue;
    }

    const char = text[index];
    output += LITTLE_TEXT_RESERVED.has(char) ? `\\${char}` : char;
    index += 1;
  }

  return output;
}

/**
 * Wire-form gate: throws if the escaped commentary still contains a reserved
 * character that is not escaped, not inside a URL, not a well-formed mention, and
 * not a hashtag. Run this on the exact string that goes in the POST body.
 */
export function assertLittleText(text: string): void {
  let index = 0;

  while (index < text.length) {
    const live = readLiveSpan(text, index);
    if (live !== null) {
      index = live;
      continue;
    }

    const char = text[index];
    if (char === '\\') {
      const next = text[index + 1];
      if (next === undefined || !LITTLE_TEXT_RESERVED.has(next)) {
        throw new Error(`little-text: dangling backslash at ${index}: ${context(text, index)}`);
      }
      index += 2;
      continue;
    }

    if (LITTLE_TEXT_RESERVED.has(char)) {
      throw new Error(`little-text: unescaped "${char}" at ${index}: ${context(text, index)}`);
    }

    index += 1;
  }
}

/**
 * Truncate by code point (math alphabets are supplementary-plane, two UTF-16 units
 * each). Never cuts inside a mention (a half mention is a broken link AND an
 * unescaped "@[", so the cut moves to the mention's start) and never between an
 * escaping backslash and the character it escapes.
 */
export function truncateCodePoints(text: string, max: number): string {
  if (max <= 0) {
    return '';
  }

  const codePoints = Array.from(text);
  if (codePoints.length <= max) {
    return text;
  }

  if (max <= 3) {
    return '.'.repeat(max);
  }

  let cut = max - 3;
  for (const span of mentionSpansInCodePoints(text)) {
    if (cut > span.start && cut < span.end) {
      cut = span.start;
      break;
    }
  }

  // A hashtag sign with its word cut off is a bare "#", which is reserved and
  // unescaped on the wire. Drop the sign too.
  while (cut > 0 && codePoints[cut - 1] === '#') {
    cut -= 1;
  }

  // Never split an escape pair: a trailing escaping backslash is a dangling
  // backslash on the wire, which assertLittleText rejects. An odd run of
  // backslashes before the cut means the last one is escaping what follows.
  let run = 0;
  while (cut - 1 - run >= 0 && codePoints[cut - 1 - run] === '\\') {
    run += 1;
  }
  if (run % 2 === 1) {
    cut -= 1;
  }

  return codePoints.slice(0, cut).join('').replace(/\s+$/, '') + '...';
}

/**
 * Mentions in the text, as [start, end) code-point offsets.
 */
export function mentionSpansInCodePoints(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(MENTION_PATTERN_GLOBAL)) {
    const start = Array.from(text.slice(0, match.index)).length;
    spans.push({ start, end: start + Array.from(match[0]).length });
  }
  return spans;
}

// --- internals ---------------------------------------------------------------

function context(text: string, index: number): string {
  return JSON.stringify(text.slice(Math.max(0, index - 20), index + 20));
}

/**
 * End index of a span that must reach LinkedIn untouched (URL, mention, hashtag
 * sign), or null when `index` starts no such span.
 */
function readLiveSpan(text: string, index: number): number | null {
  const rest = text.slice(index);

  const url = URL_PATTERN.exec(rest);
  if (url) {
    return index + url[0].length;
  }

  const mention = MENTION_PATTERN.exec(rest);
  if (mention) {
    return index + mention[0].length;
  }

  if (isHashtagStart(text, index)) {
    return index + 1;
  }

  return null;
}

/**
 * `#` counts as a hashtag sign only at line start or after whitespace AND when a
 * letter follows. "#42", "(No. 42)" and "C#" stay escaped, so the silent
 * truncation class cannot come back through this door.
 */
function isHashtagStart(text: string, index: number): boolean {
  if (text[index] !== '#') {
    return false;
  }
  const prev = index === 0 ? ' ' : text[index - 1];
  const next = text[index + 1] ?? '';
  return /\s/.test(prev) && /\p{L}/u.test(next);
}

function formatInline(text: string): string {
  let output = '';
  let index = 0;

  while (index < text.length) {
    const protectedEnd = getProtectedSpanEnd(text, index);
    if (protectedEnd !== null) {
      output += text.slice(index, protectedEnd);
      index = protectedEnd;
      continue;
    }

    const link = MARKDOWN_LINK_PATTERN.exec(text.slice(index));
    if (link) {
      output += `${formatInline(link[1])}: ${link[2]}`;
      index += link[0].length;
      continue;
    }

    const escaped = readEscape(text, index);
    if (escaped !== null) {
      output += escaped.value;
      index = escaped.end;
      continue;
    }

    const marker = readMarker(text, index);
    if (marker !== null) {
      const closingIndex = findClosingMarker(text, index + marker.token.length, marker.token);
      if (closingIndex === -1) {
        output += marker.token;
        index += marker.token.length;
        continue;
      }

      output += applyStyle(text.slice(index + marker.token.length, closingIndex), marker.style);
      index = closingIndex + marker.token.length;
      continue;
    }

    output += text[index];
    index += 1;
  }

  return output;
}

function readMarker(text: string, index: number): { token: string; style: Style } | null {
  if (text.startsWith('***', index)) {
    return { token: '***', style: 'boldItalic' };
  }

  if (text.startsWith('**', index)) {
    return { token: '**', style: 'bold' };
  }

  if (text[index] === '*') {
    return { token: '*', style: 'italic' };
  }

  return null;
}

function findClosingMarker(text: string, start: number, marker: string): number {
  let index = start;

  while (index < text.length) {
    const protectedEnd = getProtectedSpanEnd(text, index);
    if (protectedEnd !== null) {
      index = protectedEnd;
      continue;
    }

    const escaped = readEscape(text, index);
    if (escaped !== null) {
      index = escaped.end;
      continue;
    }

    if (text.startsWith(marker, index)) {
      return index;
    }

    index += 1;
  }

  return -1;
}

function applyStyle(text: string, style: Style, options: { uppercase?: boolean } = {}): string {
  let output = '';
  let index = 0;

  while (index < text.length) {
    const protectedEnd = getProtectedSpanEnd(text, index);
    if (protectedEnd !== null) {
      output += text.slice(index, protectedEnd);
      index = protectedEnd;
      continue;
    }

    const escaped = readEscape(text, index);
    if (escaped !== null) {
      output += escaped.value;
      index = escaped.end;
      continue;
    }

    const char = options.uppercase ? text[index].toUpperCase() : text[index];
    output += convertChar(char, style);
    index += 1;
  }

  return output;
}

function convertChar(char: string, style: Style): string {
  const code = char.charCodeAt(0);
  const block = SANS[style];

  if (code >= 0x41 && code <= 0x5a) {
    return String.fromCodePoint(block.upper + (code - 0x41));
  }

  if (code >= 0x61 && code <= 0x7a) {
    return String.fromCodePoint(block.lower + (code - 0x61));
  }

  if (code >= 0x30 && code <= 0x39 && block.digit !== null) {
    return String.fromCodePoint(block.digit + (code - 0x30));
  }

  return char;
}

/**
 * Spans inline formatting must not touch: URLs, mentions, `code`.
 */
function getProtectedSpanEnd(text: string, index: number): number | null {
  const rest = text.slice(index);

  const url = URL_PATTERN.exec(rest);
  if (url) {
    return index + url[0].length;
  }

  const mention = MENTION_PATTERN.exec(rest);
  if (mention) {
    return index + mention[0].length;
  }

  if (text[index] === '`') {
    const end = text.indexOf('`', index + 1);
    if (end === -1) {
      return text.length;
    }

    return end + 1;
  }

  return null;
}

function readEscape(text: string, index: number): { value: string; end: number } | null {
  if (text[index] !== '\\') {
    return null;
  }

  if (index + 1 >= text.length) {
    return { value: '\\', end: index + 1 };
  }

  const next = text[index + 1];
  if (next === '*' || next === '\\') {
    return { value: next, end: index + 2 };
  }

  return { value: `\\${next}`, end: index + 2 };
}
