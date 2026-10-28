#!/usr/bin/env bun
/**
 * OutputReconciler — the independent coverage denominator (assay-everywhere ISC-29, ISC-12, ISC-41; RedTeam R1).
 *
 * The output ledger (MEMORY/OBSERVABILITY/outputs-*.jsonl) is written only by gates, so coverage measured
 * against it is circular. This tool builds the denominator from things that happened whether or not a gate
 * saw them, then matches each event to a ledger line. Unmatched = escape.
 *
 * Sources (each reported present/absent with an event count; an absent source is named, never silently zero):
 *   files      every regular file created/modified under Downloads and Desktop (the hand-off places), any type, recursive to depth 8,
 *              each root on its own 500,000-entry budget: the same walk the OutputRecord backstop uses (lib/DeliveryScan.ts), so the (maintainer-side; not in the public release)
 *              denominator and the recorder cannot disagree about what exists. No other root (Documents, iCloud Drive, CloudStorage,
 *              a custom root) is ever walked: listing cloud placeholders can trigger downloads and time out, and only what the DA wrote
 *              there counts anyway. For those roots the independent activity log is the only source: each path it names as a write
 *              target in the window is lstat'ed, and a directory a Bash cp/mv/ditto/rsync wrote into is walked once, bounded (depth 4,
 *              5,000 entries) and never inside CloudStorage or Mobile Documents. The report names which root classes the walk covered
 *              (and which are covered by the activity log only) and, when it was incomplete, why, never a full path.
 *   writes     Write/Edit/Bash file writes into those roots, from MEMORY/OBSERVABILITY/tool-activity.jsonl
 *              (read from the tail; the file can grow very large). A file the DA wrote is "attributed".
 *   pushes     `update by push` entries in the reflogs of remote-tracking refs, repos under ~/Projects and ~/.claude. A repo's worktrees
 *              share one reflog, so a push is one event per git common directory, not per checkout. A push before the recorder started
 *              writing push lines (RECORDING_STARTED) is history, counted in `history_before_recording`, never an escape.
 *   deploys    MEMORY/SYSTEMUPDATES/deploys.jsonl (the Ledger deploy record)
 *   sends      every gated sender's CLI run as a Bash call in tool-activity (gmail.ts send, RELAY/bridge/send.ts, X post.ts and
 *              article.ts publish, DiscordCli.ts send, Broadcast Broadcast.ts post|edit, LinkedInComment.ts, OmnyPublish.ts,
 *              substack.ts, skills/LifeOS Report.ts file --yes) plus every mcp__ tool whose last segment holds a write verb
 *              (send post create update upload publish reply comment share schedule). Nothing is called to count them; an
 *              execution is anchored to a real `bun <script>.ts` command segment, so text that merely mentions a sender is not a send.
 *   runs       every skill in MEMORY/SKILLS/execution.jsonl in the window, so a skill with no output lines is listed too
 *
 * Matching: files by sha256 (bytes when too large to hash); pushes, deploys and sends by channel within
 * +-15 minutes, each ledger line consumed once. A send prefers a ledger line from the same session as the activity row.
 *
 * Coverage = receipted / reconciled (a matched ledger line that carries a receipt_id). `ledgered` also counts
 * lines that carry an explicit labelled reason without a receipt. The summary never carries a path: an escape
 * is kind + extension + sha prefix.
 *
 * Trend (ISC-12): every CLI run appends one line to MEMORY/OBSERVABILITY/reconciler-runs.jsonl (--no-trend skips it).
 *
 * Usage: bun OutputReconciler.ts --since 24h [--json] [--no-emit] [--no-trend]
 *        bun OutputReconciler.ts trend [--last 10] [--json]
 *
 * @version 1.4.5
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { effectiveProgram, programName, simpleCommands } from "../../hooks/lib/shell-commands.ts";
import { invariant, InvariantViolation } from "./Invariant.ts";
import { getClaudeDir, getLifeosDir } from "./Paths.ts";
import { TRANSIENT_WINDOW_MS, channelOfPath, deliveryRoots, scanDelivery, skippedDir, type ScanFs, type ScanResult } from "./lib/DeliveryScan.ts";
import { isGatedMcpTool } from "./lib/McpWriteVerbs.ts";
import { readOutputLines, ledgerDir, type OutputLine } from "./lib/OutputLedger.ts";
import { IGNORED_NAMES, TRANSIENT_NAME } from "./lib/ProofKinds.ts";
import { loadVigilEmit, vigilDir } from "./lib/VigilOptional.ts";
// release-allow: private-skill-names (sender match patterns for script paths; a missing skill simply never matches)

export const MATCH_WINDOW_MS = 15 * 60 * 1000;
const HASH_CAP_BYTES = 2 * 1024 ** 3;
const PUSH_CHANNELS = new Set(["git", "git-push", "github", "push"]);
const DEPLOY_CHANNELS = new Set(["cf-deploy", "deploy"]);
const MAIL_CHANNELS = new Set(["gmail", "mail", "email"]);
/** A file the backstop could not read is recorded with this reason prefix and a marker hash, so no sha can match it: it matches by reason and time. */
const UNREADABLE_REASON = "unproofed: bytes could not be read";

export type Channel = "downloads" | "desktop" | "documents" | "icloud" | "cloud" | "custom" | "git-push" | "deploy" | "mail" | `send:${string}`;
export type EventKind = "file" | "push" | "deploy" | "send";

type Ev = {
  /** Sends only: which sender, the ledger channels that count as its record, and the session that ran it. */
  send?: { sender: string; channels: Set<string>; session: string | null };
  channel: Channel;
  kind: EventKind;
  ext: string | null;
  sha: string | null;
  bytes: number | null;
  ts: number;
  attributed: boolean;
  line: OutputLine | null;
};

export type SourceStatus = { present: boolean; events: number };
export type SkillRow = { skill: string; outputs: number; receipted: number; coverage: number; gap: boolean; /** Seen in the run ledger, with no output line in the window. */ no_outputs: boolean };
export type EscapeRow = { channel: Channel; kind: EventKind; ext: string | null; sha_prefix: string | null; attributed: boolean };
export type ChannelRow = { channel: Channel; reconciled: number; receipted: number; ledgered: number; escapes: number };

export type Report = {
  since: string;
  until: string;
  reconciled: number;
  receipted: number;
  ledgered: number;
  escapes: number;
  /** Escapes the DA demonstrably produced (tool-activity saw the write, or a push/deploy/send): what the Vigil event counts. */
  attributed_escapes: number;
  unattributed_escapes: number;
  /** Ledger lines in the window that no reconciled event matched: outputs the gates saw and the reconciler did not. Not in the denominator. */
  gate_only: number;
  coverage: number | null;
  ledgered_coverage: number | null;
  by_channel: ChannelRow[];
  per_skill: SkillRow[];
  gaps: string[];
  escape_rows: EscapeRow[];
  sources: Record<"files" | "writes" | "pushes" | "deploys" | "sends" | "runs", SourceStatus>;
  /** Pushes and deploys older than the moment their recorder started writing lines (RECORDING_STARTED): history, not escapes, not in the denominator. */
  history_before_recording: { "git-push": number; deploy: number };
  /** What the collectors could not read. A failed git read is missing coverage; it must never read as "nothing pushed". */
  collection: { repos: number; git_read_failures: number };
  /** What the delivery-root walk covered. When not complete, files beyond the bound or in unreadable directories are not in the denominator. */
  scan: Pick<ScanResult, "visited" | "overflow" | "unreadable_dirs" | "truncated_dirs" | "complete"> & {
    roots: number;
    /**
     * Per root class (downloads, desktop, documents, icloud, cloud, custom): how many roots and whether they are covered. `walked` is true for Downloads and
     * Desktop, which the scan lists in full (covered = the walk finished). A root that is not walked is covered by the activity log alone: covered is true
     * unless a named directory's bounded walk was cut short.
     */
    roots_covered: { channel: string; roots: number; covered: boolean; walked: boolean }[];
    /** Why the scan is incomplete, by root class and cause, never a full path. Empty when complete. */
    incomplete_reasons: string[];
  };
};

