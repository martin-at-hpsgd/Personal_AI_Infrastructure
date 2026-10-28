/**
 * Cloud runtime — every Cloudflare Worker in the LifeOS fleet, one record each.
 *
 * The fleet root is `USER/CUSTOMIZATIONS/WORKFLOWS` (a legacy symlink to it
 * still resolves). A Worker is any `Workers/<dir>` or top-level
 * `<dir>` holding a Worker config (`cloudflare.config.ts`, or a legacy `wrangler.jsonc`, `.json` or `.toml`);
 * a directory without one is a build-cache leftover, not a Worker.
 *
 * Read-only by construction: this file parses configs and source text and never
 * writes, deploys, or calls Cloudflare. Everything a card says that the author
 * did not declare in an `action.json` or `workflow.yaml` is marked inferred.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parseJsonc, describeCron, cronTrigger, record, card, step } from "./shared.ts";
import type { Card, Executor, Step, Trigger, WorkflowRecord } from "../types.ts";

const CONFIG_NAMES = ["cloudflare.config.ts", "wrangler.jsonc", "wrangler.json", "wrangler.toml"] as const;
/** A top-level fleet directory can hold a Worker unless it is hidden, archived (`_`-prefixed) or installed packages. */
const topLevelWorkerDir = (dir: string): boolean => dir !== "node_modules" && !dir.startsWith("_") && !dir.startsWith(".");

export interface WorkerConfigFile { dir: string; path: string; cfg: string; parsed: Record<string, unknown> | null }

