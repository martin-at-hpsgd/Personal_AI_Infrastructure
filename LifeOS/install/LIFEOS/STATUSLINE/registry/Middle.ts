import { separator } from "../Ansi";
import type { Section } from "../Registry.ts";
import { renderContext } from "../sections/Context";
import { renderLadder } from "../sections/Ladder";
import type { State } from "../State";

/** The rule that closes the ladder block (it used to close the WORK rows); none when the ladder has nothing to draw. */
const renderRule = (state: State): string => renderLadder(state) ? separator(state.geometry.content, state.geometry.density) : "";

/**
 * Rows from the model ladder through the CONTEXT row, in frame order. Owned by the middle lane.
 * Agent activity (the agents row, delegation counters, route trail and WORK rows) left the statusline on 2026-10-11
 * so the activity lives in the response format instead; the answer's
 * one-line 🤖 AGENTS field carries it now.
 */
export const middleSections: readonly Section[] = [
  { id: "ladder", inputs: ["stdin.model", "models.ts", "model-labels.txt", "model-mix-<session>.txt"], ttl: 20, render: renderLadder },
  { id: "rule", inputs: ["geometry", "stdin.model", "models.ts", "model-labels.txt", "model-mix-<session>.txt"], ttl: 0, render: renderRule },
  { id: "context", inputs: ["stdin.context_window", "startup-estimate-<session>.sh", "model-mix-<session>.txt", "model-labels.txt", "ctx-sizes.txt", "CLAUDE.md", "LIFEOS_SYSTEM_PROMPT.md", "skills-size-<session>.sh", "listing-size-<session>.sh", "listing-size-last.sh", "transcript", "geometry"], ttl: "session", render: renderContext },
];
