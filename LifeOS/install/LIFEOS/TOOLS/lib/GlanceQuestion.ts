import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { isIP } from "node:net";
import { addressClass } from "./SafeFetch.ts";
import { touchesSecret, normalizeCommand } from "../../../hooks/lib/texting-guard-core.ts";
import { shellSteps } from "../../../hooks/lib/shell-commands.ts";
import { hasGlob } from "../../../hooks/lib/shell-paths.ts";
import { parseStateSource, sourceKind, type StateSource } from "./StateSources.ts";
import type { Question } from "../../ASSAY/Engine.ts";

export interface GlanceQuestion {
  id: string;
  claim: string;
  kind: "noul" | "score" | "choice";
  instructions: string;
  criteria?: string[] | { true?: string; false?: string };
  options?: Record<string, string | null>;
  state: { producer: string };
  caller: string;
}

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;

// Glance owns its own secret-path list. A producer runs as a plain child of
// Bunker, where settings.json permissions do not apply, and its output goes to
// an outside engine. It borrowed the texting guard's list until 2026-09-24,
// when that list was narrowed for terminal parity on the texting channel
// (ef5354986) and `cat .env` stopped being refused here (eval backlog
// remediation found it through glance.test.ts).
const PRODUCER_SECRET_RE = new RegExp([
  String.raw`(?:^|[\s/=:])\.env\b`, String.raw`\.age\b`, String.raw`\/SECURITY(?:\/|$)`, String.raw`CREDENTIALS\/`,
  String.raw`texting-auth`, String.raw`bridge-config`, String.raw`dashboard-token`, String.raw`device-code`, String.raw`poll-token`,
  String.raw`\.claude\/projects\/`, String.raw`\.claude\/history`,
  String.raw`(?:^|[\s/])\.ssh\b`, String.raw`\/Keychains?\/`, String.raw`\bsecurity\s+find-`, String.raw`\bkeychain\b`,
  String.raw`\.aws\/`, String.raw`\.config\/gh\/`, String.raw`\.docker\/config`, String.raw`\.kube\/`, String.raw`\.gnupg`,
  String.raw`\.netrc\b`, String.raw`\.npmrc\b`, String.raw`\.pypirc\b`, String.raw`\.dev\.vars\b`, String.raw`\.wrangler\/`,
  String.raw`\.pem\b`, String.raw`id_(?:rsa|ed25519|ecdsa)\b`,
].join("|"), "i");

export const PRODUCER_COMMANDS =["cat", "curl", "bun", "rg", "jq", "git", "head", "tail", "ls"] as const;
/** Words after `bun` that name a mode rather than a script to execute. */
const BUN_SUBCOMMANDS = new Set(["run", "test", "x", "exec", "build", "repl", "init", "create", "link", "pm", "install", "add", "remove", "upgrade", "update"]);
export type Producer = { file: string } | { argv: string[] } | { source: StateSource };

/** One producer word, with the first character a POSIX shell would expand in it (quoting considered), or null. */
interface ProducerWord { text: string; expands: string | null }

/**
 * The one producer lexer: split one command into words with no shell (quotes group, shell syntax
 * throws) and record, while the quoting is still known, what a shell WOULD expand in each word: an
 * unquoted glob, brace or tilde, or a `$`, backtick or backslash inside double quotes. Nothing inside
 * single quotes expands. A direct producer runs the words as they are; a package-script body is run by
 * a shell, so scriptBodyRefusal refuses any word with `expands` set.
 */
function lexProducer(producer: string): ProducerWord[] {
  const words: ProducerWord[] = [];
  let token = "", quote = "", active = false;
  let expands: string | null = null;
  for (const c of producer.trim()) {
    if (quote) {
      if (c === quote) quote = "";
      else { token += c; if (quote === '"' && expands === null && /[$`\\]/.test(c)) expands = c; }
      continue;
    }
    if (c === '"' || c === "'") { quote = c; active = true; }
    else if (/\s/.test(c)) { if (active) words.push({ text: token, expands }); token = ""; active = false; expands = null; }
    else {
      if (/[;&|<>`$\\]/.test(c)) throw new Error("producer denied syntax: shell expansion or composition");
      if (expands === null && (/[~{}]/.test(c) || hasGlob(c))) expands = c;
      token += c; active = true;
    }
  }
  if (quote) throw new Error("producer denied syntax: unmatched quote");
  if (active) words.push({ text: token, expands });
  return words;
}

/** Split one command into argv tokens with no shell: quotes group, shell syntax throws. */
export function tokenizeProducer(producer: string): string[] {
  return lexProducer(producer).map((w) => w.text);
}

const BUN_SAFE_FLAGS = new Set(["--silent", "--bun", "--smol", "--bail", "--only", "--todo", "--coverage"]);
const BUN_VALUE_FLAGS = new Set(["--timeout", "-t", "--test-name-pattern", "--rerun-each"]);

/** How Bun reads one producer argv: its mode and, for `bun run`, the script it runs and the words it forwards. */
type BunParse = { refused: string } | { mode: "run"; script: string; forwarded: string[] } | { mode: "test" | "script" };

/**
 * The one reading of a `bun` argv, shared by the mode check (bunModeRefusal) and the script lookup
 * (bunRunTarget), so the script that is judged is the script Bun runs (LOSIntegrity S062/S063).
 * Bun 1.3.6, probed: run accepts the boolean flags in BUN_SAFE_FLAGS before or after `run` and
 * consumes them, so `bun run --silent evil` runs `evil`. The value flags are test-only: anywhere but
 * after `test`, Bun reads `--timeout` as a bare switch and the value as the script
 * (`bun --timeout 5 run evil` runs a script named `5`), so they are refused outside `bun test`.
 */
function parseBun(tokens: string[]): BunParse {
  const args = tokens.slice(1);
  if (!args.length) return { refused: "a bare `bun` reads nothing" };
  const pathShaped = (a: string) => a.includes("/") || /\.[cm]?[jt]sx?$/.test(a);
  let i = 0;
  let mode: "run" | "test" | "script" | null = null;
  while (i < args.length) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (BUN_SAFE_FLAGS.has(name) && (eq < 0 || name === "--bail")) { i++; continue; }
      if (BUN_VALUE_FLAGS.has(name)) {
        if (mode !== "test") return { refused: `producer denied bun flag ${a}: it takes a value only \`bun test\` reads; anywhere else Bun runs the value as the script` };
        i += eq > 0 ? 1 : 2; continue;
      }
      return { refused: `producer denied bun flag ${a}: inline evaluation, preload and unlisted options do not run` };
    }
    if (mode === null) {
      if (a === "run" || a === "test") { mode = a; i++; continue; }
      // Everything after the script path is the script's own argv, never a bun flag.
      if (pathShaped(a)) { mode = "script"; i++; break; }
      return { refused: `producer denied bun mode ${a}: only \`bun run\`, \`bun test\` or a script path run` };
    }
    break;
  }
  if (mode === null) return { refused: "producer denied bun: no script or mode named" };
  if (mode !== "run") return { mode };
  if (i >= args.length) return { refused: "producer denied bun: `bun run` names no script" };
  const script = args[i]!;
  if (!pathShaped(script) && !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(script)) return { refused: `producer denied bun run target ${script}` };
  return { mode, script, forwarded: args.slice(i + 1) };
}

