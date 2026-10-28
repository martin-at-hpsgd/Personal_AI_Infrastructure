#!/usr/bin/env bun
/**
 * Share.ts — upload a .excalidraw file to excalidraw.com and return the link,
 * with the canvas background under our control (the upstream `share` command
 * hardcodes a white canvas; this tool exists to fix that).
 *
 * Encryption contract ported from mcp-excalidraw-server's share-url.ts (MIT):
 * scene JSON → concatBuffers → zlib deflate → AES-GCM 128 → POST to
 * json.excalidraw.com; the key lives only in the URL fragment.
 *
 * Usage: bun Share.ts <scene.excalidraw> [--bg <hex>]   (default bg #111114)
 */

import { deflateSync } from "zlib";
import { webcrypto } from "crypto";
import { readFileSync } from "fs";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("Usage: bun Share.ts <scene.excalidraw> [--bg <hex>]");
  process.exit(2);
}
const BG = arg("--bg", "#111114");

const scene = JSON.parse(readFileSync(file, "utf8"));
if (!scene.elements?.length) {
  console.error("Scene has no elements");
  process.exit(1);
}
scene.appState = { ...(scene.appState ?? {}), viewBackgroundColor: BG, gridSize: null };
scene.source = "https://excalidraw.com";

// [4-byte version=1][4-byte len][chunk]... — Excalidraw's concatBuffers
function concatBuffers(...bufs: Uint8Array[]): Uint8Array {
  let total = 4;
  for (const b of bufs) total += 4 + b.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1);
  let off = 4;
  for (const b of bufs) {
    dv.setUint32(off, b.length);
    off += 4;
    out.set(b, off);
    off += b.length;
  }
  return out;
}

const encoder = new TextEncoder();
const innerData = concatBuffers(encoder.encode("{}"), encoder.encode(JSON.stringify(scene)));
const compressed = deflateSync(Buffer.from(innerData));

const cryptoKey = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["encrypt"]);
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const encrypted = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, compressed);

const payload = concatBuffers(
  encoder.encode(JSON.stringify({ version: 2, compression: "pako@1", encryption: "AES-GCM" })),
  iv,
  new Uint8Array(encrypted)
);

const res = await fetch("https://json.excalidraw.com/api/v2/post/", { method: "POST", body: Buffer.from(payload) });
if (!res.ok) {
  console.error(`Upload failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const { id } = (await res.json()) as { id: string };
const jwk = await webcrypto.subtle.exportKey("jwk", cryptoKey);
console.log(JSON.stringify({ success: true, url: `https://excalidraw.com/#json=${id},${jwk.k}`, background: BG }));
