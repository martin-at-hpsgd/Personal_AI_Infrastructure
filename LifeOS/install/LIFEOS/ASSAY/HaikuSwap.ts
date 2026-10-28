/**
 * HaikuSwap — moves a Haiku decision onto Assay's judgment layer the safe way (principal, 2026-10-12).
 *
 * A call site asks the judgment layer first. When the registry lets that question act (enforce, earned through the
 * principal's labels), the call site uses the judgment and skips Haiku. Until then Haiku answers, and every pair of
 * answers lands in assay-haiku-pairs.jsonl so agreement can be read and labelled. Never throws: a judgment-layer
 * failure is a null and the Haiku path runs.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { invariant } from "../TOOLS/Invariant.ts";
import { dirname, join } from "path";
import { lifeosPath } from "../TOOLS/Paths.ts";
import { judge, noulValue, type JudgeResult } from "./Assay.ts";
import type { Questions } from "./Engine.ts";
import { liveEngineId } from "./Registry.ts";

/**
 * The drift event's default writer: STATVS writeEvent (migration design §2.1), by a computed path so an install without
 * LIFEOS/STATVS/ still reverts and simply skips the event. writeEvent never throws on a refusal; this throws it, so
 * driftRevert keeps its old answer for an event that could not be written.
 */
function writeStatvsEvent(e: Record<string, unknown>): unknown {
  const path = join(import.meta.dir, "../STATVS/index.ts");
  if (!existsSync(path)) return undefined;
  const sent = (require(path) as { writeEvent: (e: Record<string, unknown>) => { ok: boolean; refused?: string } }).writeEvent(e);
  if (!sent.ok) throw new Error(sent.refused);
  return sent;
}

export const PAIRS_PATH = () => lifeosPath("MEMORY", "OBSERVABILITY", "assay-haiku-pairs.jsonl");
/** Where `list` keeps what it showed, per caller, so `answer` numbers resolve against exactly those judgments. */
export const LISTED_DIR = () => lifeosPath("MEMORY", "STATE", "assay-haiku-list");

/**
 * The engine each answer came from and the mode its question was in, keyed by caller, question and state, so recordPair
 * can stamp the pair with both: a label must name the engine whose answer it judged, never whichever engine is live when
 * the principal gets round to labelling, and drift must tell an enforcement check from shadow collection. One entry per
 * question, so recording one question of a judgment leaves the other questions' entries for their own recordPair.
 * recordPair consumes its entry. Calls that act on the judgment never record a pair, so the map is bounded (oldest out).
 */
type Judged = { engine: string | null; mode: string | null };
const judgedBy = new Map<string, Judged>();
const JUDGED_BY_MAX = 1000;
const judgedKey = (caller: string, question: string, state: string) => `${caller}\n${question}\n${createHash("sha256").update(state).digest("hex")}`;

function engineOf(model: string | undefined): string | null {
  try { return liveEngineId(model); } // no model on the answer: the engine called is the configured alias
  catch { return null; } // an unreadable model id leaves the pair's engine unrecorded, which labels as unknown and never earns
}

function rememberEngine(caller: string, state: string, j: JudgeResult): void {
  try {
    const anyModel = Object.values(j).find((r) => typeof r?.model === "string" && r.model.length > 0)?.model;
    for (const [question, r] of Object.entries(j)) {
      const key = judgedKey(caller, question, state);
      const model = typeof r?.model === "string" && r.model.length > 0 ? r.model : anyModel;
      judgedBy.delete(key);
      judgedBy.set(key, { engine: engineOf(model), mode: typeof r?.verdict?.mode === "string" ? r.verdict.mode : null });
    }
    while (judgedBy.size > JUDGED_BY_MAX) judgedBy.delete(judgedBy.keys().next().value as string);
  } catch { /* a malformed result leaves its pairs unstamped: unknown engine, never counted as an enforcement check */ }
}

