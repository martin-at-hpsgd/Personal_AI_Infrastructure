/**
 * WorkRedact — deterministic PII redaction at the Work System's issue boundary.
 *
 * One chokepoint, applied inside every issue-creating/editing function
 * (LIFEOS/TOOLS/WorkSweep.ts and the maintainer-side
 * session-sync hook, not shipped) right before content leaves the machine.
 * Free text captured from prompts and session frontmatter is unpredictable;
 * once it lands in an issue it is effectively permanent, so the filter runs
 * on every payload rather than trusting any caller to pre-clean.
 *
 * Deliberately NOT covered: TELOS goal text. Scrubbing a goal destroys the
 * reason it is useful — goal export is instead gated off by default
 * (WORK.CAPTURE_GOALS, see work-config.ts). Dollar amounts are also kept:
 * in a privacy-attested private repo they are usually the point of the
 * reminder, and masking them would gut utility without closing a real hole.
 *
 * public issue #1825, @PaulWaldo
 *
 * @version 1.0.0
 */

import { invariant } from "../Invariant";
import { redact } from "./Boundary";

interface PatternClass {
  name: string;
  re: RegExp;
  replacement: string;
  /** The class can only match text containing this; skipped otherwise. */
  needs?: string;
}

// Order matters: credentials first so a token inside an email-shaped or
// path-shaped string is classified as the more sensitive thing it is.
//
// Speed: a pattern that can start at every `\b` inside a long run of word
// characters and hyphens rescans the rest of the run from each one, which is
// quadratic in the run's length (a 32 KB `a-a-a-…` line took about two minutes
// in the final review). The prefixed label class therefore starts only where
// such a run starts; the email class keeps HEAD's exact pattern and runs only
// on text holding an "@".
const CLASSES: PatternClass[] = [
  {
    name: "credential",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:credential]",
  },
  {
    // Known token shapes: OpenAI, GitHub (every ghX_ family: personal, OAuth,
    // user-to-server, server-to-server, refresh; plus fine-grained), Slack,
    // AWS access key IDs, GitLab.
    name: "credential",
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,})\b/g,
    replacement: "[REDACTED:credential]",
  },
  {
    // key/secret/password assignments. Requires an explicit ':' or '=', so
    // prose like "the password reset flow" passes untouched. The key may carry
    // a prefix (client_secret, DB_PASSWORD, x-api-key) and ends in one of the
    // credential words the shared redactor also labels.
    //
    // The value is one of:
    //  - a quoted value to its closing quote on the same line, plus anything
    //    glued after it, so `password="two words"` goes whole (the space used
    //    to cut it and keep the second word);
    //  - otherwise, as at HEAD, 8+ non-space characters, taking the whole run.
    // Either way the match ends where HEAD's did or later, never earlier.
    //
    // A value that is exactly a credential mark (or the shared redactor's bare
    // one), optionally quoted, then whitespace or the end, is left alone, so
    // redacting this function's own output again changes nothing. Anything
    // glued after a mark, or a delimiter and more text ("[REDACTED]hunter2…",
    // "[REDACTED:credential],hunter2…"), means the value only starts like a
    // mark, and the whole run is redacted as at HEAD (S060 reviews 1 and 2).
    // A typed non-credential mark ("password=[REDACTED:email]") is a value
    // under a credential label and is redacted as at HEAD.
    //
    // The key starts where its run of word characters and hyphens starts (the
    // lookbehind), never at each `\b` inside it; from there the lazy prefix
    // still reaches every later position in the run, linearly.
    name: "credential",
    re: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]*?(?:api[_-]?key|apikey|(?:private|access|secret|session|signing)[_-]?key|secret|password|passwd|passphrase|token)\s*[:=]\s*(?!(["']?)\[REDACTED(?::credential)?\]\1(?=$|\s))(?:"[^"\r\n]*"\S*|'[^'\r\n]*'\S*|["']?\S{8,}["']?)/gi,
    replacement: "[REDACTED:credential]",
  },
  {
    // HEAD's own label pattern, kept beside the prefixed one (same mark
    // exemption). A prefixed match can start where HEAD's could not
    // (`mypassword=…`) and its value can swallow the next key
    // (`mypassword=abcdefgh/x-api-key = value`), so that key's value, which
    // HEAD redacted, would survive (final round 2 fuzz). With HEAD's pattern
    // in the union every label match HEAD made is still made.
    name: "credential",
    re: /\b(?:api[_-]?key|apikey|secret|password|passwd|auth[_-]?token|access[_-]?token)\s*[:=]\s*(?!(["']?)\[REDACTED(?::credential)?\]\1(?=$|\s))["']?\S{8,}["']?/gi,
    replacement: "[REDACTED:credential]",
  },
  {
    name: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED:email]",
    needs: "@",
  },
  {
    // Phone numbers must carry separators or a leading + — bare digit runs
    // (issue numbers, years, byte counts) never match.
    name: "phone",
    re: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\b\d{3}[ .-])\d{3}[ .-]\d{4}\b/g,
    replacement: "[REDACTED:phone]",
  },
  {
    name: "phone",
    re: /\+\d{10,15}\b/g,
    replacement: "[REDACTED:phone]",
  },
  {
    name: "gov-id",
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[REDACTED:gov-id]",
  },
  {
    name: "card",
    re: /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b/g,
    replacement: "[REDACTED:card]",
  },
  {
    // Street addresses, conservatively: number + 1-3 capitalized words + a
    // street suffix. Lowercase prose ("3 ways forward") never matches.
    name: "address",
    re: /\b\d{1,5}\s+(?:[A-Z][A-Za-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir)\b\.?/g,
    replacement: "[REDACTED:address]",
  },
];

// Home paths rewrite to "~" instead of a redaction token — the path stays
// useful, only the username disappears. Covers this machine's own paths AND
// other users' paths pasted into prompts (logs, stack traces).
const HOME_PATH_RE = /\/(?:Users|home)\/[A-Za-z0-9._-]+/g;

// What one redaction pass matches: every class, then home paths last, so a
// home path that overlaps a credential merges into the credential mark (a
// prefixed label match could take the username out of `/Users/<name>…` and
// leave `/Users/` that HEAD rewrote to "~").
const PASS: PatternClass[] = [...CLASSES, { name: "home-path", re: HOME_PATH_RE, replacement: "~" }];

// HEAD's own pass: HEAD's exact patterns, applied in HEAD's order, one class
// after another, each over the text the earlier ones left. Its result is
// combined with the union pass below (both computed on the same input), so the
// output hides at least what HEAD hid by construction. The union pass alone
// matched every class on the original text, where a match could start inside
// or stop short of what HEAD's replacement exposed to the next class: a token
// glued to `x@example.com@example.com` left the second email visible, a phone
// glued to a card left the last card group, and a labelled key block glued to
// a suffix left the suffix (closing pass, S060 parity). HEAD's pass alone loses
// the union's wider matches (`password="two words"`), so neither replaces the
// other. Only two changes from HEAD: the label class skips a value that is
// exactly a mark (the same exemption as above, so a second run over this
// function's output changes nothing), and the email class runs only on text
// holding an "@" (it cannot match otherwise). Each entry names the PASS entry
// whose mark it writes.
const HEAD_PASS: Array<{ c: PatternClass; rank: number }> = [
  { c: CLASSES[0]!, rank: 0 },
  {
    c: {
      name: "credential",
      re: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,})\b/g,
      replacement: "[REDACTED:credential]",
    },
    rank: 1,
  },
  ...CLASSES.slice(3).map((c, i) => ({ c, rank: i + 3 })),
  { c: PASS[PASS.length - 1]!, rank: PASS.length - 1 },
];

