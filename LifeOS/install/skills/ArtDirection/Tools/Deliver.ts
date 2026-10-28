#!/usr/bin/env bun
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant.ts';
import { createHash } from 'node:crypto';
import { receiptId, releaseAdmission, sha256File, type ProofFinding } from '../../../LIFEOS/TOOLS/lib/ProofReceipt.ts';
import { recordOutput, redactTarget, type RecordResult } from '../../../LIFEOS/TOOLS/lib/OutputLedger.ts';
import { recheckCodeTier, recheckLine } from '../../../LIFEOS/TOOLS/lib/VideoRecheck.ts';

/** sha256 of a file, or of a directory as every entry's relative path plus its bytes (symlinks by target, never followed). */
export function contentDigest(path: string): string {
  const fileSha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const info = lstatSync(path);
  if (info.isFile()) return fileSha(path);
  invariant(info.isDirectory(), `contentDigest needs a file or directory: ${path}`);
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name), rel = relative(path, full).split(sep).join('/'), entry = lstatSync(full);
      if (entry.isSymbolicLink()) lines.push(`${rel}\0link:${readlinkSync(full)}`);
      else if (entry.isDirectory()) { lines.push(`${rel}/\0dir`); walk(full); }
      else if (entry.isFile()) lines.push(`${rel}\0${fileSha(full)}`);
    }
  };
  walk(path);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export interface DeliveryOptions { artifact: string; critique?: string; to: string }
export interface CopiedFile { source: string; dest: string; bytes: number }
/** What was copied, the open unearned flags the Proof receipt carries (never blocking), and the one line naming them. */
export interface DeliveryResult { files: CopiedFile[]; flags: ProofFinding[]; flagLine: string | null; /** For a video: what the hand-off re-measured on its bytes. */ recheckLine?: string | null; /** For a video: the output line the hand-off wrote (OutputLedger), so an Errata complaint about it can join. */ output?: RecordResult | null }
/** The video re-measure Deliver runs (VideoRecheck.recheckCodeTier); a test hands in a stub for byte strings that are not video. */
export interface DeliveryDeps { recheck?: typeof recheckCodeTier }
/** Resolve existing ancestors too, so a destination symlink cannot point into the source. */
function canonical(file: string): string {
  const path = resolve(file);
  return existsSync(path) ? realpathSync(path) : join(canonical(dirname(path)), basename(path));
}
/** The whole-deck digest a slides critique is bound to (Brief.json deckSha256): every file's path and bytes in the package. */
export function deckDigest(deck: string): string {
  const path = resolve(deck);
  if (extname(path).toLowerCase() !== '.key' || !existsSync(path)) throw new Error(`Not a .key deck: ${path}`);
  newestMtimeMs(path); // refuses symlinks, as delivery does
  return contentDigest(path);
}
/** deliverChecked's copied files, for callers that only need what landed. */
export async function deliver(options: DeliveryOptions, deps: DeliveryDeps = {}): Promise<CopiedFile[]> {
  return (await deliverChecked(options, deps)).files;
}
/** The newest mtime of any file in a deck (a Keynote package directory, or a single-file .key). */
function newestMtimeMs(path: string): number {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`Deck symlinks are not supported: ${path}`);
  if (info.isFile()) return info.mtimeMs;
  return readdirSync(path).reduce((max, name) => Math.max(max, newestMtimeMs(join(path, name))), 0);
}
/**
 * A deck cannot be judged by Critique.ts, which reads images and video, so a deck is delivered on a critique of its
 * exported slide frames: the critique's brief is kind "slides" and carries `deckSha256`, the digest of the whole deck
 * when its frames were exported (`Deliver.ts --deck-digest <deck>`), which must equal the deck's digest now; the frame
 * it names (`artifact`) still has the bytes and mtime the critique scored; and no file in the deck is newer than that
 * frame. The digest is what ties the deck's bytes to the critique: mtimes can be copied or set back.
 * The Proof receipt checked is the frame's. Returns the frame path and the deck digest.
 */
function deckFrame(deck: string, critique: Record<string, unknown>): { frame: string; deckSha256: string } {
  const brief = critique.brief;
  if (typeof brief !== 'object' || brief === null || (brief as { kind?: unknown }).kind !== 'slides') throw new Error('Deck critique must judge the slides: its brief kind must be "slides"');
  const bound = (brief as { deckSha256?: unknown }).deckSha256;
  if (typeof bound !== 'string' || !/^[0-9a-f]{64}$/.test(bound)) throw new Error(`Deck critique must bind the deck: its brief needs deckSha256 from \`bun skills/ArtDirection/Tools/Deliver.ts --deck-digest ${deck}\`, taken when the slides were exported`);
  const now = contentDigest(deck);
  if (bound !== now) throw new Error('Stale critique: the deck digest does not match the deckSha256 its slides critique was bound to; export and critique again');
  const frame = critique.artifact;
  if (typeof frame !== 'string' || !existsSync(frame) || !statSync(frame).isFile()) throw new Error('Deck critique must name the exported slide frame it scored (artifact)');
  if (critique.artifactMtime !== statSync(frame).mtime.toISOString()) throw new Error('Stale critique: the critiqued slide frame changed after the critique');
  if (typeof critique.artifactSha256 !== 'string' || critique.artifactSha256 !== createHash('sha256').update(readFileSync(frame)).digest('hex')) throw new Error('Stale critique: slide frame sha256 does not match the critique receipt');
  if (newestMtimeMs(deck) > statSync(frame).mtimeMs) throw new Error('Stale critique: the deck changed after its slides were exported and critiqued; export and critique again');
  return { frame, deckSha256: now };
}
/**
 * Refuses without: a passing critique (fresh to the artifact bytes) AND an admitted receipt (releaseAdmission), and for a
 * video a clean re-measure of its bytes (VideoRecheck). Returns the
 * receipt's open unearned flags with the files, in the line the Proof hand-off gate prints, so the hand-off can say them.
 * A .key deck (package directory or single file) is delivered on a critique of its exported slides (deckFrame).
 */
