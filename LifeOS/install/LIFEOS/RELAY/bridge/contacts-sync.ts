import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(homedir(), ".claude");
const { normalizeNumber } = await import(join(root, "hooks/lib/texting-guard-core.ts"));

/** Sync address-book destinations without exposing contact values in results or errors. */
export function syncContactChannels(opts: { contactsPath?: string; configPath?: string } = {}): { numbers: number; emails: number } {
  const configPath = opts.configPath ?? join(root, "LIFEOS/USER/RELAY/state/bridge-config.json");
  const contactsPath = opts.contactsPath ?? join(root, "LIFEOS/USER/CONTACTS/contacts.jsonl");
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
  } catch { throw new Error("Contact sync requires an existing, valid config object"); }
  const numbers = new Set<string>(), emails = new Set<string>();
  try {
    for (const line of readFileSync(contactsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.class !== "personal" && record.class !== "both") continue;
      for (const email of record.emails ?? []) {
        if (typeof email !== "string") throw new Error();
        if (email.trim()) emails.add(email.trim().toLowerCase());
      }
      for (const phone of record.phones ?? []) {
        if (typeof phone !== "string") throw new Error();
        if (/\d/.test(phone)) numbers.add(normalizeNumber(phone));
      }
    }
  } catch { throw new Error("Contact sync could not read valid contact records"); }
  const temp = `${configPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ ...config, contactChannels: { numbers: [...numbers].sort(), emails: [...emails].sort() } }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, configPath);
    chmodSync(configPath, 0o600);
  } catch { throw new Error("Contact sync could not atomically update config"); }
  finally { rmSync(temp, { force: true }); }
  return { numbers: numbers.size, emails: emails.size };
}
