/**
 * Review — Pulse module for LifeOS's daily, weekly and monthly self-review.
 *
 *   GET  /api/review/detail/:id  one queue row's detail: current state, falsifier, first 8 evidence entries
 *                             and the count of the rest, history notes (fetched when Detail opens)
 *   GET  /api/review          open decisions, recent ones, instrument health, alarms, watches,
 *                             the latest scorecard and unlabeled items, each source with its as-of time,
 *                             plus the Upgrades queue (`queue`), every applied change (`applied`) and the
 *                             newest rejected and expired records (`closed`, `closed_total`)
 *   POST /api/review/decide   { id, decision: "y" | "n", note? }  the principal's yes or no
 *   POST /api/review/label    { id, right: boolean }               confirm or correct the detector
 *
 * A yes files one Upgrades record (the same path as `Review.ts decide`). Nothing else changes.
 * The queue is Review's queue: /upgrades folded into /review on 2026-10-10, and accept or reject on a
 * queue row still goes through /api/upgrades/:id/(accept|reject) in modules/upgrades.ts.
 * ISA: LIFEOS/REVIEW/ISA.md (maintainer-side, not shipped)
 */
import { appliedCut, decide, label, liveDeps, rollbackKey, SPECIFIC_METRICS, status, WATCH_REGISTER_DAYS } from "../../REVIEW/Review"
import { loadRecs } from "../../REVIEW/Store"
import { detectorAgreement } from "../../REVIEW/Monthly"
import { listUpgrades, type UpgradeRecord } from "../../TOOLS/Upgrades"
import { listPending } from "./hypotheses"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface QueueItem {
  id: string                    // upgrade id, or "hyp:<slug>" for a pending deriver hypothesis
  source: string
  claim: string
  created: string
  confidence: number
  status: "recommended" | "accepted"
  target_surface: string
  expires_in_days: number | null
  evidence_count: number
  recommendation: string
  quote: string                 // coach only: the correction in the principal's words
  category: string              // coach only
  has_patch: boolean            // a pending healing fixture is attached (autonomous hypotheses only)
  patch_target: string | null   // the surface that patch targets; null when there is no patch
  proposed_patch: string        // the patch text, clipped; "" when there is none
  recurrence_count: number      // times the problem recurred: 1 = once (shown for coach rows)
  ledger_id: string | null      // the Ledger entry the record is tied to; null when none (and for hypotheses)
}

/** What a queue row's Detail shows, fetched when it opens so the list payload stays small. */
export interface QueueDetail {
  id: string
  current_state: string         // what happens today (records only; "" for a hypothesis)
  falsifier: string             // what would show the recommendation wrong (hypotheses only; "" for a record)
  evidence: string[]            // the first DETAIL_EVIDENCE_MAX entries
  evidence_more: number         // how many entries were left out
  notes: string[]               // the record's history notes, oldest first
  recommendation: string        // the full recommendation; the queue row carries it clipped
}
export const DETAIL_EVIDENCE_MAX = 8

/** A rejected or expired record: what it was, when it closed, and the note it closed with. */
export interface ClosedItem {
  id: string
  source: string
  claim: string
  created: string
  status: "rejected" | "expired"
  target_surface: string
  confidence: number
  quote: string
  category: string
  recurrence_count: number
  note: string                  // the record's last note, as stored
  reason: string                // why it closed, as one plain line: the reject reason, or what expired it
  closed_at: string | null      // when it closed (the time on its closing note); null when no note carries one
}

/** The closed list is the newest this many; `closed_total` carries the full count. */
export const CLOSED_CAP = 200
const PATCH_MAX = 8_000
const DETAIL_TEXT_MAX = 4_000
const DETAIL_NOTES_MAX = 60
/** The label an applied change older than the watch window carries when it never had a watch. */
export const NO_WATCH_OLD = "applied before watches"

export interface AppliedItem {
  id: string
  source: string
  claim: string
  created: string
  status: "applied" | "verified"
  ledger_id: string | null
  watch: { id: string; label: string; verdict: string } | null
  verdict_sentence: string      // the watch state as one plain sentence, with the number when there is one (ISC-89)
  verdict_kind: OutcomeKind     // the glance label shown before the sentence
}

