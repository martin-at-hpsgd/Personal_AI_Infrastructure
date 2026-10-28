#!/usr/bin/env bun
/**
 * @version 0.1.0
 *
 * People — tick.ts. The unattended run: every source in order, each one isolated,
 * one `runs.jsonl` row per tick.
 * ISA: LIFEOS/PEOPLE/ISA.md (maintainer-side state of record, not in the release) (ISC-2, ISC-26, ISC-27, ISC-38, ISC-39).
 *
 * Four properties this file exists to hold:
 *
 *   1. NO PATH UP. Nothing here imports `boundary.ts`, and nothing here imports a
 *      upstream business client. The scheduled job physically cannot send a record off the
 *      machine, which is what makes the security boundary structural rather than
 *      a rule someone has to remember (ISC-2). `tests/boundary.test.ts` (source tree only) walks this
 *      module's transitive import graph and fails if `boundary.ts` appears in it.
 *
 *   2. ONE SOURCE CANNOT TAKE DOWN THE RUN. Each source runs inside its own
 *      try/catch. A throw is recorded as `failed` with the message, and the
 *      remaining sources still run (ISC-27, ISC-38). A source that has no key
 *      configured reports `skipped`, which is a different fact from `failed` and
 *      is stored as one.
 *
 *   3. NO SOURCE RUNS FOREVER. Every source is a paginated sweep of a remote
 *      backend with a per-request timeout but no bound on its loop, so one of
 *      them can run for hours — on an hourly job that is indistinguishable from
 *      a hang. A source that blows its wall-clock budget is recorded as `failed`
 *      like any other and the run moves on.
 *
 *   4. NO VOICE. Scheduled work never speaks (OPERATIONAL_PREFERENCES § Background work:
 *      no terminal, no voice). The plist sets LIFEOS_NOTIFICATION_CHANNEL=headless
 *      and this module imports no notification client at all, so there is nothing
 *      here that could fire one.
 *
 * Order is apple → gmail → calendar → stripe → beehiiv → merge. The customer
 * sources FETCH in their own slot but their result is applied by the merge source
 * at the end: a rebuild is what normalizes the store's shape, and attaching
 * customer state to the rebuilt records means the tick writes contacts.jsonl once
 * per run instead of three times.
 */

import { attachCustomerState, fetchNewsletter, fetchStripe, type CustomerLookup } from "./customer";
import { calendarToolPresent, ingestCalendar, ingestGmail, syncGmail } from "./ledger";
import { runMerge } from "./merge";
import { appendRun, readContacts, withStoreLock, writeContacts } from "./store";
import { cacheAppleAudit } from "./sync";
import type { SourceName, SourceStatus, TickRun } from "./types";

/** What a source may report back. Returning nothing means `ok` with no note. */
export type SourceResult = { status?: SourceStatus; note?: string } | void;

/**
 * Handed to every source. `expired()` is true once the source has blown its
 * budget and the run has moved on. A source whose work outlives its slot must
 * check this before publishing anything a later source will read — otherwise a
 * straggler could land its result after being recorded as `failed`, and the run
 * row would disagree with what the run actually did.
 */
export type SourceContext = { expired: () => boolean };
export type TickJob = { name: SourceName; run: (ctx: SourceContext) => Promise<SourceResult> };

/**
 * Wall-clock budget per source. Every source here is a paginated sweep of a
 * remote backend with a per-REQUEST timeout but no bound on the loop: a
 * subscriber list long enough, or a backend slow enough, and one source can run
 * for hours. On an hourly job that is indistinguishable from a hang — the store
 * simply stops being rebuilt — so a source that overruns is recorded as `failed`
 * and the run moves on. Ten minutes is comfortably more than any healthy source
 * has ever needed and comfortably less than the interval.
 */
export const SOURCE_BUDGET_MS = 10 * 60_000;

class SourceTimedOut extends Error {
  constructor(name: SourceName, ms: number) {
    super(`${name} exceeded its ${Math.round(ms / 1000)}s budget`);
    this.name = "SourceTimedOut";
  }
}

/**
 * Races a source against its budget. The losing work is NOT cancelled — a fetch
 * loop has no cancel — so the CLI exits the process explicitly once the run is
 * recorded rather than waiting for a straggler to settle.
 */
