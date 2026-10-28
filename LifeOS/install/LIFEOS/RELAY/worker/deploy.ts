#!/usr/bin/env bun
/**
 * Ships the `lifeos-tex` Worker (Relay ISA F28).
 *
 *   bun LIFEOS/RELAY/worker/deploy.ts deploy     `cf deploy` through CfEnv (its review gate and release record run)
 *   bun LIFEOS/RELAY/worker/deploy.ts secrets    BRIDGE_TOKEN (Keychain, created there once), DA_NAME and PRINCIPAL_NAME (the
 *                                                names calls and notices speak, from the identity; `deploy` pushes
 *                                                them too), PRINCIPAL_HANDLES (the
 *                                                root-owned allowlist pin when present, else the bridge config's own
 *                                                numbers; an unsafe pin refuses the push), and the Linq keys from .env
 *   bun LIFEOS/RELAY/worker/deploy.ts token      print nothing; exit 0 when the bridge token is in the Keychain
 *   bun LIFEOS/RELAY/worker/deploy.ts passphrase set the call passphrase at a hidden prompt; only a salted hash is kept
 *                                                (USER/RELAY/call-passphrase.json) and pushed as PASSPHRASE_CHECK
 *   bun LIFEOS/RELAY/worker/deploy.ts pronunciations  push USER/PRINCIPAL/PRONUNCIATIONS.json as PRONUNCIATIONS, so call
 *                                                lines say words the way every other voice does (Fish voice ISA F7)
 *   bun LIFEOS/RELAY/worker/deploy.ts voice P:V  set the call voice: Fish:<reference id>:<speed> ({{DA_NAME}}'s own voice, with the
 *                                                Fish key and model), or Google:en-US-Journey-D
 *
 * Secret values only ever travel on stdin to CfEnv: never an argument, a file or a log line.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lifeosPath } from "../../TOOLS/Paths.ts";
import { type AllowPin, pinnedAllowFrom } from "../bridge/session.ts";
import { getDAName, getPrincipalName } from "../../../hooks/lib/identity";

const DIR = import.meta.dir;
const CF_ENV = resolve(DIR, "..", "..", "TOOLS", "CfEnv.ts");
export const WORKER_NAME = "lifeos-tex";
export const KEYCHAIN_SERVICE = "lifeos-tex-bridge";
const LINQ_KEYS = ["LINQ_API_KEY", "LINQ_WEBHOOK_SECRET"];
/** F29: Worker secret ← .env key. */
const CALL_ENV_KEYS: [string, string][] = [["TWILIO_AUTH_TOKEN", "TWILIO_AUTH_TOKEN"], ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_LIFEOS"]];
/** The call voice unless the bridge config names another: {{DA_NAME}}'s one voice, the Fish clone in [da.voices.main] (ISC-396). */
export async function defaultCallVoice(): Promise<string> {
  const { resolveFishVoice } = await import("../../TOOLS/FishTTS.ts");
  const { referenceId, speed } = resolveFishVoice("main");
  return `Fish:${referenceId}:${speed ?? 1}`;
}

/**
 * The names the Worker speaks (DA_NAME, PRINCIPAL_NAME), from the install's identity: the assistant's name and the
 * principal's first name. Never a template token: an unset identity refuses the push rather than send a placeholder.
 */
export function callNames(read: { da: string; principal: string } = { da: getDAName(), principal: getPrincipalName() }): { da: string; principal: string } | null {
  const da = read.da.trim();
  const principal = read.principal.trim().split(/\s+/)[0] ?? "";
  if (!da || !principal || /[{}]/.test(da + principal)) return null;
  return { da, principal };
}

function putNames(): boolean {
  const names = callNames();
  if (!names) { console.error("DA_NAME / PRINCIPAL_NAME: the identity names no assistant or principal yet, or still holds a template token"); return false; }
  return putSecret("DA_NAME", names.da) && putSecret("PRINCIPAL_NAME", names.principal);
}

/** The bridge token, read from (or, when `create`, minted into) the login Keychain. */
export function bridgeToken(create = false): string | null {
  const read = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8" });
  if (read.status === 0 && read.stdout.trim()) return read.stdout.trim();
  if (!create) return null;
  const token = randomBytes(32).toString("hex");
  // Through `security -i` on stdin, so the token is never an argument another process can read from ps.
  const add = spawnSync("security", ["-i"], { input: `add-generic-password -a lifeos -s ${KEYCHAIN_SERVICE} -w ${token} -U\n`, encoding: "utf8" });
  return add.status === 0 ? token : null;
}

/** The call passphrase's salted hash (Relay F29). Its own file: the text countersign was retired by ISC-84. */
const PASSPHRASE_FILE = lifeosPath("USER", "RELAY", "call-passphrase.json");
function callPassphrase(): { salt: string; sha256: string } | null {
  try { const p = JSON.parse(readFileSync(PASSPHRASE_FILE, "utf8")); return /^[0-9a-f]{64}$/.test(p.sha256) ? p : null; } catch { return null; }
}

/** One line from the terminal with echo off, or from stdin when piped. */
async function readPhrase(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim();
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let out = "";
  return new Promise(resolve => {
    process.stdin.on("data", (b: Buffer) => {
      for (const ch of b.toString("utf8")) {
        if (ch === "\r" || ch === "\n") { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); resolve(out.trim()); return; }
        if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (ch === "\u007f") out = out.slice(0, -1); else out += ch;
      }
    });
  });
}

