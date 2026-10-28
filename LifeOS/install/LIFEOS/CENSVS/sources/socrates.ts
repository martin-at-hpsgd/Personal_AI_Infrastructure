/**
 * The Socrates ledger → `question` RES (record authority), species `standing`.
 * Reads each question pack and holds every question to the registry's own
 * contract (assertQuestion); a question that fails it, or a pack that does not
 * parse, is counted unmapped instead of failing the whole source.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertQuestion, type Question } from "../../SOCRATES/Registry";
import type { Adapter, Link } from "./common";
import { clip, compact } from "./common";

/** An isa_ref may be a slug or a path to an ISA.md; either way the ISA's directory names it. */
function isaKey(ref: string): string {
  const parts = ref.split("/").filter((p) => p && p !== "ISA.md");
  return parts[parts.length - 1] ?? ref;
}

export const socrates: Adapter = {
  name: "socrates",
  kinds: ["question"],
  read(ctx, sink) {
    const dir = ctx.paths.socratesDir;
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      let pack: { questions?: unknown };
      try {
        pack = JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch {
        sink.unmapped(f, "question pack is not valid JSON");
        continue;
      }
      if (!Array.isArray(pack?.questions)) {
        sink.unmapped(f, "question pack has no questions[] array");
        continue;
      }
      for (const raw of pack.questions as Question[]) {
        const id = typeof raw?.id === "string" ? raw.id : `${f}#?`;
        try {
          assertQuestion(raw);
        } catch {
          sink.unmapped(id, "question fails the Socrates registry contract");
          continue;
        }
        const links: Link[] = [];
        if (raw.isa_ref) links.push({ rel: "isa", to: `isa:${isaKey(raw.isa_ref)}` });
        if (raw.risk_ref) links.push({ rel: "risk", to: `risk:${raw.risk_ref}` });
        sink.res(id, {
          kind: "question",
          key: raw.id,
          title: clip(raw.text) || raw.id,
          state: raw.status,
          links: links.length ? links : undefined,
          data: compact({
            species: "standing",
            domain: raw.domain,
            cadence: raw.cadence,
            severity: raw.severity,
            verifier: raw.verifier,
            answerer: raw.answerer?.adapter,
            pack: f,
          }),
        });
      }
    }
  },
};
