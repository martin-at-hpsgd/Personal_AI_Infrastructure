#!/usr/bin/env bun
/**
 * Rewind.ts — put one human turn back together as a fixture a replay can run (STATVS ISA ISC-51).
 *
 *   bun LIFEOS/STATVS/Rewind.ts input <session> <promptIndex> [--assume key=value ...] [--source "<why>"] [--check] [--json]
 *   bun LIFEOS/STATVS/Rewind.ts input <session> --errata <ERR-id> [--assume key=value ...] [--check] [--json]
 *
 * The fixture holds what the model saw and what the turn did: the conversation after the last compaction
 * through that prompt, the system prompt and tools from the turn's recorded request shape, every tool call
 * with its recorded outcome (ran, or refused by a hook), the final answer, and the conditions it ran under.
 * Conditions come from the STATVS turn row when one exists (ISC-85); `--assume` states one that was not
 * recorded, with its source. `--errata` picks the turn the complaint was about: the prompt Errata recorded
 * as `context.requested`, last before the complaint.
 *
 * A fixture is a reproducible input, not a recording: sampling cannot be replayed. It holds transcript
 * content, so it is written 0600 under ~/.local/state/lifeos/rewind/, never into the record (ISC-8).
 * @version 1.0.0
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { getClaudeDir } from "../TOOLS/Paths";
import { scan } from "./index";

type Line = Record<string, any>;

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /**
   * `ran`: the tool ran, even when its command exited non-zero. `refused`: a LifeOS hook blocked it.
   * `denied`: the permission layer or the principal declined it. `tool-error`: the tool itself refused
   * before running (a file not read first, a missing path). Only `ran` can flip.
   */
  outcome: "ran" | "refused" | "denied" | "tool-error" | "no-result";
  result_preview: string;
}

export interface Condition { value: unknown; source: string }

export interface Fixture {
  v: 1;
  session: string;
  turn: number;
  prompt: string;
  prompt_ts: string;
  transcript_path: string;
  errata?: string;
  model: string | null;
  system: unknown;
  tools: unknown[];
  messages: { role: string; content: unknown }[];
  tool_calls: ToolCall[];
  answer: string;
  turn_row: Record<string, unknown> | null;
  conditions: Record<string, Condition>;
}

export function rewindDir(): string {
  return resolve(process.env.LIFEOS_REWIND_DIR || join(homedir(), ".local", "state", "lifeos", "rewind"));
}

