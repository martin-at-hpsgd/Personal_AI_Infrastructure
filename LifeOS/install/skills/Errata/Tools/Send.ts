#!/usr/bin/env bun
/**
 * @version 1.0.0
 * Send.ts — file feedback about LifeOS itself as a clean GitHub issue (the /feedback command).
 *
 *   bun Send.ts draft <id> [--summary-file <path>] [--comment-on <n>] [--json]
 *   bun Send.ts file  <id> --confirm <sha256> [--summary-file <path>] [--comment-on <n>] [--new] [--json]
 *
 * `draft` is local only: it makes no network request and spawns nothing. It rebuilds the issue from the
 * person's own words (complaint, kind, component, LifeOS version, an optional summary the session model wrote),
 * never from the erratum's cwd, requested, response_preview, session_id or instance, then scrubs it and prints the
 * exact text, its sha256 and everything the scrubber removed.
 *
 * The sha256 covers the text AND where it goes (the fixed upstream repo, and either "new issue" or "comment on #n"), and
 * the preview shows that target. `file` runs only with the sha256 the person just saw: it rebuilds the draft for the same
 * target, refuses on any mismatch, searches the upstream repo's open issues by the approved title alone, and files under
 * the person's own `gh` login, with the host and repo pinned on every call.
 *
 * Exit codes: 0 done, 2 usage or missing erratum, 3 refused (target, hash, duplicates, already filed), 4 gh failed.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { homedir, hostname, userInfo } from "os";
import { ErrataStore, redactPii } from "../../../LIFEOS/ERRATA/Store";
import type { Erratum, Kind } from "../../../LIFEOS/ERRATA/Schema";
import { redactSecrets } from "../../../LIFEOS/TOOLS/FailureCapture";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant";
import { DEFAULT_REPO as LIFEOS_PUBLIC_REPO } from "../../../LIFEOS/TOOLS/Credits";

// The one place approved text may go: the LifeOS public repo, owned by the system constant in LIFEOS/TOOLS/Credits.ts.
// Fixed in code: no environment variable or config file can move it, and the approval hash covers it.
export const UPSTREAM_REPO: string = LIFEOS_PUBLIC_REPO;
const REPO_FORM = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// ---------------------------------------------------------------- scrubber

export interface ScrubEnv { username: string; homeDir: string; hostname: string }
export interface Removal { rule: string; was: string; now: string }

export function defaultScrubEnv(): ScrubEnv {
  let username = process.env.USER ?? "";
  try { username = userInfo().username || username; } catch { /* keep env value */ }
  return { username, homeDir: homedir(), hostname: hostname() };
}