/** A replaced stretch of the input, as offsets into it, and the PASS entry whose mark it takes. */
interface Span { start: number; end: number; rank: number }

/** Every match of every PASS entry, each on `src` as given. */
function unionSpans(src: string): Span[] {
  const spans: Span[] = [];
  PASS.forEach((c, rank) => {
    if (c.needs !== undefined && !src.includes(c.needs)) return;
    const re = new RegExp(c.re.source, c.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (m[0].length === 0) { re.lastIndex = m.index + 1; continue; }
      spans.push({ start: m.index, end: m.index + m[0].length, rank });
    }
  });
  return spans;
}

/** What HEAD's sequential pass replaced, as spans of `src`. Each class runs on the text the earlier
 * classes wrote; a match that touches an earlier mark takes that mark's whole stretch of `src`. */
function headSpans(src: string): Span[] {
  let marks: Span[] = [];
  for (const { c, rank } of HEAD_PASS) {
    // The text HEAD's next class sees, and where each piece of it came from.
    const segs: Array<{ cur: number; len: number; orig: number; mark?: Span }> = [];
    let text = "";
    let at = 0;
    for (const m of marks) {
      if (m.start > at) { segs.push({ cur: text.length, len: m.start - at, orig: at }); text += src.slice(at, m.start); }
      const rep = PASS[m.rank]!.replacement;
      segs.push({ cur: text.length, len: rep.length, orig: m.start, mark: m });
      text += rep;
      at = m.end;
    }
    if (at < src.length) { segs.push({ cur: text.length, len: src.length - at, orig: at }); text += src.slice(at); }
    if (text.length === 0 || (c.needs !== undefined && !text.includes(c.needs))) continue;

    let k = 0;
    const seg = (p: number) => {
      while (k < segs.length - 1 && segs[k]!.cur + segs[k]!.len <= p) k++;
      return segs[k]!;
    };
    const found: Span[] = [];
    const re = new RegExp(c.re.source, c.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex = m.index + 1; continue; }
      const last = m.index + m[0].length - 1;
      const a = seg(m.index);
      const start = a.mark ? a.mark.start : a.orig + (m.index - a.cur);
      const b = seg(last);
      const end = b.mark ? b.mark.end : b.orig + (last - b.cur) + 1;
      const prev = found[found.length - 1];
      if (prev && start < prev.end) prev.end = Math.max(prev.end, end);
      else found.push({ start, end, rank });
    }
    if (found.length === 0) continue;
    // HEAD replaced each match, marks inside it included, with this class's mark.
    marks = [...marks.filter((x) => !found.some((f) => f.start < x.end && x.start < f.end)), ...found]
      .sort((x, y) => x.start - y.start);
  }
  return marks;
}

