// Codex front door's Bunker manifest — the second front door has an app of
// record like every other piece of the install, watched by the same harness.
//
// `cli` because there is no URL: its probes are local (symlinks resolve, the
// native renderer lists the catalog, the bridge left telemetry), so they run
// in the local monitor's jurisdiction and never compile to the cloud worker.
//
// Plain object literal, NOT `defineBunker()` — `LIFEOS/PULSE/Bunker/**` is a
// containment zone and `LIFEOS/CODEX/` ships; see LIFEOS/HERMES/bunker.config.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export default {
  name: "codex",
  type: "cli",
  // Adopted only while a Codex home exists on this install.
  enabled: existsSync(process.env.CODEX_HOME || join(homedir(), ".codex")),
  isa: "./ISA.md",
};