/**
 * Which `bun` invocations a producer may be. Only `bun run <name|script>`,
 * `bun test ...` and `bun <script path>` run; inline evaluation (-e, -p),
 * package execution (x, exec, create), preload and every other mode are refused
 * because none of them names a script that could be confined.
 */
export function bunModeRefusal(tokens: string[]): string | null {
  const parsed = parseBun(tokens);
  return "refused" in parsed ? parsed.refused : null;
}

// No redirect following (-L/--location) and no address override (--resolve): a
// spawned curl follows a redirect to wherever the server says and connects to
// whatever --resolve names, and neither hop can be re-checked against the
// destination policy below.
const CURL_SHORT_BOOL = new Set(["f", "s", "S", "i", "I", "v"]);
const CURL_SHORT_VALUE: Record<string, string> = { o: "output", w: "write-out", D: "dump-header", m: "max-time", H: "header", A: "user-agent" };
const CURL_LONG_BOOL = new Set(["--fail", "--silent", "--show-error", "--include", "--head", "--compressed", "--http1.1", "--http2", "--verbose", "--fail-with-body", "--ipv4", "--ipv6", "--no-keepalive"]);
const CURL_LONG_VALUE: Record<string, string> = { "--output": "output", "--write-out": "write-out", "--dump-header": "dump-header", "--max-time": "max-time", "--connect-timeout": "max-time", "--retry": "max-time", "--retry-delay": "max-time", "--header": "header", "--user-agent": "user-agent", "--max-filesize": "max-filesize" };

function curlValueRefusal(kind: string, value: string): string | null {
  if (kind === "output") return value === "/dev/null" ? null : "a producer may only GET; this curl writes an output file";
  if (kind === "dump-header") return value === "-" || value === "/dev/null" ? null : "a producer may only GET; this curl writes a header file";
  // --max-filesize only caps how much is read; a size like 200000 or 200k.
  if (kind === "max-filesize") return /^\d+[kKmMgG]?$/.test(value) ? null : "a producer may only GET; this curl size limit is not a number";
  if (kind === "max-time") return /^\d+(?:\.\d+)?$/.test(value) ? null : "a producer may only GET; this curl timeout is not a number";
  if (value.startsWith("@")) return "a producer may only GET; this curl reads an option value from a file";
  if (kind === "write-out" && writeOutDirective(value) !== null) {
    return `a producer may only GET; this curl write-out uses the %${writeOutDirective(value)}{} directive (%output{} writes files; only %{variable}, %header{} and %time{} read)`;
  }
  return null;
}

/** Named %name{…} directives a write-out may use: both only print (a response header, the time). */
const WRITE_OUT_READ_DIRECTIVES = new Set(["header", "time"]);

/**
 * The first named directive a curl write-out format would act on other than the read-only ones, or
 * null (LOSIntegrity S064). Scanned the way curl 8.7.1 reads it (probed on loopback): `%%` is a
 * literal %, `%{…}` runs to the first `}` and names a variable, `%name{` is a directive (case
 * sensitive; %output{file} creates or appends a file), and a `%` before anything else, or at the
 * end, is printed as is (`100%`). So `%x%output{f}` writes f and is caught, while `%%output{f}`,
 * `%{a%output{f}}` and `100%` only print.
 */
function writeOutDirective(format: string): string | null {
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== "%") continue;
    const next = format[i + 1];
    if (next === "%") { i++; continue; }
    if (next === "{") { const close = format.indexOf("}", i + 2); i = close < 0 ? i + 1 : close; continue; }
    const named = /^([A-Za-z_][A-Za-z0-9_]*)\{/.exec(format.slice(i + 1));
    if (named && !WRITE_OUT_READ_DIRECTIVES.has(named[1]!)) return named[1]!;
  }
  return null;
}

