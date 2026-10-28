/**
 * @version 1.1.0
 * Capture.ts — build a hook-captured erratum from the session transcript.
 *
 * Called by SatisfactionCapture on a low rating, an explicit correction, or a
 * frustration hit. Reads THIS session's transcript (never the global
 * last-response cache) for the response that drew the complaint, the ask that
 * preceded it, and the last few tool calls. Deterministic; no inference.
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getClaudeDir } from "../TOOLS/Paths";
import { CROSS_VENDOR, CURRENT, resolveCarrierId, type ClaudeTier } from "../TOOLS/models";
import { roster, type AgentRoute } from "../ROUTER/Router";
import { readOutputLines } from "../TOOLS/lib/OutputLedger";
import { addLabel } from "../TOOLS/lib/LabelStore";
import { draftFalsePassForErratum } from "../TOOLS/FalsePassDraft";
import { textRequest } from "../TOOLS/DeliveredContext";
import { ErrataStore, responseHash } from "./Store";
import type { DispatchSummary, Erratum, ErratumLinks, Kind, ToolCallSummary } from "./Schema";

interface TranscriptRead {
  response_preview: string | null;
  response_hash: string | null;
  requested: string | null;
  /** Timestamp of the user entry the ask came from: the previous typed prompt, the lower bound for output_ids. */
  requested_ts: string | null;
  tool_calls: ToolCallSummary[];
  model: string | null;
  cwd: string | null;
  /** Every Agent / Worker.ts dispatch from the judged prompt to the end of the transcript. */
  dispatches: DispatchSummary[];
}

export interface TranscriptOptions {
  /** Agent roster dir for route lookup; defaults to <claudeDir>/agents. Tests point it at a fixture. */
  agentsDir?: string;
}

/** Home-relative path so a ledger row never carries the OS username (audit note 2). */
export function tildePath(p: string): string {
  const h = homedir();
  return p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === "string" ? c : c?.type === "text" && c?.text ? c.text : ""))
      .filter(Boolean).join("\n").trim();
  }
  return "";
}

function toolSummary(block: any): ToolCallSummary {
  const input = block?.input ?? {};
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.prompt ?? input.description ?? "";
  return { name: String(block?.name ?? "?"), summary: String(pick).slice(0, 160) };
}

/**
 * Prompt sources a person or a caller sent. The router's typedText keeps typed/queued/suggestion_accepted for
 * interactive sessions; "sdk" is the prompt a headless or Relay session was given. Anything else ("system") the
 * harness made. Kept local so the per-prompt hook does not load the router's front door (Assay, Inference).
 */
const ASK_SOURCES = new Set(["typed", "queued", "suggestion_accepted", "sdk"]);

/**
 * The ask a user row carries, or null when the row is not one (ISC-22). Not the ask: tool results, harness-made rows
 * (isMeta, which is how a skill body is injected; sidechains; a promptSource outside ASK_SOURCES), relay turns
 * (absence review A-7) and skill bodies by their text. A delivered-context frame yields only its current request.
 */
