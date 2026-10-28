/**
 * The quality-loop writers (STATVS ISA F16): one function per record of the quality loop, each appending exactly one
 * row to its own stream through the record's append(). This is step 1 of the five-step migration, dual-write: the old
 * stores (the output ledger, the receipt files, labels.jsonl, the Errata ledger, execution.jsonl) keep writing, and
 * these rows land beside them. Nothing here reads or deletes an old store.
 *
 *   recordOutput   → stream `output`     (owner LIFEOS/TOOLS/lib/OutputLedger.ts)
 *   recordReceipt  → stream `receipt`    (owner LIFEOS/TOOLS/lib/ProofReceipt.ts)    counts and ids, never finding text
 *   recordLabel    → stream `label`      (owner LIFEOS/TOOLS/lib/LabelStore.ts)
 *   recordErratum  → stream `errata`     (owner LIFEOS/ERRATA/Capture.ts)            ids and classes, never the complaint
 *   recordSkillRun → stream `skill-run`  (owner hooks/EventLogger.hook.ts)
 *   recordToolRun  → stream `tool-run`   (owner hooks/EventLogger.hook.ts)
 *   recordRender   → stream `render`     (owner this file)
 *   renderFor      ← the newest `render` row for some bytes
 *
 * `append` is the function LIFEOS/STATVS/index.ts exports; this file sits inside lib/ and takes it from ./record
 * directly, which skips loading the views, backup and drill code a hook never needs.
 *
 * Each stream has its own writer name (`lib:quality-<stream>`), so each keeps its own daily segment and lock: a
 * tool-run row on every tool call never waits behind a receipt, and renderFor opens only the render writer's files.
 * Every row is class `personal`; a caller's session id goes in the envelope's `session`.
 *
 * Digest-valued fields are stored under keys that name them as digests (`receipt_key_sha256`, `key_sha256`,
 * `revision_sha256`), because the record refuses any 40+ hex run under a key that does not say it is a hash. So a
 * receipt's store key, which the contract calls `key` or `receipt_id`, is `key_sha256` / `receipt_key_sha256` in data.
 *
 * Failure contract: no function throws for a bad input or a broken record. An input that breaks the contract is
 * refused with a named reason; the record's own refusals and spools come back as append() returns them. Every
 * refusal and spool is returned AND logged to stderr, so nothing is refused silently. Only an InvariantViolation, an
 * impossible state that only a bug in this file or the engine can raise, escapes (OPERATIONAL_PREFERENCES § Code invariants).
 *
 * @version 1.0.0
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { invariant, InvariantViolation } from "../../TOOLS/Invariant";
import { append, statvsDir, writerSlug } from "./record";
import type { StatvsInput, StatvsRow } from "./types";

// ── Contract ──

export type QualityStream = "output" | "receipt" | "label" | "errata" | "skill-run" | "tool-run" | "render";
export const QUALITY_STREAMS: readonly QualityStream[] = ["output", "receipt", "label", "errata", "skill-run", "tool-run", "render"];
/** The one writer name per stream. Stable: renderFor and every reader of a stream rely on it. */
export const QUALITY_WRITERS: Readonly<Record<QualityStream, string>> = Object.freeze({
  output: "lib:quality-output",
  receipt: "lib:quality-receipt",
  label: "lib:quality-label",
  errata: "lib:quality-errata",
  "skill-run": "lib:quality-skill-run",
  "tool-run": "lib:quality-tool-run",
  render: "lib:quality-render",
});

export type QualityResult =
  | { ok: true; row: StatvsRow }
  | { ok: false; refused: string }
  | { ok: false; spooled: true; reason: string };

