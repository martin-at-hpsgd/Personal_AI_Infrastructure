/**
 * Cluster.ts — group diagnosed defects by what one fix would remove (Errata ISA F6, ISC-47).
 *
 * Glance caller named errata-coverage (shadow), question `same_root_cause`. See
 * LIFEOS/DOCUMENTATION/Assay/AssaySystem.md, section The caller contract. Fail-open: a failed pair
 * is an error row the next run retries, and an unanswered pair simply does not merge.
 *
 * Buckets are keyed by code, never by free text: `rule:<rule id>` when coverage names the rule the
 * failure broke, else `class:<primary class>|<component>`, where the component is read
 * deterministically from the complaint, then the reply, then the tool calls (a hook, skill,
 * LifeOS tool, LifeOS subsystem or file named there; `none` when nothing is). Failures that predate
 * their covering rule stay out: a rule written since already answers them.
 *
 * A rule bucket is one cluster: its key already names the root cause (that rule was ignored) and
 * the fix (enforce it). Splitting it by root cause was tried on a real corpus on 2026-09-27 and
 * shattered a single rule's failures into singletons, because the reasons a rule is
 * ignored vary while the fix does not. A class × component bucket is coarse (a large share of
 * defects name no component), so it is split: each member is paired with its PAIRS_PER_MEMBER nearest
 * neighbours by TF-IDF cosine of complaint and reply (pairs grow linearly, at most PAIRS_PER_MEMBER
 * per member), Glance asks `same_root_cause` of every pair not already answered (judgeMany pools),
 * and a union-find merges the pairs whose answer reaches the registry cut. Each connected component
 * is one cluster (`split: true`). Clusters rank by distinct sessions × (1 + mean severity).
 * Pair answers persist in LIFEOS/USER/ERRATA/v4/pairs.jsonl; clusters are written to
 * clusters-<date>.jsonl. The pair state carries no id, session id or home path, passes
 * `redactForEngine`, and is at most STATE_MAX chars (ISC-50).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { judgeMany, type CallerConfig } from "../ASSAY/Assay";
import { invariant } from "../TOOLS/Invariant";
import { v4Dir, type Exchange } from "./Exchanges";
import { exchangeView, STATE_MAX } from "./Triage4";
import { ACT_CALLER, SAME_ROOT_CAUSE, sameRootCause, type ActCuts, type FixType } from "./ActQuestions";
import { actCaller, type CoverageEntry, type Failure } from "./Coverage";
import { tokens } from "./Rules";

const CALL_TIMEOUT_MS = 15_000;
/** Nearest neighbours each member is paired with inside its bucket. */
export const PAIRS_PER_MEMBER = 3;
const PAIR_CHUNK = 500;

// ── Components ──────────────────────────────────────────────────────────────

