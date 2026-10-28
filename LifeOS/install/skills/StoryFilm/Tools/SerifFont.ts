/**
 * SerifFont.ts — the caption and card serif, as font files the HyperFrames seam can embed.
 *
 * The composition must carry its own @font-face: a family without one makes the HyperFrames compiler
 * fetch it from Google Fonts (and the seam's preflight refuses that). So the serif is always a file:
 *   - the skill config's `fonts.serif` / `fonts.serifItalic` (paths to faces you are licensed to embed), or
 *   - the default: Source Serif 4 Regular and Italic (SIL Open Font License 1.1, which permits embedding),
 *     installed by Setup.ts as the pinned `@fontsource/source-serif-4` dependency. Its Latin subset covers
 *     English captions; configure a fuller face for other scripts.
 * A config path may name one face of a collection (.ttc) with a `#<index>` suffix: `~/fonts/House.ttc#2`.
 * Chrome does not load a collection through @font-face, so that face is extracted into a standalone sfnt first.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { FontFaceSpec } from "../../../LIFEOS/TOOLS/HyperFrames/fonts.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { expandHome, type SkillConfig } from "./Lib.ts";

/** The CSS family every StoryFilm composition sets its text in. */
export const SERIF_FAMILY = "StoryFilmSerif";

export interface FontRef { path: string; index?: number }

/** The default serif: the openly licensed Source Serif 4 faces from the pinned fontsource package. */
export const DEFAULT_SERIF_PACKAGE = "@fontsource/source-serif-4";
export const DEFAULT_SERIF_DIR = join(import.meta.dir, "node_modules", "@fontsource", "source-serif-4", "files");
export const DEFAULT_SERIF: { serif: FontRef; serifItalic: FontRef } = {
  serif: { path: join(DEFAULT_SERIF_DIR, "source-serif-4-latin-400-normal.woff2") },
  serifItalic: { path: join(DEFAULT_SERIF_DIR, "source-serif-4-latin-400-italic.woff2") },
};

/** `path` or `path#index` → a font reference. */
export function parseFontRef(ref: string): FontRef {
  const m = /^(.*)#(\d+)$/.exec(ref);
  return m ? { path: expandHome(m[1]!), index: Number(m[2]) } : { path: expandHome(ref) };
}

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
const u16 = (b: Uint8Array, o: number) => (b[o]! << 8) + b[o + 1]!;
function put32(b: Uint8Array, o: number, v: number): void { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }

/** OpenType checksum: the sum of big-endian u32 words, zero-padded to a multiple of four bytes. */
export function sfntChecksum(b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < b.length; i += 4) sum = (sum + (((b[i] ?? 0) << 24) >>> 0) + ((b[i + 1] ?? 0) << 16) + ((b[i + 2] ?? 0) << 8) + (b[i + 3] ?? 0)) >>> 0;
  return sum;
}

/** True when the bytes are a font collection (`ttcf`). */
export function isCollection(b: Uint8Array): boolean { return b.length >= 12 && String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === "ttcf"; }

/**
 * One face of a font collection as a standalone sfnt: its table directory with offsets rewritten,
 * every table copied 4-byte aligned, and head.checkSumAdjustment recomputed for the new file.
 */
export function extractCollectionFace(ttc: Uint8Array, index: number): Uint8Array {
  invariant(isCollection(ttc), "not a font collection (no ttcf header)");
  const count = u32(ttc, 8);
  invariant(Number.isInteger(index) && index >= 0 && index < count, `collection has ${count} faces, asked for index ${index}`);
  const at = u32(ttc, 12 + 4 * index);
  invariant(at + 12 <= ttc.length, `face ${index} offset ${at} is past the end of the file`);
  const numTables = u16(ttc, at + 4);
  const dirEnd = at + 12 + 16 * numTables;
  invariant(numTables > 0 && dirEnd <= ttc.length, `face ${index} table directory is truncated`);
  const tables = Array.from({ length: numTables }, (_, i) => {
    const r = at + 12 + 16 * i;
    const tag = String.fromCharCode(ttc[r]!, ttc[r + 1]!, ttc[r + 2]!, ttc[r + 3]!);
    const offset = u32(ttc, r + 8), length = u32(ttc, r + 12);
    invariant(offset + length <= ttc.length, `table ${tag} of face ${index} runs past the end of the file`);
    return { tag, checksum: u32(ttc, r + 4), offset, length, record: r };
  });
  const headerLen = 12 + 16 * numTables;
  let size = headerLen;
  for (const t of tables) size += (t.length + 3) & ~3;
  const out = new Uint8Array(size);
  out.set(ttc.subarray(at, at + 12), 0);
  let cursor = headerLen;
  let headAt = -1;
  tables.forEach((t, i) => {
    const r = 12 + 16 * i;
    out.set(ttc.subarray(t.record, t.record + 8), r); // tag + checksum
    put32(out, r + 8, cursor);
    put32(out, r + 12, t.length);
    out.set(ttc.subarray(t.offset, t.offset + t.length), cursor);
    if (t.tag === "head") headAt = cursor;
    cursor += (t.length + 3) & ~3;
  });
  invariant(headAt >= 0, `face ${index} has no head table`);
  put32(out, headAt + 8, 0);
  put32(out, headAt + 8, (0xb1b0afba - sfntChecksum(out)) >>> 0);
  return out;
}

/** Resolve one reference to a single-face font file: the path itself, or an extracted face written under `workDir`. */
export function faceFile(ref: FontRef, workDir: string, name: string): string {
  invariant(existsSync(ref.path), `serif font not found: ${ref.path}`);
  const bytes = new Uint8Array(readFileSync(ref.path));
  if (!isCollection(bytes)) {
    invariant(ref.index === undefined || ref.index === 0, `${basename(ref.path)} is a single font; index ${ref.index} does not exist`);
    return ref.path;
  }
  invariant(ref.index !== undefined, `${basename(ref.path)} is a font collection: name the face with #<index>`);
  const out = join(workDir, `${name}.ttf`);
  writeFileSync(out, extractCollectionFace(bytes, ref.index));
  return out;
}

/**
 * The faces to embed. A configured serif wins; its italic is used when configured, otherwise the browser
 * slants the roman (as the Remotion build did). No configured serif means the default serif, roman and italic.
 */
export function serifFaces(config: SkillConfig, workDir: string): FontFaceSpec[] {
  const fonts = config.fonts ?? {};
  if (!fonts.serif) {
    for (const ref of [DEFAULT_SERIF.serif, DEFAULT_SERIF.serifItalic]) {
      invariant(existsSync(ref.path), `default serif missing (${basename(ref.path)}): run \`bun Setup.ts\` to install ${DEFAULT_SERIF_PACKAGE}, or set fonts.serif in the skill config`);
    }
  }
  const serif = fonts.serif ? parseFontRef(fonts.serif) : DEFAULT_SERIF.serif;
  const italic = fonts.serif ? (fonts.serifItalic ? parseFontRef(fonts.serifItalic) : undefined) : DEFAULT_SERIF.serifItalic;
  const faces: FontFaceSpec[] = [{ family: SERIF_FAMILY, path: faceFile(serif, workDir, "serif"), weight: 400, style: "normal" }];
  if (italic) faces.push({ family: SERIF_FAMILY, path: faceFile(italic, workDir, "serif-italic"), weight: 400, style: "italic" });
  return faces;
}
