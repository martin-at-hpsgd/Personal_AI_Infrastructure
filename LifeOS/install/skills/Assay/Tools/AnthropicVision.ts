/** Anthropic image judge, run through LIFEOS/TOOLS/Inference.ts image input (the claude CLI on the subscription).
 * Assay owns it beside OpenAIVision.ts; JudgeCall.judgeImage, VisionJudge and ArtDirection Critique all reach it from here.
 */
import { pinnedModelForEffort, type EffortLevel } from '../../../LIFEOS/TOOLS/models.ts';
import { inference, type InferenceOptions, type InferenceResult } from '../../../LIFEOS/TOOLS/Inference.ts';
import { assertEvaluatorVendor } from '../../../LIFEOS/TOOLS/lib/EvaluatorEgress.ts';
import { guardVisionRequest, type VisionResponse } from './OpenAIVision.ts';

/** The Anthropic vision seat: the high rung of models.ts EFFORT_MODEL through Inference.ts, at low reasoning effort to
 * mirror the OpenAI judge seat (OpenAIVision.ts runs its judge at reasoning effort low). */
export const ANTHROPIC_JUDGE_LEVEL: EffortLevel = 'high';
export function anthropicJudgeModel(): string { return pinnedModelForEffort(ANTHROPIC_JUDGE_LEVEL); }
/** Said by the Anthropic judge when the image did not attach, so a blind answer is never scored. */
export const IMAGE_UNAVAILABLE = 'IMAGE_UNAVAILABLE';
/** Spawns allowed for one Anthropic vision answer when the model reports it cannot see the attached image. */
export const IMAGE_UNAVAILABLE_ATTEMPTS = 3;
/** One Anthropic call's own ceiling; callers that bound an attempt add the CLI spawn time on top. */
export const ANTHROPIC_CALL_MS = 170_000;
const ANTHROPIC_VISION_SYSTEM = `You are a vision judge. The image to judge is attached to the user message. Look at it before answering, then answer exactly as the user message asks. If no image is visible to you, reply with exactly ${IMAGE_UNAVAILABLE} and nothing else.`;

/** Test seams: the inference call and its per-call ceiling. */
export interface AnthropicVisionDeps { infer?: (options: InferenceOptions) => Promise<InferenceResult>; timeoutMs?: number }

function isRecord(x: unknown): x is Record<string, unknown> { return typeof x === 'object' && x !== null && !Array.isArray(x); }

/**
 * Anthropic vision through Inference.ts image input. The user prompt is the caller's exact prompt, the same one the
 * OpenAI seat gets, so the two answers are comparable. Never falls back to another vendor: an answer from anyone else is
 * refused, never recorded as Anthropic's.
 */
export async function anthropicVision(file: string, prompt: string, allowIdentity = false, deps: AnthropicVisionDeps = {}): Promise<VisionResponse> {
  assertEvaluatorVendor('anthropic', 'Assay.anthropicVision');
  guardVisionRequest(file, allowIdentity);
  // Inference.ts attaches the image as an inline image block on every call (the old @file mention depended on
  // the model choosing to call Read, and at low effort it sometimes did not: 2026-10-10, ISC-12). A blind reply
  // still gets fresh spawns before it counts as a failure, as a backstop for the Read-path fallback formats.
  for (let attempt = 1; ; attempt++) {
    const result = await (deps.infer ?? inference)({ systemPrompt: ANTHROPIC_VISION_SYSTEM, userPrompt: prompt, level: ANTHROPIC_JUDGE_LEVEL, effort: 'low', vendor: 'anthropic', allowVendorFallback: false, imagePaths: [file], timeout: deps.timeoutMs ?? ANTHROPIC_CALL_MS });
    if (!isRecord(result) || typeof result.success !== 'boolean') throw new Error('Anthropic vision: malformed inference result');
    // Never echo result.output on failure: it may carry private request content.
    if (!result.success) throw new Error(`Anthropic vision: ${result.error ?? 'call failed'}`);
    if (result.vendor !== undefined && result.vendor !== 'anthropic') throw new Error(`Anthropic vision: answered by vendor ${result.vendor}, refused`);
    const text = typeof result.output === 'string' ? result.output.trim() : '';
    if (!text) throw new Error('Anthropic vision returned no text');
    if (text === IMAGE_UNAVAILABLE) {
      if (attempt < IMAGE_UNAVAILABLE_ATTEMPTS) continue;
      throw new Error(`Anthropic vision: the judge could not see the image (${attempt} attempts)`);
    }
    return { text, ...(typeof result.executedModel === 'string' && result.executedModel ? { executed_model: result.executedModel } : {}) };
  }
}
