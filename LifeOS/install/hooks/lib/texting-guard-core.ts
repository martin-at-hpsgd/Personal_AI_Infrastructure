/**
 * @version 4.3.2
 * texting-guard-core.ts — pure decision logic for TextingGuard.hook.ts (Relay, the LifeOS text interface).
 *
 * 4.3.0 (Relay ISA F22, ISC-330): a mail read aimed at a login, verification or one-time code asks first (CONFIRM)
 * where it would have run unasked, and is never a locked-tier read; every other mail read runs as before. Tightens only.
 *
 * 4.2.0 (Relay ISA F16, from the 4.1.1 review): a settings write that changes hook registration, a write to the Relay
 * launchd plist, and a launchctl stop of the Relay job are SENSITIVE; the injection tripwire normalizes text first.
 *
 * 4.0.0: TERMINAL PARITY. A text from the principal's number runs under exactly what governs the terminal —
 * settings.json permissions, auto mode, and every terminal hook (TaintGuard included) — and this guard adds only:
 *   SENSITIVE  the text channel's own auth surface (bridge, allowlist config/state, this guard) and shapes that
 *              leave the guarded process (nested `claude`, LIFEOS_TEXTING_* blanking, isolated sub-agents).
 *   CONFIRM    the terminal's own ask-first classes (deploy, delete, money, publish/push, sends to other people),
 *              answered in-thread.
 * Removed as terminal-parity violations: the secret-path list (.env, dotfiles, transcripts — settings.json governs),
 * doctrine/skills write refusals, host egress refusals, and the escape/service/network/infra/secrets holds.
 * The historical notes below describe earlier versions.
 *
 * Relay runs the real DA over iMessage with the terminal's full tool surface. This module is the
 * deterministic half of the security model the principal ratified on 2026-09-04 (Relay ISA § Articulation):
 *
 *   WHO        the sender allowlist — bridge-side, before any model runs (not in this file).
 *   UNLOCKED   the covert countersign has been cleared this session (or within the idle window).
 *              An unlocked session IS the terminal: every tool runs. No read/write tiering of ordinary work.
 *   LOCKED     a new session, or one idle past the window. Only NATIVE reads run — Read, Grep, Glob,
 *              WebSearch, and WebFetch to hosts we own. Everything else is HELD: denied with an
 *              instruction to answer what it can and end on one natural check-in ("Want me to pull that up?").
 *              Bash while locked is never parsed for read-ness; it is held and offered — except the 3.3.0
 *              closed-grammar allowlist of exact read-only CLI invocations (calendar/mail/contacts reads), see lockedCliRead().
 *
 * Two constraints ride EVERY tier, because they are about where data and damage go, not who is asking:
 *   SENSITIVE  secrets and credentials (LifeOS and the usual dotfiles), the guard's own state, the guard's
 *              import closure, the bridge, hooks, settings, launchd, SSH, Keychain, harness transcripts:
 *              never touched. Doctrine files (CLAUDE.md, OPERATIONAL_PREFERENCES, the system prompt, identity):
 *              reachable only through the native Read/Grep/Glob tools — any Bash mention or Write/Edit is refused.
 *              Shell shapes that could blank or bypass the guard (a nested `claude`, LIFEOS_TEXTING_* assignment,
 *              `unset`, `env -i/-u`) are refused outright.
 *   EGRESS     sends name only the principal's own channels; shell network reach never leaves owned hosts.
 *
 * One gate mirrors the terminal's "confirm before irreversible" (unlocked only):
 *   CONFIRM    deploy / delete / send / spend / publish / service / secrets / interpreter-escape shapes are held
 *              for an in-thread confirmation (CONFIRM) or the out-of-band tap (CONFIRM_TAP when configured).
 *              An approved EXACT fingerprint allows that one call once.
 *
 * 3.4.0: Unlocked sends to address-book contacts require confirmation of the exact call,
 * with one-shot approval consumption. Unknown recipients and non-owned network destinations
 * remain EGRESS refusals; sensitive surfaces and the locked tier are unchanged. The guard
 * imports only node builtins, including for resolving the locked CLI overlay path.
 *
 * 3.1.0 (2026-09-04, Max review of 3.0.0): this module now imports ONLY node builtins — the owned-host
 * oracle is inlined — so the guard's import closure is `hooks/` plus the runtime, and every file in that
 * closure, the bridge, and the countersign tool are SENSITIVE. State-dir matching goes through realpathSync
 * (the MEMORY symlink's real path was reachable), Grep/Glob refuse ancestors of secret dirs, the secret set
 * covers the standard credential dotfiles and harness transcripts, the countersign hash is salted, and a
 * challenge closes after a bounded number of misses.
 * 3.0.0 (2026-09-04): the 2.x read/write shell classifier is deleted — deciding whether an arbitrary shell
 * string "is a read" cannot be made sound, and it refused the principal's legitimate reads.
 * Nothing personal lives here: numbers, mailboxes and the countersign hash come from the bridge's 0600 config.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type DenyKind = "LOCKED" | "SENSITIVE" | "EGRESS" | "CONFIRM" | "CONFIRM_TAP";

export interface OwnChannels { numbers: string[]; emails: string[]; discordUserIds: string[] }
export interface GuardConfig {
  ownChannels: OwnChannels;
  contactChannels?: { numbers: string[]; emails: string[] };
  /** Relay F36 ISC-432: Ring 1 handles (the bridge's chatFrom, rebuilt from the ring files by Rings.ts relay --apply) */
  trustedHandles?: string[];
  /** ms of inactivity after which an unlocked session re-locks (default 2h) */
  unlockIdleMs: number;
  /** ms a pending challenge (locked hold) stays answerable by the countersign (default 15 min) */
  challengeTtlMs: number;
  /** ms a pending in-thread confirm stays answerable by a short yes (default 10 min) */
  confirmTtlMs: number;
  countersignSha256?: string;
  /** random salt hashed in front of the normalized phrase; absent on pre-3.1 configs (plain sha256) */
  countersignSalt?: string;
  /** the bridge's 0600 state dir; always sensitive (set by the hook from LIFEOS_TEXTING_STATE) */
  stateDir?: string;
}
export interface SenderAuth {
  unlockedUntil?: string;
  challengePending?: { ts: string; fingerprint: string; summary?: string; attempts?: number };
  confirmPending?: { ts: string; fingerprint: string; tool: string; summary: string };
  approved?: { fingerprint: string; until: string };
  lastSeen?: string;
}
export type AuthState = Record<string, SenderAuth>;

export interface Decision {
  allow: boolean;
  kind?: DenyKind;
  reason: string;
  message?: string;
  /** set on an allow that spent a one-shot approval; the hook clears auth.approved */
  consumeApproval?: boolean;
}

export const DEFAULT_CONFIG: GuardConfig = {
  ownChannels: { numbers: [], emails: [], discordUserIds: [] },
  unlockIdleMs: 2 * 60 * 60_000,
  challengeTtlMs: 15 * 60_000,
  confirmTtlMs: 10 * 60_000,
};
/** Non-matching texts a challenge survives before it closes (a fresh hold reopens it). Bounds guessing. */
export const MAX_COUNTERSIGN_MISSES = 8;

// ── hashing / normalization (shared with the bridge) ────────────────────
export function normalizePhrase(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]/g, ""); }
export function sha256(s: string): string { return createHash("sha256").update(s).digest("hex"); }
/** The stored form of a phrase: sha256(salt + normalized). Salt-less for pre-3.1 configs. */
export function countersignHash(phrase: string, salt?: string): string { return sha256(`${salt ?? ""}${normalizePhrase(phrase)}`); }
/** Salient-input fingerprint: Bash binds to the command alone (a re-issued call with a new `description`
 *  is the same action); file tools bind to path + content; WebFetch to the URL. */
/** The one-shot marker for one approval GRANT: the call's fingerprint plus that grant's expiry. A replayed grant
 *  (a sibling's stale texting-auth.json write) maps to the same marker and is refused; a fresh yes on the same
 *  command is a new grant with its own marker (Relay ISA ISC-65, ISC-202). 12 hex keeps sweepApprovalMarkers' match. */
export function approvalMarker(fp: string, until: string): string {
  return `approved-${sha256(`${fp}\n${until}`).slice(0, 12)}.used`;
}
export function fingerprint(toolName: string, toolInput: unknown): string {
  const ti = (toolInput ?? {}) as Record<string, unknown>;
  let salient: unknown;
  switch (toolName) {
    case "Bash": salient = ti.command; break;
    case "Write": salient = [ti.file_path, ti.content]; break;
    case "Edit": salient = [ti.file_path, ti.old_string, ti.new_string, ti.replace_all ?? false]; break;
    case "WebFetch": salient = ti.url; break;
    default: salient = ti;
  }
  return sha256(`${toolName}\n${JSON.stringify(salient ?? null)}`).slice(0, 12);
}
/** A one-line human summary of a tool call, for the check-in / confirm continuation and the log. */
export function summarize(toolName: string, toolInput: unknown): string {
  const ti = (toolInput ?? {}) as Record<string, unknown>;
  if (toolName === "Bash") return String(ti.command ?? "");
  const target = ti.file_path ?? ti.notebook_path ?? ti.url ?? ti.path ?? ti.pattern ?? ti.query ?? "";
  return `${toolName} ${String(target)}`.trim();
}

// ── paths ────────────────────────────────────────────────────────────────
const HOME = () => process.env.HOME ?? homedir();
/** LifeOS data dir. Read from env so tests are hermetic; the hook's env comes from the bridge, not from a Bash call. */
function lifeosDir(): string { return process.env.LIFEOS_DIR || join(HOME(), ".claude", "LIFEOS"); }
function expandHome(p: string): string { return p.replace(/^~(?=\/|$)/, HOME()).replace(/^\$HOME(?=\/|$)/, HOME()); }
/** The install's config root, with the shared resolver's precedence (LIFEOS/TOOLS/Paths.ts getClaudeDir):
 *  plugin root, CLAUDE_CONFIG_DIR, dirname(LIFEOS_SKILLS_DIR), then ~/.claude. Inlined, not imported: this
 *  module's import closure is node builtins only (3.1.0). Two users: the locked-CLI overlay loader (whose
 *  precedence this is, unchanged) and secretDirs, where it is ADDED to the HOME-profile literal on the deny
 *  side, never swapped for it. The LOCKED_CLIS path match and the owned-host list keep the literal. */
export function claudeDir(): string {
  const expand = (path: string) => path.replace(/^(?:\$HOME|\$\{HOME\}|~)(?=\/|$)/, homedir());
  const configured = process.env.CLAUDE_PLUGIN_ROOT || process.env.CLAUDE_CONFIG_DIR;
  if (configured) return expand(configured);
  if (process.env.LIFEOS_SKILLS_DIR) return dirname(expand(process.env.LIFEOS_SKILLS_DIR));
  return join(homedir(), ".claude");
}
/** realpath when the operand exists; the empty string stays empty (realpathSync("") would resolve to cwd). */
function realOrSelf(p: string): string { if (!p) return p; try { return realpathSync(p); } catch { return p; } }
function stripSlash(p: string): string { return p.replace(/\/+$/, ""); }

// ── owned hosts (inlined from taint.ts so the guard imports nothing outside node builtins) ──
const LOCAL_HOST_RE =
  /^(?:localhost|127\.(?:\d{1,3}\.){2}\d{1,3}|0\.0\.0\.0|\[::1\]|::1|10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|(?:[A-Za-z0-9-]+\.)+(?:lan|local|internal|home))$/i;
let ownedCache: { dir: string; set: Set<string> } | null = null;
/** Domains we own: the Workflows infra inventory plus USER/SECURITY/owned-hosts.json. Both files are SENSITIVE below. */
export function ownedDomains(): Set<string> {
  const dir = lifeosDir();
  if (ownedCache && ownedCache.dir === dir) return ownedCache.set;
  const out = new Set<string>();
  try {
    const inv = join(dir, "USER", "CUSTOMIZATIONS", "WORKFLOWS", "Shared", "infra-inventory.ts");
    if (existsSync(inv)) for (const m of readFileSync(inv, "utf8").matchAll(/domain:\s*"([^"]+)"/g)) out.add(m[1]!.toLowerCase());
  } catch { /* no inventory */ }
  try {
    const extra = join(dir, "USER", "SECURITY", "owned-hosts.json");
    if (existsSync(extra)) { const arr = JSON.parse(readFileSync(extra, "utf8")); if (Array.isArray(arr)) for (const d of arr) if (typeof d === "string") out.add(d.toLowerCase()); }
  } catch { /* no extra list */ }
  ownedCache = { dir, set: out };
  return out;
}
export function isOwnedHost(hostWithPort: string): boolean {
  const host = hostWithPort.replace(/:\d+$/, "").toLowerCase();
  if (!host) return false;
  if (LOCAL_HOST_RE.test(host)) return true;
  for (const d of ownedDomains()) if (host === d || host.endsWith(`.${d}`)) return true;
  return false;
}
/** Test seam. */
export function resetOwnedCache(): void { ownedCache = null; }

// ── normalization used by every Bash check ──────────────────────────────
/** Collapse quoting/bracket/backslash obfuscation so `.en[v]`, `.e"nv`, `r\m` read as their plain form. Text level, as
 *  in the live guard; normalForms() adds the walker's word-level reading beside it. */
