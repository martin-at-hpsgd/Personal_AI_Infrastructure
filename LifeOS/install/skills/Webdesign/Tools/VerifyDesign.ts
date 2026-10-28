#!/usr/bin/env bun
/*
Usage:
  VerifyDesign.ts <url-or-path> <out-dir> [--viewport WIDTHxHEIGHT] [--a11y|--no-a11y]

Runs a thin Interceptor-driven smoke check for a rendered design, in the pinned
Interceptor test context only (INTERCEPTOR_TEST_CONTEXT_ID from the environment or
the Interceptor preferences.env; it refuses to run without one, so it never drives
the operator's own window).

What it does NOT verify, and says so in its JSON under not_verified:
- The viewport. --viewport is validated and echoed with applied: false; the page is
  captured at the test window's current size. For a real width check use
  skills/Interceptor/Tools/VerifyViewport.ts.
- Colour contrast. The a11y pass is tree heuristics (names, alt text, labels,
  heading order), not axe-core and not WCAG AA contrast.

A failed open or wait-stable fails the run (exit 1) before any screenshot, so a
stale tab is never captured and reported as the page. The screenshot goes through
Interceptor/Tools/Capture.sh, which cannot capture a file:// page (the extension's
tabCapture refuses it); serve a local build over http and pass that URL.
*/
import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lifeosPath } from "../../../LIFEOS/TOOLS/Paths.ts";

type TreeNode = {
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
  alt?: string;
  href?: string;
  level?: number;
  children?: TreeNode[];
};
type Violation = { type: string; count: number; examples: { ref?: string; text?: string }[] };
type A11yResult = {
  engine: "interceptor-tree-heuristic";
  limitations: string[];
  violations: Violation[];
  pass: boolean;
};

function resolveInterceptorBin(): string {
  const found = Bun.spawnSync(["which", "interceptor"]);
  const bin = found.stdout.toString().trim();
  if (found.exitCode !== 0 || bin.length === 0) {
    console.error("interceptor CLI not found on PATH — install the Interceptor skill (see ~/.claude/skills/Interceptor/SKILL.md)");
    process.exit(127);
  }
  return bin;
}

async function run(argv: string[], timeout: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(timeout) });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

/** Interceptor's screenshot wrapper: `screenshot <path>` is not a CLI form, and the wrapper pins the test context. */
const CAPTURE_SH = join(import.meta.dir, "..", "..", "Interceptor", "Tools", "Capture.sh");

/** What this check never verifies; printed in every result so a pass is not read as more than it is. */
export const NOT_VERIFIED = [
  "viewport: --viewport is echoed, not applied; the capture is at the test window's current size (use Interceptor/Tools/VerifyViewport.ts for widths)",
  "contrast: colour contrast (WCAG AA) is not checked; the a11y pass covers names, alt text, labels and heading order only",
] as const;

/** The pinned Interceptor test context: env first, then the Interceptor preferences.env. Null when neither sets one. */
export function testContextId(env: Record<string, string | undefined> = process.env, prefsPath = lifeosPath("USER", "CUSTOMIZATIONS", "SKILLS", "Interceptor", "preferences.env")): string | null {
  const fromEnv = env.INTERCEPTOR_TEST_CONTEXT_ID?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(prefsPath)) return null;
  const line = readFileSync(prefsPath, "utf8").split("\n").find((l) => /^\s*(export\s+)?INTERCEPTOR_TEST_CONTEXT_ID=/.test(l));
  const value = line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  return value ? value : null;
}

type StepResult = { code: number; stderr: string };
/**
 * Why the page cannot be trusted as loaded. A failed open or wait-stable is a failure on its own: a screenshot taken
 * after it would show whatever tab was already there. `wait` is null when open failed and wait-stable never ran. Pure.
 */
