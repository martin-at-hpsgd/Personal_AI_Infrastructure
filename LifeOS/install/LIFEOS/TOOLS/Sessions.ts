#!/usr/bin/env bun
/**
 * @version 1.0.0
 * Sessions — list and restore interactive sessions across harnesses.
 *
 *   bun LIFEOS/TOOLS/Sessions.ts list [--json] [--all]
 *   bun LIFEOS/TOOLS/Sessions.ts restore <id|name|--all> [--dry-run] [--print]
 *   bun LIFEOS/TOOLS/Sessions.ts forget <id> | prune
 *
 * The registry is MEMORY/STATE/live-sessions/ (see LiveSessions.ts). A session
 * is restorable when its file is still there and its harness process is gone,
 * which is what a killed terminal leaves behind. `restore` opens each one in a
 * new kitty tab at its recorded directory using that harness's own resume
 * command; outside kitty (or with --print) it prints the commands instead.
 * Slash form: /rs.
 */

import { spawnSync } from 'node:child_process';
import {
  type LiveSession, readSessions, isAlive, resumeCommand, kittyLaunchArgs, resolveKittySocket,
  shellLine, homeRelative, unregisterSession, registryDir,
} from './LiveSessions';
import { readSessionIdentity } from '../../hooks/lib/session-identity';

interface Row extends LiveSession { name: string | null; label: string | null; alive: boolean }

function rows(): Row[] {
  return readSessions().map((e) => ({ ...e, ...readSessionIdentity(e.sessionId), alive: isAlive(e) }));
}

function fmt(r: Row): string {
  const state = r.alive ? 'live' : 'dead';
  const name = r.label ?? r.name ?? '(unnamed)';
  return `${r.sessionId.slice(0, 8)}  ${state.padEnd(4)}  ${r.harness.padEnd(6)}  ${name.padEnd(28).slice(0, 28)}  ${homeRelative(r.cwd)}`;
}

function pick(all: Row[], q: string): Row {
  const byId = all.filter((r) => r.sessionId === q || (q.length >= 6 && r.sessionId.startsWith(q)));
  if (byId.length === 1) return byId[0];
  const lq = q.toLowerCase();
  const byName = all.filter((r) => (r.name ?? '').toLowerCase().includes(lq) || (r.label ?? '').toLowerCase().includes(lq));
  if (byName.length === 1) return byName[0];
  const c = byId.length ? byId : byName;
  if (c.length === 0) throw new Error(`no session matches "${q}"; run \`list\``);
  throw new Error(`"${q}" matches ${c.length} sessions:\n${c.map(fmt).join('\n')}`);
}

function cmdList(args: string[]): number {
  const shown = rows();
  if (args.includes('--json')) { console.log(JSON.stringify(shown, null, 2)); return 0; }
  if (shown.length === 0) { console.log('no registered sessions'); return 0; }
  console.log('id        state harness name                          cwd');
  for (const r of shown) console.log(fmt(r));
  const dead = shown.filter((r) => !r.alive).length;
  console.log(`\n${shown.length} registered, ${dead} restorable (dead). Restore: Sessions.ts restore <id|name|--all>`);
  return 0;
}

function cmdRestore(args: string[]): number {
  const dry = args.includes('--dry-run');
  const print = args.includes('--print');
  const all = args.includes('--all');
  const query = args.filter((a) => !a.startsWith('--'))[0];
  if (!all && !query) { console.error('usage: restore <id|name|--all> [--dry-run] [--print]'); return 2; }
  const everything = rows();
  const targets = all ? everything.filter((r) => !r.alive) : [pick(everything, query!)];
  if (targets.length === 0) { console.log('nothing to restore: every registered session is still running'); return 0; }
  const socket = print ? null : resolveKittySocket();
  let failures = 0;
  for (const r of targets) {
    if (r.alive) { console.log(`skip ${r.sessionId.slice(0, 8)}: ${r.harness} process ${r.pid} is still running`); continue; }
    const argv = resumeCommand(r);
    const title = `${r.label ?? r.name ?? r.harness}`;
    const launch = socket ? kittyLaunchArgs(socket, r, argv, title) : null;
    if (!launch) { console.log(`cd ${shellLine([r.cwd])} && ${shellLine(argv)}`); continue; }
    if (dry) { console.log(shellLine(launch)); continue; }
    const res = spawnSync(launch[0], launch.slice(1), { encoding: 'utf-8', timeout: 10_000 });
    if (res.status === 0) console.log(`restored ${r.sessionId.slice(0, 8)} (${r.harness}) in a new tab at ${homeRelative(r.cwd)}`);
    else { failures++; console.error(`failed ${r.sessionId.slice(0, 8)}: ${(res.stderr || res.stdout || '').trim()}\nrun by hand: cd ${shellLine([r.cwd])} && ${shellLine(argv)}`); }
  }
  return failures ? 1 : 0;
}

function cmdForget(args: string[]): number {
  const q = args[0];
  if (!q) { console.error('usage: forget <id|name>'); return 2; }
  const r = pick(rows(), q);
  console.log(unregisterSession(r.sessionId) ? `forgot ${r.sessionId}` : `no entry for ${r.sessionId}`);
  return 0;
}

function cmdPrune(): number {
  let n = 0;
  for (const r of rows()) if (!r.alive && unregisterSession(r.sessionId)) n++;
  console.log(`pruned ${n} dead entries from ${homeRelative(registryDir())}`);
  return 0;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'list': case 'ls': case undefined: return cmdList(rest);
      case 'restore': case 'rs': return cmdRestore(rest);
      case 'forget': return cmdForget(rest);
      case 'prune': return cmdPrune();
      default:
        console.error('usage: Sessions.ts list [--json] | restore <id|name|--all> [--dry-run] [--print] | forget <id> | prune');
        return 2;
    }
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
