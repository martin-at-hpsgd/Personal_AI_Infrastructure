/**
 * ForeignDataCheck — structural detection of personal/foreign data inside the
 * system repo (~/.claude).
 *
 * Born from the 2026-08-11 lifelog incident: a concurrent session's
 * relative-write bug mirrored an absolute filesystem path INSIDE the repo
 * (LIFEOS/Users/<name>/.../lifelog-monitor-<id>.json) holding personal
 * conversation transcripts. A checkpoint commit then git-tracked the files, and
 * the release cut caught them only because the transcript CONTENT happened to
 * contain a home-path string. This module makes the catch structural: the
 * SHAPE of the path and the SHAPE of the content are each sufficient, no
 * content-string luck required.
 *
 * The invariant enforced across its consumers: the only sanctioned
 * personal-data locations inside ~/.claude are the `LIFEOS/USER/` and
 * `LIFEOS/MEMORY/` symlinks into the private USER_DATA repo
 * (~/.config/LIFEOS/USER). Everything else tracked in ~/.claude is SYSTEM and
 * shippable. Contract: LIFEOS/DOCUMENTATION/SystemUserBoundary.md.
 *
 * Consumers (each an independent layer):
 *   - the private repository-update tool — refuses the commit/push
 *   - hooks/CheckpointPerISC.hook.ts          — never stages a foreign path
 *   - the private release builder — checks staging
 *   - LIFEOS/TOOLS/MemorySystem.ts + LIFEOS/PULSE/lib/memory-proposals.ts —
 *     assertInsideUserData() refuses personal writes outside USER_DATA
 *   - ~/.claude/.gitignore carries the same shapes as static patterns
 *
 * Node builtins plus Boundary.confinedPath (the one symlink-aware path walk). Path checks are lexical over
 * repo-RELATIVE paths (git output); filesystem checks use lstat/realpath so a
 * symlinked component can never redirect or defeat them.
 */

import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as pathResolve, sep } from "node:path";
import { confinedPath } from "./Boundary.ts";

// Directory names that exist at an absolute filesystem root (macOS + Linux)
// and therefore appear as path COMPONENTS when a relative-write bug mirrors an
// absolute path into the repo. Case-sensitive on purpose: the bug reproduces
// the exact casing of the real filesystem dir, and case-sensitive matching
// keeps legitimate lowercase code dirs (`src/system/`, `lib/library/`) clean.
export const ABS_MIRROR_SEGMENTS: ReadonlySet<string> = new Set([
  "Users", "home", "private", "var", "tmp", "Volumes", "etc", "opt", "System", "Library",
]);

// Real tracked top-level directories of ~/.claude (git ls-tree HEAD, 2026-08-11).
// Enumerated so a root-level absolute-mirror hit can never flag a legitimate
// repo dir. Currently disjoint from ABS_MIRROR_SEGMENTS — the allowlist is
// belt-and-suspenders for the day a future top-level dir collides.
const REAL_TOP_DIRS: ReadonlySet<string> = new Set([
  ".github", "agents", "backups", "cache", "commands", "hooks", "skills",
  "scratchpad", "teams", "test", "workflows", "Plugins", "LIFEOS",
]);

// Personal-data FILE signatures, matched on the basename only (a directory
// named `lifelog skill` or a doc named `Granola.md` must never hit). Each entry
// names a known personal-export shape.
const PERSONAL_NAME_SIGNATURES: ReadonlyArray<{ test: (base: string) => boolean; label: string }> = [
  // The export family is `lifelog-<kind>-<id>` — monitor, followup, and any
  // future kind. Keyed to the shape (kind word + id), not to specific kinds, so
  // a new variant can't slip the gate the way `lifelog-followup-<id>` did past a
  // `monitor`/`transcript`-only rule (INC 7.38.4). `Lifelog.md`/`lifelog skill` don't
  // match — they lack the `-<kind>-<digit>` export shape.
  { test: (b) => /^lifelog-[a-z]+-\d/i.test(b), label: "lifelog export (Bee wearable / followup transcript)" },
  { test: (b) => /lifelog/i.test(b) && /transcript/i.test(b), label: "lifelog transcript export" },
  // Every `bee` CLI output is `bee-<something>`: bee-list, bee-<id>-transcript,
  // bee-conversation-<id>. A kind allowlist rots the same way the lifelog one did
  // (INC 7.38.4) and missed both real files, so this keys on the prefix and a data
  // extension — `bee-client.ts` and `Bee.md` stay clean.
  { test: (b) => /^bee-.+\.(json|jsonl|csv|txt|md)$/i.test(b), label: "Bee wearable export" },
  { test: (b) => /granola/i.test(b) && /(transcript|export)/i.test(b), label: "Granola meeting export" },
];

