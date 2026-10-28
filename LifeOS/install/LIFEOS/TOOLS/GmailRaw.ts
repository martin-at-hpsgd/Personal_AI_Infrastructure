#!/usr/bin/env bun
/**
 * @version 1.0.0
 */
// Print Gmail's raw RFC 822 source, or the readable text from every HTML MIME part.
//
// Usage:
//   bun LIFEOS/TOOLS/GmailRaw.ts <messageId> [<messageId> ...] [--account <name>] [--text]
//
// `--account <name>` selects {lifeosUserDir}/CONFIG/CREDENTIALS/google/<name>.json,
// exactly as gmail.ts does.  The default credential resolution is likewise shared.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadLifeosConfig, lifeosUserDir } from "./LifeosConfig";

type Creds = { client_id: string; client_secret: string; refresh_token: string };
type MimePart = { headers: Map<string, string>; body: string };

const USAGE = `Usage: bun LIFEOS/TOOLS/GmailRaw.ts <messageId> [<messageId> ...] [--account <name>] [--text]

Print Gmail's decoded raw MIME source. With --text, print readable text from every
text/html MIME part (including quoted-printable and base64 encoded parts).
`;

function parseArgs(argv: string[]): { ids: string[]; account: string | null; text: boolean; help: boolean } {
  const ids: string[] = [];
  let account: string | null = null;
  let text = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ids, account, text, help: true };
    if (arg === "--text") { text = true; continue; }
    if (arg === "--account") {
      account = argv[++i] ?? null;
      if (!account) throw new Error("--account requires a name");
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    ids.push(arg);
  }
  return { ids, account, text, help: false };
}

function resolveCredsPath(account: string | null): string {
  if (account) {
    const p = join(lifeosUserDir(), "CONFIG/CREDENTIALS/google", `${account.replace(/\.json$/, "")}.json`);
    if (!existsSync(p)) throw new Error(`no credential for --account ${account}: ${p}`);
    return p;
  }
  const envOverride = process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE?.replace(/^\$HOME/, homedir());
  if (envOverride) return envOverride;
  try {
    const cfg = loadLifeosConfig();
    const fromConfig = cfg.integrations?.google?.credentialsFile;
    if (typeof fromConfig === "string" && fromConfig.length > 0)
      return fromConfig.replace(/^\$HOME/, homedir()).replace(/^~/, homedir());
  } catch { /* LifeosConfig unavailable on fresh install — fall through */ }
  return join(lifeosUserDir(), "CONFIG/CREDENTIALS/google/credentials.json");
}

async function accessToken(creds: Creds): Promise<string> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    signal: AbortSignal.timeout(30_000), method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...creds, grant_type: "refresh_token" }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${body}`);
  const token = JSON.parse(body) as { access_token?: string };
  if (!token.access_token) throw new Error("token refresh returned no access_token");
  return token.access_token;
}

async function rawMessage(id: string, token: string): Promise<string> {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=raw`, {
    signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${token}` },
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${body}`);
  const json = JSON.parse(body) as { raw?: string };
  if (!json.raw) throw new Error("Gmail response contained no raw MIME data");
  return Buffer.from(json.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function splitHeaders(source: string): MimePart {
  const match = /\r?\n\r?\n/.exec(source);
  const headerText = match ? source.slice(0, match.index) : source;
  const body = match ? source.slice(match.index + match[0].length) : "";
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function parameter(value: string, name: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^\"]*)"|([^;\\s]*))`, "i").exec(value);
  return match?.[1] ?? match?.[2] ?? null;
}

function decodeTransfer(body: string, encoding: string): string {
  if (/base64/i.test(encoding)) return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
  if (/quoted-printable/i.test(encoding)) {
    const bytes: number[] = [];
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "=" && body[i + 1] === "\r" && body[i + 2] === "\n") { i += 2; continue; }
      if (body[i] === "=" && body[i + 1] === "\n") { i += 1; continue; }
      if (body[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(body.slice(i + 1, i + 3))) { bytes.push(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; continue; }
      bytes.push(...Buffer.from(body[i], "utf8"));
    }
    return Buffer.from(bytes).toString("utf8");
  }
  return body;
}

function htmlToText(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot);|&#39;|&#(\d+);|&#x([\da-f]+);/gi, (entity, named, decimal, hex) => {
      if (named) return ({ nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"' } as Record<string, string>)[named.toLowerCase()];
      if (entity.toLowerCase() === "&#39;") return "'";
      const code = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }).replace(/\s+/g, " ").trim();
}

/** Extracts readable content from every text/html part in a decoded RFC 822 message. */
export function extractHtmlText(mime: string): string {
  const visit = (source: string): string[] => {
    const part = splitHeaders(source);
    const contentType = part.headers.get("content-type") ?? "text/plain";
    if (/^multipart\//i.test(contentType)) {
      const boundary = parameter(contentType, "boundary");
      if (!boundary) return [];
      const marker = `--${boundary}`;
      const children = part.body.split(/\r?\n/).reduce<string[]>((out, line) => {
        if (line === marker || line === `${marker}--`) out.push("");
        else if (out.length) out[out.length - 1] += (out[out.length - 1] ? "\n" : "") + line;
        return out;
      }, []).filter(Boolean);
      return children.flatMap(visit);
    }
    if (!/^text\/html(?:;|$)/i.test(contentType)) return [];
    return [htmlToText(decodeTransfer(part.body, part.headers.get("content-transfer-encoding") ?? ""))].filter(Boolean);
  };
  return visit(mime).join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE); return; }
  if (!args.ids.length) throw new Error(USAGE.trim());
  const creds = JSON.parse(readFileSync(resolveCredsPath(args.account), "utf8")) as Creds;
  const token = await accessToken(creds);
  for (const [index, id] of args.ids.entries()) {
    const raw = await rawMessage(id, token);
    if (args.ids.length > 1) process.stdout.write(`=== ${id} ===\n`);
    process.stdout.write(args.text ? `${extractHtmlText(raw)}\n` : raw.endsWith("\n") ? raw : `${raw}\n`);
    if (args.ids.length > 1 && index < args.ids.length - 1) process.stdout.write("\n");
  }
}

if (import.meta.main) main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
