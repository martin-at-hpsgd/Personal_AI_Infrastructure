#!/usr/bin/env bun
import { Frame } from "./Frame";
import { sections, type Section } from "./Registry.ts";
import { buildState, type State } from "./State";
import { InvariantViolation } from "../TOOLS/Invariant";
import { Admission } from "./Admission";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { mtime } from "./Cache";
import { noteHerdr } from "./producers/Herdr";
import { prepareVersions } from "./producers/Versions";
import { contextInput } from "./producers/Startup";
import { privateExtension } from "./Private";
import { payment } from "./producers/UsageView";

/** One raw stdin payload, 0600, then the flag is consumed so this never loops. Diagnostic only. */
export function captureStdin(state: State): void {
  const flag = state.cache.path("sl-capture");
  if (mtime(flag) === 0) return;
  const payload = state.cache.path("sl-payload.json");
  writeFileSync(payload, state.rawInput, { mode: 0o600 });
  chmodSync(payload, 0o600);
  rmSync(flag, { force: true });
}

/**
 * The bootstrap that follows admission in the bash (746-878). It writes only the small always-written caches and plans no
 * refresh: every shared fetch belongs to the scheduled refresher (Refresh.ts, workflow statusline-refresh), so a render
 * only reads caches. Nothing here fetches or spawns.
 */
export function produce(state: State): void {
  const { cache } = state;
  if (state.widthToPersist !== null) cache.put(`term-width-${state.env.KITTY_WINDOW_ID || "default"}`, `${state.widthToPersist}\n`);
  if (state.timezoneOverride) process.env.TZ = state.timezone;
  prepareVersions(state);
  // The estimated context replaces a zero stdin reading before any section draws it.
  state.contextPct = Number(contextInput(state).pct) || 0;
  state.pay = payment(state);
  privateExtension()?.saveStdin({ label: state.pay.label, transcript: state.transcript, env: state.env, cacheRoot: state.cache.root, rawInput: state.rawInput });
  noteHerdr(state);
}

export interface RenderOptions { produce?: boolean }

export function render(state: State, selected: readonly Section[] = sections, options: RenderOptions = {}): string {
  state.cache.initialize();
  // The daily sweep runs before idle admission, as in the bash, so a replayed frame still ages the directory.
  state.cache.sweepDaily();
  if (options.produce) captureStdin(state);
  const admission = new Admission(state);
  const replay = admission.enter();
  if (replay !== null) return replay;
  if (options.produce) {
    try { produce(state); }
    catch (error) {
      if (error instanceof InvariantViolation) { admission.release(); throw error; }
      process.stderr.write(`statusline: ${error instanceof Error ? error.message : "producers failed"}\n`);
    }
  }
  const frame = new Frame(state);
  let settled = false;
  const emergency = (): void => {
    if (settled) return;
    settled = true;
    try { process.stdout.write(frame.finish(false)); } finally { admission.release(); }
  };
  const signal = (): void => { emergency(); process.exit(143); };
  process.on("exit", emergency);
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, signal);
  try {
    try {
      for (const section of selected) frame.append(section.render(state));
    } catch (error) {
      if (error instanceof InvariantViolation) throw error;
      process.stderr.write(`statusline: ${error instanceof Error ? error.message : "section failed"}\n`);
      settled = true;
      return frame.finish(false);
    }
    settled = true;
    return frame.finish(true);
  } finally {
    process.off("exit", emergency);
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(name, signal);
    admission.release();
  }
}

if (import.meta.main) {
  const state = buildState(await Bun.stdin.text());
  // Fail closed: an install root that is not absolute would send every cache write somewhere unintended.
  if (state.failClosed) { process.stdout.write("LifeOS\n"); process.exit(0); }
  const sectionArg = process.argv.indexOf("--section");
  const selected = process.argv.includes("--empty") ? [] : sectionArg >= 0 ? sections.filter(s => s.kind === "chip" || s.id === process.argv[sectionArg + 1]) : sections;
  let output: string;
  try { output = render(state, selected, { produce: !process.argv.includes("--no-produce") }); }
  catch (error) {
    if (error instanceof InvariantViolation) throw error;
    // The cache directory could not be made (a failed scratch allocation prints the bare name).
    process.stdout.write("LifeOS\n");
    process.exit(0);
  }
  // Claude Code shows the line when this process exits, so it exits as soon as the frame is written.
  await new Promise<void>((resolve) => process.stdout.write(output, () => resolve()));
  process.exit(0);
}