/** A Review watch as status() returns it; `refs` lists the Upgrades record ids and Ledger ids it measures. */
export interface WatchLike {
  id: string; label?: string; refs?: string[]; result?: unknown
  cut?: string; days?: number; metrics?: Array<{ metric: string; args?: Record<string, string> }>; rollback_held?: string
}

const DAY_MS = 86_400_000
const byNewest = (a: { created: string }, b: { created: string }) => b.created.localeCompare(a.created)
/** Claims can hold a whole pasted report; the list shows the head and the record holds the rest. */
const clip = (s: string | undefined, max: number) => (s && s.length > max ? `${s.slice(0, max)}…` : s ?? "")

/** A record's claim as a page title: markdown markers removed, links reduced to their text (ISC-100). */
export function plainTitle(s: string | undefined): string {
  return (s ?? "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** A `recurred:` note is appended by CoachReview each time a fresh correction folds onto a record. */
export function recurrenceCount(r: UpgradeRecord): number {
  return 1 + (r.notes ?? []).filter((n) => /^recurred:/.test(n)).length
}

/** Recommended and accepted records, plus pending deriver hypotheses as source=autonomous, newest first. */
export function buildQueue(records: UpgradeRecord[], hyps: ReturnType<typeof listPending>, now = Date.now()): QueueItem[] {
  const fromRecord = (r: UpgradeRecord): QueueItem => {
    const exp = r.expires ? Date.parse(r.expires) : NaN
    return {
      id: r.id, source: r.source, claim: clip(plainTitle(r.claim), 400), created: r.created, confidence: r.confidence ?? 0.5,
      status: r.status as QueueItem["status"], target_surface: r.target_surface ?? "unknown",
      expires_in_days: r.status === "recommended" && exp > 0 ? Math.round((exp - now) / DAY_MS) : null,
      evidence_count: (r.evidence ?? []).length, recommendation: clip(r.recommendation, 600),
      quote: r.quote ?? "", category: r.category ?? "",
      has_patch: false, patch_target: null, proposed_patch: "", recurrence_count: recurrenceCount(r),
      ledger_id: r.ledger_id ?? null,
    }
  }
  const fromHypothesis = (h: (typeof hyps)[number]): QueueItem => ({
    id: `hyp:${h.slug}`, source: "autonomous", claim: clip(plainTitle(h.claim || h.slug), 400), created: h.generated, confidence: h.confidence,
    status: "recommended", target_surface: h.enforcement_surface || "context", expires_in_days: h.expires_in_days,
    evidence_count: h.evidence_signals.length, recommendation: clip(h.suggested_action, 600), quote: "", category: "",
    has_patch: !!h.has_patch, patch_target: h.has_patch ? h.enforcement_surface || "context" : null,
    proposed_patch: clip(h.proposed_patch, PATCH_MAX), recurrence_count: 1, ledger_id: null,
  })
  return [
    ...records.filter((r) => r.status === "recommended" || r.status === "accepted").map(fromRecord),
    ...hyps.map(fromHypothesis),
  ].sort(byNewest)
}

/** The detail of one queue row: a record by id, or a pending hypothesis as `hyp:<slug>`; null when neither exists. */
export function buildDetail(id: string, records: UpgradeRecord[], hyps: ReturnType<typeof listPending>): QueueDetail | null {
  const split = (all: string[]) => ({ evidence: all.slice(0, DETAIL_EVIDENCE_MAX).map((e) => clip(String(e), 400)), evidence_more: Math.max(0, all.length - DETAIL_EVIDENCE_MAX) })
  if (id.startsWith("hyp:")) {
    const h = hyps.find((x) => x.slug === id.slice(4))
    if (!h) return null
    return { id, current_state: "", falsifier: clip(h.falsifier, DETAIL_TEXT_MAX), ...split(h.evidence_signals ?? []), notes: [], recommendation: clip(h.suggested_action, DETAIL_TEXT_MAX) }
  }
  const r = records.find((x) => x.id === id)
  if (!r) return null
  return {
    id, current_state: clip(r.current_state, DETAIL_TEXT_MAX), falsifier: "", ...split(r.evidence ?? []),
    notes: (r.notes ?? []).slice(-DETAIL_NOTES_MAX).map((n) => clip(n, 400)),
    recommendation: clip(r.recommendation, DETAIL_TEXT_MAX),
  }
}

/** Rejected and expired records, newest first: at most `cap` of them, plus how many there are in all. */
export function buildClosed(records: UpgradeRecord[], cap = CLOSED_CAP): { items: ClosedItem[]; total: number } {
  const closed = records.filter((r) => r.status === "rejected" || r.status === "expired").sort(byNewest)
  const items = closed.slice(0, cap).map((r): ClosedItem => ({
    id: r.id, source: r.source, claim: clip(plainTitle(r.claim), 400), created: r.created, status: r.status as ClosedItem["status"],
    target_surface: r.target_surface ?? "unknown", confidence: r.confidence ?? 0.5, quote: r.quote ?? "", category: r.category ?? "",
    recurrence_count: recurrenceCount(r), note: clip((r.notes ?? []).at(-1), 300), ...closedReason(r),
  }))
  return { items, total: closed.length }
}

/** Reasons the stores write that mean nothing to a reader, mapped to what happened. */
const PLAIN_REASON: Record<string, string> = { "TTL sweep": "No decision before its time ran out." }

/**
 * Why a record closed and when (ISC-96), from its last note naming the closing status: "<ts> — rejected: <reason>"
 * or "<ts> — expired: <reason>". A leading date in the reason is dropped (the row shows when), whitespace runs fold
 * to one space, and a bare status reads as a sentence, so the row never shows a raw timestamp or an empty reason.
 */
export function closedReason(r: Pick<UpgradeRecord, "status" | "notes">): { reason: string; closed_at: string | null } {
  const status = r.status === "expired" ? "expired" : "rejected"
  const notes = r.notes ?? []
  const idx = notes.map((n) => new RegExp(`—\\s*${status}\\b`).test(n)).lastIndexOf(true)
  const note = idx >= 0 ? notes[idx] : undefined
  const m = note ? /^(\S+)\s+—\s*(?:rejected|expired)\b:?\s*([\s\S]*)$/.exec(note) : null
  const at = m && !Number.isNaN(Date.parse(m[1])) ? new Date(Date.parse(m[1])).toISOString() : null
  let text = (m?.[2] ?? "").replace(/\s+/g, " ").trim().replace(/^\d{4}-\d\d-\d\d(?:T[\d:.]+Z)?\s*/, "")
  // A reason written as its own note after the status change counts as the reason (ISC-96).
  if (!text && idx >= 0) {
    const later = notes.slice(idx + 1).find((n) => !/^\S+\s+—\s/.test(n) && n.trim())
    if (later) text = later.replace(/^[^:]{1,60}:\s*/, "").replace(/\s+/g, " ").trim()
  }
  text = PLAIN_REASON[text] ?? text
  if (!text) text = status === "rejected" ? "Rejected with no reason given." : "Expired with no decision."
  return { reason: clip(text.charAt(0).toUpperCase() + text.slice(1), 300), closed_at: at }
}

/** One line for a measured watch: an explicit verdict when the watch carries one, else each metric's state. */
export function watchVerdict(result: unknown): string {
  if (result == null) return "pending"
  const r = result as { verdict?: unknown; results?: Array<{ metric?: string; state?: string }> }
  if (typeof r.verdict === "string" && r.verdict) return r.verdict
  const parts = (r.results ?? []).filter((x) => x.metric && x.state).map((x) => `${x.metric} ${x.state}`)
  return parts.length ? parts.join(" · ") : "measured"
}

/** The state of an applied change's measurement, as verdictSentence reads it. */
export type WatchState =
  | { kind: "before-watches" }                 // applied more than WATCH_REGISTER_DAYS ago: never gets a watch
  | { kind: "unregistered" }                   // applied recently: the next daily run registers its watch
  | { kind: "watch"; watch: WatchLike; rollback_filed?: boolean }

interface MeasuredLike { metric?: string; args?: Record<string, string>; change_pct?: number | null; mde_pct?: number | null; state?: string }

/** A metric in plain words, as the subject of a sentence. */
function metricName(m: MeasuredLike): string {
  const a = m.args ?? {}
  switch (m.metric) {
    case "complaint_rate": return "Complaints"
    case "failure_rate": return "Detector failures"
    case "turn_corrections": return "Corrections"
    case "skill_complaint_rate": return a.skill ? `Complaints about ${a.skill}` : "Complaints about the skill"
    case "class_rate": return a.class ? `Failures of the ${a.class} kind` : "Failures of one kind"
    case "rule_breaks": return a.rule ? `Breaks of ${a.rule}` : "Rule breaks"
    default: { const t = String(m.metric ?? "the measure").replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1) }
  }
}

const pctText = (n: number) => `${Math.round(Math.abs(n))}%`
const STATE_RANK: Record<string, number> = { up: 4, down: 4, underpowered: 3, "no-change": 2, "insufficient-data": 1 }

/**
 * One plain sentence for an applied change's watch (ISC-89): what moved and by how much, whether that is more than
 * noise, and what Review did about it. It reads the metric that says most about this change: a metric specific to it
 * (one skill, failure kind or rule) before a system-wide one, which moves with every other change in the window
 * (ISC-84), then a clear rise or fall before an underpowered or thin one. Never returns raw watch data (ISC-90).
 */
export function verdictSentence(s: WatchState, now = Date.now()): string {
  return watchOutcome(s, now).sentence
}

/**
 * What a reader takes from a watch at a glance, shown as a short label before the sentence: too early (not due),
 * overdue, unclear (moved within noise, too little data, no change, or a system-wide rate that counts every other
 * change too), helped and worse (a metric specific to the change moved), never measured, and no watch yet.
 */
export type OutcomeKind = "too-early" | "overdue" | "unclear" | "helped" | "worse" | "never-measured" | "no-watch-yet"

/** The outcome of an applied change's watch: its glance label and its one plain sentence (ISC-89). */
export function watchOutcome(s: WatchState, now = Date.now()): { kind: OutcomeKind; sentence: string } {
  if (s.kind === "before-watches") return { kind: "never-measured", sentence: "Applied before watches began, so it was never measured." }
  if (s.kind === "unregistered") return { kind: "no-watch-yet", sentence: "No watch yet; the next daily review adds one." }
  const w = s.watch
  if (w.result == null) {
    const due = w.cut && w.days ? Date.parse(w.cut) + w.days * DAY_MS : NaN
    if (Number.isNaN(due)) return { kind: "too-early", sentence: "Not measured yet." }
    const day = new Date(due).toISOString().slice(0, 10)
    return due > now ? { kind: "too-early", sentence: `Not measured yet; due ${day}.` } : { kind: "overdue", sentence: `Overdue: due ${day} and still not measured.` }
  }
  const r = w.result as { verdict?: unknown; results?: MeasuredLike[] }
  const results = (r.results ?? []).filter((x) => x.metric && x.state)
  if (!results.length) {
    const v = typeof r.verdict === "string" ? r.verdict : ""
    const kind: OutcomeKind = /better/.test(v) ? "helped" : /worse/.test(v) ? "worse" : "unclear"
    return { kind, sentence: v ? `Measured: ${v}.` : "Measured, but no metric produced a result." }
  }
  const score = (x: MeasuredLike) => (SPECIFIC_METRICS.has(String(x.metric)) ? 10 : 0) + (STATE_RANK[String(x.state)] ?? 0)
  const lead = [...results].sort((a, b) => score(b) - score(a))[0]
  const name = metricName(lead)
  const specific = SPECIFIC_METRICS.has(String(lead.metric))
  const change = typeof lead.change_pct === "number" ? lead.change_pct : null
  const moved = change === null ? "" : `${change < 0 ? "fell" : "rose"} ${pctText(change)}`
  const span = w.days ? `those ${w.days} days` : "the window"
  const unclear = (sentence: string) => ({ kind: "unclear" as const, sentence })
  switch (lead.state) {
    case "insufficient-data": return unclear(moved
      ? `${name} ${moved}, but on too little data to trust the number.`
      : `Too little data on one side of the change to tell whether ${name.toLowerCase()} moved.`)
    case "no-change": return unclear(`${name} did not change.`)
    case "underpowered":
      return unclear(change === null ? `${name} moved too little to tell from noise.`
        : `${name} ${moved}, too small to tell from noise${typeof lead.mde_pct === "number" ? ` (±${pctText(lead.mde_pct)})` : ""}.`)
    case "down":
      return specific ? { kind: "helped", sentence: `${name} ${moved}.` }
        : unclear(`${name} ${moved} across all of LifeOS in ${span}, a rate that moves with every change, so it says nothing about this one.`)
    case "up":
      if (!specific) return unclear(`${name} ${moved} across all of LifeOS in ${span}, a rate that moves with every change, so it says nothing about this one.`)
      if (s.rollback_filed) return { kind: "worse", sentence: `${name} ${moved}; a rollback decision was filed.` }
      if (w.rollback_held) return { kind: "worse", sentence: `${name} ${moved}; a rollback decision is waiting for a free decision slot.` }
      return { kind: "worse", sentence: `${name} ${moved}; the next daily review files a rollback decision.` }
    default: return unclear(`${name}: ${lead.state}.`)
  }
}

/** The outcome of a watch as listed in /review's Watches section, with its rollback looked up in the recs. */
export function watchOutcomeFor(w: WatchLike, recs: Array<{ key?: string }> = [], now = Date.now()): { kind: OutcomeKind; sentence: string } {
  return watchOutcome({ kind: "watch", watch: w, rollback_filed: recs.some((r) => r.key === rollbackKey(w.id)) }, now)
}

/** The sentence alone for a listed watch. */
export function watchSentence(w: WatchLike, recs: Array<{ key?: string }> = [], now = Date.now()): string {
  return watchOutcomeFor(w, recs, now).sentence
}

/**
 * Applied and verified records, each with the first Review watch that names it exactly: one of the
 * watch's refs, or the watch id itself, equals the record id or its Ledger id (ISC-69). Labels and
 * substrings never match, so Ledger L-9 cannot take the verdict of a watch on L-90.
 * A record with no watch whose applied time is older than the 28-day registration window will never get
 * one (Review's daily run skips it), so it reads "applied before watches" (ISC-78); a recent one stays
 * null ("no watch") until the next daily run registers its watch.
 */
export function buildApplied(records: UpgradeRecord[], watches: WatchLike[], now = Date.now(), recs: Array<{ key?: string }> = []): AppliedItem[] {
  return records
    .filter((r) => r.status === "applied" || r.status === "verified")
    .map((r): AppliedItem => {
      const keys = new Set([r.id, r.ledger_id].filter((k): k is string => !!k))
      const w = watches.find((x) => [x.id, ...(Array.isArray(x.refs) ? x.refs : [])].some((ref) => typeof ref === "string" && keys.has(ref)))
      const cut = Date.parse(appliedCut(r).cut)
      const tooOld = !w && cut < now - WATCH_REGISTER_DAYS * DAY_MS
      const outcome = w ? watchOutcomeFor(w, recs, now) : watchOutcome({ kind: tooOld ? "before-watches" : "unregistered" }, now)
      return {
        id: r.id, source: r.source, claim: clip(plainTitle(r.claim), 400), created: r.created, status: r.status as AppliedItem["status"],
        ledger_id: r.ledger_id,
        watch: w ? { id: w.id, label: w.label ?? w.id, verdict: watchVerdict(w.result) }
          : tooOld ? { id: "", label: `No watch was registered for changes applied more than ${WATCH_REGISTER_DAYS} days ago`, verdict: NO_WATCH_OLD } : null,
        verdict_sentence: outcome.sentence, verdict_kind: outcome.kind,
      }
    })
    .sort(byNewest)
}

/**
 * The next time a five-field cron fires after `from`, in local time, for the subset Review's workflows use:
 * each field is a number or "*". Anything else (ranges, lists, steps) returns null rather than a wrong time.
 */
export function nextCronRun(cron: string, from: Date): string | null {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5 || !f.every((x) => x === "*" || /^\d+$/.test(x))) return null
  const [min, hour, dom, mon, dow] = f.map((x) => (x === "*" ? null : Number(x)))
  if (min === null || hour === null) return null
  for (let i = 0; i <= 366; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, hour, min, 0, 0)
    if (d.getTime() <= from.getTime()) continue
    if (dom !== null && d.getDate() !== dom) continue
    if (mon !== null && d.getMonth() + 1 !== mon) continue
    if (dow !== null && d.getDay() !== dow % 7) continue
    return d.toISOString()
  }
  return null
}