// ripgrep options a producer may use (LOSIntegrity S063): every option ripgrep 15.2.0 documents
// except the four that spawn a program (--pre, --pre-glob, --hostname-bin, -z/--search-zip). An
// allowlist, so whatever rg adds next is refused until it is reviewed. -f/--file and --ignore-file
// read a file, as an rg path operand does; -f takes its path only as a separate word, so the path
// is resolved and checked against the secret zones like any operand (an attached `-fPATH` is not).
const RG_SHORT_BOOL = new Set(["i", "s", "S", "w", "x", "v", "c", "l", "n", "N", "F", "o", "u", "H", "I", "L", "U", "P", "0", "q", "a", "b", "p", "h", ".", "V"]);
const RG_SHORT_VALUE = new Set(["e", "f", "g", "t", "T", "A", "B", "C", "m", "d", "E", "M", "j", "r"]);
/** Short value options whose value is a path: only the separate-word form is accepted. */
const RG_SHORT_PATH_VALUE = new Set(["f"]);
const RG_LONG_BOOL = new Set([...[
  "auto-hybrid-regex", "binary", "block-buffered", "byte-offset", "column", "crlf", "fixed-strings", "follow", "glob-case-insensitive", "heading",
  "hidden", "ignore", "ignore-dot", "ignore-exclude", "ignore-files", "ignore-global", "ignore-messages", "ignore-parent", "ignore-vcs",
  "ignore-file-case-insensitive", "include-zero", "invert-match", "json", "line-buffered", "line-number", "max-columns-preview", "messages", "mmap",
  "multiline", "multiline-dotall", "one-file-system", "pcre2", "pcre2-unicode", "require-git", "sort-files", "stats", "text", "trim", "unicode",
].flatMap((o) => [`--${o}`, `--no-${o}`]),
  "--case-sensitive", "--no-config", "--no-context-separator", "--count", "--count-matches", "--debug", "--trace", "--no-encoding", "--files",
  "--files-with-matches", "--files-without-match", "--help", "--ignore-case", "--line-regexp", "--null", "--print0", "--null-data", "--only-matching",
  "--passthru", "--passthrough", "--pcre2-version", "--no-pre", "--pretty", "--quiet", "--no-search-zip", "--smart-case", "--stop-on-nonmatch",
  "--type-list", "--unrestricted", "--version", "--vimgrep", "--with-filename", "--no-filename", "--word-regexp"]);
const RG_LONG_VALUE = new Set(["--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--type-clear", "--after-context",
  "--before-context", "--context", "--max-count", "--max-depth", "--maxdepth", "--max-filesize", "--sort", "--sortr", "--color", "--colors", "--encoding",
  "--engine", "--max-columns", "--threads", "--replace", "--path-separator", "--context-separator", "--field-match-separator",
  "--field-context-separator", "--ignore-file", "--dfa-size-limit", "--regex-size-limit", "--hyperlink-format", "--generate"]);

/** Why an rg argv (already tokenized, `rg` first) could do more than read, or null. */
export function rgRefusal(tokens: string[]): string | null {
  const args = tokens.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break; // everything after is a pattern or path operand
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (RG_LONG_BOOL.has(name) && eq < 0) continue;
      if (RG_LONG_VALUE.has(name)) { if (eq < 0) i++; continue; }
      return `rg option ${name} is not on the read-only list; a producer only reads (no preprocessors or spawned programs)`;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j]!;
        if (RG_SHORT_BOOL.has(c)) continue;
        if (RG_SHORT_VALUE.has(c)) {
          if (j === a.length - 1) i++;
          else if (RG_SHORT_PATH_VALUE.has(c)) return `rg -${c} takes its path as a separate word here (\`-${c} <path>\`), so the path is checked like any operand`;
          break;
        }
        return `rg option -${c} is not on the read-only list; a producer only reads (no preprocessors or spawned programs)`;
      }
    }
  }
  return null;
}

/** IPv4 dotted quad → 32-bit number; null when not exactly four decimal octets. */
function ipv4Number(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!;
}

/** True for an IPv4 address that is not on the public internet: this-network, private, CGNAT, loopback, link-local, benchmark, multicast, reserved. */
export function nonPublicIpv4(n: number): boolean {
  // Each range is [first octet, second octet, prefix bits]; the remaining octets of every base are zero.
  const inNet = (o1: number, o2: number, bits: number) => { const b = ((o1 << 24) >>> 0) + (o2 << 16); const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return ((n & mask) >>> 0) === ((b & mask) >>> 0); };
  const ranges: Array<[number, number, number] | [number, number, number, number]> = [[0, 0, 8], [10, 0, 8], [100, 64, 10], [127, 0, 8], [169, 254, 16], [172, 16, 12], [192, 0, 24, 0],
    [192, 0, 24, 2], [192, 168, 16], [198, 18, 15], [198, 51, 24, 100], [203, 0, 24, 113], [224, 0, 4], [240, 0, 4]];
  return ranges.some(([o1, o2, bits, o3]) => o3 === undefined ? inNet(o1, o2, bits) : inNet(o1, o2, 0) && ((n >>> 8) & 0xffffff) === ((((o1 << 16) | (o2 << 8) | o3)) & 0xffffff));
}

/** True for an IPv6 literal (no brackets) that is loopback, unspecified, link-local, unique-local, multicast, or maps/embeds a non-public IPv4. */
export function nonPublicIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (/^fe[89ab]/.test(h) || /^f[cd]/.test(h) || /^ff/.test(h)) return true;
  // IPv4-mapped / -compatible / NAT64 forms carry an IPv4 address in the low 32 bits.
  const dotted = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h)?.[1];
  if (dotted) { const n = ipv4Number(dotted); return n === null || nonPublicIpv4(n) || /^::(?:ffff:)?/.test(h); }
  const hexTail = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hexTail) return nonPublicIpv4(((parseInt(hexTail[1]!, 16) << 16) >>> 0) + parseInt(hexTail[2]!, 16));
  return false;
}

/**
 * Why an http(s) URL's destination is not a public internet host, or null when
 * it is. Refuses userinfo, IP literals in loopback/private/link-local/reserved
 * ranges (any IPv4 spelling the WHATWG parser normalises: decimal, hex, short
 * forms), reserved names (localhost, .local, .internal, .home.arpa) and
 * single-label names that only a local resolver answers. Shared by every
 * outbound fetch a producer or tool makes from untrusted input.
 */
