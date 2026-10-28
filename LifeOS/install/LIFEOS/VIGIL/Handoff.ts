#!/usr/bin/env bun
/**
 * Handoff — the advocate's hands (Vigil F16, STATVS migration design §3 Lane G).
 *
 * A research, prepare or background outcome is handed to Workflows as the event `vigil.<kind>`, with the
 * event id = the answered row id, so a re-run tick cannot start a second run (dispatcher emitEvent is
 * idempotent by id). The tick itself writes nothing else (ISC-440).
 *
 * Before it emits, it loads EVERY enabled definition subscribed to that event and refuses the hand-off
 * unless each one passes all of these (P4, ISC-446):
 *   - no step declares an outbound, money or deploy side effect, and no step calls another workflow
 *     (the check cannot see through it);
 *   - runs_on local, and data_class confidential or restricted, so no step input or output lands in
 *     plaintext artifacts or goes to the cloud as public;
 *   - every agent step is read-only and declares tools, all inside ADVOCATE_TOOLS; every agent and model
 *     step names a lane whose model belongs to a trusted vendor (Anthropic, OpenAI, Google);
 *   - no agent step holds the lethal trifecta. Every advocate agent step holds the untrusted row, so no
 *     step may hold a local-read tool (Read, Grep, Glob) and an outbound tool (WebSearch, WebFetch) together,
 *     and a step holding an outbound tool takes data only from the workflow input: no `needs` and no
 *     `steps.*` reference, so nothing another step read locally can reach it and leave in a URL or a query.
 * A hand-off is also refused when the row carries no decision id (^s[0-9a-f]{24}$, the record row the
 * workflows and recordResult answer to) or when the caller gives no record lookup for the depth check, which
 * then fails closed. A refused hand-off falls back to pulse with `handoff: { refused }`. A row whose ref chain
 * leads back to an advocate run is never handed off again (depth 1). While `advocate_mode` is shadow nothing
 * is emitted: the would-be hand-off is checked and recorded, and the floor's outcome stands.
 *
 * The advocate workflows' last step calls `Handoff.ts result --kind <kind>` with the run's result on
 * stdin. It writes one event (source advocate-<kind>, ref = the decision row, severity at most medium)
 * so the tick reads the result, and one `vigil-log` `recommendation` row per change the run proposes,
 * which Review's `vigil-advocate` producer puts in front of {{PRINCIPAL_NAME}} (ISC-441): no advocate run changes a
 * system, spends money or contacts anyone on its own. A recommendation row carries ids and a SHA-256 of its
 * words only (design §1.3, P10); the change, why and target go to Vigil's local editor-words.jsonl (0600),
 * where the reader joins them back by hash (Decision.wordsByHash).
 *
 *   bun LIFEOS/VIGIL/Handoff.ts check <research|prepare|background>   the subscriber check, as JSON
 *   bun LIFEOS/VIGIL/Handoff.ts result --kind <kind> < result.json     record a run's result (workflow step)
 *
 * 1.1.0: trifecta split (local reads and outbound tools never in one step, and an outbound step takes only the
 * workflow input), decision id required, record lookup required, recommendation words kept local by hash.
 * @version 1.1.0
 */
import { invariant } from "../TOOLS/Invariant";
import { CROSS_VENDOR } from "../TOOLS/models";
import { GATED_EFFECTS, type DefinitionV2 } from "../WORKFLOWS/engine/format";
import { definitionsDir } from "../WORKFLOWS/engine/paths";
import { emitEvent, loadDefinitions } from "../WORKFLOWS/engine/dispatcher";
import { append, writeEvent } from "../STATVS/index";
import { keepWords } from "./Decision";
import type { Outcome } from "./Outcome";

export const HANDOFF_KINDS = ["research", "prepare", "background"] as const;
export type HandoffKind = typeof HANDOFF_KINDS[number];
export const isHandoffKind = (v: unknown): v is HandoffKind => (HANDOFF_KINDS as readonly unknown[]).includes(v);
export const handoffEvent = (kind: HandoffKind): string => `vigil.${kind}`;

