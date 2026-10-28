/**
 * EvaluatorEgress — the one assertion behind ISC-35 (ISA 20260930-assay-everywhere): an evaluator call that carries
 * private material goes only to an approved vendor. Approved: Anthropic, OpenAI, Google (principal, 2026-10-10), and
 * Cloudflare (Workers AI on our own account, Assay's Clef-omni engine; principal, 2026-10-10). The set matches
 * RESTRICTED_CAPABLE_VENDORS in hooks/lib/data-classification.ts. Everything else is refused for private material,
 * by name or by omission.
 *
 * Callers (Proof's compile, Review's reviewer dispatch, EvalRunner's subject and judge lanes) call
 * assertEvaluatorVendor(vendor) with the vendor they are about to send to, before dispatch. Assay's engine is fixed to
 * Cloudflare in Engine.ts, so its calls need no choice made here; the helper exists so a vendor picked from
 * config or env can never widen the egress set silently. Never add a vendor to APPROVED_EVALUATOR_VENDORS without
 * the principal's word (OPERATIONAL_PREFERENCES § Model selection: trusted vendors for reasoning and audit).
 */

/** Spelled once. */
export const APPROVED_EVALUATOR_VENDORS = ["anthropic", "openai", "google", "cloudflare"] as const;

export type MaterialClass = "private" | "public";

export class EvaluatorEgressError extends Error {
  constructor(public readonly vendor: string, public readonly caller: string) {
    super(`evaluator egress refused: vendor "${vendor}" is not approved for private material (${caller}); approved: anthropic, openai, google, cloudflare`);
    this.name = "EvaluatorEgressError";
  }
}

/** True when `vendor` may receive private material. Case-insensitive; an empty or non-string vendor is never approved. */
export function isApprovedEvaluatorVendor(vendor: unknown): boolean {
  return typeof vendor === "string" && (APPROVED_EVALUATOR_VENDORS as readonly string[]).includes(vendor.trim().toLowerCase());
}

/**
 * Throws EvaluatorEgressError when private material would go to a vendor outside the approved set. Public material is
 * not restricted here (its own data-class rules live with the lane that sends it). Returns the vendor so a call site can
 * wrap its argument: `vendor: assertEvaluatorVendor(v, "review")`.
 */
export function assertEvaluatorVendor<T extends string>(vendor: T, caller = "evaluator", material: MaterialClass = "private"): T {
  if (material === "public") return vendor;
  if (!isApprovedEvaluatorVendor(vendor)) throw new EvaluatorEgressError(String(vendor), caller);
  return vendor;
}
