/**
 * The Errata ledger → `issue` RES (record authority), species from the
 * erratum's kind, state from its folded status. Reads through ErrataStore's own
 * fold. App-sourced rows (customer, user) are tenant records: RES never holds
 * tenant content, so they are counted as a policy skip. A torn ledger line is
 * counted unmapped.
 */
import { ErrataStore, TENANT_SOURCES } from "../../ERRATA/Store";
import type { Adapter } from "./common";
import { clip, compact } from "./common";

export const errata: Adapter = {
  name: "errata",
  kinds: ["issue"],
  read(ctx, sink) {
    const store = new ErrataStore(ctx.paths.errataDir, ctx.paths.errataTenantDir);
    const { skipped } = store.rawLines();
    for (let i = 0; i < skipped; i++) sink.unmapped("(torn ledger line)", "ledger line does not parse");
    let tenant = 0;
    for (const e of store.all()) {
      if (TENANT_SOURCES.has(e.source)) {
        tenant++;
        continue;
      }
      const links = e.links?.upgrade_id ? [{ rel: "filed", to: `proposal:${e.links.upgrade_id}` }] : undefined;
      sink.res(e.id, {
        kind: "issue",
        key: e.id,
        title: clip(e.complaint) || `${e.kind} in ${e.system}`,
        state: e.status,
        links,
        data: compact({
          species: e.kind,
          system: e.system,
          source_kind: e.source,
          channel: e.channel,
          at: e.ts,
          target: e.target,
          rating: e.rating ?? undefined,
        }),
      });
    }
    if (tenant) sink.skipped("tenant", "app-sourced rows (customer, user) are tenant records: counted, never RES content", tenant);
  },
};