/** Roots where a changed file is a candidate output on its own: the hand-off places. Every other root needs the activity log to name the file or its directory. */
export const HANDOFF_CHANNELS: readonly string[] = ["downloads", "desktop"];

const PROBE_MAX_DIRS = 4000;
const PROBE_MS = 2000;
/** Root classes as the principal knows them, for the incomplete-scan reason ("iCloud: permission denied"). */
const CLASS_LABEL: Record<string, string> = { downloads: "Downloads", desktop: "Desktop", documents: "Documents", icloud: "iCloud", cloud: "CloudStorage", custom: "custom root" };

/**
 * Why a walk was incomplete, by root class and cause. An uncovered unit is an overflow victim (the entry bound was hit) or holds a directory that
 * could not be read; a root that will not list says its error class, a readable root with an unreadable directory below it says so.
 */
export function incompleteReasons(scan: Pick<ScanResult, "overflow" | "unreadable_dirs" | "visited" | "units">): string[] {
  const out: string[] = [];
  if (scan.overflow) out.push(`overflow: the walk stopped at ${scan.visited} entries`);
  for (const u of scan.units) {
    if (u.covered) continue;
    const cls = CLASS_LABEL[u.channel] ?? u.channel;
    const { errs: found, cut } = probeUnreadable(u.path);
    const why = found.size === 0 ? null : [...found].map(([code, n]) => `${CODE_WORDS[code] ?? code} (${cut ? "at least " : ""}${n} director${n === 1 ? "y" : "ies"})`).join(", ");
    out.push(`${cls}: ${why ?? (scan.overflow ? "not finished before the overflow" : scan.unreadable_dirs > 0 ? "a directory could not be read" : "not finished")}`);
  }
  if (!scan.overflow && out.length === 0 && scan.unreadable_dirs > 0) out.push(`${scan.unreadable_dirs} director${scan.unreadable_dirs === 1 ? "y" : "ies"} could not be read`);
  return [...new Set(out)];
}

const CODE_WORDS: Record<string, string> = { EPERM: "permission denied", EACCES: "permission denied", ETIMEDOUT: "timed out", EIO: "I/O error" };
/**
 * A bounded breadth-first listing of one root (at most PROBE_MAX_DIRS directories and PROBE_MS) that counts the error class of each directory
 * it cannot list. The full walk only counts unreadable directories; this names the cause by class. A cause it does not reach stays unnamed.
 */
function probeUnreadable(root: string): { errs: Map<string, number>; cut: boolean } {
  const errs = new Map<string, number>();
  const t0 = Date.now();
  let level = [root], listed = 0, cut = false;
  while (level.length > 0) {
    if (listed >= PROBE_MAX_DIRS || Date.now() - t0 >= PROBE_MS) { cut = true; break; }
    const next: string[] = [];
    for (const d of level) {
      if (listed >= PROBE_MAX_DIRS || Date.now() - t0 >= PROBE_MS) { cut = true; break; }
      listed++;
      let es;
      try { es = readdirSync(d, { withFileTypes: true }); } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "error";
        if (code !== "ENOENT" && code !== "ENOTDIR") errs.set(code, (errs.get(code) ?? 0) + 1);
        continue;
      }
      for (const e of es) if (e.isDirectory() && !skippedDir(e.name, 2)) next.push(join(d, e.name));
    }
    level = next;
  }
  return { errs, cut };
}

export type Options = {
  sinceMs?: number;
  now?: Date;
  home?: string;
  ledgerDir?: string;
  activityFile?: string;
  deploysFile?: string;
  /** Test seam: the run ledger (MEMORY/SKILLS/execution.jsonl). */
  executionFile?: string;
  /** Test seam: explicit repos instead of ~/Projects/* + ~/.claude. */
  repos?: string[];
  /** Called with the finished report; the CLI and /ic wire this to a Vigil event. */
  emit?: (r: Report) => void;
  /** Test seam: the file-system calls the delivery walk makes, so a test can count what is listed per root. */
  fs?: ScanFs;
  /** Test seam: when each recorder started writing lines, ms epoch; default RECORDING_STARTED. */
  recordingStarted?: Partial<Record<"git-push" | "deploy", number>>;
};

/**
 * When the OutputRecord hook started writing a line for each channel (the date of the earliest line in the ledger). (maintainer-side; not in the public release)
 * An event older than this is history: no recorder existed to write its line, so it can never match one and is not an escape.
 */
export const RECORDING_STARTED: Record<"git-push" | "deploy", number> = { "git-push": Date.parse("2026-10-01T05:35:00Z"), deploy: Date.parse("2026-10-01T05:33:00Z") };
/** A directory a Bash copy wrote into is walked once, bounded. */
const NAMED_DIR_MAX_DEPTH = 4;
const NAMED_DIR_MAX_ENTRIES = 5_000;
/** True for a path in a cloud-synced tree: listing it can download placeholders, so it is never walked and its files are never read. */
export function isCloudPath(p: string, home: string): boolean {
  return p.startsWith(join(home, "Library", "CloudStorage") + "/") || p.startsWith(join(home, "Library", "Mobile Documents") + "/") || p.includes("/Library/CloudStorage/") || p.includes("/Library/Mobile Documents/");
}

/** "24h", "90m", "7d" to milliseconds. */
export function parseSince(s: string): number {
  const m = /^(\d+)([mhd])$/.exec(s.trim());
  invariant(m !== null, `--since is <n>m|h|d, got "${s}"`);
  return Number(m![1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m![2] as "m" | "h" | "d"];
}

function hashFile(path: string, size: number): string | null {
  if (size > HASH_CAP_BYTES) return null;
  const h = createHash("sha256");
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
    return h.digest("hex");
  } catch { return null; } finally { closeSync(fd); }
}

const extOf = (p: string): string => extname(p).replace(/^\./, "").toLowerCase() || "none";
/** Finder bookkeeping is never an output; a partial-download name is ignored only while it is fresh (the scan's own rule), so a stalled one counts. */
const skippable = (name: string, changedMs: number | null = null, nowMs = Date.now()): boolean =>
  IGNORED_NAMES.has(name) || (TRANSIENT_NAME.test(name) && (changedMs === null || changedMs > nowMs - TRANSIENT_WINDOW_MS));
/** The "something changed here" clock of a file: the latest of mtime, ctime and birthtime, so a moved or restored old file counts (DeliveryScan's `changed`). */
const changedOf = (st: { mtimeMs: number; ctimeMs: number; birthtimeMs: number }): number => Math.max(st.mtimeMs, st.ctimeMs, st.birthtimeMs);

export type SendActivity = { ts: number; sender: string; channels: string[]; session: string | null };
/**
 * What the independent activity log says the DA wrote. `writes` is the loose set (any root path a Write/Edit names or a Bash command mentions);
 * it only marks a Downloads or Desktop file as DA-attributed. The other three are the strict set that decides whether a changed file in any
 * OTHER root is the DA's: `strict` is a Write/Edit/MultiEdit/NotebookEdit path or a Bash cp/mv/ditto/rsync/install destination, a redirect
 * (> or >>) or a tee target; `exactDirs` is the directory of each such path; `treeDirs` is a directory a Bash cp/mv/ditto/rsync wrote into,
 * with everything under it.
 */
type Activity = { writes: Map<string, number>; strict: Map<string, number>; exactDirs: Set<string>; treeDirs: Set<string>; sends: SendActivity[]; present: boolean };

/** True when the activity log names this file, or names its directory with a write. */
export function attributedByActivity(a: Pick<Activity, "strict" | "exactDirs" | "treeDirs">, p: string): boolean {
  if (a.strict.has(p) || a.exactDirs.has(dirname(p))) return true;
  for (const d of a.treeDirs) if (p.startsWith(d + "/")) return true;
  return false;
}

