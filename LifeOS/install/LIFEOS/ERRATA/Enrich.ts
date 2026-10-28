#!/usr/bin/env bun
/**
 * @version 1.0.0
 * Enrich.ts — fills the judged `enrichment` object on every Errata entry that
 * still has it null, via the cheapest OpenAI lane (Inference.ts). Never the
 * Anthropic subscription (OPERATIONAL_PREFERENCES § Model selection). A malformed
 * model reply leaves the entry null and logs the error to stderr — never a
 * partial write (ISC-8).
 */
import { invariant } from "../TOOLS/Invariant";
import { inference, inferenceDisabledBy, type InferenceOptions, type InferenceResult } from "../TOOLS/Inference";
import { ErrataStore, TENANT_SOURCES } from "./Store";
import { validateEnrichment, ENRICHMENT_VERSION, type Enrichment, type Erratum } from "./Schema";

export interface EnrichOptions {
  /** Injected for tests; defaults to the real Inference.ts call on the OpenAI low lane. */
  infer?: (opts: InferenceOptions) => Promise<InferenceResult>;
  /** Optional cap on how many pending entries to enrich in one pass. Newest entries go first. */
  limit?: number;
  /** Stop starting new entries once this much wall time has passed, so a scheduled run ends inside its own timeout. */
  budgetMs?: number;
  /** Customer/user rows carry tenant data and never go to the general OpenAI key; set true only when the call runs on a tenant-isolated key (ISC-21). */
  tenantKeyOk?: boolean;
  /** Passed straight to Inference.ts; the daily job sets `flex` because nobody is waiting on it. */
  serviceTier?: "flex";
}

export interface EnrichResult {
  attempted: number;
  enriched: number;
  failed: number;
  errors: { id: string; error: string }[];
  /** Tenant rows skipped because no tenant-isolated key was declared. */
  skipped_tenant: number;
  /** Pending entries left for a later pass by the limit or the time budget. */
  remaining: number;
}

const SYSTEM_PROMPT = `You are enriching one entry in the Errata complaint ledger for LifeOS. You will be given one erratum's verbatim complaint and its context: what was requested, what the system was doing, and the response that drew the complaint. Read it carefully and return ONLY a JSON object with exactly these fields, no others:

{
  "how_upset": 0 | 1 | 2 | 3,
  "which_part": string,
  "what_upset": string,
  "reporter_right": true | false | null,
  "reporter_right_reason": string,
  "root_cause_hypothesis": string,
  "class": string,
  "proposed_fix": string,
  "confidence": number
}

Field meanings:
- how_upset: 0 none, 1 displeased, 2 upset, 3 furious. Judge from the words themselves, not any deterministic score you are given.
- which_part: the specific part of the system, response, or workflow the reporter is unhappy about.
- what_upset: one or two plain sentences on what specifically went wrong, from the reporter's point of view.
- reporter_right: was the complaint actually valid given the context you were given? Use null only when you genuinely cannot tell.
- reporter_right_reason: one sentence justifying reporter_right.
- root_cause_hypothesis: your best guess at the underlying cause.
- class: a short, stable, snake_case label for this failure class that would also match other similar entries (e.g. "wrong_file_path", "ignored_instruction", "hallucinated_fact"). Lowercase letters, digits, and underscores only.
- proposed_fix: one concrete, actionable sentence.
- confidence: your confidence in this whole enrichment, 0 to 1.

Return JSON only. No prose, no markdown code fences, no extra keys.`;

function buildUserPrompt(e: Erratum): string {
  return JSON.stringify(
    {
      system: e.system,
      kind: e.kind,
      complaint: e.complaint,
      context: e.context,
      reporter_role: e.reporter.role,
      rating: e.rating,
      frustration: e.frustration,
    },
    null,
    2
  );
}

/** Shapes the model's parsed reply into a candidate Enrichment object. Validated by the caller
 * before it ever touches the ledger — this function never writes and never throws. */
function toEnrichmentCandidate(parsed: unknown, model: string): unknown {
  const p = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  return {
    ts: new Date().toISOString(),
    model,
    enrichment_version: ENRICHMENT_VERSION,
    how_upset: p.how_upset,
    which_part: p.which_part,
    what_upset: p.what_upset,
    reporter_right: p.reporter_right ?? null,
    reporter_right_reason: p.reporter_right_reason,
    root_cause_hypothesis: p.root_cause_hypothesis,
    class: p.class,
    proposed_fix: p.proposed_fix,
    confidence: p.confidence,
  };
}

/**
 * Fills `enrichment` on every entry where it is still null. Throws immediately
 * (before touching the store) when LIFEOS_INFERENCE_DISABLED is set — the same
 * flag Inference.ts itself honors, so this can never race a liveness probe
 * into spending (ISC-9).
 */
export async function enrichPending(store: ErrataStore, opts: EnrichOptions = {}): Promise<EnrichResult> {
  const disabled = inferenceDisabledBy();
  if (disabled) throw new Error(`LIFEOS_INFERENCE_DISABLED=${disabled} — enrich refuses to run in this context`);

  const infer = opts.infer ?? ((o: InferenceOptions) => inference(o));
  let rows = store.list({ enriched: false });
  const result: EnrichResult = { attempted: 0, enriched: 0, failed: 0, errors: [], skipped_tenant: 0, remaining: 0 };
  if (!opts.tenantKeyOk) {
    const before = rows.length;
    rows = rows.filter((e) => !TENANT_SOURCES.has(e.source));
    result.skipped_tenant = before - rows.length;
  }
  // Newest first: today's complaint matters more than a backfilled one from January, and a
  // capped pass that walked oldest-first would never reach it (2026-09-18: 4,994 pending
  // rows made the uncapped daily run hit its 15-minute timeout with nothing enriched).
  rows = [...rows].sort((a, b) => b.ts.localeCompare(a.ts));
  const pending = rows.length;
  if (opts.limit) rows = rows.slice(0, opts.limit);
  const started = Date.now();

  for (const e of rows) {
    if (opts.budgetMs && Date.now() - started >= opts.budgetMs) break;
    result.attempted++;
    const res = await infer({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(e),
      expectJson: true,
      level: "low",
      effort: "low",
      vendor: "openai",
      allowVendorFallback: false,
      ...(opts.serviceTier ? { serviceTier: opts.serviceTier } : {}),
    });

    if (!res.success || res.parsed === undefined) {
      const msg = res.error ?? "no parsed output";
      result.failed++;
      result.errors.push({ id: e.id, error: msg });
      console.error(`[Enrich] ${e.id}: ${msg}`);
      continue;
    }

    const model = res.executedModel ?? `${res.vendor ?? "openai"}:low`;
    const candidate = toEnrichmentCandidate(res.parsed, model);
    const errs = validateEnrichment(candidate);
    if (errs.length > 0) {
      result.failed++;
      result.errors.push({ id: e.id, error: errs.join("; ") });
      console.error(`[Enrich] ${e.id}: malformed model reply: ${errs.join("; ")}`);
      continue;
    }

    invariant(store.get(e.id) !== null, `enrich target not found: ${e.id}`);
    store.patch(e.id, { enrichment: candidate as Enrichment });
    result.enriched++;
  }

  result.remaining = pending - result.attempted;
  return result;
}

if (import.meta.main) {
  const store = new ErrataStore();
  enrichPending(store)
    .then((r) => {
      console.log(JSON.stringify(r));
      process.exit(0);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}
