import type { State } from "./State";
import { renderHeader } from "./sections/Header";
import { renderPhone } from "./sections/Phone";
import { renderStateRow } from "./sections/StateRow";
import { renderInputs, renderWorkQueue } from "./sections/WorkQueue";
import { renderContextLoad } from "./sections/ContextLoad";
import { renderDoctor } from "./sections/Doctor";
import { renderVersion } from "./sections/Version";
import { prepareUltracode } from "./sections/Ultracode";
import { middleSections } from "./registry/Middle";
import { bottomSections } from "./registry/Bottom";

export interface Section {
  id: string;
  /**
   * What the section reads. An input marked `wake:` (a LifeOS-root path, `<session>` for the id) can change between turns
   * while the transcript stays still, so it must re-render the frame at once: it is listed in fast/wake, which both
   * Admission.enter() and the Rust statusline-fast read (Registry.test.ts holds the two equal). Declaring one needs no
   * Rust change; Fast.test.ts proves every line on both halves.
   */
  inputs: readonly string[];
  ttl: number | "mtime" | "session";
  kind?: "chip" | "row";
  render: (state: State) => string;
}

/** The one table of rows, in frame order. A row removed here takes its section, producer and refresh files with it. */
export const sections: readonly Section[] = [
  // The mode chips: the engine's ultracode rows and the session-shape file the dispatch hook writes (Router ISA F7), and
  // the docs chip's MicroIntegrity result and the doctrine mark's file, both written outside the transcript, so they are wake inputs (see Section.inputs).
  { id: "ultracode", kind: "chip", inputs: ["transcript", "ultracode-session-cache", "MEMORY/STATE/session-shape/<session>.json", "wake:MEMORY/STATE/micro-integrity/<session>.json", "wake:MEMORY/STATE/doctrine-mark/<session>.json"], ttl: "mtime", render: prepareUltracode },
  { id: "header", inputs: ["versions", "session-names", "session-labels", "location-cache.json", "weather-cache.json", "tide-line.txt", "ultracode", "clock", "geometry"], ttl: "mtime", render: renderHeader },
  { id: "phone", inputs: ["session-names", "session-labels"], ttl: "mtime", render: renderPhone },
  { id: "state", inputs: ["USER/STATE/current.json", "memory-health.jsonl", "work-attention.json", "interview-due.json", "clock"], ttl: 0, render: renderStateRow },
  { id: "work-queue", inputs: ["work-queue.json", "clock", "geometry"], ttl: 0, render: renderWorkQueue },
  { id: "inputs", inputs: ["work-queue.json", "clock", "geometry"], ttl: 0, render: renderInputs },
  { id: "context-load", inputs: ["context-load/statusline.json", "UPGRADES/records", "clock"], ttl: 0, render: renderContextLoad },
  { id: "doctor", inputs: ["capabilities-statusline.txt"], ttl: 0, render: renderDoctor },
  { id: "version", inputs: ["versions.algorithm", "stdin.model", "density", "LIFEOS_STATUSLINE_FULL"], ttl: 0, render: renderVersion },
  ...middleSections,
  ...bottomSections,
];