/** Shell-ish split: whitespace separates, single and double quotes group, a backslash escapes the next character. */
function shellWords(seg: string): string[] {
  const out: string[] = [];
  let cur = "", q: string | null = null, has = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === "\\" && i + 1 < seg.length) { cur += seg[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) { out.push(cur); cur = ""; has = false; } continue; }
    cur += c; has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

const expandHome = (p: string, home: string): string => p.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);

/**
 * The absolute paths a Bash command writes: `files` are cp/mv/ditto/rsync/install destinations (and, for a copy into a directory, the
 * file that lands there), > and >> redirect targets and tee targets; `trees` are directories a copy wrote into. Relative targets are ignored
 * (no working directory is known), as are reads. ~ and $HOME expand to `home`.
 */
export function bashWriteTargets(cmd: string, home: string): { files: string[]; trees: string[] } {
  const files: string[] = [], trees: string[] = [];
  const abs = (p: string): string | null => { const e = expandHome(p, home); return e.startsWith("/") ? e.replace(/\/+$/, "") || "/" : null; };
  for (const seg of cmd.split(/&&|\|\||[;\n|]/)) {
    for (const m of seg.matchAll(/(?<![0-9&<>])>{1,2}\s*(?!&)("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g)) {
      const t = abs(shellWords(m[1]!)[0] ?? ""); if (t) files.push(t);
    }
    const w = shellWords(seg.replace(/(?<![0-9&<>])>{1,2}\s*(?!&)("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g, " "));
    while (w.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!) || ["rtk", "sudo", "command", "time"].includes(w[0]!))) w.shift();
    const name = (w[0] ?? "").split("/").pop() ?? "";
    const args = w.slice(1);
    const recursive = args.some((a) => /^-[A-Za-z]*[rRa][A-Za-z]*$/.test(a) || a === "--recursive" || a === "--archive");
    const pos = args.filter((a) => !a.startsWith("-"));
    if (name === "tee") { for (const a of pos) { const t = abs(a); if (t) files.push(t); } continue; }
    if (!["cp", "mv", "ditto", "rsync", "install"].includes(name) || pos.length < 2) continue;
    const dest = abs(pos[pos.length - 1]!);
    if (!dest) continue;
    files.push(dest);
    const dirLike = /\/$/.test(pos[pos.length - 1]!) || name === "rsync" || name === "ditto" || recursive || !/\.[A-Za-z0-9]{1,8}$/.test(dest);
    if (dirLike) trees.push(dest);
    for (const src of pos.slice(0, -1)) files.push(join(dest, basename(src.replace(/\/+$/, ""))));
  }
  return { files, trees };
}

const MAIL_LEDGER = ["gmail", "mail", "email"];

/** A sender's dry-run grammar: true only when its own parser would set the dry-run flag from this argv (the words after the script). */
type DryRunGrammar = (argv: string[]) => boolean;
/** The sender has no dry-run flag: every run sends, and a `--dry-run` word is message text or an error (Relay, Discord, …). */
const NO_DRY_RUN: DryRunGrammar = () => false;
/** The sender sets dry-run when the word appears anywhere, even as another flag's value (`argv.includes("--dry-run")`). */
const ANY_WORD = (flag: string): DryRunGrammar => (argv) => argv.includes(flag);
/**
 * A left-to-right parser: each flag in `values` consumes the next word as its value, a flag in `dry` sets dry-run, and the
 * walk stops at `--`. Unknown words are skipped, never read as dry-run, so an unmodelled flag can only count as a send.
 */
const SEQUENTIAL = (values: string[], dry: string[]): DryRunGrammar => {
  const v = new Set(values), d = new Set(dry);
  return (argv) => {
    for (let i = 0; i < argv.length; i++) {
      const w = argv[i]!;
      if (w === "--") return false;
      if (v.has(w)) { i++; continue; }
      if (d.has(w)) return true;
    }
    return false;
  };
};
/**
 * commander (v12) parseOptions for one subcommand: a required-value option consumes the next word whatever it looks
 * like, `--opt=value` is one word, a short cluster `-ad` expands left to right until a value option takes the rest,
 * and `--` ends the options. `shortBool` lists the cluster letters that are boolean flags.
 */
const COMMANDER = (sub: Record<string, { values: string[]; shortValues: string; shortBool: string }>, dryLong: string, dryShort: string): DryRunGrammar => (argv) => {
  const spec = sub[argv[0] ?? ""];
  if (!spec) return false;
  const values = new Set(spec.values);
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]!;
    if (w === "--") return false;
    if (values.has(w)) { i++; continue; }
    if (w === dryLong || w === `-${dryShort}`) return true;
    if (/^-[A-Za-z]{2,}$/.test(w)) {
      for (const ch of w.slice(1)) {
        if (ch === dryShort) return true;
        if (spec.shortValues.includes(ch)) break; // the rest of the word is that option's value
        if (!spec.shortBool.includes(ch)) break; // unknown: commander refuses the whole run, which sends nothing anyway
      }
    }
  }
  return false;
};

/**
 * The gated senders' CLIs. `script` matches the executed .ts path, `args` the arguments after it. `dryRun` is that sender's
 * own dry-run grammar, mirrored from its parser (LOSIntegrity S097): one shared flag list read `--subtitle --dry-run` as a
 * dry run for Substack, which takes it as the subtitle, and `send.ts <to> --dry-run` as one for Relay, which has no such
 * flag and sends the words. `channels` are the ledger channels that count as that sender's record. Command shapes come
 * from each tool's own usage block and from CommunicationSkillGuard / SendGate; when a parser changes, its grammar here
 * changes with it, and an unmodelled word only ever counts as a send.
 */
const SENDERS: { sender: string; script: RegExp; args: RegExp; dryRun: DryRunGrammar; channels: string[] }[] = [
  // gmail.ts: `--account <name>` is stripped from anywhere on the line first; then parseSendArgs walks the send flags.
  {
    sender: "gmail", script: /(?:^|\/)gmail\.ts$/, args: /^(?:--account\s+\S+\s+)?send\b/, channels: MAIL_LEDGER,
    dryRun: (argv) => {
      const rest: string[] = [];
      for (let i = 0; i < argv.length; i++) { if (argv[i] === "--account") { i++; continue; } rest.push(argv[i]!); }
      if (rest[0] !== "send") return false;
      return SEQUENTIAL(["--to", "--subject", "--body-file", "--cc", "--bcc", "--from", "--reply-to", "--reply-to-id", "--in-reply-to", "--references", "--thread-id", "--attach"], ["--dry-run"])(rest.slice(1));
    },
  },
  // bridge/send.ts parseSendArgs: positional recipient and words; no dry-run flag.
  { sender: "relay", script: /(?:^|\/)bridge\/send\.ts$/, args: /./, dryRun: NO_DRY_RUN, channels: ["relay", "imessage", "text", "sms", "textus"] },
  // X post.ts: `argv.includes("--dry-run")`.
  { sender: "x-post", script: /(?:^|\/)X\/Tools\/post\.ts$/, args: /./, dryRun: ANY_WORD("--dry-run"), channels: ["x", "twitter", "social", "broadcast"] },
  { sender: "x-article", script: /(?:^|\/)X\/Tools\/article\.ts$/, args: /^(?:publish\b|create\b[^\n]*--publish\b)/, dryRun: NO_DRY_RUN, channels: ["x", "twitter", "social", "broadcast"] },
  { sender: "discord", script: /(?:^|\/)DiscordCli\.ts$/, args: /^send\b/, dryRun: NO_DRY_RUN, channels: ["discord"] },
  // Broadcast (skills/Broadcast/src/index.ts): commander `post` and `edit` with `-d, --dry-run`.
  {
    sender: "broadcast", script: /(?:^|\/)Broadcast\/Tools\/Broadcast\.ts$/, args: /^(?:post|edit)\b/, channels: ["broadcast", "x", "twitter", "linkedin", "bluesky", "instagram", "social"],
    dryRun: COMMANDER({
      post: { values: ["-c", "--content", "-f", "--file", "-m", "--media", "-p", "--platforms"], shortValues: "cfmp", shortBool: "da" },
      edit: { values: ["-u", "--urn", "-c", "--content", "-f", "--file"], shortValues: "ucf", shortBool: "d" },
    }, "--dry-run", "d"),
  },
  { sender: "linkedin-comment", script: /(?:^|\/)LinkedInComment\.ts$/, args: /./, dryRun: NO_DRY_RUN, channels: ["linkedin", "broadcast", "social"] },
  // OmnyPublish.ts: `flag("dry-run")` is `process.argv.includes("--dry-run")`.
  { sender: "omny", script: /(?:^|\/)OmnyPublish\.ts$/, args: /./, dryRun: ANY_WORD("--dry-run"), channels: ["omny", "podcast", "broadcast"] },
  // substack.ts parseArgs: --title/--subtitle/--body/--file take the next word; --dry-run is a flag.
  { sender: "substack", script: /(?:^|\/)(?:_SUBSTACK\/Tools\/)?substack\.ts$/, args: /./, dryRun: SEQUENTIAL(["--title", "--subtitle", "--body", "--file"], ["--dry-run"]), channels: ["substack", "blog", "newsletter"] },
  // Report.ts: a send is `file … --yes` (its args pattern); it has no separate dry-run flag.
  { sender: "report", script: /(?:^|\/)LifeOS\/Tools\/Report\.ts$/, args: /^file\b[^\n]*--yes\b/, dryRun: NO_DRY_RUN, channels: ["github", "report"] },
];

/** Segments of a shell command that start a real `bun [run] <script>.ts <args>` execution (env prefixes, an `rtk` prefix and an absolute path to bun or bunx allowed). Never a grep or echo that mentions a script. */
export function bunExecutions(cmd: string): { script: string; args: string }[] {
  const out: { script: string; args: string }[] = [];
  for (const seg of cmd.split(/&&|\|\||[;|\n]/)) {
    const m = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:rtk\s+)?(?:\S*\/)?(?:bun|bunx)(?:\s+run)?\s+(?:--\S+\s+)*(\S+\.ts)(?:\s+([\s\S]*))?$/.exec(seg);
    if (m) out.push({ script: m[1]!.replace(/^["']|["']$/g, ""), args: (m[2] ?? "").trim() });
  }
  return out;
}

/**
 * Every send a Bash command performs, with the ledger channels that would record it. Arguments come from the one shell
 * parser (hooks/lib/shell-commands), so quoting decides what is a flag, and each sender's own grammar (SENDERS dryRun)
 * decides whether a `--dry-run` word is its dry-run flag or a value it consumes (LOSIntegrity S097). A line the parser cannot fully read falls back to the
 * text scan and counts every gated execution as a send, never as a dry run.
 */
export function sendsInCommand(cmd: string): { sender: string; channels: string[] }[] {
  const found: { sender: string; channels: string[] }[] = [];
  // argv: the parsed words, so the sender's own grammar decides the dry run; null on the text fallback, which never reads one.
  const match = (script: string, args: string, argv: string[] | null) => {
    for (const s of SENDERS) {
      if (!s.script.test(script) || !s.args.test(args)) continue;
      if (argv && s.dryRun(argv)) continue;
      found.push({ sender: s.sender, channels: s.channels });
    }
  };
  let walk: ReturnType<typeof simpleCommands> | null = null;
  try { walk = simpleCommands(cmd); } catch { walk = null; }
  if (!walk || walk.tooDeep) {
    for (const ex of bunExecutions(cmd)) match(ex.script, ex.args, null);
    return found;
  }
  for (const c of walk.commands) {
    if (!["bun", "bunx"].includes(programName(c.argv[0]))) continue;
    const ep = effectiveProgram(c.argv);
    if (!/\.ts$/.test(ep.word)) continue;
    match(ep.word, ep.args.join(" "), ep.args);
  }
  return found;
}

/** An mcp__ tool the send gate treats as a write (the one rule, lib/McpWriteVerbs.ts): its channel token, else null. */
export function mcpWriteChannel(tool: string): string | null {
  if (!isGatedMcpTool(tool)) return null;
  if (tool.toLowerCase().includes("slack")) return "slack";
  return (/^mcp__(?:plugin_)?([A-Za-z0-9]+)/.exec(tool)?.[1] ?? "mcp").toLowerCase();
}

/**
 * The ledger channel an Artifact tool call is an output on, or null when the call is not one: Artifact publish (action publish, or no
 * action with a file, files or type_url) on "artifact"; ArtifactData set, update, str_replace and batch on "artifact-data";
 * ArtifactComments reply and create on "artifact-comment". The action is read from the logged input preview.
 */
export function artifactChannel(tool: string, line: string): string | null {
  if (tool !== "Artifact" && tool !== "ArtifactData" && tool !== "ArtifactComments") return null;
  const action = /\\?"action\\?":\\?"([a-z_]+)/.exec(line)?.[1];
  if (tool === "ArtifactData") return action !== undefined && ["set", "update", "str_replace", "batch"].includes(action) ? "artifact-data" : null;
  if (tool === "ArtifactComments") return action !== undefined && ["reply", "create"].includes(action) ? "artifact-comment" : null;
  if (action !== undefined) return action === "publish" && !/\\?"asset\\?":true/.test(line) ? "artifact" : null;
  return /\\?"(?:file_path|files|type_url)\\?":/.test(line) && !/\\?"asset\\?":true/.test(line) ? "artifact" : null;
}

/** Read tool-activity from the tail until lines are older than `sinceMs` (minus an hour of slack for unordered subagent lines). */
function readActivity(file: string, sinceMs: number, roots: string[], home: string = homedir()): Activity {
  const result: Activity = { writes: new Map(), strict: new Map(), exactDirs: new Set(), treeDirs: new Set(), sends: [], present: false };
  if (!existsSync(file)) return result;
  result.present = true;
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const CHUNK = 8 * 1024 * 1024;
    let pos = size;
    let carry = "";
    // A command may name a root as ~/Documents or $HOME/Documents; the cheap line filter must see those spellings too.
    const rootNeedles = roots.flatMap((r) => (r.startsWith(home + "/") ? [r, "~" + r.slice(home.length), "$HOME" + r.slice(home.length), "${HOME}" + r.slice(home.length)] : [r]));
    const inRoot = (p: string): boolean => roots.some((r) => p.startsWith(r + "/"));
    const consider = (line: string) => {
      if (!line) return true;
      const tsM = /"timestamp":"([^"]+)"/.exec(line);
      const ts = tsM ? Date.parse(tsM[1]!) : NaN;
      if (Number.isFinite(ts) && ts < sinceMs - 3_600_000) return false; // older than the window plus slack: stop reading
      if (!Number.isFinite(ts) || ts < sinceMs) return true;
      const tool = /"tool_name":"(Write|Edit|MultiEdit|NotebookEdit|Bash|Artifact|ArtifactData|ArtifactComments|mcp__[^"]+)"/.exec(line)?.[1];
      if (!tool) return true;
      const mcpChannel = mcpWriteChannel(tool);
      const mentionsRoot = rootNeedles.some((r) => line.includes(r));
      const mentionsSend = tool === "Bash" && /\.ts/.test(line) && /bun/.test(line);
      const artifact = artifactChannel(tool, line);
      if (tool.startsWith("Artifact") && artifact === null) return true; // an Artifact read, list, delete, open or comment-read is not an output
      if (!mentionsRoot && !mentionsSend && !mcpChannel && artifact === null) return true;
      let row: any;
      try { row = JSON.parse(line); } catch { return true; }
      const gt = row.ground_truth ?? {};
      const session: string | null = typeof row.session_id === "string" ? row.session_id : null;
      if (mcpChannel) { result.sends.push({ ts, sender: tool, channels: [mcpChannel, "mcp"], session }); return true; }
      if (artifact !== null) { result.sends.push({ ts, sender: artifact, channels: [artifact], session }); return true; }
      if (tool !== "Write" && tool !== "Edit" && tool !== "MultiEdit" && tool !== "NotebookEdit" && tool !== "Bash") return true;
      if (tool !== "Bash") {
        const p: string | undefined = gt.file_path ?? gt.notebook_path ?? /"(?:file_path|notebook_path)\\?":\\?"([^"\\]+)/.exec(String(row.tool_input_preview ?? ""))?.[1];
        if (p && inRoot(p)) {
          result.writes.set(p, Math.max(result.writes.get(p) ?? 0, ts));
          result.strict.set(p, Math.max(result.strict.get(p) ?? 0, ts));
          result.exactDirs.add(dirname(p));
        }
      } else {
        const cmd = String(gt.command ?? row.tool_input_preview ?? "");
        for (const r of roots) {
          const re = new RegExp(`${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\\s"'\\\\;|&<>)]+`, "g");
          for (const m of cmd.matchAll(re)) result.writes.set(m[0], Math.max(result.writes.get(m[0]) ?? 0, ts));
        }
        const t = bashWriteTargets(cmd, home);
        for (const p of t.files) if (inRoot(p)) { result.strict.set(p, Math.max(result.strict.get(p) ?? 0, ts)); result.exactDirs.add(dirname(p)); }
        for (const d of t.trees) if (inRoot(d)) result.treeDirs.add(d);
        for (const sd of sendsInCommand(cmd)) result.sends.push({ ts, sender: sd.sender, channels: sd.channels, session });
      }
      return true;
    };
    outer: while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, pos);
      const text = buf.toString("utf8") + carry;
      const lines = text.split("\n");
      carry = pos > 0 ? lines.shift() ?? "" : "";
      for (let i = lines.length - 1; i >= 0; i--) if (!consider(lines[i]!)) break outer;
    }
    if (carry) consider(carry);
  } finally { closeSync(fd); }
  return result;
}

