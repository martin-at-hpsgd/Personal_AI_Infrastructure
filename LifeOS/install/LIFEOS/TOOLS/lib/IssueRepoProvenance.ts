/**
 * Detector for a GitHub issue write whose target repo is not the verified-private
 * work repo.
 *
 * Issue bodies and comments carry private material (evidence, Cortex pitches,
 * session summaries). The work-config loader (hooks/lib/work-config.ts) answers
 * with a repo only after `gh` confirms it private; lib/PrivateRepo.ts runs the
 * same check for any other target. The 2026-09-27 pre-release audit found two
 * writers that skipped both: `achilles close` read work_repo.json raw, and Cortex
 * Distill filed to a configured repo with no visibility check. The /ic lane
 * `issue-repo-provenance` (IntegrityCheck.ts) uses this.
 *
 * Rules, per tracked source file:
 *   1. A file that writes issues (`gh issue create|comment|close|edit|reopen`,
 *      array or string form, or `gh api …/issues…`) must call loadWorkConfig()
 *      or verifyPrivateRepo() somewhere in the file.
 *   2. No write site passes a literal `owner/name` to --repo / -R.
 *   3. No file but the loader reads work_repo.json itself. Rule 1 is file-level, so
 *      a file that gates one command and bypasses the gate in another (the
 *      Achilles defect: `ticket` used the loader, `close` read the JSON raw)
 *      passes it; the raw read is the bypass, and this rule names it.
 * A file that legitimately writes to a public repo (community triage) goes in the
 * allowlist by path with its reason; the allowlist exempts it from both rules.
 */

const VERBS = String.raw`(?:create|comment|close|edit|reopen)`;
const Q = String.raw`["'\x60]`;

// Four shapes, in order: an argv array (gh, issue, <verb>), a shell string
// (gh issue <verb>), an argv array for gh api on an issues path, and the same as a
// shell string. Written without an inline example so this file does not match itself.
export const ISSUE_WRITE_RE = new RegExp([
  String.raw`${Q}issue${Q}\s*,\s*${Q}${VERBS}${Q}`,
  String.raw`\bgh\s+issue\s+${VERBS}\b`,
  String.raw`${Q}api${Q}\s*,[^\n]*\/issues\b`,
  String.raw`\bgh\s+api\s+[^\n]*\/issues\b`,
].join("|"));

/** Lines after a write site that still belong to its argv (a multi-line array). */
const SITE_WINDOW = 8;

/** A literal owner/name handed to --repo or -R (checked across a write site's argv window). */
export const LITERAL_REPO_RE = new RegExp(String.raw`(?:--repo|-R)(?:${Q}\s*,\s*${Q}|[\s=]+${Q}?)[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+`);

/** A repo that came through the privacy gate. The call, not an import, counts. */
export const APPROVED_REPO_SOURCE_RE = /\b(?:loadWorkConfig|verifyPrivateRepo)\s*\(/;

/** Code that opens or resolves work_repo.json (a path built for reading, or a read call on it). */
export const RAW_WORK_REPO_READ_RE = /\b(?:readFileSync|readFile|Bun\.file|join|resolve|existsSync)\([^\n]*work_repo\.json/;

/** The one file allowed to read work_repo.json: the loader that verifies it. */
export const WORK_CONFIG_LOADER = "hooks/lib/work-config.ts";

export interface IssueProvenanceFinding { line: number; rule: "no-private-source" | "literal-repo" | "raw-work-repo-read"; text: string }

function isCommentLine(line: string): boolean {
  const code = line.trim();
  return code.startsWith("//") || code.startsWith("*") || code.startsWith("/*") || code.startsWith("#");
}

/**
 * Scan one file. `allowlist` maps repo-relative path → reason; an allowlisted
 * file returns no findings.
 */
export function scanIssueRepoProvenance(rel: string, text: string, allowlist: ReadonlyMap<string, string>): IssueProvenanceFinding[] {
  if (allowlist.has(rel)) return [];
  const lines = text.split("\n");
  const findings: IssueProvenanceFinding[] = [];
  if (rel !== WORK_CONFIG_LOADER) {
    lines.forEach((line, i) => {
      if (!isCommentLine(line) && RAW_WORK_REPO_READ_RE.test(line)) findings.push({ line: i + 1, rule: "raw-work-repo-read", text: line.trim().slice(0, 140) });
    });
  }
  const sites: Array<{ line: number; text: string }> = [];
  lines.forEach((line, i) => {
    if (!isCommentLine(line) && ISSUE_WRITE_RE.test(line)) sites.push({ line: i + 1, text: line.trim().slice(0, 140) });
  });
  if (sites.length === 0) return findings;
  const approved = lines.some((l) => !isCommentLine(l) && APPROVED_REPO_SOURCE_RE.test(l));
  if (!approved) for (const s of sites) findings.push({ ...s, rule: "no-private-source" });
  for (const s of sites) {
    const window = lines.slice(s.line - 1, s.line - 1 + SITE_WINDOW).filter((l) => !isCommentLine(l));
    if (window.some((l) => LITERAL_REPO_RE.test(l))) findings.push({ ...s, rule: "literal-repo" });
  }
  return findings;
}