export function askText(e: any): string | null {
  if (e?.isMeta || e?.isSidechain) return null;
  if (typeof e?.promptSource === "string" && !ASK_SOURCES.has(e.promptSource)) return null;
  const raw = e?.message?.content;
  if (Array.isArray(raw) && raw.some((b: any) => b?.type === "tool_result")) return null;
  const text = textRequest(typeof raw === "string" ? raw : textOf(raw)).trim();
  if (!text) return null;
  if (/<(task-notification|teammate-message|system-reminder|cross-session-message|agent-message)/.test(text) || /^\[SYSTEM NOTIFICATION/.test(text)) return null;
  if (/^Base directory for this skill:/.test(text)) return null;
  return text;
}

/** Walk the transcript backwards: last text-bearing assistant message, the user prompt before it, the last three tool calls. */
export function readTranscript(transcriptPath: string | undefined, opts: TranscriptOptions = {}): TranscriptRead {
  const out: TranscriptRead = { response_preview: null, response_hash: null, requested: null, requested_ts: null, tool_calls: [], model: null, cwd: null, dispatches: [] };
  if (!transcriptPath || !existsSync(transcriptPath)) return out;
  let lines: string[];
  try { lines = readFileSync(transcriptPath, "utf8").trim().split("\n"); } catch { return out; }
  let sawResponse = false;
  let requestedAt = -1;
  for (let i = lines.length - 1; i >= 0 && (out.requested === null || out.tool_calls.length < 3); i--) {
    let e: any;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (!out.cwd && typeof e?.cwd === "string") out.cwd = tildePath(e.cwd);
    if (e?.type === "assistant" && e?.message?.content) {
      // "<synthetic>" marks a harness-made message (API error, interrupt), not a model: skip it so the real one is found.
      if (!out.model && typeof e.message.model === "string" && e.message.model !== "<synthetic>") out.model = e.message.model;
      const content = Array.isArray(e.message.content) ? e.message.content : [];
      for (const b of [...content].reverse()) {
        if (b?.type === "tool_use" && out.tool_calls.length < 3) out.tool_calls.unshift(toolSummary(b));
      }
      if (!sawResponse) {
        const text = textOf(e.message.content);
        if (text) { out.response_preview = text; out.response_hash = responseHash(text); sawResponse = true; }
      }
    } else if (e?.type === "user" && sawResponse && out.requested === null) {
      const text = askText(e);
      if (text) { out.requested = text; requestedAt = i; out.requested_ts = typeof e?.timestamp === "string" ? e.timestamp : null; }
    }
  }
  // The loop above stops early; dispatches need the whole judged span, so they get their own forward pass.
  // No real prompt found means no judged turn to attribute: leave dispatches empty rather than guess a span.
  if (requestedAt >= 0) out.dispatches = collectDispatches(lines, requestedAt + 1, opts.agentsDir ?? join(getClaudeDir(), "agents"));
  return out;
}

// luna and terra stay in the match on purpose: this parses OLD transcripts, where Worker.ts still took those names (retired 2026-10-07).
// An unresolved lane yields model null below, so history still reads and nothing live depends on the two names.
const WORKER_RE = /\bbun\s+(?:run\s+)?\S*Worker\.ts\s+(luna|terra|sol|astra)\b/g;
const HEREDOC_RE = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)(?:\n\s*\1\s*(?:\n|$)|$)/;

function vendorOf(model: string | null): DispatchSummary["vendor"] {
  if (!model) return null;
  if (/^claude-/.test(model)) return "anthropic";
  if (/^gpt-/.test(model)) return "openai";
  if (/^gemini/.test(model)) return "google";
  if (/^grok/.test(model)) return "xai";
  return null;
}

function clip80(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const t = text.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 80) : null;
}

/**
 * Model an Agent dispatch ran on. Observe-only: reads the call and the roster, never alters either.
 * A codex-lane agent works in its codex child, so its lane wins over any wrapper override; a fork
 * always runs on the parent model (Agent tool contract). Anything unresolvable is null, never the carrier.
 */
function agentModel(input: any, route: AgentRoute | undefined, carrier: string | null): string | null {
  const agent = typeof input?.subagent_type === "string" && input.subagent_type ? input.subagent_type : "general-purpose";
  if (agent === "fork") return carrier;
  if (route?.runtime === "codex") return route.model;
  if (typeof input?.model === "string" && input.model) {
    const explicit = resolveCarrierId(input.model);
    if (explicit) return explicit;
  }
  if (!route || route.runtime !== "claude") return null;
  if (route.lane === "inherit") return carrier;
  return route.lane && route.lane in CURRENT ? CURRENT[route.lane as ClaudeTier] : null;
}

