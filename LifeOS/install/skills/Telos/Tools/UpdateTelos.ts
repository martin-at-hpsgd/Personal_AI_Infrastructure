#!/usr/bin/env bun
/**
 * update-telos - Update TELOS life context with automatic backups and change tracking
 *
 * This command manages updates to the TELOS life context files, ensuring:
 * - Automatic timestamped backups before any modification
 * - Change tracking in updates.md
 * - Complete version history
 *
 * Usage:
 *   update-telos <file> "<content>" "<change-description>" [--section "<heading>"]
 *   update-telos TELOS.md --region current|ideal --body-file <file> ["<change-description>"]
 *
 * Example:
 *   update-telos BOOKS.md "- Project Hail Mary by Andy Weir" "Added new favorite book"
 *   update-telos TELOS.md "### Capture\n\nOne gesture..." "Added capture ideal state" --section "Ideal State"
 *
 * Without --section, content appends at EOF (above a trailing italic footer when
 * the file has one). With --section, content lands at the END of the named
 * section — TELOS.md is section-structured, so an EOF append would file an
 * Ideal State entry under Changelog. Fails closed when the section is absent.
 * When the section carries a machine-owned AUTOMATED region, the insert lands
 * above its BEGIN marker, and headings inside a region never match --section.
 *
 * --region rewrites ONLY the bytes between the AUTOMATED markers of the named
 * region (LIFEOS/TOOLS/TelosRegions.ts owns the format). It skips the write
 * when the content hash is unchanged, backs up under its own prefix
 * (Backups/TELOS.region-*) so hand-edit backups are never pruned by it, never
 * touches the H2 `<!-- updated -->` markers or the frontmatter, and logs one
 * short updates.md line only when it actually writes. When updates.md stays
 * locked, the region write still stands and the CLI exits 2 with the missing
 * line on stderr (exit 1 means nothing was written).
 *
 * Files that can be updated:
 * - BELIEFS.md - Core beliefs and world model
 * - BOOKS.md - Favorite books
 * - CHALLENGES.md - Current challenges
 * - FRAMES.md - Mental frames and perspectives
 * - GOALS.md - Life goals
 * - LESSONS.md - Lessons learned
 * - MISSION.md - Life mission
 * - MODELS.md - Mental models
 * - MOVIES.md - Favorite movies
 * - NARRATIVES.md - Personal narratives
 * - PREDICTIONS.md - Predictions about the future
 * - PROBLEMS.md - Problems to solve
 * - PROJECTS.md - Active projects
 * - STRATEGIES.md - Strategies being employed
 * - TELOS.md - Main TELOS document
 * - TRAUMAS.md - Past traumas
 * - WISDOM.md - Accumulated wisdom
 * - WRONG.md - Things I was wrong about
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync } from 'fs';
import { basename, dirname, join } from 'path';
import { getPrincipal } from '../../../hooks/lib/identity';
import { homedir } from "node:os";
import { invariant, InvariantViolation } from '../../../LIFEOS/TOOLS/Invariant';
import { TelosLockTimeout, withTelosLock, type TelosLockHandle, type TelosLockOptions } from '../../../LIFEOS/TOOLS/TelosLock';
import { exciseRegions, parseRegions, planRegionWrite, REGION_WHICH, RegionError, type RegionWhich } from '../../../LIFEOS/TOOLS/TelosRegions';

// Same resolution as DashboardTemplate/lib/telos-data.ts: the config root honors
// CLAUDE_CONFIG_DIR (isolated installs), LIFEOS_USER_DIR relocates the user tree,
// and the HOME fallback reads $HOME before os.homedir() (public issue #1919 item 2, @dissembler21-png).
const CONFIG_ROOT = process.env.CLAUDE_CONFIG_DIR || join((process.env.HOME ?? process.env.USERPROFILE ?? homedir()), '.claude');
const TELOS_DIR = join(process.env.LIFEOS_USER_DIR || join(CONFIG_ROOT, 'LIFEOS', 'USER'), 'TELOS');
// Changelog file: prefer whichever casing already exists (older installs used
// 'Updates.md'; the docs and scaffold use 'updates.md'), so case-sensitive
// filesystems never fork the changelog into two files (public issue #1452).
// When neither exists it is created lazily as lowercase 'updates.md'.
function resolveUpdatesFile(telosDir: string = TELOS_DIR): string {
  const lower = join(telosDir, 'updates.md');
  const upper = join(telosDir, 'Updates.md');
  if (existsSync(lower)) return lower;
  if (existsSync(upper)) return upper;
  return lower;
}

// Valid TELOS files
const VALID_FILES = [
  'BELIEFS.md', 'BOOKS.md', 'CHALLENGES.md', 'FRAMES.md', 'GOALS.md',
  'LESSONS.md', 'MISSION.md', 'MODELS.md', 'MOVIES.md', 'NARRATIVES.md',
  'PREDICTIONS.md', 'PROBLEMS.md', 'PROJECTS.md', 'STRATEGIES.md',
  'TELOS.md', 'TRAUMAS.md', 'WISDOM.md', 'WRONG.md'
];

function getLocalTimestamp(now: Date = new Date()): string {
  const principal = getPrincipal();
  const timezone = principal.timezone || 'UTC';
  const localTime = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

  const year = localTime.getFullYear();
  const month = String(localTime.getMonth() + 1).padStart(2, '0');
  const day = String(localTime.getDate()).padStart(2, '0');
  const hours = String(localTime.getHours()).padStart(2, '0');
  const minutes = String(localTime.getMinutes()).padStart(2, '0');
  const seconds = String(localTime.getSeconds()).padStart(2, '0');

  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function getLocalDateForLog(now: Date = new Date()): string {
  const principal = getPrincipal();
  const timezone = principal.timezone || 'UTC';
  const localTime = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

  const year = localTime.getFullYear();
  const month = String(localTime.getMonth() + 1).padStart(2, '0');
  const day = String(localTime.getDate()).padStart(2, '0');
  const hours = String(localTime.getHours()).padStart(2, '0');
  const minutes = String(localTime.getMinutes()).padStart(2, '0');
  const seconds = String(localTime.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} (${timezone})`;
}

/**
 * Insert `content` at the END of the section whose heading starts with
 * `section` (case-insensitive, hashes stripped — so "Ideal State" matches
 * "## Ideal State (The IDEAL in ...)"). A section ends at the next heading of
 * the same or higher level, or at a standalone `---` divider, whichever comes
 * first. Returns null when the section is not found so the caller can fail
 * closed rather than silently appending to the wrong place.
 */