/** The config root for `home`: the resolver's root for the real home, the same layout under a synthesized home (the test seam). */
function claudeDirFor(home: string): string {
  return home === homedir() ? getClaudeDir() : join(home, basename(getClaudeDir()));
}
/** A path under LIFEOS/ for `home` (MEMORY/..., USER/...), through the resolver when home is real. */
function lifeosFor(home: string, ...parts: string[]): string {
  return home === homedir() ? join(getLifeosDir(), ...parts) : join(claudeDirFor(home), basename(getLifeosDir()), ...parts);
}

function discoverRepos(home: string): string[] {
  const out: string[] = [];
  const claude = claudeDirFor(home);
  if (existsSync(join(claude, ".git"))) out.push(claude);
  try {
    for (const e of readdirSync(join(home, "Projects"), { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(home, "Projects", e.name, ".git"))) out.push(join(home, "Projects", e.name));
    }
  } catch { /* no Projects directory */ }
  return out;
}

/** Push times from the reflogs of remote-tracking refs: the local record that a push moved a remote ref. */
function readPushes(repos: string[], sinceMs: number): { pushes: { ts: number; sha: string }[]; failed: number } {
  const seen = new Set<string>();
  const out: { ts: number; sha: string }[] = [];
  let failed = 0; // reflog reads that did not succeed: a failed read is missing coverage, never "no pushes"
  const commonDirs = new Set<string>();
  for (const repo of repos) {
    // Worktrees of one repository share its remote-tracking refs and their reflog: one push, however many checkouts list it.
    const cd = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--git-common-dir"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    if (cd.exitCode === 0) {
      let dir = resolve(repo, cd.stdout.toString().trim());
      try { dir = realpathSync(dir); } catch { /* keep the lexical path */ } // a checkout reached through a symlink names the same directory
      if (commonDirs.has(dir)) continue;
      commonDirs.add(dir);
    }
    const p = Bun.spawnSync(
      ["git", "-C", repo, "log", "-g", "--glob=refs/remotes/*", "--date=iso-strict", `--since=${new Date(sinceMs).toISOString()}`, "--format=%gd|%gs|%H"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
    );
    if (p.exitCode !== 0) { failed++; continue; }
    for (const l of p.stdout.toString().split("\n")) {
      const [gd, gs, sha] = l.split("|");
      if (!gs || !sha || !gs.startsWith("update by push")) continue;
      const ts = Date.parse(/@\{([^}]+)\}/.exec(gd ?? "")?.[1] ?? "");
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      const key = `${repo}|${sha}`;
      if (seen.has(key)) continue; // the HEAD alias and the branch ref log the same push
      seen.add(key);
      out.push({ ts, sha });
    }
  }
  return { pushes: out, failed };
}

