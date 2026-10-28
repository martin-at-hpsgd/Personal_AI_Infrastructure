/** Socrates verdict-transition adapter: keys each answer by its own question_id and instance_key, never its position in the snapshot's answers list. @version 0.4.0 */
import { homedir } from "node:os"; import { join } from "node:path";
import { SEVERITIES, type VigilEvent } from "../../STATVS/lib/refuse"; import { clip, clock, event, jsonFile, need, withCursor } from "./common";
type Answer = { id: number; question_id: string; instance_key?: string; ts?: string; verdict: string; value?: string | null; evidence?: string | null };
type Question = { id: string; text?: string; severity?: string; ideal?: string; domain?: string };
export type Verdict = { verdict: string; answer: number; qid?: string; instance?: string; at?: string; value?: string; evidence?: string };
export type Snapshot = { verdicts: Record<string, Verdict>; questions: Record<string, { text: string; severity: string; ideal?: string; domain?: string }> };
/** Health and money answers carry measurements; the event says the verdict and where to look, never the value. */
const PRIVATE_DOMAINS = new Set(["health", "money", "finance", "finances"]);
/** Security failures are worked by Achilles: the fail text says so up front, and the all-clear of a texted fail is texted too, so the principal knows it is being worked on. The decision texts are Achilles' own escalations. */
const HANDLED = "Achilles is working it; you'll get a text when it clears or needs your call.";
const TEXTED = new Set(["critical", "high"]);
/** A cursor written before 0.3.0 is keyed by list position ("0", "1", ...): comparing against it would pair unrelated questions, so it counts as no cursor (ISC-86). */
const positional = (s?: Snapshot) => !!s && Object.keys(s.verdicts).length > 0 && Object.keys(s.verdicts).every((k) => /^\d+$/.test(k));
const identity = (key: string, v: Verdict) => { const cut = key.indexOf("|"); return { qid: v.qid ?? (cut < 0 ? key : key.slice(0, cut)), instance: v.instance ?? (cut < 0 ? "" : key.slice(cut + 1)) }; };
export function diff(prev: Snapshot | undefined, next: Snapshot): VigilEvent[] {
  const before = positional(prev) ? {} : prev?.verdicts ?? {};
  return Object.entries(next.verdicts).flatMap(([key, v]) => {
    const now = v.verdict, was = before[key]?.verdict, bad = (x?: string) => x === "fail" || x === "unknown";
    if (!was || was === now || !(bad(now) || now === "pass" && bad(was))) return [];
    const { qid, instance } = identity(key, v), q = next.questions[qid] ?? { text: "question not in the snapshot", severity: "medium" };
    const security = String(q.domain ?? "").toLowerCase() === "security";
    const severity: VigilEvent["severity"] = now === "pass" ? (security && was === "fail" && TEXTED.has(q.severity) ? "high" : "info") : now === "unknown" ? "medium" : SEVERITIES.includes(q.severity as never) ? q.severity as VigilEvent["severity"] : "medium";
    const quiet = PRIVATE_DOMAINS.has(String(q.domain ?? "").toLowerCase()), subject = instance ? `${qid} ${instance}` : qid, verb = now === "pass" ? "passes again" : now;
    const facts = [`${subject} went from ${was} to ${now}${v.at ? ` at ${clock(v.at)}` : ""}.`, security && now === "fail" ? HANDLED : "", q.text.endsWith("?") ? q.text : `${q.text}.`, !quiet && v.value ? `Value: ${clip(v.value, 160)}.` : "", !quiet && v.evidence ? `Evidence: ${clip(v.evidence)}.` : "", quiet && now !== "pass" ? "Value withheld: private domain." : "", now !== "pass" && q.ideal ? `Ideal: ${clip(q.ideal, 200)}` : "", `Look: bun LIFEOS/SOCRATES/Socrates.ts show ${qid}`];
    return [event("socrates", key, now, severity, `${subject} ${verb}: ${q.text}`, facts.filter(Boolean).join(" "), "ai", null, String(v.answer))];
  });
}
export async function live(): Promise<Snapshot> {
  const s = jsonFile<{ answers?: Answer[] | Record<string, Answer>; questions?: Question[] }>(join(homedir(), ".local/state/lifeos/socrates/snapshot.json"));
  need(s.answers && typeof s.answers === "object" && Array.isArray(s.questions), "socrates snapshot answers and questions list");
  const verdicts: Record<string, Verdict> = {};
  for (const a of Object.values(s.answers)) {
    need(typeof a?.verdict === "string" && typeof a.id === "number" && typeof a.question_id === "string" && (a.instance_key === undefined || a.instance_key === null || typeof a.instance_key === "string"), "socrates answer verdict, id, question_id and instance_key");
    const key = `${a.question_id}|${a.instance_key ?? ""}`, have = verdicts[key];
    if (have && (have.at ?? "") > (a.ts ?? "") || have && have.at === a.ts && have.answer >= a.id) continue;
    verdicts[key] = { verdict: a.verdict, answer: a.id, qid: a.question_id, instance: a.instance_key ?? "", ...(a.ts ? { at: a.ts } : {}), ...(a.value ? { value: String(a.value) } : {}), ...(a.evidence ? { evidence: String(a.evidence) } : {}) };
  }
  return { verdicts, questions: Object.fromEntries(s.questions.map((q) => [q.id, { text: String(q.text ?? q.id), severity: String(q.severity ?? "medium"), ...(q.ideal ? { ideal: String(q.ideal) } : {}), ...(q.domain ? { domain: String(q.domain) } : {}) }])) };
}
export const read = () => withCursor("socrates", live, diff);
