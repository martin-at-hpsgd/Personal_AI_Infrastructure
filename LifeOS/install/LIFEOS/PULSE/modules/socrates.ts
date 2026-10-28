/**
 * Socrates Pulse module — read-only surface over the standing-question ledger.
 *
 * Reads ONLY the redacted snapshot (~/.local/state/lifeos/socrates/snapshot.json)
 * exported by `socrates tick` — never the live DB (single-writer honesty) and
 * never the raw USER question files. Mutations go through the CLI
 * (bun LIFEOS/SOCRATES/Socrates.ts) so every write passes store invariants.
 *
 * Routes:
 *   GET /api/socrates        → { generated_at, stale, domains, questions, answers, findings, status }
 *   GET /api/socrates/banner → { alert, open_findings, unknown, stale }
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MODULE_NAME = "socrates";
const SNAPSHOT = join(homedir(), ".local/state/lifeos/socrates/snapshot.json");

/** Snapshot older than 2× the shortest cadence (hourly) means the tick is dead. */
const STALE_MS = 2 * 3600_000;
const CACHE_TTL_MS = 15_000;
const state: { running: boolean; cache: { payload: Payload; expiresAt: number } | null } = { running: false, cache: null };

interface Snapshot {
  generated_at: string;
  questions: Array<{ id: string; domain: string; text: string; ideal: string; status: string; severity: string; cadence: string; verifier: string; answerer: string | null; experiential: boolean; node_type: string | null; provenance: string; telos_ref: string | null; accounted_for: number | null; ruled_out: string[] }>;
  answers: Array<{ question_id: string; instance_key: string; ts: string; verdict: string; value: string | null; evidence: string | null; computed_from: string; closer_version: string }>;
  findings: Array<Record<string, unknown>>;
  status: Record<string, unknown>;
}
interface Payload extends Snapshot {
  stale: boolean;
  age_minutes: number;
  /** Why the tick is late, when the machine knows (SchedulerWatch's open episode); null otherwise. */
  stale_reason: string | null;
  domains: Array<{ domain: string; pass: number; fail: number; unknown: number; unanswerable: number }>;
}

const SCHEDULER_STATE = join(homedir(), ".claude/LIFEOS/MEMORY/STATE/scheduler-watch.json");

/** The one cause this machine can name: launchd in on-demand-only mode (SchedulerWatch episode open). */
function staleReason(): string | null {
  try {
    const s = JSON.parse(readFileSync(SCHEDULER_STATE, "utf8")) as { episode?: { startedAt: string } | null };
    if (!s.episode) return null;
    const since = new Date(s.episode.startedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `The Mac's scheduler stopped starting scheduled jobs at ${since} (launchd on-demand-only mode, usually a cancelled update restart). Pulse is kicking the jobs every 5 minutes; a restart clears it.`;
  } catch { return null; }
}

function compose(): Payload {
  if (!existsSync(SNAPSHOT)) {
    return { generated_at: "", stale: true, age_minutes: -1, stale_reason: staleReason(), domains: [], questions: [], answers: [], findings: [], status: {} };
  }
  const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
  const ageMs = Date.now() - Date.parse(snap.generated_at);

  // Per-question rollup: fail if any instance fails; else unknown if any
  // instance is unknown (unknown NEVER aggregates into pass); else pass.
  const byQ = new Map<string, { fail: boolean; unknown: boolean; any: boolean }>();
  for (const a of snap.answers) {
    const s = byQ.get(a.question_id) ?? { fail: false, unknown: false, any: false };
    s.any = true;
    if (a.verdict === "fail") s.fail = true;
    if (a.verdict === "unknown") s.unknown = true;
    byQ.set(a.question_id, s);
  }
  const domains = new Map<string, { domain: string; pass: number; fail: number; unknown: number; unanswerable: number }>();
  for (const q of snap.questions) {
    const d = domains.get(q.domain) ?? { domain: q.domain, pass: 0, fail: 0, unknown: 0, unanswerable: 0 };
    if (q.status === "unanswerable") d.unanswerable++;
    else if (q.status === "active") {
      const s = byQ.get(q.id);
      if (!s || !s.any || (!s.fail && s.unknown)) d.unknown++;
      else if (s.fail) d.fail++;
      else d.pass++;
    }
    domains.set(q.domain, d);
  }
  return {
    ...snap,
    stale: ageMs > STALE_MS,
    age_minutes: Math.round(ageMs / 60_000),
    stale_reason: ageMs > STALE_MS ? staleReason() : null,
    domains: [...domains.values()].sort((a, b) => a.domain.localeCompare(b.domain)),
  };
}

export function start(): void {
  state.running = true;
  console.log(`[${MODULE_NAME}] Started — serving /api/socrates`);
}

export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/socrates")) return null;
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const now = Date.now();
  if (!state.cache || state.cache.expiresAt <= now) {
    try {
      state.cache = { payload: compose(), expiresAt: now + CACHE_TTL_MS };
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }
  const p = state.cache.payload;
  if (pathname === "/api/socrates/banner") {
    const unknown = p.domains.reduce((n, d) => n + d.unknown, 0);
    return Response.json({ alert: p.findings.length > 0 || p.stale, open_findings: p.findings.length, unknown, stale: p.stale });
  }
  return Response.json(p);
}

export function health(): { running: boolean } {
  return { running: state.running };
}
