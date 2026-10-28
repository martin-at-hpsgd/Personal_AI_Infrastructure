#!/usr/bin/env bun
/**
 * AchillesSync — the Workflows infra-security scanner's leg into Achilles.
 *
 * The scanner probes the estate hourly and keeps its own findings ledger
 * (first_seen / last_seen / seen_count / resolved_at + reason). This leg reads
 * that ledger and mirrors it into the Achilles registry so scanner findings
 * share the one lifecycle every other finder has: the Pulse banner, the daily
 * ping, a work-repo ticket for critical/high, and close-with-evidence. Before
 * this leg existed the scanner wore its own strip at the top of Pulse next to
 * the Achilles one — one fact told twice (ISA Decisions 2026-09-07).
 *
 * Policy (ISA ISC-15/ISC-20):
 *   - a finding registers only once it has PERSISTED (seen_count ≥ 3 hourly
 *     runs — mirrors Socrates ROUTE_AFTER.hourly); one-hour flaps never land
 *   - `availability` checks never register: uptime is Bunker's plane
 *   - already-resolved scanner history is never backfilled
 *   - a finding the scanner resolves closes its entry with the reason mapped:
 *     pass → remediated · tombstoned → accepted (note carried) ·
 *     not-applicable / retired → false_positive
 *   - a retired finding the scanner reopens reopens the same entry;
 *     `accepted` entries are never reopened (disagree → tombstone in the scanner)
 *   - the sync only ever READS the scanner; every registry write goes through
 *     the Achilles CLI verbs so the invariants run
 *
 *   bun AchillesSync.ts [--dry-run] [--json]      (also: bun Achilles.ts sync-scanner)
 *
 * Config: ~/.config/workflows/config.yaml (subdomain, auth_token, security_worker),
 * the same file the Pulse bunker module reads. Doctrine: LIFEOS/ACHILLES/ISA.md (maintainer-side state of record, not in the release).
 *
 * @version 1.1.7
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acceptanceEnd, canonicalSourceRef, classifyFix, findBySourceRef, isTuned, loadFixClassOverrides, loadRegistry, SEVERITIES, type AchillesEntry, type FixClass } from "./Achilles";
import { invariant } from "./Invariant";
import { workflowsConfigPath } from "./WorkflowsConfig";

export interface ScannerFinding {
  key: string; // `${target}|${category}|${check}`
  target: string;
  category: string;
  check: string;
  severity: string;
  evidence: string;
  first_seen: string;
  last_seen: string;
  seen_count: number;
  resolved_at: string | null;
  resolved_reason?: "pass" | "not-applicable" | "retired" | "tombstoned";
  resolved_note?: string;
}

/** Consecutive hourly fails before a finding is a weakness rather than a flap. */
export const PERSIST_AFTER = 3;
/** Categories that are health, not weakness — Bunker wears those. */
export const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set(["availability"]);
/** Severities that earn a work-repo ticket (same threshold as the Pulse banner). */
export const TICKET_SEVERITIES: ReadonlySet<string> = new Set(["critical", "high"]);

/** Idempotency key. A pass-resolved finding that fails again is a NEW scanner
 *  record with its own first_seen, so it becomes a new entry — correct: it is a
 *  regression, not the same open weakness. */
export const sourceRef = (f: Pick<ScannerFinding, "key" | "first_seen">): string => `workflows:${f.key}#${f.first_seen}`;

export type Resolution = "remediated" | "accepted" | "false_positive";

export type SyncAction =
  | { kind: "add"; ref: string; finding: ScannerFinding; ticket: boolean }
  | { kind: "close"; id: string; ref: string; resolution: Resolution; evidence: string; owner?: string; until?: string }
  | { kind: "reopen"; id: string; ref: string; evidence: string; ticket: boolean }
  | { kind: "severity"; id: string; ref: string; from: string; to: string };

export interface SyncPlan { actions: SyncAction[]; skipped: { key: string; why: string }[] }

