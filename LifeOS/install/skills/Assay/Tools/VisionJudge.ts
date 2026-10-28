#!/usr/bin/env bun
/**
 * VisionJudge — model-graded image assertions (anchored rubric + pairwise).
 *
 * Rubric, describer and ladder judges are OpenAI and Anthropic; the pairwise judge is Gemini only, so it needs --public
 * (a private pair is refused, never sent to Google). A suite with no entry in USER/CONFIG/vision-judge.json is judged by
 * both as a panel (a case passes only when both pass); Google (Gemini) is reachable only through an
 * explicit public-material opt-in (install policy and its provenance: USER/CUSTOMIZATIONS/SKILLS/Assay/
 * PREFERENCES.md § Judge providers). The Anthropic seat is Assay's anthropicVision (skills/Assay/Tools/AnthropicVision.ts, Inference.ts imagePaths),
 * reused here, never duplicated. Reason-then-score, forced JSON verdict, UNKNOWN→miss.
 *
 * IDENTITY GUARD: grading is a different purpose than PII scanning, so images
 * that carry the principal's likeness are NOT sent by default. Paths matching
 * /headshot/i are refused without --allow-identity; suite authors must not
 * point this at identity-bearing images unless the install's PREFERENCES.md
 * § Judge providers clears it. Deterministic ImageAsserts (local, no
 * egress) remain available for everything.
 *
 *   bun VisionJudge.ts rubric --image <f> --rubric "..." [--anchors '{"1":"...","5":"..."}'] [--trials 2]
 *   bun VisionJudge.ts pairwise --a <f> --b <f> --question "..." --public [--out <json>]   # Gemini: public images only
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { CROSS_VENDOR } from '../../../LIFEOS/TOOLS/models';
import type { Assertion, AssertResult } from './Assertions.ts';
import { VISION_RUBRIC_SYSTEM, anchorBlock, referenceBlock } from '../../../LIFEOS/TOOLS/lib/JudgePrompts.ts';
import { judgeAssertion, extractJson, type JudgeOptions } from './Judge.ts';
import { inferenceDisabledBy } from '../../../LIFEOS/TOOLS/Inference.ts';
import { resolveVisionJudge, type VisionRubricConfig } from '../../../LIFEOS/TOOLS/lib/VisionJudgeConfig.ts';
import { guardVisionRequest, openAiVision, type VisionResponse } from './OpenAIVision.ts';
import { gemini, imgPart, judgeImage } from '../../../LIFEOS/ASSAY/JudgeCall.ts';
import { assertEvaluatorVendor, type MaterialClass } from '../../../LIFEOS/TOOLS/lib/EvaluatorEgress.ts';
import { anthropicVision, anthropicJudgeModel } from './AnthropicVision.ts';

export type VisionProvider = 'google' | 'openai' | 'anthropic';
type PanelVendor = 'openai' | 'anthropic';
export const PANEL_VENDORS: readonly PanelVendor[] = ['openai', 'anthropic'];

/** The Anthropic vision seat: Assay's anthropicVision (AnthropicVision.ts), the one Inference.ts image path. Exported so the seat is testable. */
export function anthropicVisionSeat(file: string, prompt: string, allowIdentity: boolean, deps: Parameters<typeof anthropicVision>[3] = {}): Promise<VisionResponse> {
  return anthropicVision(file, prompt, allowIdentity, deps);
}

function requestedModel(provider: VisionProvider): string {
  return provider === 'openai' ? CROSS_VENDOR.openaiJudge : provider === 'anthropic' ? anthropicJudgeModel() : CROSS_VENDOR.gemini;
}

export { gemini, geminiBody, visionResponseOf, mime, imgPart } from '../../../LIFEOS/ASSAY/JudgeCall.ts';

/** The prompt a vision-rubric assert sends (system + rubric + anchors + reference). Pure, exported so the mechanics are testable without Gemini. */
export function buildVisionRubricPrompt(rubric: string, anchors?: Record<string, string>, reference?: string, threshold = 0.6): string {
  const minimum = Math.ceil(1 + 4 * threshold);
  return `${VISION_RUBRIC_SYSTEM}\n\n## RUBRIC\n${rubric}${anchorBlock(anchors)}${referenceBlock(reference)}\n\n## PASS CONTRACT\nThe normalized score is (score - 1) / 4. Passing requires a score of at least ${minimum}/5 (normalized threshold ${threshold}) and satisfaction of the rubric. Use the written anchors directly: clear evidence matching a level earns that level. Choosing the lower level applies only to genuine ambiguity between adjacent anchors; it does not authorize score compression toward the midpoint. A lower score needs a concrete shortfall under the actual rubric, not an additional unstated requirement. Set pass false below the threshold or when the evidence is UNKNOWN. State any shortfall in the reason.`;
}

