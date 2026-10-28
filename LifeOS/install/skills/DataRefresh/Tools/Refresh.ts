#!/usr/bin/env bun
/**
 * Refresh.ts — registry-driven data-freshness engine for data-backed public sites
 * and their linked source-of-record datasets.
 *
 * Commands:
 *   bun Refresh.ts status [target] [--live]     freshness report (STALE/FRESH vs cadence)
 *   bun Refresh.ts refresh <target|--all> [--deploy]
 *       fetch → dataset-of-record update → build. NEVER deploys without --deploy.
 *       --deploy additionally runs the target's sanctioned deploy command, then its
 *       live verify probe, and reports live freshness.
 *
 * Registry: $DATAREFRESH_REGISTRY or ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/DataRefresh/Registry.json
 * All personal paths/targets live in the registry (USER tree), never in this file.
 * Run log: ~/.claude/LIFEOS/MEMORY/OBSERVABILITY/datarefresh.jsonl
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { lifeosPath } from "../../../LIFEOS/TOOLS/Paths.ts";

const HOME = homedir();
const REGISTRY_PATH =
  process.env.DATAREFRESH_REGISTRY ??
  lifeosPath("USER", "CUSTOMIZATIONS", "SKILLS", "DataRefresh", "Registry.json");
const LOG_PATH = lifeosPath("MEMORY", "OBSERVABILITY", "datarefresh.jsonl");

interface Target {
  name: string;
  repo: string; // ~-relative or absolute
  fetch: string[][]; // argv arrays, run in repo cwd
  build?: string[]; // argv array
  deploy?: string[]; // argv array — sanctioned deploy command, only with --deploy
  dataDir?: string; // dir holding pulled JSON (default "data")
  timestampConvention?: "meta-json" | "mtime"; // default meta-json with mtime fallback
  cadenceDays: number;
  verifyUrl?: string; // live JSON endpoint
  verifyField?: string; // dot-path to freshness field in verify JSON
  dataset?: { update: string[]; cwd?: string; summary?: string }; // source-of-record dataset (e.g. a dataset repo's update script)
  notes?: string;
}

const expand = (p: string) => (p.startsWith("~/") ? join(HOME, p.slice(2)) : p);

function loadRegistry(): Target[] {
  if (!existsSync(REGISTRY_PATH)) fail(`not configured: no registry at ${REGISTRY_PATH}. Create it by following skills/DataRefresh/Setup.md`);
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } catch (e) {
    fail(`registry is not valid JSON: ${e}`);
  }
  const targets: Target[] = parsed.targets ?? [];
  if (Array.isArray(targets) && targets.length === 0) fail(`not configured: ${REGISTRY_PATH} has no targets yet. Add one by following skills/DataRefresh/Setup.md`);
  invariant(Array.isArray(targets) && targets.length > 0, "registry has a non-empty targets array");
  for (const t of targets) {
    const ctx = `registry entry "${t?.name ?? "?"}"`;
    invariant(typeof t.name === "string" && t.name.length > 0, `${ctx}: name present`);
    invariant(typeof t.repo === "string" && existsSync(expand(t.repo)), `${ctx}: repo path exists (${t.repo})`);
    invariant(Array.isArray(t.fetch) && t.fetch.every((c) => Array.isArray(c) && c.length > 0), `${ctx}: fetch is a list of argv arrays`);
    invariant(typeof t.cadenceDays === "number" && t.cadenceDays > 0, `${ctx}: cadenceDays > 0`);
    if (t.deploy) invariant(Array.isArray(t.deploy) && t.deploy.length > 0, `${ctx}: deploy is an argv array`);
    if (t.dataset) invariant(Array.isArray(t.dataset.update) && t.dataset.update.length > 0, `${ctx}: dataset.update is an argv array`);
  }
  return targets;
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function run(argv: string[], cwd: string, label: string): { ok: boolean; tail: string } {
  const resolved = argv.map(expand);
  const r = Bun.spawnSync(resolved, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  const tail = out.trim().split("\n").slice(-3).join("\n");
  if (r.exitCode !== 0) console.error(`  ✗ ${label} failed (exit ${r.exitCode}):\n${tail}`);
  return { ok: r.exitCode === 0, tail };
}

/** Newest fetched_at across the target's data files; falls back to newest mtime. */
function lastPulled(t: Target): { iso: string | null; source: string } {
  const dir = join(expand(t.repo), t.dataDir ?? "data");
  if (!existsSync(dir)) return { iso: null, source: "no data dir" };
  let newestMeta: string | null = null;
  let newestMtime = 0;
  for (const f of new Bun.Glob("*.json").scanSync(dir)) {
    const p = join(dir, f);
    newestMtime = Math.max(newestMtime, statSync(p).mtimeMs);
    if (t.timestampConvention !== "mtime") {
      try {
        const j = JSON.parse(readFileSync(p, "utf-8"));
        const ts = j?._meta?.fetched_at ?? j?._meta?.fetched ?? j?.generated ?? null;
        if (typeof ts === "string" && (!newestMeta || ts > newestMeta)) newestMeta = ts;
      } catch {
        /* non-JSON or huge file: mtime covers it */
      }
    }
  }
  if (newestMeta) return { iso: newestMeta, source: "_meta" };
  if (newestMtime > 0) return { iso: new Date(newestMtime).toISOString(), source: "mtime" };
  return { iso: null, source: "no json files" };
}