/** Where Review's three scheduled workflows live; their cron lines are the one source for when each runs next. */
const WORKFLOW_DIR = join(import.meta.dir, "../../USER/WORKFLOWS")

/** When the daily, weekly and monthly reviews run next, read from their workflow definitions; null when one is unreadable. */
export function nextRuns(now: Date, dir = WORKFLOW_DIR): Record<"daily" | "weekly" | "monthly", string | null> {
  const one = (cadence: string) => {
    const file = join(dir, `review-${cadence}.workflow.yaml`)
    if (!existsSync(file)) return null
    const cron = /cron:\s*"([^"]+)"/.exec(readFileSync(file, "utf8"))?.[1]
    return cron ? nextCronRun(cron, now) : null
  }
  return { daily: one("daily"), weekly: one("weekly"), monthly: one("monthly") }
}

let cache: { at: number; body: unknown } | null = null
const TTL_MS = 60_000

export function start(): void {}
export function stop(): void {}
export function health(): { status: string } { return { status: "healthy" } }

export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  const sub = pathname.replace(/^\/api\/review/, "") || "/"
  if (req.method === "GET" && sub === "/") {
    if (!cache || Date.now() - cache.at > TTL_MS) cache = { at: Date.now(), body: status(liveDeps()) }
    // The queue is read fresh so an accept or reject on /api/upgrades shows on the next load.
    const base = cache.body as { watches?: WatchLike[] }
    const records = listUpgrades()
    const closed = buildClosed(records)
    // Every rec, not just the recent ones status() lists, so a rollback filed long ago still reads as filed.
    const recs = loadRecs().recs
    const now = Date.now()
    return Response.json({
      ...base,
      watches: (base.watches ?? []).map((w) => { const o = watchOutcomeFor(w, recs, now); return { ...w, sentence: o.sentence, outcome: o.kind } }),
      queue: buildQueue(records, listPending()), applied: buildApplied(records, base.watches ?? [], now, recs),
      closed: closed.items, closed_total: closed.total, next_runs: nextRuns(new Date(now)),
    })
  }
  const detail = sub.match(/^\/detail\/([^/]+)$/)
  if (req.method === "GET" && detail) {
    const d = buildDetail(decodeURIComponent(detail[1]), listUpgrades(), listPending())
    return d ? Response.json(d) : Response.json({ error: "not_found" }, { status: 404 })
  }
  if (req.method === "POST" && sub === "/decide") {
    const body = (await req.json().catch(() => null)) as { id?: unknown; decision?: unknown; note?: unknown } | null
    if (!body || typeof body.id !== "string" || (body.decision !== "y" && body.decision !== "n")) return Response.json({ error: "id and decision y|n required" }, { status: 400 })
    try {
      const rec = decide(liveDeps(), body.id, body.decision === "y", typeof body.note === "string" ? body.note.slice(0, 500) : undefined)
      cache = null
      return Response.json({ ok: true, rec })
    } catch (e) { return Response.json({ error: String((e as Error).message ?? e) }, { status: 409 }) }
  }
  if (req.method === "POST" && sub === "/label") {
    const body = (await req.json().catch(() => null)) as { id?: unknown; right?: unknown } | null
    if (!body || typeof body.id !== "string" || typeof body.right !== "boolean") return Response.json({ error: "id and right:boolean required" }, { status: 400 })
    try {
      const batch = label(liveDeps(), body.id, body.right)
      cache = null
      return Response.json({ ok: true, agreement: detectorAgreement(batch) })
    } catch (e) { return Response.json({ error: String((e as Error).message ?? e) }, { status: 404 }) }
  }
  return null
}