export function loadErrors(open: StepResult, wait: StepResult | null): string[] {
  const errors: string[] = [];
  if (open.code !== 0) errors.push(`open failed (exit ${open.code}): ${open.stderr.trim() || "no stderr"}`);
  if (wait === null && open.code === 0) errors.push("wait-stable did not run");
  if (wait && wait.code !== 0) errors.push(`wait-stable failed (exit ${wait.code}): ${wait.stderr.trim() || "no stderr"}`);
  return errors;
}

/** The run's verdict: loaded, captured, and the a11y heuristics passed (or were skipped). Pure. */
export function verdict(o: { open: StepResult; wait: StepResult | null; screenshot: string | null; a11yPass: boolean }): { pass: boolean; errors: string[] } {
  const errors = loadErrors(o.open, o.wait);
  if (!errors.length && o.screenshot === null) errors.push("no screenshot");
  return { pass: errors.length === 0 && o.a11yPass, errors };
}

function walkTree(node: TreeNode, out: TreeNode[] = []): TreeNode[] {
  out.push(node);
  for (const child of node.children ?? []) walkTree(child, out);
  return out;
}

function textOf(n: TreeNode): string {
  return `${n.name ?? ""} ${n.text ?? ""}`.trim();
}

function add(map: Map<string, Violation>, type: string, node: TreeNode): void {
  const v = map.get(type) ?? { type, count: 0, examples: [] };
  v.count += 1;
  if (v.examples.length < 5) v.examples.push({ ref: node.ref, text: textOf(node) });
  map.set(type, v);
}

function a11yFromTree(root: TreeNode): A11yResult {
  const nodes = walkTree(root);
  const violations = new Map<string, Violation>();
  let previousHeading = 0;
  let sawHeading = false;
  for (const n of nodes) {
    const role = (n.role ?? "").toLowerCase();
    const label = textOf(n);
    if (role === "img" && !label && !n.alt) add(violations, "img-alt", n);
    if (role === "button" && !label) add(violations, "button-name", n);
    if (role === "a" && (!label || !n.href)) add(violations, "link-name", n);
    if (["textbox", "combobox", "spinbutton"].includes(role) && !label) add(violations, "form-label", n);
    if (role === "heading" && typeof n.level === "number") {
      if (!sawHeading && n.level > 1) add(violations, "heading-order", n);
      if (sawHeading && n.level > previousHeading + 1) add(violations, "heading-order", n);
      sawHeading = true;
      previousHeading = n.level;
    }
  }
  const list = [...violations.values()];
  return {
    engine: "interceptor-tree-heuristic",
    limitations: ["no-contrast-check", "no-dynamic-aria-live-check", "no-css-parsed-check"],
    violations: list,
    pass: list.length === 0,
  };
}

function parseArgs(): { input: string; outDir: string; w: number; h: number; a11y: boolean } {
  const args = Bun.argv.slice(2);
  const input = args.shift();
  const outDir = args.shift();
  if (!input || !outDir) {
    console.error("usage: VerifyDesign.ts <url-or-path> <out-dir> [--viewport WIDTHxHEIGHT] [--a11y|--no-a11y]");
    process.exit(2);
  }
  let viewport = "1440x900";
  let a11y = true;
  while (args.length) {
    const flag = args.shift();
    if (flag === "--viewport") viewport = args.shift() ?? "";
    else if (flag === "--a11y") a11y = true;
    else if (flag === "--no-a11y") a11y = false;
    else {
      console.error(`unknown flag: ${flag ?? ""}`);
      process.exit(2);
    }
  }
  const m = /^(\d+)x(\d+)$/.exec(viewport);
  const w = m ? Number(m[1]) : 0;
  const h = m ? Number(m[2]) : 0;
  if (!m || w < 320 || h < 320 || w > 7680 || h > 7680) {
    console.error("invalid viewport; expected WIDTHxHEIGHT with each value in [320, 7680]");
    process.exit(2);
  }
  return { input, outDir, w, h, a11y };
}