/** Forward pass over lines[from..]: every non-sidechain Agent call and Worker.ts leg. The roster is read at most once, and only if an Agent call exists. */
function collectDispatches(lines: string[], from: number, agentsDir: string): DispatchSummary[] {
  const out: DispatchSummary[] = [];
  let routes: Map<string, AgentRoute> | null = null;
  const routeFor = (agent: string): AgentRoute | undefined => {
    if (!routes) {
      try { routes = new Map(roster(agentsDir).map((r) => [r.agent, r])); } catch { routes = new Map(); }
    }
    return routes.get(agent);
  };
  for (let i = from; i < lines.length; i++) {
    let e: any;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e?.isSidechain === true || e?.type !== "assistant" || !Array.isArray(e?.message?.content)) continue;
    const raw = typeof e.message.model === "string" ? e.message.model : null;
    const carrier = raw && raw !== "<synthetic>" ? raw : null;
    for (const b of e.message.content) {
      if (b?.type !== "tool_use") continue;
      const input = b.input ?? {};
      // "Task" is the Agent tool's name in older transcripts.
      if (b.name === "Agent" || b.name === "Task") {
        const agent = typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "general-purpose";
        const model = agentModel(input, agent === "fork" ? undefined : routeFor(agent), carrier);
        out.push({ agent, model, vendor: vendorOf(model), description: clip80(input.description) ?? clip80(input.prompt) });
      } else if (b.name === "Bash" && typeof input.command === "string") {
        const task = clip80(input.command.match(HEREDOC_RE)?.[2]);
        for (const m of input.command.matchAll(WORKER_RE)) {
          const lane = m[1];
          const model = CROSS_VENDOR[lane] ?? null;
          out.push({ agent: lane.charAt(0).toUpperCase() + lane.slice(1), model, vendor: vendorOf(model), description: task });
        }
      }
    }
  }
  return out;
}

/** The most output ids an erratum carries. */
export const MAX_OUTPUT_IDS = 20;

/** With no prompt time and no turn on the session's lines, the window of delivered outputs a complaint still links. */
export const OUTPUT_FALLBACK_WINDOW_MS = 30 * 60 * 1000;

/**
 * assay-everywhere S10: the output-ledger lines for this session since the previous typed prompt, oldest first, at most
 * MAX_OUTPUT_IDS (the newest, nearest the complaint). With no prompt time (no transcript), falls back to the session's
 * latest turn; when no line carries a turn (tool outputs the delivery backstop recorded outside a skill run, Errata ISA
 * F-STATVS), to the session's lines from the last OUTPUT_FALLBACK_WINDOW_MS before `now`. So a complaint about a file a
 * tool delivered links it whichever way the output was recorded. A missing or unreadable ledger, no session, or nothing
 * delivered is an empty list, never an error.
 */
export function outputIdsSince(sessionId: string | null | undefined, sinceTs: string | null | undefined, dir?: string, now: number = Date.now()): string[] {
  try {
    if (!sessionId) return [];
    const mine = readOutputLines(dir).filter((l) => l?.session_id === sessionId && typeof l.output_id === "string" && Number.isFinite(Date.parse(l.ts)));
    mine.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    let picked = mine;
    const since = sinceTs ? Date.parse(sinceTs) : NaN;
    if (Number.isFinite(since)) picked = mine.filter((l) => Date.parse(l.ts) >= since);
    else {
      const turn = [...mine].reverse().find((l) => l.turn)?.turn;
      picked = turn ? mine.filter((l) => l.turn === turn) : mine.filter((l) => { const t = Date.parse(l.ts); return t <= now && now - t <= OUTPUT_FALLBACK_WINDOW_MS; });
    }
    return picked.slice(-MAX_OUTPUT_IDS).map((l) => l.output_id);
  } catch { return []; }
}

/** Erratum kinds that are a verdict on the outputs they cite: negative kinds read as fail, praise as pass. Requests and questions are no verdict. */
export function reactionVerdict(kind: Kind): "pass" | "fail" | null {
  if (kind === "praise") return "pass";
  if (kind === "complaint" || kind === "bug" || kind === "correction" || kind === "incident") return "fail";
  return null;
}