async function withBudget(job: TickJob, ms: number): Promise<SourceResult> {
  let over = false;
  const ctx: SourceContext = { expired: () => over };
  if (ms <= 0) return job.run(ctx);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      job.run(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          over = true;
          reject(new SourceTimedOut(job.name, ms));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const SOURCE_ORDER: readonly SourceName[] = ["apple", "gmail", "calendar", "stripe", "beehiiv", "merge"];

/**
 * The real source table. Built per call rather than as a module constant so the
 * customer lookups it closes over belong to one run and never leak into the next.
 */
export function defaultJobs(): TickJob[] {
  const customer: { stripe?: CustomerLookup; newsletter?: CustomerLookup } = {};

  return [
    {
      name: "apple",
      run: async (ctx) => {
        const { cards } = await cacheAppleAudit(undefined, ctx.expired);
        return { note: `${cards} cards cached` };
      },
    },
    {
      name: "gmail",
      run: async (ctx) => {
        const swept = await syncGmail(undefined, ctx.expired);
        if (ctx.expired()) return;
        // Ingest against the records as they stand. A correspondent who becomes a
        // record only in this run's merge gets their events on the next tick;
        // an hour's lag beats reordering the sources around one edge case.
        const { added, total } = ingestGmail(readContacts());
        return { note: `${swept.fetched} fetched, ${added} new events, ${total} total` };
      },
    },
    {
      name: "calendar",
      run: async () => {
        // The calendar tool is a private skill; a public install without it skips this source instead of failing every hour.
        if (!calendarToolPresent()) return { status: "skipped" as const, note: "calendar tool not installed" };
        const { added, total } = await ingestCalendar(readContacts());
        return { note: `${added} new events, ${total} total` };
      },
    },
    {
      name: "stripe",
      run: async (ctx) => {
        const lookup = await fetchStripe();
        // Publish only while this source still owns its slot: a sweep that
        // outran its budget was already recorded as failed, and the merge must
        // not quietly use its result anyway.
        if (ctx.expired()) return;
        customer.stripe = lookup;
        return { status: lookup.status, note: lookup.note ?? `${lookup.byEmail.size} customers` };
      },
    },
    {
      name: "beehiiv",
      run: async (ctx) => {
        const lookup = await fetchNewsletter();
        if (ctx.expired()) return;
        customer.newsletter = lookup;
        return { status: lookup.status, note: lookup.note ?? `${lookup.byEmail.size} subscribers` };
      },
    },
    {
      name: "merge",
      run: async () => {
        // One store lock across the rebuild and the customer attach, so a
        // human's `people add` cannot land between them and be overwritten.
        const { records, attach } = withStoreLock(() => {
          const merged = runMerge();
          const attached = attachCustomerState(readContacts(), customer);
          writeContacts(attached.records);
          return { records: merged.records, attach: attached };
        });
        return { note: `${records} records, stripe ${attach.matched.stripe}, newsletter ${attach.matched.newsletter}` };
      },
    },
  ];
}

/**
 * Runs every job in order and appends one row to runs.jsonl. Never throws for a
 * source failure — a tick that died on its first bad source would leave no record
 * of the sources that were fine, which is exactly the silent-skip failure the ISA
 * forbids.
 */
export async function runTick(opts: { jobs?: TickJob[]; now?: string; budgetMs?: number } = {}): Promise<TickRun> {
  const jobs = opts.jobs ?? defaultJobs();
  const at = opts.now ?? new Date().toISOString();
  const budgetMs = opts.budgetMs ?? SOURCE_BUDGET_MS;
  const sources = {} as TickRun["sources"];

  for (const job of jobs) {
    const t0 = Date.now();
    let status: SourceStatus = "ok";
    let note: string | undefined;
    try {
      const result = await withBudget(job, budgetMs);
      if (result?.status) status = result.status;
      if (result?.note) note = result.note.slice(0, 200);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      status = needsHumanGrant(msg) ? "blocked" : "failed";
      note = msg.slice(0, 200);
    }
    sources[job.name] = { status, ms: Date.now() - t0, ...(note ? { note } : {}) };
  }

  const run: TickRun = { at, sources };
  appendRun(run); // asserts the run's shape before it touches disk (ISC-5)
  return run;
}

/**
 * A source that cannot run until a human grants something. Matched on the message
 * because the denial crosses a process boundary (ContactsCli, gcal) as text, so
 * there is no typed error to catch.
 */
export function needsHumanGrant(message: string): boolean {
  return /\b(DENIED|not granted|not authorized|permission denied|TCC|invalid_grant|re-?authorize|reauth)\b/i.test(message);
}

/** One line per source, for the CLI and the launchd log. */
export function renderRun(run: TickRun): string {
  const rows = Object.entries(run.sources).map(
    ([name, s]) => `  ${name.padEnd(9)} ${s.status.padEnd(8)} ${String(s.ms).padStart(6)}ms${s.note ? `  ${s.note}` : ""}`,
  );
  const vals = Object.values(run.sources);
  const failed = vals.filter((s) => s.status === "failed").length;
  const blocked = vals.filter((s) => s.status === "blocked").length;
  const tail: string[] = [];
  if (failed) tail.push(`${failed} source(s) FAILED`);
  if (blocked) tail.push(`${blocked} source(s) BLOCKED — waiting on a human grant, not a code fix`);
  if (!tail.length) tail.push("all sources ok");
  return [`tick ${run.at}`, ...rows, ...tail].join("\n");
}