export function destinationRefusal(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return `not a valid URL: ${raw}`; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `scheme ${u.protocol} is not http(s)`;
  if (u.username || u.password) return "the URL carries credentials";
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return "the URL names no host";
  if (host.includes(":")) return nonPublicIpv6(host) ? `${host} is not a public address` : null;
  const v4 = ipv4Number(host);
  if (v4 !== null) return nonPublicIpv4(v4) ? `${host} is not a public address` : null;
  if (/^[0-9.]+$|^0x/i.test(host)) return `${host} is not a valid public host`;
  if (host === "localhost" || /\.(?:localhost|local|internal|intranet|lan|home\.arpa|localdomain)$/.test(host)) return `${host} is a reserved local name`;
  if (!host.includes(".")) return `${host} is a single-label name only a local resolver answers`;
  return null;
}

/**
 * Walk curl's arguments (program name excluded) with each allowlisted option's
 * arity: the indexes curl reads as URL operands, or why the argv is refused.
 * One walker, so the check (curlRefusal) and the pin (pinProducerArgv) agree on
 * which words are destinations; a URL-shaped option value is a value.
 */
function curlWalk(args: string[]): { refused: string } | { operands: number[]; family: 4 | 6 | null } {
  const operands: number[] = [];
  const families = new Set<4 | 6>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return { refused: "a producer may only GET; this curl ends option parsing" };
    if (a.startsWith("--")) {
      if (a === "--ipv4") families.add(4);
      if (a === "--ipv6") families.add(6);
      if (CURL_LONG_BOOL.has(a)) continue;
      const kind = CURL_LONG_VALUE[a];
      if (!kind) return { refused: `a producer may only GET; curl option ${a} is not allowed` };
      const v = args[++i];
      if (v === undefined) return { refused: `a producer may only GET; curl ${a} has no value` };
      const r = curlValueRefusal(kind, v); if (r) return { refused: r };
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j]!;
        if (CURL_SHORT_BOOL.has(c)) continue;
        const kind = CURL_SHORT_VALUE[c];
        if (!kind) return { refused: `a producer may only GET; curl option -${c} is not allowed` };
        const attached = a.slice(j + 1);
        const v = attached || args[++i];
        if (v === undefined) return { refused: `a producer may only GET; curl -${c} has no value` };
        const r = curlValueRefusal(kind, v); if (r) return { refused: r };
        break;
      }
      continue;
    }
    if (!/^https?:\/\//i.test(a)) return { refused: "a producer may only GET; a curl operand must be an http(s) URL" };
    const dest = destinationRefusal(a);
    if (dest) return { refused: `a producer may only GET a public host; ${dest}` };
    operands.push(i);
  }
  if (families.size > 1) return { refused: "a producer may only GET; this curl sets both --ipv4 and --ipv6" };
  const [family = null] = families;
  return operands.length ? { operands, family } : { refused: "a producer may only GET; this curl names no URL" };
}

/**
 * Fixed GET-only curl: every option must be on the allowlist, output goes to
 * stdout or /dev/null, and every operand is an http(s) URL (no file://, ftp, or
 * config) whose host is a public internet destination. Combined short flags,
 * JSON bodies, output files, redirects and address overrides cannot slip past.
 * This check does no DNS. validateProducer, whose argv the callers spawn, also
 * resolves every name once and pins curl to the checked address
 * (pinProducerArgv, LOSIntegrity S065).
 */
export function curlRefusal(tokens: string[]): string | null {
  const walk = curlWalk(tokens.slice(1));
  return "refused" in walk ? walk.refused : null;
}

export interface ProducerOptions {
  /** Resolution seam for curl hosts; defaults to one system lookup. Throws when the name does not resolve. */
  resolveHost?: (host: string) => string[];
}

/**
 * The producer as it will run: parsed without a shell, checked against the
 * allowlist and the guard's secret zones, and for curl resolved once and pinned
 * to the public address that was checked (LOSIntegrity S065). The returned argv
 * is what the callers spawn, so nothing is checked here that does not also run.
 * Throws with the reason when the producer may not run.
 */
export function validateProducer(producer: string, isaPath?: string, opts: ProducerOptions = {}): Producer {
  const checked = checkProducer(producer, isaPath);
  if ("argv" in checked && checked.argv[0] === "curl") return { argv: pinProducerArgv(checked.argv, opts.resolveHost ?? resolveHostOnce) };
  return checked;
}

/**
 * Parse one command without shell expansion; reuse the guard's secret-zone policy.
 * Structural only: a curl argv here is not yet pinned, so it is never spawned. A
 * question file is checked with this at load time; validateProducer runs it at
 * execution time.
 */
