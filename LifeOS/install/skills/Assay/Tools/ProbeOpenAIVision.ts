/** Explicitly invoked public-only capability probe. Synthesizes its own image; accepts no artifact paths. */
import { deflateSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant.ts';
import { CROSS_VENDOR } from '../../../LIFEOS/TOOLS/models.ts';
import { guardVisionRequest, openAiVision } from './OpenAIVision.ts';

function chunk(type: string, bytes: Buffer): Buffer {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, data, checksum]);
}

/** A freshly synthesized red square on white, with no text, metadata, or personal content. */
export function publicVisionProbePng(): Buffer {
  const width = 96, height = 96;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 3) + 1 + x * 3;
      const square = x >= 24 && x < 72 && y >= 24 && y < 72;
      raw[offset] = 255;
      raw[offset + 1] = square ? 0 : 255;
      raw[offset + 2] = square ? 0 : 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export async function probeOpenAiVision(): Promise<{ passed: boolean; requested_model: string; executed_model?: string; answer: string }> {
  guardVisionRequest('public-synthetic-shape.png');
  const bytes = publicVisionProbePng();
  invariant(bytes.length > 0 && bytes.subarray(1, 4).toString() === 'PNG', 'public capability probe must synthesize its own PNG');
  const directory = mkdtempSync(join(tmpdir(), 'public-vision-probe-'));
  const path = join(directory, 'public-synthetic-shape.png');
  writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  try {
    const response = await openAiVision(path, 'Name the color and geometric shape centered in this image. Return only JSON with string fields color and shape.');
    let answer: { color?: unknown; shape?: unknown } = {};
    try { answer = JSON.parse(response.text); } catch { /* malformed is a failed capability probe */ }
    const passed = typeof answer.color === 'string' && answer.color.toLowerCase() === 'red' && typeof answer.shape === 'string' && answer.shape.toLowerCase() === 'square';
    return { passed, requested_model: CROSS_VENDOR.openaiJudge, ...(response.executed_model ? { executed_model: response.executed_model } : {}), answer: response.text };
  } finally {
    unlinkSync(path);
    rmdirSync(directory);
  }
}

if (import.meta.main) {
  if (Bun.argv.slice(2).join(' ') !== '--run-public-probe') throw new Error('Explicit public-only probe invocation required: --run-public-probe');
  const result = await probeOpenAiVision();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
