#!/usr/bin/env bun
/** Read-only provider contract probe. Never subscribes to app.messages, sends
 * a message, or prints message contents, identifiers, addresses, or credentials. */
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, safeHistoryText } from "./session.ts";
import { ConversationStore } from "./conversation.ts";
import { hydrateConversation, providerClient } from "./provider-context.ts";

const cfg = loadConfig();
const app = await Spectrum({ projectId: cfg.projectId, projectSecret: cfg.projectSecret, providers: [imessage.config()] });
const root = mkdtempSync(join(tmpdir(), "relay-context-probe-"));
try {
  // The principal's own line is ownChannels.numbers
  if (cfg.ownChannels.numbers.length !== 1) throw new Error("ownChannels.numbers must name exactly one line");
  const sender = cfg.ownChannels.numbers[0]!;
  const space = await imessage(app).space.get(`any;-;${sender}`);
  const client = providerClient(app, space.phone);
  const page = await client.messages.listInChat(space.id, { pageSize: 20 });
  const current = page.messages.find(m => !m.isFromMe && m.sender?.address === sender);
  if (!current) throw new Error("No principal inbound found for scoped probe");
  const result = await hydrateConversation(client, new ConversationStore(root), sender, space.id, current.guid, text => safeHistoryText(text, cfg));
  console.log(JSON.stringify({ ok: true, returned: page.messages.length, hydrated: result.count, explicitReply: !!result.replyTo, sent: 0, streamSubscriptions: 0 }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message.replace(/\+?[0-9]{10,}/g, "[REDACTED]").slice(0, 200) : "provider probe failed" }));
  process.exitCode = 1;
} finally { rmSync(root, { recursive: true }); }
process.exit(process.exitCode ?? 0);
