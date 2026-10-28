/**
 * Workflow → application map. Which deployed applications or websites each
 * workflow serves, read from a USER-zone config and attached to every inventory
 * record as `apps`, so the /workflows page only renders icons.
 *
 * Config (`USER/CONFIG/workflow-apps.json`):
 *   { "apps": [ { "slug", "name", "url", "icon", "match": { "ids"?, "groups"?, "definedIn"? } } ] }
 * `icon` is a bare file name inside the icons directory beside the config.
 * `ids` match a record id exactly, `groups` match its group exactly, and
 * `definedIn` entries are path prefixes (home as ~) matched on a path-segment
 * boundary, so `~/p/app` covers `~/p/app` and `~/p/app/x` but never `~/p/app-two`.
 *
 * Everything here is read-only. A missing config means no apps; a malformed one
 * means no apps plus an error the inventory reports. Nothing here throws.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import type { Inventory, WorkflowApp, WorkflowRecord } from "../../WORKFLOWS/types.ts";

export interface AppMatch {
  ids: string[];
  groups: string[];
  definedIn: string[];
}

export interface AppEntry extends WorkflowApp {
  /** Bare file name inside the icons directory. */
  icon: string;
  match: AppMatch;
}

export interface AppConfig {
  apps: AppEntry[];
  /** Entries or fields that were skipped, one sentence each. */
  errors: string[];
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ICON_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_NAME = 80;
const MAX_ICON_BYTES = 512 * 1024;

export const ICON_TYPES: Readonly<Record<string, string>> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

function httpUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Shape-checks a parsed config. Bad entries are skipped and named; good ones survive. */
export function parseAppConfig(raw: unknown): AppConfig {
  if (!isObj(raw) || !Array.isArray(raw.apps)) return { apps: [], errors: ["the app map has no apps array"] };
  const apps: AppEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  raw.apps.forEach((a, i) => {
    const where = isObj(a) && typeof a.slug === "string" ? `app "${a.slug}"` : `app #${i + 1}`;
    if (!isObj(a)) { errors.push(`${where} is not an object`); return; }
    if (typeof a.slug !== "string" || !SLUG_RE.test(a.slug)) { errors.push(`${where} has no valid slug (lowercase letters, digits, hyphens)`); return; }
    if (seen.has(a.slug)) { errors.push(`${where} appears twice; the first one is used`); return; }
    if (typeof a.name !== "string" || !a.name.trim() || a.name.length > MAX_NAME) { errors.push(`${where} has no usable name`); return; }
    const url = httpUrl(a.url);
    if (!url) { errors.push(`${where} has no http(s) url`); return; }
    if (typeof a.icon !== "string" || !ICON_RE.test(a.icon) || a.icon.includes("..") || !(extname(a.icon).toLowerCase() in ICON_TYPES)) {
      errors.push(`${where} has no valid icon file name (.svg, .png, .ico or .webp, no directories)`);
      return;
    }
    const m = isObj(a.match) ? a.match : {};
    const match: AppMatch = { ids: stringList(m.ids), groups: stringList(m.groups), definedIn: stringList(m.definedIn) };
    if (match.ids.length + match.groups.length + match.definedIn.length === 0) { errors.push(`${where} matches nothing`); return; }
    seen.add(a.slug);
    apps.push({ slug: a.slug, name: a.name.trim(), url, icon: a.icon, match });
  });
  return { apps, errors };
}

/** Path-prefix test on a segment boundary: `~/a/b` covers `~/a/b` and `~/a/b/c`, never `~/a/bc`. */
export function underPath(path: string, prefix: string): boolean {
  const p = prefix.length > 1 && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === p || path.startsWith(`${p}/`);
}

/** The apps one record serves, in config order, each at most once. */
export function appsFor(record: Pick<WorkflowRecord, "id" | "group" | "definedIn">, apps: readonly AppEntry[]): WorkflowApp[] {
  const out: WorkflowApp[] = [];
  for (const a of apps) {
    const hit =
      a.match.ids.includes(record.id) ||
      a.match.groups.includes(record.group) ||
      (typeof record.definedIn === "string" && a.match.definedIn.some((p) => underPath(record.definedIn, p)));
    if (hit) out.push({ slug: a.slug, name: a.name, url: a.url });
  }
  return out;
}

/** A new inventory whose records carry `apps` (only where at least one matched). Config problems join `errors`. */
export function attachApps(inv: Inventory, config: AppConfig, source = "workflow-apps"): Inventory {
  const records = inv.records.map((r) => {
    const apps = appsFor(r, config.apps);
    if (apps.length > 0) return { ...r, apps };
    if (r.apps === undefined) return r;
    const { apps: _dropped, ...rest } = r; // a stale value from upstream never survives a map that no longer assigns it
    return rest;
  });
  const errors = config.errors.length ? [...inv.errors, ...config.errors.map((message) => ({ source, message }))] : inv.errors;
  return { ...inv, records, errors };
}

/** Reads the config file. Missing → no apps, no error (the map is optional). Unreadable or malformed → no apps, one error. */
export function loadAppConfig(path: string): AppConfig {
  if (!existsSync(path)) return { apps: [], errors: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { apps: [], errors: [`the app map could not be read: ${String(e).slice(0, 200)}`] };
  }
  return parseAppConfig(raw);
}

export type IconFile = { ok: true; path: string; contentType: string } | { ok: false; status: 400 | 404; reason: string };

/**
 * Resolves `slug` to its icon file, confined to `iconsDir`: both sides go through
 * realpathSync before the boundary check, so a symlinked icon pointing outside
 * the directory is refused.
 */
export function resolveIcon(slug: string, apps: readonly AppEntry[], iconsDir: string): IconFile {
  if (!SLUG_RE.test(slug)) return { ok: false, status: 400, reason: "not an app slug" };
  const app = apps.find((a) => a.slug === slug);
  if (!app) return { ok: false, status: 404, reason: `no app "${slug}" in the app map` };
  let root: string;
  let file: string;
  try {
    root = realpathSync(iconsDir);
    file = realpathSync(join(iconsDir, app.icon));
  } catch {
    return { ok: false, status: 404, reason: `the icon for "${slug}" is not on disk` };
  }
  if (!file.startsWith(root + sep)) return { ok: false, status: 404, reason: `the icon for "${slug}" is outside the icons directory` };
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return { ok: false, status: 404, reason: `the icon for "${slug}" is not a file` };
    size = st.size;
  } catch {
    return { ok: false, status: 404, reason: `the icon for "${slug}" is not on disk` };
  }
  if (size > MAX_ICON_BYTES) return { ok: false, status: 404, reason: `the icon for "${slug}" is larger than ${MAX_ICON_BYTES} bytes` };
  const contentType = ICON_TYPES[extname(file).toLowerCase()];
  if (!contentType) return { ok: false, status: 404, reason: `the icon for "${slug}" is not an image type the page serves` };
  return { ok: true, path: file, contentType };
}
