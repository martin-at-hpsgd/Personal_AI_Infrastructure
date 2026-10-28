/**
 * Models collectors — every place a model is used, across the whole estate.
 *
 * One collector per source, so each source sweeps on its own: a Cloudflare outage can never
 * expire a LifeOS edge, and a source that could not be read keeps its prior edges (it reports
 * complete:false, and Atlas only sweeps on a complete run). Sources:
 *   models-lifeos       ~/.claude code and config (plus the USER tree), agent frontmatter
 *   models-projects     every repo PROJECTS.md lists, whichever root holds it
 *   models-workflows    workflow definitions in LIFEOS/USER/WORKFLOWS
 *   models-cloudflare   deployed workers: plain-text vars and the deployed bundle (what actually runs)
 *   models-codex        codex config
 *   models-raycast      Raycast AI (its model choice sits in an encrypted store: reported unreadable)
 *   models-claude-code  the carrier and alias pins in settings.json
 *
 * Each use becomes a USES edge consumer → `model:<vendor>:<id>`, labelled by
 * LIFEOS/TOOLS/ModelEstate.ts: tracks (names a registry lane), pinned (types a current id),
 * stale (types an id the registry has moved past), auto-moving (a vendor alias or -latest id).
 * Each run also writes a `model-source:<name>` asset carrying that source's coverage:
 * scanned, degraded or unreadable. Never stores a value that is not a model id.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { ATLAS_DIR, type AssetObs, type CollectResult, type Collector, type EdgeObs } from "../Store";
import {
  buildExport, classifyLane, classifyTyped, isModelSelection, laneRefs, MODEL_ID_RG, shapeOf,
  type Classified, type RegistryExport, type UseStatus,
} from "../../TOOLS/ModelEstate";
import { SCAN_EXCLUDES } from "../../TOOLS/UpdateModels";
import { getClaudeDir } from "../../TOOLS/Paths";
import { cf, mapPool, token } from "./Cloudflare";

export type Coverage = "scanned" | "degraded" | "unreadable";

/** One observed use before grouping. */
type Use = {
  consumer: { key: string; kind: string; name: string; attrs: Record<string, unknown> };
  id: string;
  cls: Classified;
  via: string; // "typed" | "lane:<lane>" | "var:<NAME>" | "bundle"
  file?: string; // where-used label: a relative path, or a Raycast command title (no path exists there)
};

const STATUS_RANK: Record<UseStatus, number> = { tracks: 0, pinned: 1, "auto-moving": 2, stale: 3 };
export const worst = (a: UseStatus, b: UseStatus): UseStatus => (STATUS_RANK[a] >= STATUS_RANK[b] ? a : b);

export const modelKey = (vendor: string, id: string) => `model:${vendor}:${id}`;

function modelAsset(id: string, reg: RegistryExport): AssetObs {
  const cls = classifyTyped(id, reg);
  const lanes = Object.values(reg.lanes).filter((e) => e.id === id).map((e) => e.lane);
  const registry = lanes.length ? "current" : cls.status === "stale" ? "superseded" : cls.unregistered ? "unregistered" : "other";
  return { kind: "model", key: modelKey(cls.vendor, id), name: id, attrs: { vendor: cls.vendor, id, class: shapeOf(id).family, lanes, registry } };
}

