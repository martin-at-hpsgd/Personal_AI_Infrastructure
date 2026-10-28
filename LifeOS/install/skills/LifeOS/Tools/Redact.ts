/**
 * Redact — deterministic scrub for anything that leaves a LifeOS install.
 *
 * Reports written by a DA arrive carrying the home path, the principal's and
 * DA's names, and sometimes the user's own data (public discussion #1847,
 * @xmasyx). This module is the boundary: pattern code, never a model. It
 * strips what the install's own config says is identity, plus the generic
 * shapes (home dirs, emails, tokens, LAN addresses), and `leaks()` names what
 * survived so the caller can refuse to ship.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir, hostname, userInfo } from "node:os";
import { SYSTEM_TREE_PATHS } from "./SystemTrees";

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();

export interface IdentityContext {
  home: string;
  username: string;
  hostname: string;     // `Example-MacBook-Pro.local` carries the name past the word-bounded name matcher
  names: string[];      // principal + DA names, any form, ≥3 chars
  voiceIds: string[];
}

/** Minimal TOML string reader: `section.key` → value. Enough for identity keys. */
export function tomlStrings(src: string): Map<string, string> {
  const out = new Map<string, string>();
  let section = "";
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) { section = sec[1].trim(); continue; }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/);
    if (kv) out.set(section ? `${section}.${kv[1]}` : kv[1], kv[2]);
  }
  return out;
}

export function configTomlPath(configRoot: string): string {
  return process.env.LIFEOS_CONFIG_PATH || join(configRoot, "LIFEOS", "USER", "CONFIG", "LIFEOS_CONFIG.toml");
}

export function identityContext(configRoot: string): IdentityContext {
  const ctx: IdentityContext = { home: HOME, username: safeUsername(), hostname: safeHostname(), names: [], voiceIds: [] };
  const configPath = configTomlPath(configRoot);
  if (!existsSync(configPath)) return ctx;
  const t = tomlStrings(readFileSync(configPath, "utf8"));
  for (const k of ["principal.name", "principal.full_name", "da.name", "da.full_name", "da.display_name"]) {
    const v = t.get(k);
    if (v && v.trim().length >= 3) ctx.names.push(v.trim());
  }
  for (const [k, v] of t) if ((k.endsWith(".voice_id") || k.endsWith(".fish_reference_id")) && v.length >= 8) ctx.voiceIds.push(v);
  return ctx;
}

function safeUsername(): string {
  try { return userInfo().username; } catch { return basename(HOME); }
}
function safeHostname(): string {
  try { return hostname(); } catch { return ""; }
}

export interface RedactResult { text: string; counts: Record<string, number> }

