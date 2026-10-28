import { C, RESET, separator } from "../Ansi";
import { fit, label } from "../Width";
import type { State } from "../State";

export function renderVersion(state: State): string {
  if (state.geometry.phone) return "";
  const { density, content } = state.geometry;
  let out = separator(content, density);
  if (density <= 2 || state.env.LIFEOS_STATUSLINE_FULL) {
    const model = state.model.replaceAll(" context", "").toUpperCase();
    const algo = `${C.slate400}${label(density, "ALGO:", "ALGO", "A")}${RESET} ${C.blue}${state.versions.algorithm}${RESET}`;
    const named = `${C.slate400}${label(density, "DEFAULT MODEL:", "MODEL", "M")}${RESET} ${C.blue}${model}${RESET}`;
    // Narrower, the algorithm version goes, then the model label, then the model name keeps only its first word.
    out += `${fit(content, `${algo} ${C.slate600}│${RESET} ${named}`, named, `${C.blue}${model}${RESET}`, `${C.blue}${model.split(" ")[0]}${RESET}`)}\n`;
  }
  return out;
}
