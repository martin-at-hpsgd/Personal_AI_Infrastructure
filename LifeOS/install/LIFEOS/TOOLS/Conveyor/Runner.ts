#!/usr/bin/env bun
/**
 * Conveyor Runner — the stage engine (P2, stage 1: inbox → prep via transcription).
 *
 * P1 gave us drop → ledger → board. Nothing advanced a card off INBOX because
 * no process owned that job. This is that process: it claims an inbox item with
 * a lease, extracts its audio, transcribes it, writes the transcript into the
 * ledger, and advances the card to `prep`. That's the first visible movement.
 *
 * Scope (deliberately bounded):
 *   - ONLY the inbox → prep transition (transcription). PRODUCE (derivatives),
 *     REVIEW (the gate), and the external PUBLISH legs are follow-on phases and
 *     are NOT run here. External publishing stays human-gated per doctrine.
 *   - Lease-based claim so two runners never fight over one item. Attempt cap
 *     stops a poisoned item (corrupt file) from looping forever.
 *
 * Writer note: the ledger is append-only and order-authoritative. In P1 the
 * watcher was the sole writer; now the runner also appends (src: 'runner').
 * Writes are seconds-rare and mostly sequential, but strict cross-process
 * single-writer safety (a shared lock in appendEvents adopted by both watcher
 * and runner) is a known follow-up — flagged, not hidden.
 *
 * CLI:
 *   bun Runner.ts --once        claim + process the oldest claimable inbox item, exit
 *   bun Runner.ts --id <id>     process one specific item, exit
 *   bun Runner.ts --all         process every claimable inbox item once, exit
 *   bun Runner.ts               service loop (KeepAlive): poll + process one at a time
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { assertSafeDestination } from '../lib/NoFollowWrite';
import {
  appendEvents,
  readState,
  type ContentEvent,
  type ContentItem,
} from './Ledger';
import { getClaudeDir, getLifeosDir } from '../Paths'; // public issue #1974 @sabo961, PR #1918 @PigLardLord

const LIFEOS = getLifeosDir();
const ARTIFACT_DIR = join(LIFEOS, 'MEMORY', 'STATE', 'content-pipeline', 'artifacts');
const TRANSCRIBE = join(getClaudeDir(), 'skills', 'AudioEditor', 'Tools', 'Transcribe.ts');
const LEASE_MS = Number(process.env.CONVEYOR_LEASE_MS || 30 * 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.CONVEYOR_MAX_ATTEMPTS || 3);
const POLL_MS = Number(process.env.CONVEYOR_RUNNER_POLL_MS || 20_000);
const OWNER = `runner-${process.pid}`;

const now = (): string => new Date().toISOString();

// ── Ledger event helpers ────────────────────────────────────────────────────

/** Thrown when the item was deleted mid-stage — cancels the stage, writes nothing. */
class ItemDeletedError extends Error {}

function writeEvent(id: string, fields: Record<string, unknown>, unset?: string[]): void {
  // Deletion is cancellation: a dashboard delete between steps must not be
  // resurrected as a ghost row by an in-flight progress write.
  if (!readState().items[id]) throw new ItemDeletedError(`${id} deleted — stage cancelled, write suppressed`);
  const event: ContentEvent = { v: 1, ts: now(), id, op: 'upsert', fields: { ...fields, updated: now() }, src: 'runner' };
  if (unset && unset.length) event.unset = unset;
  appendEvents([event]);
}

// ── Item id + artifact path safety ──────────────────────────────────────────

/** Ledger item ids become directory names. The watcher mints 12-hex hash prefixes; anything outside this shape is refused. */
export const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The artifact directory for an item id, created under `base`. Refuses an id that is not a plain name, and verifies
 * (via realpathSync, so a planted symlink counts) that the directory really sits inside the artifact root before
 * anything is written to it.
 */
export function artifactDirFor(id: string, base: string = ARTIFACT_DIR): string {
  if (typeof id !== 'string' || !ITEM_ID_RE.test(id)) throw new Error(`unsafe item id refused: ${JSON.stringify(String(id)).slice(0, 80)}`);
  mkdirSync(base, { recursive: true });
  const baseReal = realpathSync(base);
  const dir = join(baseReal, id);
  mkdirSync(dir, { recursive: true });
  const real = realpathSync(dir);
  if (!real.startsWith(baseReal + sep)) throw new Error(`artifact directory escapes the artifact root: ${id}`);
  return real;
}