/** The erratum fields that must never reach the issue, as literal values to strike wherever they surface. */
function privateValues(e: Erratum): { value: string; field: string }[] {
  const c = e.context ?? {};
  const out: { value: string; field: string }[] = [];
  const add = (v: unknown, field: string, min: number) => {
    if (typeof v !== "string") return;
    const t = v.trim();
    if (t.length >= min) out.push({ value: t, field });
  };
  add(c.session_id, "session_id", 6);
  add(e.instance, "instance", 6);
  add(c.cwd, "cwd", 6);
  // Free-text fields are struck only when distinctive, so a short phrase the person also typed is not mangled.
  add(c.requested, "requested", 24);
  add(c.response_preview, "response_preview", 24);
  return out.sort((a, b) => b.value.length - a.value.length);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mask = (s: string) => `${s.slice(0, s.length <= 8 ? 1 : 4)}…(${s.length} chars)`;
const clipLine = (s: string, n = 120) => (s.length > n ? s.slice(0, n) + "…" : s);

/** What an external redactor took out, found by walking the original against the redacted text between its markers. */
function redactedSpans(before: string, after: string): string[] {
  const marker = /\[REDACTED[A-Z-]*\]/;
  const pieces = after.split(marker);
  if (pieces.length === 1) return [];
  const spans: string[] = [];
  let cursor = 0;
  if (!before.startsWith(pieces[0])) return [before];
  cursor = pieces[0].length;
  for (let k = 1; k < pieces.length; k++) {
    const last = k === pieces.length - 1;
    let end: number;
    if (pieces[k] === "") end = last ? before.length : cursor;
    else {
      end = before.indexOf(pieces[k], cursor);
      if (end < 0) { spans.push(before.slice(cursor)); break; }
    }
    const span = before.slice(cursor, end);
    if (span && !/^\[REDACTED[A-Z-]*\]$/.test(span)) spans.push(span);
    cursor = end + pieces[k].length;
  }
  return spans;
}

const USER_PATH = /(?<![A-Za-z0-9])USER\/[A-Za-z0-9_.\-]/;
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const ENTROPY = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const INTERNAL_HOST = /\b[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.(?:local|lan|internal|corp|home\.arpa|ts\.net)\b/gi;
// One path separator in any spelling it takes in pasted text: `/`, `\`, JSON-escaped `\/` and `\\`, URL-encoded `%2F` and `%5C`.
const SEP = String.raw`(?:\\*\/|\\+|%2[Ff]|%5[Cc])`;
const NAME = String.raw`[^\/\\%\s"'\x60]+`;
const PATH_TAIL = `(?:${SEP}[^\\s"'\\x60<>)\\],;]*)?`;

/** Remove lines that quote files under USER/, and any fenced block that contains one (its body is the file's content). */
function stripUserFileLines(text: string, removed: Removal[]): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !/^\s*(```|~~~)/.test(lines[j])) j++;
      const block = lines.slice(i, Math.min(j + 1, lines.length));
      const hit = block.find((l) => USER_PATH.test(l));
      if (hit) {
        removed.push({ rule: "user-file-block", was: clipLine(hit.trim()) + ` (+${block.length - 1} lines in the block)`, now: "(block removed)" });
        i = j;
        continue;
      }
      out.push(...block);
      i = j;
      continue;
    }
    if (USER_PATH.test(lines[i])) { removed.push({ rule: "user-file-line", was: clipLine(lines[i].trim()), now: "(line removed)" }); continue; }
    out.push(lines[i]);
  }
  return out.join("\n");
}

const FILE_EXT = /\.[A-Za-z0-9]{1,6}$/;
const NEXT_TOKEN = /^[^\s"'\x60<>)\],;]+/;

/**
 * Where a path ends. It stops at whitespace unless the words after the space look like more of the path: the next
 * word holds a separator, or it starts with a capital or digit (folder names with spaces read "My Documents") and
 * the word before it did not end in a file extension or sentence punctuation. Trailing sentence punctuation stays outside.
 */
function pathEnd(t: string, from: number): number {
  let end = from;
  for (;;) {
    if (t[end] !== " " && t[end] !== "\t") break;
    const next = NEXT_TOKEN.exec(t.slice(end + 1))?.[0];
    if (!next) break;
    const before = t.slice(0, end);
    const cur = before.slice(Math.max(before.lastIndexOf(" "), before.lastIndexOf("\t"), before.lastIndexOf("\n")) + 1);
    const more = /[\/\\]/.test(next) || (/^[A-Z0-9]/.test(next) && !FILE_EXT.test(cur) && !/[.:!?]$/.test(cur));
    if (!more) break;
    end += 1 + next.length;
  }
  while (end > from && /[.:!?]/.test(t[end - 1])) end--;
  return end;
}

/** Replace every path that starts with `prefix` (a regex source) by `fn(whole path, tail below the prefix)`. */
function collapsePaths(t: string, prefix: string, tailRequired: boolean, fn: (whole: string, tail: string) => string): string {
  const re = new RegExp(`(?:${prefix})(?<tail>${PATH_TAIL})`, "g");
  let out = "";
  let last = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const start = m.index;
    const tail0 = m.groups?.tail ?? "";
    let end = start + m[0].length;
    if (tail0) end = pathEnd(t, end);
    else if (tailRequired) { re.lastIndex = end; continue; }
    // In a URL-encoded path a literal & # ? is the query or fragment starting, so it ends the path.
    if (/%2[Ff]|%5[Cc]/.test(t.slice(start, end))) {
      const stop = t.slice(start, end).search(/[&#?]/);
      if (stop > 0) end = start + stop;
    }
    const whole = t.slice(start, end);
    const prefixLen = m[0].length - tail0.length;
    out += t.slice(last, start) + fn(whole, t.slice(start + prefixLen, end));
    last = end;
    re.lastIndex = Math.max(end, start + 1);
  }
  return out + t.slice(last);
}

/** Scrub one piece of text. Everything it takes out is listed in `removed`. */
export function scrub(input: string, env: ScrubEnv, e?: Erratum): { text: string; removed: Removal[] } {
  const removed: Removal[] = [];
  let t = input.toWellFormed();

  t = stripUserFileLines(t, removed);

  if (e) for (const { value, field } of privateValues(e)) {
    const re = new RegExp(esc(value), "g");
    if (re.test(t)) { removed.push({ rule: `context-${field}`, was: clipLine(value, 60), now: "[removed]" }); t = t.replace(new RegExp(esc(value), "g"), () => "[removed]"); }
  }

  const external = (rule: string, fn: (s: string) => string) => {
    const after = fn(t);
    if (after !== t) for (const s of redactedSpans(t, after)) removed.push({ rule, was: mask(s), now: "[REDACTED]" });
    t = after;
  };
  external("secret", redactSecrets);
  external("pii", (s) => redactPii(s, false));

  const pattern = (rule: string, re: RegExp, to: string, show: (m: string) => string = (m) => m) => {
    t = t.replace(re, (m) => { removed.push({ rule, was: show(m), now: to }); return to; });
  };
  pattern("session-id", UUID, "<session-id>");
  pattern("token", ENTROPY, "[REDACTED-TOKEN]", mask);

  // Home-directory paths: the home prefix and everything below it collapse, keeping only `.claude` as the install marker.
  const homes: string[] = [];
  const homeSegments = (env.homeDir ?? "").split(/[\/\\]/).filter(Boolean);
  if (env.homeDir && env.homeDir.length > 1 && homeSegments.length) homes.push((/^[\/\\]/.test(env.homeDir) ? SEP : "") + homeSegments.map(esc).join(SEP));
  homes.push(
    `[A-Za-z]:${SEP}Users${SEP}${NAME}`, `${SEP}Users${SEP}${NAME}`, `${SEP}home${SEP}${NAME}`,
    String.raw`\$\{?HOME\}?`, String.raw`%(?:USERPROFILE|HOME|HOMEPATH)%`,
  );
  const home = (m: string, tail: string) => {
    removed.push({ rule: "home-path", was: m, now: "<home>…" });
    if (!tail) return "<home>";
    return new RegExp(`^${SEP}\\.claude${SEP}`).test(tail) ? "<home>/.claude/<path>" : "<home>/<path>";
  };
  t = collapsePaths(t, `(?:${homes.join("|")})`, false, home);
  // `~/x` and `~name/x`; a bare `~5` is not a path.
  t = collapsePaths(t, `(?<![\\w~])~(?:[A-Za-z0-9_.-]+(?=${SEP}))?`, true, home);
  // Paths outside home: temp dirs, mounts, system and application roots, shell and Windows variables, any drive letter.
  const system = (m: string) => { removed.push({ rule: "system-path", was: clipLine(m), now: "<path>" }); return "<path>"; };
  t = collapsePaths(t, `(?<![\\w\\/\\\\.:~$%-])(?:\\\\*\\/|%2[Ff])(?:private|var|tmp|opt|Volumes|mnt|srv|root|etc|usr|Library|Applications|System|proc|run|media|snap|nix)(?=${SEP})`, true, system);
  t = collapsePaths(t, String.raw`(?<![\w$%])(?:\$\{?(?:PWD|OLDPWD|TMPDIR|TMP|TEMP|XDG_[A-Z_]+)\}?|%(?:APPDATA|LOCALAPPDATA|TEMP|TMP|PROGRAMDATA)%)`, false, system);
  t = collapsePaths(t, `(?<![A-Za-z0-9])[A-Za-z]:(?=${SEP}[^\\s"'\\x60<>)\\],;])`, true, system);

  if (env.username.length >= 3) {
    const re = new RegExp(`(?<![A-Za-z0-9])${esc(env.username)}(?![A-Za-z0-9])`, "gi");
    t = t.replace(re, (m) => { removed.push({ rule: "username", was: m, now: "<user>" }); return "<user>"; });
  }

  for (const h of [env.hostname, env.hostname.split(".")[0]]) {
    if (!h || h.length < 4 || h.toLowerCase() === "localhost") continue;
    const re = new RegExp(`(?<![A-Za-z0-9-])${esc(h)}(?![A-Za-z0-9-])`, "gi");
    t = t.replace(re, (m) => { removed.push({ rule: "hostname", was: m, now: "<host>" }); return "<host>"; });
  }
  pattern("hostname", INTERNAL_HOST, "<host>");
  pattern("ip-address", IPV4, "<ip>");

  t = t.replace(/\n{3,}/g, "\n\n");
  return { text: t, removed };
}

// ---------------------------------------------------------------- draft

/** Where an approved draft goes. The label is part of what the sha256 covers. */
export interface Target { repo: string; commentOn?: number; label: string }
export interface Draft { id: string; title: string; body: string; text: string; target: Target; sha256: string; removed: Removal[] }

export function makeTarget(repo: string = UPSTREAM_REPO, commentOn?: number): Target {
  invariant(REPO_FORM.test(repo), "upstream repo must be owner/name");
  invariant(commentOn === undefined || (Number.isInteger(commentOn) && commentOn > 0), "comment-on must be a positive issue number");
  return { repo, commentOn, label: commentOn === undefined ? `github.com/${repo} (new issue)` : `github.com/${repo} (comment on issue #${commentOn})` };
}

const KIND_LABEL: Record<Kind, string> = {
  complaint: "feedback", bug: "bug", "feature-request": "feature request", correction: "correction",
  praise: "praise", question: "question", incident: "incident",
};
const MAX_SUMMARY = 6000;
const MAX_TITLE = 80;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** First sentence of the first non-empty line, cut at a word boundary. */
function titleFrom(line: string): string {
  const one = line.replace(/\s+/g, " ").trim();
  const sentence = (one.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? one).replace(/[.!?]+$/, "");
  if (sentence.length <= MAX_TITLE) return sentence;
  const cut = sentence.slice(0, MAX_TITLE);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 20)).trim() + "…";
}

export function buildDraft(e: Erratum, opts: { summary?: string; env?: ScrubEnv; repo?: string; commentOn?: number } = {}): Draft {
  invariant(e.target === "lifeos-product", "draft requires a lifeos-product erratum");
  const env = opts.env ?? defaultScrubEnv();
  const label = KIND_LABEL[e.kind] ?? "feedback";

  let summary = (opts.summary ?? "").trim();
  let titleSource: string | null = null;
  const tm = summary.match(/^title:[ \t]*(.+)\n?/i);
  if (tm) { titleSource = tm[1]; summary = summary.slice(tm[0].length).trim(); }
  if (summary.length > MAX_SUMMARY) summary = summary.slice(0, MAX_SUMMARY) + "…";

  const removed: Removal[] = [];
  const keep = (s: string) => { const r = scrub(s, env, e); removed.push(...r.removed); return r.text.trim(); };

  const complaint = keep(e.complaint);
  const summaryText = summary ? keep(summary) : "";

  // The title is derived from already-scrubbed text, then passed through the scrubber once more, silently.
  const firstLine = (titleSource ? keep(titleSource) : complaint).split("\n").find((l) => l.trim()) ?? "";
  let head = scrub(titleFrom(firstLine), env, e).text.replace(/\s+/g, " ").trim();
  if (head.replace(/[^A-Za-z]/g, "").length < 3) head = "Feedback from a LifeOS user";
  const title = `[${label}] ${head}`;

  const details: string[] = [`- Kind: ${label}`];
  const component = e.context?.component ? keep(String(e.context.component)).replace(/\s+/g, " ") : "";
  if (component) details.push(`- Component: ${component}`);
  const version = e.context?.version ? keep(String(e.context.version)).replace(/\s+/g, " ") : "";
  if (version) details.push(`- LifeOS version: ${version}`);

  const parts = [`## What happened\n\n${complaint || "(no text)"}`];
  if (summaryText) parts.push(`## Summary\n\n${summaryText}`);
  parts.push(`## Details\n\n${details.join("\n")}`);
  parts.push("---\n\nFiled with the LifeOS `/feedback` command. The reporter approved this exact text before it was sent; paths, secrets and personal details were stripped locally.");
  const body = parts.join("\n\n") + "\n";

  const text = `${title}\n\n${body}`;
  const target = makeTarget(opts.repo, opts.commentOn);
  return { id: e.id, title, body, text, target, sha256: sha256(`target: ${target.label}\n\n${text}`), removed };
}

export function renderPreview(d: Draft): string {
  const removed = d.removed.length
    ? d.removed.map((r) => `  - ${r.rule}: ${r.was}  ->  ${r.now}`).join("\n")
    : "  (nothing needed removing)";
  const flag = d.target.commentOn === undefined ? "" : ` --comment-on ${d.target.commentOn}`;
  return [
    "WILL BE SENT TO",
    d.target.label,
    "",
    "ISSUE TITLE",
    d.title,
    "",
    "ISSUE BODY",
    d.body.trimEnd(),
    "",
    `SHA256  ${d.sha256}`,
    "",
    `REMOVED BY THE SCRUBBER (${d.removed.length})`,
    removed,
    "",
    `To file this exact text to that target: bun Send.ts file ${d.id} --confirm ${d.sha256}${flag}`,
    "To keep it local: do nothing.",
  ].join("\n");
}

// ---------------------------------------------------------------- store access

export type SendDeps = {
  store?: ErrataStore;
  env?: ScrubEnv;
  runner?: GhRunner;
  readFile?: (path: string) => string;
  processEnv?: Record<string, string | undefined>;
  /** Tests only: a stand-in for the upstream repo. Never read from the environment. */
  repo?: string;
};

function loadErratum(id: string, store: ErrataStore): Erratum | null {
  return store.get(id);
}

export function draftFor(id: string, o: { summaryFile?: string; commentOn?: number } & SendDeps = {}): { ok: true; draft: Draft; erratum: Erratum } | { ok: false; reason: "not-found" | "target"; message: string } {
  const store = o.store ?? new ErrataStore();
  const e = loadErratum(id, store);
  if (!e) return { ok: false, reason: "not-found", message: `no erratum ${id}` };
  if (e.target !== "lifeos-product") return { ok: false, reason: "target", message: `${id} is about this install, not LifeOS itself; it stays in the local ledger` };
  const summary = o.summaryFile ? (o.readFile ?? ((p) => readFileSync(p, "utf8")))(o.summaryFile) : undefined;
  return { ok: true, draft: buildDraft(e, { summary, env: o.env, repo: o.repo, commentOn: o.commentOn }), erratum: e };
}

// ---------------------------------------------------------------- gh

export interface GhResult { code: number; stdout: string; stderr: string }
export type GhRunner = (args: string[], opts: { env: Record<string, string>; input?: string }) => GhResult;

const TOKEN_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
// Variables that would move a call to another host or repository than the one the person approved.
const REDIRECT_ENV = ["GH_HOST", "GH_REPO"];

/** The environment gh runs in: the person's own, minus every variable that would swap in another account's token or move the target. */
export function ghEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !TOKEN_ENV.includes(k) && !REDIRECT_ENV.includes(k)) out[k] = v;
  return out;
}