export const BOUNDARIES = ["handoff", "send", "publish", "deploy", "isa-close"] as const;
export const OUTPUT_KINDS = ["video", "image", "audio", "text", "page", "doc", "diff", "other"] as const;
export const DECISIONS = ["allowed", "allowed-labelled", "blocked", "overridden"] as const;
export const RECEIPT_VERDICTS = ["pass", "admitted-flagged", "unmeasured", "fail", "unavailable", "reference"] as const;
export const DESTINATIONS = ["handoff", "send", "publish", "deploy", "isa-close", "none"] as const;
export const LABEL_SOURCES = ["principal", "proxy"] as const;
export const LABEL_KINDS = ["check", "artifact", "reaction"] as const;
export const LABEL_VERDICTS = ["right", "wrong", "pass", "fail", "unsure"] as const;
export const ERRATA_KINDS = ["complaint", "bug", "feature-request", "correction", "praise", "question", "incident"] as const;
export const ERRATA_STATUSES = ["new", "enriched", "triaged", "upgrade-filed", "fixed", "wontfix", "duplicate"] as const;
// release-allow: private-skill-names (_VIDEO is the camera-footage pipeline value a render row may carry; an install without the video pipeline skill never writes one)
export const PIPELINES = ["VideoEssay", "HyperFrames", "StoryFilm", "_VIDEO"] as const;

export interface OutputRow {
  output_id: string; sha256?: string; boundary: string; channel: string; kind: string;
  skill?: string; session_id?: string; target?: string; receipt_id?: string; decision: string;
}
export interface ReceiptRecord {
  key: string; sha256: string; verdict: string; evaluators: Record<string, string>;
  destination?: string; ideal_state?: unknown; counts?: Record<string, number>; run_id?: string;
}
export interface LabelRecord {
  id: string; source: string; kind: string; verdict: string; check_id?: string; caller?: string; question?: string;
  artifact_sha256?: string; receipt_id?: string; from_label?: string;
}
export interface ErratumRecord { id: string; kind: string; system: string; status: string; session_id?: string; output_ids?: string[] }
export interface SkillRunRecord { skill: string; intent?: string; session_id?: string; run_id?: string; args_hash?: string }
export interface ToolRunRecord { tool: string; exit_code: number; ms: number; session_id?: string; skill?: string }
export type Pipeline = (typeof PIPELINES)[number];
export interface RenderRecord {
  sha256: string; pipeline: Pipeline; intent?: string; artifact: string; composition?: string; composition_digest?: string;
}
export interface RenderHit { pipeline: Pipeline; intent?: string; artifact: string; composition?: string; composition_digest?: string; ts: string }

// ── Field rules ──

const SHA256 = /^[0-9a-f]{64}$/;
const HEXISH = /^[0-9a-f]{8,128}$/;
/** An id or name: no whitespace or control characters, bounded. Ids like out_<uuid>, run_<uuid>, a uuid, a skill name. */
const ID = /^[^\s\u0000-\u001f]{1,160}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** The output ledger's target rule: a redacted class (email, chat, path:downloads), never an address. */
const TARGET_CLASS = /^[a-z0-9][a-z0-9_.-]{0,31}(:[a-z0-9][a-z0-9_.-]{0,31}){0,2}$/;
/** Paths and free names are capped so a render row never spills into the object store and stays one short line. */
const MAX_TEXT = 4096;

class Refusal extends Error {}
const refuseIf = (bad: unknown, reason: string): void => { if (bad) throw new Refusal(reason); };
const isStr = (v: unknown): v is string => typeof v === "string";
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => isStr(v) && (list as readonly string[]).includes(v);

function need(o: Record<string, unknown>, k: string, re: RegExp, what = "an id"): string {
  const v = o[k];
  refuseIf(!isStr(v) || !re.test(v), `${k} must be ${what}`);
  return v as string;
}
function opt(o: Record<string, unknown>, k: string, re: RegExp, what = "an id"): string | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  refuseIf(!isStr(v) || !re.test(v), `${k} must be ${what} when given`);
  return v as string;
}
function text(o: Record<string, unknown>, k: string, required: boolean): string | undefined {
  const v = o[k];
  if (!required && (v === undefined || v === null)) return undefined;
  refuseIf(!isStr(v) || v.length === 0 || v.length > MAX_TEXT || /[\u0000-\u001f]/.test(v), `${k} must be a non-empty single-line string up to ${MAX_TEXT} characters`);
  return v as string;
}
function enumOf<T extends string>(o: Record<string, unknown>, k: string, list: readonly T[], required = true): T | undefined {
  const v = o[k];
  if (!required && (v === undefined || v === null)) return undefined;
  refuseIf(!oneOf(list, v), `${k} must be one of ${list.join(", ")}`);
  return v as T;
}
/** Drop undefined so a row carries only the fields it has. */
function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
function asObject(v: unknown, what = "input"): Record<string, unknown> {
  refuseIf(!v || typeof v !== "object" || Array.isArray(v), `${what} must be an object`);
  return v as Record<string, unknown>;
}

