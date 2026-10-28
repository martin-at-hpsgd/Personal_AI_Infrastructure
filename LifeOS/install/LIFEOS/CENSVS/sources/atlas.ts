/**
 * Atlas → estate RES (observed authority), plus the git kinds Atlas also
 * watches (model, workflow, tool, system). Opens atlas.db read-only and maps
 * each asset kind through GENERA's ATLAS_KIND_MAP; a mapping marked `skip` is a
 * named decision (counted as skipped), a kind with no mapping is unmapped.
 *
 * Key: the canonical key with a leading `<atlas kind>:` or `<RES kind>:` taken
 * off ("domain:example.com" → `domain:example.com`, "cloudflare:worker:w1" →
 * `service:cloudflare:worker:w1`). The canonical key stays as alias
 * `atlas:<canonical key>`.
 *
 * State: Atlas's active/stale/expired where the kind declares it; otherwise the
 * kind's first state in the same bucket (active → active, stale → open, else
 * active, expired → gone), with Atlas's word kept as data.sourceState.
 *
 * Edges → links on the source RES (`rel` is the edge kind lowercased). Expired
 * edges are left out; an edge whose end is skipped or unmapped is counted.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { ATLAS_KIND_MAP, GENERA, canonicalState, type Bucket } from "../genera";
import type { Adapter } from "./common";
import { compact } from "./common";

const STATUS_BUCKET: Readonly<Record<string, Bucket>> = { active: "active", stale: "open", expired: "gone" };

/** The declared state an Atlas status reads as for a RES kind, or null. */
export function atlasState(kind: string, status: string): string | null {
  const direct = canonicalState(kind, status);
  if (direct) return direct;
  const bucket = STATUS_BUCKET[status];
  const d = GENERA[kind];
  if (!bucket || !d) return null;
  const inBucket = d.states.find((s) => d.bucket[s] === bucket);
  if (inBucket) return inBucket;
  return bucket === "open" ? (d.states.find((s) => d.bucket[s] === "active") ?? null) : null;
}

export const ATLAS_RES_KINDS: readonly string[] = [
  ...new Set(Object.values(ATLAS_KIND_MAP).flatMap((m) => ("kind" in m ? [m.kind] : []))),
];

interface AssetRow {
  id: number;
  kind: string;
  canonical_key: string;
  display_name: string;
  status: string;
  first_observed_at: string;
  last_observed_at: string;
}

export const atlas: Adapter = {
  name: "atlas",
  kinds: ATLAS_RES_KINDS,
  read(ctx, sink) {
    const path = ctx.paths.atlasDb;
    if (!existsSync(path)) return;
    const db = new Database(path, { readonly: true });
    try {
      const idByAsset = new Map<number, string>();
      const skips = new Map<string, number>();
      const assets = db
        .prepare("SELECT id, kind, canonical_key, display_name, status, first_observed_at, last_observed_at FROM asset ORDER BY id")
        .all() as AssetRow[];
      for (const a of assets) {
        const mapping = Object.hasOwn(ATLAS_KIND_MAP, a.kind) ? ATLAS_KIND_MAP[a.kind] : undefined;
        if (!mapping) {
          sink.unmapped(a.canonical_key, `atlas kind "${a.kind}" has no mapping in ATLAS_KIND_MAP`);
          continue;
        }
        if ("skip" in mapping) {
          skips.set(a.kind, (skips.get(a.kind) ?? 0) + 1);
          continue;
        }
        let key = a.canonical_key;
        for (const prefix of [`${a.kind}:`, `${mapping.kind}:`]) {
          if (key.startsWith(prefix) && key.length > prefix.length) {
            key = key.slice(prefix.length);
            break;
          }
        }
        const state = atlasState(mapping.kind, a.status);
        const id = sink.res(a.canonical_key, {
          kind: mapping.kind,
          key,
          title: a.display_name || key,
          state: state ?? a.status,
          aliases: [`atlas:${a.canonical_key}`],
          data: compact({
            species: mapping.species,
            atlas_kind: a.kind,
            sourceState: state !== null && state !== a.status ? a.status : undefined,
            first_observed: a.first_observed_at,
            last_observed: a.last_observed_at,
          }),
        });
        if (id) idByAsset.set(a.id, id);
      }
      for (const [k, n] of skips) {
        const m = ATLAS_KIND_MAP[k];
        sink.skipped(k, "skip" in m ? m.skip : "skipped", n);
      }

      let dropped = 0;
      const edges = db.prepare("SELECT kind, src, dst FROM edge WHERE status != 'expired' ORDER BY id").all() as Array<{
        kind: string;
        src: number;
        dst: number;
      }>;
      for (const e of edges) {
        const from = idByAsset.get(e.src);
        const to = idByAsset.get(e.dst);
        if (!from || !to) {
          dropped++;
          continue;
        }
        sink.link(from, { rel: e.kind.toLowerCase(), to });
      }
      if (dropped) sink.skipped("edges", "edge with an end that is a skipped or unmapped asset", dropped);
    } finally {
      db.close();
    }
  },
};