/** Group uses into assets and USES edges, plus the source's coverage asset. Pure. */
export function toResult(
  source: string, uses: Use[], coverage: Coverage, detail: string, reg: RegistryExport,
  extra: { assets?: AssetObs[]; edges?: EdgeObs[]; scanned?: number; complete?: boolean } = {},
): CollectResult {
  const assets: AssetObs[] = [...(extra.assets ?? [])];
  const edges: EdgeObs[] = [...(extra.edges ?? [])];
  const consumers = new Map<string, Use["consumer"]>();
  const models = new Set<string>();
  const grouped = new Map<string, { use: Use; status: UseStatus; via: Set<string>; files: Set<string>; hits: number }>();
  for (const u of uses) {
    consumers.set(u.consumer.key, u.consumer);
    models.add(u.id);
    const k = `${u.consumer.key}\u0000${u.id}`;
    const g = grouped.get(k) ?? { use: u, status: u.cls.status, via: new Set<string>(), files: new Set<string>(), hits: 0 };
    g.status = worst(g.status, u.cls.status);
    g.via.add(u.via);
    if (u.file) g.files.add(u.file);
    g.hits++;
    grouped.set(k, g);
  }
  for (const c of consumers.values()) assets.push({ kind: c.kind, key: c.key, name: c.name, attrs: c.attrs });
  for (const id of models) assets.push(modelAsset(id, reg));
  for (const g of grouped.values()) {
    const { use, status } = g;
    edges.push({
      kind: "USES", srcKey: use.consumer.key, dstKey: modelKey(use.cls.vendor, use.id), srcKind: use.consumer.kind, dstKind: "model",
      attrs: {
        status, source, via: [...g.via].sort(), lanes: use.cls.lanes, hits: g.hits,
        files: [...g.files].sort().slice(0, 10),
        ...(use.cls.currentId ? { current_id: use.cls.currentId } : {}),
        ...(use.cls.unregistered ? { unregistered: true } : {}),
        ...(use.cls.ahead ? { ahead: true } : {}),
      },
    });
  }
  assets.push({
    kind: "model-source", key: `model-source:${source}`, name: source,
    attrs: { coverage, detail: detail.slice(0, 400), at: new Date().toISOString(), consumers: consumers.size, uses: grouped.size, scanned: extra.scanned ?? null },
  });
  // `complete` may be set by a source whose readable part was read in full but which has a
  // standing, named gap (the Raycast source): sweeping what it can read is right; the gap stays visible.
  return { complete: extra.complete ?? coverage === "scanned", assets, edges };
}

// ── Text scanning ────────────────────────────────────────────────────

const CODE_GLOBS = ["*.{ts,tsx,js,jsx,mjs,cjs,json,jsonc,yaml,yml,toml,py,sh}"];
const VENDORED_GLOBS = ["node_modules", "vendor", "dist", "build", ".next", ".wrangler", ".svelte-kit", ".astro", "coverage", "__snapshots__"]
  .map((d) => `!**/${d}/**`).concat(["!*.lock", "!package-lock.json", "!*.min.js"]);

/** Records of what ran, not selections: ISAs, changelogs, memory, tests, fixtures, evals. */
export const HISTORICAL = ["/MEMORY/", "ISA.md", "CHANGELOG", "changelog", "/tests/", "/test/", "/__tests__/", ".test.", ".spec.", "/fixtures/", "/Fixtures/", "/evals/", "/Evals/", ".bak", "/node_modules/", "/vendor/"];

export function excluded(path: string, extra: string[] = []): boolean {
  return HISTORICAL.some((x) => path.includes(x)) || extra.some((x) => path.includes(x));
}

type Hit = { path: string; match: string };

/** rg -o over roots; null when rg is missing or errors (exit 2), [] when nothing matched. */
export function rgMatches(roots: string[], pattern: string, extraGlobs: string[] = []): Hit[] | null {
  if (!Bun.which("rg")) return null;
  const args = ["rg", "--no-heading", "--with-filename", "--null", "-o", "-N", "--no-messages", "--max-filesize", "2M"];
  for (const g of [...CODE_GLOBS, ...VENDORED_GLOBS, ...extraGlobs]) args.push("-g", g);
  args.push("-e", pattern, ...roots);
  const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode === 2 && r.stdout.length === 0) return null;
  const out: Hit[] = [];
  for (const line of r.stdout.toString().split("\n")) {
    const i = line.indexOf("\0");
    if (i > 0) out.push({ path: line.slice(0, i), match: line.slice(i + 1).trim() });
  }
  return out;
}

const LANE_RG = String.raw`CROSS_VENDOR(?:\.[A-Za-z_]\w*|\[\s*["'][A-Za-z_]\w*["']\s*\])|\bCURRENT(?:\.(?:opus|sonnet|haiku|fable)\b|\[\s*["'](?:opus|sonnet|haiku|fable)["']\s*\])|currentModel\(\s*["'](?:opus|sonnet|haiku|fable)["']\s*\)`;

const TIERS = new Set(["opus", "sonnet", "haiku", "fable"]);

/** A file naming this many distinct model ids is a catalog (a price table, a leaderboard,
 *  an SDK's model map): it lists models, it does not select one. Skipped and named in coverage. */
export const CATALOG_MIN_IDS = 8;

