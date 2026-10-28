/** The principal reviews ten random closed criteria a week and says whether each criterion's eval would catch the criterion failing; that answer is the real coverage number. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { invariant } from "./Invariant.ts";
import { getClaudeDir, getLifeosDir } from "./Paths.ts";
import { parseIsaClaimsText, stripBulletPrefix, claimText } from "./lib/IsaClaims.ts";
import { parseTestStrategyDiagnostic, type Probe } from "./lib/IsaTestStrategy.ts";
// The event writer loads optionally (STATVS and Vigil are absent from public installs); VigilOptional owns that.
import { emitVigilEvent, type VigilEvent } from "./lib/VigilOptional.ts";

export const ROW_CLASSES = ["test-suite", "live-http", "screenshot", "runs-a-command", "judged", "grep-source", "file-exists", "grep-a-doc", "manual"] as const;
export type RowClass = typeof ROW_CLASSES[number];
export type Verdict = "catch" | "miss" | "unsure";
export interface SampleRow { type: string; check: string; tool: string; rowClass: RowClass }
export interface SampleItem { n: number; isa: string; claim: string; text: string; rows: SampleRow[] }
export interface Label { ts: string; week: string; n: number; isa: string; claim: string; verdict: Verdict; note: string; rows_sha256: string }
export interface Rate { catch: number; miss: number; unsure: number; rate: number | null }
export interface Report { overall: Rate; byRowClass: Partial<Record<RowClass, Rate>> }
export interface Options { stateDir?: string; obsDir?: string; isas?: string[]; emitEvent?: (event: VigilEvent) => unknown; now?: Date }

const WEEK_RE = /^\d{4}-W\d{2}$/;
const verdicts = new Set<string>(["catch", "miss", "unsure"]);
const home = () => homedir();
const stateDir = (opts: Options) => opts.stateDir ?? process.env.EVAL_SAMPLE_STATE_DIR ?? join(getLifeosDir(), "MEMORY", "STATE");
const obsDir = (opts: Options) => opts.obsDir ?? process.env.EVAL_SAMPLE_OBS_DIR ?? join(getLifeosDir(), "MEMORY", "OBSERVABILITY");
const weekFile = (opts: Options, week: string) => join(stateDir(opts), "eval-sample", `${week}.json`);
const labelsFile = (opts: Options) => join(obsDir(opts), "eval-sample-labels.jsonl");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** One event through the event writer (STATVS writeEvent once VigilOptional routes there); nothing when none is installed. A refusal is reported, never thrown. */
async function emitVigil(event: VigilEvent): Promise<void> {
  try { emitVigilEvent(event); }
  catch (e) { console.error(`[eval-sample] event refused: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)); }
}

export function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((d.getTime() - start.getTime()) / 86400000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function rowClass(row: Pick<Probe, "type" | "tool">): RowClass {
  const type = row.type;
  const tool = row.tool.trim();
  if (type === "bun-test" || type === "bun-property") return "test-suite";
  if (type === "curl" || /(?:^|\s)curl\s/.test(tool)) return "live-http";
  if (type === "screenshot") return "screenshot";
  if (type === "eval" || type === "pairwise" || type === "glance") return "judged";
  if (type === "manual") return "manual";
  if (/^(?:test\s+-(?:f|e)\b|\[\s+-f\b|ls\s)/.test(tool)) return "file-exists";
  if (/(?:^|[\s;|&])(?:rg|grep)(?:\s|$)/.test(tool)) return /\.md(?:\b|[\s'"`])/i.test(tool) ? "grep-a-doc" : "grep-source";
  return "runs-a-command";
}

export function seededPick<T>(items: readonly T[], n: number, seed: string): T[] {
  const copy = [...items];
  let x = Number.parseInt(sha256(seed).slice(0, 8), 16) >>> 0;
  const random = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, Math.max(0, n));
}

function expandPath(path: string): string {
  if (path === "~" || path.startsWith("~/")) return join(home(), path.slice(2));
  if (path.startsWith("LIFEOS/")) return join(getClaudeDir(), path);
  return isAbsolute(path) ? path : resolve(path);
}