export function findTranscript(session: string, projects = join(getClaudeDir(), "projects")): string | null {
  invariant(/^[0-9a-f-]{8,}$/.test(session), "a session id is a uuid");
  for (const d of readdirSync(projects)) {
    const p = join(projects, d, `${session}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** A prompt the principal typed: task notifications, peer messages, meta lines and compaction summaries also carry a promptIndex. */
export const isPrompt = (j: Line): boolean => j.type === "user" && !j.isSidechain && !j.isMeta && !j.isCompactSummary && j.turnOrigin === "human" && typeof j.turnPosition?.promptIndex === "number";
const promptText = (j: Line): string => {
  const c = j.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b: Line) => b.type === "text").map((b: Line) => b.text).join("\n");
  return "";
};
const resultText = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((b: Line) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n") : JSON.stringify(c ?? "");
const HOOK_REFUSAL = /^(?:PreToolUse:\S+ hook (?:error|denied|blocked)|<tool_use_error>LifeOS: (?:refused|BLOCKED))/;
const DENIAL = /^(?:<tool_use_error>)?(?:The user doesn't want to proceed|Permission to use \S+ (?:has been|was) denied|[^\n]{0,80}\bpermission (?:denied|was denied))/i;
/** How a tool call ended, from its result. */
export function outcomeOf(isError: boolean, text: string): ToolCall["outcome"] {
  if (!isError) return "ran";
  const s = text.trimStart();
  if (HOOK_REFUSAL.test(s)) return "refused";
  if (DENIAL.test(s)) return "denied";
  if (/^Exit code \d+/.test(s)) return "ran";
  return "tool-error";
}

/** Builds the fixture from parsed transcript lines. Pure: the caller reads files and the record. */
export function buildFixture(lines: Line[], opts: { session: string; transcriptPath: string; turn?: number; requested?: string; before?: string; errata?: string; turnRows?: Line[]; assume?: Record<string, Condition> }): Fixture {
  let at = -1;
  if (opts.turn !== undefined) at = lines.findIndex((j) => isPrompt(j) && j.turnPosition.promptIndex === opts.turn);
  else if (opts.requested) {
    const want = opts.requested.trim();
    // An exact match wins; a prefix match only for a request long enough not to match some other short reply.
    const pick = (match: (s: string) => boolean) => lines.forEach((j, i) => {
      if (isPrompt(j) && match(promptText(j).trim()) && (!opts.before || String(j.timestamp) < opts.before)) at = i;
    });
    pick((s) => s === want);
    if (at < 0 && want.length >= 20) pick((s) => s.startsWith(want));
  }
  invariant(at >= 0, `no human prompt in ${opts.transcriptPath} matches ${opts.turn ?? JSON.stringify(opts.requested)}`);
  const prompt = lines[at]!;
  const end = lines.findIndex((j, i) => i > at && isPrompt(j));
  const stop = end < 0 ? lines.length : end;

  let from = 0;
  for (let i = at; i >= 0; i--) if (lines[i]!.isCompactSummary) { from = i; break; }
  const messages: { role: string; content: unknown }[] = [];
  let lastAssistantId: string | null = null;
  // Through the first request of the turn, so the prompt-time hook context the model saw is included.
  const firstRequest = lines.findIndex((j, i) => i > at && i < (end < 0 ? lines.length : end) && j.type === "api-request" && j.querySource === "repl_main_thread");
  const through = firstRequest < 0 ? at : firstRequest;
  for (let i = from; i <= through; i++) {
    const j = lines[i]!;
    if (j.isSidechain) continue;
    if (j.type === "attachment" && j.attachment) { messages.push({ role: "attachment", content: j.attachment }); lastAssistantId = null; continue; }
    if (i > at || (j.type !== "user" && j.type !== "assistant") || !j.message) continue;
    if (j.type === "assistant" && j.message.id && j.message.id === lastAssistantId) {
      const prev = messages[messages.length - 1]!;
      prev.content = [...(prev.content as unknown[]), ...(j.message.content ?? [])];
      continue;
    }
    lastAssistantId = j.type === "assistant" ? j.message.id ?? null : null;
    messages.push({ role: j.message.role, content: j.type === "assistant" ? [...(j.message.content ?? [])] : j.message.content });
  }

  const request = lines.find((j, i) => i > at && i < stop && j.type === "api-request" && j.querySource === "repl_main_thread");
  const shapeLine = request ? lines.find((j) => j.type === "api-request-shape" && j.shapeHash === request.shapeHash) : undefined;
  const shape = shapeLine ? (typeof shapeLine.shape === "string" ? JSON.parse(shapeLine.shape) : shapeLine.shape) : null;
  const params = request ? (typeof request.params === "string" ? JSON.parse(request.params) : request.params) : null;

  const calls: ToolCall[] = [];
  const results = new Map<string, Line>();
  const texts: string[] = [];
  for (let i = at + 1; i < stop; i++) {
    const j = lines[i]!;
    if (j.isSidechain || !j.message) continue;
    const content = Array.isArray(j.message.content) ? j.message.content : [];
    for (const b of content) {
      if (j.type === "assistant" && b.type === "tool_use") calls.push({ id: b.id, name: b.name, input: b.input, outcome: "no-result", result_preview: "" });
      if (j.type === "assistant" && b.type === "text" && b.text) texts.push(b.text);
      if (j.type === "user" && b.type === "tool_result") results.set(b.tool_use_id, b);
    }
  }
  for (const c of calls) {
    const r = results.get(c.id);
    if (!r) continue;
    const text = resultText(r.content);
    c.result_preview = text.slice(0, 400);
    c.outcome = outcomeOf(r.is_error === true, text);
  }

  const pts = Date.parse(prompt.timestamp);
  const row = (opts.turnRows ?? [])
    .filter((r) => r.session === opts.session && Math.abs(Date.parse(r.ts) - pts) <= 60_000)
    .sort((a, b) => Math.abs(Date.parse(a.ts) - pts) - Math.abs(Date.parse(b.ts) - pts))[0] ?? null;
  const conditions: Record<string, Condition> = {};
  if (row?.data && typeof row.data === "object" && (row.data as Line).seat_idle_min !== undefined) conditions.seat_idle_min = { value: (row.data as Line).seat_idle_min, source: `turn row ${row.id}` };
  Object.assign(conditions, opts.assume ?? {});

  return {
    v: 1, session: opts.session, turn: prompt.turnPosition.promptIndex, prompt: promptText(prompt), prompt_ts: prompt.timestamp,
    transcript_path: opts.transcriptPath, ...(opts.errata ? { errata: opts.errata } : {}),
    model: params?.model ?? null, system: shape?.system ?? null, tools: Array.isArray(shape?.tools) ? shape.tools : [],
    messages, tool_calls: calls, answer: texts.join("\n\n"), turn_row: row ? { id: row.id, ts: row.ts, data: row.data } : null, conditions,
  };
}

/** What a fixture is missing; empty means a replay has every part it needs. */
export function checkFixture(f: Fixture): string[] {
  const out: string[] = [];
  if (!f.system) out.push("no system prompt (no recorded request shape for this turn)");
  if (f.tools.length === 0) out.push("no tools in the request shape");
  if (!f.messages.some((m) => m.role === "user" && (m.content === f.prompt || (Array.isArray(m.content) && m.content.some((b: any) => b?.text === f.prompt))))) out.push("the conversation does not hold the prompt");
  if (f.tool_calls.length === 0 && !f.answer) out.push("the turn has neither tool calls nor an answer");
  if (f.tool_calls.some((c) => c.outcome === "no-result")) out.push("a tool call has no recorded result");
  if (!f.turn_row && Object.keys(f.conditions).length === 0) out.push("no turn row and no stated conditions");
  return out;
}

export function writeFixture(f: Fixture, dir = rewindDir()): string {
  const name = `${f.session}-${f.errata ?? `turn${f.turn}`}.json`;
  invariant(/^[A-Za-z0-9-]+\.json$/.test(name), "a fixture name is the session and the turn or Errata id");
  const path = join(dir, name);
  invariant(resolve(path).startsWith(resolve(dir) + "/"), "a fixture stays inside the rewind dir");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

function errataEntry(id: string): Line {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "ERRATA", "Errata.ts"), "list", "--json"], { stdout: "pipe", stderr: "pipe" });
  const e = (JSON.parse(p.stdout.toString()) as Line[]).find((x) => x.id === id);
  invariant(e, `no Errata entry ${id}`);
  return e;
}

/** The session's turn rows, from the cloud record (migration ISA ISC-170); --local reads this Mac's segments until they are retired. */
async function turnRowsFor(session: string, local: boolean): Promise<Line[]> {
  if (local) return scan({ streams: ["turn"], classes: ["system"] }).rows.filter((r) => r.session === session) as unknown as Line[];
  // The cloud, plus this machine's rows it does not hold yet (the outbox: rows written in the last minute, or a withheld
  // session's, which never leave). A cloud that cannot be reached leaves the outbox alone, and says so.
  const outbox = scan({ streams: ["turn"], classes: ["system"] }).rows.filter((r) => r.session === session) as unknown as Line[];
  const { cloudRows } = await import("./lib/cloudRead");
  let cloud: Line[] = [];
  try {
    cloud = (await cloudRows({ stream: "turn", class: "system", session, withData: true })) as unknown as Line[];
  } catch (e) {
    console.error(`cloud record unreachable (${(e as Error).message.slice(0, 120)}); using this machine's rows only`);
  }
  const have = new Set(cloud.map((r) => r.id));
  return [...cloud, ...outbox.filter((r) => !have.has(r.id))];
}

async function main(argv: string[]): Promise<number> {
  const [cmd, session, ...rest] = argv;
  if (cmd !== "input" || !session) { console.error("usage: Rewind.ts input <session> (<promptIndex> | --errata <id>) [--assume key=value ...] [--source why] [--check] [--json]"); return 2; }
  const flag = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const errata = flag("--errata");
  const turnArg = rest[0] && /^\d+$/.test(rest[0]) ? Number(rest[0]) : undefined;
  const assume: Record<string, Condition> = {};
  rest.forEach((a, i) => {
    if (a !== "--assume") return;
    const [k, v] = (rest[i + 1] ?? "").split("=");
    invariant(k && v !== undefined, "--assume takes key=value");
    const num = Number(v);
    assume[k] = { value: Number.isFinite(num) && v !== "" ? num : v, source: flag("--source") ?? (errata ? `stated: ${errata}` : "stated on the command line") };
  });
  const transcript = findTranscript(session);
  if (!transcript) { console.error(`no transcript for session ${session}`); return 1; }
  const lines = readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as Line; } catch { return {}; } });
  const e = errata ? errataEntry(errata) : null;
  const f = buildFixture(lines, {
    session, transcriptPath: transcript, turn: turnArg, requested: e?.context?.requested ?? undefined, before: e?.ts, errata,
    turnRows: await turnRowsFor(session, rest.includes("--local")), assume,
  });
  const path = writeFixture(f);
  const missing = checkFixture(f);
  const summary = { fixture: path, turn: f.turn, prompt: f.prompt.slice(0, 80), messages: f.messages.length, tools: f.tools.length, tool_calls: f.tool_calls.map((c) => `${c.name}:${c.outcome}`), conditions: f.conditions, turn_row: f.turn_row?.id ?? null, missing };
  console.log(rest.includes("--json") ? JSON.stringify(summary) : `Fixture ${path}\n  turn ${f.turn}: ${summary.prompt}\n  ${f.messages.length} messages, ${f.tools.length} tools, ${f.tool_calls.length} tool calls (${summary.tool_calls.join(", ")})\n  conditions ${JSON.stringify(f.conditions)}${missing.length ? `\n  missing: ${missing.join("; ")}` : ""}`);
  return rest.includes("--check") && missing.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