function putSecret(name: string, stdin?: string, envKey?: string): boolean {
  const args = [CF_ENV, "secret", "put", name, "--name", WORKER_NAME, ...(stdin === undefined ? ["--from-env", ...(envKey ? [envKey] : [])] : [])];
  const r = spawnSync("bun", args, { cwd: DIR, input: stdin, stdio: [stdin === undefined ? "ignore" : "pipe", "inherit", "inherit"] });
  return r.status === 0;
}

/** USER/PRINCIPAL/PRONUNCIATIONS.json as one secret (under the 5 KB Worker limit, checked here so it fails loud). */
export function pronunciationsSecret(path: string = lifeosPath("USER", "PRINCIPAL", "PRONUNCIATIONS.json")): string {
  const map = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const value = JSON.stringify(Object.fromEntries(Object.entries(map).filter(([, v]) => typeof v === "string")));
  if (new TextEncoder().encode(value).length > 5000) throw new Error("PRONUNCIATIONS.json is over the 5 KB Worker secret limit");
  return value;
}

function hasEnv(key: string): boolean {
  return spawnSync("bun", [join(DIR, "..", "..", "TOOLS", "Secrets.ts"), "has", key], { stdio: "ignore" }).status === 0;
}

/**
 * ISC-261.2: who the call line admits. The root-owned pin, when present, is the whole list, so editing the bridge
 * config cannot add a caller; an unsafe pin refuses the push rather than fall back. No pin keeps the config's numbers.
 */
export function callHandles(cfg: { ownChannels?: { numbers?: string[] }; allowFrom?: string[] }, pin: AllowPin): { ok: true; handles: string[] } | { ok: false; reason: string } {
  if (pin.state === "unsafe") return { ok: false, reason: `allowlist pin is unsafe (${pin.reason}); refusing to push PRINCIPAL_HANDLES` };
  const source = pin.state === "pinned" ? pin.allowFrom : (cfg.ownChannels?.numbers ?? cfg.allowFrom ?? []);
  const handles = source.filter(n => /^\+\d{8,15}$/.test(n));
  if (handles.length === 0) return { ok: false, reason: pin.state === "pinned" ? "allowlist pin names no number" : "bridge config names no own number" };
  return { ok: true, handles };
}

