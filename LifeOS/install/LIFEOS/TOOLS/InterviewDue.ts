#!/usr/bin/env bun
/**
 * @version 1.0.10
 */
// Normalize env path vars Claude Code may inject unexpanded — literal $HOME/${HOME}
// in LIFEOS_DIR/LIFEOS_CONFIG_DIR/PROJECTS_DIR resolves to a shadow dir (#1404 / PR #1451, author jbmml).
for (const __k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const __v = process.env[__k];
  if (__v && /^\$\{?HOME\}?(\/|$)/.test(__v)) process.env[__k] = __v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}

/**
 * InterviewDue — deterministic "is an interview due" verdict, and the cron entrypoint.
 *
 * Four independent conditions make an interview due: a domain whose observed data
 * has run ahead of the claim file that describes it, constitutional files past their
 * review threshold, or plain cadence since the last interview. The verdict carries a
 * statusline-sized headline plus one human reason per triggered condition.
 *
 * `computeVerdict` is pure over plain data so the rules are testable without a
 * filesystem. Everything above it degrades: a missing evidence cache still yields a
 * verdict from freshness and cadence alone, with a reason saying so. Nothing throws.
 *
 * LOCAL FILES ONLY. No network.
 *
 * Usage:
 *   bun InterviewDue.ts               Verdict from existing caches + write cache
 *   bun InterviewDue.ts --refresh     Regenerate evidence + freshness first (cron entrypoint)
 *   bun InterviewDue.ts --mark-done   Record an interview — REFUSED (exit 2) while overdue
 *                                     files or state claims still make one due; the
 *                                     interview's job is to review exactly those
 *   bun InterviewDue.ts --mark-done --partial   Record a stopped interview anyway
 *                                     (the principal said stop); prints what remains
 */

