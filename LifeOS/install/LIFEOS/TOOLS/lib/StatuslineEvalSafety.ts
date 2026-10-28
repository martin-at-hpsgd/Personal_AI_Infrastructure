/**
 * Detector for shell-injection shapes in LIFEOS/LIFEOS_StatusLine.sh
 * (GHSA-r4v7-4f75-h7ch, @krish-221).
 *
 * Two shapes run data as shell:
 *
 * 1. `eval "$(jq -r '"name=\(.field)"' file)"`: a jq string interpolation is
 *    printed raw, so a string field holding `1; cmd` becomes a command. Each
 *    interpolation must pass through `numbers` (a non-number empties the whole
 *    output, so nothing is assigned) or `@sh` (shell-quoted).
 * 2. `echo "name='$(cat cache)'" > file.sh` followed by `source file.sh`: a `'`
 *    in the cached text closes the quote. Write with `printf 'name=%q\n'`.
 * 3. `eval "$(… grep -E '^name=' file)"`: grep fences the name, not the value.
 *    A grep-fed eval passes only when its patterns are the fenced whitelist shape below.
 *
 * The /ic lane `statusline-eval-safety` (IntegrityCheck.ts) runs this over the
 * statusline. Pure: takes source text, returns findings, touches nothing.
 */

export interface EvalHazard {
  line: number; // 1-based line of the offending construct
  detail: string;
}

/** An `eval "$(` whose command substitution runs jq, directly or after a pipe. */
const EVAL_JQ_RE = /eval\s+"\$\((?:[^'\n]*\|\s*)?jq\b/g;
/** A sourced-file write that wraps a command or variable expansion in single quotes. */
const ECHO_SOURCED_RE = /echo\s+(?:-e\s+)?"[A-Za-z_][A-Za-z0-9_]*='\$[({A-Za-z_]/;

function lineOf(src: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

/**
 * Body of the `\(` interpolation that opens at `open` (the index of the `(`),
 * or null when the parens never balance inside the program.
 */
function interpolationBody(program: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < program.length; i++) {
    const c = program[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return program.slice(open + 1, i);
    }
  }
  return null;
}

/** Split a jq expression on a top-level separator, ignoring string literals and anything inside (), [] or {}. */
function splitTop(expr: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0, inStr = false, last = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && expr.startsWith(sep, i)) {
      parts.push(expr.slice(last, i));
      i += sep.length - 1;
      last = i + 1;
    }
  }
  parts.push(expr.slice(last));
  return parts;
}

/** True when the first `(` of the expression closes on its last character, so the parentheses wrap all of it. */
function wholeParen(a: string): boolean {
  if (!a.startsWith('(') || !a.endsWith(')')) return false;
  let depth = 0, inStr = false;
  for (let i = 0; i < a.length; i++) {
    const c = a[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i === a.length - 1; }
  }
  return false;
}

/**
 * True only when the value an interpolation EMITS has passed through the `numbers` filter or `@sh` as a filter stage:
 * the final pipe stage is exactly `numbers`/`@sh` (or a parenthesised expression that is), and every `//` alternative
 * in it is likewise guarded or a bare number. A field that is merely NAMED `numbers` is not a filter, and a guard
 * on an earlier stage that a later stage undoes does not count.
 */
export function emitsGuarded(expr: string, allowSh = true): boolean {
  const stages = splitTop(expr, '|');
  const lastStage = (stages[stages.length - 1] ?? '').trim();
  if (!lastStage) return false;
  return splitTop(lastStage, '//').every((alt) => {
    const a = alt.trim();
    if (a === 'numbers' || (allowSh && a === '@sh') || /^-?\d+(?:\.\d+)?$/.test(a)) return true;
    return wholeParen(a) && emitsGuarded(a.slice(1, -1), allowSh);
  });
}

type ShellQuote = 'none' | 'single' | 'double';

/**
 * Each interpolation in a jq program with the shell quoting state of the text jq emits just before it.
 * `@sh` output is a single-quoted word, which is only safe where the shell reads it unquoted: inside
 * `"…"` the quotes it adds are literal and `$(…)` still runs, and inside `'…'` they close the quote.
 * The walk follows jq string literals (where `\"` emits `"`) and treats text outside them as emitting nothing.
 */
function interpolationsWithQuoting(program: string): Array<{ index: number; body: string | null; quote: ShellQuote }> {
  const out: Array<{ index: number; body: string | null; quote: ShellQuote }> = [];
  let inJq = false, quote: ShellQuote = 'none', shellEscape = false;
  const emit = (c: string) => {
    if (shellEscape) { shellEscape = false; return; }
    if (quote === 'none') { if (c === "'") quote = 'single'; else if (c === '"') quote = 'double'; else if (c === '\\') shellEscape = true; }
    else if (quote === 'single') { if (c === "'") quote = 'none'; }
    else if (c === '"') quote = 'none';
    else if (c === '\\') shellEscape = true;
  };
  for (let i = 0; i < program.length; i++) {
    const c = program[i];
    if (!inJq) { if (c === '"') inJq = true; continue; }
    if (c === '"') { inJq = false; continue; }
    if (c !== '\\') { emit(c); continue; }
    const n = program[i + 1];
    if (n === '(') {
      const body = interpolationBody(program, i + 1);
      out.push({ index: i, body, quote });
      if (body === null) return out;
      shellEscape = false; // the emitted value is one opaque word
      i += 1 + body.length + 1;
      continue;
    }
    emit(n === 'n' ? '\n' : n === 't' ? '\t' : n ?? '');
    i++;
  }
  return out;
}

