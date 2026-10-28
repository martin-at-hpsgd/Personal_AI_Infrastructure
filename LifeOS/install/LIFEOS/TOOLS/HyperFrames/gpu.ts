/**
 * GPU canary: does hardware compositing in the pinned headless Chrome actually put pixels on a page?
 *
 * Why: HyperFrames' own GPU probe reads the WebGL renderer string only. On 2026-09-24 a Mac's
 * GPU driver started failing every CPU wire mapping (kernel: `IOGPUSysMemory::retainCPUWireMapping
 * failed`, `AGXk: map block failed for cpu`). The renderer string still said
 * "ANGLE Metal Renderer: Apple <chip>", HyperFrames chose hardware, and every screenshot came back
 * fully transparent: black renders and black snapshots for every project, with exit 0.
 * The same page under SwiftShader rendered correctly.
 *
 * The canary opens a one-colour page in the pinned Chrome with HyperFrames' own macOS hardware
 * flags, takes one DevTools screenshot, and checks the colour. `auto` uses hardware when the
 * canary passes and SwiftShader when it does not. `hardware` fails loudly on a failed canary.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, devtoolsUrl } from "./probe";
import { runProcessBytes, sandboxed } from "./run";

export type GpuMode = "hardware" | "software";
export type GpuRequest = GpuMode | "auto";
export const GPU_REQUESTS: readonly GpuRequest[] = ["auto", "hardware", "software"];

export interface CanaryResult { ok: boolean; detail: string; ms: number }
export interface GpuDecision { requested: GpuRequest; mode: GpuMode; canary: CanaryResult | null }

/**
 * HyperFrames 0.8.71 `getBrowserGpuArgs("hardware", "darwin")`, plus the two GPU flags its
 * `buildChromeArgs` always adds. Re-read this on every version bump.
 */
export const HARDWARE_GPU_ARGS: readonly string[] = ["--use-gl=angle", "--use-angle=metal", "--enable-gpu-rasterization", "--enable-webgl", "--ignore-gpu-blocklist"];

export const CANARY_RGB: readonly [number, number, number] = [255, 0, 128];
const CANARY_SIZE = 64;
/** Per-channel tolerance for a pixel to count as the canary colour. */
const CANARY_TOLERANCE = 8;
/** Share of pixels that must be the canary colour, fully opaque. */
const CANARY_MIN_MATCH = 0.98;

/** Judge decoded RGBA screenshot bytes. Pure, so the rule is unit-tested without a GPU. */
export function judgeCanary(rgba: Uint8Array): { ok: boolean; detail: string } {
  if (rgba.length === 0 || rgba.length % 4 !== 0) return { ok: false, detail: `screenshot decoded to ${rgba.length} bytes, not RGBA pixels` };
  const n = rgba.length / 4;
  let match = 0;
  const sum = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    for (let c = 0; c < 4; c++) sum[c]! += rgba[o + c]!;
    if (rgba[o + 3] === 255 && CANARY_RGB.every((v, c) => Math.abs(rgba[o + c]! - v) <= CANARY_TOLERANCE)) match++;
  }
  const mean = sum.map((s) => Math.round(s / n)).join(",");
  const share = match / n;
  return { ok: share >= CANARY_MIN_MATCH, detail: `${(share * 100).toFixed(1)}% of pixels are the canary colour rgb(${CANARY_RGB.join(",")}); mean rgba (${mean})` };
}

/** One sandboxed Chrome with the hardware flags, one screenshot of a one-colour page. Never throws: a canary that cannot run fails. */
export async function gpuCanary(browserPath: string, timeoutMs = 20_000): Promise<CanaryResult> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  if (!existsSync(browserPath)) return { ok: false, detail: `browser not found at ${browserPath}`, ms: ms() };
  const profile = mkdtempSync(join(tmpdir(), "lifeos-hf-gpu-"));
  const chrome = Bun.spawn(sandboxed([
    // --no-sandbox for the same reason as the probe: Chrome's own seatbelt cannot start inside sandbox-exec.
    browserPath, "--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost",
    `--window-size=${CANARY_SIZE},${CANARY_SIZE}`, ...HARDWARE_GPU_ARGS, "about:blank",
  ]), { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  let cdp: Cdp | undefined;
  try {
    cdp = await Cdp.connect(await devtoolsUrl(chrome.stderr, timeoutMs), timeoutMs);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const [r, g, b] = CANARY_RGB;
    const html = `<!doctype html><html><body style="margin:0;background:rgb(${r},${g},${b})"></body></html>`;
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Page.navigate", { url: `data:text/html,${encodeURIComponent(html)}` }, sessionId);
    // Two animation frames after load, so the compositor has produced a frame for the new document.
    await cdp.send("Runtime.evaluate", { expression: "new Promise((ok) => { const go = () => requestAnimationFrame(() => requestAnimationFrame(ok)); document.readyState === 'complete' ? go() : addEventListener('load', go); })", awaitPromise: true }, sessionId, timeoutMs);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId, timeoutMs);
    if (typeof shot?.data !== "string" || shot.data.length === 0) return { ok: false, detail: "Page.captureScreenshot returned no image data", ms: ms() };
    const png = join(profile, "canary.png");
    writeFileSync(png, Buffer.from(shot.data, "base64"));
    const ffmpeg = Bun.which("ffmpeg");
    if (!ffmpeg) return { ok: false, detail: "ffmpeg not found on PATH; cannot decode the canary screenshot", ms: ms() };
    const raw = await runProcessBytes([ffmpeg, "-v", "error", "-i", png, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { timeoutMs: 30_000 });
    if (raw.code !== 0) return { ok: false, detail: `canary screenshot did not decode: ${raw.stderr.slice(-200)}`, ms: ms() };
    return { ...judgeCanary(raw.stdout), ms: ms() };
  } catch (e) {
    return { ok: false, detail: `canary could not run: ${(e as Error).message}`, ms: ms() };
  } finally {
    cdp?.close();
    chrome.kill("SIGKILL");
    await chrome.exited;
    rmSync(profile, { recursive: true, force: true });
  }
}

const decisions = new Map<string, Promise<GpuDecision>>();

/**
 * Decide the GPU mode for this process, once per browser and request. `software` skips the canary.
 * `auto` falls back to software on a failed canary; `hardware` returns the failed canary and the caller fails.
 */
export function resolveGpu(browserPath: string, requested: GpuRequest = "auto"): Promise<GpuDecision> {
  if (!GPU_REQUESTS.includes(requested)) throw new Error(`gpu must be one of ${GPU_REQUESTS.join(", ")}, got "${requested}"`);
  if (requested === "software") return Promise.resolve({ requested, mode: "software", canary: null });
  const key = `${browserPath}\0${requested}`;
  let decision = decisions.get(key);
  if (!decision) {
    decision = gpuCanary(browserPath).then((canary): GpuDecision => ({ requested, mode: canary.ok || requested === "hardware" ? "hardware" : "software", canary }));
    decisions.set(key, decision);
  }
  return decision;
}