export function normalizeCommand(command: string): string {
  return command
    .replace(/\\\r?\n/g, " ") // a line continuation is one command
    .replace(/\[(.)\]/g, "$1")
    .replace(/\\(.)/g, "$1")
    .replace(/(['"])(.*?)\1/g, "$2")
    .replace(/(\w)['"]+(\w)/g, "$1$2");
}

// ── the shell walker: the one reader of what a Bash line runs ─────────────
// P1 batch 2, fix round 2 (S030, S031). Round 1 added four readers beside each other (a text pre-pass that decoded
// ANSI-C quoting everywhere, a lexer, a shell-body extractor that scanned every word, and a regex scan for computed
// program names), and the review found each disagreeing with bash and with the others: an unquoted heredoc decoded as
// if it were `$'…'`, `bash -O extglob -c` lost its body, `eval --` kept the `--`, a quoted substitution lost its
// command boundaries, `A='x y'` lost its word boundary in a rendering, and an outer `--to` stood in for an inner send's
// recipient. They are replaced by one walker. walkShell() lexes a line with bash's quoting rules (single quotes and
// backslashes literal, double quotes keep expansions, `$'…'` decoded only where bash decodes it, heredoc bodies read
// only for their substitutions), peels assignments and wrappers to find each program word (both readings of a wrapper
// option it does not know), and descends into every body the line runs: substitutions, a shell's `-c` operand (the
// first non-option word, past option operands), `eval` (with `--` dropped), `env -S`, `find -exec`, and the stdin
// text a line feeds a shell it starts. Every check reads its result: the disarm check reads program words, the escape
// hold reads computed program words and opaque lines, and the send check reads each command's own arguments.
// This module imports node builtins only (Relay ISC-34: the guard's import closure is SENSITIVE), so the walker lives
// here rather than reusing hooks/lib/shell-commands.ts, whose closure reaches SubagentShipGuard.
/** Stand-in for a word part the shell computes at run time (a substitution or a parameter expansion). */
const COMPUTED_MARK = "\u0001";
const ANSI_C_SIMPLE: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
/** The bytes bash passes for the body of a `$'…'` word. An unknown escape keeps its backslash, as bash does, and
 *  the string ends at its first NUL (`$'claude\0x'` runs `claude`). */
function ansiCBody(body: string): string {
  const decoded = body.replace(/\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3})|c([\s\S])|([\s\S]))/g,
    (m, x?: string, u?: string, U?: string, o?: string, c?: string, ch?: string) => {
      if (x) return String.fromCharCode(parseInt(x, 16));
      if (u) return String.fromCodePoint(parseInt(u, 16));
      if (U) { const n = parseInt(U, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : ""; }
      if (o) return String.fromCharCode(parseInt(o, 8) & 0xff);
      if (c) return String.fromCharCode(c.charCodeAt(0) & 0x1f);
      return ANSI_C_SIMPLE[ch ?? ""] ?? m;
    });
  const nul = decoded.indexOf("\0");
  return nul < 0 ? decoded : decoded.slice(0, nul);
}

/**
 * A word of a simple command. `text` is its value with quotes removed and each computed part as COMPUTED_MARK;
 * `computed` says some part is computed; `tail` says a computed part (or a glob) follows the word's last literal `/`,
 * so the file name it names is unknown; `split` says an unquoted expansion or glob can turn it into several words.
 */
interface LexWord { text: string; computed: boolean; tail: boolean; split: boolean; redirect?: boolean; quoted?: boolean; fd?: string }
/** One line lexed: its simple commands, the substitution bodies it runs, and the stdin texts it spells (heredoc bodies
 *  and here-strings), which run as code only when the line feeds them to a shell. */
interface LexLine { cmds: LexWord[][]; subs: string[]; stdinTexts: string[]; writes: string[] }

/** The body of a `$(…)` whose `(` is at `open` in `s`, and the index after its `)`; -1 when unbalanced. */
function readParen(s: string, open: number): [string, number] {
  let d = 0;
  const delims: Array<{ delim: string; strip: boolean }> = [];
  for (let j = open; j < s.length; j++) {
    const ch = s[j]!;
    // A heredoc inside the substitution: its body is skipped whole, so an apostrophe in it is text, not a quote.
    const hd = s[j - 1] !== "<" && s[j + 2] !== "<" ? /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([\w.-]+))/.exec(s.slice(j)) : null;
    if (hd) { delims.push({ delim: hd[2] ?? hd[3] ?? hd[4] ?? "", strip: hd[1] === "-" }); j += hd[0].length - 1; continue; }
    if (ch === "\n" && delims.length) {
      let k = j + 1;
      for (const h of delims.splice(0)) {
        for (;;) {
          if (k >= s.length) return ["", -1];
          const e = s.indexOf("\n", k);
          const line = s.slice(k, e < 0 ? s.length : e);
          k = e < 0 ? s.length : e + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        }
      }
      j = k - 1;
      continue;
    }
    if (ch === "\\") { j++; continue; }
    if (ch === "'") { const k = s.indexOf("'", j + 1); if (k < 0) return ["", -1]; j = k; continue; }
    if (ch === '"') { let k = j + 1; while (k < s.length && s[k] !== '"') k += s[k] === "\\" ? 2 : 1; if (k >= s.length) return ["", -1]; j = k; continue; }
    if (ch === "(") d++;
    else if (ch === ")" && --d === 0) return [s.slice(open + 1, j), j + 1];
  }
  return ["", -1];
}
function readTick(s: string, open: number): [string, number] {
  for (let j = open + 1; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === "`") return [s.slice(open + 1, j), j + 1];
  }
  return ["", -1];
}
const subAt = (s: string, i: number): [string, number] => (s[i] === "`" ? readTick(s, i) : readParen(s, i + 1));
/** Index after a parameter expansion starting with `$` at `i` (`$x`, `${…}`, `$1`, `$@`), or -1 when it is not one.
 *  Final round (S031): the word of a `${x:-…}`, `${x:=…}`, `${x/…/…}` operator runs its substitutions when bash
 *  expands it (`"${x:-$(claude -p hi)}"`), so each `$(…)` or backtick body inside the braces is pushed to `subs`
 *  and skipped whole (its own braces never end the expansion). Quotes inside the braces are not honoured: a body
 *  that bash would leave literal is read as code too, which only adds commands to judge. */
function paramEnd(s: string, i: number, subs?: string[]): number {
  const n = s[i + 1] ?? "";
  if (n === "{") {
    let d = 0;
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === "\\") { j++; continue; }
      if ((s[j] === "$" && s[j + 1] === "(") || s[j] === "`") {
        const [body, next] = subAt(s, j);
        if (next < 0) return -2; // an unterminated substitution: the caller treats the line as unreadable
        subs?.push(body);
        j = next - 1;
        continue;
      }
      if (s[j] === "{") d++;
      else if (s[j] === "}" && --d === 0) return j + 1;
    }
    return s.length;
  }
  if (/[@*#?$!0-9-]/.test(n)) return i + 2;
  const m = /^[A-Za-z_]\w*/.exec(s.slice(i + 1));
  return m ? i + 1 + m[0].length : -1;
}
/** Characters that end an unquoted word as an operator or separator. */
const WORD_END = /[\s;&|()<>]/;

/** Lex one command line with bash's quoting. Null when a quote or substitution is unterminated. */
function lexLine(src: string): LexLine | null {
  const cmds: LexWord[][] = [];
  const subs: string[] = [];
  const stdinTexts: string[] = [];
  /** Files the line's output redirects write (`> f`, `>> f`, `&> f`). */
  const writes: string[] = [];
  let cur: LexWord[] = [];
  let w = "", has = false, comp = false, tail = false, split = false, quoted = false;
  /** Heredocs opened on the current line; their bodies start after its newline. */
  const pending: Array<{ delim: string; quoted: boolean; strip: boolean }> = [];
  /** `case … in` patterns: the words before `)` are patterns, never a command (`*.ts) bun x;;`). */
  let caseLevel = 0, casePat = false;
  const lit = (s: string) => { w += s; has = true; if (s.includes("/")) tail = false; };
  const computedPart = (splittable: boolean) => { w += COMPUTED_MARK; has = true; comp = true; tail = true; if (splittable) split = true; };
  const glob = (s: string) => { w += s; has = true; comp = true; tail = true; split = true; };
  const endWord = () => {
    if (has) {
      const prev = cur[cur.length - 1];
      if (prev?.redirect && /^<<-?$/.test(prev.text)) pending.push({ delim: w, quoted, strip: prev.text === "<<-" });
      if (prev?.redirect && prev.text === "<<<") stdinTexts.push(w);
      if (prev?.redirect && prev.text.includes(">")) writes.push(w);
      cur.push({ text: w, computed: comp, tail, split, quoted });
      if (!casePat && cur.length === 3 && w === "in" && !quoted && cur[0]!.text === "case" && !cur[0]!.quoted && !cur[0]!.computed) { cmds.push(cur); cur = []; caseLevel++; casePat = true; }
      else if (caseLevel > 0 && cur.length === 1 && w === "esac" && !quoted) { cur = []; caseLevel--; casePat = false; }
    }
    w = ""; has = false; comp = false; tail = false; split = false; quoted = false;
  };
  const endCmd = () => { endWord(); if (cur.length && !casePat) cmds.push(cur); cur = []; };
  const substitution = (i: number, splittable: boolean): number => {
    const [body, next] = subAt(src, i);
    if (next < 0) return -1;
    subs.push(body); computedPart(splittable);
    return next;
  };
  /** Consume the bodies of the heredocs opened on the line ending at `nl`; returns the index after the last one.
   *  An unquoted delimiter leaves the body's substitutions live; nothing else in it is read as code here. */
  const heredocBodies = (nl: number): number | null => {
    let i = nl + 1;
    for (const h of pending.splice(0)) {
      const lines: string[] = [];
      for (;;) {
        if (i >= src.length) break;
        const e = src.indexOf("\n", i);
        const line = src.slice(i, e < 0 ? src.length : e);
        i = e < 0 ? src.length : e + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        lines.push(line);
      }
      const body = lines.join("\n");
      stdinTexts.push(body);
      if (h.quoted) continue;
      for (let j = 0; j < body.length; j++) {
        if (body[j] === "\\") { j++; continue; }
        if ((body[j] === "$" && body[j + 1] === "(") || body[j] === "`") {
          const [inner, next] = subAt(body, j);
          if (next < 0) return null;
          subs.push(inner); j = next - 1;
        }
      }
    }
    return i;
  };
  for (let i = 0; i < src.length;) {
    const c = src[i]!;
    if (c === "#" && !has) { const e = src.indexOf("\n", i); i = e < 0 ? src.length : e; continue; }
    if (c === "\n") {
      if (casePat) { endWord(); i++; continue; }
      endCmd();
      if (pending.length) { const next = heredocBodies(i); if (next === null) return null; i = next; } else i++;
      continue;
    }
    if (c === "\\") { if (src[i + 1] === undefined) lit("\\"); else if (src[i + 1] !== "\n") { lit(src[i + 1]!); quoted = true; } i += 2; continue; }
    if (c === COMPUTED_MARK) { computedPart(true); i++; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); if (j < 0) return null; lit(src.slice(i + 1, j)); quoted = true; i = j + 1; continue; }
    if (c === "$" && src[i + 1] === "'") {
      const m = /^\$'((?:[^'\\]|\\[\s\S])*)'/.exec(src.slice(i));
      if (!m) return null;
      lit(ansiCBody(m[1]!)); quoted = true; i += m[0].length; continue;
    }
    if (c === '"' || (c === "$" && src[i + 1] === '"')) {
      has = true; quoted = true;
      let j = i + (c === "$" ? 2 : 1);
      for (; j < src.length && src[j] !== '"';) {
        const d = src[j]!;
        if (d === "\\") { if (/[$`"\\\n]/.test(src[j + 1] ?? "")) { if (src[j + 1] !== "\n") lit(src[j + 1]!); j += 2; } else { lit("\\"); j++; } continue; }
        if ((d === "$" && src[j + 1] === "(") || d === "`") { const next = substitution(j, false); if (next < 0) return null; j = next; continue; }
        if (d === "$") { const e = paramEnd(src, j, subs); if (e === -2) return null; if (e > 0) { computedPart(false); j = e; continue; } }
        if (d === COMPUTED_MARK) { computedPart(false); j++; continue; }
        lit(d); j++;
      }
      if (j >= src.length) return null;
      i = j + 1; continue;
    }
    if ((c === "$" && src[i + 1] === "(") || c === "`") { const next = substitution(i, true); if (next < 0) return null; i = next; continue; }
    if (c === "$") { const e = paramEnd(src, i, subs); if (e === -2) return null; if (e > 0) { computedPart(true); i = e; continue; } }
    if (c === "*" || c === "?") { glob(c); i++; continue; }
    if (c === "[" || c === "{") {
      // `[…]` is a glob and `{a,b}` / `{1..3}` a brace expansion only when closed within the word.
      let j = i + 1;
      while (j < src.length && !WORD_END.test(src[j]!) && src[j] !== (c === "[" ? "]" : "}")) j++;
      const inner = src.slice(i + 1, j);
      if (src[j] === (c === "[" ? "]" : "}") && (c === "[" ? inner.length > 0 : /,|\.\./.test(inner))) { glob(src.slice(i, j + 1)); i = j + 1; continue; }
      lit(c); i++; continue;
    }
    if (casePat && c === "|") { endWord(); i++; continue; }
    if (casePat && c === "(" && !has && !cur.length) { i++; continue; }
    if (casePat && c === ")") { endWord(); cur = []; casePat = false; i++; continue; }
    if (c === ";" && caseLevel > 0 && (src[i + 1] === ";" || src[i + 1] === "&")) { endCmd(); casePat = true; i += src[i + 1] === ";" && src[i + 2] === "&" ? 3 : 2; continue; }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") { endCmd(); i++; continue; }
    if (/\s/.test(c)) { endWord(); i++; continue; }
    if (c === "<" || c === ">") {
      // `2>file` and `<<<text`: the descriptor digits belong to the operator, never a word of their own.
      // The digits are kept on the operator as `fd` (closing pass, S031 parity): `bash 3</dev/null` still reads stdin.
      const fd = /^\d+$/.test(w) && has && !comp && !quoted ? w : "";
      if (fd) { w = ""; has = false; } else endWord();
      let j = i; while (j < src.length && /[<>&|]/.test(src[j]!)) j++;
      if (src.slice(i, j) === "<<" && src[j] === "-") j++;
      cur.push({ text: src.slice(i, j), computed: false, tail: false, split: false, redirect: true, fd });
      i = j; continue;
    }
    lit(c); i++;
  }
  endCmd();
  if (caseLevel > 0) return null; // an unterminated case: bash runs none of it, and the walker does not guess
  return { cmds, subs, stdinTexts, writes };
}
/** A command's words with redirect operators and their targets removed: the program and its arguments. */
function argWords(cmd: LexWord[]): LexWord[] {
  const out: LexWord[] = [];
  for (let i = 0; i < cmd.length; i++) { if (cmd[i]!.redirect) { i++; continue; } out.push(cmd[i]!); }
  return out;
}

const SHELL_PROGRAMS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "mksh", "yash", "tcsh", "csh"]);
/** Words that run the command after them, plus the reserved words a command may follow. */
const PEEL_WORDS = new Set(["env", "command", "builtin", "exec", "nohup", "nice", "time", "timeout", "gtimeout", "caffeinate", "stdbuf", "sudo", "doas", "setsid", "xargs", "chronic", "unbuffer", "ionice", "arch", "script", "then", "do", "else", "elif", "if", "while", "until", "!", "{", "rtk", "xcrun", "coproc", "busybox",
  // zsh precommand modifiers (the harness shell is zsh): `noglob claude`, `nocorrect claude`, `- claude`, `repeat 2 claude`
  "noglob", "nocorrect", "-", "repeat"]);
/** Per wrapper: options whose next word is their value, and options known to take none. Any other option is read
 *  both ways, since an option the guard does not know may or may not take the next word. */
const PEEL_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--host", "--prompt", "--chdir"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "-P", "--unset", "--chdir"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  gtimeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p", "-t"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  caffeinate: new Set(["-t", "-w"]),
  xargs: new Set(["-I", "-J", "-L", "-n", "-P", "-s", "-E", "-d", "-a", "-R", "-S", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"]),
  xcrun: new Set(["--sdk", "-sdk", "--toolchain", "-toolchain"]),
  arch: new Set(["-d", "-e"]),
  script: new Set(["-t", "-T", "-F"]),
  exec: new Set(["-a"]),
  time: new Set(["-f", "-o", "--format", "--output"]),
};
const PEEL_NO_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(["-A", "-b", "-E", "-e", "-H", "-i", "-K", "-k", "-l", "-n", "-P", "-S", "-s", "-v", "-B", "-N", "--preserve-env", "--login", "--non-interactive", "--stdin", "--shell", "--background"]),
  env: new Set(["-i", "-0", "-v", "--ignore-environment", "--null"]),
  timeout: new Set(["--foreground", "--preserve-status", "-v", "--verbose", "-f", "-p"]),
  gtimeout: new Set(["--foreground", "--preserve-status", "-v", "--verbose"]),
  xargs: new Set(["-0", "-r", "-t", "-p", "-x", "-o", "--null", "--no-run-if-empty", "--verbose", "--interactive"]),
  caffeinate: new Set(["-d", "-i", "-m", "-s", "-u"]),
  exec: new Set(["-c", "-l"]),
  time: new Set(["-p", "-l", "-v", "--portability", "--verbose"]),
  command: new Set(["-p"]),
  nohup: new Set([]),
  setsid: new Set(["-f", "-w", "--fork", "--wait"]),
  script: new Set(["-a", "-q", "-k", "-d", "-e", "-r", "-p"]),
};
/** A program word's file name, lower-cased (the macOS file system is case-insensitive, so `Claude` runs `claude`),
 *  without zsh's `=` path-lookup prefix (`=claude -p` runs `claude`). */
const progName = (t: string) => t.slice(t.lastIndexOf("/") + 1).toLowerCase().replace(/^=/, "");
/** Shell options whose next word is their operand (`bash -O extglob`, `bash --rcfile f`). */
const SHELL_LONG_VALUE = new Set(["--rcfile", "--init-file"]);

/** One simple command the line runs. */
export interface WalkCommand {
  /** Every argument word, redirects removed. */
  words: LexWord[];
  /** The words that are this command's own arguments: words handed on as code (a `-c` operand, `eval`'s arguments,
   *  an `env -S` string, a `find -exec` command) are judged as their own commands and left out here. */
  own: LexWord[];
  /** Indexes into `words` of every reading of the program word (more than one when a wrapper option is unknown). */
  programs: number[];
  /** Nesting depth: 0 for the line itself. */
  depth: number;
  /** xargs or find supplies more arguments than the text shows. */
  moreArgs: boolean;
}
export interface ShellWalk {
  commands: WalkCommand[];
  /** Every command line read: the line itself and every body it runs. */
  lines: string[];
  /** A quote or substitution is unterminated, or nesting passes WALK_MAX_DEPTH: the line cannot be read. */
  opaque: boolean;
  /** A shell the line starts reads its script from stdin, which the text need not spell. */
  stdinShell: boolean;
  /** Files the line writes (output redirects, tee operands), and the script files it runs (a shell's or source's
   *  file operand, a program word). A file written and run in one line runs text the guard never read. */
  writes: string[];
  runs: string[];
  /** A program word (any reading) has a computed or globbed file name, or a computed word stands where a shell's
   *  option could be: what runs cannot be read from the text. */
  computedProgram: boolean;
}
const WALK_MAX_DEPTH = 6;
/** Readings of a wrapper option explored before the walker gives up and calls the line opaque. */
const WALK_MAX_BRANCHES = 16;

