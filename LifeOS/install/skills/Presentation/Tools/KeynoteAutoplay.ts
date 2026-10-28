#!/usr/bin/env bun
/**
 * KeynoteAutoplay.ts — make every movie and animated GIF in a Keynote deck start by itself.
 *
 *   bun KeynoteAutoplay.ts <deck.key> [--check]
 *   bun KeynoteAutoplay.ts --self-test
 *
 * Keynote turns an inserted animated GIF into a movie object and gives it a "start movie" build
 * (KN.BuildArchive, type 8, effect "apple:movie-start") whose build chunk (KN.BuildChunkArchive,
 * type 153) has `automatic` (field 5) = 0: the movie waits for a click in the show. Its own export
 * reports that event as `automaticPlay: false`, and its scripting dictionary cannot change it.
 * (TSD.MovieArchive field 8 `autoPlay` is deprecated and ignored; measured.)
 * This tool rewrites the deck's Index/*.iwa files so every movie-start chunk is automatic, which is
 * Keynote's "After Transition": the movie starts the moment its slide appears.
 *
 * An .iwa file is a run of chunks, each a 0x00 byte, a 3-byte little-endian length, and a raw snappy
 * block. Inside, archives repeat as: varint length, a TSP.ArchiveInfo (message_infos with type and
 * length), then each message's bytes. A patched chunk gets field 5 set to 1 (appended when absent),
 * its MessageInfo.length is rewritten, and the file is re-encoded as literal-only snappy.
 *
 * `--check` reports movies and their autoplay state without writing. Exit: 0 done, 1 failed, 2 usage.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";

export const BUILD_TYPE = 8;
export const BUILD_CHUNK_TYPE = 153;
const CHUNK_AUTOMATIC = 5;
const MOVIE_START = "apple:movie-start";

// ── varint / protobuf ───────────────────────────────────────────────────────

export function readVarint(b: Uint8Array, at: number): [number, number] {
  let v = 0, shift = 0, i = at;
  for (;;) {
    invariant(i < b.length, "varint runs past the end of the buffer");
    const byte = b[i++]!;
    v += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [v, i];
    shift += 7;
    invariant(shift < 64, "varint too long");
  }
}

export function writeVarint(v: number): number[] {
  const out: number[] = [];
  do { let byte = v % 128; v = Math.floor(v / 128); if (v > 0) byte |= 0x80; out.push(byte); } while (v > 0);
  return out;
}

export interface Field { num: number; wire: number; raw: Uint8Array; value?: number; body?: Uint8Array }

/** Split a protobuf message into its fields, keeping each field's exact bytes. */
export function fields(msg: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < msg.length) {
    const start = i;
    const [key, a] = readVarint(msg, i); i = a;
    const num = Math.floor(key / 8), wire = key % 8;
    let value: number | undefined, body: Uint8Array | undefined;
    if (wire === 0) { [value, i] = readVarint(msg, i); }
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) { const [len, b] = readVarint(msg, i); body = msg.subarray(b, b + len); i = b + len; }
    else throw new Error(`unsupported wire type ${wire} for field ${num}`);
    invariant(i <= msg.length, "field runs past the end of its message");
    out.push({ num, wire, raw: msg.subarray(start, i), value, body });
  }
  return out;
}

const concat = (parts: (Uint8Array | number[])[]): Uint8Array => {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) { out.set(a, at); at += a.length; }
  return out;
};

const lengthDelimited = (num: number, body: Uint8Array) => concat([writeVarint(num * 8 + 2), writeVarint(body.length), body]);
const varintField = (num: number, v: number) => Uint8Array.from([...writeVarint(num * 8), ...writeVarint(v)]);

/** The last value of a varint field, as protobuf reads it, or undefined. */
export function lastVarint(msg: Uint8Array, num: number): number | undefined {
  let v: number | undefined;
  for (const f of fields(msg)) if (f.num === num && f.wire === 0) v = f.value;
  return v;
}

// ── snappy (raw block) ──────────────────────────────────────────────────────

