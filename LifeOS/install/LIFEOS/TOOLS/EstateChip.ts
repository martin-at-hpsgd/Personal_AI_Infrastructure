import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { invariant } from "./Invariant.ts";

export type EstateSeverity = "ok" | "warn" | "crit";

/** Fixed palette slots the statusline maps to colours; text never carries escapes. */
export type Tone = "crit" | "high" | "med" | "low" | "type" | "count" | "bad" | "ok" | "ops";

/** One coloured run of text inside an item. */
export interface Part {
  tone: Tone;
  text: string;
}

/**
 * A labelled row of items. The statusline owns layout: it aligns labels, puts
 * " · " between items, and wraps only between items, so an item never splits.
 */
export interface Row {
  label: string;
  items: Part[][];
}

export interface VulnType {
  name: string;
  count: number;
}

export interface EstateChip {
  apps: number;
  /** Distinct apps with at least one failing Bunker check. */
  red: number;
  /** Open security findings (Pentest, scanners) by severity; Socrates questions excluded. */
  crit: number;
  high: number;
  med: number;
  low: number;
  types: VulnType[];
  /** Open Socrates standing-question failures, which live in Achilles but are not vulnerabilities. */
  ops: number;
  opsHigh: number;
  rows: Row[];
  updated: string;
  severity: EstateSeverity;
  /** Evidence sources that were missing or unparseable ("vulns", "apps"). Their numbers are unknown, not zero. */
  unavailable?: Array<"vulns" | "apps">;
}

interface AchillesEntry {
  severity?: string;
  status?: string;
  source?: string;
  title?: string;
  description?: string;
  cves?: string[];
}

interface AchillesRegistry {
  entries?: AchillesEntry[];
}

interface BunkerSnapshot {
  summary?: { apps?: number };
  apps?: Array<{ name?: string; fail?: number }>;
}

interface MonitorState {
  [name: string]: { status?: string };
}

const TOOL_DIR = import.meta.dir;
const LIFEOS_DIR = resolve(TOOL_DIR, "..");
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const ACHILLES_REGISTRY = join(LIFEOS_DIR, "USER", "SECURITY", "ACHILLES", "registry.json");
const BUNKER_DIR = join(HOME, ".config", "LIFEOS", "USER", "PULSE", "Bunker");
const BUNKER_SNAPSHOT = join(BUNKER_DIR, "snapshot.json");
const BUNKER_MONITOR_STATE = join(BUNKER_DIR, "monitor-state.json");

export function cachePaths(env: NodeJS.ProcessEnv = process.env): { txt: string; json: string } {
  const stateDir = join(LIFEOS_DIR, "MEMORY", "STATE");
  return {
    txt: env.LIFEOS_ESTATE_CHIP_TXT ?? join(stateDir, "estate-chip.txt"),
    json: env.LIFEOS_ESTATE_CHIP_JSON ?? join(stateDir, "estate-chip.json"),
  };
}

export function severityOf({ crit, high, red, unavailable }: Pick<EstateChip, "crit" | "high" | "red" | "unavailable">): EstateSeverity {
  // Missing evidence is never "ok": it floors at warn.
  return crit > 0 ? "crit" : high > 0 || red > 0 || (unavailable?.length ?? 0) > 0 ? "warn" : "ok";
}

const CWE_TYPES: Record<string, string> = {
  "284": "access", "285": "access", "639": "access", "862": "access", "863": "access",
  "400": "rate-limit", "770": "rate-limit", "799": "rate-limit",
  "352": "csrf",
  "78": "injection", "79": "injection", "89": "injection", "94": "injection", "113": "injection",
  "200": "info-leak", "209": "info-leak", "532": "info-leak",
  "384": "session", "613": "session",
};

const CHECK_TYPES: Array<[RegExp, string]> = [
  [/^(csp|hsts|x-content-type-options|x-frame-options|permissions-policy|referrer-policy)\b/i, "headers"],
  [/^(dmarc|spf|dkim|caa|dnssec)\b/i, "dns"],
  [/\b(tls|certificate|cert)\b/i, "tls"],
];

/** One short, plain name per finding so the row says what kind of problem is open. */
export function vulnType(entry: Pick<AchillesEntry, "title" | "description" | "cves">): string {
  if ((entry.cves ?? []).length > 0) return "cve";
  const cwe = /CWE-(\d+)/.exec(`${entry.description ?? ""} ${entry.title ?? ""}`)?.[1];
  if (cwe) return CWE_TYPES[cwe] ?? "other";
  const title = entry.title ?? "";
  for (const [pattern, name] of CHECK_TYPES) if (pattern.test(title)) return name;
  return "other";
}

const SEVERITY_ORDER = ["crit", "high", "med", "low"] as const;

type Counts = Pick<EstateChip, "apps" | "red" | "crit" | "high" | "med" | "low" | "types" | "ops" | "opsHigh"> & Pick<EstateChip, "unavailable">;

/**
 * Three labelled rows so every number says what it counts: open vulnerabilities by
 * severity, the kinds they are, and what is failing (apps' Bunker tests, Socrates
 * standing questions).
 */
