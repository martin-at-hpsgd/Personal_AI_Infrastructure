/**
 * The People store → `person` RES (opaque key) and, for organization cards,
 * `org` RES (record authority). Reads through People's own readContacts.
 *
 * A person's key is `p` plus 16 hex characters of a keyed HMAC-SHA256 of the
 * People id (CENSVS ISA ISC-62, ids.ts hashedKey), so the id never carries an
 * email, phone or contact identifier, and nobody holding a candidate email can
 * confirm a subject without the key; the same keying names the `same_as` links.
 * With no key on this machine no person is mapped: each contact is counted
 * unmapped, and an organization maps only when its name slug is unique. No
 * email, phone, address or customer field is copied, and unmapped examples use
 * the keyed id (or a line number), never the raw id.
 * State: `active` with a human interaction in the last 365 days, else `dormant`.
 */
import { hashedKey } from "../ids";
import { readContacts } from "../../PEOPLE/store";
import type { PersonRecord } from "../../PEOPLE/types";
import type { Adapter, Link } from "./common";
import { compact, withEnv } from "./common";

const ACTIVE_DAYS = 365;
const EMAILISH = /@|\d{3}[\s.-]?\d{4}/;

const NO_KEY = "no person key: the STATVS mask key is unavailable, so person ids cannot be minted (ISC-62)";

/** The opaque person key for a People id, keyed (ISC-62); null when no key is available, never an unsalted hash. */
export function personKey(peopleId: string): string | null {
  return hashedKey("person", peopleId);
}

export const people: Adapter = {
  name: "people",
  kinds: ["person", "org"],
  read(ctx, sink) {
    const records = withEnv({ PEOPLE_DIR: ctx.paths.peopleDir }, () => readContacts()) as Array<Partial<PersonRecord>>;
    const orgKeys = new Set<string>();
    records.forEach((r, i) => {
      if (typeof r?.id !== "string" || !r.id) {
        sink.unmapped(`line ${i + 1}`, "contact record has no id");
        return;
      }
      const hashed = personKey(r.id);
      const recordId = hashed ?? `line ${i + 1}`;
      const name = typeof r.name === "string" && !EMAILISH.test(r.name) ? r.name : "";

      if (r.isOrganization) {
        // org is an opaque-key kind (an organization's name can be a person's name), so its key is keyed like a person's.
        const key = hashedKey("org", r.id);
        if (!key || orgKeys.has(key)) {
          sink.unmapped(recordId, key ? "organization id repeated" : NO_KEY);
          return;
        }
        orgKeys.add(key);
        sink.res(recordId, {
          kind: "org",
          key,
          title: name || "organization",
          state: "active",
          data: compact({ species: "company", sources: r.sources }),
        });
        return;
      }

      if (!hashed) {
        sink.unmapped(recordId, NO_KEY);
        return;
      }
      const last = r.interactions?.last ? Date.parse(r.interactions.last) : NaN;
      const active = Number.isFinite(last) && ctx.now.getTime() - last <= ACTIVE_DAYS * 86_400_000;
      const links: Link[] = (r.same_as ?? [])
        .filter((s): s is string => typeof s === "string" && !!s)
        .map((s) => ({ rel: "same_as", to: `person:${personKey(s)!}` }));
      sink.res(hashed, {
        kind: "person",
        key: hashed,
        title: name || "contact",
        state: active ? "active" : "dormant",
        links: links.length ? links : undefined,
        data: compact({
          species: "contact",
          class: r.class_override ?? r.class,
          sources: r.sources,
          interactions: r.interactions?.total,
        }),
      });
    });
  },
};
