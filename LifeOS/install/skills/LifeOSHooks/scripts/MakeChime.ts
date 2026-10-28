#!/usr/bin/env bun
/**
 * MakeChime.ts — writes `assets/chime.wav`, the plugin's one sound (FUNCTIONHOOKS F12, ISC-184/185).
 *
 * A soft two-partial bell (a fifth apart, the upper one quieter), exponential decay, a 6 ms attack so it
 * never clicks, mono 16-bit PCM at 22.05 kHz, 0.7 s. Deterministic: the same bytes every run.
 *
 *   bun scripts/MakeChime.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const RATE = 22_050;
const SECONDS = 0.7;
const PEAK = 0.32; // well under full scale: a cue, not an alarm

const n = Math.round(RATE * SECONDS);
const pcm = new Int16Array(n);
for (let i = 0; i < n; i++) {
  const t = i / RATE;
  const attack = Math.min(1, t / 0.006);
  const tail = Math.min(1, (SECONDS - t) / 0.05); // fade the last 50 ms to silence
  const env = attack * tail * Math.exp(-t * 6.5);
  const v = Math.sin(2 * Math.PI * 880 * t) + 0.45 * Math.sin(2 * Math.PI * 1320 * t) * Math.exp(-t * 4);
  pcm[i] = Math.round(Math.max(-1, Math.min(1, (v / 1.45) * env * PEAK)) * 32767);
}

const data = new Uint8Array(pcm.buffer);
const head = new DataView(new ArrayBuffer(44));
const ascii = (o: number, s: string) => { for (let k = 0; k < s.length; k++) head.setUint8(o + k, s.charCodeAt(k)); };
ascii(0, "RIFF"); head.setUint32(4, 36 + data.length, true); ascii(8, "WAVE");
ascii(12, "fmt "); head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true);
head.setUint32(24, RATE, true); head.setUint32(28, RATE * 2, true); head.setUint16(32, 2, true); head.setUint16(34, 16, true);
ascii(36, "data"); head.setUint32(40, data.length, true);

const out = join(dirname(import.meta.dir), "assets", "chime.wav");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([new Uint8Array(head.buffer), data]));
console.log(`${out} ${44 + data.length} bytes`);
