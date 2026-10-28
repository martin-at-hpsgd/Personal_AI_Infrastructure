#!/usr/bin/env bun
/**
 * @version 1.4.5
 * 1.4.4 (2026-10-15, security P1 batch 2 closing pass, S038/S039): parity with the live hook on the reviewed
 * inputs. The bridge reads an entry's role the way the shared reader does: `human` is the user, and the neutral
 * `type: "message"` envelope names no role, so its role and message.role decide. A call or result in either
 * form pairs again; an entry whose role fields disagree still pairs nothing. A transcript that records no
 * timestamp on a shell write's call or its result gives changedDuring no window, and the parsed target is then
 * credited as the live hooks credited it; one timestamp without the other still proves nothing.
 * 1.4.3 (2026-10-15, security P1 batch 2 final round 2, S038/S039): a shell rewrite of the active ISA folds a
 * mutation again, as the live hook allowed, but only when the shared parser names the ISA as a write target
 * of an answered, successful, non-sidechain Bash call and the file changed between that call and its result
 * (the shared isa-turn reader no longer credits command text, LOSIntegrity S044). The shell-write reader
 * (shellWrittenIsas, changedDuring) lives here so IsaDeployMarkerGate and this gate use one rule.
 * transcriptToolCalls takes { lenient: true } for callers that, after a strict read failed, still look for
 * a violation they can block on: malformed lines are skipped and counted, never a pass by themselves.
 * 1.4.2 (2026-10-15, security P1 batch 2 final round, S038/S039): the bridge pairs a call only from an
 * assistant entry and a result only from a user entry, and a result answers a call only from the same
 * side of a sidechain, as the harness writes them; a forged tool_result inside an assistant entry, or a
 * subagent's result, answers nothing. Each call also carries its result's timestamp. In turn scope, when
 * the 8 MB tail holds no turn opening (a single tool result can be larger than that), the whole file is
 * read, so a long result never hides the turn's earlier calls. An edit or delegation from the shared
 * reader clears the fold only when the bridge confirms an answered, successful, non-sidechain call of
 * that tool and target (the shared reader does not yet tell a subagent's result from the session's).
 * 1.4.1 (2026-10-15, security P1 batch 2 fix round 2, S041/S042): each bridged ToolCall carries the
 * epoch-ms timestamp of the entry that made it and the arrival order of its result, so
 * IsaDeployMarkerGate orders deploys by when they finished and asks a shell write's target file
 * whether it changed after the call. Additive; nothing here reads them.
 * 1.4.0 (2026-10-15, security P1 batch 2 S038/S039): the turn is read through
 * parseTurnEvents({ strict: true }), so an unreadable transcript or a malformed line inside the
 * current turn holds the stop (unchecked fold) instead of reading as "no prod mutation". A
 * MultiEdit of the active ISA folds a mutation like an Edit does, and only an answered, successful
 * write or delegation can clear one. transcriptToolCalls is the one bridge reader for the two
 * things transcript-evidence does not report yet (MultiEdit calls, full result text); it refuses
 * the same unreadable or malformed turn, and ISAGate and IsaDeployMarkerGate read through it too.
 * 1.3.0 (2026-10-14): with an active run, an unreadable or unparseable
 * transcript or an internal error holds the stop once (unchecked fold) instead of passing.
 * ISAFoldGate.hook.ts — the D-50 gate: prod mutated, ISA untouched → fold before closing.
 *
 * Why it does not key on wording: a gate that only wakes on completion
 * PHRASES misses a turn that installs secrets, applies an import, or deploys and then reports
 * in words outside COMPLETION_RE's vocabulary. That turn ends with the state-of-record stale and no
 * gate fired. A production app's D-50 named the failure class ("a fact that changed a criterion got
 * written into narrative instead of into the criterion"); this is its enforcement.
 *
 * BLOCK iff ALL hold; otherwise PASS:
 *   1. not a stop-hook recovery pass (loop guard)
 *   2. the session is bound to an active run in work.json (phase ≠ complete)
 *   3. this turn's transcript contains ≥1 SUCCESSFUL prod-mutating call:
 *      a `deploy`-kind event, a remote D1 write (wrangler d1 execute … --remote with a
 *      write verb or --file), `wrangler secret put`, a remote KV key put/delete, or one
 *      of our own write-flag tools (`--apply`, Release.ts). The cf CLI (Wrangler
 *      replaced 2026-09-29) counts the same: cf d1 query/raw with a write verb or
 *      --batch/--body, d1 migrations apply/import/time-travel restore, workers secrets
 *      update/bulk/delete (and CfEnv.ts secret put), kv keys|bulk put/delete — cf is
 *      remote by default, so only --local or --dry-run exempts one.
 *   4. no answered, successful ISA edit (Edit, Write, MultiEdit or a shell write) in this
 *      turn, and no answered subagent this turn (a delegate may own the fold)
 *   5. the final message does not honestly address ISA state (ISA_ADDRESSED_RE — "ISA
 *      updated", "no ISA delta needed", etc. all pass)
 *
 * There is NO once-per-run latch: every mutating turn owes its fold,
 * so recurrence is the point. Natural termination: the recovery turn either edits the ISA
 * or states why no delta is needed — both pass condition 4/5 next evaluation.
 *
 * Errors: with an active run, a transcript that cannot be read, a current turn with a line that is
 * not valid JSON, or an internal error holds the stop once (unchecked fold); the re-stop carries
 * stop_hook_active and passes. With no active run there is nothing to hold.
 * Kill switch: ISAFOLDGATE_OFF=1.
 * TRIGGER: Stop (evaluated inside StopGates.hook.ts)
 */

