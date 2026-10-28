#!/usr/bin/env bun
/**
 * @version 1.0.1
 * LiveSessions — the harness-agnostic registry of interactive sessions.
 *
 * One file per session under MEMORY/STATE/live-sessions/<id>.json, written at
 * SessionStart by KittyEnvPersist (Claude, and Codex through its bridge)
 * and removed at SessionEnd by SessionCleanup. A session whose terminal was
 * killed never reaches SessionEnd, so its file survives; that surviving file
 * plus a dead harness pid is exactly what `Sessions.ts restore` looks for.
 *
 * Nothing here talks to a harness. It records which one ran the session, where,
 * and under which pid, and composes that harness's own resume command.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { invariant } from './Invariant';
import { getLifeosDir, lifeosPath } from './Paths';

export type Harness = 'claude' | 'codex';
export const HARNESSES: readonly Harness[] = ['claude', 'codex'] as const;

export interface KittyRef { listenOn: string; windowId: string }

export interface LiveSession {
  sessionId: string;
  harness: Harness;
  cwd: string;
  /** The harness process, when it could be found from the hook's ancestry. */
  pid: number | null;
  startedAt: string;
  kitty: KittyRef | null;
}

export type PsArgs = (pid: number) => { ppid: number; args: string } | null;
export type PidProbe = (pid: number) => boolean;

export function registryDir(): string { return lifeosPath('MEMORY', 'STATE', 'live-sessions'); }

/** The harness this hook process runs under. The bridges set LIFEOS_HARNESS; Claude sets nothing. */
export function harnessFromEnv(env: NodeJS.ProcessEnv = process.env): Harness {
  const h = env.LIFEOS_HARNESS;
  return h === 'codex' ? h : 'claude';
}

/** Does this argv belong to the harness? Matches the executable name as a whole token. */
export function argsMatchHarness(args: string, harness: Harness): boolean {
  return new RegExp(`(^|[\\s/])${harness}(\\s|$)`).test(args);
}

export const defaultPsArgs: PsArgs = (pid) => {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf-8', timeout: 2000 }).trim();
    const m = out.match(/^\s*(\d+)\s+(.*)$/s);
    return m ? { ppid: Number(m[1]), args: m[2] } : null;
  } catch { return null; }
};

/** Walk up from a hook's parent until the harness process is found. */
export function findHarnessPid(harness: Harness, startPid: number, ps: PsArgs = defaultPsArgs, maxHops = 12): number | null {
  let pid = startPid;
  for (let i = 0; i < maxHops && pid > 1; i++) {
    const row = ps(pid);
    if (!row) return null;
    if (argsMatchHarness(row.args, harness)) return pid;
    pid = row.ppid;
  }
  return null;
}

function entryPath(sessionId: string, dir: string): string {
  invariant(/^[A-Za-z0-9._-]{4,}$/.test(sessionId), `session id is a plain token: ${sessionId}`);
  return join(dir, `${sessionId}.json`);
}

export function registerSession(entry: LiveSession, dir: string = registryDir()): string {
  invariant(HARNESSES.includes(entry.harness), `known harness: ${entry.harness}`);
  invariant(entry.cwd.startsWith('/'), `absolute cwd: ${entry.cwd}`);
  invariant(entry.pid === null || (Number.isInteger(entry.pid) && entry.pid > 1), `pid is null or a real process id: ${entry.pid}`);
  invariant(!Number.isNaN(Date.parse(entry.startedAt)), `startedAt parses: ${entry.startedAt}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = entryPath(entry.sessionId, dir);
  writeFileSync(path, JSON.stringify(entry, null, 2) + '\n', 'utf-8');
  return path;
}

export function unregisterSession(sessionId: string, dir: string = registryDir()): boolean {
  const path = entryPath(sessionId, dir);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function readSessions(dir: string = registryDir()): LiveSession[] {
  if (!existsSync(dir)) return [];
  const out: LiveSession[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as LiveSession;
      if (e && typeof e.sessionId === 'string' && HARNESSES.includes(e.harness) && typeof e.cwd === 'string') out.push(e);
    } catch { /* a torn write is not a session */ }
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export const defaultPidProbe: PidProbe = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Alive means the recorded pid exists AND still runs the recorded harness.
 * A reused pid running something else is dead for our purposes. No pid means
 * we could not see the harness at start; treat as dead so restore can offer it.
 */
export function isAlive(entry: LiveSession, probe: PidProbe = defaultPidProbe, ps: PsArgs = defaultPsArgs): boolean {
  if (entry.pid === null) return false;
  if (!probe(entry.pid)) return false;
  const row = ps(entry.pid);
  return !!row && argsMatchHarness(row.args, entry.harness);
}

/** The harness's own resume argv, run from entry.cwd. */
export function resumeCommand(entry: LiveSession, lifeosDir: string = getLifeosDir()): string[] {
  switch (entry.harness) {
    case 'claude': return ['bun', join(lifeosDir, 'TOOLS', 'lifeos.ts'), '-r', entry.sessionId];
    case 'codex': return ['codex', 'resume', entry.sessionId];
  }
}

/** kitty remote-control argv that opens the resume in a new tab at the session's cwd. */
export function kittyLaunchArgs(socket: string, entry: LiveSession, argv: string[], title: string): string[] {
  invariant(argv.length > 0, 'a command to launch');
  return ['kitten', '@', '--to', socket, 'launch', '--type=tab', `--cwd=${entry.cwd}`, `--tab-title=${title}`, ...argv];
}

/** The kitty socket for this terminal: the live env first, then the last one a session persisted. */
export function resolveKittySocket(env: NodeJS.ProcessEnv = process.env, stateDir: string = lifeosPath('MEMORY', 'STATE')): string | null {
  if (env.KITTY_LISTEN_ON) return env.KITTY_LISTEN_ON;
  try {
    const j = JSON.parse(readFileSync(join(stateDir, 'kitty-env.json'), 'utf-8'));
    const s = typeof j?.KITTY_LISTEN_ON === 'string' ? j.KITTY_LISTEN_ON : null;
    if (s && s.startsWith('unix:') && existsSync(s.slice(5))) return s;
  } catch { /* no persisted socket */ }
  return null;
}

/** Shell-quote an argv for the printed fallback. */
export function shellLine(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

export function homeRelative(p: string): string {
  const h = homedir();
  return p.startsWith(h) ? '~' + p.slice(h.length) : p;
}
