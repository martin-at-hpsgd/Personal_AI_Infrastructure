/**
 * Pre-render runtime probe: open the composition in the pinned headless Chrome (sandboxed,
 * DNS mapped to nowhere) over the DevTools protocol and read `window.__timelines`.
 *
 * Why our own probe: HyperFrames 0.8.71 renders a composition whose timeline never registers.
 * `lint` only sees the assignment text, `check` passes it, and `render` waits 45 s and ships a
 * motionless video with exit 0 (measured on the never-registers fixture). The probe fails in
 * seconds and says why: unregistered id, not a GSAP timeline, zero duration, a tween whose
 * selector matched nothing, a page error, or a font face that did not load.
 *
 * Scope: compositions in the entry document. Nested hosts (data-composition-src) are loaded
 * only by the HyperFrames runtime; for those the render runs with --no-best-effort, which turns
 * HyperFrames' own sub_timeline_readiness_timeout into a failed render.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Finding } from "./preflight";
import { sandboxed } from "./run";

export interface TimelineState { registered: boolean; isTimeline?: boolean; duration?: number | null; paused?: boolean | null; tweens?: number; emptyTweens?: number; emptyTargets?: string[] }
export interface ProbeResult { ok: boolean; findings: Finding[]; rootId: string | null; timelines: Record<string, TimelineState>; nestedHosts: number; pageErrors: string[]; fontsError: string | null; ms: number }
export interface ProbeOptions { projectDir: string; entry?: string; browserPath: string; variables?: Record<string, unknown>; expectMotion: boolean; budgetMs?: number; width?: number; height?: number }

const PROBE_EXPR = `(() => {
  const all = [...document.querySelectorAll('[data-composition-id]')];
  const root = all[0] || null;
  const ids = all.filter((el) => !el.hasAttribute('data-composition-src') && !el.hasAttribute('data-no-timeline')).map((el) => el.getAttribute('data-composition-id'));
  const reg = window.__timelines || {};
  const timelines = {};
  for (const id of ids) {
    const tl = reg[id];
    if (!tl) { timelines[id] = { registered: false }; continue; }
    const isTimeline = typeof tl.duration === 'function' && typeof tl.getChildren === 'function';
    const state = { registered: true, isTimeline, duration: isTimeline ? tl.duration() : null, paused: isTimeline ? tl.paused() : null, tweens: 0, emptyTweens: 0, emptyTargets: [] };
    if (isTimeline) {
      for (const t of tl.getChildren(true, true, false)) {
        state.tweens++;
        const n = typeof t.targets === 'function' ? t.targets().length : -1;
        if (n === 0) { state.emptyTweens++; const v = t.vars && t.vars.id; state.emptyTargets.push(String(v || '(tween ' + state.tweens + ')')); }
      }
    }
    timelines[id] = state;
  }
  return { rootId: root ? root.getAttribute('data-composition-id') : null, ids, timelines, nestedHosts: document.querySelectorAll('[data-composition-src]').length, fontsError: window.__hfFontsError || null };
})()`;

/**
 * Minimal flattened-session CDP client over Bun's WebSocket. Params and results are `any` on purpose:
 * they are untyped protocol JSON, and every field the probe uses is coerced (String/Number) or checked where read.
 */