/** One judgment-layer call; null on any failure, so the caller falls back to Haiku. `run` is injectable for tests. */
export async function judgeOrNull(caller: string, state: string, questions: Questions, timeoutMs = 4000, run: typeof judge = judge): Promise<JudgeResult | null> {
  let j: JudgeResult;
  try { j = await run(state, questions, { caller, timeoutMs }); } catch { return null; }
  rememberEngine(caller, state, j);
  return j;
}

/**
 * The judgment's own answer as a plain value: the choice, or "yes"/"no" for a yes/no question. A yes/no reads the
 * registered cut through decide()'s `yes` when the question has a registry threshold, and otherwise the engine's own
 * majority reading (noulValue); no probability cut lives in this file.
 */
export function judgedValue(j: JudgeResult | null, question: string): string | null {
  const r = j?.[question];
  if (!r) return null;
  if (r.answer.type === "choice") return r.answer.choice;
  if (r.answer.type === "noul") {
    if (typeof r.verdict?.yes === "boolean") return r.verdict.yes ? "yes" : "no";
    try { return noulValue(r.answer.noul).verdict; } catch { return null; }
  }
  return null;
}

/** While a caller acts, Haiku still answers 1 call in CHECK_EVERY, picked by a stable hash of the caller and the state. */
export const CHECK_EVERY = 10;
/** A caller acting on the judgment layer goes back to shadow when the last DRIFT_WINDOW checked pairs agree under DRIFT_BAR. */
export const DRIFT_WINDOW = 20;
export const DRIFT_BAR = 0.85;

export function checkThisOne(caller: string, state: string): boolean {
  return parseInt(createHash("sha256").update(`${caller}\n${state}`).digest("hex").slice(0, 8), 16) % CHECK_EVERY === 0;
}

/**
 * Puts an enforce caller back to shadow, texting the principal through Vigil, when its last DRIFT_WINDOW checked pairs
 * agree with Haiku less than DRIFT_BAR of the time. Returns true when it reverted. Never throws.
 *
 * A checked pair is one Haiku answered while its question was enforcing (stamped `mode: "enforce"`), judged by the live
 * engine, and recorded after the caller's last revert. Pairs collected in shadow, judged by an earlier engine, or from an
 * enforce stretch that already ended in a revert describe a judgment that is not the one acting now, so they never count.
 */
