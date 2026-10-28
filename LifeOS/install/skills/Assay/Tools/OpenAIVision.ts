/** OpenAI image judge (Sol), run through codex on the ChatGPT subscription. openAiVisionBody/ResponseOf stay as the Responses payload contract.
 * Payload contract: https://developers.openai.com/api/docs/guides/images-vision
 */
import { extname } from 'node:path';
import { CROSS_VENDOR } from '../../../LIFEOS/TOOLS/models.ts';
import { inferenceDisabledBy, runCodexOnSubscription } from '../../../LIFEOS/TOOLS/Inference.ts';

export interface VisionResponse { text: string; executed_model?: string }

/**
 * Every pixel egress path checks these before credentials, image reads, or network.
 * The identity guard is a filename heuristic (a path containing "headshot"), not face detection: a face photo under
 * another name passes, so identity-bearing images must be kept out of judged suites by their owner.
 */
export function guardVisionRequest(file: string, allowIdentity = false): void {
  if (!allowIdentity && /headshot/i.test(file)) throw new Error('identity guard: identity-bearing image requires explicit clearance (--allow-identity)');
  const disabled = inferenceDisabledBy();
  if (disabled) throw new Error(`inference disabled in this context (LIFEOS_INFERENCE_DISABLED=${disabled}); this probe must be deterministic`);
}

export function openAiVisionBody(prompt: string, bytes: Uint8Array, mime: string) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('unsupported vision image MIME type');
  return {
    model: CROSS_VENDOR.openaiJudge,
    reasoning: { effort: 'low' },
    store: false,
    max_output_tokens: 2048,
    input: [{ role: 'user', content: [
      { type: 'input_text', text: prompt },
      { type: 'input_image', image_url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`, detail: 'high' },
    ] }],
  };
}

export function openAiVisionResponseOf(value: unknown): VisionResponse {
  const j = value as { status?: unknown; error?: unknown; model?: unknown; output?: { type?: string; content?: { type?: string; text?: unknown }[] }[] } | null;
  if (!j || typeof j !== 'object' || j.error || (j.status !== undefined && j.status !== 'completed')) throw new Error('OpenAI vision response incomplete or failed');
  const text = (Array.isArray(j.output) ? j.output : []).filter((x) => x?.type === 'message')
    .flatMap((m) => Array.isArray(m.content) ? m.content : [])
    .filter((c) => c?.type === 'output_text' && typeof c.text === 'string').map((c) => c.text as string).join('\n').trim();
  if (!text) throw new Error('OpenAI vision response returned no text');
  return { text, ...(typeof j.model === 'string' && j.model.trim() ? { executed_model: j.model } : {}) };
}

/**
 * The OpenAI judge seat reads the image through `codex exec -i` on the signed-in codex CLI.
 * The image path stays local to the codex child.
 */
export const OPENAI_VISION_TIMEOUT_MS = 360_000;

export async function openAiVision(file: string, prompt: string, allowIdentity = false, deps: { run?: typeof runCodexOnSubscription } = {}): Promise<VisionResponse> {
  guardVisionRequest(file, allowIdentity);
  const ext = extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('unsupported OpenAI vision image extension');
  // A rubric read over a four-frame sheet runs past three minutes at the judge's reasoning level (2026-10-25: the
  // sharpness and polish judges hit 180 s twice running while a one-line read of the same sheet took 31 s).
  const t0 = Date.now();
  const r = await (deps.run ?? runCodexOnSubscription)(prompt, CROSS_VENDOR.openaiJudge, OPENAI_VISION_TIMEOUT_MS, [file]);
  // Never include provider error bodies: they may echo private request content. A timeout is named, since it carries none.
  if (!r.ok) throw new Error(Date.now() - t0 >= OPENAI_VISION_TIMEOUT_MS - 1000 ? `OpenAI vision (codex) timed out after ${OPENAI_VISION_TIMEOUT_MS / 1000} s` : 'OpenAI vision (codex) failed');
  // codex exec reports no executed model, so none is claimed; callers record the requested model separately.
  return { text: r.output };
}