function readDeploys(file: string, sinceMs: number): { present: boolean; rows: { ts: number; sha: string | null }[] } {
  if (!existsSync(file)) return { present: false, rows: [] };
  const rows: { ts: number; sha: string | null }[] = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      const ts = Date.parse(r.ts);
      if (r.ok === true && Number.isFinite(ts) && ts >= sinceMs) rows.push({ ts, sha: typeof r.sha === "string" ? r.sha : null });
    } catch { /* torn line */ }
  }
  return { present: true, rows };
}

/** Skills seen in the run ledger inside the window (execution.jsonl, one line per skill run). A torn line is skipped. */
function readRunSkills(file: string, sinceMs: number, untilMs: number): { present: boolean; skills: Map<string, number> } {
  const skills = new Map<string, number>();
  if (!existsSync(file)) return { present: false, skills };
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim() || !l.includes('"skill"')) continue;
    try {
      const r = JSON.parse(l);
      const ts = Date.parse(r.ts);
      if (typeof r.skill === "string" && r.skill && Number.isFinite(ts) && ts >= sinceMs && ts <= untilMs) skills.set(r.skill, (skills.get(r.skill) ?? 0) + 1);
    } catch { /* torn line */ }
  }
  return { present: true, skills };
}

/** A ledger line that belongs to a push, deploy or send event, so a file with the same bytes never consumes it. */
const SEND_LEDGER_CHANNELS = new Set([...SENDERS.flatMap((s) => s.channels), "slack", "mcp", "artifact", "artifact-data", "artifact-comment"]);
const eventChannelLine = (l: OutputLine): boolean => PUSH_CHANNELS.has(l.channel) || DEPLOY_CHANNELS.has(l.channel) || MAIL_CHANNELS.has(l.channel) || SEND_LEDGER_CHANNELS.has(l.channel) || l.boundary === "deploy" || l.boundary === "send";

const pct = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