const COMPONENT_PATTERNS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/\bhooks\/(?:lib\/)?([A-Za-z0-9_-]+?)(?:\.hook)?\.ts\b/, (m) => `hook:${m[1]}`],
  [/\b([A-Z][A-Za-z0-9]+)\.hook\.ts\b/, (m) => `hook:${m[1]}`],
  [/\bskills\/([A-Za-z0-9_]+)\//, (m) => `skill:${m[1]}`],
  [/\bSkill\(\s*["']?([A-Za-z0-9_:-]+)/, (m) => `skill:${m[1]}`],
  [/\bLIFEOS\/TOOLS\/([A-Za-z0-9_-]+)\.ts\b/, (m) => `tool:${m[1]}`],
  [/\bLIFEOS\/(?!USER\/|MEMORY\/|DOCUMENTATION\/)([A-Z][A-Z_]+)\//, (m) => `system:${m[1]}`],
  [/\b([A-Za-z0-9_-]+\.(?:ts|md|json|yaml|toml|sh))\b/, (m) => `file:${m[1]}`],
];

/** The first component a text names, by pattern priority (hook, skill, tool, subsystem, file). Pure. */
export function componentIn(text: string): string | null {
  for (const [re, name] of COMPONENT_PATTERNS) {
    const m = re.exec(text);
    if (m) return name(m);
  }
  return null;
}

/**
 * The hook-fed memory status line ("🧠 MEMORY: … · due: TELOS.md (never reviewed) · …") ends most
 * replies and names the same file every time; it says nothing about what the reply did.
 */
const MEMORY_STATUS_RE = /🧠\s*MEMORY:[^\n🗣]*/gu;

/** The component an exchange's failure is about: named in the complaint, else the reply end, else the tool calls. Pure. */
export function componentOf(ex: Pick<Exchange, "prompt" | "reply_tail" | "tools">): string {
  return componentIn(ex.prompt) ?? componentIn(ex.reply_tail.replace(MEMORY_STATUS_RE, " ")) ?? componentIn(ex.tools.map((t) => t.summary).join(" ")) ?? "none";
}

// ── Buckets ─────────────────────────────────────────────────────────────────

export type Bucket = { key: string; rule: string | null; fix_type: FixType; members: Failure[] };

/** Pure: the bucket key of a failure, or null while its coverage is unknown or it predates its covering rule. */
export function bucketKeyOf(f: Failure, table: Map<string, CoverageEntry>): string | null {
  const e = table.get(f.ex.id);
  if (!e?.coverage || e.predates) return null;
  return e.coverage.covered ? `rule:${e.coverage.rule}` : `class:${f.dx.primary}|${componentOf(f.ex)}`;
}

/** Pure: the code-keyed bucket of every failure whose coverage is known and that does not predate its rule. */
export function bucketsOf(failures: Failure[], table: Map<string, CoverageEntry>): Bucket[] {
  const out = new Map<string, Bucket>();
  for (const f of failures) {
    const key = bucketKeyOf(f, table);
    if (key === null) continue;
    const e = table.get(f.ex.id)!;
    const b = out.get(key) ?? { key, rule: e.coverage!.covered ? e.coverage!.rule : null, fix_type: e.coverage!.fix_type, members: [] };
    b.members.push(f);
    out.set(key, b);
  }
  return [...out.values()];
}

/** Whether a bucket is split by root cause: a class bucket with more than one member. Pure. */
export const splits = (b: Bucket): boolean => b.rule === null && b.members.length > 1;

export const sessionsOf = (fs: Failure[]): number => new Set(fs.map((f) => f.ex.session)).size;
export const meanSeverity = (fs: Failure[]): number => (fs.length ? fs.reduce((s, f) => s + f.dx.severity, 0) / fs.length : 0);
/** The rank of a group of failures: distinct sessions × (1 + mean severity). Pure. */
export const rankScore = (fs: Failure[]): number => sessionsOf(fs) * (1 + meanSeverity(fs));

// ── Candidate pairs ─────────────────────────────────────────────────────────

export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
const pairText = (ex: Exchange): string => `${ex.prompt}\n${ex.prompt}\n${ex.reply_tail}`;

/** Pure: each member's PAIRS_PER_MEMBER nearest others by TF-IDF cosine, as unordered id pairs, deduped. */
export function candidatePairs(members: Exchange[], perMember = PAIRS_PER_MEMBER): [string, string][] {
  const docs = members.map((m) => { const tf = new Map<string, number>(); for (const t of tokens(pairText(m))) tf.set(t, (tf.get(t) ?? 0) + 1); return tf; });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const vecs = docs.map((d) => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, f] of d) { const w = (1 + Math.log(f)) * Math.log(1 + n / (df.get(t) ?? 1)); v.set(t, w); norm += w * w; }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });
  const cos = (a: Map<string, number>, b: Map<string, number>): number => { let s = 0; for (const [t, w] of a) s += w * (b.get(t) ?? 0); return s; };
  const out = new Map<string, [string, string]>();
  for (let i = 0; i < n; i++) {
    const near = members.map((_, j) => ({ j, s: j === i ? -1 : cos(vecs[i]!, vecs[j]!) }))
      .filter((x) => x.j !== i).sort((a, b) => b.s - a.s || a.j - b.j).slice(0, perMember);
    for (const { j } of near) {
      const a = members[i]!.id, b = members[j]!.id;
      out.set(pairKey(a, b), a < b ? [a, b] : [b, a]);
    }
  }
  return [...out.values()].sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));
}

