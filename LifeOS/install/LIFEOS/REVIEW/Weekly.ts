/**
 * Weekly — the three decisions most worth the principal's yes.
 *
 * Every generator's output for the week goes into one pool. The pool is merged by claim, ranked in
 * code by sessions affected × severity × chance the fix lands ÷ minutes to decide, and the top of it
 * goes to one OpenAI-lane model call through the Superior lens. Every answer is gated in code: real
 * evidence ids, a fix type, and a prediction on a catalog metric large enough to be detectable.
 * Open decisions (changes and rollbacks) never exceed three; one deletion slot sits beside them.
 *
 * @version 1.3.0
 *
 * 1.3.0: producer vigil-advocate (the continuous advocate's recommendation rows in STATVS).
 *
 * Uses Assay's judgment layer (LIFEOS/DOCUMENTATION/Assay/AssaySystem.md).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { getClaudeDir } from "../TOOLS/Paths";
import { claimKey, FIX_TYPES, type FixType, type Prediction, type Rec } from "./Store";
import type { SourceRead } from "./Sources";
import { isMetric, METRICS, type MetricId } from "./Metrics";

const DAY = 86_400_000;
export const MAX_OPEN_CHANGES = 3;
export const EXPIRE_DAYS = 14;
export const COOLDOWN_DAYS = 30;

export interface Candidate {
  id: string; generator: string; claim: string; evidence: string[];
  sessions: number; severity: 1 | 2 | 3; p_land: number; minutes: number; key?: string;
}

export interface UpgradeLike { id: string; source: string; status: string; created: string; claim: string; confidence?: number; evidence?: string[]; ledger_id?: string | null; notes?: string[]; target_surface?: string }
export interface IdealRecLike { id: string; status: string; created: string; kind?: string; title?: string; text?: string; why?: string }
export interface V4RecLike { title?: string; change?: string; target?: string; sessions?: number; count?: number }
export interface HillLike { score: number; type: string; target: string; evidence?: string }
export interface AlarmLike { rule: string; date: string; detail: string; value: number; class?: string }
export interface AuditProposalLike { failure_class: string; title?: string; change?: { target?: string; what?: string }; confidence?: number; count?: number; distinct_sessions?: number; exemplar_ids?: string[]; error?: string }
export interface TriageClusterLike { date: string; system: string; class: string; entries: number; ids: string[]; fix: string; max_upset: number }
export interface SocratesFindingLike { id: number; question_id: string; instance_key: string; first_seen: string; last_value: string | null; text?: string; severity?: string }
export interface HypothesisLike { slug: string; claim: string; confidence: number; evidence: string[]; generated: string }
export interface AdvocateRecLike { id: string; ts: string; decision: string; advocate: string; change: string; why: string; target?: string }
export interface VigilRecLike { id: string; source: string; ts: string; severity: string; title: string; summary: string; dedup_key: string; meta?: Record<string, unknown> }

/** A reader's result: a bare list is a source that was read; a SourceRead says whether it was and why not. */
export type Readable<T> = T[] | SourceRead<T>;

/** One reader per producer; `LIFEOS/REVIEW/sources.json` lists each by this key, and `Review.ts sources` holds the two equal. */
export interface PoolSources {
  upgrades: () => Readable<UpgradeLike>;
  idealRecs: () => Readable<IdealRecLike>;
  v4Recs: () => { date: string; recs: V4RecLike[]; read?: boolean; detail?: string };
  hills: () => Readable<HillLike>;
  alarms: () => Readable<AlarmLike>;
  auditProposals: () => Readable<AuditProposalLike>;
  triageClusters: () => Readable<TriageClusterLike>;
  socrates: () => Readable<SocratesFindingLike>;
  hypotheses: () => Readable<HypothesisLike>;
  modelAdvisor: () => Readable<VigilRecLike>;
  shadowExpiry: () => Readable<VigilRecLike>;
  vigilAdvocate: () => Readable<AdvocateRecLike>;
}
export type SourceKey = keyof PoolSources;

/** Per source in the weekly run record (ISC-68, ISC-72): pool items it gave and whether it was read at all. */
export interface SourceStat { items: number; read: boolean; detail?: string }

/** The principal's standing directives are orders already given, never questions to put back to them (ISC-61). */
export const NOT_A_QUESTION = new Set(["directive"]);

const SEVERITY: Record<string, 1 | 2 | 3> = { critical: 3, high: 3, medium: 2, low: 1 };

