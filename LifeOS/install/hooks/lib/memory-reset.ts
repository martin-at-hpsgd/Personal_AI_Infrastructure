import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { getClaudeDir } from "./paths";
import { invariant } from "../../LIFEOS/TOOLS/Invariant";

/** Session start/resume and compaction invalidate delivered-context receipts. */
export function resetMemoryDelivery(session: string, root = resolve(getClaudeDir(), "LIFEOS/MEMORY/STATE/memory-inject")): void {
  if (!session) return;
  const key = session.replace(/[^A-Za-z0-9._-]/g, "_");
  invariant(key.length > 0 && !key.includes("/"), "Memory reset has a session key");
  for (const suffix of [".json", ".queue.json"]) {
    try { unlinkSync(resolve(root, key + suffix)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
