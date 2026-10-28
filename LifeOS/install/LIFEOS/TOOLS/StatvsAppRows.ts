/**
 * StatvsAppRows — the Mac-side facts about each app, written to STATVS (STATVS ISA F8, ISC-109–112).
 *
 * Three tools already sit on the only path each fact can take, so they record it there:
 *   CfEnv.ts deploy        → stream `deploy`      (every real deploy, success or failure)
 *   ReleaseRecord prepare  → stream `release`     (every version bump and CHANGELOG entry)
 *   journey probe run    → stream `app-health`  (every load-to-content timing)
 *
 * An app is named by its Cloudflare worker (`surface`, `human3`), never by the folder a deploy
 * ran from: a deploy from a scratch checkout once recorded Surface as "surface-deploy".
 * Recording never changes the caller's outcome; a refused or spooled row only warns.
 *
 * @version 1.0.1
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeEvent, type EventInput } from "../STATVS/lib/event";
import { append } from "../STATVS/lib/record";
import type { StatvsInput } from "../STATVS/lib/types";
import { configWorkerName } from "./CfEnvChecks";
import { invariant } from "./Invariant";

/** The app a repo deploys: its worker name, else its package name, else the folder (last resort, flagged). */
export function appNameFor(root: string, hint?: { worker?: string | null; pagesProject?: string | null }): { app: string; from: "worker" | "pages" | "package" | "folder" } {
  if (hint?.worker) return { app: hint.worker, from: "worker" };
  if (hint?.pagesProject) return { app: hint.pagesProject, from: "pages" };
  const config = join(root, "cloudflare.config.ts");
  if (existsSync(config)) {
    const name = configWorkerName(readFileSync(config, "utf8"));
    if (name) return { app: name, from: "worker" };
  }
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    try {
      const name = (JSON.parse(readFileSync(pkg, "utf8")) as { name?: unknown }).name;
      if (typeof name === "string" && name.trim()) return { app: name.trim(), from: "package" };
    } catch { /* fall through to the folder */ }
  }
  return { app: basename(root), from: "folder" };
}

/** STATVS refuses any 40+ hex run as credential-shaped, and a full commit id is one, so every
 *  string in a row carries git's 12-hex short form, which `git rev-parse` still resolves (Review.ts does the same). */
export function shortHashes<T>(value: T): T {
  if (typeof value === "string") return value.replace(/[0-9a-f]{40,}/gi, (h) => h.slice(0, 12)) as T;
  if (Array.isArray(value)) return value.map(shortHashes) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shortHashes(v)])) as T;
  return value;
}

export type DeployFacts = {
  app: string; appFrom: string; version: string | null; head: string | null; dirty: boolean; versionId: string | null;
  previousVersionId: string | null; cfExit: number; review: unknown; releaseRecord: unknown; probes: unknown;
  socialCard: unknown; secretsLost: string[]; dir: string;
};

export function deployRow(f: DeployFacts): StatvsInput {
  invariant(f.app.length > 0 && Number.isInteger(f.cfExit), "a deploy row needs an app and cf's exit code");
  const ok = f.cfExit === 0;
  return {
    writer: "tool:CfEnv", stream: "deploy", class: "system", app: f.app,
    kind: ok ? "deployed" : "deploy-failed", severity: ok ? "info" : "high",
    title: ok ? `Deployed ${f.app}${f.versionId ? ` (${f.versionId.slice(0, 8)})` : ""}` : `Deploy of ${f.app} failed (cf exit ${f.cfExit})`,
    ref: f.head ?? undefined,
    data: { ...f },
  };
}

export type ReleaseFacts = { app: string; from: string | null; to: string; caps: number | null; notes: string; commit: string; repo: string };

export function releaseRow(f: ReleaseFacts): StatvsInput {
  invariant(f.app.length > 0 && f.to.length > 0, "a release row needs an app and its new version");
  return {
    writer: "tool:ReleaseRecord", stream: "release", class: "system", app: f.app,
    kind: "release", severity: "info", title: `${f.app} v${f.from ?? "none"} → v${f.to}`, ref: f.commit,
    data: { ...f },
  };
}

export type HealthFacts = { app: string; journey: string; outcome: string; median_ms: number | null; samples_ms: number[]; budget_ms: number; error: string | null };

export function healthRow(f: HealthFacts): StatvsInput {
  invariant(f.app.length > 0 && f.journey.length > 0, "an app-health row needs an app and a journey");
  const ok = f.outcome === "pass";
  return {
    writer: "tool:UxProbe", stream: "app-health", class: "system", app: f.app, // UxProbe is the maintainer-side journey probe; not in the public release
    kind: "journey", severity: ok ? "info" : "medium",
    title: `${f.journey} ${f.outcome}${f.median_ms != null ? ` ${f.median_ms} ms` : ""} (budget ${f.budget_ms})`,
    data: { ...f },
  };
}

/** The Vigil notice for a deploy, which the retired `deploys` adapter used to copy out of the Ledger file:
 *  info on success, high on failure, so a failed deploy still reaches the principal by text (migration ISC-36). */
export function deployNotice(f: DeployFacts, ts: string): EventInput {
  const ok = f.cfExit === 0;
  const v = f.version ? `version ${f.version}` : "version not recorded";
  return {
    source: "deploys", ts, kind: "infra", severity: ok ? "info" : "high", privacy_class: "personal", ref: f.app,
    title: (ok ? `Deployed ${f.app}${f.version ? ` ${f.version}` : ""}` : `Deploy failed: ${f.app}`).slice(0, 140),
    summary: `${f.app} ${v}; ${ok ? "succeeded" : `failed with exit code ${f.cfExit}`}${f.versionId ? `; Cloudflare version ${f.versionId}` : ""}.`.slice(0, 1000),
    dedup_key: `deploys:${f.app}:${ok ? "ok" : "failed"}:${ts}`,
  };
}

/** A deploy into the record and, as a notice, to Vigil. Never throws. */
export function recordDeploy(f: DeployFacts, ts = new Date().toISOString()): void {
  recordAppRow(deployRow(f));
  try {
    const r = writeEvent(shortHashes(deployNotice(f, ts)));
    if (!r.ok) console.error(`STATVS: deploy notice for ${f.app} not written: ${"refused" in r ? r.refused : "not accepted"}`);
  } catch (e) {
    console.error(`STATVS: deploy notice for ${f.app} not written: ${(e as Error).message}`);
  }
}

/** Appends one row and never throws: the deploy, release or probe it describes has already happened. */
export function recordAppRow(row: StatvsInput): boolean {
  try {
    const r = append(shortHashes(row));
    // A spooled row lands with the next good append, so it counts as recorded.
    if (r.ok || "spooled" in r) return true;
    console.error(`STATVS: ${row.stream} row for ${row.app} not recorded: ${r.refused}`);
  } catch (e) {
    console.error(`STATVS: ${row.stream} row for ${row.app} not recorded: ${(e as Error).message}`);
  }
  return false;
}
