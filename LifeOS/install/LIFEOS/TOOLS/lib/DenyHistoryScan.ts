/**
 * DenyHistoryScan.ts — the deny-list scan PublicReady runs before a repo goes public: HEAD, every local branch and
 * tag tip, and full history, generic patterns case-sensitive and the user file case-insensitive. A hit is reported
 * as `ref:path` locations and opaque rule ids only, never the matched line or the pattern.
 *
 * PublicReady (skills/OpenSourceManagement/Tools/PublicReady.ts) is the one caller. Ordinary pushes are held
 * separately, by each private tree's pre-push hook (LIFEOS/TOOLS/githooks/PrePush.ts), which refuses any
 * remote GitHub does not confirm private.
 */

/**
 * True for a grep location (<ref>:<path>) whose blob equals the blob at the same path in one of the
 * public commits. Any lookup failure means not public, so the location stays a hit.
 */
function publicBlobSkip(dir: string, gitEnv: Record<string, string>, publicCommits: string[]): (location: string) => boolean {
  const blob = (spec: string) => { const r = sh(["git", "rev-parse", "--verify", "-q", spec], dir, 10_000, gitEnv); return r.ok && /^[a-f0-9]{40,64}$/.test(r.out) ? r.out : null; };
  return (location) => {
    const at = location.indexOf(":");
    if (at <= 0) return false;
    const path = location.slice(at + 1);
    const mine = blob(location);
    if (!mine) return false;
    return publicCommits.some((c) => blob(`${c}:${path}`) === mine);
  };
}
const REAL_GRAPH = { GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null" };

const HISTORY_SCAN_BATCH_SIZE = 400;
// Per git-grep call. A data-heavy public repo needs ~100s for a full-history pass; a call that
// still runs over fails closed (INCOMPLETE blocks the push), exactly as before.
const GREP_TIMEOUT_MS = 120_000;

function sh(cmd: string[], cwd?: string, timeout?: number, env?: Record<string, string>): { ok: boolean; out: string } {
  try {
    const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout, env: { ...process.env, ...env } });
    return { ok: r.exitCode === 0 && !r.signalCode, out: new TextDecoder().decode(r.stdout).trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Locations shown in a denial, and the budget for naming which rules matched them. */
const MAX_SHOWN_LOCATIONS = 20;
const RULE_ID_BUDGET_MS = 20_000;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/**
 * A deny hit as the gate may report it: `ref:path` locations and opaque rule ids
 * (`generic-N`, `private-N`: the Nth loaded pattern of that set). Never a matched line and never
 * pattern text: the denial is model-visible, and a hit is by definition content that must not leak
 * (2026-10-14).
 */
interface GrepHit { locations: string[]; total: number; rules: string[] }

/** A location safe to print: control characters replaced, length capped, an object id shortened. */
function showLocation(loc: string): string {
  const at = loc.indexOf(":");
  const ref = at < 0 ? loc : loc.slice(0, at);
  const path = at < 0 ? "" : loc.slice(at + 1);
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 200);
  return `${OID.test(ref) ? ref.slice(0, 12) : clean(ref)}:${clean(path)}`;
}

function formatHit(h: GrepHit): string {
  const more = h.total > h.locations.length ? ` (+${h.total - h.locations.length} more)` : "";
  return `  files: ${h.locations.map(showLocation).join(", ")}${more}\n  rules: ${h.rules.join(", ")}`;
}

/** One `git grep` over `refs`. Returns hit locations and rule ids, or null; throws on scan failure.
 *  An empty pattern set is a no-op (git grep with zero -e args would error and
 *  fail-close the push for the wrong reason — public installs ship no user file). */
function grepRefs(dir: string, patterns: string[], caseInsensitive: boolean, refs: string[], label: string, perlRegexp = false, gitEnv: Record<string, string> = {}, ruleSet = "generic", skip?: (location: string) => boolean): GrepHit | null {
  if (patterns.length === 0) return null;
  // PCRE with many -e patterns is pathological: on a data-heavy repo
  // 110 case-insensitive -P patterns passed as separate -e args ran past two minutes and every
  // public push died INCOMPLETE. The same patterns joined into ONE alternation match exactly the
  // same files (verified on HEAD and full history) in ~3s. Coverage is unchanged.
  const joined = perlRegexp && patterns.length > 1 ? [patterns.map((p) => `(?:${p})`).join("|")] : patterns;
  const flags = ["-I", ...(caseInsensitive ? ["-i"] : []), perlRegexp ? "-P" : "-E"];
  const env = Object.keys(gitEnv).length ? { ...process.env, ...gitEnv } : undefined;
  // `-l -z`: names only, NUL-separated. The matching line never leaves git.
  const r = Bun.spawnSync(["git", "grep", ...flags, "-l", "-z", ...joined.flatMap((p) => ["-e", p]), ...refs], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: GREP_TIMEOUT_MS, env });
  // git grep: 0 = matches, 1 = clean, >1 = error
  if (r.signalCode || (r.exitCode !== 0 && r.exitCode !== 1)) throw new Error(`${label} scan failed (${r.signalCode ?? `exit ${r.exitCode}`})`);
  if (r.exitCode !== 0) return null;
  const all = Array.from(new Set(new TextDecoder().decode(r.stdout).split("\0").filter(Boolean))).filter((l) => !skip?.(l));
  if (!all.length) return null;
  const locations = all.slice(0, MAX_SHOWN_LOCATIONS);
  // Which rules matched: each pattern alone, over just the shown refs and paths. Bounded; a rule
  // the budget did not reach is reported as unidentified, never guessed.
  const hitRefs = Array.from(new Set(locations.map((l) => l.slice(0, Math.max(0, l.indexOf(":"))) || l)));
  const paths = Array.from(new Set(locations.map((l) => l.slice(l.indexOf(":") + 1)).filter(Boolean))).map((p) => `:(literal)${p}`);
  const rules: string[] = [];
  const started = Date.now();
  for (const [i, p] of patterns.entries()) {
    if (Date.now() - started > RULE_ID_BUDGET_MS) { rules.push(`${ruleSet}-unidentified`); break; }
    const one = Bun.spawnSync(["git", "grep", ...flags, "-q", "-e", p, ...hitRefs, "--", ...paths], { cwd: dir, stdout: "ignore", stderr: "ignore", timeout: GREP_TIMEOUT_MS, env });
    if (one.exitCode === 0) rules.push(`${ruleSet}-${i + 1}`);
  }
  if (!rules.length) rules.push(`${ruleSet}-unidentified`);
  return { locations, total: all.length, rules };
}