/** The program word index of every reading of `words`, after assignments and wrappers are peeled. */
function programReadings(words: LexWord[]): { programs: number[]; xargs: boolean; envSplit: Array<{ at: number; body: string }>; overflow: boolean } {
  const programs = new Set<number>();
  const envSplit: Array<{ at: number; body: string }> = [];
  let xargs = false, overflow = false, branches = 0;
  const queue: Array<{ i: number; after: string | null; flagsDone: boolean }> = [{ i: 0, after: null, flagsDone: false }];
  while (queue.length) {
    let { i, after, flagsDone } = queue.shift()!;
    for (; i < words.length;) {
      const w = words[i]!, t = w.text;
      if (/^[A-Za-z_]\w*=/.test(t)) { i++; continue; }
      const name = progName(t);
      if (!w.computed && PEEL_WORDS.has(name)) {
        if (name === "command" && /^-[vV]$/.test(words[i + 1]?.text ?? "")) { programs.add(i); break; } // `command -v x` looks x up
        if (name === "xargs") xargs = true;
        after = name; flagsDone = false; i++;
        if (name === "script") { // macOS `script [-q] file cmd…`: the first operand is the typescript file
          while (i < words.length && words[i]!.text.startsWith("-")) i += PEEL_VALUE_FLAGS.script!.has(words[i]!.text) ? 2 : 1;
          i++;
        }
        continue;
      }
      if (after && !flagsDone && !w.computed && /^-/.test(t)) {
        if (t === "--") { flagsDone = true; i++; continue; }
        if (after === "env" && /^(?:-S|--split-string)(?:=|$)|^-S./.test(t)) {
          const attached = t.startsWith("--split-string=") ? t.slice(15) : t.startsWith("-S") && t.length > 2 ? t.slice(2) : null;
          const rest = words.slice(attached === null ? i + 2 : i + 1).map((x) => x.text);
          envSplit.push({ at: i, body: [attached ?? words[i + 1]?.text ?? "", ...rest].join(" ") });
          break;
        }
        if (PEEL_VALUE_FLAGS[after]?.has(t)) { i += 2; continue; }
        if (PEEL_NO_VALUE_FLAGS[after]?.has(t) || /^--[\w-]+=/.test(t)) { i++; continue; }
        if (++branches > WALK_MAX_BRANCHES) { overflow = true; i++; continue; }
        queue.push({ i: i + 2, after, flagsDone });
        i++; continue;
      }
      if (after && /^\d[\w.]*$/.test(t)) { i++; continue; } // `timeout 5 x`, `nice 10 x`
      programs.add(i);
      break;
    }
  }
  return { programs: [...programs].sort((a, b) => a - b), xargs, envSplit, overflow };
}

const walkCache = new Map<string, ShellWalk>();
/** Every simple command a Bash line runs, read with shell semantics. Never throws: an unreadable line is opaque. */
export function walkShell(cmd: string): ShellWalk {
  const hit = walkCache.get(cmd);
  if (hit) return hit;
  const out: ShellWalk = { commands: [], lines: [], opaque: false, stdinShell: false, computedProgram: false, writes: [], runs: [] };
  try {
    visitLine(cmd.replace(/\\\r\n/g, "\\\n"), 0, out);
  } catch {
    out.opaque = true;
  }
  // Final round (S031): `printf '…' > s.sh; bash s.sh` runs a script the same line wrote, whose text is in a printf
  // argument the walker does not read as code. A run whose file name matches a file the line writes is unreadable.
  if (out.runs.some((r) => out.writes.some((w) => maySameFile(w, r, out.runs)))) out.computedProgram = true;
  if (walkCache.size > 64) walkCache.clear();
  walkCache.set(cmd, out);
  return out;
}
/** Programs that can make one path name another file (a link, a move, a copy, a mount) partway through a line. */
const PATH_REBINDERS = new Set(["ln", "link", "mv", "cp", "rsync", "install", "ditto", "mount", "bindfs", "cd", "pushd", "popd"]);
/**
 * Final round 2 (S031): could the file a line writes as `written` be the script it runs as `run`? Same base name is
 * the first test. The two are told apart only when both are literal absolute paths whose physical forms differ
 * (`/tmp/a/run.sh` against `/tmp/b/run.sh`) and the line runs nothing that could rebind a path between the write
 * and the run (`ln -s /tmp/a /tmp/b`). A relative or computed spelling, or a rebinding program, keeps the match.
 */
function maySameFile(written: string, run: string, runs: string[]): boolean {
  const name = progName(run);
  if (!name || progName(written) !== name) return false;
  const literalAbs = (p: string) => p.startsWith("/") && !/[$`*?\[\u0001]/.test(p);
  if (!literalAbs(written) || !literalAbs(run)) return true;
  if (runs.some((r) => PATH_REBINDERS.has(progName(r)))) return true;
  return physicalPath(written) === physicalPath(run);
}
function visitLine(src: string, depth: number, out: ShellWalk): void {
  if (depth > WALK_MAX_DEPTH) { out.opaque = true; return; }
  out.lines.push(src);
  const lex = lexLine(src);
  if (!lex) { out.opaque = true; return; }
  let feedsShell = false;
  out.writes.push(...lex.writes);
  const argvs = lex.cmds.map(argWords);
  argvs.forEach((words, k) => { if (visitArgv(words, depth, false, out, stdinFile(lex.cmds[k]!))) feedsShell = true; });
  for (const body of lex.subs) visitLine(body, depth + 1, out);
  if (!feedsShell) return;
  // The line starts a shell that reads stdin: the text it spells for that stdin (heredocs, here-strings, echo and
  // printf arguments) is code that shell runs, so it is read as command lines too. The hold for a stdin shell stays.
  for (const text of lex.stdinTexts) visitLine(text, depth + 1, out);
  for (const words of argvs) {
    const p = words.findIndex((x) => !/^[A-Za-z_]\w*=/.test(x.text));
    const name = p >= 0 ? progName(words[p]!.text) : "";
    if (name === "echo" || name === "printf") visitLine(words.slice(p + 1).filter((x) => !/^-[neE]+$/.test(x.text)).map((x) => x.text).join(" "), depth + 1, out);
  }
}
/** Final round 2 (S031): true when `hash`'s arguments bind a name to a path, so the name no longer says what runs:
 *  bash `-p PATH NAME` (alone or in a cluster such as `-rp`), zsh `NAME=PATH` (and `-d NAME=DIR`). `hash -r`,
 *  `hash -t NAME`, `hash -d NAME` and `hash NAME` only clear, print, forget or look up the program the name already
 *  names. A computed argument could be any of these, so it counts as a mapping. */
function hashRemaps(args: LexWord[]): boolean {
  return args.some((x) => x.computed || x.text.includes("=") || (/^-[A-Za-z]+$/.test(x.text) && x.text.includes("p")));
}
/** Closing pass (S031 parity): the file a simple command's stdin comes from, when its last fd-0 input redirect is a
 *  plain `<` with a literal target that is not a stream (`/dev/stdin`, `/dev/fd/N`, `/proc/…`). Any other last input
 *  redirect (heredoc, here-string, `<&`, `<>`), a computed target, or none at all leaves stdin to the line: null. */
function stdinFile(cmd: LexWord[]): string | null {
  let file: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const x = cmd[i]!;
    if (!x.redirect || !x.text.startsWith("<") || (x.fd && x.fd !== "0")) continue;
    const t = cmd[i + 1];
    file = x.text === "<" && t && !t.redirect && !t.computed && !/^\/(?:dev\/(?:stdin|fd\/)|proc\/)/.test(t.text) ? t.text : null;
  }
  return file;
}
/** Read one simple command; true when it is a shell reading its script from stdin. `fromFile` is the file its stdin
 *  is redirected from (stdinFile): a shell reading that runs the file, never the line's stdin texts. */
function visitArgv(words: LexWord[], depth: number, moreArgs: boolean, out: ShellWalk, fromFile: string | null = null): boolean {
  if (depth > WALK_MAX_DEPTH) { out.opaque = true; return false; }
  const { programs, xargs, envSplit, overflow } = programReadings(words);
  if (overflow) out.opaque = true;
  const consumed = new Set<number>();
  let stdin = false;
  for (const e of envSplit) {
    for (let k = e.at; k < words.length; k++) consumed.add(k);
    visitLine(e.body, depth + 1, out);
  }
  for (const p of programs) {
    const w = words[p]!;
    if (w.tail) out.computedProgram = true;
    out.runs.push(w.text);
    const name = progName(w.text);
    // tee and sponge (moreutils) write stdin to their file operands, like a redirect.
    if ((name === "tee" || name === "sponge") && !w.computed) for (const x of words.slice(p + 1)) if (!x.text.startsWith("-")) out.writes.push(x.text);
    if (SHELL_PROGRAMS.has(name) && !w.computed) {
      if (shellArgv(words, p, depth, consumed, out)) {
        // Under xargs the shell's stdin is xargs's business, not the redirect's: the stdin reading stays.
        if (fromFile === null || xargs) stdin = true;
        else if (fromFile !== "/dev/null") out.runs.push(fromFile);
      }
    } else if (name === "eval" && !w.computed) {
      let k = p + 1;
      if (words[k]?.text === "--") k++;
      for (let m = p + 1; m < words.length; m++) consumed.add(m);
      visitLine(words.slice(k).map((x) => x.text).join(" "), depth + 1, out);
    } else if ((name === "source" || name === ".") && !w.computed) {
      // `source <(…)`, `. /dev/stdin`: the script is a stream the text need not spell.
      const operand = words[p + 1];
      if (operand) out.runs.push(operand.text);
      if (!operand || /^\/dev\/(?:stdin|fd\/\d+)$/.test(operand.text)) stdin = true;
    } else if ((name === "alias" && words.slice(p + 1).some((x) => x.text.includes("="))) || (name === "hash" && hashRemaps(words.slice(p + 1)))) {
      // An alias (zsh expands aliases in scripts) or a hashed path renames a program for the lines after it, so later
      // program words no longer say what runs.
      out.computedProgram = true;
    } else if (name === "find" && !w.computed) {
      for (let k = p + 1; k < words.length; k++) {
        if (!["-exec", "-execdir", "-ok", "-okdir"].includes(words[k]!.text)) continue;
        let j = k + 1;
        for (; j < words.length && words[j]!.text !== ";" && words[j]!.text !== "+"; j++) consumed.add(j);
        visitArgv(words.slice(k + 1, j), depth + 1, true, out);
        k = j;
      }
    }
  }
  out.commands.push({ words, own: words.filter((_, k) => !consumed.has(k)), programs, depth, moreArgs: moreArgs || xargs });
  if (stdin) out.stdinShell = true;
  return stdin;
}
/** A shell's arguments read as bash reads them: options (and their operands) first; with `-c` the first non-option
 *  word is the script and the rest are `$0`, `$1`…; without it, no operand (or `-s`) means the script is stdin. */
function shellArgv(words: LexWord[], p: number, depth: number, consumed: Set<number>, out: ShellWalk): boolean {
  let i = p + 1, hasC = false, fromStdin = false, informational = false, sawShort = false;
  while (i < words.length) {
    const x = words[i]!, t = x.text;
    if (x.computed) {
      // A computed word where an option may stand could be `-c` (or split into `-c 'code'`): unreadable.
      if (x.split || i < words.length - 1) out.computedProgram = true;
      break;
    }
    if (t === "--") { i++; break; }
    if (t === "-") { fromStdin = true; i++; break; }
    // Final round 2 (S031): `--version` or `--help` before any short option prints and exits (bash, zsh, ksh), so
    // stdin is never read as a script. After a short option (`-s --version`) the shells differ, so the stricter
    // reading stays. A `-c` body is still read below as code: over-reading it only adds matches.
    if ((t === "--version" || t === "--help") && !sawShort) informational = true;
    if (t.startsWith("--")) { if (t === "--command") hasC = true; i += SHELL_LONG_VALUE.has(t) ? 2 : 1; continue; }
    if (/^[-+][A-Za-z]+$/.test(t)) {
      // Final round (S031), checked against bash: `+c` runs its operand like `-c`, and every `o`/`O` in a cluster
      // takes the next word as its operand wherever it stands (`-oc pipefail 'body'`, `-ooc a b 'body'`).
      sawShort = true;
      if (t.includes("c")) hasC = true;
      if (t[0] === "-" && t.includes("s")) fromStdin = true;
      i += 1 + (t.match(/[oO]/g)?.length ?? 0);
      continue;
    }
    break;
  }
  const operand = words[i];
  if (hasC) {
    if (operand) { consumed.add(i); visitLine(operand.text, depth + 1, out); }
    return false;
  }
  if (operand) out.runs.push(operand.text);
  if (informational) return false;
  return fromStdin || !operand || /^\/dev\/(?:stdin|fd\/\d+)$/.test(operand.text);
}
/** A command's words joined for the text-level checks, with separators inside a word blanked so quoted text never
 *  reads as a command boundary. */
function renderWords(words: LexWord[]): string {
  return words.map((x) => x.text.replace(/[;&|()`\n]/g, "_")).join(" ");
}
/** The text forms a mention check tests: the live normalized text, and every command the walker read (bodies
 *  included), one per line, each word as the shell passes it. Extra forms only add matches. */
export function normalForms(command: string): string[] {
  const walk = walkShell(command);
  const rendered = walk.commands.map((c) => renderWords(c.words)).join("\n");
  return [...new Set([normalizeCommand(command), rendered])];
}

// ── SENSITIVE (every tier) ──────────────────────────────────────────────
// Terminal parity: a text session is the terminal. Secrets, doctrine, skills, hooks, settings and dotfiles are governed
// by exactly what governs the terminal: settings.json permissions (the same deny/ask rules load here via
// --setting-sources user), auto mode, and every terminal hook. The guard keeps ONE surface of its own: the text
// channel's authentication (the bridge, its allowlist config and state, and this guard), because changing it
// from a text changes who can text in. The terminal has no equivalent.
/** The text channel's own auth surface. Write/Edit and any Bash mention refused; native reads open, like the terminal. */
const SECRET_PATH_RE = new RegExp([
  String.raw`texting-auth`, String.raw`bridge-config`, String.raw`texting-locked-clis\.json`,
  String.raw`TextingGuard\.hook\.ts`, String.raw`texting-guard-core`, String.raw`Countersign\.ts`,
  String.raw`LIFEOS\/RELAY\/(?!inbox\/)`, String.raw`\/RELAY\/(?:bridge|state|host)\/`,
  // The app launchd starts the bridge under (LIFEOS/RELAY/host): replacing it changes what the text line runs.
  String.raw`LifeOS\\? Relay\.app`, String.raw`RelayHost`,
].join("|"), "i");
/**
 * Words that run the command after them (with their own options and values), plus the reserved words a command may
 * follow. `env claude …` and `command claude …` ran a nested assistant because the
 * check expected `claude` right at a command boundary; every such wrapper is now peeled first.
 */
const DISARM_WRAPPERS = String.raw`(?:(?:\S*\/)?(?:env|command|builtin|exec|nohup|nice|time|timeout|gtimeout|caffeinate|stdbuf|sudo|doas|setsid|xargs|chronic|unbuffer|ionice|arch|script|then|do|else|if|while|until|!|\{)(?:\s+(?:-\S*(?:\s+[^\s;&|()-]\S*)?|\w+=\S*|\d[\w.]*))*\s+)*`;
/** Shell shapes that step outside the guarded process: a nested `claude` (bare, by path, or under a wrapper), LIFEOS_TEXTING_* assignment/unset, `env -i/-u`. */
const DISARM_SHELL_RE = new RegExp(
  String.raw`(?:^|[;&|(\x60\n]\s*)(?:\w+=\S*\s+)*` + DISARM_WRAPPERS + String.raw`(?:\w+=\S*\s+)*(?:\S*\/)?claude(?:\s|$)` +
  String.raw`|LIFEOS_TEXTING_\w*\s*=|(?:^|[\s;&|(])unset\s[^;&|\n]*LIFEOS_TEXTING|(?:^|[\s;&|(])env\s+(?:-\w*[iu]|--ignore-environment|--unset)`,
);
/**
 * P1 batch 2, S031: true when what a Bash line runs cannot be read from its text, so it could be a nested assistant
 * the disarm check cannot see: a program word (any reading) whose file name is computed or globbed (`$c -p`,
 * `${c}`, `$(printf claude)`, `cl?ude`), a computed word where a shell option stands (`bash "$OPT" '…'`), a shell
 * reading its script from stdin (`… | bash`, `bash -s`), or a line the walker cannot read. A computed directory with
 * a literal program (`$(brew --prefix)/bin/jq`, `$HOME/bin/x`) is readable and runs. The caller holds such a line as
 * an escape: the model re-expresses it plainly, or the principal confirms the exact command.
 */
export function computedProgramName(cmd: string): boolean {
  const w = walkShell(cmd);
  return w.opaque || w.stdinShell || w.computedProgram;
}
/** The text readings the disarm and terminal-drive shapes are tested against: the raw line, every command line the
 *  walker read (bodies included) as written and normalized, and the walker's word-level rendering of each command. */