/** Counts only: a flat map of non-negative finite numbers, no text. */
function countsOf(v: unknown): Record<string, number> | undefined {
  if (v === undefined || v === null) return undefined;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(asObject(v, "counts"))) {
    refuseIf(!TOKEN.test(k), "counts keys must be tokens");
    refuseIf(typeof n !== "number" || !Number.isFinite(n) || n < 0, `counts.${k} must be a non-negative number`);
    out[k] = n as number;
  }
  return out;
}

/** Evaluator name → version, at least one, both short ids. */
function evaluatorsOf(v: unknown): Record<string, string> {
  const entries = Object.entries(asObject(v, "evaluators"));
  refuseIf(entries.length === 0, "evaluators must name at least one evaluator");
  const out: Record<string, string> = {};
  for (const [k, ver] of entries) {
    refuseIf(!ID.test(k) || k.length > 64, "evaluators keys must be short names");
    refuseIf(!isStr(ver) || !ID.test(ver), `evaluators.${k} must be a version id`);
    out[k] = ver as string;
  }
  return out;
}

/**
 * The receipt's ideal_state reduced to ids: its kind, the ISA or intent path, the revision digest, the ask digest, the
 * intent's skill and name, and the criteria ids. The `none` reason is free text and is left out.
 */
function idealStateOf(v: unknown): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  const o = asObject(v, "ideal_state");
  const kind = enumOf(o, "kind", ["isa", "ask", "none"] as const)!;
  const out: Record<string, unknown> = { kind };
  if (kind === "isa") {
    out.path = text(o, "path", true);
    out.revision_sha256 = need(o, "revision", SHA256, "a sha256");
    out.source = opt(o, "source", TOKEN, "a token");
    out.skill = opt(o, "skill", ID);
    out.intent = opt(o, "intent", ID);
    if (o.criteria !== undefined && o.criteria !== null) {
      refuseIf(!Array.isArray(o.criteria) || !(o.criteria as unknown[]).every((c) => isStr(c) && ID.test(c) && c.length <= 32), "ideal_state.criteria must be criterion ids");
      out.criteria = [...(o.criteria as string[])];
    }
  } else if (kind === "ask") {
    out.sha256 = need(o, "sha256", SHA256, "a sha256");
  }
  return compact(out);
}

// ── The one write path ──

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function log(stream: QualityStream, what: string): void {
  try { process.stderr.write(`statvs quality ${stream}: ${what}\n`); } catch { /* stderr closed: the return value still says it */ }
}

/**
 * Build the row with `build` and append it. A Refusal from `build` and any refusal or spool from append() come back
 * as the result and are logged; any other operational error is a refusal too. Only an InvariantViolation escapes.
 */
function write(stream: QualityStream, idKey: string, build: () => { data: Record<string, unknown>; session?: string }): QualityResult {
  let input: StatvsInput;
  try {
    const { data, session } = build();
    input = { writer: QUALITY_WRITERS[stream], stream, class: "personal", data: compact(data) };
    if (session !== undefined) input.session = session;
  } catch (e) {
    if (e instanceof InvariantViolation) throw e;
    const refused = `refused: ${message(e)}`;
    log(stream, refused);
    return { ok: false, refused };
  }
  // Built by this file alone: a wrong stream, writer, class or a missing identity field is a bug here, never an input.
  invariant(QUALITY_STREAMS.includes(input.stream as QualityStream) && input.writer === QUALITY_WRITERS[stream], `quality row must go to its own stream under its own writer (${stream})`);
  invariant(input.class === "personal", "every quality row is personal");
  invariant(isStr((input.data as Record<string, unknown>)[idKey]), `a ${stream} row carries its ${idKey}`);
  try {
    const r = append(input);
    if (r.ok) return r;
    if ("spooled" in r) { log(stream, `spooled: ${r.reason}`); return r; }
    log(stream, `refused by the record: ${r.refused}`);
    return r;
  } catch (e) {
    if (e instanceof InvariantViolation) throw e;
    const refused = `append failed: ${message(e)}`;
    log(stream, refused);
    return { ok: false, refused };
  }
}

