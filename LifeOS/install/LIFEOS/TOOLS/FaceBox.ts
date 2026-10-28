#!/usr/bin/env bun
/**
 * FaceBox.ts — face geometry for a still image, via Apple's Vision framework.
 *
 * Wraps FaceBox.swift: compiles it to a cached binary on first use (and whenever the source is
 * newer), then runs it. Emits the Swift tool's JSON unchanged:
 *
 *   { "w": <px>, "h": <px>, "faces": [ { x, y, w, h, cx, cy, eyeY }, ... ] }
 *
 * All face values are fractions of the image with a TOP-LEFT origin, largest face first.
 *
 * Usage:  bun FaceBox.ts <image> [--largest]
 *         --largest  emit only the largest face object (exit 3 if there is no face)
 *
 * macOS only — Vision has no portable equivalent. Callers that must run elsewhere need their own
 * fallback; the maintainer-private video skill’s ThumbnailText.ts tool falls back to an alpha-silhouette estimate and says so in its JSON.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = dirname(Bun.fileURLToPath(import.meta.url));
const SRC = join(HERE, "FaceBox.swift");
const CACHE = join(HERE, ".cache");
const BIN = join(CACHE, "facebox");

export function ensureBinary(): string {
  if (!existsSync(SRC)) throw new Error(`FaceBox.swift missing at ${SRC}`);
  const fresh = existsSync(BIN) && statSync(BIN).mtimeMs >= statSync(SRC).mtimeMs;
  if (!fresh) {
    mkdirSync(CACHE, { recursive: true });
    const r = spawnSync("swiftc", ["-O", SRC, "-o", BIN], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`swiftc failed: ${r.stderr?.slice(0, 400)}`);
  }
  return BIN;
}

export type Face = { x: number; y: number; w: number; h: number; cx: number; cy: number; eyeY: number };
export type FaceBoxResult = { w: number; h: number; faces: Face[] };

/** Detect faces. Returns null when the platform or toolchain cannot run Vision at all. */
export function faceBox(image: string): FaceBoxResult | null {
  let bin: string;
  try {
    bin = ensureBinary();
  } catch {
    return null;
  }
  try {
    // stderr carries a Vision info line on every run; keep it off stdout and ignore it.
    const out = execFileSync(bin, [image], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(out) as FaceBoxResult;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const image = process.argv[2];
  if (!image || !existsSync(image)) {
    console.error("usage: bun FaceBox.ts <image> [--largest]");
    process.exit(1);
  }
  const res = faceBox(image);
  if (!res) {
    console.error("FaceBox: detection unavailable (macOS + swiftc required)");
    process.exit(2);
  }
  if (process.argv.includes("--largest")) {
    const f = res.faces[0];
    if (!f) {
      console.error("FaceBox: no face found");
      process.exit(3);
    }
    console.log(JSON.stringify({ ...f, imgW: res.w, imgH: res.h }, null, 2));
  } else {
    console.log(JSON.stringify(res, null, 2));
  }
}