const SECRET_SHAPES: Array<[string, RegExp]> = [
  ["token", /\b(?:sk|rk|pk)-(?:ant-|live-|test-|proj-)?[A-Za-z0-9_-]{16,}\b/g],
  ["token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g],
  ["token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["token", /\bAKIA[0-9A-Z]{16}\b/g],
  ["token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["token", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g],
  ["secret", /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|key|token|secret|password|passwd))(\s*[=:]\s*)(["']?)[^\s"']+\3/g],
  // an assigned 32+ hex blob (session ids, api secrets); bare hashes in output are left alone
  ["secret", /\b([A-Za-z_][A-Za-z0-9_-]*)(\s*[=:]\s*)(["']?)[0-9a-f]{32,}\3/g],
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["lan-ip", /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g],
];

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function wordRe(s: string, flags: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(s)}(?![A-Za-z0-9])`, flags);
}

export function redact(input: string, ctx: IdentityContext): RedactResult {
  const counts: Record<string, number> = {};
  const bump = (k: string, n: number) => { if (n) counts[k] = (counts[k] ?? 0) + n; };
  let text = input;
  const swap = (kind: string, re: RegExp, to: string) => {
    const n = (text.match(re) ?? []).length; text = text.replace(re, to); bump(kind, n);
  };

  // Home directory, in every spelling: the literal, then the generic shapes.
  const home = ctx.home.replace(/\/+$/, "");
  if (home.length > 1) swap("home", new RegExp(escapeRe(home), "g"), "~");
  for (const re of [/\/Users\/[^/\s"'`]+/g, /\/home\/[^/\s"'`]+/g, /C:\\Users\\[^\\\s"'`]+/g]) swap("home", re, "~");

  for (const [kind, re] of SECRET_SHAPES) swap(kind, re, kind === "secret" ? "$1$2<redacted>" : `<${kind}>`);
  for (const id of ctx.voiceIds) swap("voice-id", new RegExp(escapeRe(id), "g"), "<voice-id>");

  // Names last, longest first, word-bounded, case-insensitive.
  const names = [...new Set(ctx.names)].sort((a, b) => b.length - a.length);
  for (const name of names) swap("name", wordRe(name, "gi"), "<name>");
  if (ctx.username.length >= 4) swap("username", wordRe(ctx.username, "g"), "<user>");
  for (const h of hostForms(ctx.hostname)) swap("hostname", new RegExp(escapeRe(h), "gi"), "<host>");
  return { text, counts };
}

/** `Example-MacBook-Pro.local` → both the FQDN and the short form, longest first. Short generic names are skipped. */
function hostForms(h: string): string[] {
  const full = h.trim();
  if (full.length < 6) return [];
  const short = full.split(".")[0];
  return short.length >= 6 && short !== full ? [full, short] : [full];
}

/** What must never survive redaction. Anything listed here fails the build. */
export function leaks(text: string, ctx: IdentityContext): string[] {
  const out: string[] = [];
  const home = ctx.home.replace(/\/+$/, "");
  if (home.length > 1 && text.includes(home)) out.push(`home path ${home}`);
  for (const name of ctx.names) if (wordRe(name, "i").test(text)) out.push(`name "${name}"`);
  for (const id of ctx.voiceIds) if (text.includes(id)) out.push("voice id");
  for (const h of hostForms(ctx.hostname)) if (new RegExp(escapeRe(h), "i").test(text)) { out.push(`hostname "${h}"`); break; }
  for (const [kind, re] of SECRET_SHAPES) {
    if (kind === "token" && new RegExp(re.source).test(text)) { out.push("token-shaped string"); break; }
  }
  return out;
}

// A value that is plainly not a secret: a reference, a template slot or a documented placeholder.
const PLACEHOLDER_VALUE = /^(?:<.*>|\$.*|\{.*\}|%.*|\.\.\.|x{3,}|\*+|changeme|your[-_ ].*|example.*|placeholder.*|process\.env.*|env\..*|null|undefined|true|false)$/i;
const SECRET_ASSIGN = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|key|token|secret|password|passwd))(\s*[=:]\s*)(["']?)([^\s"']+)\3/g;
const EMAIL_ANY = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const NON_PERSONAL_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|users\.noreply\.github\.com|anthropic\.com|localhost|invalid|test)$/i;

/**
 * What a contributed diff must not carry. A diff cannot be redacted (it has to apply byte for byte), so the same
 * scrub redact() applies to a report becomes a refusal here: everything leaks() names, plus, on added lines only,
 * a secret assigned a literal value (`SERVICE_PASSWORD=hunter2`, `password: "x1y2z3"`) and an email address that is
 * not a placeholder or a no-reply form. Code that merely names a variable (`token: string`, `key = process.env.X`) passes.
 */
export function patchLeaks(patch: string, ctx: IdentityContext): string[] {
  const out = leaks(patch, ctx);
  const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  for (const line of added) {
    for (const m of line.matchAll(SECRET_ASSIGN)) {
      const [, name, , quote, value] = m;
      if (PLACEHOLDER_VALUE.test(value)) continue;
      const envStyle = /^[A-Z][A-Z0-9_]*$/.test(name);
      if (quote ? value.length >= 4 : envStyle && value.length >= 4 && !/[()[\]]/.test(value)) { out.push(`secret assigned to ${name}`); break; }
    }
    for (const m of line.matchAll(EMAIL_ANY)) {
      if (!NON_PERSONAL_EMAIL_DOMAIN.test(m[1])) { out.push("email address"); break; }
    }
  }
  return [...new Set(out)];
}

/**
 * The system-owned trees shared with OverlaySystem. Attestation compares
 * exactly these, and a contributed diff may touch ONLY these plus the named
 * system files: an allowlist, so a workflow file under `.github/`, a root
 * script, or anything under the user's own data is refused outright. A PR is
 * code against the system, never a copy of someone's install and never a CI
 * change riding in on a bug fix.
 */
export const SYSTEM_TREES = SYSTEM_TREE_PATHS;
export const SYSTEM_FILES = ["LIFEOS/LIFEOS_SYSTEM_PROMPT.md", "settings.system.json", "skills/LifeOS/install/CLAUDE.template.md"];
// A skill dir whose name starts with an underscore is the user's own private skill (the underscore decides where a skill ships, and no release
// ships one), and a nested USER/ or MEMORY/ directory is the user's data wherever it sits under a system tree.
const DIFF_DENY_INSIDE = [/^skills\/LifeOS\/install\//, /^skills\/_[^/]+\//, /(^|\/)(?:USER|MEMORY)\//, /(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)\.env/];

/**
 * Every path a patch names. `git apply` acts on more than the `---`/`+++` headers: a pure rename, a copy, an empty
 * new file and a binary patch carry no such lines, only `diff --git a/X b/Y` and `rename|copy from|to`. All of
 * those count, so the gate and the dry-run plan see every path git will touch.
 */
export function diffPaths(patch: string): string[] {
  const paths = new Set<string>();
  const add = (p: string) => { const t = p.replace(/^"|"$/g, ""); if (t && t !== "/dev/null") paths.add(t); };
  for (const m of patch.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm)) add(m[1]);
  for (const m of patch.matchAll(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/gm)) { add(m[1]); add(m[2]); }
  for (const m of patch.matchAll(/^(?:rename|copy) (?:from|to) (.+)$/gm)) add(m[1]);
  return [...paths];
}

/** A binary patch hides its content from the leak scan, so a contribution never carries one. */
export function diffHasBinary(patch: string): boolean {
  return /^(?:GIT binary patch|Binary files )/m.test(patch);
}

/** The paths git actually staged after the patch was applied (NUL-separated `--name-only --no-renames` output) that a contribution may not carry. */
export function stagedDenied(nameOnlyZ: string): string[] {
  return nameOnlyZ.split("\0").filter(Boolean).filter((p) => !diffAllowed(p));
}

export function diffAllowed(path: string): boolean {
  if (SYSTEM_FILES.includes(path)) return true;
  if (DIFF_DENY_INSIDE.some((re) => re.test(path))) return false;
  return SYSTEM_TREES.some((t) => path.startsWith(t + "/"));
}

export function diffDenied(patch: string): string[] {
  return diffPaths(patch).filter((p) => !diffAllowed(p));
}
