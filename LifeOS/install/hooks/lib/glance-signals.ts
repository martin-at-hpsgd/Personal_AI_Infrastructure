// Assay judgment layer (engine: Clef-omni), shadow only. Publishes the six prompt-signal judgments from the
// `dispatch-advisor` caller to a per-turn scratch file and logs each one beside the keyword-table
// verdict it is compared with. Thresholds come from the Assay caller registry, never from this file.
// See LIFEOS/DOCUMENTATION/Assay/AssaySystem.md § Judgment layer.
// On-disk names jev-turn/, jev-signal-*.jsonl and the jev_value row field are retired 2026-10-10 names, kept so old data still reads.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareGlanceSignal } from "../../LIFEOS/ERRATA/Signals";
import { invariant } from "../../LIFEOS/TOOLS/Invariant";
import { lifeosPath } from "../../LIFEOS/TOOLS/Paths";
import { decide, safeCallerConfig, thresholdRows, type ComparisonLine } from "../../LIFEOS/ASSAY/Assay";
import type { EngineResponse, NoulAnswer } from "../../LIFEOS/ASSAY/Engine";

export const SIGNAL_IDS = ["praise", "question", "task", "correction", "frustration", "injection"] as const;
export type SignalId = typeof SIGNAL_IDS[number];
export type SignalVerdicts = Record<SignalId, boolean>;
export type SignalScratch = {
  session: string; turn: string; timestamp: string; prompt_hash: string; model: string;
  signals: Record<SignalId, NoulAnswer>;
};
export type SignalPaths = { scratchDir?: string; observationsDir?: string; callersPath?: string; env?: NodeJS.ProcessEnv };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function scratchPath(session: string, paths: SignalPaths): string {
  // Encode untrusted session ids as a single filename, retaining ordinary UUIDs.
  const name = /^[A-Za-z0-9_-]+$/.test(session) ? session : digest(session);
  return join(paths.scratchDir ?? lifeosPath("MEMORY", "STATE", "jev-turn"), `${name}.json`);
}
export function validNoul(answer: unknown): answer is NoulAnswer {
  const a = answer as Partial<NoulAnswer> | null;
  return !!a && a.type === "noul" && typeof a.noul === "number" && Number.isFinite(a.noul) && a.noul >= 0 && a.noul <= 1;
}
function validScratch(row: SignalScratch): boolean {
  return !!row && typeof row.session === "string" && !!row.session && typeof row.turn === "string" && !!row.turn &&
    typeof row.model === "string" && Number.isFinite(Date.parse(row.timestamp)) && typeof row.prompt_hash === "string" &&
    !!row.signals && SIGNAL_IDS.every(id => validNoul(row.signals[id]));
}
export function writeSignals(session: string, turn: string, prompt: string, response: EngineResponse, paths: SignalPaths = {}): boolean {
  const signals = Object.fromEntries(SIGNAL_IDS.map(id => [id, response.answers[id]])) as SignalScratch["signals"];
  const row: SignalScratch = { session, turn, timestamp: new Date().toISOString(), prompt_hash: digest(prompt), model: response.model, signals };
  invariant(validScratch(row), "Signal scratch must contain six valid Nouls and a local turn identity");
  const path = scratchPath(session, paths);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(row) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch { return false; }
  finally { try { unlinkSync(tmp); } catch {} }
}

/** Missing, stale, malformed or another prompt's answers are never evidence. */
export function readSignals(session: string, prompt: string, paths: SignalPaths = {}): SignalScratch | null {
  try {
    const row = JSON.parse(readFileSync(scratchPath(session, paths), "utf8")) as SignalScratch;
    if (!validScratch(row) || row.session !== session || row.prompt_hash !== digest(prompt)) return null;
    if (Date.now() - Date.parse(row.timestamp) > 60_000) return null;
    return row;
  } catch { return null; }
}

/** Observational only. The denominator includes agreements; the disagreement ledger never does. */
export function observeSignals(session: string, prompt: string, verdicts: SignalVerdicts, paths: SignalPaths = {}): void {
  if (((paths.env ?? process.env).LIFEOS_GLANCE_DISABLED === "1" || (paths.env ?? process.env).LIFEOS_JEV_DISABLED === "1")) return;
  const row = readSignals(session, prompt, paths);
  if (!row) return;
  const cfg = safeCallerConfig("dispatch-advisor", paths.callersPath);
  const registered = thresholdRows(cfg);
  if (!cfg || SIGNAL_IDS.some(id => !registered[id])) return;
  const file = scratchPath(session, paths);
  const lock = `${file}.lock`;
  let locked = false;
  try {
    // Cross-process dedupe: either hook may observe first. No waiting on contention.
    writeFileSync(lock, row.turn, { flag: "wx", mode: 0o600 });
    locked = true;
    try { if (readFileSync(`${file}.observed`, "utf8") === row.turn) return; } catch {}
    const records: ComparisonLine[] = SIGNAL_IDS.map(question => ({
      timestamp: row.timestamp, caller: "dispatch-advisor", session, turn: row.turn,
      question, model: row.model, jev_value: row.signals[question].noul, keyword_verdict: verdicts[question],
    }));
    invariant(records.every(r => typeof r.keyword_verdict === "boolean" && validNoul({ type: "noul", noul: r.jev_value })), "Signal comparisons must pair valid engine answers with deterministic booleans");
    const dir = paths.observationsDir ?? lifeosPath("MEMORY", "OBSERVABILITY");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "jev-signal-comparisons.jsonl"), records.map(r => JSON.stringify(r)).join("\n") + "\n");
    const disagreements = records.filter(r => {
      const answer = { type: "noul" as const, noul: r.jev_value };
      return compareGlanceSignal(answer, r.keyword_verdict, decide("dispatch-advisor", r.question, answer, paths.callersPath)) !== null;
    });
    if (disagreements.length) appendFileSync(join(dir, "jev-signal-disagreements.jsonl"), disagreements.map(r => JSON.stringify(r)).join("\n") + "\n");
    invariant(!!row.turn, "Observed marker needs a turn identity");
    writeFileSync(`${file}.observed`, row.turn, { mode: 0o600 });
  } catch { /* Observability failure never changes the deterministic result. */ }
  finally { if (locked) try { unlinkSync(lock); } catch {} }
}
