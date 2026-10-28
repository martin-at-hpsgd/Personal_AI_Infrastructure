/**
 * Injection collector — puts trust boundaries in the asset graph.
 *
 * Atlas already answers "what do we own" and "what would leak if this got
 * popped." This collector adds the third question: "where can somebody else's
 * text get in, and what can it borrow once it's there."
 *
 * It emits three asset kinds and three edge kinds:
 *
 *   ingest     --FLOWS_INTO-->  system:agent-context  --GRANTS-->  capability
 *      \                                                             /
 *       `--------------------- GUARDED_BY ---> control <------------'
 *
 * The single `system:agent-context` node is the whole point. Every untrusted
 * surface converges on one context that holds every capability, so the graph
 * shows the confused-deputy shape structurally instead of asserting it in
 * prose. What distinguishes a bad surface from a survivable one is not what it
 * can reach — they all reach everything — but which controls sit on the edge
 * and whether those controls block or merely advise.
 *
 * Source of authority: the bundled structural registry, plus an optional
 * per-instance overlay in the private USER tree. The overlay may ADD surfaces
 * and may TIGHTEN or LOOSEN an existing one by id; it never silently drops a
 * bundled surface, because "we removed the row" must never be how a real
 * exposure disappears from the census.
 *
 * @version 1.0.0
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { invariant } from "../../TOOLS/Invariant";
import type { AssetObs, CollectResult, Collector, EdgeObs } from "../Store";
import {
  CAPABILITIES,
  CONTROLS,
  SURFACES,
  type Capability,
  type Control,
  type Surface,
} from "./injection-surfaces";

/** Optional private overlay — instance specifics that must never ship publicly. */
const OVERLAY = join(homedir(), ".claude/LIFEOS/USER/SECURITY/injection-surfaces.ts");

/** The one node every ingestion surface converges on and every capability hangs off. */
export const CONTEXT_KEY = "system:agent-context";

const TRUST = new Set(["principal", "semi", "untrusted"]);
const MODE = new Set(["blocking", "advisory", "human-gate"]);

export interface Overlay {
  SURFACES?: Surface[];
  CAPABILITIES?: Capability[];
  CONTROLS?: Control[];
}

/** Merge by id, overlay wins. Overlay can add or amend, never delete. */
function mergeById<T extends { id: string }>(base: T[], extra: T[] | undefined): T[] {
  if (!extra?.length) return base;
  const byId = new Map(base.map((r) => [r.id, r]));
  for (const r of extra) byId.set(r.id, r);
  return [...byId.values()];
}

export const injection: Collector = {
  name: "injection",
  async collect(): Promise<CollectResult> {
    let overlay: Overlay = {};
    // A missing overlay is the normal case (and the only case on a public
    // install), so absence degrades silently. A PRESENT but malformed overlay
    // throws — a security census that quietly ignores a broken source is worse
    // than one that fails loud.
    if (existsSync(OVERLAY)) overlay = (await import(OVERLAY)) as Overlay;
    return collectWithOverlay(overlay);
  },
};

/**
 * The census over the bundled registry plus a given overlay. Tests pass a synthetic
 * overlay (an ungoverned untrusted surface, say) rather than depending on what the
 * bundled registry happens to contain this month.
 */
export function collectWithOverlay(overlay: Overlay): CollectResult {
  const controls = mergeById(CONTROLS, overlay.CONTROLS);
  const capabilities = mergeById(CAPABILITIES, overlay.CAPABILITIES);
  const surfaces = mergeById(SURFACES, overlay.SURFACES);

  const controlIds = new Set(controls.map((c) => c.id));
  const assets: AssetObs[] = [];
  const edges: EdgeObs[] = [];

  // Validate before emitting: these facts drive a security census, and a
  // typo'd trust class or a dangling control reference would show up as
  // reassurance rather than as an error.
  for (const c of controls) {
    invariant(MODE.has(c.mode), `injection: control ${c.id} has unknown mode ${c.mode}`);
    assets.push({
      kind: "control",
      key: `control:${c.id}`,
      name: c.name,
      attrs: { layer: c.layer, mode: c.mode, fail_open: c.failOpen, impl: c.impl },
    });
  }

  assets.push({
    kind: "system",
    key: CONTEXT_KEY,
    name: "Agent context (the deputy)",
    attrs: { note: "Every ingestion surface converges here; every capability hangs off here." },
  });

  for (const c of capabilities) {
    const key = `capability:${c.id}`;
    assets.push({
      kind: "capability",
      key,
      name: c.name,
      attrs: { blast: c.blast, reversible: c.reversible },
    });
    edges.push({ kind: "GRANTS", srcKey: CONTEXT_KEY, dstKey: key, srcKind: "system", dstKind: "capability" });
    for (const ctl of c.controls) {
      invariant(controlIds.has(ctl), `injection: capability ${c.id} references unknown control ${ctl}`);
      edges.push({ kind: "GUARDED_BY", srcKey: key, dstKey: `control:${ctl}`, srcKind: "capability", dstKind: "control" });
    }
  }

  for (const s of surfaces) {
    invariant(TRUST.has(s.trust), `injection: surface ${s.id} has unknown trust class ${s.trust}`);
    const key = `ingest:${s.id}`;
    assets.push({
      kind: "ingest",
      key,
      name: s.name,
      attrs: {
        trust: s.trust,
        channel: s.channel,
        persists: s.persists,
        authenticated: s.authenticated,
        notes: s.notes,
      },
    });
    edges.push({ kind: "FLOWS_INTO", srcKey: key, dstKey: CONTEXT_KEY, srcKind: "ingest", dstKind: "system" });
    for (const ctl of s.controls) {
      invariant(controlIds.has(ctl), `injection: surface ${s.id} references unknown control ${ctl}`);
      edges.push({ kind: "GUARDED_BY", srcKey: key, dstKey: `control:${ctl}`, srcKind: "ingest", dstKind: "control" });
    }
  }

  return { complete: true, assets, edges };
}
