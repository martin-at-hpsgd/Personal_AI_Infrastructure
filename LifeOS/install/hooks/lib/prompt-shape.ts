/**
 * prompt-shape — the ⏱️ SHAPE line, the deadlines.jsonl row and the session-shape file for one prompt (Router ISA F5, F7).
 *
 * The shape is the principal's own words (`dw`, a trailing time, `uc`, the `p` levels), so it needs no router and no
 * model call. It moved out of the prompt router hook (maintainer-side; not in the public release) on 2026-10-17: unregistering that hook (native-unblock ISC-14, no model
 * call before a prompt) had taken the SHAPE line, the deadline rows and the statusline shape chips with it.
 * TimeContext now draws it on every prompt; the router hook imports it from here.
 *
 * FrontDoor (for the injected-text check) and herdr-tabs load only when there is something to write, so a plain prompt
 * pays for neither.
 * Any failure draws nothing.
 */
import {
  appendDeadline, deadlineRow, formatShapeLine, isBareShortcut, isShaped, nextSessionShape, parseShape, readSessionShape,
  sessionShapeDir, writeSessionShape,
} from "../../LIFEOS/ROUTER/Shape";

export type ShapeDeps = { env?: NodeJS.ProcessEnv; now?: Date; deadlinesPath?: string; transcriptPath?: string; sessionShapeDir?: string };

/** FrontDoor.unwrapPasted, inlined so a plain prompt never loads FrontDoor: paste wrappers and image placeholders dropped. */
const unwrap = (p: string): string => p.replace(/<\/?pasted_content\b[^>]*>/gi, " ").replace(/\[Image(?: #\d+|: [^\]]*)\]/g, " ").trim();

/**
 * The ⏱️ SHAPE line for a prompt that carries `dw` or a trailing time, and its row in deadlines.jsonl (ids and times only,
 * never the prompt), plus the session-shape file (Router ISA F7, R119: ultracode stays until `uc off`, the parallel level
 * clears on any non-shortcut prompt; written only when it changes). Injected and headless text does none of it.
 */
export async function shapeLine(prompt: unknown, sessionId: string | undefined, turn: string, deps: ShapeDeps = {}): Promise<string | null> {
  try {
    const env = deps.env ?? process.env;
    if (typeof prompt !== "string" || env.LIFEOS_NOTIFICATION_CHANNEL === "headless") return null;
    const now = deps.now ?? new Date();
    const text = unwrap(prompt);
    const shape = parseShape(text, now);
    const dir = deps.sessionShapeDir ?? sessionShapeDir();
    const prev = sessionId ? readSessionShape(sessionId, dir) : null;
    const next = prev ? nextSessionShape(prev, shape, isBareShortcut(text)) : null;
    const moved = !!(prev && next && (next.ultracode !== prev.ultracode || next.parallel !== prev.parallel));
    const herdr = !deps.env && env.HERDR_ENV === "1"; // tests inject env, so a test run never writes the live sidebar
    if (!moved && !isShaped(shape) && !herdr) return null;
    const { skipReason } = await import("../../LIFEOS/ROUTER/FrontDoor");
    if (skipReason(prompt, {}) === "injected") return null;
    if (moved) try { writeSessionShape(next!, dir); } catch { /* the statusline chip is display only */ }
    // Herdr space row: the deadline this request carries, cleared by a request without one.
    if (herdr) try { (await import("./herdr-tabs")).reportHerdrDue(shape.due); } catch { /* display only */ }
    if (!isShaped(shape)) return null;
    try { appendDeadline(deadlineRow(shape, sessionId ?? "unknown", turn, now, deps.transcriptPath), deps.deadlinesPath); } catch { /* the log is a record; the line still goes */ }
    return formatShapeLine(shape, now);
  } catch { return null; }
}