export function reconcile(opts: Options = {}): Report {
  const now = opts.now ?? new Date();
  const home = opts.home ?? homedir();
  const sinceMs = now.getTime() - (opts.sinceMs ?? 86_400_000);
  const roots = deliveryRoots(home);
  const rootPaths = roots.map((r) => r.path);
  const channelOf = (p: string): Channel => (channelOfPath(p, roots) ?? "custom") as Channel;

  const ledger = readOutputLines(opts.ledgerDir ?? ledgerDir());
  const events: Ev[] = [];

  // (b) tool-activity first, so (a) can mark files the DA wrote as attributed.
  const activity = readActivity(opts.activityFile ?? lifeosFor(home, "MEMORY", "OBSERVABILITY", "tool-activity.jsonl"), sinceMs, rootPaths, home);
  const writtenPaths = new Set(activity.writes.keys());

  // (a) + (b): files. A path is one event however many sources saw it. A changed file in a hand-off root (Downloads, Desktop) is a candidate
  // output on its own; in any other root it counts only when the activity log names the file or its directory, else it is the informational
  // "changed, not attributed to the DA" count (written by the principal or by sync, never an escape).
  const filePaths = new Set<string>();
  let filesFromDisk = 0;
  let filesFromWrites = 0;
  const candidate = (p: string): boolean => HANDOFF_CHANNELS.includes(channelOf(p)) || attributedByActivity(activity, p);
  // The walk lists Downloads and Desktop only, each on its own budget; no other root is ever listed.
  const scan = scanDelivery({ mode: "full", roots, keep: (e) => e.changed >= sinceMs, now: now.getTime(), ...(opts.fs ? { fs: opts.fs } : {}) });
  for (const e of scan.entries) { filePaths.add(e.path); filesFromDisk++; }
  // Every other root: the activity log is the only source. A directory a copy wrote into is walked once, bounded, never inside a cloud tree.
  const named = { visited: 0, overflow: false, unreadable: 0, covered: new Set<string>(), cut: new Set<string>() };
  const copyDirs = [...activity.treeDirs].filter((d) => !HANDOFF_CHANNELS.includes(channelOf(d)) && !isCloudPath(d, home)).sort();
  const walkedDirs: string[] = [];
  for (const d of copyDirs) {
    if (walkedDirs.some((w) => d === w || d.startsWith(w + "/"))) continue; // inside one already walked
    try { if (isCloudPath(realpathSync(d), home)) continue; } catch { continue; } // a symlink into a cloud tree, or gone
    walkedDirs.push(d);
    const ch = channelOf(d);
    const sub = scanDelivery({ mode: "full", roots: [{ channel: ch, path: d }], walkChannels: [ch], maxDepth: NAMED_DIR_MAX_DEPTH, maxEntries: NAMED_DIR_MAX_ENTRIES, keep: (e) => e.changed >= sinceMs, now: now.getTime(), ...(opts.fs ? { fs: opts.fs } : {}) });
    named.visited += sub.visited; named.unreadable += sub.unreadable_dirs;
    if (sub.complete) named.covered.add(ch);
    else { named.cut.add(ch); if (sub.overflow) named.overflow = true; }
    for (const e of sub.entries) { if (!filePaths.has(e.path)) { filePaths.add(e.path); filesFromWrites++; } }
  }
  // Each path the activity log names as a write target (and, in a hand-off root, any path a command mentions) is lstat'ed, never listed.
  const namedPaths = new Set([...writtenPaths, ...activity.strict.keys()]);
  for (const p of namedPaths) {
    const name = p.split("/").pop() ?? "";
    if (filePaths.has(p) || IGNORED_NAMES.has(name) || !candidate(p)) continue;
    try { const st = lstatSync(p); if ((st.isFile() || st.isSymbolicLink()) && !skippable(name, changedOf(st), now.getTime())) { filePaths.add(p); filesFromWrites++; } } catch { /* written then removed: not a delivered file */ }
  }
  for (const p of filePaths) {
    let st;
    try { st = statSync(p); } catch { try { st = lstatSync(p); } catch { continue; } } // a dangling link keeps its own size; a vanished file is no event
    // A file in a cloud tree may be a placeholder: reading it would download it, so it is matched by size and time, never by bytes.
    events.push({ channel: channelOf(p), kind: "file", ext: extOf(p), sha: isCloudPath(p, home) ? null : hashFile(p, st.size), bytes: st.size, ts: changedOf(st), attributed: writtenPaths.has(p) || (!HANDOFF_CHANNELS.includes(channelOf(p)) && attributedByActivity(activity, p)), line: null });
  }

  // (c) pushes
  const repos = opts.repos ?? discoverRepos(home);
  const floor = { ...RECORDING_STARTED, ...(opts.recordingStarted ?? {}) };
  const history = { "git-push": 0, deploy: 0 };
  const pushRead = readPushes(repos, sinceMs);
  const allPushes = pushRead.pushes;
  const pushes = allPushes.filter((p) => p.ts >= floor["git-push"]);
  history["git-push"] = allPushes.length - pushes.length;
  for (const p of pushes) events.push({ channel: "git-push", kind: "push", ext: null, sha: p.sha, bytes: null, ts: p.ts, attributed: true, line: null });

  // (d) deploys
  const deploys = readDeploys(opts.deploysFile ?? lifeosFor(home, "MEMORY", "SYSTEMUPDATES", "deploys.jsonl"), sinceMs);
  const liveDeploys = deploys.rows.filter((d) => d.ts >= floor.deploy);
  history.deploy = deploys.rows.length - liveDeploys.length;
  for (const d of liveDeploys) events.push({ channel: "deploy", kind: "deploy", ext: null, sha: d.sha, bytes: null, ts: d.ts, attributed: true, line: null });

  // (e) sends
  for (const sd of activity.sends) {
    const mail = sd.sender === "gmail";
    events.push({ send: { sender: sd.sender, channels: new Set(sd.channels), session: sd.session }, channel: mail ? "mail" : (`send:${sd.sender}` as Channel), kind: "send", ext: null, sha: null, bytes: null, ts: sd.ts, attributed: true, line: null });
  }

  // Matching. Each ledger line is consumed once; a receipt wins among equal candidates.
  const used = new Set<string>();
  const pick = (cands: OutputLine[]): OutputLine | null => {
    const free = cands.filter((l) => !used.has(l.output_id));
    const best = free.find((l) => l.receipt_id) ?? free[0] ?? null;
    if (best) used.add(best.output_id);
    return best;
  };
  const near = (l: OutputLine, ts: number) => Math.abs(Date.parse(l.ts) - ts) <= MATCH_WINDOW_MS;
  // A blocked line records a refusal, never a delivery: it can satisfy no event of any kind (LOSIntegrity S096).
  const delivered = ledger.filter((l) => l.decision !== "blocked");
  for (const e of events) {
    if (e.kind === "file") {
      // A same-sha line from outside the window (an old landing, a stale record) is not this event's.
      e.line = pick(delivered.filter((l) => !eventChannelLine(l) && (e.sha ? near(l, e.ts) && l.sha256 === e.sha : l.reason.startsWith(UNREADABLE_REASON) ? near(l, e.ts) : l.bytes === e.bytes && near(l, e.ts))));
    } else if (e.kind === "push") {
      e.line = pick(delivered.filter((l) => PUSH_CHANNELS.has(l.channel) && near(l, e.ts)));
    } else if (e.kind === "deploy") {
      e.line = pick(delivered.filter((l) => (l.boundary === "deploy" || DEPLOY_CHANNELS.has(l.channel)) && near(l, e.ts)));
    } else {
      // A send matches a ledger line on one of its sender's channels inside the window; a line from the same session wins.
      const cands = delivered.filter((l) => e.send!.channels.has(l.channel) && near(l, e.ts));
      const same = e.send!.session ? cands.filter((l) => l.session_id === e.send!.session) : [];
      e.line = pick(same.some((l) => !used.has(l.output_id)) ? same : cands);
    }
  }

  const matched = events.filter((e) => e.line);
  const receipted = matched.filter((e) => e.line!.receipt_id);
  const escapes = events.filter((e) => !e.line);
  const fixed: Channel[] = ["downloads", "desktop", "documents", "icloud", "cloud", "custom", "git-push", "deploy", "mail"];
  const channels: Channel[] = [...fixed, ...[...new Set(events.map((e) => e.channel))].filter((c) => !fixed.includes(c)).sort()];
  const by_channel: ChannelRow[] = channels
    .map((c) => {
      const es = events.filter((e) => e.channel === c);
      return { channel: c, reconciled: es.length, receipted: es.filter((e) => e.line?.receipt_id).length, ledgered: es.filter((e) => e.line).length, escapes: es.filter((e) => !e.line).length };
    })
    .filter((r) => r.reconciled > 0);

  const skillMap = new Map<string, { outputs: number; receipted: number }>();
  for (const e of matched) {
    const k = e.line!.skill ?? e.line!.workflow ?? "(none)";
    const row = skillMap.get(k) ?? { outputs: 0, receipted: 0 };
    row.outputs++;
    if (e.line!.receipt_id) row.receipted++;
    skillMap.set(k, row);
  }
  const per_skill: SkillRow[] = [...skillMap]
    .map(([skill, v]) => ({ skill, outputs: v.outputs, receipted: v.receipted, coverage: pct(v.receipted, v.outputs) ?? 0, gap: v.outputs > 0 && v.receipted === 0, no_outputs: false }));
  // ISC-41: every skill the run ledger saw in the window is listed, outputs or not. "(none)" is a bucket, not a skill.
  const runs = readRunSkills(opts.executionFile ?? lifeosFor(home, "MEMORY", "SKILLS", "execution.jsonl"), sinceMs, now.getTime());
  for (const skill of runs.skills.keys()) {
    if (!skillMap.has(skill)) per_skill.push({ skill, outputs: 0, receipted: 0, coverage: 0, gap: false, no_outputs: true });
  }
  per_skill.sort((a, b) => b.outputs - a.outputs || a.skill.localeCompare(b.skill));

  const gate_only = ledger.filter((l) => !used.has(l.output_id) && Date.parse(l.ts) >= sinceMs && Date.parse(l.ts) <= now.getTime()).length;
  const escape_rows: EscapeRow[] = escapes.map((e) => ({ channel: e.channel, kind: e.kind, ext: e.ext, sha_prefix: e.sha ? e.sha.slice(0, 8) : null, attributed: e.attributed }));

  const report: Report = {
    since: new Date(sinceMs).toISOString(),
    until: now.toISOString(),
    reconciled: events.length,
    receipted: receipted.length,
    ledgered: matched.length,
    escapes: escapes.length,
    attributed_escapes: escapes.filter((e) => e.attributed).length,
    unattributed_escapes: escapes.filter((e) => !e.attributed).length,
    gate_only,
    coverage: pct(receipted.length, events.length),
    ledgered_coverage: pct(matched.length, events.length),
    by_channel,
    per_skill,
    gaps: per_skill.filter((s) => s.gap).map((s) => s.skill),
    escape_rows,
    sources: {
      files: { present: roots.length > 0, events: filesFromDisk },
      writes: { present: activity.present, events: filesFromWrites },
      // Present means at least one repository's reflog was actually read, not merely that a repository was discovered.
      pushes: { present: repos.length > 0 && pushRead.failed < repos.length, events: pushes.length },
      deploys: { present: deploys.present, events: liveDeploys.length },
      sends: { present: activity.present, events: activity.sends.length },
      runs: { present: runs.present, events: runs.skills.size },
    },
    history_before_recording: history,
    collection: { repos: repos.length, git_read_failures: pushRead.failed },
    scan: {
      visited: scan.visited + named.visited, overflow: scan.overflow || named.overflow, unreadable_dirs: scan.unreadable_dirs + named.unreadable, truncated_dirs: scan.truncated_dirs, complete: scan.complete && named.cut.size === 0, roots: roots.length,
      roots_covered: [...new Set(roots.map((r) => r.channel))].map((channel) => {
        const us = scan.units.filter((u) => u.channel === channel);
        const walked = us.length > 0;
        return { channel, roots: roots.filter((r) => r.channel === channel).length, covered: walked ? us.every((u) => u.covered) : !named.cut.has(channel), walked };
      }),
      incomplete_reasons: [...(scan.complete ? [] : incompleteReasons(scan)), ...[...named.cut].map((ch) => `${CLASS_LABEL[ch] ?? ch}: a directory the activity log named was cut at ${NAMED_DIR_MAX_ENTRIES} entries or unreadable`)],
    },
  };
  invariant(report.reconciled === report.ledgered + report.escapes, "every reconciled event is matched or an escape");
  invariant(report.receipted <= report.ledgered, "a receipted output is a ledgered output");
  opts.emit?.(report);
  return report;
}

