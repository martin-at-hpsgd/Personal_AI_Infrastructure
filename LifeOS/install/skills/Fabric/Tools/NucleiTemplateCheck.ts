#!/usr/bin/env bun
// NucleiTemplateCheck — checks a NucleiTemplate output (Intents/NucleiTemplate.md)
// against the parts of its contract code can judge: one fenced YAML block that
// parses and holds a Nuclei template (`id`, an `info` block with the required
// fields, and at least one protocol block), every request path/host using a
// {{placeholder}} rather than a literal hostname, at least one matcher present,
// no deprecated top-level key, nothing outside the fence, and then Nuclei
// itself: `nuclei -validate` on the template. Whether the matchers are specific
// enough to avoid false positives stays a judged check.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELP = `NucleiTemplateCheck — shape and Nuclei check for a Fabric NucleiTemplate output

  bun skills/Fabric/Tools/NucleiTemplateCheck.ts <file|-> [--json] [--no-nuclei]

  --json       print {ok, id, protocols, matchers, nuclei, problems}
  --no-nuclei  structural checks only (no nuclei -validate)
Exit: 0 every check holds, 1 a check failed, 2 bad usage, unreadable input, or nuclei missing.`;

export const SEVERITIES = ["info", "low", "medium", "high", "critical", "unknown"];
export const PROTOCOLS = ["http", "dns", "tcp", "ssl", "websocket", "whois", "headless", "network", "file", "javascript", "code", "flow"];
const DEPRECATED: Record<string, string> = { requests: "http", network: "tcp" };
const ID_RE = /^([a-zA-Z0-9]+[-_])*[a-zA-Z0-9]+$/;
// A Nuclei placeholder (e.g. {{BaseURL}}, {{Hostname}}, {{interactsh-url}}).
const PLACEHOLDER = /\{\{[^}]+\}\}/;
// A literal host where a placeholder belongs: scheme://host, or a bare
// dotted/colon host that is not wrapped in {{ }}.
const LITERAL_HOST = /\b(?:https?|wss?|tls|tcp):\/\/(?!\{\{)[A-Za-z0-9.-]+|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/i;

export type Matcher = { type?: unknown };
export type Block = { lang: string; body: string; line: number };
export type Result = {
  ok: boolean;
  id: string | null;
  protocols: string[];
  matchers: number;
  nuclei: "passed" | "failed" | "skipped";
  problems: string[];
};

export function blocks(input: string): { blocks: Block[]; outside: { line: number; text: string }[]; unclosed: boolean } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  const outside: { line: number; text: string }[] = [];
  let cur: { lang: string; fence: string; start: number; body: string[] } | null = null;
  lines.forEach((raw, i) => {
    if (cur) {
      if (raw.trim().startsWith(cur.fence) && raw.trim().replace(/[`~]/g, "") === "") {
        out.push({ lang: cur.lang, body: cur.body.join("\n"), line: cur.start });
        cur = null;
      } else cur.body.push(raw);
      return;
    }
    const open = raw.match(/^\s*(`{3,}|~{3,})\s*([\w#+.-]*)/);
    if (open) cur = { lang: open[2].toLowerCase(), fence: open[1], start: i + 1, body: [] };
    else if (raw.trim() !== "") outside.push({ line: i + 1, text: raw.trim() });
  });
  return { blocks: out, outside, unclosed: cur !== null };
}

const isTemplateBlock = (b: Block) =>
  (b.lang === "yaml" || b.lang === "yml" || b.lang === "") && /^\s*id\s*:/m.test(b.body) && /^\s*info\s*:/m.test(b.body);

/** Walk a parsed value collecting every string, with a path, so paths/hosts can be inspected. */
function walkStrings(v: unknown, path: string, out: { path: string; value: string }[]): void {
  if (typeof v === "string") out.push({ path, value: v });
  else if (Array.isArray(v)) v.forEach((e, i) => walkStrings(e, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) walkStrings(val, path ? `${path}.${k}` : k, out);
}

function countMatchers(v: unknown): number {
  let n = 0;
  const walk = (node: unknown, key?: string): void => {
    if (Array.isArray(node)) {
      if (key === "matchers") n += node.length;
      node.forEach((e) => walk(e));
    } else if (node && typeof node === "object") {
      for (const [k, val] of Object.entries(node)) walk(val, k);
    }
  };
  walk(v);
  return n;
}

/** Structural checks only; no process is spawned. */
export function checkShape(input: string): Result & { templateBlock?: Block } {
  const problems: string[] = [];
  const { blocks: all, outside, unclosed } = blocks(input);
  if (unclosed) problems.push("a code fence is never closed");
  for (const o of outside) problems.push(`line ${o.line}: text outside the code block ("${o.text.slice(0, 60)}")`);

  const tmplBlocks = all.filter(isTemplateBlock);
  const otherBlocks = all.filter((b) => !isTemplateBlock(b));
  for (const b of otherBlocks) problems.push(`line ${b.line}: a code block that is not the Nuclei template (every output is one yaml template)`);
  if (tmplBlocks.length === 0) problems.push("no ```yaml block holding a Nuclei template (needs top-level id: and info:)");
  if (tmplBlocks.length > 1) problems.push(`${tmplBlocks.length} template blocks; deliver exactly one template`);
  const templateBlock = tmplBlocks[0];

  let id: string | null = null;
  const protocols: string[] = [];
  let matchers = 0;

  if (templateBlock) {
    if (/^---\s*$/m.test(templateBlock.body.trim().replace(/^---\s*\n/, "")))
      problems.push("more than one YAML document in the block; deliver one template");
    let doc: Record<string, unknown> | undefined;
    try {
      const parsed = Bun.YAML.parse(templateBlock.body);
      if (Array.isArray(parsed)) problems.push("the YAML is a multi-document stream; deliver one template");
      else doc = parsed as Record<string, unknown>;
    } catch (e) {
      problems.push(`template YAML does not parse: ${(e as Error).message}`);
    }

    if (doc && typeof doc === "object") {
      // id
      if (typeof doc.id !== "string" || !ID_RE.test(doc.id)) problems.push("id missing or not a plain identifier matching ^([a-zA-Z0-9]+[-_])*[a-zA-Z0-9]+$");
      else id = doc.id;

      // info block
      const info = doc.info as Record<string, unknown> | undefined;
      if (!info || typeof info !== "object") problems.push("info block missing");
      else {
        if (typeof info.name !== "string" || info.name.trim().length === 0) problems.push("info.name missing");
        if (typeof info.author !== "string" || info.author.trim().length === 0) problems.push("info.author missing");
        if (typeof info.severity !== "string" || !SEVERITIES.includes(info.severity.toLowerCase())) problems.push(`info.severity must be one of ${SEVERITIES.slice(0, 5).join(", ")}`);
        if (typeof info.description !== "string" || info.description.trim().length < 10) problems.push("info.description missing or too short to say what is detected");
      }

      // deprecated keys
      for (const [dep, now] of Object.entries(DEPRECATED)) if (dep in doc) problems.push(`top-level ${dep}: is deprecated, use ${now}: instead`);

      // protocol blocks
      for (const p of PROTOCOLS) if (p in doc && !(p in DEPRECATED)) protocols.push(p);
      // `flow` is orchestration, not a protocol on its own; a real protocol must exist too.
      const realProtocols = protocols.filter((p) => p !== "flow");
      if (realProtocols.length === 0) problems.push(`no protocol block (one of ${PROTOCOLS.filter((p) => p !== "flow" && !(p in DEPRECATED)).join(", ")})`);

      // matchers present
      matchers = countMatchers(doc);
      if (matchers === 0) problems.push("no matcher anywhere; a template with no matcher reports every reachable host");

      // placeholders vs literal hosts in paths, raw requests and hosts
      const strings: { path: string; value: string }[] = [];
      for (const p of protocols) walkStrings(doc[p], p, strings);
      const targetFields = strings.filter((s) => /\.(path|host|address)(\[\d+\])*$/.test(s.path) || /\.(path|host|address)\b/.test(s.path) || /\braw\b/.test(s.path));
      for (const s of targetFields) {
        if (LITERAL_HOST.test(s.value) && !PLACEHOLDER.test(s.value.replace(LITERAL_HOST, "")) && !hasPlaceholderHost(s.value)) {
          problems.push(`${s.path}: literal host "${firstLiteralHost(s.value)}" where a {{BaseURL}}/{{Hostname}} placeholder belongs`);
        }
      }
      // At least one request path or host must use a placeholder at all.
      const anyTarget = targetFields.length > 0;
      const anyPlaceholder = targetFields.some((s) => PLACEHOLDER.test(s.value));
      if (anyTarget && !anyPlaceholder) problems.push("no {{BaseURL}}/{{RootURL}}/{{Hostname}}/{{Host}} placeholder in any request path or host");
    }
  }

  return { ok: problems.length === 0, id, protocols, matchers, nuclei: "skipped", problems, templateBlock };
}

/** A path/host/raw value is safe if every host-looking token in it is a placeholder. */
function hasPlaceholderHost(value: string): boolean {
  // Strip all placeholders; if a literal host remains, it is not safe.
  const stripped = value.replace(/\{\{[^}]+\}\}/g, " ");
  return !LITERAL_HOST.test(stripped);
}