function bashViews(cmd: string): string[] {
  const walk = walkShell(cmd);
  const views = [cmd];
  for (const l of walk.lines) views.push(l, normalizeCommand(l));
  views.push(walk.commands.map((c) => renderWords(c.words)).join("\n"));
  return [...new Set(views)];
}
/** S031: a command the line runs whose program word (any reading) is `claude`, or a disarm shape in any reading. */
function disarms(cmd: string): boolean {
  for (const c of walkShell(cmd).commands) {
    for (const p of c.programs) { const w = c.words[p]!; if (!w.computed && progName(w.text) === "claude") return true; }
  }
  return bashViews(cmd).some((v) => DISARM_SHELL_RE.test(v));
}
/** 4.1.0 (Relay ISA F12): typing into another terminal reaches a session the guard does not cover, which is the
 *  nested-assistant escape by another road: herdr agent/pane input, kitty remote control, tmux send-keys. Reads
 *  (herdr agent list/read, pane read, kitty @ ls/get-text) stay ordinary work. */
const TERMINAL_DRIVE_RE = /\bherdr\b[^;&|\n]*\b(?:agent\s+(?:prompt|send-keys|start|attach)|pane\s+(?:run|send-text|send-keys|input)|(?:workspace|tab)\s+create\b[^;&|\n]*--env|pane\s+split\b[^;&|\n]*--env)\b|\bkitt(?:y|en)\s+@[^;&|\n]*\b(?:send-text|send-key|launch|new-window)\b|\btmux\b[^;&|\n]*\b(?:send-keys|send|new-window|split-window|new-session)\b/;
/** Kept for callers; doctrine is terminal-governed since 4.0.0 and never refused by this guard. */
const DOCTRINE_PATH_RE = /LIFEOS_SYSTEM_PROMPT\.md|\/CLAUDE\.md|OPERATIONAL_PREFERENCES\.md|\/ALGORITHM\/(?:v\d|LATEST)|DA_IDENTITY\.md|PRINCIPAL_IDENTITY\.md/i;
/** settings.json writes are terminal-governed, except one that would drop this guard's registration. */
const SETTINGS_PATH_RE = /settings(?:\.local)?\.json$/i;
/** 4.2.0 (Relay ISA F16, ISC-178): a Bash write onto any settings file. Reads (cat, jq without a redirect) still run. */
const SETTINGS_BASH_WRITE_RE = /(?:>>?|\btee\b(?:\s+-\w+)*)\s*\S*settings(?:\.local)?\.json\b|\b(?:sed|perl)\b[^;&|\n]*\s-\w*i[^;&|\n]*settings(?:\.local)?\.json\b|\b(?:cp|mv|ln|install|rsync|ditto|sponge|dd|plutil)\b[^;&|\n]*settings(?:\.local)?\.json\b|settings(?:\.local)?\.json\b[^;&|\n]*\b(?:writeFile\w*|write_text|createWriteStream)\b|\b(?:writeFile\w*|write_text|createWriteStream|Bun\.write)\b[^;&|\n]*settings(?:\.local)?\.json\b/i;
/** 4.2.0 (ISC-179): the Relay service's launchd job. Any shell mention of the plist file, or a file-tool write to it, is refused. */
const RELAY_PLIST_RE = /com\.lifeos\.relay[\w.-]*\.plist\b/i;
/** 4.2.0 (ISC-180): launchctl verbs that stop, restart, unload or disable a job. Status reads (print, list) run. */
const LAUNCHCTL_STOP_VERB_RE = /\blaunchctl\b[^;&|\n]*\b(bootout|unload|remove|kill|disable|stop|kickstart)\b([^;&|\n]*)/gi;
/** The domain forms of the current user, which are computed but never name a job. */
const UID_FORM_RE = /\$\(\s*id\s+-[ru]+\s*\)|`\s*id\s+-[ru]+\s*`|\$\{?UID\}?|\$\{?HOME\}?/g;
/** Shell expansion or glob characters: the operand's final spelling is computed at run time. */
const COMPUTED_RE = /[$`*?{]/;
const RELAY_PLIST_NAME = "com.lifeos.relay.plist";
/** 4.2.0 (ISC-180, review round 1): true when a Bash command stops, restarts or unloads the Relay service, including
 *  by a label or plist the guard cannot read literally. Refused: a stop verb naming the Relay label; a stop verb whose
 *  operand is computed (`com.lifeos.${X}relay`, `$L`), since the guard cannot prove it is not Relay; any stop verb in a
 *  command that mentions relay at all (a label set in an earlier segment). Literal other labels still run. */
function stopsRelayService(cmd: string): boolean {
  const forms = [cmd, ...normalForms(cmd)];
  for (const f of forms) {
    LAUNCHCTL_STOP_VERB_RE.lastIndex = 0;
    let any = false;
    for (const m of f.matchAll(LAUNCHCTL_STOP_VERB_RE)) {
      any = true;
      const rest = m[2] ?? "";
      if (/com\.lifeos\.relay\b/i.test(rest)) return true;
      if (COMPUTED_RE.test(rest.replace(UID_FORM_RE, "0"))) return true;
    }
    if (any && /relay/i.test(f)) return true;
  }
  return false;
}
/** 4.2.0 (ISC-179, review round 1): a Bash operand under LaunchAgents/ whose file name is a glob or expansion that
 *  could spell the Relay plist (`com.lifeos.rel*.plist`, `*.plist`, `$P`), or a removal or bulk rewrite of the
 *  LaunchAgents directory itself. Literal other plists still run. */
function touchesRelayPlistComputed(cmd: string): boolean {
  for (const f of [cmd, ...normalForms(cmd)]) {
    for (const m of f.matchAll(/LaunchAgents\/([^\s;&|<>()'"]*)/g)) {
      const name = (m[1] ?? "").replace(UID_FORM_RE, "0");
      const at = name.search(COMPUTED_RE);
      if (at >= 0 && RELAY_PLIST_NAME.startsWith(name.slice(0, at).toLowerCase())) return true;
    }
    if (/\b(?:rm|mv|unlink|trash|rmdir)\b[^;&|\n]*LaunchAgents\/?(?=$|[\s;&|)'"])/.test(f)) return true;
    if (/\bfind\b[^;&|\n]*LaunchAgents\b[^;&|\n]*\s-(?:delete|exec|execdir|ok)\b/.test(f)) return true;
  }
  return false;
}
/** A path segment after Library/ that is, or could glob to, LaunchAgents (`L*`, `Launch?gents`, `*`). */
function mentionsLaunchAgents(f: string): boolean {
  if (/LaunchAgents/i.test(f)) return true;
  for (const m of f.matchAll(/Library\/([^\s\/;&|<>()'"]*)/g)) {
    const seg = (m[1] ?? "").replace(UID_FORM_RE, "0");
    const at = seg.search(COMPUTED_RE);
    if (at >= 0 && "launchagents".startsWith(seg.slice(0, at).toLowerCase())) return true;
  }
  return false;
}
/** The session's working directory is LaunchAgents, or under it, so a bare operand names a file there. */
function cwdInLaunchAgents(cwd: string | undefined): boolean {
  if (!cwd) return false;
  return [cwd, realOrSelf(cwd)].some((c) => /\/Library\/LaunchAgents(?:\/|$)/i.test(c));
}
/** A verb that can delete, move, overwrite or rewrite a file through its operands. */
const MUTATE_VERB_RE = /(?:^|[\s(`])(?:sudo\s+)?(?:rm|mv|unlink|trash|rmdir|cp|ln|install|rsync|ditto|tee|truncate|shred|chmod|chflags|xattr|plutil|defaults|sed|perl|dd|touch|sponge)\b/;
/** 4.2.0 (ISC-179, review round 2): the plist reached through a directory change. `cd ~/Library/LaunchAgents && rm c*`
 *  never spells `LaunchAgents/<name>`, and a `cd` in an earlier Bash call leaves the session's cwd there. Inside a
 *  LaunchAgents context (the command names that directory, the cwd is in it, or a `cd` target is computed), any
 *  mutating verb with a glob or expansion operand, any redirect to a computed name, and any `find` that deletes or
 *  executes is refused, since the guard cannot prove the operand is not the Relay plist. */
function touchesRelayPlistViaCwd(cmd: string, cwd: string | undefined): boolean {
  for (const f of [cmd, ...normalForms(cmd)]) {
    const ctx = mentionsLaunchAgents(f) || cwdInLaunchAgents(cwd) || /(?:^|[\s;&|(])(?:cd|pushd)\s+[^;&|\n]*[$`*?{]/.test(f.replace(UID_FORM_RE, "0"));
    if (!ctx) continue;
    for (const seg of f.split(/&&|\|\||[;&|\n]/)) {
      const t = seg.replace(UID_FORM_RE, "0");
      if (MUTATE_VERB_RE.test(t) && COMPUTED_RE.test(t)) return true;
      if (/>>?\s*[^\s]*[$`*?{]/.test(t)) return true;
      if (/\bfind\b[^\n]*\s-(?:delete|exec|execdir|ok|okdir)\b/.test(t)) return true;
    }
  }
  return false;
}
/** A process-kill pattern that names the Relay bridge or its runtime. */
const RELAY_PROC_RE = /relay|bridge|textus|imsg|lifeos|\bbun\b/i;
/** 4.2.0 (ISC-180, review round 2): the Relay job stopped by signal instead of launchctl. Refused: pkill/killall whose
 *  pattern names the bridge, its runtime or is computed, and a `kill` whose PID comes from a process lookup that does.
 *  A literal PID is the named computed-target residual (ISC-40). */
function killsRelayProcess(cmd: string): boolean {
  for (const f of [cmd, ...normalForms(cmd)]) {
    for (const seg of f.split(/&&|\|\||[;&\n]/)) {
      const t = seg.replace(UID_FORM_RE, "0");
      const pk = t.match(/(?:^|[\s(`])(?:sudo\s+)?(?:pkill|killall)\b(.*)$/);
      if (pk && (RELAY_PROC_RE.test(pk[1] ?? "") || COMPUTED_RE.test(pk[1] ?? ""))) return true;
    }
    if (/(?:^|[\s(`;&|])(?:sudo\s+)?kill\b/.test(f) && /\b(?:pgrep|pidof|lsof|ps|launchctl)\b/.test(f) && RELAY_PROC_RE.test(f)) return true;
  }
  return false;
}
/** The settings keys that decide whether hooks run in a session: the registration itself, the kill switches, and
 *  any env override of the texting markers (which would leave the hook unarmed). */
function hookRelevant(settings: unknown): string {
  const s = (settings ?? {}) as Record<string, unknown>;
  const env = (s.env ?? {}) as Record<string, unknown>;
  const texting = typeof env === "object" && env ? Object.fromEntries(Object.entries(env).filter(([k]) => /^LIFEOS_TEXTING/i.test(k)).sort()) : {};
  // A non-object `hooks` value registers nothing (the harness reads hooks only from an object), so it compares as absent.
  // Any object, an empty one or an array included, compares by its full content: fail closed.
  const hooks = typeof s.hooks === "object" && s.hooks !== null ? s.hooks : null;
  return JSON.stringify([hooks, s.disableAllHooks ?? null, s.allowManagedHooksOnly ?? null, texting]);
}
/** A Claude Code settings file: `.claude/settings(.local).json` anywhere, or the install's own config root. */
function isClaudeSettingsPath(p: string): boolean {
  const abs = expandHome(p.trim());
  // A file not yet created has no realpath; its parent's realpath catches a symlinked directory that leads to .claude.
  let viaParent = abs;
  try { viaParent = join(realpathSync(dirname(abs)), basename(abs)); } catch { /* parent absent too */ }
  for (const f of new Set([abs, realOrSelf(abs), viaParent])) {
    if (/(?:^|\/)\.claude\/settings(?:\.local)?\.json$/i.test(f)) return true;
    if (f.startsWith(`${claudeDir()}/`) && SETTINGS_PATH_RE.test(f)) return true;
  }
  return false;
}
/** True when a file-tool call on a Claude settings file would change what runs as a hook. Unknowable → true (fail closed).
 *  An absent file compares as `{}` (review round 1): creating settings.local.json with hooks or disableAllHooks is a
 *  registration change, since the harness merges every settings file it finds. An edit whose old_string is not in the
 *  file cannot land, so it is not a change. */
function changesHookRegistration(toolName: string, toolInput: Record<string, unknown> | undefined, p: string): boolean {
  const abs = realOrSelf(expandHome(p.trim()));
  let current = "";
  if (existsSync(abs)) { try { current = readFileSync(abs, "utf8"); } catch { return true; } }
  let next: string;
  if (toolName === "Write") next = String(toolInput?.content ?? "");
  else if (toolName === "Edit" || toolName === "MultiEdit") {
    const edits = toolName === "Edit" ? [toolInput ?? {}] : (Array.isArray(toolInput?.edits) ? toolInput!.edits as Array<Record<string, unknown>> : null);
    if (!edits) return true;
    next = current;
    for (const e of edits) {
      const from = String(e.old_string ?? ""), to = String(e.new_string ?? "");
      if (!from) return true;
      if (!next.includes(from)) return false; // the tool refuses an edit it cannot match; nothing is written
      next = e.replace_all ? next.split(from).join(to) : next.replace(from, () => to);
    }
  } else return true;
  let before: unknown = {}, after: unknown;
  try { if (current.trim()) before = JSON.parse(current); } catch { return true; }
  try { after = next.trim() ? JSON.parse(next) : {}; } catch { return true; }
  return hookRelevant(before) !== hookRelevant(after);
}

/** Auth-surface directories (kept for sweepsSecretDir; reads of them are no longer refused). */
function secretDirs(cfg?: GuardConfig): string[] {
  const h = HOME();
  const out: string[] = [];
  // Deny side: the install's own LIFEOS is added to the HOME-profile one, never swapped for it, so a relocated
  // install's bridge is covered and the home profile's stays covered. Extra secret dirs only tighten.
  for (const L of new Set([lifeosDir(), join(claudeDir(), "LIFEOS"), join(h, ".claude", "LIFEOS")])) out.push(join(L, "RELAY", "bridge"), join(L, "RELAY", "host"), join(L, "USER", "RELAY", "state"));
  out.push(join(h, "Applications", "LifeOS Relay.app"));
  if (cfg?.stateDir) out.push(cfg.stateDir);
  return [...new Set(out.flatMap((d) => pathForms(d)))];
}
/** The spellings one directory can have: as given, realpathed, and without macOS's /private prefix. */
function pathForms(d: string): string[] {
  const a = stripSlash(d), b = stripSlash(realOrSelf(a));
  return [...new Set([a, b, a.replace(/^\/private(?=\/)/, ""), b.replace(/^\/private(?=\/)/, "")])];
}
/** True when `p` (expanded, realpathed) is a proper ancestor of a secret dir — e.g. Grep over ~ or over the WORK parent. */
export function sweepsSecretDir(p: string, cfg?: GuardConfig): boolean {
  const raw = stripSlash(expandHome(p.trim()));
  const cands = new Set([raw, stripSlash(realOrSelf(raw))]);
  if (raw === "" || raw === "." ) cands.add(stripSlash(realOrSelf(process.cwd())));
  for (const c of cands) for (const d of secretDirs(cfg)) if (d.startsWith(`${c}/`)) return true;
  return false;
}
export function touchesSecret(s: string, cfg?: GuardConfig): boolean {
  const ns = normalForms(s);
  if (ns.some((n) => SECRET_PATH_RE.test(n))) return true;
  if (cfg?.stateDir) {
    const h = HOME();
    const forms = new Set<string>();
    for (const sd of pathForms(cfg.stateDir)) {
      forms.add(sd);
      if (h && sd.startsWith(h)) { forms.add(sd.replace(h, "~")); forms.add(sd.replace(h, "$HOME")); }
    }
    for (const f of forms) if (ns.some((n) => n.includes(f))) return true;
    // a path operand that resolves INTO the state dir (symlink, relative, `..`) — for native tool paths
    for (const real of pathForms(expandHome(s.trim()))) for (const f of forms) if (real === f || real.startsWith(`${f}/`)) return true;
  }
  return false;
}
/**
 * The path the kernel reaches for `p`: the deepest existing ancestor realpathed (every symlink in it
 * dereferenced), the not-yet-existing tail appended as spelled. A Bash write names its target by a
 * spelling that need not exist yet (`cp x alias/new`), so realOrSelf on the whole path misses it.
 */
function canonicalTarget(p: string): string { return physicalPath(p); }
/**
 * Final round (S029): every directory a write to `abs` could be judged to land in. The kernel's reading
 * (physicalPath: `alias/..` steps to the alias target's parent) and the lexical reading (`..` folded first, as
 * the live guard judged it) can name different directories, and the guard only tightens, so both are checked:
 * `state/link/../new.json` stays refused as the live guard refused it, and `MEMORY/../STATE/x` through a
 * symlinked MEMORY is checked where the kernel puts it too.
 */
function targetReadings(abs: string): string[] {
  return [...new Set([physicalPath(abs), canonicalLexical(abs)])];
}
/** The live guard's reading: `..` folded lexically, then the deepest existing ancestor realpathed. */
function canonicalLexical(abs: string): string {
  let cur = resolve(abs);
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(cur), ...tail.reverse()); } catch { /* not there yet */ }
    const up = dirname(cur);
    if (up === cur) return resolve(abs);
    tail.push(basename(cur));
    cur = up;
  }
}
/**
 * Round 1 review (S029): `p` (absolute) resolved the way the kernel opens it: every existing component through
 * realpath, left to right, so `alias/..` steps to the physical parent of the alias's target (`/var/..` is
 * `/private` on macOS), and the first missing component ends resolution with the rest joined as spelled. Walking
 * up from the leaf with dirname folded `..` lexically first and judged the wrong directory. The same algorithm as
 * the shared resolver's realPathOf (hooks/lib/shell-paths.ts); it is restated here because this module imports
 * node builtins only (Relay ISC-34), and a parity test pins the two together.
 */