/** A malformed vision response is evaluator-unavailable, never a zero-quality score. */
export function parseVisionRubricVerdict(text: string): { score: number; passed: boolean; reason: string } | null {
  const j = extractJson(text);
  if (!j || typeof j.score !== 'number' || !Number.isInteger(j.score) || j.score < 1 || j.score > 5 || typeof j.pass !== 'boolean' || typeof j.reason !== 'string') return null;
  return { score: j.score, passed: j.pass, reason: String(j.reason ?? '') };
}

export async function judgeImageRubric(file: string, rubric: string, anchors?: Record<string, string>, opts: { weight?: number; threshold?: number; allowIdentity?: boolean; reference?: string; suite?: string; publicMaterial?: boolean } = {}, deps: {
  config?: VisionRubricConfig;
  request?: (provider: VisionProvider, file: string, prompt: string, allowIdentity: boolean) => Promise<VisionResponse>;
} = {}): Promise<AssertResult> {
  const weight = opts.weight ?? 1;
  const threshold = opts.threshold ?? 0.6;
  try {
    guardVisionRequest(file, opts.allowIdentity ?? false);
    const config = deps.config ?? resolveVisionJudge(opts.suite);
    // Google on private material is refused here, before any request, whatever the config says.
    if (config.provider === 'google') assertEvaluatorVendor('google', 'VisionJudge.rubric', opts.publicMaterial ? 'public' : 'private');
    const prompt = buildVisionRubricPrompt(rubric, anchors, opts.reference, opts.threshold);
    const request = deps.request ?? ((provider: VisionProvider, file: string, prompt: string, allowIdentity: boolean) => judgeImage(provider, file, prompt, allowIdentity, { publicMaterial: opts.publicMaterial, caller: 'VisionJudge.rubric' }));
    const attempt = async (provider: VisionProvider) => {
      // An unparseable reply is intermittent (2026-10-10: one OpenAI reply stopped a calibration run; the same
      // prompt parsed on every re-ask), so it is re-asked once, and a second miss names what came back.
      let response = await request(provider, file, prompt, opts.allowIdentity ?? false);
      let verdict = parseVisionRubricVerdict(response.text);
      if (!verdict) { response = await request(provider, file, prompt, opts.allowIdentity ?? false); verdict = parseVisionRubricVerdict(response.text); }
      if (!verdict) throw new Error(`${provider} judge returned unparseable verdict twice (last reply ${response.text.length} chars: ${JSON.stringify(response.text.slice(0, 120))})`);
      const unknown = /^unknown:/i.test(verdict.reason.trim());
      const score = unknown ? 0 : Math.max(0, Math.min(1, (verdict.score - 1) / 4));
      return { verdict, unknown, score, passed: !unknown && verdict.passed && score >= threshold,
        judge: { provider, requested_model: requestedModel(provider), ...(response.executed_model ? { executed_model: response.executed_model } : {}) } };
    };
    const describe = (r: Awaited<ReturnType<typeof attempt>>) => `${r.verdict.reason || 'No reason supplied'} [score ${r.verdict.score}/5; model pass ${r.verdict.passed}; threshold ${threshold}]`;

    if (config.provider === 'panel') {
      // Both vendors judge the same prompt and pixels. Either one unavailable is no verdict: a one-vendor pass is never a panel pass.
      const settled = await Promise.allSettled(PANEL_VENDORS.map((v) => attempt(v)));
      const failed = settled.flatMap((r, i) => r.status === 'rejected' ? [`${PANEL_VENDORS[i]}: ${(r.reason as Error)?.message ?? String(r.reason)}`] : []);
      if (failed.length) return { type: 'vision-rubric', passed: false, score: 0, reason: `judge error: panel incomplete (${failed.join('; ')})`, weight, unavailable: true };
      const seats = settled.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof attempt>>>).value);
      const panel = seats.map((r) => ({ ...(r.judge as { provider: PanelVendor; requested_model: string; executed_model?: string }), score: r.score, passed: r.passed, reason: r.verdict.reason }));
      return { type: 'vision-rubric', passed: seats.every((r) => r.passed), score: Math.min(...seats.map((r) => r.score)),
        reason: seats.map((r) => `${r.judge.provider}: ${describe(r)}`).join(' | '), weight,
        judge: { provider: 'panel', requested_model: seats.map((r) => r.judge.requested_model).join('+'), panel } };
    }

    let result: Awaited<ReturnType<typeof attempt>>;
    let fallback = false;
    try { result = await attempt(config.provider); }
    catch (error) {
      if (config.provider !== 'openai' || config.fallback !== 'google') throw error;
      // Google is a fallback only for public material; a private image never falls through to it (ISC-35).
      if (!opts.publicMaterial) throw error;
      // Fallback repairs unavailability only. A valid low score never reaches this branch.
      result = await attempt('google');
      fallback = true;
    }
    return { type: 'vision-rubric', passed: result.passed, score: result.score, reason: describe(result), weight,
      judge: { ...result.judge, ...(fallback ? { fallback_from: 'openai' as const } : {}) } };
  } catch (e) {
    return { type: 'vision-rubric', passed: false, score: 0, reason: `judge error: ${(e as Error).message}`, weight, unavailable: true };
  }
}

