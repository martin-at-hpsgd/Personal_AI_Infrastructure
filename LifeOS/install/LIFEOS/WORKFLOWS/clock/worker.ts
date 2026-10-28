/**
 * The `wf-clock` Worker (WORKFLOWS ISA F27, ISC-316, ISC-318): the one clock for every local workflow.
 *
 * Routes:
 *   GET  /health        unauthenticated; whether the clock ticks and its secrets are set, nothing else
 *   GET  /status        bearer; schedule count, run counts by state, last tick, when the Mac last checked in
 *   POST /sync          bearer; {zone, workflows:[{name, alert, triggers}]} replaces the scheduled set
 *   POST /lease         bearer; {worker, max} leases up to max waiting runs (max 0 is a heartbeat)
 *   POST /complete      bearer; {id, outcome, detail?} closes a lease
 * Cron: every minute, clockTick. Texts go to the principal through Twilio, because when the Mac is down Relay is too.
 */
import { bearerAuthorized } from "../cloud/auth.ts";
import { clockStatus, clockTick, completeRun, lastTick, leaseRuns, syncWorkflows, type ClockDb, type Notify, type Outcome, type SyncBody } from "./core.ts";

export interface ClockEnv {
  CLAIMS: ClockDb;
  CLOCK_TOKEN?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_TO_NUMBER?: string;
  TWILIO_FROM_NUMBER?: string;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A Twilio text to the principal; a failure is logged, returns false, and never stops the clock. */
export function twilioNotify(env: ClockEnv, fetcher: typeof fetch = fetch): Notify {
  return async text => {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_TO_NUMBER: to } = env;
    if (!sid || !token || !to) {
      console.error("clock: cannot text, Twilio secrets are not set");
      return false;
    }
    try {
      const auth = `Basic ${btoa(`${sid}:${token}`)}`;
      let from = env.TWILIO_FROM_NUMBER ?? "";
      if (!from) {
        const list = await (await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=1`, { headers: { Authorization: auth } })).json() as { incoming_phone_numbers?: Array<{ phone_number?: string }> };
        from = list.incoming_phone_numbers?.[0]?.phone_number ?? "";
      }
      if (!from) {
        console.error("clock: cannot text, the Twilio account has no number");
        return false;
      }
      const res = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: auth, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: to, From: from, Body: text.slice(0, 600) }),
      });
      if (!res.ok) console.error(`clock: text failed with HTTP ${res.status}`);
      return res.ok;
    } catch (e) {
      console.error(`clock: text failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };
}

const OUTCOMES = new Set<Outcome>(["submitted", "duplicate", "skipped", "refused"]);

export function createClock(opts: { now?: () => Date; notify?: (env: ClockEnv) => Notify } = {}) {
  const now = opts.now ?? (() => new Date());
  const notifier = opts.notify ?? ((env: ClockEnv) => twilioNotify(env));
  return {
    async fetch(request: Request, env: ClockEnv): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        const tick = await lastTick(env.CLAIMS);
        const age = tick ? now().getTime() - Date.parse(tick) : null;
        return json({ ok: age !== null && age < 3 * 60_000, ticking: age !== null && age < 3 * 60_000, token_set: !!env.CLOCK_TOKEN, texting_set: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_TO_NUMBER) });
      }
      if (!await bearerAuthorized(request.headers.get("authorization"), env.CLOCK_TOKEN)) return json({ error: "unauthorized" }, 401);
      try {
        if (request.method === "GET" && url.pathname === "/status") return json(await clockStatus(env.CLAIMS));
        if (request.method !== "POST") return json({ error: "not found" }, 404);
        const body = await request.json() as Record<string, unknown>;
        if (url.pathname === "/sync") return json(await syncWorkflows(env.CLAIMS, body as unknown as SyncBody, now()));
        if (url.pathname === "/lease") return json(await leaseRuns(env.CLAIMS, String(body.worker ?? ""), Number(body.max ?? 0), now(), notifier(env)));
        if (url.pathname === "/complete") {
          if (!OUTCOMES.has(body.outcome as Outcome)) return json({ error: "bad outcome" }, 400);
          return json({ closed: await completeRun(env.CLAIMS, String(body.id ?? ""), body.outcome as Outcome, typeof body.detail === "string" ? body.detail : undefined, now()) });
        }
        return json({ error: "not found" }, 404);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // An invariant names a bad request; anything else is the clock's own failure.
        return json({ error: message }, /Invariant/i.test(e instanceof Error ? e.name : "") ? 400 : 500);
      }
    },
    async scheduled(_controller: unknown, env: ClockEnv): Promise<void> {
      const summary = await clockTick(env.CLAIMS, now(), notifier(env));
      if (summary.queued.length || summary.failed.length || summary.requeued) console.log(JSON.stringify(summary));
    },
  };
}