/** Uses in a tree: typed ids plus lane references, minus catalog files. */
function scanTree(
  roots: string[], consumerOf: (path: string) => Use["consumer"] | null, reg: RegistryExport, exclude: string[], extraGlobs: string[] = [],
): { uses: Use[]; catalogs: string[] } | null {
  const typed = rgMatches(roots, MODEL_ID_RG, extraGlobs);
  const lanes = rgMatches(roots, LANE_RG, extraGlobs);
  if (typed === null || lanes === null) return null;
  const byFile = new Map<string, Set<string>>();
  for (const h of typed) {
    if (excluded(h.path, exclude) || !isModelSelection(h.match)) continue;
    (byFile.get(h.path) ?? byFile.set(h.path, new Set()).get(h.path)!).add(h.match);
  }
  const catalogs: string[] = [];
  const uses: Use[] = [];
  for (const [path, ids] of byFile) {
    if (ids.size >= CATALOG_MIN_IDS) { catalogs.push(path); continue; }
    const consumer = consumerOf(path);
    if (consumer) for (const id of ids) uses.push({ consumer, id, cls: classifyTyped(id, reg), via: "typed", file: path });
  }
  for (const h of lanes) {
    if (excluded(h.path, exclude)) continue;
    const consumer = consumerOf(h.path);
    if (!consumer) continue;
    for (const lane of laneRefs(h.match)) {
      const c = classifyLane(lane, reg);
      if (c) uses.push({ consumer, id: c.id, cls: c, via: `lane:${c.lanes[0]}`, file: h.path });
    }
  }
  return { uses, catalogs };
}

const catalogNote = (catalogs: string[], shorten: (p: string) => string) =>
  catalogs.length ? `; ${catalogs.length} catalog file(s) skipped (${CATALOG_MIN_IDS}+ ids): ${catalogs.slice(0, 6).map(shorten).join(", ")}` : "";

const tilde = (p: string, home: string) => (p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);

// ── Sources ──────────────────────────────────────────────────────────

const HOME = homedir();
const CLAUDE_DIR = getClaudeDir();

type Leg = (reg: RegistryExport) => Promise<CollectResult>;

function guard(source: string, leg: Leg): Collector {
  return {
    name: source,
    async collect(): Promise<CollectResult> {
      const reg = buildExport();
      try {
        return await leg(reg);
      } catch (err) {
        // A source that blew up is unreadable, never "no models": keep prior edges, report why.
        return toResult(source, [], "unreadable", `collector error: ${(err as Error).message}`, reg);
      }
    },
  };
}

