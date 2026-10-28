/**
 * STATVS core — field-by-field secret masking.
 *
 * mask(value, key) walks any JSON value and replaces only the secret substrings it finds with a
 * mask token, ⟦masked:<class>:<first 12 hex of HMAC-SHA256(key, secret)>⟧, so the rest of the
 * string and the row survive and two copies of one secret still match. It never refuses a row.
 *
 * What counts as a secret is a set of real credential shapes (provider key prefixes, JWTs, PEM
 * private keys, Authorization values, url passwords, cookies) plus values whose key or variable
 * name says they are secret. There is deliberately no generic "long run" or "hex run" pattern:
 * the old engine's generic patterns (lib/refuse.ts) refused about a fifth of transcript lines,
 * none of them secrets. Git ids, sha256 values, UUIDs, base64 and readable path segments pass
 * byte for byte unless a secret-named key or variable holds them.
 *
 * Pure: WebCrypto only, no node: imports, so the Worker intake can rescan with scan().
 *
 * @version 0.1.0
 */

export type MaskKey = string | Uint8Array | CryptoKey;
export type MaskResult = { value: unknown; masked: string[]; classes: string[] };
/** One secret found, for in-memory audits. `value` is the raw secret: never print or persist it. */
export type MaskMatch = { path: string; cls: string; value: string; name?: string };
export type MaskOptions = {
  onMatch?: (m: MaskMatch) => void;
  /**
   * Our own secret values, masked wherever they appear whatever their shape (class own_secret). The shipper passes
   * them from the sealed env on the machine; the Worker never holds them. Values under EXACT_MIN characters are ignored.
   */
  exact?: readonly string[];
};
/** The shortest own secret masked by exact match: anything shorter would mask ordinary words. */
export const EXACT_MIN = 12;

/** A mask token anywhere in a string. */
export const MASK_TOKEN_RE = /⟦masked:[a-z0-9_]+:[0-9a-f]{12}⟧/;
const MASK_TOKEN_ONLY = /^⟦masked:[a-z0-9_]+:[0-9a-f]{12}⟧$/;
/** A mask token as a regex atom, so a value run can hold one: a token never ends or shields the run it sits in. */
const TOK_SRC = MASK_TOKEN_RE.source;

/**
 * The plaintext of s[start, end) around the mask tokens in s: each piece before, between or after the tokens that
 * overlap the range, trimmed of whitespace, when anything is left. A token is cut out of the range, never a reason
 * to skip it.
 */
export function plainPieces(s: string, start = 0, end = s.length): [number, number][] {
  return piecesBetween(s, tokenSpans(s), start, end);
}

type TokenSpan = readonly [number, number];
/** Every mask token in s, in order. Tokens never overlap, so the list is sorted by both ends. */
const tokenSpans = (s: string): TokenSpan[] => [...s.matchAll(new RegExp(TOK_SRC, "g"))].map((m) => [m.index!, m.index! + m[0].length] as const);
/** Index of the first token whose end is past `at` (tokens.length when none): a binary search, so a scan stays linear. */
function firstTokenEndingAfter(tokens: readonly TokenSpan[], at: number): number {
  let lo = 0, hi = tokens.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (tokens[mid]![1] > at) hi = mid; else lo = mid + 1; }
  return lo;
}

/** plainPieces over a precomputed token list: only the tokens that overlap [start, end) are visited. */
function piecesBetween(s: string, tokens: readonly TokenSpan[], start: number, end: number): [number, number][] {
  const out: [number, number][] = [];
  let at = start;
  const take = (a: number, b: number) => {
    let x = at, y = Math.min(a, end);
    while (x < y && /\s/.test(s[x]!)) x++;
    while (y > x && /\s/.test(s[y - 1]!)) y--;
    if (y > x) out.push([x, y]);
    at = Math.max(at, b);
  };
  for (let i = firstTokenEndingAfter(tokens, start); i < tokens.length && tokens[i]![0] < end; i++) take(tokens[i]![0], tokens[i]![1]);
  take(end, end);
  return out;
}
/** A value with every mask token cut out: what is left beside its tokens. */
const untokened = (v: string) => v.replace(new RegExp(TOK_SRC, "g"), "");

export const maskToken = (cls: string, hex12: string): string => `⟦masked:${cls}:${hex12}⟧`;

// ── Value tests ──

const hasDigit = (s: string) => /[0-9]/.test(s);
const hasLetter = (s: string) => /[A-Za-z]/.test(s);
const distinct = (s: string) => new Set(s).size;
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
/** Mixed-case run long enough to be random rather than a camelCase identifier. */
const randomCase = (s: string) => s.length >= 12 && (s.match(/[A-Z]/g)?.length ?? 0) >= 2 && (s.match(/[a-z]/g)?.length ?? 0) >= 2 && !/^[A-Za-z][a-z]+(?:[A-Z][a-z]+)+$/.test(s);
/** Digits with letters, or a random-case run: what a credential looks like, as opposed to a word or an identifier. */
const tokenish = (v: string) => (hasDigit(v) && hasLetter(v)) || randomCase((v.match(/[A-Za-z0-9]+/g) ?? [""]).reduce((a, b) => (b.length > a.length ? b : a)));
/** A made-up value: an ascending run of six (abcdef, 123456) that a random token essentially never holds. */
function isSequential(v: string): boolean {
  let run = 1;
  for (let i = 1; i < v.length; i++) {
    const a = v.charCodeAt(i - 1), b = v.charCodeAt(i);
    run = b - a === 1 && /[A-Za-z0-9]/.test(v[i]!) && /[A-Za-z0-9]/.test(v[i - 1]!) ? run + 1 : 1;
    if (run >= 6) return true;
  }
  return false;
}
const isPathOrUrl = (s: string) => /^(?:[/~.]|[a-z][a-z0-9+.-]*:\/\/)/i.test(s);

