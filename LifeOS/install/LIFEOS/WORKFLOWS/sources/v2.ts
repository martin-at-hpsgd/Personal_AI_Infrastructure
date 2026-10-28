import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { lastDeploys } from "../engine/deploy-record.ts";
import { analyzeDefinition, EXECUTOR_OF, loadDefinitionFile, message, type DefinitionV2, type StepV2, type TriggerV2 } from "../engine/format.ts";
import { ledgerEvidence, type WorkflowEvidence } from "../engine/ledger.ts";
import { DEFINITION_SUFFIX, renameAliasPath } from "../engine/paths.ts";
import { card, cronTrigger, emptyEvidence, everyMinutes, record } from "./shared.ts";
import type { Evidence, Step, Trigger, WorkflowRecord } from "../types.ts";
import { principalTimezone } from "../../TOOLS/lib/Timezone.ts";

const TIME_TRIGGERS = new Set<TriggerV2["type"]>(["schedule", "interval", "once"]);

/** A trigger runs unless it says `enabled: false`. */
const live = (t: TriggerV2): boolean => t.enabled !== false;

/**
 * ISC-88: paused means the whole workflow is switched off (`enabled: false`) or every trigger it has is.
 * A paused workflow is shown as paused and is never judged late or missing a run record.
 */
export function isPaused(def: DefinitionV2): boolean {
  return def.enabled === false || (def.triggers.length > 0 && def.triggers.every(t => !live(t)));
}

/** A schema in one short line: `object {text: string, count?: integer}`, `string`, or null when undeclared. */
export function schemaSummary(schema: unknown): string | null {
  if (schema === undefined) return null;
  if (schema === true) return "any value";
  if (schema === false) return "no value";
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const s = schema as Record<string, unknown>;
  const type = typeof s.type === "string" ? s.type : Array.isArray(s.type) ? (s.type as string[]).join(" | ") : null;
  const props = s.properties && typeof s.properties === "object" && !Array.isArray(s.properties) ? (s.properties as Record<string, unknown>) : null;
  if (props && Object.keys(props).length) {
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    const fields = Object.entries(props).map(([key, child]) => {
      const t = child && typeof child === "object" && !Array.isArray(child) ? (child as Record<string, unknown>).type : undefined;
      const shown = typeof t === "string" ? t : Array.isArray(t) ? (t as string[]).join(" | ") : "any";
      return `${key}${required.has(key) ? "" : "?"}: ${shown}`;
    });
    return `${type ?? "object"} {${fields.join(", ")}}`;
  }
  return type ?? "any value";
}

function stepDetail(step: StepV2): string {
  switch (step.kind) {
    case "action": return step.uses as string;
    case "command": return basename((step.argv as string[])[0]);
    case "model":
    case "agent": return `${step.lane} lane`;
    case "judgment": return "Glance";
    case "human": return "decision";
    case "workflow": return step.workflow as string;
  }
}

function stepsOf(def: DefinitionV2): Step[] {
  return Object.values(def.steps).map(s => ({ id: s.id, label: `${s.id} · ${s.kind} ${stepDetail(s)}`, executor: EXECUTOR_OF[s.kind] }));
}


/** A zone in plain words: "London time" for Europe/London; empty for the principal's own zone. */
function zoneWords(tz: string): string {
  if (tz === principalTimezone()) return ""; // the principal's own zone, from config, needs no suffix (ISC-107)
  if (!tz.includes("/")) return ` · ${tz}`; // UTC and other bare zone names already read as words
  const city = tz.split("/").pop() ?? tz;
  return ` · ${city.replace(/_/g, " ")} time`;
}

/**
 * ISC-107: a cron schedule in plain words, never raw cron. The shared parser covers
 * the common shapes; anything it hands back verbatim becomes "custom schedule".
 */
