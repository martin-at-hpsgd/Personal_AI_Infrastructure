#!/usr/bin/env bun
/**
 * SyncCores.ts — copy the pure cores the plugin depends on into hooks/lib/.
 *
 * A hooks module cannot import anything outside its plugin folder (not even a
 * symlink — probed 2026-09-05), so the plugin carries byte-identical copies of
 * a few import-free files. This script is the one way those copies move;
 * tests/parity.test.ts fails when a copy drifts from its source. Run it after
 * editing any source listed in CORES.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PLUGIN = resolve(dirname(new URL(import.meta.url).pathname), "..");
const CLAUDE_DIR = resolve(PLUGIN, "..", "..");

/** source (relative to the install root) → copy (relative to the plugin). */
export const CORES: ReadonlyArray<[string, string]> = [
  ["hooks/lib/system-surfaces.ts", "hooks/lib/system-surfaces.ts"],
  ["hooks/lib/egress-shapes.ts", "hooks/lib/egress-shapes.ts"],
  ["hooks/lib/outbound-shapes.ts", "hooks/lib/outbound-shapes.ts"],
  ["hooks/lib/context-reduction-core.ts", "hooks/lib/context-reduction-core.ts"],
  ["LIFEOS/TOOLS/InjectionShapes.ts", "hooks/lib/injection-shapes.ts"],
  ["hooks/lib/route-label.ts", "hooks/lib/route-label.ts"],
  ["hooks/lib/subagent-sandbox-wrap.ts", "hooks/lib/subagent-sandbox-wrap.ts"],
  ["hooks/lib/glyph-core.ts", "hooks/lib/glyph-core.ts"],
];

export function driftedCores(claudeDir = CLAUDE_DIR, plugin = PLUGIN): string[] {
  const out: string[] = [];
  for (const [src, dst] of CORES) {
    let a = "";
    let b = "";
    try { a = readFileSync(join(claudeDir, src), "utf8"); } catch { a = "<missing source>"; }
    try { b = readFileSync(join(plugin, dst), "utf8"); } catch { b = "<missing copy>"; }
    if (a !== b) out.push(`${src} ≠ ${dst}`);
  }
  return out;
}

if (import.meta.main) {
  for (const [src, dst] of CORES) {
    const from = join(CLAUDE_DIR, src);
    const to = join(PLUGIN, dst);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log(`synced ${src} → ${dst}`);
  }
  // A core that imports anything is not a core: the module would refuse to load.
  for (const [, dst] of CORES) {
    const text = readFileSync(join(PLUGIN, dst), "utf8");
    if (/^\s*import\s/m.test(text)) {
      console.error(`NOT PURE: ${dst} contains an import — the hooks module cannot load it`);
      process.exit(1);
    }
  }
}