import type { HookInput } from "./lib/hook-io";
import { parseTurnEvents, spawnedAgent, type TxEvent } from "./lib/transcript-evidence";
import { findActiveSessionByUUID } from "./lib/isa-utils";
import { isaEditedThisTurn, ISA_ADDRESSED_RE } from "./lib/isa-turn";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "fs";
import { effectiveProgram, inlineCodeBodies, writeView } from "./lib/shell-commands";
import { pathForms, realPathOf, resolveSteps, substituteWord } from "./lib/shell-paths";
import { dirname, isAbsolute, join } from "path";
import { getLifeosDir } from "./lib/paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

const LIFEOS = getLifeosDir();
const OBS_PATH = join(LIFEOS, "MEMORY", "OBSERVABILITY", "isa-fold-gate.jsonl");

/** A cf CLI invocation (bare, bunx, pinned, or forwarded by CfEnv.ts). cf talks to the remote
 * account by default, so a real --local or --dry-run argument in its own simple command is the
 * only way one of its writes stays off prod. Which words are real arguments is decided on the
 * shell-parsed command (simpleCommands), never by a regex over raw text: `"... --local"` inside
 * a quoted SQL string is one argument, not the flag (hooks audit shard ad #6). */
const CF_CMD = String.raw`(?:\bcf(?:@\S+)?|CfEnv\.ts)\s+(?:cf\s+)?`;
/** The old text-level exemption. Used only when the command cannot be shell-parsed
 * (an unbalanced quote): the shell refuses that command too, so nothing new passes. */
const CF_REMOTE_TEXT = String.raw`${CF_CMD}(?![^\n;&|]*\s--(?:local|dry-run)\b)`;