/**
 * assay-everywhere: one principal "reaction" label per output an erratum cites (context.output_ids), so the reaction lands
 * in the one label store beside the receipt it judges. Kind "reaction" never counts toward earning (earnedStatus reads
 * principal right/wrong labels only). Fail-open: a missing ledger line or a label error skips that output and never
 * throws. Returns the number of labels written.
 */
export function writeReactionLabels(e: { id: string; kind: Kind; context?: { output_ids?: string[] } }, dir?: string): number {
  try {
    const verdict = reactionVerdict(e.kind);
    const ids = e.context?.output_ids;
    if (!verdict || !ids?.length) return 0;
    const lines = new Map(readOutputLines(dir).map((l) => [l.output_id, l]));
    let n = 0;
    for (const id of ids) {
      try {
        const line = lines.get(id);
        if (!line?.sha256 || line.decision === "blocked") continue; // a refused hand-off was never delivered, so there is nothing to react to
        addLabel({ source: "principal", kind: "reaction", artifact_sha256: line.sha256, ...(line.receipt_id ? { receipt_id: line.receipt_id } : {}), verdict, note: e.id, by: "principal" });
        n++;
      } catch (err) { console.error(`[Errata] reaction label skipped: ${err}`); }
    }
    return n;
  } catch { return 0; }
}

/** ISA slug the session is climbing, from the work registry; null when none. */
export function isaForSession(sessionId: string): string | null {
  try {
    const reg = JSON.parse(readFileSync(join(getClaudeDir(), "LIFEOS/MEMORY/STATE/work.json"), "utf8"));
    const sessions = reg?.sessions ?? {};
    const hit = Object.values(sessions).find((s: any) => s?.sessionUUID === sessionId) as any;
    return hit?.slug ?? hit?.isa ?? null;
  } catch { return null; }
}

export interface HookErratumInput {
  prompt: string;
  sessionId: string;
  transcriptPath?: string;
  kind: Kind;
  rating?: number | null;
  frustration?: 0 | 1 | 2 | 3 | null;
  tags?: string[];
  /** Cross-references for this row: the FAILURES context dir, the Upgrades record it filed. */
  links?: ErratumLinks;
  store?: ErrataStore;
  /** Agent roster for dispatch attribution; defaults to <claudeDir>/agents. */
  agentsDir?: string;
}

/** Append one erratum for a principal signal caught by the hook. Fail-open: returns null on any error. */
export function recordHookErratum(input: HookErratumInput): Erratum | null {
  try {
    const t = readTranscript(input.transcriptPath, { agentsDir: input.agentsDir });
    const store = input.store ?? new ErrataStore();
    const row = store.append({
      system: "lifeos",
      source: "principal",
      channel: "hook:prompt",
      kind: input.kind,
      rating: input.rating ?? null,
      frustration: input.frustration ?? null,
      complaint: input.prompt.trim(),
      context: {
        requested: t.requested,
        doing: t.tool_calls.length ? t.tool_calls.map((c) => `${c.name}: ${c.summary}`).join(" · ") : null,
        response_preview: t.response_preview,
        response_hash: t.response_hash,
        session_id: input.sessionId,
        isa: isaForSession(input.sessionId),
        cwd: t.cwd,
        model: t.model,
        tool_calls: t.tool_calls,
        dispatches: t.dispatches,
        output_ids: outputIdsSince(input.sessionId, t.requested_ts),
      },
      reporter: { id: "principal", role: "principal" },
      tags: input.tags ?? [],
      links: input.links ?? {},
    });
    if (row) {
      writeReactionLabels(row);
      // ISC-40: a rejection of one output whose receipt passed drafts that criterion's eval revision as an Upgrades
      // recommendation. Deterministic, no model call, never throws.
      draftFalsePassForErratum(row);
    }
    return row;
  } catch (err) {
    console.error(`[Errata] capture failed: ${err}`);
    return null;
  }
}