/** ~/.claude code and config, the USER tree (minus memory and workflows), agent frontmatter. */
export function lifeosLeg(opts: { claudeDir?: string } = {}): Leg {
  return async (reg) => {
    const root = opts.claudeDir ?? CLAUDE_DIR;
    if (!existsSync(root)) return toResult("models-lifeos", [], "unreadable", `${root} missing`, reg);
    const roots = [root];
    let userReal: string | null = null;
    const userLink = join(root, "LIFEOS", "USER");
    if (existsSync(userLink)) { userReal = realpathSync(userLink); if (userReal !== userLink) roots.push(userReal); }
    const consumerOf = (abs: string): Use["consumer"] => {
      const rel = userReal && abs.startsWith(userReal + "/") ? join("LIFEOS/USER", abs.slice(userReal.length + 1)) : relative(root, abs);
      return { key: `code:lifeos:${rel}`, kind: "code", name: rel, attrs: { scope: "lifeos", path: rel } };
    };
    const runtime = ["projects", "file-history", "telemetry", "plans", "cache", "debug", "shell-snapshots", "todos", "statsig", "logs"].map((d) => `!/${d}/**`);
    const exclude = [
      // HISTORICAL already carries the test dirs. SCAN_EXCLUDES also carries the generated registry export, so it is not repeated here.
      ...SCAN_EXCLUDES.filter((x) => x !== "/tests/" && x !== "/test/"),
      "LIFEOS/TOOLS/ModelEstate.ts", "LIFEOS/ATLAS/collectors/Models.ts",
      "/WORKFLOWS/", // its own source
    ];
    const scan = scanTree(roots, consumerOf, reg, exclude, runtime);
    if (scan === null) return toResult("models-lifeos", [], "unreadable", "rg unavailable", reg);
    const { uses, catalogs } = scan;
    // Agent frontmatter: `model: opus` follows the tier; a typed id is a pin.
    const agentsDir = join(root, "agents");
    if (existsSync(agentsDir)) {
      for (const f of readdirSync(agentsDir).filter((n) => n.endsWith(".md"))) {
        const m = readFileSync(join(agentsDir, f), "utf8").match(/^---\n[\s\S]*?^model:\s*["']?([\w.\-\[\]]+)/m);
        if (!m) continue;
        const v = m[1].replace(/\[1m\]$/i, "");
        const consumer = consumerOf(join(agentsDir, f));
        if (TIERS.has(v)) { const c = classifyLane(`claude.${v}`, reg)!; uses.push({ consumer, id: c.id, cls: c, via: `lane:claude.${v}`, file: join(agentsDir, f) }); }
        else if (isModelSelection(v)) uses.push({ consumer, id: v, cls: classifyTyped(v, reg), via: "typed", file: join(agentsDir, f) });
      }
    }
    for (const u of uses) u.file = undefined; // the consumer IS the file here
    const registryModels = [...new Set(Object.values(reg.lanes).map((e) => e.id))].map((id) => modelAsset(id, reg));
    return toResult("models-lifeos", uses, "scanned", `${roots.length} root(s)` + catalogNote(catalogs, (f) => consumerOf(f).name), reg, { assets: registryModels });
  };
}

/** Repo dirs a PROJECTS.md path cell names: backticked absolute or ~ paths that exist locally. */
export function repoDirsFromProjects(md: string, home: string, claudeDir: string): { project: string; dir: string; missing: boolean }[] {
  const out: { project: string; dir: string; missing: boolean }[] = [];
  const seen = new Set<string>();
  const main = md.split(/^## Routing Aliases/m)[0];
  for (const row of main.split("\n").filter((l) => /^\|/.test(l)).slice(2)) {
    const cells = row.split("|").map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    if (cells.length < 2) continue;
    const project = cells[0].replace(/\*\*/g, "").replace(/[🟡🟢🎯🚨⚠️]/gu, "").split("(")[0].trim();
    for (const m of cells[1].matchAll(/`(~\/[^`]+|\/[^`]+)`/g)) {
      let p = m[1].replace(/^~(?=\/)/, home).replace(/\/+$/, "");
      if (p.startsWith(claudeDir) || p.startsWith(join(home, ".config")) || p.startsWith("/tmp") || p.startsWith("/private/tmp")) continue;
      if (existsSync(p) && statSync(p).isFile()) p = dirname(p);
      if (seen.has(p)) continue;
      seen.add(p);
      out.push({ project, dir: p, missing: !existsSync(p) });
    }
  }
  return out;
}

/** The worker name a repo deploys as, from its deploy config at the root: the cf CLI's
 *  cloudflare.config.ts first, then a legacy wrangler file. First `name` wins. */
export function workerNameOf(dir: string): string | null {
  for (const f of ["cloudflare.config.ts", "wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const t = readFileSync(p, "utf8");
    const m = f.endsWith(".toml") ? t.match(/^name\s*=\s*"([^"]+)"/m)
      : f.endsWith(".ts") ? t.match(/\bname\s*:\s*["'`]([^"'`]+)["'`]/) : t.match(/"name"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return null;
}

export function projectsLeg(opts: { projectsMd?: string; home?: string; claudeDir?: string } = {}): Leg {
  return async (reg) => {
    const home = opts.home ?? HOME;
    const claudeDir = opts.claudeDir ?? CLAUDE_DIR;
    const mdPath = opts.projectsMd ?? join(claudeDir, "LIFEOS/USER/PROJECTS.md");
    if (!existsSync(mdPath)) return toResult("models-projects", [], "unreadable", "PROJECTS.md missing", reg);
    const repos = repoDirsFromProjects(readFileSync(mdPath, "utf8"), home, claudeDir);
    if (!repos.length) return toResult("models-projects", [], "unreadable", "PROJECTS.md lists no local repo paths", reg);
    const present = repos.filter((r) => !r.missing);
    const missing = repos.filter((r) => r.missing).map((r) => tilde(r.dir, home));
    const byDir = new Map(present.map((r) => [r.dir, r]));
    const consumerOf = (abs: string): Use["consumer"] | null => {
      let best: string | null = null;
      for (const d of byDir.keys()) if (abs.startsWith(d + "/") && (!best || d.length > best.length)) best = d;
      if (!best) return null;
      const r = byDir.get(best)!;
      return { key: `code:repo:${basename(best)}`, kind: "code", name: basename(best), attrs: { scope: "product", path: tilde(best, home), project: r.project } };
    };
    const scan = present.length ? scanTree(present.map((r) => r.dir), consumerOf, reg, []) : { uses: [], catalogs: [] };
    if (scan === null) return toResult("models-projects", [], "unreadable", "rg unavailable", reg);
    const { uses, catalogs } = scan;
    for (const u of uses) if (u.file) { const d = [...byDir.keys()].find((k) => u.file!.startsWith(k + "/")); if (d) u.file = relative(d, u.file); }
    // Repo → the worker it deploys as, so the view can compare the repo with what runs.
    const edges: EdgeObs[] = [];
    const assets: AssetObs[] = [];
    for (const r of present) {
      const w = workerNameOf(r.dir);
      const key = `code:repo:${basename(r.dir)}`;
      assets.push({ kind: "code", key, name: basename(r.dir), attrs: { scope: "product", path: tilde(r.dir, home), project: r.project, worker: w } });
      if (w) edges.push({ kind: "DEPLOYED_FROM", srcKey: `cloudflare:worker:${w}`, dstKey: key, srcKind: "worker", dstKind: "code" });
    }
    const cov: Coverage = missing.length ? "degraded" : "scanned";
    const detail = `${present.length} repo(s) scanned` + (missing.length ? `; not on disk: ${missing.join(", ")}` : "") + catalogNote(catalogs, (f) => tilde(f, home));
    return toResult("models-projects", uses, cov, detail, reg, { assets, edges, scanned: present.length });
  };
}

export function workflowsLeg(opts: { dir?: string } = {}): Leg {
  return async (reg) => {
    const dir = opts.dir ?? join(CLAUDE_DIR, "LIFEOS/USER/WORKFLOWS");
    if (!existsSync(dir)) return toResult("models-workflows", [], "unreadable", "workflows dir missing", reg);
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") walk(p);
        else if (/\.ya?ml$/.test(e.name)) files.push(p);
      }
    };
    walk(dir);
    const uses: Use[] = [];
    const idRe = new RegExp(MODEL_ID_RG, "g");
    for (const f of files) {
      const name = basename(f).replace(/\.workflow\.ya?ml$|\.ya?ml$/, "");
      const consumer = { key: `workflow:${name}`, kind: "workflow", name, attrs: { scope: "workflow", path: relative(dir, f) } };
      const text = readFileSync(f, "utf8");
      const typed = new Set<string>();
      for (const m of text.matchAll(idRe)) if (isModelSelection(m[0])) typed.add(m[0]);
      for (const id of typed) uses.push({ consumer, id, cls: classifyTyped(id, reg), via: "typed", file: relative(dir, f) });
      for (const m of text.matchAll(/^\s*(?:model|lane):\s*["']?([\w.@\/\-\[\]]+)/gm)) {
        const v = m[1].replace(/\[1m\]$/i, "");
        const c = classifyLane(v, reg);
        if (c) uses.push({ consumer, id: c.id, cls: c, via: `lane:${c.lanes[0]}`, file: relative(dir, f) });
      }
    }
    return toResult("models-workflows", uses, "scanned", `${files.length} definition(s)`, reg, { scanned: files.length });
  };
}

/** What the Cloudflare leg needs from the API; injectable so tests never touch the network. */
export type WorkerApi = {
  list(): Promise<Array<{ id: string; modified_on?: string }>>;
  vars(worker: string): Promise<Array<{ name: string; text: string }> | null>;
  bundle(worker: string): Promise<string | null>;
};

function liveWorkerApi(): WorkerApi | null {
  const tok = token();
  if (!tok) return null;
  let acct: string | null = null;
  /** A paged listing with the same backoff: cf() throws "CF <path> -> 429" on a rate limit. */
  const listing = async (path: string): Promise<unknown[]> => {
    for (let attempt = 0; ; attempt++) {
      try { return await cf(path, tok); }
      catch (err) {
        if (attempt >= 4 || !/-> (429|5\d\d)/.test((err as Error).message)) throw err;
        await Bun.sleep(1000 * 2 ** attempt);
      }
    }
  };
  const account = async () => {
    if (acct) return acct;
    const a = (await listing("/accounts")) as Array<{ id: string }>;
    if (!a[0]) throw new Error("no account visible to token");
    return (acct = a[0].id);
  };
  /** GET with backoff on 429/5xx: a 228-worker fan-out trips Cloudflare's rate limit. */
  const get = async (path: string): Promise<Response | null> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${tok}` } });
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) return null;
      const wait = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
      await Bun.sleep(Math.min(wait, 8000));
    }
    return null;
  };
  return {
    async list() { return (await listing(`/accounts/${await account()}/workers/scripts`)) as Array<{ id: string; modified_on?: string }>; },
    async vars(w) {
      const res = await get(`/accounts/${await account()}/workers/scripts/${w}/settings`);
      const body = res ? ((await res.json()) as { success?: boolean; result?: any }) : null;
      const s = body?.success ? body.result : null;
      if (!s) return null;
      // Only plain-text vars carry a readable value; secrets never do and are never read.
      return ((s.bindings ?? []) as Array<{ type: string; name?: string; text?: string }>)
        .filter((b) => b.type === "plain_text" && typeof b.text === "string")
        .map((b) => ({ name: b.name ?? "?", text: b.text! }));
    },
    async bundle(w) {
      const res = await get(`/accounts/${await account()}/workers/scripts/${w}/content/v2`);
      return res ? await res.text() : null;
    },
  };
}