export function rowsFor(chip: Counts): Row[] {
  const vulns = chip.crit + chip.high + chip.med + chip.low;
  const rows: Row[] = [];

  const vulnsUnknown = chip.unavailable?.includes("vulns") ?? false;
  const appsUnknown = chip.unavailable?.includes("apps") ?? false;

  rows.push({
    label: "VULNS",
    items: vulnsUnknown
      ? [[{ tone: "bad", text: "unknown (no evidence)" }]]
      : vulns === 0
        ? [[{ tone: "ok", text: "none open" }]]
        : SEVERITY_ORDER.filter((level) => chip[level] > 0).map((level) => [{ tone: level, text: `${chip[level]} ${level}` }]),
  });

  if (chip.types.length > 0) {
    rows.push({
      label: "KINDS",
      items: chip.types.map((type) => [{ tone: "type", text: `${type.name} ` }, { tone: "count", text: String(type.count) }]),
    });
  }

  const failing: Part[][] = [
    appsUnknown
      ? [{ tone: "bad", text: "apps unknown (no evidence)" }]
      : chip.red > 0
        ? [{ tone: "bad", text: `${chip.red} of ${chip.apps} apps` }]
        : [{ tone: "ok", text: `0 of ${chip.apps} apps` }],
  ];
  if (chip.ops > 0) {
    const socrates: Part[] = [{ tone: "ops", text: `${chip.ops} Socrates checks` }];
    if (chip.opsHigh > 0) socrates.push({ tone: "high", text: ` (${chip.opsHigh} high)` });
    failing.push(socrates);
  }
  rows.push({ label: "FAILING", items: failing });
  // All caps, matching every other statusline row (2026-09-22).
  return rows.map((row) => ({ label: row.label, items: row.items.map((item) => item.map((part) => ({ ...part, text: part.text.toUpperCase() }))) }));
}

/** Plain-text form of the same rows, one per line, for the sidecar and any reader without colour. */
export function renderChip(chip: Counts): string {
  return rowsFor(chip)
    .map((row) => `${row.label.padEnd(8)}${row.items.map((item) => item.map((part) => part.text).join("")).join(" · ")}`)
    .join("\n");
}

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

export function vulnerabilityCounts(entries: AchillesEntry[]): Pick<EstateChip, "crit" | "high" | "med" | "low" | "types" | "ops" | "opsHigh"> {
  const open = entries.filter((entry) => entry.status === "open" || entry.status === "in_progress");
  const ops = open.filter((entry) => entry.source === "socrates");
  const vulns = open.filter((entry) => entry.source !== "socrates");
  const tally = new Map<string, number>();
  for (const entry of vulns) tally.set(vulnType(entry), (tally.get(vulnType(entry)) ?? 0) + 1);
  const types = [...tally.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (a.name === "other" ? 1 : 0) - (b.name === "other" ? 1 : 0) || b.count - a.count || a.name.localeCompare(b.name));
  return {
    crit: vulns.filter((entry) => entry.severity === "critical").length,
    high: vulns.filter((entry) => entry.severity === "high").length,
    med: vulns.filter((entry) => entry.severity === "medium").length,
    low: vulns.filter((entry) => entry.severity === "low").length,
    types,
    ops: ops.length,
    opsHigh: ops.filter((entry) => entry.severity === "high" || entry.severity === "critical").length,
  };
}

/** Evidence counts, with unreadable sources named as unavailable instead of defaulted to zero. */
export function countsFrom(
  registry: AchillesRegistry | undefined,
  bunker: Pick<EstateChip, "apps" | "red"> | undefined,
): Counts {
  const unavailable: Array<"vulns" | "apps"> = [];
  if (!registry || !Array.isArray(registry.entries)) unavailable.push("vulns");
  if (!bunker) unavailable.push("apps");
  const vulnerabilities = vulnerabilityCounts(Array.isArray(registry?.entries) ? registry!.entries! : []);
  return { apps: 0, red: 0, ...bunker, ...vulnerabilities, ...(unavailable.length ? { unavailable } : {}) };
}

async function bunkerCounts(): Promise<Pick<EstateChip, "apps" | "red"> | undefined> {
  const snapshot = readJson<BunkerSnapshot>(BUNKER_SNAPSHOT);
  if (snapshot?.apps) {
    // The snapshot can list one app more than once; count names, not rows.
    const failing = new Set(snapshot.apps.filter((app) => (app.fail ?? 0) > 0).map((app, index) => app.name ?? `#${index}`));
    return { apps: snapshot.summary?.apps ?? snapshot.apps.length, red: failing.size };
  }

  // There is no snapshot on a newly installed monitor. Discovery reads manifests only;
  // monitor state supplies last-known red health and is intentionally not re-probed here.
  const registryPath = join(import.meta.dir, "../PULSE/Bunker/src/registry.ts");
  if (!existsSync(registryPath)) return undefined;
  try {
    const { discoverApps } = await import(registryPath);
    const apps = await discoverApps();
    const state = readJson<MonitorState>(BUNKER_MONITOR_STATE) ?? {};
    return { apps: apps.length, red: apps.filter((app) => state[app.name]?.status === "red").length };
  } catch {
    return undefined;
  }
}

export async function refresh(): Promise<EstateChip> {
  const counts = countsFrom(readJson<AchillesRegistry>(ACHILLES_REGISTRY), await bunkerCounts());
  const rows = rowsFor(counts);
  const chip: EstateChip = {
    ...counts,
    rows,
    updated: new Date().toISOString(),
    severity: severityOf(counts),
  };
  const paths = cachePaths();
  const line = renderChip(counts);
  // Printable ASCII only: the statusline measures width with the character count, and nothing here may carry an escape.
  const texts = rows.flatMap((row) => [row.label, ...row.items.flat().map((part) => part.text)]);
  invariant(texts.every((text) => /^[\x20-\x7e]*$/.test(text)), "estate chip text must be printable ASCII");
  for (const path of [paths.txt, paths.json]) mkdirSync(dirname(path), { recursive: true });
  atomicWrite(paths.txt, line);
  atomicWrite(paths.json, JSON.stringify(chip, null, 2) + "\n");
  return chip;
}

function atomicWrite(path: string, contents: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, contents);
  renameSync(temp, path);
}

export function readCache(json = false): string {
  const path = json ? cachePaths().json : cachePaths().txt;
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--refresh")) await refresh();
  else process.stdout.write(readCache(args.includes("--json")));
}
