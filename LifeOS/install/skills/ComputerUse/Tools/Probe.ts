#!/usr/bin/env bun
/**
 * Probe — prove the Astra leg works on this machine through the SAME runner a
 * mission uses: deny scan, caps, watcher, verifier, record. Captures the child's
 * JSONL event stream so the ISA can record the observed event vocabulary.
 *
 * Default task: type a line into TextEdit and save it to ~/Downloads/cu-probe.txt.
 * Verifier: the file exists.
 *
 * @version 1.0.0
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, unlinkSync } from "node:fs";
import { loadConfig, realProviders, supervise, writeRecord, EXIT, DEFAULT_CONFIG_PATH, type RunRequest } from "./Run";

const HOME = homedir();
const args = process.argv.slice(2);
const get = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const app = get("app", "TextEdit");
const defaultOut = join(HOME, "Downloads", "cu-probe.txt");
const outFile = get("out", defaultOut);
const outDir = outFile.slice(0, outFile.lastIndexOf("/"));
const outName = outFile.slice(outFile.lastIndexOf("/") + 1);
const eventLog = get("events", join(HOME, "Downloads", "cu-probe.jsonl"));
const task = get(
  "task",
  `In ${app} (already running with a window open): create a new document with Cmd+N. Type exactly: hello from computeruse\nSave with Cmd+S. In the Save dialog, press Cmd+Shift+G, type the folder path ${outDir} and press Return, then set the file name to ${outName} and press Return. If asked, choose plain text / replace. The end condition is that the Save dialog has closed and the window title reads ${outName}. Then stop.`,
);

const dryRun = args.includes("--dry-run");
// The verifier needs a file the run itself creates, so a stale one must go. Only the probe's own default
// output may be removed, and never on a dry run; an existing --out file is someone's file, so refuse.
if (existsSync(outFile)) {
  if (outFile !== defaultOut) {
    console.error(`refused: --out ${outFile} already exists; pick a path that does not exist.`);
    process.exit(2);
  }
  if (!dryRun) unlinkSync(outFile);
}

const req: RunRequest = {
  task,
  allowlist: [app, "Finder"],
  verifier: { kind: "cli", command: `test -f "${outFile}"` },
  eventLog,
  stepCap: Number(get("step-cap", "40")),
  wallClockSeconds: Number(get("wall-clock", "240")),
  dryRun,
  backend: get("backend", "astra") === "claude" ? "claude" : "astra",
  claudeModel: get("model", "") || undefined,
};

const cfg = loadConfig(get("config", DEFAULT_CONFIG_PATH));
const r = await supervise(req, cfg, realProviders);
if (r.record && !req.dryRun) console.error(`record: ${writeRecord(r.record)}`);
console.log(r.message);
if (r.record) console.log(`steps=${r.record.steps} browserEvents=${r.record.browserEvents} verdict=${r.record.verdict} events=${eventLog}`);
process.exit(r.exitCode === EXIT.OK ? 0 : r.exitCode);
