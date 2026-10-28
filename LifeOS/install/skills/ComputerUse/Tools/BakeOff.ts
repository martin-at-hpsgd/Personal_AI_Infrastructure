#!/usr/bin/env bun
/**
 * BakeOff — run one mission set through both vision legs (astra, claude) under the
 * same supervisor and score them ONLY by each mission's deterministic verifier.
 *
 *   bun BakeOff.ts run [--backend astra|claude] [--mission <id>] [--trials N] [--model <alias>]
 *   bun BakeOff.ts report              scoreboard + per-class pick
 *   bun BakeOff.ts report --check      exit 1 unless every mission × backend has a verdict
 *   bun BakeOff.ts report --check-pick exit 1 unless Config vision_pick matches the scoreboard
 *   bun BakeOff.ts pick                print the vision_pick line the scoreboard implies
 *
 * Results append to <USER skill dir>/bakeoff/results.jsonl, one line per run, each
 * carrying the run record's verifier verdict. The actors' own reports are stored as
 * text and never scored.
 *
 * @version 1.0.0
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_CONFIG_PATH, USER_SKILL_DIR, loadConfig, realProviders, supervise, writeRecord,
  type RunRequest, type VisionBackend,
} from "./Run";

export const RESULTS = join(USER_SKILL_DIR, "bakeoff", "results.jsonl");
const OUT = join(homedir(), "Downloads", "cu-bake");
const BACKENDS: VisionBackend[] = ["astra", "claude"];

export interface Mission {
  id: string;
  /** Task class = the target app, lowercased. The pick is made per class. */
  app: string;
  task: (b: VisionBackend) => string;
  verify: (b: VisionBackend) => string;
  /** Shell setup run before each trial (give the app a window, clear old output). */
  setup: (b: VisionBackend) => string[][];
  stepCap: number;
  wallClockSeconds: number;
}

const saveSteps = (dir: string, name: string) =>
  `Save with Cmd+S. In the Save dialog press Cmd+Shift+G, type the folder path ${dir} and press Return, then set the file name to ${name} and press Return. If asked, replace.`;

export const MISSIONS: Mission[] = [
  {
    id: "textedit-save",
    app: "TextEdit",
    task: (b) => `In TextEdit (running with a window open): create a new document with Cmd+N. Type exactly: bake-off line from ${b}\n${saveSteps(OUT, `${b}-save.rtf`)} The end condition is that the Save dialog has closed and the window title reads ${b}-save.rtf. Then stop.`,
    verify: (b) => `rg -q "bake-off line from ${b}" "${OUT}/${b}-save.rtf"`,
    setup: (b) => [["rm", "-f", `${OUT}/${b}-save.rtf`], ["open", "-g", "-a", "TextEdit"], ["interceptor", "macos", "menu", "--app", "TextEdit", "File", "New"]],
    stepCap: 40, wallClockSeconds: 300,
  },
  {
    id: "textedit-bold",
    app: "TextEdit",
    task: (b) => `In TextEdit (running with a window open): create a new document with Cmd+N. Type exactly: Bold words here\nThen select all of that text and make it bold (Format menu or the B button), so the whole line is bold. ${saveSteps(OUT, `${b}-bold.rtf`)} The end condition is that the Save dialog has closed and the window title reads ${b}-bold.rtf. Then stop.`,
    // RTF marks bold with the \b control word (or a *-Bold font face).
    verify: (b) => `f="${OUT}/${b}-bold.rtf"; rg -q "Bold words here" "$f" && rg -q '\\\\b[\\\\ ]|-Bold;' "$f"`,
    setup: (b) => [["rm", "-f", `${OUT}/${b}-bold.rtf`], ["open", "-g", "-a", "TextEdit"], ["interceptor", "macos", "menu", "--app", "TextEdit", "File", "New"]],
    stepCap: 50, wallClockSeconds: 420,
  },
  {
    id: "shortcuts-echo",
    app: "Shortcuts",
    task: (b) => `In Shortcuts (running, All Shortcuts window open): create a new shortcut with Cmd+N. Name it exactly "CU Bake ${b}". Configure it to receive input (Text) and add one Text action whose content is the Shortcut Input variable, so running it returns its input unchanged. Close the editor window when done. The end condition is that "CU Bake ${b}" appears in All Shortcuts. Then stop.`,
    verify: (b) => `n=$RANDOM; echo "nonce-$n" | shortcuts run "CU Bake ${b}" --output-type public.plain-text | rg -q "nonce-$n"`,
    setup: () => [["open", "-g", "-a", "Shortcuts"]],
    stepCap: 60, wallClockSeconds: 600,
  },
];

