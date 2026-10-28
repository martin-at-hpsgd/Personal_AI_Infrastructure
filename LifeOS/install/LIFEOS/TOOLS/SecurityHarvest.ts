#!/usr/bin/env bun
/**
 * SecurityHarvest — turn our own session transcripts into a security decision ledger.
 *
 * Every moment a layer stopped or questioned a tool call (a native permission rule, a
 * PreToolUse guard, the auto-mode classifier, or the principal) becomes one JSON line,
 * with the tool, a redacted input excerpt, a derived shape, the deciding layer, the
 * verdict, and WHO supplied the label: `human`, `classifier` (auto-mode, an independent
 * proxy) or `regex` (our own guards, a proxy that must never grade itself). Each stop
 * also carries the next genuine principal message and a heuristic reaction class, which
 * is a pointer for later human labelling, never a label. Base-rate negatives (calls that
 * ran with no stop) and PostToolUse injection-marker sightings ride the same ledger.
 *
 * Usage:
 *   bun LIFEOS/TOOLS/SecurityHarvest.ts harvest [--root DIR] [--limit-files N] [--out FILE] [--summary FILE]
 *   bun LIFEOS/TOOLS/SecurityHarvest.ts help --json
 *
 * Output: the ledger (0600, rewritten atomically each run) and a summary markdown that
 * holds shapes and counts only — no raw command text, names, hosts or secrets.
 * Exit codes: 0 ok · 1 runtime error · 2 bad arguments · 3 incomplete (unreadable input or malformed records; ledger preserved)
 * --limit-files is a sample: it needs explicit --out and --summary that are not the canonical outputs, through any link or alias.
 *
 * @version 1.1.0
 */

import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { invariant } from "./Invariant";
import { atomicWrite as writeAtomic, confinedPath } from "./lib/Boundary";
import { getClaudeDir, lifeosPath } from "./Paths";
import { redactForEngine } from "../ASSAY/Engine";
import { outboundClass } from "../../hooks/lib/outbound-shapes";
import { hasNonOwnedUrl, isOwnedHost } from "../../hooks/lib/taint";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LabelSource = "human" | "classifier" | "regex";
export type Verdict = "deny" | "ask" | "allow-after-ask" | "rejected" | "ran" | "flagged";
export type Kind = "denial" | "ask" | "ran" | "injection-marker";
export type Reaction = "override" | "affirm" | "unrelated" | "none";
export const LABEL_SOURCES: ReadonlySet<string> = new Set(["human", "classifier", "regex"]);

export type Shape = {
  heads?: string[];
  flags?: string[];
  host_class: "owned" | "non-owned" | "none";
  outbound?: string | null;
  path_class?: string;
  tainted: boolean;
};

export type DecisionEvent = {
  kind: Kind;
  session: string;
  ts: string;
  tool: string;
  tool_use_id: string;
  input_excerpt: string;
  shape: Shape;
  layer: string;
  verdict: Verdict;
  /** What the stop actually was: security, budget, routing, language-policy, harness, availability, interrupt, negative. */
  category: string;
  label_source: LabelSource;
  denial_kind?: string;
  answered_by?: "human" | "auto-permission" | null;
  outcome?: "ran" | "rejected" | "denied" | "unknown";
  principal_next?: string | null;
  reaction?: Reaction;
  reaction_source?: "heuristic";
  sidechain: boolean;
  entrypoint: string;
  source_class?: string;
};

type ToolUse = { id: string; name: string; input: Record<string, unknown>; ts: string; sidechain: boolean };

export type FileResult = {
  events: DecisionEvent[];
  toolCounts: Map<string, number>;
  ranCounts: Map<string, number>;
  candidates: DecisionEvent[];
  autoAllowWithoutHookAsk: number;
  /** Records that are not a JSON object, or that name a tool call, ask or denial without its id (S101). A torn last line is one. */
  malformedRecords: number;
};

// ── Redaction ─────────────────────────────────────────────────────────────────