export function snappyDecode(src: Uint8Array): Uint8Array {
  const [len, start] = readVarint(src, 0);
  const out = new Uint8Array(len);
  let i = start, o = 0;
  while (i < src.length) {
    const tag = src[i++]!, kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) { const bytes = n - 59; n = 0; for (let k = 0; k < bytes; k++) n |= src[i++]! << (8 * k); }
      n += 1;
      out.set(src.subarray(i, i + n), o); i += n; o += n;
      continue;
    }
    let length: number, offset: number;
    if (kind === 1) { length = ((tag >> 2) & 7) + 4; offset = ((tag >> 5) << 8) | src[i++]!; }
    else if (kind === 2) { length = (tag >> 2) + 1; offset = src[i]! | (src[i + 1]! << 8); i += 2; }
    else { length = (tag >> 2) + 1; offset = src[i]! | (src[i + 1]! << 8) | (src[i + 2]! << 16) | (src[i + 3]! << 24); i += 4; }
    invariant(offset > 0 && offset <= o, `snappy copy offset ${offset} outside the ${o} bytes written`);
    for (let k = 0; k < length; k++) { out[o] = out[o - offset]!; o++; }
  }
  invariant(o === len, `snappy block decoded to ${o} bytes, header says ${len}`);
  return out;
}

/** A valid snappy block made only of literals. Larger than compressed, always correct. */
export function snappyEncodeLiteral(data: Uint8Array): Uint8Array {
  const parts: (Uint8Array | number[])[] = [writeVarint(data.length)];
  for (let i = 0; i < data.length; i += 65536) {
    const n = Math.min(65536, data.length - i), m = n - 1;
    parts.push(m < 60 ? [m << 2] : m < 256 ? [60 << 2, m] : [61 << 2, m & 0xff, m >> 8]);
    parts.push(data.subarray(i, i + n));
  }
  return concat(parts);
}

// ── .iwa ────────────────────────────────────────────────────────────────────

export function iwaDecode(file: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [];
  let i = 0;
  while (i < file.length) {
    invariant(file[i] === 0, `iwa chunk at ${i} does not start with 0x00`);
    const len = file[i + 1]! | (file[i + 2]! << 8) | (file[i + 3]! << 16);
    blocks.push(snappyDecode(file.subarray(i + 4, i + 4 + len)));
    i += 4 + len;
  }
  return concat(blocks);
}

export function iwaEncode(payload: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  // Keynote writes chunks of at most 64 KiB of uncompressed data; keep to that.
  for (let i = 0; i < payload.length || i === 0; i += 65536) {
    const block = snappyEncodeLiteral(payload.subarray(i, i + 65536));
    invariant(block.length < 1 << 24, "iwa chunk too large for its 3-byte length");
    parts.push(Uint8Array.from([0, block.length & 0xff, (block.length >> 8) & 0xff, (block.length >> 16) & 0xff]), block);
    if (payload.length === 0) break;
  }
  return concat(parts);
}

export interface MovieState { file: string; chunk: number; autoplay: boolean }

interface Message { type: number; body: Uint8Array }
interface Archive { id: number; infoFields: Field[]; messages: Message[] }

export function parsePayload(payload: Uint8Array): Archive[] {
  const out: Archive[] = [];
  let i = 0;
  while (i < payload.length) {
    const [infoLen, a] = readVarint(payload, i);
    const infoFields = fields(payload.subarray(a, a + infoLen));
    let at = a + infoLen;
    const messages: Message[] = [];
    for (const f of infoFields.filter((x) => x.num === 2)) {
      const mi = fields(f.body!);
      const type = mi.find((x) => x.num === 1)?.value, len = mi.find((x) => x.num === 3)?.value;
      invariant(type !== undefined && len !== undefined, "a MessageInfo lacks type or length");
      messages.push({ type, body: payload.subarray(at, at + len) });
      at += len;
    }
    out.push({ id: infoFields.find((x) => x.num === 1)?.value ?? -1, infoFields, messages });
    i = at;
  }
  return out;
}