/** One use read out of a deployed bundle. */
export type BundleUse = { id: string; lane?: string };

/**
 * Uses in a deployed bundle. Two kinds count, because a bundle carries every string its
 * dependencies carry (SDK model maps, leaderboards) and those are not selections:
 *   - registry pairs: `<lane>: "<id>"` for lanes the registry names. splitBundle decides
 *     whether they are a bundled copy of models.ts (one fact about the worker) or selections.
 *   - an id in a model-selection context: `model` within 24 characters before it.
 * Pure, so tests drive it with synthetic bundle text.
 */
export function bundleUses(text: string, reg: RegistryExport): BundleUse[] {
  const out = new Map<string, BundleUse>();
  const fromRegistry = new Set<string>();
  for (const e of Object.values(reg.lanes)) {
    const key = e.kind === "claude-tier" ? e.lane.slice("claude.".length) : e.lane;
    const re = new RegExp(`[{,\\s]["']?${key}["']?\\s*:\\s*["']([^"']{3,80})["']`, "g");
    for (const m of text.matchAll(re)) {
      if (!isModelSelection(m[1])) continue;
      if (e.kind === "claude-tier" && !m[1].startsWith("claude-")) continue;
      out.set(`${e.lane}\u0000${m[1]}`, { id: m[1], lane: e.lane });
      fromRegistry.add(m[1]);
    }
  }
  const idRe = new RegExp(MODEL_ID_RG, "g");
  for (const m of text.matchAll(idRe)) {
    if (!isModelSelection(m[0]) || fromRegistry.has(m[0])) continue;
    const before = text.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0);
    if (/model/i.test(before)) out.set(`\u0000${m[0]}`, { id: m[0] });
  }
  return [...out.values()];
}