/**
 * Why this run's coverage cannot be called clean even with zero escapes: a collector failed or a source the denominator
 * needs was absent. A short denominator would otherwise read as better coverage. Empty means every source was read.
 * Deploys and runs are not listed: a deploy ledger with no deploys yet and a run ledger with no runs are valid, empty states.
 */
export function coverageGaps(r: Report): string[] {
  const gaps: string[] = [];
  if (r.collection.git_read_failures > 0) gaps.push(`${r.collection.git_read_failures} git reflog read${r.collection.git_read_failures === 1 ? "" : "s"} failed`);
  if (!r.sources.pushes.present) gaps.push(r.collection.repos === 0 ? "no repository was discovered, so pushes were not read" : "no repository's push history could be read");
  if (!r.sources.writes.present || !r.sources.sends.present) gaps.push("the tool-activity log is absent, so writes and sends were not read");
  if (!r.sources.files.present) gaps.push("no delivery roots were scanned");
  if (!r.scan.complete) gaps.push("the delivery-root scan is incomplete");
  return gaps;
}

/** Where the event builder's adapter module is looked up, in order: STATVS/adapters (the migration moves them there in p2), then VIGIL/adapters. */
export const adapterDirs = (): string[] => [join(import.meta.dir, "../STATVS/adapters"), join(vigilDir(), "adapters")];

/**
 * One adapter module from the first directory that holds it, or null when none does (a public install). The load fails
 * silently by design, so both locations are tested (migration design §3 Lane E1, S9): a stale path would emit nothing.
 */
export function loadAdapterModule<T>(file: string, dirs: string[] = adapterDirs()): T | null {
  for (const dir of dirs) {
    const path = join(dir, file);
    if (existsSync(path)) return require(path) as T;
  }
  return null;
}

/** The one Vigil event: escape count, medium when the DA produced an output nothing gated; "incomplete" (medium) when coverage was short, never "clean". */
export async function emitVigil(r: Report): Promise<void> {
  const common = loadAdapterModule<{ event: (...a: any[]) => any }>("common.ts");
  const emit = loadVigilEmit();
  if (!common || !emit) return; // Vigil is not installed (a public install)
  const { event } = common;
  const gaps = r.gaps.length ? ` Skills with outputs and no receipts: ${r.gaps.slice(0, 8).join(", ")}.` : "";
  const short = coverageGaps(r);
  const e = event(
    "output-reconciler",
    "coverage",
    r.attributed_escapes > 0 ? "escapes" : short.length > 0 ? "incomplete" : "clean",
    r.attributed_escapes > 0 || short.length > 0 ? "medium" : "info",
    `Output coverage ${r.coverage === null ? "n/a" : `${r.coverage}%`}, ${r.attributed_escapes} escape${r.attributed_escapes === 1 ? "" : "s"}${short.length > 0 ? ", coverage incomplete" : ""}`,
    `${short.length > 0 ? `Coverage incomplete: ${short.join("; ")}. ` : ""}${r.reconciled} reconciled, ${r.receipted} receipted, ${r.ledgered} ledgered, ${r.escapes} unmatched (${r.attributed_escapes} DA-attributed, ${r.unattributed_escapes} unattributed files). ${r.history_before_recording["git-push"] + r.history_before_recording.deploy} pushes and deploys predate the recorder (history, not counted).${gaps}`,
    "ai",
    null,
    r.until.slice(0, 10),
  );
  e.meta = { coverage_gaps: short, escapes: r.attributed_escapes, unmatched: r.escapes, reconciled: r.reconciled, receipted: r.receipted, gate_only: r.gate_only, history_before_recording: r.history_before_recording["git-push"] + r.history_before_recording.deploy };
  emit(e as never);
  if (!r.scan.complete) {
    // The denominator is short: say so loudly rather than let a smaller number read as better coverage.
    const { emitLoud } = await import("../../hooks/lib/handoff-state.ts");
    const parts = r.scan.incomplete_reasons;
    await emitLoud({
      source: "hook:OutputRecord", severity: "medium", title: "Output reconciliation scan incomplete: the denominator is short", // maintainer-side; not in the public release
      summary: `The delivery-root scan did not cover everything: ${parts.join("; ")}. Files not visited are not in the reconciled count.`,
      dedup: `output-reconciler-scan-incomplete:${r.until.slice(0, 13)}`,
    });
  }
}

