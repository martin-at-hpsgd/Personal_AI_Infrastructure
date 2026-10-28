/**
 * panes-view.ts — which other herdr sessions need the principal (FUNCTIONHOOKS ISC-202..207).
 *
 * Pure: no `$`, no I/O. The plugin runs `herdr agent list` and hands its JSON here. A session needs the principal when
 * its agent is `blocked` (an approval or a question is open) or `done` (a turn finished that nobody has looked at).
 * The pane this session runs in is left out: the principal is already looking at it.
 */

export type PaneAttention = { pane: string; session: string; title: string; status: "blocked" | "done" };

/** At most this many sessions get a row of their own; the rest fold into one `+N more` line. */
export const MAX_PANE_ROWS = 4;

/** A pane title without the agent glyph herdr puts in front of it (`◐ Vigil …` → `Vigil …`). Never shortened. */
export function paneTitle(title: string): string {
  return title.replace(/^[^\p{L}\p{N}]+/u, "").trim() || "Session";
}

/** The sessions needing the principal, blocked first, from `herdr agent list` output. Unreadable output is none. */
export function attentionPanes(json: string, ownPane: string): PaneAttention[] {
  let agents: unknown;
  try { agents = (JSON.parse(json) as { result?: { agents?: unknown } }).result?.agents; } catch { return []; }
  if (!Array.isArray(agents)) return [];
  const out: PaneAttention[] = [];
  for (const a of agents as Array<Record<string, unknown>>) {
    const status = a.agent_status;
    if ((status !== "blocked" && status !== "done") || a.pane_id === ownPane) continue;
    const session = (a.agent_session as { value?: unknown } | undefined)?.value;
    out.push({ pane: String(a.pane_id ?? ""), session: typeof session === "string" ? session : "", title: paneTitle(String(a.terminal_title_stripped ?? a.terminal_title ?? "")), status });
  }
  return out.sort((x, y) => (x.status === y.status ? 0 : x.status === "blocked" ? -1 : 1));
}

/** The row text: `⏸ Needs you` or `✓ Finished`, the full title, then the session's own last line when known. */
export function attentionRow(p: PaneAttention, note?: string): { icon: string; title: string; note: string | null } {
  return { icon: p.status === "blocked" ? "⏸ Needs you" : "✓ Finished", title: p.title, note: note ?? null };
}

/** A stable key for the set, so an unchanged poll redraws nothing. */
export function attentionKey(xs: readonly PaneAttention[]): string {
  return xs.map((x) => `${x.status}:${x.pane}:${x.title}`).join("|");
}
