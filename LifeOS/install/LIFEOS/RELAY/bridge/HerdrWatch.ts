#!/usr/bin/env bun
/**
 * HerdrWatch.ts — the herdr pane side of a texted run (Relay ISA F12).
 *
 *   bun HerdrWatch.ts <run.jsonl>
 *
 * Shows the run live while the text line's guarded session works, then opens that session here as an
 * interactive fork (`lifeos -r <id> -- --fork-session`), so the principal can keep going at the keyboard.
 * The bridge writes <run.jsonl>.done when the run ends for any reason.
 *
 * The fork is named from the request (ISC-188). Left alone it inherits the text line's session title, which
 * comes from whatever the first text on that line was, so the pane could not be found by what was asked.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getClaudeDir } from "../../TOOLS/Paths.ts";
import { setSessionName } from "../../../hooks/lib/session-identity.ts";

const execFileP = promisify(execFile);

const DIM = "\x1b[2m", BOLD = "\x1b[1m", CYAN = "\x1b[36m", RESET = "\x1b[0m";
/** Past the bridge's own hard ceiling (60 min) plus margin: the run is over even if no marker came. */
export const GIVE_UP_MS = 75 * 60_000;
const clip = (s: string, n: number) => { const one = s.replace(/\s+/g, " ").trim(); return one.length > n ? `${one.slice(0, n - 1)}…` : one; };

function toolLine(name: string, input: Record<string, unknown>): string {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? input.skill ?? input.description ?? "";
  return `${CYAN}▸ ${name}${RESET} ${DIM}${clip(String(detail), 110)}${RESET}`;
}

/** The fork's session name: the request label without the 📱 the workspace row carries. */
export function forkName(label: string): string {
  return label.replace(/^📱\s*/u, "").trim() || "Texted request";
}

/** The fork's session id from `herdr pane get` output, once the pane runs a session other than the text line. */
export function forkSessionId(paneJson: string, textLineId: string): string | undefined {
  try {
    const id = JSON.parse(paneJson)?.result?.pane?.agent_session?.value;
    return typeof id === "string" && /^[0-9a-f-]{36}$/.test(id) && id !== textLineId ? id : undefined;
  } catch { return undefined; }
}

/** Waits for the fork to report its session id to herdr, then names it. Best effort: a miss leaves the default name. */
async function nameFork(name: string, textLineId: string): Promise<void> {
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) return;
  for (let i = 0; i < 90; i++) {
    await Bun.sleep(1000);
    let id: string | undefined;
    try { id = forkSessionId((await execFileP("herdr", ["pane", "get", pane], { timeout: 5000 })).stdout, textLineId); } catch { /* herdr busy; try again */ }
    if (id) { try { setSessionName(id, name, { source: "relay-herdr" }); } catch { /* best effort */ } return; }
  }
}

/** Renders one stream line for the pane, and reports the session id it names (init or result). */
export function render(raw: string): { out: string[]; sessionId?: string; label?: string } {
  let j: any;
  try { j = JSON.parse(raw); } catch { return { out: [] }; }
  if (!j || typeof j !== "object") return { out: [] };
  if (j.type === "textus_prompt") return { out: [`${BOLD}📱 From your text${RESET}`, String(j.text ?? ""), ""], label: typeof j.label === "string" ? j.label : undefined };
  if (j.type === "system" && j.subtype === "init") return { out: [], sessionId: typeof j.session_id === "string" ? j.session_id : undefined };
  if (j.type === "assistant" && Array.isArray(j.message?.content)) {
    const out: string[] = [];
    for (const c of j.message.content) {
      if (c?.type === "tool_use" && typeof c.name === "string") out.push(toolLine(c.name, c.input ?? {}));
      else if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) out.push(c.text.trim());
    }
    return { out };
  }
  if (j.type === "result") {
    const sid = typeof j.session_id === "string" ? j.session_id : undefined;
    const text = typeof j.result === "string" ? j.result.trim() : "";
    return { out: text ? ["", `${BOLD}✅ Answer sent to your phone${RESET}`, text] : [], sessionId: sid };
  }
  return { out: [] };
}

async function main(runFile: string): Promise<number> {
  if (!runFile || !existsSync(runFile)) { console.error("usage: bun HerdrWatch.ts <run.jsonl>"); return 2; }
  let offset = 0, pending = "", sessionId: string | undefined, label = "";
  const started = Date.now();
  const drain = () => {
    const buf = readFileSync(runFile);
    if (buf.length <= offset) return;
    pending += buf.subarray(offset).toString("utf8");
    offset = buf.length;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const r = render(line);
      if (r.sessionId) sessionId = r.sessionId;
      if (r.label) label = r.label;
      for (const l of r.out) console.log(l);
    }
  };
  while (!existsSync(`${runFile}.done`) && Date.now() - started < GIVE_UP_MS) { drain(); await Bun.sleep(400); }
  drain();
  if (!sessionId) { console.log(`\n${DIM}The run ended before a session started, so there is nothing to open here.${RESET}`); return 0; }
  console.log(`\n${DIM}Opening the session here as a fork. Texts keep their own line; this one is yours.${RESET}\n`);
  const lifeos = join(getClaudeDir(), "LIFEOS", "TOOLS", "lifeos.ts");
  const name = forkName(label);
  const proc = Bun.spawn(["bun", lifeos, "-r", sessionId, "--", "--fork-session", "--name", name], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  void nameFork(name, sessionId);
  return await proc.exited;
}

if (import.meta.main) process.exit(await main(process.argv[2] ?? ""));
