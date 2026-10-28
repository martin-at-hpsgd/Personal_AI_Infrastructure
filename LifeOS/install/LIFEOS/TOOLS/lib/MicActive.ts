// MicActive — read-only question to CoreAudio: is the dictation app's microphone
// input running right now? Voice mode uses it to stop the DA's speech the instant
// the principal starts dictating (barge-in).
//
// Ported from the pedal repo's src/audio.ts (the same probe the pedal uses to
// tell a start press from a stop press). Kept here rather than imported because
// LifeOS must not depend on a sibling checkout. Nothing here changes audio state.
// macOS only: every other platform answers false.
//
// The app is named in LIFEOS/USER/CUSTOMIZATIONS/DICTATION/App.ts; its bundle
// path fragment is "/<label>.app/". Dictation apps record from helper processes
// inside their bundles, and their input runs only while dictating.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync } from "node:fs";

/** The install's dictation-app module, or null when none is configured (USER data never ships, so a fresh install has none). */
async function dictationApp(): Promise<any> {
  const path = new URL("../../USER/CUSTOMIZATIONS/DICTATION/App.ts", import.meta.url).pathname;
  return existsSync(path) ? await import(path) : null;
}

type Probe = { readU32s(object: number, selector: string): number[]; pidPath(pid: number): string };

let probe: Probe | null | undefined;

function load(): Probe | null {
  if (probe !== undefined) return probe;
  if (process.platform !== "darwin") return (probe = null);
  try {
    const CA = dlopen("/System/Library/Frameworks/CoreAudio.framework/CoreAudio", {
      AudioObjectGetPropertyDataSize: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      AudioObjectGetPropertyData: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    }).symbols;
    const libc = dlopen("/usr/lib/libSystem.B.dylib", {
      proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    }).symbols;
    const fourCC = (s: string) => [...s].reduce((a, c) => (a << 8) | c.charCodeAt(0), 0) >>> 0;
    probe = {
      readU32s(object, selector) {
        const address = new Uint32Array([fourCC(selector), fourCC("glob"), 0]);
        const size = new Uint32Array(1);
        if (CA.AudioObjectGetPropertyDataSize(object, ptr(address), 0, null, ptr(size)) || !size[0]) return [];
        const out = new Uint32Array(size[0] / 4);
        if (CA.AudioObjectGetPropertyData(object, ptr(address), 0, null, ptr(size), ptr(out))) return [];
        return [...out.subarray(0, size[0] / 4)];
      },
      pidPath(pid) {
        const buf = Buffer.alloc(4096);
        const n = libc.proc_pidpath(pid, ptr(buf), buf.length);
        return n > 0 ? buf.toString("utf8", 0, n) : "";
      },
    };
  } catch {
    probe = null;
  }
  return probe;
}

// CoreAudio process objects are stable for a process's lifetime, so each path is
// resolved once and forgotten when the process goes away.
const processPath = new Map<number, string>();
const SYSTEM_OBJECT = 1;

/** True while any process whose path contains `appPath` has its audio input running. */
export function appRecording(appPath: string): boolean {
  const p = load();
  if (!p || !appPath) return false;
  const objects = p.readU32s(SYSTEM_OBJECT, "prs#");
  for (const key of processPath.keys()) if (!objects.includes(key)) processPath.delete(key);
  return objects.some((object) => {
    let path = processPath.get(object);
    if (path === undefined) {
      const pid = p.readU32s(object, "ppid")[0];
      path = pid ? p.pidPath(pid) : "";
      processPath.set(object, path);
    }
    return path.includes(appPath) && p.readU32s(object, "piri")[0] === 1;
  });
}

/** The bundle-path fragment for the configured dictation app, or "" when none is configured. */
export async function dictationAppPath(): Promise<string> {
  try {
    const mod = await dictationApp();
    const label = mod?.app?.label;
    return typeof label === "string" && label ? `/${label}.app/` : "";
  } catch {
    return "";
  }
}

/**
 * Bundle-path fragments whose input running means the principal started talking,
 * from the USER dictation config's `talkMicPaths`, else the dictation app alone.
 */
export async function talkMicPaths(): Promise<string[]> {
  try {
    const mod = await dictationApp();
    if (typeof mod?.talkMicPaths === "function") {
      const paths = mod.talkMicPaths(process.env.HOME ?? "");
      if (Array.isArray(paths)) return paths.filter((p: unknown): p is string => typeof p === "string" && p.length > 0);
    }
  } catch { /* no USER config: fall through */ }
  const app = await dictationAppPath();
  return app ? [app] : [];
}

/** True while any of the given talk mics is recording. */
export function anyRecording(paths: readonly string[]): boolean {
  return paths.some((p) => appRecording(p));
}

if (import.meta.main) {
  // `--watch <ms>`: poll and print each change with its time, for timing a real pedal press (ISC-19).
  const paths = await talkMicPaths();
  const i = process.argv.indexOf("--watch");
  if (i < 0) {
    console.log(JSON.stringify({ paths, recording: Object.fromEntries(paths.map((p) => [p, appRecording(p)])) }));
  } else {
    const ms = Number(process.argv[i + 1] ?? 15000);
    const start = performance.now();
    let last = "";
    while (performance.now() - start < ms) {
      const now = paths.map((p) => `${p}=${appRecording(p)}`).join(" ");
      if (now !== last) { console.log(`${Math.round(performance.now() - start)}ms ${now}`); last = now; }
      await Bun.sleep(10);
    }
  }
}
