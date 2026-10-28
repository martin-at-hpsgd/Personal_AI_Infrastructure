import type { State } from "../State";
import { fit } from "../Width";
import { sessionForms } from "./Header";

/**
 * The phone layout under the header: the session row and nothing else. Context, subscription and Codex usage stay off
 * the phone (principal directive, 2026-10-24); the header row carries the city.
 */
export function renderPhone(state: State): string {
  if (!state.geometry.phone) return "";
  // The phone layout has no label, so the unlabelled forms only.
  const session = sessionForms(state, state.geometry.content).slice(1);
  return session.length ? `${fit(state.geometry.content, ...session)}\n` : "";
}
