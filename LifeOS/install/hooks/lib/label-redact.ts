/**
 * @version 1.1.1
 * label-redact.ts — the one label-aware secret redactor for captured and judged text.
 *
 * `redactSecretValues` (egress-shapes.ts) is shape-based: it replaces values that LOOK
 * like credentials, and its assignment rule needs 12+ characters. A short value under a
 * credential label (`password: hunter2`, `"token":"abc"`, `--password hunter2`) has no
 * shape, so it survived into the judge engine and the event logs
 * (EventLogger, via event-capture). This module adds a label pass that redacts the value
 * after any credential label regardless of its length, then runs the shape pass.
 *
 * 1.1.0 (ISA 20261015-boundary-primitives, C3/C6/C9): passphrases are redacted to the end of
 * their line (a passphrase has spaces), PIN and passcode labels are judged by their words so
 * `spin`, `hairpin` and `pinned` stay readable, verification codes next to a verification
 * phrase are redacted whether numeric or alphanumeric (`A7K2Q9`, `G-482913`, `7KQ2-M9XZ`),
 * `isVerificationCode` is the shared detector the message filter uses, and `redactStructured`
 * cuts cycles instead of overflowing the stack. `LIFEOS/TOOLS/lib/Boundary.ts` is the single
 * entry tools import; this file stays the implementation because hooks load it directly.
 *
 * Kept out of egress-shapes.ts on purpose: that file is byte-mirrored into the LifeOSHooks
 * plugin, and the egress gate refuses on its shapes; a label rule here only scrubs.
 *
 * Callers redact the WHOLE string first and cut afterwards (`redactThenCut`), so a cut
 * can never split a token or separate a label from its value.
 * Audit: hooks shard ac items 2-4 (2026-10-13).
 */

import { redactSecretValues } from './egress-shapes';

const MARK = '[REDACTED]';

/** Words that make a key or label a credential label. Matched as the LAST word of the label
 * (camelCase, snake_case and kebab-case split), so `apiKeyHelper` and `maxTokens` stay readable. */
const LABEL_LAST_WORD = 'password|passwd|passphrase|passcode|pwd|secret|token|cookie|credentials?|authorization|apikey|api[_-]?key|access[_-]?key|private[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token|session[_-]?key|signing[_-]?key';

/** A labelled value: quoted (escaped-quote, double or single) or bare up to whitespace / delimiter.
 * A value opened by an escaped quote (`\"…\"`, JSON inside a JSON string) closes at the next escaped
 * quote; a value opened by a plain quote closes only at an unescaped one, so an embedded `\"` stays
 * inside the redacted value (2026-10-14). */
const VALUE =
  String.raw`(?:\\"(?:[^"\\\n]|\\(?!")[^\n])*(?:\\"|(?=\n)|$)|"(?:[^"\\\n]|\\[^\n])*(?:"|(?=\n)|$)|'[^'\n]*'|(?!\[REDACTED\])[^\s,;&|)}\]"']+)`;

/** `label = value`, `label: value`, `"label":"value"`, `label=\"value\"`. Group 1 is the label and
 * separator, kept; the value is replaced. The label must end the key: `[A-Za-z0-9_-]*` before it
 * allows prefixes like `DB_PASSWORD`, `x-api-key`, `githubToken`. */
const LABELLED_ASSIGNMENT = new RegExp(
  String.raw`(\b[A-Za-z0-9_-]*?(?:${LABEL_LAST_WORD})(?:\\?["'])?\s*[=:]\s*)` + VALUE,
  'gi',
);

/** CLI flags: `--password hunter2`, `--token=abc`, `-p` is too ambiguous and is left alone. A double-quoted
 * value closes only at an unescaped quote. */
const FLAG_VALUE = String.raw`(?!\[REDACTED\])(?:"(?:[^"\\\n]|\\[^\n])*(?:"|(?=\n)|$)|'[^'\n]*'|[^\s"'-][^\s]*)`;
const LABELLED_FLAG = new RegExp(String.raw`(--(?:[A-Za-z0-9]+-)*(?:${LABEL_LAST_WORD})(?:=|\s+))` + FLAG_VALUE, 'gi');

/** PIN flags: `--pin 4821`, `--card-pin=1234`, `--pin-code 1234`. `--pinned` and `--spin` do not match. */
const PIN_FLAG = new RegExp(String.raw`(--(?:[A-Za-z0-9]+-)*(?:pin(?:-?(?:code|number))?)(?:=|\s+))` + FLAG_VALUE, 'gi');