export function writePayload(archives: Archive[]): Uint8Array {
  const out: Uint8Array[] = [];
  for (const ar of archives) {
    let m = 0;
    const info = ar.infoFields.map((f) => {
      if (f.num !== 2) return f.raw;
      const body = ar.messages[m++]!.body;
      return lengthDelimited(2, concat(fields(f.body!).map((x) => (x.num === 3 ? varintField(3, body.length) : x.raw))));
    });
    const infoBytes = concat(info);
    out.push(Uint8Array.from(writeVarint(infoBytes.length)), infoBytes, ...ar.messages.map((x) => x.body));
  }
  return concat(out);
}

/** Ids of the build archives whose effect is the movie start. */
export function movieStartBuilds(archives: Archive[]): Set<number> {
  const ids = new Set<number>(), needle = new TextEncoder().encode(MOVIE_START);
  for (const ar of archives) for (const m of ar.messages) {
    if (m.type !== BUILD_TYPE) continue;
    const b = Buffer.from(m.body);
    if (b.includes(Buffer.from(needle))) ids.add(ar.id);
  }
  return ids;
}

/** Set (or report) `automatic` on every build chunk that runs one of `builds`. */
export function patchChunks(archives: Archive[], builds: Set<number>, write: boolean): { chunk: number; before: boolean }[] {
  const seen: { chunk: number; before: boolean }[] = [];
  for (const ar of archives) for (const m of ar.messages) {
    if (m.type !== BUILD_CHUNK_TYPE) continue;
    const fs = fields(m.body), ref = fs.find((x) => x.num === 1);
    const target = ref?.body ? fields(ref.body).find((x) => x.num === 1)?.value : undefined;
    if (target === undefined || !builds.has(target)) continue;
    const before = lastVarint(m.body, CHUNK_AUTOMATIC) === 1;
    seen.push({ chunk: ar.id, before });
    if (write && !before) {
      const has = fs.some((x) => x.num === CHUNK_AUTOMATIC);
      m.body = has ? concat(fs.map((x) => (x.num === CHUNK_AUTOMATIC ? varintField(CHUNK_AUTOMATIC, 1) : x.raw))) : concat([m.body, varintField(CHUNK_AUTOMATIC, 1)]);
    }
  }
  return seen;
}

// ── .key ────────────────────────────────────────────────────────────────────

