/**
 * The Achilles registry → `finding` RES (record authority), species `vuln`,
 * state from the entry's status verbatim. Reads through Achilles's own
 * loadRegistry (which only migrates in memory).
 */
import { loadRegistry } from "../../TOOLS/Achilles";
import type { Adapter, Link } from "./common";
import { clip, compact } from "./common";

export const achilles: Adapter = {
  name: "achilles",
  kinds: ["finding"],
  read(ctx, sink) {
    const reg = loadRegistry(ctx.paths.achillesRegistry);
    for (const e of reg.entries) {
      const links: Link[] = [];
      if (e.risk_ref) links.push({ rel: "risk", to: `risk:${e.risk_ref}` });
      sink.res(e.id, {
        kind: "finding",
        key: e.id,
        title: clip(e.title) || e.id,
        state: e.status,
        links: links.length ? links : undefined,
        data: compact({
          species: "vuln",
          category: e.category,
          severity: e.severity,
          source_kind: e.source,
          first_seen: e.first_seen,
          closed_at: e.closed_at,
          fix_class: e.fix_class,
          work_issue: e.work_issue,
          cves: e.cves?.length || undefined,
        }),
      });
    }
  },
};
