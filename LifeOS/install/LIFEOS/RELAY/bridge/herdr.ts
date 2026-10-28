/**
 * herdr.ts — Tex → herdr hand-off (Relay ISA F12).
 *
 * A text that asks for herdr runs exactly like any other text: the guarded headless session does the work and
 * the answer comes back on the thread. The bridge also mirrors that run into a herdr workspace on the Mac. The
 * pane shows the run live (HerdrWatch.ts tails the stream), then turns into an interactive fork of the same
 * session, so the principal can walk up to herdr later and keep going. The fork never shares a session id
 * with the text line, so a later text and the keyboard never write into one transcript.
 *
 * Only the bridge drives herdr. The guarded text session cannot type into a pane (texting-guard-core 4.1.0),
 * because an interactive pane runs outside the guard.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { getClaudeDir } from "../../TOOLS/Paths.ts";

const execFileP = promisify(execFile);
const LIFEOS_ROOT = getClaudeDir();
export const WATCH_SCRIPT = join(LIFEOS_ROOT, "LIFEOS/RELAY/bridge/HerdrWatch.ts");

/** Words that make a leading "Herder …" a sentence about herdr rather than an order to use it. */
const ABOUT_HERDR = "is|was|isn'?t|wasn'?t|has|had|keeps?|seems|looks|won'?t|doesn'?t|didn'?t|does|did|can'?t|broke|crashed|says|shows|and|or|itself|update|updates|config|version|status";
/** At the start of the text, or of a voice note's transcript line (Relay ISA F12, spoken form):
 *  "herdr: …", "Herder, …", "Herder. …", "herd - …", and the dictated "Herder fix the deploy" with no comma.
 *  Bare "herd" needs the punctuation, so "herd the sponsors" stays a text. Stripped from the prompt. */
const KEYWORD = new RegExp(String.raw`^[ \t]*(?:herd(?:r|er)?[ \t]*(?:[:,.]|[ \t]-)|herd(?:r|er)[ \t]+(?!(?:${ABOUT_HERDR})\b)(?=\w))[ \t]*`, "im");
/** "do it in herdr", "open a herder session", "use herder for this" anywhere. Left in place: it is part of the sentence. */
const MENTION = /\b(?:in|on|into|via|through|using|with|from|use|open|start|launch|spin\s+up)\s+(?:a\s+|the\s+|up\s+)?herd(?:r|er)\b|\bherd(?:r|er)\s+(?:session|workspace|pane|tab|window)s?\b/i;

export const BRIDGE_NOTE = "[Bridge note: the principal asked for this in herdr. The bridge is mirroring this run live into a herdr workspace on their Mac, and it becomes an interactive session there when you finish. That is already handled, so do the work itself and never run herdr for it. Say nothing about the mirror; the bridge adds that line to your reply.]";

export function herdrRoute(text: string): { herdr: boolean; prompt: string } {
  if (KEYWORD.test(text)) {
    const rest = text.replace(KEYWORD, "").trim();
    return { herdr: true, prompt: `${rest || text.trim()}\n${BRIDGE_NOTE}` };
  }
  if (MENTION.test(text)) return { herdr: true, prompt: `${text}\n${BRIDGE_NOTE}` };
  return { herdr: false, prompt: text };
}

/** A short workspace label from the request: its first words, without the bridge note. */
export function herdrLabel(prompt: string): string {
  const first = prompt.replace(BRIDGE_NOTE, "").replace(/\s+/g, " ").trim();
  const words = first.split(" ").slice(0, 6).join(" ");
  const clipped = words.length > 40 ? `${words.slice(0, 39).trimEnd()}…` : words;
  return `📱 ${clipped || "text"}`;
}

export interface HerdrRun {
  /** Plain line for the reply, e.g. "🖥️ It's in herdr as “📱 fix the blog”." */
  note: string;
  ok: boolean;
  /** One raw stream-json line from the run. */
  line(raw: string): void;
  /** The run is over (answered, failed, stopped or timed out); the pane may open the session. */
  finish(): void;
}

export type Exec = (args: string[]) => Promise<string>;

export interface HerdrOptions { stateDir: string; exec?: Exec; now?: () => number; bin?: string }

function herdrBin(): string {
  const fallback = join(homedir(), ".local", "bin", "herdr");
  return Bun.which("herdr") ?? (existsSync(fallback) ? fallback : "herdr");
}

/** The real herdr CLI: argument array, never a shell string. */
export function herdrExec(bin = herdrBin()): Exec {
  return async (args) => (await execFileP(bin, args, { timeout: 15_000 })).stdout;
}

const NOOP_RUN = (note: string): HerdrRun => ({ note, ok: false, line() {}, finish() {} });

export class HerdrMirror {
  private readonly dir: string;
  private readonly exec: Exec;
  private readonly now: () => number;
  constructor(opts: HerdrOptions) {
    this.dir = join(opts.stateDir, "herdr");
    this.exec = opts.exec ?? herdrExec(opts.bin);
    this.now = opts.now ?? Date.now;
  }

  route(text: string) { return herdrRoute(text); }

  /** Opens the live view for one run. Never throws: if herdr is not reachable the text still gets its answer. */
  async open(_thread: string, prompt: string): Promise<HerdrRun> {
    const label = herdrLabel(prompt);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const runFile = join(this.dir, `${new Date(this.now()).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}-${randomUUID().slice(0, 8)}.jsonl`);
    writeFileSync(runFile, JSON.stringify({ type: "textus_prompt", label, text: prompt.replace(BRIDGE_NOTE, "").trim() }) + "\n", { mode: 0o600 });
    // Every herdr text gets its own workspace (ISC-110). A follow-up filed as a tab in an earlier workspace was
    // invisible: the sidebar row is named from that workspace's first tab only (2026-10-09).
    let paneId: string;
    try {
      const ws = JSON.parse(await this.exec(["workspace", "create", "--cwd", LIFEOS_ROOT, "--label", label, "--no-focus"]));
      paneId = ws?.result?.root_pane?.pane_id;
      const workspaceId = ws?.result?.workspace?.workspace_id;
      if (typeof paneId !== "string" || !paneId || typeof workspaceId !== "string" || !workspaceId) throw new Error("herdr returned no pane");
      await this.exec(["pane", "run", paneId, `bun ${WATCH_SCRIPT} ${runFile}`]);
    } catch {
      writeFileSync(`${runFile}.done`, "", { mode: 0o600 });
      return NOOP_RUN("🖥️ I couldn't reach herdr on the Mac, so this one ran on the text line only.");
    }
    let finished = false;
    return {
      ok: true,
      note: `🖥️ It's in herdr as “${label}”, ready for you to pick up.`,
      line: (raw) => { if (!finished && raw.trim()) try { appendFileSync(runFile, raw.trimEnd() + "\n"); } catch { /* the view is best effort */ } },
      finish: () => { if (finished) return; finished = true; try { writeFileSync(`${runFile}.done`, "", { mode: 0o600 }); } catch { /* best effort */ } },
    };
  }
}