const HOME = homedir();
const HOME_RE = new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
const USERS_RE = /\/(?:Users|home)\/(?!<home>)[^/\s"'\\]+/g;

/** Secret shapes, emails, phones and home paths out; capped. Redact, cut, redact again. */
export function redact(text: string, max: number): string {
  const first = redactForEngine(text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(HOME_RE, "~").replace(USERS_RE, "/<home>"), max + 4096);
  const cut = first.length > max ? first.slice(0, max) + " …" : first;
  return redactForEngine(cut, max + 16);
}

/** True when text still carries a secret, email, phone or home path that our redaction would change. */
export function hasSensitiveShape(text: string): boolean {
  if (text.includes(HOME)) return true;
  USERS_RE.lastIndex = 0;
  if (USERS_RE.test(text)) return true;
  return redactForEngine(text, Number.MAX_SAFE_INTEGER) !== text;
}

// ── Shapes ────────────────────────────────────────────────────────────────────

const SAFE_TOKEN = /^[A-Za-z0-9._+-]{1,40}$/;
const URL_HOST_RE = /https?:\/\/([^\s/'"`)]+)/gi;
const SENSITIVE_PATH: ReadonlyArray<[RegExp, string]> = [
  [/(^|\/)\.env(\.|$|\b)/, "sensitive:env"],
  [/(^|\/)\.ssh\//, "sensitive:ssh"],
  [/(^|\/)\.aws\//, "sensitive:aws"],
  [/credential|secret|token|keychain|\.pem$|id_rsa|id_ed25519/i, "sensitive:credential"],
  [/\/SECURITY\//, "sensitive:security-config"],
  [/settings(\.local)?\.json$/, "sensitive:harness-settings"],
  [/(^|\/)hooks\//, "sensitive:hooks"],
];

function hostClass(text: string): Shape["host_class"] {
  let seen = false;
  for (const m of text.matchAll(URL_HOST_RE)) {
    seen = true;
    if (!isOwnedHost(m[1] ?? "")) return "non-owned";
  }
  return seen ? "owned" : "none";
}

/** Executable heads of a Bash command: first word of each segment, env-assigns and `cd` skipped. */
export function bashHeads(command: string): string[] {
  const heads: string[] = [];
  // Heredoc bodies and quoted payloads are data, not executables: drop them before splitting.
  const bare = command
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, " ")
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, " __q__ ")
    .replace(/\$\([^)]*\)|`[^`]*`/g, " __q__ ");
  for (const seg of bare.split(/&&|\|\||[;|\n]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    const w = words[i];
    if (!w || w === "cd" || w === "__q__" || w.startsWith("#") || w.startsWith("-")) continue;
    let head = basename(w.replace(/^["'(]+|["')]+$/g, ""));
    if (["bun", "node", "bunx", "bash", "sh", "zsh"].includes(head)) {
      const next = words.slice(i + 1).find(x => !x.startsWith("-"));
      if (next && /\.(?:ts|js|sh|mjs)$/.test(next)) head = `${head} ${basename(next)}`;
      else if (next && head === "bunx") head = `bunx ${basename(next)}`;
    }
    head = head.split(" ").every(p => SAFE_TOKEN.test(p)) ? head : "other";
    if (!heads.includes(head)) heads.push(head);
    if (heads.length >= 6) break;
  }
  return heads;
}

function bashFlags(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/(?:^|\s)(--?[A-Za-z][A-Za-z0-9-]{0,24})(?=[\s=]|$)/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
    if (out.length >= 10) break;
  }
  return out;
}

/** Generic class of a file path: a sensitive kind, or the first tree segments with the home dir stripped. */
export function pathClass(path: string): string {
  for (const [re, name] of SENSITIVE_PATH) if (re.test(path)) return name;
  const p = path.replace(HOME_RE, "~");
  if (p.startsWith("~/.claude/")) {
    const segs = p.slice(10).split("/").filter(Boolean);
    return "claude:" + segs.slice(0, Math.min(2, segs.length - 1)).filter(s => SAFE_TOKEN.test(s)).join("/");
  }
  if (/^~\/[A-Za-z]*Projects\//.test(p)) return "projects";
  if (p.startsWith("~/Downloads/")) return "downloads";
  if (p.startsWith("~/")) return "home-other";
  if (/^\/(?:private\/)?tmp\//.test(p)) return "tmp";
  return p ? "system" : "none";
}

/** Any shape token that still looks like a secret, email, phone or home path becomes a placeholder. */
function scrubToken(v: string): string {
  return hasSensitiveShape(JSON.stringify(v)) ? "[redacted-token]" : v;
}

export function deriveShape(tool: string, input: Record<string, unknown>, tainted: boolean): Shape {
  const s = rawShape(tool, input, tainted);
  return {
    ...s,
    ...(s.heads ? { heads: s.heads.map(scrubToken) } : {}),
    ...(s.flags ? { flags: s.flags.map(scrubToken) } : {}),
    ...(s.path_class ? { path_class: scrubToken(s.path_class) } : {}),
  };
}

function rawShape(tool: string, input: Record<string, unknown>, tainted: boolean): Shape {
  if (tool === "Bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    return { heads: bashHeads(cmd), flags: bashFlags(cmd), host_class: hostClass(cmd), outbound: outboundClass(cmd, hasNonOwnedUrl), tainted };
  }
  const path = ["file_path", "path", "notebook_path"].map(k => input[k]).find(v => typeof v === "string") as string | undefined;
  const url = typeof input.url === "string" ? input.url : "";
  return { host_class: url ? hostClass(url) : "none", path_class: path ? pathClass(path) : undefined, tainted };
}

// ── Denial parsing ────────────────────────────────────────────────────────────

const HOOK_ERR_RE = /^Error: PreToolUse:([A-Za-z0-9_.-]+) hook error: \[([^\]]*)\]:\s*([\s\S]*)$/;

/** Name of the guard from a hook path: `…/hooks/TextingGuard.hook.ts` → TextingGuard. */
export function guardName(hookPath: string): string {
  const m = hookPath.match(/([A-Za-z0-9_-]+)\.hook\.ts\b/) ?? hookPath.match(/([A-Za-z0-9_-]+)\.(?:ts|js|sh)\b/);
  return m ? m[1]! : "unknown";
}

/** The sub-guard named inside a composite guard's message (PreToolGuard hosts several). */
function innerGuard(message: string): string | null {
  const m = message.match(/\b([A-Z][A-Za-z]+(?:Guard|Budget|Gate))\b/);
  return m ? m[1]! : null;
}

function categoryOf(message: string): string {
  if (/MECHANICAL CALL LIMIT|AgentBudget/i.test(message)) return "budget";
  if (/codex worker|is a codex/i.test(message)) return "routing";
  if (/inline Python|python invocation|inline perl|inline ruby/i.test(message)) return "language-policy";
  if (/No tools needed for summary/.test(message)) return "harness";
  return "security";
}

export type DenialInfo = { layer: string; label_source: LabelSource; verdict: Verdict; category: string; sub_guard?: string };

/** Classify one denied tool_result. `kind` is toolDenialKind (may be absent on older hook errors). */
export function classifyDenial(kind: string | undefined, result: string): DenialInfo {
  const hook = result.match(HOOK_ERR_RE);
  if (hook) {
    const inner = innerGuard(hook[3]!);
    return { layer: `hook:${guardName(hook[2]!)}`, label_source: "regex", verdict: "deny", category: categoryOf(hook[3]!), ...(inner ? { sub_guard: inner } : {}) };
  }
  switch (kind) {
    case "user-rejected":
      return { layer: "user", label_source: "human", verdict: "rejected", category: "security" };
    case "interrupted":
    case "cancelled":
      return { layer: "user", label_source: "human", verdict: "rejected", category: "interrupt" };
    case "automode-blocked":
      return { layer: "automode-classifier", label_source: "classifier", verdict: "deny", category: "security" };
    case "automode-unavailable":
    case "automode-parsing-error":
      return { layer: "automode-classifier", label_source: "classifier", verdict: "deny", category: "availability" };
    default:
      // A plugin function-hook refusal carries no PreToolUse prefix: `Error: [Tag] refused: …` or `Error: LifeOS: …`.
      if (/^Error: (?:\[[^\]]+\]|LifeOS[^:]*:)/.test(result)) return { layer: "hook:plugin", label_source: "regex", verdict: "deny", category: categoryOf(result) };
      return { layer: "native-rule", label_source: "regex", verdict: "deny", category: categoryOf(result) };
  }
}

// ── Principal messages and reactions ──────────────────────────────────────────

const NOT_PRINCIPAL = /^\s*(?:<task-notification|<system-reminder|<command-|<local-command|<bash-|<user-prompt-submit-hook|\[Request interrupted|Caveat:|This session is being continued|<agent-|\[SUBAGENT|<teammate-message)/;

/** The principal's own text on a user line, or null when the line is a tool result, meta, or machine text. */
export function principalText(row: Record<string, unknown>): string | null {
  if (row.type !== "user" || row.isMeta === true || row.isCompactSummary === true || row.isSidechain === true) return null;
  if (row.toolUseResult !== undefined) return null;
  const c = (row.message as { content?: unknown } | undefined)?.content;
  let text: string | null = null;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some(p => (p as { type?: string })?.type === "tool_result")) return null;
    text = c.filter(p => (p as { type?: string })?.type === "text").map(p => String((p as { text?: unknown }).text ?? "")).join("\n");
  }
  if (!text || !text.trim() || NOT_PRINCIPAL.test(text)) return null;
  return text;
}

const OVERRIDE_RE = /\b(?:do it anyway|just do it|go ahead|proceed|run it|allow it|that'?s fine|it'?s fine|approved?|false positive|shouldn'?t (?:have )?(?:been )?block|why (?:did|was|is) (?:it|that|this) (?:get )?(?:blocked|denied|refused)|stop blocking|wrong(?:ly)? block|ship it)\b|^\s*(?:y|yes|yep|si|ok|okay|do it)\s*[.!]*\s*$/i;
const AFFIRM_RE = /\b(?:good catch|good block|right(?:ly)? blocked|correct(?:ly)? (?:blocked|denied)|don'?t do that|never do that|do not do that|don'?t run|don'?t push|not that|leave it)\b|^\s*(?:no|nope|stop|n)\s*[.!]*\s*$/i;

export function classifyReaction(text: string | null): Reaction {
  if (text === null) return "none";
  if (AFFIRM_RE.test(text)) return "affirm";
  if (OVERRIDE_RE.test(text)) return "override";
  return "unrelated";
}

// ── Per-file processing ───────────────────────────────────────────────────────

const CANDIDATE_BASH_RE = /git\s+push|wrangler|deploy|\bgh\s|curl|wget|\bssh\b|\bscp\b|rsync|stripe|gmail|gcal|open\s+-a|Secrets\.ts|\.env\b|https?:\/\//;
const CANDIDATE_PATH_RE = /\.env\b|\.ssh\/|\.aws\/|credential|secret|token|keychain|\/SECURITY\/|settings(?:\.local)?\.json|\/hooks\//i;

/** A plain JSON object, or null. Records and their parts are read through this, never as text (S101). */
function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The content parts of a record's message that are objects. */
function contentParts(rec: Record<string, unknown>): Record<string, unknown>[] {
  const c = obj(rec.message)?.content;
  return Array.isArray(c) ? c.map(obj).filter((p): p is Record<string, unknown> => p !== null) : [];
}

/** Every string an attachment carries, at any depth, in document order: content markers are searched here, never in
 *  the serialized line. Walked with an explicit stack, so a deeply nested but valid record never exhausts the call
 *  stack and aborts the run (S101 parity). */
function attachmentText(root: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") { out.push(v); continue; }
    const children = Array.isArray(v) ? v : Object.values(obj(v) ?? {});
    for (let k = children.length - 1; k >= 0; k--) stack.push(children[k]);
  }
  return out;
}

/** Whether a hook's stdout carries a PreToolUse permissionDecision of "ask", read as JSON: the whole output or any one line of it. */
function hookAsked(stdout: string): boolean {
  const asks = (t: string): boolean => {
    try { return obj(obj(JSON.parse(t))?.hookSpecificOutput)?.permissionDecision === "ask"; } catch { return false; }
  };
  return asks(stdout) || stdout.split("\n").some(l => l.trim() !== "" && asks(l));
}

function excerpt(input: Record<string, unknown>): string {
  return redact(typeof input.command === "string" ? input.command : JSON.stringify(input), 400);
}

/** Tool name as the ledger records it: MCP double-underscores become colons so a long name never reads as a token. */
export function toolLabel(name: string): string {
  return scrubToken(name.replace(/__/g, ":"));
}

/** Process one transcript's lines. Pure over its input; the caller decides what to do with the result. */
export function processLines(lines: Iterable<string>, fileSidechain: boolean): FileResult {
  const uses = new Map<string, ToolUse>();
  const asks = new Map<string, { guard: string; ts: string }>();
  const autoAllowed = new Set<string>();
  const denied = new Map<string, { kind?: string; result: string; ts: string }>();
  const ran = new Set<string>();
  const injections: { id: string; ts: string; source: string }[] = [];
  const taintedAt = new Map<string, boolean>();
  const pending: string[] = [];
  const reactions = new Map<string, string | null>();
  let session = "";
  let entrypoint = "unknown";
  let tainted = false;
  let malformedRecords = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;
    // Every record is parsed before anything classifies it, and only its parsed fields classify it (S101): how
    // the writer spaced its JSON never decides what a record is. A line that is not a JSON object is evidence
    // we could not read, wherever it sits in the file. The harness writes whole lines (0 of 59,682 live
    // transcripts ended unterminated, 2026-10-15), so a torn last line is corruption too, as the evidence
    // reader's strict mode already holds (hooks/lib/transcript-evidence.ts).
    let rec: Record<string, unknown>;
    try {
      const v = obj(JSON.parse(line));
      if (v === null) throw new TypeError("not a record");
      rec = v;
    } catch {
      malformedRecords++;
      continue;
    }
    if (!session) session = str(rec.sessionId) || str(rec.session_id);
    if (entrypoint === "unknown") entrypoint = str(rec.entrypoint) || "unknown";
    const ts = str(rec.timestamp);

    if (rec.type === "assistant") {
      const side = fileSidechain || rec.isSidechain === true;
      for (const part of contentParts(rec)) {
        if (part.type !== "tool_use") continue;
        const id = str(part.id);
        const name = str(part.name);
        // A tool call that names no id or tool is unreadable evidence, never guessed.
        if (!id || !name) { malformedRecords++; continue; }
        uses.set(id, { id, name, input: obj(part.input) ?? {}, ts, sidechain: side });
        taintedAt.set(id, tainted);
      }
      continue;
    }
    if (rec.type === "attachment") {
      const a = obj(rec.attachment) ?? {};
      const text = attachmentText(a);
      if (text.some(t => t.includes("EXTERNAL CONTENT via"))) tainted = true;
      if (a.type === "hook_success" && hookAsked(str(a.stdout))) {
        const id = str(a.toolUseID);
        // A record that names an ask but not its tool call is unreadable evidence, never guessed.
        if (!id) { malformedRecords++; continue; }
        asks.set(id, { guard: guardName(str(a.command)), ts });
        pending.push(id);
      } else if (a.type === "hook_permission_decision" && a.decision === "allow") {
        const id = str(a.toolUseID);
        if (id) autoAllowed.add(id);
      } else if (a.type === "hook_additional_context" && (a.hookEvent === "PostToolUse" || str(a.hookName).startsWith("PostToolUse")) && text.some(t => t.includes("INJECTION SHAPE DETECTED"))) {
        const source = text.map(t => t.match(/EXTERNAL CONTENT via ([A-Za-z0-9:_-]+)/)?.[1]).find(Boolean) ?? "unknown";
        injections.push({ id: str(a.toolUseID), ts, source });
      }
      continue;
    }
    if (rec.type !== "user") continue;
    const results = contentParts(rec).filter(p => p.type === "tool_result");
    const isDenial = rec.toolDenialKind !== undefined || str(rec.toolUseResult).startsWith("Error: PreToolUse:");
    // A record marked as a denial that carries no tool_result cannot say which call was stopped: unreadable
    // evidence, counted, never read as a prompt or skipped (0 such records in the live transcripts, 2026-10-15).
    if (isDenial && results.length === 0) { malformedRecords++; continue; }
    if (results.length > 0) {
      if (isDenial) {
        const id = str(results[0]!.tool_use_id);
        // A denial that names no tool call is unreadable evidence: counted, never a silent skip.
        if (!id) { malformedRecords++; continue; }
        const result = typeof rec.toolUseResult === "string" ? rec.toolUseResult : String(JSON.stringify(rec.toolUseResult) ?? "");
        denied.set(id, { kind: typeof rec.toolDenialKind === "string" ? rec.toolDenialKind : undefined, result, ts });
        pending.push(id);
      } else {
        // A result that names no tool call cannot be joined to one: counted, never a silent skip.
        for (const p of results) { const id = str(p.tool_use_id); if (id) ran.add(id); else malformedRecords++; }
      }
      continue;
    }
    const text = principalText(rec);
    if (text === null) continue;
    tainted = false; // the principal's next prompt clears the taint mark
    // Sub-agent and SDK transcripts carry agent prompts on user lines, never the principal.
    const eligible = !fileSidechain && entrypoint === "cli";
    for (const id of pending.splice(0)) if (!reactions.has(id)) reactions.set(id, eligible ? text : null);
  }

  const events: DecisionEvent[] = [];
  const toolCounts = new Map<string, number>();
  const ranCounts = new Map<string, number>();
  const candidates: DecisionEvent[] = [];
  const base = (use: ToolUse | undefined, id: string, ts: string): Omit<DecisionEvent, "kind" | "layer" | "verdict" | "category" | "label_source"> => {
    const input = use?.input ?? {};
    return {
      session, ts: ts || use?.ts || "", tool: toolLabel(use?.name ?? "unknown"), tool_use_id: id,
      input_excerpt: use ? excerpt(input) : "",
      shape: deriveShape(use?.name ?? "unknown", input, taintedAt.get(id) ?? false),
      sidechain: use?.sidechain ?? fileSidechain, entrypoint,
    };
  };
  const withReaction = (e: DecisionEvent): DecisionEvent => {
    const next = reactions.get(e.tool_use_id) ?? null;
    return { ...e, principal_next: next === null ? null : redact(next, 400), reaction: classifyReaction(next), reaction_source: "heuristic" };
  };

  for (const [id, d] of denied) {
    const use = uses.get(id);
    const info = classifyDenial(d.kind, d.result);
    const ask = asks.get(id);
    asks.delete(id);
    if (ask && info.layer === "user") {
      // A hook ask the principal answered by rejecting: a human label.
      events.push(withReaction({ ...base(use, id, d.ts), kind: "ask", layer: `hook:${ask.guard}`, verdict: "rejected", category: "security", label_source: "human", denial_kind: d.kind, answered_by: "human", outcome: "rejected" }));
      continue;
    }
    const { sub_guard, ...rest } = info;
    // Dismissing a question or a plan prompt is a human answer, not a security verdict.
    if (rest.layer === "user" && use && ["AskUserQuestion", "ExitPlanMode"].includes(use.name)) rest.category = "question";
    events.push(withReaction({ ...base(use, id, d.ts), kind: "denial", ...rest, ...(sub_guard ? { source_class: sub_guard } : {}), denial_kind: d.kind, outcome: "denied" }));
  }
  for (const [id, ask] of asks) {
    const use = uses.get(id);
    const auto = autoAllowed.has(id);
    const didRun = ran.has(id);
    // An ask the harness resolved on its own never reached a human: the verdict is still our regex's.
    const label: LabelSource = !auto && didRun ? "human" : "regex";
    events.push(withReaction({
      ...base(use, id, ask.ts), kind: "ask", layer: `hook:${ask.guard}`, verdict: didRun ? "allow-after-ask" : "ask",
      category: "security", label_source: label, answered_by: auto ? "auto-permission" : didRun ? "human" : null,
      outcome: didRun ? "ran" : "unknown",
    }));
  }
  let autoAllowWithoutHookAsk = 0;
  for (const id of autoAllowed) if (!asks.has(id) && !denied.has(id)) autoAllowWithoutHookAsk++;
  for (const inj of injections) {
    events.push({ ...base(uses.get(inj.id), inj.id, inj.ts), input_excerpt: "", kind: "injection-marker", layer: "hook:Safety", verdict: "flagged", category: "security", label_source: "regex", source_class: inj.source });
  }

  for (const use of uses.values()) {
    toolCounts.set(use.name, (toolCounts.get(use.name) ?? 0) + 1);
    if (!ran.has(use.id) || denied.has(use.id) || asks.has(use.id)) continue;
    ranCounts.set(use.name, (ranCounts.get(use.name) ?? 0) + 1);
    const cand = use.name === "Bash" ? CANDIDATE_BASH_RE.test(str(use.input.command) || JSON.stringify(use.input)) : ["Read", "Edit", "Write"].includes(use.name) && CANDIDATE_PATH_RE.test(JSON.stringify(use.input));
    if (!cand) continue;
    const e: DecisionEvent = { ...base(use, use.id, use.ts), kind: "ran", layer: "none", verdict: "ran", category: "negative", label_source: "regex", outcome: "ran" };
    const interesting = use.name === "Bash" ? Boolean(e.shape.outbound) || e.shape.host_class === "non-owned" : (e.shape.path_class ?? "").startsWith("sensitive:");
    if (interesting) candidates.push(e);
  }
  return { events, toolCounts, ranCounts, candidates, autoAllowWithoutHookAsk, malformedRecords };
}

// ── File walking and streaming ────────────────────────────────────────────────

/** The transcripts under `root` and every directory that could not be listed. */
export function listTranscriptsChecked(root: string): { files: string[]; unreadableDirs: string[] } {
  const out: string[] = [];
  const unreadableDirs: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { unreadableDirs.push(dir); return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return { files: out.sort(), unreadableDirs: unreadableDirs.sort() };
}

export function listTranscripts(root: string): string[] {
  return listTranscriptsChecked(root).files;
}

/** Lines of one transcript, read whole (transcripts are processed one at a time per worker). */
export async function processFile(path: string): Promise<FileResult> {
  const text = await Bun.file(path).text();
  return processLines(text.split("\n"), path.includes("/subagents/"));
}

// ── Sampling ──────────────────────────────────────────────────────────────────

/** Deterministic stratified sample: at most `max` rows, round-robin across shape strata. */
export function stratifiedSample(rows: DecisionEvent[], max: number): DecisionEvent[] {
  const strata = new Map<string, DecisionEvent[]>();
  for (const r of rows) {
    const key = `${r.tool}|${r.shape.outbound ?? r.shape.path_class ?? r.shape.host_class}`;
    strata.set(key, [...(strata.get(key) ?? []), r]);
  }
  const lists = [...strata.values()].map(l => l.sort((a, b) => (a.tool_use_id < b.tool_use_id ? -1 : 1)));
  const out: DecisionEvent[] = [];
  for (let i = 0; out.length < max; i++) {
    let added = false;
    for (const l of lists) if (i < l.length && out.length < max) { out.push(l[i]!); added = true; }
    if (!added) break;
  }
  return out;
}

// ── Summary ───────────────────────────────────────────────────────────────────

export type Aggregate = {
  filesScanned: number;
  events: DecisionEvent[];
  toolCounts: Map<string, number>;
  ranCounts: Map<string, number>;
  autoAllowWithoutHookAsk: number;
  runtimeMs: number;
  /** Set when any transcript or directory could not be read, or a record in one could not be parsed. An incomplete harvest never replaces the ledger or the summary. */
  incomplete?: { unreadableFiles: number; unreadableDirs: number; malformedRecords?: number };
  /** Set when --limit-files left transcripts out (S102). A partial harvest writes only when the caller opted in with allowPartial. */
  partial?: { omittedFiles: number };
};

function tally<T>(items: T[], key: (t: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** One generalized, text-free shape line for a decision. */
export function generalShape(e: DecisionEvent): string {
  const s = e.shape;
  const what = e.tool === "Bash"
    ? `Bash ${(s.heads ?? []).slice(0, 3).join("+") || "empty"}${s.outbound ? `, outbound ${s.outbound}` : ""}, host ${s.host_class}`
    : `${/^mcp(?:__|:)/.test(e.tool) ? "mcp-tool" : SAFE_TOKEN.test(e.tool) ? e.tool : "other"}${s.path_class ? ` path ${s.path_class}` : ""}${s.host_class !== "none" ? `, host ${s.host_class}` : ""}`;
  const guard = e.kind === "denial" && e.source_class ? `(${e.source_class})` : "";
  return `${what}${s.tainted ? ", session tainted" : ""} → ${e.layer}${guard} ${e.verdict}${e.outcome ? ` → ${e.outcome}` : ""}`;
}

const table = (head: [string, string], rows: [string, number][]): string =>
  [`| ${head[0]} | ${head[1]} |`, "|---|---|", ...rows.map(([k, v]) => `| ${k.replace(/\|/g, "/")} | ${v} |`)].join("\n");

/** Calls, ran-with-no-stop and stops per generic tool label, MCP tools pooled. */
function baseRates(a: Aggregate, stops: DecisionEvent[], label: (t: string) => string): [string, number, number, number][] {
  const m = new Map<string, [number, number, number]>();
  for (const [t, n] of a.toolCounts) {
    const k = label(t);
    const cur = m.get(k) ?? [0, 0, 0];
    m.set(k, [cur[0] + n, cur[1] + (a.ranCounts.get(t) ?? 0), cur[2]]);
  }
  for (const e of stops) {
    const k = label(e.tool);
    const cur = m.get(k) ?? [0, 0, 0];
    m.set(k, [cur[0], cur[1], cur[2] + 1]);
  }
  return [...m.entries()].map(([k, v]) => [k, ...v] as [string, number, number, number]).sort((x, y) => y[1] - x[1]);
}

export function renderSummary(a: Aggregate): string {
  const ev = a.events;
  const stops = ev.filter(e => e.kind === "denial" || e.kind === "ask");
  const safeTool = (t: string): string => (/^mcp(?:__|:)/.test(t) ? "mcp-tool" : SAFE_TOKEN.test(t) ? t : "other");
  const parts: string[] = [
    "# Security decision harvest — summary",
    "",
    `Generated by \`LIFEOS/TOOLS/SecurityHarvest.ts\`. Shapes and counts only: no raw command text, paths, names, hosts or secrets. ` +
      `Files scanned: ${a.filesScanned}. Ledger rows: ${ev.length}. Runtime: ${(a.runtimeMs / 1000).toFixed(1)} s.`,
    "",
    "Label sources: `human` = the principal rejected a call or answered an ask; `classifier` = the Claude Code auto-mode classifier (independent proxy); `regex` = our own guards and native rules (proxy, never ground truth). Reactions are heuristic pointers for later human labelling, never labels. Categories separate security stops from budget, routing, language-policy, harness and availability stops.",
    "",
    "## Rows by kind and label source",
    table(["kind / label_source", "rows"], tally(ev, e => `${e.kind} / ${e.label_source}`)),
    "",
    "## Stops by deciding layer",
    table(["layer", "rows"], tally(stops, e => e.layer)),
    "",
    "## Stops by category",
    table(["category", "rows"], tally(stops, e => e.category)),
    "",
    "## Stops by tool",
    table(["tool", "rows"], tally(stops, e => safeTool(e.tool))),
    "",
    "## Guards (hook layer)",
    table(["guard (sub-guard) / category / verdict", "rows"], tally(stops.filter(e => e.layer.startsWith("hook:")), e => `${e.layer}${e.kind === "denial" && e.source_class ? ` (${e.source_class})` : ""} / ${e.category} / ${e.verdict}`)),
    "",
    "## Hook asks and who answered",
    table(["answered_by / outcome / label", "rows"], tally(ev.filter(e => e.kind === "ask"), e => `${e.answered_by ?? "unanswered"} / ${e.outcome ?? "unknown"} / ${e.label_source}`)),
    "",
    `Permission requests the harness auto-allowed with no hook ask in front of them: ${a.autoAllowWithoutHookAsk}.`,
    "",
    "## Base rates per tool",
    "| tool | calls | ran with no stop | stopped | stop rate |",
    "|---|---|---|---|---|",
    ...baseRates(a, stops, safeTool).slice(0, 30).map(([t, n, ran, stopped]) =>
      `| ${t} | ${n} | ${ran} | ${stopped} | ${n ? ((stopped / n) * 100).toFixed(2) : "0"}% |`),
    "",
    "## Principal reaction distribution (heuristic)",
    table(["label_source / reaction", "rows"], tally(stops, e => `${e.label_source} / ${e.reaction ?? "none"}`)),
    "",
    "## Injection-marker sightings",
    table(["tool / source class", "rows"], tally(ev.filter(e => e.kind === "injection-marker"), e => `${safeTool(e.tool)} / ${e.source_class ?? "unknown"}`)),
    "",
  ];
  for (const ls of ["human", "classifier", "regex"] as const) {
    const rows = stops.filter(e => e.label_source === ls && e.category !== "harness" && e.category !== "question");
    parts.push(`## Top shapes — ${ls} labels (${rows.length} rows)`, table(["generalized shape", "rows"], tally(rows, generalShape).slice(0, 40)), "");
  }
  const neg = ev.filter(e => e.kind === "ran");
  parts.push(`## Top shapes — ran without a prompt (stratified sample of ${neg.length})`, table(["generalized shape", "rows"], tally(neg, generalShape).slice(0, 40)), "");
  return parts.join("\n");
}

// ── Writing ───────────────────────────────────────────────────────────────────

/** Atomic 0600 write of the ledger. Asserts every row is labelled and carries no sensitive shape. */
export function writeLedger(path: string, rows: DecisionEvent[]): void {
  for (const r of rows) {
    invariant(LABEL_SOURCES.has(r.label_source), `ledger row without a valid label_source: ${r.kind}`);
    invariant((r.kind !== "denial" && r.kind !== "ask") || r.principal_next !== undefined, `stop row without a principal_next field: ${r.kind}`);
  }
  const lines = rows.map(r => JSON.stringify(r));
  for (const [i, l] of lines.entries()) invariant(!hasSensitiveShape(l), `ledger row ${i} (${rows[i]!.kind}, field ${sensitiveField(rows[i]!)}) carries a sensitive shape after redaction`);
  const body = lines.join("\n") + (rows.length ? "\n" : "");
  atomicWrite(path, body);
}

/** Name of the first field whose serialized value still carries a sensitive shape (diagnostics only; never the value). */
function sensitiveField(row: DecisionEvent): string {
  for (const [k, v] of Object.entries(row)) if (hasSensitiveShape(JSON.stringify(v) ?? "")) return k;
  return "cross-field";
}

/** Atomic 0600 write of the summary. Asserts no sensitive shape. */
export function writeSummary(path: string, text: string): void {
  invariant(!hasSensitiveShape(text), "summary carries a sensitive shape");
  atomicWrite(path, text);
}

/**
 * Replace `path` through Boundary's atomic writer: an exclusively created, randomly named 0600 temp file in the
 * same directory, so nothing planted at a predictable temp name is ever written through (S102). The directory is
 * the one `path` physically names, resolved component by component as the alias check resolves it, so the write
 * lands where that check judged it, never at a lexically folded `link/..`.
 */
function atomicWrite(path: string, body: string): void {
  const name = basename(path);
  const dir = physicalPath(dirname(path));
  if (dir === null || name === "" || name === "." || name === "..") throw new Error("output path cannot be resolved to a writable location");
  writeAtomic(join(dir, name), body, { mode: 0o600 });
}

// ── Harvest ───────────────────────────────────────────────────────────────────

/** The canonical ledger and summary a full harvest owns. Only a complete harvest may replace them (S102). */
export function canonicalOutputs(): { out: string; summary: string } {
  return {
    out: lifeosPath("MEMORY", "OBSERVABILITY", "security-decisions.jsonl"),
    summary: lifeosPath("MEMORY", "WORK", "20260928-security-glance-harvest", "harvest-summary.md"),
  };
}

/**
 * The physical path `p` names, resolved the way the kernel walks it: every existing component through the
 * filesystem in order, so `link/../x` goes where the link's real parent is, never folded lexically first (S102).
 * A relative `p` is joined to the working directory as text, so its `..` stays for Boundary to resolve.
 * Null when it cannot be resolved (`..` after a missing component, a dangling or looping link).
 */
function physicalPath(p: string): string | null {
  return confinedPath(sep, isAbsolute(p) ? p : `${process.cwd()}${sep}${p}`);
}

/** Where a write to `p` lands: its parent's physical path and identity, plus the final name, case-folded. Null when unknown. */
function landing(p: string): { dir: string; name: string; dirId: string | null } | null {
  const name = basename(p);
  if (name === "" || name === "." || name === "..") return null;
  const dir = physicalPath(dirname(p)); // dirname keeps `..`: the parent is resolved physically, never collapsed
  if (dir === null) return null;
  let dirId: string | null = null;
  try { const st = statSync(dir); dirId = `${st.dev}:${st.ino}`; } catch { /* not there yet: compared by path */ }
  return { dir: dir.toLowerCase(), name: name.toLowerCase(), dirId };
}

/**
 * Whether writing `p` could replace `target` (S102): the same physical file through a symlink, the same real
 * directory and name through a symlinked directory or `..`, or a name that differs only in case (the volume may
 * fold case). When unsure it answers yes, so a sample is refused rather than allowed onto the ledger.
 */
export function aliasesOutput(p: string, target: string): boolean {
  const fp = physicalPath(p);
  const ft = physicalPath(target);
  if (fp === null || ft === null) return true;
  if (fp.toLowerCase() === ft.toLowerCase()) return true;
  const a = landing(p);
  const b = landing(target);
  if (a === null || b === null) return true;
  if (a.name !== b.name) return false;
  if (a.dirId !== null && b.dirId !== null) return a.dirId === b.dirId;
  return a.dir === b.dir;
}

/** Whether `p` names, or aliases, either canonical output. */
export function namesCanonicalOutput(p: string): boolean {
  const c = canonicalOutputs();
  return aliasesOutput(p, c.out) || aliasesOutput(p, c.summary);
}

/** allowPartial: the caller chose these output paths for a sample, so a --limit-files run may write them, never onto a canonical output (S102). */
export type HarvestOptions = { root: string; limitFiles?: number; out: string; summary: string; concurrency?: number; allowPartial?: boolean };

export async function harvest(opts: HarvestOptions): Promise<Aggregate> {
  const t0 = performance.now();
  const listed = listTranscriptsChecked(opts.root);
  let files = listed.files;
  if (opts.limitFiles !== undefined) files = files.slice(0, opts.limitFiles);
  const omittedFiles = listed.files.length - files.length;
  const events: DecisionEvent[] = [];
  const candidates: DecisionEvent[] = [];
  const toolCounts = new Map<string, number>();
  const ranCounts = new Map<string, number>();
  let autoAllow = 0;
  let unreadable = 0;
  let malformedRecords = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const f = files[next++]!;
      let r: FileResult;
      try {
        r = await processFile(f);
      } catch {
        unreadable++;
        continue;
      }
      events.push(...r.events);
      candidates.push(...r.candidates);
      for (const [k, v] of r.toolCounts) toolCounts.set(k, (toolCounts.get(k) ?? 0) + v);
      for (const [k, v] of r.ranCounts) ranCounts.set(k, (ranCounts.get(k) ?? 0) + v);
      autoAllow += r.autoAllowWithoutHookAsk;
      malformedRecords += r.malformedRecords;
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
  if (unreadable) process.stderr.write(`could not read ${unreadable} transcript(s)\n`);
  if (malformedRecords) process.stderr.write(`could not parse ${malformedRecords} transcript record(s)\n`);
  if (listed.unreadableDirs.length) process.stderr.write(`could not list ${listed.unreadableDirs.length} director${listed.unreadableDirs.length === 1 ? "y" : "ies"}\n`);
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const all = [...events, ...stratifiedSample(candidates, 300)];
  const agg: Aggregate = { filesScanned: files.length - unreadable, events: all, toolCounts, ranCounts, autoAllowWithoutHookAsk: autoAllow, runtimeMs: performance.now() - t0 };
  if (omittedFiles > 0) agg.partial = { omittedFiles };
  if (unreadable > 0 || listed.unreadableDirs.length > 0 || malformedRecords > 0) {
    // Skipped evidence is not a smaller ledger: the previous ledger and summary stay exactly as they were.
    agg.incomplete = { unreadableFiles: unreadable, unreadableDirs: listed.unreadableDirs.length, ...(malformedRecords > 0 ? { malformedRecords } : {}) };
    return agg;
  }
  // A sample is not the ledger either: it writes only to paths the caller chose for it, and never onto the
  // canonical ledger or summary, whatever path spells them (S102).
  if (agg.partial && (!opts.allowPartial || namesCanonicalOutput(opts.out) || namesCanonicalOutput(opts.summary))) return agg;
  invariant(!agg.partial || !(namesCanonicalOutput(opts.out) || namesCanonicalOutput(opts.summary)), "a partial harvest is about to replace a canonical output");
  writeLedger(opts.out, all);
  writeSummary(opts.summary, renderSummary(agg));
  return agg;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const HELP = {
  name: "SecurityHarvest",
  purpose: "Harvest security decisions (denials, asks, rejections, injection markers, base-rate negatives) from session transcripts into a labelled ledger.",
  commands: {
    harvest: {
      args: {
        "--root DIR": "transcript tree (default: <claude dir>/projects)",
        "--limit-files N": "scan only the first N transcripts (sorted by path); a partial sample, so it needs explicit --out and --summary",
        "--out FILE": "ledger path (default: MEMORY/OBSERVABILITY/security-decisions.jsonl)",
        "--summary FILE": "summary path (default: the harvest run's harvest-summary.md)",
      },
      output: "one JSON line on stdout: files scanned, rows by kind and label source, runtime",
    },
    help: { args: { "--json": "print this catalog as JSON" } },
  },
  exit_codes: { "0": "ok", "1": "runtime error", "2": "bad arguments (including --limit-files without explicit --out and --summary, or with either naming a canonical output)", "3": "incomplete: a transcript or directory could not be read, or a record could not be parsed; the previous ledger and summary are preserved" },
};

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(rest.includes("--json") ? JSON.stringify(HELP, null, 2) + "\n" : `${HELP.purpose}\n\n  harvest [--root DIR] [--limit-files N] [--out FILE] [--summary FILE]\n  help --json\n`);
    return 0;
  }
  if (cmd !== "harvest") { process.stderr.write(`unknown command: ${cmd}\n`); return 2; }
  const flag = (name: string): string | undefined => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const limitRaw = flag("--limit-files");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) { process.stderr.write("--limit-files needs a positive integer\n"); return 2; }
  // A sample must never replace the canonical ledger or summary (S102): it names its own outputs.
  if (limit !== undefined && (flag("--out") === undefined || flag("--summary") === undefined)) { process.stderr.write("--limit-files writes a partial sample, so it needs explicit --out and --summary paths\n"); return 2; }
  if (limit !== undefined && [flag("--out")!, flag("--summary")!].some(namesCanonicalOutput)) { process.stderr.write("--limit-files writes a partial sample, so --out and --summary must not name the canonical ledger or summary, directly or through a link\n"); return 2; }
  const root = flag("--root") ?? join(getClaudeDir(), "projects");
  if (!existsSync(root) || !statSync(root).isDirectory()) { process.stderr.write("root is not a directory\n"); return 2; }
  const canonical = canonicalOutputs();
  const out = flag("--out") ?? canonical.out;
  const summary = flag("--summary") ?? canonical.summary;
  const agg = await harvest({ root, limitFiles: limit, out, summary, allowPartial: limit !== undefined });
  if (agg.incomplete) {
    process.stdout.write(JSON.stringify({ ok: false, incomplete: true, unreadable_files: agg.incomplete.unreadableFiles, unreadable_dirs: agg.incomplete.unreadableDirs, malformed_records: agg.incomplete.malformedRecords ?? 0, ledger: "preserved" }) + "\n");
    return 3;
  }
  const byKind = Object.fromEntries(tally(agg.events, e => `${e.kind}/${e.label_source}`));
  process.stdout.write(JSON.stringify({ ok: true, ...(agg.partial ? { partial: true, files_omitted: agg.partial.omittedFiles } : {}), files_scanned: agg.filesScanned, rows: agg.events.length, by_kind_label: byKind, runtime_s: +(agg.runtimeMs / 1000).toFixed(1) }) + "\n");
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => {
    process.stderr.write(`SecurityHarvest failed: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