function run(cmd: string[], cwd?: string): void {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd[0]} failed: ${new TextDecoder().decode(p.stderr).trim().slice(-300)}`);
}

export function autoplay(deck: string, write = true): MovieState[] {
  const key = resolve(deck);
  if (!existsSync(key)) throw new Error(`no such deck: ${key}`);
  const isDir = statSync(key).isDirectory();
  const work = mkdtempSync(join(tmpdir(), "keynote-autoplay-"));
  try {
    const root = isDir ? key : join(work, "x");
    if (!isDir) run(["unzip", "-q", key, "-d", root]);
    const index = join(root, "Index");
    invariant(existsSync(index), `${key} has no Index folder; not a Keynote package`);
    const found: MovieState[] = [];
    const files = readdirSync(index).filter((n) => n.endsWith(".iwa")).sort();
    const parsed = new Map(files.map((n) => [n, parsePayload(iwaDecode(readFileSync(join(index, n))))]));
    const builds = new Set<number>();
    for (const archives of parsed.values()) for (const id of movieStartBuilds(archives)) builds.add(id);
    for (const [name, archives] of parsed) {
      const r = patchChunks(archives, builds, write);
      for (const c of r) found.push({ file: name, chunk: c.chunk, autoplay: write ? true : c.before });
      if (write && r.some((c) => !c.before)) {
        const payload = writePayload(archives);
        // Round-trip guard: the rewritten file must decode back with every movie-start chunk automatic.
        const again = patchChunks(parsePayload(iwaDecode(iwaEncode(payload))), builds, false);
        invariant(again.length === r.length && again.every((c) => c.before), `${name}: patched payload does not read back with autoplay on`);
        writeFileSync(join(index, name), iwaEncode(payload));
      }
    }
    if (write && !isDir) {
      const tmpKey = join(dirname(key), `.${basename(key, ".key")}.autoplay.key`);
      rmSync(tmpKey, { force: true });
      run(["zip", "-q", "-0", "-X", "-r", tmpKey, "."], root);
      renameSync(tmpKey, key);
    }
    return found;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Synthetic archives only: a movie-start build, a fade build, and one chunk for each. */
function selfTest(): number {
  let fails = 0;
  const t = (name: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fails++; };
  const enc = new TextEncoder();
  const archive = (id: number, type: number, body: Uint8Array) => {
    const info = concat([varintField(1, id), lengthDelimited(2, concat([varintField(1, type), varintField(3, body.length)]))]);
    return concat([writeVarint(info.length), info, body]);
  };
  const ref = (id: number) => lengthDelimited(1, varintField(1, id));
  const payload = concat([
    archive(10, BUILD_TYPE, lengthDelimited(2, enc.encode(MOVIE_START))),
    archive(12, BUILD_TYPE, lengthDelimited(2, enc.encode("apple:dissolve"))),
    archive(11, BUILD_CHUNK_TYPE, concat([ref(10), varintField(CHUNK_AUTOMATIC, 0)])),
    archive(13, BUILD_CHUNK_TYPE, ref(12)),
  ]);
  t("varint round-trips 300 and 2^40", readVarint(Uint8Array.from(writeVarint(300)), 0)[0] === 300 && readVarint(Uint8Array.from(writeVarint(2 ** 40)), 0)[0] === 2 ** 40);
  t("snappy decodes a copy op", new TextDecoder().decode(snappyDecode(Uint8Array.from([8, 0x08, 97, 98, 99, 0x01 | (1 << 2), 3]))) === "abcabcab");
  const big = new Uint8Array(150_000).map((_, i) => i % 251);
  t("iwa round-trips a payload larger than one chunk", Buffer.from(iwaDecode(iwaEncode(big))).equals(Buffer.from(big)));
  const archives = parsePayload(iwaDecode(iwaEncode(payload)));
  t("payload parses and writes back byte-identical", Buffer.from(writePayload(archives)).equals(Buffer.from(payload)));
  const builds = movieStartBuilds(archives);
  t("only the movie-start build is found", builds.size === 1 && builds.has(10));
  t("check mode reports the movie chunk waiting for a click", JSON.stringify(patchChunks(archives, builds, false)) === JSON.stringify([{ chunk: 11, before: false }]));
  patchChunks(archives, builds, true);
  const again = parsePayload(iwaDecode(iwaEncode(writePayload(archives))));
  const chunk = (id: number) => again.find((a) => a.id === id)!.messages[0]!.body;
  t("the movie chunk reads back automatic", lastVarint(chunk(11), CHUNK_AUTOMATIC) === 1);
  t("the other build's chunk is untouched", lastVarint(chunk(13), CHUNK_AUTOMATIC) === undefined);
  t("a second pass changes nothing", patchChunks(again, builds, false).every((c) => c.before));
  console.log(fails ? `${fails} failed` : "all passed");
  return fails ? 1 : 0;
}

if (import.meta.main) {
  if (process.argv.includes("--self-test")) process.exit(selfTest());
  const args = process.argv.slice(2), deck = args.find((a) => !a.startsWith("--"));
  if (!deck || args.some((a) => a.startsWith("--") && a !== "--check")) { console.error("usage: bun KeynoteAutoplay.ts <deck.key> [--check] | --self-test"); process.exit(2); }
  try {
    const check = args.includes("--check");
    const movies = autoplay(deck, !check);
    for (const m of movies) console.log(`${m.file} chunk ${m.chunk}: ${m.autoplay ? "starts automatically" : "waits for a click"}`);
    console.log(`${check ? "found" : "✓ set autoplay on"} ${movies.length} movie${movies.length === 1 ? "" : "s"}`);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
}