const cfMutationRes = (cf: string): RegExp[] => [
  new RegExp(String.raw`${cf}d1\s+(?:query|raw)\s+\S+[^\n]*(?:--batch|--body|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bCREATE\b|\bALTER\b|\bDROP\b|\bREPLACE\b)`, "is"),
  new RegExp(String.raw`${cf}d1\s+(?:migrations\s+apply|import|time-travel\s+restore)\b`, "i"),
  new RegExp(String.raw`${cf}workers\s+secrets\s+(?:update|bulk|delete)\b`, "i"),
  new RegExp(String.raw`${cf}kv\s+(?:keys|bulk)\s+(?:put|delete)\b`, "i"),
];
/** cf CLI, bare / bunx / through CfEnv.ts, matched per simple command. */
const CF_MUTATION_RES = cfMutationRes(CF_CMD);
const CF_MUTATION_TEXT_RES = cfMutationRes(CF_REMOTE_TEXT);
const CF_EXEMPT_ARGS = new Set(["--local", "--dry-run", "--local=true", "--dry-run=true"]);

/** Split a shell command into simple commands, each with its raw text and its words
 * after quote removal. Separators are unquoted ; & | newline ( ) ` and $( . Null when a
 * quote is left open: the input is not a command the shell would run as written. */
export function simpleCommands(command: string): { raw: string; words: string[] }[] | null {
  const out: { raw: string; words: string[] }[] = [];
  let raw = "";
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const endWord = () => { if (inWord) words.push(word); word = ""; inWord = false; };
  const endCommand = () => { endWord(); if (raw.trim()) out.push({ raw, words }); raw = ""; words = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      raw += c;
      if (c === "'") quote = null; else word += c;
      continue;
    }
    if (quote === '"') {
      raw += c;
      if (c === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) { word += command[++i]!; raw += command[i]!; }
      else if (c === '"') quote = null;
      else word += c;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) { raw += c + command[i + 1]!; word += command[++i]!; inWord = true; continue; }
    if (c === "'" || c === '"') { quote = c; inWord = true; raw += c; continue; }
    if (c === "$" && command[i + 1] === "(") { endCommand(); i++; continue; }
    if (";&|\n()`".includes(c)) { endCommand(); continue; }
    raw += c;
    if (c === " " || c === "\t") endWord();
    else { word += c; inWord = true; }
  }
  if (quote) return null;
  endCommand();
  return out;
}

/** A cf write that stays off prod only through a real --local/--dry-run argument. */
function cfProdMutation(command: string): boolean {
  if (!CF_MUTATION_RES.some((re) => re.test(command))) return false;
  const parts = simpleCommands(command);
  if (!parts) return CF_MUTATION_TEXT_RES.some((re) => re.test(command));
  return parts.some((p) => CF_MUTATION_RES.some((re) => re.test(p.raw)) && !p.words.some((w) => CF_EXEMPT_ARGS.has(w)));
}

/** Prod-mutating command shapes. Conservative and explicit: each one is a class this
 * system actually uses to change remote state. A plain local test/build never matches.
 * cf CLI writes are matched separately by cfProdMutation. */
const PROD_MUTATION_RES: RegExp[] = [
  /wrangler\s+d1\s+execute\s+\S+[^\n]*--remote[^\n]*(--file|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bCREATE\b|\bALTER\b)/is,
  /wrangler\s+secret\s+put\b/i,
  /wrangler\s+kv\s+key\s+(put|delete)\b/i,
  /CfEnv\.ts\s+(?:cf\s+)?secret\s+put\b/i,
  /Tools\/Release\.ts\b/,
  /\s--apply\b/, // our importers' one write flag (ImportBackfill, ProvisionPortal, …)
];

/** A search/display command whose ARGUMENTS routinely contain the exact strings
 * PROD_MUTATION_RES hunts for — `rg -n "Tools/Release.ts"` is a grep, not a
 * release. Only these three tests together are safe: the exemption applies solely
 * to a single unchained invocation, so `rg x && wrangler secret put y` keeps its
 * teeth, and none of these binaries can run a subcommand from argv (which is why
 * `find`/`fd`/`awk`/`sed` are deliberately absent — they have -exec/system()).
 *
 * `less` and `bat` are absent for the same reason: both are pagers with shell
 * escapes (`less` runs `!cmd` and honours LESSOPEN; `bat` shells out to its
 * pager), so an exempted invocation is not a guaranteed read. EXEC_FLAG_RE
 * covers the remaining argv-level escapes: any flag that hands the exempted
 * binary a command to run turns a "grep" into arbitrary execution — `rg --pre
 * <cmd>` / `--pre-glob`, `rg --hostname-bin <cmd>`, `ack --pager=<cmd>`. Testing
 * the whole command for these is the tightest form of the same rule.
 * (ported from public PR #1738, @elhoim; exemption tightened here) */