export async function deliverChecked(options: DeliveryOptions, deps: DeliveryDeps = {}): Promise<DeliveryResult> {
  const artifact = resolve(options.artifact), to = canonical(options.to);
  const deck = extname(artifact).toLowerCase() === '.key';
  if (deck ? !existsSync(artifact) : !statSync(artifact).isFile()) throw new Error(`Artifact is not a file: ${artifact}`);
  const critiqueFile = resolve(options.critique ?? join(dirname(artifact), 'Critique.json'));
  if (!existsSync(critiqueFile)) throw new Error(`Missing critique: ${critiqueFile}`);
  let critique: unknown;
  try { critique = JSON.parse(readFileSync(critiqueFile, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid critique JSON: ${critiqueFile}`);
    throw error;
  }
  if (typeof critique !== 'object' || critique === null || Array.isArray(critique) || !('verdict' in critique) || typeof critique.verdict !== 'string' || !('artifactMtime' in critique) || typeof critique.artifactMtime !== 'string') throw new Error('Invalid critique shape: verdict and artifactMtime must be strings');
  if (critique.verdict !== 'pass') throw new Error(`Critique verdict is ${critique.verdict}; delivery requires pass`);
  // The file the critique scored and the Proof receipt must describe: the artifact itself, or a deck's exported slide frame.
  const bound = deck ? deckFrame(artifact, critique as Record<string, unknown>) : null;
  const scored = bound ? bound.frame : artifact;
  if (!deck) {
    if (critique.artifactMtime !== statSync(artifact).mtime.toISOString()) throw new Error('Stale critique: artifact mtime does not match artifactMtime');
    // Bound by sha: Critique.ts writes artifactSha256, the sha256 of the bytes it scored. A critique without it, or with
    // another file's, is refused: mtime alone can match changed bytes, and a hand-written Critique.json has no binding.
    if (!('artifactSha256' in critique) || typeof critique.artifactSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(critique.artifactSha256)) throw new Error(`Unbound critique: ${critiqueFile} carries no artifactSha256, so it is not tied to these bytes; run the critique (skills/ArtDirection/Tools/Critique.ts) on ${artifact}`);
    if (critique.artifactSha256 !== createHash('sha256').update(readFileSync(artifact)).digest('hex')) throw new Error('Stale critique: artifact sha256 does not match the critique receipt');
  }
  const deckDest = join(to, basename(artifact));
  const files: CopiedFile[] = deck ? [] : [{ source: artifact, dest: deckDest, bytes: statSync(artifact).size }];
  const directories = [to], review = join(dirname(artifact), 'review');
  function collect(source: string, dest: string, label = 'Review'): void {
    const info = lstatSync(source);
    if (info.isSymbolicLink()) throw new Error(`${label} symlinks are not supported: ${source}`);
    if (info.isDirectory()) {
      directories.push(dest);
      for (const name of readdirSync(source).sort()) collect(join(source, name), join(dest, name), label);
    } else if (info.isFile()) files.push({ source, dest, bytes: info.size });
    else throw new Error(`${label} entry is not a regular file or directory: ${source}`);
  }
  if (deck) {
    const inside = relative(canonical(artifact), canonical(deckDest));
    if (inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..')) throw new Error('Deck destination must not be inside the deck');
    // Copying a package over an older one would leave the older one's files inside it.
    if (existsSync(deckDest) && lstatSync(deckDest).isDirectory()) throw new Error(`Deck destination already exists: ${deckDest}; move it aside first`);
    collect(artifact, deckDest, 'Deck');
  }
  if (extname(artifact).toLowerCase() === '.mp4' && existsSync(review)) {
    const destinationReview = canonical(join(to, 'review')), sourceReview = canonical(review);
    const inside = relative(sourceReview, destinationReview);
    if (inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..')) throw new Error('Review destination must not be inside source review');
    collect(review, join(to, 'review'));
  }
  for (const file of files) {
    if (canonical(file.source) === canonical(file.dest) || existsSync(file.dest) && statSync(file.source).dev === statSync(file.dest).dev && statSync(file.source).ino === statSync(file.dest).ino) throw new Error(`Destination would replace source: ${file.dest}`);
  }
  // The one release rule (ProofReceipt.releaseAdmission), shared with the YouTubeUpload gates: any receipt for these
  // bytes that records a failure refuses; a reference or critique-only receipt refuses; a video needs its VideoEval receipt.
  const scoredSha = await sha256File(scored);
  const proof = await releaseAdmission({ artifact: scored, sha256: scoredSha, boundary: 'handoff', name: basename(artifact) });
  if (!proof.ok) throw new Error(`No passing Assay receipt for ${scored}: ${proof.reason}. Run: ${proof.video ? proof.fix : `bun skills/Assay/Tools/Proof.ts run --artifact ${scored}`}`);
  // A video is re-measured at hand-off too (VideoRecheck, shared with the YouTubeUpload gates): the code tier fresh on
  // these bytes, the skip list from the intent file, and the DA essay badge origin rule. The receipt only adds failures.
  let rechecked: string | null = null;
  if (proof.video && !deck) {
    invariant(proof.receipt !== null, 'an admitted video has the receipt it was admitted on');
    const c = await (deps.recheck ?? recheckCodeTier)(artifact, scored, proof.receipt);
    if (c.problem) throw new Error(`Refusing to hand off ${scored}: ${c.problem}. Fix the render, then: ${proof.fix}`);
    if (await sha256File(scored) !== scoredSha) throw new Error(`Refusing to hand off ${scored}: it changed while it was being re-measured`);
    rechecked = recheckLine(c);
  }
  function assertPassing(): void {
    invariant(critique !== null && typeof critique === 'object' && 'verdict' in critique && critique.verdict === 'pass', 'Delivery requires literal pass');
    invariant('artifactMtime' in critique && critique.artifactMtime === statSync(scored).mtime.toISOString(), 'Delivery requires exact artifact mtime');
  }
  for (const directory of directories) { assertPassing(); mkdirSync(directory, { recursive: true }); }
  for (const file of files) { assertPassing(); copyFileSync(file.source, file.dest); file.bytes = statSync(file.dest).size; }
  // The file that landed is the file that was admitted and re-measured, byte for byte.
  if (!deck) invariant(await sha256File(join(to, basename(artifact))) === scoredSha, `Delivered ${basename(artifact)} does not match the bytes its receipt admitted`);
  if (bound) {
    // The deck that landed is the deck the slides critique was bound to, byte for byte.
    const landed = contentDigest(deckDest);
    invariant(landed === bound.deckSha256, `Delivered deck ${deckDest} does not match the critiqued deck digest`);
  }
  // A video hand-off is an output that crossed a boundary: one output line (OutputLedger, the existing writer) for the
  // bytes that landed, so a complaint about it joins to its receipt. A ledger that cannot be written never undoes the copy.
  const output = proof.video && !deck ? recordHandoff(join(to, basename(artifact)), proof.receipt?.artifact ?? scored, proof.line !== null) : null;
  // ISC-24: an unmeasured receipt is handed over as before, with the line the hand-off must say.
  return { files, flags: proof.flags, flagLine: proof.line, recheckLine: rechecked, output };
}

/** The hand-off's output line: boundary handoff, channel handoff, kind video, the landed bytes, the receipt's store key. Never throws. */
export function recordHandoff(landed: string, receiptArtifact: string, labelled: boolean): RecordResult {
  try {
    return recordOutput({
      session_id: process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || 'no-session',
      boundary: 'handoff', channel: 'handoff', kind: 'video', target: redactTarget(landed), artifact: landed,
      receipt_id: receiptId(receiptArtifact), decision: labelled ? 'allowed-labelled' : 'allowed',
      reason: labelled ? 'handed off with open flags or an unmeasured receipt, named at the gate' : 'admitted by its Assay receipt and the code-tier re-measure',
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    try { process.stderr.write(`output ledger: the hand-off line was not written: ${error}\n`); } catch { /* stderr closed */ }
    return { ok: false, error };
  }
}
if (import.meta.main) {
  try {
    const { values: v } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: { artifact: { type: 'string' }, critique: { type: 'string' }, to: { type: 'string' }, 'deck-digest': { type: 'string' } } });
    // The digest a slides Brief.json carries as deckSha256, taken when the frames are exported.
    if (v['deck-digest']) { console.log(deckDigest(v['deck-digest'])); process.exit(0); }
    if (!v.artifact || !v.to) throw new Error('Use --artifact <file|deck.key> [--critique <Critique.json>] --to <dir>, or --deck-digest <deck.key>');
    const result = await deliverChecked({ artifact: v.artifact, critique: v.critique, to: v.to });
    for (const file of result.files) console.log(`${file.source} → ${file.dest} (${file.bytes} bytes)`);
    if (result.flagLine) console.log(`Proof: ${result.flagLine}. Say so when presenting.`);
    if (result.recheckLine) console.log(`Assay: ${result.recheckLine}`);
    process.exit(0);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
