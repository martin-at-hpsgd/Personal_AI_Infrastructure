#!/usr/bin/env bun
/**
 * DetectInference — Setup step 5.5. Finds the Claude and Codex logins already on this machine and writes
 * `LIFEOS/USER/CONFIG/inference-vendor.json` (the file LIFEOS/TOOLS/Inference.ts `loadVendorConfig` reads)
 * from what it found. It detects which vendor CLIs are signed in and never reads out or writes a credential
 * (`anthropic` = the signed-in claude CLI, `openai` = the signed-in codex CLI with a ChatGPT login).
 *
 *   bun DetectInference.ts            dry run: prints what it found and the file it would write
 *   bun DetectInference.ts --apply    writes the file (only over the shipped template or its own earlier write)
 *   bun DetectInference.ts --apply --force   also replaces a hand-edited file
 *
 * Login evidence is presence only; no credential is read into output:
 *   claude  — CLAUDE_CODE_OAUTH_TOKEN set; or <configRoot>/.credentials.json; or `oauthAccount` in ~/.claude.json
 *             (or $CLAUDE_CONFIG_DIR/.claude.json); or, on macOS, a "Claude Code-credentials" Keychain item
 *             (existence check, `security find-generic-password` without -w).
 *   codex   — ~/.codex/auth.json holding ChatGPT `tokens` (the file Inference.ts requires; an auth.json
 *             without a ChatGPT login does not count, since the openai vendor runs on that login).
 * Test seams: LIFEOS_DETECT_HOME (home dir), LIFEOS_DETECT_CONFIG_ROOT, LIFEOS_DETECT_KEYCHAIN=off.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { claudeDirFor, invariant } from "./lib/claude-dir";

export type Vendor = "anthropic" | "openai";
export interface Login { installed: boolean; loggedIn: boolean; via: string | null }
export interface Detected { claude: Login; codex: Login }
export interface VendorFile { _doc: string; _source: "DetectInference"; default: Vendor; fallback?: Vendor }

const SOURCE = "DetectInference";

function readJson(path: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch { return null; }
}

function onPath(bin: string, home: string): boolean {
  return Boolean(Bun.which(bin)) || existsSync(join(home, ".local", "bin", bin));
}

export function detectLogins(opts: { home: string; configRoot: string; env: Record<string, string | undefined>; keychain: boolean }): Detected {
  const { home, configRoot, env } = opts;
  let claudeVia: string | null = null;
  if ((env.CLAUDE_CODE_OAUTH_TOKEN ?? "").length > 0) claudeVia = "CLAUDE_CODE_OAUTH_TOKEN";
  else if (readJson(join(configRoot, ".credentials.json"))?.claudeAiOauth) claudeVia = `${configRoot}/.credentials.json`;
  else {
    for (const f of [env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : null, join(home, ".claude.json")]) {
      const acct = f ? readJson(f)?.oauthAccount : undefined;
      if (acct && typeof acct === "object") { claudeVia = `${f} oauthAccount`; break; }
    }
  }
  if (!claudeVia && opts.keychain && process.platform === "darwin") {
    const r = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials"], { stdout: "ignore", stderr: "ignore", timeout: 10_000 });
    if (r.exitCode === 0) claudeVia = "macOS Keychain (Claude Code-credentials)";
  }
  const auth = readJson(join(home, ".codex", "auth.json"));
  const codexVia = auth?.tokens && typeof auth.tokens === "object" ? `${join(home, ".codex", "auth.json")} (ChatGPT login)` : null;
  return {
    claude: { installed: onPath("claude", home), loggedIn: claudeVia !== null, via: claudeVia },
    codex: { installed: onPath("codex", home), loggedIn: codexVia !== null, via: codexVia },
  };
}

/** The vendor file for what was found. Claude first (the harness itself), codex as the fallback when present. */
export function vendorFileFor(d: Detected, today: string): VendorFile {
  const found = `claude ${d.claude.loggedIn ? "yes" : "no"}, codex ${d.codex.loggedIn ? "yes" : "no"}`;
  const doc = `Written by skills/LifeOS/Tools/DetectInference.ts on ${today} from the logins found (${found}). ` +
    "anthropic = the claude CLI on your Claude subscription; openai = codex on your ChatGPT plan. Neither uses an API key. " +
    "Edit freely; see LIFEOS/DOCUMENTATION/Setup/Inference.md.";
  if (d.claude.loggedIn && d.codex.loggedIn) return { _doc: doc, _source: SOURCE, default: "anthropic", fallback: "openai" };
  if (d.codex.loggedIn) return { _doc: doc, _source: SOURCE, default: "openai" };
  return { _doc: doc, _source: SOURCE, default: "anthropic" };
}

/** The settings of a vendor file: every key but the `_`-prefixed notes, in a stable order. */
function settingsOf(f: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(f).filter((k) => !k.startsWith("_")).sort().map((k) => [k, f[k]]));
}

/**
 * Our own earlier write, still as we wrote it. The `_source` marker survives a hand edit of `default` or `fallback`,
 * so it alone proves nothing: the settings must still be the ones vendorFileFor produces for the logins the `_doc`
 * recorded. Anything else is the user's edit.
 */
function unchangedOwnWrite(current: Record<string, unknown>): boolean {
  if (current._source !== SOURCE || typeof current._doc !== "string") return false;
  const m = /from the logins found \(claude (yes|no), codex (yes|no)\)/.exec(current._doc);
  if (!m) return false;
  const login = (yes: boolean): Login => ({ installed: yes, loggedIn: yes, via: null });
  const ours = vendorFileFor({ claude: login(m[1] === "yes"), codex: login(m[2] === "yes") }, "");
  return settingsOf(current) === settingsOf(ours as unknown as Record<string, unknown>);
}

/** True when the file on disk is ours to replace: absent, unreadable, the shipped template, or our own earlier write left unedited. */
export function replaceable(current: Record<string, unknown> | null): boolean {
  if (!current) return true;
  if (unchangedOwnWrite(current)) return true;
  const keys = Object.keys(current).filter((k) => !k.startsWith("_")).sort().join(",");
  return keys === "default,fallback" && current.default === "anthropic" && current.fallback === "openai";
}

function userDir(configRoot: string): string {
  return join(configRoot, "LIFEOS", "USER");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const force = args.includes("--force");
  const home = process.env.LIFEOS_DETECT_HOME ?? homedir();
  const configRoot = process.env.LIFEOS_DETECT_CONFIG_ROOT ?? claudeDirFor(process.env, home);
  const detected = detectLogins({ home, configRoot, env: process.env, keychain: process.env.LIFEOS_DETECT_KEYCHAIN !== "off" });
  const target = join(userDir(configRoot), "CONFIG", "inference-vendor.json");
  const current = existsSync(target) ? readJson(target) : null;
  const next = vendorFileFor(detected, new Date().toISOString().slice(0, 10));
  const mayWrite = force || !existsSync(target) || replaceable(current);
  const loginHint = !detected.claude.loggedIn && !detected.codex.loggedIn
    ? "no Claude or Codex login found: run `claude` and sign in (or `codex login`), then re-run this. No API key is needed."
    : null;
  let written = false;
  let kept: string | null = null;
  if (apply && mayWrite) {
    invariant(next.default === "anthropic" || next.default === "openai", "default must be a subscription vendor");
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, target);
    written = true;
  } else if (apply) {
    kept = "the file was edited by hand; left as is (pass --force to replace it)";
  }
  console.log(JSON.stringify({ ok: true, dryRun: !apply, detected, target, wouldWrite: next, written, kept, loginHint }, null, 2));
}