/** Tools that read local files. */
export const LOCAL_READ_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
/** Tools that reach outside the machine: whatever is in a query or a URL leaves with it. */
export const OUTBOUND_TOOLS: readonly string[] = ["WebSearch", "WebFetch"];
/** The read-only tools an advocate agent step may hold. Anything else blocks the hand-off. */
export const ADVOCATE_TOOLS: readonly string[] = [...LOCAL_READ_TOOLS, ...OUTBOUND_TOOLS];
/** A decision row id: the record row the hand-off, the workflows and recordResult answer to. */
export const DECISION_ID = /^s[0-9a-f]{24}$/;
/** OPERATIONAL_PREFERENCES § Model selection: trusted vendors for private data, reasoning and audit. */
export const TRUSTED_VENDORS: readonly string[] = ["anthropic", "openai", "google"];
/** The ceiling an advocate result is written at, whatever the run asked for (Q-7, Vigil ISC-447). */
export const ADVOCATE_SEVERITY_MAX = "medium";
const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"] as const;
/** How far up a ref chain the depth check walks before giving up and refusing. */
const MAX_CHAIN = 8;

/** The vendor a lane's model belongs to, read from its id in models.ts; null for an unknown lane or vendor. */
export function laneVendor(lane: string, table: Record<string, string> = CROSS_VENDOR): string | null {
  const model = Object.hasOwn(table, lane) ? table[lane] : undefined;
  if (typeof model !== "string" || !model) return null;
  if (/^(gpt-|o\d)/i.test(model)) return "openai";
  if (/^claude-/i.test(model)) return "anthropic";
  if (/^gemini-/i.test(model)) return "google";
  return null;
}

/** Why one subscriber may not take an advocate hand-off, or null when it may. */
export function subscriberRefusal(def: DefinitionV2, table: Record<string, string> = CROSS_VENDOR): string | null {
  if (def.runs_on !== "local") return `${def.name} runs_on ${def.runs_on}, not local`;
  if (def.data_class !== "confidential" && def.data_class !== "restricted") return `${def.name} is data_class ${def.data_class}, not confidential or restricted`;
  for (const step of Object.values(def.steps)) {
    const where = `${def.name}.${step.id}`;
    const gated = step.side_effects.filter((e) => GATED_EFFECTS.includes(e));
    if (gated.length) return `${where} declares ${gated.join(", ")} side effects`;
    if (step.kind === "workflow") return `${where} calls workflow ${step.workflow}, which the hand-off check cannot see through`;
    // A registered action runs a contract this check cannot read, and its effects are not declared on the step.
    if (step.kind === "action") return `${where} runs action ${step.uses}, whose effects the hand-off check cannot see`;
    // Command steps pass on their declared side effects alone, and the definition parser guarantees those are
    // honest: a command must declare them, and an argv that runs an outbound, money or deploy program must say so.
    if (step.kind !== "agent" && step.kind !== "model") continue;
    const vendor = step.lane ? laneVendor(step.lane, table) : null;
    if (!vendor || !TRUSTED_VENDORS.includes(vendor)) return `${where} lane ${step.lane ?? "(none)"} is not a trusted-vendor lane`;
    if (step.kind !== "agent") continue;
    if (!step.tools || step.tools.length === 0) return `${where} is an agent step with no declared tools`;
    const outside = step.tools.filter((t) => !ADVOCATE_TOOLS.includes(t));
    if (outside.length) return `${where} declares tools outside the advocate allowlist: ${outside.join(", ")}`;
    if (step.sandbox !== "read-only") return `${where} sandbox is ${step.sandbox}, not read-only`;
    const trifecta = trifectaRefusal(step);
    if (trifecta) return `${where} ${trifecta}`;
  }
  return null;
}

/** The ids of other steps whose output a step can see: its `needs` and every `steps.<id>` it references. */
function upstreamOf(step: DefinitionV2["steps"][string]): string[] {
  const refs = JSON.stringify({ with: step.with ?? null, prompt: step.prompt ?? null, when: step.when ?? null }).match(/\bsteps\.([A-Za-z0-9_-]+)/g) ?? [];
  return [...new Set([...step.needs, ...refs.map((r) => r.slice("steps.".length))])];
}

/**
 * The lethal trifecta for one agent step (every advocate agent step already holds the untrusted row): local
 * reads and an outbound tool together, or an outbound tool fed by any other step's output. Null when clean.
 */
export function trifectaRefusal(step: DefinitionV2["steps"][string]): string | null {
  const tools = step.tools ?? [];
  const local = tools.filter((t) => LOCAL_READ_TOOLS.includes(t)), outbound = tools.filter((t) => OUTBOUND_TOOLS.includes(t));
  if (!outbound.length) return null;
  if (local.length) return `holds local reads (${local.join(", ")}) and outbound tools (${outbound.join(", ")}) with the untrusted row: the lethal trifecta`;
  const upstream = upstreamOf(step);
  if (upstream.length) return `holds outbound tools (${outbound.join(", ")}) and takes data from step ${upstream.join(", ")}: an outbound step takes only the workflow input`;
  return null;
}