const head = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)} …` : s);
const tail = (s: string, n: number): string => (s.length > n ? `… ${s.slice(-n)}` : s);

/** JSON state for one pair: each failure's message and the reply end it reacts to, at most STATE_MAX chars. Pure. */
export function pairState(a: Exchange, b: Exchange): string {
  const va = exchangeView(a), vb = exchangeView(b);
  const lim = { message: 800, reply: 550 };
  for (let round = 0; round < 40; round++) {
    const side = (v: ReturnType<typeof exchangeView>) => ({ assistant_previous_reply_end: tail(v.assistant_previous_reply_end, lim.reply), user_message: head(v.user_message, lim.message) });
    const out = JSON.stringify({ failure_a: side(va), failure_b: side(vb) });
    if (out.length <= STATE_MAX) return out;
    if (lim.reply > 120) lim.reply = Math.floor(lim.reply * 0.7);
    else lim.message = Math.floor(lim.message * 0.8);
  }
  return JSON.stringify({ failure_a: { user_message: head(va.user_message, 300) }, failure_b: { user_message: head(vb.user_message, 300) } }).slice(0, STATE_MAX);
}

// ── Stored pair answers ─────────────────────────────────────────────────────

/** One stored same_root_cause answer; `model` names the engine that answered (rows before 2026-09-27 lack it). */
export type PairRow = { a: string; b: string; ts: string; p?: number; model?: string; error?: string };
export const pairsPath = (dir = v4Dir()): string => join(dir, "pairs.jsonl");

export function validPairRow(x: unknown): x is PairRow {
  if (!x || typeof x !== "object") return false;
  const r = x as PairRow;
  if (!/^X-[0-9a-f]{16}$/.test(r.a) || !/^X-[0-9a-f]{16}$/.test(r.b) || !(r.a < r.b) || typeof r.ts !== "string") return false;
  if (typeof r.error === "string") return r.error.length > 0 && r.p === undefined;
  if (r.model !== undefined && (typeof r.model !== "string" || !r.model)) return false;
  return typeof r.p === "number" && Number.isFinite(r.p) && r.p >= 0 && r.p <= 1;
}

/** Every stored answered pair row, latest per pair, with its model when recorded. */
export function loadPairRows(dir = v4Dir()): Map<string, PairRow> {
  const out = new Map<string, PairRow>();
  const p = pairsPath(dir);
  if (!existsSync(p)) return out;
  for (const l of readFileSync(p, "utf8").split("\n")) {
    if (!l.trim()) continue;
    let r: unknown;
    try { r = JSON.parse(l); } catch { continue; }
    if (validPairRow(r) && r.p !== undefined) out.set(pairKey(r.a, r.b), r);
  }
  return out;
}

export function loadPairs(dir = v4Dir()): Map<string, number> {
  return new Map([...loadPairRows(dir)].map(([k, r]) => [k, r.p!]));
}

// ── Union-find and clusters ─────────────────────────────────────────────────

/** Pure: connected components of `ids` under `edges`, each sorted, largest first then by first id. */
export function components(ids: string[], edges: [string, string][]): string[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; let y = x; while (parent.get(y) !== r) { const n = parent.get(y)!; parent.set(y, r); y = n; } return r; };
  for (const [a, b] of edges) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) (groups.get(find(id)) ?? groups.set(find(id), []).get(find(id))!).push(id);
  return [...groups.values()].map((g) => g.sort()).sort((x, y) => y.length - x.length || x[0]!.localeCompare(y[0]!));
}

export type Cluster = {
  key: string; bucket: string; rule: string | null; fix_type: FixType; primary: string; component: string | null;
  members: string[]; count: number; sessions: number; severity: Record<"0" | "1" | "2" | "3", number>; mean_severity: number; score: number; split: boolean;
};

function toCluster(bucket: Bucket, members: Failure[], index: number, split: boolean): Cluster {
  const classes = new Map<string, number>();
  for (const f of members) classes.set(f.dx.primary, (classes.get(f.dx.primary) ?? 0) + 1);
  const primary = [...classes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  const severity = { "0": 0, "1": 0, "2": 0, "3": 0 } as Cluster["severity"];
  for (const f of members) severity[String(f.dx.severity) as keyof Cluster["severity"]]++;
  const comp = bucket.key.startsWith("class:") ? bucket.key.slice(bucket.key.indexOf("|") + 1) : null;
  return {
    key: `${bucket.key}#${index + 1}`, bucket: bucket.key, rule: bucket.rule, fix_type: bucket.fix_type, primary, component: comp,
    members: members.map((f) => f.ex.id), count: members.length, sessions: sessionsOf(members), severity,
    mean_severity: Math.round(meanSeverity(members) * 100) / 100, score: Math.round(rankScore(members) * 100) / 100, split,
  };
}