const PLACEHOLDER_WORD = /^(?:null|none|nil|undefined|true|false|string|number|required|optional|hidden|secret|secrets|password|passwd|token|value|test|empty|unset|default|changeme|redacted|masked|example|sample|dummy|fake|foo|bar|baz|abc123|pass|pwd|admin)$/i;
const PLACEHOLDER_HINT = /redacted|placeholder|example|changeme|your[_-]|\byour|xxxx|\.\.\.|…|dummy|fake[_-]|sample|insert[_-]|replace[_-]?me|<[^>]*>|\{\{|\$\{|^\$|^%|process\.env|os\.environ|import\.meta|getenv|secrets\.|(?:^|[-_.])(?:test|testing|dev|local|demo|mock|stub|fixture|synthetic|bogus|invalid|wrong)(?:[-_.]|$)/i;

/** A value that holds no secret: empty, tiny, a mask token, a reference or an obvious stand-in. */
export function isPlaceholder(v: string): boolean {
  const t = v.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (t.length < 4) return true;
  // A mask token alone is masked already. Plaintext beside a token is never a stand-in: the token says the place held a
  // secret, so what is glued to it is judged a secret too, whatever it looks like (fail closed).
  if (MASK_TOKEN_RE.test(t)) return !/\S/.test(untokened(t));
  if (/^[<[{(].*[>\]})]$/.test(t)) return true;
  if (distinct(t) <= 2) return true; // xxxx, ****, ----
  if (/^[*xX•.\-_#]+$/.test(t)) return true;
  if (PLACEHOLDER_WORD.test(t)) return true;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(t)) return true; // a variable name (SECRET_TOKEN) standing for its value
  if (isSequential(t)) return true;
  return PLACEHOLDER_HINT.test(t);
}

/**
 * The only values a secret-named key may hold unmasked: nothing, an existing mask token standing alone, a
 * redaction marker (<REDACTED>, [REDACTED], {{ var }}), a ${VAR} reference, a run of mask characters (***, xxxx),
 * or a literal null, boolean or not-set word. Unlike isPlaceholder, no prefix or hint word ("test-", "example") exempts a
 * value: under a secret name anything else is the secret, and the record is permanent.
 */
export function isExactPlaceholder(v: string): boolean {
  const t = v.trim();
  if (t === "") return true;
  if (MASK_TOKEN_ONLY.test(t)) return true;
  // A bracketed marker is a placeholder only when it is letters naming what it stands for (<REDACTED>, [YOUR_API_KEY]):
  // a bracketed value with digits or no marker word ([Hunter2pass], <Tr0ub4dor>) is a secret someone wrapped.
  const marker = t.match(/^<([A-Za-z][A-Za-z _-]{0,40})>$/) ?? t.match(/^\[([A-Za-z][A-Za-z _-]{0,40})\]$/);
  if (marker) return MARKER_WORD.test(marker[1]!);
  if (/^\{\{\s*[A-Za-z_][A-Za-z0-9_.]*\s*\}\}$/.test(t)) return true;
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(t)) return true;
  if (/^[*xX•]{3,}$/.test(t)) return true;
  return /^(?:null|nil|none|undefined|true|false|unset|not set|empty|missing|redacted|masked)$/i.test(t);
}

/** Words a bracketed placeholder marker names (<REDACTED>, [your-api-key], <SECRET_TOKEN>). */
const MARKER_WORD = /(?:^|[^a-z])(?:redacted|masked|hidden|removed|omitted|placeholder|secret|password|passwd|passphrase|token|key|your|value|credentials?|env)(?:[^a-z]|$)/i;

/**
 * A provider shape whose variable part is one or two characters repeated (ghp_xxxx…, sk-0000…, AKIAXXXX…): a stand-in,
 * never a key. Two distinct characters at most, so a real key is never read as one: the chance that a random 16-character
 * base32 AWS key id (the shortest body tested) uses fewer than three characters is about 3e-17.
 */
const uniform = (body: string) => distinct(body) < 3;
/** At least two of digits, upper case and lower case: a random base62 key of 32 or more fails this about once in 1e12. */
const mixed = (s: string) => [/[0-9]/, /[A-Z]/, /[a-z]/].filter((r) => r.test(s)).length >= 2;

// ── Secret names ──

/** Normalize a key name: camelCase and any separator to lower snake. */
const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Plurals (passwords, api_keys) hold lists of secrets. "tokens" stays out: input_tokens and friends are counts.
const STRONG_NAME = /(?:^|_)(?:passwords?|passwds?|passphrases?|secrets?|token|api_?keys?|apikeys?|access_keys?|private_keys?|client_secrets?|secret_keys?|auth_keys?|signing_keys?|encryption_keys?|master_keys?|cookies?|authorization)$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE)$/;
/**
 * A key named for a password: a password, passwd, passphrase or pwd component anywhere in its snake form (db_password,
 * password_confirmation, newPasswordHash, PWD). Its value is the password whatever it looks like.
 */
const PASSWORD_NAME = /(?:passwords?|passwds?|passphrases?|pwds?)(?:_|$)/;

/** How a key name marks its value: "strong" masks any real value, "weak" (session) only a credential-looking one. */
export function secretName(name: string): "strong" | "weak" | null {
  if (ENV_NAME.test(name)) return "strong";
  const n = snake(name);
  if (!n) return null;
  if (PASSWORD_NAME.test(n)) return "strong";
  if (n === "session" || n === "set_cookie") return n === "session" ? "weak" : "strong";
  return STRONG_NAME.test(n) ? "strong" : null;
}

// ── Text rules ──

type Span = { start: number; end: number; cls: string; name?: string };
/** What a tail read after its rule's regex matched: where the whole match ends, and the spans it found. */
type Tail = { end: number; spans: Span[] };
/**
 * Per-text scan state shared by a detect() call. `next(set, from)` is the first index at or after `from` holding a
 * character of the named set (the text length when none). Asked with rising `from`, it rescans nothing it already read,
 * so many names sharing one long run cost one pass over the run, where a lazy regex run cost one pass per name.
 */
type ScanCtx = {
  next: (set: keyof typeof STOP_SETS, from: number) => number;
  /** The first match of a global, lookbehind-free regex at or after `from`, memoized like next(). */
  nextMatch: (re: RegExp, from: number) => RegExpExecArray | null;
  runs: () => NameRuns;
  /** Per name run, the largest index a name of this kind may start at and still be valid (-1: no valid name in the run). */
  valid: (kind: NameKind) => Int32Array;
};
const STOP_SETS = { brace: "}\r\n", field: ";\r\n\"'", eol: "\r\n", lt: "<", cookie: "\r\n\"'\\", seg: "\r\n|;&", eq: "=" } as const;
/** Maximal runs of name characters [A-Za-z0-9_-], in order. */
type NameRuns = { start: Int32Array; end: Int32Array; n: number };
type NameKind = "pw" | "text" | "strong";
const isNameCode = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;
function scanCtx(text: string): ScanCtx {
  const memo = new Map<string, { from: number; at: number }>();
  const reMemo = new Map<RegExp, { from: number; m: RegExpExecArray | null }>();
  let runs: NameRuns | undefined;
  const valids = new Map<NameKind, Int32Array>();
  const ctx: ScanCtx = {
    next(set, from) {
      const seen = memo.get(set);
      if (seen && from >= seen.from && from <= seen.at) return seen.at;
      const stops = STOP_SETS[set];
      let i = from;
      while (i < text.length && !stops.includes(text[i]!)) i++;
      memo.set(set, { from, at: i });
      return i;
    },
    nextMatch(re, from) {
      // A match found from `seen.from` at index i is also the first match from any `from` in [seen.from, i]: nothing
      // matched in between. With no match at all, nothing matches from any later `from` either.
      const seen = reMemo.get(re);
      if (seen && from >= seen.from && (seen.m === null || from <= seen.m.index)) return seen.m;
      re.lastIndex = from;
      const m = re.exec(text);
      reMemo.set(re, { from, m });
      return m;
    },
    runs() {
      if (runs) return runs;
      const start: number[] = [], end: number[] = [];
      for (let i = 0; i < text.length; ) {
        if (!isNameCode(text.charCodeAt(i))) { i++; continue; }
        const a = i;
        while (i < text.length && isNameCode(text.charCodeAt(i))) i++;
        start.push(a); end.push(i);
      }
      return (runs = { start: Int32Array.from(start), end: Int32Array.from(end), n: start.length });
    },
    valid(kind) {
      const have = valids.get(kind);
      if (have) return have;
      const v = kind === "pw" ? pwValid(text, ctx.runs()) : kind === "strong" ? strongValid(text, ctx.runs()) : textValid(text, ctx.runs());
      valids.set(kind, v);
      return v;
    },
  };
  return ctx;
}

// ── Names read in code ──
//
// A secret name is a run of name characters [A-Za-z0-9_-] ending at its separator, so it always ends where its run
// ends. A regex that found it with a lazy prefix ([A-Za-z0-9_-]*?password) restarted at every "_" or "-" of a long run
// and rescanned the run each time: quadratic on a_a_a_…, worse on password_password_…. Here each run is read once.

const PW_CORE_G = /pass(?:word|wd|phrase)|pwd/gi;
/**
 * Per run, the largest core index whose rest of the run is a valid password-name suffix: [sS]? then camelCase or
 * _/- separated words (PW_NAME_SRC's suffix), i.e. empty, or opening on _, - or a capital with every _ or - followed by
 * a letter or digit.
 */
function pwValid(s: string, runs: NameRuns): Int32Array {
  const out = new Int32Array(runs.n).fill(-1);
  const lastBad = new Int32Array(runs.n).fill(-2);
  let r = 0;
  PW_CORE_G.lastIndex = 0;
  for (let m = PW_CORE_G.exec(s); m; m = PW_CORE_G.exec(s)) {
    const c = m.index, q = c + m[0].length;
    while (r < runs.n && runs.end[r]! <= c) r++;
    if (r >= runs.n) break;
    const a = runs.start[r]!, b = runs.end[r]!;
    if (c < a || q > b) continue;
    if (lastBad[r] === -2) {
      let x = -1;
      for (let i = b - 1; i >= a; i--) {
        const ch = s[i];
        if ((ch === "_" || ch === "-") && (i + 1 === b || s[i + 1] === "_" || s[i + 1] === "-")) { x = i; break; }
      }
      lastBad[r] = x;
    }
    const ok = (at: number) => at === b || (at > lastBad[r]! && /[_A-Z-]/.test(s[at]!));
    if (ok(q) || ((s[q] === "s" || s[q] === "S") && ok(q + 1))) out[r] = Math.max(out[r]!, c);
  }
  return out;
}

/** TEXT_NAME_SRC's cores, every [_-]? spelled out: a secret_value name is a run ending in one (any case). */
const TEXT_CORES: string[] = (() => {
  const out = ["password", "passwd", "passphrase", "secret", "token"];
  for (const [a, b] of [["api", "key"], ["access", "key"], ["private", "key"], ["client", "secret"], ["secret", "key"], ["auth", "key"], ["signing", "key"], ["encryption", "key"]] as const) {
    for (const sep of ["", "_", "-"]) out.push(a + sep + b);
  }
  return out.sort((x, y) => x.length - y.length);
})();
const TEXT_CORE_TAILS = new Set(TEXT_CORES.map((w) => w.slice(-3)));
/** Per run, the start of the shortest core that ends the run (case-insensitive), or -1. */
/** Runs whose whole name secretName() calls strong (SERVICE_KEY, client_secret, api_token): the run start, else -1. One check per run. */
function strongValid(s: string, runs: NameRuns): Int32Array {
  const out = new Int32Array(runs.n).fill(-1);
  for (let r = 0; r < runs.n; r++) if (secretName(s.slice(runs.start[r]!, runs.end[r]!)) === "strong") out[r] = runs.start[r]!;
  return out;
}

function textValid(s: string, runs: NameRuns): Int32Array {
  const out = new Int32Array(runs.n).fill(-1);
  for (let r = 0; r < runs.n; r++) {
    const a = runs.start[r]!, b = runs.end[r]!;
    if (b - a < 5 || !TEXT_CORE_TAILS.has(s.slice(b - 3, b).toLowerCase())) continue;
    for (const w of TEXT_CORES) {
      if (w.length > b - a) break;
      if (s.slice(b - w.length, b).toLowerCase() === w) { out[r] = b - w.length; break; }
    }
  }
  return out;
}

/** Whether a whole string is a password-type name (PASSWORD_TEXT_NAME), read in linear time. */
export function isPwName(name: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return false;
  return pwValid(name, { start: Int32Array.of(0), end: Int32Array.of(name.length), n: 1 })[0]! >= 0;
}

/** What a head rule read after its name: where the match ends and its groups (numbered from 2 in the synthetic match). */
type After = { end: number; groups: ([number, number] | undefined)[] };
/** A sticky regex as an after-name reader. */
function stickyAfter(re: RegExp): (s: string, b: number) => After | null {
  return (s, b) => {
    re.lastIndex = b;
    const m = re.exec(s) as Indexed | null;
    return m ? { end: m.index + m[0].length, groups: m.indices.slice(1) } : null;
  };
}
/** The match a name rule's regex would have made: group 1 the name, the after-reader's groups from 2. */
function synthMatch(s: string, p: number, b: number, after: After): Indexed {
  const m = [s.slice(p, after.end), s.slice(p, b), ...after.groups.map((g) => (g ? s.slice(g[0], g[1]) : undefined))] as unknown as Indexed;
  m.index = p;
  m.input = s;
  m.indices = [[p, after.end], [p, b], ...after.groups];
  return m;
}

/**
 * A rule's matcher. `tail`, when set, reads the value after the regex in code: null means the rule does not match where
 * the regex matched (the scan resumes one character on, as a failed regex would), a Tail sets where the scan resumes.
 * `head`, when set, reads the secret name in code (see Names read in code) and `after` reads what follows it; the rule
 * then runs its spans or tail on the match the old one-regex form would have made. `verify` rejects a regex match that
 * read a name greedily: the scan resumes one character on, as the old lazy-name regex would have failed there.
 */
type Rule = {
  cls: string;
  re?: RegExp;
  group?: number;
  accept?: (v: string, m: RegExpExecArray) => boolean;
  spans?: (m: RegExpExecArray) => Span[];
  tail?: (m: RegExpExecArray, ctx: ScanCtx) => Tail | null;
  verify?: (m: RegExpExecArray) => boolean;
  head?: { kind: NameKind; lead: "alnum" | "delim"; after: (s: string, b: number, ctx: ScanCtx) => After | null };
};

/** A value read from text after a secret name: quoted (any non-space run) or bare (a token-like run). */
const VALUE_SRC = String.raw`(?:\\?"([^"\\\s]{4,})\\?"|'([^'\s]{4,})'|((?:${TOK_SRC})+[A-Za-z0-9_\-+=~!@#%^&*/](?:[A-Za-z0-9_\-+=~!@#%^&*/]|${TOK_SRC}){0,}|[A-Za-z0-9](?:[A-Za-z0-9_\-+=~!@#%^&*/]|${TOK_SRC}){5,}|[A-Za-z0-9][A-Za-z0-9_\-+=~!@#%^&*/]{0,4}${TOK_SRC}(?:[A-Za-z0-9_\-+=~!@#%^&*/]|${TOK_SRC}){0,})(?![A-Za-z0-9_(.\[]))`;
// The bare run above takes a mask token as part of the value (opening, inside or closing it), so plaintext glued to a
// token is read as the value it is; detect() then masks the run minus the token.
const TEXT_NAME_SRC = String.raw`[A-Za-z0-9_-]*?(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|secret[_-]?key|auth[_-]?key|signing[_-]?key|encryption[_-]?key)`;
const ENV_NAME_SRC = String.raw`[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE)`;

/** Digits only, eight or more and at least four distinct: long enough to be a secret, not a count or a port. */
const numericSecret = (d: string) => /^\d{8,}$/.test(d) && distinct(d) >= 4 && !isSequential(d);

// ── Password-bound values ──
//
// A value bound to a password-type name is the password, in every syntax: whatever its length, digits, word count,
// alphabet or entropy. The one exemption is the closed set of non-secrets (isExactPlaceholder). A quoted value is masked
// whole, spaces included; an unquoted one runs to the delimiter that ends a value in its syntax (whitespace inline, the
// end of the line on a key line, ";" in a connection string, "&" in a query, the last "@" of url userinfo), so prose
// after it stays. The record is permanent: a false mask costs little, a leaked password is forever.

/** A word as case-exact character classes, so a camelCase suffix (passwordConfirm) is told from a word going on (passwordless). */
const ci = (w: string) => [...w].map((c) => `[${c.toUpperCase()}${c.toLowerCase()}]`).join("");
const PW_CORE_SRC = `(?:${ci("pass")}(?:${ci("word")}|${ci("wd")}|${ci("phrase")})|${ci("pwd")})`;
/**
 * A password-type name in text: password, passwd, passphrase or pwd, with any prefix (db_password, PGPASSWORD, newPassword)
 * and any snake, kebab or camelCase suffix (password_confirmation, password-file, passwordConfirm). Not passwordless.
 */
const PW_NAME_SRC = String.raw`[A-Za-z0-9_-]*?${PW_CORE_SRC}[sS]?(?:[_-][A-Za-z0-9]+|[A-Z][A-Za-z0-9]*)*`;
/** Between a name and its value: an optional closing quote on the name, then = : := or =>. */
const PW_SEP_SRC = String.raw`\\?["']?[ \t]*(?::=|=>|[:=])[ \t]*`;
/**
 * A quoted value, whole: an escaped-quote value inside JSON-in-a-string (\"…\", whose own quotes are \\\"), a double-,
 * single- or back-quoted one. Four groups, one per form.
 */
const QUOTED_SRC = String.raw`(?:\\"((?:[^"\\\r\n]|\\\\\\\\|\\\\\\"|\\\\?[^"\\\r\n])*)\\"|"((?:[^"\\\r\n]|\\.)*)"|'((?:[^'\\\r\n]|\\.)*)'|\x60([^\x60\r\n]*)\x60)`;
/**
 * Syntax that is not a value: the ">" of an arrow before a quoted value ('password' => 'x'), and a YAML block indicator
 * standing alone at the end of its line (password: |), whose value is on the lines below.
 */
const NOT_VALUE_SRC = String.raw`(?!>[ \t]*["'\x60])(?![|>][-+0-9]*[ \t]*(?:#[^\r\n]*)?(?:\r?\n|\r?$))(?!\{[^}\r\n]*\}[ \t]*(?:;|\r?$))`;
/**
 * An unquoted inline value: to the next whitespace, quote or backslash. It never opens with "=" (the rest of == or ===).
 * A {{ template }} standing alone is read whole, spaces and all, so the closed set judges it as one value.
 */
const BARE_VALUE_SRC = String.raw`(?:\{\{[^{}\r\n]{0,200}\}\}(?=[\s"'\x60\\;,]|$)|${NOT_VALUE_SRC}[^\s"'\x60\\=][^\s"'\x60\\]{0,})`;
const BARE_SRC = `(${BARE_VALUE_SRC})`;

type Indexed = RegExpExecArray & { indices: ([number, number] | undefined)[] };

/**
 * The first value group from `first` on, as a password span unless it is one of the closed set of non-secrets. `cut`
 * may end the span earlier (a query value at its "&"). No other test applies.
 */
function boundSpan(m: RegExpExecArray, cls: string, first = 2, cut?: (m: RegExpExecArray, start: number, end: number) => number, skip?: (v: string) => number): Span[] {
  const idx = (m as Indexed).indices;
  for (let g = first; g < m.length; g++) {
    const at = idx[g];
    if (!at) continue;
    const end = cut ? cut(m, at[0], at[1]) : at[1];
    const start = at[0] + (skip ? skip(m.input.slice(at[0], end)) : 0);
    const v = m.input.slice(start, end);
    return isExactPlaceholder(v) ? [] : [{ start, end, cls, ...(first > 1 && m[1] ? { name: m[1] } : {}) }];
  }
  return [];
}

/** Spans of a strong-name binding: none under a password name (the password rules own those), and an all-digit value keeps the count test (max_token: 4096 stays). */
function strongBound(spans: Span[], m: RegExpExecArray): Span[] {
  // Password, Authorization and Cookie names have their own rules, which read their values' syntax (Bearer x, k=v; k=v).
  if (isPwName(m[1]!) || /(?:authorization|cookies?)$/i.test(m[1]!)) return [];
  return spans.filter((sp) => { const v = m.input.slice(sp.start, sp.end); return !alreadyMasked(v) && (!/^\d+$/.test(v) || numericSecret(v)); });
}

/** A CLI flag's value; in openssl's -pass pass:VALUE form the password is what follows "pass:". */
const cliSpan = (m: RegExpExecArray): Span[] => boundSpan(m, "password", 2, undefined, (v) => (v.startsWith("pass:") ? 5 : 0));

/**
 * Where an inline bare value ends in its syntax: a query parameter (its name after "?" or "&") at the next "&" or "#";
 * a connection-string field (its name after ";", or a ";" in the value followed by another key=) at that ";".
 * Otherwise the run stands: to the next whitespace or quote.
 */
function syntaxCut(m: RegExpExecArray, start: number, end: number): number {
  const v = m.input.slice(start, end);
  const prev = m.input[m.index - 1];
  if (prev === "?" || prev === "&") {
    const stop = v.search(/[&#]/);
    return stop < 0 ? end : start + stop;
  }
  const semi = v.indexOf(";");
  if (semi >= 0 && (semiBefore(m.input, m.index) || fieldAfterSemi(m.input, start + semi, end))) return start + semi;
  return end;
}

/**
 * Whether the text before `at` ends in ";" and optional spaces or tabs (the old /;[ \t]*$/ over a slice of everything
 * before the match). It looks back only over that run, never the whole prefix: a test over the prefix per match made a
 * line dense with password=… values quadratic.
 */
function semiBefore(s: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && (s[i] === " " || s[i] === "\t")) i--;
  return s[i] === ";";
}
const FIELD_AFTER_SEMI = /;[ \t]*[A-Za-z][A-Za-z0-9 _]{0,40}[ \t]*=/y;
/**
 * Whether another key= field follows the ";" at `at`, reading no further than `limit` (sticky, so it starts there and
 * never scans the rest of the text).
 */
function fieldAfterSemi(s: string, at: number, limit = s.length): boolean {
  const within = limit < s.length ? s.slice(at, limit) : s;
  FIELD_AFTER_SEMI.lastIndex = limit < s.length ? 0 : at;
  return FIELD_AFTER_SEMI.test(within);
}

/** A YAML block scalar under a password name (password: |, then indented lines): every content line, as one span. */
function blockSpan(m: RegExpExecArray): Span[] {
  const at = (m as Indexed).indices[3]!;
  const raw = m.input.slice(at[0], at[1]);
  const start = at[0] + (raw.length - raw.trimStart().length);
  const end = at[1] - (raw.length - raw.trimEnd().length);
  return end > start && !isExactPlaceholder(m.input.slice(start, end)) ? [{ start, end, cls: "password", name: m[2] }] : [];
}

/**
 * A connection-string field (Password=…; or Pwd={…}): a braced value whole; a bare one to its ";", spaces included, but
 * only where the ";" really separates fields (a field before it, or another key= after it), so prose is never read as one.
 */
function connTail(m: RegExpExecArray, ctx: ScanCtx): Tail | null {
  const s = m.input;
  const p = m.index + m[0].length;
  const c = s[p];
  if (c === "{") {
    // {value} whole, then only spaces before a ";", a quote or the end of the line.
    const q = ctx.next("brace", p + 1);
    if (s[q] !== "}") return null;
    let r = q + 1;
    while (s[r] === " " || s[r] === "\t") r++;
    if (!(r === s.length || ";\"'\n\r  ".includes(s[r]!))) return null;
    // The braces go with the value, so a masked field reads PWD=⟦…⟧ and a rescan finds nothing left over.
    return { end: q + 1, spans: isExactPlaceholder(s.slice(p + 1, q)) ? [] : [{ start: p, end: q + 1, cls: "password", name: m[1] }] };
  }
  if (c === undefined || ";\r\n\"'{ \t".includes(c)) return null;
  // A bare value runs to its ";": no newline or quote may come first. Trailing spaces stay out of it.
  const t = ctx.next("field", p + 1);
  if (s[t] !== ";") return null;
  let e = t;
  while (e > p + 1 && (s[e - 1] === " " || s[e - 1] === "\t")) e--;
  // Only where the ";" really separates fields (a field before it, or another key= after it), so prose is never read as one.
  const field = semiBefore(s, m.index) || fieldAfterSemi(s, t);
  if (!field) return { end: t, spans: [] };
  return { end: t, spans: isExactPlaceholder(s.slice(p, e)) ? [] : [{ start: p, end: e, cls: "password", name: m[1] }] };
}

/** Where `$` holds: the end, or (multiline) before a line terminator. */
const atEnd = (s: string, i: number, multiline: boolean) => i >= s.length || (multiline && "\n\r  ".includes(s[i]!));
const skipBlank = (s: string, i: number) => { while (s[i] === " " || s[i] === "\t") i++; return i; };
/** \r?\n or \r?$ at i. */
const lineEndAt = (s: string, i: number, multiline: boolean) => s[i] === "\n" || atEnd(s, i, multiline) || (s[i] === "\r" && (s[i + 1] === "\n" || atEnd(s, i + 1, multiline)));

/**
 * NOT_VALUE_SRC read in code, so a line dense with names never rescans to its end per name: the ">" of an arrow before a
 * quote, a YAML block indicator alone on its line, a {braced} value before ";" or the end.
 */
function notValue(s: string, v: number, ctx: ScanCtx, multiline: boolean): boolean {
  const c = s[v];
  if (c === ">") { const i = skipBlank(s, v + 1); if (s[i] === '"' || s[i] === "'" || s[i] === "`") return true; }
  if (c === "|" || c === ">") {
    let i = v + 1;
    while (i < s.length && "-+0123456789".includes(s[i]!)) i++;
    i = skipBlank(s, i);
    if (s[i] === "#") { if (lineEndAt(s, ctx.next("eol", i), multiline)) return true; } else if (lineEndAt(s, i, multiline)) return true;
  }
  if (c === "{") {
    const q = ctx.next("brace", v + 1);
    if (s[q] === "}") {
      const i = skipBlank(s, q + 1);
      if (s[i] === ";" || atEnd(s, i, multiline) || (s[i] === "\r" && atEnd(s, i + 1, multiline))) return true;
    }
  }
  return false;
}

const TEMPLATE_Y = /\{\{[^{}\r\n]{0,200}\}\}(?=[\s"'\x60\\;,]|$)/y;
const BARE_RUN_Y = /[^\s"'\x60\\]*/y;
/** PW_SEP_SRC then BARE_SRC, read in code: every separator reading in the regex's order, the first that holds a value. */
function pwBareAfter(s: string, b: number, ctx: ScanCtx): After | null {
  let o = b;
  if (s[o] === "\\") o++;
  if (s[o] === '"' || s[o] === "'") o++;
  o = skipBlank(s, o);
  const cands: number[] = [];
  if (s.startsWith(":=", o)) cands.push(o + 2);
  if (s.startsWith("=>", o)) cands.push(o + 2);
  if (s[o] === ":" || s[o] === "=") cands.push(o + 1);
  for (const e of cands) {
    const v = skipBlank(s, e);
    TEMPLATE_Y.lastIndex = v;
    const t = TEMPLATE_Y.exec(s);
    if (t) return { end: v + t[0].length, groups: [[v, v + t[0].length]] };
    if (v >= s.length || /[\s"'\x60\\=]/.test(s[v]!) || notValue(s, v, ctx, false)) continue;
    BARE_RUN_Y.lastIndex = v + 1;
    const end = v + 1 + BARE_RUN_Y.exec(s)![0].length;
    return { end, groups: [[v, end]] };
  }
  return null;
}

/**
 * A key line's value (the key-line rule's regex reads up to it): NOT_VALUE, then the shortest run to a " #" comment or
 * the end of the line, less trailing blanks. Read in code: the old lazy run rescanned every blank run once per position.
 */
function keyLineTail(m: RegExpExecArray, ctx: ScanCtx): Tail | null {
  if (!isPwName(m[1]!)) return null;
  const s = m.input;
  const v = m.index + m[0].length;
  if (v >= s.length || /[\s"'\x60=]/.test(s[v]!) || notValue(s, v, ctx, true)) return null;
  let k = v + 1, end = -1;
  while (end < 0) {
    if (k >= s.length || atEnd(s, k, true)) { end = k; break; }
    if (s[k] === " " || s[k] === "\t") {
      const j = skipBlank(s, k);
      if (atEnd(s, j, true)) { end = k; break; }
      if (s[j] === "#") { end = k; break; }
      k = j;
      continue;
    }
    k++;
  }
  const j = skipBlank(s, end);
  let stop = j;
  if (!atEnd(s, j, true)) { stop = j; while (stop < s.length && s[stop] !== "\r" && s[stop] !== "\n") stop++; }
  const full = stop + (s[stop] === "\r" && atEnd(s, stop + 1, true) ? 1 : 0);
  const sm = synthMatch(s, m.index, m.index + m[0].length, { end: full, groups: [[v, end]] });
  sm[1] = m[1]!;
  sm.indices[1] = (m as Indexed).indices[1];
  return { end: full, spans: boundSpan(sm, "password", 2, syntaxCut) };
}
const CURL_FLAG_G = /[ \t](-u|--user)(?:=|[ \t]+)(?:"[^"\r\n:]*:([^"\r\n]*)"|'[^'\r\n:]*:([^'\r\n]*)'|[^\s:"']*:([^\s"']+))/dg;
const MYSQL_FLAG_G = /[ \t]-p(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+))/dg;
/**
 * Every credential flag after a tool's name, in the same command segment (no newline, |, ; or & first). Flags are
 * found once per text, not once per mention.
 */
function toolFlagTail(flag: RegExp, nameGroup: boolean): (m: RegExpExecArray, ctx: ScanCtx) => Tail | null {
  return (m, ctx) => {
    const s = m.input;
    const from = m.index + m[0].length;
    const seg = ctx.next("seg", from);
    // Every credential flag in the segment is masked: curl uses the last --user it is given, so masking only the first
    // would leave the live one. The scan then resumes at the segment end; no later mention in it has a flag left.
    const spans: Span[] = [];
    for (let at = from, f = ctx.nextMatch(flag, at) as Indexed | null; f && f.index < seg; f = ctx.nextMatch(flag, at) as Indexed | null) {
      const end = f.index + f[0].length;
      // curl: group 1 is the flag (-u, --user); mysql: group 1 is the tool name. Values follow from group 2.
      const groups = nameGroup ? [(m as Indexed).indices[1], ...f.indices.slice(1)] : f.indices.slice(1);
      const sm = [s.slice(m.index, end), ...groups.map((g) => (g ? s.slice(g[0], g[1]) : undefined))] as unknown as Indexed;
      sm.index = m.index;
      sm.input = s;
      sm.indices = [[m.index, end], ...groups];
      spans.push(...boundSpan(sm, "password", 2));
      at = Math.max(end, f.index + 1);
    }
    return { end: seg, spans };
  };
}

/** A version string such as 1.2.3 or ^9.0.0: package.json lines name packages like jsonwebtoken. */
const isVersion = (v: string) => /^[\^~>=<v]*\d+(?:\.[\dx*]+)+(?:[-+][\w.]+)?$/i.test(v);

/**
 * The value group of a name=value match, as a span. A password-named value is masked whenever it is real; any
 * other name (key, token, secret) needs a token-looking value, digits with letters or a long random-case run,
 * so words, type names, paths and versions after a secret-ish name pass.
 */
/**
 * A bound value that opens with mask tokens and has nothing after them, or only syntax (&next=, ;, ,): the secret was
 * the token, so masking it again would mask the query text after it and masking would never settle (the intake rescans
 * the shipper's output and must find nothing). Real text glued straight onto a token still counts as a value.
 */
function alreadyMasked(v: string): boolean {
  const rest = v.replace(new RegExp("^(?:" + TOK_SRC + ")+"), "");
  return rest.length < v.length && (rest === "" || /^[&;,?#]/.test(rest));
}

function kvSpan(m: RegExpExecArray, cls: string, first: number): Span[] {
  const idx = (m as RegExpExecArray & { indices: ([number, number] | undefined)[] }).indices;
  const password = isPwName(m[1]!);
  // A strong secret name (TOKEN, API_KEY, SECRET, any *_KEY, *_TOKEN, *_SECRET) binds its value the way a password name
  // does: no hint word, prefix, length or shape exempts it, only the closed set of non-secrets (isExactPlaceholder).
  const strong = !password && secretName(m[1]!) === "strong";
  for (const g of [first, first + 1, first + 2]) {
    const at = idx[g];
    if (!at) continue;
    const v = m[g]!;
    if (alreadyMasked(v)) return [];
    // A value bound to a password name is the password whatever its length, alphabet or shape (a word, a path, a url):
    // only the closed set of non-secrets passes, as under a password key. The record is permanent; a false mask costs little.
    if (password) {
      const end = syntaxCut(m, at[0], at[1]);
      return isExactPlaceholder(m.input.slice(at[0], end)) ? [] : [{ start: at[0], end, cls, name: m[1] }];
    }
    // Digits keep the count test under every name (max_token=4096 is a limit, not a secret).
    if (strong && !/^\d+$/.test(v)) return isExactPlaceholder(v) ? [] : [{ start: at[0], end: at[1], cls, name: m[1] }];
    // A path or url after a key or token name is where it lives.
    if (isPlaceholder(v) || isPathOrUrl(v) || isVersion(v)) return [];
    // An all-digit value (a numeric API secret) is a secret when it is long and varied enough not to be a count.
    if (/^\d+$/.test(v)) return numericSecret(v) ? [{ start: at[0], end: at[1], cls, name: m[1] }] : [];
    if (!hasLetter(v)) return [];
    if (!tokenish(v) || v.length < 12) return []; // real keys and tokens are long; "token1" is a stand-in
    return [{ start: at[0], end: at[1], cls, name: m[1] }];
  }
  return [];
}

/** A text name that marks its value as a password (the kv rules' test): the same names PW_NAME_SRC reads. */
/** A CLI flag word naming a password (the cli rule): password, passwd, passphrase, pwd, pass, passin, passout, any case. */
const CLI_PW_WORD = /^(?:pass(?:word|wd|phrase|in|out)?|pwd)$/i;

/** A jwt's ".eyJ<payload>.<signature>" after its header run. */
const JWT_REST_Y = /\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/y;

/** Each name=value pair of a cookie header value s[v, f), as cookie spans; Set-Cookie holds one pair, its first. */
function cookieSpans(header: string, s: string, v: number, f: number): Span[] {
  const setCookie = /^set-/i.test(header);
  const out: Span[] = [];
  let at = 0;
  for (const pair of s.slice(v, f).split(";")) {
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (eq > 0 && /^[A-Za-z0-9_.!#$%&'*+^`|~-]+$/.test(name) && val.length >= 8 && !isPlaceholder(val)) {
      const start = v + at + pair.indexOf(val, eq + 1);
      out.push({ start, end: start + val.length, cls: "cookie", name });
    }
    at += pair.length + 1;
    if (setCookie) break;
  }
  return out;
}

const PEM_BODY = /(?:\s*(?:[A-Za-z0-9+/=]{4,}|[A-Za-z-]+: [^\n]*))+/y;
const pemEnds = new Map<string, RegExp>();
const pemAccept = (v: string) => (v.replace(/-----[^-]+-----/g, "").match(/[A-Za-z0-9+/]/g)?.length ?? 0) >= 64;

/** A private key: the header to its first END marker, else to the end of its base64 and header-line body. */
function pemTail(m: RegExpExecArray, ctx: ScanCtx): Tail | null {
  const s = m.input, from = m.index + m[0].length;
  const marker = "-----END " + (m[1] ?? "") + "PRIVATE KEY" + (m[2] ?? "") + "-----";
  let re = pemEnds.get(marker);
  if (!re) { re = new RegExp(marker.replace(/[^A-Za-z0-9 -]/g, (c) => "\\" + c), "g"); pemEnds.set(marker, re); }
  const e = ctx.nextMatch(re, from);
  let end: number;
  if (e) end = e.index + e[0].length;
  else {
    PEM_BODY.lastIndex = from;
    const b = PEM_BODY.exec(s);
    if (!b || b[0].length === 0) return null;
    end = from + b[0].length;
  }
  return { end, spans: pemAccept(s.slice(m.index, end)) ? [{ start: m.index, end, cls: "private_key" }] : [] };
}

const CDATA_CLOSE = /\]\]>/g;
/** The end of a close tag </name\s*> at pos, or -1. */
function closeTagAt(s: string, pos: number, name: string): number {
  if (!s.startsWith("</" + name, pos)) return -1;
  let j = pos + 2 + name.length;
  while (j < s.length && /\s/.test(s[j]!)) j++;
  return s[j] === ">" ? j + 1 : -1;
}

/** A password element's value: a CDATA section to the first "]]>" a close tag follows, or text to the next "<" a close tag starts. */
function xmlTail(m: RegExpExecArray, ctx: ScanCtx): Tail | null {
  const s = m.input, name = m[1]!, at = m.index + m[0].length;
  let vEnd = -1, end = -1;
  if (s.startsWith("<![CDATA[", at)) {
    for (let from = at + 9, c = ctx.nextMatch(CDATA_CLOSE, from); c; from = c.index + 1, c = ctx.nextMatch(CDATA_CLOSE, from)) {
      const close = closeTagAt(s, c.index + 3, name);
      if (close >= 0) { vEnd = c.index + 3; end = close; break; }
    }
  }
  if (end < 0) {
    const lt = s.indexOf("<", at);
    const pos = lt < 0 ? s.length : lt;
    const close = closeTagAt(s, pos, name);
    if (close < 0) return null;
    vEnd = pos; end = close;
  }
  return { end, spans: isExactPlaceholder(s.slice(at, vEnd)) ? [] : [{ start: at, end: vEnd, cls: "password", name }] };
}

const RULES: Rule[] = [
  {
    cls: "private_key",
    // The regex reads the header; pemTail finds its END marker through a memoized search, so a text of headers with no
    // END is not rescanned to its end per header. Same result as the old lazy [\s\S]*?-----END \u2026 alternation.
    re: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----/g,
    tail: pemTail,
  },
  { cls: "aws_access_key_id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, accept: (v) => !/EXAMPLE/.test(v) && !uniform(v.slice(4)) },
  { cls: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g, accept: (v) => !uniform(v.slice(4)) },
  { cls: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, accept: (v) => hasDigit(v) && !uniform(v.slice(5)) },
  { cls: "stripe_key", re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g, accept: (v) => !uniform(v.slice(8)) },
  { cls: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, accept: (v) => hasDigit(v) && !uniform(v.slice(7)) },
  {
    cls: "openai_key",
    re: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{30,}|[A-Za-z0-9]{32,})/g,
    accept: (v) => !v.startsWith("sk-ant-") && mixed(v.slice(3)) && !uniform(v.slice(3)),
  },
  { cls: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, accept: (v) => !uniform(v.slice(4)) },
  // Google OAuth: a client secret, a refresh token, an access token.
  { cls: "google_oauth", re: /\b(?:GOCSPX-[A-Za-z0-9_-]{24,}|1\/\/0[A-Za-z0-9_-]{40,}|ya29\.[A-Za-z0-9_-]{30,})/g, accept: (v) => hasDigit(v) && !uniform(v.slice(7)) },
  // An age identity, classic or post-quantum hybrid: bech32 upper case after the prefix.
  { cls: "age_secret_key", re: /\bAGE-SECRET-KEY-(?:[A-Z]{1,8}-)?1[02-9AC-HJ-NP-Z]{38,}/g, accept: (v) => !uniform(v.slice(16)) },
  { cls: "huggingface_token", re: /\bhf_[A-Za-z0-9]{34,}\b/g, accept: (v) => mixed(v.slice(3)) && !uniform(v.slice(3)) },
  { cls: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/g, accept: (v) => mixed(v.slice(4)) && !uniform(v.slice(4)) },
  { cls: "sk_hex48_key", re: /\bsk_[0-9a-f]{48}\b/g, accept: (v) => hasDigit(v.slice(3)) && /[a-f]/.test(v.slice(3)) && !uniform(v.slice(3)) },
  { cls: "twilio_api_key", re: /\bSK[0-9a-f]{32}\b/g, accept: (v) => hasDigit(v.slice(2)) && /[a-f]/.test(v.slice(2)) && !uniform(v.slice(2)) },
  // eyJ, then the rest of its [A-Za-z0-9_-] run, read in code: every eyJ in one run shares the run's end, so when the
  // first fails the run is left whole (the old regex rescanned the run from every eyJ in it).
  {
    cls: "jwt",
    re: /\beyJ/g,
    tail: (m) => {
      const s = m.input;
      let r = m.index + 3;
      while (r < s.length && isNameCode(s.charCodeAt(r))) r++;
      if (r - (m.index + 3) < 8) return { end: r, spans: [] };
      JWT_REST_Y.lastIndex = r;
      const t = JWT_REST_Y.exec(s);
      return t ? { end: r + t[0].length, spans: [{ start: m.index, end: r + t[0].length, cls: "jwt" }] } : { end: r, spans: [] };
    },
  },
  {
    cls: "authorization",
    // A mask token may sit in the credential run.
    re: new RegExp(String.raw`\b(?:Proxy-)?Authorization\\?["']?\s*[:=]\s*\\?["']?(?:Bearer|Basic|Token|Bot|Digest)\s+((?:[A-Za-z0-9._~+/-]|${TOK_SRC})+=*)`, "dgi"),
    group: 1,
    // The header binds its value as a credential, the way a password name does: only the closed non-secret set passes.
    accept: (v) => !isExactPlaceholder(v),
  },
  {
    cls: "bearer_token",
    re: new RegExp(String.raw`\bBearer\s+((?:[A-Za-z0-9._~+/-]|${TOK_SRC})+=*)`, "dg"),
    group: 1,
    accept: (v) => v.length >= 16 && !isPlaceholder(v) && tokenish(v) && distinct(v) >= 8,
  },
  {
    // URL userinfo, scheme://user:PASSWORD@host: the password runs from the first ":" after the user to the last "@" before
    // the host (a raw "@", "?", "#" or ":" in it stays inside), and the authority ends at "/" or whitespace.
    cls: "url_password",
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/?#'"<>`]*:([^\s/'"`]*)@(?=[^\s@/'"<>`])/dgi,
    spans: (m) => boundSpan(m, "url_password", 1),
  },
  {
    cls: "cookie",
    // The regex reads to the value; the value (to the next newline, quote or backslash, holding an "=") is read in code
    // with memoized scans, so a line of cookie: mentions with no "=" is not rescanned to its end per mention.
    re: /(?:^|[\s"'{,([])((?:set-)?cookie)\\?["']?\s*:\s*\\?["']?/dgi,
    tail: (m, ctx) => {
      const v = m.index + m[0].length;
      const f = ctx.next("cookie", v);
      if (ctx.next("eq", v) >= f) return null;
      return { end: f, spans: cookieSpans(m[1]!, m.input, v, f) };
    },
  },
  { cls: "env_secret", re: new RegExp(String.raw`(?<![A-Za-z0-9_])(${ENV_NAME_SRC})\\?["']?[ \t]*[:=][ \t]*${VALUE_SRC}`, "dg"), spans: (m) => kvSpan(m, "env_secret", 2) },
  { cls: "cli_secret", re: new RegExp(String.raw`(?<![\w-])--((?:[a-z0-9]+-)*(?:password|passwd|token|secret|api-key|apikey|access-key|private-key|client-secret))(?:=|[ \t]+)${VALUE_SRC}`, "dg"), spans: (m) => kvSpan(m, "cli_secret", 2) },
  // The name ([A-Za-z0-9_-]*? then a core, TEXT_NAME_SRC) is read in code; the regex reads what follows it.
  { cls: "secret_value", head: { kind: "text", lead: "alnum", after: stickyAfter(new RegExp(String.raw`\\?["']?[ \t]*[:=][ \t]*${VALUE_SRC}`, "dyi")) }, spans: (m) => kvSpan(m, "secret_value", 2) },
  // A strong secret name binds its value whatever its length, and a quoted value whole, spaces included (a short API_KEY
  // value, or a quoted value holding spaces): the password rules' own separator and value readers, so VALUE_SRC's length floors never apply.
  { cls: "secret_value", head: { kind: "strong", lead: "alnum", after: stickyAfter(new RegExp(`${PW_SEP_SRC}${QUOTED_SRC}`, "dy")) }, spans: (m) => strongBound(boundSpan(m, "secret_value"), m) },
  // Bare: API_KEY=abc, API_KEY = k7!q, access_key: x7, to the next blank, quote or separator. Code such as `token === x`
  // stays; `const token = await f()` masks "await", a false mask that costs nothing.
  { cls: "secret_value", head: { kind: "strong", lead: "alnum", after: stickyAfter(/["']?[ \t]*(?:=(?!=)|:(?!:))[ \t]*([^\s"'\x60\\,;&=:@][^\s"'\x60\\,;&@]*)/dy) }, spans: (m) => strongBound(boundSpan(m, "secret_value", 2, syntaxCut), m) },
  // ── Password-bound values: every value masked whole unless it is in the closed set (isExactPlaceholder) ──
  // name = "…", name: '…', "name": "…", name := `…`, 'name' => '…': the quoted value whole, spaces and all.
  { cls: "password", head: { kind: "pw", lead: "alnum", after: stickyAfter(new RegExp(`${PW_SEP_SRC}${QUOTED_SRC}`, "dy")) }, spans: (m) => boundSpan(m, "password") },
  // name=value, name: value inline: the bare value to the next whitespace or quote (in a query, to its "&").
  { cls: "password", head: { kind: "pw", lead: "alnum", after: pwBareAfter }, spans: (m) => boundSpan(m, "password", 2, syntaxCut) },
  // A key line (YAML, dotenv, ini, properties, TOML): an unquoted value runs to the end of the line, less a " #" comment.
  // The regex reads to the value; keyLineTail checks the name and reads the value in one pass.
  { cls: "password", re: new RegExp(String.raw`^[ \t]*(?:export[ \t]+|-[ \t]+)?["']?([A-Za-z0-9_-]+)["']?[ \t]*[:=][ \t]*`, "dgm"), tail: keyLineTail },
  // A YAML block scalar (password: | or >, the value on the indented lines below).
  { cls: "password", re: new RegExp(String.raw`^([ \t]*)(?:-[ \t]+)?["']?([A-Za-z0-9_-]+)["']?[ \t]*:[ \t]*[|>][-+0-9]*[ \t]*(?:#[^\r\n]*)?\r?\n((?:[ \t]*\r?\n)*\1[ \t]+\S[^\r\n]*(?:\r?\n(?:[ \t]*\r?\n)*\1[ \t]+\S[^\r\n]*)*)`, "dgm"), verify: (m) => isPwName(m[2]!), spans: blockSpan },
  // A CLI flag, --password VALUE, --db-password=VALUE, -pass pass:VALUE, -passin …: quoted whole, bare to whitespace.
  { cls: "password", re: new RegExp(String.raw`(?<![\w-])--?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?:=|[ \t]+)(?:${QUOTED_SRC}|(\{\{[^{}\r\n]{0,200}\}\}(?=[\s"'\x60\\;,]|$)|[^\s"'\x60\\][^\s"'\x60\\]{0,}))`, "dg"), verify: (m) => m[1]!.split("-").some((w) => CLI_PW_WORD.test(w)), spans: cliSpan },
  // A connection-string field, such as Password=… or Pwd={…}: a value runs to its ";" (spaces included), or the braces whole.
  // The regex reads only the name and "="; connTail reads the value, so a line dense with password=… never rescans to its end per name.
  { cls: "password", head: { kind: "pw", lead: "delim", after: stickyAfter(/[ \t]*=[ \t]*/dy) }, tail: connTail },
  // SQL: PASSWORD 'value', IDENTIFIED BY 'value'.
  { cls: "password", re: new RegExp(String.raw`(?<![A-Za-z0-9_])(${ci("password")}|${ci("identified")}[ \t]+${ci("by")})[ \t]+(?:'((?:[^'\\\r\n]|\\.|'')*)'|"((?:[^"\\\r\n]|\\.)*)")`, "dg"), spans: (m) => boundSpan(m, "password") },
  // An XML element named for a password: <password>value</password>, CDATA included.
  // The regex reads the open tag; xmlTail reads the value and the close tag, finding "]]>" through a memoized search.
  { cls: "password", re: /<((?:[A-Za-z0-9_.-]+:)?[A-Za-z0-9_-]+)(?:\s[^<>]*)?>/dg, verify: (m) => isPwName(m[1]!.slice(m[1]!.indexOf(":") + 1)), tail: xmlTail },
  // user:PASSWORD after curl -u / --user, sshpass -p PASSWORD, mysql -pPASSWORD: bound by the tool's own syntax. A quoted value runs to its closing quote, spaces included.
  { cls: "password", re: /\bcurl\b/g, tail: toolFlagTail(CURL_FLAG_G, false) },
  { cls: "password", re: /\b(sshpass)[ \t]+(?:-[a-oq-zA-Z]\S*[ \t]+)*-p[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+))/dg, spans: (m) => boundSpan(m, "password", 2) },
  { cls: "password", re: /\b(mysql(?:dump|admin|import|sh|check|slap)?)\b/dg, tail: toolFlagTail(MYSQL_FLAG_G, true) },
];

/**
 * Every secret span in a piece of text, merged and ordered. Spans that overlap keep the earlier rule's class.
 *
 * No gate sits outside the rules: no length floor on the text and no veto after a rule matched. Each rule decides its own
 * match (a provider shape, a password binding, or a generic value that needs a shape test to be a secret at all), and
 * what it keeps is masked. A password bound to its name is masked at any length (pwd=7).
 */
/** How many text rules there are, so a test can time each one alone (detect's `only`). */
export const RULE_COUNT = RULES.length;

/**
 * A head rule over every name run (see Names read in code). Within one run every start shares the run's end and so the
 * same after-reading, and a later start reaches only fewer cores: when the first start a rule may take in a run fails,
 * every later one in that run fails too, and the run is left whole.
 */
function runHead(rule: Rule, rank: number, text: string, ctx: ScanCtx, tokens: readonly TokenSpan[], found: (Span & { rank: number })[]): void {
  const head = rule.head!;
  const runs = ctx.runs();
  const valid = ctx.valid(head.kind);
  let i = 0, pos = 0;
  while (i < runs.n) {
    const a = runs.start[i]!, b = runs.end[i]!;
    if (b <= pos || valid[i]! < 0) { i++; continue; }
    let p = -1;
    if (head.lead === "delim") p = pos <= a && (a === 0 || /[;"'\s]/.test(text[a - 1]!)) ? a : -1;
    else for (let x = Math.max(a, pos); x < b; x++) if (x === a || text[x - 1] === "_" || text[x - 1] === "-") { p = x; break; }
    if (p < 0 || p > valid[i]!) { i++; continue; }
    const host = tokens[firstTokenEndingAfter(tokens, p)];
    if (host && p > host[0]) { pos = host[1]; continue; }
    const after = head.after(text, b, ctx);
    if (!after) { i++; continue; }
    const m = synthMatch(text, p, b, after);
    if (rule.tail) {
      const t = rule.tail(m, ctx);
      if (!t) { pos = p + 1; continue; }
      pos = t.end;
      for (const s of t.spans) found.push({ ...s, rank });
      continue;
    }
    for (const s of rule.spans!(m)) found.push({ ...s, rank });
    pos = after.end;
  }
}

export function detect(text: string, only?: number): Span[] {
  const found: (Span & { rank: number })[] = [];
  const tokens = tokenSpans(text);
  const ctx = scanCtx(text);
  RULES.forEach((rule, rank) => {
    if (only !== undefined && rank !== only) return;
    if (rule.head) { runHead(rule, rank, text, ctx, tokens, found); return; }
    const re = rule.re!;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      // A token's own text (⟦masked:url_password:…⟧) is not a secret name: a match anchored inside a token is no match,
      // and the scan resumes right after that token so a real name glued behind it is still read.
      const host = tokens[firstTokenEndingAfter(tokens, m.index)];
      if (host && m.index > host[0]) { re.lastIndex = host[1]; continue; }
      if (rule.verify && !rule.verify(m)) { re.lastIndex = m.index + 1; continue; }
      if (rule.tail) {
        const t = rule.tail(m, ctx);
        if (!t) { re.lastIndex = m.index + 1; continue; }
        re.lastIndex = t.end;
        for (const s of t.spans) found.push({ ...s, rank });
        continue;
      }
      if (rule.spans) { for (const s of rule.spans(m)) found.push({ ...s, rank }); continue; }
      const idx = (m as RegExpExecArray & { indices?: [number, number][] }).indices;
      const [start, end] = rule.group !== undefined && idx ? idx[rule.group]! : [m.index, m.index + m[0].length];
      // The rule's own accept is the only test: a provider key holding an ascending run (abcdef) is still a key.
      if (rule.accept && !rule.accept(text.slice(start, end), m)) continue;
      found.push({ start, end, cls: rule.cls, rank });
    }
  });
  // An existing mask token never shields the text around it: a span that overlaps a token is masked minus the token,
  // so plaintext glued to a token is masked and the token itself stays byte for byte (masking twice changes nothing).
  if (MASK_TOKEN_RE.test(text)) {
    const cut: typeof found = [];
    for (const sp of found) for (const [start, end] of piecesBetween(text, tokens, sp.start, sp.end)) cut.push({ ...sp, start, end });
    found.splice(0, found.length, ...cut);
  }
  found.sort((a, b) => a.start - b.start || a.rank - b.rank);
  const out: Span[] = [];
  for (const s of found) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) { last.end = Math.max(last.end, s.end); continue; }
    out.push({ start: s.start, end: s.end, cls: s.cls, ...(s.name ? { name: s.name } : {}) });
  }
  return out;
}

// ── Walk ──

type Part = string | { cls: string; secret: string };
class Deferred { constructor(readonly parts: Part[]) {} }

const childPath = (path: string, key: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);

/** The class a whole value under a secret-named key gets, or null when the value stays. */
function keyContextClass(name: string, v: unknown): string | null {
  const kind = secretName(name);
  if (!kind) return null;
  const n = snake(name);
  const password = kind === "strong" && PASSWORD_NAME.test(n);
  if (kind === "weak") {
    // "session" names an id far more often than a credential: only a credential-looking string is masked.
    if (typeof v !== "string" || isExactPlaceholder(v)) return null;
    return v.length >= 16 && hasDigit(v) && hasLetter(v) && !/\s/.test(v) && !isUuid(v) && !/^[0-9a-f]+$/i.test(v) && !isPathOrUrl(v) ? "session" : null;
  }
  // Under a strong secret name the value is the secret unless it is one of a closed set of non-secrets. Nothing about
  // its length, a url or path shape, or reading as prose exempts it: the record is permanent and a false mask costs little.
  if (typeof v === "boolean" || v === null || v === undefined) return null;
  // A password number is always a secret; under any other strong name only a long, varied integer is (max_token: 4096 stays).
  if (typeof v === "number") return password ? "password" : Number.isSafeInteger(v) && numericSecret(String(Math.abs(v))) ? "secret_value" : null;
  if (typeof v !== "string") return null; // objects and arrays are walked, their leaves inheriting the name
  if (isExactPlaceholder(v)) return null;
  if (password) return "password"; // whitespace included: a passphrase such as four random words is a password
  if (/cookies?$/.test(n)) return "cookie";
  if (/authorization$/.test(n)) return "authorization";
  return "secret_value";
}

function walkString(s: string, path: string, out: { path: string; cls: string }[], onMatch?: MaskOptions["onMatch"]): string | Deferred {
  const spans = detect(s);
  if (!spans.length) return s;
  const parts: Part[] = [];
  let at = 0;
  for (const sp of spans) {
    if (sp.start > at) parts.push(s.slice(at, sp.start));
    const secret = s.slice(sp.start, sp.end);
    parts.push({ cls: sp.cls, secret });
    out.push({ path, cls: sp.cls });
    onMatch?.({ path, cls: sp.cls, value: secret, ...(sp.name ? { name: sp.name } : {}) });
    at = sp.end;
  }
  if (at < s.length) parts.push(s.slice(at));
  return new Deferred(parts);
}

function walk(v: unknown, path: string, name: string | undefined, out: { path: string; cls: string }[], onMatch?: MaskOptions["onMatch"]): unknown {
  if (name !== undefined) {
    const cls = keyContextClass(name, v);
    if (cls) {
      const secret = String(v);
      out.push({ path, cls });
      if (typeof v === "string" && MASK_TOKEN_RE.test(v)) {
        // Part masked already: keep each token byte for byte, mask every other non-blank piece (the same cut detect() makes).
        const parts: Part[] = [];
        let at = 0;
        for (const [a, b] of plainPieces(v)) {
          if (a > at) parts.push(v.slice(at, a));
          const raw = v.slice(a, b);
          parts.push({ cls, secret: raw });
          onMatch?.({ path, cls, value: raw, name });
          at = b;
        }
        if (at < v.length) parts.push(v.slice(at));
        return new Deferred(parts);
      }
      onMatch?.({ path, cls, value: secret, name });
      return new Deferred([{ cls, secret }]);
    }
  }
  if (typeof v === "string") return walkString(v, path, out, onMatch);
  // A list under a secret name ({passwords: [...]}, {api_key: [old, new]}) is a list of secrets: its items keep the name.
  const kind = name !== undefined ? secretName(name) : null;
  if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, kind ? name : undefined, out, onMatch));
  // An object under a strong secret name ({secrets: {db: ...}}) holds secrets: a child keeps the parent's name unless
  // its own key is a strong secret name too; a weaker name (session) never downgrades it. The keys themselves are still scanned as text, never masked whole.
  const inherit = kind === "strong" ? name : undefined;
  if (v && typeof v === "object") {
    const entries: [string | Deferred, unknown][] = [];
    Object.entries(v as Record<string, unknown>).forEach(([k, x], i) => {
      // A key that holds a secret must not leak through the reported paths: it is named by its position instead.
      const p = detect(k).length ? `${path}[#${i}]` : childPath(path, k);
      entries.push([walkString(k, `${p}#key`, out, onMatch), walk(x, p, inherit !== undefined && secretName(k) !== "strong" ? inherit : k, out, onMatch)]);
    });
    return { __entries: entries } as const;
  }
  return v;
}

// ── HMAC ──

const keyCache = new Map<string, Promise<CryptoKey>>();

async function importKey(key: MaskKey): Promise<CryptoKey> {
  if (typeof key !== "string" && !(key instanceof Uint8Array)) return key;
  const bytes = typeof key === "string" ? new TextEncoder().encode(key) : key;
  if (bytes.length === 0) throw new Error("mask key is empty");
  const cacheId = typeof key === "string" ? `s:${key}` : null;
  if (cacheId && keyCache.has(cacheId)) return keyCache.get(cacheId)!;
  const p = crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  if (cacheId) { if (keyCache.size > 8) keyCache.clear(); keyCache.set(cacheId, p); }
  return p;
}

async function hmac12(k: CryptoKey, secret: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(secret)));
  let hex = "";
  for (let i = 0; i < 6; i++) hex += sig[i]!.toString(16).padStart(2, "0");
  return hex;
}

function collectSecrets(t: unknown, into: Set<string>): void {
  if (t instanceof Deferred) { for (const p of t.parts) if (typeof p !== "string") into.add(p.secret); return; }
  if (Array.isArray(t)) { for (const x of t) collectSecrets(x, into); return; }
  if (t && typeof t === "object" && "__entries" in t) {
    for (const [k, x] of (t as { __entries: [string | Deferred, unknown][] }).__entries) { collectSecrets(k, into); collectSecrets(x, into); }
  }
}

function materialize(t: unknown, tokens: Map<string, string>): unknown {
  if (t instanceof Deferred) return t.parts.map((p) => (typeof p === "string" ? p : maskToken(p.cls, tokens.get(p.secret)!))).join("");
  if (Array.isArray(t)) return t.map((x) => materialize(x, tokens));
  if (t && typeof t === "object" && "__entries" in t) {
    // defineProperty, never assignment: an own "__proto__" key (JSON.parse makes one) must stay a key, not set the prototype.
    const o: Record<string, unknown> = {};
    for (const [k, x] of (t as { __entries: [string | Deferred, unknown][] }).__entries) {
      Object.defineProperty(o, materialize(k, tokens) as string, { value: materialize(x, tokens), enumerable: true, writable: true, configurable: true });
    }
    return o;
  }
  return t;
}

/** Every string in a JSON value, object keys included. */
function stringsOf(v: unknown, into: string[] = []): string[] {
  if (typeof v === "string") into.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, into);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { into.push(k); stringsOf(x, into); }
  return into;
}

/** Replace every occurrence of an own secret, longest first, in strings and object keys. Linear per needle. */
function replaceExact(v: unknown, path: string, needles: readonly string[], tokens: Map<string, string>, out: { path: string; cls: string }[], onMatch?: MaskOptions["onMatch"]): unknown {
  const swap = (s: string, p: string): string => {
    let r = s;
    for (const n of needles) {
      if (!r.includes(n)) continue;
      r = r.split(n).join(tokens.get(n)!);
      out.push({ path: p, cls: "own_secret" });
      onMatch?.({ path: p, cls: "own_secret", value: n });
    }
    return r;
  };
  if (typeof v === "string") return swap(v, path);
  if (Array.isArray(v)) return v.map((x, i) => replaceExact(x, `${path}[${i}]`, needles, tokens, out, onMatch));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    Object.entries(v as Record<string, unknown>).forEach(([key, x], i) => {
      const k2 = swap(key, `${path}[#${i}]#key`);
      Object.defineProperty(o, k2, { value: replaceExact(x, k2 === key ? childPath(path, key) : `${path}[#${i}]`, needles, tokens, out, onMatch), enumerable: true, writable: true, configurable: true });
    });
    return o;
  }
  return v;
}

// ── API ──

/**
 * Mask every secret in a JSON value. Returns a new value (the input is not touched), the JSON paths
 * that changed (a masked object key is reported as `<path>#key`) and the classes found.
 * Idempotent: masking a masked value changes nothing.
 */
export async function mask(value: unknown, key: MaskKey, opts: MaskOptions = {}): Promise<MaskResult> {
  const found: { path: string; cls: string }[] = [];
  // Only the own secrets that actually occur get a token: signing every one on every call would cost a signature per
  // secret per row.
  const candidates = (opts.exact ?? []).filter((s) => typeof s === "string" && s.length >= EXACT_MIN);
  const strings = candidates.length > 0 ? stringsOf(value) : [];
  const needles = [...new Set(candidates.filter((n) => strings.some((s) => s.includes(n))))].sort((a, b) => b.length - a.length);
  let k: CryptoKey | null = null;
  if (needles.length > 0) {
    k = await importKey(key);
    const tokens = new Map<string, string>();
    for (const n of needles) tokens.set(n, maskToken("own_secret", await hmac12(k, n)));
    value = replaceExact(value, "$", needles, tokens, found, opts.onMatch);
  }
  const tree = walk(value, "$", undefined, found, opts.onMatch);
  if (!found.length) return { value, masked: [], classes: [] };
  const hk = k ?? (await importKey(key));
  const secrets = new Set<string>();
  collectSecrets(tree, secrets);
  const tokens = new Map<string, string>();
  await Promise.all([...secrets].map(async (s) => tokens.set(s, await hmac12(hk, s))));
  return {
    value: materialize(tree, tokens),
    masked: [...new Set(found.map((f) => f.path))],
    classes: [...new Set(found.map((f) => f.cls))].sort(),
  };
}

/** Where a value still holds a secret, without masking it: the intake's rescan. Empty means clean. */
export function scan(value: unknown): { path: string; cls: string }[] {
  const found: { path: string; cls: string }[] = [];
  walk(value, "$", undefined, found);
  return found;
}
