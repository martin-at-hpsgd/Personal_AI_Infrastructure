/**
 * progress.ts — what the principal sees while a texted task runs.
 *
 * The agent runs with `--output-format stream-json`, so every tool call arrives as it happens. This module turns
 * those events into a plain phrase ("checking your calendar"), schedules the "still on it" texts, and pulls the
 * final result line back out of the stream. Pure except for the timers in ProgressReporter.
 */
import { basename } from "node:path";

export type AgentEvent =
  | { kind: "init"; sessionId: string }
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "result"; line: string };

/** Parse one stream-json line into the events we act on. Unknown or malformed lines yield nothing. */
export function eventsFromStreamLine(line: string): AgentEvent[] {
  let j: any;
  try { j = JSON.parse(line); } catch { return []; }
  if (!j || typeof j !== "object") return [];
  if (j.type === "system" && j.subtype === "init" && typeof j.session_id === "string") return [{ kind: "init", sessionId: j.session_id }];
  if (j.type === "result") return [{ kind: "result", line }];
  if (j.type === "assistant" && Array.isArray(j.message?.content)) {
    return j.message.content
      .filter((c: any) => c?.type === "tool_use" && typeof c.name === "string")
      .map((c: any) => ({ kind: "tool" as const, name: c.name, input: c.input && typeof c.input === "object" ? c.input : {} }));
  }
  return [];
}

/** The last `result` line of a stream-json run, which carries the same envelope `--output-format json` prints. */
export function resultLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (eventsFromStreamLine(lines[i]!).some((e) => e.kind === "result")) return lines[i]!;
  }
  return "";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
function host(url: unknown): string | undefined {
  try { return new URL(String(url)).hostname.replace(/^www\./, ""); } catch { return undefined; }
}
const BASH_ACTIVITY: Array<[RegExp, string]> = [
  [/\bgcal\b|calendar/i, "your calendar"],
  [/\bgmail\b|\bmail\b/i, "your inbox"],
  [/People\.ts|contacts/i, "a contact lookup"],
  [/\bdd-cli\b|doordash/i, "the order"],
  [/\bgh\s/, "the GitHub side"],
  [/\bbun\s+test\b|\bbunker\b/, "the tests"],
  [/\bgit\s/, "the repo"],
  [/\bcurl\b/, "a service check"],
];

/**
 * A short, lower-case topic for what a tool call is working on ("your calendar"), or undefined when the call says
 * nothing a person would care about. An unrecognized shell command is undefined, so the text keeps the last real
 * topic or falls back to "it", never "running a command".
 */
export function describeActivity(e: AgentEvent): string | undefined {
  if (e.kind !== "tool") return undefined;
  const i = e.input;
  switch (e.name) {
    case "Bash": {
      const cmd = String(i.command ?? "");
      for (const [re, topic] of BASH_ACTIVITY) if (re.test(cmd)) return topic;
      return undefined;
    }
    case "WebSearch": return i.query ? `a web search for "${clip(String(i.query), 40)}"` : "a web search";
    case "WebFetch": { const h = host(i.url); return h ? h : "a web page"; }
    case "Read": return i.file_path ? basename(String(i.file_path)) : "some files";
    case "Grep": case "Glob": return "a file search";
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit":
      return i.file_path ? basename(String(i.file_path)) : "the changes";
    case "Skill": { const s = String(i.skill ?? "").replace(/^_+/, "").toLowerCase(); return s ? `the ${clip(s, 30)} skill` : "a skill"; }
    case "Agent": case "Task": return "a side task with a helper";
    default: return undefined; // TodoWrite, ToolSearch and the like say nothing useful
  }
}

