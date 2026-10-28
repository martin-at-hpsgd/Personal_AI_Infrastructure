/**
 * ProofKinds — the one answer to "what kind is this file, and can Proof measure it?".
 *
 * Proof (skills/Assay/Tools/Proof.ts) re-exports kindFromPath from here; the hand-off gate (hooks/ProofGate.hook.ts, maintainer-side, not shipped) (maintainer-side; not in the public release)
 * and the output recorder (hooks/OutputRecord.hook.ts, maintainer-side, not shipped) import from here. There is no second extension list anywhere. (maintainer-side; not in the public release)
 *
 * Two questions, two tables:
 *   - KIND_EXTS: which extensions belong to which ProofKind. Proof's kindFromPath reads it.
 *   - KIND_SUPPORT: for each ProofKind, whether Proof can really measure a bare file of that kind today. It is an
 *     exhaustive Record, so a ProofKind added to ProofReceipt.ts does not compile here until someone decides, and a
 *     kind flipped to `measurable: true` is gated everywhere at once (Fable B2 #1428: gating a kind Proof cannot run
 *     would leave only a false "reference" receipt, so the decision is written down per kind, with its reason).
 *
 * `page` and `doc` are measurable for TEXT checks (S5, 2026-09-30). A page (html/htm) is reduced to its visible text in
 * code (no browser); a doc is pdf (pdftotext) or word-processor (textutil: docx, doc, rtf, odt) text. `.pages` is NOT in KIND_EXTS.doc: textutil cannot read it, so it stays in DOC_EXTS only and is UNPROOFED like pptx. Both then
 * run the same text checks as `text`: non-empty, text-present/absent, the count types, Glance, and the always-on
 * safety scan. Neither is measured VISUALLY here: a page proofed with --project keeps the frame/OCR path, and a bare
 * page or a doc has no rendered frame. An extractor that fails (missing binary, encrypted PDF, no text layer) reads
 * unavailable, never pass.
 *
 * `text` is measurable (non-empty, text-present and text-absent, Glance checks), but opening a text file is how a file
 * is edited, not how an output is presented, so `open` leaves text alone (OPEN_EXEMPT). Delivery (copy into
 * Downloads/Desktop, Write/Edit there, Artifact publish) still gates it.
 *
 * Unknown types (2026-09-30): any regular file outside every list above is kind "other" (outputKind, outputKindByName). It is
 * recorded in the output ledger and has no Proof method; the kind only chooses how a file is proofed, never whether it is an output.
 *
 * @version 1.1.0
 */
import { statSync } from "node:fs";
import { extname } from "node:path";
import type { ProofKind } from "./ProofReceipt.ts";

export const KIND_EXTS = {
  video: [".mp4", ".mov", ".webm", ".mkv", ".m4v"],
  image: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".bmp"],
  audio: [".wav", ".mp3", ".m4a", ".flac", ".aac", ".ogg", ".aiff"],
  text: [".txt", ".md", ".markdown", ".json", ".csv", ".diff", ".patch"],
  page: [".html", ".htm"],
  doc: [".pdf", ".docx", ".doc", ".rtf", ".odt"],
} as const satisfies Record<ProofKind, readonly string[]>;

export type KindSupport = { measurable: boolean; why: string };

export const KIND_SUPPORT: Record<ProofKind, KindSupport> = {
  video: { measurable: true, why: "frames, OCR, marks, loudness" },
  image: { measurable: true, why: "OCR, marks, prominence" },
  audio: { measurable: true, why: "loudness, gate scan" },
  text: { measurable: true, why: "non-empty, text-present/absent, count checks, Glance, safety scan" },
  page: { measurable: true, why: "visible text extracted in code, then the text checks and the safety scan; a project run adds frames and OCR" },
  doc: { measurable: true, why: "text extracted with pdftotext or textutil, then the text checks and the safety scan; no visual measurement" },
};

/** Kinds `open` does not gate even though Proof can measure them: opening text is editing, not presenting. */
export const OPEN_EXEMPT: ReadonlySet<ProofKind> = new Set<ProofKind>(["text"]);

/** Document files the output ledger counts as outputs (kind "doc"). Those in KIND_EXTS.doc are measurable for text; the rest (pptx, key, xlsx, numbers, pages) are not. */
export const DOC_EXTS = [".pdf", ".pptx", ".key", ".docx", ".xlsx", ".pages", ".numbers", ".rtf"] as const;

/** The ProofKind of a path by extension, or null. */
export function kindFromPath(p: string): ProofKind | null {
  const e = extname(p).toLowerCase();
  for (const kind of Object.keys(KIND_EXTS) as ProofKind[]) if ((KIND_EXTS[kind] as readonly string[]).includes(e)) return kind;
  return null;
}

/** Partial-download names: a file still being written by a browser or a sync client. Never an output until it is renamed. */
export const TRANSIENT_NAME = /\.(crdownload|part|tmp|download|icloud|partial)$/i;
/** Finder bookkeeping files that every folder carries. The only dotfiles that are not outputs. */
export const IGNORED_NAMES: ReadonlySet<string> = new Set([".DS_Store", ".localized"]);

/** True for a name that is never an output: Finder bookkeeping or a partial download. */
export function ignoredName(name: string): boolean {
  return IGNORED_NAMES.has(name) || TRANSIENT_NAME.test(name);
}

/**
 * The kind of output a file of this NAME is, from its extension alone (no disk access): a ProofKind, "doc", "other" for
 * any extension not in a known list (or none), or null for an ignored name. The scan has already established the entry is
 * a regular file, so it calls this one; `outputKind` adds the regular-file check for callers holding a bare path.
 */
export function outputKindByName(p: string): ProofKind | "doc" | "other" | null {
  const name = p.slice(p.lastIndexOf("/") + 1);
  if (ignoredName(name)) return null;
  const k = kindFromPath(p);
  if (k) return k;
  return (DOC_EXTS as readonly string[]).includes(extname(p).toLowerCase()) ? "doc" : "other";
}

const isRegularFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };

/**
 * The kind of output a file is for the ledger: a ProofKind, "doc", or "other" for any REGULAR file not in a known list
 * (the kind only chooses how the file is proofed; "other" has no Proof method, so it is recorded unproofed). Null when the
 * path is not a regular file (missing, a directory) or the name is ignored (.DS_Store, .localized, partial downloads).
 */
export function outputKind(p: string): ProofKind | "doc" | "other" | null {
  const k = outputKindByName(p);
  if (k === null) return null;
  if (k !== "other") return k;
  return isRegularFile(p) ? "other" : null;
}

/** The kind Proof can really measure for this path, or null (unknown extension, or a kind Proof cannot measure yet). */
export function measurableKind(p: string): ProofKind | null {
  const k = kindFromPath(p);
  return k && KIND_SUPPORT[k].measurable ? k : null;
}

/** The kind `open` gates for this path: measurable and not exempt. */
export function viewedKind(p: string): ProofKind | null {
  const k = measurableKind(p);
  return k && !OPEN_EXEMPT.has(k) ? k : null;
}

/** A regex matching any extension of a kind `open` gates, for spotting media named through a variable. */
export function viewedExtRegex(): RegExp {
  const exts = (Object.keys(KIND_EXTS) as ProofKind[])
    .filter((k) => KIND_SUPPORT[k].measurable && !OPEN_EXEMPT.has(k))
    .flatMap((k) => KIND_EXTS[k] as readonly string[])
    .map((e) => e.slice(1));
  return new RegExp(`\\.(${exts.join("|")})\\b`, "i");
}
