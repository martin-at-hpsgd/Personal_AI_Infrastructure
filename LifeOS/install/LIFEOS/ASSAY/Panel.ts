/**
 * Panel — Assay's judge panel for comparing several producers' outputs on the same input.
 * The caller owns the rubric (from its ISA); the panel owns what keeps the comparison fair:
 * blinding, word-budget cuts, cross-vendor judges with vendor exclusion, verdict repair and
 * retries, pairwise preferences from rankings, and the length check. Doctrine: AssaySystem.md § Judge panel.
 */
import { createHash } from 'node:crypto';
import { vendorOf, judgeModelId, namedJudge, judgeStrength } from './JudgeCall';
export { vendorOf, judgeModelId, judgeStrength };

/** A judge's grade on a candidate counts only when they come from different vendors. */
export const gradeCounts = (judgeModel: string, candidateModel: string) => vendorOf(judgeModel) !== vendorOf(candidateModel);
/** A judge's preference between two candidates counts only when it is outside both vendors. */
export const preferenceCounts = (judgeModel: string, a: string, b: string) => gradeCounts(judgeModel, a) && gradeCounts(judgeModel, b);

/** An output past the word budget reaches judges cut at the budget, so length beyond it cannot help. */
export function cutToBudget(text: string, words?: number): { text: string; cut: boolean } {
  if (!words) return { text, cut: false };
  const parts = text.split(/(\s+)/); let n = 0;
  for (let i = 0; i < parts.length; i++) if (parts[i].trim() && ++n > words) return { text: parts.slice(0, i).join('').trimEnd() + `\n\n[cut here: the answer ran past the ${words}-word budget]`, cut: true };
  return { text, cut: false };
}

/** Vendor and model names that would tell a judge who wrote a candidate, plus any extra names the caller passes (its producer ids). */
const VENDOR_NAMES = ['claude', 'anthropic', 'opus', 'sonnet', 'fable', 'haiku', 'openai', 'chatgpt', 'gpt[-\\w.]*', 'codex', 'meta ai', 'llama', 'muse', 'gemini', 'google deepmind', 'grok', 'xai'];
export function anonymize(text: string, extra: string[] = []): string {
  const names = [...VENDOR_NAMES, ...extra.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))];
  return text.replace(new RegExp(`\\b(${names.join('|')})\\b`, 'gi'), '[model]');
}

/**
 * Version of the plain form below; a bench that judges through it records this in its definition, so a change to the
 * form changes the bench's version.
 */
export const PLAIN_FORM = 'plain-form-v1';

/**
 * One plain format for every candidate, so how a model formats cannot tell a judge which lab wrote it (2026-10-15:
 * formatting alone told the labs apart, Anthropic with about 15 bullets an answer and the rest with 1 to 5, and each
 * judge graded its own lab about half a point to a point higher). Deterministic, and it keeps every word of content:
 * headings and bold label lines become "Label:" lines; list markers, emphasis, inline code marks, table rules and
 * fences go; each section's lines join into one paragraph; dashes, quotes and ellipses take one form.
 */
export function plainForm(text: string): string {
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push(para.join(' ')); para = []; } };
  const end = (s: string) => (/[.!?:;,)\]"']$/.test(s) ? s : `${s}.`);
  const inline = (s: string) => s
    .replace(/`{1,3}/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\s*[\u2014]\s*|\s+--\s+/g, ', ')
    .replace(/(\d)\u2013(\d)/g, '$1-$2')
    .replace(/\s*\u2013\s*/g, ', ')
    .replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || /^```/.test(line) || /^[-*_]{3,}$/.test(line) || /^\|?\s*:?-{2,}/.test(line)) { if (!line) flush(); continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line) ?? /^(?:\*\*|__)([^*_]{1,60}?)(?::)?(?:\*\*|__):?$/.exec(line);
    if (heading) { flush(); out.push(`${inline(heading[1]!).replace(/:$/, '')}:`); continue; }
    const labelled = /^(?:\*\*|__)([^*_]{1,40}?):?(?:\*\*|__):?\s+(.+)$/.exec(line);
    const body = labelled ? null : line.replace(/^(?:[-*+\u2022]|\d{1,3}[.)])\s+/, '').replace(/^\|(.*)\|$/, (_, cells: string) => cells.split('|').map((c) => c.trim()).join(', '));
    if (labelled) { flush(); out.push(`${inline(labelled[1]!)}:`); para.push(end(inline(labelled[2]!))); continue; }
    const t = inline(body!);
    if (t) para.push(end(t));
  }
  flush();
  return out.join('\n\n');
}

