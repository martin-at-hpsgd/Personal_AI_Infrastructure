#!/usr/bin/env bun
/**
 * LabelBatch: the weekly label supply (assay-everywhere ISC-30).
 *
 * Labels are how a flag earns the right to decide, and they only arrive if somebody asks for them. This picks recent
 * receipts that carry unearned flags nobody has labelled, turns each flag into one numbered question, and writes the
 * principal's answers to the label store tied to receipt_id + check_id.
 *
 *   bun LIFEOS/TOOLS/LabelBatch.ts next [--n 10] [--json] [--deliver]   pick flags, write a batch file, print the questions;
 *                                                             --deliver writes the questions text to a state file, proofs it (Assay Proof,
 *                                                             destination handoff), then copies it to ~/Downloads (the weekly job) and records
 *                                                             the ledger line with the receipt_id. Exit 1: Proof failed, nothing delivered.
 *                                                             Exit 2: Proof could not measure, nothing delivered.
 *   bun LIFEOS/TOOLS/LabelBatch.ts answer <batch-id> 1y 2n 3s    y = flag was right, n = wrong, s = unsure
 *   bun LIFEOS/TOOLS/LabelBatch.ts stats [--json]            labels per ISO week, principal vs proxy
 *
 * Batch files: LIFEOS/USER/ASSAY/batches/<batch-id>.json (override LIFEOS_LABEL_BATCH_DIR; a per-process temp dir under bun test).
 * Receipts are read from the proof receipt store (ProofReceipt.receiptDir). An "unsure" answer is recorded and counts for nothing.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { invariant } from "./Invariant.ts";
import { getLifeosDir } from "./Paths.ts";
import { receiptDir, receiptId, type ProofReceipt } from "./lib/ProofReceipt.ts";
import { addLabel, readLabels, PROOF_GLANCE_CALLER, PROOF_GLANCE_QUESTION, type Label, type LabelVerdict } from "./lib/LabelStore.ts";
import { recordOutput } from "./lib/OutputLedger.ts";

/** caller + question are set when the flag was a glance-tier finding, so the answer lands on the key earnedStatus asks that Glance question under. */
export type BatchItem = { n: number; receipt_id: string; check_id: string; artifact: string; artifact_sha256: string; message: string; caller?: string; question?: string; answered?: { verdict: LabelVerdict; at: string } };
export type Batch = { v: 1; id: string; created: string; items: BatchItem[] };

/** Newest receipts scanned per batch: a store of thousands must not make `next` slow. */
export const SCAN_MAX_FILES = 2000;

export function batchDir(): string {
  if (process.env.LIFEOS_LABEL_BATCH_DIR) return process.env.LIFEOS_LABEL_BATCH_DIR;
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `lifeos-label-batches-test-${process.pid}`);
  return join(getLifeosDir(), "USER", "ASSAY", "batches");
}

const BATCH_ID = /^[A-Za-z0-9-]{6,64}$/;
const batchPath = (id: string): string => { invariant(BATCH_ID.test(id), `invalid batch id: ${id}`); return join(batchDir(), `${id}.json`); };

export class UsageError extends Error {}

function isFlag(f: ProofReceipt["findings"][number]): boolean {
  return f.severity === "flag" && f.earned !== true;
}

/** The Glance caller and question a glance-tier finding was asked under: its own when it names them, else Proof's (LabelStore.recordedChecks reads the same key). */
export function glanceKeyOf(f: ProofReceipt["findings"][number]): { caller?: string; question?: string } {
  if (f.tier !== "glance") return {};
  const own = f as typeof f & { caller?: unknown; question?: unknown };
  const s = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  return { caller: s(own.caller) ? own.caller : PROOF_GLANCE_CALLER, question: s(own.question) ? own.question : PROOF_GLANCE_QUESTION };
}

