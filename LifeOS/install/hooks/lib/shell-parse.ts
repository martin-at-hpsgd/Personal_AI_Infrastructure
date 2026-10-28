/**
 * shell-parse.ts — the shell tokenizer the shell-command walker (lib/shell-commands.ts) and VerificationGate read
 * a Bash line with: simple commands, quoted words, redirects, heredocs, substitutions.
 *
 * Moved out of SubagentShipGuard.hook.ts on 2026-10-24 when the per-call guards were deleted
 * (ISA 20261024-native-security ISC-7). The parser is unchanged; nothing here judges a command.
 */


/**
 * One word or redirect operator. `quoted` marks a word with any quoting or escaping in it (`"fi"`, `'}'`, `\done`):
 * the shell never reads such a word as a reserved word, so it opens and closes no scope (S006 final round).
 */
export interface Tok { text: string; op?: ">" | ">>" | "<" | "<<"; quoted?: boolean }
export interface Simple {
  toks: Tok[];
  heredocBodies: string[];
  /** Code inside `$(…)` or backticks that the tokenizer kept inside a word (double quotes, heredoc text). */
  subs: string[];
  hereStrings: string[];
  /** Heredoc body spans in the original command, and whether the delimiter was quoted (no expansion). */
  heredocs: Array<{ quoted: boolean; start: number; end: number }>;
  /** The command's stdout feeds a pipe. */
  pipedOut: boolean;
  /**
   * Subshell boundaries crossed just before this command, in order: `(` for a subshell, `$(`,
   * a backtick or a process substitution opening, `)` for one closing. A case pattern's `)` and
   * an arithmetic `$((` read the same way; the directory model treats every `)` conservatively.
   */
  scope: Array<"(" | ")">;
  /** The command may run in a forked shell: a pipeline member or a background job (`&`). */
  forked: boolean;
  /**
   * The command may not run at all: it follows `&&` or `||`. A cd here adds
   * directory candidates and removes none, so a skipped `false && cd /tmp` cannot move where later writes are judged.
   */
  conditional?: boolean;
  /**
   * The command is text inside a comment (S006/S007, 2026-10-15): an unquoted `#` that starts a word runs to the
   * end of its line, and the shell discards it. The comment's text is still read as its own line of commands, so
   * the guards that refuse over-detect, but never as arguments of the command it follows, and its quotes and
   * substitutions end at the newline. The directory model treats a cd here as one that may be skipped.
   */
  commented?: boolean;
}

/** The inner text of every `$(…)` and backtick span in `text`. */
export function substitutions(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")" && --depth === 0) break;
      }
      out.push(text.slice(i + 2, j));
      i = j;
    } else if (text[i] === "`") {
      const j = text.indexOf("`", i + 1);
      const end = j === -1 ? text.length : j;
      out.push(text.slice(i + 1, end));
      i = end;
    }
  }
  return out;
}

/** Token left where an unquoted `$(…)` or backtick substitution starts a word. */
const SUBST_MARK = "$(";

/**
 * Lines with a comment whose text has shell meaning (S006 final round 2, tightening only). The comment reading is
 * right: the shell discards the text. But the guard before it read that text as words, so a `|`, `&`, quote, `(`,
 * backslash or `<<` inside a comment forked, scoped or swallowed a nearby cd and kept the earlier directory as a
 * candidate (`cd /tmp # |<nl>echo x > .git/config` was refused). On such a line no cd removes a directory: each one
 * adds candidates, so nothing the old reading refused is allowed. A comment of plain words changes nothing.
 */