function firstLiteralHost(value: string): string {
  const stripped = value.replace(/\{\{[^}]+\}\}/g, " ");
  return stripped.match(LITERAL_HOST)?.[0] ?? value.slice(0, 40);
}

export function nucleiAvailable(): boolean {
  return Bun.which("nuclei") !== null;
}

function runNuclei(path: string): { code: number; out: string } {
  // -duc: disable update check; -nc: no color; env scrubbed so a stray
  // GOOGLE_API_KEY etc. does not add noise. -validate exits non-zero on any
  // template error.
  const p = Bun.spawnSync(["nuclei", "-validate", "-t", path, "-duc", "-nc"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    timeout: 120_000,
  });
  return { code: p.exitCode ?? -1, out: p.stdout.toString() + "\n" + p.stderr.toString() };
}

/** Full check: structure, then `nuclei -validate` unless nuclei is false. */
export function check(input: string, opts: { nuclei?: boolean } = {}): Result {
  const shape = checkShape(input);
  const { templateBlock, ...base } = shape;
  const useNuclei = opts.nuclei ?? true;
  if (!useNuclei || !templateBlock) return { ...base, ok: base.problems.length === 0 };
  const problems = [...base.problems];
  const dir = mkdtempSync(join(tmpdir(), "nuclei-template-check-"));
  try {
    const tplPath = join(dir, "template.yaml");
    writeFileSync(tplPath, templateBlock.body + "\n");
    const v = runNuclei(tplPath);
    if (v.code !== 0) {
      const why = v.out.split("\n").filter((l) => /\[ERR\]|\[FTL\]|error|invalid|could not/i.test(l)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()).slice(0, 6).join(" | ");
      problems.push(`nuclei -validate failed (exit ${v.code}): ${why || "no detail"}`);
      return { ...base, ok: false, problems, nuclei: "failed" };
    }
    return { ...base, ok: problems.length === 0, problems, nuclei: problems.length > base.problems.length ? "failed" : "passed" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const noNuclei = args.includes("--no-nuclei");
  const unknown = args.filter((a) => a.startsWith("--") && !["--json", "--no-nuclei"].includes(a));
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}`);
    process.exit(2);
  }
  const src = args.find((a) => !a.startsWith("--") || a === "-");
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  if (!noNuclei && !nucleiAvailable()) {
    console.error("nuclei is not on PATH; install it (see Setup.md) or pass --no-nuclei for structural checks only");
    process.exit(2);
  }
  const r = check(input, { nuclei: !noNuclei });
  if (json) console.log(JSON.stringify({ ok: r.ok, id: r.id, protocols: r.protocols, matchers: r.matchers, nuclei: r.nuclei, problems: r.problems }));
  else if (r.ok) console.log(`✓ template ${r.id} (${r.protocols.join(", ")}), ${r.matchers} matcher(s), nuclei ${r.nuclei}`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
