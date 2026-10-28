#!/usr/bin/env bun
/**
 * Bake.ts — checks and freezes a hand-built Visualize page (the Concept route).
 *
 * Two jobs, both deterministic:
 *   --check  parses every inline script and reports syntax errors with the
 *            page line, so a page that would render blank is caught before
 *            any screenshot.
 *   bake     loads the page in the headless verifier (Interceptor's
 *            VerifyViewport), lets its scripts draw, then writes a copy with
 *            every script and inline handler removed and each canvas kept as
 *            an image. The copy renders anywhere scripts are blocked, such as
 *            a host that serves files under `Content-Security-Policy: sandbox`.
 *
 * Usage:
 *   bun Bake.ts --check <page.html>
 *   bun Bake.ts <page.html> --out <baked.html> [--width 1440] [--wait 1500] [--dpr 2]
 *
 * Exit: 0 ok · 1 refused (syntax error, or the page threw while rendering) · 2 usage · 3 verifier unavailable
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve, sep } from "path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";

const VERIFY = join(import.meta.dir, "..", "..", "Interceptor", "Tools", "VerifyViewport.ts");
const ENTRY = "/__bake__.html";

export interface ScriptBlock { index: number; line: number; code: string }
export interface SyntaxIssue { script: number; line: number; message: string; text: string }

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const JS_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);

/** Inline scripts the browser would execute, with the page line each body starts on. */
export function inlineScripts(html: string): ScriptBlock[] {
  const out: ScriptBlock[] = [];
  let n = 0;
  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? "").toLowerCase();
    if (!JS_TYPES.has(type)) continue;
    const bodyStart = m.index! + m[0].indexOf(">") + 1;
    out.push({ index: n++, line: html.slice(0, bodyStart).split("\n").length, code: m[2] });
  }
  return out;
}

/** Parse every inline script; one issue per script that fails, with its page line. */
export function syntaxIssues(html: string): SyntaxIssue[] {
  const issues: SyntaxIssue[] = [];
  const t = new Bun.Transpiler({ loader: "js" });
  for (const s of inlineScripts(html)) {
    try {
      t.transformSync(s.code);
    } catch (e: any) {
      const pos = e?.position ?? e?.errors?.[0]?.position;
      const rel = typeof pos?.line === "number" ? pos.line : 1;
      issues.push({ script: s.index, line: s.line + rel - 1, message: String(e?.message ?? e), text: String(pos?.lineText ?? "").trim() });
    }
  }
  return issues;
}

/** Records uncaught errors from the moment the page starts parsing. */
export const ERROR_HOOK =
  `<script>window.__bakeErrors=[];addEventListener("error",function(e){__bakeErrors.push(String(e.message||e))});` +
  `addEventListener("unhandledrejection",function(e){__bakeErrors.push(String(e.reason))})</script>`;

export function injectHook(html: string): string {
  const head = html.match(/<head\b[^>]*>/i);
  if (!head) return ERROR_HOOK + html;
  const at = head.index! + head[0].length;
  return html.slice(0, at) + ERROR_HOOK + html.slice(at);
}

const HANDLER_RE = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
// A baked page goes to hosts served under `Content-Security-Policy: sandbox`, which forbids
// opening new browsing contexts: a target="_blank" link silently does nothing on click (2026-10-12).
const NEW_CONTEXT_TARGET_RE = /\s+target\s*=\s*("(?!_self"|_top")[^"]*"|'(?!_self'|_top')[^']*'|(?!_self\b|_top\b)[^\s>"']+)/gi;

/** Removes every script element, inline event handler and new-tab link target, leaving markup and styles. */
export function stripActive(html: string): string {
  return html
    .replace(SCRIPT_RE, "")
    .replace(/<script\b[^>]*\/>/gi, "")
    .replace(/<[a-zA-Z][^>]*>/g, (tag) => tag.replace(HANDLER_RE, "").replace(NEW_CONTEXT_TARGET_RE, ""));
}

export function countActive(html: string): { scripts: number; handlers: number } {
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  let handlers = 0;
  for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) handlers += (tag.match(HANDLER_RE) ?? []).length;
  return { scripts, handlers };
}

/** The expression VerifyViewport evaluates in the page once it has rendered. */
export function bakeExpression(waitMs: number, dpr: number): string {
  return `async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(${waitMs});
  if (${dpr} > (window.devicePixelRatio || 1)) {
    Object.defineProperty(window, "devicePixelRatio", { get: () => ${dpr} });
    dispatchEvent(new Event("resize"));
    await sleep(${waitMs});
  }
  const errors = (window.__bakeErrors || []).slice();
  let canvases = 0;
  for (const c of document.querySelectorAll("canvas")) {
    let url = "";
    try { url = c.toDataURL("image/webp", 0.86); } catch (e) { errors.push("canvas could not be read: " + e.message); continue; }
    c.style.backgroundImage = 'url("' + url + '")';
    c.style.backgroundSize = "100% 100%";
    c.style.backgroundRepeat = "no-repeat";
    canvases++;
  }
  document.querySelectorAll("script").forEach((s) => s.remove());
  return { errors, canvases, html: "<!doctype html>\\n" + document.documentElement.outerHTML };
}`;
}

