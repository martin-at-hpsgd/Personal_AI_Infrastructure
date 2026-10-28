#!/usr/bin/env bun
/**
 * Countersign.ts — set or check the texting countersign. The phrase is read from
 * STDIN (never argv, never shell history) and only its sha256 over the
 * normalized form (lowercase, letters+digits only) is stored in bridge-config.json.
 *
 *   printf '%s' 'the phrase' | bun Countersign.ts set
 *   printf '%s' 'a guess'    | bun Countersign.ts check   → exit 0 on match
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG = join(homedir(), ".claude/LIFEOS/USER/RELAY/state/bridge-config.json");
const core = await import(join(homedir(), ".claude/hooks/lib/texting-guard-core.ts"));

const mode = process.argv[2];
const phrase = (await Bun.stdin.text()).trim();
if (!phrase || (mode !== "set" && mode !== "check")) { console.error("usage: printf '%s' '<phrase>' | bun Countersign.ts set|check"); process.exit(2); }
const norm = core.normalizePhrase(phrase);
if (norm.length < 4) { console.error("phrase too short after normalization"); process.exit(2); }
const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
if (mode === "set") {
  if (!cfg.countersignSalt) cfg.countersignSalt = require("node:crypto").randomBytes(16).toString("hex");
  const hash = core.countersignHash(phrase, cfg.countersignSalt);
  cfg.countersignSha256 = hash;
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  console.log(`countersign set (sha256 ${hash.slice(0, 8)}…, ${norm.length} normalized chars)`);
} else {
  const ok = cfg.countersignSha256 === core.countersignHash(phrase, cfg.countersignSalt);
  console.log(ok ? "match" : "no match");
  process.exit(ok ? 0 : 1);
}