const daysOld = (iso: string) => (Date.now() - Date.parse(iso)) / 86_400_000;

function dig(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

/** ok is true only when the probe answered 2xx and the freshness field was present. */
async function probeLive(t: Target): Promise<{ ok: boolean; value: string }> {
  if (!t.verifyUrl) return { ok: true, value: "—" };
  try {
    const r = await fetch(`${t.verifyUrl}${t.verifyUrl.includes("?") ? "&" : "?"}cb=${Date.now()}`, {
      headers: { "User-Agent": "datarefresh/1.0" },
    });
    if (!r.ok) return { ok: false, value: `HTTP ${r.status}` };
    const j = await r.json();
    const v = t.verifyField ? dig(j, t.verifyField) : null;
    if (v == null) return { ok: false, value: "field missing" };
    return { ok: true, value: typeof v === "string" ? v : JSON.stringify(v).slice(0, 40) };
  } catch (e) {
    return { ok: false, value: `unreachable (${String(e).slice(0, 60)})` };
  }
}

const liveFreshness = async (t: Target): Promise<string> => (await probeLive(t)).value;

/**
 * True only when the live freshness value moved forward from the pre-deploy one: numbers by
 * value, dates by time, plain text by string order (ISO dates sort that way). A change of kind
 * (a date replaced by unrelated text) or a value that went backwards is not an advance.
 */
function advanced(pre: string, now: string): boolean {
  const num = (s: string) => (s.trim() !== "" && Number.isFinite(Number(s)) ? Number(s) : null);
  const date = (s: string) => (num(s) === null && !Number.isNaN(Date.parse(s)) ? Date.parse(s) : null);
  const [pn, nn] = [num(pre), num(now)];
  if (pn !== null || nn !== null) return pn !== null && nn !== null && nn > pn;
  const [pd, nd] = [date(pre), date(now)];
  if (pd !== null || nd !== null) return pd !== null && nd !== null && nd > pd;
  return now > pre;
}

// Seconds between live probes after a deploy; overridable so tests do not wait a minute.
const POLL_MS = Number(process.env.DATAREFRESH_POLL_MS) > 0 ? Number(process.env.DATAREFRESH_POLL_MS) : 10_000;

/** Flag when the dataset's human summary looks older than the data itself. */
function summaryDriftFlag(t: Target, freshIso: string): string | null {
  const summary = t.dataset?.summary ? expand(t.dataset.summary) : null;
  if (!summary || !existsSync(summary)) return null;
  const dates = (readFileSync(summary, "utf-8").match(/20\d\d-\d\d-\d\d/g) ?? []).sort();
  const newest = dates[dates.length - 1];
  if (!newest) return null;
  if (newest < freshIso.slice(0, 10)) {
    return `⚠ dataset summary ${t.dataset!.summary} newest date ${newest} < fresh data ${freshIso.slice(0, 10)} — headline prose may be stale (DA follow-up, tool never edits prose)`;
  }
  return null;
}

function log(entry: Record<string, unknown>) {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

// ---------------------------------------------------------------- commands

async function cmdStatus(name: string | undefined, live: boolean) {
  const targets = loadRegistry().filter((t) => !name || t.name === name);
  if (name && targets.length === 0) fail(`no registry target named "${name}"`);
  const rows: string[][] = [["TARGET", "LAST PULL", "AGE", "CADENCE", "STATE", live ? "LIVE" : ""]];
  for (const t of targets) {
    const lp = lastPulled(t);
    const age = lp.iso ? daysOld(lp.iso) : Infinity;
    // A timestamp Date.parse cannot read gives NaN, and NaN > cadence is false: never call that FRESH.
    const state = !lp.iso || Number.isNaN(age) ? "UNKNOWN" : age > t.cadenceDays ? "STALE" : "FRESH";
    rows.push([
      t.name,
      lp.iso ? `${lp.iso.slice(0, 10)} (${lp.source})` : lp.source,
      lp.iso && !Number.isNaN(age) ? `${age.toFixed(1)}d` : "?",
      `${t.cadenceDays}d`,
      state,
      live ? await liveFreshness(t) : "",
    ]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd());
  const stale = rows.slice(1).filter((r) => r[4] === "STALE" || r[4] === "UNKNOWN").length;
  console.log(`\n${stale === 0 ? "✓ all targets fresh" : `✗ ${stale} target(s) need a refresh`}`);
  process.exitCode = stale === 0 ? 0 : 2;
}

async function cmdRefresh(name: string, deploy: boolean) {
  const all = loadRegistry();
  const targets = name === "--all" ? all : all.filter((t) => t.name === name);
  if (targets.length === 0) fail(`no registry target named "${name}"`);
  let failures = 0;
  let unverified = 0;
  for (const t of targets) {
    const repo = expand(t.repo);
    const before = lastPulled(t).iso ?? "none";
    console.log(`\n═══ ${t.name} ═══`);
    let ok = true;
    for (const f of t.fetch) ok = run(f, repo, `fetch: ${f.join(" ")}`).ok && ok;
    if (t.dataset && ok) {
      const dcwd = t.dataset.cwd ? expand(t.dataset.cwd) : repo;
      ok = run(t.dataset.update, dcwd, `dataset update: ${t.dataset.update.join(" ")}`).ok && ok;
    }
    if (t.build && ok) ok = run(t.build, repo, `build: ${t.build.join(" ")}`).ok && ok;
    const after = lastPulled(t).iso ?? "none";
    console.log(`  pulled: ${before.slice(0, 10)} → ${after.slice(0, 10)}${ok ? "" : "  (with failures)"}`);
    if (t.dataset && after !== "none") {
      const drift = summaryDriftFlag(t, after);
      if (drift) console.log(`  ${drift}`);
    }
    let live = "";
    let liveVerified = false;
    if (deploy && ok) {
      invariant(!!t.deploy, `target ${t.name} has a sanctioned deploy command before --deploy runs`);
      const preDeploy = await probeLive(t);
      ok = run(t.deploy!, repo, `deploy: ${t.deploy!.join(" ")}`).ok;
      if (ok) {
        // Edge propagation is not instant; a warm T+0 probe is not the authority.
        let probe = preDeploy;
        for (let i = 0; i < 6; i++) {
          probe = await probeLive(t);
          // No pre-deploy baseline means nothing to advance past: stop at the first good probe.
          if (!t.verifyUrl || (probe.ok && (!preDeploy.ok || advanced(preDeploy.value, probe.value)))) break;
          await Bun.sleep(POLL_MS);
        }
        live = probe.value;
        if (!t.verifyUrl) {
          console.log(`  live freshness: no verifyUrl configured — deploy accepted, not live-verified`);
        } else if (!probe.ok) {
          ok = false;
          console.log(`  ✗ live verify failed: ${live}`);
        } else if (!preDeploy.ok) {
          console.log(`  live freshness: ${live}  ⚠ no pre-deploy value to compare (${preDeploy.value}) — deployed, NOT live-verified; verify manually`);
        } else if (!advanced(preDeploy.value, probe.value)) {
          console.log(`  live freshness: ${live}  ⚠ did not advance past ${preDeploy.value} after 6 probes — deployed, NOT live-verified; verify manually`);
        } else {
          liveVerified = true;
          console.log(`  live freshness: ${live}`);
        }
      }
    } else if (deploy && !ok) {
      console.log(`  ✗ skipping deploy — earlier step failed`);
    } else {
      console.log(`  (no deploy — data staged only; pass --deploy to ship)`);
    }
    if (!ok) failures++;
    log({ cmd: "refresh", target: t.name, before, after, deployed: deploy && ok, live, liveVerified, ok });
    if (deploy && ok && !liveVerified) unverified++;
  }
  if (failures > 0) fail(`${failures} target(s) failed`);
  console.log(
    `\n✓ refresh complete${deploy ? (unverified === 0 ? " (deployed + live-verified)" : ` (deployed; ${unverified} target(s) NOT live-verified)`) : " (staged, not deployed)"}`,
  );
}

// ---------------------------------------------------------------- entry

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a) => !a.startsWith("--"));

if (cmd === "status") await cmdStatus(args[0], flags.has("--live"));
else if (cmd === "refresh") {
  const target = args[0] ?? (flags.has("--all") ? "--all" : undefined);
  if (!target) fail("refresh needs a target name or --all");
  await cmdRefresh(target, flags.has("--deploy"));
} else {
  console.log("usage: bun Refresh.ts status [target] [--live] | refresh <target|--all> [--deploy]");
  process.exit(cmd ? 1 : 0);
}
