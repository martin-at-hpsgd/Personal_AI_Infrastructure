/**
 * JudgeCall — Assay's one judge transport. Every model call a judge makes inside Assay goes through here:
 * text judges (Judge.ts, Panel.ts) through `judgeText`, image judges (VisionJudge.ts) through `judgeImage`.
 * A new vendor or model is added once, here. Vendor comes from the model id, never a lane name, and judge
 * strength is read from the same model registry (AssaySystem.md § One eval system, § Judge strength).
 */
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { getEnvPath } from '../TOOLS/Paths';
import { inference, inferenceDisabledBy, openAiModelForLevel, type InferenceOptions, type InferenceResult } from '../TOOLS/Inference';
import { CROSS_VENDOR, CURRENT, EFFORT_MODEL, STRONGEST, type EffortLevel } from '../TOOLS/models';
import { assertEvaluatorVendor, type MaterialClass } from '../TOOLS/lib/EvaluatorEgress';
import { guardVisionRequest, openAiVision, type VisionResponse } from '../../skills/Assay/Tools/OpenAIVision';
import { anthropicVision } from '../../skills/Assay/Tools/AnthropicVision';

export type JudgeVendor = 'anthropic' | 'openai' | 'google' | 'meta' | 'xai' | string;

/** Vendor of a model id (or a tier alias). Unknown ids are their own vendor, so they never pass as another's. */
export function vendorOf(model: string): JudgeVendor {
  const id = model.toLowerCase();
  if (/^(claude|anthropic|opus|sonnet|haiku|fable)/.test(id)) return 'anthropic';
  if (/^(gpt|o\d|chatgpt|codex|sol\b|astra\b)/.test(id)) return 'openai';
  if (/^gemini|^gemma/.test(id)) return 'google';
  if (/^(muse|llama)/.test(id)) return 'meta';
  if (/^grok/.test(id)) return 'xai';
  return id.match(/^[a-z]+/)?.[0] ?? id;
}

/** A registry name (a Claude tier in CURRENT, or any CROSS_VENDOR key) to its model id; an id passes through. */
export function judgeModelId(name: string): string | undefined {
  return (CURRENT as Record<string, string>)[name] ?? (CROSS_VENDOR as Record<string, string>)[name];
}

// ---- Judge strength -------------------------------------------------------------------------------------

const LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'max'];
/**
 * The capability rung of a model, read from the registry's own level tables: a Claude tier through EFFORT_MODEL,
 * an OpenAI id through the openai<Level> keys, and any vendor's declared strongest model (STRONGEST) as `max`.
 * A model the registry gives no rung (an older Gemini, Muse, Grok) is `null`, unrated, never guessed.
 */
export function levelOfModel(model: string): EffortLevel | null {
  const id = (judgeModelId(model) ?? model).toLowerCase();
  let best: EffortLevel | null = null;
  for (const l of LEVELS) {
    const claude = CURRENT[EFFORT_MODEL[l]]?.toLowerCase();
    let openai = ''; try { openai = openAiModelForLevel(l).toLowerCase(); } catch { /* unset rung */ }
    if (id === claude || id === openai || id === EFFORT_MODEL[l]) best = l;
  }
  if (Object.values(STRONGEST).some((k) => judgeModelId(k)?.toLowerCase() === id)) best = 'max';
  return best;
}

/**
 * The judge-strength rule: a judge is at least as capable as the work it grades. A judge below the strongest
 * rated producer it grades is `below`; either side unrated is `unrated` (stated, never treated as a pass).
 */
export function judgeStrength(judgeModel: string, producerModels: string[]): { status: 'ok' | 'below' | 'unrated'; judge: EffortLevel | null; work: EffortLevel | null } {
  const judge = levelOfModel(judgeModel);
  const rated = producerModels.map(levelOfModel).filter((x): x is EffortLevel => x !== null);
  const work = rated.length ? rated.reduce((a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a)) : null;
  if (!judge || !work) return { status: 'unrated', judge, work };
  return { status: LEVELS.indexOf(judge) >= LEVELS.indexOf(work) ? 'ok' : 'below', judge, work };
}

/** The strongest judge the registry offers for a vendor (models.ts STRONGEST), named by its shortest registry key. */
export function strongestJudge(vendor: 'anthropic' | 'openai' | 'google'): string {
  const id = judgeModelId(STRONGEST[vendor]);
  if (!id) throw new Error(`models.ts STRONGEST.${vendor} names no model`);
  const names = [...Object.keys(CURRENT).filter((k) => (CURRENT as Record<string, string>)[k] === id), ...Object.keys(CROSS_VENDOR).filter((k) => CROSS_VENDOR[k] === id)];
  return names.sort((a, b) => a.length - b.length)[0] ?? STRONGEST[vendor];
}

// ---- Text judges ----------------------------------------------------------------------------------------

/**
 * One text judge call. Takes the same options as Inference.ts and returns its result shape, so every caller and its
 * tests keep one contract. A Google model goes to Gemini (search off); Anthropic and OpenAI go through Inference.
 */
export async function judgeText(o: InferenceOptions): Promise<InferenceResult> {
  const id = o.model ? judgeModelId(o.model) ?? o.model : undefined;
  if (id && vendorOf(id) === 'google') return geminiText(o, id);
  return inference(o);
}