const READ_ONLY_CMD_RE = /^\s*(rg|grep|egrep|fgrep|ag|ack|cat|head|tail|ls|wc)\b/;
const SHELL_CHAIN_RE = /[;&|`\n]|\$\(/;
const EXEC_FLAG_RE = /--(pre|pre-glob|hostname-bin|pager)\b/;

export function prodMutations(ev: TxEvent[]): TxEvent[] {
  return ev.filter((e) => {
    if (e.isError) return false; // a failed attempt changed nothing
    if (e.kind === "deploy") return true;
    if (e.kind !== "command") return false;
    if (READ_ONLY_CMD_RE.test(e.target) && !SHELL_CHAIN_RE.test(e.target) && !EXEC_FLAG_RE.test(e.target)) return false;
    // Match on the command text only, never its output.
    return PROD_MUTATION_RES.some((re) => re.test(e.target)) || cfProdMutation(e.target);
  });
}

// ── the bridge reader: what transcript-evidence does not report yet ─────────

/** The tail a Stop gate judges in turn scope; the same 8 MB transcript-evidence reads. */
const TURN_CAP_BYTES = 8 * 1024 * 1024;

/** One tool call, paired with its result by id. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
  /** A tool_result for this call exists. An unanswered call is not evidence that anything ran. */
  answered: boolean;
  /** Answered and not an error. */
  ok: boolean;
  /** The full result text (transcript-evidence keeps only its first 4,000 characters). */
  resultText: string;
  /** The call was made inside a subagent's sidechain, not by this session. */
  sidechain: boolean;
  /** Epoch-ms timestamp of the transcript entry that made the call; null when it carries none. */
  ts: number | null;
  /** Arrival position of this call's result among all results paired in scope (0 first); -1 when unanswered. */
  resultOrder: number;
  /** Epoch-ms timestamp of the entry that carried the result; null when unanswered or it carries none. */
  resultTs: number | null;
}

/** A strict read refuses any malformed line in scope; a lenient one skips it and counts it in `malformed`. */
export type CallsRead = { ok: true; calls: ToolCall[]; malformed: number } | { ok: false; reason: string };

/** The entry that opens a turn: a user/human message with text that is not only tool results.
 *  The rule transcript-evidence's turn boundary uses. */
function opensTurn(e: Record<string, any>): boolean {
  const role = e.role ?? e.message?.role ?? e.type;
  if (role !== "user" && role !== "human") return false;
  const content = e.message?.content ?? e.content;
  if (Array.isArray(content) && content.length && content.every((b: any) => b?.type === "tool_result")) return false;
  return typeof content === "string" ? content.trim().length > 0
    : Array.isArray(content) && content.some((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim());
}

function resultTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  return "";
}

/**
 * The entry is written by `role` as the harness writes it: every role field it carries (`type`,
 * `role`, `message.role`) names that role, and it carries at least one. As in the shared reader,
 * `human` names the user, and `type: "message"` is the neutral envelope that names no role (S038).
 */
function writtenBy(e: Record<string, any>, role: "assistant" | "user"): boolean {
  const named = [e.type === "message" ? null : e.type, e.role, e.message?.role]
    .filter((v): v is string => typeof v === "string")
    .map((v) => (v === "human" ? "user" : v));
  return named.length > 0 && named.every((v) => v === role);
}

/** The entry's own `timestamp` as epoch-ms, or null when it has none that parses. */
function entryMs(e: Record<string, any>): number | null {
  const ms = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Tool calls of the current turn ("turn") or of the whole session ("session"), each paired with its
 * result by id. A bridge, not a second evidence reader: transcript-evidence's parseTurnEvents is the
 * reader and judge of the turn, and this exists only for what it does not report yet, a MultiEdit
 * call (it emits no event for one) and a Bash result's full text across the whole session (it keeps
 * 4,000 characters of an 8 MB tail). Both are requested of transcript-evidence's owner; when they
 * land, the callers drop this. It refuses what strict parseTurnEvents refuses: a transcript that is
 * missing, unreadable or not a regular file, and a line in scope that is not a JSON object (the
 * cut-off first line of a turn-scope tail read excepted). Session scope reads the whole file.
 */
export function transcriptToolCalls(path: unknown, scope: "turn" | "session", opts: { lenient?: boolean } = {}): CallsRead {
  if (typeof path !== "string" || !path) return { ok: false, reason: "no transcript path was given" };
  let buf: Buffer;
  try {
    if (!statSync(path).isFile()) return { ok: false, reason: "the transcript is not a regular file" };
    buf = readFileSync(path);
  } catch {
    return { ok: false, reason: "the transcript could not be read" };
  }
  const rowsOf = (text: string) => {
    const rows: { line: number; entry: Record<string, any> | null }[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i]!.trim();
      if (!s) continue;
      let entry: Record<string, any> | null = null;
      try {
        const v = JSON.parse(s);
        entry = v && typeof v === "object" && !Array.isArray(v) ? v : null;
      } catch { entry = null; }
      rows.push({ line: i + 1, entry });
    }
    return rows;
  };
  const opening = (rows: { entry: Record<string, any> | null }[]) => {
    for (let k = rows.length - 1; k >= 0; k--) {
      const e = rows[k]!.entry;
      if (e && opensTurn(e)) return k;
    }
    return -1;
  };
  let rows: { line: number; entry: Record<string, any> | null }[];
  let start = 0;
  if (scope === "turn" && buf.length > TURN_CAP_BYTES) {
    const tail = buf.subarray(buf.length - TURN_CAP_BYTES).toString("utf-8");
    rows = rowsOf(tail.slice(tail.indexOf("\n") + 1));
    start = opening(rows);
    // The turn opened before the tail (one result can be larger than the cap): read the whole turn.
    if (start < 0) { rows = rowsOf(buf.toString("utf-8")); start = Math.max(0, opening(rows)); }
  } else {
    rows = rowsOf(buf.toString("utf-8"));
    if (scope === "turn") start = Math.max(0, opening(rows));
  }
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  let arrived = 0;
  let malformed = 0;
  for (let k = start; k < rows.length; k++) {
    const r = rows[k]!;
    if (!r.entry) {
      if (!opts.lenient) return { ok: false, reason: `a line of the ${scope === "turn" ? "current turn" : "session"} is not a valid transcript entry (line ${r.line})` };
      malformed++;
      continue;
    }
    const content = r.entry.message?.content ?? r.entry.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        if (!writtenBy(r.entry, "assistant")) continue; // only the assistant makes a call
        if (byId.has(b.id)) continue; // a transcript can repeat an entry; one call per id
        const c: ToolCall = {
          id: b.id, name: b.name, input: b.input && typeof b.input === "object" ? b.input : {},
          answered: false, ok: false, resultText: "", sidechain: r.entry.isSidechain === true,
          ts: entryMs(r.entry), resultOrder: -1, resultTs: null,
        };
        calls.push(c);
        byId.set(b.id, c);
      } else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        const c = byId.get(b.tool_use_id);
        if (!c || c.answered) continue;
        // Only a user entry carries a result, and only from the same side of a sidechain as its call.
        if (!writtenBy(r.entry, "user") || (r.entry.isSidechain === true) !== c.sidechain) continue;
        c.answered = true;
        c.ok = b.is_error !== true;
        c.resultText = resultTextOf(b.content);
        c.resultOrder = arrived++;
        c.resultTs = entryMs(r.entry);
      }
    }
  }
  return { ok: true, calls, malformed };
}

/** Answered, successful MultiEdit calls of this session as edit events (transcript-evidence emits none for them). */
function multiEditEvents(calls: ToolCall[]): TxEvent[] {
  return calls
    .filter((c) => c.name === "MultiEdit" && c.ok && !c.sidechain && typeof c.input.file_path === "string" && c.input.file_path)
    .map((c, i) => ({
      seq: -1 - i, kind: "edit" as const, tool: "MultiEdit", target: String(c.input.file_path), resultText: c.resultText,
      isError: false, isToolError: false, isCode: false, hasResult: true,
    }));
}

// ── shell writes: parsed write targets, confirmed by the file's mtime ──────

const ISA_FILE_RE = /(?:^|\/)ISA\.md$/;
/** The result entry's timestamp is cut to whole milliseconds; a write in that same millisecond is still inside. */
const RESULT_TS_GRAIN_MS = 1;
// Write targets a parsed simple command names beyond its redirects.
const IN_PLACE = new Set(["sed", "gsed", "perl"]);
const DEST_LAST = new Set(["cp", "mv", "install", "rsync", "ditto"]);
/** A file-write call inside inline interpreter code; the ISA literals beside it are its candidate targets. */
const CODE_WRITE_API = /\b(?:writeFileSync|appendFileSync|writeFile|appendFile|Bun\.write|copyFileSync|renameSync|cpSync|write_text)\s*\(|\bopen\([^)]*["'][wa]\+?["']/;
const realOf = (p: string): string => realPathOf(isAbsolute(p) ? p : join(process.cwd(), p)).real;

/**
 * Real paths of the ISA.md files `command` may write, read from the shared parser (shell-paths
 * resolveSteps over shell-commands): its `>`/`>>` redirect targets, tee operands, in-place sed/perl
 * files, a cp/mv/install destination, dd of=, and ISA.md literals in inline interpreter code that
 * calls a write API (`bun -e`, a heredoc fed to `bun -`). A relative word resolves against the
 * directories the line's own `cd` reached; with none known it is not counted. A word that only
 * appears in the text (`git add ISA.md`, `rg … ISA.md`, an echo) is never a write (S042, S044). These
 * are candidates: a caller credits one only when changedDuring shows the file changed while the call ran.
 */
export function shellWrittenIsas(command: string): Set<string> {
  const out = new Set<string>();
  if (!/ISA\.md/.test(command)) return out;
  const rs = resolveSteps(command, null);
  const add = (word: string | null | undefined, cwds: readonly string[]) => {
    if (!word || !ISA_FILE_RE.test(word)) return;
    if (isAbsolute(word)) { out.add(realOf(word)); return; }
    for (const c of cwds) out.add(pathForms(word, c).real);
  };
  const codeWrites = (body: string, cwds: readonly string[]) => {
    if (!CODE_WRITE_API.test(body)) return;
    for (const m of body.matchAll(/(["'`])([^"'`\s]*ISA\.md)\1/g)) add(substituteWord(m[2]!, rs.vars), cwds);
  };
  for (const { step, words, cwds } of rs.steps) {
    for (const t of step.writeTargets) add(substituteWord(t, rs.vars), cwds);
    const ws = words.filter((w): w is string => w !== null);
    const { program, args } = effectiveProgram(ws);
    const operands = args.filter((a) => a && !a.startsWith("-"));
    if (program === "tee") for (const w of operands) add(w, cwds);
    else if (IN_PLACE.has(program) && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) for (const w of operands) add(w, cwds);
    else if (DEST_LAST.has(program) && operands.length >= 2) add(operands[operands.length - 1], cwds);
    else if (program === "dd") for (const a of args) if (a.startsWith("of=")) add(a.slice(3), cwds);
    for (const body of inlineCodeBodies(ws)) codeWrites(body, cwds);
  }
  // Heredoc and here-string code fed to an interpreter (`bun - <<'EOF'`), judged against every directory the line reached.
  for (const body of writeView(command).code) codeWrites(body, rs.cwds);
  return out;
}