/** A reader that throws is unread, with its error, so one broken producer never empties the whole pool. */
function take<T>(read: () => Readable<T>): SourceRead<T> {
  try {
    const r = read();
    return Array.isArray(r) ? { items: r, read: true } : r;
  } catch (e) { return { items: [], read: false, detail: `reader failed: ${String((e as Error).message ?? e).slice(0, 200)}` }; }
}

// ── Vigil digests: one event, N recommendations (ISC-71) ────────────────────

export interface VigilItem { key: string; text: string }

/**
 * The model advisor's digest: the dedup key ends with every new recommendation's
 * key (`<current id>-><candidate slug>`, sorted, `|`-joined) and the summary carries one ` · `-separated
 * line per recommendation for the first five. Each key is an item; its text is the line naming its
 * current model, or the key itself when the summary cut it off.
 */
function modelAdvisorItems(e: VigilRecLike): VigilItem[] | null {
  const m = e.dedup_key.match(/^model-advisor:\d{4}-\d{2}-\d{2}:(.+)$/);
  const keys = m ? m[1].split("|").filter(Boolean) : [];
  if (!keys.length || !keys.every((k) => k.includes("->"))) return null;
  const lines = e.summary.replace(/\. Source: [\s\S]*$/, "").split(" · ").filter((l) => !/^and \d+ more$/.test(l.trim()));
  return keys.map((key) => {
    const from = key.slice(0, key.indexOf("->")), to = key.slice(key.indexOf("->") + 2);
    const line = lines.find((l) => l.includes(`: ${from} → `));
    return { key, text: `Model upgrade worth a look: ${line ?? `${from} → ${to} (detail cut from the digest: run the model advisor for the full list)`}` };
  });
}

/**
 * ShadowExpiry's digest (ShadowExpiry.expiredEvent): `Past expiry, decide promote or kill: <name> (since
 * <date>), …` and `Registered but never ran, candidates to delete: <name>, …`. Each switch is an item keyed
 * by its name. The title states the total; when the 1000-character cap cut names off the end, the
 * unnamed rest stay as items so the count at the source survives (ISC-62).
 */
function shadowExpiryItems(e: VigilRecLike): VigilItem[] | null {
  const s = e.summary, truncated = s.endsWith("...");
  const segment = (lead: string) => {
    const i = s.indexOf(lead);
    if (i < 0) return null;
    const rest = s.slice(i + lead.length);
    const end = rest.search(/\. (?:Registered but never ran|Evidence per caller)/);
    return { text: end < 0 ? rest.replace(/\.{3}$/, "") : rest.slice(0, end), last: end < 0 };
  };
  const items: VigilItem[] = [];
  const stale = segment("Past expiry, decide promote or kill: ");
  if (stale) for (const m of stale.text.matchAll(/([\w.:-]+) \(since (\d{4}-\d{2}-\d{2})\)/g))
    items.push({ key: m[1], text: `Shadow switch ${m[1]} is past expiry (in shadow since ${m[2]}): promote it or kill it. Evidence: bun LIFEOS/ASSAY/Assay.ts report --caller ${m[1]}` });
  const never = segment("Registered but never ran, candidates to delete: ");
  if (never) {
    const names = never.text.replace(/\.$/, "").split(", ").filter((n) => /^[\w.:-]+$/.test(n));
    // A name at the very end of a cut summary may itself be cut.
    if (truncated && never.last) names.pop();
    for (const n of names) items.push({ key: n, text: `Shadow switch ${n} is registered but never ran: a candidate to delete` });
  }
  if (!items.length) return null;
  const named = items.length, total = Number(e.title.match(/^(\d+) shadow switch/)?.[1] ?? named);
  for (let i = 1; i <= total - named; i++)
    items.push({ key: `${e.dedup_key}#unnamed-${i}`, text: `Shadow switch past expiry whose name the digest cut off (${i} of ${total - named}): list them all with bun LIFEOS/TOOLS/ShadowExpiry.ts check` });
  return items;
}

/** The separate recommendations one Vigil event lists; an event with no recognizable structure is one item. */
export function vigilItems(e: VigilRecLike): VigilItem[] {
  const split = e.source === "model-advisor" ? modelAdvisorItems(e) : e.source === "shadow-expiry" ? shadowExpiryItems(e) : null;
  return split ?? [{ key: e.dedup_key, text: `${e.title}: ${e.summary}` }];
}