async function geminiText(o: InferenceOptions, model: string): Promise<InferenceResult> {
  const disabled = inferenceDisabledBy();
  const level = (o.level ?? 'high') as InferenceResult['level'];
  if (disabled) return { success: false, output: '', error: `inference disabled in this context (LIFEOS_INFERENCE_DISABLED=${disabled})`, latencyMs: 0, level };
  const started = Date.now();
  const p = Bun.spawn([process.execPath, join(import.meta.dir, '../TOOLS/GeminiSearch.ts'), '--no-search', '--model', model, '--max-tokens', '32000', '--system', o.systemPrompt, o.userPrompt], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  return code === 0 ? { success: true, output: out, latencyMs: Date.now() - started, level, executedModel: model } : { success: false, output: '', error: err.trim().slice(0, 300), latencyMs: Date.now() - started, level, executedModel: model };
}

/** A named judge as a plain ask: the registry name resolves to its model, and transport follows the model's vendor. */
export function namedJudge(name: string, system = 'You are a careful, impartial judge. Reply with JSON only.'): { name: string; ask: (prompt: string) => Promise<{ ok: boolean; text: string; model: string; error?: string }> } {
  const id = judgeModelId(name);
  if (!id) throw new Error(`no judge named ${name}: not a model in models.ts`);
  const vendor = vendorOf(id);
  let options: Partial<InferenceOptions>;
  if (vendor === 'anthropic') options = { vendor: 'anthropic', model: name, effort: 'high', level: (levelOfModel(id) ?? 'high') as InferenceOptions['level'] };
  else if (vendor === 'openai') {
    const level = levelOfModel(id);
    if (!level) throw new Error(`no judge transport for ${name} (${id}): no OpenAI rung serves it`);
    options = { vendor: 'openai', level: level as InferenceOptions['level'] };
  } else if (vendor === 'google') options = { model: id };
  else throw new Error(`no judge transport for ${name} (${id}, vendor ${vendor})`);
  return { name, async ask(prompt) {
    const r = await judgeText({ systemPrompt: system, userPrompt: prompt, timeout: 1_200_000, allowVendorFallback: false, maxAttempts: 1, persistSession: false, ...options } as InferenceOptions);
    return { ok: r.success, text: r.output, model: r.executedModel ?? `${id} (unverified)`, error: r.error };
  } };
}

// ---- Image judges ---------------------------------------------------------------------------------------

export type VisionProvider = 'google' | 'openai' | 'anthropic';
const API = 'https://generativelanguage.googleapis.com';

/** The Google key: the environment first, then the install's .env (getEnvPath honours CLAUDE_CONFIG_DIR). Never printed. */
function googleKey(): string {
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  try {
    for (const line of readFileSync(getEnvPath(), 'utf-8').split('\n')) {
      const m = line.match(/^GOOGLE_API_KEY=(.*)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* fall through */ }
  return '';
}

export function mime(file: string): string {
  const e = extname(file).toLowerCase();
  return e === '.png' ? 'image/png' : e === '.webp' ? 'image/webp' : 'image/jpeg';
}

/** Preserve the provider's model metadata; absence is unknown, never the requested model. */
export function visionResponseOf(j: { modelVersion?: unknown; candidates?: { content?: { parts?: { text?: string }[] } }[] }): { text: string; executed_model?: string } {
  return {
    text: j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '',
    ...(typeof j.modelVersion === 'string' && j.modelVersion.trim() ? { executed_model: j.modelVersion } : {}),
  };
}

/** One fresh, single-turn request: no history, no prior turns, nothing from whichever call generated the image (ISC-31). Pure. */
export function geminiBody(parts: unknown[]): { contents: { parts: unknown[] }[]; generationConfig: { temperature: number } } {
  return { contents: [{ parts }], generationConfig: { temperature: 0.1 } };
}

export function imgPart(file: string): unknown {
  return { inline_data: { mime_type: mime(file), data: Buffer.from(readFileSync(file)).toString('base64') } };
}

/**
 * Every Gemini call is Google egress, checked by the shared evaluator-egress assertion before any key read or network
 * call (LIFEOS/TOOLS/lib/EvaluatorEgress.ts). The install's provider rulings live in its USER Assay PREFERENCES.md.
 */
export async function gemini(parts: unknown[], observed?: { executed_model?: string }, deps: { publicMaterial?: boolean; fetch?: typeof fetch; caller?: string } = {}): Promise<string> {
  const material: MaterialClass = deps.publicMaterial ? 'public' : 'private';
  assertEvaluatorVendor('google', deps.caller ?? 'VisionJudge', material);
  const disabled = inferenceDisabledBy();
  if (disabled) throw new Error(`inference disabled in this context (LIFEOS_INFERENCE_DISABLED=${disabled}); this probe must be deterministic`);
  const key = googleKey();
  if (!key) throw new Error('GOOGLE_API_KEY missing');
  const r = await (deps.fetch ?? fetch)(`${API}/v1beta/models/${CROSS_VENDOR.gemini}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(geminiBody(parts)),
    signal: AbortSignal.timeout(60_000),
  });
  // The status only: a response body can echo private request content.
  if (!r.ok) throw new Error(`gemini ${r.status}`);
  const j = await r.json() as { modelVersion?: unknown; candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const response = visionResponseOf(j);
  if (observed && response.executed_model) observed.executed_model = response.executed_model;
  return response.text;
}

/** One image judge call by provider: OpenAI through codex, Anthropic through Inference's image path, Google through Gemini. */
export async function judgeImage(provider: VisionProvider, file: string, prompt: string, allowIdentity: boolean, opts: { publicMaterial?: boolean; caller?: string } = {}): Promise<VisionResponse> {
  if (provider === 'openai') return openAiVision(file, prompt, allowIdentity);
  if (provider === 'anthropic') return anthropicVision(file, prompt, allowIdentity);
  guardVisionRequest(file, allowIdentity);
  const observed: { executed_model?: string } = {};
  const text = await gemini([{ text: prompt }, imgPart(file)], observed, { publicMaterial: opts.publicMaterial, caller: opts.caller ?? 'VisionJudge' });
  return { text, ...observed };
}
