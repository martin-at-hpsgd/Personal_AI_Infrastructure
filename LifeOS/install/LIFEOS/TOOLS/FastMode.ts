#!/usr/bin/env bun
/**
 * FastMode — turn Claude Code fast mode on or off by writing `fastMode` in the
 * user settings file, the documented non-typed toggle
 * (https://code.claude.com/docs/en/fast-mode.md#toggle-fast-mode).
 * A command cannot invoke the built-in /fast, so `/f` calls this instead.
 *
 * Usage: bun LIFEOS/TOOLS/FastMode.ts [toggle|on|off|status]   (default toggle)
 * Prints one JSON line: {"fastMode": true|false, "changed": bool}.
 *
 * @version 1.0.1
 */

import { readFileSync, renameSync, writeFileSync } from "fs";
import { getSettingsPath } from "./Paths";
import { invariant } from "./Invariant";

const SETTINGS = process.env.CLAUDE_SETTINGS_PATH ?? getSettingsPath();

type Action = "toggle" | "on" | "off" | "status";

export function setFastMode(path: string, action: Action): { fastMode: boolean; changed: boolean } {
  const text = readFileSync(path, "utf8");
  const settings = JSON.parse(text) as Record<string, unknown>;
  const current = settings.fastMode === true;
  const next = action === "status" ? current : action === "toggle" ? !current : action === "on";
  if (next === current) return { fastMode: current, changed: false };

  const keysBefore = Object.keys(settings).length;
  const hadKey = "fastMode" in settings; // an explicit `fastMode: false` is replaced, not added
  if (next) settings.fastMode = true;
  else delete settings.fastMode;
  const out = JSON.stringify(settings, null, 2) + "\n";
  const reparsed = JSON.parse(out) as Record<string, unknown>;
  invariant(Object.keys(reparsed).length === keysBefore + (next ? (hadKey ? 0 : 1) : -1), "FastMode must change only the fastMode key");
  invariant((reparsed.fastMode === true) === next, "FastMode wrote the wrong fastMode value");

  const tmp = `${path}.fastmode.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);
  return { fastMode: next, changed: true };
}

if (import.meta.main) {
  const arg = (process.argv[2] ?? "toggle").toLowerCase();
  if (!["toggle", "on", "off", "status"].includes(arg)) {
    console.error("usage: FastMode.ts [toggle|on|off|status]");
    process.exit(2);
  }
  console.log(JSON.stringify(setFastMode(SETTINGS, arg as Action)));
}