// ── The meaning ladder (eval re-evaluation ISA F5) ─────────────
// Stage 2, the blind describer, sees the IMAGE and nothing else. Stage 3, the
// ladder judge, sees the DESCRIPTION and the argument summary and never the
// image. If the argument is not in the pixels it cannot be in the description,
// and a judge that never sees the article cannot match on its vocabulary.

/** What the blind describer is told. Image only: no article, no thesis brief, no title (ISC-29). */
export const BLIND_DESCRIBER_PROMPT = 'Describe this image for someone who cannot see it. Say what is literally there (objects, figures, any text, composition, palette, mood), then say in one or two sentences what you think it is ABOUT: what idea or argument a stranger would take from it. You have no other context; describe only what is in front of you. Plain prose, under 200 words.';

/** The describer's request parts: the fixed instruction and the image. Nothing else is ever appended. */
export function blindDescriberParts(file: string): unknown[] {
  return [{ text: BLIND_DESCRIBER_PROMPT }, imgPart(file)];
}

/** Private material is described by OpenAI vision; Gemini describes only on the explicit public-material flag. */
export async function describeImageBlind(file: string, allowIdentity = false, publicMaterial = false, fetchImpl?: typeof fetch,
  privateDescriber: (file: string, prompt: string, allowIdentity: boolean) => Promise<VisionResponse> = (f, pr, id) => judgeImage('openai', f, pr, id, { caller: 'VisionJudge.describe' })): Promise<string> {
  guardVisionRequest(file, allowIdentity);
  const out = (publicMaterial
    ? await gemini(blindDescriberParts(file), undefined, { publicMaterial, fetch: fetchImpl, caller: 'VisionJudge.describe' })
    : (await privateDescriber(file, BLIND_DESCRIBER_PROMPT, allowIdentity)).text).trim();
  if (!out) throw new Error('blind describer returned nothing');
  return out;
}

/** The four rungs. Rung 4 is what euphoric surprise means for a header image. */
export const MEANING_LADDER_ANCHORS: Record<string, string> = {
  '1': 'unrelated: the description could be of a header for any article; nothing in it points at this topic',
  '2': 'topic only: a stranger would name the general subject but not what the article claims about it',
  '3': 'argument: the description recovers the direction of the argument, what the article says is happening or should happen',
  '4': "specific claim: the description recovers the article's specific claim from the reference in the stranger's own words; the euphoric surprise rung, the image that makes a reader feel the essay before reading it",
};
export const MEANING_LADDER_QUESTION = "How much of the article's argument does this description of the image recover? Quote the description's deciding phrases first; when torn between two rungs, choose the lower.";
/** A title is one phrase; a reference shorter than this is a title, not an argument summary (ISC-37). */
export const LADDER_REFERENCE_MIN_WORDS = 15;

/** The ladder as a text-judge assert over the description. Refuses a title-length reference. Pure. */
export function meaningLadderAssert(reference: string, opts: { anchors?: Record<string, string>; threshold?: number; weight?: number; derived_from?: string; value?: string } = {}): Assertion {
  const words = reference.trim().split(/\s+/).filter(Boolean).length;
  if (words < LADDER_REFERENCE_MIN_WORDS) {
    throw new Error(`meaning ladder reference must be the article's argument summary (≥ ${LADDER_REFERENCE_MIN_WORDS} words), never the title alone: got ${words} word(s)`);
  }
  const anchors = opts.anchors ?? MEANING_LADDER_ANCHORS;
  return {
    type: 'llm-rubric',
    value: opts.value ?? MEANING_LADDER_QUESTION,
    anchors,
    scale: Object.keys(anchors).length,
    reference: reference.trim(),
    threshold: opts.threshold ?? 0.6,
    weight: opts.weight ?? 1,
    ...(opts.derived_from ? { derived_from: opts.derived_from } : {}),
  };
}

