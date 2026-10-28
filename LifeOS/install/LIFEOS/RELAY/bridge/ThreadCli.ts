#!/usr/bin/env bun
/**
 * ThreadCli.ts — the principal thread's maintenance CLI (Tex F18). Named ThreadCli, not Thread, because macOS
 * folds case and `Thread.ts` would be the engine file thread.ts.
 *
 *   bun LIFEOS/RELAY/bridge/ThreadCli.ts status     counts only
 *   bun LIFEOS/RELAY/bridge/ThreadCli.ts view       the rendered view's size in bytes
 *   bun LIFEOS/RELAY/bridge/ThreadCli.ts backfill   import the live + archived principal thread once, oldest
 *                                                   first, then summarize it; resumable (ISC-228)
 *   bun LIFEOS/RELAY/bridge/ThreadCli.ts verify-store
 *                                                   counts only: exits 0 only when every principal transport id,
 *                                                   live and in the retired archive, is in the thread log (ISC-249)
 *   bun LIFEOS/RELAY/bridge/ThreadCli.ts compaction-transcripts [--json] [--root <dir>]
 *                                                   read-only: every compaction transcript under ~/.claude/projects
 *                                                   (or --root) with its bytes and first-user-line class (ISC-238).
 *                                                   It deletes nothing; its JSON is the list a deletion works from.
 *
 * status, view and backfill take the thread's single-writer lock, so they refuse to run while the bridge holds it,
 * and the bridge writes nothing while they run. verify-store and compaction-transcripts only read and need no lock. Nothing here prints a
 * sender handle, a thread id or message text.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { getClaudeDir } from "../../TOOLS/Paths.ts";
import { ConversationStore } from "./conversation.ts";
import { classifyTranscript, isCompaction, type TranscriptClass } from "./transcriptClass.ts";
import { inferenceSummarizer } from "./compactor.ts";
import { PrincipalThread, ThreadLockedError, loggedTransportIds, principalThreadIds, resolvePrincipalThread, threadDir, type TransportMessage } from "./thread.ts";

/** Counts only. `live` and `archived` are distinct principal transport ids in the store and the retired F17 archive;
 *  `logged` of them are in the log; `ok` is true only when none is missing. */
export interface StoreVerification { live: number; archived: number; logged: number; missing: number; ok: boolean }

/**
 * No principal message is lost in the move (ISC-249): every principal transport id, live and archived, under every
 * provider prefix of the own-line DM, must be in the thread log. Reads only, with no lock. Contact-sourced records
 * never enter the log and are not counted.
 */
export function verifyStore(
  store: { messages(sender: string, thread: string): TransportMessage[]; archived(sender: string, thread: string): TransportMessage[] },
  principal: { sender: string; thread: string },
  dir: string,
): StoreVerification {
  const live = new Set<string>(), archived = new Set<string>();
  for (const thread of new Set([principal.thread, ...principalThreadIds(principal.sender)])) {
    for (const m of store.messages(principal.sender, thread)) if (m.source !== "contact") live.add(m.id);
    for (const m of store.archived(principal.sender, thread)) if (m.source !== "contact") archived.add(m.id);
  }
  const logged = loggedTransportIds(dir);
  const all = new Set([...live, ...archived]);
  const held = [...all].filter(id => logged.has(id)).length;
  return { live: live.size, archived: archived.size, logged: held, missing: all.size - held, ok: held === all.size };
}

/** Every principal record the backfill imports: archived and live, under every provider prefix of the own-line DM,
 *  the same set verify-store checks (ISC-249). Contact records are left in; ingest skips them by kind. */
export function principalRecords(
  store: { messages(sender: string, thread: string): TransportMessage[]; archived(sender: string, thread: string): TransportMessage[] },
  principal: { sender: string; thread: string },
): TransportMessage[] {
  return [...new Set([principal.thread, ...principalThreadIds(principal.sender)])]
    .flatMap(thread => [...store.archived(principal.sender, thread), ...store.messages(principal.sender, thread)]);
}

/** One compaction transcript: its path, size in bytes, and its first user line's class. */
export interface CompactionTranscript { path: string; bytes: number; class: TranscriptClass }
export interface CompactionListing { root: string; count: number; bytes: number; byProject: Record<string, { count: number; bytes: number }>; transcripts: CompactionTranscript[] }

/**
 * Every compaction transcript under `root` (default ~/.claude/projects), recursively, classified by the one classifier
 * (transcriptClass.ts) from the whole first user line. Reads only: nothing is deleted or moved. Symlinks are not
 * followed, so the walk stays inside `root`.
 */
