#!/usr/bin/env bun
/**
 * RealPrompts.ts — sample the principal's own past prompts for router evaluation.
 *
 *   bun LIFEOS/ROUTER/RealPrompts.ts [--n 1000] [--seed 7]
 *
 * Reads the harness transcripts under ~/.claude/projects and keeps only prompts the principal
 * typed in an interactive session (entrypoint "cli", promptSource typed/queued/suggestion_accepted):
 * headless jobs, subagents, tool results, meta rows and harness notices are excluded. Each kept
 * prompt must pass FrontDoor's skipReason, so the sample is exactly what the router would classify.
 * Prompts are private: the output goes to the USER data repo
 * (MEMORY/STATE/router/real-prompts.jsonl), never into the system tree.
 */

import { Glob } from "bun";
import { join } from "node:path";
import { lifeosPath } from "../TOOLS/Paths";
import { skipReason, unwrapPasted } from "./FrontDoor";

export type RealPrompt = { id: string; ts: string; session: string; prompt: string; context: string; dictated?: true };
const TYPED = new Set(["typed", "queued", "suggestion_accepted"]);

/** The recent end of an assistant reply, normalized for prompt context. */
export function contextTail(text: string, max = 800): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `… ${normalized.slice(-max)}` : normalized;
}

/** The text a principal typed on one transcript row, or null when the row is not such a prompt. */
export function typedPrompt(r: Record<string, unknown>): { text: string; dictated?: true } | null {
  if (r.type !== "user" || r.isMeta || r.isSidechain || r.entrypoint !== "cli" || !TYPED.has(String(r.promptSource))) return null;
  const c = (r.message as { content?: unknown } | undefined)?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x: { type?: string }) => x?.type === "text").map((x: { text?: string }) => x.text ?? "").join("\n") : "";
  const t = text.trim();
  const dictated = /^<pasted_content\b/i.test(t);
  const unwrapped = dictated ? unwrapPasted(t) : t;
  if (!unwrapped || unwrapped.startsWith("<") || unwrapped.startsWith("[Request interrupted") || unwrapped.startsWith("Caveat:")) return null;
  return dictated ? { text: unwrapped, dictated: true } : { text: unwrapped };
}

export function typedText(r: Record<string, unknown>): string | null { return typedPrompt(r)?.text ?? null; }

/** Deterministic PRNG so a sample is reproducible. */
function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Every eligible typed prompt across the transcripts, with its previous-reply context, deduplicated. */
export async function collectAll(root: string = join(process.env.HOME ?? "", ".claude", "projects")): Promise<Omit<RealPrompt, "id">[]> {
  const seen = new Set<string>(); const all: Omit<RealPrompt, "id">[] = [];
  for await (const p of new Glob("*/*.jsonl").scan(root)) {
    const text = await Bun.file(join(root, p)).text();
    if (!text.includes('"entrypoint":"cli"')) continue;
    let lastAssistantText = "";
    for (const line of text.split("\n")) {
      let r: Record<string, unknown>; try { r = JSON.parse(line); } catch { continue; }
      if (r.type === "assistant" && !r.isSidechain) {
        const content = (r.message as { content?: unknown } | undefined)?.content;
        if (Array.isArray(content)) {
          const parts = content.filter((x: { type?: string }) => x?.type === "text").map((x: { text?: string }) => x.text ?? "");
          if (parts.length) lastAssistantText = parts.join("\n");
        }
      }
      if (!line.includes('"promptSource"')) continue;
      const prompt = typedPrompt(r); if (!prompt || skipReason(prompt.text, {}) !== null) continue;
      const t = prompt.text;
      const key = t.slice(0, 500); if (seen.has(key)) continue; seen.add(key);
      all.push({ ts: String(r.timestamp ?? ""), session: String(r.sessionId ?? ""), prompt: t, context: contextTail(lastAssistantText), ...(prompt.dictated ? { dictated: true as const } : {}) });
    }
  }
  return all;
}

/** Deterministic in-place Fisher-Yates shuffle. */
export function shuffle<T>(all: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  return all;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const n = Number(argv[argv.indexOf("--n") + 1]) || 1000;
  const seed = Number(argv[argv.indexOf("--seed") + 1]) || 7;
  const all = shuffle(await collectAll(), seed);
  const sample = all.slice(0, n).sort((a, b) => a.ts.localeCompare(b.ts)).map((r, i) => ({ id: `R${String(i + 1).padStart(4, "0")}`, ...r }));
  const out = lifeosPath("MEMORY", "STATE", "router", "real-prompts.jsonl");
  await Bun.write(out, sample.map(r => JSON.stringify(r)).join("\n") + "\n");
  console.log(`eligible ${all.length}, sampled ${sample.length} → ${out}`);
  console.log(`span ${sample[0]?.ts.slice(0, 10)} … ${sample.at(-1)?.ts.slice(0, 10)}`);
}
