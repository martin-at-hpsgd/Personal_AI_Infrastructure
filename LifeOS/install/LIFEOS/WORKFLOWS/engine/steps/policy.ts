/**
 * Step policy the v2 runner applies around each executor: exponential retry
 * backoff (ISC-54), the run deadline (ISC-55), and the artifact-ref existence
 * check on a step's output before any downstream step can start (ISC-59).
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { invariant } from "../../../TOOLS/Invariant.ts";
import type { StepV2 } from "../format.ts";

/* ── Backoff (ISC-54) ───────────────────────────────────────────────────── */

/**
 * Milliseconds to wait before attempt `attempt` (2 is the first retry).
 * Exponential: base x 2^(n-1) where n is the retry number, capped at
 * `retry_delay_max_ms` when one is declared. Fixed: `base` every time.
 */
export function retryDelayMs(attempt: number, base: number, backoff: "fixed" | "exponential" | undefined, maxMs?: number): number {
  invariant(Number.isInteger(attempt) && attempt >= 2, "A retry delay is asked for attempt 2 or later");
  if (base <= 0) return 0;
  if (backoff !== "exponential") return base;
  const retry = attempt - 1;
  const raw = base * 2 ** (retry - 1);
  return maxMs !== undefined ? Math.min(raw, maxMs) : raw;
}

export class StepTimedOut extends Error {
  constructor(readonly ms: number, readonly stepId: string) {
    super(`Step "${stepId}" timed out after ${ms}ms; cancellation requested, completion unknown.`);
    this.name = "StepTimedOut";
  }
}

export class DeadlineReached extends Error {
  constructor(readonly deadlineMs: number) {
    super(`The run reached its deadline of ${deadlineMs}ms.`);
    this.name = "DeadlineReached";
  }
}

export interface AttemptOutcome {
  value: unknown;
  attempts: number;
}

export interface AttemptTrace {
  attempts: number;
  timedOut: boolean;
  delays: number[];
}

/**
 * Runs one step's attempts with its own retry loop, used for steps that
 * declare `retry_backoff: exponential` (the compiled v1 graph then carries no
 * retries or timeout for them, so the policy lives in exactly one place).
 * A timed-out attempt is never retried: its side effect is uncertain, which
 * is the v1 engine's rule too.
 */
export async function runWithBackoff(
  step: Pick<StepV2, "id" | "retries" | "retry_delay_ms" | "retry_backoff" | "retry_delay_max_ms" | "timeout_ms">,
  defaults: { retries?: number; retry_delay_ms?: number; timeout_ms?: number } | undefined,
  execute: (signal: AbortSignal, attempt: number) => Promise<unknown>,
  opts: { signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; trace: AttemptTrace },
): Promise<unknown> {
  const retries = step.retries ?? defaults?.retries ?? 0;
  const base = step.retry_delay_ms ?? defaults?.retry_delay_ms ?? 0;
  const timeoutMs = step.timeout_ms ?? defaults?.timeout_ms;
  const sleep = opts.sleep ?? abortableSleep;
  let last: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    opts.signal?.throwIfAborted();
    if (attempt > 1) {
      const wait = retryDelayMs(attempt, base, step.retry_backoff, step.retry_delay_max_ms);
      opts.trace.delays.push(wait);
      await sleep(wait, opts.signal);
    }
    opts.trace.attempts = attempt;
    const controller = new AbortController();
    const signals = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = timeoutMs === undefined ? null : new Promise<"timeout">(res => {
      timer = setTimeout(() => {
        controller.abort();
        res("timeout");
      }, timeoutMs);
    });
    try {
      const run = execute(signals, attempt).then(value => ({ value }), error => ({ error }));
      const raced = timeout ? await Promise.race([run, timeout]) : await run;
      if (raced === "timeout") {
        opts.trace.timedOut = true;
        throw new StepTimedOut(timeoutMs as number, step.id);
      }
      if ("value" in raced) return raced.value;
      last = raced.error;
      if (last instanceof DeadlineReached || opts.signal?.aborted) throw last;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  throw last;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      res();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      rej(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/* ── Artifact refs (ISC-59) ─────────────────────────────────────────────── */

/** Every string found at a dotted artifact-ref path (`*` walks an array). */
export function valuesAtPath(value: unknown, path: string): unknown[] {
  let current: unknown[] = [value];
  for (const part of path.split(".").filter(Boolean)) {
    const next: unknown[] = [];
    for (const item of current) {
      if (part === "*") {
        if (Array.isArray(item)) next.push(...item);
      } else if (item !== null && typeof item === "object" && !Array.isArray(item) && Object.hasOwn(item, part)) {
        next.push((item as Record<string, unknown>)[part]);
      }
    }
    current = next;
  }
  return current;
}

/**
 * Confirms every artifact-ref value in a step output names an existing file
 * under one of the allowed roots. Symlinks are dereferenced before the
 * boundary check, so a link cannot smuggle a path outside the roots. Returns
 * the failure sentence, or null when every reference resolves.
 */
export function danglingArtifactRef(output: unknown, fields: readonly string[], roots: readonly string[], base: string): string | null {
  for (const field of fields) {
    for (const ref of valuesAtPath(output, field)) {
      if (typeof ref !== "string" || ref.length === 0) return `artifact-ref ${field} is not a path`;
      const path = isAbsolute(ref) ? ref : resolve(base, ref);
      if (!existsSync(path)) return `artifact-ref ${field} points at ${ref}, which does not exist`;
      const real = realpathSync(path);
      const inside = roots.some(root => {
        if (!existsSync(root)) return false;
        const rel = relative(realpathSync(root), real);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      });
      if (!inside) return `artifact-ref ${field} points at ${ref}, outside every allowed artifact root`;
    }
  }
  return null;
}