async function resolveUrl(input: string): Promise<{ url: string; resolvedUrl: string }> {
  if (/^https?:\/\//.test(input)) return { url: input, resolvedUrl: input };
  const abs = resolve(input);
  const s = await stat(abs).catch(() => null);
  if (!s) {
    console.error(`path does not exist: ${abs}`);
    process.exit(2);
  }
  return { url: input, resolvedUrl: pathToFileURL(abs).href };
}

async function main(): Promise<void> {
  if (Bun.argv.slice(2).length === 0) {
    console.error("usage: VerifyDesign.ts <url-or-path> <out-dir> [--viewport WIDTHxHEIGHT] [--a11y|--no-a11y]");
    return;
  }
  const opts = parseArgs();
  const { url, resolvedUrl } = await resolveUrl(opts.input);
  const outDir = resolve(opts.outDir);
  const made = await run(["mkdir", "-p", outDir], 5_000);
  if (made.code !== 0) {
    console.error(made.stderr || "failed to create output directory");
    process.exit(2);
  }
  const bin = resolveInterceptorBin();
  const context = testContextId();
  if (!context) {
    console.error("no Interceptor test context: set INTERCEPTOR_TEST_CONTEXT_ID (run bash ~/.claude/skills/Interceptor/Tools/PreflightIsolation.sh first). VerifyDesign never drives an unpinned window.");
    process.exit(2);
  }
  const ctx = ["--context", context];
  const timestamp = new Date().toISOString();
  const viewport = { w: opts.w, h: opts.h, applied: false };
  const open = await run([bin, "open", resolvedUrl, ...ctx], 60_000);
  const wait = open.code === 0 ? await run([bin, "wait-stable", ...ctx], 30_000) : null;
  const notLoaded = loadErrors(open, wait);
  if (notLoaded.length) {
    console.log(JSON.stringify({ url, resolvedUrl, viewport, screenshot: null, errors: notLoaded, not_verified: NOT_VERIFIED, pass: false, timestamp }, null, 2));
    process.exit(1);
  }
  const shot = join(outDir, `${timestamp.replace(/[:.]/g, "-")}.png`);
  let screenshot: string | null = shot;
  let screenshotError: string | undefined;
  // The sanctioned capture: pinned context only, and a blank frame is refused (exit 12) instead of saved as the page.
  const s = await run(["bash", CAPTURE_SH, "--current", "--out", shot], 90_000);
  if (s.code !== 0 || !existsSync(shot)) {
    screenshot = null;
    screenshotError = s.stderr || "screenshot failed";
  }
  let a11y: A11yResult | { skipped: true };
  if (opts.a11y) {
    const tree = await run([bin, "tree", "--json", ...ctx], 30_000);
    let parsed: TreeNode | null = null;
    if (tree.code === 0) {
      try {
        parsed = JSON.parse(tree.stdout) as TreeNode;
      } catch {
        parsed = null;
      }
    }
    if (parsed) {
      a11y = a11yFromTree(parsed);
    } else {
      a11y = {
        engine: "interceptor-tree-heuristic",
        limitations: ["no-contrast-check", "no-dynamic-aria-live-check", "no-css-parsed-check"],
        violations: [{ type: "tree-unavailable", count: 1, examples: [{ text: tree.code === 0 ? "tree output was not JSON" : tree.stderr || "tree failed" }] }],
        pass: false,
      };
    }
  } else {
    a11y = { skipped: true };
  }
  const a11yPass = "skipped" in a11y ? true : a11y.pass;
  const { pass, errors } = verdict({ open, wait, screenshot, a11yPass });
  const result = {
    url,
    resolvedUrl,
    viewport,
    screenshot,
    ...(screenshotError ? { screenshotError } : {}),
    ...(errors.length ? { errors } : {}),
    a11y,
    not_verified: NOT_VERIFIED,
    pass,
    timestamp,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(pass ? 0 : 1);
}

if (import.meta.main) await main();