// Each list rotates, so consecutive texts never repeat a phrasing. {T} is the topic, {M} the minutes elapsed.
const FIRST_WITH = ["Working on {T} in the background…", "Digging into {T} in the background…", "Heads down on {T} in the background…", "Working through {T} in the background…"];
const FIRST_BARE = ["Working on it in the background…", "On it, working away in the background…", "Heads down on this in the background…"];
const LATER_WITH = ["Still working on {T} in the background ({M} min in)…", "{M} min in, still on {T}…", "Still going on {T} in the background, {M} min so far…", "Still heads down on {T} ({M} min)…"];
const LATER_BARE = ["Still working on it in the background ({M} min in)…", "{M} min in and still going…", "Still at it in the background, {M} min so far…"];

/** The status text for the nth update (0-based); `seed` picks where in the rotation this task starts. */
export function progressText(activity: string | undefined, elapsedMs: number, n: number, seed = 0): string {
  const min = Math.max(1, Math.round(elapsedMs / 60_000));
  const list = n === 0 ? (activity ? FIRST_WITH : FIRST_BARE) : (activity ? LATER_WITH : LATER_BARE);
  const tpl = list[(seed + n) % list.length]!;
  return `⏳ ${tpl.split("{T}").join(activity ?? "").split("{M}").join(String(min))}`;
}

export interface ProgressOptions {
  send: (text: string) => void;
  firstAfterMs?: number;
  everyMs?: number;
  max?: number;
  now?: () => number;
  /** Starting point in the phrasing rotation; random per task unless a test pins it. */
  seed?: number;
}

/** Sends the first status after `firstAfterMs`, then one every `everyMs`, at most `max`, each naming the latest activity. */
export class ProgressReporter {
  private activity: string | undefined;
  private sent = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = 0;
  private readonly firstAfterMs: number;
  private readonly everyMs: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly seed: number;
  constructor(private readonly opts: ProgressOptions) {
    this.firstAfterMs = opts.firstAfterMs ?? 45_000;
    this.everyMs = opts.everyMs ?? 180_000;
    this.max = opts.max ?? 8;
    this.now = opts.now ?? Date.now;
    this.seed = opts.seed ?? Math.floor(Math.random() * 12);
  }
  start(): this { this.started = this.now(); this.schedule(this.firstAfterMs); return this; }
  note(e: AgentEvent): void { const a = describeActivity(e); if (a) this.activity = a; }
  get count(): number { return this.sent; }
  get lastActivity(): string | undefined { return this.activity; }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private schedule(ms: number) {
    this.timer = setTimeout(() => {
      if (this.sent >= this.max) return;
      this.opts.send(progressText(this.activity, this.now() - this.started, this.sent, this.seed));
      this.sent++;
      if (this.sent < this.max) this.schedule(this.everyMs);
    }, ms);
  }
}

// release-allow: profanity (the stop matcher must recognise the principal's own spoken words)
/** What a stop may be aimed at: nothing, or the running work itself, never a thing in the world ("the dryer"). */
const STOP_OBJECT = String.raw`(?:(?:the|that|this|your|it|all|everything)\s+)?(?:(?:fucking|damn|goddamn|whole)\s+)?(?:job|task|run|work|search|research|harvest|thing|one|it|that|this|everything|now)?`;
/** A stop from the principal: cancels the running task instead of queueing behind it. A bare stop word counts, and
 *  so does a sentence that opens on one aimed at the work ("Stop the job; we're doing it ourself") or repeats an
 *  earlier stop ("I told you to stop that fucking task"); on 2026-10-17 both waited 35 minutes behind a harvest. */
export function isStopCommand(text: string): boolean {
  const t = text.trim();
  if (/^(?:nevermind|never mind)[\s.!]*$/i.test(t)) return true;
  const verb = String.raw`(?:stop|cancel|abort|kill|halt)`;
  const aimed = new RegExp(String.raw`^(?:please\s+|just\s+|ok(?:ay)?\s+)?${verb}\s*${STOP_OBJECT}(?:\s+now)?\s*(?:$|[.!;,:\-—–]|\s+(?:we|i|i'm|im|i’m|please)\b)`, "i");
  if (aimed.test(t)) return true;
  return new RegExp(String.raw`\b(?:told you to|said to|asked you to)\s+${verb}\b`, "i").test(t);
}