function checkProducer(producer: string, isaPath?: string): Producer {
  if (sourceKind(producer)) return { source: parseStateSource(producer, isaPath ? dirname(resolve(isaPath)) : process.cwd()) };
  const denied = (value: string) => touchesSecret(value) || PRODUCER_SECRET_RE.test(normalizeCommand(value)) || /(?:^|\/)LIFEOS\/USER(?:\/|$)/i.test(normalizeCommand(value));
  if (denied(producer)) throw new Error("producer denied path: guard secret zone or LIFEOS/USER");
  const tokens = tokenizeProducer(producer);
  const root = isaPath ? realpathSync(dirname(resolve(isaPath))) : undefined;
  for (const arg of tokens) {
    if (denied(arg)) throw new Error("producer denied path: guard secret zone or LIFEOS/USER");
    // Resolve path operands too: traversal and symlinks cannot hide a denied zone.
    for (const candidate of [arg, ...arg.split(/[\s='"(),]+/)]) {
      if (!candidate || candidate.startsWith("-") || candidate.includes("://")) continue;
      const path = resolve(root ?? process.cwd(), candidate);
      const canonical = existsSync(path) ? realpathSync(path) : path;
      if (denied(path) || denied(canonical)) throw new Error("producer denied path: resolved guard secret zone or LIFEOS/USER");
    }
  }
  // `bun` on the allowlist is arbitrary code execution: the loop above only
  // checks operands against the DENIED zones, so `bun ~/anything.ts` passes.
  // A bun producer's script must resolve inside the ISA directory or under
  // LIFEOS/TOOLS — the two places whose contents are already ours.
  if (tokens[0] === "curl") {
    const refusal = curlRefusal(tokens);
    if (refusal) throw new Error(`producer denied curl: ${refusal}`);
  }
  if (tokens[0] === "bun") {
    const modeRefusal = bunModeRefusal(tokens);
    if (modeRefusal) throw new Error(modeRefusal.startsWith("producer denied") ? modeRefusal : `producer denied bun: ${modeRefusal}`);
    const toolsRoot = realpathSync(resolve(dirname(new URL(import.meta.url).pathname), ".."));
    const pathShaped = (a: string) => a.includes("/") || /\.[cm]?[jt]sx?$/.test(a);
    for (const arg of tokens.slice(1)) {
      if (arg.startsWith("-") || BUN_SUBCOMMANDS.has(arg) || !pathShaped(arg)) continue;
      let canonical: string;
      try { canonical = realpathSync(resolve(root ?? process.cwd(), arg)); }
      catch { throw new Error(`producer denied bun scope: ${arg} does not resolve to a file`); }
      const inside = (base: string | undefined) => !!base && (canonical === base || canonical.startsWith(`${base}/`));
      if (!inside(root) && !inside(toolsRoot)) {
        throw new Error("producer denied bun scope: a bun script must resolve inside the ISA directory or under LIFEOS/TOOLS");
      }
    }
  }
  if (tokens[0] === "rg") {
    const refusal = rgRefusal(tokens);
    if (refusal) throw new Error(`producer denied rg: ${refusal}`);
    // The executed argv never loads a ripgrep config file, which could add --pre behind the producer.
    return { argv: tokens[1] === "--no-config" ? tokens : ["rg", "--no-config", ...tokens.slice(1)] };
  }
  if ((PRODUCER_COMMANDS as readonly string[]).includes(tokens[0] ?? "")) return { argv: tokens };
  if (tokens.length === 1 && root) {
    const file = realpathSync(resolve(root, tokens[0]!));
    const rel = relative(root, file);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel) || !statSync(file).isFile()) {
      throw new Error("producer denied file: must be inside ISA directory");
    }
    return { file };
  }
  throw new Error("producer denied command: expected an allowlisted command or in-directory file");
}

export function validateGlanceQuestion(raw: unknown, isaPath?: string): GlanceQuestion {
  if (!object(raw)) throw new Error("question file must contain an object");
  for (const key of ["id", "claim", "instructions", "caller"]) {
    if (!text(raw[key])) throw new Error(`question file requires ${key}`);
  }
  if (!object(raw.state) || !text(raw.state.producer)) throw new Error("question file requires state.producer");
  // Load time: the structural check. The run re-checks and pins through validateProducer.
  checkProducer(raw.state.producer, isaPath);
  if (!["noul", "score", "choice"].includes(String(raw.kind))) throw new Error("question file kind must be noul, score or choice");
  if (raw.kind === "score" && (!Array.isArray(raw.criteria) || !raw.criteria.length || !raw.criteria.every(text))) {
    throw new Error("score question file requires ordered non-empty criteria");
  }
  if (raw.kind === "choice" && (!object(raw.options) || !Object.keys(raw.options).length ||
    !Object.entries(raw.options).every(([k, v]) => text(k) && (v === null || text(v))))) {
    throw new Error("choice question file requires options");
  }
  if (raw.kind === "noul" && raw.criteria !== undefined && (!object(raw.criteria) ||
    !Object.entries(raw.criteria).every(([k, v]) => ["true", "false"].includes(k) && text(v)))) {
    throw new Error("noul question file criteria must name true or false");
  }
  return raw as unknown as GlanceQuestion;
}

export function loadGlanceQuestion(isaPath: string, tool: string): GlanceQuestion {
  const m = /^glance:([A-Za-z0-9_-]+)(?:\.json)?#([A-Za-z0-9_.-]+)$/.exec(tool);
  if (!m) throw new Error("invalid glance pointer (expected glance:<question-file>#<question-id>)");
  const root = realpathSync(join(dirname(isaPath), "Questions"));
  const path = realpathSync(join(root, `${m[1]}.json`));
  if (relative(root, path).startsWith("..")) throw new Error("question file escapes Questions directory");
  const question = validateGlanceQuestion(JSON.parse(readFileSync(path, "utf8")), isaPath);
  if (question.id !== m[2]) throw new Error(`question file id mismatch: expected ${m[2]}`);
  return question;
}

export function engineQuestion(q: GlanceQuestion): Question {
  if (q.kind === "score") return { type: "score", instructions: q.instructions, criteria: q.criteria as string[] };
  if (q.kind === "choice") return { type: "choice", instructions: q.instructions, criteria: q.options! };
  return { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria as { true?: string; false?: string } } : {}) };
}

const MUTATING_WORDS = /\b(deploy|publish|push|release|ship|purge|ingest|upload|delete|destroy|remove|migrate|seed|reset|revert|rollback|install|write|send|sync|prune|clean|format|fix)\b/i;
/** The only git subcommands that cannot change a repository. */
const READ_ONLY_GIT = new Set(["log", "show", "diff", "status", "ls-files", "rev-parse", "cat-file", "describe", "blame"]);
/** The only option git may take before its subcommand: -c, -C, --git-dir, --exec-path and the rest move the repo or run code. */
const GIT_GLOBAL_OPTIONS = new Set(["--no-pager"]);
/**
 * Options a read-only git subcommand may take. An allowlist, so
 * --output, --ext-diff, --textconv, --filters, --open-files-in-pager and whatever git adds next are
 * refused by construction. Value options are accepted only in their attached `--x=value` form, so a
 * separate value can never be read as an option or an operand.
 */