/** Every enabled definition with an enabled event trigger for this event name. */
export function subscribersOf(event: string, defsDir: string): DefinitionV2[] {
  const out: DefinitionV2[] = [];
  for (const { def } of loadDefinitions(defsDir).values()) {
    if (def.enabled === false) continue;
    if (def.triggers.some((t) => t.type === "event" && t.enabled !== false && t.name === event)) out.push(def);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The P4 check over every subscriber: null when the hand-off may go ahead. */
export function handoffRefusal(kind: HandoffKind, defsDir: string, table: Record<string, string> = CROSS_VENDOR): string | null {
  const subs = subscribersOf(handoffEvent(kind), defsDir);
  if (!subs.length) return `no enabled workflow subscribes to ${handoffEvent(kind)}`;
  for (const def of subs) {
    const why = subscriberRefusal(def, table);
    if (why) return why;
  }
  return null;
}

/** The fields of a read row the depth check needs. */
export type ChainRow = { id: string; source: string; ref: string | null };
const isAdvocateSource = (s: string | null | undefined) => typeof s === "string" && s.startsWith("advocate-");

/**
 * Depth 1: true when this row, or any row up its ref chain, came from an advocate run. A chain longer
 * than MAX_CHAIN, one that loops, or one with a ref the lookup cannot find counts as advocate-derived, so the
 * check fails closed: a link it cannot read could be the advocate run.
 */
export function fromAdvocate(row: ChainRow, lookup: (id: string) => ChainRow | null): boolean {
  const seen = new Set<string>();
  let cur: ChainRow | null = row;
  for (let i = 0; cur && i <= MAX_CHAIN; i++) {
    if (isAdvocateSource(cur.source)) return true;
    if (!cur.ref) return false;
    if (seen.has(cur.id)) return true;
    seen.add(cur.id);
    const next = lookup(cur.ref);
    if (!next) return true; // a ref that resolves to no row: the chain cannot be shown clean
    cur = next;
  }
  return true; // walked MAX_CHAIN rows without reaching the end of the chain
}

export type HandoffRecord =
  | { event: string; id: string; emitted: boolean; shadow?: true }
  | { refused: string };
export type HandoffResult = { outcome: Outcome; handoff: HandoffRecord };

export interface HandoffDeps {
  mode: "shadow" | "enforce";
  defsDir?: string;
  /** Looks a record row up by id, for the depth check (STATVS rowById). Required: without it the hand-off is refused. */
  lookup: (id: string) => ChainRow | null;
  /** The Workflows event door; defaults to dispatcher emitEvent with the id. */
  emit?: (name: string, input: unknown, id: string) => string;
  table?: Record<string, string>;
}

/**
 * Hands one advocate outcome off. `row` is the answered row; `floor` is the outcome the floor gave it.
 * Shadow: never emits, the floor's outcome stands, and the record says what would have happened.
 * Enforce: emits `vigil.<kind>` with id = row id and returns the advocate's outcome, or falls back to pulse.
 */
export function handOff(kind: HandoffKind, row: ChainRow & { decision: string }, input: Record<string, unknown>, floor: Outcome, deps: HandoffDeps): HandoffResult {
  invariant(isHandoffKind(kind), `hand-off kind must be research, prepare or background: ${String(kind)}`);
  invariant(typeof row?.id === "string" && row.id.length > 0, "a hand-off names the row it answers");
  const event = handoffEvent(kind);
  // Fail closed, in this order: no decision id, no lookup, an advocate-derived row, then the subscriber check.
  const refused = typeof row.decision !== "string" || !DECISION_ID.test(row.decision)
    ? "the hand-off names no decision row id (^s[0-9a-f]{24}$): write the decision row first"
    : typeof deps.lookup !== "function"
      ? "no record lookup for the depth check, so it cannot see whether the row came from an advocate run"
      : fromAdvocate(row, deps.lookup)
        ? "the row comes from an advocate run (depth 1)"
        : handoffRefusal(kind, deps.defsDir ?? definitionsDir(), deps.table);
  if (deps.mode !== "enforce") return { outcome: floor, handoff: refused ? { refused } : { event, id: row.id, emitted: false, shadow: true } };
  if (refused) return { outcome: "pulse", handoff: { refused } };
  const emit = deps.emit ?? ((name: string, body: unknown, id: string) => emitEvent(name, body, id));
  const id = emit(event, { ...input, answers: row.id, decision: row.decision }, row.id);
  invariant(id === row.id, "the hand-off event id is the answered row id");
  return { outcome: kind, handoff: { event, id, emitted: true } };
}

// ── The advocate run's result, back into STATVS ─────────────────────────────

export type AdvocateRecommendation = { change: string; why: string; target?: string };
export type AdvocateResult = {
  decision: string;
  answers?: string;
  title: string;
  summary: string;
  severity?: string;
  recommendations?: AdvocateRecommendation[];
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A requested severity held at or below the advocate ceiling; anything unknown is low. */
export function cappedSeverity(s: unknown): typeof SEVERITY_ORDER[number] {
  const i = SEVERITY_ORDER.indexOf(s as typeof SEVERITY_ORDER[number]);
  const cap = SEVERITY_ORDER.indexOf(ADVOCATE_SEVERITY_MAX);
  return SEVERITY_ORDER[i < 0 ? 1 : Math.min(i, cap)]!;
}

/**
 * Writes an advocate run's result: one event the tick reads (source advocate-<kind>, ref = decision) and one
 * vigil-log recommendation row per proposed change. Nothing here acts; Review puts each change to {{PRINCIPAL_NAME}}.
 */
export function recordResult(kind: HandoffKind, r: AdvocateResult): { event_id: string; ok: boolean; refused?: string; recommendations: number } {
  invariant(isHandoffKind(kind), `result kind must be research, prepare or background: ${String(kind)}`);
  invariant(typeof r?.decision === "string" && DECISION_ID.test(r.decision), "an advocate result names the decision row it answers");
  invariant(typeof r.title === "string" && r.title.trim().length > 0 && typeof r.summary === "string", "an advocate result has a title and a summary");
  const recs = Array.isArray(r.recommendations) ? r.recommendations : [];
  invariant(recs.every((x) => typeof x?.change === "string" && x.change.trim() && typeof x.why === "string"), "every recommendation has a change and a why");
  const source = `advocate-${kind}`;
  const severity = cappedSeverity(r.severity);
  invariant(SEVERITY_ORDER.indexOf(severity) <= SEVERITY_ORDER.indexOf(ADVOCATE_SEVERITY_MAX), "an advocate result is never above medium");
  const w = writeEvent({
    source, kind: "other", severity, ts: new Date().toISOString(),
    title: clip(r.title.trim(), 140), summary: clip(r.summary, 1000), ref: r.decision,
    privacy_class: "personal", dedup_key: `${source}:${r.decision}`,
    meta: { decision: r.decision, ...(r.answers ? { answers: r.answers } : {}), recommendations: recs.length },
  });
  let written = 0;
  for (const rec of recs) {
    // P10: the row holds ids and a hash; the words stay local beside it, keyed by the result event (else the decision).
    const words_sha256 = keepWords(w.event_id || r.decision, { change: rec.change, why: rec.why, ...(rec.target ? { target: rec.target } : {}) });
    const data = { decision: r.decision, advocate: kind, event_id: w.event_id, words_sha256 };
    invariant(/^[0-9a-f]{64}$/.test(words_sha256) && Object.keys(data).join() === "decision,advocate,event_id,words_sha256", "a recommendation row carries ids and a hash, never its words");
    const res = append({ writer: "tool:vigil", stream: "vigil-log", kind: "recommendation", ref: r.decision, title: "Advocate recommendation", data });
    if (res.ok) written++;
  }
  return { event_id: w.event_id, ok: w.ok, ...(w.ok ? {} : { refused: (w as { refused: string }).refused }), recommendations: written };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === "check") {
    const kind = rest[0];
    if (!isHandoffKind(kind)) { console.error("usage: Handoff.ts check <research|prepare|background>"); return 2; }
    const why = handoffRefusal(kind, definitionsDir());
    console.log(JSON.stringify({ event: handoffEvent(kind), ok: why === null, ...(why ? { refused: why } : {}), subscribers: subscribersOf(handoffEvent(kind), definitionsDir()).map((d) => d.name) }));
    return why === null ? 0 : 1;
  }
  if (cmd === "result") {
    const kind = flag("--kind");
    if (!isHandoffKind(kind)) { console.error("usage: Handoff.ts result --kind <research|prepare|background> < result.json"); return 2; }
    const raw = JSON.parse(await new Response(Bun.stdin.stream()).text()) as { decision?: string; result?: AdvocateResult } & AdvocateResult;
    // A workflow command step gets its `with` map on stdin: { decision, answers, result: {...} }.
    const body: AdvocateResult = raw.result ? { ...raw.result, decision: raw.decision ?? raw.result.decision, answers: raw.answers ?? raw.result.answers } : raw;
    const out = recordResult(kind, body);
    console.log(JSON.stringify(out));
    return out.ok ? 0 : 1;
  }
  console.error("usage: Handoff.ts check <kind> | result --kind <kind> < result.json");
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
