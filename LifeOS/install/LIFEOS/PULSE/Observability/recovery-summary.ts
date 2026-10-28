/**
 * recovery-summary.ts — the "Owed to you" feed for Pulse /finances.
 *
 * Runs `Recover.ts summary --json` and hands its parsed result to the finances handler. The summary carries
 * amounts and capped titles (a holder name, a sender's domain) for the principal's own screen, so this module
 * never logs, caches or stores it: it goes from the child's stdout into one HTTP response and nowhere else.
 * Failures log a fixed message with the exit status only, never the child's output.
 *
 * Returns:
 *   undefined  Recover.ts is not installed (a public install): the page omits the card.
 *   null       the tool failed or returned something that is not a version-1 summary: the card says unavailable.
 *   object     the validated summary.
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"

export interface RecoverySummaryEnvelope {
  version: 1
  generated_at: string
  last_run: { at: string; scope: string; outcome: string } | null
  last_full_run: { at: string; outcome: string } | null
  totals: Record<string, unknown>
  nearest_deadline: { date: string; days_left: number; kind: string; status: string } | null
  deadlines_within_window: number
  states: Array<{ state: string; status: string; at: string | null }>
  states_complete: boolean
  top: unknown[]
  more: number
}

/** True only for the version-1 shape the card renders. Anything else is treated as a tool failure. */
export function isRecoverySummary(v: unknown): v is RecoverySummaryEnvelope {
  if (!v || typeof v !== "object") return false
  const s = v as Record<string, unknown>
  return (
    s.version === 1 &&
    !!s.totals && typeof s.totals === "object" &&
    Array.isArray(s.top) &&
    Array.isArray(s.states) &&
    typeof s.more === "number" &&
    typeof s.deadlines_within_window === "number"
  )
}

export async function loadRecoverySummary(
  cliPath: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RecoverySummaryEnvelope | null | undefined> {
  if (!existsSync(cliPath)) return undefined
  const run = await new Promise<{ ok: true; stdout: string } | { ok: false; status: string }>((resolve) =>
    execFile(
      "bun",
      [cliPath, "summary", "--json"],
      { encoding: "utf8", timeout: opts.timeoutMs ?? 15_000, maxBuffer: 4 * 1024 * 1024, env: opts.env ?? process.env },
      (err, out) => resolve(err ? { ok: false, status: exitStatus(err) } : { ok: true, stdout: out }),
    ))
  if (!run.ok) {
    console.error(`[finances] Recover.ts summary failed (${run.status})`)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(run.stdout)
  } catch {
    // JSON.parse quotes the offending text in its message, so the message itself is never logged.
    console.error("[finances] Recover.ts summary failed (output is not JSON)")
    return null
  }
  return isRecoverySummary(parsed) ? parsed : null
}

/** The child's exit status as a fixed token: a numeric exit code, a signal name, or a Node error code; never its output. */
function exitStatus(err: Error): string {
  const e = err as Error & { code?: unknown; signal?: unknown }
  if (typeof e.code === "number") return `exit ${e.code}`
  if (typeof e.signal === "string" && /^SIG[A-Z0-9]+$/.test(e.signal)) return `signal ${e.signal}`
  if (typeof e.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(e.code)) return e.code
  return "exit unknown"
}