export function listCompactionTranscripts(root: string = join(getClaudeDir(), "projects")): CompactionListing {
  const transcripts: CompactionTranscript[] = [];
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const cls = classifyTranscript(path);
        if (!isCompaction(cls)) continue;
        let bytes: number;
        try { bytes = statSync(path).size; } catch { continue; }
        transcripts.push({ path, bytes, class: cls });
      }
    }
  };
  walk(root);
  transcripts.sort((a, b) => a.path.localeCompare(b.path));
  const byProject: Record<string, { count: number; bytes: number }> = {};
  for (const t of transcripts) {
    const project = relative(root, t.path).split(sep)[0]!;
    const entry = (byProject[project] ??= { count: 0, bytes: 0 });
    entry.count++;
    entry.bytes += t.bytes;
  }
  return { root, count: transcripts.length, bytes: transcripts.reduce((n, t) => n + t.bytes, 0), byProject, transcripts };
}

/** Import transport records oldest first, in chunks, then build every node. Re-running continues where it stopped. */
export async function backfill(runtime: PrincipalThread, messages: readonly TransportMessage[], chunk = 500, maxRounds = 10_000): Promise<{ imported: number; built: boolean }> {
  const ordered = [...messages].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id));
  let imported = 0;
  for (let k = 0; k < ordered.length; k += chunk) imported += runtime.ingest(ordered.slice(k, k + chunk)).length;
  let rounds = 0;
  for (;;) {
    runtime.compactor.pump();
    await runtime.compactor.idle();
    const ready = runtime.thread.readyWork();
    if (ready.leaves.length === 0 && ready.merges.length === 0) return { imported, built: true };
    if (++rounds > maxRounds) return { imported, built: false };
    if (runtime.compactor.running === 0) {
      // Held failures get another try once their outage backoff ends; waiting it out here, instead of spinning,
      // keeps an outage from burning the round budget in a few milliseconds.
      const wait = runtime.compactor.nextRetryMs() ?? 0;
      if (wait > 0) await Bun.sleep(wait);
      runtime.compactor.onMessage();
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === "compaction-transcripts") {
    const at = argv.indexOf("--root");
    if (at >= 0 && !argv[at + 1]) { console.error("usage: ThreadCli.ts compaction-transcripts [--json] [--root <dir>]"); return 64; }
    const listing = listCompactionTranscripts(at >= 0 ? argv[at + 1] : undefined);
    if (argv.includes("--json")) { console.log(JSON.stringify(listing)); return 0; }
    for (const t of listing.transcripts) console.log(`${t.class}\t${t.bytes}\t${t.path}`);
    for (const [project, p] of Object.entries(listing.byProject)) console.log(`project\t${p.count}\t${p.bytes}\t${project}`);
    console.log(`total\t${listing.count}\t${listing.bytes}`);
    return 0;
  }
  if (command !== "status" && command !== "view" && command !== "backfill" && command !== "verify-store") {
    console.error("usage: ThreadCli.ts status | view | backfill | verify-store | compaction-transcripts [--json] [--root <dir>]");
    return 64;
  }
  const { loadConfig } = await import("./session.ts");
  const store = new ConversationStore();
  const principal = resolvePrincipalThread(loadConfig().ownChannels.numbers, store);
  if (!principal) { console.error("no principal thread: ownChannels.numbers must name exactly one line"); return 1; }
  if (command === "verify-store") {
    const result = verifyStore(store, principal, threadDir(principal.sender, principal.thread));
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }
  let runtime: PrincipalThread;
  try {
    runtime = PrincipalThread.open({ dir: threadDir(principal.sender, principal.thread), summarizer: inferenceSummarizer(), start: command === "backfill" });
  } catch (error) {
    if (error instanceof ThreadLockedError) { console.error("the thread is held by another process (the bridge): stop it first"); return 75; }
    throw error;
  }
  try {
    if (command === "status") { console.log(JSON.stringify(runtime.status())); return 0; }
    if (command === "view") { console.log(JSON.stringify({ viewBytes: Buffer.byteLength(runtime.thread.renderView(), "utf8") })); return 0; }
    const result = await backfill(runtime, principalRecords(store, principal));
    console.log(JSON.stringify({ ...result, ...runtime.status() }));
    return result.built ? 0 : 1;
  } finally {
    runtime.close();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