export interface ForeignCheckResult {
  foreign: boolean;
  reason?: string;
}

/**
 * Decide whether a repo-relative path inside ~/.claude is FOREIGN — i.e. must
 * never be tracked in the system repo nor ship in a release.
 *
 * Foreign =
 *   (a) an absolute-filesystem-mirror shape: an absolute-fs dirname
 *       (ABS_MIRROR_SEGMENTS) appearing as a DIRECTORY component at the repo
 *       root or anywhere under LIFEOS/ — the relative-write-bug shape; or
 *   (b) a personal-data file signature by basename (lifelog/Bee/Granola
 *       export names).
 *
 * NOT foreign: anything under the `LIFEOS/USER/` or `LIFEOS/MEMORY/` symlink
 * subtrees — that is legitimately USER data and other gates own whether it may
 * appear in a diff at all. The exclusion matches the symlink NAMES at the
 * boundary (compared case-insensitively for APFS), never by resolving them.
 */
export function isForeignToSystemRepo(
  relPath: string,
  opts: { realTopDirs?: ReadonlySet<string> } = {},
): ForeignCheckResult {
  const topDirs = opts.realTopDirs ?? REAL_TOP_DIRS;
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!norm) return { foreign: false };
  // `git status` reports a fully-untracked directory with a trailing slash
  // (`?? LIFEOS/TOOLS/Users/`) — every segment of such an entry is a directory
  // component, including the last one.
  const isDirEntry = norm.endsWith("/");
  const segs = norm.split("/").filter((s) => s.length > 0 && s !== ".");

  // Sanctioned USER-data subtrees, by symlink name. "USER"/"MEMORY" never
  // collides with the incident's "Users" — different string even case-folded.
  if (segs.length > 1 && segs[0] === "LIFEOS") {
    const second = (segs[1] ?? "").toUpperCase();
    if (second === "USER" || second === "MEMORY") return { foreign: false };
  }

  // (a) absolute-mirror shape at the repo root: first component is an
  // absolute-fs dirname, is a directory component (something under it), and is
  // not a real tracked top-level dir.
  if ((segs.length > 1 || isDirEntry) && ABS_MIRROR_SEGMENTS.has(segs[0]!) && !topDirs.has(segs[0]!)) {
    return {
      foreign: true,
      reason: `absolute-filesystem mirror at repo root: '${segs[0]}/' is an absolute-path dirname, not a system-repo dir (relative-write-bug shape)`,
    };
  }

  // (a) absolute-mirror shape under LIFEOS/: any interior (directory)
  // component that is an absolute-fs dirname. The USER/MEMORY subtrees
  // returned early above.
  if (segs[0] === "LIFEOS") {
    const dirBound = isDirEntry ? segs.length : segs.length - 1;
    for (let i = 1; i < dirBound; i++) {
      if (ABS_MIRROR_SEGMENTS.has(segs[i]!)) {
        return {
          foreign: true,
          reason: `absolute-filesystem mirror under LIFEOS/: '${segs.slice(0, i + 1).join("/")}/' (relative-write-bug shape)`,
        };
      }
    }
  }

  // (b) personal-data file signature by basename.
  const base = segs[segs.length - 1]!;
  for (const sig of PERSONAL_NAME_SIGNATURES) {
    if (sig.test(base)) {
      return { foreign: true, reason: `personal-data filename signature: ${sig.label}` };
    }
  }

  return { foreign: false };
}

// Above this size, JSON.parse is skipped and a bounded head-scan decides. A
// personal transcript this large is still caught (fail-suspicious), just via
// tokens instead of structure.
const TRANSCRIPT_PARSE_CAP_BYTES = 25 * 1024 * 1024;
const TRANSCRIPT_HEAD_SCAN_BYTES = 256 * 1024; // size of each streamed chunk
const TRANSCRIPT_TOKEN_OVERLAP = 4096; // bytes of the previous chunk rescanned, so a split token is found