export interface ResultRow {
  at: string; mission: string; app: string; backend: VisionBackend; model?: string;
  verdict: "pass" | "fail" | "refused"; state: string; steps: number; durationMs: number;
  abortReason?: string; record?: string; actorReport?: string;
}

export function readResults(path = RESULTS): ResultRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ResultRow);
}

export interface Cell { trials: number; passes: number; medianSteps: number; medianSecs: number }
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** Pure. Refusals are not trials: a deny-list refusal says nothing about the actor. */
export function scoreboard(rows: ResultRow[]): Record<string, Partial<Record<VisionBackend, Cell>>> {
  const out: Record<string, Partial<Record<VisionBackend, Cell>>> = {};
  for (const m of new Set(rows.map((r) => r.mission))) {
    out[m] = {};
    for (const b of BACKENDS) {
      const rs = rows.filter((r) => r.mission === m && r.backend === b && r.verdict !== "refused");
      if (!rs.length) continue;
      out[m][b] = {
        trials: rs.length,
        passes: rs.filter((r) => r.verdict === "pass").length,
        medianSteps: median(rs.map((r) => r.steps)),
        medianSecs: Math.round(median(rs.map((r) => r.durationMs)) / 1000),
      };
    }
  }
  return out;
}

/**
 * Pure. Per class: higher pass rate wins; a tie on pass rate goes to the faster
 * median among passing legs; with no evidence for one leg, no pick is made for
 * that class (the default stays). Default = the leg with more total passes; ties stay astra.
 */
export function derivePick(rows: ResultRow[], missions = MISSIONS): Record<string, VisionBackend> {
  const sb = scoreboard(rows);
  const pick: Record<string, VisionBackend> = {};
  const classes = new Set(missions.map((m) => m.app.toLowerCase()));
  let totals = { astra: 0, claude: 0 };
  for (const c of classes) {
    const ids = missions.filter((m) => m.app.toLowerCase() === c).map((m) => m.id);
    const agg = (b: VisionBackend) => ids.reduce((acc, id) => {
      const cell = sb[id]?.[b];
      return cell ? { t: acc.t + cell.trials, p: acc.p + cell.passes, s: acc.s + cell.medianSecs } : acc;
    }, { t: 0, p: 0, s: 0 });
    const A = agg("astra"), C = agg("claude");
    totals = { astra: totals.astra + A.p, claude: totals.claude + C.p };
    if (!A.t || !C.t) continue;
    const ra = A.p / A.t, rc = C.p / C.t;
    if (rc > ra) pick[c] = "claude";
    else if (ra > rc) pick[c] = "astra";
    else if (ra > 0) pick[c] = C.s < A.s ? "claude" : "astra";
  }
  pick.default = totals.claude > totals.astra ? "claude" : "astra";
  return pick;
}

export function pickLine(pick: Record<string, VisionBackend>): string {
  const keys = ["default", ...Object.keys(pick).filter((k) => k !== "default").sort()];
  return `vision_pick: ${keys.map((k) => `${k}=${pick[k]}`).join(", ")}`;
}

async function sh(cmd: string[]): Promise<number> {
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  return await p.exited;
}