// The shared redactor's own mark. While it runs, every credential mark is
// written this way, because the shared redactor treats exactly this text as
// already redacted; any other text after a credential label ("password:
// [REDACTED:credential]") it would redact again. Converted back afterwards.
// Only a complete mark is converted: one followed by a space, the end, a quote
// or closing punctuation. A mark with text glued after it is left as written,
// so the shared redactor never takes "[REDACTED:credential]hunter2…" for its
// own already-redacted mark. The way back is complete-only too, so a glued
// "[REDACTED]tail" in the input never becomes a glued credential mark.
const SHARED_MARK = "[REDACTED]";
const CREDENTIAL_MARK = "[REDACTED:credential]";
const COMPLETE_CREDENTIAL_MARK = /\[REDACTED:credential\](?=$|[\s"'`,;)}\]>])/g;
const COMPLETE_SHARED_MARK = /\[REDACTED\](?=$|[\s"'`,;)}\]>])/g;
const toShared = (s: string) => s.replace(COMPLETE_CREDENTIAL_MARK, () => SHARED_MARK);
const fromShared = (s: string) => s.replace(COMPLETE_SHARED_MARK, () => CREDENTIAL_MARK);
const countMarks = (s: string) => s.split(SHARED_MARK).length - 1;

export interface RedactionResult {
  text: string;
  total: number;
  byClass: Record<string, number>;
}

export function redactWorkContent(input: string): RedactionResult {
  let text = input;
  const byClass: Record<string, number> = {};
  let total = 0;

  // Every local class and the home-path rewrite are matched against the same
  // text and the union of their matches is replaced; where matches overlap, the
  // merged span takes the mark of the earliest entry in PASS (credentials
  // first, home paths last). Applying the classes
  // one after another let an earlier match cut a later one short: the prefixed
  // label class took `compassword = …` out of `x-api-key@example.compassword`,
  // so the email class no longer matched and `x-api-key@example.` stayed
  // visible where HEAD redacted it as an email (final round 2 fuzz). Each class
  // matches at least what HEAD's did, so the union covers everything HEAD
  // redacted.
  const applySpans = (spans: Span[]) => {
    if (spans.length === 0) return;
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: typeof spans = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.start < last.end) {
        last.end = Math.max(last.end, s.end);
        last.rank = Math.min(last.rank, s.rank);
      } else {
        merged.push({ ...s });
      }
    }
    let out = "";
    let at = 0;
    for (const s of merged) {
      const c = PASS[s.rank];
      invariant(c !== undefined && s.start >= at && s.end > s.start, "WorkRedact span merge produced a bad span");
      out += text.slice(at, s.start) + c.replacement;
      at = s.end;
      byClass[c.name] = (byClass[c.name] ?? 0) + 1;
      total += 1;
    }
    text = out + text.slice(at);
  };

  // 1. The local classes, as the union pass and as HEAD's sequential pass, both
  // on the input, and every stretch either one replaced is replaced, so every
  // value HEAD redacted is still taken whole before anything else touches the
  // text. The shared pass used to run first; its token pass broke an email
  // apart before the email class saw it ("jane.doe-[REDACTED]@example.com"),
  // and it cut `password=12345678,SecretTail` at the comma under a label only
  // it knows (pwd=, cookie=, pin=), leaving the tail (final review).
  applySpans([...headSpans(text), ...unionSpans(text)]);

  // 2. Then the one shared redactor (Boundary.redact: every secret shape LifeOS
  // knows plus credential-labelled values in headers, flags and quoted JSON
  // keys). The local list names only a few shapes, so a bearer header, a quoted
  // JSON key or a token family it lacked passed through unchanged (S060). Run
  // last, it can only add marks to what the local pass left.
  const before = toShared(text);
  const shared = redact(before);
  if (shared !== before) {
    const added = Math.max(countMarks(shared) - countMarks(before), 1);
    byClass["credential"] = (byClass["credential"] ?? 0) + added;
    total += added;
  }
  text = fromShared(shared);

  // 3. The local classes once more over what the shared pass wrote. It cuts a
  // bare value at a delimiter, so a short value under a local label the first
  // pass left (`password=abc,de`) comes back as `password=[mark],de`; the label
  // class takes that whole, so no tail survives and the self-check holds.
  const afterShared = text;
  applySpans(unionSpans(text));

  // Self-check before this content is allowed out: the redactor's own output
  // must be clean by its own patterns. A match surviving here is a programmer
  // error (pattern replaced with something that re-triggers), never bad input.
  for (const c of CLASSES) {
    if (c.needs !== undefined && !text.includes(c.needs)) continue;
    invariant(!c.re.test(text), `WorkRedact output still matches class "${c.name}"`);
    c.re.lastIndex = 0; // /g regexes are stateful across .test() calls
  }
  invariant(!HOME_PATH_RE.test(text), "WorkRedact output still contains a home path");
  HOME_PATH_RE.lastIndex = 0;
  // And clean by the shared redactor. When step 3 changed nothing, the text is
  // exactly the shared redactor's output with its complete marks renamed and
  // renamed back, and redactLabelled is idempotent, so a second shared pass
  // would only repeat the first; it runs when step 3 changed the text.
  if (text !== afterShared) {
    const back = toShared(text);
    invariant(redact(back) === back, "WorkRedact output still holds a value the shared redactor redacts");
  }

  return { text, total, byClass };
}

/** Convenience wrapper for the issue payload shape every writer uses. */
export function redactIssuePayload(
  title: string,
  body: string,
): { title: string; body: string; total: number; byClass: Record<string, number> } {
  const t = redactWorkContent(title);
  const b = redactWorkContent(body);
  const byClass: Record<string, number> = { ...t.byClass };
  for (const [k, v] of Object.entries(b.byClass)) byClass[k] = (byClass[k] ?? 0) + v;
  return { title: t.text, body: b.text, total: t.total + b.total, byClass };
}