export function insertIntoSection(fileContent: string, section: string, content: string): string | null {
  const lines = fileContent.split('\n');
  const wanted = section.replace(/^#+\s*/, '').trim().toLowerCase();
  // Lines inside a machine-owned AUTOMATED region: never a --section match, and
  // a hand insert lands above the region's BEGIN marker, never inside or below it.
  const regions = parseRegions(fileContent).regions;
  const inRegion = (i: number) => regions.some((r) => i >= r.beginLine && i <= r.endLine);

  let startIdx = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (inRegion(i)) continue;
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m && m[2].trim().toLowerCase().startsWith(wanted)) {
      startIdx = i;
      level = m[1].length;
      break;
    }
  }
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (regions.some((r) => r.beginLine === i)) { endIdx = i; break; }
    if (inRegion(i)) continue;
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) { endIdx = i; break; }
    if (lines[i].trim() === '---') { endIdx = i; break; }
  }

  // Back up over trailing blank lines so the insert sits flush with the last
  // content line, then re-open one blank line of separation.
  let insertAt = endIdx;
  while (insertAt > startIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;

  const needsTrailingBlank = lines[insertAt] !== undefined && lines[insertAt].trim() !== '';
  const block = ['', ...content.split('\n'), ...(needsTrailingBlank ? [''] : [])];
  lines.splice(insertAt, 0, ...block);
  return lines.join('\n');
}

/**
 * Copy `sourceFile` into `backupsDir` as `<prefix><stamp>.md` and prune that
 * prefix to the `keep` newest. Prefixes never overlap: hand edits use
 * `TELOS-`, region writes use `TELOS.region-`, so neither prune can remove
 * the other's backups. Git is the durable history; these only cover the gap
 * before the next repo sync (without a prune, stale backups pile up without
 * bound; seen 2026-07-12). Returns the backup's file name.
 */