/**
 * What a transfer selects beyond HEAD and the local branch and tag tips: `all` (a mirror sends
 * every ref, remote-tracking and custom refs included) and the source side of each refspec.
 */
export interface TransferSources { all?: boolean; refs: string[] }

/**
 * The object ids a transfer's sources resolve to in this tree. Throws when one cannot be
 * resolved: an object the hook cannot bind to the scanned set is not published unscanned.
 */
function resolveSources(dir: string, gitEnv: Record<string, string>, sources: TransferSources | undefined): string[] {
  if (!sources) return [];
  const out: string[] = [];
  const listRefs = (pattern?: string): string[] => {
    const r = sh(["git", "for-each-ref", "--format=%(objectname)", ...(pattern ? [pattern] : [])], dir, 30_000, gitEnv);
    if (!r.ok) throw new Error("for-each-ref failed while resolving the transfer's sources");
    return r.out.split("\n").filter(Boolean);
  };
  if (sources.all) out.push(...listRefs());
  for (const raw of sources.refs) {
    if (raw.startsWith("^")) continue; // a negative refspec only narrows what is sent
    const colon = raw.indexOf(":");
    const src = (colon < 0 ? raw : raw.slice(0, colon)).replace(/^\+/, "");
    if (!src) continue; // a deletion, or ":" (matching branches, already scanned)
    if (src.startsWith("-")) throw new Error("a transfer source reads as an option");
    if (src.includes("*")) { out.push(...listRefs(src)); continue; }
    const r = sh(["git", "rev-parse", "--verify", "--quiet", `${src}^{commit}`], dir, 30_000, gitEnv);
    if (!r.ok || !OID.test(r.out)) throw new Error("a source object of this transfer does not resolve to a commit in the scanned tree");
    out.push(r.out);
  }
  for (const o of out) if (!OID.test(o)) throw new Error("a transfer source resolved to an invalid object id");
  return Array.from(new Set(out));
}