/** A scanner tombstone is the principal's acceptance; it lapses for re-review after this long (ISA ISC-82). */
export const TOMBSTONE_ACCEPT_DAYS = 180;

export function resolutionFor(f: ScannerFinding, now = Date.now()): { resolution: Resolution; evidence: string; owner?: string; until?: string } {
  const at = f.resolved_at ?? "unknown time";
  switch (f.resolved_reason ?? "pass") {
    case "pass": return { resolution: "remediated", evidence: `scanner cleared: ${f.check} on ${f.target} passed at ${at}` };
    case "tombstoned": return { resolution: "accepted", evidence: `scanner tombstoned at ${at}: ${f.resolved_note ?? "no note recorded"}`, owner: "principal (scanner tombstone)", until: new Date(now + TOMBSTONE_ACCEPT_DAYS * 86_400_000).toISOString().slice(0, 10) };
    case "not-applicable": return { resolution: "false_positive", evidence: `scanner: ${f.check} no longer applies to ${f.target} (${at})` };
    case "retired": return { resolution: "false_positive", evidence: `scanner: ${f.check} retired from the inventory for ${f.target} (${at})` };
  }
}

const isOpen = (e: AchillesEntry) => e.status === "open" || e.status === "in_progress";

/** Pure: scanner ledger + registry → the actions that bring the registry in line. */
export function planScannerSync(findings: ScannerFinding[], registry: { entries: AchillesEntry[] }): SyncPlan {
  const actions: SyncAction[] = [];
  const skipped: SyncPlan["skipped"] = [];
  for (const f of findings) {
    const ref = sourceRef(f);
    const existing = findBySourceRef(registry as Parameters<typeof findBySourceRef>[0], ref);
    const knownSeverity = (SEVERITIES as readonly string[]).includes(f.severity);
    if (!existing) {
      if (EXCLUDED_CATEGORIES.has(f.category)) { skipped.push({ key: f.key, why: `${f.category} is health, not a weakness` }); continue; }
      if (f.resolved_at) { skipped.push({ key: f.key, why: "already resolved — history is never backfilled" }); continue; }
      if (!knownSeverity) { skipped.push({ key: f.key, why: `unknown severity ${f.severity}` }); continue; }
      if (f.seen_count < PERSIST_AFTER) { skipped.push({ key: f.key, why: `seen ${f.seen_count}/${PERSIST_AFTER} — not yet persisted` }); continue; }
      actions.push({ kind: "add", ref, finding: f, ticket: TICKET_SEVERITIES.has(f.severity) });
      continue;
    }
    if (f.resolved_at) {
      if (isOpen(existing)) {
        const r = resolutionFor(f);
        // A ref this entry already cleared or held is history; planning it again would rewrite the entry every hour.
        const done = [...(existing.cleared_refs ?? []), ...(existing.held_refs ?? [])].map(canonicalSourceRef);
        if (done.includes(canonicalSourceRef(ref))) continue;
        // An acceptance that lapsed waits for a fresh decision: a tombstone older than the lapse never re-accepts it.
        if (r.resolution === "accepted" && existing.accepted_until && Date.parse(f.resolved_at) <= acceptanceEnd(existing.accepted_until)) { skipped.push({ key: f.key, why: `${existing.id}: acceptance expired ${existing.accepted_until} — waits for the principal, never re-accepted by an older tombstone` }); continue; }
        actions.push({ kind: "close", id: existing.id, ref, ...r });
      }
      continue;
    }
    // scanner says the check is failing
    if (isTuned(existing)) { skipped.push({ key: f.key, why: `${existing.id}: false positive with a tuned finder — never reopened by the scanner` }); continue; }
    if (existing.status === "remediated" || existing.status === "false_positive") {
      actions.push({
        kind: "reopen", id: existing.id, ref,
        evidence: `scanner reopened: ${f.check} on ${f.target} failing again, ${f.seen_count} consecutive runs (last ${f.last_seen})`,
        ticket: TICKET_SEVERITIES.has(f.severity),
      });
      continue;
    }
    if (isOpen(existing) && knownSeverity && existing.severity !== f.severity) {
      actions.push({ kind: "severity", id: existing.id, ref, from: existing.severity, to: f.severity });
    }
  }
  return { actions, skipped };
}