/** The pool plus, per source, how many items it gave and whether it was read. */
export function poolWithSources(src: PoolSources, now: Date): { pool: Candidate[]; sources: Record<SourceKey, SourceStat> } {
  const weekAgo = now.getTime() - 7 * DAY;
  const pool: Candidate[] = [];
  const sources = {} as Record<SourceKey, SourceStat>;
  /** Reads one source and records its stat; `add` pushes that source's items and returns how many. */
  const from = <T>(key: SourceKey, read: () => Readable<T>, add: (items: T[]) => number) => {
    const r = take(read);
    const items = add(r.items);
    sources[key] = { items, read: r.read, ...(r.detail ? { detail: r.detail } : {}) };
  };
  const push = (c: Candidate) => { pool.push(c); return 1; };
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  from("upgrades", src.upgrades, (us) => sum(us.map((u) => (u.status === "recommended" && Date.parse(u.created) >= weekAgo && !NOT_A_QUESTION.has(u.source)
    ? push({ id: `upgrade:${u.id}`, generator: `upgrades:${u.source}`, claim: u.claim, evidence: [u.id, ...(u.evidence ?? [])], sessions: Math.max(1, (u.evidence ?? []).length), severity: 2, p_land: u.confidence ?? 0.5, minutes: 2 }) : 0))));
  from("idealRecs", src.idealRecs, (rs) => sum(rs.map((r) => (r.status === "open"
    // A needs-input row (current-ideal delta ISC-57) is a decision only he can make, so it outranks an ordinary proposal.
    ? push({ id: `ideal:${r.id}`, generator: "ideal-state", claim: r.title ?? r.text ?? r.why ?? r.id, evidence: [r.id], sessions: 1, severity: r.kind === "needs-input" ? 3 : 2, p_land: 0.5, minutes: 3 }) : 0))));
  {
    let v4: ReturnType<PoolSources["v4Recs"]>;
    try { v4 = src.v4Recs(); } catch (e) { v4 = { date: "", recs: [], read: false, detail: `reader failed: ${String((e as Error).message ?? e).slice(0, 200)}` }; }
    v4.recs.forEach((r, i) => push({ id: `v4:${v4.date}:${i}`, generator: "errata-v4", claim: [r.title, r.change].filter(Boolean).join(": "), evidence: [`v4:${v4.date}:${i}`], sessions: r.sessions ?? r.count ?? 1, severity: 2, p_land: 0.5, minutes: 3 }));
    sources.v4Recs = { items: v4.recs.length, read: v4.read ?? true, ...(v4.detail ? { detail: v4.detail } : {}) };
  }
  from("hills", src.hills, (hs) => sum(hs.map((h) => {
    const m = h.evidence?.match(/in (\d+) sessions/);
    return push({ id: `hill:${h.type}:${h.target}`, generator: "hillclimb", claim: `${h.type} ${h.target}: ${h.evidence ?? ""}`.slice(0, 400), evidence: [`hill:${h.type}:${h.target}`], sessions: m ? Number(m[1]) : Math.max(1, Math.round(h.score / 10)), severity: h.score >= 90 ? 3 : 2, p_land: 0.5, minutes: 5 });
  })));
  from("alarms", src.alarms, (as) => sum(as.map((a) => (Date.parse(a.date) >= weekAgo - DAY
    ? push({ id: `alarm:${a.date}:${a.rule}${a.class ? `:${a.class}` : ""}`, generator: "review-daily", claim: a.detail, evidence: [`alarm:${a.date}:${a.rule}`], sessions: Math.max(1, Math.round(a.value)), severity: 3, p_land: 0.5, minutes: 3 }) : 0))));
  from("auditProposals", src.auditProposals, (ps) => sum(ps.map((p) => {
    const id = `audit:${p.failure_class}`;
    return push({ id, generator: "errata-audit", claim: [p.title, p.change?.what].filter(Boolean).join(": ").slice(0, 400), evidence: [id, ...(p.exemplar_ids ?? []).slice(0, 8)], sessions: Math.max(1, p.distinct_sessions ?? p.count ?? 1), severity: 2, p_land: p.confidence ?? 0.5, minutes: 3 });
  })));
  from("triageClusters", src.triageClusters, (ts) => sum(ts.map((t) => {
    const id = `triage:${t.date}:${t.system}:${t.class}`;
    return push({ id, generator: "errata-triage", claim: (t.fix || `${t.class} in ${t.system}`).slice(0, 400), evidence: [id, ...t.ids], sessions: Math.max(1, t.entries), severity: t.max_upset >= 3 ? 3 : 2, p_land: 0.5, minutes: 3 });
  })));
  from("socrates", src.socrates, (fs) => sum(fs.map((f) => {
    const id = `socrates:${f.question_id}|${f.instance_key}#${f.id}`;
    return push({ id, generator: "socrates", claim: `${f.text ?? f.question_id}${f.instance_key ? ` (${f.instance_key})` : ""}: failing since ${f.first_seen.slice(0, 10)}${f.last_value ? `, last value ${f.last_value}` : ""}`.slice(0, 400), evidence: [id], sessions: 1, severity: SEVERITY[f.severity ?? ""] ?? 2, p_land: 0.5, minutes: 3 });
  })));
  from("hypotheses", src.hypotheses, (hs) => sum(hs.map((h) => {
    const id = `hypothesis:${h.slug}`;
    return push({ id, generator: "deriver", claim: h.claim.replace(/\s+/g, " ").slice(0, 400), evidence: [id, ...h.evidence.slice(0, 10)], sessions: Math.max(1, h.evidence.length), severity: 2, p_land: h.confidence, minutes: 3 });
  })));
  // Each digest becomes one item per recommendation it lists. A recommendation that two digests in the
  // week both name (the same switch in two weekly digests) is one item, from the newest event.
  for (const [key, generator] of [["modelAdvisor", "model-advisor"], ["shadowExpiry", "shadow-expiry"]] as const)
    from(key, src[key], (events) => {
      const seen = new Set<string>();
      let n = 0;
      for (const e of [...events].filter((x) => Date.parse(x.ts) >= weekAgo).sort((a, b) => b.ts.localeCompare(a.ts)))
        for (const item of vigilItems(e)) {
          const id = `${generator}:${item.key}`;
          if (seen.has(id)) continue;
          seen.add(id);
          n += push({ id, generator, claim: item.text, evidence: [id], sessions: 1, severity: 2, p_land: 0.5, minutes: 2 });
        }
      return n;
    });
  // The continuous advocate (Vigil F16, ISC-441): each change an advocate run proposed and did not make is
  // one item, keyed by the decision it came from and the change, so the same proposal twice is one item.
  from("vigilAdvocate", src.vigilAdvocate, (recs) => {
    const seen = new Set<string>();
    let n = 0;
    for (const r of [...recs].filter((x) => Date.parse(x.ts) >= weekAgo).sort((a, b) => b.ts.localeCompare(a.ts))) {
      const id = `vigil-advocate:${r.decision}:${createHash("sha256").update(claimKey(r.change)).digest("hex").slice(0, 12)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      n += push({ id, generator: "vigil-advocate", claim: `${r.change}${r.why ? ` (why: ${r.why})` : ""}`.replace(/\s+/g, " ").slice(0, 400), evidence: [id, r.id], sessions: 1, severity: 2, p_land: 0.5, minutes: 3 });
    }
    return n;
  });
  return { pool, sources };
}

export const buildPool = (src: PoolSources, now: Date): Candidate[] => poolWithSources(src, now).pool;

/** The decisions that share the cap of three (ISC-17, ISC-70): changes and rollbacks. The deletion slot sits beside them. */
export const takesDecisionSlot = (r: Pick<Rec, "kind">): boolean => r.kind === "change" || r.kind === "rollback";

/** The producer an item came from: the id's first segment, which sources.json names as each producer's `prefix`. */
export const producerOf = (c: Pick<Candidate, "id">): string => c.id.slice(0, c.id.indexOf(":"));

export const value = (c: Candidate): number => c.sessions * c.severity * c.p_land / c.minutes;

/** Same normalized claim from different generators becomes one candidate holding every source id. */
export function dedupe(pool: Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate & { generators: Set<string> }>();
  for (const c of pool) {
    const key = claimKey(c.claim) || c.id;
    const have = byKey.get(key);
    if (!have) { byKey.set(key, { ...c, key, generators: new Set([c.generator]) }); continue; }
    have.evidence = [...new Set([...have.evidence, ...c.evidence])];
    have.sessions = Math.max(have.sessions, c.sessions);
    have.severity = Math.max(have.severity, c.severity) as 1 | 2 | 3;
    have.generators.add(c.generator);
    have.generator = [...have.generators].join("+");
  }
  return [...byKey.values()].map(({ generators: _g, ...c }) => c);
}

/** A declined idea stays down for 30 days unless it comes back with evidence the declined one lacked. */
export function applyCooldown(pool: Candidate[], recs: Rec[], now: Date): Candidate[] {
  const recent = recs.filter((r) => r.status === "dismissed" && r.decided && now.getTime() - Date.parse(r.decided) < COOLDOWN_DAYS * DAY);
  return pool.filter((c) => !recent.some((r) => r.key === c.key && c.evidence.every((e) => r.evidence.includes(e))));
}

export const rank = (pool: Candidate[]): Candidate[] => [...pool].sort((a, b) => value(b) - value(a));

// ── The model call and its gates ────────────────────────────────────────────

export interface RawRec { title?: unknown; change?: unknown; fix_type?: unknown; target?: unknown; evidence?: unknown; why_not_check?: unknown; prediction?: unknown }
export interface Rejected { title: string; reason: string }

/** Minimum detectable change for a metric over a window of `spanMs`, from current data. */
export type MdeFor = (metric: MetricId, args: Record<string, string> | undefined, spanMs: number) => { mde_pct: number; baseline: number | null };

export function gate(raw: RawRec[], pool: Candidate[], mdeFor: MdeFor, now: Date, slots: number): { accepted: Rec[]; rejected: Rejected[] } {
  const ids = new Set(pool.flatMap((c) => [c.id, ...c.evidence]));
  const byId = new Map(pool.map((c) => [c.id, c]));
  const accepted: Rec[] = [], rejected: Rejected[] = [];
  for (const r of raw) {
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const reject = (reason: string) => rejected.push({ title: title || "(untitled)", reason });
    if (!title || typeof r.change !== "string" || !r.change.trim()) { reject("missing title or change"); continue; }
    const evidence = Array.isArray(r.evidence) ? r.evidence.filter((e): e is string => typeof e === "string") : [];
    if (!evidence.length || !evidence.every((e) => ids.has(e))) { reject("evidence ids not in the pool"); continue; }
    if (!FIX_TYPES.includes(r.fix_type as FixType)) { reject("fix_type not delete|tool|check|prose"); continue; }
    const fix = r.fix_type as FixType;
    const whyNot = typeof r.why_not_check === "string" ? r.why_not_check.trim() : "";
    if (fix === "prose" && whyNot.length < 20) { reject("prose without a reason no check can catch it"); continue; }
    const p = r.prediction as Partial<Prediction> | undefined;
    if (!p || typeof p.metric !== "string" || !isMetric(p.metric)) { reject("prediction metric not in catalog"); continue; }
    if (p.direction !== "down" && p.direction !== "up") { reject("prediction direction"); continue; }
    if (!(typeof p.size_pct === "number" && p.size_pct > 0)) { reject("prediction size"); continue; }
    if (!(typeof p.p === "number" && p.p > 0 && p.p < 1)) { reject("prediction probability"); continue; }
    const due = typeof p.due === "string" ? Date.parse(p.due) : NaN;
    if (!(due >= now.getTime() + 7 * DAY && due <= now.getTime() + 92 * DAY)) { reject("prediction due date outside 7-92 days"); continue; }
    const args = p.args && typeof p.args === "object" ? Object.fromEntries(Object.entries(p.args).filter(([, v]) => typeof v === "string")) as Record<string, string> : undefined;
    if ((p.metric === "class_rate" && !args?.class) || (p.metric === "rule_breaks" && !args?.rule) || (p.metric === "skill_complaint_rate" && !args?.skill)) { reject("prediction args missing"); continue; }
    const { mde_pct, baseline } = mdeFor(p.metric, args, due - now.getTime());
    if (!(p.size_pct >= mde_pct)) { reject(`predicted ${p.size_pct}% is inside the detectable ±${mde_pct}%`); continue; }
    if (accepted.length >= slots) { reject("weekly cap reached"); continue; }
    const generators = [...new Set(evidence.map((e) => byId.get(e)?.generator).filter((g): g is string => !!g))];
    accepted.push({
      id: `rv-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`,
      kind: "change", status: "open", created: now.toISOString(), title, change: r.change.trim(), fix_type: fix,
      target: typeof r.target === "string" ? r.target : "", why_not_check: whyNot || undefined,
      evidence, generators: generators.length ? generators : ["review"], key: claimKey(title + " " + r.change),
      prediction: { metric: p.metric, args, direction: p.direction, size_pct: p.size_pct, p: p.p, due: new Date(due).toISOString().slice(0, 10), baseline: baseline ?? undefined, mde_pct },
    });
  }
  return { accepted, rejected };
}

function superiorLens(): string {
  try {
    const text = readFileSync(join(getClaudeDir(), "skills/Superior/SKILL.md"), "utf8");
    const m = text.match(/## The Superior Mind\n([\s\S]*?)\n## /);
    return m ? m[1].trim() : "";
  } catch { return ""; }
}

export function buildPrompt(top: Candidate[], slots: number, baselines: Record<string, unknown>, now: Date): { system: string; user: string } {
  const system = [
    "You are the weekly Review for LifeOS, a personal AI system. You pick the changes most worth the principal's yes this week.",
    "Think as this mind would:", superiorLens(),
    `Return at most ${slots} recommendations. Fewer is fine; zero is fine when nothing clears the bar.`,
    "Prefer, in order: delete something, fix a tool, add a check (an assert, eval row, Glance question or gate), and only then prose. Prose needs why_not_check: why no check can catch the problem.",
    "Every recommendation predicts one number from this catalog moving by a stated percent by a due date 7-90 days out, with a probability. Predictions smaller than the detectable change given below are rejected; pick a metric and window that can see the effect.",
    `Catalog: ${JSON.stringify(METRICS)}`,
    "Return JSON only: {\"recommendations\":[{\"title\":\"one plain sentence\",\"change\":\"the exact change or brief\",\"fix_type\":\"delete|tool|check|prose\",\"target\":\"file or system\",\"why_not_check\":\"only for prose\",\"evidence\":[\"pool ids\"],\"prediction\":{\"metric\":\"…\",\"args\":{},\"direction\":\"down|up\",\"size_pct\":30,\"p\":0.6,\"due\":\"YYYY-MM-DD\"}}]}",
  ].join("\n\n");
  const user = [
    `Today: ${now.toISOString().slice(0, 10)}`,
    `Current baselines (last 14 days) and detectable change for a 28-day window: ${JSON.stringify(baselines)}`,
    "Pool, ranked by sessions × severity × chance ÷ minutes (id · generator · sessions · claim):",
    ...top.map((c) => `- ${c.id} · ${c.generator} · ${c.sessions} · ${c.claim.replace(/\s+/g, " ").slice(0, 300)}`),
  ].join("\n");
  return { system, user };
}

// ── Deletion candidate, expiry, what worked ─────────────────────────────────

/**
 * A generator is dead when 5+ of its last-60-day records were rejected and none landed. Records still
 * open or expired by the stale sweep prove nothing, since nobody said no to them: work is often done in the session that heard it and
 * the record never closed ("directive" records the principal's own words, and most of them stay open).
 * Directives are never candidates at all: retiring the source of his standing orders would re-ask them.
 */
export function deletionCandidate(upgrades: UpgradeLike[], now: Date): Rec | null {
  const since = now.getTime() - 60 * DAY;
  const by = new Map<string, { n: number; landed: number; refused: number }>();
  for (const u of upgrades) {
    if (Date.parse(u.created) < since || NOT_A_QUESTION.has(u.source)) continue;
    const g = by.get(u.source) ?? { n: 0, landed: 0, refused: 0 };
    g.n++;
    if (["accepted", "applied", "verified"].includes(u.status)) g.landed++;
    if (u.status === "rejected") g.refused++;
    by.set(u.source, g);
  }
  const dead = [...by].filter(([, g]) => g.refused >= 5 && g.landed === 0).sort((a, b) => b[1].refused - a[1].refused)[0];
  if (!dead) return null;
  const [source, g] = dead;
  const title = `Retire or fix the "${source}" generator: ${g.refused} of its ${g.n} recommendations in 60 days were rejected, none accepted`;
  return {
    id: `rv-${now.toISOString().slice(0, 10).replace(/-/g, "")}-del-${randomBytes(2).toString("hex")}`,
    kind: "deletion", status: "open", created: now.toISOString(), title, fix_type: "delete",
    change: `Stop the ${source} source from filing Upgrades records, or fix what it files so they get accepted. It costs queue space and attention and has landed nothing.`,
    target: `Upgrades source: ${source}`, evidence: [`upgrades:${source}`], generators: ["review"], key: claimKey(title),
  };
}

export function expire(recs: Rec[], now: Date): Rec[] {
  return recs.map((r) => (r.status === "open" && now.getTime() - Date.parse(r.created) > EXPIRE_DAYS * DAY ? { ...r, status: "expired" as const, decided: now.toISOString() } : r));
}

export function whatWorked(recs: Rec[], since: string | null): Rec[] {
  return recs.filter((r) => r.score?.result === "hit" && (!since || r.score.ts > since));
}