/** A `cloudflare.config.ts` read as text (never imported) and reshaped into the wrangler-style record the rest of this file consumes. */
export function cloudflareConfigRecord(raw: string): Record<string, unknown> {
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const str = (re: RegExp): string | undefined => re.exec(code)?.[1];
  const out: Record<string, unknown> = {};
  const name = str(/\bname\s*:\s*["'`]([^"'`]+)["'`]/);
  if (name) out.name = name;
  const main = str(/\bentrypoint\s*:\s*["'`]([^"'`]+)["'`]/);
  if (main) out.main = main;
  out.triggers = { crons: [...code.matchAll(/\bschedule\s*:\s*["'`]([^"'`]+)["'`]/g)].map(m => m[1]) };
  out.services = [...code.matchAll(/\bbindings\.worker\(\s*\{[^}]*?\bworker\s*:\s*["'`]([^"'`]+)["'`]/g)].map(m => ({ service: m[1] }));
  out.kv_namespaces = [...code.matchAll(/(\w+)\s*:\s*bindings\.kv\(/g)].map(m => ({ binding: m[1] }));
  out.d1_databases = [...code.matchAll(/(\w+)\s*:\s*bindings\.d1\(\s*\{[^}]*?\b(?:name|database)\s*:\s*["'`]([^"'`]+)["'`]/g)].map(m => ({ binding: m[1], database_name: m[2] }));
  return out;
}

function readConfig(cfg: string): Record<string, unknown> {
  const text = readFileSync(cfg, "utf8");
  if (cfg.endsWith(".ts")) return cloudflareConfigRecord(text);
  const parsed = cfg.endsWith(".toml") ? Bun.TOML.parse(text) : parseJsonc(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("worker config is not an object");
  return parsed as Record<string, unknown>;
}

/** The worker config files under one directory of Worker directories, in directory order. Unparseable configs come back with `parsed: null`. */
export function scanWorkerConfigs(workers: string, onError?: (source: string, message: string) => void, include: (dir: string) => boolean = () => true): WorkerConfigFile[] {
  if (!existsSync(workers)) return [];
  const out: WorkerConfigFile[] = [];
  for (const dir of readdirSync(workers)) {
    if (!include(dir)) continue;
    const path = join(workers, dir);
    for (const name of CONFIG_NAMES) {
      const cfg = join(path, name);
      if (!existsSync(cfg)) continue;
      try { out.push({ dir, path, cfg, parsed: readConfig(cfg) }); }
      catch (e) { onError?.(cfg, String(e)); out.push({ dir, path, cfg, parsed: null }); }
      break;
    }
  }
  return out;
}

const titleOf = (dir: string): string => dir.replace(/^_[AFP]_/, "").replace(/_/g, " ").toLowerCase();
const cronsOf = (parsed: Record<string, unknown>): string[] => {
  const crons = (parsed.triggers as { crons?: unknown } | undefined)?.crons;
  return Array.isArray(crons) ? crons.filter((c): c is string => typeof c === "string" && c.trim().length > 0) : [];
};

/** A cron-bearing Worker as the `/assistant` scheduled view has always listed it (W7: this projection is frozen). */
export interface CloudCronJob { id: string; title: string; executor: "workflows"; cadence: string; state: "running" | "unknown"; purpose?: string; category?: string }

/** The `/assistant` projection: cron-bearing Workers under `workers`, one entry per Worker. */
export function cloudCronJobsAt(workers: string): CloudCronJob[] {
  return scanWorkerConfigs(workers).flatMap(({ dir, parsed }) => {
    if (!parsed) return [{ id: dir, title: dir, executor: "workflows" as const, cadence: "?", state: "unknown" as const, purpose: "wrangler config could not be parsed" }];
    const crons = cronsOf(parsed);
    if (!crons.length) return [];
    return [{ id: typeof parsed.name === "string" && parsed.name ? parsed.name : dir, title: titleOf(dir), executor: "workflows" as const,
      cadence: crons.map(describeCron).join(", "), state: "running" as const, purpose: `Cloudflare cron — ${crons.join(", ")}`,
      category: dir.startsWith("_F_") ? "flow" : dir.startsWith("_P_") ? "pipeline" : "action" }];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/* ── Normalized Worker ─────────────────────────────────────────────────── */

export type CloudVia = NonNullable<Trigger["via"]>;
export type CloudGroup = "action" | "pipeline" | "flow" | "app";

interface Worker {
  dir: string; path: string; cfg: string; name: string; title: string; main: string;
  crons: string[]; queueConsumers: string[]; queueProducers: Array<{ binding: string; queue: string }>;
  services: string[]; d1: Array<{ binding: string; name: string }>; kv: string[]; r2: Array<{ binding: string; bucket: string }>;
  email: boolean; domains: string[]; assets: boolean;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
const field = (v: unknown, key: string): string | null => (v && typeof v === "object" ? text((v as Record<string, unknown>)[key]) : null);

function normalize(file: WorkerConfigFile & { parsed: Record<string, unknown> }): Worker | string {
  const c = file.parsed;
  const name = text(c.name);
  if (!name) return "wrangler config has no name";
  const queues = (c.queues ?? {}) as Record<string, unknown>;
  const routes = [...list(c.routes), ...(c.route === undefined ? [] : [c.route])];
  return {
    dir: file.dir, path: file.path, cfg: file.cfg, name, title: titleOf(file.dir), main: text(c.main) ?? "src/index.ts",
    crons: cronsOf(c),
    queueConsumers: list(queues.consumers).map(q => field(q, "queue")).filter((q): q is string => q !== null),
    queueProducers: list(queues.producers).map(q => ({ binding: field(q, "binding") ?? "", queue: field(q, "queue") ?? "" })).filter(q => q.queue),
    services: [...new Set(list(c.services).map(s => field(s, "service")).filter((s): s is string => s !== null && s !== name))],
    d1: list(c.d1_databases).map(d => ({ binding: field(d, "binding") ?? "", name: field(d, "database_name") ?? "" })).filter(d => d.name),
    kv: list(c.kv_namespaces).map(k => field(k, "binding")).filter((k): k is string => k !== null),
    r2: list(c.r2_buckets).map(r => ({ binding: field(r, "binding") ?? "", bucket: field(r, "bucket_name") ?? "" })).filter(r => r.bucket),
    email: list(c.send_email).length > 0,
    // A route pattern may carry a path ("example.com/*"); the card shows the host only.
    domains: [...new Set(routes.map(r => (typeof r === "string" ? r : field(r, "pattern"))).filter((p): p is string => p !== null).map(p => p.split("/")[0]))],
    assets: c.assets !== undefined && c.assets !== null,
  };
}

/* ── Source reading ───────────────────────────────────────────────────── */

const SOURCE_FILE = /\.(ts|js|mjs)$/;
const TEST_FILE = /\.test\.(ts|js|mjs)$/;
const SHARED_IMPORT = /from\s+["']((?:\.\.\/)+Shared\/[\w./-]+)["']/g;

function sourceFiles(dir: string, depth = 0): string[] {
  if (depth > 4 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) out.push(...sourceFiles(path, depth + 1));
    else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry) && !entry.endsWith(".generated.ts")) out.push(path);
  }
  return out;
}

interface Source { own: string; withShared: string; header: string | null }

/** A Worker's own source, and the same text plus the fleet `Shared/` modules it imports directly (one level). */
function readSource(w: Worker, fleetRoot: string, sharedCache: Map<string, string>): Source {
  const files = sourceFiles(join(w.path, "src"));
  const own = files.map(f => readFileSync(f, "utf8"));
  const sharedRoot = resolve(fleetRoot, "Shared") + sep;
  const shared: string[] = [];
  files.forEach((file, i) => {
    for (const m of own[i].matchAll(SHARED_IMPORT)) {
      const base = resolve(dirname(file), m[1]);
      const target = SOURCE_FILE.test(base) ? base : `${base}.ts`;
      if (!target.startsWith(sharedRoot) || !existsSync(target)) continue;
      if (!sharedCache.has(target)) sharedCache.set(target, readFileSync(target, "utf8"));
      shared.push(sharedCache.get(target)!);
    }
  });
  const mainFile = join(w.path, w.main);
  const main = existsSync(mainFile) ? readFileSync(mainFile, "utf8") : "";
  return { own: own.join("\n"), withShared: [...own, ...new Set(shared)].join("\n"), header: headerOf(main) };
}

const CODE_LINE = /^(?:export|const|let|var|function|class|async|type|interface|enum|declare)\b/m;
const DOCUMENTS_DECLARATION = /^[ \t]*\r?\n[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\b/;

/**
 * The file-header doc comment: the first `/** … *\/` block that opens before any
 * code other than imports and is not the doc comment of the declaration right under it.
 */
export function headerOf(source: string): string | null {
  const block = /\/\*\*([\s\S]*?)\*\//.exec(source);
  if (!block) return null;
  const code = CODE_LINE.exec(source);
  if (code && block.index > code.index) return null;
  if (DOCUMENTS_DECLARATION.test(source.slice(block.index + block[0].length))) return null;
  return block[1].split("\n").map(l => l.replace(/^\s*\*\s?/, "").trimEnd()).join("\n").trim() || null;
}

const LABELLED_LINE = /^(?:Input|Output|Secrets|Security|Auth|Dedup|Queue|Service bindings|Bindings|Trigger|Env|Usage):/i;
/** A heading rather than a sentence: seven words or fewer with no closing punctuation ("Signal Fetch Action"). */
const isHeading = (p: string): boolean => p.split(/\s+/).length <= 7 && !/[.!?:]$/.test(p);

/** What the header says the Worker does: the first prose paragraph, skipping headings like "A_NOTIFY — Action Worker". */
export function purposeFromHeader(header: string | null): string | null {
  if (!header) return null;
  const paragraphs = header.split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  for (const [i, p] of paragraphs.entries()) {
    const titled = i === 0 ? /^[\w.-]+\s+[—–-]\s+(.+)$/.exec(p) : null;
    if (titled) {
      const rest = titled[1].trim();
      if (isHeading(rest)) continue;
      return rest;
    }
    if (isHeading(p) || LABELLED_LINE.test(p)) continue;
    return p;
  }
  return null;
}
const headerLine = (header: string | null, label: "Input" | "Output"): string | null =>
  header ? text(new RegExp(`^${label}:\\s*(.+)$`, "m").exec(header)?.[1]) : null;

const MODEL_CALL = /\bcreateActionWorker\(|\bcallOpenAI\(|\bcallAnthropic\(|api\.openai\.com|api\.anthropic\.com|\.AI\.run\(/;
const JUDGMENT_CALL = /typesafe/i;
/** Who does a Worker's work, read from its own source (never the shared helpers it merely imports). */
export function executorOf(ownSource: string): Executor {
  if (MODEL_CALL.test(ownSource)) return "model";
  if (JUDGMENT_CALL.test(ownSource)) return "judgment";
  return "code";
}

/* ── Declared contracts ───────────────────────────────────────────────── */

interface Contract { description: string | null; input: string | null; output: string | null }

/** A JSON Schema as a one-line shape: `JSON {target, depth?}`. Null when it says nothing a person can use. */
export function schemaSummary(schema: unknown): string | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as { type?: unknown; properties?: unknown; required?: unknown };
  if (s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)) {
    const keys = Object.keys(s.properties);
    if (!keys.length) return null;
    const required = new Set(Array.isArray(s.required) ? s.required.filter((k): k is string => typeof k === "string") : []);
    return `JSON {${keys.map(k => (required.has(k) ? k : `${k}?`)).join(", ")}}`;
  }
  return typeof s.type === "string" && s.type !== "object" ? `JSON ${s.type}` : null;
}

function readContract(w: Worker, error: (source: string, message: string) => void): Contract | null {
  const path = join(w.path, "action.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("action.json is not an object");
    const c = raw as Record<string, unknown>;
    return { description: text(c.description), input: schemaSummary(c.input), output: schemaSummary(c.output) };
  } catch (e) { error(path, String(e)); return null; }
}

interface DeclaredWorkflow { description: string | null; steps: Array<{ id: string; uses: string | null }> }

function readWorkflowYaml(w: Worker, error: (source: string, message: string) => void): DeclaredWorkflow | null {
  const path = join(w.path, "workflow.yaml");
  if (!existsSync(path)) return null;
  try {
    const data = Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") throw new Error("workflow.yaml is not a mapping");
    const raw = data.steps;
    // v1 writes steps as a map keyed by id; older examples wrote a list of { id }.
    const steps = Array.isArray(raw)
      ? raw.map((s, i) => ({ id: field(s, "id") ?? String(i + 1), uses: field(s, "uses") }))
      : raw && typeof raw === "object" ? Object.entries(raw as Record<string, unknown>).map(([id, s]) => ({ id, uses: field(s, "uses") })) : [];
    return { description: text(data.description), steps };
  } catch (e) { error(path, String(e)); return null; }
}

/* ── Records ──────────────────────────────────────────────────────────── */

export function groupOf(w: Pick<Worker, "dir" | "name" | "domains" | "assets">): CloudGroup {
  if (w.domains.length || w.assets) return "app";
  const prefix = /^_([AFP])_/.exec(w.dir)?.[1] ?? /^[a-z]+-([afp])-/.exec(w.name)?.[1]?.toUpperCase();
  return prefix === "F" ? "flow" : prefix === "P" ? "pipeline" : prefix === "A" ? "action" : "app";
}

function names(titles: string[]): string {
  return titles.length <= 3 ? titles.join(", ") : `${titles.slice(0, 3).join(", ")} +${titles.length - 3}`;
}

/** How the Worker starts. Precedence: cron, a queue someone else fills, a custom domain, a fleet caller, plain HTTP. */
export function cloudTrigger(w: Pick<Worker, "crons" | "queueConsumers" | "queueProducers" | "domains">, callers: string[]): Trigger {
  if (w.crons.length) {
    const each = w.crons.map(cronTrigger);
    if (each.length === 1) return { ...each[0], via: "cron" };
    const periods = each.map(t => t.periodMinutes).filter((p): p is number => p !== null);
    return { kind: "schedule", expr: w.crons.join(" | "), display: each.map(t => t.display).join(", ").slice(0, 200),
      periodMinutes: periods.length ? Math.min(...periods) : null, via: "cron" };
  }
  // A queue the Worker fills itself is its own buffer, not what starts it.
  const own = new Set(w.queueProducers.map(p => p.queue));
  const external = w.queueConsumers.filter(q => !own.has(q));
  if (external.length) return { kind: "on-demand", expr: null, display: `on queue ${external.join(", ")}`.slice(0, 200), periodMinutes: null, via: "queue" };
  if (w.domains.length) return { kind: "on-demand", expr: null, display: `HTTP at ${w.domains.join(", ")}`.slice(0, 200), periodMinutes: null, via: "http" };
  if (callers.length) return { kind: "on-demand", expr: null, display: `called by ${names(callers)}`.slice(0, 200), periodMinutes: null, via: "service-binding" };
  return { kind: "on-demand", expr: null, display: "on HTTP request", periodMinutes: null, via: "http" };
}

const SQL_WRITE = /\b(?:INSERT|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\b/;
const OBJECT_WRITE = /\.put\(/;

/** Bound storage split into what the source writes (destination) and what it only reads. */
export function storageOf(w: Pick<Worker, "d1" | "kv" | "r2" | "queueProducers" | "email">, source: string): { writes: string[]; reads: string[]; kinds: string[] } {
  const bound = (binding: string) => binding.length > 0 && new RegExp(`\\b${binding.replace(/[^\w]/g, "")}\\b`).test(source);
  const writes: string[] = [], reads: string[] = [], kinds = new Set<string>();
  for (const d of w.d1) {
    if (bound(d.binding) && SQL_WRITE.test(source)) { writes.push(`D1 ${d.name}`); kinds.add("database rows"); } else reads.push(`D1 ${d.name}`);
  }
  for (const k of w.kv) {
    if (bound(k) && OBJECT_WRITE.test(source)) { writes.push(`KV ${k}`); kinds.add("KV entries"); } else reads.push(`KV ${k}`);
  }
  for (const r of w.r2) {
    if (bound(r.binding) && OBJECT_WRITE.test(source)) { writes.push(`R2 ${r.bucket}`); kinds.add("R2 objects"); } else reads.push(`R2 ${r.bucket}`);
  }
  for (const q of w.queueProducers) { writes.push(`queue ${q.queue}`); kinds.add("queue messages"); }
  if (w.email) { writes.push("email"); kinds.add("email"); }
  return { writes: [...new Set(writes)], reads: [...new Set(reads)], kinds: [...kinds] };
}

function inputFor(trigger: Trigger, reads: string[]): string {
  const start = trigger.via === "cron" ? "a scheduled tick"
    : trigger.via === "queue" ? `messages ${trigger.display}`
      : trigger.via === "service-binding" ? "a JSON request from the Workers that call it"
        : "an HTTP request";
  return reads.length ? `${start}; reads ${reads.join(", ")}` : start;
}

/**
 * One record per Worker in the fleet: `Workers/<dir>` and any top-level
 * `<dir>` with a worker config under `fleetRoot`.
 */
export function collectCloud(fleetRoot: string, shown: (path: string) => string, error: (source: string, message: string) => void): WorkflowRecord[] {
  if (!existsSync(fleetRoot)) return [];
  const files = [
    ...scanWorkerConfigs(join(fleetRoot, "Workers"), error),
    ...scanWorkerConfigs(fleetRoot, error, topLevelWorkerDir),
  ];
  const workers: Worker[] = [];
  for (const file of files) {
    if (!file.parsed) continue;
    const w = normalize({ ...file, parsed: file.parsed });
    if (typeof w === "string") { error(file.cfg, w); continue; }
    if (workers.some(x => x.name === w.name)) { error(file.cfg, `two wrangler configs declare Worker "${w.name}"; the first is listed`); continue; }
    workers.push(w);
  }
  // Two Workers can share a title across kinds (the label-and-rate action and pipeline); each then names its kind.
  const titleCount = new Map<string, number>();
  for (const w of workers) titleCount.set(w.title, (titleCount.get(w.title) ?? 0) + 1);
  for (const w of workers) if ((titleCount.get(w.title) ?? 0) > 1) w.title = `${w.title} (${groupOf(w)})`;
  const byName = new Map(workers.map(w => [w.name, w]));
  const byActionId = new Map(workers.map(w => [w.dir.replace(/^_/, ""), w]));
  const sharedCache = new Map<string, string>();
  const sources = new Map(workers.map(w => [w.name, readSource(w, fleetRoot, sharedCache)]));
  const executor = (name: string): Executor => (sources.has(name) ? executorOf(sources.get(name)!.own) : "unknown");
  const callersOf = new Map<string, string[]>();
  for (const w of workers) for (const s of w.services) if (byName.has(s)) callersOf.set(s, [...(callersOf.get(s) ?? []), w.name]);

  return workers.map(w => {
    const src = sources.get(w.name)!;
    const callers = (callersOf.get(w.name) ?? []).sort();
    const trigger = cloudTrigger(w, callers.map(n => byName.get(n)!.title));
    const contract = readContract(w, error);
    const declared = readWorkflowYaml(w, error);
    const storage = storageOf(w, src.withShared);
    const inferred: Card["inferred"] = ["destination"];

    const readme = join(w.path, "README.md");
    const readmePurpose = existsSync(readme) ? readFileSync(readme, "utf8").split(/\n\s*\n/).map(p => p.trim()).find(p => p && !p.startsWith("#")) ?? null : null;
    const declaredPurpose = contract?.description ?? declared?.description ?? readmePurpose;
    const purpose = declaredPurpose ?? purposeFromHeader(src.header);
    if (!declaredPurpose && purpose) inferred.push("purpose");

    let steps: Step[];
    if (declared?.steps.length) {
      steps = declared.steps.map(s => step(`${s.id}${s.uses ? ` ${s.uses}` : ""}`, s.uses && byActionId.has(s.uses) ? executor(byActionId.get(s.uses)!.name) : "code", s.id));
    } else {
      inferred.push("steps");
      steps = w.services.length
        ? w.services.map((s, i) => step(byName.get(s)?.title ?? s, executor(s), String(i + 1)))
        : [step(w.title, executorOf(src.own), "1")];
    }

    const input = contract?.input ?? headerLine(src.header, "Input") ?? inputFor(trigger, storage.reads);
    if (!contract?.input) inferred.push("input");
    const output = contract?.output ?? headerLine(src.header, "Output")
      ?? (storage.kinds.length ? storage.kinds.join(", ") : trigger.via === "http" || trigger.via === "service-binding" ? "JSON response" : null);
    if (!contract?.output && output !== null) inferred.push("output");

    const linked = [...new Set([...w.services.filter(s => byName.has(s)), ...callers])].sort().map(n => `cloud:${n}`);
    return record("cloud", w.name, w.title, groupOf(w), trigger, shown(w.cfg), {
      card: card({ purpose, input, steps, output, destination: storage.writes.length ? storage.writes.join(" · ") : null, inferred }),
      linked,
    });
  });
}