/** Pick up to n unearned flags, newest receipts first, that have no principal label yet (receipt_id + check_id). */
export function pickFlags(n: number, opts: { receipts?: string; labelPath?: string } = {}): BatchItem[] {
  const dir = opts.receipts ?? receiptDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".history.json"))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, SCAN_MAX_FILES);
  const labelled = new Set(readLabels({ path: opts.labelPath }).filter((l) => l.source === "principal" && l.receipt_id && l.check_id).map((l) => `${l.receipt_id}\u0000${l.check_id}`));
  const found: Array<{ ran: number; item: Omit<BatchItem, "n"> }> = [];
  for (const { f } of files) {
    let r: ProofReceipt;
    try { r = JSON.parse(readFileSync(join(dir, f), "utf8")) as ProofReceipt; } catch { continue; }
    if (!r || !Array.isArray(r.findings) || typeof r.sha256 !== "string") continue;
    const receipt_id = basename(f, ".json");
    const seen = new Set<string>();
    for (const fd of r.findings.filter(isFlag)) {
      if (seen.has(fd.check) || labelled.has(`${receipt_id}\u0000${fd.check}`)) continue;
      seen.add(fd.check);
      found.push({ ran: Date.parse(r.ran_at) || 0, item: { receipt_id, check_id: fd.check, artifact: r.artifact, artifact_sha256: r.sha256, message: fd.message.replace(/\s+/g, " ").slice(0, 200), ...glanceKeyOf(fd) } });
    }
  }
  return found.sort((a, b) => b.ran - a.ran).slice(0, n).map((x, i) => ({ n: i + 1, ...x.item }));
}

export function createBatch(n = 10, opts: { receipts?: string; labelPath?: string; now?: Date } = {}): Batch | null {
  invariant(Number.isInteger(n) && n >= 1 && n <= 50, "batch size must be 1-50");
  const items = pickFlags(n, opts);
  if (items.length === 0) return null;
  const created = (opts.now ?? new Date()).toISOString();
  const batch: Batch = { v: 1, id: `${created.slice(0, 10)}-${randomUUID().slice(0, 8)}`, created, items };
  mkdirSync(batchDir(), { recursive: true });
  writeFileSync(batchPath(batch.id), JSON.stringify(batch, null, 2), { mode: 0o600 });
  return batch;
}

/** A home-directory prefix in text that goes to the principal is written as ~, never as the absolute path. */
export function tildify(s: string, home: string = homedir()): string {
  return home.length > 1 ? s.split(home).join("~") : s;
}

/** Artifacts appear by basename and any home path inside a flag message is shown as ~/…, so the question text carries no absolute home path. */
export function formatQuestions(b: Batch): string {
  return tildify([`Batch ${b.id}: was each flag right? Answer with: LabelBatch.ts answer ${b.id} ${b.items.slice(0, 3).map((i, k) => `${i.n}${"yns"[k]}`).join(" ")} (y right, n wrong, s unsure)`, "",
    ...b.items.map((i) => `${i.n}. ${basename(i.artifact)}: flag "${i.check_id}" said: ${i.message}. Was this flag right? y/n`)].join("\n"));
}

/** Where a delivered batch lands: ~/Downloads, or LIFEOS_LABEL_DELIVER_DIR (tests). Questions to the principal only; nothing is sent anywhere. */
export function deliverDir(): string {
  if (process.env.LIFEOS_LABEL_DELIVER_DIR) return process.env.LIFEOS_LABEL_DELIVER_DIR;
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `lifeos-label-deliver-test-${process.pid}`);
  return join(homedir(), "Downloads");
}

/** What Proof said about the text, in the terms deliverBatch needs. exit follows Proof: 0 pass, 1 code failure, 2 could not measure. */
export type ProofOutcome = { exit: number; verdict: string; receipt_id: string | null; detail?: string };
export type ProofFn = (file: string) => Promise<ProofOutcome>;

type Finding = { severity?: string; check?: string; message?: string };
const PROOF_SCRIPT = join(import.meta.dir, "..", "..", "skills", "Assay", "Tools", "Proof.ts");

/** The first fail or unavailable finding, as the one line that says why a delivery stopped. */
function firstProblem(findings: Finding[] | undefined): string | undefined {
  const all = findings ?? [];
  const f = all.find((x) => x.severity === "fail") ?? all.find((x) => x.severity === "unavailable");
  return f ? `${f.check ?? "check"}: ${String(f.message ?? "").replace(/\s+/g, " ").slice(0, 160)}` : undefined;
}

type ProofModule = { runProof: (o: { artifact: string; destination: "handoff" }) => Promise<{ exit: number; receipt: { verdict: string; findings: Finding[] } }> };

/**
 * Proof the text in-process through runProof (skills/Assay/Tools/Proof.ts) with destination handoff; when that module cannot be
 * imported, spawn `bun Proof.ts run --artifact <f> --destination handoff --json`. Proof writes the receipt itself.
 */
