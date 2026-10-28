/**
 * shell-view.ts — the prompt footer the plugin draws (FUNCTIONHOOKS F9 ISC-82; F10).
 *
 * Pure and plugin-local (not a synced core). The live shell rows, the SHELLS head, the pill prefix, the
 * spinner message and the turn-end counts line left 2026-10-11 (native work display): Claude Code's own Bash
 * pill, spinner, /tasks and "✻ <verb> for <time>" line show the same thing. Every model- or user-written string passes `clean` before it reaches a drawn segment.
 */
import { C, type Row } from "./board-view";

/** C0, DEL, C1 and the bidi controls: none of them ever reaches a drawn segment. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/** One line, controls blanked, whitespace collapsed. */
export function clean(text: string): string {
  return text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

/**
 * The prompt footer's mode labels with the ascent drawn as a chip (ISC-82): the engine's labels keep their dim
 * style, joined by ` & ` as the engine joins them, and the ascent label follows as one coloured bold run, then the
 * ULTRACODE chip while ultracode is on for the session (F10), then VOICE and FAST (F12).
 */
export function modeFooter(modes: readonly string[], ascent: { icon: string; label: string } | null, ultracode = false, voice = false, fast = false): Row {
  const row: Row = [];
  for (const m of modes) {
    const label = clean(m);
    if (!label) continue;
    if (row.length > 0) row.push({ text: " & ", dim: true });
    row.push({ text: label, dim: true });
  }
  const chip = ascent ? clean(`${ascent.icon} ${ascent.label}`) : "";
  if (chip) {
    if (row.length > 0) row.push({ text: "  " });
    row.push({ text: ` ${chip} `, color: C.label, bg: C.track, bold: true });
  }
  // F10 (ISC-110/111): ultracode for this session, from the transcript via band-state.
  if (ultracode) {
    if (row.length > 0) row.push({ text: "  " });
    row.push({ text: " ⚡ ULTRACODE ", color: C.violet, bg: C.track, bold: true });
  }
  // F12 (ISC-177..179): voice mode, and fast mode unless the engine already labels it.
  if (voice) {
    if (row.length > 0) row.push({ text: "  " });
    row.push({ text: " 🎙 VOICE ", color: C.ok, bg: C.track, bold: true });
  }
  if (fast && !modes.some((m) => /fast/i.test(m))) {
    if (row.length > 0) row.push({ text: "  " });
    row.push({ text: " ↯ FAST ", color: C.warn, bg: C.track, bold: true });
  }
  return row;
}