function isUtteranceLike(el: unknown): boolean {
  if (!el || typeof el !== "object" || Array.isArray(el)) return false;
  const o = el as Record<string, unknown>;
  const hasSpeaker = "speaker" in o;
  const hasStamp = "spoken_at" in o || "spokenAt" in o;
  const hasText = typeof o.text === "string";
  // speaker + timestamp is the strong shape; speaker + text alone qualifies
  // only inside a `transcript`-keyed array (see caller) — that pairing is the
  // documented export shape and the key scopes it away from generic fixtures.
  return hasSpeaker && (hasStamp || hasText);
}

/**
 * The conversation-LIST shape: a `conversations` array whose elements carry a
 * prose `summary` plus a session timestamp. Bee's list export has no
 * `transcript` array at any depth, so the utterance walk below returns clean on
 * it while the file holds full personal conversation summaries.
 */
function isConversationListLike(node: unknown): boolean {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  const c = (node as Record<string, unknown>).conversations;
  if (!Array.isArray(c)) return false;
  return c.slice(0, 5).some((el) => {
    if (!el || typeof el !== "object" || Array.isArray(el)) return false;
    const o = el as Record<string, unknown>;
    return typeof o.summary === "string" && ("start_time" in o || "startTime" in o || "spoken_at" in o);
  });
}

function containsTranscriptArray(node: unknown, depth: number): boolean {
  if (depth < 0 || !node || typeof node !== "object") return false;
  if (Array.isArray(node)) {
    // A bare top-level array of utterances only counts with the strong shape
    // (speaker + timestamp) — text alone is too generic without the
    // `transcript` key scoping it.
    return node.slice(0, 5).some((el) => {
      if (!el || typeof el !== "object" || Array.isArray(el)) return false;
      const o = el as Record<string, unknown>;
      return "speaker" in o && ("spoken_at" in o || "spokenAt" in o);
    });
  }
  const obj = node as Record<string, unknown>;
  if (isConversationListLike(obj)) return true;
  const t = obj.transcript;
  if (Array.isArray(t) && t.slice(0, 5).some(isUtteranceLike)) return true;
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object" && containsTranscriptArray(value, depth - 1)) return true;
  }
  return false;
}

/**
 * Content-signature backstop: does this file structurally look like a personal
 * conversation transcript (Bee/Granola export shape — a `transcript` array
 * whose elements carry `speaker` plus `spoken_at`/`text`)?
 *
 * Deliberately independent of any home-path or identity string in the content
 * — this is the check that catches the incident class even when the transcript
 * text mentions nothing identifying. lstat-based: never follows a symlink.
 */
export type TranscriptInspection =
  | { verdict: "transcript"; reason: string }
  | { verdict: "clean" }
  | { verdict: "error"; reason: string };

/** Token-triple signature over raw text: used for oversize heads and for JSON that will not parse. */
function hasTranscriptTokens(text: string): boolean {
  if (/"conversations"\s*:/.test(text) && /"summary"\s*:/.test(text)
    && /"start_?[tT]ime"\s*:/.test(text)) return true;
  return /"transcript"\s*:/.test(text) && /"speaker"\s*:/.test(text)
    && (/"spoken_?[aA]t"\s*:/.test(text) || /"text"\s*:/.test(text));
}

/**
 * Three-valued form of the transcript backstop. `error` means the file exists
 * and is a regular file but could not be inspected (lstat other than ENOENT,
 * open or read failure): it is a BLOCKING result, never clean. A file that is
 * absent (ENOENT), empty, not a regular file (never followed), or not
 * JSON-shaped is `clean`. JSON that fails to parse (truncated, JSONL) is
 * scanned for the transcript token signature and is `transcript` when it
 * carries it, so a damaged export cannot read as clean.
 */