export function discoverIsas(opts: Options = {}): string[] {
  let candidates: string[];
  if (opts.isas || process.env.EVAL_SAMPLE_ISAS !== undefined) {
    candidates = opts.isas ?? process.env.EVAL_SAMPLE_ISAS!.split(":").filter(Boolean);
  } else {
    const projects = readFileSync(join(getLifeosDir(), "USER", "PROJECTS.md"), "utf8");
    candidates = [...projects.matchAll(/`([^`\n]*ISA\.md)`/g)].map(m => m[1]!);
    const lifeos = getLifeosDir();
    candidates.push(...readdirSync(lifeos, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(lifeos, e.name, "ISA.md")));
  }
  const seen = new Set<string>();
  return candidates.map(expandPath).filter(path => {
    if (path.includes("/LIFEOS/MEMORY/WORK/") || !existsSync(path)) return false;
    const real = realpathSync(path);
    if (real.includes("/LIFEOS/MEMORY/WORK/") || seen.has(real)) return false;
    seen.add(real);
    return true;
  }).map(realpathSync).sort();
}

function eligibleItems(paths: string[]): SampleItem[] {
  const items: SampleItem[] = [];
  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    const claims = parseIsaClaimsText(source, { path }).claims;
    const probes = parseTestStrategyDiagnostic(path).probes;
    const lines = source.replace(/^---\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/, "").split(/\r?\n/);
    for (const claim of claims) {
      if (!claim.checked || claim.source !== "checkbox") continue;
      const rows = probes.filter(p => p.isc === claim.id || p.anchors_to.replace(/^(?:derived:|cross:)\s*/, "") === claim.id)
        .map(p => ({ type: p.type, check: p.check, tool: p.tool, rowClass: rowClass(p) }));
      if (!rows.some(r => r.type !== "manual")) continue;
      const raw = lines[claim.line - 1] ?? "";
      const text = claimText(stripBulletPrefix(raw))?.body ?? "";
      items.push({ n: 0, isa: path.startsWith(`${home()}/`) ? `~/${path.slice(home().length + 1)}` : path, claim: claim.id, text, rows });
    }
  }
  return items;
}

function writeSample(path: string, week: string, items: SampleItem[]): void {
  invariant(WEEK_RE.test(week), "sample week is valid");
  invariant(items.every((item, i) => item.n === i + 1 && item.claim && item.rows.some(r => r.type !== "manual")), "sample items are numbered and eligible");
  const body = JSON.stringify(items, null, 2) + "\n";
  invariant(body.length > 2, "sample JSON is nonempty");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { flag: "wx" });
}

export function draw(n = 10, opts: Options = {}): SampleItem[] {
  const week = weekKey(opts.now ?? new Date());
  let items: SampleItem[] = [];
  let failure: unknown;
  try {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("--n must be a nonnegative integer");
    const path = weekFile(opts, week);
    if (existsSync(path)) items = readSample(opts, week);
    else {
      items = seededPick(eligibleItems(discoverIsas(opts)), n, week).map((item, i) => ({ ...item, n: i + 1 }));
      writeSample(path, week, items);
    }
    return items;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const event: VigilEvent = {
      id: randomUUID(), source: "eval-sample", ts: new Date().toISOString(), kind: "other",
      severity: failure ? "low" : "info", title: failure ? `Eval sample failed for ${week}` : `Eval sample ready: ${items.length} criteria for ${week}`,
      summary: failure ? `Review the eval sample draw failure for ${week}, then run draw again.` : `Run show ${week}, review whether each eval would catch its criterion failing, then record catch, miss, or unsure with answer.`,
      ref: null, url: null, privacy_class: "personal", dedup_key: `eval-sample:${week}`,
    };
    if (opts.emitEvent) opts.emitEvent(event);
    else void emitVigil(event);
  }
}

export function readSample(opts: Options, week: string): SampleItem[] {
  if (!WEEK_RE.test(week)) throw new Error(`Unknown week: ${week}`);
  const path = weekFile(opts, week);
  if (!existsSync(path)) throw new Error(`Unknown week: ${week}`);
  const items: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(items)) throw new Error(`Invalid sample for ${week}`);
  return items as SampleItem[];
}

function readLabels(opts: Options): Label[] {
  const path = labelsFile(opts);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Label);
}

export function latestLabels(labels: readonly Label[]): Map<string, Label> {
  const latest = new Map<string, Label>();
  for (const label of labels) latest.set(`${label.week}:${label.n}`, label);
  return latest;
}

function appendLabel(opts: Options, label: Label): void {
  invariant(WEEK_RE.test(label.week) && Number.isSafeInteger(label.n) && label.n > 0, "label identity is valid");
  invariant(verdicts.has(label.verdict) && label.isa && label.claim && /^[a-f0-9]{64}$/.test(label.rows_sha256), "label data is valid");
  const line = JSON.stringify(label);
  invariant(!line.includes("\n"), "JSONL label is one line");
  const path = labelsFile(opts);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`);
}

export function answer(week: string, n: number, verdict: string, note = "", opts: Options = {}): Label {
  if (!verdicts.has(verdict)) throw new Error(`Bad verdict: ${verdict}`);
  const items = readSample(opts, week);
  if (!Number.isSafeInteger(n) || n < 1 || n > items.length) throw new Error(`Sample number out of range: ${n}`);
  const item = items[n - 1]!;
  const label: Label = { ts: new Date().toISOString(), week, n, isa: item.isa, claim: item.claim, verdict: verdict as Verdict, note, rows_sha256: sha256(JSON.stringify(item.rows)) };
  appendLabel(opts, label);
  return label;
}