export const realGhRunner: GhRunner = (args, opts) => {
  const r = Bun.spawnSync(["gh", ...args], { env: opts.env, stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : undefined });
  return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

export interface DuplicateCandidate { number: number; title: string; url: string }

export type FileResult =
  | { ok: true; mode: "issue" | "comment"; url: string; linked: boolean }
  | { ok: false; reason: "not-found" | "target" | "no-confirm" | "hash-mismatch" | "duplicates" | "already-filed" | "gh-failed"; message: string; draft?: Draft; candidates?: DuplicateCandidate[] };

const ISSUE_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+(?:#issuecomment-\d+)?/;

export function fileDraft(id: string, o: { confirm?: string; commentOn?: number; allowNew?: boolean; summaryFile?: string } & SendDeps = {}): FileResult {
  const store = o.store ?? new ErrataStore();
  const d = draftFor(id, { ...o, store });
  if (!d.ok) return { ok: false, reason: d.reason, message: d.message };
  const { draft, erratum } = d;
  // The host is pinned in the repo argument, so no GH_HOST in the person's shell can move the call.
  const repoArg = `github.com/${draft.target.repo}`;

  if (!o.confirm) return { ok: false, reason: "no-confirm", message: "file needs --confirm <sha256> from the draft the person just saw", draft };
  if (o.confirm.trim().toLowerCase() !== draft.sha256) {
    return { ok: false, reason: "hash-mismatch", message: "the rebuilt draft does not hash to the approved text and target; nothing was filed. Review the draft below and approve its hash again.", draft };
  }
  if (erratum.links?.issue && o.commentOn === undefined) {
    return { ok: false, reason: "already-filed", message: `already filed: ${erratum.links.issue}. Use --comment-on <n> to add to an issue.`, draft };
  }

  const run = o.runner ?? realGhRunner;
  const env = ghEnv(o.processEnv ?? process.env);

  let result: GhResult;
  let mode: "issue" | "comment";
  if (o.commentOn !== undefined) {
    mode = "comment";
    result = run(["issue", "comment", String(draft.target.commentOn), "--repo", repoArg, "--body-file", "-"], { env, input: draft.text });
  } else {
    // Duplicate search: the approved title only, so nothing but approved words reach GitHub.
    const search = run(["issue", "list", "--repo", repoArg, "--state", "open", "--search", draft.title, "--json", "number,title,url", "--limit", "5"], { env });
    let candidates: DuplicateCandidate[] = [];
    let searchError: string | null = null;
    if (search.code !== 0) {
      searchError = `gh issue list exited ${search.code}: ${(search.stderr || search.stdout).trim().slice(0, 300)}`;
    } else {
      try {
        const parsed = JSON.parse(search.stdout || "[]");
        if (Array.isArray(parsed)) candidates = parsed.filter((c) => c && Number.isInteger(c.number));
        else searchError = "gh issue list returned something other than a JSON array";
      } catch {
        searchError = "gh issue list returned output that is not JSON";
      }
    }
    // A search that did not run is not a search that found nothing: filing on it could open a
    // duplicate public issue, so only --new (the person's explicit "file anyway") goes past it.
    if (searchError && !o.allowNew) {
      return { ok: false, reason: "gh-failed", message: `duplicate search failed, so nothing was filed (${searchError}). Re-run once gh can search, or re-run with --new to file without the check.`, draft };
    }
    if (candidates.length && !o.allowNew) {
      return { ok: false, reason: "duplicates", message: "open issues may already cover this. To add to one, run draft with --comment-on <n> and approve that target; or re-run with --new to file anyway.", draft, candidates };
    }
    mode = "issue";
    result = run(["issue", "create", "--repo", repoArg, "--title", draft.title, "--body-file", "-"], { env, input: draft.body });
  }

  const url = result.stdout.match(ISSUE_URL)?.[0];
  if (result.code !== 0 || !url) {
    return { ok: false, reason: "gh-failed", message: `gh ${mode === "issue" ? "issue create" : "issue comment"} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`, draft };
  }

  if (!url.toLowerCase().startsWith(`https://github.com/${draft.target.repo.toLowerCase()}/issues/`)) {
    return { ok: false, reason: "gh-failed", message: `gh returned a URL outside ${draft.target.repo}: ${url}. Nothing was linked.`, draft };
  }
  invariant(erratum.target === "lifeos-product", "only a lifeos-product erratum gets an upstream link");
  invariant(ISSUE_URL.test(url), "issue url malformed");
  store.patch(erratum.id, { links: { ...erratum.links, issue: url } });
  return { ok: true, mode, url, linked: true };
}

// ---------------------------------------------------------------- cli

export interface CliIo { out: (s: string) => void; err: (s: string) => void }

export function runCli(argv: string[], deps: SendDeps & { io?: CliIo } = {}): number {
  const io = deps.io ?? { out: (s) => console.log(s), err: (s) => console.error(s) };
  const [cmd, id, ...rest] = argv;
  if (!cmd || !["draft", "file"].includes(cmd) || !id) { io.err("usage: Send.ts draft <id> [--summary-file <path>] [--comment-on <n>] [--json] | file <id> --confirm <sha256> [--comment-on <n>] [--new]"); return 2; }

  let json = false; let summaryFile: string | undefined; let confirm: string | undefined; let commentOn: number | undefined; let allowNew = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") json = true;
    else if (a === "--summary-file") summaryFile = rest[++i];
    else if (a === "--confirm") confirm = rest[++i];
    else if (a === "--comment-on") { commentOn = Number(rest[++i]); if (!Number.isInteger(commentOn) || commentOn < 1) { io.err("--comment-on needs an issue number"); return 2; } }
    else if (a === "--new") allowNew = true;
    else { io.err(`unknown argument: ${a}`); return 2; }
  }
  if ((cmd === "draft") && (confirm !== undefined || allowNew)) { io.err("draft takes only --summary-file, --comment-on and --json"); return 2; }

  try {
    if (cmd === "draft") {
      const d = draftFor(id, { ...deps, summaryFile, commentOn });
      if (!d.ok) { io.err(d.message); return d.reason === "target" ? 3 : 2; }
      io.out(json ? JSON.stringify({ id: d.draft.id, title: d.draft.title, body: d.draft.body, target: d.draft.target, sha256: d.draft.sha256, removed: d.draft.removed }) : renderPreview(d.draft));
      return 0;
    }
    const r = fileDraft(id, { ...deps, confirm, commentOn, allowNew, summaryFile });
    if (r.ok) {
      io.out(json ? JSON.stringify({ ok: true, mode: r.mode, url: r.url, linked: r.linked }) : `${r.mode === "issue" ? "filed" : "commented"}: ${r.url}\nlinked on ${id}`);
      return 0;
    }
    if (json) io.out(JSON.stringify({ ok: false, reason: r.reason, message: r.message, sha256: r.draft?.sha256, candidates: r.candidates }));
    else {
      io.err(r.message);
      if (r.candidates) for (const c of r.candidates) io.err(`  #${c.number} ${c.title} ${c.url}`);
      if (r.reason === "hash-mismatch" && r.draft) io.err("\n" + renderPreview(r.draft));
    }
    return r.reason === "not-found" || r.reason === "no-confirm" ? 2 : r.reason === "gh-failed" ? 4 : 3;
  } catch (err) {
    if (err instanceof Error && err.name === "InvariantViolation") throw err;
    io.err(`send: ${err instanceof Error ? err.message : err}`);
    return 2;
  }
}

if (import.meta.main) process.exit(runCli(process.argv.slice(2)));