export const runProofOnFile: ProofFn = async (file) => {
  let mod: ProofModule | null = null;
  try { mod = (await import(PROOF_SCRIPT)) as ProofModule; } catch { mod = null; }
  if (mod && typeof mod.runProof === "function") {
    const r = await mod.runProof({ artifact: file, destination: "handoff" });
    return { exit: r.exit, verdict: r.receipt.verdict, receipt_id: receiptId(file), detail: firstProblem(r.receipt.findings) };
  }
  const p = Bun.spawnSync([process.execPath, PROOF_SCRIPT, "run", "--artifact", file, "--destination", "handoff", "--json"], { stdout: "pipe", stderr: "pipe" });
  let j: { verdict?: unknown; findings?: Finding[] } | null = null;
  try {
    const parsed: unknown = JSON.parse(p.stdout.toString());
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) j = parsed as typeof j;
  } catch { j = null; }
  // Unparseable or verdict-less output is never a pass, whatever the exit code says.
  if (j === null || typeof j.verdict !== "string") {
    return { exit: 2, verdict: "unavailable", receipt_id: receiptId(file), detail: `Proof output was not a receipt (exit ${p.exitCode ?? "none"})` };
  }
  return { exit: p.exitCode ?? 2, verdict: j.verdict, receipt_id: receiptId(file), detail: firstProblem(Array.isArray(j.findings) ? j.findings : []) };
};

/** The Proof verdicts that clear a handoff (Proof exits 0 for exactly these); anything else is never delivered. */
export const DELIVERABLE_VERDICTS: ReadonlySet<string> = new Set(["pass", "admitted-flagged", "unmeasured"]);

export type DeliverResult =
  | { ok: true; file: string; receipt_id: string; verdict: string; state_file: string }
  | { ok: false; exit: 1 | 2; verdict: string; reason: string; state_file: string };

/**
 * Hand the batch to the principal as a text file (the questions plus how to answer). The text is written to a state file first
 * (the batch dir), Proof runs on it (destination handoff), and only a pass is copied to the delivery dir and recorded in the output
 * ledger with the receipt_id. A Proof fail returns exit 1 and an unavailable verdict exit 2; in both nothing is delivered and nothing
 * is recorded. The file carries only the question text, never an artifact body.
 */
export async function deliverBatch(b: Batch, opts: { dir?: string; now?: Date; ledgerDir?: string; proof?: ProofFn; stateDir?: string } = {}): Promise<DeliverResult> {
  invariant(BATCH_ID.test(b.id), `invalid batch id: ${b.id}`);
  const stateDir = opts.stateDir ?? batchDir();
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, `label-batch-${b.id}.txt`);
  writeFileSync(stateFile, formatQuestions(b) + "\n", { mode: 0o600 });
  const out = await (opts.proof ?? runProofOnFile)(stateFile);
  // Delivery needs BOTH a zero exit and an affirmative verdict: an exit 0 carrying "unavailable", "fail" or an
  // unknown verdict is refused as unmeasured.
  if (out.exit !== 0 || !DELIVERABLE_VERDICTS.has(out.verdict)) {
    const exit = out.exit === 1 || out.verdict === "fail" ? 1 : 2;
    return { ok: false, exit, verdict: out.verdict, reason: `Proof ${exit === 1 ? "failed" : "could not measure"} the batch text (${out.verdict})${out.detail ? `: ${out.detail}` : ""}; nothing delivered`, state_file: stateFile };
  }
  invariant(out.receipt_id !== null && out.receipt_id.length > 0, "a passing proof carries a receipt_id");
  const dir = opts.dir ?? deliverDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `label-batch-${b.id}.txt`);
  copyFileSync(stateFile, file);
  chmodSync(file, 0o600);
  const rec = recordOutput({ session_id: "label-batch", workflow: "label-batch", boundary: "handoff", channel: "downloads", kind: "text", target: "path:downloads", artifact: file, receipt_id: out.receipt_id, decision: "allowed", reason: "weekly label batch questions, proofed by Assay before delivery", now: opts.now, dir: opts.ledgerDir });
  invariant(rec.ok, `the delivered batch is recorded in the output ledger: ${rec.ok ? "" : rec.error}`);
  return { ok: true, file, receipt_id: out.receipt_id!, verdict: out.verdict, state_file: stateFile };
}

const ANSWER = /^(\d{1,2})([yns])$/i;
const VERDICT: Record<string, LabelVerdict> = { y: "right", n: "wrong", s: "unsure" };

