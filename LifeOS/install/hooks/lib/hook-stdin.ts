/**
 * @version 1.0.0
 * hook-stdin.ts — the one stdin reader for hook shims.
 *
 * Twenty-four hooks each carried their own copy of a 10-line stdin reader.
 * Modules that export `run(input)` now keep only a two-line `import.meta.main`
 * shim built on this. Returns the parsed object, or null on empty/invalid/timeout.
 */

const STDIN_CAP_BYTES = 10_000_000;

export async function readStdinJson(timeoutMs = 2000): Promise<Record<string, unknown> | null> {
  const raw = await readStdinText(timeoutMs);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function readStdinText(timeoutMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.on("data", (c: Buffer) => {
      data += c.toString();
      if (data.length > STDIN_CAP_BYTES) {
        clearTimeout(timer);
        try { process.stdin.pause(); } catch { /* closed */ }
        resolve(data);
      }
    });
    process.stdin.on("end", () => { clearTimeout(timer); resolve(data); });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(data); });
  });
}

/** Standard shim output: JSON with additionalContext when there is any, nothing otherwise. */
export function emitContext(event: string, text: string | null | undefined): void {
  if (!text) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) + "\n");
}
