/**
 * The Upgrades store → `proposal` RES (record authority). Reads through
 * Upgrades.ts's own list function, pointed at the chosen store directory.
 * `recommended` is the store's word for the declared `proposed` state (GENERA
 * stateAliases). A record file the store's parser refuses is counted unmapped.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listUpgrades } from "../../TOOLS/Upgrades";
import type { Adapter } from "./common";
import { clip, compact, withEnv } from "./common";

/** Upgrade source → proposal species. Every other source is a plain upgrade. */
const SPECIES: Readonly<Record<string, string>> = { errata: "errata", review: "review" };

export const upgrades: Adapter = {
  name: "upgrades",
  kinds: ["proposal"],
  read(ctx, sink) {
    const dir = ctx.paths.upgradesDir;
    const recordsDir = join(dir, "records");
    if (!existsSync(recordsDir)) return;
    const records = withEnv({ LIFEOS_UPGRADES_DIR: dir }, () => listUpgrades());
    const parsed = new Set(records.map((r) => r.id));
    for (const f of readdirSync(recordsDir).sort()) {
      if (!f.endsWith(".md")) continue;
      const id = f.slice(0, -3);
      if (!parsed.has(id)) sink.unmapped(id, "record does not parse as an Upgrades record");
    }
    for (const r of [...records].sort((a, b) => a.id.localeCompare(b.id))) {
      sink.res(r.id, {
        kind: "proposal",
        key: r.id,
        title: clip(r.claim) || r.slug,
        state: r.status,
        data: compact({
          species: SPECIES[r.source] ?? "upgrade",
          source_kind: r.source,
          created: r.created,
          expires: r.expires,
          confidence: r.confidence,
          target_surface: r.target_surface,
          ledger_id: r.ledger_id && r.ledger_id !== "null" ? r.ledger_id : undefined,
        }),
      });
    }
  },
};