// ── Writers ──

/** One output that crossed a boundary. Dual-writes the output ledger line. */
export function recordOutput(line: OutputRow): QualityResult {
  return write("output", "output_id", () => {
    const o = asObject(line);
    return {
      session: opt(o, "session_id", ID),
      data: {
        output_id: need(o, "output_id", ID),
        sha256: opt(o, "sha256", SHA256, "a sha256"),
        boundary: enumOf(o, "boundary", BOUNDARIES),
        channel: need(o, "channel", TOKEN, "a channel token"),
        kind: enumOf(o, "kind", OUTPUT_KINDS),
        skill: opt(o, "skill", ID),
        target: opt(o, "target", TARGET_CLASS, "a redacted target class, never an address"),
        receipt_key_sha256: opt(o, "receipt_id", SHA256, "a receipt key (sha256)"),
        decision: enumOf(o, "decision", DECISIONS),
      },
    };
  });
}

/** One Assay boundary run's receipt: the verdict, counts and ids, never a finding's text. */
export function recordReceipt(r: ReceiptRecord): QualityResult {
  return write("receipt", "key_sha256", () => {
    const o = asObject(r);
    return {
      data: {
        key_sha256: need(o, "key", SHA256, "a receipt key (sha256)"),
        sha256: need(o, "sha256", SHA256, "a sha256"),
        verdict: enumOf(o, "verdict", RECEIPT_VERDICTS),
        evaluators: evaluatorsOf(o.evaluators),
        destination: enumOf(o, "destination", DESTINATIONS, false),
        ideal_state: idealStateOf(o.ideal_state),
        counts: countsOf(o.counts),
        run_id: opt(o, "run_id", ID),
      },
    };
  });
}

/** One human or proxy verdict. Mirrors LabelStore's shape rules, so a label it takes is not refused here. */
export function recordLabel(l: LabelRecord): QualityResult {
  return write("label", "id", () => {
    const o = asObject(l);
    const kind = enumOf(o, "kind", LABEL_KINDS)!;
    const verdict = enumOf(o, "verdict", LABEL_VERDICTS)!;
    const data = {
      id: need(o, "id", ID),
      source: enumOf(o, "source", LABEL_SOURCES),
      kind,
      verdict,
      check_id: opt(o, "check_id", ID),
      caller: opt(o, "caller", ID),
      question: opt(o, "question", ID),
      artifact_sha256: opt(o, "artifact_sha256", SHA256, "a sha256"),
      receipt_key_sha256: opt(o, "receipt_id", SHA256, "a receipt key (sha256)"),
      from_label: opt(o, "from_label", ID),
    };
    refuseIf((verdict === "right" || verdict === "wrong") && kind !== "check", "right and wrong are verdicts on a check; artifact and reaction labels use pass, fail or unsure");
    refuseIf(kind === "check" && !data.check_id && !(data.caller && data.question), "a check label names a check_id or a caller and question");
    refuseIf(!data.check_id && !data.artifact_sha256 && !data.receipt_key_sha256 && !(data.caller && data.question), "a label names a receipt, an artifact, a check, or a caller and question");
    return { data };
  });
}

/** One erratum's ids and classes. The verbatim complaint stays in the Errata ledger and never enters this row. */
export function recordErratum(e: ErratumRecord): QualityResult {
  return write("errata", "id", () => {
    const o = asObject(e);
    let output_ids: string[] | undefined;
    if (o.output_ids !== undefined && o.output_ids !== null) {
      refuseIf(!Array.isArray(o.output_ids) || !(o.output_ids as unknown[]).every((x) => isStr(x) && ID.test(x)), "output_ids must be a list of output ids");
      refuseIf((o.output_ids as unknown[]).length > 100, "output_ids holds at most 100 ids");
      output_ids = [...(o.output_ids as string[])];
    }
    return {
      session: opt(o, "session_id", ID),
      data: {
        id: need(o, "id", ID),
        kind: enumOf(o, "kind", ERRATA_KINDS),
        system: need(o, "system", TOKEN, "a system token"),
        status: enumOf(o, "status", ERRATA_STATUSES),
        output_ids,
      },
    };
  });
}