/**
 * The file changed while the call that targeted it ran: its mtime falls between the call's transcript
 * timestamp and its result's. A call or result with only one of the two timestamps, or a missing file,
 * proves nothing. A transcript that records neither gives no window to read, and the parsed target is
 * credited as the live hooks credited a shell write (closing-pass parity).
 * This separates a write from a command that only names the ISA as a destination and leaves it as it
 * was (`cp -n`, `dd count=0 conv=notrunc`, a write after `exit`, inline code that writes somewhere
 * else), including when the file was last written just before the call or rewritten by something else
 * after it (S042, S044). A filesystem with 1-second mtimes can floor a real write below the call; that
 * write is then not credited, the stricter reading.
 */
export function changedDuring(real: string, from: number | null, to: number | null): boolean {
  if (from === null && to === null) return true;
  if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to)) return false;
  try {
    const m = statSync(real).mtimeMs;
    return m >= from && m <= to + RESULT_TS_GRAIN_MS;
  } catch {
    return false;
  }
}

/**
 * Answered, successful, non-sidechain Bash calls that rewrote an ISA, as edit events: the parsed write
 * targets name it and the file changed between the call and its result. A command the parser cannot
 * read credits nothing (the stricter reading).
 */
export function shellIsaEdits(calls: ToolCall[]): TxEvent[] {
  const out: TxEvent[] = [];
  for (const c of calls) {
    if (c.name !== "Bash" || !c.ok || c.sidechain || typeof c.input.command !== "string") continue;
    let targets: Set<string>;
    try { targets = shellWrittenIsas(c.input.command); } catch { continue; }
    for (const real of targets) {
      if (!changedDuring(real, c.ts, c.resultTs)) continue;
      out.push({
        seq: -100_000 - out.length, kind: "edit", tool: "Bash", target: real, resultText: c.resultText,
        isError: false, isToolError: false, isCode: false, hasResult: true,
      });
    }
  }
  return out;
}