async function runOne(m: Mission, b: VisionBackend, model?: string): Promise<ResultRow> {
  mkdirSync(OUT, { recursive: true });
  for (const c of m.setup(b)) await sh(c);
  await Bun.sleep(1500);
  const req: RunRequest = {
    task: m.task(b), allowlist: [m.app], verifier: { kind: "cli", command: m.verify(b) },
    stepCap: m.stepCap, wallClockSeconds: m.wallClockSeconds, backend: b, claudeModel: model,
    eventLog: join(USER_SKILL_DIR, "bakeoff", `${m.id}-${b}-last.jsonl`),
  };
  mkdirSync(join(USER_SKILL_DIR, "bakeoff"), { recursive: true });
  const r = await supervise(req, loadConfig(DEFAULT_CONFIG_PATH), realProviders);
  const row: ResultRow = {
    at: new Date().toISOString(), mission: m.id, app: m.app, backend: b, model: b === "claude" ? (model ?? "opus") : undefined,
    verdict: r.record && r.record.verdict !== "unverified" ? r.record.verdict : "refused",
    state: r.record?.state ?? "refused", steps: r.record?.steps ?? 0, durationMs: r.record?.durationMs ?? 0,
    abortReason: r.record?.abortReason ?? (r.record ? undefined : r.message),
    record: r.record && r.record.verdict !== "unverified" ? writeRecord(r.record) : undefined,
    actorReport: r.record?.astraReport?.slice(0, 600),
  };
  appendFileSync(RESULTS, JSON.stringify(row) + "\n");
  return row;
}

function printReport(rows: ResultRow[]) {
  const sb = scoreboard(rows);
  console.log("mission            | astra (pass/trials, steps, secs) | claude (pass/trials, steps, secs)");
  for (const m of MISSIONS) {
    const cell = (b: VisionBackend) => { const c = sb[m.id]?.[b]; return c ? `${c.passes}/${c.trials}, ${c.medianSteps}, ${c.medianSecs}s` : "—"; };
    console.log(`${m.id.padEnd(19)}| ${cell("astra").padEnd(33)}| ${cell("claude")}`);
  }
  console.log(pickLine(derivePick(rows)));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const cmd = args[0] ?? "report";
  if (cmd === "run") {
    const backends = get("backend") ? [get("backend") as VisionBackend] : BACKENDS;
    const missions = get("mission") ? MISSIONS.filter((m) => m.id === get("mission")) : MISSIONS;
    const trials = Number(get("trials") ?? "1");
    if (!missions.length) { console.error("unknown mission"); process.exit(2); }
    for (let t = 0; t < trials; t++) for (const m of missions) for (const b of backends) {
      const row = await runOne(m, b, get("model"));
      console.log(`${m.id} ${b}: ${row.verdict} (${row.state}, ${row.steps} steps, ${Math.round(row.durationMs / 1000)}s)${row.abortReason ? ` — ${row.abortReason}` : ""}`);
      if (row.verdict === "refused") { console.error("refused: resolve the deny list, then re-run"); process.exit(2); }
    }
    process.exit(0);
  }
  const rows = readResults();
  if (cmd === "pick") { console.log(pickLine(derivePick(rows))); process.exit(0); }
  printReport(rows);
  if (args.includes("--check")) {
    const sb = scoreboard(rows);
    const missing = MISSIONS.flatMap((m) => BACKENDS.filter((b) => !sb[m.id]?.[b]).map((b) => `${m.id}×${b}`));
    if (missing.length) { console.error(`missing verdicts: ${missing.join(", ")}`); process.exit(1); }
  }
  if (args.includes("--check-pick")) {
    const want = derivePick(rows);
    const have = loadConfig(DEFAULT_CONFIG_PATH).visionPick;
    const bad = Object.keys(want).filter((k) => have[k] !== want[k]);
    if (bad.length) { console.error(`Config vision_pick disagrees with the scoreboard on: ${bad.join(", ")}\nexpected ${pickLine(want)}`); process.exit(1); }
  }
}