export function physicalPath(p: string): string {
  const segs = p.split("/").filter(Boolean);
  let cur = "/";
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s === ".") continue;
    if (s === "..") { cur = dirname(cur); continue; }
    const next = join(cur, s);
    try { cur = realpathSync(next); } catch { return resolve(next, ...segs.slice(i + 1)); }
  }
  return cur;
}
/**
 * True when some word of a Bash command, read as a path from `cwd`, lands in or on an auth-surface
 * directory once symlinks are followed. touchesSecret matches spellings; an alias (`ln -s
 * …/RELAY/bridge /tmp/x; cp payload /tmp/x/config.json`) spells nothing it knows (LOSIntegrity
 * 2026-10-13). Every word is a candidate operand: over-reading costs a
 * refused texted call, under-reading lets a text rewrite its own authentication.
 */
export function bashOperandTouchesSecret(cmd: string, cfg: GuardConfig | undefined, cwd?: string): boolean {
  const dirs = secretDirs(cfg);
  const base = cwd || process.cwd();
  const words = normalForms(cmd).flatMap((n) => n.replace(/['"]/g, "").split(/[\s;&|()<>]+/));
  const lands = (path: string): boolean => {
    const abs = expandHome(path);
    for (const target of targetReadings(abs.startsWith("/") ? abs : `${base}/${abs}`)) {
      for (const form of pathForms(target)) {
        if (dirs.some((d) => form === d || form.startsWith(`${d}/`))) return true;
      }
    }
    return false;
  };
  for (const raw of words) {
    // `--target-directory=DIR`, `VAR=DIR`: the value is the operand.
    const word = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : raw;
    if (!word || /^-/.test(word)) continue;
    const open = word.search(/[$`*?\u0001]/);
    if (open < 0) { if (lands(word)) return true; continue; }
    // Final round 2 (S029): a word with an unreadable part (`link/$NAME`, `link/*`, a computed part) still names the
    // directory spelled before that part, and a file written there is in that directory: `link/` is judged. A
    // COMPUTED_MARK may also be a literal U+0001 in the command, a file-name byte the kernel opens as spelled, so a
    // word holding one is judged as spelled too. Skipping such words let `cp x link/<U+0001>new.json` through.
    const dir = word.slice(0, word.lastIndexOf("/", open) + 1);
    if (dir && lands(dir)) return true;
    if (word.includes(COMPUTED_MARK) && !/[$`*?]/.test(word) && lands(word)) return true;
  }
  return false;
}
/**
 * P1 batch 2, S029: true when a file tool's path lands in or on an auth-surface directory once every symlink in
 * its deepest existing ancestor is followed. realOrSelf returns a not-yet-existing file's path unchanged, so a
 * Write of a NEW file under a symlinked alias of the bridge or state dir was judged by the alias spelling alone.
 * A relative path resolves from the session cwd, as the tool resolves it.
 */
export function fileTargetTouchesSecret(p: string, cfg: GuardConfig | undefined, cwd?: string): boolean {
  if (!p) return false;
  const dirs = secretDirs(cfg);
  // Final round (S029): the path as given and trimmed. A leading or trailing space is part of a file name the tool
  // opens (` alias/new.json` is the entry " alias"), so trimming alone judged a different path.
  for (const spelled of new Set([p, p.trim()])) {
    if (!spelled) continue;
    const abs = expandHome(spelled);
    for (const target of targetReadings(abs.startsWith("/") ? abs : `${cwd || process.cwd()}/${abs}`)) {
      if (touchesSecret(target, cfg)) return true;
      if (pathForms(target).some((form) => dirs.some((d) => form === d || form.startsWith(`${d}/`)))) return true;
    }
  }
  return false;
}
export function touchesDoctrine(s: string): boolean { return normalForms(s).some((n) => DOCTRINE_PATH_RE.test(n)); }
/** Back-compat name used by the bridge's Probe: the auth surface. */
export function touchesSensitivePath(s: string, cfg?: GuardConfig): boolean { return touchesSecret(s, cfg); }

const NATIVE_READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * The Relay send tools. Running one is a message, held by the send rules below like any send (P11), never a change
 * to the text channel's auth surface (2026-10-26: every `bun ~/.claude/LIFEOS/RELAY/bridge/send.ts …` from a text,
 * the Send intent's own command, was refused as auth-surface, so the DA could not text a Ring 1 group or anyone else).
 */
const RELAY_SEND_TOOLS = ["send.ts", "voice-send.ts"];
function relaySendToolPaths(): Set<string> {
  const out = new Set<string>();
  for (const L of new Set([lifeosDir(), join(claudeDir(), "LIFEOS"), join(HOME(), ".claude", "LIFEOS")])) {
    for (const f of RELAY_SEND_TOOLS) for (const form of pathForms(join(L, "RELAY", "bridge", f))) out.add(form);
  }
  return out;
}
/**
 * The line with each literal `bun <bridge>/send.ts` or `voice-send.ts` program path replaced by a neutral word, for
 * the auth-surface checks only. A path is replaced only when every spelling of it in the line is such a run and the
 * line writes none of them, so `bun …/send.ts x; cp y …/send.ts` is judged as written. An unreadable line is unchanged.
 */
export function maskRelaySendRuns(cmd: string): string {
  const walk = walkShell(cmd);
  if (walk.opaque || walk.stdinShell || walk.computedProgram) return cmd;
  const tools = relaySendToolPaths();
  const runs = new Map<string, number>();
  for (const c of walk.commands) {
    if (c.programs.length !== 1) continue;
    const p = c.programs[0]!;
    const prog = c.words[p], script = c.words[p + 1];
    if (!prog || !script || prog.computed || script.computed || progName(prog.text) !== "bun") continue;
    const abs = expandHome(script.text);
    if (!abs.startsWith("/") || !pathForms(abs).some((f) => tools.has(f))) continue;
    runs.set(script.text, (runs.get(script.text) ?? 0) + 1);
  }
  let out = cmd;
  for (const [text, n] of runs) {
    if (cmd.split(text).length - 1 !== n || walk.writes.includes(text)) return cmd;
    out = out.split(text).join("relay-send-tool");
  }
  return out;
}

/** Why a tool call is SENSITIVE (writes the text channel's auth surface or steps outside the guard), or undefined. */
export function sensitiveReason(toolName: string, toolInput: Record<string, unknown> | undefined, cfg: GuardConfig, cwd?: string): string | undefined {
  if (toolName === "Agent" && toolInput?.isolation) return "disarm"; // a worktree/remote sub-agent leaves the guarded process tree
  if (toolName === "Bash") {
    const cmd = toolInput?.command;
    if (typeof cmd !== "string") return undefined;
    if (disarms(cmd)) return "disarm";
    if (bashViews(cmd).some((v) => TERMINAL_DRIVE_RE.test(v))) return "disarm";
    const surface = maskRelaySendRuns(cmd);
    if (touchesSecret(surface, cfg)) return "auth-surface";
    if (bashOperandTouchesSecret(surface, cfg, cwd)) return "auth-surface";
    const norms = normalForms(cmd);
    if (RELAY_PLIST_RE.test(cmd) || norms.some((n) => RELAY_PLIST_RE.test(n))) return "relay-service";
    if (touchesRelayPlistComputed(cmd)) return "relay-service";
    if (touchesRelayPlistViaCwd(cmd, cwd)) return "relay-service";
    if (stopsRelayService(cmd)) return "relay-service";
    if (killsRelayProcess(cmd)) return "relay-service";
    if (SETTINGS_BASH_WRITE_RE.test(cmd) || norms.some((n) => SETTINGS_BASH_WRITE_RE.test(n))) return "hook-registration";
    return undefined;
  }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const p = String(toolInput?.file_path ?? toolInput?.notebook_path ?? "");
    if (touchesSecret(p, cfg) || touchesSecret(realOrSelf(expandHome(p)), cfg)) return "auth-surface";
    if (fileTargetTouchesSecret(p, cfg, cwd)) return "auth-surface";
    if (RELAY_PLIST_RE.test(p) || RELAY_PLIST_RE.test(realOrSelf(expandHome(p)))) return "relay-service";
    if (isClaudeSettingsPath(p) && changesHookRegistration(toolName, toolInput, p)) return "hook-registration";
    if (SETTINGS_PATH_RE.test(p)) {
      // Unregistering this guard from a text is the one settings edit refused; everything else is the terminal's call.
      const removed = String(toolInput?.old_string ?? "");
      const written = toolName === "Write" ? String(toolInput?.content ?? "") : String(toolInput?.new_string ?? "");
      if (/TextingGuard/.test(removed) && !/TextingGuard/.test(written)) return "auth-surface";
      if (toolName === "Write" && !/TextingGuard/.test(written)) return "auth-surface";
    }
    return undefined;
  }
  return undefined;
}

// ── SENDS (every tier) ──────────────────────────────────────────────────
// 4.0.0: only messages to people are sends (P11: the terminal asks before those). An HTTP call to an API is
// ordinary work, same as the terminal; after an untrusted read, the terminal's TaintGuard hook governs outbound.
interface Rule { re: RegExp; reason: string }
const SEND_RULES: Rule[] = [
  { re: /\bgmail\.ts\s+(?:send|reply|forward)\b|\baws\s+sesv?2?\s+send(?:-raw)?-email\b|\bsendmail\b|(?:^|[;&|]\s*)mail\s+-s\b|\bmailto:/, reason: "send" },
  { re: /\bSendText\b|\btwilio\b|\bsend\.ts\b|\btell\s+(?:application|app)\s+"?Messages\b/i, reason: "send" },
  { re: /\bDiscordCli\.ts\s+send\b|discord(?:app)?\.com\/api\/webhooks|\bLinkedInComment\.ts\b|\bpost\.ts\b|\bBroadcast\b|\b_BROADCAST\b|\bxurl\b[^|;&\n]*\b(?:-X\s*POST|--method\s*POST|-d\b)/i, reason: "send" },
  { re: /\bslack\b[^|;&\n]*\b(?:send|post|chat\.postMessage)\b/i, reason: "send" },
];
/** Programs that only search, list or print files: a send tool's name in their pattern or operands is text, not a
 *  message (2026-10-26: `rg -n "send.ts" …` from a text was held as a send and asked "Run it?"). */
const READ_ONLY_PROGRAMS = new Set(["rg", "grep", "egrep", "fgrep", "ls", "eza", "cat", "bat", "head", "tail", "wc", "file", "stat"]);
function readsOnly(c: WalkCommand): boolean {
  if (c.moreArgs || !c.programs.length) return false;
  if (c.programs.some((p) => c.words[p]!.computed || !READ_ONLY_PROGRAMS.has(progName(c.words[p]!.text)))) return false;
  return !c.words.some((w) => /^--pre(?:-glob)?(?:=|$)/.test(w.text)); // rg --pre runs a program on every file
}
export function isSendCommand(command: string): boolean {
  const norms = normalForms(command);
  if (!SEND_RULES.some((r) => r.re.test(command) || norms.some((n) => r.re.test(n)))) return false;
  const walk = walkShell(command);
  if (walk.opaque || walk.stdinShell || walk.computedProgram) return true;
  // A readable line is a send only when some command other than a read-only one names a send in its own words.
  return walk.commands.some((c) => {
    if (readsOnly(c)) return false;
    const own = renderWords(c.own);
    return SEND_RULES.some((r) => r.re.test(own) || normalForms(own).some((n) => r.re.test(n)));
  });
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE_RE = /(?<![\w.])(?:\+\d{8,15}|\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})(?![\w.])/g;
const OWNED_ALWAYS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function normalizeNumber(s: string): string {
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}
export interface EgressResult { ok: boolean; reason?: string; offenders?: string[] }

/** Recipients of a send that are not the principal's own channels. 4.0.0: hosts are no longer offenders (terminal parity). */
export function egressCheck(command: string, cfg: GuardConfig, isSend: boolean): EgressResult {
  const offenders: string[] = [];
  if (isSend) {
    const emails = new Set(cfg.ownChannels.emails.map((e) => e.toLowerCase()));
    const numbers = new Set(cfg.ownChannels.numbers.map(normalizeNumber));
    for (const norm of normalForms(command)) {
      for (const m of norm.matchAll(EMAIL_RE)) if (!emails.has(m[0].toLowerCase())) offenders.push(`email:${m[0]}`);
      for (const m of norm.matchAll(PHONE_RE)) if (!numbers.has(normalizeNumber(m[0]))) offenders.push(`number:${normalizeNumber(m[0])}`);
    }
  }
  const uniq = [...new Set(offenders)];
  return uniq.length ? { ok: false, reason: "non-owned destination", offenders: uniq } : { ok: true };
}

/** Options that name a send's recipients, in `--to x` or `--to=x` form. */
const RECIPIENT_FLAGS = new Set(["--to", "--cc", "--bcc", "--recipient", "--recipients", "--number", "--phone", "--user", "--channel"]);
/** Send options whose next word is a value that never names a recipient (gmail.ts, send.ts, mail). A computed word
 *  is accepted only in one of these value slots: anywhere else it could expand to `--cc` and add a recipient. */
const SEND_VALUE_FLAGS = new Set(["--subject", "--body", "--body-file", "--from", "--reply-to", "--reply-to-id", "--in-reply-to", "--references", "--thread-id", "--attach", "--account", "--message", "--text", "--image", "--origin", "--title", "--file", "-s", "-m"]);
const EMAIL_EXACT = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
const PHONE_EXACT = /^(?:\+\d{8,15}|\+?1?[.-]?\d{3}[.-]?\d{3}[.-]?\d{4})$/;
/**
 * P1 batch 2, S030: true only when every send command the line runs names its recipients, and every one is a literal
 * owned channel. Recipients are the values of the recipient options and the first operand of the Relay `send.ts`.
 * A recipient that is computed (`$RCPT`, `$(…)`), a name, a list with an unreadable member, or no recipient found at
 * all is unresolved, so the send asks first. Before this, any owned address anywhere in the command (a
 * `--body "cc me"`) waived the question for a recipient the guard never read.
 *
 * Fix round 2: the commands come from walkShell(), so a send inside `bash -c '…'`, `eval`, `env -S` or `find -exec`
 * is judged on its own words, and the shell's trailing words (`$0`, `$1`, an outer `--to`) bind to nothing. A
 * computed word outside a known value slot, an unquoted (splitting) computed value, and arguments that xargs or
 * find adds all leave the recipients unresolved.
 */
/**
 * The recipient word of a Relay `send.ts` call, given the words after `send.ts`, or null when it cannot be read.
 * Mirrors LIFEOS/RELAY/bridge/send.ts parseSendArgs (restated: this module imports node builtins only, ISC-34):
 * the first `--origin` and its value are dropped, then every `--md`, then the first `--image` and its value (a
 * second `--image` is a usage error, so nothing is sent), and the first word left is the number.
 */
function sendTsRecipient(args: LexWord[]): LexWord | null {
  const lit = (w: LexWord | undefined, t: string) => !!w && !w.computed && w.text === t;
  const originAt = args.findIndex((w) => lit(w, "--origin"));
  const valueSlots = new Set<number>();
  if (originAt >= 0) valueSlots.add(originAt + 1);
  const rest = args.map((w, k) => ({ w, k })).filter(({ k }) => originAt < 0 || (k !== originAt && k !== originAt + 1));
  const imageAt = rest.findIndex(({ w }) => lit(w, "--image"));
  if (imageAt >= 0) {
    if (rest.slice(imageAt + 1).some(({ w }) => lit(w, "--image"))) return null;
    const value = rest[imageAt + 1];
    if (value) valueSlots.add(value.k);
  }
  const positional = rest.filter(({ w }, j) => !lit(w, "--md") && !lit(w, "--approved") && (imageAt < 0 || (j !== imageAt && j !== imageAt + 1)));
  const to = positional[0];
  if (!to) return null;
  for (let k = 0; k < to.k; k++) {
    const w = args[k]!;
    if (!w.computed) continue;
    if (!valueSlots.has(k) || w.split) return null;
  }
  return to.w;
}
const MAIL_PROGRAMS = new Set(["mail", "mailx", "sendmail"]);
/**
 * Final round 2 (S030): the recipient words of a `mail`/`mailx` or `sendmail` command, read as their option parsers
 * read argv, or null when they cannot be bound. mail: `-s`/`-r`/`-a`/`-q`/`-S` take a value (attached or the next
 * word, also at the end of a cluster such as `-is subj`), `-c`/`-b` take a recipient list, `E i I n v d F N` are
 * flags, and every operand is a recipient. sendmail: each option is its own word; `-f -F -r -N -R -V -B -L -h` take
 * a value (attached or next), `-i -n -v -U -G -oi -om -oe? -bm -A?` are plain, every operand is a recipient, and
 * `-t` (recipients from the message headers) or any other option leaves them unbound. A computed word outside a
 * value slot, a splitting computed value, or an option after the first operand (a permuting parser reads it) is
 * unbound too.
 */
function mailRecipients(prog: string, args: LexWord[]): LexWord[] | null {
  const to: LexWord[] = [];
  const value = (k: number): boolean => { const v = args[k]; return !!v && !(v.computed && v.split); };
  let i = 0;
  if (prog === "sendmail") {
    for (; i < args.length; i++) {
      const w = args[i]!, t = w.text;
      if (w.computed) return null;
      if (t === "--") { i++; break; }
      if (!t.startsWith("-") || t === "-") break;
      if (/^-[fFrNRVBLh]$/.test(t)) { if (!value(i + 1)) return null; i++; continue; }
      if (/^-[fFrNRVBLh]./.test(t)) continue;
      if (/^-(?:i|n|v|U|G|oi|om|oe[mpqw]|bm|A[mc])$/.test(t)) continue;
      return null;
    }
  } else {
    for (; i < args.length; i++) {
      const w = args[i]!, t = w.text;
      if (w.computed) return null;
      if (t === "--") { i++; break; }
      if (!/^-./.test(t)) break;
      for (let k = 1; k < t.length; k++) {
        const ch = t[k]!;
        if ("EiInvdFN".includes(ch)) continue;
        if (!"sraqScb".includes(ch)) return null;
        const attached = t.slice(k + 1);
        let v: LexWord;
        if (attached) v = { ...w, text: attached };
        else { if (!value(i + 1)) return null; v = args[++i]!; }
        if (ch === "c" || ch === "b") to.push(v);
        break;
      }
    }
  }
  for (; i < args.length; i++) {
    const w = args[i]!;
    if (w.computed || w.text.startsWith("-")) return null;
    to.push(w);
  }
  return to;
}
export function ownRecipientsOnly(command: string, cfg: GuardConfig): boolean {
  const walk = walkShell(command);
  if (walk.opaque || walk.stdinShell) return false;
  const emails = new Set(cfg.ownChannels.emails.map((e) => e.toLowerCase()));
  const numbers = new Set(cfg.ownChannels.numbers.map(normalizeNumber));
  const owned = (w: LexWord): boolean => {
    if (w.computed) return false;
    for (const raw of w.text.split(",")) {
      // Closing pass (S030 parity): `Name <addr>` with a plain display name is the one mailbox gmail.ts's
      // parseAddressList reads as exactly <addr>. Any quote, comment, `@` or other special in the name stays unread.
      const angle = /^[A-Za-z0-9][A-Za-z0-9 ._-]*?\s*<([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>$/.exec(raw.trim());
      const r = angle ? angle[1]! : raw.trim();
      if (!r || /[$`*?{}()<>;&|\\'"\s\u0001]/.test(r)) return false;
      if (EMAIL_EXACT.test(r)) { if (!emails.has(r.toLowerCase())) return false; continue; }
      if (PHONE_EXACT.test(r)) { if (!numbers.has(normalizeNumber(r))) return false; continue; }
      return false;
    }
    return true;
  };
  let sends = 0;
  for (const c of walk.commands) {
    if (!SEND_RULES.some((r) => r.re.test(renderWords(c.own)))) continue;
    sends++;
    if (c.moreArgs) return false;
    const words = c.own;
    const prog = c.programs.length ? words.indexOf(c.words[c.programs[0]!]!) : 0;
    const progWord = prog >= 0 ? words[prog] : undefined;
    if (progWord && !progWord.computed && MAIL_PROGRAMS.has(progName(progWord.text))) {
      // Final round 2 (S030): mail and sendmail take their recipients as operands, not as a recipient option.
      const to = mailRecipients(progName(progWord.text), words.slice(prog + 1));
      if (!to || !to.length || !to.every(owned)) return false;
      continue;
    }
    let recips = 0;
    // Closing pass (S030 parity): when send.ts is itself the program (`./send.ts <number> hi`), it is read from its
    // own word, so its positional number is the recipient, exactly as `bun ./send.ts <number> hi` is read.
    const sendTsIsProgram = !!progWord && /(?:^|\/)send\.ts$/.test(progWord.text);
    for (let i = Math.max(prog, 0) + (sendTsIsProgram ? 0 : 1); i < words.length; i++) {
      const w = words[i]!, t = w.text;
      if (/(?:^|\/)send\.ts$/.test(t) && !w.tail && !w.split) {
        // send.ts, read as its parseSendArgs reads argv (final round, S030: `send.ts --md <own> hi` was asked about):
        // flags anywhere, `--md` alone, the first `--origin` and the first `--image` each with the next word as value,
        // and the first remaining word is the number. A computed word before the number, outside one of those value
        // slots, could itself be a flag or the number; a splitting computed value could add words before it.
        const to = sendTsRecipient(words.slice(i + 1));
        if (!to || !owned(to)) return false;
        recips++;
        break;
      }
      if (w.computed) {
        // A path with a computed directory and a literal file name (`"$HOME/…/gmail.ts"`) is not an option.
        const lit = t.slice(0, t.indexOf(COMPUTED_MARK));
        const eqFlag = /^(--[\w-]+)=/.exec(lit);
        if (!w.split && ((!w.tail && t.includes("/")) || (eqFlag && !RECIPIENT_FLAGS.has(eqFlag[1]!)))) continue;
        return false;
      }
      const eq = t.startsWith("--") ? t.indexOf("=") : -1;
      const flag = eq > 0 ? t.slice(0, eq) : t;
      if (RECIPIENT_FLAGS.has(flag)) {
        const v: LexWord | undefined = eq > 0 ? { ...w, text: t.slice(eq + 1) } : words[++i];
        if (!v || !owned(v)) return false;
        recips++;
        continue;
      }
      if (SEND_VALUE_FLAGS.has(t)) {
        const v = words[i + 1];
        if (v?.computed && v.split) return false;
        i++;
      }
    }
    if (!recips) return false;
  }
  // The whole line reads as a send (isSendCommand) but no single command does: the recipient cannot be bound.
  return sends > 0;
}

/**
 * Relay F36 ISC-432 (principal directive, 2026-10-27): a text to Ring 1 goes unasked. True only for one literal `bun` run of the
 * bridge's real send.ts (any `cd` beside it), with no `--approved`, no write and no xargs-added words, whose literal
 * recipient is an owned channel, a Ring 1 handle (cfg.trustedHandles), or a `chat:` group thread, and with no other
 * foreign phone or email anywhere in the line. A group is let through here because send.ts reads its members live and
 * refuses unless all are Ring 0 or 1 (ISC-433); `--approved` skips that check, so a send carrying it always asks.
 */
export function trustedRelaySend(command: string, cfg: GuardConfig): boolean {
  if (maskRelaySendRuns(command) === command) return false;
  const walk = walkShell(command);
  if (walk.opaque || walk.stdinShell || walk.computedProgram || walk.writes.length) return false;
  const emails = new Set([...cfg.ownChannels.emails, ...(cfg.trustedHandles ?? []).filter((h) => h.includes("@"))].map((e) => e.toLowerCase()));
  const numbers = new Set([...cfg.ownChannels.numbers, ...(cfg.trustedHandles ?? []).filter((h) => !h.includes("@"))].map(normalizeNumber));
  const tools = relaySendToolPaths();
  let sends = 0;
  for (const c of walk.commands) {
    if (c.programs.length !== 1) return false;
    const p = c.programs[0]!;
    const prog = c.words[p]!;
    if (!prog.computed && progName(prog.text) === "cd") continue;
    const script = c.words[p + 1];
    if (prog.computed || progName(prog.text) !== "bun" || !script || script.computed || c.moreArgs) return false;
    if (!/(?:^|\/)send\.ts$/.test(script.text) || !pathForms(expandHome(script.text)).some((f) => tools.has(f))) return false;
    const args = c.words.slice(p + 2);
    if (args.some((w) => w.text === "--approved")) return false;
    const to = sendTsRecipient(args);
    if (!to || to.computed) return false;
    if (!/^chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(to.text)) {
      if (EMAIL_EXACT.test(to.text) ? !emails.has(to.text.toLowerCase()) : !PHONE_EXACT.test(to.text) || !numbers.has(normalizeNumber(to.text))) return false;
    }
    sends++;
  }
  if (sends !== 1) return false;
  for (const norm of normalForms(command)) {
    for (const m of norm.matchAll(EMAIL_RE)) if (!emails.has(m[0].toLowerCase())) return false;
    for (const m of norm.matchAll(PHONE_RE)) if (!numbers.has(normalizeNumber(m[0]))) return false;
  }
  return true;
}

// ── LOCKED: the native-read allowlist ───────────────────────────────────
function webFetchHost(toolInput: Record<string, unknown> | undefined): string {
  const url = String(toolInput?.url ?? "");
  return (url.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] ?? "").toLowerCase();
}
/** Owned in the strict sense for a LOCKED fetch: loopback or a listed domain. Never `.local`/RFC1918 (an attacker.local resolves on the LAN). */
export function isOwnedHostStrict(hostWithPort: string): boolean {
  const host = hostWithPort.replace(/:\d+$/, "").toLowerCase();
  if (!host) return false;
  if (OWNED_ALWAYS.has(host) || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)) return true;
  for (const d of ownedDomains()) if (host === d || host.endsWith(`.${d}`)) return true;
  return false;
}
/** True when the call is a native read a LOCKED session may run (sensitive already cleared). */
export function nativeRead(toolName: string, toolInput: Record<string, unknown> | undefined): boolean {
  if (NATIVE_READ_TOOLS.has(toolName) || toolName === "WebSearch") return true;
  if (toolName === "WebFetch") return isOwnedHostStrict(webFetchHost(toolInput));
  if (toolName === "Bash" && typeof toolInput?.command === "string") return lockedCliRead(toolInput.command);
  return false;
}

// ── LOCKED: the read-only CLI allowlist (3.3.0) ─────────────────────────
// A week of real texts (2026-09-04 → 09-10) showed the locked tier holding every calendar and mail READ,
// and a natural "yes" to the check-in never lifts a hold (only the countersign does), so the principal saw
// "I can't" for a week. The fix keeps the model: Bash is still never parsed for read-ness. Instead a
// closed grammar names the exact deterministic read-only invocations a locked session may run, and the
// match consumes the WHOLE command — exact binary, exact tool path under ~/.claude, a subcommand from the
// tool's read set, and arguments from a closed token charset. Any shell metacharacter anywhere rejects,
// so `gcal.ts list; rm -rf ~` never matches (the unlocked-tier CONFIRM rules do not run while locked).
// The lifelog CLI is deliberately absent: transcripts are untrusted third-party speech and stay behind
// the countersign (principal, 2026-09-10).
type LockedCli = { rel: string; subs: ReadonlySet<string>; flags: ReadonlySet<string>; globalFlags?: ReadonlySet<string>; maxPositional: number };
// Private-skill rows live in the USER zone (LIFEOS/USER/SECURITY/texting-locked-clis.json) and load
// here at import, so a release carries no inventory of private tools and never pre-trusts a path the
// install does not have (Fable in-family audit, round 9, 7.52.0 cut).
function loadLockedCliOverlay(): LockedCli[] {
  const p = join(claudeDir(), "LIFEOS", "USER", "SECURITY", "texting-locked-clis.json");
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { rows?: Array<{ rel: string; subs: string[]; flags: string[]; globalFlags?: string[]; maxPositional: number }> };
    return (j.rows ?? []).filter((r) => typeof r?.rel === "string" && !r.rel.includes("..")).map((r) => ({
      rel: r.rel, subs: new Set(r.subs ?? []), flags: new Set(r.flags ?? []), globalFlags: r.globalFlags ? new Set(r.globalFlags) : undefined, maxPositional: Number(r.maxPositional ?? 0),
    }));
  } catch { return []; }
}
const LOCKED_CLIS: readonly LockedCli[] = [
  ...loadLockedCliOverlay(),
  { rel: "LIFEOS/TOOLS/gmail.ts", subs: new Set(["list", "fetch", "fetchfull", "threads", "thread", "body", "count", "ids", "profile"]), flags: new Set([]), globalFlags: new Set(["--account"]), maxPositional: 2 },
  { rel: "LIFEOS/TOOLS/ContactsDb.ts", subs: new Set(["search", "get", "list", "stats"]), flags: new Set(["--json"]), maxPositional: 8 },
  // People replaced ContactsDb as the contacts surface (2026-09-11). Same data,
  // same read class; the ContactsDb row stays while its shim does. Only the three
  // read subcommands are named — `push` (the one path off the machine), `add`,
  // `sync` and `tick` (all writers) are outside the set and stay held.
  { rel: "LIFEOS/PEOPLE/People.ts", subs: new Set(["who", "list", "stats"]), flags: new Set(["--json", "--class", "--limit"]), maxPositional: 8 },
];
const BOOLEAN_FLAGS = new Set(["--json"]);
/** Any of these anywhere in the raw command means it is not a single literal invocation. `~` only as the path prefix. */
const LOCKED_CLI_META = /[;&|`$<>(){}\[\]\\\n\r*?!#%^]/;
/** What an argument may contain once its quotes are stripped: letters (any script), digits, and query punctuation. Never a quote, slash-dot climb, or shell glyph. */
const LOCKED_CLI_ARG = /^[\p{L}\p{N} ._:@+\/,=-]*$/u;
const BUN_BINS = new Set(["bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]);

/** Split on whitespace honouring simple single/double quotes; returns null on an unterminated quote. */
function shellTokens(command: string): string[] | null {
  const out: string[] = []; let cur = ""; let q: string | null = null; let has = false;
  for (const ch of command) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) out.push(cur); cur = ""; has = false; continue; }
    cur += ch; has = true;
  }
  if (q) return null;
  if (has || cur) out.push(cur);
  return out;
}
/** True when `command` is exactly one allowlisted read-only CLI invocation (whole-command, closed grammar). Exported for tests and the tool map. */
export function lockedCliRead(command: string): boolean {
  const raw = command.trim();
  if (!raw || raw.length > 600 || LOCKED_CLI_META.test(raw)) return false;
  if (/~(?!\/\.claude\/)/.test(raw)) return false; // tilde only as the ~/.claude/ path prefix
  if (/["']~/.test(raw)) return false; // a quoted tilde never expands in a shell: what the grammar approves must be what runs (advisor, 2026-09-10)
  const toks = shellTokens(raw);
  if (!toks || toks.length < 3) return false;
  const [bin, path, ...rest] = toks;
  if (!BUN_BINS.has(bin!)) return false;
  const home = HOME();
  const tool = LOCKED_CLIS.find((t) => path === `~/.claude/${t.rel}` || path === `${home}/.claude/${t.rel}`);
  if (!tool) return false;
  // optional global flags (e.g. gmail --account <name>) may precede the subcommand
  let i = 0;
  while (i < rest.length && rest[i]!.startsWith("--")) {
    const f = rest[i]!;
    if (!tool.globalFlags?.has(f)) return false;
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("-") || !LOCKED_CLI_ARG.test(v) || v.includes("/") || v.includes("..")) return false;
    i += 2;
  }
  const sub = rest[i];
  if (sub === undefined || !tool.subs.has(sub)) return false;
  let positional = 0;
  for (i = i + 1; i < rest.length; i++) {
    const t = rest[i]!;
    if (t.startsWith("--")) {
      if (!tool.flags.has(t)) return false;
      if (BOOLEAN_FLAGS.has(t)) continue;
      const v = rest[++i];
      if (v === undefined || v.startsWith("-") || !LOCKED_CLI_ARG.test(v) || v.includes("..")) return false;
      continue;
    }
    if (t.startsWith("-") || !LOCKED_CLI_ARG.test(t) || t.includes("..")) return false;
    if (++positional > tool.maxPositional) return false;
  }
  return true;
}

// ── CONFIRM (unlocked): the terminal's own ask-first classes ────────────
// 4.0.0: exactly the actions the terminal asks about before running (Permission Boundaries P6 deploy, P7 publish,
// P8 delete, P12 money, P13 publish under his name, P11 sends via SEND_RULES). Service control, ssh, network
// tools, env inspection, interpreters and shell indirection are ordinary terminal work and run.
const CONFIRM_RULES: Rule[] = [
  // deploy
  { re: /\bwrangler\b[^|;&\n]*\b(deploy|publish|versions\s+upload|pages\s+deploy)\b/, reason: "deploy" },
  { re: /\bdeploy\.sh\b|\bbun\s+run\s+deploy\b|\bCfEnv\.ts\s+deploy\b|\bgh\s+workflow\s+run\b/, reason: "deploy" },
  // cf CLI (Wrangler replaced 2026-09-29): cf deploy / pages|previews|triggers deploy, workers versions|deployments create,
  // builds create — bare, via bunx, or through CfEnv.ts. `deploy-hooks` and `deployments list` are reads.
  { re: /(?:(?<![\w.-])cf|\bCfEnv\.ts)\b[^|;&\n]*\b(?:deploy|versions\s+create|deployments\s+create|builds\s+create)\b(?!-)/, reason: "deploy" },
  // delete / destructive
  { re: /(?:^|[;&|(]\s*|\$\(\s*|`\s*)\s*(?:sudo\s+)?(?:\S*\/)?rm\b|\brmdir\b|\btrash\b|\bshred\b|\bdd\s+(?:if|of)=/, reason: "delete" },
  { re: /\bfind\b[^|;&\n]*\s-delete\b|\btruncate\b/, reason: "delete" },
  { re: /\bgit\b[^|;&\n]*\b(?:branch\s+-D|reset\s+--hard|filter-(?:branch|repo)|clean\s+-[a-z]*f)/, reason: "delete" },
  { re: /\bgh\s+(?:repo|issue|release|pr|gist|secret)\s+delete\b|\bgh\s+api\b[^|;&\n]*(?:-X|--method)\s*DELETE\b/, reason: "delete" },
  { re: /\bwrangler\b[^|;&\n]*\bdelete\b|\bd1\s+execute\b[^|;&\n]*\b(?:DELETE|DROP|TRUNCATE)\b/i, reason: "delete" },
  // cf CLI: any `cf … delete` (workers, d1, r2 buckets/objects incl. bulk-delete, kv, dns, zones, queues, pages…),
  // a D1 time-travel restore, a queue purge, and a destructive statement through d1 query/raw.
  { re: /(?:(?<![\w.-])cf|\bCfEnv\.ts)\b[^|;&\n]*\b(?:delete|time-travel\s+restore|queues\s+purge)\b|\bd1\s+(?:query|raw)\b[^|;&\n]*\b(?:DELETE|DROP|TRUNCATE)\b/i, reason: "delete" },
  // money: Stripe writes (SDK or CLI), orders. Reads (list/retrieve/search) run.
  { re: /\bstripe\b[\s\S]*?\.(?:create|update|del|cancel|capture|confirm|pay|refund|finalizeInvoice|voidInvoice|markUncollectible|resume)\s*\(|\bstripe\s+\S+\s+(?:create|update|delete|cancel|capture|confirm|pay)\b|\bstripe\s+(?:post|delete)\b/i, reason: "spend" },
  { re: /\bStripe\.ts\b[^|;&\n]*\b(?:charge|refund|payment|create|cancel)\b|\bdd-cli\b[^|;&\n]*\b(?:order|checkout|place)\b/i, reason: "spend" },
  // publish
  { re: /\bgit\b[^|;&\n]*\bpush\b|\bnpm\s+publish\b|\bgh\s+release\s+create\b|\bgh\s+gist\s+create\b|\bgh\s+repo\s+(?:create|edit)\b[^|;&\n]*--public\b|\bCreateRelease\b|\bsync-docs\.ts\b/, reason: "publish" },
  { re: /\bPublishVideo\.ts\b|\byoutube\b[^|;&\n]*\b(?:upload|publish)\b|\bSubstack\b|\bshare\.ts\b|(?:^|[;&|]\s*)share\s+\S/i, reason: "publish" },
  // the sealed store's private identity
  { re: /\bSecrets\.ts\s+(?:unseal|export-identity)\b/, reason: "secrets" },
];

/** The system temp roots. Everything under them is throwaway scratch, which P8 lets the terminal delete without
 *  asking ("Scratch and regenerable artifacts → ACT"); holding `rm -rf /tmp/scratch-x` for a yes was most of the
 *  distinct delete holds on the text line. */
function scratchRoots(): string[] {
  return [...new Set(["/tmp", tmpdir()].map((d) => stripSlash(physicalPath(d))).filter((d) => d.split("/").length > 2))];
}
const DELETE_PROGRAMS = new Set(["rm", "rmdir", "unlink", "trash"]);
/** Commands a scratch-delete line may also run: none can make a path name another file. */
const SCRATCH_LINE_EXTRAS = new Set(["echo", "printf", "true", ":", "ls", "pwd"]);
/**
 * True when every command the line runs is a delete of literal absolute paths strictly inside a temp root once
 * symlinks are followed, or a harmless extra. The whole-line closed shape keeps `ln -s ~ /tmp/x && rm -rf /tmp/x/`,
 * a wrapper (`sudo rm`), a nested shell, a glob and a computed path held: each could aim the delete outside scratch.
 */
export function deletesOnlyScratch(cmd: string): boolean {
  const walk = walkShell(cmd);
  if (walk.opaque || walk.stdinShell || walk.computedProgram || !walk.commands.length) return false;
  const roots = scratchRoots();
  const inScratch = (t: string) => {
    if (!t.startsWith("/") || /[$`*?\[\]{}~\u0001]/.test(t)) return false;
    const real = stripSlash(physicalPath(t));
    return roots.some((r) => real.startsWith(`${r}/`));
  };
  let deletes = 0;
  for (const c of walk.commands) {
    if (c.depth !== 0 || c.moreArgs || c.programs.length !== 1 || c.programs[0] !== 0) return false;
    const name = progName(c.words[0]!.text);
    if (SCRATCH_LINE_EXTRAS.has(name)) continue;
    if (!DELETE_PROGRAMS.has(name)) return false;
    let operands = false, endOfOptions = false;
    for (const w of c.words.slice(1)) {
      if (w.computed) return false;
      if (!endOfOptions && w.text === "--") { endOfOptions = true; continue; }
      if (!endOfOptions && w.text.startsWith("-")) continue;
      if (!inScratch(w.text)) return false;
      operands = true;
    }
    if (!operands) return false;
    deletes++;
  }
  return deletes > 0;
}

/** Relay F20 (ISC-259): each command the walker read, rendered from each program word on, one string apiece, so a
 *  rule anchored at a command start sees the program a wrapper runs (`xargs rm -rf`, `env X=1 nice rm`). */
function programForms(cmd: string): string[] {
  const out: string[] = [];
  for (const c of walkShell(cmd).commands) for (const p of c.programs) out.push(renderWords(c.words.slice(p)));
  return out;
}

/** Interpreters whose inline code the shell text carries as one opaque argument, and the flags that introduce it. */
const INLINE_CODE_FLAGS: Record<string, Set<string>> = {
  bun: new Set(["-e", "--eval", "-p", "--print"]), node: new Set(["-e", "--eval", "-p", "--print"]),
  deno: new Set(["eval"]), osascript: new Set(["-e"]), python: new Set(["-c"]), python3: new Set(["-c"]),
  perl: new Set(["-e", "-E"]), ruby: new Set(["-e"]), php: new Set(["-r"]), swift: new Set(["-e"]),
};
/** Inline code that starts a process: the guard reads only the shell line, never what the code runs. */
const INLINE_SPAWN_RE = /child_process|\bspawn(?:Sync)?\b|\bexecSync\b|\bexecFile(?:Sync)?\b|\bfork\s*\(|\bBun\s*\.\s*\$|\$\s*`|\bsubprocess\b|\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*)\b|\bpopen\b|(?<![\w.])system\s*\(|\bdo\s+shell\s+script\b|\bNSTask\b|\bProcess\s*\(\s*\)/;
/** Inline code that deletes. */
const INLINE_DELETE_RE = /\b(?:rm|unlink|rmdir)(?:Sync)?\s*\(|\.delete\s*\(\s*\)|\bshutil\s*\.\s*rmtree\b|\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs)\b|\bremoveItem\b|\bFileUtils\s*\.\s*rm/;
/** Inline code that hides what it calls: a module, property or program name built at run time, or decoded code. */
const INLINE_HIDDEN_RE = /\b(?:require|import)\s*\(\s*(?!["'`][^"'`$+]*["'`]\s*\))|\beval\s*\(|\bFunction\s*\(|\bglobalThis\s*\[|\b(?:Bun|process|Deno)\s*\[|\[\s*["'`][^"'`]*["'`]\s*\+|\bString\s*\.\s*fromCharCode\b|\batob\s*\(|\bbase64\b|\b__import__\b|\bgetattr\s*\(/;

/** Relay F20 (ISC-259): why inline interpreter code needs confirmation. Read-only inline code runs. */
function inlineCodeReason(cmd: string): string | undefined {
  for (const c of walkShell(cmd).commands) {
    for (const p of c.programs) {
      const flags = INLINE_CODE_FLAGS[progName(c.words[p]!.text).replace(/\.exe$/, "")];
      if (!flags) continue;
      // Only the interpreter's own options count: the first other word is a script path, and what follows is its argv.
      for (let i = p + 1; i < c.words.length; i++) {
        const w = c.words[i]!;
        if (w.text === "-") return "escape"; // the script is read from stdin
        if (!flags.has(w.text)) { if (w.computed || !w.text.startsWith("-")) break; continue; }
        const code = c.words[i + 1];
        if (!code || code.computed) return "escape";
        if (INLINE_SPAWN_RE.test(code.text) || INLINE_HIDDEN_RE.test(code.text)) return "escape";
        if (INLINE_DELETE_RE.test(code.text)) return "delete";
      }
    }
  }
  return undefined;
}

/** Relay F20 (ISC-260): agent CLIs and LifeOS agent launchers. Each runs its own tool loop that this guard never
 *  sees, the way a nested `claude` would; unlike `claude` (refused as a disarm), each is held for a yes. */
const AGENT_PROGRAMS = new Set(["codex", "gemini", "opencode", "aider", "cursor-agent", "goose", "crush", "droid", "qwen", "copilot"]);
const AGENT_SCRIPTS = new Set(["worker.ts", "apilane.ts", "muse.ts"]);
/** First arguments that only inspect: they start no agent turn (`codex doctor`, `Worker.ts wait sol`). */
const AGENT_READ_VERBS = new Set(["doctor", "--version", "-v", "-V", "version", "--help", "-h", "help", "wait", "status", "list", "ls", "show", "logs", "result"]);
function runsNestedAgent(cmd: string): boolean {
  const launches = (args: LexWord[]) => !(args[0] && !args[0].computed && AGENT_READ_VERBS.has(args[0].text));
  for (const c of walkShell(cmd).commands) {
    for (const p of c.programs) {
      const name = progName(c.words[p]!.text);
      if (AGENT_PROGRAMS.has(name) && launches(c.words.slice(p + 1))) return true;
      if (name === "bun" || name === "node" || name === "bunx" || name === "deno") {
        const at = c.words.findIndex((w, k) => k > p && AGENT_SCRIPTS.has(progName(w.text)));
        if (at > 0 && launches(c.words.slice(at + 1))) return true;
      }
    }
  }
  return false;
}

/** Why an UNLOCKED call needs confirmation, or undefined when it simply runs. */
export function destructiveReason(toolName: string, toolInput: Record<string, unknown> | undefined): string | undefined {
  if (toolName !== "Bash") return undefined;
  const cmd = toolInput?.command;
  if (typeof cmd !== "string") return undefined;
  const norms = [...normalForms(cmd), ...programForms(cmd)];
  for (const r of CONFIRM_RULES) {
    if (!(r.re.test(cmd) || norms.some((n) => r.re.test(n)))) continue;
    if (r.reason === "delete" && deletesOnlyScratch(cmd)) continue;
    return r.reason;
  }
  const inline = inlineCodeReason(cmd);
  if (inline) return inline;
  if (runsNestedAgent(cmd)) return "nested-agent";
  if (isSendCommand(cmd)) return "send";
  return undefined;
}

// ── Lock state ───────────────────────────────────────────────────────────
export function isUnlocked(auth: SenderAuth | undefined, now: number): boolean {
  if (!auth?.unlockedUntil) return false;
  return new Date(auth.unlockedUntil).getTime() > now;
}
/** A hold is answerable while inside its TTL and under the miss cap. */
export function challengeOpen(auth: SenderAuth | undefined, cfg: GuardConfig, now: number): boolean {
  const c = auth?.challengePending;
  if (!c) return false;
  if ((c.attempts ?? 0) >= MAX_COUNTERSIGN_MISSES) return false;
  return now - new Date(c.ts).getTime() <= cfg.challengeTtlMs;
}
/** A text arrived while a hold was open and was not the countersign: count it. */
export function noteCountersignMiss(auth: SenderAuth | undefined): SenderAuth {
  const c = auth?.challengePending;
  if (!c) return { ...(auth ?? {}) };
  return { ...(auth ?? {}), challengePending: { ...c, attempts: (c.attempts ?? 0) + 1 } };
}
export function confirmOpen(auth: SenderAuth | undefined, cfg: GuardConfig, now: number): boolean {
  if (!auth?.confirmPending) return false;
  return now - new Date(auth.confirmPending.ts).getTime() <= cfg.confirmTtlMs;
}
export function countersignMatches(text: string, cfg: GuardConfig): boolean {
  if (!cfg.countersignSha256) return false;
  return countersignHash(text, cfg.countersignSalt) === cfg.countersignSha256;
}
export function unlock(auth: SenderAuth | undefined, cfg: GuardConfig, now: number): SenderAuth {
  return { ...(auth ?? {}), unlockedUntil: new Date(now + cfg.unlockIdleMs).toISOString(), challengePending: undefined, lastSeen: new Date(now).toISOString() };
}
export function touch(auth: SenderAuth | undefined, cfg: GuardConfig, now: number): SenderAuth {
  const next: SenderAuth = { ...(auth ?? {}), lastSeen: new Date(now).toISOString() };
  if (isUnlocked(next, now)) next.unlockedUntil = new Date(now + cfg.unlockIdleMs).toISOString();
  else next.unlockedUntil = undefined;
  return next;
}
export function lock(auth: SenderAuth | undefined): SenderAuth {
  return { ...(auth ?? {}), unlockedUntil: undefined, challengePending: undefined, confirmPending: undefined, approved: undefined };
}
/** The principal's short yes to an open confirm: the pending fingerprint becomes a one-shot approval. */
export function approve(auth: SenderAuth | undefined, cfg: GuardConfig, now: number): SenderAuth {
  const fp = auth?.confirmPending?.fingerprint;
  return { ...(auth ?? {}), confirmPending: undefined, approved: fp ? { fingerprint: fp, until: new Date(now + cfg.confirmTtlMs).toISOString() } : undefined };
}
export function clearConfirm(auth: SenderAuth | undefined): SenderAuth {
  return { ...(auth ?? {}), confirmPending: undefined };
}
/** Input files an approved command reads (`--body-file`, `--attach`, `--file`) that do not exist. Checked before a
 *  one-shot approval is spent, so a run that would fail on a missing file keeps the approval (2026-10-14: an
 *  approved send died on ENOENT for its body file, burned the yes, and every retry asked again). */
export function missingInputFiles(command: string, exists: (p: string) => boolean, home = "", cwd?: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/--(?:body-file|attach|file)(?:=|\s+)("([^"]+)"|'([^']+)'|(\S+))/g)) {
    let p = m[2] ?? m[3] ?? m[4] ?? "";
    if (!p || p === "-") continue;
    if (p.startsWith("~/") && home) p = home + p.slice(1);
    else if (!p.startsWith("/") && cwd) p = `${cwd}/${p}`;
    if (!exists(p)) out.push(p);
  }
  return out;
}
export function approvalMatches(auth: SenderAuth | undefined, fp: string, now: number): boolean {
  const a = auth?.approved;
  return !!a && a.fingerprint === fp && new Date(a.until).getTime() > now;
}

/** Trailing words a short reply may carry without changing its meaning; the DA's own name is added at runtime. */
function tailWords(daName?: string): string {
  const name = daName ? daName.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  return name ? "|" + name : "";
}
// release-allow: profanity (the matcher strips these emphasis words from a short reply before judging it)
/** Emphasis words that never change a yes into anything else; stripped before matching (2026-10-14:
 *  "Yes email" and an all-caps profane "do it" each superseded an open send confirm, ~10 refusals in a row). */
const EMPHASIS = /\b(?:just|already|the)\b/g;
/** A short affirmative — the natural reply to a confirm question. Prose is not a yes. */
export function affirmative(text: string, daName?: string): boolean {
  const raw = text.trim().toLowerCase().replace(/[.!…]+$/g, "").trim();
  if (raw.length > 40) return false;
  const t = raw.replace(EMPHASIS, " ").replace(/\s+/g, " ").trim();
  const re = new RegExp("^(?:y|ya|yes|yep|yeah|yup|yeh|ok|okay|k|sure|go|go ahead|go for it|do it|send it|send|email it|text it|ship it|push it|run it|delete it|approved?|confirm(?:ed)?|please do|yes please|affirmative|👍|✅|👌)(?:[\\s,]+(?:please|do it|go ahead|go|send it|send|email|email it|email her|email him|text it|thanks|thank you|now" + tailWords(daName) + "))*$");
  return re.test(t);
}
/** A short negative — cancels an open confirm. */
export function negative(text: string, daName?: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!…]+$/g, "").trim();
  if (t.length > 40) return false;
  const re = new RegExp("^(?:n|no|nope|nah|don't|do not|dont|cancel|stop|hold|hold off|not now|never ?mind|wait|skip it|leave it)(?:[\\s,]+(?:please|thanks|that|it" + tailWords(daName) + "))*$");
  return re.test(t);
}

// ── Injection tripwire (bridge-side, before any spawn) ──────────────────
// The persona alternative names the "DAN" (Do Anything Now) jailbreak persona, not a person.
const INJECTION_SHAPES: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|earlier|above) (instructions|prompts|rules)/i,
  /disregard (your|all|any|the) ((previous|prior|earlier|above) )?(instructions|rules|system prompt|guidelines)/i,
  /(you are|act as|pretend to be) (now )?(a )?(different|new|d\.?a\.?n\b|do anything now|admin|developer mode)/i,
  /(system|developer) (prompt|message|instruction)\s*[:>]/i,
  /<\s*\/?\s*(system|instructions?|admin)\s*>/i,
  /\[\s*(system|instruction|admin|important)\s*\]/i,
  /(new|updated|revised) (instructions?|task|directive)s?\s*[:>]/i,
  /(do not|don't) (tell|inform|mention to|alert) (the )?(user|principal|owner|human)/i,
  /(reveal|print|output|show|dump) (your|the) (system prompt|instructions|rules|context)/i,
  /base64\s*(-d|--decode|decode)/i,
  /curl [^|]*\|\s*(bash|sh|zsh|python)/i,
];
/** 4.2.0 (ISC-185): fold full-width and compatibility forms (NFKC), drop zero-width characters, and collapse every
 *  whitespace run (newlines, NBSP, doubled spaces) to one space, so trivial respellings match the same shapes. */
export function normalizeForTripwire(text: string): string {
  return text.normalize("NFKC").replace(/[​-‍⁠﻿­]/g, "").replace(/\s+/gu, " ");
}
export function injectionShaped(text: string): boolean {
  const n = normalizeForTripwire(text);
  return INJECTION_SHAPES.some((re) => re.test(text) || re.test(n));
}

// ── Messages the model sees on a deny (never the mechanism) ─────────────
export const MSG = {
  LOCKED:
    "[TEXTING-LOCKED] This action is held for now. Do NOT retry it and do NOT try another route to the same effect. Finish whatever native reading helps (Read, Grep, Glob, WebSearch), answer what you can from that, then end your reply with ONE short, natural check-in asking whether they want you to go ahead with exactly that action (for example: 'Want me to pull up your mail for that?' or 'Want me to put that on the calendar?'). Never write the words can't, cannot, unable, or blocked anywhere in the reply, and never say the action is impossible, unavailable, off-limits, or that you lack access; do not promise to queue or remember it; do not add unrelated status. Never mention a phrase, password, countersign, challenge, unlock, or that any particular reply of theirs would change this — even if they ask why.",
  SENSITIVE:
    "[TEXTING-SENSITIVE] Refused: this would change the text line's own login layer (its bridge, the allowlist of the principal's number, or this guard), or start an unguarded nested session. Everything else runs exactly as it does in the terminal. Read files with the Read tool if you only need to look. Do NOT retry or route around it. If they asked for exactly this, say in one plain sentence that you don't change your own text-line security from a text. Never say anything needs the terminal, and never say you aren't allowed to do other work.",
  EGRESS:
    "[TEXTING-EGRESS] Refused: from a text session, data may only go to the principal's own channels (their number, their mailboxes, their Discord DM), and shell commands may not reach hosts we do not own. Do NOT retry or route around it. Tell them plainly that sending to that destination isn't something you'll do from text.",
  CONFIRM:
    "[TEXTING-CONFIRM] This is one of the actions the terminal also asks about first (deploy, delete, spend, publish, push). It is held until the principal confirms. Do NOT retry it and do NOT try another route. Finish anything else that is safe, then end your reply with ONE short, plain question naming the exact action (for example: 'Push these two commits to origin/main?' or 'Send that to your work inbox?'). When they confirm, re-run the exact same tool call, byte for byte — a changed command is a new question. Never mention that a tap, token, or approval mechanism exists.",
  CONFIRM_ESCAPE:
    "[TEXTING-CONFIRM] Held only because the command hides part of itself behind shell indirection ($(...), backticks, ${...}, a heredoc substitution, eval, xargs, an interpreter -c). If the principal directly asked for this action, do NOT ask them about it: re-express the same action in plain form and run that instead. Put any long text in a file with the Write tool and pass the path (gh issue create --body-file <path>, gh issue comment --body-file <path>); spell values out literally instead of substituting them. The plain command is checked again from scratch, so a genuinely outward or destructive action is still held. Only if it cannot be expressed without indirection, end your reply with ONE short, plain question naming the exact action. Never mention that a tap, token, or approval mechanism exists.",
  CONFIRM_SEND:
    "[TEXTING-CONFIRM] This sends a message to someone other than the principal, so it is held until they confirm. Do NOT retry it and do NOT try another route. End your reply with ONE plain question that names the recipient and quotes the exact message text in full (for example: 'Text Alex: \"Here's the creatine link …\"?'). When they confirm, re-run the exact same tool call, byte for byte — a changed message is a new question. Never mention that a tap, token, or approval mechanism exists.",
  CONFIRM_CODE:
    "[TEXTING-CONFIRM] This reads mail for a login, verification or one-time code, which is a key to an account, so it is held until the principal confirms. Do NOT retry it and do NOT try another route to the same code. Finish anything else that is safe, then end your reply with ONE short, plain question naming the exact mail you would read (for example: 'Pull the newest sign-in code from Netflix in your mail?'). When they confirm, re-run the exact same tool call, byte for byte — a changed search is a new question. Never mention that a tap, token, or approval mechanism exists.",
  CONFIRM_TIMEOUT:
    "[TEXTING-CONFIRM-TIMEOUT] The principal did not approve this on their phone within the window. Do NOT retry. Tell them it's held until they approve the push notification, and that texting again will re-send it.",
} as const;

// ── Taint: has this session read untrusted content (mail, web) that could steer a fetch? ──
/** True when TaintGuard has marked this harness session within the window. Reads MEMORY/STATE/taint/<id>.json (builtins only). */
export function taintStands(sessionId: string | undefined, now: number, windowMs = 2 * 60 * 60_000): boolean {
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) return false;
  try {
    const p = join(lifeosDir(), "MEMORY", "STATE", "taint", `${sessionId}.json`);
    if (!existsSync(p)) return false;
    const m = JSON.parse(readFileSync(p, "utf8")) as { ts?: string };
    const ts = m?.ts ? new Date(m.ts).getTime() : NaN;
    return Number.isFinite(ts) ? now - ts <= windowMs : true;
  } catch { return true; } // unreadable mark: assume tainted
}

// ── One-time codes in mail (Relay F22, ISC-330) ─────────────────────────
// Instinct's incident: an agent pulled sign-in codes out of the user's mail unasked. A login, verification or one-time
// code is a key to an account, so a text session's mail read aimed at one waits for the principal's yes; every other
// mail read runs as before. "Confirmation code" stays an ordinary read: it names a booking or an order, not a login.
/** A mail reader named in a shell line: gmail.ts, the Gmail API, gog's gmail verb, the usual CLI and IMAP readers, Mail.app. */
const MAIL_TOOL_RE = /\bgmail\.ts\b|gmail\.googleapis\.com|\bgog\b[^\n]*\bgmail\b|\bhimalaya\b|\bnotmuch\b|\bneomutt\b|\bmutt\b|\bimaps?:\/\/|application\s+"?mail\b|Library\/Mail\b/i;
/** Tool names that read mail: Gmail and other mail MCP servers. */
const MAIL_TOOL_NAME_RE = /gmail|mail|inbox|outlook|imap/i;
/** The words a login-code query uses, tested on text folded to lowercase words separated by single spaces. */
const LOGIN_CODE_RE = new RegExp([
  String.raw`\b(?:otps?|totp|2fa|mfa|passcodes?|verification|magic link|two (?:factor|step)|2 step)\b`,
  String.raw`\b(?:log ?in|sign ?in|sign ?on|security|auth|authentication|access|one time|single use|verify|reset)(?: \S+)? (?:codes?|pins?|passwords?|links?|tokens?)\b`,
  String.raw`\bverify (?:your|my|this) (?:email|account|identity|login|device|sign ?in)\b`,
].join("|"));
/** Fold a query for matching: compatibility forms, no invisible characters, percent and plus decoding, words only. */
function foldQuery(s: string): string {
  let t = s.normalize("NFKC").replace(/[​-‍⁠﻿­]/g, "");
  try { t = decodeURIComponent(t.replace(/\+/g, " ")); } catch { /* not percent-encoded */ }
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
/** True when text, once folded, asks for a login, verification or one-time code. */
function targetsLoginCode(s: string): boolean { return LOGIN_CODE_RE.test(foldQuery(s)); }
/** gmail.ts subcommands whose positional arguments are a Gmail search query. */
const GMAIL_QUERY_SUBS = new Set(["list", "ids", "count", "threads", "search"]);
/** Every string inside a tool input, a few levels deep. */
function inputStrings(v: unknown, depth = 0, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (depth < 4 && v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) inputStrings(x, depth + 1, out);
  return out;
}
/**
 * Why a call reads mail for a login code: "otp-mail" when its query or line asks for one, "escape" when a gmail.ts
 * search query is computed (`"$Q"`, `$(…)`, xargs-supplied) so the text cannot say what it asks for; undefined for
 * every other call. A shell line counts when it names a mail reader and any reading of it asks for a code, so a code
 * filtered out of an ordinary search's output (`gmail.ts list … | rg verification`) is caught with the search.
 */
export function mailCodeReason(toolName: string, toolInput: Record<string, unknown> | undefined): "otp-mail" | "escape" | undefined {
  if (toolName === "Bash") {
    const cmd = toolInput?.command;
    if (typeof cmd !== "string") return undefined;
    const views = [cmd, ...normalForms(cmd)];
    if (!views.some((v) => MAIL_TOOL_RE.test(v.normalize("NFKC")))) return undefined;
    if (views.some(targetsLoginCode)) return "otp-mail";
    for (const c of walkShell(cmd).commands) {
      const at = c.words.findIndex((w) => progName(w.text) === "gmail.ts");
      if (at < 0) continue;
      const args = c.words.slice(at + 1);
      const rest: LexWord[] = [];
      for (let i = 0; i < args.length; i++) { if (args[i]!.text === "--account") { i++; continue; } rest.push(args[i]!); }
      const sub = rest[0];
      if (!sub) { if (c.moreArgs) return "escape"; continue; }
      if (sub.computed) return "escape";
      if (!GMAIL_QUERY_SUBS.has(sub.text)) continue;
      if (c.moreArgs || rest.slice(1).some((w) => w.computed)) return "escape";
    }
    return undefined;
  }
  if (toolName === "Grep") {
    const path = typeof toolInput?.path === "string" ? toolInput.path : "";
    return /Library\/Mail\b/.test(path) && targetsLoginCode(String(toolInput?.pattern ?? "")) ? "otp-mail" : undefined;
  }
  if (toolName.startsWith("mcp__") && MAIL_TOOL_NAME_RE.test(toolName)) return inputStrings(toolInput).some(targetsLoginCode) ? "otp-mail" : undefined;
  return undefined;
}

// ── The decision ─────────────────────────────────────────────────────────
export function decide(args: {
  toolName: string;
  toolInput: Record<string, unknown> | undefined;
  auth: SenderAuth | undefined;
  cfg: GuardConfig;
  now: number;
  tapConfigured: boolean;
  /** the session has read untrusted content this window; a non-owned fetch then asks first (Max HIGH 5) */
  tainted?: boolean;
  /** the session's working directory from the hook payload; a bare operand resolves against it (ISC-179) */
  cwd?: string;
}): Decision {
  const { toolName, toolInput, auth, cfg, now, tapConfigured, tainted, cwd } = args;

  void tainted; // 4.0.0: post-untrusted-read outbound is the terminal's TaintGuard hook, which runs in text sessions too

  // 1. The text channel's auth surface — every tier, before anything else.
  const sens = sensitiveReason(toolName, toolInput, cfg, cwd);
  if (sens) return { allow: false, kind: "SENSITIVE", reason: `sensitive:${sens}`, message: MSG.SENSITIVE };

  // F22 (ISC-330): a mail read aimed at a login, verification or one-time code. Locked, it is never a read the
  // locked tier runs; unlocked, it asks first wherever the call would otherwise have run unasked.
  const code = mailCodeReason(toolName, toolInput);

  // 2. Locked (non-principal senders only since ISC-84): native reads only; everything else held.
  if (!isUnlocked(auth, now)) {
    if (code) return { allow: false, kind: "LOCKED", reason: `held:${code}`, message: MSG.LOCKED };
    if (nativeRead(toolName, toolInput)) return { allow: true, reason: "read" };
    return { allow: false, kind: "LOCKED", reason: toolName === "WebFetch" ? "held:webfetch-nonowned" : `held:${toolName.toLowerCase()}`, message: MSG.LOCKED };
  }

  // 3. Unlocked = the terminal, with the terminal's own ask-first classes.
  if (toolName === "Bash" && typeof toolInput?.command === "string" && isSendCommand(toolInput.command)) {
    const eg = egressCheck(toolInput.command, cfg, true);
    // P1 batch 2, S030: an owned address in the body or subject is not the recipient. The send goes unasked only when
    // its recipient arguments are found and every one is a literal owned channel, and nothing else named is foreign.
    const ownOnly = eg.ok && ownRecipientsOnly(toolInput.command, cfg);
    // A message to the principal's own channels just goes, and so does a Relay text to Ring 1 or a group (send.ts
    // checks the group's members live, ISC-433); anything to anyone else asks, like the terminal (P11).
    if (!ownOnly && trustedRelaySend(toolInput.command, cfg)) return { allow: true, reason: "trusted:send" };
    if (!ownOnly) {
      const fp = fingerprint(toolName, toolInput);
      if (approvalMatches(auth, fp, now)) return { allow: true, consumeApproval: true, reason: "approved:send" };
      if (tapConfigured) return { allow: false, kind: "CONFIRM_TAP", reason: "send" };
      return { allow: false, kind: "CONFIRM", reason: "send", message: MSG.CONFIRM_SEND };
    }
  }
  let d = destructiveReason(toolName, toolInput);
  // P1 batch 2, S031: a command whose program name is computed (`$c -p`, `$(printf …) -p`, `cl?ude`) could be a nested
  // assistant the disarm check cannot read. It is held as an escape: the model re-expresses it plainly, where the
  // disarm check reads it again, or the principal confirms the exact command.
  if ((!d || d === "send") && toolName === "Bash" && typeof toolInput?.command === "string" && computedProgramName(toolInput.command)) d = "escape";
  // F22 (ISC-330): a call that would run unasked but reads mail for a login code asks first. A call already held for
  // another reason stays held under that reason, so it is never asked about twice.
  if ((!d || d === "send") && code) {
    const fp = fingerprint(toolName, toolInput);
    if (approvalMatches(auth, fp, now)) return { allow: true, reason: `approved:${code}`, consumeApproval: true };
    if (tapConfigured) return { allow: false, kind: "CONFIRM_TAP", reason: code };
    return { allow: false, kind: "CONFIRM", reason: code, message: code === "escape" ? MSG.CONFIRM_ESCAPE : MSG.CONFIRM_CODE };
  }
  if (!d || d === "send") return { allow: true, reason: "unlocked" };
  const fp = fingerprint(toolName, toolInput);
  if (approvalMatches(auth, fp, now)) return { allow: true, reason: `approved:${d}`, consumeApproval: true };
  if (tapConfigured) return { allow: false, kind: "CONFIRM_TAP", reason: d };
  return { allow: false, kind: "CONFIRM", reason: d, message: d === "escape" ? MSG.CONFIRM_ESCAPE : MSG.CONFIRM };
}