/**
 * The shared reader's events that may clear a fold obligation. An edit or a delegation counts only when
 * the bridge, which pairs a result only from a user entry on the same side of a sidechain as its call,
 * has an answered, successful, non-sidechain call of that tool and target this turn; a subagent's result
 * answering the session's call never clears the fold. Other events pass through unchanged.
 */
export function confirmedCredit(ev: TxEvent[], calls: ToolCall[]): TxEvent[] {
  const ok = calls.filter((c) => c.ok && !c.sidechain);
  const targetOf = (c: ToolCall): string =>
    c.name === "Agent" || c.name === "Task" ? String(c.input.description ?? c.name) : String(c.input.file_path ?? c.input.notebook_path ?? "");
  return ev.filter((e) => {
    if (e.hasResult === false) return false;
    if (e.kind !== "edit" && e.kind !== "agent-result") return true;
    return ok.some((c) => c.name === e.tool && targetOf(c) === e.target);
  });
}

function obs(entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(OBS_PATH), { recursive: true });
    appendFileSync(OBS_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* observability must never break the gate */
  }
}

/**
 * The hold returned when an active run's fold obligation could not be evaluated. The
 * re-stop right after it carries stop_hook_active and passes, so an evaluation error
 * costs one restate and never wedges the session.
 */
