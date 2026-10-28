#!/usr/bin/env bun
/**
 * RmPreview.ts — what a recursive or forced `rm` would remove, without running it.
 *
 * The LifeOSHooks plugin puts the answer under the permission dialog for that call
 * (`$.ui.notice`), so a delete prompt says "removes 1,204 files: dist/ (1,180), …" instead of
 * a bare yes/no. Read-only: it parses the command's arguments and reads the filesystem; the
 * command itself never runs, globs are expanded by Bun.Glob, symlinks are counted as one entry
 * and never followed, and the walk stops at MAX_FILES or MAX_MS.
 *
 *   bun RmPreview.ts <cwd> <<< "<command>"   →  one JSON line (RmPreview)
 */
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const MAX_FILES = 10_000;
export const MAX_MS = 1_500;

export interface RmTarget { arg: string; path: string; kind: "dir" | "file" | "link" | "missing"; files: number }
export interface RmPreview { ok: true; isRm: boolean; total: number; capped: boolean; targets: RmTarget[]; unexpanded: string[] }

/** Shell-ish words: single and double quotes, backslash escapes; no expansion beyond what we do below. */
export function words(segment: string): string[] {
  const out: string[] = [];
  let cur = ""; let q: string | null = null; let any = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (q) { if (c === q) q = null; else if (c === "\\" && q === '"' && i + 1 < segment.length) cur += segment[++i]; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; any = true; continue; }
    if (c === "\\" && i + 1 < segment.length) { cur += segment[++i]; any = true; continue; }
    if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ""; any = false; continue; }
    cur += c; any = true;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** The arguments of every `rm` in the command that carries a recursive or force flag. */
export function rmArgs(command: string): string[] | null {
  const segments = command.split(/&&|\|\||;|\||\n/);
  const args: string[] = [];
  let found = false;
  for (const seg of segments) {
    let w = words(seg.trim());
    while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || w[0] === "sudo" || w[0] === "command" || w[0] === "env")) w = w.slice(1);
    if (w[0] !== "rm" && !/\/rm$/.test(w[0] ?? "")) continue;
    let forceful = false; let endOfFlags = false; const mine: string[] = [];
    for (const a of w.slice(1)) {
      if (!endOfFlags && a === "--") { endOfFlags = true; continue; }
      if (!endOfFlags && /^--(recursive|force)$/.test(a)) { forceful = true; continue; }
      if (!endOfFlags && /^-[A-Za-z]+$/.test(a)) { if (/[rRf]/.test(a)) forceful = true; continue; }
      if (!endOfFlags && a.startsWith("--")) continue;
      mine.push(a);
    }
    if (forceful) { found = true; args.push(...mine); }
  }
  return found ? args : null;
}

function countTree(root: string, budget: { files: number; deadline: number }): number {
  let n = 0;
  const stack = [root];
  while (stack.length) {
    if (budget.files >= MAX_FILES || Date.now() > budget.deadline) return n;
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (budget.files >= MAX_FILES) return n;
      if (ent.isDirectory()) stack.push(join(dir, ent.name)); // Dirent of a symlink is not a directory: never followed
      else { n++; budget.files++; }
    }
  }
  return n;
}

export function preview(command: string, cwd: string, home = homedir()): RmPreview {
  const args = rmArgs(command);
  if (!args) return { ok: true, isRm: false, total: 0, capped: false, targets: [], unexpanded: [] };
  const budget = { files: 0, deadline: Date.now() + MAX_MS };
  const targets: RmTarget[] = [];
  const unexpanded: string[] = [];
  for (const raw of args) {
    if (/[$`]/.test(raw)) { unexpanded.push(raw); continue; }
    const arg = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
    const paths: string[] = /[*?[]/.test(arg)
      ? [...new Bun.Glob(isAbsolute(arg) ? arg.slice(1) : arg).scanSync({ cwd: isAbsolute(arg) ? "/" : cwd, onlyFiles: false, dot: false, followSymlinks: false })].map((p) => resolve(isAbsolute(arg) ? "/" : cwd, p))
      : [resolve(cwd, arg)];
    if (paths.length === 0) targets.push({ arg: raw, path: resolve(cwd, arg), kind: "missing", files: 0 });
    for (const p of paths) {
      let st: import("node:fs").Stats;
      try { st = lstatSync(p); } catch { targets.push({ arg: raw, path: p, kind: "missing", files: 0 }); continue; }
      if (st.isSymbolicLink()) { budget.files++; targets.push({ arg: raw, path: p, kind: "link", files: 1 }); continue; }
      if (st.isDirectory()) { targets.push({ arg: raw, path: p, kind: "dir", files: countTree(p, budget) }); continue; }
      budget.files++; targets.push({ arg: raw, path: p, kind: "file", files: 1 });
    }
  }
  const total = targets.reduce((a, t) => a + t.files, 0);
  return { ok: true, isRm: true, total, capped: budget.files >= MAX_FILES || Date.now() > budget.deadline, targets, unexpanded };
}

/** The one dialog line: `removes 1,204 files: dist/ (1,180), build/ (21), app.log`. */
export function noticeLine(p: RmPreview, cwd: string): string | null {
  if (!p.isRm) return null;
  const rel = (t: RmTarget) => {
    const r = t.path.startsWith(cwd + "/") ? t.path.slice(cwd.length + 1) : t.path;
    return t.kind === "dir" ? `${r}/` : r;
  };
  const present = p.targets.filter((t) => t.kind !== "missing").sort((a, b) => b.files - a.files);
  const missing = p.targets.filter((t) => t.kind === "missing");
  const parts: string[] = [];
  const shown = present.slice(0, 3).map((t) => (t.kind === "dir" ? `${rel(t)} (${t.files.toLocaleString("en-US")})` : rel(t)));
  if (present.length > 3) shown.push(`+${present.length - 3} more`);
  const count = `${p.total.toLocaleString("en-US")}${p.capped ? "+" : ""} file${p.total === 1 && !p.capped ? "" : "s"}`;
  if (present.length > 0) parts.push(`removes ${count}: ${shown.join(", ")}`);
  if (missing.length > 0) parts.push(`not found: ${missing.slice(0, 2).map((t) => t.arg).join(", ")}${missing.length > 2 ? ` +${missing.length - 2}` : ""}`);
  if (p.unexpanded.length > 0) parts.push(`can't preview ${p.unexpanded.slice(0, 2).join(", ")}`);
  return parts.length > 0 ? `LifeOS: ${parts.join(" · ")}` : null;
}

if (import.meta.main) {
  const cwd = process.argv[2] || process.cwd();
  const command = await Bun.stdin.text();
  const p = preview(command, cwd);
  console.log(JSON.stringify({ ...p, line: noticeLine(p, cwd) }));
}
