#!/usr/bin/env bun
/**
 * @version 1.0.0
 */
// Sweep one or more mailboxes for a topic, archive every attachment durably, and
// extract text so the result is searchable. Built for the house-document archive
// but topic-agnostic: the queries come from a config file, nothing is hardcoded.
//
//   MailArchive.ts sweep   --config <path>   # query -> message metadata -> manifest
//   MailArchive.ts fetch   --config <path>   # download attachments named in the manifest
//   MailArchive.ts extract --config <path>   # pdftotext / unzip -> .txt beside each file
//   MailArchive.ts index   --config <path>   # write INDEX.md from the manifest
//   MailArchive.ts status  --config <path>
//
// Config (JSON):
//   { "store": "<abs dir>", "accounts": ["<name>"|null], "queries": ["<gmail q>"],
//     "maxPerQuery": 500, "skipSenders": ["noreply@ups.com"] }
//
// A null account entry means gmail.ts's default credential.
// Attachments dedupe by sha256; the manifest records every message that carried a copy.

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const GMAIL = join(import.meta.dir, "gmail.ts");

type Attachment = { filename: string; path: string; bytes: number; sha256: string; textPath?: string; needsOcr?: boolean };
type Message = { id: string; account: string; date: string; from: string; to?: string; subject: string; queries: string[]; attachments: Attachment[] };
type Manifest = { generated: string; store: string; messages: Record<string, Message>; blobs: Record<string, string> };

type Config = {
  store: string;
  accounts: (string | null)[];
  queries: string[];
  maxPerQuery?: number;
  skipSenders?: string[];
};

function readConfig(path: string): Config {
  const cfg = JSON.parse(readFileSync(path, "utf8")) as Config;
  if (!cfg.store) throw new Error("config.store is required");
  if (!Array.isArray(cfg.queries) || cfg.queries.length === 0) throw new Error("config.queries must be a non-empty array");
  if (!Array.isArray(cfg.accounts) || cfg.accounts.length === 0) cfg.accounts = [null];
  return cfg;
}

function manifestPath(cfg: Config) { return join(cfg.store, "manifest.json"); }

function loadManifest(cfg: Config): Manifest {
  const p = manifestPath(cfg);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as Manifest;
  return { generated: new Date().toISOString(), store: cfg.store, messages: {}, blobs: {} };
}

function saveManifest(cfg: Config, m: Manifest) {
  m.generated = new Date().toISOString();
  mkdirSync(cfg.store, { recursive: true });
  writeFileSync(manifestPath(cfg), JSON.stringify(m, null, 2));
}

