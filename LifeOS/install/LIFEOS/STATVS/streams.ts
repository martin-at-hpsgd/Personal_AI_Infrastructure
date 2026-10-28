/**
 * STATVS stream registry. An append to a stream not named here is refused (ISC-63),
 * and every stream names its owner, privacy class and retention (ISC-80).
 *
 * Tests register streams two ways:
 *  - in-process: `registerStreamForTest(name, def?)`;
 *  - in spawned processes: `STATVS_EXTRA_STREAMS="name:class,other:class"`. The env
 *    form is honoured ONLY when STATVS_DIR is set, so it can never open a stream on
 *    the live record.
 *
 * A stream that declares `forward: true` sends its severity rows to the cloud tier (ISC-191);
 * the flag is set only here, in a reviewed commit. A stream that declares `ship: false` never
 * leaves the machine: the core shipper skips its rows (CENSVS ISA F3, F10).
 *
 * @version 1.5.0
 */
import type { PrivacyClass, StreamDef } from "./lib/types";

export const STREAMS: Record<string, StreamDef> = {
  work: { owner: "hooks/lib/work-events.ts", class: "personal", retention: "forever" },
  statvs: { owner: "LIFEOS/STATVS", class: "system", retention: "forever" },
  turn: { owner: "hooks/TurnRecord.hook.ts", class: "system", retention: "forever" },
  messages: { owner: "LIFEOS/TOOLS/Messages/MessagesSync.ts", class: "system", retention: "forever" },
  // Every non-allow gate verdict and every gate failure (STATVS ISA F14). Personal: a reason can name the principal's work.
  move: { owner: "hooks/lib/gate-run.ts", class: "personal", retention: "forever" },
  // The Vigil collection split (migration design §2.5). Kept forever like every stream, because the record
  // is permanent, so prune refuses them. Only `event` forwards its severity rows.
  event: { owner: "LIFEOS/STATVS/lib/event.ts", class: "personal", retention: "forever", forward: true },
  cloud: { owner: "LIFEOS/STATVS/lib/cloud.ts", class: "personal", retention: "forever" },
  collect: { owner: "LIFEOS/STATVS/lib/collect.ts", class: "system", retention: "forever" },
  vigil: { owner: "LIFEOS/VIGIL", class: "personal", retention: "forever" },
  // Relay ISA F21: every text in and out with its words, every bridge event and guard decision, one outcome per text.
  // Personal: it carries the principal's own words; own-channel values are replaced by a role label before append.
  relay: { owner: "LIFEOS/RELAY", class: "personal", retention: "forever" },
  "vigil-log": { owner: "LIFEOS/VIGIL", class: "personal", retention: "forever" },
  // Explain skill: each fundamentals set explained and each quiz answer with its verdict, so the next quiz targets the
  // misses (principal directive, 2026-10-16). Personal: it records what the principal does and does not yet understand.
  learning: { owner: "skills/Explain", class: "personal", retention: "forever" },
  // Every pre-deploy code review, one row per record, so a later miss joins the review that passed it and that review
  // can be replayed (review-miss-evals ISA F1). Personal: findings can quote code that names people or amounts.
  review: { owner: "LIFEOS/TOOLS/Review.ts", class: "personal", retention: "forever" },
  // Each replay of a past review on a reviewer miss: both arms, k samples, catch rates and models (review-miss-evals ISA F5).
  "review-replay": { owner: "LIFEOS/TOOLS/ReviewSuite.ts", class: "personal", retention: "forever" },
  // What happens to each app (STATVS ISA F8, ISC-109): every state change, piece of work, problem, failure,
  // push and upgrade is reported. Rows name the app by its worker. The Mac writes deploy, release and
  // app-health at the one tool each fact passes through; the apps write app-event and app-error themselves, holding
  // only ids, counts and redacted error text, never a user's email, name or content. `push` joins once its writer exists.
  deploy: { owner: "LIFEOS/TOOLS/CfEnv.ts", class: "system", retention: "forever" },
  release: { owner: "LIFEOS/TOOLS/ReleaseRecord.ts", class: "system", retention: "forever" },
  "app-health": { owner: "LIFEOS/TOOLS/StatvsAppRows.ts", class: "system", retention: "forever" },
  "app-event": { owner: "LIFEOS/TOOLS/StatvsAppRows.ts", class: "personal", retention: "forever" },
  "app-error": { owner: "LIFEOS/TOOLS/StatvsAppRows.ts", class: "personal", retention: "forever" },
  // CENSVS (ISA F3): the RES writer's create, set, move, link, unlink and retire rows, each naming its RES in `subject`.
  // Personal: a RES title or field can name the principal's work.
  res: { owner: "LIFEOS/CENSVS/res.ts", class: "personal", retention: "forever" },
  // Atlas's observe rows for appeared, changed and expired estate assets, plus one row per sync run (CENSVS ISA F10).
  // Held on the machine until sealing exists: estate rows (credential, ingest, capability, control) never ship unsealed.
  observe: { owner: "LIFEOS/ATLAS", class: "system", retention: "forever", ship: false },
  // The quality loop's records (STATVS ISA F16), written through LIFEOS/STATVS/lib/quality.ts at the one choke point
  // each record already passes through. Step 1, dual-write: every old store keeps writing. Personal: ids, hashes, counts
  // and classes about the principal's work; no finding text and no complaint words.
  output: { owner: "LIFEOS/TOOLS/lib/OutputLedger.ts", class: "personal", retention: "forever" },
  receipt: { owner: "LIFEOS/TOOLS/lib/ProofReceipt.ts", class: "personal", retention: "forever" },
  label: { owner: "LIFEOS/TOOLS/lib/LabelStore.ts", class: "personal", retention: "forever" },
  errata: { owner: "LIFEOS/ERRATA/Capture.ts", class: "personal", retention: "forever" },
  "skill-run": { owner: "hooks/EventLogger.hook.ts", class: "personal", retention: "forever" },
  "tool-run": { owner: "hooks/EventLogger.hook.ts", class: "personal", retention: "forever" },
  // Which pipeline rendered which bytes; renderFor() reads it back by sha256.
  render: { owner: "LIFEOS/STATVS/lib/quality.ts", class: "personal", retention: "forever" },
  // Every commit CommitOwn makes, with the session that made it and the sha as ref (STATVS ISA F17). Turn rows cannot
  // say who committed: sessions share a tree, so a commit appears in every session's next turn. Personal: subjects and
  // paths can name the principal's work.
  commit: { owner: "LIFEOS/TOOLS/CommitOwn.ts", class: "personal", retention: "forever" },
  // Every email the DA's own mailbox sends through gmail.ts: each recipient by People id (never an address), the
  // subject, and the Gmail message and thread ids (conversation-memory ISA ISC-1, ISC-11). Personal: subjects are the
  // principal's correspondence.
  mail: { owner: "LIFEOS/TOOLS/gmail.ts", class: "personal", retention: "forever" },
};