async function main(argv: string[]): Promise<number> {
  switch (argv[0]) {
    case "deploy":
      // A deploy keeps the spoken names current: cf deploy leaves a declared secret as it is, so they are pushed after it.
      if ((spawnSync("bun", [CF_ENV, "deploy"], { cwd: DIR, stdio: "inherit" }).status ?? 1) !== 0) return 1;
      return putNames() ? 0 : 1;
    case "secrets": {
      const token = bridgeToken(true);
      if (!token) { console.error("could not read or create the bridge token in the Keychain"); return 1; }
      const cfg = JSON.parse(readFileSync(lifeosPath("USER", "RELAY", "state", "bridge-config.json"), "utf8")) as { ownChannels?: { numbers?: string[] }; allowFrom?: string[]; countersignSha256?: string; countersignSalt?: string; callVoice?: string };
      const caller = callHandles(cfg, pinnedAllowFrom());
      if (!caller.ok) { console.error(caller.reason); return 1; }
      const handles = caller.handles;
      let ok = putSecret("BRIDGE_TOKEN", token);
      ok = putSecret("PRINCIPAL_HANDLES", handles.join(",")) && ok;
      for (const key of LINQ_KEYS) {
        if (hasEnv(key)) ok = putSecret(key) && ok;
        else console.log(`${key}: not in .env yet, skipped`);
      }
      // F29: the talker, the passphrase hash, and the voice.
      for (const [name, envKey] of CALL_ENV_KEYS) {
        if (hasEnv(envKey)) ok = putSecret(name, undefined, envKey) && ok;
        else { console.error(`${envKey}: not in .env`); ok = false; }
      }
      const { currentModel } = await import("../../TOOLS/models.ts");
      ok = putSecret("TALKER_MODEL", currentModel("haiku")) && ok;
      const pass = callPassphrase();
      if (!pass) { console.error(`no call passphrase yet: run \`bun ${join(DIR, "deploy.ts")} passphrase\` in a terminal`); ok = false; }
      else ok = putSecret("PASSPHRASE_CHECK", `${pass.salt}:${pass.sha256}`) && ok;
      const voice = cfg.callVoice ?? await defaultCallVoice();
      if (voice.startsWith("Fish:")) {
        const { CROSS_VENDOR } = await import("../../TOOLS/models.ts");
        ok = (hasEnv("FISH_API_KEY") && putSecret("FISH_API_KEY")) && ok;
        ok = putSecret("FISH_MODEL", CROSS_VENDOR.fishVoice) && ok;
      }
      ok = putSecret("CALL_VOICE", voice) && ok;
      ok = putSecret("PRONUNCIATIONS", pronunciationsSecret()) && ok;
      ok = putNames() && ok;
      return ok ? 0 : 1;
    }
    case "passphrase": {
      // {{PRINCIPAL_NAME}} types the phrase at a hidden prompt; only a salted hash is kept, then the Worker gets the new check.
      const phrase = await readPhrase("New call passphrase (hidden): ");
      const norm = phrase.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (norm.length < 6) { console.error("too short: use at least two words"); return 2; }
      const salt = randomBytes(16).toString("hex");
      const sha256 = createHash("sha256").update(salt + norm).digest("hex");
      writeFileSync(PASSPHRASE_FILE, `${JSON.stringify({ salt, sha256, set: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
      console.log("✓ call passphrase saved (hash only)");
      return putSecret("PASSPHRASE_CHECK", `${salt}:${sha256}`) ? 0 : 1;
    }
    case "voice": {
      // provider:voice. Not secret; a secret binding is how cf keeps it. Fish also needs its key and model (ISC-396).
      const v = argv[1] ?? "";
      if (!/^(Fish|Google|Amazon):\S+$/.test(v)) { console.error("usage: deploy.ts voice <Fish|Google|Amazon>:<voice>"); return 2; }
      if (v.startsWith("Fish:")) {
        if (!hasEnv("FISH_API_KEY")) { console.error("FISH_API_KEY: not in .env"); return 1; }
        const { CROSS_VENDOR } = await import("../../TOOLS/models.ts");
        if (!putSecret("FISH_API_KEY") || !putSecret("FISH_MODEL", CROSS_VENDOR.fishVoice) || !putSecret("PRONUNCIATIONS", pronunciationsSecret())) return 1;
      }
      return putSecret("CALL_VOICE", v) ? 0 : 1;
    }
    case "pronunciations":
      return putSecret("PRONUNCIATIONS", pronunciationsSecret()) ? 0 : 1;
    case "token":
      return bridgeToken(false) ? 0 : 1;
    default:
      console.error("usage: deploy.ts deploy | secrets | pronunciations | token");
      return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