/** A bundle with this many registry pairs carries a copy of models.ts, not a selection. */
export const SNAPSHOT_MIN_LANES = 3;

export type SnapshotBehind = { lane: string; id: string; current: string };

/**
 * Split a bundle's uses. A worker that bundled models.ts carries every lane as it was at deploy
 * time, and its minified code cannot show which lanes it calls. So a registry copy is one fact
 * about the worker (its copy is behind on these lanes, a redeploy refreshes it), never a use of
 * each model in it. A few lane-shaped pairs short of a copy read as typed selections.
 * Pure, so tests drive it with synthetic bundle uses.
 */
export function splitBundle(found: BundleUse[], reg: RegistryExport): { uses: BundleUse[]; snapshot: { lanes: number; behind: SnapshotBehind[] } | null } {
  const pairs = found.filter((b) => b.lane);
  const plain = found.filter((b) => !b.lane);
  if (new Set(pairs.map((p) => p.lane)).size < SNAPSHOT_MIN_LANES) return { uses: [...plain, ...pairs.map((p) => ({ id: p.id }))], snapshot: null };
  const behind = pairs
    .filter((p) => reg.lanes[p.lane!] && reg.lanes[p.lane!].id !== p.id)
    .map((p) => ({ lane: p.lane!, id: p.id, current: reg.lanes[p.lane!].id }))
    .sort((a, b) => a.lane.localeCompare(b.lane));
  return { uses: plain, snapshot: { lanes: new Set(pairs.map((p) => p.lane)).size, behind } };
}

/** Bundle uses cached per worker by modified_on so an unchanged worker is never downloaded
 *  twice. Only the uses are cached, never bundle text. */
type BundleCache = Record<string, { modified_on: string; uses: BundleUse[]; vars?: Array<{ name: string; id: string }> }>;