/** Deterministic shuffle of candidates onto letters, different for every seed (input and judge). */
export function blindLabels(seed: string, ids: string[]): Record<string, string> {
  const h = (x: string) => createHash('sha256').update(seed + x).digest('hex');
  return Object.fromEntries([...ids].sort((a, b) => h(a).localeCompare(h(b))).map((id, i) => [String.fromCharCode(65 + i), id]));
}

/** Judges sometimes return near-JSON: a fenced block, trailing commas, comments or bare keys. Strict parse first, then a repaired one. */
export function parseLoose(text: string): any {
  const body = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return JSON.parse(body); } catch {}
  return JSON.parse(body.replace(/\/\/[^\n"]*$/gm, '').replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":'));
}

export interface Candidate { id: string; model: string; text: string }
export interface Shown { label: string; id: string; text: string; cut: boolean }
export interface JudgeReply { ok: boolean; text: string; model: string; error?: string }
export interface PanelJudge { name: string; ask: (prompt: string) => Promise<JudgeReply> }
export interface PanelVerdict<V> { key: string; judge: string; model: string; ok: boolean; error?: string; labels: Record<string, string>; cut: Record<string, boolean>; verdict?: V }

/**
 * One judge grades every candidate for one input in one blinded pass. `prompt` builds the rubric prompt from
 * the shown candidates; `parse` turns the reply into the caller's verdict and throws on anything malformed.
 * A verdict that never parses after `attempts` is unavailable (ok: false), never a low grade.
 */
export async function judgeOnce<V>(o: { key: string; judge: PanelJudge; candidates: Candidate[]; words?: number; hide?: string[]; plain?: boolean; prompt: (shown: Shown[]) => string; parse: (text: string, labels: Record<string, string>) => V; attempts?: number }): Promise<PanelVerdict<V>> {
  const labels = blindLabels(`${o.key}:${o.judge.name}`, o.candidates.map((c) => c.id));
  const shown: Shown[] = Object.entries(labels).map(([label, id]) => ({ label, id, ...cutToBudget((o.plain ? plainForm : (t: string) => t)(anonymize(o.candidates.find((c) => c.id === id)!.text, o.hide)), o.words) }));
  const cut = Object.fromEntries(shown.map((s) => [s.id, s.cut]));
  const prompt = o.prompt(shown);
  let last = 'no reply', model = '';
  for (let attempt = 0; attempt < (o.attempts ?? 3); attempt++) {
    const r = await o.judge.ask(prompt);
    model = r.model || model;
    if (!r.ok) { last = r.error ?? 'no reply'; continue; }
    try { return { key: o.key, judge: o.judge.name, model: r.model, ok: true, labels, cut, verdict: o.parse(r.text, labels) }; }
    catch (e) { last = `unparseable verdict: ${(e as Error).message}`; }
  }
  return { key: o.key, judge: o.judge.name, model, ok: false, error: last, labels, cut };
}

/** Pairwise preferences from rankings (best first), counting only judges outside both candidates' vendors. */
export function preferences(rankings: { judgeModel: string; ranking: string[] }[], modelOf: (id: string) => string, counts: (judgeModel: string, a: string, b: string) => boolean = preferenceCounts): Record<string, Record<string, { w: number; l: number }>> {
  const pairs: Record<string, Record<string, { w: number; l: number }>> = {};
  const cell = (a: string, b: string) => ((pairs[a] ??= {})[b] ??= { w: 0, l: 0 });
  for (const { judgeModel, ranking } of rankings) ranking.forEach((a, i) => ranking.slice(i + 1).forEach((b) => {
    if (!counts(judgeModel, modelOf(a), modelOf(b))) return;
    cell(a, b).w++; cell(b, a).l++;
  }));
  return pairs;
}

/** Pearson correlation of candidate length with rank position (1 = best). Strongly negative means longer candidates won. */
export function lengthBias(points: [words: number, rank: number][]): number {
  const n = points.length; if (n < 3) return 0;
  const mx = points.reduce((a, p) => a + p[0], 0) / n, my = points.reduce((a, p) => a + p[1], 0) / n;
  const cov = points.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
  const sx = Math.sqrt(points.reduce((a, p) => a + (p[0] - mx) ** 2, 0)), sy = Math.sqrt(points.reduce((a, p) => a + (p[1] - my) ** 2, 0));
  return sx && sy ? cov / (sx * sy) : 0;
}
export const LENGTH_BIAS_FLAG = 0.5;

/** A panel judge by registry name, through Assay's one judge transport (JudgeCall.ts). */
export const panelJudge = (name: string): PanelJudge => namedJudge(name);

export async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