const SHELL_TEXT_COMMENTS = new WeakSet<Simple[]>();
const PLAIN_COMMENT = /^[A-Za-z0-9\s.,:_\/@+=%~^?!*[\]#{}-]*$/;
/** True when `segs` (one parseShell result) came from a line with a comment that holds shell text. */
export function commentHoldsShellText(segs: Simple[]): boolean { return SHELL_TEXT_COMMENTS.has(segs); }

export function parseShell(cmd: string): Simple[] {
  const segs: Simple[] = [];
  const fresh = (): Simple => ({ toks: [], heredocBodies: [], subs: [], hereStrings: [], heredocs: [], pipedOut: false, scope: [], forked: false });
  let cur = fresh();
  let word = "";
  let hasWord = false;
  let wordQuoted = false;
  const pendingHeredocs: Array<{ delim: string; quoted: boolean; into: Simple }> = [];
  let expectHeredocDelim = false;
  let expectHereString = false;
  let inBacktick = false;
  let pendingScope: Array<"(" | ")"> = []; // boundaries seen since the last command, carried to the next one
  let pipeIn = false; // the next command reads a pipe

  const flushWord = () => {
    if (!hasWord) return;
    if (expectHereString) {
      cur.hereStrings.push(word);
      expectHereString = false;
    } else {
      if (expectHeredocDelim) {
        pendingHeredocs.push({ delim: word.replace(/^-/, ""), quoted: wordQuoted, into: cur });
        expectHeredocDelim = false;
      }
      if (word !== "$") cur.toks.push(wordQuoted ? { text: word, quoted: true } : { text: word });
    }
    word = ""; hasWord = false; wordQuoted = false;
  };
  const endSeg = () => {
    flushWord();
    // An empty segment (`&& (`, `&&\n`) passes its may-not-run flag on to the next real command.
    let carry = false;
    if (cur.toks.length || cur.hereStrings.length || cur.subs.length) {
      cur.scope = pendingScope;
      pendingScope = [];
      if (pipeIn) { cur.forked = true; pipeIn = false; }
      segs.push(cur);
    } else carry = cur.conditional === true;
    cur = fresh();
    if (carry) cur.conditional = true;
  };
  const pushOp = (op: Tok["op"]) => {
    flushWord();
    cur.toks.push({ text: op!, op });
  };

  const n = cmd.length;
  for (let i = 0; i < n; i++) {
    const c = cmd[i]!;
    if (c === "\\") { // outside quotes: next char is literal (line continuation vanishes)
      if (cmd[i + 1] === "\n") { i++; continue; }
      word += cmd[i + 1] ?? ""; hasWord = true; wordQuoted = true; i++; continue;
    }
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j === -1 ? n : j;
      word += cmd.slice(i + 1, end); hasWord = true; wordQuoted = true; i = end; continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = "";
      for (; j < n && cmd[j] !== '"'; j++) {
        if (cmd[j] === "\\" && j + 1 < n) { buf += cmd[j + 1]; j++; } else buf += cmd[j];
      }
      cur.subs.push(...substitutions(buf)); // "$(…)" and "`…`" still run inside double quotes
      word += buf; hasWord = true; wordQuoted = true; i = j; continue;
    }
    if (c === "\n") {
      endSeg();
      if (pendingHeredocs.length) {
        // Consume heredoc bodies line by line until each delimiter line.
        for (const h of pendingHeredocs) {
          const body: string[] = [];
          const bodyStart = i + 1;
          let start = i + 1;
          let bodyEnd = n;
          while (start <= n) {
            let e = cmd.indexOf("\n", start);
            if (e === -1) e = n;
            const line = cmd.slice(start, e);
            if (line.trim() === h.delim) { bodyEnd = start; start = e; break; }
            body.push(line);
            start = e + 1;
            if (e >= n) break;
          }
          const text = body.join("\n");
          h.into.heredocBodies.push(text);
          h.into.heredocs.push({ quoted: h.quoted, start: Math.min(bodyStart, n), end: Math.max(Math.min(bodyEnd, n), Math.min(bodyStart, n)) });
          if (!h.quoted) h.into.subs.push(...substitutions(text)); // an unquoted delimiter expands $(…)
          if (!segs.includes(h.into) && (h.into.heredocBodies.length || h.into.subs.length)) segs.push(h.into);
          i = Math.min(start, n);
        }
        pendingHeredocs.length = 0;
      }
      continue;
    }
    if (c === " " || c === "\t") { flushWord(); continue; }
    if (c === ";" || c === "(" || c === ")" || c === "`") {
      // An unquoted `$(` or opening backtick that starts a word leaves a SUBST_MARK token, so a
      // program named by a substitution (`$(which claude) -p hi`) is visible; its code is the next segment.
      if (c === "(" && word === "$" && cmd[i + 1] !== "(") word = SUBST_MARK;
      else if (c === "`" && !inBacktick && !hasWord) { word = SUBST_MARK; hasWord = true; }
      // A substitution opened mid-word (`pu\`true\`sh`): the shell splices its output into this word,
      // so the word keeps a backtick and reads as computed (2026-10-11 re-attack).
      else if (c === "`" && !inBacktick && hasWord) word += "`";
      const opens = c === "(" || (c === "`" && !inBacktick);
      if (c === "`") inBacktick = !inBacktick;
      endSeg();
      if (c !== ";") pendingScope.push(opens ? "(" : ")");
      continue;
    }
    if (c === "|") {
      const pipe = cmd[i + 1] !== "|"; // `|` and `|&` pipe; `||` does not
      if (pipe) { cur.pipedOut = true; cur.forked = true; }
      endSeg(); if (pipe) pipeIn = true;
      if (!pipe) cur.conditional = true; // the command after `||` may never run
      if (cmd[i + 1] === "|" || cmd[i + 1] === "&") i++; continue;
    }
    if (c === "&") {
      if (cmd[i + 1] === ">") { // &> / &>> redirect both streams
        i++; const app = cmd[i + 1] === ">"; if (app) i++;
        pushOp(app ? ">>" : ">"); continue;
      }
      if (cmd[i + 1] !== "&") cur.forked = true; // a lone `&` runs the command as a background job
      const andAnd = cmd[i + 1] === "&";
      endSeg(); if (andAnd) { i++; cur.conditional = true; } // the command after `&&` may never run
      continue;
    }
    if (c === ">") {
      if (hasWord && /^\d+$/.test(word)) { word = ""; hasWord = false; } // 2> fd prefix
      const app = cmd[i + 1] === ">";
      if (app) i++;
      if (cmd[i + 1] === "|") i++;
      if (cmd[i + 1] === "&") { // >&2 / 2>&1 fd duplication: no file target
        i++; while (/[0-9-]/.test(cmd[i + 1] ?? "")) i++;
        flushWord(); continue;
      }
      pushOp(app ? ">>" : ">"); continue;
    }
    if (c === "<") {
      if (cmd[i + 1] === "<" && cmd[i + 2] === "<") { i += 2; flushWord(); expectHereString = true; continue; }
      if (cmd[i + 1] === "<") {
        i++; if (cmd[i + 1] === "-") i++;
        pushOp("<<"); expectHeredocDelim = true; continue;
      }
      pushOp("<"); continue;
    }
    // A `#` that starts a word starts a comment (S006/S007, 2026-10-15), which the shell discards up to the
    // newline. The command it interrupts (`cd x # note`) ends here and still runs, without the comment's words
    // (`plutil -extract K xml1 f # -o -` has no -o). Quotes, `$(` and backticks inside the comment are inert,
    // so they cannot swallow the next line (`true # '<nl>echo > .git/config`). The comment's text is parsed
    // as its own line and kept, marked, so a guard that refuses still sees what it names. Inside backticks
    // the old word reading stands: their closing tick may sit on the same line.
    // A shell with comments off (`shopt -u interactive_comments`, zsh's interactive default) reads `#` as a word
    // and hands it and the words after it to the command (closing pass, S006/S007 parity): `rm -- # .git/config`
    // removes .git/config there. Which reading runs cannot be known from the text, so both are kept: the command
    // also appears once more, marked, with the comment's first command's words as its arguments, as HEAD read it.
    if (c === "#" && !hasWord && !inBacktick) {
      const before = segs.length;
      endSeg();
      const head = segs.length > before ? segs[segs.length - 1]! : null; // the command the comment interrupts
      let e = cmd.indexOf("\n", i);
      if (e === -1) e = n;
      const text = cmd.slice(i + 1, e);
      if (!PLAIN_COMMENT.test(text)) SHELL_TEXT_COMMENTS.add(segs);
      const inComment = parseShell(text);
      if (head && inComment.length && !/^\s*[;|&()`]/.test(text)) {
        const first = inComment[0]!;
        const glued = !/^\s/.test(text) && first.toks.length > 0 && !first.toks[0]!.op; // `#word` is one word
        const words: Tok[] = glued ? [{ ...first.toks[0]!, text: `#${first.toks[0]!.text}` }, ...first.toks.slice(1)] : [{ text: "#" }, ...first.toks];
        segs.push({ ...head, toks: [...head.toks, ...words], subs: [...head.subs, ...first.subs], hereStrings: [...head.hereStrings, ...first.hereStrings], commented: true });
      }
      for (const s of inComment) { s.commented = true; segs.push(s); }
      i = e - 1; // the newline itself ends the line as usual (heredoc bodies start after it)
      continue;
    }
    word += c; hasWord = true;
  }
  endSeg();
  return segs;
}