/** HTTP-style headers: `Authorization: Basic abc`, `Cookie: sid=1`. The whole rest of the line goes. */
const LABELLED_HEADER = /(\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*)(?!\[REDACTED\])[^\s"][^\n"]*/gi;

/** An unquoted passphrase runs to the end of its line (`passphrase: correct horse battery staple`,
 * `my passphrase is …`). Quoted values are left to LABELLED_ASSIGNMENT, which closes at the quote. */
const PASSPHRASE_LINE =
  /(\b[A-Za-z0-9_-]*?pass[ _-]?phrase(?:\\?["'])?(?:\s*[=:]\s*|\s+(?:is|was)\s*:?\s*))(?!\[REDACTED\])(?!\\?["'])(?=\S)[^\n]*/gi;

/** A key that ends in pin, passcode, pin code or pin number (`pin`, `PIN`, `user_pin`, `pinCode`,
 * `card_pin_number`), followed by an assignment. The key is confirmed by `isPinLabel` in the replacer,
 * so a lexical match on `hairpin` or `spin` is rejected. Group 1: label and separator. Group 2: the key. */
const PIN_KEYED = new RegExp(
  String.raw`(\b([A-Za-z0-9_-]*?(?:pin|passcode)(?:[_-]?(?:code|number))?)(?:\\?["'])?\s*[=:]\s*)` + VALUE,
  'gi',
);

/** PIN in prose: `PIN is 4821`, `my pin 4821`, `pin code: 4821`, `passcode is 1234567`. The value must be
 * a 4-16 character token holding a digit, so `the pin is broken` and `pin 3 of the header` stay. */
const PIN_PROSE =
  /\b((?:pin|passcode)(?:[\s_-]?(?:code|number))?(?:\s*#)?(?:\s*[:=]\s*|\s+(?:is|was)\s*[:=]?\s*|\s+))((?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{3,15})(?![A-Za-z0-9])/gi;

/** A phrase that announces a one-time code. Narrow on purpose: `exit code` and `source code` are not it. */
const VERIFY_PHRASE =
  /\b(?:(?:verification|verify|security|confirmation|login|log-in|sign[- ]in|one[- ]time|access|auth|authentication|2fa|mfa|otp)\s+(?:code|passcode|pin)|passcode|otp)\b/gi;

/** A candidate code: alphanumerics with at most one hyphen group (`A7K2Q9`, `G-482913`, `7KQ2-M9XZ`).
 * A match counts only when it holds a digit and has 4-16 alphanumerics (`isCodeToken`). */
const CODE_TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9]{1,12}(?:-[A-Za-z0-9]{2,12})?(?![A-Za-z0-9_-])/g;
/** Characters on either side of a verification phrase within which a code token is redacted. */
const CODE_WINDOW = 60;

function isCodeToken(token: string, upperOnly: boolean): boolean {
  const alnum = token.replace(/-/g, '');
  if (alnum.length < 4 || alnum.length > 16 || !/\d/.test(alnum)) return false;
  return !upperOnly || /^[A-Z0-9]+$/.test(alnum);
}

/** Redact every code token within CODE_WINDOW characters, on the same line, of a verification phrase. */
function redactVerificationCodes(text: string): string {
  if (!/\d/.test(text)) return text;
  return text.split('\n').map((line) => {
    const windows: Array<[number, number]> = [];
    for (const m of line.matchAll(VERIFY_PHRASE)) {
      const at = m.index ?? 0;
      windows.push([at - CODE_WINDOW, at + m[0].length + CODE_WINDOW]);
    }
    if (windows.length === 0) return line;
    return line.replace(CODE_TOKEN, (token: string, at: number) => {
      const end = at + token.length;
      const near = windows.some(([s, e]) => end > s && at < e);
      return near && isCodeToken(token, false) ? MARK : token;
    });
  }).join('\n');
}

/** Replace each PIN-keyed assignment whose key `isPinLabel` confirms. A rejected lexical match
 * (`hairpin=…`) advances one character, so a real PIN key inside its value is still found. */
function redactPinKeyed(text: string): string {
  const re = new RegExp(PIN_KEYED.source, 'gi');
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const label = m[1];
    if (!isPinLabel(m[2])) {
      re.lastIndex = m.index + 1;
      continue;
    }
    const quote = m[0].slice(label.length).match(/^(\\?["'])/)?.[1] ?? '';
    out += text.slice(last, m.index) + label + quote + MARK + quote;
    last = m.index + m[0].length;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** `text` with every credential-labelled value, every PIN and passphrase, every verification code
 * next to a verification phrase, and every secret-shaped value replaced by [REDACTED].
 * Pure and idempotent. Run it on the whole string, before any cut. */
export function redactLabelled(text: string): string {
  if (!text) return text;
  let out = redactSecretValues(text);
  out = out.replace(LABELLED_HEADER, (_m, label: string) => label + MARK);
  out = out.replace(LABELLED_FLAG, (_m, label: string) => label + MARK);
  out = out.replace(PIN_FLAG, (_m, label: string) => label + MARK);
  out = out.replace(PASSPHRASE_LINE, (_m, label: string) => label + MARK);
  out = out.replace(LABELLED_ASSIGNMENT, (m: string, label: string) => {
    const quote = m.slice(label.length).match(/^(\\?["'])/)?.[1] ?? '';
    return label + quote + MARK + quote;
  });
  out = redactPinKeyed(out);
  out = out.replace(PIN_PROSE, (_m, label: string) => label + MARK);
  return redactVerificationCodes(out);
}

/** Redact the whole string, then keep at most `max` characters: the head by default,
 * the tail when `from` is 'end' (a long reply's conclusion is at its end). */
export function redactThenCut(text: string, max: number, from: 'start' | 'end' = 'start'): string {
  const clean = redactLabelled(text);
  if (clean.length <= max) return clean;
  return from === 'end' ? clean.slice(-max) : clean.slice(0, max);
}

/** Last words of a key that labels its value as a secret. Shared with structured walkers. */
const KEY_LAST_WORD = new Set(['password', 'passwd', 'passphrase', 'passcode', 'pwd', 'secret', 'token', 'cookie', 'credential', 'credentials', 'authorization', 'bearer', 'apikey']);
const KEY_LAST_PAIR = new Set(['api key', 'private key', 'access key', 'secret key', 'signing key', 'client secret', 'session key', 'auth token']);

function keyWords(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** True when a key names a PIN by its words: last word pin, pincode, pinnumber or passcode, or the
 * last two words pin code / pin number (`PIN`, `user_pin`, `pinCode`, `card_pin_number`).
 * `spin`, `hairpin`, `pinned` and `pins` are not PIN labels. */
export function isPinLabel(key: string): boolean {
  const words = keyWords(key);
  if (words.length === 0) return false;
  const last = words[words.length - 1];
  if (last === 'pin' || last === 'pincode' || last === 'pinnumber' || last === 'passcode') return true;
  return words.length >= 2 && words[words.length - 2] === 'pin' && (last === 'code' || last === 'number');
}

/** True when an object key names a secret (`password`, `apiKey`, `X-API-Key`, `GITHUB_TOKEN`, `pinCode`). */
export function isSecretLabel(key: string): boolean {
  const words = keyWords(key);
  if (words.length === 0) return false;
  if (KEY_LAST_WORD.has(words[words.length - 1])) return true;
  if (words.length >= 2 && KEY_LAST_PAIR.has(`${words[words.length - 2]} ${words[words.length - 1]}`)) return true;
  return isPinLabel(key);
}

const OTP_WORDS = /\b(code|passcode|verification|verify|one[- ]time|otp|2fa|mfa|login|log-in|sign[- ]in)\b/i;
const OTP_DIGITS = /\b\d{4,8}\b/;

/** True when a message looks like it carries a one-time code: an OTP word plus a 4-8 digit number
 * (the message filter's original rule, kept whole), or an OTP word plus an upper-case alphanumeric
 * code token holding a digit (`A7K2Q9`, `7KQ2-M9XZ`). A strict superset of the original rule, so a
 * filter built on it only drops more. */
export function isVerificationCode(text: string): boolean {
  if (!text || !OTP_WORDS.test(text)) return false;
  if (OTP_DIGITS.test(text)) return true;
  for (const m of text.matchAll(CODE_TOKEN)) if (isCodeToken(m[0], true)) return true;
  return false;
}

/** A structured value with every leaf under a secret-labelled key replaced by [REDACTED] and every
 * other string leaf run through `redactLabelled`. Keys are kept. A reference back to an ancestor
 * becomes [CIRCULAR]; an object shared by siblings is copied each time. Pure. */
export function redactStructured(value: unknown, sensitive = false): unknown {
  return walkStructured(value, sensitive, new Set<object>());
}

function walkStructured(value: unknown, sensitive: boolean, ancestors: Set<object>): unknown {
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) return '[CIRCULAR]';
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map((v) => walkStructured(v, sensitive, ancestors));
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walkStructured(v, sensitive || isSecretLabel(k), ancestors);
      return out;
    } finally {
      ancestors.delete(value);
    }
  }
  if (sensitive && value !== null && value !== undefined && value !== '') return MARK;
  if (typeof value === 'string') return redactLabelled(value);
  return value;
}
