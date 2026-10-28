import { join } from "node:path";
import { RESET } from "../Ansi";
import { readText } from "../Cache";
import type { State } from "../State";

export function renderDoctor(state: State): string {
  if (state.geometry.phone) return "";
  const text = readText(join(state.root, "MEMORY", "STATE", "capabilities-statusline.txt"));
  return text ? `${state.env.YELLOW || ""}${text.replace(/\n+$/, "")}${RESET}\n` : "";
}