/** One skill or intent invocation. */
export function recordSkillRun(r: SkillRunRecord): QualityResult {
  return write("skill-run", "skill", () => {
    const o = asObject(r);
    return {
      session: opt(o, "session_id", ID),
      data: {
        skill: need(o, "skill", ID, "a skill name"),
        intent: opt(o, "intent", ID, "an intent name"),
        run_id: opt(o, "run_id", ID),
        args_hash: opt(o, "args_hash", HEXISH, "a hex digest"),
      },
    };
  });
}

/** One tool call's outcome: which tool, its exit code and how long it took. */
export function recordToolRun(r: ToolRunRecord): QualityResult {
  return write("tool-run", "tool", () => {
    const o = asObject(r);
    refuseIf(!Number.isInteger(o.exit_code), "exit_code must be an integer");
    refuseIf(typeof o.ms !== "number" || !Number.isFinite(o.ms) || (o.ms as number) < 0, "ms must be a non-negative number");
    return {
      session: opt(o, "session_id", ID),
      data: {
        tool: need(o, "tool", ID, "a tool name"),
        exit_code: o.exit_code as number,
        ms: o.ms as number,
        skill: opt(o, "skill", ID, "a skill name"),
      },
    };
  });
}

/** One rendered artifact: which pipeline made these bytes, from which intent and composition. */
export function recordRender(r: RenderRecord): QualityResult {
  return write("render", "sha256", () => {
    const o = asObject(r);
    return {
      data: {
        sha256: need(o, "sha256", SHA256, "a sha256"),
        pipeline: enumOf(o, "pipeline", PIPELINES),
        intent: opt(o, "intent", ID, "an intent name"),
        artifact: text(o, "artifact", true),
        composition: text(o, "composition", false),
        composition_digest: opt(o, "composition_digest", HEXISH, "a hex digest"),
      },
    };
  });
}

// ── Reader ──

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The newest render row for these bytes, or null. Reads only the render writer's daily segments, newest day first,
 * each from its last line back, and stops at the first match, so a recent render costs one small file and a miss
 * costs one read per day the writer wrote. The render stream has one writer, this file, so no other segment holds
 * its rows. A row still waiting in the spool is not seen until it lands. Never throws.
 */
export function renderFor(sha256: string): RenderHit | null {
  if (!isStr(sha256) || !SHA256.test(sha256)) return null;
  try {
    const base = join(statvsDir(), "personal");
    let days: string[];
    try { days = readdirSync(base).filter((d) => DATE_DIR.test(d)).sort().reverse(); } catch { return null; }
    const file = `${writerSlug(QUALITY_WRITERS.render)}.jsonl`;
    for (const day of days) {
      let body: string;
      try { body = readFileSync(join(base, day, file), "utf8"); } catch { continue; }
      if (!body.includes(sha256)) continue;
      const lines = body.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!line.includes(sha256)) continue;
        let row: StatvsRow;
        try { row = JSON.parse(line) as StatvsRow; } catch { continue; }
        const d = row?.data as Record<string, unknown> | null;
        if (row?.stream !== "render" || !d || d.sha256 !== sha256 || !oneOf(PIPELINES, d.pipeline) || !isStr(d.artifact)) continue;
        return compact({
          pipeline: d.pipeline, intent: isStr(d.intent) ? d.intent : undefined, artifact: d.artifact,
          composition: isStr(d.composition) ? d.composition : undefined,
          composition_digest: isStr(d.composition_digest) ? d.composition_digest : undefined, ts: row.ts,
        }) as RenderHit;
      }
    }
  } catch { /* an unreadable record answers "no render known", never an error */ }
  return null;
}
