/**
 * Vigil deterministic severity routing and interruption ceiling, plus the F12 decider for job texts (shadow and enforce), the watch sub-cap and per-source text caps.
 * 0.9.0 (STATVS split p1): `let_be` is a routing action (a policy route value: recorded, nothing shown), and the severity ceiling is Policy.severityCeiling(), so every `advocate-*` source runs under medium whether or not the policy names it (Vigil ISC-447).
 * @version 0.9.0
 */
import { createHash } from "node:crypto";
import type { VigilEvent } from "./Schema";
import { isAdvocateSource, loadPolicy, severityCeiling, type RouteValue, type VigilPolicy } from "./Policy";
import { isWatchWorkflow } from "../WORKFLOWS/engine/vigil-emit";
/** `editor` is set only when Editor.ts promoted the event; it carries the reason line and story key. `job` marks an F12 enforce job text: `text` is the sender's draft (or the editor's rewording of it), the only words ever sent for it. */
export type Decision = { event: VigilEvent; action: RouteValue | "held"; reason: string; workrepo?: "workrepo" | "workrepo-held"; editor?: { why: string; story: string }; job?: { cls: JobClass; text: string; reworded?: true } };
/** What an event is about, stable across re-emits: the caller key when given, else the dedup key without its trailing counters (example-service:health:fail:35924 → example-service:health:fail; example-service:nightly:missed:2027-01-01T00:00:00Z#50 → example-service:nightly:missed). */
export const storyKeyOf = (event: VigilEvent): string => {
  const key = typeof event.meta?.key === "string" && event.meta.key ? event.meta.key : event.dedup_key.replace(/(:(\d+|\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?(#\d+)?))+$/, "");
  // A watch's story key always starts with `watch-`, whatever key or dedup_key the watch chose (a watch may set any meta.key of its own). Every sent record and the 72h hold read the key through here, so the watch sub-cap (ISC-113) finds a watch's earlier texts across ticks by key alone.
  return event.source.startsWith("watch-") && !key.startsWith("watch-") ? `${event.source}:${key}` : key;
};
/** A story texted in the last 72 hours is not texted again unless severity rose or the sender marks it as superseding. */
export const REPEAT_WINDOW_MS = 72 * 3_600_000;
export type SentStory = { key: string; ts: string; severity?: VigilEvent["severity"]; source?: string };
/**
 * F12 ISC-141: the one daily budget for unrequested texts. `texts` are the send times the budget counts, `cap` how many a day may reach the principal.
 * `ledger`: every origin's texts from the interruption ledger against `interruptions_per_day`. `vigil`: the fallback when that ledger is unreadable,
 * Vigil's own texts against its own `text_ceiling_per_24h`. Security criticals, prep and decision skip the cap but count, because they are sends.
 */
export type TextBudget = { cap: number; texts: string[]; source: "ledger" | "vigil" };
export const BUDGET_REASON = "daily text budget reached across every origin";
/** Texts the budget counts since 24 hours before `at` (routing: everything sent since, a send stamped after a lagging clock included). */
export const budgetUsedAt = (b: TextBudget, at: number): number => b.texts.filter((ts) => Date.parse(ts) >= at - 86_400_000).length;
/** What was left of the budget at `at` itself: only texts inside the 24 hours ending then (shadow's record of the job's own moment). */
export const budgetLeftAt = (b: TextBudget, at: number): number => Math.max(0, b.cap - b.texts.filter((ts) => { const t = Date.parse(ts); return t >= at - 86_400_000 && t <= at; }).length);

/** A text that skips the 24h ceiling: its ref or title carries a configured `text_ceiling_exempt` substring. It still counts as a send. */
export const ceilingExempt = (event: VigilEvent, policy: VigilPolicy): boolean =>
  (policy.text_ceiling_exempt ?? []).some((s) => s && (`${event.ref ?? ""} ${event.title}`).includes(s));
/** Watch workflows (LIFEOS/WATCHES) emit under `watch-<name>`. Many polling sources must not spend the one daily text budget a real ops alert needs. */
/** The same `watch-` prefix names a watch's workflow and its Vigil source, so one predicate (defined beside the streak code in vigil-emit.ts) answers for both. */
export const isWatchSource = (source: string): boolean => isWatchWorkflow(source);
export const WATCH_CAP_REASON = "watch text sub-cap reached (shared by every watch source)";
/** ISC-113: the watch sources' own daily text cap. Policy key `watch_text_cap_per_24h`, default 3. */
/** A critical watch event is exempt, as every critical text is from the general ceiling: an urgent warning must not wait behind three routine watch texts. The rest of the brake on a swarm is `source_events_per_hour` and the 72h story hold. */
export const watchTextCap = (policy: VigilPolicy): number => { const v = policy.watch_text_cap_per_24h; return Number.isInteger(v) && v >= 0 ? v : 3; };
export const SOURCE_CAP_REASON = "this source's daily text cap reached";
/** The daily text cap a policy sets for one source (`source_text_cap_per_24h`), or null when it sets none. A bad value is no cap, never zero. */
export const sourceTextCap = (policy: VigilPolicy, source: string): number | null => { const v = (policy.source_text_cap_per_24h ?? {})[source]; return Number.isInteger(v) && v! >= 0 ? v! : null; };
/** A source's texts already sent, read back from `sentStories`: by the story's recorded source, and by key prefix for a story recorded before the source was kept (an event's own meta.key need not start with its source). */
export const sentBySource = (stories: SentStory[], source: string, cutoff: number): number => stories.filter((t) => (t.source !== undefined ? t.source === source : t.key.startsWith(`${source}:`)) && Date.parse(t.ts) >= cutoff).length;
/** Watch texts already sent are read back from `sentStories`: storyKeyOf gives every watch event a key that starts `watch-`, so the tick needs no extra input. */
export function route(events: VigilEvent[], opts: { policy: VigilPolicy; recentTexts: Array<string | { ts: string }>; recentWorkRepo?: Array<string | { ts: string }>; now: Date; sentStories?: SentStory[]; quiet?: boolean; budget?: TextBudget }): Decision[] {
  // With a budget (F12 enforce, ISC-141) the count and cap are every origin's; without one, Vigil's own texts against its own ceiling.
  const cutoff = opts.now.getTime() - 86_400_000, cap = opts.budget?.cap ?? opts.policy.text_ceiling_per_24h, overCap = opts.budget?.source === "ledger" ? BUDGET_REASON : "rolling 24h text ceiling reached"; let used = opts.budget ? budgetUsedAt(opts.budget, opts.now.getTime()) : opts.recentTexts.filter((x) => Date.parse(typeof x === "string" ? x : x.ts) >= cutoff).length;
  const watchCap = watchTextCap(opts.policy), watchSent = (opts.sentStories ?? []).filter((t) => isWatchSource(t.key)); let watchUsed = watchSent.filter((x) => Date.parse(x.ts) >= cutoff).length;
  let workrepoUsed = (opts.recentWorkRepo ?? []).filter((x) => Date.parse(typeof x === "string" ? x : x.ts) >= cutoff).length;
  const sourceUsed = new Map<string, number>(), sourceCapReached = (source: string): boolean => { const cap = sourceTextCap(opts.policy, source); if (cap === null) return false; if (!sourceUsed.has(source)) sourceUsed.set(source, sentBySource(opts.sentStories ?? [], source, cutoff)); return sourceUsed.get(source)! >= cap; };
  const rank = ["info", "low", "medium", "high", "critical"] as const;
  const batchTexted = new Set<string>();
  const counts = new Map<string, number>(), collapsed = new Map<string, VigilEvent[]>(), admitted: VigilEvent[] = [];
  // The per-source cap sheds the least severe events, never the latest: admitted in arrival order, a burst of info events from one
  // source would fill the cap and collapse the high alerts behind it into a pulse. Severity picks WHICH events are admitted;
  // everything after keeps arrival order, so budget and story holds fall exactly as before.
  const perSource = new Map<string, number>(), keep = new Set<VigilEvent>();
  for (const e of events.map((e, i) => ({ e, i })).sort((a, b) => rank.indexOf(b.e.severity) - rank.indexOf(a.e.severity) || a.i - b.i).map(({ e }) => e)) { const n = perSource.get(e.source) ?? 0; perSource.set(e.source, n + 1); if (n < opts.policy.source_events_per_hour) keep.add(e); }
  for (const original of events) { const ceiling = severityCeiling(opts.policy, original.source); const event = ceiling && rank.indexOf(original.severity) > rank.indexOf(ceiling) ? { ...original, severity: ceiling } : original; counts.set(event.source, (counts.get(event.source) ?? 0) + 1); if (keep.has(original)) admitted.push(event); else collapsed.set(event.source, [...(collapsed.get(event.source) ?? []), event]); }
  for (const [source, rows] of collapsed) { const severity = rows.reduce<VigilEvent["severity"]>((best, e) => rank.indexOf(e.severity) > rank.indexOf(best) ? e.severity : best, "info"); admitted.push({ ...rows[0]!, id: `collapsed:${source}:${rows[0]!.ts}`, severity, title: `${rows.length} more from ${source} collapsed`, summary: rows.slice(0, 20).map((e) => e.title).join("; "), dedup_key: `vigil:collapsed:${source}:${rows[0]!.ts}` }); }
  return admitted.map((event): Decision => { const intended: RouteValue = event.id.startsWith("collapsed:") ? "pulse" : opts.policy.routes[event.severity]; let action: Decision["action"] = intended, reason = event.id.startsWith("collapsed:") ? "source event cap exceeded" : `${event.severity} routes to ${intended} by policy`;
    const told = intended === "text" ? (opts.sentStories ?? []).find((t) => t.key === storyKeyOf(event) && opts.now.getTime() - Date.parse(t.ts) < REPEAT_WINDOW_MS) : undefined;
    const rose = told?.severity !== undefined && rank.indexOf(event.severity) > rank.indexOf(told.severity);
    // let_be: recorded, nothing shown. No hold, cap or batch rule applies, because nothing is sent or queued; only the work-repo filing below still looks at it.
    if (intended === "let_be") { action = "let_be"; reason = `${event.severity} routes to let_be by policy: recorded, nothing shown`; }
    else if (batchTexted.has(storyKeyOf(event))) { action = "held"; reason = "same story already routed to text in this batch"; }
    else if (intended === "text" && !opts.policy.text_trusted_sources.includes(event.source)) { action = "pulse"; reason = "source not text-trusted"; }
    else if (told && !rose && event.meta?.supersedes !== true) { action = "held"; reason = "already texted about this in the last 72h"; }
    else if (intended === "text" && opts.quiet && event.severity !== "critical") { action = "held"; reason = "quiet hours"; }
    else if (intended === "text" && isWatchSource(event.source) && event.severity !== "critical" && watchUsed >= watchCap) { action = "held"; reason = WATCH_CAP_REASON; }
    else if (intended === "text" && event.severity !== "critical" && sourceCapReached(event.source)) { action = "held"; reason = SOURCE_CAP_REASON; }
    else if (intended === "text" && event.severity !== "critical" && used >= cap && !ceilingExempt(event, opts.policy)) { action = "held"; reason = overCap; }
    else if (intended === "text") { used++; batchTexted.add(storyKeyOf(event)); if (isWatchSource(event.source)) watchUsed++; if (sourceTextCap(opts.policy, event.source) !== null) { sourceCapReached(event.source); sourceUsed.set(event.source, sourceUsed.get(event.source)! + 1); } }
    let workrepo: Decision["workrepo"]; if (!event.id.startsWith("collapsed:") && event.meta?.workrepo === true && rank.indexOf(event.severity) >= rank.indexOf(opts.policy.issue_min_severity)) { workrepo = workrepoUsed >= opts.policy.issue_ceiling_per_24h ? "workrepo-held" : "workrepo"; if (workrepo === "workrepo") workrepoUsed++; }
    return { event, action, reason, ...(workrepo ? { workrepo } : {}) }; });
}

/** F12 shadow mode (ISC-138/143/148). A scheduled job's text becomes one typed event on the existing schema; the draft never enters the event (it is forwarded to the cloud store), only a hash of it does. */
export const JOB_CLASSES = ["security", "prep", "decision", "ops", "news"] as const; export type JobClass = typeof JOB_CLASSES[number];
/** Classes that would always reach the phone, whatever the holds say (ISC-139/147). */
export const ALWAYS_SEND: readonly JobClass[] = ["security", "prep", "decision"];
const SECURITY_TEXT = /\b(security alert|breach(ed)?|compromised|intrusion|malware|phishing|unauthori[sz]ed|suspicious (log-?in|sign-?in|activity)|CVE-\d{4}-\d+|leaked (key|token|credential)s?)\b/i;
const CHOICE_TEXT = /\b(should i|shall i|want me to|do you want|would you like|which (one|option|do you)|ok(ay)? to|approve|reply (y|yes|no|\d))\b[^?]*\?|\(y\/n\)/i;
/** Deterministic, no model: `Prep:` briefs are prep, a job named in policy `news_job_ids` is news, security wording is security, a question asking the principal to choose is decision, everything else is ops. */
export function jobClass(jobId: string, text: string, newsJobIds: readonly string[] = loadPolicy().news_job_ids ?? []): JobClass { if (/^\s*Prep:/.test(text)) return "prep"; if (newsJobIds.includes(jobId)) return "news"; if (SECURITY_TEXT.test(text)) return "security"; if (CHOICE_TEXT.test(text)) return "decision"; return "ops"; }
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const NOT_NAMES = new Set(["i", "a", "an", "the", "your", "you", "we", "it", "its", "this", "that", "these", "there", "theres", "here", "heres", "prep", "fyi", "heads", "reminder", "note", "new", "good", "morning", "no", "yes", "ok", "okay", "also", "both", "one", "should", "want", "do", "would", "which", "when", "what", "where", "who", "how", "if", "and", "but", "or", "for", "from", "to", "on", "at", "in", "of", "with", "am", "pm", "pdt", "pst", "utc", "pt", "today", "tomorrow", "tonight", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "june", "july", "august", "september", "sept", "october", "november", "december", ...MONTHS]);
const mmdd = (month: string, day: string): string => `${String(MONTHS.indexOf(month.slice(0, 3).toLowerCase()) + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
/** The normalized subject of a job text: a calendar event id when the text carries one, else its first date plus its first two proper names, else its first six long words. Rewordings of one story share a subject. */
export function jobSubject(text: string): string {
  const id = text.match(/\beid=([A-Za-z0-9_-]{8,})/)?.[1] ?? text.match(/\bevent[ _-]?id[:#= ]+([A-Za-z0-9_@.-]{8,})/i)?.[1]; if (id) return `event:${id}`;
  const t = text.replace(/https?:\/\/\S+/g, " "), iso = t.match(/\b\d{4}-(\d{2})-(\d{2})\b/), named = t.match(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})\\b`, "i")), reversed = t.match(new RegExp(`\\b(\\d{1,2})\\s+${MONTH_RE}(?![a-z])`, "i"));
  const date = iso ? `${iso[1]}-${iso[2]}` : named ? mmdd(named[1]!, named[2]!) : reversed ? mmdd(reversed[2]!, reversed[1]!) : "";
  const names = [...new Set(t.split(/[^A-Za-z0-9&'’-]+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w.replace(/['’]s?$/, "").replace(/['’]/g, "").toLowerCase()).filter((w) => w && !NOT_NAMES.has(w)))].slice(0, 2);
  if (date || names.length) return `${date}|${names.join(" ")}`;
  return t.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 6).join(" ") || "empty";
}
/** Stable caller key: job id plus a hash of the subject, so the subject's names never leave the machine. */
export const jobKey = (jobId: string, text: string): string => `${jobId}:${createHash("sha256").update(jobSubject(text)).digest("hex").slice(0, 16)}`;
const JOB_KIND: Record<JobClass, VigilEvent["kind"]> = { security: "security", prep: "life", decision: "life", ops: "other", news: "news" };
const JOB_SEVERITY: Record<JobClass, VigilEvent["severity"]> = { security: "high", prep: "medium", decision: "medium", ops: "info", news: "info" };
/**
 * The event for one job text. `text_sha256` is the first 32 hex chars: the schema refuses any 40+ hex run as credential-shaped. The full hash and the draft live only in Vigil's local shadow-drafts.jsonl.
 * A shadow event (the default, AgentJob's) reports what the job already did with its text. `shadow: false` is an F12 enforce report (`Vigil.ts emit --text-file`): the job hands its text to Vigil to decide, so there is no `actual`, and the caller may name class, key and severity.
 */
export function jobEvent(o: { id: string; origin: string; text: string; actual?: string; ts: string; source?: string; shadow?: boolean; cls?: JobClass; key?: string; severity?: VigilEvent["severity"] }): VigilEvent {
  const cls = o.cls ?? jobClass(o.origin, o.text), shadow = o.shadow !== false, actual = o.actual ?? "unknown", source = o.source ?? "agentjob";
  const summary = shadow ? `Job ${o.origin} produced one ${cls} text; the job ${actual === "sent" ? "sent it" : actual === "failed" ? "failed to send it" : actual.replace(/^held-/, "held it: ").replace(/-/g, " ")}. The draft stays in Vigil's local state, never in this event.` : `Job ${o.origin} reported one ${cls} text for Vigil to decide. The draft stays in Vigil's local state, never in this event.`;
  return { id: o.id, source, ts: o.ts, kind: JOB_KIND[cls], severity: o.severity ?? JOB_SEVERITY[cls], title: (shadow ? `${o.origin} ${cls} text, job ${actual}` : `${o.origin} ${cls} text`).slice(0, 140), summary, ref: o.origin, url: null, privacy_class: "personal", dedup_key: `${source}:${o.origin}:${o.id}`, meta: { class: cls, key: o.key ?? jobKey(o.origin, o.text), origin: o.origin, ...(shadow ? { shadow: true, actual } : {}), text_sha256: createHash("sha256").update(o.text).digest("hex").slice(0, 32), chars: o.text.length } };
}
/** `budget_left` (ISC-141, shadow): what the one daily budget had left at the job's own time. Recorded for the labels, never acted on. */
export type ShadowDecision = { event: VigilEvent; decision: "shadow-send" | "shadow-hold"; reason: string; key: string; budget_left?: number; budget_source?: TextBudget["source"] };
/**
 * What Vigil would have done with each shadow event, using today's rules: security, prep and decision always send; everything else
 * sends only if it survives the 72h story hold (against earlier would-sends), quiet hours at the event's own time, and the 24h
 * ceiling (real Vigil texts plus earlier would-sends). Pure: the caller records the decisions.
 */
export function shadowRoute(events: VigilEvent[], opts: { policy: VigilPolicy; now: Date; recentTexts: string[]; shadowSent: SentStory[]; quietAt: (ts: string) => boolean; budget?: TextBudget }): ShadowDecision[] {
  const rank = ["info", "low", "medium", "high", "critical"] as const, cutoff = opts.now.getTime() - 86_400_000, stories = [...opts.shadowSent];
  let used = opts.recentTexts.filter((ts) => Date.parse(ts) >= cutoff).length + stories.filter((s) => Date.parse(s.ts) >= cutoff).length;
  const budgeted = (d: ShadowDecision): ShadowDecision => opts.budget ? { ...d, budget_left: budgetLeftAt(opts.budget, Date.parse(d.event.ts)), budget_source: opts.budget.source } : d;
  return [...events].sort((a, b) => a.ts.localeCompare(b.ts)).map((event): ShadowDecision => budgeted(decideShadow(event)));
  function decideShadow(event: VigilEvent): ShadowDecision {
    const key = storyKeyOf(event), cls = String(event.meta?.class ?? "ops"), at = Date.parse(event.ts);
    const send = (reason: string): ShadowDecision => { used++; stories.push({ key, ts: event.ts, severity: event.severity }); return { event, decision: "shadow-send", reason, key }; };
    if ((ALWAYS_SEND as readonly string[]).includes(cls)) return send(`${cls} always sends`);
    const told = stories.find((s) => s.key === key && Math.abs(at - Date.parse(s.ts)) < REPEAT_WINDOW_MS), rose = told?.severity !== undefined && rank.indexOf(event.severity) > rank.indexOf(told.severity);
    if (told && !rose && event.meta?.supersedes !== true) return { event, decision: "shadow-hold", reason: "already told this story in the last 72h", key };
    if (opts.quietAt(event.ts) && event.severity !== "critical") return { event, decision: "shadow-hold", reason: "quiet hours", key };
    if (event.severity !== "critical" && used >= opts.policy.text_ceiling_per_24h) return { event, decision: "shadow-hold", reason: "rolling 24h text ceiling reached", key };
    return send("passed the 72h story hold, quiet hours and the 24h ceiling");
  }
}
/**
 * An F12 enforce job text: a non-shadow event whose `meta.class` is a job class. Vigil's own rows carry a class too and never count, and
 * neither does an `advocate-*` row: it may have read injected content, so it never texts on its own (ISC-447) and stays under route().
 */
export const isJobEvent = (e: VigilEvent): boolean => e.source !== "vigil" && !isAdvocateSource(e.source) && e.meta?.shadow !== true && (JOB_CLASSES as readonly unknown[]).includes(e.meta?.class);
/** ISC-139: the job texts decided by fixed rules alone. Prep and decision always qualify; security needs severity high or above. */
export const fixedJob = (e: VigilEvent): boolean => isJobEvent(e) && (e.meta?.class === "prep" || e.meta?.class === "decision" || e.meta?.class === "security" && (e.severity === "high" || e.severity === "critical"));
/**
 * F12 enforce (ISC-139): what Vigil does with job texts, by fixed rules and no model. Fixed classes always send; the rest send only past
 * the 72h story hold, quiet hours and the 24h ceiling (shadowRoute's rules, judged at send time). Every send counts toward the ceiling and
 * the story hold. A text with no local draft is held: Vigil sends the sender's words or nothing. Pure: the caller sends and records.
 */
export function jobRoute(events: VigilEvent[], opts: { policy: VigilPolicy; now: Date; recentTexts: string[]; sentStories: SentStory[]; quiet: boolean; draftOf: (event: VigilEvent) => string | undefined; budget?: TextBudget }): Decision[] {
  const rank = ["info", "low", "medium", "high", "critical"] as const, at = opts.now.getTime(), stories = [...opts.sentStories], cap = opts.budget?.cap ?? opts.policy.text_ceiling_per_24h, overCap = opts.budget?.source === "ledger" ? BUDGET_REASON : "rolling 24h text ceiling reached";
  let used = opts.budget ? budgetUsedAt(opts.budget, at) : opts.recentTexts.filter((ts) => Date.parse(ts) >= at - 86_400_000).length;
  return events.filter(isJobEvent).sort((a, b) => a.ts.localeCompare(b.ts)).map((event): Decision => {
    const cls = event.meta!.class as JobClass, key = storyKeyOf(event), draft = opts.draftOf(event)?.trim() ?? "";
    const hold = (reason: string): Decision => ({ event, action: "held", reason, job: { cls, text: draft } });
    const send = (reason: string): Decision => { used++; stories.push({ key, ts: opts.now.toISOString(), severity: event.severity }); return { event, action: "text", reason, job: { cls, text: draft } }; };
    if (!draft) return hold("no local draft for this job text: Vigil sends the sender's words or nothing");
    if (fixedJob(event)) return send(`${cls} always sends (fixed rule, no model)`);
    const told = stories.find((s) => s.key === key && at - Date.parse(s.ts) < REPEAT_WINDOW_MS), rose = told?.severity !== undefined && rank.indexOf(event.severity) > rank.indexOf(told.severity);
    if (told && !rose && event.meta?.supersedes !== true) return hold("already told this story in the last 72h");
    if (opts.quiet && event.severity !== "critical") return hold("quiet hours");
    if (event.severity !== "critical" && used >= cap) return hold(overCap);
    return send("passed the 72h story hold, quiet hours and the 24h ceiling");
  });
}
