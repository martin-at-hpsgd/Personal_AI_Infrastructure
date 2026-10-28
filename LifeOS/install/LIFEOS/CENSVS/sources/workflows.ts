/**
 * Workflow definitions → `workflow` RES (git authority). One RES per
 * `LIFEOS/USER/WORKFLOWS/*.workflow.yaml`, keyed by its `name`. `enabled: false`
 * reads as `paused`. Species comes from the triggers: followup-* names are
 * followups, a `once` trigger is a one-shot, schedule and interval are cron,
 * event and after triggers chain off another run.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Adapter } from "./common";
import { clip, compact } from "./common";

const DEF_FILE = /\.workflow\.ya?ml$/;

function speciesOf(name: string, types: string[]): string | undefined {
  if (name.startsWith("followup-")) return "followup";
  if (types.includes("once")) return "once";
  if (types.includes("schedule") || types.includes("interval")) return "cron";
  if (types.includes("event") || types.includes("after")) return "after";
  return undefined;
}

export const workflows: Adapter = {
  name: "workflows",
  kinds: ["workflow"],
  read(ctx, sink) {
    const dir = ctx.paths.workflowsDir;
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).sort()) {
      if (!DEF_FILE.test(file)) continue;
      let doc: Record<string, unknown>;
      try {
        doc = Bun.YAML.parse(readFileSync(`${dir}/${file}`, "utf8")) as Record<string, unknown>;
      } catch {
        sink.unmapped(file, "definition is not valid YAML");
        continue;
      }
      if (!doc || typeof doc !== "object" || typeof doc.name !== "string" || !doc.name) {
        sink.unmapped(file, "definition has no name");
        continue;
      }
      const name = doc.name;
      const types = Array.isArray(doc.triggers)
        ? (doc.triggers as Array<{ type?: unknown }>).map((t) => String(t?.type ?? "")).filter(Boolean)
        : [];
      sink.res(file, {
        kind: "workflow",
        key: name,
        title: name,
        state: doc.enabled === false ? "paused" : "active",
        data: compact({
          species: speciesOf(name, types),
          path: `LIFEOS/USER/WORKFLOWS/${file}`,
          triggers: types.length ? types : undefined,
          description: clip(doc.description, 200) || undefined,
        }),
      });
    }
  },
};
