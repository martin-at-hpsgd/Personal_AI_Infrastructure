#!/usr/bin/env bun
/**
 * WindowBounds — on-screen window frames (points, global display space) for a pid,
 * read through CoreGraphics' CGWindowListCopyWindowInfo via bun:ffi. Read-only:
 * no input, no focus change, no Apple Events (which time out on a locked session).
 *
 * The Claude leg needs this to map a window screenshot's pixels to the global
 * point space `interceptor macos click X,Y --app` posts into.
 *
 * CLI: bun WindowBounds.ts <pid>   → JSON array of {id, name, layer, x, y, width, height}
 *
 * @version 1.0.0
 */
import { dlopen, FFIType, ptr, CString } from "bun:ffi";

const CF = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
  CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.cstring, FFIType.u32], returns: FFIType.ptr },
  CFArrayGetCount: { args: [FFIType.ptr], returns: FFIType.i64 },
  CFArrayGetValueAtIndex: { args: [FFIType.ptr, FFIType.i64], returns: FFIType.ptr },
  // u64, never ptr, for values: small CFNumbers/CFStrings are tagged pointers on Apple
  // Silicon (high bit set), which bun:ffi's ptr-as-double return corrupts into a segfault.
  CFDictionaryGetValue: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
  CFNumberGetValue: { args: [FFIType.u64, FFIType.i32, FFIType.ptr], returns: FFIType.bool },
  CFStringGetCString: { args: [FFIType.u64, FFIType.ptr, FFIType.i64, FFIType.u32], returns: FFIType.bool },
  CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
});
const CG = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
  CGWindowListCopyWindowInfo: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
  CGRectMakeWithDictionaryRepresentation: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.bool },
});

const UTF8 = 0x08000100;
const kCFNumberSInt64Type = 4;
const kCGWindowListOptionOnScreenOnly = 1;
const kCGWindowListExcludeDesktopElements = 16;

const keys = new Map<string, unknown>();
function key(s: string) {
  if (!keys.has(s)) keys.set(s, CF.symbols.CFStringCreateWithCString(null, ptr(Buffer.from(s + "\0")), UTF8));
  return keys.get(s) as never;
}
function num(dict: never, k: string): number | null {
  const v = CF.symbols.CFDictionaryGetValue(dict, key(k));
  if (!v) return null;
  const out = new BigInt64Array(1);
  return CF.symbols.CFNumberGetValue(v, kCFNumberSInt64Type, ptr(out)) ? Number(out[0]) : null;
}
function str(dict: never, k: string): string {
  const v = CF.symbols.CFDictionaryGetValue(dict, key(k));
  if (!v) return "";
  const buf = new Uint8Array(512);
  return CF.symbols.CFStringGetCString(v, ptr(buf), buf.length, UTF8) ? new CString(ptr(buf)).toString() : "";
}

export interface WindowFrame { id: number; name: string; layer: number; x: number; y: number; width: number; height: number }

/** Normal-layer, on-screen windows owned by `pid`, front to back. */
export function windowBounds(pid: number, onScreenOnly = true): WindowFrame[] {
  const opts = onScreenOnly ? kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements : kCGWindowListExcludeDesktopElements;
  const list = CG.symbols.CGWindowListCopyWindowInfo(opts, 0);
  if (!list) return [];
  const out: WindowFrame[] = [];
  try {
    const n = Number(CF.symbols.CFArrayGetCount(list));
    for (let i = 0; i < n; i++) {
      const d = CF.symbols.CFArrayGetValueAtIndex(list, i) as never;
      if (num(d, "kCGWindowOwnerPID") !== pid) continue;
      const layer = num(d, "kCGWindowLayer") ?? -1;
      if (layer !== 0) continue;
      const bounds = CF.symbols.CFDictionaryGetValue(d, key("kCGWindowBounds"));
      if (!bounds) continue;
      const rect = new Float64Array(4);
      if (!CG.symbols.CGRectMakeWithDictionaryRepresentation(bounds, ptr(rect))) continue;
      out.push({ id: num(d, "kCGWindowNumber") ?? 0, name: str(d, "kCGWindowName"), layer, x: rect[0], y: rect[1], width: rect[2], height: rect[3] });
    }
  } finally {
    CF.symbols.CFRelease(list);
  }
  return out;
}

if (import.meta.main) {
  const pid = Number(process.argv[2]);
  if (!Number.isInteger(pid) || pid <= 0) { console.error("usage: bun WindowBounds.ts <pid>"); process.exit(2); }
  console.log(JSON.stringify(windowBounds(pid, !process.argv.includes("--all")), null, 2));
}