export function cloudflareLeg(opts: { api?: WorkerApi | null; cachePath?: string } = {}): Leg {
  return async (reg) => {
    const api = opts.api === undefined ? liveWorkerApi() : opts.api;
    if (!api) return toResult("models-cloudflare", [], "unreadable", "no Cloudflare token", reg);
    let workers: Array<{ id: string; modified_on?: string }>;
    try { workers = await api.list(); }
    catch (err) { return toResult("models-cloudflare", [], "unreadable", `worker listing failed: ${(err as Error).message}`, reg); }
    const cachePath = opts.cachePath ?? join(ATLAS_DIR, "models-worker-bundles.json");
    let cache: BundleCache = {};
    try { cache = JSON.parse(readFileSync(cachePath, "utf8")); } catch { /* first run */ }
    const failed: string[] = [];
    const uses: Use[] = [];
    const snapshots: AssetObs[] = [];
    const snapshotEdges: EdgeObs[] = [];
    const idRe = new RegExp(MODEL_ID_RG, "g");
    const idsIn = (text: string) => [...new Set([...text.matchAll(idRe)].map((m) => m[0]).filter(isModelSelection))];
    await mapPool(workers, 3, async (w) => {
      const consumer = { key: `cloudflare:worker:${w.id}`, kind: "worker", name: w.id, attrs: {} };
      const mod = w.modified_on ?? "";
      const hit = cache[w.id];
      const fresh = !!mod && hit?.modified_on === mod;
      // Vars change only with a deploy or a settings write, both of which move modified_on,
      // so an unchanged worker costs no API call at all (Cloudflare allows 1,200 per 5 minutes,
      // and the Cloudflare collector shares that budget in the same tick).
      let varIds = fresh && Array.isArray(hit.vars) ? hit.vars : null;
      if (!varIds) {
        const vars = await api.vars(w.id).catch(() => null);
        if (vars === null) { failed.push(`${w.id} (settings)`); varIds = Array.isArray(hit?.vars) ? hit.vars : []; }
        else {
          varIds = vars.flatMap((v) => idsIn(v.text).map((id) => ({ name: v.name, id })));
          if (fresh) hit.vars = varIds;
        }
      }
      for (const v of varIds) uses.push({ consumer, id: v.id, cls: classifyTyped(v.id, reg), via: `var:${v.name}` });
      let found = fresh && Array.isArray(hit.uses) ? hit.uses : null;
      if (!found) {
        const text = await api.bundle(w.id).catch(() => null);
        if (text === null) { failed.push(`${w.id} (bundle)`); found = Array.isArray(hit?.uses) ? hit.uses : []; }
        else { found = bundleUses(text, reg); cache[w.id] = { modified_on: mod, uses: found, vars: varIds }; }
      }
      const split = splitBundle(found, reg);
      for (const b of split.uses) uses.push({ consumer, id: b.id, cls: classifyTyped(b.id, reg), via: "bundle" });
      if (split.snapshot) {
        const key = `registry-snapshot:${w.id}`;
        snapshots.push({ kind: "registry-snapshot", key, name: w.id, attrs: { worker: w.id, deployed: mod || null, lanes: split.snapshot.lanes, behind: split.snapshot.behind } });
        snapshotEdges.push({ kind: "CARRIES", srcKey: consumer.key, dstKey: key, srcKind: "worker", dstKind: "registry-snapshot" });
      }
    });
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(`${cachePath}.tmp`, JSON.stringify(cache));
      renameSync(`${cachePath}.tmp`, cachePath);
    } catch { /* cache is an optimisation; a failed write re-downloads next run */ }
    const cov: Coverage = failed.length ? "degraded" : "scanned";
    return toResult("models-cloudflare", uses, cov, `${workers.length} worker(s)` + (failed.length ? `; unread: ${failed.slice(0, 12).join(", ")}` : "") + (snapshots.length ? `; ${snapshots.length} carry a registry copy` : ""), reg, { scanned: workers.length, assets: snapshots, edges: snapshotEdges });
  };
}

export function codexLeg(opts: { configPath?: string } = {}): Leg {
  return async (reg) => {
    const p = opts.configPath ?? join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "config.toml");
    if (!existsSync(p)) return toResult("models-codex", [], "unreadable", "no codex config.toml", reg);
    const consumer = { key: "tool:codex", kind: "tool", name: "codex", attrs: { scope: "tool" } };
    const uses: Use[] = [];
    for (const m of readFileSync(p, "utf8").matchAll(/^\s*model\s*=\s*"([^"]+)"/gm)) {
      uses.push({ consumer, id: m[1], cls: classifyTyped(m[1], reg), via: "typed", file: "config.toml" });
    }
    return toResult("models-codex", uses, "scanned", `${uses.length} model setting(s)`, reg);
  };
}