function unevaluated(slug: string, isa: unknown, why: string): object {
  return {
    decision: "block",
    reason:
      `ISA FOLD UNCHECKED [ISAFoldGate/D-50]. The run '${slug}' is active, but this turn could not be checked for ` +
      `prod-mutating calls (${why}). If this turn changed live state, fold it into ${typeof isa === "string" && isa ? isa : "the run's ISA"} now; ` +
      `otherwise say plainly that no ISA delta is needed, then restate.`,
  };
}

export async function run(input: HookInput): Promise<object | null> {
  let active: { slug: string; session: Record<string, any> } | null = null;
  try {
    if (process.env.ISAFOLDGATE_OFF === "1") return null;
    if ((input as { stop_hook_active?: boolean }).stop_hook_active) return null;

    active = findActiveSessionByUUID(input.session_id);
    if (!active || active.session?.phase === "complete") return null;

    // An unreadable transcript, or a current turn with a line that is not valid JSON, is an
    // unknown turn, never an empty one (S038): strict parseTurnEvents throws on both.
    let ev: TxEvent[];
    try {
      ev = parseTurnEvents(input.transcript_path, { strict: true });
    } catch (err) {
      const why = typeof (err as { reason?: unknown })?.reason === "string" ? (err as { reason: string }).reason : "the transcript could not be parsed";
      obs({ decision: "block-transcript-unchecked", slug: active.slug, why });
      return unevaluated(active.slug, active.session?.isa, why);
    }
    const turn = transcriptToolCalls(input.transcript_path, "turn");
    if (!turn.ok) {
      obs({ decision: "block-transcript-unchecked", slug: active.slug, why: turn.reason });
      return unevaluated(active.slug, active.session?.isa, turn.reason);
    }

    const mutations = prodMutations(ev);
    if (mutations.length === 0) return null;
    const isaRef = typeof active.session?.isa === "string" && active.session.isa ? active.session.isa : "";
    const activeIsa = isaRef ? (isAbsolute(isaRef) ? isaRef : join(LIFEOS, isaRef)) : undefined;
    // What clears the obligation is credited only when it was answered (an interrupted call is not a
    // write or a delegation), and a MultiEdit is an edit like any other (S039).
    // A shell rewrite counts only when its parsed target is the ISA and the file really changed (S044).
    const credited = [...confirmedCredit(ev, turn.calls), ...multiEditEvents(turn.calls), ...shellIsaEdits(turn.calls)];
    if (isaEditedThisTurn(credited, activeIsa)) {
      obs({ decision: "pass-isa-edited", slug: active.slug, mutations: mutations.length });
      return null;
    }
    if (spawnedAgent(credited)) {
      obs({ decision: "pass-delegated", slug: active.slug });
      return null;
    }

    const message = (input as { last_assistant_message?: string }).last_assistant_message ?? "";
    if (ISA_ADDRESSED_RE.test(message)) {
      obs({ decision: "pass-isa-addressed", slug: active.slug });
      return null;
    }

    const sample = mutations
      .slice(0, 3)
      .map((m) => (m.kind === "deploy" ? "deploy" : m.target.slice(0, 60)))
      .join(" · ");
    obs({ decision: "block", slug: active.slug, mutations: mutations.length, sample });
    return {
      decision: "block",
      reason:
        `ISA FOLD GAP [ISAFoldGate/D-50]. This turn changed live state (${mutations.length} prod-mutating call(s): ${sample}) ` +
        `on the run '${active.slug}', but its ISA was not touched and the reply does not address ISA state. ` +
        `A fact that changes a criterion goes into the criterion, same turn (D-50; Algorithm criteria 12-14). ` +
        `Fold the new state into ${active.session.isa || "the run's ISA"} now (evidence stubs on affected criteria, ` +
        `progress/phase if changed), then restate — or state explicitly why no ISA delta is needed.`,
    };
  } catch (err) {
    // Before an active run is known there is no fold obligation to hold. After it is,
    // an error means the obligation was never evaluated.
    if (!active || active.session?.phase === "complete") {
      obs({ decision: "pass-error-no-run", error: String(err).slice(0, 200) });
      return null;
    }
    obs({ decision: "block-error", slug: active.slug, error: String(err).slice(0, 200) });
    return unevaluated(active.slug, active.session?.isa, "an internal error stopped the check");
  }
}
