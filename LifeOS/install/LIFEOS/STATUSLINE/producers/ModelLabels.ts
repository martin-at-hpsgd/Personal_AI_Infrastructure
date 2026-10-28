import { statSync } from "node:fs";
import { readText } from "../Cache";
import type { State } from "../State";

export interface ModelLabels { max: string; high: string; med: string; astra: string; sol: string }

/** `sed -n '/START/,/^}/p'`: from the first matching line through the first later line starting with "}". */
function block(text: string, start: string): string[] {
  const lines = text.split("\n");
  const from = lines.findIndex(line => line.includes(start));
  if (from < 0) return [];
  const out = [lines[from]];
  for (const line of lines.slice(from + 1)) { out.push(line); if (line.startsWith("}")) break; }
  return out;
}

function lookup(lines: string[], key: string, value: string): string {
  const pattern = new RegExp(`^[ \\t]*${key}:[ \\t]*"(${value})"`);
  for (const line of lines) { const m = pattern.exec(line); if (m) return m[1]; }
  return "";
}

const LABEL = "[A-Z0-9._-]";
const SHAPE = new RegExp(`^${LABEL}+\\|${LABEL}+\\|${LABEL}+\\|${LABEL}+\\|${LABEL}*$`);
const CACHE = "model-labels.txt";

/**
 * Ladder labels read from the model registry. One line "v1|epoch|max|high|med|astra|sol|path",
 * reused while owned by this user, not older than the registry file, and under 300 s. Fallback labels are drawn,
 * never cached.
 */
export function modelLabels(state: State): ModelLabels {
  const source = `${state.root}/TOOLS/models.ts`;
  const { cache } = state;
  const cached = ((): ModelLabels | null => {
    let info;
    try { info = statSync(cache.path(CACHE)); } catch { return null; }
    if (info.uid !== process.getuid?.()) return null;
    try { if (statSync(source).mtimeMs > info.mtimeMs) return null; } catch { /* absent registry file: not newer */ }
    const line = (cache.text(CACHE) ?? "").split("\n")[0];
    const [v, at, max, high, med, astra, sol, ...rest] = line.split("|");
    const age = state.now - Number(at);
    if (v !== "v1" || rest.join("|") !== source || !/^[1-9][0-9]*$/.test(at ?? "") || age < 0 || age >= 300) return null;
    if (!SHAPE.test([max, high, med, astra, sol].join("|"))) return null;
    return { max, high, med, astra, sol };
  })();
  if (cached) return cached;
  const text = readText(source) ?? "";
  const effort = block(text, "export const EFFORT_MODEL");
  const vendor = block(text, "export const CROSS_VENDOR");
  const tier = (key: string): string => lookup(effort, key, "[a-z0-9-]*").toUpperCase();
  // Cross-vendor label: codename suffix only ("SOL", not "GPT-6.1 SOL").
  const lane = (key: string): string => lookup(vendor, key, '[^"]*').replace(/.*-/, "").toUpperCase();
  let fallback = false;
  let [max, high, med] = [tier("max"), tier("high"), tier("medium")];
  if (!max || !high || !med) fallback = true;
  max ||= "FABLE"; high ||= "OPUS"; med ||= "SONNET";
  let astra = lane("astra");
  if (!astra) { fallback = true; astra = "ASTRA"; }
  const sol = lane("sol");
  const labels = { max, high, med, astra, sol };
  if (!fallback && !Object.values(labels).some(label => label.includes("|"))) {
    cache.put(CACHE, `v1|${state.now}|${max}|${high}|${med}|${astra}|${sol}|${source}\n`);
  }
  return labels;
}
