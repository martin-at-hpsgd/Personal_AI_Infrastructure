#!/usr/bin/env bun
/**
 * BuildHost.ts — build "LifeOS Relay.app", the text line's macOS app identity (see RelayHost.swift).
 *
 *   bun BuildHost.ts            # build if the source changed; prints the executable path
 *   bun BuildHost.ts --request  # prompt for each grant not yet asked (at the Mac), then print them
 *   bun BuildHost.ts --status   # each privacy grant the app holds, as macOS records it
 *
 * The app is ad-hoc signed, and macOS keys an ad-hoc app's grants to its exact signature, so a
 * rebuild drops every grant. The build is skipped while the source hash matches the last build.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { getDAName } from "../../../hooks/lib/identity";

const HOME = process.env.HOME ?? homedir();
const HERE = dirname(new URL(import.meta.url).pathname);
const SOURCE = join(HERE, "RelayHost.swift");
export const APP = join(HOME, "Applications", "LifeOS Relay.app");
export const EXECUTABLE = join(APP, "Contents", "MacOS", "RelayHost");
const STAMP = join(APP, "Contents", "Resources", "source.sha256");
const BUNDLE_ID = "com.lifeos.relay.host";

function xmlEscape(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Info.plist for the app. The DA's name is resolved at runtime so macOS privacy prompts name this install's assistant. */
export function infoPlist(daName: string = getDAName()): string {
  const name = xmlEscape(daName);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>LifeOS Relay</string>
  <key>CFBundleDisplayName</key><string>LifeOS Relay</string>
  <key>CFBundleExecutable</key><string>RelayHost</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>LSUIElement</key><true/>
  <key>NSContactsUsageDescription</key><string>So ${name} can read and update your contacts when you ask by text.</string>
  <key>NSCalendarsFullAccessUsageDescription</key><string>So ${name} can read and change your calendar when you ask by text.</string>
  <key>NSRemindersFullAccessUsageDescription</key><string>So ${name} can read and add reminders when you ask by text.</string>
  <key>NSPhotoLibraryUsageDescription</key><string>So ${name} can find and send photos when you ask by text.</string>
  <key>NSAppleEventsUsageDescription</key><string>So ${name} can drive Mac apps when you ask by text.</string>
</dict>
</plist>
`;
}

function sh(cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

export function build(): { built: boolean } {
  const hash = createHash("sha256").update(readFileSync(SOURCE)).update(infoPlist()).digest("hex");
  if (existsSync(EXECUTABLE) && existsSync(STAMP) && readFileSync(STAMP, "utf8").trim() === hash) return { built: false };
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(dirname(EXECUTABLE), { recursive: true });
  mkdirSync(dirname(STAMP), { recursive: true });
  writeFileSync(join(APP, "Contents", "Info.plist"), infoPlist());
  sh(["swiftc", "-O", "-o", EXECUTABLE, SOURCE]);
  writeFileSync(STAMP, hash + "\n");
  sh(["codesign", "--force", "--sign", "-", "--identifier", BUNDLE_ID, APP]);
  return { built: true };
}

/** The grants as macOS records them for the app. Run through `open` so the app, not this
 *  terminal, is the process macOS asks about. `request` also shows a prompt for each grant
 *  not yet asked and waits until every one is answered. */
export function status(request = false): Record<string, string> {
  const out = join(tmpdir(), `relayhost-status-${process.pid}.json`);
  rmSync(out, { force: true });
  sh(["open", "-n", "-W", APP, "--args", request ? "--request" : "--status", out]);
  const s = JSON.parse(readFileSync(out, "utf8"));
  rmSync(out, { force: true });
  return s;
}

if (import.meta.main) {
  if (process.argv.includes("--request")) console.log(JSON.stringify(status(true), null, 2));
  else if (process.argv.includes("--status")) console.log(JSON.stringify(status(), null, 2));
  else { const r = build(); console.log(`${r.built ? "built" : "unchanged"} ${EXECUTABLE}`); }
}
