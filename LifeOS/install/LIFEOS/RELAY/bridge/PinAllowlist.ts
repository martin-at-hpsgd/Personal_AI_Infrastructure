#!/usr/bin/env bun
/**
 * PinAllowlist.ts — Relay F20 ISC-261: print the root-owned allowlist pin command for the principal to run once.
 *
 * Run as the principal (never under sudo): it reads today's allowFrom from bridge-config.json and prints the one
 * command that writes it to ALLOWFROM_PIN as root. The command itself runs no repo code as root (install, tee, chmod
 * only), so a tampered checkout cannot use the sudo step. After it runs, restart the bridge; bridge_starting logs
 * allowFromPin: "pinned". To change the allowlist later, rerun this and the printed command.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ALLOWFROM_PIN, CONFIG, pinnedAllowFrom } from "./session.ts";

const allowFrom: unknown = JSON.parse(readFileSync(CONFIG, "utf8")).allowFrom;
if (!Array.isArray(allowFrom) || !allowFrom.length || !allowFrom.every(n => typeof n === "string" && /^\+[0-9]{8,15}$/.test(n))) {
  console.error("bridge-config.json allowFrom is not a list of +E.164 numbers; fix it before pinning");
  process.exit(1);
}
const body = JSON.stringify({ allowFrom });
console.error(`pinning ${allowFrom.length} number(s), ending ${allowFrom.map(n => n.slice(-4)).join(", ")}; current pin: ${pinnedAllowFrom().state}`);
// ISC-261.3: the printed line looks like a finished step, so the last thing on screen says it is not one.
process.on("exit", () => console.error("Nothing applied yet. Run the sudo line above in a terminal (it asks for your password), then restart the bridge."));
console.log(`sudo install -d -o root -g wheel -m 755 ${dirname(ALLOWFROM_PIN)} && printf '%s\\n' '${body}' | sudo tee ${ALLOWFROM_PIN} >/dev/null && sudo chown root:wheel ${ALLOWFROM_PIN} && sudo chmod 644 ${ALLOWFROM_PIN}`);
