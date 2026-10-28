#!/usr/bin/env bun
/**
 * AddImage.ts — embed a local image into the canvas as an Excalidraw image element.
 *
 * Registers the image bytes as a file (POST /api/files with a data URL) and adds
 * an `image` element that references it by fileId. The file travels with the
 * scene through export and through Share.ts, so shared links and .excalidraw
 * files render the picture with no external dependency.
 *
 * Usage:
 *   bun AddImage.ts <image> --x N --y N [--w N] [--h N] [--id <elemId>]
 *   bun AddImage.ts <image> --replace <shapeId>   # size+place over an existing shape's box
 *
 * With --w/--h omitted the intrinsic pixel size is used (capped to 480 on the
 * long edge); with only one given, the other follows the image's aspect ratio. --replace reads the target shape's geometry and fits the image
 * inside it (keeping aspect), so a screenshot can stand in for a placeholder box.
 */

import { readFileSync } from "fs";
import { extname } from "path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}
function num(name: string): number | undefined {
  const v = arg(name);
  return v == null ? undefined : Number(v);
}

const imgPath = process.argv[2];
if (!imgPath || imgPath.startsWith("--")) {
  console.error("Usage: bun AddImage.ts <image> --x N --y N [--w N] [--h N] [--replace <shapeId>] [--id <elemId>]");
  process.exit(2);
}

const PORT = process.env.EXCALIDRAW_PORT ?? "3579";
const URL_ = process.env.EXPRESS_SERVER_URL ?? `http://127.0.0.1:${PORT}`;

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp" };
const mimeType = MIME[extname(imgPath).toLowerCase()] ?? "image/png";

const bytes = readFileSync(imgPath);
const dataURL = `data:${mimeType};base64,${bytes.toString("base64")}`;

// Intrinsic size read from the file header for every type in MIME, so one-dimension sizing and
// --replace keep the real aspect ratio. Only an unreadable header falls back to a default box.
function imageSize(b: Buffer): [number, number] | null {
  // PNG: IHDR width/height.
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  // GIF: logical screen size, little-endian.
  if (b.length > 10 && b.toString("ascii", 0, 3) === "GIF") return [b.readUInt16LE(6), b.readUInt16LE(8)];
  // JPEG: walk the markers to the first start-of-frame (SOF0-SOF15, minus DHT/JPG/DAC).
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }
  // WebP: RIFF....WEBP with a VP8 (lossy), VP8L (lossless) or VP8X (extended) first chunk.
  if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (chunk === "VP8L") { const v = b.readUInt32LE(21); return [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1]; }
    if (chunk === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    return null;
  }
  // SVG: width/height on the root element when both are plain numbers or px, else the viewBox.
  const text = b.toString("utf8", 0, Math.min(b.length, 4096));
  const root = text.match(/<svg\b[^>]*>/i)?.[0];
  if (root) {
    const attr = (n: string) => root.match(new RegExp(`\\s${n}\\s*=\\s*["']\\s*([\\d.]+)\\s*(px)?\\s*["']`, "i"))?.[1];
    const w = Number(attr("width")), h = Number(attr("height"));
    if (w > 0 && h > 0) return [w, h];
    const vb = root.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (vb && Number(vb[1]) > 0 && Number(vb[2]) > 0) return [Number(vb[1]), Number(vb[2])];
  }
  return null;
}
let iw = 320, ih = 200;
const nat = imageSize(bytes);
if (nat && nat[0] > 0 && nat[1] > 0) [iw, ih] = nat;
else console.error(`AddImage: could not read the size of ${imgPath}; using a ${iw}x${ih} box`);

let x = num("--x") ?? 0;
let y = num("--y") ?? 0;
let w = num("--w");
let h = num("--h");

const replaceId = arg("--replace");
if (replaceId) {
  const res = await fetch(`${URL_}/api/elements/${replaceId}`);
  if (!res.ok) { console.error(`Target shape ${replaceId} not found`); process.exit(1); }
  const t = (await res.json()) as any;
  const el = t.element ?? t;
  const pad = 8;
  const boxW = el.width - pad * 2, boxH = el.height - pad * 2;
  const scale = Math.min(boxW / iw, boxH / ih);
  w = iw * scale; h = ih * scale;
  x = el.x + (el.width - w) / 2;
  y = el.y + (el.height - h) / 2;
}

if (w != null && h == null) {
  h = w * (ih / iw); // one dimension given: keep the image's aspect ratio
} else if (h != null && w == null) {
  w = h * (iw / ih);
} else if (w == null || h == null) {
  const cap = 480;
  const scale = Math.min(1, cap / Math.max(iw, ih));
  w = iw * scale; h = ih * scale;
}

const fileId = `img_${Math.abs([...dataURL].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36)}`;

const fRes = await fetch(`${URL_}/api/files`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ files: [{ id: fileId, dataURL, mimeType, created: 0 }] }),
});
if (!fRes.ok) { console.error(`File upload failed: ${fRes.status}`); process.exit(1); }

const elemId = arg("--id") ?? `image-${fileId}`;
const element = { id: elemId, type: "image", x, y, width: Math.round(w), height: Math.round(h), fileId, status: "saved" };

const eRes = await fetch(`${URL_}/api/elements/batch`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ elements: [element] }),
});
if (!eRes.ok) { console.error(`Element add failed: ${eRes.status}`); process.exit(1); }

console.log(JSON.stringify({ success: true, fileId, elemId, x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }));