export function formatReport(r: Report): string {
  const L: string[] = [];
  L.push(`Output reconciliation ${r.since.slice(0, 16)}Z to ${r.until.slice(0, 16)}Z`);
  L.push(`reconciled ${r.reconciled}, receipted ${r.receipted}, ledgered ${r.ledgered}, escapes ${r.escapes} (${r.attributed_escapes} DA-attributed, ${r.unattributed_escapes} unattributed), gate-only ${r.gate_only}`);
  L.push(`coverage (receipted / reconciled): ${r.coverage === null ? "n/a" : r.coverage + "%"}   ledgered / reconciled: ${r.ledgered_coverage === null ? "n/a" : r.ledgered_coverage + "%"}`);
  L.push("by channel:");
  for (const c of r.by_channel) L.push(`  ${c.channel.padEnd(10)} reconciled ${c.reconciled}  receipted ${c.receipted}  ledgered ${c.ledgered}  escapes ${c.escapes}`);
  L.push("per skill:");
  for (const s of r.per_skill) L.push(s.no_outputs ? `  ${s.skill.padEnd(24)} no outputs recorded` : `  ${s.skill.padEnd(24)} outputs ${s.outputs}  receipted ${s.receipted}  ${s.coverage}%${s.gap ? "  GAP" : ""}`);
  if (r.gaps.length) L.push(`gaps (outputs, no receipts): ${r.gaps.join(", ")}`);
  const counts = new Map<string, number>();
  for (const e of r.escape_rows) {
    const k = `${e.channel} ${e.kind}${e.ext ? " ." + e.ext : ""}${e.sha_prefix ? " " + e.sha_prefix : ""}${e.attributed ? "" : " (unattributed)"}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  L.push(`escapes: ${r.escape_rows.length}`);
  for (const [k, n] of [...counts].slice(0, 40)) L.push(`  ${k}${n > 1 ? ` x${n}` : ""}`);
  if (counts.size > 40) L.push(`  ... ${counts.size - 40} more`);
  L.push(`before the recorder started (history, not counted): pushes ${r.history_before_recording["git-push"]}, deploys ${r.history_before_recording.deploy}`);
  L.push(`scan: ${r.scan.roots} root(s) [${r.scan.roots_covered.map((c) => `${c.channel}${c.roots > 1 ? " x" + c.roots : ""} ${c.covered ? (c.walked ? "covered" : "by activity log, not walked") : "NOT COVERED"}`).join(", ")}], ${r.scan.visited} entries, ${r.scan.complete ? "complete" : "INCOMPLETE"}${r.scan.truncated_dirs ? `, ${r.scan.truncated_dirs} directories below the depth bound` : ""}`);
  if (!r.scan.complete) for (const why of r.scan.incomplete_reasons) L.push(`  incomplete: ${why}`);
  L.push("sources: " + Object.entries(r.sources).map(([k, v]) => `${k} ${v.present ? "present" : "ABSENT"}(${v.events})`).join(", "));
  return L.join("\n");
}

/* ── Trend (ISC-12) ─────────────────────────────────────────────────────────────────────────────────────────────── */

export type RunLine = {
  ts: string;
  window: string;
  reconciled: number;
  receipted: number;
  coverage: number | null;
  escapes: number;
  by_skill: Record<string, { outputs: number; receipted: number }>;
  scan_complete: boolean;
};

/** Where the trend lives: MEMORY/OBSERVABILITY/reconciler-runs.jsonl through the resolver; a per-process temp file under `bun test`. */
export function runsFile(home: string = homedir()): string {
  if (process.env.LIFEOS_RECONCILER_RUNS) return process.env.LIFEOS_RECONCILER_RUNS;
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `lifeos-reconciler-runs-test-${process.pid}.jsonl`);
  return lifeosFor(home, "MEMORY", "OBSERVABILITY", "reconciler-runs.jsonl");
}

export function runLine(r: Report, window: string): RunLine {
  const by_skill: RunLine["by_skill"] = {};
  for (const s of r.per_skill) by_skill[s.skill] = { outputs: s.outputs, receipted: s.receipted };
  return { ts: r.until, window, reconciled: r.reconciled, receipted: r.receipted, coverage: r.coverage, escapes: r.escapes, by_skill, scan_complete: r.scan.complete };
}

/** Append one line for this run. Asserts the line is coherent before it is written: a wrong number in a trend is read as history. */
export function appendRun(r: Report, window: string, file: string = runsFile()): RunLine {
  const line = runLine(r, window);
  invariant(Number.isFinite(Date.parse(line.ts)), "a run line carries a valid timestamp");
  invariant(line.receipted <= line.reconciled && line.escapes <= line.reconciled, "a run line cannot receipt or escape more than it reconciled");
  invariant(line.coverage === null || (line.coverage >= 0 && line.coverage <= 100), "coverage is a percentage or null");
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(line) + "\n", { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
  return line;
}

/** The last n runs, oldest first. A torn or foreign line is skipped. */
export function readRuns(n = 10, file: string = runsFile()): RunLine[] {
  if (!existsSync(file)) return [];
  const out: RunLine[] = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r && typeof r.ts === "string" && typeof r.reconciled === "number" && typeof r.receipted === "number") out.push(r as RunLine);
    } catch { /* torn line */ }
  }
  return out.slice(-Math.max(1, n));
}

const fmtCov = (c: number | null): string => (c === null ? "n/a" : c + "%");
/** Coverage change between the last two runs, in points; null when there is no pair or either run had no denominator. */
export function trendDelta(runs: RunLine[]): number | null {
  if (runs.length < 2) return null;
  const a = runs[runs.length - 2]!.coverage;
  const b = runs[runs.length - 1]!.coverage;
  return a === null || b === null ? null : Math.round((b - a) * 10) / 10;
}

export function formatTrend(runs: RunLine[]): string {
  if (runs.length === 0) return "No reconciler runs recorded yet.";
  const L = [`last ${runs.length} reconciler run(s), oldest first:`];
  for (const r of runs) L.push(`  ${r.ts.slice(0, 16)}Z  window ${r.window.padEnd(4)}  coverage ${fmtCov(r.coverage).padStart(6)}  receipted ${r.receipted}/${r.reconciled}  escapes ${r.escapes}${r.scan_complete ? "" : "  scan INCOMPLETE"}`);
  const d = trendDelta(runs);
  L.push(d === null ? "delta: n/a (needs two runs with a denominator)" : `delta vs previous run: ${d > 0 ? "+" : ""}${d} points`);
  return L.join("\n");
}

/** One short line for /ic: the delta against the previous recorded run, or why there is none. */
export function trendSummary(home: string = homedir()): string {
  const runs = readRuns(2, runsFile(home));
  if (runs.length === 0) return "no trend yet";
  const d = trendDelta(runs);
  return d === null ? `trend: ${runs.length} run recorded` : `trend ${d > 0 ? "+" : ""}${d} points vs previous run`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "trend") {
    const li = args.indexOf("--last");
    const n = li > -1 ? Number(args[li + 1]) : 10;
    invariant(Number.isInteger(n) && n >= 1 && n <= 500, "--last is an integer 1-500");
    const runs = readRuns(n);
    console.log(args.includes("--json") ? JSON.stringify({ runs, delta: trendDelta(runs) }, null, 2) : formatTrend(runs));
  } else {
    const i = args.indexOf("--since");
    const window = i > -1 ? (args[i + 1] ?? "24h") : "24h";
    const report = reconcile({ sinceMs: parseSince(window) });
    if (!args.includes("--no-trend")) {
      try { appendRun(report, window); } catch (e) { if (e instanceof InvariantViolation) throw e; console.error(`trend append failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (!args.includes("--no-emit")) {
      try { await emitVigil(report); } catch (e) { console.error(`vigil emit failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
    console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
  }
}