// ---------- scanner I/O (read-only) ----------

export interface ScannerConfig { url: string; token: string }

export function scannerConfig(home = process.env.HOME ?? homedir()): ScannerConfig | null {
  try {
    const y = readFileSync(workflowsConfigPath(home), "utf8");
    const subdomain = y.match(/^subdomain:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
    const token = y.match(/^auth_token:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
    const worker = y.match(/^security_worker:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || "infra-security";
    if (!subdomain || !token) return null;
    // The bearer token only ever goes to a Cloudflare Workers host: both labels must be plain DNS labels, so a value
    // like `evil.example/x#` or `a.b` cannot rewrite the authority.
    if (!DNS_LABEL.test(subdomain) || !DNS_LABEL.test(worker)) return null;
    const url = `https://${worker}.${subdomain}.workers.dev`;
    return isScannerOrigin(url) ? { url, token } : null;
  } catch { return null; }
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/** True only for an https URL whose host is `<label>.<label>.workers.dev`, with no credentials, port or odd path. */
export function isScannerOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/i.test(u.hostname) && (u.pathname === "/" || u.pathname === "");
  } catch { return false; }
}

export async function fetchFindings(cfg: ScannerConfig): Promise<ScannerFinding[]> {
  invariant(isScannerOrigin(cfg.url), `scanner origin refused: ${cfg.url}`);
  // redirect: "error" — the bearer token must never follow a redirect to another host.
  const r = await fetch(`${cfg.url}/findings?all=1`, { headers: { Authorization: `Bearer ${cfg.token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  invariant(r.ok, `scanner /findings returned HTTP ${r.status}`);
  const d = (await r.json()) as { findings?: ScannerFinding[] };
  invariant(Array.isArray(d.findings), "scanner /findings payload has no findings[]");
  return d.findings!;
}

// ---------- fix_class backfill (F9 ISC-42) ----------

export interface FixClassBackfill { id: string; to: FixClass }

/** Pure: every open entry with no fix_class, and the class classifyFix gives it. Writers that skip the classifier (the old code sweep) never leave an entry unworked past the next hourly sync. */
export function planFixClassBackfill(registry: { entries: AchillesEntry[] }, overrides: Record<string, FixClass> = loadFixClassOverrides()): FixClassBackfill[] {
  return registry.entries.filter((e) => isOpen(e) && !e.fix_class).map((e) => ({ id: e.id, to: classifyFix(e, overrides) }));
}

// ---------- execution: every write is an Achilles CLI verb ----------

const ACHILLES = join(import.meta.dir, "Achilles.ts");

function achilles(args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync([process.execPath, ACHILLES, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
}

export function addArgv(f: ScannerFinding, ref: string, reportUrl: string): string[] {
  return [
    "add",
    "--title", `${f.check} on ${f.target}`,
    "--description", `Workflows infra-security scanner: ${f.category}/${f.check} failing on ${f.target} for ${f.seen_count} consecutive hourly runs since ${f.first_seen}.`,
    "--category", "technical",
    "--severity", f.severity,
    "--source", "workflows-scanner",
    "--source-ref", ref,
    "--affected", f.target,
    "--first-seen", f.first_seen,
    "--evidence", `scanner: ${f.evidence} (seen ${f.seen_count}× since ${f.first_seen})`,
    "--link", reportUrl,
  ];
}

export interface SyncReport { classed: string[]; added: string[]; closed: string[]; reopened: string[]; reseverity: string[]; ticketed: number[]; skipped: number; errors: string[]; dry_run: boolean }

export async function runSync(opts: { dryRun?: boolean; json?: boolean } = {}): Promise<number> {
  const log = (l: string) => console.error(`[achilles-sync] ${l}`);
  const report: SyncReport = { classed: [], added: [], closed: [], reopened: [], reseverity: [], ticketed: [], skipped: 0, errors: [], dry_run: !!opts.dryRun };
  await runBrowserPatchLeg(report, !!opts.dryRun, log);
  runFixClassLeg(report, !!opts.dryRun, log);
  // Acceptances past their expiry read open again (ISA ISC-108), every hour, before the scanner plan reads the registry.
  const exp = achilles(["expire-acceptances", ...(opts.dryRun ? ["--dry-run"] : [])]);
  if (exp.code !== 0) report.errors.push(`expire-acceptances: ${(exp.err || exp.out).slice(0, 160)}`);
  else for (const id of (JSON.parse(exp.out || "{}").reopened ?? []) as string[]) report.reopened.push(id);
  const cfg = scannerConfig();
  if (!cfg) { log("no scanner configured (~/.config/workflows/config.yaml) — nothing to sync"); console.log(JSON.stringify(report)); return report.errors.length ? 1 : 0; }
  const findings = await fetchFindings(cfg);
  const plan = planScannerSync(findings, loadRegistry());
  report.skipped = plan.skipped.length;

  const ticket = (id: string) => {
    const t = achilles(["ticket", id]);
    const num = Number(t.out.match(/"(?:work|ul)_issue":(\d+)/)?.[1]);
    if (t.code !== 0 || !num) { report.errors.push(`ticket ${id}: ${(t.err || t.out).slice(0, 160)}`); return; }
    if (/"status":"ticketed"/.test(t.out)) report.ticketed.push(num);
  };

  for (const a of plan.actions) {
    if (opts.dryRun) { log(`would ${a.kind} ${a.kind === "add" ? a.finding.key : a.id}`); continue; }
    try {
      switch (a.kind) {
        case "add": {
          const r = achilles(addArgv(a.finding, a.ref, `${cfg.url}/findings`));
          const id = r.out.match(/"id":"(ACH-\d{4})"/)?.[1];
          if (r.code !== 0 || !id) { report.errors.push(`add ${a.finding.key}: ${(r.err || r.out).slice(0, 160)}`); break; }
          if (/"status":"added"/.test(r.out)) report.added.push(id);
          if (/"status":"reopened"/.test(r.out)) report.reopened.push(id);
          if (a.ticket && /"status":"(added|reopened)"/.test(r.out)) ticket(id);
          break;
        }
        case "close": {
          const r = achilles(["close", a.id, "--evidence", a.evidence, "--resolution", a.resolution, "--ref", a.ref, ...(a.owner ? ["--owner", a.owner] : []), ...(a.until ? ["--until", a.until] : [])]);
          if (r.code !== 0) { report.errors.push(`close ${a.id}: ${(r.err || r.out).slice(0, 160)}`); break; }
          if (/"status":"closed"/.test(r.out)) report.closed.push(a.id);
          break;
        }
        case "reopen": {
          const r = achilles(["reopen", a.id, "--evidence", a.evidence]);
          if (r.code !== 0) { report.errors.push(`reopen ${a.id}: ${(r.err || r.out).slice(0, 160)}`); break; }
          report.reopened.push(a.id);
          if (a.ticket) ticket(a.id);
          break;
        }
        case "severity": {
          const r = achilles(["update", a.id, "--severity", a.to, "--evidence", `scanner re-graded ${a.from} → ${a.to}`]);
          if (r.code !== 0) { report.errors.push(`severity ${a.id}: ${(r.err || r.out).slice(0, 160)}`); break; }
          report.reseverity.push(a.id);
          break;
        }
      }
    } catch (err) {
      report.errors.push(`${a.kind}: ${String(err).slice(0, 200)}`);
    }
  }

  if (opts.dryRun) {
    const counts = plan.actions.reduce<Record<string, number>>((m, a) => ((m[a.kind] = (m[a.kind] ?? 0) + 1), m), {});
    console.log(JSON.stringify({ dry_run: true, findings: findings.length, plan: counts, skipped: plan.skipped.length, ...(opts.json ? { actions: plan.actions, skipped_detail: plan.skipped } : {}) }, null, opts.json ? 2 : 0));
    return 0;
  }
  console.log(JSON.stringify(report, null, opts.json ? 2 : 0));
  return report.errors.length ? 1 : 0;
}

/** Stamps fix_class on every open entry that lacks one: one `achilles update --fix-class` per planned entry, so the CLI invariants run, only the planned (open) entries change, and `report.classed` lists exactly the ids the CLI accepted. */
export function runFixClassLeg(report: SyncReport, dryRun: boolean, log: (l: string) => void, deps: { registry?: { entries: AchillesEntry[] }; run?: (args: string[]) => { code: number; out: string; err: string } } = {}): void {
  const todo = planFixClassBackfill(deps.registry ?? loadRegistry());
  if (!todo.length) return;
  if (dryRun) { log(`would classify ${todo.length} unclassified open entries`); return; }
  const run = deps.run ?? achilles;
  for (const t of todo) {
    const r = run(["update", t.id, "--fix-class", t.to]);
    if (r.code !== 0) { report.errors.push(`classify ${t.id}: ${(r.err || r.out).slice(0, 160)}`); continue; }
    report.classed.push(t.id);
  }
}

// ── Browser-patch leg ────────────────────────────────────────────────────
// A Synapse story entry for a browser we run ("Google Chrome") stays open long
// after the browser auto-updated, because nothing compared the installed build
// with the fixed one (an entry once sat eleven days on a browser that had patched itself).
// This leg reads the story links the entry already carries, takes the highest
// dotted build number as the fixed build, and closes the entry as remediated
// when the installed build is at or above it. Only the version regex is taken
// from the fetched page; nothing else it says is read.

/** Numeric compare of dotted build strings (152.0.7977.84 vs 152.0.7977.82). */
export function compareBuilds(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** A Chrome release build: major ≥ 100, build segment ≥ 1000 — never an IP, an extension or a ChromeOS platform version. */
export function isChromeBuild(v: string): boolean {
  const [major, , build] = v.split(".").map(Number);
  return major >= 100 && build >= 1000;
}

/**
 * The FIXED Chrome build named by a story, or null. The number must sit within
 * a short window after a fix word (fixed / patched / updated / addressed /
 * resolved / "update to") in a sentence that names Chrome, so an
 * affected-only build ("Chrome version 152.0.7977.60 is exploited, no fix yet"),
 * a stray IP, or an extension version never closes an entry (audit 2026-09-15).
 * The bare word "version" is not a fix word: it labels affected builds as often
 * as fixed ones ("update to version X" still qualifies through "update").
 * A build followed closely by a mobile or ChromeOS platform name ("152.0.7977.89 for
 * Android") is not the desktop build this Mac runs, so it never qualifies.
 * When several qualify the highest wins.
 */
export function fixedBuildIn(text: string): string | null {
  const flat = text.replace(/\s+/g, " ");
  const found = new Set<string>();
  const re = /\b(?:fix(?:ed|es)?|patch(?:ed|es)?|updat(?:ed|es|e)|address(?:ed|es)?|resolv(?:ed|es)?)\b[^.!?]{0,120}?\b(\d+\.\d+\.\d+\.\d+)\b/gi;
  for (const m of flat.matchAll(re)) {
    const start = Math.max(0, m.index! - 200);
    const sentence = flat.slice(start, m.index! + m[0].length + 40);
    if (!/chrome/i.test(sentence)) continue;
    const after = flat.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
    if (/\b(?:android|ios|chromeos|chrome os)\b/i.test(after)) continue;
    if (isChromeBuild(m[1]!)) found.add(m[1]!);
  }
  return found.size ? [...found].sort(compareBuilds)[found.size - 1]! : null;
}

export function installedChromeVersion(): string | null {
  const p = Bun.spawnSync(["plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", "/Applications/Google Chrome.app/Contents/Info.plist"], { stdout: "pipe", stderr: "pipe" });
  const v = p.stdout.toString().trim();
  return p.exitCode === 0 && /^\d+(\.\d+){3}$/.test(v) ? v : null;
}

export interface BrowserPatchClose { id: string; fixed: string; installed: string; link: string }

export async function planBrowserPatchCloses(
  registry: { entries: AchillesEntry[] },
  installed: string | null,
  fetchText: (url: string) => Promise<string>,
): Promise<BrowserPatchClose[]> {
  if (!installed) return [];
  const out: BrowserPatchClose[] = [];
  for (const e of registry.entries) {
    if (e.status !== "open" || e.source !== "synapse") continue;
    if (!(e.affected ?? []).some((a) => /google chrome/i.test(a))) continue;
    for (const link of e.links ?? []) {
      let page: string;
      try { page = await fetchText(link); } catch { continue; }
      // An entry that names CVEs closes only on a page that names one of them, so a fix for another Chrome bug
      // on the same advisory or news page never stands in for this one.
      if ((e.cves ?? []).length && !e.cves.some((c) => page.toUpperCase().includes(c.toUpperCase()))) continue;
      const fixed = fixedBuildIn(page);
      if (fixed && compareBuilds(installed, fixed) >= 0) { out.push({ id: e.id, fixed, installed, link }); break; }
    }
  }
  return out;
}

/**
 * Advisory hosts the browser-patch leg may fetch (exact host match, https only). Registry links come from externally
 * ingested stories, and a fetched page can auto-close a vulnerability entry, so the destination is an allowlist, not
 * whatever the story linked. Redirects are followed by hand and every hop must stay on the list.
 */
export const ADVISORY_HOSTS: ReadonlySet<string> = new Set([
  "chromereleases.googleblog.com", "developer.chrome.com", "www.chromium.org", "issues.chromium.org", "chromium.googlesource.com",
  "nvd.nist.gov", "www.cve.org", "www.cisa.gov", "msrc.microsoft.com", "support.apple.com",
  "www.bleepingcomputer.com", "thehackernews.com", "www.securityweek.com", "www.theregister.com", "arstechnica.com", "therecord.media", "krebsonsecurity.com",
]);

export function isApprovedAdvisoryUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && (u.port === "" || u.port === "443") && ADVISORY_HOSTS.has(u.hostname.toLowerCase());
  } catch { return false; }
}

/** Fetch an approved advisory page; each redirect hop is re-checked against the allowlist (max 3 hops). */
export async function fetchAdvisory(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let cur = url;
  for (let hop = 0; hop <= 3; hop++) {
    if (!isApprovedAdvisoryUrl(cur)) throw new Error(`advisory URL not on the approved list: ${cur}`);
    const r = await fetchImpl(cur, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) throw new Error(`${cur} redirected with no location`);
      cur = new URL(loc, cur).toString();
      continue;
    }
    if (r.status !== 200) throw new Error(`${cur} answered ${r.status}`);
    return r.text();
  }
  throw new Error(`${url} redirected too many times`);
}

export async function runBrowserPatchLeg(report: SyncReport, dryRun: boolean, log: (l: string) => void): Promise<void> {
  const closes = await planBrowserPatchCloses(loadRegistry(), installedChromeVersion(), (u) => fetchAdvisory(u));
  for (const c of closes) {
    if (dryRun) { log(`would close ${c.id} (installed Chrome ${c.installed} ≥ fixed ${c.fixed})`); continue; }
    const r = achilles(["close", c.id, "--evidence", `installed Google Chrome ${c.installed} ≥ fixed build ${c.fixed} named by ${c.link} (auto-updated; checked ${new Date().toISOString()})`, "--resolution", "remediated"]);
    if (r.code !== 0) { report.errors.push(`close ${c.id}: ${(r.err || r.out).slice(0, 160)}`); continue; }
    report.closed.push(c.id);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  runSync({ dryRun: args.includes("--dry-run"), json: args.includes("--json") })
    .then((code) => process.exit(code))
    .catch((err) => { console.error(`[achilles-sync] fatal: ${String(err)}`); process.exit(1); });
}