/** The latest label for a sample item, only when it was given for this exact item:
 *  same ISA, same criterion, same rows. A label left over from a regenerated or restored
 *  week file never scores a different criterion. */
export function labelFor(item: SampleItem, week: string, latest: Map<string, Label>): Label | undefined {
  const label = latest.get(`${week}:${item.n}`);
  if (!label || label.isa !== item.isa || label.claim !== item.claim || label.rows_sha256 !== sha256(JSON.stringify(item.rows))) return undefined;
  return label;
}

export function reportMath(items: readonly (SampleItem & { week: string })[], labels: readonly Label[]): Report {
  const latest = latestLabels(labels);
  const count = (values: Verdict[]): Rate => {
    const catchCount = values.filter(v => v === "catch").length;
    const miss = values.filter(v => v === "miss").length;
    return { catch: catchCount, miss, unsure: values.filter(v => v === "unsure").length, rate: catchCount + miss ? catchCount / (catchCount + miss) : null };
  };
  const groups = new Map<RowClass, Verdict[]>();
  const all: Verdict[] = [];
  for (const item of items) {
    const label = labelFor(item, item.week, latest);
    if (!label) continue;
    all.push(label.verdict);
    const strongest = ROW_CLASSES.find(cls => item.rows.some(row => row.rowClass === cls));
    if (strongest) groups.set(strongest, [...(groups.get(strongest) ?? []), label.verdict]);
  }
  return { overall: count(all), byRowClass: Object.fromEntries([...groups].map(([cls, values]) => [cls, count(values)])) };
}

function sampledWeeks(opts: Options, limit?: number): string[] {
  const dir = join(stateDir(opts), "eval-sample");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^\d{4}-W\d{2}\.json$/.test(name)).map(name => name.slice(0, -5)).sort().reverse().slice(0, limit);
}

function displayRate(rate: Rate): string { return `${rate.rate === null ? "n/a" : `${(rate.rate * 100).toFixed(1)}%`} (${rate.catch}/${rate.catch + rate.miss}; unsure ${rate.unsure})`; }
export function show(week: string, opts: Options = {}): string {
  const items = readSample(opts, week);
  const labels = latestLabels(readLabels(opts));
  return items.map(item => {
    const rows = item.rows.map(row => `  ${row.type}: ${row.tool.length > 140 ? `${row.tool.slice(0, 137)}...` : row.tool}`).join("\n");
    const verdict = labelFor(item, week, labels)?.verdict;
    return `${item.n}. ${item.claim}: ${item.text}\n${rows}${verdict ? `\n  verdict: ${verdict}` : ""}`;
  }).join("\n");
}

export function report(opts: Options = {}, weeks?: number): string {
  if (weeks !== undefined && (!Number.isSafeInteger(weeks) || weeks < 1)) throw new Error("--weeks must be a positive integer");
  const items = sampledWeeks(opts, weeks).flatMap(week => readSample(opts, week).map(item => ({ ...item, week })));
  const rates = reportMath(items, readLabels(opts));
  return [`Overall: ${displayRate(rates.overall)}`, ...ROW_CLASSES.filter(cls => rates.byRowClass[cls]).map(cls => `${cls}: ${displayRate(rates.byRowClass[cls]!)}`)].join("\n");
}

export function main(args: string[], opts: Options = {}): number {
  try {
    const [command, ...rest] = args;
    if (command === "draw") {
      const n = !rest.length ? 10 : rest.length === 2 && rest[0] === "--n" ? Number(rest[1]) : NaN;
      const items = draw(n, opts);
      console.log(`Eval sample ready: ${items.length} criteria for ${weekKey(opts.now ?? new Date())}`);
    } else if (command === "answer") {
      if (rest.length < 3 || rest.length > 5 || (rest.length === 5 && rest[3] !== "--note") || rest.length === 4) throw new Error("Usage: answer <week|current> <n> catch|miss|unsure [--note text]");
      const week = rest[0] === "current" ? weekKey(opts.now ?? new Date()) : rest[0]!;
      const label = answer(week, Number(rest[1]), rest[2]!, rest[4] ?? "", opts);
      console.log(`Recorded ${label.verdict} for ${label.week} #${label.n}`);
    } else if (command === "show") {
      if (rest.length > 1) throw new Error("Usage: show [week|current]");
      console.log(show(!rest.length || rest[0] === "current" ? weekKey(opts.now ?? new Date()) : rest[0]!, opts));
    } else if (command === "report") {
      if (rest.length && (rest.length !== 2 || rest[0] !== "--weeks")) throw new Error("Usage: report [--weeks N]");
      console.log(report(opts, rest.length ? Number(rest[1]) : undefined));
    } else throw new Error("Usage: draw [--n N] | answer <week|current> <n> catch|miss|unsure [--note text] | show [week|current] | report [--weeks N]");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