// gmail.ts is the one mailbox path in LifeOS; never reimplement the API client here.
function gmail(account: string | null, args: string[], timeoutMs = 120_000) {
  const argv = account ? ["--account", account, ...args] : args;
  const r = spawnSync("bun", [GMAIL, ...argv], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { ok: false as const, out: (r.stderr || r.stdout || "").slice(0, 400) };
  return { ok: true as const, out: r.stdout ?? "" };
}

function sweep(cfg: Config) {
  const man = loadManifest(cfg);
  const max = cfg.maxPerQuery ?? 500;
  const skip = (cfg.skipSenders ?? []).map(s => s.toLowerCase());
  let added = 0, seen = 0;

  for (const account of cfg.accounts) {
    const label = account ?? "default";
    for (const q of cfg.queries) {
      const r = gmail(account, ["list", q, String(max)], 300_000);
      if (!r.ok) { console.error(`  ! ${label} | ${q} -> ${r.out}`); continue; }
      let n = 0;
      for (const line of r.out.split("\n")) {
        if (!line.trim()) continue;
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (!m?.id) continue;
        seen++; n++;
        const from = (m.from ?? "").toLowerCase();
        if (skip.some(s => from.includes(s))) continue;
        const key = `${label}:${m.id}`;
        if (!man.messages[key]) {
          man.messages[key] = {
            id: m.id, account: label, date: m.date ?? "", from: m.from ?? "",
            to: m.to ?? "", subject: m.subject ?? "", queries: [], attachments: [],
          };
          added++;
        }
        const rec = man.messages[key];
        if (!rec.queries.includes(q)) rec.queries.push(q);
      }
      console.log(`  ${label} | ${n.toString().padStart(4)} hits | ${q}`);
    }
  }
  saveManifest(cfg, man);
  console.log(`sweep: ${seen} rows, ${added} new messages, ${Object.keys(man.messages).length} total`);
}

// Attachments are fetched per message into raw/<account>/<id>/ and deduped by content
// hash, so the same disclosure PDF forwarded five times costs one copy on disk.
function fetchAttachments(cfg: Config) {
  const man = loadManifest(cfg);
  const keys = Object.keys(man.messages).filter(k => man.messages[k].attachments.length === 0);
  let done = 0, files = 0, dupes = 0, failed = 0;

  for (const key of keys) {
    const rec = man.messages[key];
    const outdir = join(cfg.store, "raw", rec.account, rec.id);
    mkdirSync(outdir, { recursive: true });
    const r = gmail(rec.account === "default" ? null : rec.account, ["attach", rec.id, outdir], 180_000);
    done++;
    if (!r.ok) { failed++; continue; }
    let names: string[] = [];
    try { names = readdirSync(outdir); } catch { names = []; }
    for (const name of names) {
      const p = join(outdir, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (!st.isFile() || st.size === 0) continue;
      const buf = readFileSync(p);
      const sha = createHash("sha256").update(buf).digest("hex");
      if (man.blobs[sha] && man.blobs[sha] !== p) dupes++;
      else man.blobs[sha] = p;
      rec.attachments.push({ filename: name, path: p, bytes: st.size, sha256: sha });
      files++;
    }
    if (done % 25 === 0) { saveManifest(cfg, man); console.log(`  ...${done}/${keys.length} messages, ${files} files`); }
  }
  saveManifest(cfg, man);
  console.log(`fetch: ${done} messages, ${files} files, ${dupes} duplicate blobs, ${failed} failures`);
}

// A PDF that yields almost no text is a scan. Flag it rather than guessing at OCR here;
// the OCR pass is a separate, slower job.
const TEXT_MIN = 200;

function extract(cfg: Config) {
  const man = loadManifest(cfg);
  let converted = 0, scans = 0, skipped = 0;
  for (const key of Object.keys(man.messages)) {
    for (const a of man.messages[key].attachments) {
      if (a.textPath && existsSync(a.textPath)) { skipped++; continue; }
      const lower = a.filename.toLowerCase();
      const txt = `${a.path}.txt`;
      if (lower.endsWith(".pdf")) {
        spawnSync("pdftotext", ["-layout", a.path, txt], { timeout: 120_000 });
        if (existsSync(txt)) {
          const body = readFileSync(txt, "utf8").replace(/DocuSign Envelope ID:[^\n]*/g, "").trim();
          a.textPath = txt;
          if (body.length < TEXT_MIN) { a.needsOcr = true; scans++; } else converted++;
        }
      } else if (lower.endsWith(".docx") || lower.endsWith(".xlsx") || lower.endsWith(".pptx")) {
        const inner = lower.endsWith(".docx") ? "word/document.xml"
          : lower.endsWith(".xlsx") ? "xl/sharedStrings.xml" : "ppt/slides/slide1.xml";
        const r = spawnSync("unzip", ["-p", a.path, inner], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
        if (r.status === 0 && r.stdout) {
          const body = r.stdout.replace(/<\/(t|a:t)>/g, "\n").replace(/<[^>]*>/g, "").replace(/\n{2,}/g, "\n");
          writeFileSync(txt, body); a.textPath = txt; converted++;
        }
      } else if (lower.endsWith(".txt") || lower.endsWith(".csv") || lower.endsWith(".ics")) {
        a.textPath = a.path; converted++;
      }
    }
  }
  saveManifest(cfg, man);
  console.log(`extract: ${converted} converted, ${scans} need OCR, ${skipped} already done`);
}

function index(cfg: Config) {
  const man = loadManifest(cfg);
  const rows = Object.values(man.messages)
    .filter(m => m.attachments.length > 0)
    .sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
  const lines: string[] = [
    "# Mail archive index", "",
    `_Generated ${new Date().toISOString().slice(0, 10)} by \`LIFEOS/TOOLS/MailArchive.ts\`. ${rows.length} messages with attachments._`, "",
    "| Date | From | Subject | Files |", "|---|---|---|---|",
  ];
  for (const m of rows) {
    const files = m.attachments.map(a => `\`${a.filename}\`${a.needsOcr ? " ⚠️scan" : ""}`).join("<br>");
    const d = (Date.parse(m.date) ? new Date(m.date).toISOString().slice(0, 10) : m.date).slice(0, 10);
    lines.push(`| ${d} | ${m.from.replace(/\|/g, "/").slice(0, 44)} | ${m.subject.replace(/\|/g, "/").slice(0, 70)} | ${files} |`);
  }
  const p = join(cfg.store, "INDEX.md");
  writeFileSync(p, lines.join("\n") + "\n");
  console.log(`index: ${p} (${rows.length} rows)`);
}

function status(cfg: Config) {
  const man = loadManifest(cfg);
  const msgs = Object.values(man.messages);
  const atts = msgs.flatMap(m => m.attachments);
  const bytes = atts.reduce((n, a) => n + a.bytes, 0);
  console.log(JSON.stringify({
    store: cfg.store,
    messages: msgs.length,
    withAttachments: msgs.filter(m => m.attachments.length > 0).length,
    attachments: atts.length,
    uniqueBlobs: Object.keys(man.blobs).length,
    megabytes: +(bytes / 1e6).toFixed(1),
    extracted: atts.filter(a => a.textPath).length,
    needOcr: atts.filter(a => a.needsOcr).length,
  }, null, 2));
}

const [cmd] = process.argv.slice(2);
const ci = process.argv.indexOf("--config");
if (ci === -1) { console.error("usage: MailArchive.ts sweep|fetch|extract|index|status --config <path>"); process.exit(2); }
const cfg = readConfig(process.argv[ci + 1]);
if (cmd === "sweep") sweep(cfg);
else if (cmd === "fetch") fetchAttachments(cfg);
else if (cmd === "extract") extract(cfg);
else if (cmd === "index") index(cfg);
else if (cmd === "status") status(cfg);
else { console.error(`unknown command: ${cmd}`); process.exit(2); }