/** Stages 2 and 3 on one file: describe blind, then grade the description on the ladder. The result type is `meaning-ladder`; the reason carries the description's head so a disagreement can be mined. */
export async function judgeMeaningLadder(file: string, assert: Assertion, opts: JudgeOptions & { allowIdentity?: boolean; publicMaterial?: boolean; describe?: (f: string, allow: boolean, publicMaterial?: boolean) => Promise<string>; judge?: typeof judgeAssertion } = {}): Promise<AssertResult & { description?: string }> {
  const weight = assert.weight ?? 1;
  try {
    const description = await (opts.describe ?? describeImageBlind)(file, opts.allowIdentity ?? false, opts.publicMaterial ?? false);
    const r = await (opts.judge ?? judgeAssertion)(description, assert, { level: opts.level ?? 'high', timeout: opts.timeout });
    return { ...r, type: 'meaning-ladder', reason: `${r.reason} · blind description: "${description.slice(0, 160)}${description.length > 160 ? '…' : ''}"`, description };
  } catch (e) {
    return { type: 'meaning-ladder', passed: false, score: 0, reason: `ladder error: ${(e as Error).message}`, weight, unavailable: true };
  }
}

export async function judgeImagePairwise(a: string, b: string, question: string, allowIdentity = false, publicMaterial = false, fetchImpl?: typeof fetch): Promise<{ winner: 'A' | 'B' | 'tie'; reason: string; executed_model?: string }> {
  guardVisionRequest(a, allowIdentity);
  guardVisionRequest(b, allowIdentity);
  const prompt = `You are comparing two images, IMAGE A (first) and IMAGE B (second).\nQUESTION: ${question}\nFirst reason briefly about each, then output exactly one JSON object: {"winner": "A"|"B"|"tie", "reason": "<one sentence>"}`;
  const observed: { executed_model?: string } = {};
  const out = await gemini([{ text: prompt }, imgPart(a), imgPart(b)], observed, { publicMaterial, fetch: fetchImpl, caller: 'VisionJudge.pairwise' });
  const j = extractJson(out) as { winner?: string; reason?: string } | null;
  const w = typeof j?.winner === 'string' ? j.winner.toUpperCase() : '';
  if ((w !== 'A' && w !== 'B' && w !== 'TIE') || typeof j?.reason !== 'string' || !j.reason.trim()) throw new Error('pairwise judge returned unparseable verdict');
  return { winner: w === 'A' ? 'A' : w === 'B' ? 'B' : 'tie', reason: String(j.reason ?? 'no reason supplied'), ...observed };
}

if (import.meta.main) {
  const [cmd] = Bun.argv.slice(2);
  const { values } = parseArgs({
    args: Bun.argv.slice(3),
    options: {
      image: { type: 'string' }, rubric: { type: 'string' }, anchors: { type: 'string' },
      a: { type: 'string' }, b: { type: 'string' }, question: { type: 'string' },
      out: { type: 'string' }, 'allow-identity': { type: 'boolean' }, reference: { type: 'string' }, public: { type: 'boolean' },
    },
  });
  if (cmd === 'describe' && values.image) {
    console.log(await describeImageBlind(values.image, values['allow-identity'] ?? false, values.public ?? false));
    process.exit(0);
  }
  if (cmd === 'ladder' && values.image && values.reference) {
    const r = await judgeMeaningLadder(values.image, meaningLadderAssert(values.reference, { anchors: values.anchors ? JSON.parse(values.anchors) : undefined }), { allowIdentity: values['allow-identity'], publicMaterial: values.public });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? 0 : 1);
  }
  if (cmd === 'rubric' && values.image && values.rubric) {
    const r = await judgeImageRubric(values.image, values.rubric, values.anchors ? JSON.parse(values.anchors) : undefined, { allowIdentity: values['allow-identity'], publicMaterial: values.public });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? 0 : 1);
  }
  if (cmd === 'pairwise' && values.a && values.b && values.question) {
    const r = await judgeImagePairwise(values.a, values.b, values.question, values['allow-identity'] ?? false, values.public ?? false);
    if (values.out) writeFileSync(values.out, JSON.stringify({ ...r, a: values.a, b: values.b, question: values.question, ts: new Date().toISOString() }, null, 2));
    console.log(`⚖️  winner: ${r.winner} — ${r.reason}`);
    process.exit(0);
  }
  console.log(`VisionJudge — image rubric, blind describer, meaning ladder, pairwise\n\n  bun VisionJudge.ts rubric --image <f> --rubric "..." [--anchors '{"1":"..","5":".."}']\n  bun VisionJudge.ts describe --image <f>                       # stage 2: image only, no article\n  bun VisionJudge.ts ladder --image <f> --reference "<argument summary>"   # stage 3: four rungs over the blind description\n  bun VisionJudge.ts pairwise --a <f> --b <f> --question "..." --public [--out <json>]   # Gemini: public images only\n\n  Default judge: the OpenAI + Anthropic panel. Gemini (Google) receives only public material, and only with --public.`);
  process.exit(1);
}