export function takeBackup(backupsDir: string, sourceFile: string, prefix: string, stamp: string, keep = 3): string {
  invariant(prefix.length > 0 && !prefix.includes('/'), `backup prefix must be a bare file-name prefix, got "${prefix}"`);
  invariant(keep >= 1, 'backup window must keep at least one backup');
  mkdirSync(backupsDir, { recursive: true });
  let name = `${prefix}${stamp}.md`;
  for (let n = 2; existsSync(join(backupsDir, name)); n++) name = `${prefix}${stamp}-${n}.md`;
  copyFileSync(sourceFile, join(backupsDir, name));
  const stale = readdirSync(backupsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
    .sort()
    .slice(0, -keep);
  invariant(!stale.includes(name), `prune would remove the backup just taken: ${name}`);
  for (const f of stale) rmSync(join(backupsDir, f));
  return name;
}

/**
 * Put `entry` right after the "## Future Changes" line of updates.md (newest
 * first), or append when the marker is absent. Creates the changelog on a
 * fresh install (#1452). Throws on I/O failure; callers decide how to report.
 */
function prependUpdateEntry(telosDir: string, entry: string, lockOpts?: TelosLockOptions): 'inserted' | 'appended' {
  const updatesFile = resolveUpdatesFile(telosDir);
  return withTelosLock(updatesFile, (lock) => prependUpdateEntryLocked(updatesFile, entry, lock), lockOpts);
}

function prependUpdateEntryLocked(updatesFile: string, entry: string, lock: TelosLockHandle): 'inserted' | 'appended' {
  invariant(lock.held(), 'updates.md lock is held for the changelog write');
  if (!existsSync(updatesFile)) {
    writeFileSync(updatesFile, '# TELOS Updates\n\nChangelog of TELOS file updates, newest first.\n', 'utf-8');
  }
  const updatesContent = readFileSync(updatesFile, 'utf-8');
  const futureChangesMarker = '## Future Changes';
  const insertPosition = updatesContent.indexOf(futureChangesMarker);
  if (insertPosition !== -1) {
    const beforeMarker = updatesContent.substring(0, insertPosition + futureChangesMarker.length);
    const afterMarker = updatesContent.substring(insertPosition + futureChangesMarker.length);
    const nextLineBreak = afterMarker.indexOf('\n');
    const headerSection = afterMarker.substring(0, nextLineBreak + 1);
    const changesList = afterMarker.substring(nextLineBreak + 1);
    const next = beforeMarker + headerSection + entry + changesList;
    invariant(next.length === updatesContent.length + entry.length && next.includes(entry), 'updates.md insert would drop existing changelog bytes');
    writeFileSync(updatesFile, next, 'utf-8');
    return 'inserted';
  }
  const next = updatesContent.trimEnd() + '\n' + entry;
  invariant(next.startsWith(updatesContent.trimEnd()) && next.endsWith(entry), 'updates.md append would drop existing changelog bytes');
  writeFileSync(updatesFile, next, 'utf-8');
  return 'appended';
}

/** Prefix region-write backups carry; distinct from the hand-edit `TELOS-` prefix. */
export const REGION_BACKUP_PREFIX = 'TELOS.region-';

export interface RegionWriteOptions {
  telosDir: string;
  which: RegionWhich;
  body: string;
  description: string;
  /** Clock for the stamp, the backup name and the log line. Defaults to now. */
  now?: Date;
  /** Wait and staleness bounds for the shared TELOS lock. */
  lock?: TelosLockOptions;
}

/**
 * Whether the updates.md line for a landed region write was written. When it
 * was not (updates.md stayed locked past the wait, or an I/O error), the region
 * write still stands; `entry` is the exact line that is missing so the caller
 * can report it and the operator can add it by hand.
 */
export type RegionChangelog = { logged: true } | { logged: false; error: string; entry: string };

export interface RegionWriteResult {
  written: boolean;
  /** contentHash of the requested body. */
  hash: string;
  /** Backup file name under Backups/, present only when written. */
  backup?: string;
  /** The changelog outcome, present only when written. */
  changelog?: RegionChangelog;
}

/**
 * Rewrite only the `which` AUTOMATED region of TELOS.md. Skips everything
 * (no write, no backup, no log line) when the body's content hash is
 * unchanged. Never touches the frontmatter or any H2 `<!-- updated -->`
 * marker, so TelosFreshness and the Interview-due verdict do not move.
 * Throws RegionError on a bad body or malformed fences, and when TELOS.md
 * changed on disk while this write was being prepared; nothing is written then.
 * Once the region has landed, a changelog line that cannot be written never
 * turns into a throw: it comes back as `changelog: { logged: false, ... }`.
 */
export function writeRegion(opts: RegionWriteOptions): RegionWriteResult {
  const file = join(opts.telosDir, 'TELOS.md');
  if (!existsSync(file)) throw new RegionError(`TELOS.md not found in ${opts.telosDir}`);
  let result: RegionWriteResult;
  try {
    // One shared lock across the read, the plan and the rename: no other TELOS
    // writer (the Pulse editor, a stamp, an entry add) can land in between.
    result = withTelosLock(file, (lock) => writeRegionLocked(opts, file, lock), opts.lock);
  } catch (err) {
    if (err instanceof TelosLockTimeout) throw new RegionError(`${err.message} (region ${opts.which})`);
    throw err;
  }
  if (!result.written) return result;
  const now = opts.now ?? new Date();
  const line = `\n- ${getLocalDateForLog(now)} · TELOS.md AUTOMATED ${opts.which} region rewritten (${opts.description.replace(/\s+/g, ' ').trim()}); backup \`Backups/${result.backup}\`\n`;
  return { ...result, changelog: logLandedWrite(opts.telosDir, line, opts.lock) };
}

/**
 * Write the changelog line for a write that already landed. It runs after the
 * TELOS.md lock is released (holding TELOS.md while waiting on updates.md
 * would let two writers deadlock each other). It is not retried here: the lock
 * wait is already a bounded retry, and a longer loop would only stall the
 * scheduled render. A busy lock or an I/O error is returned, never thrown, so
 * the landed write is not reported as a failed one. An InvariantViolation, or
 * any error that is not one of those, still throws.
 */
function logLandedWrite(telosDir: string, entry: string, lockOpts: TelosLockOptions | undefined): RegionChangelog {
  try {
    prependUpdateEntry(telosDir, entry, lockOpts);
    return { logged: true };
  } catch (err) {
    if (err instanceof InvariantViolation) throw err;
    const ioError = err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
    if (err instanceof TelosLockTimeout || ioError) return { logged: false, error: (err as Error).message, entry };
    throw err;
  }
}

function writeRegionLocked(opts: RegionWriteOptions, file: string, lock: TelosLockHandle): RegionWriteResult {
  const now = opts.now ?? new Date();
  const raw = readFileSync(file, 'utf-8');
  const plan = planRegionWrite(raw, opts.which, opts.body, now);
  if (!plan.changed) return { written: false, hash: plan.hash };

  // Invariants before any byte is written: only the region moved, and the
  // region now holds exactly the requested content.
  invariant(exciseRegions(plan.next, opts.which) === exciseRegions(raw, opts.which), `region write for ${opts.which} would change bytes outside the region`);
  const markersBefore = raw.match(/<!--\s*updated:[^>]*-->/g) ?? [];
  const markersAfter = plan.next.match(/<!--\s*updated:[^>]*-->/g) ?? [];
  invariant(JSON.stringify(markersBefore) === JSON.stringify(markersAfter), 'region write would change a TelosFreshness updated marker');

  const backup = takeBackup(join(opts.telosDir, 'Backups'), file, REGION_BACKUP_PREFIX, `${getLocalTimestamp(now)}-${String(now.getMilliseconds()).padStart(3, '0')}`);

  // Refuse to overwrite a hand edit that landed while this write was planned.
  if (readFileSync(file, 'utf-8') !== raw) {
    throw new RegionError('TELOS.md changed on disk during the region write; nothing written, retry');
  }
  const tmp = join(dirname(file), `.${basename(file)}.region-${process.pid}-${now.getTime()}.tmp`);
  writeFileSync(tmp, plan.next, { encoding: 'utf-8', flag: 'wx' });
  invariant(lock.held(), 'TELOS.md lock was lost before the region write could replace the file');
  renameSync(tmp, file);
  return { written: true, hash: plan.hash, backup };
}

/** Exit code when the region write landed but its updates.md line did not. */
export const EXIT_CHANGELOG_NOT_LOGGED = 2;

/**
 * `update-telos TELOS.md --region current|ideal --body-file <f> ["<change-description>"]`
 *
 * Exit 0: written (and logged) or unchanged. Exit 1: nothing written (bad
 * arguments, bad body, busy TELOS.md). Exit 2: the region write LANDED but the
 * updates.md line did not; stderr carries the reason and the exact line.
 * `env` exists for tests; the CLI uses the real TELOS folder and lock defaults.
 */
export function regionCli(argv: string[], env: { telosDir?: string; lock?: TelosLockOptions } = {}): number {
  const args = [...argv];
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const which = take('--region');
  const bodyFile = take('--body-file');
  const [filename, description] = args;
  if (filename !== 'TELOS.md') {
    console.error('❌ --region writes only TELOS.md');
    return 1;
  }
  if (!which || !(REGION_WHICH as readonly string[]).includes(which)) {
    console.error(`❌ --region needs one of: ${REGION_WHICH.join(', ')}`);
    return 1;
  }
  if (!bodyFile || !existsSync(bodyFile)) {
    console.error('❌ --region needs --body-file <existing file>');
    return 1;
  }
  try {
    const result = writeRegion({
      telosDir: env.telosDir ?? TELOS_DIR,
      which: which as RegionWhich,
      body: readFileSync(bodyFile, 'utf-8'),
      description: description ?? `refresh AUTOMATED ${which} region`,
      lock: env.lock,
    });
    console.log(result.written
      ? `✅ TELOS.md AUTOMATED ${which} region rewritten (backup Backups/${result.backup})`
      : `✅ TELOS.md AUTOMATED ${which} region unchanged (content ${result.hash.slice(0, 12)}); nothing written`);
    if (result.changelog && !result.changelog.logged) {
      console.error(`❌ The region write above landed, but its updates.md line was NOT written: ${result.changelog.error}`);
      console.error(`   Add this line under "## Future Changes" in updates.md by hand:\n${result.changelog.entry.trim()}`);
      return EXIT_CHANGELOG_NOT_LOGGED;
    }
    return 0;
  } catch (error) {
    if (!(error instanceof RegionError)) throw error;
    console.error(`❌ ${error.message}`);
    return 1;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--region')) {
    process.exit(regionCli(args));
  }

  const sectionFlag = args.indexOf('--section');
  let section: string | undefined;
  if (sectionFlag !== -1) {
    section = args[sectionFlag + 1];
    if (!section) {
      console.error('❌ --section requires a heading name');
      process.exit(1);
    }
    args.splice(sectionFlag, 2);
  }

  if (args.length < 3) {
    console.error('❌ Usage: update-telos <file> "<content>" "<change-description>" [--section "<heading>"]');
    console.error('\nExample: update-telos BOOKS.md "- New Book Title" "Added favorite book"');
    console.error('\nValid files:', VALID_FILES.join(', '));
    process.exit(1);
  }

  const [filename, content, changeDescription] = args;

  // Validate filename
  if (!VALID_FILES.includes(filename)) {
    console.error(`❌ Invalid file: ${filename}`);
    console.error(`Valid files: ${VALID_FILES.join(', ')}`);
    process.exit(1);
  }

  const targetFile = join(TELOS_DIR, filename);
  const timestamp = getLocalTimestamp();
  // Default name; addEntry reports the real one (same-second writes get a suffix).
  let backupFilename = filename.replace('.md', `-${timestamp}.md`);

  let outcome: EntryAddResult;
  try {
    outcome = addEntry({ telosDir: TELOS_DIR, filename, content, section, timestamp, onBackup: (name) => { backupFilename = name; } });
  } catch (error) {
    if (error instanceof TelosLockTimeout) {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    }
    console.error(`❌ Failed to update file: ${error}`);
    process.exit(1);
  }
  if (outcome.created) console.log(`✅ Created starter file: ${filename}`);
  console.log(`✅ Backup created: ${backupFilename}`);
  if (outcome.kind === 'section-missing') {
    console.error(`❌ Section not found in ${filename}: "${section}"`);
    console.error('   Nothing written. Backup remains at Backups/' + backupFilename);
    process.exit(1);
  }
  console.log(section ? `✅ Updated: ${filename} (inside section "${section}")` : `✅ Updated: ${filename}`);
  logChange(filename, changeDescription, backupFilename, section);
}

export interface EntryAddOptions {
  telosDir: string;
  filename: string;
  content: string;
  /** Insert inside this H2 section instead of at the end. */
  section?: string;
  /** Backup stamp. */
  timestamp: string;
  lock?: TelosLockOptions;
  /** Receives the backup's actual file name (takeBackup may add a collision suffix). */
  onBackup?: (backupFilename: string) => void;
}

export interface EntryAddResult {
  kind: 'written' | 'section-missing';
  /** True when the file did not exist and a starter was created. */
  created: boolean;
}

/**
 * Add one entry to a TELOS file. The starter creation, the backup, the read
 * and the write all run under the shared TELOS lock, so a concurrent writer
 * can never land between the read and the write and lose its change. Throws
 * TelosLockTimeout, writing nothing, when the lock stays busy.
 */
export function addEntry(opts: EntryAddOptions): EntryAddResult {
  const targetFile = join(opts.telosDir, opts.filename);
  mkdirSync(opts.telosDir, { recursive: true });
  return withTelosLock(targetFile, (lock) => {
    // A valid file that isn't scaffolded yet is created as a minimal starter
    // instead of hard-failing — the scaffold ships only a subset of VALID_FILES,
    // and this tool is the sole sanctioned write path (public issue #1452).
    const created = !existsSync(targetFile);
    if (created) writeFileSync(targetFile, `# ${opts.filename.replace('.md', '')}\n`, { encoding: 'utf-8', flag: 'wx' });

    const backupName = takeBackup(join(opts.telosDir, 'Backups'), targetFile, opts.filename.replace('.md', '-'), opts.timestamp);
    opts.onBackup?.(backupName);

    // TELOS templates end with a `---` + italic-commentary footer; new entries
    // belong in the content list ABOVE that footer, not after it (public issue
    // #1452). Files without the footer shape keep the plain EOF append.
    const currentContent = readFileSync(targetFile, 'utf-8');
    let updatedContent: string;
    if (opts.section) {
      const sectioned = insertIntoSection(currentContent, opts.section, opts.content);
      if (sectioned === null) return { kind: 'section-missing', created };
      updatedContent = sectioned;
    } else {
      const footerIdx = currentContent.lastIndexOf('\n---\n');
      const footer = footerIdx === -1 ? '' : currentContent.slice(footerIdx);
      if (footerIdx !== -1 && /\n---\n\s*\*[\s\S]*\*\s*$/.test(footer)) {
        const body = currentContent.slice(0, footerIdx).trimEnd();
        updatedContent = body + '\n' + opts.content + '\n' + footer.replace(/^\n/, '\n');
      } else {
        updatedContent = currentContent.trimEnd() + '\n' + opts.content + '\n';
      }
    }
    invariant(updatedContent.includes(opts.content), `entry add to ${opts.filename} carries the new entry`);
    invariant(lock.held(), `${opts.filename} lock was lost before the entry write`);
    writeFileSync(targetFile, updatedContent, 'utf-8');
    return { kind: 'written', created };
  }, opts.lock);
}

// Step 3: Update updates.md with change log
function logChange(filename: string, changeDescription: string, backupFilename: string, section?: string) {
  try {
    const logTimestamp = getLocalDateForLog();
    const logEntry = `
## ${logTimestamp}

- **File Modified**: ${filename}${section ? ` (section: ${section})` : ''}
- **Change Type**: Content Addition
- **Description**: ${changeDescription}
- **Backup Location**: \`Backups/${backupFilename}\`

`;

    const where = prependUpdateEntry(TELOS_DIR, logEntry);
    console.log(where === 'inserted' ? `✅ Change logged in updates.md` : `✅ Change logged in updates.md (appended)`);
  } catch (error) {
    console.error(`❌ Failed to update updates.md: ${error}`);
    process.exit(1);
  }

  console.log('\n🎯 TELOS update complete!');
  console.log(`   File: ${filename}`);
  console.log(`   Backup: Backups/${backupFilename}`);
  console.log(`   Change: ${changeDescription}`);
}

if (import.meta.main) main();