/** Write one principal label per answer, tied to receipt_id + check_id. Refuses an unknown number or an item already answered, before writing anything. */
export function answerBatch(id: string, answers: string[], opts: { labelPath?: string; by?: string; now?: Date } = {}): Label[] {
  const p = batchPath(id);
  if (!existsSync(p)) throw new UsageError(`no batch ${id}`);
  const batch = JSON.parse(readFileSync(p, "utf8")) as Batch;
  invariant(batch.v === 1 && Array.isArray(batch.items), "batch file is malformed");
  if (answers.length === 0) throw new UsageError("answer needs entries like 1y 2n 3s");
  const parsed = answers.map((a) => {
    const m = ANSWER.exec(a);
    if (!m) throw new UsageError(`bad answer "${a}" (expected <number><y|n|s>)`);
    const item = batch.items.find((i) => i.n === Number(m[1]));
    if (!item) throw new UsageError(`batch ${id} has no question ${m[1]}`);
    if (item.answered) throw new UsageError(`question ${item.n} of ${id} is already answered`);
    return { item, verdict: VERDICT[m[2]!.toLowerCase()]! };
  });
  invariant(new Set(parsed.map((x) => x.item.n)).size === parsed.length, "a question is answered once per call");
  const at = (opts.now ?? new Date()).toISOString();
  const written = parsed.map(({ item, verdict }) => {
    invariant(!item.caller === !item.question, `batch item ${item.n} names caller and question together or neither`);
    const l = addLabel({ source: "principal", kind: "check", receipt_id: item.receipt_id, artifact_sha256: item.artifact_sha256, check_id: item.check_id, ...(item.caller && item.question ? { caller: item.caller, question: item.question } : {}), verdict, by: opts.by ?? "principal", note: `weekly label batch ${id}`, ts: at }, { path: opts.labelPath });
    item.answered = { verdict, at };
    return l;
  });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(batch, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  return written;
}

/** ISO week key, e.g. 2026-W40 (Monday-based, UTC). */
export function isoWeek(ts: string): string {
  const d = new Date(Date.parse(ts));
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7)).padStart(2, "0")}`;
}

export type WeekStat = { week: string; principal: number; proxy: number; total: number };
export function labelStats(opts: { labelPath?: string } = {}): WeekStat[] {
  const by = new Map<string, WeekStat>();
  for (const l of readLabels({ path: opts.labelPath })) {
    if (!Number.isFinite(Date.parse(l.ts))) continue;
    const w = isoWeek(l.ts);
    const s = by.get(w) ?? { week: w, principal: 0, proxy: 0, total: 0 };
    s[l.source]++; s.total++;
    by.set(w, s);
  }
  return [...by.values()].sort((a, b) => a.week.localeCompare(b.week));
}

export async function main(argv: string[], deps: { proof?: ProofFn } = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  const json = rest.includes("--json");
  const args = rest.filter((a) => a !== "--json");
  try {
    switch (cmd) {
      case "next": {
        const ni = args.indexOf("--n");
        const n = ni >= 0 ? Number(args[ni + 1]) : 10;
        if (!Number.isInteger(n) || n < 1 || n > 50) throw new UsageError("--n must be an integer 1-50");
        const deliver = args.includes("--deliver");
        const b = createBatch(n);
        if (!b) { console.log(json ? JSON.stringify(deliver ? { batch: null, delivered: null } : { batch: null }) : "No unlabelled unearned flags in recent receipts."); return 0; }
        const d = deliver ? await deliverBatch(b, { proof: deps.proof }) : null;
        if (d && !d.ok) {
          if (json) console.log(JSON.stringify({ batch: b, delivered: null, verdict: d.verdict, exit: d.exit, reason: d.reason }));
          else console.log(formatQuestions(b));
          console.error(d.reason);
          return d.exit;
        }
        const delivered = d && d.ok ? d : null;
        console.log(json ? JSON.stringify(deliver ? { batch: b, delivered: delivered ? basename(delivered.file) : null, receipt_id: delivered?.receipt_id ?? null } : b) : formatQuestions(b) + (delivered ? `\n\nDelivered to ${tildify(delivered.file)}` : ""));
        return 0;
      }
      case "answer": {
        const [id, ...ans] = args;
        if (!id) throw new UsageError("answer needs <batch-id> and entries like 1y 2n");
        const ls = answerBatch(id, ans);
        console.log(json ? JSON.stringify(ls) : `Wrote ${ls.length} principal label(s) for batch ${id}.`);
        return 0;
      }
      case "stats": {
        const s = labelStats();
        console.log(json ? JSON.stringify(s) : s.length ? ["week      principal  proxy  total", ...s.map((w) => `${w.week}  ${String(w.principal).padStart(9)}  ${String(w.proxy).padStart(5)}  ${String(w.total).padStart(5)}`)].join("\n") : "No labels yet.");
        return 0;
      }
      default:
        console.error("usage: LabelBatch.ts next [--n 10] [--deliver] | answer <batch-id> 1y 2n 3s | stats  (add --json)");
        return 64;
    }
  } catch (e) {
    if (e instanceof UsageError) { console.error(e.message); return 64; }
    throw e;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