export function validCluster(c: Cluster): boolean {
  return /^(rule:[a-z]+\.[a-z0-9-]+\.[0-9a-f]{6}(-\d+)?|class:[a-z_]+\|[^\s#]+)#\d+$/.test(c.key) && c.key.startsWith(`${c.bucket}#`) &&
    c.members.length === c.count && c.count > 0 && c.sessions > 0 && c.sessions <= c.count &&
    (c.fix_type === "enforce_rule") === (c.rule !== null) && c.members.every((m) => /^X-[0-9a-f]{16}$/.test(m));
}

/** Pure: clusters from buckets and stored pair answers; a rule bucket stays whole, a multi-member class bucket splits on its merged pairs. */
export function clustersFrom(buckets: Bucket[], pairs: Map<string, number>, cuts: ActCuts): Cluster[] {
  const out: Cluster[] = [];
  buckets.forEach((b) => {
    const split = splits(b);
    if (!split) { out.push(toCluster(b, b.members, 0, false)); return; }
    const byId = new Map(b.members.map((f) => [f.ex.id, f]));
    const edges = candidatePairs(b.members.map((f) => f.ex)).filter(([x, y]) => { const p = pairs.get(pairKey(x, y)); return p !== undefined && sameRootCause(p, cuts); });
    components(b.members.map((f) => f.ex.id), edges).forEach((ids, i) => out.push(toCluster(b, ids.map((id) => byId.get(id)!), i, true)));
  });
  return out.sort((a, b) => b.score - a.score || b.count - a.count || a.key.localeCompare(b.key));
}

// ── The run ─────────────────────────────────────────────────────────────────

export type ClusterOptions = {
  dir?: string; failures: Failure[]; table: Map<string, CoverageEntry>; dryRun?: boolean;
  judge?: typeof judgeMany; cfg?: CallerConfig; cuts?: ActCuts; log?: (s: string) => void; now?: Date;
};
export type ClusterResult = { buckets: number; split_buckets: number; pairs_asked: number; errors: number; clusters: Cluster[]; path: string | null };

export const clustersPath = (dir: string, day: string): string => join(dir, `clusters-${day}.jsonl`);

/** Ask `same_root_cause` of every unanswered candidate pair in every split bucket, then write the clusters. */
export async function cluster(opts: ClusterOptions): Promise<ClusterResult> {
  const dir = opts.dir ?? v4Dir();
  const log = opts.log ?? ((s: string) => process.stderr.write(`${s}\n`));
  const cuts = opts.cuts ?? actCaller(opts.cfg).cuts;
  const buckets = bucketsOf(opts.failures, opts.table);
  const toSplit = buckets.filter(splits);
  const stored = loadPairs(dir);
  const exById = new Map(opts.failures.map((f) => [f.ex.id, f.ex]));
  const todo: [string, string][] = [];
  for (const b of toSplit) for (const pr of candidatePairs(b.members.map((f) => f.ex))) if (!stored.has(pairKey(pr[0], pr[1]))) todo.push(pr);
  let errors = 0;
  if (todo.length && !opts.dryRun) {
    mkdirSync(dir, { recursive: true });
    // One pool per chunk, appended as it lands so a killed run keeps its progress.
    for (let start = 0; start < todo.length; start += PAIR_CHUNK) {
      const slice = todo.slice(start, start + PAIR_CHUNK);
      const items = slice.map(([a, b]) => ({ key: `${a}|${b}`, state: pairState(exById.get(a)!, exById.get(b)!) }));
      const results = await (opts.judge ?? judgeMany)(items, { same_root_cause: SAME_ROOT_CAUSE }, { caller: ACT_CALLER, timeoutMs: CALL_TIMEOUT_MS });
      const byKey = new Map(results.map((r) => [r.key, r]));
      const now = new Date().toISOString();
      const rows: PairRow[] = slice.map(([a, b]) => {
        const r = byKey.get(`${a}|${b}`);
        const ans = r?.result?.same_root_cause?.answer;
        const model = r?.result?.same_root_cause?.model;
        return r && r.error === null && ans?.type === "noul" && Number.isFinite(ans.noul) && ans.noul >= 0 && ans.noul <= 1
          ? { a, b, ts: now, p: ans.noul, ...(model ? { model } : {}) } : { a, b, ts: now, error: r?.error || "missing or invalid same_root_cause answer" };
      });
      for (const row of rows) invariant(validPairRow(row), `invalid pair row ${row.a}|${row.b}`);
      appendFileSync(pairsPath(dir), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
      errors += rows.filter((x) => x.error).length;
      for (const row of rows) if (row.p !== undefined) stored.set(pairKey(row.a, row.b), row.p);
      log(`cluster: ${start + slice.length}/${todo.length} pairs (${errors} errors)`);
    }
  }
  const clusters = clustersFrom(buckets, stored, cuts);
  if (opts.dryRun) return { buckets: buckets.length, split_buckets: toSplit.length, pairs_asked: todo.length, errors: 0, clusters, path: null };
  for (const c of clusters) invariant(validCluster(c), `invalid cluster ${c.key}`);
  invariant(new Set(clusters.flatMap((c) => c.members)).size === clusters.reduce((s, c) => s + c.count, 0), "a failure landed in two clusters");
  const path = clustersPath(dir, (opts.now ?? new Date()).toISOString().slice(0, 10));
  invariant(resolve(path).startsWith(resolve(dir)), "clusters must land under the v4 dir");
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, clusters.map((c) => JSON.stringify(c)).join("\n") + "\n");
  renameSync(tmp, path);
  return { buckets: buckets.length, split_buckets: toSplit.length, pairs_asked: todo.length, errors, clusters, path };
}
