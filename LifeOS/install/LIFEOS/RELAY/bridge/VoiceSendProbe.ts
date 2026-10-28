#!/usr/bin/env bun
/**
 * Live one-shot diagnostic for native iMessage voice notes. It SENDS A REAL VOICE NOTE TO THE PRINCIPAL'S OWN LINE: run it once on
 * purpose, never from a test and never in a loop.
 *
 *   bun LIFEOS/RELAY/bridge/VoiceSendProbe.ts --text-principal [text to speak]
 *
 * Without --text-principal as the first argument it exits 2 and sends nothing, the same guard CardProbe.ts carries: a loose
 * `fd Probe.ts` lookup can pick this file instead of Probe.ts.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { AttachmentInfo, DownloadAttachmentChunk } from "@photon-ai/advanced-imessage";
import { ConversationStore, recordSend } from "./conversation.ts";
import { loadConfig } from "./session.ts";
import { synthesizeSpeech } from "./voice.ts";
import { remoteClient, sendNativeVoice } from "./voice-send.ts";

const [flag, ...words] = process.argv.slice(2);
if (flag !== "--text-principal") {
  console.error("VoiceSendProbe sends a voice note to the principal's own line. Run it only on purpose: bun LIFEOS/RELAY/bridge/VoiceSendProbe.ts --text-principal [text]");
  process.exit(2);
}

const execFileP = promisify(execFile);
const env: Record<string, string> = {};
for (const line of readFileSync(join(homedir(), ".claude/.env"), "utf8").split("\n")) {
  const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match) env[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
}
const projectId = env.PHOTON_PROJECT_ID;
const projectSecret = env.PHOTON_PROJECT_SECRET;
if (!projectId || !projectSecret) throw new Error("PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET missing from ~/.claude/.env");

const cfg = loadConfig();
// The principal's own line is ownChannels.numbers
if (cfg.ownChannels.numbers.length !== 1) throw new Error("ownChannels.numbers must name exactly one line");
const to = cfg.ownChannels.numbers[0]!;
const text = words.join(" ") ||"This is a test voice note from Tex. If you can hear this, voice notes work.";
const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
const im = imessage(app);
const space = await im.space.create(to);
const client = remoteClient(app, imessage(space).phone);
const { buffer } = await synthesizeSpeech(text);
const sent = await recordSend(new ConversationStore(), to, space.id, `[Voice note] ${text}`, "notification", () => sendNativeVoice(client, space.id, buffer));

const summarize = (message: any) => ({
  messageId: sent.id,
  isAudioMessage: message.isAudioMessage,
  isSent: message.isSent,
  isDelivered: message.isDelivered,
  attachments: ((message.content?.attachments ?? message.attachments ?? []) as AttachmentInfo[]).map(attachment => ({
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    uti: attachment.uti,
    totalBytes: attachment.totalBytes,
  })),
});

let message = await client.messages.get(sent.id);
console.log(JSON.stringify(summarize(message)));
const attachment = (message.content?.attachments ?? message.attachments)?.[0] as AttachmentInfo | undefined;
if (!attachment) throw new Error("sent voice note has no attachment");
const dir = mkdtempSync(join(tmpdir(), "relay-voice-send-probe-"));
try {
  chmodSync(dir, 0o700);
  const path = join(dir, "Audio Message.caf");
  const chunks: Uint8Array[] = [];
  for await (const frame of client.attachments.downloadStream(attachment.guid) as AsyncIterable<DownloadAttachmentChunk>) {
    if (frame.type === "primaryChunk") chunks.push(frame.data);
  }
  writeFileSync(path, Buffer.concat(chunks), { mode: 0o600 });
  chmodSync(path, 0o600);
  const probe = await execFileP("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=format_name,duration", "-of", "json", path]);
  console.log(probe.stdout);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

for (let attempt = 0; attempt < 10 && !message.isDelivered; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  message = await client.messages.get(sent.id);
}
console.log(JSON.stringify(summarize(message)));
process.exit(0);