/** Items the runner may act on: the ledger key equals the item's own id (a fields.id override is refused) and the id is a plain name. */
export function trustedItems(items: Record<string, ContentItem>): ContentItem[] {
  return Object.entries(items)
    .filter(([key, item]) => item && item.id === key && ITEM_ID_RE.test(key))
    .map(([, item]) => item);
}

// ── Artifact outputs ─────────────────────────────────

/** The files the transcription stage leaves in an item's artifact directory. */
export type StageOutputs = { wav: string; transcript: string };

/**
 * Run the stage's writers so nothing they write can follow a symlink planted at an output name. ffmpeg (run
 * with -y) and the transcriber open their output path and follow whatever is there, and a confined directory does
 * not stop a planted `audio.wav -> ~/somewhere`. So the writers write into a fresh private directory that
 * mkdtemp creates inside the verified artifact directory (nothing can be planted in it beforehand), each output
 * is checked to be a regular file, and only then renamed over its final name. A final name that is a symlink or
 * any non-regular entry is refused before and after the writers run: rename would replace it, but a planted
 * link is an attack to report, not a file to clobber quietly.
 */
export function stageArtifacts(artDir: string, write: (wav: string, transcript: string) => void): StageOutputs {
  const finals: StageOutputs = { wav: join(artDir, 'audio.wav'), transcript: join(artDir, 'transcript.json') };
  for (const p of Object.values(finals)) assertSafeDestination(p, artDir);
  const staging = mkdtempSync(join(artDir, '.stage-'));
  try {
    const tmp: StageOutputs = { wav: join(staging, 'audio.wav'), transcript: join(staging, 'transcript.json') };
    write(tmp.wav, tmp.transcript);
    for (const p of Object.values(tmp)) {
      let st;
      try { st = lstatSync(p); } catch { throw new Error(`stage writer produced no ${p.slice(staging.length + 1)}`); }
      if (!st.isFile()) throw new Error(`stage writer left a non-file at ${p.slice(staging.length + 1)}`);
    }
    for (const key of ['wav', 'transcript'] as const) {
      assertSafeDestination(finals[key], artDir);
      renameSync(tmp[key], finals[key]);
    }
    return finals;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ── Claim logic (pure — testable) ───────────────────────────────────────────

/** Claimable = in inbox, under the attempt cap, and not under a live lease held by another owner. */
export function claimable(item: ContentItem, nowMs: number, owner = OWNER): boolean {
  if (!ITEM_ID_RE.test(String(item.id))) return false;
  if (item.stage !== 'inbox') return false;
  if (Number(item.attempt ?? 0) >= MAX_ATTEMPTS) return false;
  const exp = item.lease_expires ? Date.parse(String(item.lease_expires)) : 0;
  if (Number.isFinite(exp) && exp > nowMs && item.lease_owner !== owner) return false;
  return true;
}

/** Oldest claimable inbox item by created time. */
export function pickNext(items: ContentItem[], nowMs: number): ContentItem | undefined {
  return items
    .filter((it) => claimable(it, nowMs))
    .sort((a, b) => String(a.created ?? '').localeCompare(String(b.created ?? '')))[0];
}

// ── Transcription stage ─────────────────────────────────────────────────────

function extractAudio(src: string, outWav: string): void {
  // ffmpeg accepts both video and audio inputs; 16kHz mono is what whisper wants.
  const r = spawnSync('ffmpeg', ['-nostdin', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', outWav], {
    encoding: 'utf-8',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(`ffmpeg audio extraction failed (${r.status}): ${String(r.stderr).trim().split('\n').slice(-2).join(' ')}`);
  }
}

function transcribe(wav: string, outJson: string): void {
  const r = spawnSync('bun', [TRANSCRIBE, wav, '--output', outJson], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(`transcription failed (${r.status}): ${String(r.stderr).trim().split('\n').slice(-2).join(' ')}`);
  }
  if (!existsSync(outJson)) throw new Error('transcription reported success but produced no output file');
}

/** Run the inbox → prep stage for one item. Returns the new stage or throws. */
function processItem(item: ContentItem): 'prep' {
  const artDir = artifactDirFor(item.id);

  // Claim: write a lease before doing any work.
  writeEvent(item.id, {
    lease_owner: OWNER,
    lease_expires: new Date(Date.now() + LEASE_MS).toISOString(),
    stage_status: 'running',
    activity: 'claimed',
    activity_at: now(),
  });

  if (!existsSync(item.path)) throw new Error(`source file missing: ${item.path}`);

  const { transcript: transcriptPath } = stageArtifacts(artDir, (wav, transcriptOut) => {
    console.log(`[conveyor-runner] ${item.id} extracting audio…`);
    writeEvent(item.id, { activity: 'extracting audio', activity_at: now() });
    extractAudio(item.path, wav);
    console.log(`[conveyor-runner] ${item.id} transcribing…`);
    writeEvent(item.id, { activity: 'transcribing', activity_at: now() });
    transcribe(wav, transcriptOut);
  });

  writeEvent(
    item.id,
    { stage: 'prep', stage_status: 'done', activity: 'transcribed → prep', activity_at: now(), transcript: transcriptPath, prepped_at: now() },
    ['lease_owner', 'lease_expires', 'error'],
  );
  console.log(`[conveyor-runner] ${item.id} → prep (transcript: ${transcriptPath})`);
  return 'prep';
}

function failItem(item: ContentItem, err: unknown): void {
  if (err instanceof ItemDeletedError) {
    console.log(`[conveyor-runner] ${item.id} cancelled: ${err.message}`);
    return;
  }
  const attempt = Number(item.attempt ?? 0) + 1;
  const blocked = attempt >= MAX_ATTEMPTS;
  const msg = String(err instanceof Error ? err.message : err);
  try {
    writeEvent(
      item.id,
      { attempt, error: msg, stage_status: blocked ? 'failed' : 'pending', blocked, activity: `${blocked ? 'blocked' : 'retry pending'}: ${msg.slice(0, 60)}`, activity_at: now() },
      ['lease_owner', 'lease_expires'],
    );
  } catch (writeErr) {
    if (!(writeErr instanceof ItemDeletedError)) throw writeErr;
    console.log(`[conveyor-runner] ${item.id} deleted during failure handling — nothing written`);
    return;
  }
  console.error(`[conveyor-runner] ${item.id} stage failed (attempt ${attempt}${blocked ? ', BLOCKED' : ''}): ${err}`);
}

// ── Drivers ─────────────────────────────────────────────────────────────────

function runOne(item: ContentItem | undefined): boolean {
  if (!item) return false;
  try {
    processItem(item);
  } catch (err) {
    failItem(item, err);
  }
  return true;
}

function main(): void {
  const argv = process.argv.slice(2);
  const idFlag = argv.indexOf('--id');
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  if (idFlag !== -1) {
    const id = argv[idFlag + 1];
    const item = trustedItems(readState().items).find((it) => it.id === id);
    if (!item) { console.error(`[conveyor-runner] no item with id ${id}`); process.exit(1); }
    runOne(item);
    return;
  }

  if (argv.includes('--all')) {
    let n = 0;
    // Re-read between items so leases/advances are reflected.
    for (;;) {
      const item = pickNext(trustedItems(readState().items), Date.now());
      if (!item) break;
      runOne(item);
      n++;
    }
    console.log(`[conveyor-runner] --all processed ${n} item(s)`);
    return;
  }

  if (argv.includes('--once')) {
    const item = pickNext(trustedItems(readState().items), Date.now());
    if (!item) console.log('[conveyor-runner] no claimable inbox item');
    else runOne(item);
    return;
  }

  // Service loop.
  console.log(`[conveyor-runner] service loop (poll ${POLL_MS}ms, owner ${OWNER})`);
  const tick = (): void => {
    try {
      const item = pickNext(trustedItems(readState().items), Date.now());
      if (item) runOne(item);
    } catch (err) {
      console.error(`[conveyor-runner] tick error: ${err}`);
    }
  };
  tick();
  setInterval(tick, POLL_MS);
}

if (import.meta.main) main();
