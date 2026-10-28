/**
 * McpWriteVerbs — the one rule that decides which MCP tools count as writes. On a public install its consumer is the
 * independent denominator (LIFEOS/TOOLS/OutputReconciler.ts), which uses it to classify MCP calls as sends after the fact;
 * this module blocks nothing by itself, and a public install does not gate MCP writes through it.
 * It also holds gatedInput(), what an MCP call will transmit, which the maintainer-side output recorder reads. MCP sends
 * themselves are held by native `ask` rules.
 *
 * THE RULE (inverted 2026-09-30): an mcp__ tool is gated UNLESS it is known to be a read. The last segment of the name is split
 * into words (underscores, camelCase, digits); the FIRST word that is a known verb, read or write, decides. A read verb means
 * not gated. A write verb, a name with no known verb at all, and a name whose only words are unknown (tweet, do_thing,
 * sendmessage) are all gated, so a write tool with an unlisted verb can never skip the gate. The exact-name allowlist
 * (draft-only tool, upload-url lookup) stays. Each verb is matched with its inflections (replies, creating, posted, sent).
 *
 * Known edge, by design: the first verb wins, so get_or_create_x and list_and_comment read as reads, and a read noun in front
 * of a write (status_update, info_set) reads as a read. A server that names tools like that needs an explicit decision.
 *
 * @version 2.0.0
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** The write verbs. A tool whose first known verb is one of these is a write. (export moved to READ_VERBS: an export is a read.) */
export const WRITE_VERBS = [
  "send", "post", "create", "update", "upload", "complete", "add", "schedule", "publish", "share", "reply", "batch", "comment", "invite",
  "forward", "respond", "notify", "tweet", "dm", "push", "merge", "submit", "write", "append", "edit", "put", "insert", "deploy", "attach", "broadcast", "call",
  "delete", "remove", "set", "move", "rename", "archive", "cancel", "approve", "execute", "run", "trigger", "save", "join", "leave", "react", "mark", "close",
] as const;

/** The read verbs. A tool whose first known verb is one of these is NOT gated. */
export const READ_VERBS = [
  "get", "list", "read", "search", "query", "find", "fetch", "describe", "count", "check", "view", "show", "lookup", "guide", "status",
  "info", "help", "preview", "download", "export", "inspect", "watch",
] as const;

/** Exact tool names that are NOT gated though a write verb appears: draft-only tools and read-only lookups. Exact match only, never a substring. */
export const READ_DRAFT_ALLOW: ReadonlySet<string> = new Set([
  "mcp__plugin_slack_slack__slack_send_message_draft",
  "mcp__plugin_slack_slack__slack_get_file_upload_url",
]);

const IRREGULAR: Record<string, string[]> = { send: ["sent"], find: ["found"], get: ["got", "gotten"], write: ["wrote", "written"], show: ["shown"], read: ["reads"] };

/** Every form of a verb we accept: plain, s/es, ed/d, ing, with the e dropped, the y turned to i, and the final consonant doubled. */
function forms(v: string): string[] {
  const out = new Set<string>([v, `${v}s`, `${v}es`, ...(IRREGULAR[v] ?? [])]);
  if (v.endsWith("e")) { out.add(`${v}d`); out.add(`${v.slice(0, -1)}ing`); }
  else { out.add(`${v}ed`); out.add(`${v}ing`); }
  if (/[^aeiou]y$/.test(v)) { out.add(`${v.slice(0, -1)}ies`); out.add(`${v.slice(0, -1)}ied`); }
  if (/[^aeiou]$/.test(v)) { out.add(`${v}${v.slice(-1)}ed`); out.add(`${v}${v.slice(-1)}ing`); }
  return [...out];
}

const KIND = new Map<string, "read" | "write">();
for (const [list, kind] of [[WRITE_VERBS, "write"], [READ_VERBS, "read"]] as const) {
  for (const v of list) for (const f of forms(v)) {
    if (KIND.has(f) && KIND.get(f) !== kind) throw new Error(`McpWriteVerbs: "${f}" is both a read and a write form`);
    KIND.set(f, kind);
  }
}

/** The words of a tool name: split on non-alphanumerics, camelCase and letter/digit edges, lowercased. */
export function nameWords(tool: string): string[] {
  return tool.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Za-z])([0-9])/g, "$1_$2").replace(/([0-9])([A-Za-z])/g, "$1_$2")
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** The kind of the first known verb in the tool's last name segment, or null when no word is a known verb. */
export function firstVerbKind(tool: string): "read" | "write" | null {
  const last = tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
  for (const w of nameWords(last)) { const k = KIND.get(w); if (k) return k; }
  return null;
}

/** True when the tool's first known verb is a write verb (before the allowlist is consulted). */
export function hasWriteVerb(tool: string): boolean {
  return firstVerbKind(tool) === "write";
}

/** Every known verb kind in the tool's last name segment. */
export function verbKinds(tool: string): Set<"read" | "write"> {
  const last = tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
  const out = new Set<"read" | "write">();
  for (const w of nameWords(last)) { const k = KIND.get(w); if (k) out.add(k); }
  return out;
}

/**
 * The one rule: an mcp__ tool is a read, and not gated, only when it is on the exact-name allowlist or its name carries a
 * read verb and no write verb anywhere. A write verb in any position (get_or_create, status_update), an unknown word or
 * no verb at all is gated. Misreading a read as a write costs one proof of its arguments; the reverse lets a send skip the gate.
 */
export function isGatedMcpTool(name: unknown): boolean {
  if (typeof name !== "string" || !/^mcp__/.test(name) || READ_DRAFT_ALLOW.has(name)) return false;
  const k = verbKinds(name);
  return !(k.has("read") && !k.has("write"));
}

/** Every string value at any depth, in key order. Bounded so a hostile input cannot run away. */
function stringsOf(v: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length > 5000 || depth > 20) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) stringsOf(x, out, depth + 1);
  return out;
}

/** The local file a string names (absolute, ~/ or relative to cwd), or null. */
function fileNamed(s: string, cwd: string): string | null {
  if (!s || s.length > 1024 || s.includes("\n") || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
  if (!(s.startsWith("/") || s.startsWith("~/") || s.startsWith("./") || s.startsWith("../") || /^[\w.-]+\/[\w./-]+$/.test(s) || /^[\w-]+(?:\.[\w-]+)*\.\w{1,8}$/.test(s))) return null;
  const x = s.replace(/^~(?=\/|$)/, homedir());
  const abs = isAbsolute(x) ? x : resolve(cwd, x);
  try { return statSync(abs).isFile() ? abs : null; } catch { return null; }
}

/** What the call will transmit: the text (every string field that is not a file path) and the files it names. */
export function gatedInput(toolInput: unknown, cwd: string = process.cwd()): { body: string; attachments: string[] } {
  if (typeof toolInput === "string") return { body: toolInput, attachments: [] };
  if (!toolInput || typeof toolInput !== "object") throw new Error("send input is not an object");
  const attachments: string[] = [];
  const parts: string[] = [];
  for (const s of stringsOf(toolInput)) {
    const f = fileNamed(s, cwd);
    if (f) { if (!attachments.includes(f)) attachments.push(f); } else parts.push(s);
  }
  return { body: parts.length ? parts.join("\n") : JSON.stringify(toolInput), attachments };
}
