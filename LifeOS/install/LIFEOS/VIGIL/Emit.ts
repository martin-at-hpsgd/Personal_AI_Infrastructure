/**
 * Vigil emitter shim and best-effort forwarder (STATVS migration design §3 Lane A, deleted in p3).
 * `emit` keeps its contract (validate, throw on refusal, return the event) and writes through STATVS `writeEvent`,
 * which appends to the legacy outbox and, under dual-write, the record. Vigil's own `source: "vigil"` rows go to
 * the legacy outbox only, through `appendNotification`, because writeEvent refuses that source (P1).
 * `envKeys` lives in TOOLS/lib/EnvKeys.ts. The env file is the install's own (getEnvPath, honours CLAUDE_CONFIG_DIR).
 * @version 0.4.1
 */
import { existsSync, readFileSync } from "node:fs";
import { invariant } from "../TOOLS/Invariant";
import { envFileValues } from "../TOOLS/lib/EnvKeys";
import { validateEvent, type VigilEvent } from "./Schema";
import { appendJson, readJson, statePath, writeJson } from "./State";
export { envKeys } from "../TOOLS/lib/EnvKeys";

type StatvsEvent = typeof import("../STATVS/lib/event");
type LegacyOutbox = typeof import("../STATVS/lib/legacyOutbox");
/**
 * STATVS, loaded once. p1 only: an engine copy without LIFEOS/STATVS beside it (missing-adapter.test.ts links TOOLS,
 * WORKFLOWS and hooks, not STATVS) falls back to the direct outbox append HEAD made, after the same validation. Any
 * other load failure throws. Removed once that test links STATVS (Lane D) and with this shim in p3.
 */
function loadStatvs(): { event: StatvsEvent; outbox: LegacyOutbox } | null {
  try { return { event: require("../STATVS/lib/event") as StatvsEvent, outbox: require("../STATVS/lib/legacyOutbox") as LegacyOutbox }; }
  catch (error) { if (/Cannot find module/.test(String(error instanceof Error ? error.message : error))) return null; throw error; }
}
const statvs = loadStatvs();

export function emit(event: VigilEvent): VigilEvent {
  validateEvent(event); invariant(event.dedup_key.length > 0, "event has dedup key");
  if (!statvs) { appendJson(statePath("outbox.jsonl"), event); return event; }
  // Vigil's own rows, and customer-class events (refused at writeEvent, 0 live; community.test.ts fixtures use them), keep the legacy outbox path in p1.
  if (event.source === "vigil") { statvs.outbox.appendNotification(event); return event; }
  if (event.privacy_class === "customer") { statvs.outbox.append(event); return event; }
  const r = statvs.event.writeEvent(event);
  if (!r.ok) throw new Error(r.refused);
  invariant(r.event_id === event.id, "the written event keeps the caller's id");
  return event;
}
export type ForwardResult = { skipped?: true; sent: number; refused: number; remaining: number };
const envFile = envFileValues;
/**
 * The store's URL and bearer, or null. Tests never reach the live store: under `bun test` (NODE_ENV=test) VIGIL_URL and
 * VIGIL_TOKEN are ignored, because Bun loads the install's .env into every process whose cwd is under ~/.claude, test
 * children included, so a defined VIGIL_URL there is no proof a test chose it. Only VIGIL_CLOUD_TEST_URL and
 * VIGIL_CLOUD_TEST_TOKEN count, names that never live in .env (the rule lib/cloud.ts statvsCredentials keeps for STATVS).
 * Outside tests an isolated state dir (replays) never reaches the live store unless the caller names VIGIL_URL itself:
 * fixtures once landed there dated 2027.
 */
export function vigilCredentials(env: NodeJS.ProcessEnv = process.env): { url: string; token: string } | null {
  if (env.NODE_ENV === "test") { const url = env.VIGIL_CLOUD_TEST_URL, token = env.VIGIL_CLOUD_TEST_TOKEN; return url && token ? { url, token } : null; }
  if (env.VIGIL_STATE_DIR && env.VIGIL_URL === undefined) return null;
  const fileEnv = envFile(), url = env.VIGIL_URL ?? fileEnv.VIGIL_URL, token = env.VIGIL_TOKEN ?? fileEnv.VIGIL_TOKEN;
  return url && token ? { url, token } : null;
}
export async function forward(opts: { url?: string; token?: string; batch?: number; fetchImpl?: typeof fetch } = {}): Promise<ForwardResult> {
  const credentials = vigilCredentials(), url = opts.url ?? credentials?.url, token = opts.token ?? credentials?.token;
  const rows: VigilEvent[] = existsSync(statePath("outbox.jsonl")) ? readFileSync(statePath("outbox.jsonl"), "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x)) : [];
  const saved = readJson<Array<string | { id: string; dedup_key: string }>>(statePath("sent.json"), []); const sentIds = new Set(saved.map((x) => typeof x === "string" ? x : x.id)), sentKeys = new Set(saved.flatMap((x) => typeof x === "string" ? [] : [x.dedup_key])); const pending = rows.filter((e) => !sentIds.has(e.id) && !sentKeys.has(e.dedup_key));
  if (!url) return { skipped: true, sent: 0, refused: 0, remaining: pending.length };
  if (!token) return { sent: 0, refused: 0, remaining: pending.length };
  let count = 0, refused = 0; const size = Math.min(100, Math.max(1, opts.batch ?? 100));
  const post = (batch: VigilEvent[]) => (opts.fetchImpl ?? fetch)(`${url.replace(/\/$/, "")}/events`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(batch) });
  const mark = (batch: VigilEvent[]) => {
    invariant(batch.every((e) => e.id && e.dedup_key), "sent batch identities exist");
    batch.forEach((e) => { sentIds.add(e.id); sentKeys.add(e.dedup_key); });
    const records = rows.filter((e) => sentIds.has(e.id) || sentKeys.has(e.dedup_key)).map((e) => ({ id: e.id, dedup_key: e.dedup_key }));
    invariant(records.every((e) => e.id && e.dedup_key), "sent records have identities");
    writeJson(statePath("sent.json"), records);
  };
  for (let i = 0; i < pending.length; i += size) {
    const batch = pending.slice(i, i + size);
    try {
      const res = await post(batch);
      if (res.ok) { mark(batch); count += batch.length; continue; }
      if (res.status !== 400 && res.status !== 403) break;
      for (const event of batch) {
        const single = await post([event]);
        if (single.ok) { mark([event]); count++; continue; }
        if (single.status !== 400 && single.status !== 403) return { sent: count, refused, remaining: pending.length - count - refused };
        const record = { id: event.id, dedup_key: event.dedup_key, source: event.source, status: single.status, error: (await single.text()).slice(0, 200), ts: new Date().toISOString() };
        invariant(record.id && record.dedup_key && record.source && [400, 403].includes(record.status) && record.error.length <= 200 && Number.isFinite(Date.parse(record.ts)), "refused event record is valid");
        appendJson(statePath("refused.jsonl"), record); mark([event]); refused++;
      }
    } catch { break; }
  }
  return { sent: count, refused, remaining: pending.length - count - refused };
}