export function plainSchedule(cron: string, tz: string): string {
  const shown = cronTrigger(cron).display;
  if (shown.trim() === cron.trim()) return `custom schedule${zoneWords(tz)}`;
  const words = shown.replace("Mon, Tue, Wed, Thu, Fri", "Weekdays").replace(/^Sun, Sat\b/, "Weekends")
    .replace(/\bevery (\d+)m\b/, (_m, n) => `every ${n} min`).replace(/\bevery (\d+)h\b/, (_m, n) => `every ${n} h`);
  // Time first, then the days, the same order the canvas uses: "09:00 · Weekdays".
  const m = words.match(/^(.*?)\s*(\d{2}:\d{2})$/);
  return `${m && m[1] ? `${m[2]} · ${m[1][0]!.toUpperCase()}${m[1].slice(1)}` : words}${zoneWords(tz)}`;
}

/** ISC-107: a one-off time as 24-hour HH:mm in the principal's timezone, never a raw ISO stamp. */
export function plainOnce(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "once, at an unreadable time";
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: principalTimezone(), weekday: "short", day: "numeric", month: "short" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: principalTimezone(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `once · ${day} ${time}`;
}

function triggerDisplay(t: TriggerV2): { expr: string; display: string; period: number | null } {
  switch (t.type) {
    case "manual": return { expr: "manual", display: "on demand", period: null };
    case "schedule": {
      const c = cronTrigger(t.cron);
      return { expr: `${t.cron} ${t.timezone}`, display: plainSchedule(t.cron, t.timezone), period: c.periodMinutes };
    }
    case "interval": return { expr: `every ${t.minutes}m`, display: everyMinutes(t.minutes), period: t.minutes };
    case "once": return { expr: t.at, display: plainOnce(t.at), period: null };
    case "event": return { expr: `event ${t.name}`, display: `on event ${t.name}`, period: null };
    case "after": return { expr: `after ${t.workflow} ${t.status}`, display: `after ${t.workflow} ${t.status}`, period: null };
  }
}

export function triggerOf(def: DefinitionV2): Trigger {
  const paused = isPaused(def);
  const parts = def.triggers.map(triggerDisplay);
  // Only enabled triggers schedule anything; a paused trigger is listed but adds no period.
  const timed = !paused && def.triggers.some(t => live(t) && TIME_TRIGGERS.has(t.type));
  const periods = def.triggers.map((t, i) => (live(t) && TIME_TRIGGERS.has(t.type) ? parts[i].period : null)).filter((p): p is number => p !== null);
  const shown = def.triggers.map((t, i) => (live(t) ? parts[i].display : `${parts[i].display} (paused)`));
  return {
    kind: timed ? "schedule" : "on-demand",
    expr: parts.map(p => p.expr).join(" · ").slice(0, 200),
    display: (def.enabled === false ? `paused · ${shown.join(" · ")}` : shown.join(" · ")).slice(0, 200),
    periodMinutes: timed && periods.length ? Math.min(...periods) : null,
  };
}

/**
 * ISC-76 (inventory half): the rename alias map beside the ledger, as old name to newest name.
 * The ledger keeps the name a run had; this map (appended to by renameDefinition) is how the
 * inventory shows those runs under the current name. A chain a -> b -> c resolves to c; a
 * cycle is cut at the first repeat, so a hand-edited file cannot loop.
 */
export function readRenameAliases(ledger: string): Map<string, string> {
  const file = renameAliasPath(ledger);
  const direct = new Map<string, string>();
  if (!existsSync(file)) return direct;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { from?: unknown; to?: unknown };
      if (typeof row.from === "string" && typeof row.to === "string" && row.from !== row.to) direct.set(row.from, row.to);
    } catch { /* a torn line is skipped */ }
  }
  const resolved = new Map<string, string>();
  for (const from of direct.keys()) {
    const seen = new Set([from]);
    let to = direct.get(from)!;
    while (direct.has(to) && !seen.has(to)) { seen.add(to); to = direct.get(to)!; }
    if (!seen.has(to)) resolved.set(from, to);
  }
  return resolved;
}

/** Folds each old name's evidence into its current name: runs add up, the later last run wins. Returns a new map. */
export function foldAliases(by: Map<string, WorkflowEvidence>, aliases: Map<string, string>): Map<string, WorkflowEvidence> {
  const out = new Map(by);
  for (const [from, to] of aliases) {
    const old = out.get(from);
    if (!old) continue;
    out.delete(from);
    const cur = out.get(to);
    out.set(to, !cur ? old : { runs: cur.runs + old.runs, ...(old.last_finished_at > cur.last_finished_at ? { last_finished_at: old.last_finished_at, last_status: old.last_status } : { last_finished_at: cur.last_finished_at, last_status: cur.last_status }) });
  }
  return out;
}

