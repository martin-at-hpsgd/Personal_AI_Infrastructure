#!/usr/bin/env bun
/**
 * Live one-shot diagnostic for Relay ISA F13 (ISC-169): one real card goes to the principal's own line through send.ts's own argv parser and
 * relaySend, and the message reads back from the conversation store byte-identical with markdown on. It TEXTS THE PRINCIPAL: the main
 * session runs it once at land, never a test and never a loop.
 *
 *   bun LIFEOS/RELAY/bridge/CardProbe.ts --text-principal
 *
 * Without --text-principal it exits 2 and sends nothing: on 2026-10-11 a `fd Probe.ts | head -1` lookup picked this file instead of Probe.ts
 * and a three-step probe loop texted the principal the card three times.
 *
 * Exit 0 and one JSON line `{ "ok": true, ... }` when the stored text equals the card and the transport was handed md true; exit 1 otherwise.
 * The card carries the time, so a screenshot of it is easy to find. ISC-140 (how it looks on the phone) is his look.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { textCard } from "../../TOOLS/TextFormat.ts";
import { CONVERSATIONS } from "./conversation.ts";
import { loadConfig } from "./session.ts";
import { parseSendArgs, photonTransmit, relaySend, type RelayTransmitArgs } from "./send.ts";

if (process.argv.slice(2).join(" ") !== "--text-principal") {
  console.error("CardProbe texts the principal's own line. Run it only on purpose: bun LIFEOS/RELAY/bridge/CardProbe.ts --text-principal");
  process.exit(2);
}

const cfg = loadConfig();
if (cfg.ownChannels.numbers.length !== 1) throw new Error("ownChannels.numbers must name exactly one line");
const to = cfg.ownChannels.numbers[0]!;

const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
const card = textCard({
  kind: "workflow",
  title: "Card probe",
  body: [`Relay F13 live check, ${stamp} UTC.`, "A bold title, an emoji, short lines, the link last.", "snake_case and a*b stay literal."],
  url: "https://example.invalid/card-probe",
});

// The same road a real producer takes: argv, then send.ts's parser, then the gated send. No --md: the card shape alone must turn markdown on.
const parsed = parseSendArgs([to, card, "--origin", "requested"]);
if (!parsed.ok) throw new Error(parsed.usage);
const handed: RelayTransmitArgs[] = [];
const result = await relaySend(parsed.args, { transmit: async (a) => { handed.push(a); return photonTransmit(a); } });
if (!result.ok) { console.log(JSON.stringify({ ok: false, error: result.message })); process.exit(1); }

const messageId = String((result.out as { messageId?: unknown }).messageId ?? "");
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
function stored(id: string): { text: string; direction: string } | null {
  if (!id || !existsSync(CONVERSATIONS)) return null;
  for (const dir of readdirSync(CONVERSATIONS)) {
    const file = join(CONVERSATIONS, dir, `${sha(id)}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  }
  return null;
}
const row = stored(messageId);
const checks = {
  transportGotMarkdown: handed.length === 1 && handed[0]!.md === true,
  transportGotTheCard: handed[0]?.body === card,
  storeHasTheMessage: row !== null && row.direction === "outbound",
  storedTextIsByteIdentical: row?.text === card,
};
const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ ok, messageId, checks }));
process.exit(ok ? 0 : 1);