/** Serves the page's own directory so relative assets resolve, with the hooked page at ENTRY. */
function serve(page: string, hooked: string) {
  const root = realpathSync(dirname(page));
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (path === ENTRY) return new Response(hooked, { headers: { "content-type": "text/html; charset=utf-8" } });
      const file = resolve(root, "." + path);
      if (!existsSync(file)) return new Response("not found", { status: 404 });
      const real = realpathSync(file);
      if (real !== root && !real.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
      if (!statSync(real).isFile()) return new Response("not found", { status: 404 });
      return new Response(Bun.file(real));
    },
  });
}

async function verify(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["bun", VERIFY, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

export interface BakeResult { html: string; canvases: number; errors: string[] }

export async function bake(page: string, opts: { width: number; waitMs: number; dpr: number }): Promise<BakeResult> {
  const source = readFileSync(page, "utf8");
  const server = serve(page, injectHook(source));
  const scratch = mkdtempSync(join(tmpdir(), "visualize-bake-"));
  try {
    const exprFile = join(scratch, "bake.js");
    writeFileSync(exprFile, bakeExpression(opts.waitMs, opts.dpr));
    const args = ["probe", `http://127.0.0.1:${server.port}${ENTRY}`, "--widths", String(opts.width), "--expr", `@${exprFile}`];
    let r = await verify(args);
    // A verifier left over from an earlier run can fail its liveness check; one restart clears it.
    if (r.code !== 0 && /lifecycle is NOT live/i.test(r.err)) {
      await verify(["stop"]);
      r = await verify(args);
    }
    if (r.code !== 0) throw new VerifierError(r.err.trim() || `verifier exited ${r.code}`);
    const value = JSON.parse(r.out)?.results?.[0]?.value;
    if (!value || typeof value.html !== "string") throw new VerifierError("verifier returned no page");
    return { html: value.html, canvases: value.canvases, errors: value.errors };
  } finally {
    server.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
}

export class VerifierError extends Error {}

function writeBaked(out: string, page: string, html: string): void {
  const clean = stripActive(html);
  const left = countActive(clean);
  invariant(left.scripts === 0 && left.handlers === 0, `baked page still carries ${left.scripts} scripts and ${left.handlers} handlers`);
  invariant(resolve(out) !== resolve(page), "refusing to overwrite the source page with its baked copy");
  writeFileSync(out, clean);
}

// ---------- CLI ----------

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error("usage: bun Bake.ts --check <page.html>\n       bun Bake.ts <page.html> --out <baked.html> [--width 1440] [--wait 1500] [--dpr 2]");
  process.exit(2);
}

function report(issues: SyntaxIssue[]): void {
  for (const i of issues) console.error(`\x1b[31m✗\x1b[0m script ${i.script + 1}, page line ${i.line}: ${i.message}${i.text ? `\n    ${i.text}` : ""}`);
}

if (import.meta.main) {
  if (process.argv.includes("--help")) usage();
  const valued = new Set(["--out", "--width", "--wait", "--dpr"]);
  const page = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && !valued.has(all[i - 1]));
  if (!page || !existsSync(page)) usage(page ? `no such page: ${page}` : undefined);
  const source = readFileSync(page, "utf8");
  const issues = syntaxIssues(source);

  if (process.argv.includes("--check")) {
    if (issues.length) { report(issues); process.exit(1); }
    console.log(`\x1b[32m✓\x1b[0m ${inlineScripts(source).length} inline scripts parse`);
    process.exit(0);
  }

  const out = flag("out");
  if (!out) usage("--out is required");
  if (issues.length) { report(issues); process.exit(1); }
  let result: BakeResult;
  try {
    result = await bake(page, { width: Number(flag("width") ?? 1440), waitMs: Number(flag("wait") ?? 1500), dpr: Number(flag("dpr") ?? 2) });
  } catch (e) {
    if (e instanceof VerifierError) { console.error(`verifier unavailable: ${e.message}`); process.exit(3); }
    throw e;
  }
  if (result.errors.length) {
    for (const e of result.errors) console.error(`\x1b[31m✗\x1b[0m page error: ${e}`);
    process.exit(1);
  }
  writeBaked(out, page, result.html);
  console.log(`\x1b[32m✓\x1b[0m ${out} · ${(statSync(out).size / 1024).toFixed(0)} KB · ${result.canvases} canvases kept · 0 scripts`);
}
