// Herdr focuses the session below when the focused one closes. This event hook moves
// focus to the session that sat directly above it. Closing the top session, or a
// session that was not focused, leaves herdr's own choice alone.

type WorkspaceInfo = { workspace_id: string; number: number; focused: boolean };

export function pickTarget(closed: WorkspaceInfo | null | undefined, remaining: WorkspaceInfo[]): string | null {
  if (!closed?.focused || closed.number <= 1) return null;
  // Remaining sessions renumber after the close; the one above keeps number - 1.
  return remaining.find((w) => w.number === closed.number - 1)?.workspace_id ?? null;
}

if (import.meta.main) {
  const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
  // Event shape (herdr 0.9.0): { event, data: { workspace_id, workspace: { number, focused, ... } } },
  // with number and focused as they stood before the close.
  const event = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "null");
  const closed: WorkspaceInfo | null = event?.data?.workspace ?? null;
  if (closed?.focused && closed.number > 1) {
    const list = Bun.spawnSync([herdr, "workspace", "list"]);
    const remaining: WorkspaceInfo[] = JSON.parse(list.stdout.toString()).result?.workspaces ?? [];
    const target = pickTarget(closed, remaining);
    if (target) Bun.spawnSync([herdr, "workspace", "focus", target]);
  }
}
