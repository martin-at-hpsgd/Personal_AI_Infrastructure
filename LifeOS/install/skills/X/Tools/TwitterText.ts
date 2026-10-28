/** X/Twitter weighted-length validation without text mutation. */

export const MAX_TWEET_WEIGHTED_LENGTH = 280;
export const TRANSFORMED_URL_LENGTH = 23;

const URL_CANDIDATE = /https?:\/\/[^\s<>]+/giu;
const SIMPLE_TRAILING_PUNCTUATION = /[.,!?;:\u2019\u201d"']+$/u;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function trimTrailingUrlPunctuation(candidate: string): string {
  let url = candidate.replace(SIMPLE_TRAILING_PUNCTUATION, "");
  const pairs: Array<[string, string]> = [["(", ")"], ["[", "]"], ["{", "}"]];

  for (const [open, close] of pairs) {
    const opens = [...url].filter((char) => char === open).length;
    let closes = [...url].filter((char) => char === close).length;
    while (url.endsWith(close) && closes > opens) {
      url = url.slice(0, -1);
      closes--;
    }
  }

  return url;
}

function codePointWeight(codePoint: number): number {
  // twitter-text v3 default config: these four ranges weigh 1; all other
  // Unicode code points weigh 2. Iteration uses code points, never UTF-16 units.
  if (
    codePoint <= 0x10ff ||
    (codePoint >= 0x2000 && codePoint <= 0x200d) ||
    (codePoint >= 0x2010 && codePoint <= 0x201f) ||
    (codePoint >= 0x2032 && codePoint <= 0x2037)
  ) {
    return 1;
  }
  return 2;
}

function isEmojiGrapheme(grapheme: string): boolean {
  // X scales a valid emoji sequence as one unit with the default weight (2),
  // including ZWJ families, flags, and keycap sequences.
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(grapheme);
}

function weightedNonUrlLength(text: string): number {
  let length = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (isEmojiGrapheme(segment)) {
      length += 2;
      continue;
    }
    for (const codePoint of segment) length += codePointWeight(codePoint.codePointAt(0)!);
  }
  return length;
}

export function getTweetWeightedLength(text: string): number {
  let weightedLength = 0;
  let cursor = 0;
  URL_CANDIDATE.lastIndex = 0;

  for (const match of text.matchAll(URL_CANDIDATE)) {
    const start = match.index;
    const url = trimTrailingUrlPunctuation(match[0]);
    if (!url) continue;
    weightedLength += weightedNonUrlLength(text.slice(cursor, start));
    weightedLength += TRANSFORMED_URL_LENGTH;
    cursor = start + url.length;
  }

  return weightedLength + weightedNonUrlLength(text.slice(cursor));
}

// X Premium long posts: the API accepts up to 25,000 chars on the same POST /2/tweets
// endpoint (returned as note_tweet). Callers opt in via maxWeighted; the account must
// actually have Premium or the API rejects it server-side (fail closed either way).
export const MAX_LONG_POST_LENGTH = 25000;

export function assertValidTweetText(text: string, maxWeighted: number = MAX_TWEET_WEIGHTED_LENGTH): string {
  const weightedLength = getTweetWeightedLength(text);
  if (weightedLength > maxWeighted) {
    throw new Error(`Tweet exceeds X weighted length (${weightedLength}/${maxWeighted}); text was not modified`);
  }
  return text;
}