export function inspectPersonalTranscript(absPath: string): TranscriptInspection {
  let st;
  try { st = lstatSync(absPath); } catch (e: any) {
    if (e?.code === "ENOENT") return { verdict: "clean" };
    return { verdict: "error", reason: `cannot lstat ${absPath} (${e?.code ?? e?.message ?? e})` };
  }
  if (!st.isFile() || st.size === 0) return { verdict: "clean" };

  if (st.size > TRANSCRIPT_PARSE_CAP_BYTES) {
    // Too big to parse whole: stream the WHOLE file for the token triple. A head-only scan
    // reported clean when the signature sat past the first 256 KiB (LOSIntegrity
    // ). Each token is remembered once seen, and every chunk is scanned
    // with the tail of the previous one so a token split across a boundary is still found.
    const seen = { conversations: false, summary: false, startTime: false, transcript: false, speaker: false, spokenAt: false, text: false };
    try {
      const fd = openSync(absPath, "r");
      try {
        const buf = Buffer.alloc(TRANSCRIPT_HEAD_SCAN_BYTES);
        let carry = "";
        let read = 0;
        for (;;) {
          const n = readSync(fd, buf, 0, buf.length, null);
          if (n === 0) break;
          read += n;
          const text = carry + buf.subarray(0, n).toString("latin1");
          seen.conversations ||= /"conversations"\s*:/.test(text);
          seen.summary ||= /"summary"\s*:/.test(text);
          seen.startTime ||= /"start_?[tT]ime"\s*:/.test(text);
          seen.transcript ||= /"transcript"\s*:/.test(text);
          seen.speaker ||= /"speaker"\s*:/.test(text);
          seen.spokenAt ||= /"spoken_?[aA]t"\s*:/.test(text);
          seen.text ||= /"text"\s*:/.test(text);
          carry = text.slice(-TRANSCRIPT_TOKEN_OVERLAP);
        }
        // A file that changed size under the scan was not fully covered: say so, never clean.
        if (read !== st.size) return { verdict: "error", reason: `${absPath} changed size while it was scanned (${read} of ${st.size} bytes)` };
      } finally { closeSync(fd); }
    } catch (e: any) {
      return { verdict: "error", reason: `cannot read ${absPath} (${e?.code ?? e?.message ?? e})` };
    }
    const hit = (seen.conversations && seen.summary && seen.startTime) || (seen.transcript && seen.speaker && (seen.spokenAt || seen.text));
    return hit
      ? { verdict: "transcript", reason: "oversize file carries the transcript token signature" }
      : { verdict: "clean" };
  }

  let text: string;
  try { text = readFileSync(absPath, "utf8"); } catch (e: any) {
    return { verdict: "error", reason: `cannot read ${absPath} (${e?.code ?? e?.message ?? e})` };
  }
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") return { verdict: "clean" };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    // Truncated or JSONL-shaped: structure is unavailable, so decide on tokens.
    return hasTranscriptTokens(text)
      ? { verdict: "transcript", reason: "malformed JSON carrying the transcript token signature" }
      : { verdict: "clean" };
  }
  return containsTranscriptArray(parsed, 3)
    ? { verdict: "transcript", reason: "transcript[] with speaker + spoken_at/text" }
    : { verdict: "clean" };
}

/**
 * Boolean form for the existing callers. FAILS CLOSED: true for a detected
 * transcript AND for an inspection error, so an unreadable file is held back
 * rather than staged or shipped as clean.
 */
export function looksLikePersonalTranscript(absPath: string): boolean {
  return inspectPersonalTranscript(absPath).verdict !== "clean";
}

/**
 * Canonical USER_DATA repo root — where all personal data physically lives.
 *
 * Was hardcoded to `~/.config/LIFEOS/USER`, so any install that relocated its
 * data home (the `--config-dir` / `LIFEOS_CONFIG_DIR` convention every installer
 * tool honours) had its personal writes measured against a root that does not
 * exist — and `assertInsideUserData` fails CLOSED, so those writes were refused
 * outright (public issue #1882, @jacobo-ortiz, @CarbonRaven, @xg-gh-25).
 *
 * Precedence matches LinkUser.ts:38 exactly: an explicit `--config-dir` on the
 * running command, then `LIFEOS_CONFIG_DIR`, then the default. The `$HOME`
 * normalization is the same guard the installer tools carry — a harness that
 * injects the var unexpanded would otherwise resolve a literal `$HOME/…` shadow
 * root (#1404 / PR #1451, author jbmml).
 */