export class Cdp {
  private nextId = 1;
  private pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private listeners: Array<(method: string, params: any, sessionId?: string) => void> = [];
  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.fail(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        else p.ok(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg.method, msg.params, msg.sessionId);
      }
    };
  }
  static connect(url: string, timeoutMs: number): Promise<Cdp> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => fail(new Error(`CDP connect timed out after ${timeoutMs} ms`)), timeoutMs);
      ws.onopen = () => { clearTimeout(timer); ok(new Cdp(ws)); };
      ws.onerror = () => { clearTimeout(timer); fail(new Error(`CDP connect failed: ${url}`)); };
    });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(new Error(`CDP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); fail(e); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(l: (method: string, params: any, sessionId?: string) => void): void { this.listeners.push(l); }
  close(): void { try { this.ws.close(); } catch { /* socket already closed by the browser exit */ } }
}

/** Read the DevTools endpoint Chrome prints on stderr. */
export async function devtoolsUrl(stderr: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())))]);
    if (chunk === null) break;
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(text);
    if (m) { reader.releaseLock(); return m[1]!; }
  }
  throw new Error(`headless Chrome did not report a DevTools endpoint within ${timeoutMs} ms: ${text.slice(-400)}`);
}

export async function probeTimelines(opts: ProbeOptions): Promise<ProbeResult> {
  const started = performance.now();
  const budgetMs = opts.budgetMs ?? 10_000;
  const entry = resolve(opts.projectDir, opts.entry ?? "index.html");
  const profile = mkdtempSync(join(tmpdir(), "lifeos-hf-probe-"));
  const chrome = Bun.spawn(sandboxed([
    // --no-sandbox: Chrome cannot start its own seatbelt inside sandbox-exec (renderers hang; measured
    // 2026-09-24). The outer profile is the boundary: no outbound network, and the page is our own local file.
    opts.browserPath, "--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--allow-file-access-from-files",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost", `--window-size=${opts.width ?? 1920},${opts.height ?? 1080}`, "about:blank",
  ]), { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  const pageErrors: string[] = [];
  let cdp: Cdp | undefined;
  try {
    cdp = await Cdp.connect(await devtoolsUrl(chrome.stderr, 20_000), 10_000);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    let loaded = false;
    cdp.on((method, params, sid) => {
      if (sid !== sessionId) return;
      if (method === "Runtime.exceptionThrown") pageErrors.push(String(params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text ?? "page error").split("\n")[0]);
      if (method === "Page.loadEventFired") loaded = true;
    });
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    const overrides = JSON.stringify(opts.variables ?? {});
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__hyperframes = window.__hyperframes || { getVariables() { let d = []; try { d = JSON.parse(document.documentElement.getAttribute('data-composition-variables') || '[]'); } catch (e) { d = []; } const o = {}; for (const v of d) if (v && v.id) o[v.id] = v.default; return Object.assign(o, ${overrides}); } };` }, sessionId);
    await cdp.send("Page.navigate", { url: pathToFileURL(entry).href }, sessionId);
    const deadline = Date.now() + budgetMs;
    let state: any = null;
    while (Date.now() < deadline) {
      await Bun.sleep(100);
      if (!loaded) continue;
      const res = await cdp.send("Runtime.evaluate", { expression: PROBE_EXPR, returnByValue: true }, sessionId);
      state = res?.result?.value ?? null;
      if (!state) continue;
      const done = state.ids.length > 0 && state.ids.every((id: string) => state.timelines[id]?.registered);
      if (done || pageErrors.length > 0 || state.fontsError) break;
      if (state.rootId && state.ids.length === 0) break; // every composition is nested or timeline-free
    }
    return judge(state, loaded, pageErrors, opts.expectMotion, budgetMs, Math.round(performance.now() - started));
  } finally {
    cdp?.close();
    chrome.kill("SIGKILL");
    await chrome.exited;
    rmSync(profile, { recursive: true, force: true });
  }
}

/** `state` is the page's JSON answer to PROBE_EXPR (untyped); every field is read defensively below. */
function judge(state: any, loaded: boolean, pageErrors: string[], expectMotion: boolean, budgetMs: number, ms: number): ProbeResult {
  const findings: Finding[] = [];
  const add = (code: string, message: string) => findings.push({ source: "probe", severity: "error", code, message });
  if (!loaded) add("probe-load", `the entry document did not finish loading within ${budgetMs} ms`);
  for (const e of pageErrors) add("page-error", e);
  const timelines: Record<string, TimelineState> = state?.timelines ?? {};
  if (loaded && !state?.rootId) add("no-composition", "no element with data-composition-id in the entry document");
  if (state?.fontsError) add("font-load", `font gate failed: ${state.fontsError}`);
  for (const [id, t] of Object.entries(timelines)) {
    if (!t.registered) { add("timeline-not-registered", `window.__timelines["${id}"] was never registered within ${budgetMs} ms; the render would be a still frame`); continue; }
    if (!t.isTimeline) { add("timeline-not-gsap", `window.__timelines["${id}"] is not a GSAP timeline`); continue; }
    if (expectMotion && !(Number(t.duration) > 0)) add("timeline-empty", `timeline "${id}" has duration ${t.duration}; nothing would move`);
    if ((t.emptyTweens ?? 0) > 0) add("tween-no-target", `timeline "${id}" has ${t.emptyTweens} tween(s) whose selector matched no element: ${(t.emptyTargets ?? []).join(", ")}`);
  }
  if (expectMotion && state?.rootId && Object.keys(timelines).length === 0 && (state?.nestedHosts ?? 0) === 0) {
    add("no-timeline", "motion is expected but the composition declares data-no-timeline and hosts no nested compositions");
  }
  return { ok: findings.length === 0, findings, rootId: state?.rootId ?? null, timelines, nestedHosts: state?.nestedHosts ?? 0, pageErrors, fontsError: state?.fontsError ?? null, ms };
}