/* Shape 3 whitelist (GHSA-r4v7-4f75-h7ch class follow-up, @krish-221). One alternative is
 * `^NAME=VALUE$`: NAME is word characters, `[a-z]+`, or a flat `(a|b)` group (no top-level
 * `|`), and VALUE is `[0-9]+` or one single-quoted word. Anything else is refused. */
const NAME_ATOM = String.raw`(?:[A-Za-z0-9_]|\[a-z\]\+)`;
const NAME = String.raw`(?:${NAME_ATOM}|\((?:${NAME_ATOM}|\|)+\))+`;
const ALT = String.raw`\^${NAME}=(?:\[0-9\]\+|'\[A-Za-z0-9:_\. -\]\*')\$`;
const FENCED_PATTERN = new RegExp(`^${ALT}(?:\\|${ALT})*$`);
const QUOTED = String.raw`^\s+(?:'([^']*)'|"([^"]*)")`;

/** True when the grep on an eval line has only -E/-e/-h options and fenced-shape patterns. */
function grepIsFenced(line: string): boolean {
  let rest = line.slice(line.search(/\bgrep\b/) + 4);
  const pats: string[] = [];
  const take = (re: RegExp) => {
    const m = rest.match(re);
    if (m) rest = rest.slice(m[0].length);
    return m;
  };
  // A double-quoted pattern reaches grep with `\$` already unescaped to `$`.
  const pattern = (m: RegExpMatchArray | null) => m !== null && pats.push(m[1] ?? m[2].replace(/\\\$/g, '$')) > 0;
  let hasE = false;
  for (let o = take(/^\s+-([Eh]*)(e?)(?=\s)/); o; o = take(/^\s+-([Eh]*)(e?)(?=\s)/)) {
    if (!o[1] && !o[2]) return false;
    if (o[2]) {
      hasE = true;
      if (!pattern(take(new RegExp(QUOTED)))) return false;
    }
  }
  if (!hasE) pattern(take(new RegExp(QUOTED)));
  return pats.length > 0 && !/\s-\S/.test(rest) && pats.every((p) => FENCED_PATTERN.test(p));
}

/** Every eval-jq interpolation lacking `numbers`/`@sh`, and every quoted sourced-file write. */
export function findStatuslineEvalHazards(src: string): EvalHazard[] {
  const hazards: EvalHazard[] = [];

  for (const m of src.matchAll(EVAL_JQ_RE)) {
    const jqAt = (m.index ?? 0) + m[0].length;
    // The jq program is the first single-quoted shell word after `jq`. Shell
    // single quotes cannot contain a quote, so the next `'` closes it.
    const start = src.indexOf("'", jqAt);
    const end = start < 0 ? -1 : src.indexOf("'", start + 1);
    if (start < 0 || end < 0) {
      hazards.push({ line: lineOf(src, m.index ?? 0), detail: 'eval "$(jq …)" with no single-quoted jq program — cannot verify its interpolations' });
      continue;
    }
    // A program spliced from several shell words ('…'"'"'…') is not the text between the first two quotes.
    if (end + 1 < src.length && !/[\s)|;&]/.test(src[end + 1])) {
      hazards.push({ line: lineOf(src, start), detail: 'eval "$(jq …)" program is spliced from several shell words — cannot verify its interpolations' });
      continue;
    }
    const program = src.slice(start + 1, end);
    for (const { index, body, quote } of interpolationsWithQuoting(program)) {
      const at = lineOf(src, start + 1 + index);
      if (body === null) {
        hazards.push({ line: at, detail: 'unbalanced jq interpolation inside eval "$(jq …)"' });
        break;
      }
      if (quote !== 'none' && !emitsGuarded(body, false)) {
        hazards.push({ line: at, detail: `eval'd jq interpolation \\(${body.trim()}) sits inside a ${quote}-quoted shell string, where \`@sh\` does not protect it — use \`| numbers\` or move it outside the quotes` });
      } else if (!emitsGuarded(body)) {
        hazards.push({ line: at, detail: `eval'd jq interpolation \\(${body.trim()}) has neither \`| numbers\` nor \`@sh\` — a string field runs as shell` });
      }
    }
  }

  src.split('\n').forEach((text, i) => {
    if (text.trim().startsWith('#')) return;
    if (/\beval\s+"?\$\(/.test(text) && /\bgrep\b/.test(text) && !grepIsFenced(text)) {
      hazards.push({ line: i + 1, detail: 'grep-fed eval: pattern is not a fenced whitelist shape' });
    }
    if (ECHO_SOURCED_RE.test(text)) {
      hazards.push({ line: i + 1, detail: `sourced-file write wraps an expansion in single quotes — use printf 'name=%q\\n': ${text.trim().slice(0, 120)}` });
    }
  });

  return hazards.sort((a, b) => a.line - b.line);
}