export function userDataConfigDir(): string {
  const i = process.argv.indexOf("--config-dir");
  const flag = i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : undefined;
  const raw = flag || process.env.LIFEOS_CONFIG_DIR;
  if (raw) {
    return /^\$\{?HOME\}?(\/|$)/.test(raw) ? raw.replace(/^\$\{?HOME\}?/, process.env.HOME ?? homedir()) : raw;
  }
  return join(homedir(), ".config", "LIFEOS");
}

/** Canonical USER_DATA repo root — where all personal data physically lives. */
export function userDataRoot(): string {
  return join(userDataConfigDir(), "USER");
}

/**
 * Assert an absolute write target physically resolves INSIDE the USER_DATA
 * repo. Realpath-based on the deepest existing ancestor, so:
 *   - an intact `~/.claude/LIFEOS/USER` (or MEMORY) symlink resolves into
 *     ~/.config/LIFEOS/USER and passes;
 *   - a broken/replaced symlink (real dir inside ~/.claude) resolves under
 *     ~/.claude and is REFUSED — the write would land in the system tree;
 *   - a missing USER_DATA root refuses (fail-closed): a personal write with
 *     nowhere sanctioned to land must error loudly, never fall back.
 */
export function assertInsideUserData(absTarget: string): { ok: true } | { ok: false; reason: string } {
  let root: string;
  try {
    root = realpathSync(userDataRoot());
  } catch (e: any) {
    return { ok: false, reason: `USER_DATA root unresolvable at ${userDataRoot()} (${e?.message ?? e}) — refusing personal-data write (fail-closed)` };
  }

  // Walk the path the way the kernel will (Boundary.confinedPath): each existing component is
  // resolved through the filesystem BEFORE the next one is applied, so `link/../x` goes where the
  // link points and then up, never where a lexical collapse of `..` says (LOSIntegrity S066). A
  // dangling or looping link, a component under a file, or `..` after a missing component is
  // refused. A relative target is taken from the cwd without normalising it first.
  //
  // The original check must pass as well: `..` collapsed lexically, then the deepest existing ancestor
  // realpath-resolved. A target is accepted only when both readings land inside, so a path whose
  // lexical and physical destinations disagree (`out/link-into-USER/../x`) is refused either way.
  const target = isAbsolute(absTarget) ? absTarget : process.cwd() + sep + absTarget;
  const lexical = pathResolve(target);
  const ancestorReading = resolveFromExistingAncestor(lexical);
  if ("reason" in ancestorReading) return { ok: false, reason: ancestorReading.reason };
  const lexicalInside = ancestorReading.resolved === root || ancestorReading.resolved.startsWith(root + sep);
  if (lexicalInside && confinedPath(root, target) !== null) return { ok: true };
  return {
    ok: false,
    reason: `target ${absTarget} does not resolve inside the USER_DATA repo (${root}) both physically and after collapsing \`..\` — it lands outside the USER_DATA repo or through a dangling link (lexically ${lexical}, ancestor-resolved ${ancestorReading.resolved}); personal data must never land in the system tree (SystemUserBoundary.md)`,
  };
}

/**
 * The original reading of a write target: `dir` (already lexically resolved) with its deepest
 * existing ancestor realpath-resolved and the missing tail joined back on. lstat, not existsSync:
 * existsSync follows symlinks, so a DANGLING symlink would read as absent and be joined lexically;
 * here it is present, and realpath of a dangling or looping link throws and is refused.
 */
function resolveFromExistingAncestor(lexical: string): { resolved: string } | { reason: string } {
  let dir = lexical;
  const tail: string[] = [];
  for (;;) {
    try { lstatSync(dir); break; } catch (e: any) {
      if (e?.code !== "ENOENT") return { reason: `cannot inspect ${dir} (${e?.code ?? e?.message ?? e})` };
    }
    const parent = dirname(dir);
    if (parent === dir) return { reason: `no existing ancestor for ${lexical}` };
    tail.unshift(basename(dir));
    dir = parent;
  }
  try {
    const real = realpathSync(dir);
    return { resolved: tail.length > 0 ? join(real, ...tail) : real };
  } catch (e: any) {
    return { reason: `cannot resolve ${dir} (${e?.message ?? e})` };
  }
}