/**
 * Deny-scan HEAD, local tips, every source object the transfer selects (`sources`), and history.
 * Incomplete scans are blocking results. A hit is reported as locations and rule ids only.
 */
export function scan(dir: string, patterns: { generic: string[]; user: string[] }, gitEnv: Record<string, string> = {}, sources?: TransferSources, alreadyPublic: string[] = []): string | null {
  // Replacement refs and grafts rewrite ancestry, so an excluded public commit could hide private parents:
  // every scan command reads the real object graph.
  gitEnv = { ...gitEnv, ...REAL_GRAPH };
  try {
    // Two passes per ref set (#1965): generic signatures case-sensitive, user file -i.
    // {{PRINCIPAL_NAME}}, 2026-10-21: a file whose exact bytes sit at the same path in a commit the public repository
    // already serves anonymously publishes nothing new, in HEAD, a tip or history alike. Changed and new
    // files are scanned as always.
    const skip = alreadyPublic.length ? publicBlobSkip(dir, gitEnv, alreadyPublic) : undefined;
    const hits = (refs: string[], label: string): string | null => {
      for (let offset = 0; offset < refs.length; offset += HISTORY_SCAN_BATCH_SIZE) {
        const batch = refs.slice(offset, offset + HISTORY_SCAN_BATCH_SIZE);
        const hit = grepRefs(dir, patterns.generic, false, batch, label, false, gitEnv, "generic", skip) ?? grepRefs(dir, patterns.user, true, batch, label, true, gitEnv, "private", skip);
        if (hit) return formatHit(hit);
      }
      return null;
    };
    const head = hits(["HEAD"], "HEAD");
    if (head) return head;
    // Every local branch and tag TIP, always, regardless of history size: a push
    // can ship any of them (public issue #2099, @hjbrandt). The scanned set only widens here;
    // HEAD stays hardcoded, never replaced by a parsed refspec.
    const tipRefs = sh(["git", "for-each-ref", "--format=%(objectname)", "refs/heads", "refs/tags"], dir, 30_000, gitEnv);
    if (!tipRefs.ok) throw new Error("for-each-ref failed");
    // The transfer's own sources (an explicit refspec, a mirror, a configured push refspec, a
    // remote's refs before a visibility flip) widen the set: they are what actually gets
    // published (2026-10-14).
    const extra = resolveSources(dir, gitEnv, sources);
    const tipList = Array.from(new Set([...tipRefs.out.split("\n").filter(Boolean), ...extra]));
    if (tipList.length > 0) {
      const tips = hits(tipList, "branch/tag tips");
      if (tips) return "IN A BRANCH OR TAG TIP:\n" + tips;
    }
    // Local branches + tags, plus what this transfer names: that is what it can ship. Other
    // remote-tracking refs would keep a scrubbed-then-rewritten repo permanently blocked; the
    // gate must never refuse the remediation path it demands.
    const shallow = sh(["git", "rev-parse", "--is-shallow-repository"], dir, 30_000, gitEnv);
    if (!shallow.ok || shallow.out !== "false") throw new Error("history unavailable: shallow repository or failed shallow check");
    const revList = Bun.spawnSync(["git", "rev-list", "--stdin", "HEAD", "--branches", "--tags"], { cwd: dir, stdin: new TextEncoder().encode([...extra, ...alreadyPublic.map((o) => "^" + o)].join("\n") + "\n"), stdout: "pipe", stderr: "pipe", timeout: 30_000, env: { ...process.env, ...gitEnv } });
    const revs = { ok: revList.exitCode === 0 && !revList.signalCode, out: new TextDecoder().decode(revList.stdout).trim() };
    if (!revs.ok || (!revs.out && alreadyPublic.length === 0) || !revs.out.split("\n").filter(Boolean).every((rev) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(rev))) {
      throw new Error("history revision enumeration failed or returned invalid output");
    }
    // Empty only when the destination already serves all of it (checked above); nothing new to scan.
    const histRevs = revs.out.split("\n").filter(Boolean);
    const hist = histRevs.length ? hits(histRevs, "history") : null;
    if (hist) return "IN HISTORY (older commit blobs):\n" + hist;
    return null;
  } catch (err) {
    return `INCOMPLETE: ${err instanceof Error ? err.message : String(err)}. Repair the scan and retry; public publication is blocked.`;
  }
}
