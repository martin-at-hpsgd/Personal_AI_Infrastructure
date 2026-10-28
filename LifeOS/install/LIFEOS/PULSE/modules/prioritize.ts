import { PRIVATE_SKILL_NAMES } from "../../TOOLS/CodeDataBoundary.ts";
/**
 * Prioritize Pulse module — recommendations service for work prioritization.
 *
 * Reads JSON files from a data directory and serves recommendations with
 * dismissal tracking. Routes:
 *   GET /api/prioritize → latest + status with dismissed ids filtered
 *   POST /api/prioritize/dismiss → mark a recommendation dismissed
 *   POST /api/prioritize/undismiss → unmark a recommendation
 *   POST /api/prioritize/run → spawn the Prioritize tool
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MODULE_NAME = "prioritize";
const state = { running: false };

interface Recommendation {
  id: string;
  category: string;
  title: string;
  why: string;
  next_action: string;
  priority: "now" | "soon" | "later";
  confidence: 1 | 2 | 3 | 4 | 5;
  evidence?: Array<{ ref: string; source: string; label: string; url?: string }>;
  first_seen: string;
  seen_count: number;
}

interface LatestJson {
  version: number;
  generated_at: string;
  model: string;
  vendor: string;
  lane: string;
  input_fingerprint: string;
  inputs: Record<string, number>;
  errors: Record<string, string>;
  summary: string;
  focus: string[];
  dropped: number;
  recommendations: Recommendation[];
}

interface StatusJson {
  last_check_at: string;
  last_generated_at: string | null;
  last_skip_reason: string | null;
  last_error: string | null;
  runs: number;
  skips: number;
}

interface DismissedJson {
  [id: string]: { at: string; title?: string };
}

function getDataDir(): string {
  if (process.env.LIFEOS_PRIORITIZE_DIR) {
    return process.env.LIFEOS_PRIORITIZE_DIR;
  }
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(home, ".claude", "LIFEOS", "MEMORY", "STATE", "prioritize");
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, data: unknown): void {
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  // Atomic rename
  const fs = require("fs");
  fs.renameSync(tmpPath, path);
}

function filterByDismissed(
  latest: LatestJson | null,
  dismissed: DismissedJson | null
): LatestJson | null {
  if (!latest || !dismissed) return latest;

  const dismissedIds = new Set(Object.keys(dismissed));
  return {
    ...latest,
    recommendations: latest.recommendations.filter((r) => !dismissedIds.has(r.id)),
    focus: latest.focus.filter((id) => !dismissedIds.has(id)),
  };
}

interface PrioritizeResponse {
  latest: LatestJson | null;
  status: StatusJson | null;
  dismissed_count: number;
}

async function handleGet(): Promise<Response> {
  const dataDir = getDataDir();
  const latest = readJson<LatestJson>(join(dataDir, "latest.json"));
  const status = readJson<StatusJson>(join(dataDir, "status.json"));
  const dismissed = readJson<DismissedJson>(join(dataDir, "dismissed.json")) || {};

  const filtered = filterByDismissed(latest, dismissed);

  return Response.json({
    latest: filtered,
    status,
    dismissed_count: Object.keys(dismissed).length,
  } as PrioritizeResponse);
}

async function handleDismiss(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { id?: string };
    const id = body.id?.trim();

    if (!id || !/^[a-z0-9-]{6,64}$/.test(id)) {
      return Response.json({ error: "Invalid id format" }, { status: 400 });
    }

    const dataDir = getDataDir();
    const dismissed = readJson<DismissedJson>(
      join(dataDir, "dismissed.json")
    ) || {};
    const latest = readJson<LatestJson>(join(dataDir, "latest.json"));

    const title = latest?.recommendations.find((r) => r.id === id)?.title;
    dismissed[id] = { at: new Date().toISOString(), ...(title && { title }) };

    writeJsonAtomic(join(dataDir, "dismissed.json"), dismissed);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 400 });
  }
}

async function handleUndismiss(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { id?: string };
    const id = body.id?.trim();

    if (!id || !/^[a-z0-9-]{6,64}$/.test(id)) {
      return Response.json({ error: "Invalid id format" }, { status: 400 });
    }

    const dataDir = getDataDir();
    const dismissed = readJson<DismissedJson>(
      join(dataDir, "dismissed.json")
    ) || {};

    delete dismissed[id];
    writeJsonAtomic(join(dataDir, "dismissed.json"), dismissed);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 400 });
  }
}

async function handleRun(): Promise<Response> {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const toolPath = join(
    home,
    ".claude",
    "skills",
    PRIVATE_SKILL_NAMES.prioritize,
    "Tools",
    "Prioritize.ts"
  );

  // prioritize skill is a private skill; a public install has no file here. Say so instead of
  // reporting started:true for a child that dies on a missing path (7.52.0 in-family audit).
  if (!existsSync(toolPath)) return Response.json({ ok: false, unavailable: "Prioritize skill not installed" }, { status: 503 });

  const env = { ...process.env, LIFEOS_NOTIFICATION_CHANNEL: "headless" };

  // Async spawn: the run takes ~20s and must never block the Pulse server. The tool's own lock
  // makes a second click while a run is in flight a no-op.
  const proc = Bun.spawn(["bun", toolPath, "run", "--force"], {
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  proc.unref();

  return Response.json({ ok: true, started: true });
}

export async function start(): Promise<void> {
  state.running = true;
  console.log(`[${MODULE_NAME}] started`);
}

export async function stop(): Promise<void> {
  state.running = false;
}

export function health(): { status: string; details?: Record<string, unknown> } {
  const dataDir = getDataDir();
  let latest: LatestJson | null = null;
  let dismissed = 0;
  try {
    latest = readJson<LatestJson>(join(dataDir, "latest.json"));
    const d = readJson<DismissedJson>(join(dataDir, "dismissed.json"));
    dismissed = d ? Object.keys(d).length : 0;
  } catch {
    /* ignore */
  }
  return {
    status: state.running ? "healthy" : "stopped",
    details: {
      recommendations: latest?.recommendations.length ?? 0,
      dismissed_count: dismissed,
    },
  };
}

export async function handleRequest(
  req: Request,
  pathname: string
): Promise<Response | null> {
  const sub = pathname.replace(/^\/api\/prioritize/, "") || "/";

  if (sub === "/" || sub === "") {
    if (req.method === "GET") return handleGet();
  } else if (sub === "/dismiss") {
    if (req.method === "POST") return handleDismiss(req);
  } else if (sub === "/undismiss") {
    if (req.method === "POST") return handleUndismiss(req);
  } else if (sub === "/run") {
    if (req.method === "POST") return handleRun();
  }

  return null;
}