/** Raycast model id → API id: the vendor prefix drops ("anthropic-<api id>" → "<api id>"), and
 *  the older Raycast shape "anthropic-claude-<major>-<minor>-<tier>" becomes "claude-<tier>-<major>-<minor>". */
export function apiIdFromRaycast(id: string): string {
  const bare = id.replace(/^(anthropic|openai|google|xai|perplexity|mistral|groq|deepseek)-/, "").replace(/-reasoning$/, "");
  const old = bare.match(/^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku|fable)$/);
  return old ? `claude-${old[3]}-${old[1]}${old[2] ? `-${old[2]}` : ""}` : bare;
}

/** Raycast keeps its live settings encrypted. The readable record of synced command and
 *  extension models is the newest Cloud Sync settings snapshot; the AI Chat default is not in it. */
export function raycastLeg(opts: { supportDir?: string } = {}): Leg {
  return async (reg) => {
    const dir = opts.supportDir ?? join(HOME, "Library/Application Support/com.raycast.macos");
    if (!existsSync(dir)) return toResult("models-raycast", [], "unreadable", "Raycast not installed", reg);
    const snapDir = join(dir, "cloud-sync/settings-snapshots");
    const files = existsSync(snapDir) ? readdirSync(snapDir).filter((f) => f.endsWith(".json")).sort() : [];
    if (!files.length) return toResult("models-raycast", [], "unreadable", "no Cloud Sync snapshot; the live Raycast stores are encrypted", reg);
    const file = files[files.length - 1];
    const snap = JSON.parse(readFileSync(join(snapDir, file), "utf8")) as { createdAt?: string; tables?: Record<string, unknown> };
    const consumer = { key: "tool:raycast", kind: "tool", name: "raycast", attrs: { scope: "tool" } };
    const uses: Use[] = [];
    for (const [table, rows] of Object.entries(snap.tables ?? {})) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows as Record<string, any>[]) {
        const meta = row?.syncedMeta ?? {};
        for (const k of ["model", "aiCommandModel"]) {
          if (typeof meta[k] !== "string") continue;
          const id = apiIdFromRaycast(meta[k]);
          if (!isModelSelection(id)) continue;
          uses.push({ consumer, id, cls: classifyTyped(id, reg), via: `${table}.${k}`, file: String(row.name ?? row.title ?? row.id ?? "?").slice(0, 80) });
        }
      }
    }
    const detail = `Cloud Sync snapshot ${snap.createdAt ?? file}; the AI Chat default sits in the encrypted Raycast store and is not read`;
    return toResult("models-raycast", uses, "degraded", detail, reg, { complete: true });
  };
}

export function claudeCodeLeg(opts: { settingsPath?: string } = {}): Leg {
  return async (reg) => {
    const p = opts.settingsPath ?? join(CLAUDE_DIR, "settings.json");
    if (!existsSync(p)) return toResult("models-claude-code", [], "unreadable", "no settings.json", reg);
    const s = JSON.parse(readFileSync(p, "utf8")) as { model?: string; env?: Record<string, string> };
    const consumer = { key: "tool:claude-code", kind: "tool", name: "claude-code", attrs: { scope: "tool" } };
    const uses: Use[] = [];
    const add = (raw: string, via: string) => {
      const v = raw.replace(/\[1m\]$/i, "");
      if (TIERS.has(v)) { const c = classifyLane(`claude.${v}`, reg)!; uses.push({ consumer, id: c.id, cls: c, via }); }
      else if (isModelSelection(v)) uses.push({ consumer, id: v, cls: classifyTyped(v, reg), via });
    };
    if (s.model) add(s.model, "setting:model");
    for (const [k, v] of Object.entries(s.env ?? {})) if (/MODEL/.test(k) && typeof v === "string") add(v, `env:${k}`);
    // No carrier pinned means the harness default, which follows the latest tier: nothing to report.
    return toResult("models-claude-code", uses, "scanned", s.model ? "carrier pinned" : "carrier is the harness default", reg);
  };
}

export const modelCollectors: Collector[] = [
  guard("models-lifeos", lifeosLeg()),
  guard("models-projects", projectsLeg()),
  guard("models-workflows", workflowsLeg()),
  guard("models-cloudflare", cloudflareLeg()),
  guard("models-codex", codexLeg()),
  guard("models-raycast", raycastLeg()),
  guard("models-claude-code", claudeCodeLeg()),
];

/** For tests: wrap any leg in the same never-throw contract. */
export const asCollector = guard;
