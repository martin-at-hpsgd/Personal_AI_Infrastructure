/**
 * The `atlas` slice's live side (CENSVS ISA F10, ISC-47): what `Statvs.ts compare things-atlas`
 * diffs the things fold against, and the one mapping Atlas's observe writer (ATLAS/Observe.ts)
 * uses to turn an atlas.db asset into an observed RES.
 *
 * The slice covers several GENERA kinds at once (every kind ATLAS_KIND_MAP names), so its name is
 * `atlas`, not a kind; it declares the kinds it covers in `kinds`.
 *
 * Mapping, the same as the resolver's atlas adapter (CENSVS/sources/atlas.ts):
 *  - kind: ATLAS_KIND_MAP; a `skip` mapping is a named decision and writes nothing.
 *  - id: `<RES kind>:<canonical key>` with a leading `<atlas kind>:` or `<RES kind>:` taken off.
 *  - state: Atlas's status read through atlasState (active, stale, expired, or the kind's state in
 *    the same bucket).
 *  - title: the asset's display name.
 *  - data: `atlas_kind`, `species` when the mapping names one, and for a credential only its
 *    `vendor` and `tier`. No other attr is copied: attrs stay in atlas.db, and a credential RES
 *    never carries more than its name, vendor and tier, never a value.
 *
 * Record side: every RES the `observe` stream folded with `data.atlas_kind` set, minus those the
 * writer marked `data.absent` (gone from atlas.db). Live side: atlas.db read-only, mapped the same
 * way. Both are `{ assets: { <id>: { kind, title, state, data } } }`.
 *
 * This file imports only types from views/things.ts: the things view imports the live sources
 * while it loads, so a runtime import back would be a cycle.
 *
 * @version 1.0.0
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ATLAS_KIND_MAP, validSubject } from "../genera";
import { ATLAS_RES_KINDS, atlasState } from "../sources/atlas";
import type { LiveSource, ThingsView } from "../../STATVS/views/things";

/** atlas.db's default path, resolved as ATLAS/Store.ts resolves it (env ATLAS_DIR, else ~/.local/state/lifeos/atlas). */
export function defaultAtlasDb(): string {
  return join(process.env.ATLAS_DIR ?? join(homedir(), ".local/state/lifeos/atlas"), "atlas.db");
}

/** One atlas.db asset row, as Observe and the live side read it. */
export interface AtlasAsset {
  kind: string;
  canonical_key: string;
  display_name: string;
  status: string;
  attrs: string;
}

/** An asset as an observed RES: the fields an observe row carries and the slice compares. */
export interface ObservedRes {
  id: string;
  kind: string;
  title: string;
  state: string;
  data: Record<string, unknown>;
}

export type AtlasMapResult = { res: ObservedRes } | { skip: string } | { unmapped: string };

/** The only attrs a credential RES carries (its name is the title). */
export const CREDENTIAL_FIELDS = ["vendor", "tier"] as const;

export const ASSET_SQL = "SELECT kind, canonical_key, display_name, status, attrs FROM asset ORDER BY canonical_key";

/** `<kind>:<key>` for an asset: the canonical key with a leading atlas-kind or RES-kind prefix taken off. */
export function atlasId(atlasKind: string, resKind: string, canonical: string): string {
  let key = canonical;
  for (const prefix of [`${atlasKind}:`, `${resKind}:`]) {
    if (key.startsWith(prefix) && key.length > prefix.length) {
      key = key.slice(prefix.length);
      break;
    }
  }
  return `${resKind}:${key}`;
}

function parseAttrs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One atlas.db asset as an observed RES, a named skip, or an unmapped record with its reason. */
export function mapAsset(a: AtlasAsset): AtlasMapResult {
  const m = Object.hasOwn(ATLAS_KIND_MAP, a.kind) ? ATLAS_KIND_MAP[a.kind] : undefined;
  if (!m) return { unmapped: `atlas kind "${a.kind}" has no mapping in ATLAS_KIND_MAP` };
  if ("skip" in m) return { skip: m.skip };
  const id = atlasId(a.kind, m.kind, a.canonical_key);
  const bad = validSubject(id);
  if (bad) return { unmapped: bad };
  const state = atlasState(m.kind, a.status);
  if (state === null) return { unmapped: `${m.kind} has no state for atlas status "${a.status}"` };
  const data: Record<string, unknown> = { atlas_kind: a.kind };
  if (m.species) data.species = m.species;
  if (m.kind === "credential") {
    const attrs = parseAttrs(a.attrs);
    for (const f of CREDENTIAL_FIELDS) if (typeof attrs[f] === "string" && attrs[f]) data[f] = attrs[f];
  }
  return { res: { id, kind: m.kind, title: a.display_name || id.slice(m.kind.length + 1), state, data } };
}

export interface AtlasRead {
  res: Map<string, ObservedRes>;
  skipped: number;
  unmapped: number;
}

/** Map every asset in an open atlas.db. Two assets mapping to one id keep the first (by canonical key) and count the second unmapped. */
export function mapAssets(db: Database): AtlasRead {
  const out: AtlasRead = { res: new Map(), skipped: 0, unmapped: 0 };
  for (const a of db.prepare(ASSET_SQL).all() as AtlasAsset[]) {
    const m = mapAsset(a);
    if ("skip" in m) out.skipped++;
    else if ("unmapped" in m) out.unmapped++;
    else if (out.res.has(m.res.id)) out.unmapped++;
    else out.res.set(m.res.id, m.res);
  }
  return out;
}

export interface AtlasSlice {
  assets: Record<string, { kind: string; title: string; state: string; data: Record<string, unknown> }>;
}

function sliceOf(entries: Iterable<ObservedRes>): AtlasSlice {
  const assets: AtlasSlice["assets"] = {};
  for (const r of [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    assets[r.id] = { kind: r.kind, title: r.title, state: r.state, data: r.data };
  }
  return { assets };
}

/** The record side: Atlas's observed RES in the things view, minus those marked absent. */
export function projectAtlas(view: ThingsView): AtlasSlice {
  const out: ObservedRes[] = [];
  for (const r of Object.values(view.res)) {
    const d = r.data ?? {};
    if (typeof d.atlas_kind !== "string" || d.absent === true) continue;
    out.push({ id: r.id, kind: r.kind, title: r.title, state: r.state ?? "", data: { ...d } });
  }
  return sliceOf(out);
}

/** The live side: atlas.db, opened read-only, mapped the same way Observe writes it. A missing database is an empty estate. */
export function atlasLive(dbPath = defaultAtlasDb()): AtlasSlice {
  if (!existsSync(dbPath)) return { assets: {} };
  const db = new Database(dbPath, { readonly: true });
  try {
    return sliceOf(mapAssets(db).res.values());
  } finally {
    db.close();
  }
}

/** The atlas slice over a given atlas.db (tests pass a temp copy). */
export function atlasSource(dbPath?: string): LiveSource & { kinds: readonly string[] } {
  return {
    kind: "atlas",
    kinds: ATLAS_RES_KINDS,
    // Atlas writes only the observe stream; the slice folds nothing else.
    streams: ["observe"],
    project: (view: ThingsView) => projectAtlas(view),
    live: () => atlasLive(dbPath ?? defaultAtlasDb()),
  };
}

export default atlasSource();
