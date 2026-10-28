import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface VoiceClient {
  attachments: {
    upload(input: { fileName: string; data: Uint8Array }): Promise<{ attachment: { guid: string } }>;
  };
  messages: {
    sendAttachment(chat: string, attachment: string, options?: { isAudioMessage?: boolean }): Promise<{ guid: string; dateCreated?: Date }>;
  };
}

/** Convert synthesized MP3 bytes to the CAF/Opus format used by iPhone voice notes. */
export async function toNativeVoice(
  input: Buffer,
  deps: { exec?: (cmd: string, args: string[]) => Promise<unknown> } = {},
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "relay-native-voice-"));
  const source = join(dir, "in.mp3");
  const output = join(dir, "out.caf");
  try {
    await chmod(dir, 0o700);
    await writeFile(source, input, { mode: 0o600 });
    await chmod(source, 0o600);
    await (deps.exec ?? ((cmd, args) => execFileP(cmd, args)))
      ("afconvert", ["-f", "caff", "-d", "opus@48000", "-c", "1", source, output]);
    await chmod(output, 0o600);
    const result = await readFile(output);
    if (result.length === 0) throw new Error("afconvert produced an empty CAF voice note");
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function sendNativeVoice(client: VoiceClient, chatGuid: string, audio: Buffer): Promise<{ id: string; timestamp?: Date }> {
  const caf = await toNativeVoice(audio);
  const uploaded = await client.attachments.upload({ fileName: "Audio Message.caf", data: caf });
  const message = await client.messages.sendAttachment(chatGuid, uploaded.attachment.guid, { isAudioMessage: true });
  return { id: message.guid, timestamp: message.dateCreated };
}

/** Return Spectrum's authenticated raw iMessage client for the given provider phone. */
export function remoteClient(app: any, phone: string): VoiceClient & { messages: any; attachments: any } {
  const entries = app.__internal?.platforms?.get("iMessage")?.client;
  if (!Array.isArray(entries)) throw new Error("iMessage remote client unavailable");
  const entry = entries.find((candidate: any) => candidate.phone === phone);
  const client = entry?.client;
  if (!client?.attachments?.upload || !client.attachments.downloadStream || !client?.messages?.sendAttachment || !client.messages.get) {
    throw new Error("iMessage voice client contract unavailable");
  }
  return client;
}
