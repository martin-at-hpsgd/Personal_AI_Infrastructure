// Browser-safe: workspace.ts (the renderer, bundled with target:'browser') imports
// this file, so it takes no imports. The transcript reader lives in session-transcript.ts.

export interface SessionRuntime {
  provider: "Claude Code" | "Codex" | "LifeOS";
  model: string | null;
}

type Decoration = { provider?: unknown; model?: unknown; codexThreadId?: unknown };

const PROVIDERS = new Set<SessionRuntime["provider"]>(["Claude Code", "Codex", "LifeOS"]);

/** Decorations written before the rename persist the retired "PAI" label;
 * read them as LifeOS so a live tab keeps its mark. */
const LEGACY_PROVIDERS: ReadonlyMap<string, SessionRuntime["provider"]> = new Map([["PAI", "LifeOS"]]);

export type ProviderVisual = { className: string; src?: string; text?: string };

/** Brand marks keep a small card label recognizable without provider text.
 * They are local, ignored assets that the release does not ship, so each mark
 * carries a text label the card shows when its image is absent. */
export function providerVisual(provider: SessionRuntime["provider"]): ProviderVisual {
  if (provider === "Claude Code") return { className: "provider-mark--claude", src: "assets/providers/claude.svg", text: "Claude" };
  if (provider === "Codex") return { className: "provider-mark--chatgpt", src: "assets/providers/chatgpt.svg", text: "Codex" };
  return { className: "provider-mark--lifeos", text: "LifeOS" };
}

/** Runtime identity is persisted by the harness hook; command matching only
 * supplies a provider fallback, never a speculative model. The legacy `pai`
 * launcher command still maps to LifeOS. */
export function sessionRuntime(decoration: Decoration | undefined, command: string): SessionRuntime | null {
  const rawProvider = typeof decoration?.provider === "string" ? decoration.provider : null;
  const storedProvider = rawProvider === null
    ? null
    : PROVIDERS.has(rawProvider as SessionRuntime["provider"])
      ? rawProvider as SessionRuntime["provider"]
      : LEGACY_PROVIDERS.get(rawProvider) ?? null;
  const normalizedCommand = command.trim().toLowerCase();
  const provider = storedProvider
    ?? (typeof decoration?.codexThreadId === "string" && decoration.codexThreadId.trim() ? "Codex" : null)
    ?? (normalizedCommand === "claude" ? "Claude Code" : normalizedCommand === "codex" ? "Codex" : normalizedCommand === "pai" ? "LifeOS" : null);
  if (!provider) return null;
  const model = typeof decoration?.model === "string" && decoration.model.trim() ? decoration.model.trim() : null;
  return { provider, model };
}