function evidenceOf(seen: WorkflowEvidence | undefined, source: string): Evidence {
  if (!seen) return emptyEvidence();
  return { kind: "run-log", lastRunAt: seen.last_finished_at, lastStatus: seen.last_status === "succeeded" ? "ok" : "error", source, runs: seen.runs };
}

/**
 * Every v2 (and v1) definition in the definitions home, as runtime `workflow`.
 * Card slots come from the definition, evidence from the run ledger, and each
 * `after:` link is written into BOTH records' `linked` lists. Reads only.
 */
export function collectV2(dir: string, ledger: string, shown: (path: string) => string, error: (source: string, message: string) => void,
  /** ISC-91: when given, receives the count of typed connections by class across every valid definition. */
  connections?: { checked: number; runtime: number; mismatch: number }): WorkflowRecord[] {
  if (!existsSync(dir)) return [];
  const loaded: Array<{ path: string; def: DefinitionV2; hash: string }> = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith(DEFINITION_SUFFIX)).sort()) {
    const path = join(dir, file);
    try {
      const file_ = loadDefinitionFile(path);
      loaded.push({ path, def: file_.def, hash: file_.hash });
    } catch (e) {
      error(path, `invalid workflow definition: ${message(e)}`);
    }
  }
  const byName = new Map(loaded.map(l => [l.def.name, l.def]));
  // The fast path: a byte-offset index beside the ledger, so each call reads only what was appended since the last one.
  let runs = new Map<string, WorkflowEvidence>();
  try {
    const read = ledgerEvidence(ledger);
    runs = foldAliases(read.by, readRenameAliases(ledger));
    if (read.malformed) error(ledger, `${read.malformed} malformed ledger line(s) skipped`);
  } catch (e) {
    error(ledger, message(e));
  }

  // A cloud workflow is installed when its runner was deployed: the deploy log beside the ledger says so (ISC-174).
  const deploys = lastDeploys(join(dirname(ledger), "deploys.jsonl"));
  const records = new Map<string, WorkflowRecord>();
  for (const { path, def, hash } of loaded) {
    const analysis = analyzeDefinition(def, { resolveWorkflow: name => byName.get(name) ?? null });
    if (!analysis.valid) error(path, `invalid workflow definition: ${analysis.errors.join("; ")}`);
    else if (connections) for (const c of analysis.connections) connections[c.class]++;
    const paused = isPaused(def);
    const timed = !paused && def.triggers.some(t => live(t) && TIME_TRIGGERS.has(t.type));
    const rec = record("workflow", def.name, def.name, def.runs_on, triggerOf(def), shown(path), {
      // A timed local workflow is "absent" until its com.lifeos.wf.<name> plist exists (Inventory absorbs it); a timed cloud
      // workflow is "deployed" once its runner has a deploy record; a paused one needs neither.
      installed: !timed ? "n/a" : def.runs_on === "cloud" && deploys.has(def.name) ? "deployed" : "absent",
      enabled: !paused,
      evidence: evidenceOf(runs.get(def.name), shown(ledger)),
      card: card({
        purpose: def.description ?? null,
        input: schemaSummary(def.input),
        steps: stepsOf(def),
        sop: def.sop ?? null,
        output: schemaSummary(def.output),
        destination: def.destination ?? null,
      }),
    });
    rec.paused = paused;
    rec.definitionHash = hash;
    records.set(def.name, rec);
  }
  const link = (a: WorkflowRecord, b: WorkflowRecord) => {
    if (!a.linked.includes(b.id)) a.linked.push(b.id);
    if (!b.linked.includes(a.id)) b.linked.push(a.id);
  };
  for (const { def } of loaded) {
    for (const t of def.triggers) {
      if (t.type !== "after") continue;
      const upstream = records.get(t.workflow);
      const downstream = records.get(def.name);
      if (upstream && downstream) link(upstream, downstream);
    }
  }
  return [...records.values()];
}