const TEST_STREAMS: Record<string, StreamDef> = {};
const VALID: readonly string[] = ["public", "system", "personal", "customer"];

/** Register a stream for the current process only. Test use; never call from production code. */
export function registerStreamForTest(name: string, def: Partial<StreamDef> = {}): void {
  TEST_STREAMS[name] = { owner: def.owner ?? "test", class: def.class ?? "system", retention: def.retention ?? "test" };
  if (def.ship !== undefined) TEST_STREAMS[name]!.ship = def.ship;
}

function envStreams(): Record<string, StreamDef> {
  const raw = process.env.STATVS_EXTRA_STREAMS;
  if (!raw || !process.env.STATVS_DIR) return {};
  const out: Record<string, StreamDef> = {};
  for (const part of raw.split(",")) {
    const [name, cls] = part.trim().split(":");
    if (!name) continue;
    const klass = (VALID.includes(cls ?? "") ? cls : "system") as PrivacyClass;
    out[name] = { owner: "env:STATVS_EXTRA_STREAMS", class: klass, retention: "test" };
  }
  return out;
}

/** The registered definition of a stream, or null. */
export function streamDef(name: string): StreamDef | null {
  // Own keys only: an inherited name (constructor, toString, __proto__) is never a stream.
  if (typeof name !== "string") return null;
  if (Object.hasOwn(STREAMS, name)) return STREAMS[name]!;
  if (Object.hasOwn(TEST_STREAMS, name)) return TEST_STREAMS[name]!;
  const env = envStreams();
  return Object.hasOwn(env, name) ? env[name]! : null;
}

/** Every stream visible to this process: the seed registry plus any test registrations. */
export function allStreams(): Record<string, StreamDef> {
  return { ...envStreams(), ...TEST_STREAMS, ...STREAMS };
}