export async function driftRevert(caller: string, opts: { pairsPath?: string; callersPath?: string; emit?: (e: Record<string, unknown>) => unknown; engine?: string } = {}): Promise<boolean> {
  try {
    const { defaultCallersPath } = await import("./Registry.ts");
    const callersPath = opts.callersPath ?? defaultCallersPath();
    const raw = JSON.parse(readFileSync(callersPath, "utf8"));
    if (raw[caller]?.mode !== "enforce") return false;
    const engine = opts.engine ?? liveEngineId();
    const revertedAt = Date.parse(raw[caller]?.reverted?.date ?? "");
    const current = (p: { mode?: unknown; engine?: unknown; ts?: unknown }) => p.mode === "enforce" && p.engine === engine
      && (Number.isNaN(revertedAt) || Date.parse(String(p.ts)) > revertedAt);
    const rows = readFileSync(opts.pairsPath ?? PAIRS_PATH(), "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((p) => p && p.caller === caller && typeof p.agree === "boolean" && current(p)).slice(-DRIFT_WINDOW);
    if (rows.length < DRIFT_WINDOW) return false;
    const rate = rows.filter((p) => p.agree).length / rows.length;
    if (rate >= DRIFT_BAR) return false;
    const date = new Date().toISOString();
    raw[caller] = { ...raw[caller], mode: "shadow", reverted: { reason: `agreement with Haiku ${(rate * 100).toFixed(0)}% over the last ${DRIFT_WINDOW} checks, under ${DRIFT_BAR * 100}%`, from: "enforce", to: "shadow", date } };
    invariant(raw[caller].mode === "shadow", "driftRevert: the caller must be shadow before writing");
    const tmp = `${callersPath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n");
    renameSync(tmp, callersPath);
    const emit = opts.emit ?? writeStatvsEvent;
    await emit({ id: randomUUID(), source: "assay", ts: date, kind: "ai", severity: "high", title: `${caller} switched back to Haiku`,
      summary: `The judgment layer agreed with Haiku on only ${(rate * 100).toFixed(0)}% of the last ${DRIFT_WINDOW} checks, so ${caller} is back in shadow.`,
      ref: caller, url: null, privacy_class: "public", dedup_key: `assay:haikuswap-drift:${caller}:${date.slice(0, 10)}` });
    return true;
  } catch { return false; }
}

/**
 * Records the judgment and Haiku answers for one state, for agreement and labelling, stamped with the engine that produced
 * the judgment and the mode its question was in when judgeOrNull saw it (absent otherwise: such a pair labels as unknown
 * and never counts as an enforcement check). Never throws.
 */
export function recordPair(caller: string, question: string, state: string, judgment: string | null, haiku: string | null, path = PAIRS_PATH()): void {
  if (judgment === null) return; // no judgment, no pair (also keeps tests, where inference is off, out of the log)
  try {
    const key = judgedKey(caller, question, state);
    const judged = judgedBy.get(key);
    judgedBy.delete(key);
    const engine = judged?.engine ?? null, mode = judged?.mode ?? null;
    mkdirSync(dirname(path), { recursive: true });
    const state_sha256 = createHash("sha256").update(state).digest("hex");
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), caller, question, state_sha256, state_preview: state.slice(0, 240), judgment, haiku, agree: judgment !== null && haiku !== null ? judgment === haiku : null, ...(engine ? { engine } : {}), ...(mode ? { mode } : {}) }) + "\n", { mode: 0o600 });
    void driftRevert(caller, { pairsPath: path });
  } catch { /* the pair log never breaks the caller */ }
}

// ── Labelling: the principal's right/wrong on the judgment layer's answers, which is how a caller earns enforce ──

/** `engine`: the engine whose answer `judgment` is; `mode`: its question's registry mode then. Both absent on pairs recorded before they were stamped. */
type Pair = { ts: string; caller: string; question: string; state_sha256: string; state_preview: string; judgment: string; haiku: string | null; agree: boolean | null; engine?: string; mode?: string };

/** The newest pairs for a caller that carry no principal label yet, newest first. */
export async function unlabelled(caller: string, n: number, path = PAIRS_PATH()): Promise<Pair[]> {
  const { readLabels } = await import("../TOOLS/lib/LabelStore.ts");
  const done = new Set(readLabels().filter((l) => l.caller === caller && l.source === "principal").map((l) => l.id));
  const seen = new Set<string>();
  const rows: Pair[] = [];
  let text = "";
  try { text = await Bun.file(path).text(); } catch { return []; }
  for (const line of text.trim().split("\n").reverse()) {
    let p: Pair; try { p = JSON.parse(line); } catch { continue; }
    if (!p || p.caller !== caller) continue;
    const id = labelId(p);
    if (seen.has(id) || done.has(id)) continue;
    seen.add(id); rows.push(p);
    if (rows.length >= n) break;
  }
  return rows;
}

/** One label per caller, question, state and engine: another engine's judgment of the same state is a different thing to label. */
const labelId = (p: Pick<Pair, "caller" | "question" | "state_sha256" | "engine">) =>
  `haikuswap-${createHash("sha256").update(`${p.caller}:${p.question}:${p.state_sha256}${p.engine ? `:${p.engine}` : ""}`).digest("hex").slice(0, 24)}`;

// ── What `list` showed, which is the only thing `answer` numbers can mean ──

/** Caller names become a file name under LISTED_DIR, so they are held to a plain-name shape. */
const CALLER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
type Listed = { v: 1; caller: string; listed_at: string; items: Pair[] };
const listedPath = (caller: string, dir: string) => join(dir, `${caller}.json`);

function writeListed(caller: string, items: Pair[], dir: string): void {
  invariant(CALLER_RE.test(caller), `HaikuSwap: caller ${JSON.stringify(caller)} is not a plain name`);
  invariant(items.every((p) => p.caller === caller), "HaikuSwap: a listed item belongs to another caller");
  const listed: Listed = { v: 1, caller, listed_at: new Date().toISOString(), items };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = listedPath(caller, dir), tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(listed) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function readListed(caller: string, dir: string): Listed | null {
  try {
    const l = JSON.parse(readFileSync(listedPath(caller, dir), "utf8")) as Listed;
    return l && l.v === 1 && l.caller === caller && Array.isArray(l.items) ? l : null;
  } catch { return null; }
}

async function cli(argv: string[]): Promise<number> {
  const [cmd, caller, ...rest] = argv;
  if ((cmd !== "list" && cmd !== "answer") || !caller || !CALLER_RE.test(caller)) {
    console.error("usage: bun LIFEOS/ASSAY/HaikuSwap.ts list <caller> [--n 10] | answer <caller> 1y 2n …   (y = the judgment was right, n = wrong; numbers are the ones the last list showed)");
    return 2;
  }
  const listedDir = LISTED_DIR();
  const live = liveEngineId();
  if (cmd === "list") {
    const at = rest.indexOf("--n");
    const n = at >= 0 ? Number(rest[at + 1]) : 10;
    if (!Number.isInteger(n) || n < 1) { console.error("--n needs a positive whole number"); return 2; }
    const rows = await unlabelled(caller, n);
    writeListed(caller, rows, listedDir); // an empty list is recorded too, so an older list's numbers cannot be answered
    if (!rows.length) { console.log(`No unlabelled answers for ${caller} yet.`); return 0; }
    rows.forEach((p, i) => {
      const other = p.engine === live ? "" : `\n   (answered by ${p.engine ?? "an unrecorded engine"}; a label here does not count toward ${live})`;
      console.log(`${i + 1}. Judgment: ${p.judgment}  (Haiku: ${p.haiku ?? "–"})\n   ${p.state_preview.replace(/\s+/g, " ")}${other}\n`);
    });
    console.log(`Answer with: bun LIFEOS/ASSAY/HaikuSwap.ts answer ${caller} 1y 2n …`);
    return 0;
  }
  const listed = readListed(caller, listedDir);
  if (!listed) {
    console.error(`No list on record for ${caller}: run \`bun LIFEOS/ASSAY/HaikuSwap.ts list ${caller}\` first, then answer by the numbers it shows.`);
    return 1;
  }
  if (!rest.length) { console.error("answer needs at least one item, like 1y or 2n"); return 2; }
  const { addLabel, earnedStatus, UNKNOWN_ENGINE } = await import("../TOOLS/lib/LabelStore.ts");
  let skipped = 0;
  for (const tok of rest) {
    const m = /^(\d+)([yn])$/i.exec(tok);
    if (!m) { console.error(`skipped "${tok}": use 1y or 2n`); skipped++; continue; }
    const p = listed.items[Number(m[1]) - 1];
    if (!p) { console.error(`skipped ${tok}: no item ${m[1]} in the list shown at ${listed.listed_at}`); skipped++; continue; }
    const right = m[2].toLowerCase() === "y";
    // For a yes/no question the true class follows from the judgment and the verdict; a choice question has no pass/fail class.
    const truth = p.judgment === "yes" || p.judgment === "no" ? ((p.judgment === "yes") === right ? "pass" : "fail") : undefined;
    // The label judges the engine that produced this judgment; a pair with no recorded engine is unknown and never earns.
    addLabel({ id: labelId(p), source: "principal", kind: "check", caller: p.caller, question: p.question, verdict: right ? "right" : "wrong", ...(truth ? { truth } : {}), engine: p.engine ?? UNKNOWN_ENGINE, by: "principal" });
  }
  const q = listed.items[0]?.question;
  if (q) {
    const e = earnedStatus({ caller, question: q });
    console.log(`${caller}.${q}: ${e.n} labels, agreement ${e.agreement === null ? "none" : (e.agreement * 100).toFixed(0) + "%"}, needs ${e.min_labels} at ${(e.bar * 100).toFixed(0)}% → ${e.earned ? "EARNED, ready to switch" : "not yet"}`);
  }
  return skipped > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await cli(process.argv.slice(2)));