const GIT_SAFE_FLAG = /^(?:-\d+|-[pnisztuwbcaM]|-U\d+|-M\d*%?|--(?:no-ext-diff|no-textconv|no-renames|no-color|full-history|oneline|stat|shortstat|numstat|name-only|name-status|others|ignored|exclude-standard|directory|cached|staged|modified|deleted|short|porcelain|abbrev-ref|show-toplevel|show-prefix|is-inside-work-tree|tags|always|reverse|patch|no-patch|first-parent|merges|no-merges|all|summary|ignore-all-space|ignore-space-change|minimal|long|verify|quiet|branch|graph|decorate|no-decorate|date-order|topo-order|follow|exit-code|word-diff|abbrev|exists))$/;
const GIT_SAFE_VALUE_FLAG = /^--(?:unified|format|pretty|max-count|skip|since|until|after|before|author|committer|grep|abbrev|color|date|diff-filter|dirstat|stat|word-diff|relative|decorate|porcelain|untracked-files|ignore-submodules|find-renames|find-copies|batch-check)=[^\0]*$/;

/** Why a git argv (already tokenized, `git` first) is not a read-only producer, or null. */
function gitRefusal(tokens: string[]): string | null {
  let i = 1;
  while (i < tokens.length && tokens[i]!.startsWith("-")) {
    if (!GIT_GLOBAL_OPTIONS.has(tokens[i]!)) return `git option ${tokens[i]} before the subcommand is not allowed; a producer only reads`;
    i++;
  }
  const sub = tokens[i];
  if (!sub || !READ_ONLY_GIT.has(sub)) return `git ${sub ?? ""} is not one of the read-only subcommands`;
  for (let j = i + 1; j < tokens.length; j++) {
    const a = tokens[j]!;
    if (a === "--") break; // everything after is a pathspec
    if (!a.startsWith("-")) continue; // a revision or path operand
    if (GIT_SAFE_FLAG.test(a) || GIT_SAFE_VALUE_FLAG.test(a)) continue;
    return `git ${sub} option ${a} is not on the read-only list; a producer only reads`;
  }
  return null;
}

/**
 * Why a `package.json` script body is not a reviewed read-only producer
 * (S063). Bun runs a script body
 * through its shell, so the body is accepted only when the shell would run
 * exactly the argv a direct producer of the same text would run:
 *
 * - The shared shell parser (shell-commands.shellSteps) must see one simple
 *   command at the top level, with no substitution, nested shell, env
 *   assignment, wrapper or redirect, and its argv must equal the producer
 *   tokenizer's. A quoted `"$(…)"` the tokenizer reads as text is a nested
 *   command to the parser, and the mismatch refuses it.
 * - No word may hold anything the shell expands, judged with the quoting intact
 *   (lexProducer): an unquoted glob, brace or ~, or a $, backtick or backslash
 *   inside double quotes. A direct producer passes those to the program as
 *   text, a script hands them to the shell first. Single-quoted text is literal
 *   to the shell, so `jq '.items[]' x` and `rg --glob '*.ts' …` pass.
 * - Arguments forwarded on the producer (`bun run grep --pre=sh`) are appended
 *   by Bun to the body as literal words (Bun 1.3.6, probed), so the body is
 *   judged with them appended, single-quoted here so the shell parser reads
 *   them literally too. A forwarded word holding a single quote is refused
 *   rather than re-escaped.
 * - The body passes the same checks a producer does (checkProducer: secret
 *   zones, LIFEOS/USER, bun scope; and this read-only check), and the argv
 *   checkProducer would execute must be the body's own (for rg, the body with
 *   the `--no-config` checkProducer adds). A curl body is refused because a
 *   script's curl cannot be pinned to the address it was checked against.
 */
function scriptBodyRefusal(name: string, scriptBody: string, isaDir: string, forwarded: readonly string[] = []): string | null {
  const say = (why: string) => `the \`${name}\` script${forwarded.length ? " with its forwarded arguments" : ""} ${why}; a producer only reads`;
  const quoteless = forwarded.find((a) => a.includes("'"));
  if (quoteless !== undefined) return say(`has a forwarded argument holding a single quote (${quoteless})`);
  // Bun drops a `--` right after the script name and keeps a later one (probed), so the words the
  // program sees depend on where it sits; `bun run grep -- --pre=sh` hands rg `--pre=sh` as an option.
  if (forwarded.includes("--")) return say("forwards a `--`, which Bun may drop before the script sees it");
  const body = [scriptBody, ...forwarded.map((a) => `'${a}'`)].join(" ");
  let words: ProducerWord[];
  try { words = lexProducer(body); }
  catch (e) { return say(`is not one plain command (${(e as Error).message})`); }
  const tokens = words.map((w) => w.text);
  const expanding = words.find((w) => w.expands !== null);
  if (expanding !== undefined) return say(`has a word the shell would expand (${expanding.text})`);
  const walk = shellSteps(body);
  const only = walk.steps.length === 1 ? walk.steps[0]! : undefined;
  if (walk.tooDeep || !only || only.depth !== 0 || Object.keys(only.env).length || only.wrappers.length || only.writeTargets.length ||
    only.argv.length !== tokens.length || only.argv.some((w, i) => w !== tokens[i])) {
    return say("does not parse as exactly the one plain command it reads as");
  }
  const head = tokens[0] ?? "";
  if (head === "bun" || !(PRODUCER_COMMANDS as readonly string[]).includes(head)) {
    return say(`runs \`${head}\`, which is not a reviewed read-only producer command`);
  }
  if (head === "curl") return say("runs curl, which a script cannot pin to the address it was checked against");
  const inner = readOnlyRefusal(body, isaDir);
  if (inner) return say(`is not read-only: ${inner}`);
  let checked: Producer;
  try { checked = checkProducer(body, join(isaDir, "ISA.md")); }
  catch (e) { return say(`is refused as a producer (${(e as Error).message})`); }
  // checkProducer runs an rg producer as `rg --no-config …`; a script body cannot be rewritten, so its
  // rg runs as written. That is the original behaviour (a config file comes only from the inherited
  // RIPGREP_CONFIG_PATH, which the spawning caller owns); every word of the body is still judged.
  const expected = head === "rg" && tokens[1] !== "--no-config" ? ["rg", "--no-config", ...tokens.slice(1)] : tokens;
  if (!("argv" in checked) || checked.argv.length !== expected.length || checked.argv.some((w, i) => w !== expected[i])) {
    return say("would run something other than the producer checked");
  }
  return null;
}