import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "node:os";
import * as Freshness from "./TelosFreshness";
import { readContextFreshness } from "./TelosFreshness";
import type { ContextFreshness } from "./TelosFreshness";
import { gatherEvidence, writeEvidenceCache, readEvidenceCache, type Evidence } from "./StateEvidence";
import { getPrincipalName } from "../../hooks/lib/identity";
import { getLifeosDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

// Normalize env path vars that Claude Code injects without shell expansion (LifeOS#1404)
for (const k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const v = process.env[k];
  if (v && /^\$\{?HOME\}?(\/|$)/.test(v)) process.env[k] = v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const LIFEOS_DIR = getLifeosDir();
const CACHE_PATH = join(LIFEOS_DIR, "USER", "CACHE", "interview-due.json");
const INTERVIEW_STATE = join(LIFEOS_DIR, "MEMORY", "STATE", "interview.json");

/** Days of unexamined observation before a domain's claim file counts as contradicted. */
export const SKEW_THRESHOLD_DAYS = 14;
export const STATE_STALE_THRESHOLD = 5;
/** Constitutional files past review before the count alone makes an interview due. */
export const CONSTITUTIONAL_STALE_THRESHOLD = 3;
/** Plain cadence: days between interviews. */
export const INTERVIEW_CADENCE_DAYS = 14;
/** Statusline budget. */
export const HEADLINE_MAX = 60;

/** Candidate CURRENT_STATE claim slugs per evidence domain; work has none. The
 *  shipped template names the money file MONEY.md, older installs carry
 *  FINANCIAL.md (public issue #2202, @bak3r). */
export const DOMAIN_CLAIM_SLUGS: Record<string, readonly string[] | null> = {
  health: ["current_state_health"],
  activity: ["current_state_activity"],
  money: ["current_state_money", "current_state_financial"],
  work: null,
};

/** Pure: the claim file that speaks for a domain, matched against every candidate slug. */
export function claimFileFor<T extends { slug: string }>(files: readonly T[] | undefined, domain: string): T | null {
  const slugs = DOMAIN_CLAIM_SLUGS[domain];
  if (!slugs || !files) return null;
  return files.find((f) => slugs.includes(f.slug)) ?? null;
}

/** Which evidence source's liveness gates each domain's skew condition. */
const DOMAIN_SOURCE_IDS: Record<string, string> = {
  health: "oura",
  activity: "conduit",
  money: "expenses",
};

// ---------- types ----------

export interface DomainSkew {
  domain: string;
  /** Days between the claim file's last review and the domain's newest observation. */
  evidence_days_since_review: number | null;
  /** True when the claim file carries no review marker at all. */
  never_reviewed: boolean;
  /** Age of the claim file's review marker, for the headline. Null when never reviewed. */
  claim_reviewed_age_days: number | null;
  /** A dead or stale feed cannot contradict a claim, so it never triggers. */
  source_live: boolean;
  newest_observation: string | null;
}

export interface VerdictInputs {
  domains: DomainSkew[];
  stale_constitutional: number;
  stale_state: number;
  days_since_last_interview: number | null;
  /** False when the evidence cache is missing — the verdict says so in its reasons. */
  evidence_available: boolean;
}

export interface Verdict {
  schema: 1;
  computed_at: string;
  due: boolean;
  reasons: string[];
  headline: string;
  inputs: {
    stale_constitutional: number;
    stale_state: number;
    worst_domain: string | null;
    days_since_last_interview: number | null;
  };
}

// ---------- the rule ----------

function truncate(s: string, max: number = HEADLINE_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Skew magnitude for ranking. A never-reviewed domain with no dated evidence still counts. */
function skewDays(d: DomainSkew): number {
  return d.evidence_days_since_review ?? 0;
}

function domainTriggers(d: DomainSkew): boolean {
  if (!d.source_live) return false;
  if (d.never_reviewed) return true;
  return d.evidence_days_since_review !== null && d.evidence_days_since_review >= SKEW_THRESHOLD_DAYS;
}

/**
 * Pure verdict over plain data. Reasons are ordered most severe first; the ordering of
 * the three conditions is itself the severity ranking — data contradicting your own
 * claims outranks overdue files, which outrank plain cadence.
 */
export function computeVerdict(inputs: VerdictInputs, now: Date = new Date()): Verdict {
  const triggered = inputs.domains.filter(domainTriggers);
  const worst = triggered.length
    ? triggered.slice().sort((a, b) => skewDays(b) - skewDays(a))[0]
    : null;

  const staleFired = inputs.stale_constitutional >= CONSTITUTIONAL_STALE_THRESHOLD;
  const cadenceFired =
    inputs.days_since_last_interview === null ||
    inputs.days_since_last_interview >= INTERVIEW_CADENCE_DAYS;

  const reasons: string[] = [];
  let headline: string;

  if (worst) {
    const days = skewDays(worst);
    reasons.push(
      worst.never_reviewed
        ? `${worst.domain} has ${days}d of unexamined data and its claim file was never reviewed`
        : `${worst.domain} has ${days}d of data unexamined since its claim file was last reviewed`,
    );
    for (const d of triggered) {
      if (d === worst) continue;
      reasons.push(
        d.never_reviewed
          ? `${d.domain} has ${skewDays(d)}d of unexamined data and its claim file was never reviewed`
          : `${d.domain} has ${skewDays(d)}d of data unexamined since its claim file was last reviewed`,
      );
    }
    headline = worst.never_reviewed
      ? `${worst.domain} never reviewed · ${days}d unexamined data`
      : `${worst.domain} ${worst.claim_reviewed_age_days}d stale · ${days}d unexamined data`;
  } else {
    headline = "";
  }

  if (staleFired) {
    reasons.push(`${inputs.stale_constitutional} constitutional files are past their review threshold`);
    if (!headline) headline = `${inputs.stale_constitutional} files overdue`;
  }

  // State-file staleness fires on its own so the ideal-state half of the
  // goal has a nudge beyond the generic cadence (Astra review 2026-08-11,
  // finding 5 — stale_state was carried in inputs but inert).
  const stateFired = inputs.stale_state >= STATE_STALE_THRESHOLD;
  if (stateFired) {
    reasons.push(`${inputs.stale_state} current/ideal-state files are past their review cadence`);
    if (!headline) headline = `${inputs.stale_state} state files overdue`;
  }

  if (cadenceFired) {
    reasons.push(
      inputs.days_since_last_interview === null
        ? "no interview on record"
        : `no interview in ${inputs.days_since_last_interview}d`,
    );
    if (!headline) {
      headline =
        inputs.days_since_last_interview === null
          ? "no interview on record"
          : `no interview in ${inputs.days_since_last_interview}d`;
    }
  }

  if (!inputs.evidence_available) {
    reasons.push("state evidence unavailable — verdict computed from freshness and cadence only");
  }

  const due = Boolean(worst) || staleFired || stateFired || cadenceFired;
  if (!headline) headline = "nothing overdue";

  return {
    schema: 1,
    computed_at: now.toISOString(),
    due,
    reasons,
    headline: truncate(headline),
    inputs: {
      stale_constitutional: inputs.stale_constitutional,
      stale_state: inputs.stale_state,
      worst_domain: worst?.domain ?? null,
      days_since_last_interview: inputs.days_since_last_interview,
    },
  };
}

// ---------- gathering ----------

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function atomicWrite(path: string, body: string): boolean {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

function wholeDaysBetween(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

function daysSinceIso(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/**
 * readStateFreshness lands from a parallel work stream. Read it off the namespace so a
 * build without it degrades to "no state freshness" rather than failing to import.
 */
function readStateFreshnessSafe(): ContextFreshness | null {
  const fn = (Freshness as unknown as { readStateFreshness?: () => ContextFreshness }).readStateFreshness;
  if (typeof fn !== "function") return null;
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Review stamps written by the principal (an interview ratification), never by automation: the generic labels, or the configured principal’s name. */
function principalReviewers(): Set<string> {
  const name = getPrincipalName().trim().toLowerCase();
  return new Set(["user", "principal", ...(name ? [name, name.split(/\s+/)[0]] : [])]);
}

/** The newest review stamp the principal put on any file in this freshness set. */
export function newestPrincipalReview(f: ContextFreshness | null): string | null {
  const reviewers = principalReviewers();
  const stamps = (f?.files ?? [])
    .filter((x) => typeof x.reviewed_by === "string" && reviewers.has(x.reviewed_by.toLowerCase()))
    .map((x) => x.reviewed ?? null);
  return latestIso(stamps);
}

/** The latest parseable ISO timestamp, or null when none parse. */
export function latestIso(values: Array<string | Date | null | undefined>): string | null {
  let best: number | null = null;
  for (const v of values) {
    const t = v instanceof Date ? v.getTime() : v ? Date.parse(v) : NaN;
    if (!Number.isNaN(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

function safeContextFreshness(): ContextFreshness | null {
  try {
    return readContextFreshness();
  } catch {
    return null;
  }
}

/** Metric value from an evidence domain, when it is a plain string. */
function metricString(evidence: Evidence | null, domain: string, key: string): string | null {
  const value = evidence?.domains?.[domain as keyof Evidence["domains"]]?.metrics?.[key];
  return typeof value === "string" ? value : null;
}

export function buildInputs(evidence: Evidence | null, now: Date = new Date()): VerdictInputs {
  const context = safeContextFreshness();
  const state = readStateFreshnessSafe();

  const domains: DomainSkew[] = [];
  for (const [domain, slugs] of Object.entries(DOMAIN_CLAIM_SLUGS)) {
    if (!slugs) continue; // work has no claim file to contradict
    const claim = claimFileFor(state?.files, domain);
    // Claim file absent from the registry (e.g. retired via the interview's
    // ratify-or-retire flow): there is no claim to contradict, so the domain
    // contributes no skew. never_reviewed means exists-but-unreviewed, never
    // "file gone" — otherwise retiring a file makes the chip permanently due
    // (Astra review 2026-08-11, finding 2).
    if (!claim && state !== null) continue;
    const reviewed = claim?.effective_reviewed ?? claim?.reviewed ?? null;
    const reviewedIso = reviewed ? new Date(reviewed).toISOString() : null;
    const neverReviewed = reviewedIso === null;

    const newest = metricString(evidence, domain, "newest_observation");
    const oldest30 = metricString(evidence, domain, "oldest_observation_30d");

    // Reviewed: skew is how far the newest observation has run past the review.
    // Never reviewed: nothing has ever been examined, so the whole 30d window counts.
    // Date strings arrive from evidence caches verbatim — guard the parse; an
    // Invalid Date would make toISOString throw INSIDE the daily cron and freeze
    // the verdict cache (Astra review 2026-08-11, finding 3).
    const newestParsed = newest ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(newest) ? `${newest}T00:00:00` : newest) : null;
    const newestIso = newestParsed && !isNaN(newestParsed.getTime()) ? newestParsed.toISOString() : null;
    const skew = neverReviewed
      ? daysSinceIso(oldest30, now)
      : wholeDaysBetween(reviewedIso, newestIso);

    const sourceId = DOMAIN_SOURCE_IDS[domain];
    const source = evidence?.domains?.[domain as keyof Evidence["domains"]]?.sources?.find(
      (s) => s.id === sourceId,
    );

    domains.push({
      domain,
      evidence_days_since_review: skew,
      never_reviewed: neverReviewed,
      claim_reviewed_age_days: claim?.effective_reviewed_age_days ?? claim?.reviewed_age_days ?? null,
      source_live: source?.status === "live",
      newest_observation: newest,
    });
  }

  const last = readJson<{ last_interview?: string }>(INTERVIEW_STATE);
  // The last interview is the later of the explicit mark and the newest principal review
  // stamp on a file the interview covers: a review that happened is the evidence, so a
  // wrap that never reached --mark-done cannot leave the chip saying "no interview".
  const lastIso = latestIso([last?.last_interview ?? null, newestPrincipalReview(context), newestPrincipalReview(state)]);

  return {
    domains,
    stale_constitutional: context?.stale_count ?? 0,
    stale_state: state?.stale_count ?? 0,
    days_since_last_interview: daysSinceIso(lastIso ?? undefined, now),
    evidence_available: evidence !== null,
  };
}

/**
 * The reasons an interview must still address before --mark-done records it. The
 * plain-cadence reason ("no interview in Nd", "no interview on record") is the one
 * the mark itself clears; every review reason, stale state files included, remains.
 */
export function remainingAfterInterview(reasons: string[]): string[] {
  return reasons.filter((r) => !/^no interview (on record|in \d+d)$/.test(r) && !/^state evidence unavailable\b/.test(r));
}

export function writeVerdictCache(verdict: Verdict, path: string = CACHE_PATH): boolean {
  return atomicWrite(path, `${JSON.stringify(verdict, null, 2)}\n`);
}

export function markInterviewDone(now: Date = new Date(), path: string = INTERVIEW_STATE): boolean {
  return atomicWrite(
    path,
    `${JSON.stringify({ last_interview: now.toISOString(), marked_by: "interview-skill" }, null, 2)}\n`,
  );
}

// ---------- CLI ----------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const now = new Date();

  let evidence: Evidence | null;
  if (args.includes("--refresh")) {
    // --refresh writes only CACHE/STATE files (Interview ISA ISC-22). The MRR
    // snapshot (#915), which writes USER/FINANCES/stripe-mrr.json, runs just
    // before this in the delta-daily workflow's evidence step, not from here.
    evidence = gatherEvidence(now);
    writeEvidenceCache(evidence);
    try {
      const { writeFreshnessCache } = await import("./FreshnessCache");
      writeFreshnessCache();
    } catch {
      // A freshness-cache rebuild failure must not take the cron verdict down with it.
    }
  } else {
    evidence = readEvidenceCache();
  }

  if (args.includes("--mark-done")) {
    // The chip means "review these files". An interview that leaves them
    // unreviewed is not done, whatever ran.
    const before = computeVerdict(buildInputs(evidence, now), now);
    const remaining = remainingAfterInterview(before.reasons);
    if (remaining.length > 0 && !args.includes("--partial")) {
      writeVerdictCache(before);
      console.error(`INTERVIEW INCOMPLETE — not marked done. Still due:\n  ${remaining.join("\n  ")}\nReview those items (the intent's agenda), or pass --partial if the principal said stop.`);
      process.exit(2);
    }
    markInterviewDone(now);
    if (remaining.length > 0) console.error(`Marked done (partial). Still due:\n  ${remaining.join("\n  ")}`);
  }

  const verdict = computeVerdict(buildInputs(evidence, now), now);
  writeVerdictCache(verdict);
  console.log(JSON.stringify(verdict, null, 2));
}