export function readOnlyRefusal(command: string, isaDir: string): string | null {
  if (sourceKind(command)) {
    try { checkProducer(command, join(isaDir, "ISA.md")); return null; }
    catch (e) { return (e as Error).message; }
  }
  // Tokenize once and classify that argv, the same one validateProducer returns and the caller runs
  // (LOSIntegrity S062): a quoted or escaped executable name (`"git" config`) is still git. When the
  // text is not one plain command, the head is read with quotes, escapes and `$` removed, so it cannot
  // hide which branch below applies, and those branches refuse what does not tokenize.
  let tokens: string[] | null = null;
  let tokenError = "";
  try { tokens = tokenizeProducer(command); } catch (e) { tokenError = (e as Error).message; }
  const head = tokens ? (tokens[0] ?? "") : (command.trim().split(/\s+/)[0] ?? "").replace(/[\\"'$]/g, "");
  if (MUTATING_WORDS.test(command)) return `the command names a mutating action (${command.match(MUTATING_WORDS)![0]}); a producer only reads`;
  if (!tokens) return ["curl", "git", "bun", "rg"].includes(head) ? tokenError : null;
  if (head === "curl") {
    // A literal scan of the whitespace-split text, kept from the original check: it reads every word
    // the author spelled, quoted values included, so it can only refuse more. The tokenized argv is
    // judged by curlRefusal with each option's arity, where `-A -X` is a user-agent value and a
    // quoted "-X" is still the method option (refused there as not on the allowlist).
    const words = command.trim().split(/\s+/);
    if (words.some((a) => a === "-X" || a === "--request")) return "a producer may only GET; this curl sets a method";
    if (words.some((a) => ["-d", "--data", "-T", "--upload-file", "-F", "--form"].includes(a))) return "a producer may only GET; this curl sends a body";
    const refusal = curlRefusal(tokens);
    if (refusal) return refusal;
  }
  if (head === "git") {
    // Tokenized, not whitespace-split: a quoted "--output=x" is the same option to git.
    const refusal = gitRefusal(tokens);
    if (refusal) return refusal;
  }
  if (head === "rg") {
    const refusal = rgRefusal(tokens);
    if (refusal) return refusal;
  }
  if (head === "bun") {
    if (tokens.length === 1) return "a bare `bun` reads nothing";
    const modeRefusal = bunModeRefusal(tokens);
    if (modeRefusal) return modeRefusal;
    // `bun run <script>` hides whatever the script does, so resolve the body. Leading bun flags
    // (`bun --silent run x`) do not move the subcommand out of view. Bun runs `pre<name>` before
    // and `post<name>` after the script (with no arguments), and appends the words after the name
    // to the script itself (Bun 1.3.6, probed), so every body that runs is judged as it runs.
    const target = bunRunTarget(tokens);
    if (target) {
      const { script, forwarded } = target;
      // The script must be spelled as the plain word right after a plain `run` (`bun run read`,
      // `bun --silent run read`), so the name a reader of the question file sees is, word for word,
      // the name looked up and run. A quoted name or a bun flag between `run` and the name is
      // refused, as the original whitespace lookup refused it (it found no such script). Anchored to
      // the FIRST plain `run`, so a forwarded `run <name>` later in the line cannot spell it.
      const words = command.trim().split(/\s+/);
      const at = words.indexOf("run");
      if (at < 0 || words[at + 1] !== script) {
        return `spell the script as the plain word right after \`run\` (\`bun run ${script}\`), with no quotes or bun flags between them`;
      }
      let scripts: Record<string, unknown> | undefined;
      try {
        const pkg = JSON.parse(readFileSync(join(isaDir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
        scripts = object(pkg.scripts) ? pkg.scripts : undefined;
      } catch { return `cannot read package.json to see what \`${script}\` does, so it is not safe to run`; }
      const own = (n: string) => scripts !== undefined && Object.prototype.hasOwnProperty.call(scripts, n);
      if (!own(script) || !text(scripts![script])) return `package.json has no \`${script}\` script`;
      const runs: Array<[string, readonly string[]]> = [];
      if (own(`pre${script}`)) runs.push([`pre${script}`, []]);
      runs.push([script, forwarded]);
      if (own(`post${script}`)) runs.push([`post${script}`, []]);
      for (const [n, args] of runs) {
        const body = scripts![n];
        if (typeof body !== "string") return `the \`${n}\` script is not a command string, so it is not safe to run`;
        if (MUTATING_WORDS.test(body)) return `the \`${n}\` script mutates (${body.match(MUTATING_WORDS)![0]}); a producer only reads`;
        const bodyRefusal = scriptBodyRefusal(n, body, isaDir, args);
        if (bodyRefusal) return bodyRefusal;
      }
    }
  }
  return null;
}

/**
 * The script a tokenized `bun ... run ... <name> ...` executes, past the bun flags on either side of
 * `run`, and the words after the name that Bun forwards to it; null when it is not `bun run`. Read
 * by parseBun, the same reading bunModeRefusal checks, never a second walk.
 */
function bunRunTarget(tokens: string[]): { script: string; forwarded: string[] } | null {
  const parsed = parseBun(tokens);
  return "mode" in parsed && parsed.mode === "run" ? { script: parsed.script, forwarded: parsed.forwarded } : null;
}

/** The options a pinned curl starts with: -q (skip ~/.curlrc; only honoured first), no proxy, no URL globbing. */
const CURL_PIN_PREFIX = ["-q", "--noproxy", "*", "--globoff"] as const;
/**
 * A host curl looks up as written: a plain dotted name, optionally absolute (one trailing dot). curl
 * 8.7.1 looks an absolute name up in its cache with the dot (probed on loopback), so both spellings
 * are pinned to the same checked address and the --resolve key matches whichever form curl uses.
 */
const PLAIN_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.?$/;

/**
 * The argv to execute for a curl producer (LOSIntegrity S065). The literal check in curlRefusal
 * cannot see what a name resolves to. Here every URL operand (found by curl's own option arity, so
 * a URL-shaped option value is a value) is executed as the canonical `href` of the URL that was
 * checked, its host must be an IP literal or a plain dotted name, each name is resolved exactly once,
 * every address it answers with must be public (SafeFetch.addressClass), and curl is pinned to the
 * first with --resolve so it cannot re-resolve at connect time. -q skips ~/.curlrc, --noproxy *
 * keeps an inherited proxy from carrying the request elsewhere, and --globoff stops `{a,b}` or
 * `[1-9]` expanding into hosts nobody checked. A name that does not resolve is refused, never run
 * unpinned. Given its own output it strips the pins and pins again from scratch, never trusting an
 * earlier answer. Any other argv comes back unchanged. Throws with the reason when it may not run.
 */
export function pinProducerArgv(argv: string[], resolveHost: (host: string) => string[] = resolveHostOnce): string[] {
  if (argv[0] !== "curl") return argv;
  let rest = argv.slice(1);
  if (rest[0] === "-q") {
    // Producer text cannot spell -q (curlRefusal refuses it), so this is a form this function wrote.
    if (CURL_PIN_PREFIX.some((w, i) => rest[i] !== w)) throw new Error("producer denied curl: -q outside the pinned form");
    rest = rest.slice(CURL_PIN_PREFIX.length);
    while (rest[0] === "--resolve") {
      if (rest[1] === undefined) throw new Error("producer denied curl: --resolve has no value");
      rest = rest.slice(2);
    }
  }
  const walk = curlWalk(rest);
  if ("refused" in walk) throw new Error(`producer denied curl: ${walk.refused}`);
  const run = [...rest];
  const pins: string[] = [];
  const seen = new Set<string>();
  for (const i of walk.operands) {
    const u = new URL(rest[i]!);
    run[i] = u.href;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!isIP(host) && !PLAIN_HOST.test(host)) throw new Error(`producer denied curl: host ${JSON.stringify(host)} is not an IP address or a plain dotted name`);
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    let addresses: string[];
    if (isIP(host)) addresses = [host];
    else {
      try { addresses = resolveHost(host); }
      catch (e) { throw new Error(`producer denied curl: ${host} does not resolve (${(e as Error)?.message ?? String(e)})`); }
      if (!Array.isArray(addresses) || addresses.length === 0) throw new Error(`producer denied curl: ${host} resolves to no address`);
    }
    for (const addr of addresses) {
      const bare = typeof addr === "string" ? addr.replace(/%.*$/, "") : "";
      if (!isIP(bare)) throw new Error(`producer denied curl: ${host} answered with something that is not an address`);
      const cls = addressClass(bare);
      if (cls !== "public") throw new Error(`producer denied curl: ${host} resolves to ${bare}, a ${cls} address, not public`);
    }
    if (isIP(host)) continue;
    const keys = [...new Set([host, host.replace(/\.$/, "")])].map((h) => `${h}:${port}`).filter((k) => !seen.has(k));
    if (!keys.length) continue;
    for (const k of keys) seen.add(k);
    // The pin must be in the family curl is told to use: given --ipv4 with an IPv6 pin (or the
    // reverse) curl discards the pin ("doesn't have needed family, zapped") and resolves the name
    // again at connect time, which a rebinding answer can point anywhere (S065, final review).
    const pinnable = addresses.map((a) => a.replace(/%.*$/, "")).filter((a) => walk.family === null || isIP(a) === walk.family);
    if (!pinnable.length) throw new Error(`producer denied curl: ${host} has no IPv${walk.family} address to pin, and curl would drop a pin of the other family and resolve again`);
    const addr = pinnable[0]!;
    for (const key of keys) pins.push("--resolve", `${key}:${isIP(addr) === 6 ? `[${addr}]` : addr}`);
  }
  return ["curl", ...CURL_PIN_PREFIX, ...pins, ...run];
}

/**
 * The addresses `host` resolves to, looked up once by the system resolver in a short-lived child
 * (producer validation and execution are synchronous). The host is an argv element, never code.
 * Throws when it does not resolve.
 */
function resolveHostOnce(host: string): string[] {
  const p = Bun.spawnSync([process.execPath, "--env-file=/dev/null", "-e",
    "require('node:dns').lookup(process.argv[1],{all:true,verbatim:true},(e,a)=>{if(e){console.error(e.code||e.message);process.exit(1)}console.log(JSON.stringify(a.map((x)=>x.address)))})",
    host], { stdout: "pipe", stderr: "pipe", timeout: 10_000, env: { PATH: process.env.PATH ?? "" } });
  if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr).trim() || "lookup failed");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(p.stdout));
  if (!Array.isArray(parsed)) throw new Error("lookup returned no address list");
  return parsed.map(String);
}
